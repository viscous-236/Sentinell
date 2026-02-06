import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { normalizeGasSpikeMagnitude } from './utils/magnitude';
import { withRpcRetry } from '../../shared/utils/rpc-fallback';

export interface GasData {
  chain: string;
  gasPrice: string;
  baseFee?: string;
  priorityFee?: string;
  blockNumber: number;
  timestamp: number;
  spike?: boolean;
  percentageChange?: number;
  magnitude: number; // NEW: normalized 0-1 magnitude based on gas spike ratio
}

export interface GasConfig {
  providers: Map<string, ethers.Provider>;
  updateInterval: number; // milliseconds
  spikeThreshold: number; // percentage (e.g., 50 for 50% increase)
}

export class GasTracker extends EventEmitter {
  private config: GasConfig;
  private isRunning: boolean = false;
  private updateIntervalId?: NodeJS.Timeout;
  private gasHistory: Map<string, GasData[]> = new Map();
  private readonly HISTORY_SIZE = 100;

  constructor(config: GasConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('Starting gas tracker...');
    this.isRunning = true;

    // Initial gas price fetch
    await this.updateAllGasPrices();

    // Set up periodic updates
    this.updateIntervalId = setInterval(
      () => this.updateAllGasPrices(),
      this.config.updateInterval
    );
  }

  private async updateAllGasPrices(): Promise<void> {
    const updatePromises = Array.from(this.config.providers.entries()).map(
      ([chain, provider]) =>
        this.updateGasPrice(chain, provider).catch(error =>
          console.error(`Error updating gas for ${chain}:`, error)
        )
    );

    await Promise.all(updatePromises);
  }

  private async updateGasPrice(chain: string, provider: ethers.Provider): Promise<void> {
    try {
      // Wrap RPC calls with retry logic to handle rate limits
      const [feeData, block] = await withRpcRetry(
        async () => {
          const fee = await provider.getFeeData();
          const blk = await provider.getBlock('latest');
          return [fee, blk];
        },
        3, // max 3 retries
        2000 // 2 second delay
      );

      if (!block) return;

      // Get historical average for magnitude calculation
      const history = this.gasHistory.get(chain) || [];
      const averageGas = history.length > 0
        ? BigInt(this.getAverageGas(chain, Math.min(10, history.length)))
        : feeData.gasPrice || 1n;

      const currentGas = feeData.gasPrice || 0n;
      const magnitude = normalizeGasSpikeMagnitude(currentGas, averageGas);

      const gasData: GasData = {
        chain,
        gasPrice: currentGas.toString(),
        baseFee: feeData.maxFeePerGas?.toString(),
        priorityFee: feeData.maxPriorityFeePerGas?.toString(),
        blockNumber: block.number,
        timestamp: Date.now(),
        magnitude,
      };

      // Check for gas spikes
      if (history.length > 0) {
        const lastGas = history[history.length - 1];
        const percentageChange = this.calculatePercentageChange(
          Number(lastGas.gasPrice),
          Number(gasData.gasPrice)
        );

        if (Math.abs(percentageChange) >= this.config.spikeThreshold) {
          gasData.spike = true;
          gasData.percentageChange = percentageChange;
          this.emit('gasSpike', gasData);
        }
      }

      // Update history
      history.push(gasData);
      if (history.length > this.HISTORY_SIZE) {
        history.shift();
      }
      this.gasHistory.set(chain, history);

      this.emit('gasUpdate', gasData);
    } catch (error: any) {
      const is429 = 
        error?.info?.error?.code === 429 ||
        error?.code === 'CALL_EXCEPTION' ||
        error?.message?.includes('exceeded') ||
        error?.message?.includes('rate limit');
      
      if (is429) {
        console.warn(`⚠️  Rate limit reached for gas tracking on ${chain}. Using fallback RPC or increase SCOUT_GAS_INTERVAL.`);
      } else {
        console.error(`Error fetching gas price for ${chain}:`, error.message || error);
      }
    }
  }

  private calculatePercentageChange(oldValue: number, newValue: number): number {
    if (oldValue === 0) return 0;
    return ((newValue - oldValue) / oldValue) * 100;
  }

  getCurrentGas(chain: string): GasData | undefined {
    const history = this.gasHistory.get(chain);
    return history?.[history.length - 1];
  }

  getGasHistory(chain: string, count: number = 10): GasData[] {
    const history = this.gasHistory.get(chain) || [];
    return history.slice(-count);
  }

  getAverageGas(chain: string, blocks: number = 10): string {
    const history = this.getGasHistory(chain, blocks);
    if (history.length === 0) return '0';

    const sum = history.reduce((acc, data) => acc + BigInt(data.gasPrice), 0n);
    return (sum / BigInt(history.length)).toString();
  }

  async stop(): Promise<void> {
    console.log('Stopping gas tracker...');
    this.isRunning = false;

    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
    }
  }
}