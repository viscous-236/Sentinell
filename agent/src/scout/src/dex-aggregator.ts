import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { normalizePriceChangeMagnitude } from './utils/magnitude';

export interface DexPrice {
  dex: 'uniswap' | 'curve' | 'sushiswap';
  pair: string;
  token0: string;
  token1: string;
  price: string;
  liquidity: string;
  timestamp: number;
  chain: string;
}

export interface DexConfig {
  providers: Map<string, ethers.Provider>;
  updateInterval: number; // milliseconds
  pairs: Array<{
    token0: string;
    token1: string;
    dex: string;
    chain: string;
  }>;
}

// Uniswap V2 Pair ABI (minimal)
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

export class DexAggregator extends EventEmitter {
  private config: DexConfig;
  private updateIntervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private priceCache: Map<string, DexPrice> = new Map();

  // DEX Router/Factory addresses
  private readonly DEX_ADDRESSES = {
    ethereum: {
      uniswap: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      sushiswap: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'
    },
    base: {
      uniswap: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      sushiswap: '0x71524B4f93c58fcbF659783284E38825f0622859',
    },
    arbitrum: {
      uniswap: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
      sushiswap: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'
    },
  };

  constructor(config: DexConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('Starting DEX aggregator...');
    this.isRunning = true;

    // Initial price fetch
    await this.updateAllPrices();

    // Set up periodic updates
    this.updateIntervalId = setInterval(
      () => this.updateAllPrices(),
      this.config.updateInterval
    );
  }

  private async updateAllPrices(): Promise<void> {
    const updatePromises = this.config.pairs.map(pair =>
      this.updatePairPrice(pair).catch(error =>
        console.error(`Error updating ${pair.dex} ${pair.token0}/${pair.token1}:`, error)
      )
    );

    await Promise.all(updatePromises);
  }

  private async updatePairPrice(pairConfig: any): Promise<void> {
    const provider = this.config.providers.get(pairConfig.chain);
    if (!provider) {
      console.warn(`No provider for chain ${pairConfig.chain}`);
      return;
    }

    try {
      const pairAddress = await this.getPairAddress(pairConfig);
      if (!pairAddress) return;

      const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
      const [reserve0, reserve1] = await pairContract.getReserves();

      // Import token decimals for proper price calculation
      const { TOKEN_DECIMALS } = await import('../config/scout.config');
      const decimals0 = (TOKEN_DECIMALS as any)[pairConfig.token0] || 18;
      const decimals1 = (TOKEN_DECIMALS as any)[pairConfig.token1] || 18;

      // Calculate price with decimal adjustment
      // Price = reserve1 / reserve0 * 10^(decimals0 - decimals1)
      const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
      const price = (Number(reserve1) / Number(reserve0)) * decimalAdjustment;
      const liquidity = (BigInt(reserve0) + BigInt(reserve1)).toString();

      const dexPrice: DexPrice = {
        dex: pairConfig.dex,
        pair: `${pairConfig.token0}/${pairConfig.token1}`,
        token0: pairConfig.token0,
        token1: pairConfig.token1,
        price: price.toString(),
        liquidity,
        timestamp: Date.now(),
        chain: pairConfig.chain,
      };

      const cacheKey = `${pairConfig.chain}-${pairConfig.dex}-${dexPrice.pair}`;
      const oldPrice = this.priceCache.get(cacheKey);

      this.priceCache.set(cacheKey, dexPrice);
      this.emit('price', dexPrice);

      // Detect significant price changes
      if (oldPrice) {
        const priceChange = Math.abs(
          (Number(dexPrice.price) - Number(oldPrice.price)) / Number(oldPrice.price)
        );
        if (priceChange > 0.01) { // 1% threshold
          const magnitude = normalizePriceChangeMagnitude(priceChange);
          this.emit('priceChange', {
            ...dexPrice,
            oldPrice: oldPrice.price,
            change: priceChange,
            magnitude,
          });
        }
      }
    } catch (error) {
      console.error(`Error fetching price for ${pairConfig.dex}:`, error);
    }
  }

  private async getPairAddress(pairConfig: any): Promise<string | null> {
    try {
      // Get token addresses from constants
      const { COMMON_TOKENS } = await import('../config/constants');
      const chainTokens = (COMMON_TOKENS as any)[pairConfig.chain];

      if (!chainTokens) {
        console.warn(`No tokens configured for chain ${pairConfig.chain}`);
        return null;
      }

      const token0Addr = chainTokens[pairConfig.token0];
      const token1Addr = chainTokens[pairConfig.token1];

      if (!token0Addr || !token1Addr) {
        console.warn(`Token address not found: ${pairConfig.token0} or ${pairConfig.token1} on ${pairConfig.chain}`);
        return null;
      }

      // Get factory address for the DEX
      const factoryAddresses = this.DEX_ADDRESSES[pairConfig.chain as keyof typeof this.DEX_ADDRESSES];
      if (!factoryAddresses) {
        console.warn(`No DEX addresses for chain ${pairConfig.chain}`);
        return null;
      }

      const factoryAddress = (factoryAddresses as any)[pairConfig.dex];
      if (!factoryAddress) {
        console.warn(`No factory address for ${pairConfig.dex} on ${pairConfig.chain}`);
        return null;
      }

      // Compute Uniswap V2 pair address using CREATE2
      // Tokens must be sorted
      const [sortedToken0, sortedToken1] = token0Addr.toLowerCase() < token1Addr.toLowerCase()
        ? [token0Addr, token1Addr]
        : [token1Addr, token0Addr];

      // Uniswap V2 pair address computation
      // address = keccak256(abi.encodePacked(
      //   hex'ff',
      //   factory,
      //   keccak256(abi.encodePacked(token0, token1)),
      //   init_code_hash
      // ))

      // Init code hashes for different DEXes
      const INIT_CODE_HASHES: { [key: string]: string } = {
        uniswap: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f', // Uniswap V2
        sushiswap: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303', // SushiSwap
      };

      const initCodeHash = INIT_CODE_HASHES[pairConfig.dex];
      if (!initCodeHash) {
        console.warn(`No init code hash for ${pairConfig.dex}`);
        return null;
      }

      // Compute salt = keccak256(abi.encodePacked(token0, token1))
      const salt = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'address'],
          [sortedToken0, sortedToken1]
        )
      );

      // Compute pair address
      const pairAddress = ethers.getCreate2Address(
        factoryAddress,
        salt,
        initCodeHash
      );

      return pairAddress;
    } catch (error) {
      console.error(`Error computing pair address:`, error);
      return null;
    }
  }

  getPrices(): DexPrice[] {
    return Array.from(this.priceCache.values());
  }

  async stop(): Promise<void> {
    console.log('Stopping DEX aggregator...');
    this.isRunning = false;

    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
    }
  }
}