/**
 * Cross-Chain Orchestrator for Sentinell Protection Layer
 * 
 * Handles cross-chain defense executions via LI.FI SDK:
 * - LIQUIDITY_REROUTE: Move at-risk liquidity to safer chain
 * - CROSS_CHAIN_ARBITRAGE_BLOCK: Block detected cross-chain arb exploits
 * - EMERGENCY_BRIDGE: Fast exit to safe haven chain
 * 
 * Uses testnet configuration for development (Sepolia networks).
 */

import { EventEmitter } from "events";
import { ethers } from "ethers";
import { createConfig, getRoutes, executeRoute, getStatus } from "@lifi/sdk";
import type { Route, RoutesRequest, RouteOptions } from "@lifi/sdk";
import {
  ACTIVE_CHAIN_IDS,
  CHAIN_CONFIGS,
  MAINNET_TOKENS,
  TESTNET_TOKENS,
  CROSS_CHAIN_ROUTES,
  DEFENSE_STRATEGY_CONFIGS,
  SAFE_HAVEN_CONFIG,
  LIFI_CONFIG,
  type DefenseStrategyConfig,
  type ChainConfig,
} from "../config/crosschain.config";

// =============================================================================
// TYPES
// =============================================================================

export type CrossChainAction =
  | "LIQUIDITY_REROUTE"
  | "CROSS_CHAIN_ARBITRAGE_BLOCK"
  | "EMERGENCY_BRIDGE";

export interface CrossChainDefenseRequest {
  action: CrossChainAction;
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID (optional for EMERGENCY_BRIDGE - defaults to safe haven) */
  toChainId?: number;
  /** Token symbol to move (e.g., "USDC", "ETH") */
  tokenSymbol: string;
  /** Amount in token units (e.g., "100" for 100 USDC) */
  amount: string;
  /** Pool address that triggered this defense */
  triggerPool?: string;
  /** Risk decision ID for audit trail */
  decisionId?: string;
  /** Override dry-run setting for this execution */
  forceDryRun?: boolean;
}

export interface LiquidityRoute {
  id: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmountMin: string;
  estimatedDuration: number; // seconds
  gasEstimate: string;
  bridgeUsed: string;
  route: Route;
}

export interface ExecutionResult {
  success: boolean;
  action: CrossChainAction;
  txHash?: string;
  route?: LiquidityRoute;
  error?: string;
  dryRun: boolean;
  executedAt: number;
  completedAt?: number;
}

export interface ExecutionStatus {
  txHash: string;
  status: "PENDING" | "DONE" | "FAILED" | "NOT_FOUND";
  substatus?: string;
  receiving?: {
    chainId: number;
    txHash?: string;
    amount?: string;
  };
}

export interface CrossChainOrchestratorConfig {
  /** Wallet private key for signing transactions */
  walletPrivateKey: string;
  /** Override default LI.FI integrator name */
  integrator?: string;
  /** Global dry-run mode override */
  dryRun?: boolean;
}

// =============================================================================
// CROSS-CHAIN ORCHESTRATOR
// =============================================================================

export class CrossChainOrchestrator extends EventEmitter {
  private config: CrossChainOrchestratorConfig;
  private wallets: Map<number, ethers.Wallet>;
  private providers: Map<number, ethers.Provider>;
  private isInitialized = false;

  constructor(config: CrossChainOrchestratorConfig) {
    super();
    this.config = config;
    this.wallets = new Map();
    this.providers = new Map();
  }

  /**
   * Initialize the orchestrator with chain connections
   */
  async initialize(): Promise<void> {
    console.log("🌉 CrossChainOrchestrator: Initializing...");

    // Initialize LI.FI SDK
    createConfig({
      integrator: this.config.integrator || LIFI_CONFIG.integrator,
    });

    // Setup providers and wallets for each chain
    for (const [chainKey, chainConfig] of Object.entries(CHAIN_CONFIGS)) {
      const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
      const wallet = new ethers.Wallet(this.config.walletPrivateKey, provider);

      this.providers.set(chainConfig.id, provider);
      this.wallets.set(chainConfig.id, wallet);

      console.log(`  ✅ Connected to ${chainConfig.name} (${chainConfig.id})`);
    }

    this.isInitialized = true;
    console.log("🌉 CrossChainOrchestrator: Initialized successfully");
    this.emit("orchestrator:initialized");
  }

