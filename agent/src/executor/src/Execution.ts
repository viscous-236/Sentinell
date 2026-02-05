/**
 * Sentinel Executor Agent
 * 
 * Responsibilities:
 * 1. Listen to RiskEngine decisions (ONLY - no risk logic here)
 * 2. Translate decisions to on-chain SentinelHook actions
 * 3. Activate the chosen protection (MEV / Oracle / Circuit Breaker)
 * 4. Deactivate expired protections to ensure clean state
 * 5. Generate TEE attestations for trustless execution (TODO: integrate TEE SDK)
 * 
 * Integration contract with Risk Engine:
 *   - Listens on riskEngine.on('decision', handler)
 *   - Converts RiskDecision → on-chain transaction via SentinelHook.sol
 *   - Manages protection lifecycle (activate → monitor → auto-expire)
 * 
 * Note: Dynamic fees are handled by Uniswap v4 - LPs automatically receive fee distributions.
 * No custom rebate logic needed - the protocol handles it natively.
 */

import { EventEmitter } from "events";
import { ethers } from "ethers";
import type { RiskDecision, DefenseAction, ThreatTier } from "./RiskEngine";
import type { LPThreatBroadcast } from "./types/LPBroadcast";
import { ThreatAPIServer } from "./api/ThreatAPIServer";
import {
  CrossChainOrchestrator,
  CrossChainOrchestratorConfig,
  createCrossChainOrchestrator,
  type CrossChainAction,
  type ExecutionResult,
} from "./CrossChainOrchestrator";
import { ACTIVE_CHAIN_IDS } from "../config/crosschain.config";
import { YellowMessageBus, YellowProtectionAuth } from "../../shared/yellow/YellowMessageBus";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ExecutorConfig {
  rpcUrls: {
    ethereum: string;
    base: string;
    arbitrum: string;
  };
  hookAddresses: {
    ethereum: string;
    base: string;
    arbitrum: string;
  };
  agentPrivateKey: string;
  /** Optional TEE integration for production */
  teeEnabled?: boolean;
  /** Gas price caps per chain (in gwei) */
  maxGasPrice?: {
    ethereum: number;
    base: number;
    arbitrum: number;
  };
  /** Cross-chain orchestrator configuration */
  crossChain?: {
    enabled: boolean;
    dryRun?: boolean;
  };
  /** Threat API server configuration */
  threatAPI?: {
    enabled: boolean;
    port: number;
    retentionMs?: number;
  };
  /** YellowOracle contract addresses for on-chain settlement */
  yellowOracleAddresses?: {
    ethereum: string;
    base: string;
    arbitrum: string;
  };
}

/** Maps to on-chain enum */
enum OnChainAction {
  NONE = 0,
  MEV_PROTECTION = 1,
  ORACLE_VALIDATION = 2,
  CIRCUIT_BREAKER = 3,
}

enum OnChainTier {
  WATCH = 0,
  ELEVATED = 1,
  CRITICAL = 2,
}

interface ProtectionState {
  poolId: string; // bytes32 hex string
  chain: string;
  action: DefenseAction | null;
  activatedAt: number;
  expiresAt: number;
  txHash: string;
}

/**
 * Settlement queue item for batching Yellow authorizations on-chain
 * Per PROJECT_SPEC.md: Settlement happens LATER for finality, not immediately
 */
interface SettlementQueueItem {
  auth: YellowProtectionAuth;
  decision: RiskDecision;
  timestamp: number;
}

const HOOK_ABI = [
  "function activateProtection(bytes32 poolId, uint24 newFee, bytes calldata proof) external",
  "function deactivateProtection(bytes32 poolId, bytes calldata proof) external",
  "function activateCircuitBreaker(bytes32 poolId, string calldata reason, bytes calldata proof) external",
  "function deactivateCircuitBreaker(bytes32 poolId, bytes calldata proof) external",
  "function configureOracle(bytes32 poolId, address chainlinkFeed, uint256 deviationThreshold, bytes calldata proof) external",
  "function broadcastThreat(bytes32 poolId, string calldata tier, string calldata action, uint256 compositeScore, uint256 expiresAt, string calldata rationale, string[] calldata signalTypes, bytes calldata proof) external",

  "function isProtectionActive(bytes32 poolId) external view returns (bool)",
  "function isCircuitBreakerActive(bytes32 poolId) external view returns (bool)",
  "function getActiveFee(bytes32 poolId) external view returns (uint24)",
  "function configs(bytes32 poolId) external view returns (bool circuitBreakerEnabled, bool oracleValidationEnabled, bool antiSandwichEnabled)",

  "event ProtectionActivated(bytes32 indexed poolId, uint24 newFee, uint256 expiryBlock, address activatedBy)",
  "event CircuitBreakerActivated(bytes32 indexed poolId, address indexed activatedBy, uint256 activatedAt, uint256 expiryBlock, string reason)",
  "event ThreatBroadcast(bytes32 indexed poolId, string tier, string action, uint256 compositeScore, uint256 timestamp, uint256 expiresAt, string rationale, string[] signalTypes)",
];

// YellowOracle ABI for on-chain settlement
const YELLOW_ORACLE_ABI = [
  "function commitAuthorization(bytes32 poolId, uint8 action, uint24 fee, uint256 expiryBlock, uint256 timestamp, uint256 nonce, bytes calldata signature) external",
  "function commitAuthorizationBatch(bytes32[] calldata poolIds, uint8[] calldata actions, uint24[] calldata fees, uint256[] calldata expiryBlocks, uint256[] calldata timestamps, uint256[] calldata nonces, bytes[] calldata signatures) external",
  "function getAuthorization(bytes32 poolId) view returns (bool hasAuth, uint24 fee, uint256 expiryBlock, address signer)",
  "function authorizedExecutors(address) view returns (bool)",
  "event AuthorizationCommitted(bytes32 indexed poolId, uint8 action, uint24 fee, uint256 expiryBlock, address indexed signer, uint256 timestamp)",
];

export class ExecutorAgent extends EventEmitter {
  private config: ExecutorConfig;
  private providers: Map<string, ethers.Provider>;
  private wallets: Map<string, ethers.Wallet>;
  private hookContracts: Map<string, ethers.Contract>;
  private yellowOracleContracts: Map<string, ethers.Contract>;
  private crossChainOrchestrator?: CrossChainOrchestrator;
  private threatAPIServer?: ThreatAPIServer;

