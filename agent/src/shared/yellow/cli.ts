#!/usr/bin/env node

/**
 * Sentinel Yellow Network Session CLI
 * 
 * Manual session management for Yellow Network state channels.
 * 
 * Usage:
 *   sentinel-session create --deposit <amount>
 *   sentinel-session status <sessionId>
 *   sentinel-session settle <sessionId>
 *   sentinel-session list
 */

import { NitroliteClient } from './nitrolite-client';
import { ProtectionSessionManager } from './session-manager';
import * as dotenv from 'dotenv';

dotenv.config();

// Session storage (in-memory for demo, use DB in production)
const activeSessions = new Map<string, { sessionId: string; startTime: number; manager: ProtectionSessionManager }>();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Validate environment
  if (!process.env.YELLOW_PRIVATE_KEY || !process.env.YELLOW_AGENT_ADDRESS || !process.env.ALCHEMY_RPC_URL) {
    console.error('❌ Missing required environment variables:');
    console.error('   YELLOW_PRIVATE_KEY');
    console.error('   YELLOW_AGENT_ADDRESS');
    console.error('   ALCHEMY_RPC_URL');
    process.exit(1);
  }

  const yellowConfig = {
    endPoint: process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws',
    agentAddress: process.env.YELLOW_AGENT_ADDRESS,
    privateKey: process.env.YELLOW_PRIVATE_KEY as `0x${string}`,
    rpcUrl: process.env.ALCHEMY_RPC_URL,
    network: (process.env.YELLOW_NETWORK || 'sandbox') as 'sandbox' | 'production',
  };

  switch (command) {
    case 'create':
      await createSession(yellowConfig, args);
      break;

    case 'status':
      await getSessionStatus(args);
      break;

    case 'settle':
      await settleSession(args);
      break;

    case 'list':
      await listSessions();
      break;

    default:
      printHelp();
      process.exit(1);
  }
}

async function createSession(config: any, args: string[]) {
  const depositIndex = args.indexOf('--deposit');
  const deposit = depositIndex !== -1 ? args[depositIndex + 1] : '20'; // Default 20 ytest.usd

  console.log('🚀 Creating Yellow Network protection session...');
  console.log(`   Network: ${config.network}`);
  console.log(`   Deposit: ${deposit} ytest.usd`);

  const yellowClient = new NitroliteClient(config);
  
  try {
    await yellowClient.connect();
    console.log('✅ Connected to Yellow Network');

    const sessionManager = new ProtectionSessionManager(yellowClient);
    const sessionId = await sessionManager.startSession(deposit);

    // Store session
    activeSessions.set(sessionId, {
      sessionId,
      startTime: Date.now(),
      manager: sessionManager,
    });

    console.log('\n✅ Session created successfully!');
    console.log(`   Session ID: ${sessionId}`);
    console.log(`   Deposit: ${deposit} ytest.usd`);
    console.log(`\nℹ️  Keep this terminal open or save the session ID.`);
    console.log(`   To check status: sentinel-session status ${sessionId}`);
    console.log(`   To settle: sentinel-session settle ${sessionId}`);

  } catch (error: any) {
    console.error('❌ Failed to create session:', error.message);
    process.exit(1);
  }
}

async function getSessionStatus(args: string[]) {
  const sessionId = args[1];

  if (!sessionId) {
    console.error('❌ Usage: sentinel-session status <sessionId>');
    process.exit(1);
  }

  const session = activeSessions.get(sessionId);

  if (!session) {
    console.log(`❌ Session not found: ${sessionId}`);
    console.log(`\nℹ️  Available sessions:`);
    listSessions();
    return;
  }

  console.log('\n📊 Session Status');
  console.log('─────────────────────────────────────────');
  console.log(`Session ID:    ${session.sessionId}`);
  console.log(`Start Time:    ${new Date(session.startTime).toISOString()}`);
  console.log(`Duration:      ${Math.floor((Date.now() - session.startTime) / 1000)}s`);
  console.log(`Active:        ${session.manager.isSessionActive() ? '✅ Yes' : '❌ No'}`);

  if (session.manager.isSessionActive()) {
    const summary = session.manager.getSessionSummary();
    console.log(`\n📈 Activity Summary`);
    console.log(`   Threats Detected:  ${summary.threatsDetected}`);
    console.log(`   Actions Approved:  ${summary.actionsApproved}`);
    console.log(`   Actions Rejected:  ${summary.actionsRejected}`);
    console.log(`   Hooks Activated:   ${summary.hooksActivated}`);
    console.log(`   Total Actions:     ${summary.totalActions}`);
  }
}