  /**
   * Get optimal route for cross-chain token transfer
   */
  async getRoute(params: {
    fromChainId: number;
    toChainId: number;
    fromToken: string;
    toToken: string;
    amount: string;
  }): Promise<LiquidityRoute | null> {
    this.ensureInitialized();

    console.log(`🔍 Getting route: ${params.fromChainId} → ${params.toChainId}`);
    console.log(`   Token: ${params.fromToken} → ${params.toToken}, Amount: ${params.amount}`);

    try {
      const fromTokenAddress = this.getTokenAddress(params.fromChainId, params.fromToken);
      const toTokenAddress = this.getTokenAddress(params.toChainId, params.toToken);

      if (!fromTokenAddress || !toTokenAddress) {
        console.error(`❌ Token not found: ${params.fromToken} or ${params.toToken}`);
        return null;
      }

      const routeRequest: RoutesRequest = {
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromTokenAddress,
        toTokenAddress,
        fromAmount: ethers.parseUnits(params.amount, this.getTokenDecimals(params.fromToken)).toString(),
        options: LIFI_CONFIG.defaultRouteOptions as RouteOptions,
      };

      const routesResponse = await getRoutes(routeRequest);

      if (!routesResponse.routes || routesResponse.routes.length === 0) {
        console.warn("⚠️ No routes available for this transfer");
        return null;
      }

      // Select the best route (first one is usually optimal)
      const bestRoute = routesResponse.routes[0];
      const step = bestRoute.steps[0];

      const liquidityRoute: LiquidityRoute = {
        id: bestRoute.id,
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmount: params.amount,
        toAmountMin: ethers.formatUnits(bestRoute.toAmountMin, this.getTokenDecimals(params.toToken)),
        estimatedDuration: bestRoute.steps.reduce((acc, s) => acc + (s.estimate?.executionDuration || 0), 0),
        gasEstimate: bestRoute.gasCostUSD || "0",
        bridgeUsed: step?.toolDetails?.name || "unknown",
        route: bestRoute,
      };

      console.log(`✅ Route found: ${liquidityRoute.bridgeUsed}`);
      console.log(`   Estimated time: ${liquidityRoute.estimatedDuration}s, Gas: $${liquidityRoute.gasEstimate}`);

      return liquidityRoute;
    } catch (error) {
      console.error("❌ Error fetching route:", error);
      this.emit("route:error", { params, error });
      return null;
    }
  }

  /**
   * Execute a cross-chain defense action
   */
  async executeDefense(request: CrossChainDefenseRequest): Promise<ExecutionResult> {
    this.ensureInitialized();

    const strategyConfig = DEFENSE_STRATEGY_CONFIGS[request.action];
    const isDryRun = request.forceDryRun ?? strategyConfig.dryRun ?? this.config.dryRun ?? true;

    console.log(`\n🛡️ Executing ${request.action}...`);
    console.log(`   From: Chain ${request.fromChainId}`);
    console.log(`   To: Chain ${request.toChainId || SAFE_HAVEN_CONFIG.chainId}`);
    console.log(`   Token: ${request.tokenSymbol}, Amount: ${request.amount}`);
    console.log(`   Dry Run: ${isDryRun}`);

    const executionResult: ExecutionResult = {
      success: false,
      action: request.action,
      dryRun: isDryRun,
      executedAt: Date.now(),
    };

    try {
      // Determine destination chain
      const toChainId = request.toChainId || SAFE_HAVEN_CONFIG.chainId;

      // Check gas balance
      const hasGas = await this.checkGasBalance(request.fromChainId, strategyConfig.minGasBalance);
      if (!hasGas) {
        executionResult.error = `Insufficient gas balance on chain ${request.fromChainId}`;
        console.error(`❌ ${executionResult.error}`);
        return executionResult;
      }

      // Get route
      const route = await this.getRoute({
        fromChainId: request.fromChainId,
        toChainId,
        fromToken: request.tokenSymbol,
        toToken: request.tokenSymbol, // Same token cross-chain
        amount: request.amount,
      });

      if (!route) {
        executionResult.error = "No route available for this transfer";
        return executionResult;
      }

      executionResult.route = route;

      // Dry run - log what would happen but don't execute
      if (isDryRun) {
        console.log("\n📋 DRY RUN - Would execute:");
        console.log(`   Route ID: ${route.id}`);
        console.log(`   Bridge: ${route.bridgeUsed}`);
        console.log(`   From Amount: ${route.fromAmount} ${route.fromToken}`);
        console.log(`   Min Receive: ${route.toAmountMin} ${route.toToken}`);
        console.log(`   Est. Time: ${route.estimatedDuration}s`);

        executionResult.success = true;
        this.emit("defense:dryrun", { request, route });
        return executionResult;
      }

      // Execute real transaction
      const wallet = this.wallets.get(request.fromChainId);
      if (!wallet) {
        throw new Error(`No wallet configured for chain ${request.fromChainId}`);
      }

      console.log("\n⏳ Executing cross-chain transaction...");

      const execution = await executeRoute(route.route, {
        // LI.FI SDK handles the signing internally
        updateRouteHook: (updatedRoute) => {
          console.log(`   Route updated: ${updatedRoute.id}`);
        },
      });

      // Get transaction hash from the first step
      const txHash = execution.steps[0]?.execution?.process?.[0]?.txHash;

      if (txHash) {
        executionResult.txHash = txHash;
        executionResult.success = true;

        console.log(`✅ Transaction submitted: ${txHash}`);
        this.emit("defense:executed", { request, route, txHash });

        // Start monitoring in background
        this.monitorExecution(txHash).catch(console.error);
      } else {
        executionResult.error = "Transaction submitted but no hash received";
      }

      executionResult.completedAt = Date.now();
      return executionResult;
    } catch (error) {
      executionResult.error = error instanceof Error ? error.message : String(error);
      console.error(`❌ Execution failed: ${executionResult.error}`);
      this.emit("defense:failed", { request, error });
      return executionResult;
    }
  }

