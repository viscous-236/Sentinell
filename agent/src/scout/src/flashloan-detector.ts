import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { normalizeWeiMagnitude } from './utils/magnitude';

export interface FlashLoan {
  protocol: 'aave' | 'uniswap' | 'balancer';
  borrower: string;
  token: string;
  amount: string;
  fee: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  chain: string;
  profitable?: boolean;
  profit?: string;
  magnitude: number; // NEW: normalized 0-1 magnitude based on loan amount
}

export interface FlashLoanConfig {
  providers: Map<string, ethers.Provider>;
  pollInterval?: number; // Polling interval in milliseconds (default: 15000)
  blocksToCheck?: number; // Number of past blocks to check (default: 3)
  protocols: {
    aave?: string[];
    balancer?: string[];
  };
}

export class FlashLoanDetector extends EventEmitter {
  private config: FlashLoanConfig;
  private isRunning: boolean = false;
  private lastCheckedBlocks: Map<string, number> = new Map();
  private pollIntervalId?: NodeJS.Timeout;
  private readonly pollInterval: number;
  private readonly blocksToCheck: number;

  // Flash loan event signatures
  private readonly EVENT_SIGNATURES = {
    aave: {
      FlashLoan: 'FlashLoan(address,address,address,uint256,uint256,uint16)',
      topic: ethers.id('FlashLoan(address,address,address,uint256,uint256,uint16)'),
    },
    balancer: {
      FlashLoan: 'FlashLoan(address,address,uint256,uint256)',
      topic: ethers.id('FlashLoan(address,address,uint256,uint256)'),
    },
  };

  constructor(config: FlashLoanConfig) {
    super();
    this.config = config;
    this.pollInterval = config.pollInterval || 15000; // Default 15 seconds
    this.blocksToCheck = config.blocksToCheck || 3; // Default 3 blocks
  }

  async start(): Promise<void> {
    console.log('Starting HTTP-based flash loan detector (polling mode)...');
    this.isRunning = true;

    // Initialize last checked blocks
    for (const [chain, provider] of this.config.providers) {
      try {
        const currentBlock = await provider.getBlockNumber();
        this.lastCheckedBlocks.set(chain, currentBlock);
        console.log(`${chain} flash loan detector starting from block ${currentBlock}`);
      } catch (error) {
        console.error(`Failed to get initial block for ${chain}:`, error);
      }
    }

    // Start polling
    this.pollIntervalId = setInterval(
      () => this.pollAllChains(),
      this.pollInterval
    );

    // Initial poll
    await this.pollAllChains();
  }

  private async pollAllChains(): Promise<void> {
    const pollPromises = Array.from(this.config.providers.entries()).map(
      ([chain, provider]) =>
        this.checkChainForFlashLoans(chain, provider).catch(error =>
          console.error(`Error checking flash loans on ${chain}:`, error.message)
        )
    );

    await Promise.all(pollPromises);
  }

  private async checkChainForFlashLoans(chain: string, provider: ethers.Provider): Promise<void> {
    try {
      const currentBlock = await provider.getBlockNumber();
      const lastChecked = this.lastCheckedBlocks.get(chain) || currentBlock - 1;

      // Determine blocks to check
      const startBlock = Math.max(
        lastChecked + 1,
        currentBlock - this.blocksToCheck
      );

      // Check for Aave flash loans
      if (this.config.protocols.aave) {
        await this.checkAaveFlashLoans(chain, provider, startBlock, currentBlock);
      }

      // Check for Balancer flash loans
      if (this.config.protocols.balancer) {
        await this.checkBalancerFlashLoans(chain, provider, startBlock, currentBlock);
      }

      // Update last checked
      this.lastCheckedBlocks.set(chain, currentBlock);
    } catch (error: any) {
      console.error(`Error checking flash loans for ${chain}:`, error.message);
    }
  }

  private async checkAaveFlashLoans(
    chain: string,
    provider: ethers.Provider,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const aaveAddresses = this.config.protocols.aave || [];

    for (const address of aaveAddresses) {
      try {
        const logs = await provider.getLogs({
          address,
          topics: [this.EVENT_SIGNATURES.aave.topic],
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          const parsedLog = this.parseAaveFlashLoan(log, chain);
          if (parsedLog) {
            this.emit('flashloan', parsedLog);
          }
        }
      } catch (error: any) {
        if (!error?.message?.includes('could not coalesce')) {
          console.error(`Error querying Aave logs on ${chain}:`, error.message);
        }
      }
    }
  }

  private async checkBalancerFlashLoans(
    chain: string,
    provider: ethers.Provider,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const balancerAddresses = this.config.protocols.balancer || [];

    for (const address of balancerAddresses) {
      try {
        const logs = await provider.getLogs({
          address,
          topics: [this.EVENT_SIGNATURES.balancer.topic],
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          const parsedLog = this.parseBalancerFlashLoan(log, chain);
          if (parsedLog) {
            this.emit('flashloan', parsedLog);
          }
        }
      } catch (error: any) {
        if (!error?.message?.includes('could not coalesce')) {
          console.error(`Error querying Balancer logs on ${chain}:`, error.message);
        }
      }
    }
  }

  private parseAaveFlashLoan(log: ethers.Log, chain: string): FlashLoan | null {
    try {
      const iface = new ethers.Interface([
        'event FlashLoan(address indexed target, address indexed initiator, address indexed asset, uint256 amount, uint256 premium, uint16 referralCode)'
      ]);
      const parsed = iface.parseLog(log);
      if (!parsed) return null;

      const amount = parsed.args.amount.toString();
      const magnitude = normalizeWeiMagnitude(amount);

      return {
        protocol: 'aave',
        borrower: parsed.args.initiator,
        token: parsed.args.asset,
        amount,
        fee: parsed.args.premium.toString(),
        txHash: log.transactionHash || '',
        blockNumber: log.blockNumber,
        timestamp: Date.now(),
        chain,
        magnitude,
      };
    } catch {
      return null;
    }
  }

  private parseBalancerFlashLoan(log: ethers.Log, chain: string): FlashLoan | null {
    try {
      const iface = new ethers.Interface([
        'event FlashLoan(address indexed recipient, address indexed token, uint256 amount, uint256 feeAmount)'
      ]);
      const parsed = iface.parseLog(log);
      if (!parsed) return null;

      const amount = parsed.args.amount.toString();
      const magnitude = normalizeWeiMagnitude(amount);

      return {
        protocol: 'balancer',
        borrower: parsed.args.recipient,
        token: parsed.args.token,
        amount,
        fee: parsed.args.feeAmount.toString(),
        txHash: log.transactionHash || '',
        blockNumber: log.blockNumber,
        timestamp: Date.now(),
        chain,
        magnitude,
      };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    console.log('Stopping HTTP flash loan detector...');
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