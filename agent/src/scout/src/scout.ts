import {
  MempoolMonitorHttp,
  MempoolHttpConfig,
  MempoolTransaction,
} from "./mempool-monitor-http";
import { DexAggregator, DexConfig, DexPrice } from "./dex-aggregator";
import {
  FlashLoanDetector,
  FlashLoanConfig,
  FlashLoan,
} from "./flashloan-detector";
import { GasTracker, GasConfig, GasData } from "./gas-tracker";
import { ethers } from "ethers";
import { EventEmitter } from "events";
import { ScoutSignal, ScoutSignalType } from "./types";
import type { RpcBudget } from "../../executor/src/RiskEngine";

export interface ScoutConfig {
  rpcUrls: {
    ethereum: string;
    base: string;
    arbitrum: string;
  };
  mempool?: {
    enabled: boolean;
    filters?: MempoolHttpConfig["filters"];
  };
  dex?: {
    enabled: boolean;
    updateInterval: number;
    pairs: DexConfig["pairs"];
  };
  flashloan?: {
    enabled: boolean;
    protocols: FlashLoanConfig["protocols"];
  };
  gas?: {
    enabled: boolean;
    updateInterval: number;
    spikeThreshold: number;
  };
  /** Optional RPC budget tracker for rate limiting */
  rpcBudget?: RpcBudget;
  /** Cluster detection config */
  clusterDetection?: {
    enabled: boolean;
    /** Sliding window in ms (default: 24_000 = 2 ETH blocks) */
    windowMs?: number;
    /** Min transactions to same pool to trigger cluster signal (default: 3) */
    threshold?: number;
  };
}

export interface ScoutData {
  transactions: MempoolTransaction[];
  prices: DexPrice[];
  flashloans: FlashLoan[];
  gasData: GasData[];
  timestamp: number;
}

export interface ComprehensiveScoutData {
  // Raw data arrays
  allTransactions: MempoolTransaction[];
  allPrices: DexPrice[];
  allFlashLoans: FlashLoan[];
  allGasData: GasData[];

  // Organized by chain
  byChain: {
    ethereum: {
      transactions: MempoolTransaction[];
      prices: DexPrice[];
      flashloans: FlashLoan[];
      currentGas?: GasData;
      averageGas: string;
      gasHistory: GasData[];
    };
    base: {
      transactions: MempoolTransaction[];
      prices: DexPrice[];
      flashloans: FlashLoan[];
      currentGas?: GasData;
      averageGas: string;
      gasHistory: GasData[];
    };
    arbitrum: {
      transactions: MempoolTransaction[];
      prices: DexPrice[];
      flashloans: FlashLoan[];
      currentGas?: GasData;
      averageGas: string;
      gasHistory: GasData[];
    };
  };

  // Organized by protocol
  byProtocol: {
    dex: {
      uniswap: DexPrice[];
      sushiswap: DexPrice[];
      curve: DexPrice[];
    };
    flashloan: {
      aave: FlashLoan[];
      balancer: FlashLoan[];
    };
  };

  // Analytics
  analytics: {
    totalTransactions: number;
    totalFlashLoans: number;
    totalFlashLoanVolume: {
      ethereum: string;
      base: string;
      arbitrum: string;
    };
    gasSpikes: GasData[];
    significantPriceChanges: Array<
      DexPrice & { oldPrice: string; change: number }
    >;
  };

  // Status and metadata
  status: {
    mempool: {
      connected: Array<{ chain: string; lastBlock: number }>;
      transactionCount: number;
    };
    dex: {
      priceCount: number;
      lastUpdate: number;
    };
    flashloans: {
      count: number;
      lastDetected?: number;
    };
    gas: {
      chains: Array<{
        chain: string;
        current?: GasData;
        average: string;
      }>;
    };
  };

  cacheSize: {
    transactions: number;
    prices: number;
    flashloans: number;
    gasData: number;
    total: number;
  };

  timestamp: number;
}