async function settleSession(args: string[]) {
  const sessionId = args[1];

  if (!sessionId) {
    console.error('❌ Usage: sentinel-session settle <sessionId>');
    process.exit(1);
  }

  const session = activeSessions.get(sessionId);

  if (!session) {
    console.log(`❌ Session not found: ${sessionId}`);
    return;
  }

  if (!session.manager.isSessionActive()) {
    console.log(`❌ Session already settled: ${sessionId}`);
    return;
  }

  console.log(`🔄 Settling session: ${sessionId}...`);

  try {
    const receipt = await session.manager.settleSession();

    console.log('\n✅ Session settled successfully!');
    console.log(`   Transaction Hash: ${receipt.txHash}`);
    console.log(`   Final Balance:    ${receipt.finalBalance}`);
    console.log(`   Actions Settled:  ${receipt.actionsSettled}`);
    console.log(`   Gas Used:         ${receipt.gasUsed}`);

    // Remove from active sessions
    activeSessions.delete(sessionId);

  } catch (error: any) {
    console.error('❌ Failed to settle session:', error.message);
    process.exit(1);
  }
}

async function listSessions() {
  console.log('\n📋 Active Sessions');
  console.log('─────────────────────────────────────────');

  if (activeSessions.size === 0) {
    console.log('   No active sessions');
    console.log('\nℹ️  Create a session: sentinel-session create --deposit 20');
    return;
  }

  for (const [sessionId, session] of activeSessions) {
    const duration = Math.floor((Date.now() - session.startTime) / 1000);
    const isActive = session.manager.isSessionActive();
    console.log(`\n   ${isActive ? '🟢' : '🔴'} ${sessionId.substring(0, 16)}...`);
    console.log(`      Started: ${new Date(session.startTime).toLocaleString()}`);
    console.log(`      Duration: ${duration}s`);

    if (isActive) {
      const summary = session.manager.getSessionSummary();
      console.log(`      Actions: ${summary.totalActions}`);
    }
  }

  console.log('');
}

function printHelp() {
  console.log(`
Sentinel Yellow Network Session CLI

Usage:
  sentinel-session <command> [options]

Commands:
  create [--deposit <amount>]  Create new protection session
                                Default deposit: 20 ytest.usd

  status <sessionId>            Show session status and stats

  settle <sessionId>            Close session and settle on-chain

  list                          List all active sessions

Environment Variables:
  YELLOW_PRIVATE_KEY            Private key for signing (required)
  YELLOW_AGENT_ADDRESS          Ethereum address (required)
  ALCHEMY_RPC_URL               RPC URL for Sepolia (required)
  YELLOW_ENDPOINT               WebSocket endpoint (optional)
                                Default: wss://clearnet-sandbox.yellow.com/ws
  YELLOW_NETWORK                Network mode (optional)
                                Default: sandbox

Examples:
  # Create session with default deposit (20 ytest.usd)
  sentinel-session create

  # Create session with custom deposit
  sentinel-session create --deposit 50

  # Check session status
  sentinel-session status 0xabc123...

  # Settle and close session
  sentinel-session settle 0xabc123...

  # List all active sessions
  sentinel-session list

For more info: https://docs.yellow.org/docs/learn/
`);
}

// Run CLI
main().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
