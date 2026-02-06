import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { normalizePriceChangeMagnitude } from './utils/magnitude';
import { DEX_FACTORY_ADDRESSES, COMMON_TOKENS } from '../config/constants';
import { withRpcRetry } from '../../shared/utils/rpc-fallback';

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

// Uniswap V2 Pair ABI (for V2-style pools: SushiSwap, Uniswap V2)
const PAIR_ABI_V2 = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

// Uniswap V3 Pool ABI (for V3 pools)
const POOL_ABI_V3 = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function liquidity() external view returns (uint128)',
];

export class DexAggregator extends EventEmitter {
  private config: DexConfig;
  private updateIntervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private priceCache: Map<string, DexPrice> = new Map();

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

      // Import token decimals for proper price calculation
      const { TOKEN_DECIMALS } = await import('../config/scout.config');
      const decimals0 = (TOKEN_DECIMALS as any)[pairConfig.token0] || 18;
      const decimals1 = (TOKEN_DECIMALS as any)[pairConfig.token1] || 18;

      // Determine if this is a V3 pool (based on factory used)
      const factoryAddresses = (DEX_FACTORY_ADDRESSES as any)[pairConfig.chain];
      const factoryKey = pairConfig.dex === 'uniswap' ? 'uniswapV3' : pairConfig.dex;
      const isV3Pool = factoryKey === 'uniswapV3';

      let price: number;
      let liquidity: string;

      if (isV3Pool) {
        // Uniswap V3 pool - use slot0() to get sqrtPriceX96
        const poolContract = new ethers.Contract(pairAddress, POOL_ABI_V3, provider);
        
        // Wrap contract calls with retry logic to handle rate limits
        const [sqrtPriceX96, liquidityValue, poolToken0Addr, poolToken1Addr] = await withRpcRetry(
          async () => {
            const [slot0Result] = await poolContract.slot0();
            const liq = await poolContract.liquidity();
            const t0 = await poolContract.token0();
            const t1 = await poolContract.token1();
            return [slot0Result, liq, t0, t1];
          },
          3, // max 3 retries
          2000 // 2 second delay
        );

        // Get token addresses from config
        const chainTokens = (COMMON_TOKENS as any)[pairConfig.chain];
        const configToken0Addr = chainTokens[pairConfig.token0];
        const configToken1Addr = chainTokens[pairConfig.token1];

        // Determine if config token order matches pool token order
        const tokensMatchPoolOrder =
          poolToken0Addr.toLowerCase() === configToken0Addr.toLowerCase() &&
          poolToken1Addr.toLowerCase() === configToken1Addr.toLowerCase();

        // Get decimals for pool tokens (in pool's sorted order)
        let poolToken0Decimals: number;
        let poolToken1Decimals: number;

        if (tokensMatchPoolOrder) {
          poolToken0Decimals = decimals0;
          poolToken1Decimals = decimals1;
        } else {
          // Config order is reversed from pool order
          poolToken0Decimals = decimals1;
          poolToken1Decimals = decimals0;
        }

        // Convert sqrtPriceX96 to price
        // V3 sqrtPriceX96 represents sqrt(poolToken1/poolToken0) * 2^96
        // price = (sqrtPriceX96 / 2^96)^2 gives us poolToken1/poolToken0 in raw units
        const Q96 = 2n ** 96n;
        const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
        const rawPrice = sqrtPrice ** 2;

        // Adjust for decimals: rawPrice is poolToken1/poolToken0 in contract units
        // To get human-readable price: multiply by 10^(poolToken0Decimals - poolToken1Decimals)
        const decimalAdjustment = Math.pow(10, poolToken0Decimals - poolToken1Decimals);
        let poolPrice = rawPrice * decimalAdjustment;

        // Now poolPrice is poolToken1 per poolToken0
        // If config order matches pool order, we're done
        // If config order is reversed, invert to get configToken1 per configToken0
        if (tokensMatchPoolOrder) {
          price = poolPrice;
        } else {
          price = 1 / poolPrice;
        }

        liquidity = liquidityValue.toString();

        // Check for minimal liquidity
        if (BigInt(liquidity) < 1000000n) {
          console.warn(`Low liquidity in ${pairConfig.chain} ${pairConfig.dex} ${pairConfig.token0}/${pairConfig.token1}, skipping price update`);
          return;
        }
      } else {
        // V2-style pool (SushiSwap, Uniswap V2, etc) - use getReserves()
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI_V2, provider);
        
