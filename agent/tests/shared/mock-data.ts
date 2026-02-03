/**
 * Mock Data and Test Fixtures
 * 
 * Common test data used across E2E tests.
 */

// =============================================================================
// CHAINLINK FEED ADDRESSES
// =============================================================================

export const CHAINLINK_FEEDS = {
    ethereum: {
        'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
        'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
        'USDC/USD': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
        'LINK/USD': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    },
    base: {
        'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    },
    arbitrum: {
        'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
        'BTC/USD': '0x6ce185860a4963106506C203335a2910S3e2347F',
    },
} as const;

// =============================================================================
// PYTH PRICE IDS
// =============================================================================

export const PYTH_PRICE_IDS = {
    'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7acf0a6c2b9e3a6d3d5a9c7a7a7a',
    'USDC/USD': '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
} as const;

// =============================================================================
// DEX POOLS (MAINNET)
// =============================================================================

export const UNISWAP_V3_POOLS = {
    ethereum: {
        'WETH/USDC': '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', // 0.3% fee
        'WETH/USDT': '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFA36', // 0.3% fee
        'WBTC/WETH': '0xCBCdF9626bC03E24f779434178A73a0B4bad62eD', // 0.3% fee
    },
    base: {
        'WETH/USDC': '0xd0b53D9277642d899DF5C87A3966A349A798F224',
    },
    arbitrum: {
        'WETH/USDC': '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443',
    },
} as const;

// =============================================================================
// FLASH LOAN PROTOCOLS
// =============================================================================

export const FLASHLOAN_POOLS = {
    aave: {
        ethereum: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', // Aave V2 LendingPool
        arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Aave V3 Pool
    },
    balancer: {
        ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer Vault
        arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    },
} as const;

// =============================================================================
// MOCK TRANSACTIONS
// =============================================================================

export const MOCK_TRANSACTIONS = {
    largeSwap: {
        hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        from: '0x1234567890123456789012345678901234567890',
        to: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
        value: '10000000000000000000', // 10 ETH
        gasPrice: '50000000000', // 50 gwei
        gas: '300000',
        input: '0x7ff36ab5', // swapExactETHForTokens
        chain: 'ethereum' as const,
    },
    flashLoan: {
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        from: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        to: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', // Aave
        value: '0',
        gasPrice: '100000000000', // 100 gwei
        gas: '500000',
        input: '0xab9c4b5d', // flashLoan
        chain: 'ethereum' as const,
    },
};

// =============================================================================
// MOCK RISK DECISIONS
// =============================================================================

export const MOCK_RISK_DECISIONS = {
    mevProtection: {
        id: 'test-decision-001',
        action: 'MEV_PROTECTION' as const,
        tier: 'CRITICAL' as const,
        compositeScore: 75,
        targetPool: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
        pair: 'ETH/USDC',
        chain: 'ethereum',
        timestamp: Date.now(),
        ttlMs: 60000,
        rationale: 'High sandwich attack probability detected',
        contributingSignals: [
            { source: 'mempool', magnitude: 0.8, timestamp: Date.now() },
            { source: 'gas', magnitude: 0.6, timestamp: Date.now() },
        ],
    },
    oracleValidation: {
        id: 'test-decision-002',
        action: 'ORACLE_VALIDATION' as const,
        tier: 'ELEVATED' as const,
        compositeScore: 55,
        targetPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
        pair: 'ETH/USDC',
        chain: 'base',
        timestamp: Date.now(),
        ttlMs: 30000,
        rationale: 'Oracle price deviation detected',
        contributingSignals: [
            { source: 'oracle', magnitude: 0.5, timestamp: Date.now() },
        ],
    },
    circuitBreaker: {
        id: 'test-decision-003',
        action: 'CIRCUIT_BREAKER' as const,
        tier: 'CRITICAL' as const,
        compositeScore: 90,
        targetPool: '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443',
        pair: 'ETH/USDC',
        chain: 'arbitrum',
        timestamp: Date.now(),
        ttlMs: 120000,
        rationale: 'Critical anomaly detected - pool pause recommended',
        contributingSignals: [
            { source: 'flashloan', magnitude: 0.9, timestamp: Date.now() },
            { source: 'mempool', magnitude: 0.85, timestamp: Date.now() },
        ],
    },
};

// =============================================================================
// EXPECTED VALUES FOR ASSERTIONS
// =============================================================================

export const EXPECTED_VALUES = {
    ethPriceRange: {
        min: 1000, // $1,000 USD
        max: 10000, // $10,000 USD
    },
    btcPriceRange: {
        min: 20000, // $20,000 USD
        max: 200000, // $200,000 USD
    },
    gasRange: {
        ethereum: { min: 1, max: 500 }, // gwei
        base: { min: 0.001, max: 10 },
        arbitrum: { min: 0.01, max: 5 },
    },
};
