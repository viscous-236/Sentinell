/**
 * Verify AgentRegistry Integration
 * 
 * Tests that AgentRegistry is properly linked to all SentinelHook contracts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const HOOKS = {
    ethereum: '0xb0dD144187F0e03De762E05F7097E77A9aB9765b',
    base: '0x3cC61A0fC30b561881a39ece40E230DC02D4c99B',
    arbitrum: '0xb0dD144187F0e03De762E05F7097E77A9aB9765b',
};

const REGISTRIES = {
    ethereum: '0x59e933aa18ACC69937e068873CF6EA62742D6a14',
    base: '0x4267E4cB6d6595474a79220f8d9D96108052AC9E',
    arbitrum: '0x709C1e6fbA95A6C520E7AC1716d32Aef8b675a32',
};

const RPC_URLS = {
    ethereum: process.env.ETHEREUM_SEPOLIA_RPC!,
    base: process.env.BASE_SEPOLIA_RPC!,
    arbitrum: process.env.ARBITRUM_SEPOLIA_RPC!,
};

const HOOK_ABI = ['function agentRegistry() view returns (address)'];

async function verifyChain(chainName: 'ethereum' | 'base' | 'arbitrum') {
    console.log(`\n🔍 Verifying ${chainName.toUpperCase()}...`);
    
    const provider = new ethers.JsonRpcProvider(RPC_URLS[chainName]);
    const hook = new ethers.Contract(HOOKS[chainName], HOOK_ABI, provider);
    
    const actualRegistry = await hook.agentRegistry();
    const expectedRegistry = REGISTRIES[chainName];
    
    console.log(`   Hook:              ${HOOKS[chainName]}`);
    console.log(`   Expected Registry: ${expectedRegistry}`);
    console.log(`   Actual Registry:   ${actualRegistry}`);
    
    if (actualRegistry.toLowerCase() === expectedRegistry.toLowerCase()) {
        console.log(`   ✅ Registry correctly linked!`);
        return true;
    } else {
        console.log(`   ❌ Registry mismatch!`);
        return false;
    }
}

async function main() {
    console.log('\n========================================');
    console.log('  🔗 AgentRegistry Link Verification');
    console.log('========================================');

    const results = {
        ethereum: await verifyChain('ethereum'),
        base: await verifyChain('base'),
        arbitrum: await verifyChain('arbitrum'),
    };

    console.log('\n========================================');
    console.log('  📊 Summary');
    console.log('========================================');
    console.log(`Ethereum: ${results.ethereum ? '✅ LINKED' : '❌ NOT LINKED'}`);
    console.log(`Base:     ${results.base ? '✅ LINKED' : '❌ NOT LINKED'}`);
    console.log(`Arbitrum: ${results.arbitrum ? '✅ LINKED' : '❌ NOT LINKED'}`);

    const allLinked = results.ethereum && results.base && results.arbitrum;
    console.log(`\n${allLinked ? '🎉 All registries connected!' : '❌ Some links failed'}\n`);

    if (!allLinked) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