export class ScoutAgent extends EventEmitter {
  private config: ScoutConfig;
  private mempoolMonitor?: MempoolMonitorHttp;
  private dexAggregator?: DexAggregator;
  private flashLoanDetector?: FlashLoanDetector;
  private gasTracker?: GasTracker;
  private providers: Map<string, ethers.Provider>;
  private rpcBudget?: RpcBudget;
  private clusterTracker?: TransactionClusterTracker;
  private dataCache: {
    transactions: MempoolTransaction[];
    prices: DexPrice[];
    flashloans: FlashLoan[];
    gasData: GasData[];
    priceChanges: Array<DexPrice & { oldPrice: string; change: number }>;
  };
  private readonly MAX_CACHE_SIZE = 1000;

  constructor(config: ScoutConfig) {
    super();
    this.config = config;
    this.providers = new Map();
    this.rpcBudget = config.rpcBudget;

    // Initialize cluster tracker if enabled
    if (config.clusterDetection?.enabled) {
      this.clusterTracker = new TransactionClusterTracker({
        windowMs: config.clusterDetection.windowMs ?? 24_000,
        threshold: config.clusterDetection.threshold ?? 3,
      });
    }

    this.dataCache = {
      transactions: [],
      prices: [],
      flashloans: [],
      gasData: [],
      priceChanges: [],
    };
  }

  async initialize(): Promise<void> {
    console.log("Initializing Scout Agent...");

    // Initialize HTTP providers - always use JsonRpcProvider for HTTP-only connections
    this.providers.set(
      "ethereum",
      new ethers.JsonRpcProvider(this.config.rpcUrls.ethereum),
    );
    this.providers.set(
      "base",
      new ethers.JsonRpcProvider(this.config.rpcUrls.base),
    );
    this.providers.set(
      "arbitrum",
      new ethers.JsonRpcProvider(this.config.rpcUrls.arbitrum),
    );

    // Initialize components
    if (this.config.mempool?.enabled) {
      this.initializeMempool();
    }

    if (this.config.dex?.enabled) {
      this.initializeDex();
    }

    if (this.config.flashloan?.enabled) {
      this.initializeFlashLoan();
    }

    if (this.config.gas?.enabled) {
      this.initializeGas();
    }

    console.log("Scout Agent initialized successfully");
  }

  private initializeMempool(): void {
    const mempoolConfig: MempoolHttpConfig = {
      providers: this.providers,
      pollInterval: 15000, // Poll every 15 seconds
      blocksToCheck: 3, // Check last 3 blocks
      filters: this.config.mempool?.filters,
      rpcBudget: this.rpcBudget,
    };

    this.mempoolMonitor = new MempoolMonitorHttp(mempoolConfig);

    this.mempoolMonitor.on("transaction", (tx: MempoolTransaction) => {
      this.dataCache.transactions.push(tx);
      this.trimCache("transactions");

      // Check for transaction cluster if enabled
      if (this.clusterTracker && tx.to) {
        const clusterSignal = this.clusterTracker.addTransaction(tx);
        if (clusterSignal) {
          this.emit("signal", clusterSignal);
        }
      }

      const signalType = this.classifyTransaction(tx);
      if (signalType) {
        const signal: ScoutSignal = {
          type: signalType,
          chain: tx.chain,
          pair: "unknown", // Will be enriched if we can detect DEX interactions
          poolAddress: tx.to || undefined,
          timestamp: tx.timestamp,
          magnitude: tx.magnitude,
          raw: tx,
        };
        this.emit("signal", signal);
      }
      this.emit("transaction", tx);
    });
  }

  private initializeDex(): void {
    const dexConfig: DexConfig = {
      providers: this.providers,
      updateInterval: this.config.dex!.updateInterval,
      pairs: this.config.dex!.pairs,
    };

    this.dexAggregator = new DexAggregator(dexConfig);

    this.dexAggregator.on("price", (price: DexPrice) => {
      this.dataCache.prices.push(price);
      this.trimCache("prices");
      this.emit("price", price);
    });

    this.dexAggregator.on("priceChange", (data: any) => {
      this.dataCache.priceChanges.push(data);
      if (this.dataCache.priceChanges.length > 100) {
        this.dataCache.priceChanges = this.dataCache.priceChanges.slice(-100);
      }
      const signal: ScoutSignal = {
        type: "PRICE_MOVE",
        chain: data.chain,
        pair: data.pair,
        poolAddress: undefined, // DEX doesn't provide pool address directly
        timestamp: data.timestamp,
        magnitude: data.magnitude,
        raw: data,
      };
      this.emit("signal", signal);
      this.emit("priceChange", data);
    });
  }