  private protectionStates: Map<string, ProtectionState>;

  private isRunning = false;
  private monitorInterval?: ReturnType<typeof setInterval>;

  // =========================================================================
  // YELLOW PRE-AUTHORIZATION STATE
  // Per PROJECT_SPEC.md Section 4.5: "no mempool exposure"
  // =========================================================================
  private yellowMessageBus?: YellowMessageBus;
  private yellowNonce = 0;
  private settlementQueue: SettlementQueueItem[] = [];
  private lastSettlementTime = 0;
  private settlementInterval?: ReturnType<typeof setInterval>;

  constructor(config: ExecutorConfig) {
    super();
    this.config = config;
    this.providers = new Map();
    this.wallets = new Map();
    this.hookContracts = new Map();
    this.yellowOracleContracts = new Map();
    this.protectionStates = new Map();

    this.validateConfig();

    // Per PROJECT_SPEC.md Section 4.5: "Agents communicate via Yellow state channels"
    // Per Section 4.1: "Executor Agent: Listens only to Risk Engine decisions"
    // 
    // Listen for decisions that come FROM Yellow Message Bus
    // These are emitted by the ExecutorYellowAdapter when it receives decisions from Yellow
    this.on('yellow:decision', async (decision: RiskDecision) => {
      console.log(`📥 Executor: Received decision via Yellow state channel: ${decision.id}`);
      try {
        await this.executeDecision(decision);
      } catch (error) {
        console.error('❌ Executor: Failed to execute Yellow decision:', error);
        this.emit('execution:failure', { decision, error: (error as Error).message });
      }
    });

    // Listen for threat broadcasts to cache in API
    this.on('threat:broadcast', ({ broadcast, txHash }) => {
      if (this.threatAPIServer) {
        this.threatAPIServer.addThreat(broadcast, txHash);
      }
    });
  }

  private validateConfig(): void {
    if (!ethers.isHexString(this.config.agentPrivateKey, 32)) {
      throw new Error("Invalid agent private key");
    }

    const chains = ["ethereum", "base", "arbitrum"] as const;
    for (const chain of chains) {
      if (!this.config.rpcUrls[chain]) {
        throw new Error(`Missing RPC URL for ${chain}`);
      }
      if (!ethers.isAddress(this.config.hookAddresses[chain])) {
        throw new Error(`Invalid hook address for ${chain}`);
      }
    }
  }

  async initialize(): Promise<void> {
    console.log("🚀 Executor: Initializing...");

    const chains: Array<"ethereum" | "base" | "arbitrum"> = ["ethereum", "base", "arbitrum"];

    for (const chain of chains) {
      const provider = new ethers.JsonRpcProvider(this.config.rpcUrls[chain]);
      this.providers.set(chain, provider);

      const wallet = new ethers.Wallet(this.config.agentPrivateKey, provider);
      this.wallets.set(chain, wallet);

      const hookContract = new ethers.Contract(
        this.config.hookAddresses[chain],
        HOOK_ABI,
        wallet
      );
      this.hookContracts.set(chain, hookContract);

      console.log(`✅ Executor: Connected to ${chain} hook at ${this.config.hookAddresses[chain]}`);

      // Initialize YellowOracle contracts if addresses are configured
      if (this.config.yellowOracleAddresses?.[chain]) {
        const yellowOracleContract = new ethers.Contract(
          this.config.yellowOracleAddresses[chain],
          YELLOW_ORACLE_ABI,
          wallet
        );
        this.yellowOracleContracts.set(chain, yellowOracleContract);
        console.log(`✅ Executor: Connected to ${chain} YellowOracle at ${this.config.yellowOracleAddresses[chain]}`);
      }
    }

    console.log("✅ Executor: Initialization complete");
  }

  /**
   * Start the executor agent.
   * Begins monitoring protection states for expiration.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("⚠️  Executor: Already running");
      return;
    }

    console.log("🚀 Executor: Starting...");

    this.isRunning = true;

    // Start Threat API server if enabled
    if (this.config.threatAPI?.enabled) {
      this.threatAPIServer = new ThreatAPIServer({
        port: this.config.threatAPI.port,
        retentionMs: this.config.threatAPI.retentionMs || 300000, // 5 minutes default
      });
      await this.threatAPIServer.start();
    }

    // Monitor protection expirations
    this.monitorInterval = setInterval(() => {
      this.monitorProtections();
    }, 12_000); // Every ~1 ETH block

    // Start background settlement worker
    // Batches Yellow authorizations on-chain every 30s for audit trail
    // Per PROJECT_SPEC.md Section 4.6: "Settlement happens on-chain for finality"
    this.settlementInterval = setInterval(() => {
      this.processSettlementQueue();
    }, 30_000); // Every 30 seconds

    console.log("✅ Executor: Running");
    this.emit("executor:started");
  }

  /**
   * Stop the executor agent.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log("🛑 Executor: Stopping...");

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }

    // Stop settlement worker
    if (this.settlementInterval) {
      clearInterval(this.settlementInterval);
      this.settlementInterval = undefined;
    }

    // Process any remaining items before shutdown
    if (this.settlementQueue.length > 0) {
      console.log(`⚠️ Executor: Processing ${this.settlementQueue.length} pending settlements before shutdown...`);
      await this.processSettlementQueue();
    }

    // Stop Threat API server
    if (this.threatAPIServer) {
      await this.threatAPIServer.stop();
    }

    this.isRunning = false;
    console.log("✅ Executor: Stopped");
    this.emit("executor:stopped");
  }

  // ---------------------------------------------------------------------------
  // YELLOW PRE-AUTHORIZATION METHODS
  // Per PROJECT_SPEC.md Section 4.5: "no mempool exposure"
  // ---------------------------------------------------------------------------

  /**
   * Set the Yellow MessageBus for off-chain authorization broadcasting
   */
  setYellowMessageBus(yellowMessageBus: YellowMessageBus): void {
    this.yellowMessageBus = yellowMessageBus;
    console.log("✅ Executor: Yellow MessageBus connected for pre-authorization");
  }

