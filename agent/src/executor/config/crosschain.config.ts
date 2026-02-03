/**
 * Cross-Chain Configuration for Sentinell Protection Layer
 * 
 * Testnet configuration for development:
 * - Ethereum Sepolia (11155111)
 * - Base Sepolia (84532)
 * - Arbitrum Sepolia (421614)
 */

// =============================================================================
// CHAIN IDS - TESTNETS
// =============================================================================

export const TESTNET_CHAIN_IDS = {
  ethereumSepolia: 11155111,
  baseSepolia: 84532,
  arbitrumSepolia: 421614,
} as const;

// Mainnet chain IDs (for production)
export const MAINNET_CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
} as const;

// Active chain IDs (switch between testnet/mainnet)
export const ACTIVE_CHAIN_IDS = TESTNET_CHAIN_IDS;

// =============================================================================
// CHAIN CONFIGURATIONS
// =============================================================================

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: string;
  blockExplorer: string;
  isTestnet: boolean;
  avgBlockTime: number; // in seconds
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  ethereumSepolia: {
    id: 11155111,
    name: "Ethereum Sepolia",
    rpcUrl: process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.etherscan.io",
    isTestnet: true,
    avgBlockTime: 12,
  },
  baseSepolia: {
    id: 84532,
    name: "Base Sepolia",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.basescan.org",
    isTestnet: true,
    avgBlockTime: 2,
  },
  arbitrumSepolia: {
    id: 421614,
    name: "Arbitrum Sepolia",
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.arbiscan.io",
    isTestnet: true,
    avgBlockTime: 0.25,
  },
};

// =============================================================================
// TESTNET TOKEN ADDRESSES
// =============================================================================

export const TESTNET_TOKENS = {
  ethereumSepolia: {
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle USDC
    DAI: "0x68194a729C2450ad26072b3D33ADaCbcef39D574",
    LINK: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  },
  baseSepolia: {
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  arbitrumSepolia: {
    ETH: "0x0000000000000000000000000000000000000000",
    WETH: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    USDC: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    DAI: "0xb4E33e1f85A34d8C686f82b61B9c235A0b4e2A8A",
  },
} as const;

// =============================================================================
// CROSS-CHAIN ROUTE CONFIGURATIONS
// =============================================================================

export interface CrossChainRoute {
  fromChainId: number;
  toChainId: number;
  supportedTokens: string[];
  estimatedTime: number; // in seconds
  priority: number; // 1 = highest priority
}

/**
 * Testnet cross-chain routes via LI.FI
 * Note: Not all routes may be available on testnets
 */
export const CROSS_CHAIN_ROUTES: CrossChainRoute[] = [
  // Ethereum Sepolia → Base Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.ethereumSepolia,
    toChainId: TESTNET_CHAIN_IDS.baseSepolia,
    supportedTokens: ["ETH", "USDC"],
    estimatedTime: 900, // ~15 min
    priority: 1,
  },
  // Ethereum Sepolia → Arbitrum Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.ethereumSepolia,
    toChainId: TESTNET_CHAIN_IDS.arbitrumSepolia,
    supportedTokens: ["ETH", "USDC"],
    estimatedTime: 600, // ~10 min
    priority: 1,
  },
  // Base Sepolia → Ethereum Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.baseSepolia,
    toChainId: TESTNET_CHAIN_IDS.ethereumSepolia,
    supportedTokens: ["ETH", "USDC"],
    estimatedTime: 900,
    priority: 2,
  },
  // Base Sepolia → Arbitrum Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.baseSepolia,
    toChainId: TESTNET_CHAIN_IDS.arbitrumSepolia,
    supportedTokens: ["ETH"],
    estimatedTime: 1200,
    priority: 3,
  },
  // Arbitrum Sepolia → Ethereum Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.arbitrumSepolia,
    toChainId: TESTNET_CHAIN_IDS.ethereumSepolia,
    supportedTokens: ["ETH", "USDC"],
    estimatedTime: 900,
    priority: 2,
  },
  // Arbitrum Sepolia → Base Sepolia
  {
    fromChainId: TESTNET_CHAIN_IDS.arbitrumSepolia,
    toChainId: TESTNET_CHAIN_IDS.baseSepolia,
    supportedTokens: ["ETH"],
    estimatedTime: 1200,
    priority: 3,
  },
];

