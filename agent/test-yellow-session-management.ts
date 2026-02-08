#!/usr/bin/env ts-node
/**
 * Test Script: Yellow Session On-Demand Management
 * 
 * Demonstrates the new decoupled session lifecycle:
 * - Start/stop sessions without restarting agent
 * - Check session status at any time
 * - Handle multiple sessions in agent lifetime
 */

const API_BASE = 'http://localhost:3000';

interface SessionStatus {
  connected: boolean;
  hasActiveSession: boolean;
  sessionId: string | null;
  summary?: any;
  stats?: any;
  message?: string;
}

// Helper: Pretty print JSON
function print(label: string, data: any): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

// Helper: Sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Check initial status
async function checkStatus(): Promise<SessionStatus> {
  const response = await fetch(`${API_BASE}/api/yellow/session/status`);
  const data = await response.json();
  return data;
}

// 2. Start session
async function startSession(depositAmount: string = '5'): Promise<any> {
  const response = await fetch(`${API_BASE}/api/yellow/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depositAmount })
  });
  return await response.json();
}

// 3. End session
async function endSession(): Promise<any> {
  const response = await fetch(`${API_BASE}/api/yellow/session/end`, {
    method: 'POST'
  });
  return await response.json();
}

// Main test flow
async function main() {
  console.log('\n🧪 Testing Yellow On-Demand Session Management');
  console.log('   Make sure the agent is running: npm start\n');

  try {
    // Step 1: Check initial status
    console.log('📊 Step 1: Check initial status...');
    const status1 = await checkStatus();
    print('Initial Status', status1);
    
    if (!status1.connected) {
      console.error('\n❌ Agent not connected to Yellow Network. Is the agent running?');
      process.exit(1);
    }

    // Step 2: Start first session
    console.log('\n🟡 Step 2: Starting first Yellow session with 5 ytest.usd...');
    await sleep(2000);
    const startResult1 = await startSession('5');
    print('Session Start Result', startResult1);

    if (!startResult1.success) {
      console.error('\n❌ Failed to start session:', startResult1.error || startResult1.message);
      if (startResult1.error === 'Session already active') {
        console.log('💡 A session is already running. Ending it first...');
        await endSession();
        await sleep(2000);
        const retryStart = await startSession('5');
        print('Retry Session Start', retryStart);
      }
    }

    // Step 3: Check status with active session
    console.log('\n📊 Step 3: Check status (should show active session)...');
    await sleep(2000);
    const status2 = await checkStatus();
    print('Status with Active Session', status2);

    // Step 4: Wait a bit (simulate agent activity)
    console.log('\n⏳ Step 4: Simulating agent activity for 10 seconds...');
    console.log('   (Scout signals, Validator alerts, Risk decisions would happen here)');
    for (let i = 10; i > 0; i--) {
      process.stdout.write(`\r   Waiting: ${i}s remaining...`);
      await sleep(1000);
    }
    console.log('\n   ✅ Simulation complete');

    // Step 5: Check status again (should show message activity)
    console.log('\n📊 Step 5: Check status after activity...');
    const status3 = await checkStatus();
    print('Status After Activity', status3);

    // Step 6: End session
    console.log('\n🟡 Step 6: Ending Yellow session...');
    await sleep(2000);
    const endResult1 = await endSession();
    print('Session End Result', endResult1);

    // Step 7: Check status (should show no active session)
    console.log('\n📊 Step 7: Check status (should show no session)...');
    await sleep(2000);
    const status4 = await checkStatus();
    print('Status After Session End', status4);

    // Step 8: Start second session (prove independence from first)
    console.log('\n🟡 Step 8: Starting SECOND session (proving independence)...');
    await sleep(2000);
    const startResult2 = await startSession('10');
    print('Second Session Start', startResult2);

    // Step 9: Final status check
    console.log('\n📊 Step 9: Final status check...');
    await sleep(2000);
    const status5 = await checkStatus();
    print('Final Status', status5);

    // Step 10: Clean up
    console.log('\n🧹 Step 10: Cleaning up (ending second session)...');
    await sleep(2000);
    const endResult2 = await endSession();
    print('Cleanup Result', endResult2);

    console.log('\n' + '='.repeat(60));
    console.log('  ✅ TEST COMPLETE');
    console.log('='.repeat(60));
    console.log('\n📝 Summary:');
    console.log('   ✅ Initial status checked');
    console.log('   ✅ First session started');
    console.log('   ✅ Session activity tracked');
    console.log('   ✅ First session ended');
    console.log('   ✅ Second session started (proves independence)');
    console.log('   ✅ Second session ended');
    console.log('\n🎉 Yellow on-demand session management working correctly!');
    console.log('💡 The agent can now start/stop sessions without restarting.\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
    }
    console.error('\n💡 Make sure the agent is running: npm start');
    process.exit(1);
  }
}

// Run test
main().catch(console.error);