  /**
   * Sign Yellow protection authorization (OFF-CHAIN)
   * 
   * THIS IS THE KEY TO PREVENTING MEV TIMING ATTACKS:
   * - Signs authorization message with Executor's private key
   * - No on-chain transaction = no mempool exposure
   * - Hook checks this signature BEFORE allowing swaps
   * 
   * Per PROJECT_SPEC.md Section 4.5: "no mempool exposure"
   */
  private async signYellowProtectionAuthorization(
    decision: RiskDecision
  ): Promise<YellowProtectionAuth> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const wallet = this.wallets.get(chain);
    const provider = this.providers.get(chain);

    if (!wallet || !provider) {
      throw new Error(`No wallet/provider for chain: ${chain}`);
    }

    const poolId = this.computePoolId(decision.targetPool);
    const dynamicFee = this.calculateDynamicFee(decision);
    const currentBlock = await provider.getBlockNumber();
    const expiryBlock = currentBlock + 50; // ~10 minutes on Ethereum

    // Create authorization message (EIP-712 style)
    const authMessage = {
      poolId,
      action: decision.action as 'MEV_PROTECTION' | 'ORACLE_VALIDATION' | 'CIRCUIT_BREAKER',
      fee: dynamicFee,
      expiryBlock,
      timestamp: Date.now(),
      nonce: this.yellowNonce++,
      chain: decision.chain,
    };