  private initializeFlashLoan(): void {
    const flashLoanConfig: FlashLoanConfig = {
      providers: this.providers,
      pollInterval: 15000, // Poll every 15 seconds
      blocksToCheck: 3, // Check last 3 blocks
      protocols: this.config.flashloan!.protocols,
    };

    this.flashLoanDetector = new FlashLoanDetector(flashLoanConfig);

    this.flashLoanDetector.on("flashloan", (loan: FlashLoan) => {
      this.dataCache.flashloans.push(loan);
      this.trimCache("flashloans");
      const signal: ScoutSignal = {
        type: "FLASH_LOAN",
        chain: loan.chain,
        pair: `${loan.token}/unknown`, // Token being borrowed
        poolAddress: undefined,
        timestamp: loan.timestamp,
        magnitude: loan.magnitude,
        raw: loan,
      };
      this.emit("signal", signal);
      this.emit("flashloan", loan);
    });
  }

  private initializeGas(): void {
    const gasConfig: GasConfig = {
      providers: this.providers,
      updateInterval: this.config.gas!.updateInterval,
      spikeThreshold: this.config.gas!.spikeThreshold,
    };

    this.gasTracker = new GasTracker(gasConfig);

    this.gasTracker.on("gasUpdate", (gas: GasData) => {
      this.dataCache.gasData.push(gas);
      this.trimCache("gasData");
      this.emit("gasUpdate", gas);
    });

    this.gasTracker.on("gasSpike", (gas: GasData) => {
      const signal: ScoutSignal = {
        type: "GAS_SPIKE",
        chain: gas.chain,
        pair: "GAS", // Synthetic pair for gas spikes
        poolAddress: undefined,
        timestamp: gas.timestamp,
        magnitude: gas.magnitude,
        raw: gas,
      };
      this.emit("signal", signal);
      this.emit("gasSpike", gas);
    });
  }

  private classifyTransaction(tx: MempoolTransaction): ScoutSignalType | null {
    // LARGE_SWAP: High-value transaction (magnitude already calculated)
    // Threshold: if magnitude > 0.3 (roughly > 10 ETH)
    if (tx.magnitude > 0.3) {
      return "LARGE_SWAP";
    }

    // Could add MEMPOOL_CLUSTER detection here in the future
    // (e.g., multiple txs from same address in same block targeting same pool)

    // If not interesting, return null (won't emit signal)
    return null;
  }


  private trimCache(key: keyof typeof this.dataCache): void {
    const cache = this.dataCache[key];
    if (Array.isArray(cache) && cache.length > this.MAX_CACHE_SIZE) {
      (this.dataCache[key] as any[]) = cache.slice(-this.MAX_CACHE_SIZE);
    }
  }

  async start(): Promise<void> {
    console.log("Starting Scout Agent...");

    if (this.mempoolMonitor) await this.mempoolMonitor.start();
    if (this.dexAggregator) await this.dexAggregator.start();
    if (this.flashLoanDetector) await this.flashLoanDetector.start();
    if (this.gasTracker) await this.gasTracker.start();

    console.log("Scout Agent is running");
  }

  async stop(): Promise<void> {
    console.log("Stopping Scout Agent...");

    if (this.mempoolMonitor) await this.mempoolMonitor.stop();
    if (this.dexAggregator) await this.dexAggregator.stop();
    if (this.flashLoanDetector) await this.flashLoanDetector.stop();
    if (this.gasTracker) await this.gasTracker.stop();

    console.log("Scout Agent stopped");
  }

