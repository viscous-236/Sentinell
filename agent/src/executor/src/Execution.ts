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
import {
  YellowMessageBus,
  YellowProtectionAuth,
} from "../../shared/yellow/YellowMessageBus";

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
  "function broadcastThreat(bytes32 poolId, string calldata tier, string calldata action, uint256 compositeScore, uint256 expiresAt, string calldata rationale, string[] calldata signalTypes, bytes calldata proof) external",

  "function isProtectionActive(bytes32 poolId) external view returns (bool)",
  "function isCircuitBreakerActive(bytes32 poolId) external view returns (bool)",
  "function getActiveFee(bytes32 poolId) external view returns (uint24)",
  "function configs(bytes32 poolId) external view returns (bool circuitBreakerEnabled, bool oracleValidationEnabled, bool antiSandwichEnabled)",

  "event ProtectionActivated(bytes32 indexed poolId, uint24 newFee, uint256 expiryBlock, address activatedBy)",
  "event CircuitBreakerActivated(bytes32 indexed poolId, address indexed activatedBy, uint256 activatedAt, uint256 expiryBlock, string reason)",
  "event ThreatBroadcast(bytes32 indexed poolId, string tier, string action, uint256 compositeScore, uint256 timestamp, uint256 expiresAt, string rationale, string[] signalTypes)",
];

export class ExecutorAgent extends EventEmitter {
  private config: ExecutorConfig;
  private providers: Map<string, ethers.Provider>;
  private wallets: Map<string, ethers.Wallet>;
  private hookContracts: Map<string, ethers.Contract>;
  private crossChainOrchestrator?: CrossChainOrchestrator;
  private threatAPIServer?: ThreatAPIServer;

  private protectionStates: Map<string, ProtectionState>;

  private isRunning = false;
  private monitorInterval?: ReturnType<typeof setInterval>;

  // =========================================================================
  // YELLOW MESSAGBUS FOR AGENT COORDINATION
  // Per PROJECT_SPEC.md Section 4.5: Agent-to-agent communication
  // =========================================================================
  private yellowMessageBus?: YellowMessageBus;
  
  // Decision prioritization: pool -> pending decision
  private pendingDecisions: Map<string, RiskDecision> = new Map();
  private decisionTimer?: NodeJS.Timeout;

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
    this.on("yellow:decision", async (decision: RiskDecision) => {
      console.log(
        `📥 Executor: Received decision via Yellow state channel: ${decision.id}`,
      );
      
      // Priority handling: if multiple decisions for same pool, only execute highest tier
      const existing = this.pendingDecisions.get(decision.targetPool);
      if (existing) {
        const existingPriority = this.getTierPriority(existing.tier);
        const newPriority = this.getTierPriority(decision.tier);
        
        if (newPriority > existingPriority) {
          console.log(`   ⚡ Replacing ${existing.action} (${existing.tier}) with ${decision.action} (${decision.tier}) - higher priority`);
          this.pendingDecisions.set(decision.targetPool, decision);
        } else {
          console.log(`   ⏭️  Skipping ${decision.action} (${decision.tier}) - ${existing.action} (${existing.tier}) has higher priority`);
          return;
        }
      } else {
        this.pendingDecisions.set(decision.targetPool, decision);
      }
      
      // Debounce execution: wait 200ms for more decisions to arrive
      if (this.decisionTimer) {
        clearTimeout(this.decisionTimer);
      }
      
      this.decisionTimer = setTimeout(() => {
        this.executeQueuedDecisions();
      }, 200);
    });