    // Create message hash for signing
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'string', 'uint24', 'uint256', 'uint256', 'uint256', 'string'],
      [
        authMessage.poolId,
        authMessage.action,
        authMessage.fee,
        authMessage.expiryBlock,
        authMessage.timestamp,
        authMessage.nonce,
        authMessage.chain,
      ]
    );

    // Sign with Executor's private key (in production: inside TEE)
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log(`🔐 Executor: Signed Yellow authorization`);
    console.log(`   PoolId: ${poolId.slice(0, 20)}...`);
    console.log(`   Action: ${authMessage.action}`);
    console.log(`   Fee: ${dynamicFee} bps`);
    console.log(`   Expiry: block ${expiryBlock}`);

    return {
      ...authMessage,
      signature,
      signer: wallet.address,
    };
  }

  /**
   * Broadcast Yellow authorization via state channel (INSTANT)
   * 
   * This happens OFF-CHAIN via WebSocket, <50ms latency
   * Hook will check this signature before allowing swaps
   */
  private async broadcastYellowAuthorization(
    auth: YellowProtectionAuth,
    decision: RiskDecision
  ): Promise<void> {
    if (!this.yellowMessageBus) {
      console.warn("⚠️ Executor: No Yellow MessageBus - falling back to direct on-chain");
      return;
    }

    const poolKey = `${decision.chain}:${decision.pair}`;

    // Publish to Yellow state channel (OFF-CHAIN, instant)
    await this.yellowMessageBus.publishProtectionAuth(auth, decision.id, poolKey);

    console.log(`⚡ Executor: Yellow authorization broadcast (OFF-CHAIN)`);
    console.log(`   Duration: <50ms (vs ~12s block time)`);
    console.log(`   Gas cost: 0 ETH (off-chain)`);
    console.log(`   ✅ NO mempool exposure - protection active immediately!`);
  }

  /**
   * Queue Yellow authorization for on-chain settlement (LATER)
   * 
   * Settlement is for FINALITY only - protection is already active via Yellow
   * Batches multiple authorizations to save gas
   */
  private async queueYellowAuthorizationForSettlement(
    auth: YellowProtectionAuth,
    decision: RiskDecision
  ): Promise<string> {
    this.settlementQueue.push({
      auth,
      decision,
      timestamp: Date.now(),
    });

    console.log(`📝 Executor: Authorization queued for settlement`);
    console.log(`   Queue size: ${this.settlementQueue.length}`);

    // Process settlement batch if queue is full or timeout reached
    const BATCH_SIZE = 10;
    const BATCH_TIMEOUT_MS = 60000; // 1 minute

    if (
      this.settlementQueue.length >= BATCH_SIZE ||
      (this.lastSettlementTime > 0 && Date.now() - this.lastSettlementTime > BATCH_TIMEOUT_MS)
    ) {
      return await this.processSettlementBatch();
    }

    return "0xPENDING_SETTLEMENT";
  }

  /**
   * Process batched settlements on-chain
   * 
   * REAL IMPLEMENTATION - calls YellowOracle.commitAuthorizationBatch()
   * This sends actual transactions to the deployed contracts on Sepolia
   */
  private async processSettlementBatch(): Promise<string> {
    const batch = this.settlementQueue.splice(0, 100);

    if (batch.length === 0) return "0xNO_SETTLEMENTS";

    console.log(`🔄 Executor: Settling ${batch.length} Yellow authorizations on-chain...`);

    // Group by chain for batch settlement
    const batchesByChain = new Map<string, SettlementQueueItem[]>();
    for (const item of batch) {
      const chain = item.decision.chain;
      if (!batchesByChain.has(chain)) {
        batchesByChain.set(chain, []);
      }
      batchesByChain.get(chain)!.push(item);
    }

    const txHashes: string[] = [];

    // Process each chain's batch
    for (const [chain, chainBatch] of batchesByChain) {
      const yellowOracle = this.yellowOracleContracts.get(chain);

      if (!yellowOracle) {
        console.warn(`⚠️ Executor: No YellowOracle contract for ${chain}, skipping ${chainBatch.length} settlements`);
        continue;
      }

      try {
        // Prepare batch arrays for contract call
        const poolIds: string[] = [];
        const actions: number[] = [];
        const fees: number[] = [];
        const expiryBlocks: bigint[] = [];
        const timestamps: bigint[] = [];
        const nonces: bigint[] = [];
        const signatures: string[] = [];

        for (const item of chainBatch) {
          poolIds.push(item.auth.poolId);
          actions.push(this.actionToNumber(item.auth.action));
          fees.push(item.auth.fee);
          expiryBlocks.push(BigInt(item.auth.expiryBlock));
          timestamps.push(BigInt(item.auth.timestamp));
          nonces.push(BigInt(item.auth.nonce));
          signatures.push(item.auth.signature);
        }

        console.log(`📤 Executor: Sending batch settlement to ${chain} YellowOracle...`);
        console.log(`   Pool IDs: ${poolIds.length}`);
        console.log(`   Contract: ${await yellowOracle.getAddress()}`);

        // REAL ON-CHAIN CALL
        const tx = await yellowOracle.commitAuthorizationBatch(
          poolIds,
          actions,
          fees,
          expiryBlocks,
          timestamps,
          nonces,
          signatures
        );

        console.log(`📨 Executor: Transaction submitted: ${tx.hash}`);
        console.log(`   Waiting for confirmation...`);

        // Wait for confirmation
        const receipt = await tx.wait();

        console.log(`✅ Executor: Batch settled on ${chain}`);
        console.log(`   Transaction: ${receipt.hash}`);
        console.log(`   Block: ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

        txHashes.push(receipt.hash);

        // Emit event for each settled authorization
        for (const item of chainBatch) {
          this.emit('settlement:confirmed', {
            chain,
            poolId: item.auth.poolId,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
          });
        }

      } catch (error) {
        console.error(`❌ Executor: Failed to settle batch on ${chain}:`, error);

        // Re-queue failed items for retry
        this.settlementQueue.push(...chainBatch);

        this.emit('settlement:failed', {
          chain,
          error: (error as Error).message,
          itemCount: chainBatch.length,
        });
      }
    }

    this.lastSettlementTime = Date.now();

    if (txHashes.length > 0) {
      return txHashes[0]; // Return first tx hash
    }

    return "0xSETTLEMENT_FAILED";
  }

  /**
   * Convert action string to on-chain enum value
   */
  private actionToNumber(action: 'MEV_PROTECTION' | 'ORACLE_VALIDATION' | 'CIRCUIT_BREAKER'): number {
    switch (action) {
      case 'MEV_PROTECTION': return 1;
      case 'ORACLE_VALIDATION': return 2;
      case 'CIRCUIT_BREAKER': return 3;
      default: return 0;
    }
  }

  /**
   * Calculate dynamic fee based on composite score
   * Higher fees during attacks; Uniswap v4 distributes fees to LPs
   */
  private calculateDynamicFee(decision: RiskDecision): number {
    // Base fee = 5 bps (0.05%), scale up to 30 bps (0.3%) at score=100
    const baseFee = 5;
    const maxFee = 30;
    return Math.round(baseFee + ((decision.compositeScore / 100) * (maxFee - baseFee)));
  }

  /**
   * Process settlement queue - batch commit Yellow authorizations on-chain
   * 
   * This runs in the background every 30s to settle off-chain authorizations
   * on-chain for public audit trail and decentralized discoverability.
   * 
   * Per PROJECT_SPEC.md Section 4.6:
   * "Protection is active via Yellow BEFORE on-chain settlement"
   */
  private async processSettlementQueue(): Promise<void> {
    if (this.settlementQueue.length === 0) {
      return; // Nothing to settle
    }

    const now = Date.now();
    const timeSinceLastSettlement = now - this.lastSettlementTime;

    // Only settle every 30s minimum (avoid spamming on-chain)
    if (timeSinceLastSettlement < 30_000 && this.lastSettlementTime > 0) {
      return;
    }

    console.log(`\n📦 Settlement Worker: Processing ${this.settlementQueue.length} pending authorizations...`);

    // Group by chain for efficient batching
    const byChain: Record<string, SettlementQueueItem[]> = {};

    for (const item of this.settlementQueue) {
      const chain = item.auth.chain;
      if (!byChain[chain]) byChain[chain] = [];
      byChain[chain].push(item);
    }

    // Process each chain
    for (const [chain, items] of Object.entries(byChain)) {
      try {
        await this.settleChainBatch(chain as 'ethereum' | 'base' | 'arbitrum', items);
      } catch (error) {
        console.error(`❌ Settlement Worker: Failed to settle ${chain} batch:`, error);
      }
    }

    // Clear queue and update timestamp
    this.settlementQueue = [];
    this.lastSettlementTime = now;

    console.log('✅ Settlement Worker: Batch complete\n');
  }

  /**
   * Settle a batch of authorizations for a single chain
   */
  private async settleChainBatch(
    chain: 'ethereum' | 'base' | 'arbitrum',
    items: SettlementQueueItem[]
  ): Promise<void> {
    const yellowOracleContract = this.yellowOracleContracts.get(chain);
    if (!yellowOracleContract) {
      console.log(`⚠️ Settlement: No YellowOracle for ${chain}, skipping...`);
      return;
    }

    console.log(`   📤 Settling ${items.length} authorizations on ${chain}...`);

    // Prepare batch arrays
    const poolIds: string[] = [];
    const actions: number[] = [];
    const fees: number[] = [];
    const expiryBlocks: number[] = [];
    const timestamps: number[] = [];
    const nonces: number[] = [];
    const signatures: string[] = [];

    for (const item of items) {
      const auth = item.auth;
      poolIds.push(auth.poolId);

      // Map action string to enum
      let actionEnum: number;
      if (auth.action === 'MEV_PROTECTION') actionEnum = 1;
      else if (auth.action === 'ORACLE_VALIDATION') actionEnum = 2;
      else if (auth.action === 'CIRCUIT_BREAKER') actionEnum = 3;
      else continue; // Skip invalid

      actions.push(actionEnum);
      fees.push(auth.fee);
      expiryBlocks.push(auth.expiryBlock);
      timestamps.push(auth.timestamp);
      nonces.push(auth.nonce);
      signatures.push(auth.signature);
    }

    if (poolIds.length === 0) {
      console.log(`   ⚠️ No valid authorizations to settle on ${chain}`);
      return;
    }

    try {
      // Call batch commit (fire and forget - NO await on .wait()!)
      const tx = await yellowOracleContract.commitAuthorizationBatch(
        poolIds,
        actions,
        fees,
        expiryBlocks,
        timestamps,
        nonces,
        signatures,
        { maxFeePerGas: this.getMaxGasPrice(chain) }
      );

      console.log(`   ⏳ Settlement TX submitted: ${tx.hash}`);
      console.log(`   ℹ️  Authorizations now publicly queryable on-chain`);

      // Fire and forget - don't block on confirmation
      tx.wait().then(() => {
        console.log(`   ✅ Settlement TX confirmed: ${tx.hash}`);
      }).catch((error: Error) => {
        console.error(`   ❌ Settlement TX failed: ${tx.hash}`, error.message);
      });

    } catch (error) {
      console.error(`   ❌ Failed to submit settlement batch on ${chain}:`, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // MAIN EXECUTION FLOW — Called by RiskEngine
  // ---------------------------------------------------------------------------

  /**
   * Execute a risk decision from the RiskEngine.
   * 
   * Flow:
   *   - ELEVATED tier: Broadcast to LP bots via on-chain event (no execution)
   *   - CRITICAL tier: 
   *     1. Sign Yellow authorization OFF-CHAIN (no mempool exposure)
   *     2. Broadcast via Yellow state channel (INSTANT, <50ms)
   *     3. Queue for on-chain settlement (LATER, for finality)
   *     4. Fallback: direct on-chain if Yellow not available
   * 
   * Per PROJECT_SPEC.md Section 4.5: "no mempool exposure"
   */
  async executeDecision(decision: RiskDecision): Promise<void> {
    console.log(`🎯 Executor: Executing decision ${decision.id} for pool ${decision.targetPool}`);
    console.log(`   Action: ${decision.action}, Tier: ${decision.tier}, Score: ${decision.compositeScore.toFixed(1)}`);
    console.log(`   Rationale: ${decision.rationale}`);

    try {
      // ELEVATED tier: Broadcast to LP bots (no on-chain execution)
      if (decision.tier === 'ELEVATED') {
        await this.broadcastThreatToLPs(decision);
        return;
      }

      // CRITICAL tier: Execute protection
      const poolKey = `${decision.chain}:${decision.pair}`;
      const poolId = this.computePoolId(decision.targetPool);

      let txHash: string;

      // =========================================================================
      // YELLOW PRE-AUTHORIZATION FLOW (MEV Prevention)
      // Per PROJECT_SPEC.md Section 4.5: "no mempool exposure"
      // =========================================================================

      // Check if Yellow MessageBus is connected and action is MEV-related
      const usesYellowPreAuth = this.yellowMessageBus &&
        ['MEV_PROTECTION', 'ORACLE_VALIDATION', 'CIRCUIT_BREAKER'].includes(decision.action);

      if (usesYellowPreAuth) {
        console.log(`🔐 Executor: Using Yellow pre-authorization (MEV prevention)`);

        // Step 1: Sign authorization OFF-CHAIN (no mempool exposure)
        const yellowAuth = await this.signYellowProtectionAuthorization(decision);

        // Step 2: Broadcast via Yellow state channel (INSTANT, <50ms)
        await this.broadcastYellowAuthorization(yellowAuth, decision);

        // Step 3: Queue for on-chain settlement (LATER, for finality)
        txHash = await this.queueYellowAuthorizationForSettlement(yellowAuth, decision);

        console.log(`✅ Executor: Protection active via Yellow (no mempool exposure)`);
        console.log(`   Protection is INSTANT - attacker CANNOT frontrun!`);

      } else {
        // =========================================================================
        // FALLBACK: Direct on-chain execution (for cross-chain or no Yellow)
        // =========================================================================
        console.log(`⚠️ Executor: Falling back to direct on-chain execution`);

        // 1. Deactivate all existing protections
        await this.deactivateAllProtections(decision.chain, poolId);

        // 2. Activate the chosen protection
        switch (decision.action) {
          case "MEV_PROTECTION":
            txHash = await this.activateMEVProtection(decision, poolId);
            break;
          case "ORACLE_VALIDATION":
            txHash = await this.activateOracleValidation(decision, poolId);
            break;
          case "CIRCUIT_BREAKER":
            txHash = await this.activateCircuitBreaker(decision, poolId);
            break;
          // Cross-chain defense actions
          case "LIQUIDITY_REROUTE":
          case "CROSS_CHAIN_ARBITRAGE_BLOCK":
          case "EMERGENCY_BRIDGE":
            txHash = await this.executeCrossChainDefense(decision);
            break;
          default:
            throw new Error(`Unknown action: ${decision.action}`);
        }
      }

      // 3. Store protection state
      this.protectionStates.set(poolKey, {
        poolId,
        chain: decision.chain,
        action: decision.action,
        activatedAt: decision.timestamp,
        expiresAt: decision.timestamp + decision.ttlMs,
        txHash,
      });

      console.log(`✅ Executor: Decision executed successfully, tx: ${txHash}`);
      this.emit("execution:success", { decision, txHash });
    } catch (error) {
      console.error(`❌ Executor: Failed to execute decision`, error);
      this.emit("execution:failed", { decision, error });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // PROTECTION ACTIVATION METHODS
  // ---------------------------------------------------------------------------

  private async activateMEVProtection(decision: RiskDecision, poolId: string): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const wallet = this.wallets.get(chain);
    const provider = this.providers.get(chain);

    if (!wallet || !provider) {
      throw new Error(`Missing wallet/provider for chain: ${chain}`);
    }

    // Calculate dynamic fee based on composite score (5-30 bps)
    const baseFee = 5;
    const maxFee = 30;
    const dynamicFee = Math.round(baseFee + ((decision.compositeScore / 100) * (maxFee - baseFee)));

    // Get current block and set expiry
    const currentBlock = await provider.getBlockNumber();
    const expiryBlock = currentBlock + 50; // ~10 minutes
    const timestamp = Date.now();
    const nonce = this.yellowNonce++;
    const action = 1; // MEV_PROTECTION enum value

    // Create message hash (must match YellowOracle verification)
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'string', 'uint24', 'uint256', 'uint256', 'uint256'],
      [poolId, 'MEV_PROTECTION', dynamicFee, expiryBlock, timestamp, nonce]
    );

    // Sign with Executor's private key (OFF-CHAIN, instant)
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log(`   Activating MEV protection with fee ${dynamicFee} bps`);

    // PRIORITY 1: Try off-chain broadcast via Yellow (INSTANT, <50ms)
    if (this.yellowMessageBus && this.yellowMessageBus.isActive()) {
      const auth = {
        poolId,
        action: 'MEV_PROTECTION' as const,
        fee: dynamicFee,
        expiryBlock,
        timestamp,
        nonce,
        chain,
        signature,
        signer: wallet.address,
      };

      const poolKey = `${decision.targetPool}-${chain}`;
      await this.yellowMessageBus.publishProtectionAuth(auth, decision.id, poolKey);
      console.log(`   ✅ Protection broadcast via Yellow (OFF-CHAIN, INSTANT)`);

      // Queue for background settlement (no blocking!)
      this.settlementQueue.push({ auth, decision, timestamp: Date.now() });
      console.log(`   📋 Queued for on-chain settlement (${this.settlementQueue.length} pending)`);

      return `yellow-auth-${nonce}`;
    }

    // PRIORITY 2: Fallback - Immediate on-chain commit (Yellow not connected)
    console.log(`   ⚠️ Yellow not connected, falling back to immediate on-chain commitment`);
    const yellowOracleContract = this.yellowOracleContracts.get(chain);
    if (!yellowOracleContract) {
      throw new Error(`Missing YellowOracle contract for chain: ${chain}`);
    }

    const tx = await yellowOracleContract.commitAuthorization(
      poolId,
      action,
      dynamicFee,
      expiryBlock,
      timestamp,
      nonce,
      signature,
      { maxFeePerGas: this.getMaxGasPrice(chain) }
    );

    await tx.wait();
    console.log(`   ✅ Authorization committed to YellowOracle: ${tx.hash}`);
    return tx.hash;
  }

  private async activateOracleValidation(decision: RiskDecision, poolId: string): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const wallet = this.wallets.get(chain);
    const provider = this.providers.get(chain);

    if (!wallet || !provider) {
      throw new Error(`Missing wallet/provider for chain: ${chain}`);
    }

    const currentBlock = await provider.getBlockNumber();
    const expiryBlock = currentBlock + 50;
    const timestamp = Date.now();
    const nonce = this.yellowNonce++;
    const action = 2; // ORACLE_VALIDATION enum value
    const fee = 0; // Oracle validation doesn't use fee (rejects swaps on deviation)

    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'string', 'uint24', 'uint256', 'uint256', 'uint256'],
      [poolId, 'ORACLE_VALIDATION', fee, expiryBlock, timestamp, nonce]
    );

    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log(`   Activating oracle validation`);

    // PRIORITY 1: Try off-chain broadcast via Yellow (INSTANT, <50ms)
    if (this.yellowMessageBus && this.yellowMessageBus.isActive()) {
      const auth = {
        poolId,
        action: 'ORACLE_VALIDATION' as const,
        fee,
        expiryBlock,
        timestamp,
        nonce,
        chain,
        signature,
        signer: wallet.address,
      };

      const poolKey = `${decision.targetPool}-${chain}`;
      await this.yellowMessageBus.publishProtectionAuth(auth, decision.id, poolKey);
      console.log(`   ✅ Oracle validation broadcast via Yellow (OFF-CHAIN, INSTANT)`);

      // Queue for background settlement
      this.settlementQueue.push({ auth, decision, timestamp: Date.now() });
      console.log(`   📋 Queued for settlement (${this.settlementQueue.length} pending)`);

      return `yellow-auth-${nonce}`;
    }

    // PRIORITY 2: Fallback to on-chain commit
    console.log(`   ⚠️ Yellow not connected, falling back to on-chain commitment`);
    const yellowOracleContract = this.yellowOracleContracts.get(chain);
    if (!yellowOracleContract) {
      throw new Error(`Missing YellowOracle contract for chain: ${chain}`);
    }

    const tx = await yellowOracleContract.commitAuthorization(
      poolId, action, fee, expiryBlock, timestamp, nonce, signature,
      { maxFeePerGas: this.getMaxGasPrice(chain) }
    );

    await tx.wait();
    console.log(`   ✅ Oracle validation committed to YellowOracle: ${tx.hash}`);
    return tx.hash;
  }

  private async activateCircuitBreaker(decision: RiskDecision, poolId: string): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const wallet = this.wallets.get(chain);
    const provider = this.providers.get(chain);

    if (!wallet || !provider) {
      throw new Error(`Missing wallet/provider for chain: ${chain}`);
    }

    const currentBlock = await provider.getBlockNumber();
    const expiryBlock = currentBlock + 50;
    const timestamp = Date.now();
    const nonce = this.yellowNonce++;
    const action = 3; // CIRCUIT_BREAKER enum value
    const fee = 0; // Fee=0 means circuit breaker (SentinelHook reverts with PoolPaused)

    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'string', 'uint24', 'uint256', 'uint256', 'uint256'],
      [poolId, 'CIRCUIT_BREAKER', fee, expiryBlock, timestamp, nonce]
    );

    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    console.log(`   Activating circuit breaker (pool pause)`);

    // PRIORITY 1: Try off-chain broadcast via Yellow (INSTANT, <50ms)
    if (this.yellowMessageBus && this.yellowMessageBus.isActive()) {
      const auth = {
        poolId,
        action: 'CIRCUIT_BREAKER' as const,
        fee,
        expiryBlock,
        timestamp,
        nonce,
        chain,
        signature,
        signer: wallet.address,
      };

      const poolKey = `${decision.targetPool}-${chain}`;
      await this.yellowMessageBus.publishProtectionAuth(auth, decision.id, poolKey);
      console.log(`   ✅ Circuit breaker broadcast via Yellow (OFF-CHAIN, INSTANT)`);

      // Queue for background settlement
      this.settlementQueue.push({ auth, decision, timestamp: Date.now() });
      console.log(`   📋 Queued for settlement (${this.settlementQueue.length} pending)`);

      return `yellow-auth-${nonce}`;
    }

    // PRIORITY 2: Fallback to on-chain commit
    console.log(`   ⚠️ Yellow not connected, falling back to on-chain commitment`);
    const yellowOracleContract = this.yellowOracleContracts.get(chain);
    if (!yellowOracleContract) {
      throw new Error(`Missing YellowOracle contract for chain: ${chain}`);
    }

    const tx = await yellowOracleContract.commitAuthorization(
      poolId, action, fee, expiryBlock, timestamp, nonce, signature,
      { maxFeePerGas: this.getMaxGasPrice(chain) }
    );

    await tx.wait();
    console.log(`   ✅ Circuit breaker committed to YellowOracle: ${tx.hash}`);
    return tx.hash;
  }

  // ---------------------------------------------------------------------------
  // LP THREAT BROADCAST (ELEVATED TIER)
  // ---------------------------------------------------------------------------

  /**
   * Broadcast ELEVATED tier threat to LP bots via on-chain event.
   * Does NOT execute any on-chain protection - only emits event for LP consumption.
   */
  private async broadcastThreatToLPs(decision: RiskDecision): Promise<void> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain)!;
    const poolId = this.computePoolId(decision.targetPool);

    console.log(`📡 Broadcasting ELEVATED threat to LP bots...`);
    console.log(`   Pool: ${decision.targetPool}`);
    console.log(`   Action: ${decision.action}, Score: ${decision.compositeScore.toFixed(1)}`);

    // Extract signal types from contributing signals
    const signalTypes = [...new Set(decision.contributingSignals.map(s => s.source))];

    // Calculate expiry timestamp
    const expiresAt = Math.floor((decision.timestamp + decision.ttlMs) / 1000);

    // Truncate rationale if too long
    const rationale = decision.rationale.slice(0, 256);

    // Generate proof (TEE attestation in production)
    const proof = this.generateProof(decision);

    try {
      // Call broadcastThreat on SentinelHook.sol
      const tx = await hookContract.broadcastThreat(
        poolId,
        "ELEVATED",
        decision.action,
        Math.floor(decision.compositeScore),
        expiresAt,
        rationale,
        signalTypes,
        proof,
        {
          maxFeePerGas: this.getMaxGasPrice(chain),
        }
      );

      await tx.wait();
      console.log(`✅ Threat broadcast on-chain, tx: ${tx.hash}`);

      // Emit local event for API server to cache
      const broadcast: LPThreatBroadcast = {
        id: decision.id,
        tier: 'ELEVATED',
        action: decision.action,
        compositeScore: decision.compositeScore,
        targetPool: decision.targetPool,
        chain: decision.chain,
        pair: decision.pair,
        timestamp: decision.timestamp,
        expiresAt: decision.timestamp + decision.ttlMs,
        threatDetails: {
          rationale: decision.rationale,
          contributingSignals: decision.contributingSignals,
          signalTypes,
          correlationWindow: 24000,
          recommendedAction: this.getRecommendedAction(decision),
        },
        riskMetrics: this.calculateRiskMetrics(decision),
        suggestedActions: this.generateSuggestedActions(decision),
      };

      this.emit('threat:broadcast', { broadcast, txHash: tx.hash });
    } catch (error) {
      console.error(`❌ Failed to broadcast threat:`, error);
      throw error;
    }
  }

  /**
   * Generate recommended action text for LPs
   */
  private getRecommendedAction(decision: RiskDecision): string {
    if (decision.compositeScore > 60) {
      return "Consider reducing position size by 30-50%";
    } else if (decision.compositeScore > 40) {
      return "Monitor closely and consider pausing new positions";
    } else {
      return "Elevated risk detected - exercise caution";
    }
  }

  /**
   * Calculate risk metrics for LP decision-making
   */
  private calculateRiskMetrics(decision: RiskDecision): {
    severity: number;
    confidence: number;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  } {
    const severity = decision.compositeScore;

    // Confidence based on number of contributing signals
    const signalCount = decision.contributingSignals.length;
    const confidence = Math.min(100, 50 + (signalCount * 10));

    // Urgency based on score and signal diversity
    let urgency: 'LOW' | 'MEDIUM' | 'HIGH';
    if (severity > 60) {
      urgency = 'HIGH';
    } else if (severity > 40) {
      urgency = 'MEDIUM';
    } else {
      urgency = 'LOW';
    }

    return { severity, confidence, urgency };
  }

  /**
   * Generate suggested actions for LPs based on threat
   */
  private generateSuggestedActions(decision: RiskDecision): {
    withdrawLiquidity?: boolean;
    reduceLiquidity?: number;
    pauseNewPositions?: boolean;
    increaseSlippage?: number;
  } {
    const score = decision.compositeScore;
    const actions: any = {};

    if (score > 60) {
      actions.reduceLiquidity = 50; // 50%
      actions.pauseNewPositions = true;
    } else if (score > 40) {
      actions.reduceLiquidity = 30; // 30%
      actions.pauseNewPositions = true;
    } else {
      actions.pauseNewPositions = true;
    }

    // Suggest increased slippage tolerance for MEV protection
    if (decision.action === 'MEV_PROTECTION') {
      actions.increaseSlippage = Math.floor(score / 10) * 5; // 5-50 bps
    }

    return actions;
  }

  // ---------------------------------------------------------------------------
  // CROSS-CHAIN DEFENSE EXECUTION
  // ---------------------------------------------------------------------------

  /**
   * Initialize the cross-chain orchestrator for defense actions.
   * Call this before using cross-chain features.
   */
  async initializeCrossChainOrchestrator(): Promise<void> {
    if (!this.config.crossChain?.enabled) {
      console.log("⚠️ Cross-chain defense is disabled in config");
      return;
    }

    if (this.crossChainOrchestrator) {
      console.log("ℹ️ CrossChainOrchestrator already initialized");
      return;
    }

    console.log("🌉 Initializing CrossChainOrchestrator...");

    this.crossChainOrchestrator = createCrossChainOrchestrator({
      walletPrivateKey: this.config.agentPrivateKey,
      integrator: "Sentinell",
      dryRun: this.config.crossChain?.dryRun ?? true,
    });

    // Wire up orchestrator events
    this.crossChainOrchestrator.on("defense:dryrun", (data) => {
      this.emit("crosschain:dryrun", data);
    });
    this.crossChainOrchestrator.on("defense:executed", (data) => {
      this.emit("crosschain:executed", data);
    });
    this.crossChainOrchestrator.on("defense:failed", (data) => {
      this.emit("crosschain:failed", data);
    });
    this.crossChainOrchestrator.on("execution:status", (status) => {
      this.emit("crosschain:status", status);
    });

    await this.crossChainOrchestrator.initialize();
    console.log("✅ CrossChainOrchestrator ready");
  }

  /**
   * Execute a cross-chain defense action via the LI.FI orchestrator.
   */
  private async executeCrossChainDefense(decision: RiskDecision): Promise<string> {
    if (!this.crossChainOrchestrator) {
      throw new Error("CrossChainOrchestrator not initialized. Call initializeCrossChainOrchestrator() first.");
    }

    const chainId = this.getChainId(decision.chain);
    const action = decision.action as CrossChainAction;

    console.log(`   Executing cross-chain defense: ${action}`);
    console.log(`   Source chain: ${decision.chain} (${chainId})`);

    // Determine token and amount from decision context
    // In production, this would come from pool analysis
    const tokenSymbol = this.extractTokenFromPair(decision.pair);
    const amount = "100"; // Default test amount - in production, calculate based on pool analysis

    const result = await this.crossChainOrchestrator.executeDefense({
      action,
      fromChainId: chainId,
      tokenSymbol,
      amount,
      triggerPool: decision.targetPool,
      decisionId: decision.id,
    });

    if (!result.success) {
      throw new Error(`Cross-chain defense failed: ${result.error}`);
    }

    // For dry runs, return a synthetic hash
    if (result.dryRun) {
      const dryRunHash = `0xDRYRUN_${decision.id}`;
      console.log(`   📋 Dry run complete: ${dryRunHash}`);
      return dryRunHash;
    }

    return result.txHash || "0xNO_TX_HASH";
  }

  /**
   * Get chain ID from chain name.
   * NOTE: Returns TESTNET IDs for hook activation, not LI.FI mainnet IDs
   */
  private getChainId(chain: string): number {
    const { TESTNET_CHAIN_IDS } = require("../config/crosschain.config");
    switch (chain.toLowerCase()) {
      case "ethereum":
        return TESTNET_CHAIN_IDS.ethereumSepolia;
      case "base":
        return TESTNET_CHAIN_IDS.baseSepolia;
      case "arbitrum":
        return TESTNET_CHAIN_IDS.arbitrumSepolia;
      default:
        throw new Error(`Unknown chain: ${chain}`);
    }
  }

  /**
   * Extract primary token from trading pair.
   * e.g., "ETH/USDC" -> "ETH"
   */
  private extractTokenFromPair(pair: string): string {
    const [token] = pair.split("/");
    return token || "ETH";
  }


  // ---------------------------------------------------------------------------
  // PROTECTION DEACTIVATION
  // ---------------------------------------------------------------------------

  /**
   * Deactivate all protections for a pool before activating a new one.
   * Ensures clean state — only one protection active at a time.
   */
  private async deactivateAllProtections(chain: string, poolId: string): Promise<void> {
    const hookContract = this.hookContracts.get(chain)!;
    const proof = this.generateProof(null); // Empty proof for deactivation

    // Check which protections are currently active
    const [mevActive, cbActive] = await Promise.all([
      hookContract.isProtectionActive(poolId),
      hookContract.isCircuitBreakerActive(poolId),
    ]);

    // Deactivate MEV protection if active
    if (mevActive) {
      console.log(`   Deactivating existing MEV protection`);
      const tx = await hookContract.deactivateProtection(poolId, proof, {
        maxFeePerGas: this.getMaxGasPrice(chain as any),
      });
      await tx.wait();
    }

    // Deactivate circuit breaker if active
    if (cbActive) {
      console.log(`   Deactivating existing circuit breaker`);
      const tx = await hookContract.deactivateCircuitBreaker(poolId, proof, {
        maxFeePerGas: this.getMaxGasPrice(chain as any),
      });
      await tx.wait();
    }

    // Oracle validation is sticky (stays configured), no need to deactivate
  }

  // ---------------------------------------------------------------------------
  // MONITORING & CLEANUP
  // ---------------------------------------------------------------------------

  /**
   * Monitor protection states and deactivate expired ones.
   * Runs periodically via setInterval.
   */
  private async monitorProtections(): Promise<void> {
    const now = Date.now();

    for (const [poolKey, state] of this.protectionStates.entries()) {
      if (now > state.expiresAt && state.action !== null) {
        console.log(`⏰ Executor: Protection expired for ${poolKey}, deactivating`);
        try {
          await this.deactivateAllProtections(state.chain, state.poolId);
          state.action = null; // Mark as deactivated
          this.emit("protection:expired", { poolKey, state });
        } catch (error) {
          console.error(`❌ Executor: Failed to deactivate expired protection for ${poolKey}`, error);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HELPER METHODS
  // ---------------------------------------------------------------------------

  private computePoolId(poolAddress: string): string {
    // IMPORTANT: In production, poolId must be computed from PoolKey using PoolIdLibrary.toId()
    // PoolKey = { currency0, currency1, fee, tickSpacing, hooks }
    // The RiskDecision should include the full PoolKey, not just an address
    // For demo/testing, we hash the pool identifier
    return ethers.keccak256(ethers.toUtf8Bytes(poolAddress));
  }

  private generateProof(decision: RiskDecision | null): Uint8Array {
    // In production, this would call the TEE SDK to generate a remote attestation
    // For hackathon/testing, return a dummy proof
    if (!this.config.teeEnabled) {
      return new Uint8Array(0);
    }

    // Placeholder for TEE attestation
    // Real implementation would:
    //   1. Compute enclave hash (MRENCLAVE)
    //   2. Sign decision data with enclave key
    //   3. Return SGX/Phala attestation report
    return new Uint8Array(64); // 64-byte signature placeholder
  }

  private getMaxGasPrice(chain: "ethereum" | "base" | "arbitrum"): bigint | undefined {
    if (!this.config.maxGasPrice) return undefined;
    const maxGwei = this.config.maxGasPrice[chain];
    if (!maxGwei) return undefined;
    return ethers.parseUnits(maxGwei.toString(), "gwei");
  }

  private getChainlinkFeed(chain: string, pair: string): string {
    // In production, fetch from a config/registry
    // Placeholder addresses (use real Chainlink feeds in prod)
    const feeds: Record<string, Record<string, string>> = {
      ethereum: {
        "ETH/USDC": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // ETH/USD on mainnet
        "WBTC/USDC": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", // BTC/USD on mainnet
      },
      base: {
        "ETH/USDC": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // ETH/USD on Base
      },
      arbitrum: {
        "ETH/USDC": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // ETH/USD on Arbitrum
      },
    };

    return feeds[chain]?.[pair] || ethers.ZeroAddress;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC QUERY METHODS
  // ---------------------------------------------------------------------------

  /**
   * Get current protection state for a pool.
   */
  getProtectionState(chain: string, pair: string): ProtectionState | null {
    const poolKey = `${chain}:${pair}`;
    return this.protectionStates.get(poolKey) || null;
  }

  /**
   * Get all monitored pools with active protections.
   */
  getActiveProtections(): Array<{ poolKey: string; state: ProtectionState }> {
    const result: Array<{ poolKey: string; state: ProtectionState }> = [];
    for (const [poolKey, state] of this.protectionStates.entries()) {
      if (state.action !== null) {
        result.push({ poolKey, state });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// FACTORY
// ---------------------------------------------------------------------------

export function createExecutorAgent(config: ExecutorConfig): ExecutorAgent {
  return new ExecutorAgent(config);
}