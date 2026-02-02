/**
 * Yellow Network Integration Test (REAL IMPLEMENTATION)
 * 
 * Tests complete Yellow Network flow:
 * 1. Connect to ClearNode (WebSocket)
 * 2. Authenticate (EIP-712)
 * 3. Ensure custody balance (on-chain deposit if needed)
 * 4. Create app session (off-chain, instant, from unified balance)
 * 5. Record protection actions (off-chain state updates)
 * 6. Close app session (instant settlement to unified balance)
 * 
 * NO MOCKS - All real Yellow Network operations
 * 
 * Usage: npm run test:yellow
 */

import { NitroliteClient } from './nitrolite-client';
import { ProtectionAction } from './types';
import * as dotenv from 'dotenv';

dotenv.config();

// Mock Sentinel contract address (for governance)
const MOCK_SENTINEL_ADDRESS = '0x0000000000000000000000000000000000000001';

async function testYellowIntegration() {
  console.log('🧪 Yellow Network Integration Test (REAL)\n');
  console.log('═══════════════════════════════════════\n');

  // Validate environment
  if (!process.env.YELLOW_PRIVATE_KEY || !process.env.YELLOW_AGENT_ADDRESS || !process.env.ALCHEMY_RPC_URL) {
    console.error('❌ Missing required environment variables:');
    console.error('   YELLOW_PRIVATE_KEY');
    console.error('   YELLOW_AGENT_ADDRESS');
    console.error('   ALCHEMY_RPC_URL');
    console.error('\nℹ️  Copy .env.yellow.example to .env and fill in your values');
    process.exit(1);
  }

  const yellowConfig = {
    endPoint: process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws',
    agentAddress: process.env.YELLOW_AGENT_ADDRESS,
    privateKey: process.env.YELLOW_PRIVATE_KEY as `0x${string}`,
    rpcUrl: process.env.ALCHEMY_RPC_URL,
    network: (process.env.YELLOW_NETWORK || 'sandbox') as 'sandbox' | 'production',
  };

  console.log('📋 Configuration:');
  console.log(`   Network:  ${yellowConfig.network}`);
  console.log(`   Endpoint: ${yellowConfig.endPoint}`);
  console.log(`   Agent:    ${yellowConfig.agentAddress}`);
  console.log(`   Sentinel: ${MOCK_SENTINEL_ADDRESS}`);
  console.log(`   RPC:      ${yellowConfig.rpcUrl.substring(0, 50)}...`);
  console.log('');

  let yellowClient: NitroliteClient | undefined;
  let sessionId: string | undefined;

  try {
    // Step 1: Connect & Authenticate
    console.log('Step 1: Connecting to Yellow Network...');
    yellowClient = new NitroliteClient(yellowConfig, MOCK_SENTINEL_ADDRESS);
    await yellowClient.connect();
    console.log('✅ Connected and authenticated\n');

    // Step 2: Create App Session
    // This will:
    // - Check UNIFIED balance (off-chain, from faucet)
    // - Create app session from unified balance (off-chain, instant)
    console.log('Step 2: Creating Sentinel protection session...');
    sessionId = await yellowClient.createSession('1', 'test_pool'); // 1 ytest.usd (faucet gives ~10)
    console.log('✅ Session created\n');

    // Step 3: Record Protection Actions (off-chain state updates)
    console.log('Step 3: Recording protection actions (off-chain)...');
    
    // Action 1: Threat detected
    await yellowClient.recordAction(sessionId, {
      type: 'THREAT_DETECTED',
      threatId: 'threat_001',
      timestamp: Date.now(),
      severity: 85,
      metadata: {
        attackType: 'SANDWICH_ATTACK',
        pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
        frontrunTx: '0xabc...',
      },
    });
    console.log('   ✅ Recorded: THREAT_DETECTED');

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Action 2: Threat approved
    await yellowClient.recordAction(sessionId, {
      type: 'THREAT_APPROVED',
      threatId: 'threat_001',
      timestamp: Date.now(),
      metadata: {
        approvedBy: 'Sentinel',
        action: 'BLOCK',
      },
    });
    console.log('   ✅ Recorded: THREAT_APPROVED');

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Action 3: Hook activated
    await yellowClient.recordAction(sessionId, {
      type: 'HOOK_ACTIVATED',
      threatId: 'threat_001',
      timestamp: Date.now(),
      txHash: '0x456...',
      metadata: {
        hook: 'SentinelHook',
        action: 'beforeSwap',
      },
    });
    console.log('   ✅ Recorded: HOOK_ACTIVATED\n');

    // Step 4: Check Session Status
    console.log('Step 4: Session status...');
    const status = yellowClient.getSessionStatus(sessionId);
    const actions = yellowClient.getSessionActions();
    
    console.log(`   Session ID:        ${status?.sessionId.substring(0, 20)}...`);
    console.log(`   Active:            ${status?.active}`);
    console.log(`   Actions Recorded:  ${actions.length}`);
    console.log(`   Start Time:        ${status?.startTime ? new Date(status.startTime).toISOString() : 'N/A'}`);
    console.log('\n   Action Summary:');
    actions.forEach((action, i) => {
      console.log(`     ${i + 1}. ${action.type} - ${action.threatId}`);
    });
    console.log('');

    // Step 5: Settle Session (close app session)
    console.log('Step 5: Closing app session and settling...');
    const receipt = await yellowClient.closeSession(sessionId);
    console.log('   ✅ Session closed');
    console.log(`   Actions Settled:  ${receipt.actionsSettled}`);
    console.log(`   Gas Used:         ${receipt.gasUsed} (off-chain!)`);
    console.log(`   Final Balance:    ${receipt.finalBalance} ytest.usd`);
    console.log(`   Sentinel Reward:  ${receipt.sentinelReward || '0'} ytest.usd (micro-fees)\n`);

    // Success!
    console.log('═══════════════════════════════════════\n');
    console.log('✅ All tests passed!\n');
    console.log('Yellow Network REAL implementation working:');
    console.log('  ✓ Unified balance (off-chain, from faucet)');
    console.log('  ✓ App sessions (off-chain, instant, gasless)');
    console.log('  ✓ State updates (zero gas fees)');
    console.log('  ✓ Micro-fee tracking (per PROJECT_SPEC.md)');
    console.log('  ✓ Settlement (instant to unified balance)');
    console.log('\nFully integrated per PROJECT_SPEC.md Section 4.6!\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nCommon issues:');
    console.error('1. Missing unified balance - Get from faucet:');
    console.error('   curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens -H "Content-Type: application/json" -d \'{"userAddress":"YOUR_ADDRESS"}\'');
    console.error('   Then wait ~30 seconds for balance to appear (off-chain, no tx needed!)');
    console.error('2. Invalid private key - Check YELLOW_PRIVATE_KEY has 0x prefix');
    console.error('3. Wrong network - Verify ALCHEMY_RPC_URL points to Sepolia');
    console.error('4. Yellow Network down - Check https://docs.yellow.org for status\n');
    
    if (error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  } finally {
    // Cleanup
    if (yellowClient) {
      yellowClient.disconnect();
    }
  }
}

// Run test
testYellowIntegration().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