    // Listen for threat broadcasts to cache in API
    this.on("threat:broadcast", ({ broadcast, txHash }) => {
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

    const chains: Array<"ethereum" | "base" | "arbitrum"> = [
      "ethereum",
      "base",
      "arbitrum",
    ];

    for (const chain of chains) {
      const provider = new ethers.JsonRpcProvider(this.config.rpcUrls[chain]);
      this.providers.set(chain, provider);

      const wallet = new ethers.Wallet(this.config.agentPrivateKey, provider);
      this.wallets.set(chain, wallet);

      const hookContract = new ethers.Contract(
        this.config.hookAddresses[chain],
        HOOK_ABI,
        wallet,
      );
      this.hookContracts.set(chain, hookContract);

      console.log(
        `✅ Executor: Connected to ${chain} hook at ${this.config.hookAddresses[chain]}`,
      );
    }

    // Initialize cross-chain orchestrator for cross-chain defense actions
    await this.initializeCrossChainOrchestrator();

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

    // NOTE: No settlement queue needed - we commit immediately on-chain
    // Yellow MessageBus is used for agent-to-agent coordination only

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

    // Stop Threat API server
    if (this.threatAPIServer) {
      await this.threatAPIServer.stop();
    }

    this.isRunning = false;
    
    if (this.decisionTimer) {
      clearTimeout(this.decisionTimer);
      this.decisionTimer = undefined;
    }
    
    console.log("✅ Executor: Stopped");
    this.emit("executor:stopped");
  }

  // ---------------------------------------------------------------------------
  // DECISION PRIORITIZATION
  // ---------------------------------------------------------------------------

  private getTierPriority(tier: ThreatTier): number {
    switch (tier) {
      case "CRITICAL": return 3;
      case "ELEVATED": return 2;
      case "WATCH": return 1;
      default: return 0;
    }
  }

  private async executeQueuedDecisions(): Promise<void> {
    const decisions = Array.from(this.pendingDecisions.values());
    this.pendingDecisions.clear();
    
    for (const decision of decisions) {
      try {
        await this.executeDecision(decision);
      } catch (error) {
        console.error("❌ Executor: Failed to execute Yellow decision:", error);
        this.emit("execution:failure", {
          decision,
          error: (error as Error).message,
        });
      }
    }
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
    console.log(
      "✅ Executor: Yellow MessageBus connected for pre-authorization",
    );
  }

  /**
   * Calculate dynamic fee based on composite score
   * Higher fees during attacks; Uniswap v4 distributes fees to LPs
   * 
   * Uniswap v4 fee format: 1 bps = 100 (parts per million representation)
   * Example: 5 bps = 500, 30 bps = 3000, MAX_FEE = 50000 (5%)
   * 
   * IMPORTANT: Fee must be > baseFee (3000 = 30 bps) set in contract deployment
   * 
   * Scaling:
   * - Score 0 → 32 bps (3200) - just above base fee
   * - Score 50 → 100 bps (10000) - 1%
   * - Score 100 → 200 bps (20000) - 2% (makes most MEV attacks unprofitable)
   */
  private calculateDynamicFee(decision: RiskDecision): number {
    // Scale from 32 bps to 200 bps based on threat score
    const minFeeInBps = 32;  // Just above baseFee (30 bps)
    const maxFeeInBps = 200; // Maximum dynamic fee (2%)
    
    const feeInBps = Math.round(
      minFeeInBps + (decision.compositeScore / 100) * (maxFeeInBps - minFeeInBps),
    );
    
    // Convert from bps to Uniswap v4 format (multiply by 100)
    // 32 bps -> 3200, 200 bps -> 20000
    return feeInBps * 100;
  }

  // ---------------------------------------------------------------------------
  // MAIN EXECUTION FLOW — Called by RiskEngine
  // ---------------------------------------------------------------------------

  /**
   * Execute a risk decision from the RiskEngine.
   *
   * Flow:
   *   - ELEVATED tier: Broadcast threat to LP bots via on-chain event (informational)
   *   - CRITICAL tier:
   *     1. Executor calls hook activation methods directly (on-chain)
   *     2. Protection active at pool level (~12s)
   *     3. All future swaps automatically protected
   *
   * Architecture: Direct hook calls (Executor → Hook)
   * - Hook state is single source of truth (protections[], breakers[], oracleConfigs[])
   * - Yellow MessageBus: Used ONLY for agent-to-agent coordination (Scout→RiskEngine→Executor)
   * - No intermediate authorization layer needed
   */
  async executeDecision(decision: RiskDecision): Promise<void> {
    console.log(
      `🎯 Executor: Executing decision ${decision.id} for pool ${decision.targetPool}`,
    );
    console.log(
      `   Action: ${decision.action}, Tier: ${decision.tier}, Score: ${decision.compositeScore.toFixed(1)}`,
    );
    console.log(`   Rationale: ${decision.rationale}`);

    try {
      // ELEVATED tier: Broadcast to LP bots (no on-chain execution)
      if (decision.tier === "ELEVATED") {
        await this.broadcastThreatToLPs(decision);
        return;
      }

      // CRITICAL tier: Execute protection
      const poolKey = `${decision.chain}:${decision.pair}`;
      const poolId = this.computePoolId(decision.targetPool);

      let txHash: string;

      // =========================================================================
      // IMMEDIATE PROTECTION ACTIVATION
      // Calls hook methods directly - hook state is single source of truth
      // =========================================================================

      console.log(`🔐 Executor: Activating protection via hook methods`);

      // 1. Deactivate all existing protections
      await this.deactivateAllProtections(decision.chain, poolId);

      // 2. Activate the chosen protection (calls hook method directly)
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

  private async activateMEVProtection(
    decision: RiskDecision,
    poolId: string,
  ): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain);

    if (!hookContract) {
      throw new Error(`Missing hook contract for chain: ${chain}`);
    }

    // Calculate dynamic fee based on composite score (5-30 bps = 500-3000 in Uniswap v4 format)
    const dynamicFee = this.calculateDynamicFee(decision);
    const feeInBps = dynamicFee / 100; // Convert back to bps for display

    console.log(`   Activating MEV protection with fee ${feeInBps} bps (${dynamicFee} in contract format)`);
    console.log(`   Calling hook.activateProtection() directly...`);

    // Generate proof (TEE attestation in production)
    const proof = this.generateProof(decision);

    // Call hook activation method directly (Executor → Hook)
    const tx = await hookContract.activateProtection(
      poolId,
      dynamicFee,
      proof,
      { maxFeePerGas: this.getMaxGasPrice(chain) },
    );

    await tx.wait();

    console.log(`   ✅ Protection activated on-chain: ${tx.hash}`);
    console.log(
      `   🛡️  All swaps will now use dynamic fee=${feeInBps} bps (${(feeInBps / 100).toFixed(2)}%)`,
    );
    console.log(`   👥 Protection applies to ALL users transparently`);

    return tx.hash;
  }

  private async activateOracleValidation(
    decision: RiskDecision,
    poolId: string,
  ): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain);

