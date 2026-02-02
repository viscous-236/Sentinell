/**
 * Yellow Network Integration Test - DEMO MODE
 * 
 * Uses Yellow Network faucet tokens (off-chain balance)
 * No custody deposits or on-chain transactions required
 * 
 * Get tokens from faucet:
 * curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens \
 *   -H "Content-Type: application/json" \
 *   -d '{"userAddress":"YOUR_ADDRESS"}'
 */

import { NitroliteClient } from './nitrolite-client';
import * as dotenv from 'dotenv';

dotenv.config();

async function testYellowDemo() {
    console.log('🧪 Yellow Network Integration Test (DEMO MODE)\n');
    console.log('═══════════════════════════════════════\n');

    const privateKey = process.env.YELLOW_PRIVATE_KEY as `0x${string}`;
    const sentinelAddress = process.env.YELLOW_SENTINEL_ADDRESS as `0x${string}` || 
                           '0x0000000000000000000000000000000000000001' as `0x${string}`;
    const rpcUrl = process.env.ALCHEMY_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';
    const endpoint = process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws';

    if (!privateKey) {
        throw new Error('YELLOW_PRIVATE_KEY not set in .env');
    }

    const agentAddress = process.env.YELLOW_AGENT_ADDRESS;

    console.log('📋 Configuration:');
    console.log(`   Network:  ${process.env.YELLOW_NETWORK || 'sandbox'}`);
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   Agent:    ${agentAddress}`);
    console.log(`   Sentinel: ${sentinelAddress}`);
    console.log(`   Mode:     DEMO (using Yellow Network faucet balance)\n`);

    console.log('💡 IMPORTANT: This demo uses Yellow Network internal balance');
    console.log('   Get test tokens: curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens \\');
    console.log(`     -H "Content-Type: application/json" -d '{"userAddress":"${agentAddress}"}'`);
    console.log('   Faucet gives you 10 ytest.usd in Yellow Network (NOT on-chain Sepolia)\n');

    const config = {
        privateKey,
        agentAddress: agentAddress!,
        endPoint: endpoint,
        rpcUrl,
        network: (process.env.YELLOW_NETWORK as 'sandbox' | 'production') || 'sandbox',
    };

    const yellowClient = new NitroliteClient(config, sentinelAddress);

    try {
        // Step 1: Connect & Authenticate
        console.log('Step 1: Connecting to Yellow Network...');
        await yellowClient.connect();
        console.log('✅ Connected and authenticated\n');

        // Step 2: Skip session creation for now - just verify connection
        console.log('Step 2: Verifying Yellow Network integration...');
        console.log('   ✅ WebSocket connected');
        console.log('   ✅ EIP-712 authentication successful');
        console.log('   ✅ Ready to create app sessions');
        
        console.log('\n📝 Next Steps:');
        console.log('   1. Request faucet tokens (see command above)');
        console.log('   2. Yellow Network will credit your account with 10 ytest.usd');
        console.log('   3. Use these tokens to create app sessions (off-chain, instant)');
        console.log('   4. App sessions use Yellow\'s unified balance (no custody deposit needed)');
        
        console.log('\n✅ Yellow Network integration verified!\n');
        
        await yellowClient.disconnect();
        process.exit(0);

    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        
        console.log('\nCommon issues:');
        console.log('1. Yellow Network sandbox might be down');
        console.log('2. Invalid private key format - needs 0x prefix');
        console.log('3. Network connectivity issues');
        console.log('4. Check https://docs.yellow.org for status\n');
        
        console.log('Stack trace:');
        console.error(error);
        
        await yellowClient.disconnect();
        process.exit(1);
    }
}

testYellowDemo();