  /**
   * Get all scout data in a single comprehensive call
   * This is the main method to fetch all monitoring data at once
   */
  getComprehensiveData(): ComprehensiveScoutData {
    const chains: ("ethereum" | "base" | "arbitrum")[] = [
      "ethereum",
      "base",
      "arbitrum",
    ];

    // Organize data by chain
    const byChain = {
      ethereum: this.getChainData("ethereum"),
      base: this.getChainData("base"),
      arbitrum: this.getChainData("arbitrum"),
    };

    // Organize by protocol
    const byProtocol = {
      dex: {
        uniswap: this.dataCache.prices.filter((p) => p.dex === "uniswap"),
        sushiswap: this.dataCache.prices.filter((p) => p.dex === "sushiswap"),
        curve: this.dataCache.prices.filter((p) => p.dex === "curve"),
      },
      flashloan: {
        aave: this.dataCache.flashloans.filter((f) => f.protocol === "aave"),
        balancer: this.dataCache.flashloans.filter(
          (f) => f.protocol === "balancer",
        )
      },
    };

    // Calculate analytics
    const analytics = this.calculateAnalytics();

    // Get status
    const status = this.getDetailedStatus();

    // Get cache size
    const cacheSize = this.getCacheSize();

    return {
      allTransactions: [...this.dataCache.transactions],
      allPrices: [...this.dataCache.prices],
      allFlashLoans: [...this.dataCache.flashloans],
      allGasData: [...this.dataCache.gasData],
      byChain,
      byProtocol,
      analytics,
      status,
      cacheSize,
      timestamp: Date.now(),
    };
  }

  private getChainData(chain: "ethereum" | "base" | "arbitrum") {
    return {
      transactions: this.dataCache.transactions.filter(
        (tx) => tx.chain === chain,
      ),
      prices: this.dataCache.prices.filter((p) => p.chain === chain),
      flashloans: this.dataCache.flashloans.filter((f) => f.chain === chain),
      currentGas: this.gasTracker?.getCurrentGas(chain),
      averageGas: this.gasTracker?.getAverageGas(chain) || "0",
      gasHistory: this.gasTracker?.getGasHistory(chain, 20) || [],
    };
  }

  private calculateAnalytics() {
    const chains: ("ethereum" | "base" | "arbitrum")[] = [
      "ethereum",
      "base",
      "arbitrum",
    ];

    // Calculate flash loan volume by chain (explicit object shape)
    const totalFlashLoanVolume: {
      ethereum: string;
      base: string;
      arbitrum: string;
    } = {
      ethereum: "0",
      base: "0",
      arbitrum: "0",
    };

    for (const chain of chains) {
      const chainFlashLoans = this.dataCache.flashloans.filter(
        (f) => f.chain === chain,
      );
      const volume = chainFlashLoans.reduce((sum, loan) => {
        try {
          return sum + BigInt(loan.amount);
        } catch {
          return sum;
        }
      }, 0n);
      totalFlashLoanVolume[chain] = volume.toString();
    }

    return {
      totalTransactions: this.dataCache.transactions.length,
      totalFlashLoans: this.dataCache.flashloans.length,
      totalFlashLoanVolume,
      gasSpikes: this.dataCache.gasData.filter((g) => g.spike),
      significantPriceChanges: this.dataCache.priceChanges,
    };
  }

  private getDetailedStatus() {
    const lastPrice = this.dataCache.prices[this.dataCache.prices.length - 1];
    const lastFlashLoan =
      this.dataCache.flashloans[this.dataCache.flashloans.length - 1];

    const gasChains = Array.from(this.providers.keys()).map((chain) => ({
      chain,
      current: this.gasTracker?.getCurrentGas(chain),
      average: this.gasTracker?.getAverageGas(chain) || "0",
    }));

    return {
      mempool: {
        connected: this.mempoolMonitor?.getStatus() || [],
        transactionCount: this.dataCache.transactions.length,
      },
      dex: {
        priceCount: this.dataCache.prices.length,
        lastUpdate: lastPrice?.timestamp || 0,
      },
      flashloans: {
        count: this.dataCache.flashloans.length,
        lastDetected: lastFlashLoan?.timestamp,
      },
      gas: {
        chains: gasChains,
      },
    };
  }

  // Legacy methods for backward compatibility
  getAllData(): ScoutData {
    return {
      transactions: [...this.dataCache.transactions],
      prices: [...this.dataCache.prices],
      flashloans: [...this.dataCache.flashloans],
      gasData: [...this.dataCache.gasData],
      timestamp: Date.now(),
    };
  }

