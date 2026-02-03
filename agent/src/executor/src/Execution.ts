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
import {
  CrossChainOrchestrator,
  CrossChainOrchestratorConfig,
  createCrossChainOrchestrator,
  type CrossChainAction,
  type ExecutionResult,
} from "./CrossChainOrchestrator";
import { ACTIVE_CHAIN_IDS } from "../config/crosschain.config";

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

const HOOK_ABI = [
  "function activateProtection(bytes32 poolId, uint24 newFee, bytes calldata proof) external",
  "function deactivateProtection(bytes32 poolId, bytes calldata proof) external",
  "function activateCircuitBreaker(bytes32 poolId, string calldata reason, bytes calldata proof) external",
  "function deactivateCircuitBreaker(bytes32 poolId, bytes calldata proof) external",
  "function configureOracle(bytes32 poolId, address chainlinkFeed, uint256 deviationThreshold, bytes calldata proof) external",
  
  "function isProtectionActive(bytes32 poolId) external view returns (bool)",
  "function isCircuitBreakerActive(bytes32 poolId) external view returns (bool)",
  "function getActiveFee(bytes32 poolId) external view returns (uint24)",
  "function configs(bytes32 poolId) external view returns (bool circuitBreakerEnabled, bool oracleValidationEnabled, bool antiSandwichEnabled)",
  
  "event ProtectionActivated(bytes32 indexed poolId, uint24 newFee, uint256 expiryBlock, address activatedBy)",
  "event CircuitBreakerActivated(bytes32 indexed poolId, address indexed activatedBy, uint256 activatedAt, uint256 expiryBlock, string reason)",
];

export class ExecutorAgent extends EventEmitter {
  private config: ExecutorConfig;
  private providers: Map<string, ethers.Provider>;
  private wallets: Map<string, ethers.Wallet>;
  private hookContracts: Map<string, ethers.Contract>;
  private crossChainOrchestrator?: CrossChainOrchestrator;
  
  private protectionStates: Map<string, ProtectionState>;
  
  private isRunning = false;
  private monitorInterval?: ReturnType<typeof setInterval>;

  constructor(config: ExecutorConfig) {
    super();
    this.config = config;
    this.providers = new Map();
    this.wallets = new Map();
    this.hookContracts = new Map();
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

    // Monitor protection expirations
    this.monitorInterval = setInterval(() => {
      this.monitorProtections();
    }, 12_000); // Every ~1 ETH block

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

    this.isRunning = false;
    console.log("✅ Executor: Stopped");
    this.emit("executor:stopped");
  }

  // ---------------------------------------------------------------------------
  // MAIN EXECUTION FLOW — Called by RiskEngine
  // ---------------------------------------------------------------------------

  /**
   * Execute a risk decision from the RiskEngine.
   * 
   * Flow:
   *   1. Deactivate all existing protections for this pool
   *   2. Activate the chosen protection based on decision.action
   *   3. Store protection state for monitoring
   *   4. Emit success/failure events
   */
  async executeDecision(decision: RiskDecision): Promise<void> {
    console.log(`🎯 Executor: Executing decision ${decision.id} for pool ${decision.targetPool}`);
    console.log(`   Action: ${decision.action}, Tier: ${decision.tier}, Score: ${decision.compositeScore.toFixed(1)}`);
    console.log(`   Rationale: ${decision.rationale}`);

    try {
      const poolKey = `${decision.chain}:${decision.pair}`;
      const poolId = this.computePoolId(decision.targetPool);

      // 1. Deactivate all existing protections
      await this.deactivateAllProtections(decision.chain, poolId);

      // 2. Activate the chosen protection
      let txHash: string;
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
    const hookContract = this.hookContracts.get(chain)!;

    // Calculate dynamic fee based on composite score
    // Base fee = 5 bps (0.05%), scale up to 30 bps (0.3%) at score=100
    // Higher fees during attacks; Uniswap v4 automatically distributes fees to LPs
    const baseFee = 5;
    const maxFee = 30;
    const dynamicFee = Math.round(baseFee + ((decision.compositeScore / 100) * (maxFee - baseFee)));

    console.log(`   Activating MEV protection with dynamic fee ${dynamicFee} bps`);

    // Generate proof (TEE attestation in production)
    const proof = this.generateProof(decision);

    // Call hook contract
    const tx = await hookContract.activateProtection(poolId, dynamicFee, proof, {
      maxFeePerGas: this.getMaxGasPrice(chain),
    });

    await tx.wait();
    return tx.hash;
  }

  private async activateOracleValidation(decision: RiskDecision, poolId: string): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain)!;

    console.log(`   Activating oracle validation`);

    // Oracle config: Chainlink feed address + deviation threshold
    // In production, fetch these from a registry based on decision.pair
    const chainlinkFeed = this.getChainlinkFeed(chain, decision.pair);
    const deviationThreshold = 200; // 2% (in basis points)

    const proof = this.generateProof(decision);

    const tx = await hookContract.configureOracle(poolId, chainlinkFeed, deviationThreshold, proof, {
      maxFeePerGas: this.getMaxGasPrice(chain),
    });

    await tx.wait();
    return tx.hash;
  }

  private async activateCircuitBreaker(decision: RiskDecision, poolId: string): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain)!;

    console.log(`   Activating circuit breaker (pool pause)`);

    // Truncate rationale if too long
    const reason = decision.rationale.slice(0, 256);

    const proof = this.generateProof(decision);

    const tx = await hookContract.activateCircuitBreaker(poolId, reason, proof, {
      maxFeePerGas: this.getMaxGasPrice(chain),
    });

    await tx.wait();
    return tx.hash;
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
   */
  private getChainId(chain: string): number {
    switch (chain.toLowerCase()) {
      case "ethereum":
        return ACTIVE_CHAIN_IDS.ethereumSepolia;
      case "base":
        return ACTIVE_CHAIN_IDS.baseSepolia;
      case "arbitrum":
        return ACTIVE_CHAIN_IDS.arbitrumSepolia;
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