import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { normalizeWeiMagnitude } from './utils/magnitude';
import type { RpcBudget } from '../../executor/src/RiskEngine';

export interface MempoolTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  gasPrice: string;
  gasLimit: string;
  data: string;
  nonce: number;
  timestamp: number;
  chain: 'ethereum' | 'base' | 'arbitrum';
  blockNumber: number;
  magnitude: number; // NEW: normalized 0-1 magnitude based on transaction value
}

export interface MempoolHttpConfig {
  providers: Map<string, ethers.Provider>;
  pollInterval: number; // milliseconds
  blocksToCheck: number; // How many recent blocks to scan
  filters?: {
    minValue?: string;
    addresses?: string[];
  };
  rpcBudget?: RpcBudget; // Optional RPC rate limiter
}

/**
 * HTTP-compatible Mempool Monitor
 * Polls recent blocks to find high-value/interesting transactions
 * Works with HTTP providers (no WebSocket required)
 */
export class MempoolMonitorHttp extends EventEmitter {
  private config: MempoolHttpConfig;
  private isRunning: boolean = false;
  private lastCheckedBlocks: Map<string, number> = new Map();
  private pollIntervalId?: NodeJS.Timeout;
  private rpcBudget?: RpcBudget;
  private currentPollInterval: number;

  constructor(config: MempoolHttpConfig) {
    super();
    this.config = config;
    this.rpcBudget = config.rpcBudget;
    this.currentPollInterval = config.pollInterval;
    
    // Listen to budget events for adaptive polling
    if (this.rpcBudget) {
      this.rpcBudget.on('budget:quiet', () => {
        this.adjustPollInterval();
      });
      this.rpcBudget.on('budget:exhausted', () => {
        console.warn('⚠️  Mempool: RPC budget exhausted, slowing down');
        this.adjustPollInterval();
      });
      this.rpcBudget.on('budget:refill', () => {
        this.adjustPollInterval();
      });
    }
  }

  async start(): Promise<void> {
    console.log('Starting HTTP-based mempool monitor (polling mode)...');
    this.isRunning = true;

    // Initialize last checked blocks
    for (const [chain, provider] of this.config.providers) {
      try {
        const currentBlock = await provider.getBlockNumber();
        this.lastCheckedBlocks.set(chain, currentBlock);
        console.log(`${chain} starting from block ${currentBlock}`);
      } catch (error) {
        console.error(`Failed to get initial block for ${chain}:`, error);
      }
    }

    // Start polling
    this.pollIntervalId = setInterval(
      () => this.pollAllChains(),
      this.config.pollInterval
    );

    // Initial poll
    await this.pollAllChains();
  }

  private async pollAllChains(): Promise<void> {
    const checkPromises = Array.from(this.config.providers.entries()).map(
      ([chain, provider]) =>
        this.checkChain(chain, provider).catch(error =>
          console.error(`Error checking ${chain}:`, error.message)
        )
    );

    await Promise.all(checkPromises);
  }

  /**
   * Adjust poll interval based on RPC budget status.
   */
  private adjustPollInterval(): void {
    if (!this.rpcBudget) return;

    const recommendedInterval = this.rpcBudget.getRecommendedPollIntervalMs();
    
    if (recommendedInterval !== this.currentPollInterval) {
      this.currentPollInterval = recommendedInterval;
      
      // Restart polling with new interval
      if (this.pollIntervalId && this.isRunning) {
        clearInterval(this.pollIntervalId);
        this.pollIntervalId = setInterval(
          () => this.pollAllChains(),
          this.currentPollInterval
        );
        console.log(`🔄 Mempool: Poll interval adjusted to ${this.currentPollInterval}ms`);
      }
    }
  }

  private async checkChain(chain: string, provider: ethers.Provider): Promise<void> {
    try {
      // Check RPC budget before making call
      if (this.rpcBudget && !this.rpcBudget.tryConsume(1)) {
        // Budget exhausted, skip this poll cycle
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastChecked = this.lastCheckedBlocks.get(chain) || currentBlock - 1;

      // Determine blocks to check
      const startBlock = Math.max(
        lastChecked + 1,
        currentBlock - this.config.blocksToCheck
      );

      // Check each block in range
      for (let blockNum = startBlock; blockNum <= currentBlock; blockNum++) {
        await this.processBlock(chain, provider, blockNum);
      }

      // Update last checked
      this.lastCheckedBlocks.set(chain, currentBlock);
    } catch (error: any) {
      console.error(`Error in checkChain for ${chain}:`, error.message);
    }
  }

  private async processBlock(
    chain: string,
    provider: ethers.Provider,
    blockNumber: number
  ): Promise<void> {
    try {
      // Check RPC budget before fetching block
      if (this.rpcBudget && !this.rpcBudget.tryConsume(1)) {
        return;
      }

      const block = await provider.getBlock(blockNumber, true); // Include transactions

      if (!block || !block.transactions) return;

      for (const txHash of block.transactions) {
        if (typeof txHash === 'string') {
          // Check RPC budget before fetching transaction
          if (this.rpcBudget && !this.rpcBudget.tryConsume(1)) {
            continue; // Skip this tx if budget exhausted
          }

          // Get full transaction
          const tx = await provider.getTransaction(txHash);
          if (tx && this.shouldProcessTransaction(tx)) {
            const value = tx.value.toString();
            const magnitude = normalizeWeiMagnitude(value);

            const mempoolTx: MempoolTransaction = {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value,
              gasPrice: tx.gasPrice?.toString() || '0',
              gasLimit: tx.gasLimit.toString(),
              data: tx.data,
              nonce: tx.nonce,
              timestamp: block.timestamp * 1000,
              chain: chain as any,
              blockNumber: blockNumber,
              magnitude,
            };
            this.emit('transaction', mempoolTx);
          }
        }
      }
    } catch (error: any) {
      // Silently ignore "could not coalesce error" messages
      if (!error?.message?.includes('could not coalesce')) {
        console.error(`Error processing block ${blockNumber}:`, error.message);
      }
    }
  }

  private shouldProcessTransaction(tx: ethers.TransactionResponse): boolean {
    if (this.config.filters?.minValue) {
      const minValue = BigInt(this.config.filters.minValue);
      if (tx.value < minValue) return false;
    }

    if (this.config.filters?.addresses && tx.to) {
      const addressList = this.config.filters.addresses.map(a => a.toLowerCase());
      if (!addressList.includes(tx.to.toLowerCase())) return false;
    }

    return true;
  }

  async stop(): Promise<void> {
    console.log('Stopping HTTP mempool monitor...');
    this.isRunning = false;

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
    }
  }

  getStatus(): { chain: string; lastBlock: number }[] {
    return Array.from(this.lastCheckedBlocks.entries()).map(([chain, block]) => ({
      chain,
      lastBlock: block,
    }));
  }
}