  getRecentTransactions(limit: number = 100): MempoolTransaction[] {
    return this.dataCache.transactions.slice(-limit);
  }

  getTransactionsByChain(
    chain: "ethereum" | "base" | "arbitrum",
    limit: number = 100,
  ): MempoolTransaction[] {
    return this.dataCache.transactions
      .filter((tx) => tx.chain === chain)
      .slice(-limit);
  }

  getCurrentPrices(): DexPrice[] {
    return this.dexAggregator?.getPrices() || [];
  }

  getPriceByPair(pair: string, chain?: string): DexPrice | undefined {
    return this.dataCache.prices
      .filter((p) => p.pair === pair && (!chain || p.chain === chain))
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  getRecentFlashLoans(limit: number = 50): FlashLoan[] {
    return this.dataCache.flashloans.slice(-limit);
  }

  getFlashLoansByProtocol(
    protocol: "aave" | "balancer",
    limit: number = 50,
  ): FlashLoan[] {
    return this.dataCache.flashloans
      .filter((loan) => loan.protocol === protocol)
      .slice(-limit);
  }

  getCurrentGas(chain: string): GasData | undefined {
    return this.gasTracker?.getCurrentGas(chain);
  }

  getGasHistory(chain: string, count: number = 10): GasData[] {
    return this.gasTracker?.getGasHistory(chain, count) || [];
  }

  getAverageGas(chain: string, blocks: number = 10): string {
    return this.gasTracker?.getAverageGas(chain, blocks) || "0";
  }

  getRecentGasSpikes(limit: number = 20): GasData[] {
    return this.dataCache.gasData.filter((gas) => gas.spike).slice(-limit);
  }

  getStatus() {
    return {
      mempool: {
        connected: this.mempoolMonitor?.getStatus() || [],
        transactionCount: this.dataCache.transactions.length,
      },
      dex: {
        prices: this.dexAggregator?.getPrices() || [],
        priceCount: this.dataCache.prices.length,
      },
      flashloans: {
        count: this.dataCache.flashloans.length,
        recent: this.dataCache.flashloans.slice(-5),
      },
      gas: Array.from(this.providers.keys()).map((chain) => ({
        chain,
        current: this.gasTracker?.getCurrentGas(chain),
        average: this.gasTracker?.getAverageGas(chain),
      })),
    };
  }

  clearCache(): void {
    this.dataCache = {
      transactions: [],
      prices: [],
      flashloans: [],
      gasData: [],
      priceChanges: [],
    };
    console.log("Cache cleared");
  }

  getCacheSize(): {
    transactions: number;
    prices: number;
    flashloans: number;
    gasData: number;
    total: number;
  } {
    return {
      transactions: this.dataCache.transactions.length,
      prices: this.dataCache.prices.length,
      flashloans: this.dataCache.flashloans.length,
      gasData: this.dataCache.gasData.length,
      total:
        this.dataCache.transactions.length +
        this.dataCache.prices.length +
        this.dataCache.flashloans.length +
        this.dataCache.gasData.length,
    };
  }
}

// ---------------------------------------------------------------------------
// TRANSACTION CLUSTER TRACKER
// ---------------------------------------------------------------------------

interface ClusterTrackerConfig {
  /** Sliding window in ms (default: 24_000 = 2 ETH blocks) */
  windowMs: number;
  /** Min transactions to same pool to trigger cluster signal (default: 3) */
  threshold: number;
}

interface PoolTransactionRecord {
  txHash: string;
  timestamp: number;
  from: string;
  value: string;
}

/**
 * Tracks transactions to detect suspicious clustering patterns.
 * A cluster is detected when ≥N transactions target the same pool within a sliding window.
 * This pattern indicates potential coordinated MEV attacks or sandwich attempts.
 */
class TransactionClusterTracker {
  private config: ClusterTrackerConfig;
  /** Map of pool address → recent transactions */
  private poolTxHistory: Map<string, PoolTransactionRecord[]> = new Map();
  /** Track pools that already emitted cluster signals to avoid spam */
  private activeClusterPools: Set<string> = new Set();

