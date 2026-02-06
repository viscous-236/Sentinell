/**
 * Quick Deployment Verification Test
 * 
 * Tests the newly deployed SentinelHook contracts on all 3 chains
 * after YellowOracle removal refactor.
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// New deployment addresses
const HOOKS = {
    ethereum: '0xb0dD144187F0e03De762E05F7097E77A9aB9765b',
    base: '0x3cC61A0fC30b561881a39ece40E230DC02D4c99B',
    arbitrum: '0xb0dD144187F0e03De762E05F7097E77A9aB9765b',
};

const RPC_URLS = {
    ethereum: process.env.ETHEREUM_SEPOLIA_RPC!,
    base: process.env.BASE_SEPOLIA_RPC!,
    arbitrum: process.env.ARBITRUM_SEPOLIA_RPC!,
};

// Minimal SentinelHook ABI (only what we need for testing)
const HOOK_ABI = [
    'function owner() view returns (address)',
    'function poolManager() view returns (address)',
    'function baseFee() view returns (uint24)',
    'function activateProtection(bytes32 poolId, uint24 dynamicFee, bytes proof) external',
    'function protections(bytes32) view returns (bool active, uint24 fee, uint256 activatedAt)',
    'function breakers(bytes32) view returns (bool active, string reason, uint256 activatedAt)',
    'function oracleConfigs(bytes32) view returns (address chainlinkFeed, uint256 priceThreshold, bool active)',
];

async function testChain(chainName: 'ethereum' | 'base' | 'arbitrum') {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Testing ${chainName.toUpperCase()} SEPOLIA`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const provider = new ethers.JsonRpcProvider(RPC_URLS[chainName]);
    const hookAddress = HOOKS[chainName];
    const hook = new ethers.Contract(hookAddress, HOOK_ABI, provider);

    try {
        // 1. Check contract exists
        const code = await provider.getCode(hookAddress);
        if (code === '0x') {
            console.log(`❌ Contract not deployed at ${hookAddress}`);
            return false;
        }
        console.log(`✅ Contract deployed at ${hookAddress}`);

        // 2. Check owner
        const owner = await hook.owner();
        console.log(`✅ Owner: ${owner}`);

        // 3. Check poolManager
        const poolManager = await hook.poolManager();
        console.log(`✅ PoolManager: ${poolManager}`);

        // 4. Check baseFee
        const baseFee = await hook.baseFee();
        const feePercent = Number(baseFee) / 100;  // Convert BigInt to number for display
        console.log(`✅ Base Fee: ${baseFee} (${feePercent}%)`);

        // 5. Test reading protection state (should be inactive by default)
        const testPoolId = ethers.id('TEST_POOL_WETH_USDC');
        const protection = await hook.protections(testPoolId);
        console.log(`✅ Protection state readable (active: ${protection.active})`);

        // 6. Test reading breaker state
        const breaker = await hook.breakers(testPoolId);
        console.log(`✅ Circuit breaker state readable (active: ${breaker.active})`);

        // 7. Test reading oracle config
        const oracleConfig = await hook.oracleConfigs(testPoolId);
        console.log(`✅ Oracle config readable (active: ${oracleConfig.active})`);

        console.log(`\n✅ ${chainName.toUpperCase()} - All checks passed!`);
        return true;

    } catch (error: any) {
        console.error(`❌ ${chainName.toUpperCase()} - Error:`, error.message);
        return false;
    }
}

async function main() {
    console.log('\n========================================');
    console.log('  🧪 Post-Deployment Verification');
    console.log('  YellowOracle Removal - Direct Hook Architecture');
    console.log('========================================\n');

    const results = {
        ethereum: await testChain('ethereum'),
        base: await testChain('base'),
        arbitrum: await testChain('arbitrum'),
    };

    console.log('\n========================================');
    console.log('  📊 Summary');
    console.log('========================================');
    console.log(`Ethereum Sepolia: ${results.ethereum ?  '✅ PASS' : '❌ FAIL'}`);
    console.log(`Base Sepolia:     ${results.base ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Arbitrum Sepolia: ${results.arbitrum ? '✅ PASS' : '❌ FAIL'}`);

    const allPassed = results.ethereum && results.base && results.arbitrum;
    console.log(`\n${allPassed ? '🎉 All chains verified!' : '❌ Some chains failed'}\n`);

    if (!allPassed) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
