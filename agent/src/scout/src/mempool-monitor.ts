import { ethers } from 'ethers';
import { EventEmitter } from 'events';

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
}

export interface MempoolConfig {
  ethereumRpc: string;
  baseRpc: string;
  arbitrumRpc: string;
  filters?: {
    minValue?: string;
    addresses?: string[];
  };
}

export class MempoolMonitor extends EventEmitter {
  private providers: Map<string, ethers.WebSocketProvider>;
  private isRunning: boolean = false;
  private config: MempoolConfig;

  constructor(config: MempoolConfig) {
    super();
    this.config = config;
    this.providers = new Map();
  }

  async start(): Promise<void> {
    console.log('Starting mempool monitor...');
    this.isRunning = true;

    // Initialize providers
    this.initializeProvider('ethereum', this.config.ethereumRpc);
    this.initializeProvider('base', this.config.baseRpc);
    this.initializeProvider('arbitrum', this.config.arbitrumRpc);
  }

  private initializeProvider(chain: string, rpcUrl: string): void {
    try {
      const provider = new ethers.WebSocketProvider(rpcUrl);
      this.providers.set(chain, provider);

      // Handle WebSocket connection errors using the internal websocket
      const ws = (provider as any)._websocket;
      if (ws && typeof ws.on === 'function') {
        ws.on('error', (error: Error) => {
          console.error(`[${chain}] WebSocket error:`, error.message);
          this.emit('error', { chain, error });
        });

        ws.on('close', (code: number, reason: string) => {
          console.warn(`[${chain}] WebSocket closed: code=${code}, reason=${reason || 'No reason provided'}`);
        });
      }

      // Also catch provider-level errors
      provider.on('error', (error) => {
        console.error(`[${chain}] Provider error:`, error);
        this.emit('error', { chain, error });
      });

      provider.on('pending', async (txHash) => {
        try {
          const tx = await provider.getTransaction(txHash);
          if (tx && this.shouldProcessTransaction(tx)) {
            const mempoolTx: MempoolTransaction = {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value: tx.value.toString(),
              gasPrice: tx.gasPrice?.toString() || '0',
              gasLimit: tx.gasLimit.toString(),
              data: tx.data,
              nonce: tx.nonce,
              timestamp: Date.now(),
              chain: chain as any,
            };
            this.emit('transaction', mempoolTx);
          }
        } catch (error: any) {
          // Ignore common errors when transaction is not found
          if (!error?.message?.includes('could not coalesce error')) {
            console.error(`Error processing transaction ${txHash}:`, error);
          }
        }
      });

      console.log(`${chain} mempool monitor initialized`);
    } catch (error) {
      console.error(`Failed to initialize ${chain} provider:`, error);
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
    console.log('Stopping mempool monitor...');
    this.isRunning = false;
    
    for (const [chain, provider] of this.providers) {
      await provider.removeAllListeners();
      provider.destroy();
      console.log(`${chain} provider stopped`);
    }
    
    this.providers.clear();
  }

  getStatus(): { chain: string; connected: boolean }[] {
    return Array.from(this.providers.entries()).map(([chain, provider]) => ({
      chain,
      connected: provider._network !== null,
    }));
  }
}