  constructor(config: ClusterTrackerConfig) {
    this.config = config;
  }

  /**
   * Add a transaction and check for cluster formation.
   * Returns a ScoutSignal if a new cluster is detected, null otherwise.
   */
  addTransaction(tx: MempoolTransaction): ScoutSignal | null {
    if (!tx.to) return null; // Ignore contract creation txs

    const poolAddress = tx.to;
    const now = tx.timestamp;

    // Initialize pool history if needed
    if (!this.poolTxHistory.has(poolAddress)) {
      this.poolTxHistory.set(poolAddress, []);
    }

    const history = this.poolTxHistory.get(poolAddress)!;

    // Add new transaction
    history.push({
      txHash: tx.hash,
      timestamp: now,
      from: tx.from,
      value: tx.value,
    });

    // Evict old transactions outside the window
    this.evictOldTransactions(poolAddress, now);

    // Check if cluster threshold is met
    const updatedHistory = this.poolTxHistory.get(poolAddress)!;
    const txCount = updatedHistory.length;

    if (txCount >= this.config.threshold) {
      // Check if this is a new cluster (not already signaled)
      if (!this.activeClusterPools.has(poolAddress)) {
        this.activeClusterPools.add(poolAddress);

        // Calculate magnitude: (txCount - threshold) / threshold
        // 3 txs (threshold) = 0.0, 6 txs = 1.0, 9 txs = 2.0, clamped to [0, 1]
        const excessTxs = txCount - this.config.threshold;
        const magnitude = Math.min(1, excessTxs / this.config.threshold);

        // Determine chain from first tx (all should be same chain)
        const chain = tx.chain;

        return {
          type: "MEMPOOL_CLUSTER",
          chain,
          pair: "unknown", // Would need DEX pool decoding to determine pair
          poolAddress,
          timestamp: now,
          magnitude,
          raw: {
            txCount,
            window: this.config.windowMs,
            threshold: this.config.threshold,
            transactions: updatedHistory,
          },
        };
      }
    } else {
      // Transaction count dropped below threshold, reset cluster flag
      if (this.activeClusterPools.has(poolAddress)) {
        this.activeClusterPools.delete(poolAddress);
      }
    }

    return null;
  }

  /**
   * Remove transactions older than the sliding window.
   */
  private evictOldTransactions(poolAddress: string, now: number): void {
    const history = this.poolTxHistory.get(poolAddress);
    if (!history) return;

    const cutoff = now - this.config.windowMs;
    const filtered = history.filter((tx) => tx.timestamp >= cutoff);

    this.poolTxHistory.set(poolAddress, filtered);

    // Clean up empty entries
    if (filtered.length === 0) {
      this.poolTxHistory.delete(poolAddress);
      this.activeClusterPools.delete(poolAddress);
    }
  }

  /**
   * Get current cluster status for a pool.
   */
  getPoolClusterStatus(poolAddress: string): {
    txCount: number;
    isCluster: boolean;
    transactions: PoolTransactionRecord[];
  } | null {
    const history = this.poolTxHistory.get(poolAddress);
    if (!history || history.length === 0) return null;

    return {
      txCount: history.length,
      isCluster: history.length >= this.config.threshold,
      transactions: [...history],
    };
  }

  /**
   * Get all pools currently in cluster state.
   */
  getActiveClusters(): Array<{
    poolAddress: string;
    txCount: number;
    transactions: PoolTransactionRecord[];
  }> {
    const clusters: Array<{
      poolAddress: string;
      txCount: number;
      transactions: PoolTransactionRecord[];
    }> = [];

    for (const poolAddress of this.activeClusterPools) {
      const history = this.poolTxHistory.get(poolAddress);
      if (history && history.length >= this.config.threshold) {
        clusters.push({
          poolAddress,
          txCount: history.length,
          transactions: [...history],
        });
      }
    }

    return clusters;
  }

  /**
   * Clear all tracked data.
   */
  clear(): void {
    this.poolTxHistory.clear();
    this.activeClusterPools.clear();
  }
}