// =============================================================================
// DEFENSE STRATEGY CONFIGURATIONS
// =============================================================================

export interface DefenseStrategyConfig {
  /** Maximum amount (in USD) to reroute in single action */
  maxRerouteAmountUsd: number;
  /** Maximum slippage tolerance (basis points) */
  maxSlippageBps: number;
  /** Minimum gas balance required to execute (in ETH) */
  minGasBalance: string;
  /** Timeout for cross-chain execution (ms) */
  executionTimeoutMs: number;
  /** Retry attempts for failed executions */
  maxRetries: number;
  /** Dry run mode - simulate but don't execute */
  dryRun: boolean;
}

export const DEFENSE_STRATEGY_CONFIGS: Record<string, DefenseStrategyConfig> = {
  LIQUIDITY_REROUTE: {
    maxRerouteAmountUsd: 10000, // $10k max for testnet
    maxSlippageBps: 100, // 1%
    minGasBalance: "0.01", // 0.01 ETH minimum
    executionTimeoutMs: 900_000, // 15 min
    maxRetries: 3,
    dryRun: true, // Start in dry-run mode
  },
  CROSS_CHAIN_ARBITRAGE_BLOCK: {
    maxRerouteAmountUsd: 5000,
    maxSlippageBps: 50, // 0.5%
    minGasBalance: "0.005",
    executionTimeoutMs: 120_000, // 2 min (faster response needed)
    maxRetries: 1,
    dryRun: true,
  },
  EMERGENCY_BRIDGE: {
    maxRerouteAmountUsd: 50000, // Higher limit for emergencies
    maxSlippageBps: 300, // 3% - accept higher slippage for speed
    minGasBalance: "0.02",
    executionTimeoutMs: 300_000, // 5 min
    maxRetries: 5, // More retries for critical action
    dryRun: true,
  },
};

// =============================================================================
// SAFE HAVEN CONFIGURATION
// =============================================================================

/**
 * Safe haven chain is where liquidity is routed during emergencies.
 * For testnets, Ethereum Sepolia is the default.
 */
export const SAFE_HAVEN_CONFIG = {
  chainId: TESTNET_CHAIN_IDS.ethereumSepolia,
  chainName: "Ethereum Sepolia",
  preferredToken: "USDC",
  fallbackToken: "ETH",
};

// =============================================================================
// THREAT THRESHOLDS FOR CROSS-CHAIN ACTIONS
// =============================================================================

export const CROSS_CHAIN_THREAT_THRESHOLDS = {
  /** Minimum composite score to trigger LIQUIDITY_REROUTE */
  liquidityRerouteMinScore: 60,
  /** Minimum composite score to trigger EMERGENCY_BRIDGE */
  emergencyBridgeMinScore: 85,
  /** Price deviation threshold for cross-chain arb detection (basis points) */
  crossChainArbDeviationBps: 100, // 1%
  /** Time window for detecting coordinated cross-chain attacks (ms) */
  coordinatedAttackWindowMs: 30_000, // 30 seconds
};

// =============================================================================
// LIFI SDK CONFIGURATION
// =============================================================================

export const LIFI_CONFIG = {
  integrator: "Sentinell",
  /** LI.FI API endpoint */
  apiUrl: "https://li.quest/v1",
  /** Supported chain IDs */
  chains: Object.values(TESTNET_CHAIN_IDS),
  /** Default route options */
  defaultRouteOptions: {
    slippage: 0.01, // 1%
    allowSwitchChain: true,
    bridges: {
      allow: ["across", "stargate", "hop", "cbridge"], // Preferred bridges
    },
    exchanges: {
      allow: ["uniswap", "sushiswap", "1inch"],
    },
  },
};

export default {
  ACTIVE_CHAIN_IDS,
  CHAIN_CONFIGS,
  TESTNET_TOKENS,
  CROSS_CHAIN_ROUTES,
  DEFENSE_STRATEGY_CONFIGS,
  SAFE_HAVEN_CONFIG,
  CROSS_CHAIN_THREAT_THRESHOLDS,
  LIFI_CONFIG,
};
