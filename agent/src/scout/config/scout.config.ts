import { ScoutConfig } from '../src/scout';

/**
 * Scout Agent Configuration
 * 
 * This is the ONLY configuration file for the Scout Agent.
 * All settings for multi-chain monitoring are defined here.
 */

// ==========================================
// Protocol Addresses and Constants
// ==========================================

export const CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
} as const;

export const DEX_FACTORY_ADDRESSES = {
  ethereum: {
    uniswapV2: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    uniswapV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    sushiswap: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    curve: '0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5',
  },
  base: {
    uniswapV3: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    sushiswap: '0x71524B4f93c58fcbF659783284E38825f0622859',
  },
  arbitrum: {
    uniswapV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    sushiswap: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    curve: '0x445FE580eF8d70FF569aB36e80c647af338db351',
  },
} as const;

export const LENDING_PROTOCOL_ADDRESSES = {
  ethereum: {
    aaveV2Pool: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    compoundV3: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  },
  base: {
    aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  },
  arbitrum: {
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
} as const;

export const COMMON_TOKENS = {
  ethereum: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  },
  arbitrum: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },
} as const;

export const TOKEN_DECIMALS = {
  WETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WBTC: 8,
} as const;

export const GAS_PRICE_THRESHOLDS = {
  ethereum: {
    low: '20000000000', // 20 gwei
    medium: '50000000000', // 50 gwei
    high: '100000000000', // 100 gwei
    extreme: '200000000000', // 200 gwei
  },
  base: {
    low: '100000000', // 0.1 gwei
    medium: '500000000', // 0.5 gwei
    high: '1000000000', // 1 gwei
    extreme: '5000000000', // 5 gwei
  },
  arbitrum: {
    low: '100000000', // 0.1 gwei
    medium: '500000000', // 0.5 gwei
    high: '1000000000', // 1 gwei
    extreme: '5000000000', // 5 gwei
  },
} as const;

// ==========================================
// Scout Agent Configurations
// ==========================================

/**
 * Default Scout Configuration
 */
export const scoutConfig: ScoutConfig = {
  rpcUrls: {
    ethereum: process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
    base: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
    arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
  },

  mempool: {
    // Enabled - HTTP polling mode (no WebSocket required)
    enabled: true,
    filters: {
      minValue: '1000000000000000000', // 1 ETH
    },
  },

  dex: {
    // Enabled - works with HTTP via pair address computation
    enabled: true,
    updateInterval: 30000, // 30 seconds
    pairs: [
      // Ethereum - all 3 pairs (USDC 6 decimals, USDT 6 decimals, DAI 18 decimals)
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'USDT', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'ethereum' },

      // Base - USDC and DAI only (no USDT on Base)
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'base' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'base' },

      // Arbitrum - all 3 pairs
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'arbitrum' },
      { token0: 'WETH', token1: 'USDT', dex: 'uniswap', chain: 'arbitrum' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'arbitrum' },
    ],
  },

  flashloan: {
    // Enabled - now uses HTTP polling for flash loan events
    enabled: true,
    protocols: {
      aave: [
        '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', // Aave V2 Ethereum
        '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Ethereum
        '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Aave V3 Arbitrum
        '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Aave V3 Base
      ],

      balancer: [
        '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault Ethereum
        '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault Arbitrum
      ],
    },
  },

  gas: {
    enabled: true,
    updateInterval: 15000, // 15 seconds
    spikeThreshold: 50, // 50% increase threshold
  },
};

/**
 * Development Configuration (faster updates, lower thresholds)
 */
export const scoutConfigDev: ScoutConfig = {
  rpcUrls: {
    ethereum: process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
    base: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
    arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
  },

  mempool: {
    // Enabled - HTTP polling mode
    enabled: true,
    filters: {
      minValue: '100000000000000000', // 0.1 ETH for testing
    },
  },

  dex: {
    // Enabled - HTTP + CREATE2 pair computation
    enabled: true,
    updateInterval: 10000, // 10 seconds
    pairs: [
      // Test all 3 pairs on Ethereum for development
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'USDT', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'ethereum' },
    ],
  },

  flashloan: {
    // Enabled - uses HTTP polling
    enabled: true,
    protocols: {
      aave: ['0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'],
    },
  },

  gas: {
    enabled: true,
    updateInterval: 5000, // 5 seconds
    spikeThreshold: 30, // 30% threshold
  },
};

/**
 * Production Configuration (optimized intervals, strict thresholds)
 */
export const scoutConfigProd: ScoutConfig = {
  rpcUrls: {
    ethereum: process.env.ETHEREUM_RPC_URL!,
    base: process.env.BASE_RPC_URL!,
    arbitrum: process.env.ARBITRUM_RPC_URL!,
  },

  mempool: {
    // Disabled - requires WebSocket connections
    enabled: false,
    filters: {
      minValue: '5000000000000000000', // 5 ETH
    },
  },

  dex: {
    // Disabled - pair addresses needed + WebSocket for real-time
    enabled: false,
    updateInterval: 60000, // 1 minute
    pairs: [
      // Ethereum - all 3 pairs
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'USDT', dex: 'uniswap', chain: 'ethereum' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'ethereum' },

      // Base - USDC and DAI (no USDT)
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'base' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'base' },

      // Arbitrum - all 3 pairs
      { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'arbitrum' },
      { token0: 'WETH', token1: 'USDT', dex: 'uniswap', chain: 'arbitrum' },
      { token0: 'WETH', token1: 'DAI', dex: 'uniswap', chain: 'arbitrum' },
    ],
  },

  flashloan: {
    // Disabled - requires WebSocket event listeners
    enabled: false,
    protocols: {
      aave: [
        '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
        '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      ],
      balancer: [
        '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
      ],
    },
  },

  gas: {
    enabled: true,
    updateInterval: 30000, // 30 seconds
    spikeThreshold: 75, // 75% threshold
  },
};

/**
 * Get configuration based on environment
 */
export function getScoutConfig(): ScoutConfig {
  const env = process.env.NODE_ENV || 'development';

  switch (env) {
    case 'production':
      return scoutConfigProd;
    case 'development':
      return scoutConfigDev;
    default:
      return scoutConfig;
  }
}

export default scoutConfig;