        // Wrap contract call with retry logic to handle rate limits
        const [reserve0, reserve1] = await withRpcRetry(
          async () => await pairContract.getReserves(),
          3, // max 3 retries
          2000 // 2 second delay
        );

        // Check for minimal liquidity
        const minReserve0 = BigInt(10 ** decimals0); // ~1 unit of token0
        const minReserve1 = BigInt(10 ** decimals1); // ~1 unit of token1
        if (BigInt(reserve0) < minReserve0 || BigInt(reserve1) < minReserve1) {
          console.warn(`Low liquidity in ${pairConfig.chain} ${pairConfig.dex} ${pairConfig.token0}/${pairConfig.token1}, skipping price update`);
          return;
        }

        // Calculate price with decimal adjustment
        // Price = reserve1 / reserve0 * 10^(decimals0 - decimals1)
        const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
        price = (Number(reserve1) / Number(reserve0)) * decimalAdjustment;

        liquidity = (BigInt(reserve0) + BigInt(reserve1)).toString();
      }

      // Sanity check: skip unrealistic prices
      // For WETH/USDC, price should be ~$2000-4000, not $trillion
      if (price < 0.01 || price > 100000) {
        console.warn(`Unrealistic price ${price} for ${pairConfig.chain} ${pairConfig.dex} ${pairConfig.token0}/${pairConfig.token1}, skipping`);
        return;
      }

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
    } catch (error: any) {
      const is429 = 
        error?.info?.error?.code === 429 ||
        error?.code === 'CALL_EXCEPTION' ||
        error?.message?.includes('exceeded') ||
        error?.message?.includes('rate limit');
      
      if (is429) {
        console.warn(`⚠️  Rate limit reached for ${pairConfig.dex} on ${pairConfig.chain}. Retry with fallback RPC or increase SCOUT_DEX_INTERVAL.`);
      } else {
        console.error(`Error fetching price for ${pairConfig.dex}:`, error.message || error);
      }
    }
  }

  private async getPairAddress(pairConfig: any): Promise<string | null> {
    try {
      // Get token addresses from constants (already imported at top)
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

      // Get factory address for the DEX from imported constants
      const factoryAddresses = (DEX_FACTORY_ADDRESSES as any)[pairConfig.chain];
      if (!factoryAddresses) {
        console.warn(`No DEX addresses for chain ${pairConfig.chain}`);
        return null;
      }

      // Map DEX name to factory key
      const factoryKey = pairConfig.dex === 'uniswap' ? 'uniswapV3' : pairConfig.dex;
      const factoryAddress = factoryAddresses[factoryKey];
      if (!factoryAddress) {
        console.warn(`No factory address for ${pairConfig.dex} (${factoryKey}) on ${pairConfig.chain}`);
        return null;
      }

      // Tokens must be sorted
      const [sortedToken0, sortedToken1] = token0Addr.toLowerCase() < token1Addr.toLowerCase()
        ? [token0Addr, token1Addr]
        : [token1Addr, token0Addr];

      // Check if this is a V3 pool
      const isV3 = factoryKey === 'uniswapV3';

      if (isV3) {
        // Uniswap V3 pool address computation
        // address = keccak256(abi.encodePacked(
        //   hex'ff',
        //   factory,
        //   keccak256(abi.encode(token0, token1, fee)),
        //   POOL_INIT_CODE_HASH
        // ))
        const fee = 3000; // 0.3% fee tier (most common for stablecoins and major pairs)

        const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'; // Uniswap V3

        // Compute salt = keccak256(abi.encode(token0, token1, fee))
        const salt = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24'],
            [sortedToken0, sortedToken1, fee]
          )
        );

        // Compute pool address
        const poolAddress = ethers.getCreate2Address(
          factoryAddress,
          salt,
          POOL_INIT_CODE_HASH
        );

        return poolAddress;
      } else {
        // V2-style pair address computation (SushiSwap, Uniswap V2)
        // Init code hashes for different DEXes
        const INIT_CODE_HASHES: { [key: string]: string } = {
          uniswapV2: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f', // Uniswap V2
          sushiswap: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303', // SushiSwap
        };

        const initCodeHash = INIT_CODE_HASHES[factoryKey];
        if (!initCodeHash) {
          console.warn(`No init code hash for ${factoryKey}`);
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
      }
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