    if (!hookContract) {
      throw new Error(`Missing hook contract for chain: ${chain}`);
    }

    // Get Chainlink feed address based on chain (Sepolia testnet addresses)
    // Use ETH/USD feed as default for all pools (in production, use pool-specific feeds)
    const chainlinkFeeds: Record<string, string> = {
      ethereum: "0x694AA1769357215DE4FAC081bf1f309aDC325306", // ETH/USD Sepolia
      base: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", // ETH/USD Base Sepolia
      arbitrum: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", // ETH/USD Arbitrum Sepolia
    };

    const chainlinkFeed = chainlinkFeeds[chain];
    if (!chainlinkFeed) {
      throw new Error(`No Chainlink feed configured for chain: ${chain}`);
    }

    const threshold = 200; // 2% deviation threshold (200 basis points)

    console.log(`   Activating oracle validation`);
    console.log(`   Chainlink feed: ${chainlinkFeed} (${chain} Sepolia)`);
    console.log(`   Deviation threshold: ${threshold} bps (2%)`);
    console.log(`   Calling hook.configureOracle() directly...`);

    // Generate proof (TEE attestation in production)
    const proof = this.generateProof(decision);

    // Call hook configuration method directly (Executor → Hook)
    const tx = await hookContract.configureOracle(
      poolId,
      chainlinkFeed,
      threshold,
      proof,
      { maxFeePerGas: this.getMaxGasPrice(chain) },
    );

    await tx.wait();