  /**
   * Emergency bridge to safe haven chain
   */
  async emergencyBridge(params: {
    fromChainId: number;
    tokenSymbol: string;
    amount: string;
    decisionId?: string;
  }): Promise<ExecutionResult> {
    console.log("\n🚨 EMERGENCY BRIDGE INITIATED");

    return this.executeDefense({
      action: "EMERGENCY_BRIDGE",
      fromChainId: params.fromChainId,
      toChainId: SAFE_HAVEN_CONFIG.chainId,
      tokenSymbol: params.tokenSymbol,
      amount: params.amount,
      decisionId: params.decisionId,
    });
  }

  /**
   * Monitor status of an ongoing cross-chain transaction
   */
  async monitorExecution(txHash: string): Promise<ExecutionStatus> {
    console.log(`📡 Monitoring transaction: ${txHash}`);

    try {
      // Use LI.FI status endpoint
      const status = await getStatus({
        txHash,
      });

      // Cast to any to handle LI.FI SDK response variance
      const statusAny = status as any;

      const executionStatus: ExecutionStatus = {
        txHash,
        status: this.mapLifiStatus(status.status),
        substatus: status.substatus,
        receiving: statusAny.receiving ? {
          chainId: statusAny.receiving.chainId,
          txHash: statusAny.receiving.txHash,
          amount: statusAny.receiving.amount,
        } : undefined,
      };

      console.log(`   Status: ${executionStatus.status}`);
      if (executionStatus.receiving?.txHash) {
        console.log(`   Receiving tx: ${executionStatus.receiving.txHash}`);
      }

      this.emit("execution:status", executionStatus);
      return executionStatus;
    } catch (error) {
      console.error(`❌ Error monitoring execution: ${error}`);
      return {
        txHash,
        status: "NOT_FOUND",
      };
    }
  }


  /**
   * Get the safest destination chain based on current threat levels
   */
  getSafestChain(excludeChainId?: number): number {
    // For now, return safe haven if not the excluded chain
    if (excludeChainId !== SAFE_HAVEN_CONFIG.chainId) {
      return SAFE_HAVEN_CONFIG.chainId;
    }

    // Otherwise, pick alternative (Base as secondary safe haven)
    return ACTIVE_CHAIN_IDS.base;
  }

  /**
   * Check if a route is available between two chains
   */
  isRouteAvailable(fromChainId: number, toChainId: number, tokenSymbol: string): boolean {
    const route = CROSS_CHAIN_ROUTES.find(
      (r) =>
        r.fromChainId === fromChainId &&
        r.toChainId === toChainId &&
        r.supportedTokens.includes(tokenSymbol)
    );
    return !!route;
  }

  /**
   * Get all available routes from a chain
   */
  getAvailableRoutes(fromChainId: number): typeof CROSS_CHAIN_ROUTES {
    return CROSS_CHAIN_ROUTES.filter((r) => r.fromChainId === fromChainId);
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("CrossChainOrchestrator not initialized. Call initialize() first.");
    }
  }

  private getTokenAddress(chainId: number, tokenSymbol: string): string | null {
    const chainKey = Object.entries(ACTIVE_CHAIN_IDS).find(([, id]) => id === chainId)?.[0];
    if (!chainKey) return null;

    // Use mainnet tokens for LI.FI routing (mainnet chain IDs)
    const tokens = MAINNET_TOKENS[chainKey as keyof typeof MAINNET_TOKENS];
    if (!tokens) return null;

    return (tokens as Record<string, string>)[tokenSymbol] || null;
  }

  private getTokenDecimals(tokenSymbol: string): number {
    switch (tokenSymbol) {
      case "USDC":
      case "USDT":
        return 6;
      case "WBTC":
        return 8;
      default:
        return 18;
    }
  }

  private async checkGasBalance(chainId: number, minBalance: string): Promise<boolean> {
    const wallet = this.wallets.get(chainId);
    if (!wallet) return false;

    try {
      const balance = await wallet.provider?.getBalance(wallet.address);
      const minWei = ethers.parseEther(minBalance);
      return balance ? balance >= minWei : false;
    } catch {
      return false;
    }
  }

  private mapLifiStatus(status: string): ExecutionStatus["status"] {
    switch (status) {
      case "DONE":
        return "DONE";
      case "FAILED":
        return "FAILED";
      case "PENDING":
      case "STARTED":
        return "PENDING";
      default:
        return "NOT_FOUND";
    }
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createCrossChainOrchestrator(
  config: CrossChainOrchestratorConfig
): CrossChainOrchestrator {
  return new CrossChainOrchestrator(config);
}