    console.log(
      `   ✅ Oracle validation activated on-chain: ${tx.hash}`,
    );
    console.log(
      `   🛡️  All swaps will now be rejected on oracle deviation > ${threshold} bps`,
    );

    return tx.hash;
  }

  private async activateCircuitBreaker(
    decision: RiskDecision,
    poolId: string,
  ): Promise<string> {
    const chain = decision.chain as "ethereum" | "base" | "arbitrum";
    const hookContract = this.hookContracts.get(chain);

    if (!hookContract) {
      throw new Error(`Missing hook contract for chain: ${chain}`);
    }

    // Use decision rationale as circuit breaker reason
    const reason = decision.rationale.slice(0, 256); // Max 256 chars

    console.log(`   Activating circuit breaker (pool pause)`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Calling hook.activateCircuitBreaker() directly...`);

    // Generate proof (TEE attestation in production)
    const proof = this.generateProof(decision);

    // Call hook breaker method directly (Executor → Hook)
    const tx = await hookContract.activateCircuitBreaker(
      poolId,
      reason,
      proof,
      { maxFeePerGas: this.getMaxGasPrice(chain) },
    );

    await tx.wait();

    console.log(`   ✅ Circuit breaker activated on-chain: ${tx.hash}`);
    console.log(
      `   🚫 Pool completely paused`,
    );
    console.log(`   🛡️  All swaps will be rejected`);

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
    console.log(
      `   Action: ${decision.action}, Score: ${decision.compositeScore.toFixed(1)}`,
    );

    // Extract signal types from contributing signals
    const signalTypes = [
      ...new Set(decision.contributingSignals.map((s) => s.source)),
    ];

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
        },
      );

      await tx.wait();
      console.log(`✅ Threat broadcast on-chain, tx: ${tx.hash}`);

      // Emit local event for API server to cache
      const broadcast: LPThreatBroadcast = {
        id: decision.id,
        tier: "ELEVATED",
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

      this.emit("threat:broadcast", { broadcast, txHash: tx.hash });
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
    urgency: "LOW" | "MEDIUM" | "HIGH";
  } {
    const severity = decision.compositeScore;

    // Confidence based on number of contributing signals
    const signalCount = decision.contributingSignals.length;
    const confidence = Math.min(100, 50 + signalCount * 10);

    // Urgency based on score and signal diversity
    let urgency: "LOW" | "MEDIUM" | "HIGH";
    if (severity > 60) {
      urgency = "HIGH";
    } else if (severity > 40) {
      urgency = "MEDIUM";
    } else {
      urgency = "LOW";
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
    if (decision.action === "MEV_PROTECTION") {
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

    const isDryRun = this.config.crossChain?.dryRun ?? true;
    
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("🌉 Initializing Cross-Chain Defense System (LI.FI)");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`   Mode: ${isDryRun ? '📋 DRY RUN (Simulation)' : '⚠️ LIVE EXECUTION'}`);
    
    if (isDryRun) {
      console.log("\n   ℹ️  LI.FI MAINNET REQUIREMENT:");
      console.log("   • LI.FI SDK operates on MAINNET chains only");
      console.log("   • Cross-chain actions require mainnet funds (ETH, USDC, etc.)");
      console.log("   • Current mode: DRY RUN - simulating actions without executing");
      console.log("   • Set CROSSCHAIN_DRY_RUN=false in .env for live execution (requires mainnet funds)");
    } else {
      console.log("\n   ⚠️  WARNING: LIVE EXECUTION MODE");
      console.log("   • Will execute real cross-chain transactions on mainnet");
      console.log("   • Requires sufficient mainnet funds for gas + bridging");
      console.log("   • Transactions are irreversible");
    }
    console.log("═══════════════════════════════════════════════════════════\n");

    this.crossChainOrchestrator = createCrossChainOrchestrator({
      walletPrivateKey: this.config.agentPrivateKey,
      integrator: "Sentinell",
      dryRun: isDryRun,
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
  private async executeCrossChainDefense(
    decision: RiskDecision,
  ): Promise<string> {
    if (!this.crossChainOrchestrator) {
      throw new Error(
        "CrossChainOrchestrator not initialized. Call initializeCrossChainOrchestrator() first.",
      );
    }

    const chainId = this.getChainId(decision.chain);
    const action = decision.action as CrossChainAction;
    const tokenSymbol = this.extractTokenFromPair(decision.pair);
    const amount = "100"; // Default test amount - in production, calculate based on pool analysis

    // For logging, show pair or fallback
    const displayPair = decision.pair || "Multi-asset pool";
    const displayToken = tokenSymbol === "UNKNOWN" ? "ETH (default)" : tokenSymbol;

    console.log("\n🌉 ═══════════════════════════════════════════════════════════");
    console.log(`   CROSS-CHAIN DEFENSE: ${action}`);
    console.log("   ═══════════════════════════════════════════════════════════");
    console.log(`   Source chain: ${decision.chain} (Chain ID: ${chainId})`);
    console.log(`   Target pool: ${decision.targetPool}`);
    console.log(`   Pair: ${displayPair}`);
    console.log(`   Token: ${displayToken}`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Trigger: ${decision.rationale}`);
    
    console.log("\n   📋 WHAT THIS ACTION DOES:");
    switch (action) {
      case "LIQUIDITY_REROUTE":
        console.log(`   • Moves liquidity from ${decision.chain} to a safer chain`);
        console.log(`   • Uses LI.FI to bridge ${tokenSymbol} cross-chain`);
        console.log("   • Protects against chain-specific attacks");
        break;
      case "CROSS_CHAIN_ARBITRAGE_BLOCK":
        console.log("   • Blocks detected cross-chain arbitrage exploit");
        console.log(`   • Prevents profit extraction via ${decision.chain} bridge`);
        console.log("   • Temporarily restricts cross-chain swaps");
        break;
      case "EMERGENCY_BRIDGE":
        console.log(`   • EMERGENCY: Fast exit from ${decision.chain}`);
        console.log("   • Bridges all at-risk assets to safe haven chain");
        console.log("   • Highest priority cross-chain defense");
        break;
    }

    const result = await this.crossChainOrchestrator.executeDefense({
      action,
      fromChainId: chainId,
      tokenSymbol,
      amount,
      triggerPool: decision.targetPool,
      decisionId: decision.id,
    });

    if (!result.success) {
      console.log("   ❌ Failed:", result.error);
      throw new Error(`Cross-chain defense failed: ${result.error}`);
    }

    // For dry runs, return a synthetic hash
    if (result.dryRun) {
      const dryRunHash = `0xDRYRUN_${decision.id}`;
      console.log("\n   ✅ DRY RUN COMPLETE (Simulated)");
      console.log("   • No mainnet funds spent");
      console.log("   • Action validated successfully");
      console.log(`   • Would execute on mainnet if CROSSCHAIN_DRY_RUN=false`);
      console.log(`   • Synthetic TX: ${dryRunHash}`);
      console.log("   ═══════════════════════════════════════════════════════════\n");
      return dryRunHash;
    }

    console.log("\n   ✅ EXECUTED ON MAINNET");
    console.log(`   • Transaction: ${result.txHash}`);
    console.log("   ═══════════════════════════════════════════════════════════\n");
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
  private extractTokenFromPair(pair: string | undefined): string {
    if (!pair || pair === "UNKNOWN/UNKNOWN") {
      return "ETH"; // Default to ETH for cross-chain actions
    }
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
  private async deactivateAllProtections(
    chain: string,
    poolId: string,
  ): Promise<void> {
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
        console.log(
          `⏰ Executor: Protection expired for ${poolKey}, deactivating`,
        );
        try {
          await this.deactivateAllProtections(state.chain, state.poolId);
          state.action = null; // Mark as deactivated
          this.emit("protection:expired", { poolKey, state });
        } catch (error) {
          console.error(
            `❌ Executor: Failed to deactivate expired protection for ${poolKey}`,
            error,
          );
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

  private getMaxGasPrice(
    chain: "ethereum" | "base" | "arbitrum",
  ): bigint | undefined {
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
