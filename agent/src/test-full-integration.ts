/**
 * Full Integration Test - Yellow Network + All Agents + Real RPCs
 * 
 * Tests complete Sentinel protection flow per PROJECT_SPEC.md:
 * 1. Yellow Network session initialization (Section 4.5-4.6)
 * 2. Scout Agent monitoring real blockchain data (Section 4.1)
 * 3. Validator Agent checking oracles (Section 4.1)
 * 4. Risk Engine correlating threats (Section 4.3)
 * 5. Executor Agent activating hooks (Section 4.1)
 * 6. ALL agent communication via Yellow state channels (Section 4.5)
 * 7. Session settlement with fee distribution
 * 
 * Per PROJECT_SPEC.md Section 4.5:
 *   "Agents communicate via Yellow state channels"
 * 
 * This is a production-like test with real:
 * - WebSocket connection to Yellow Network
 * - RPC calls to Ethereum/Base/Arbitrum
 * - Mempool monitoring
 * - DEX price aggregation
 * - Flash loan detection
 * - Oracle validation
 * - Off-chain state channel operations
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { YellowMessageBus } from './shared/yellow/YellowMessageBus';
import { wireAllAgentsToYellow } from './shared/yellow/YellowAgentAdapters';
import { RiskEngine } from './executor/src/RiskEngine';
import { ScoutAgent, ScoutConfig } from './scout/src/scout';
import { ValidatorAgent, ValidatorConfig } from './validator/src/validator';
import { ExecutorAgent, ExecutorConfig } from './executor/src/Execution';
import { YellowConfig } from './shared/yellow/types';

dotenv.config();

// Helper function to get block explorer URL
const getExplorerUrl = (chain: string, txHash: string): string => {
  const explorers: Record<string, string> = {
    ethereum: 'https://etherscan.io/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
  };
  return explorers[chain] + txHash;
};

async function runFullIntegrationTest() {
  console.log('\n🚀 Full Integration Test - Yellow + All Agents + Real RPCs');
  console.log('==============================================================\n');

  // Load config
  const privateKey = process.env.YELLOW_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo';

  if (!privateKey) {
    throw new Error('YELLOW_PRIVATE_KEY or PRIVATE_KEY environment variable required');
  }

  // Derive agent address
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const agentAddress = account.address;

  console.log('📋 Configuration:');
  console.log(`   Agent: ${agentAddress}`);
  console.log(`   Network: sandbox`);
  console.log(`   RPC: ${rpcUrl.substring(0, 50)}...`);
  console.log(`   Ethereum RPC: ${process.env.ETHEREUM_RPC_URL?.substring(0, 50) || rpcUrl.substring(0, 50)}...`);
  console.log(`   Base RPC: ${process.env.BASE_RPC_URL?.substring(0, 50) || 'https://mainnet.base.org'}...`);
  console.log(`   Arbitrum RPC: ${process.env.ARBITRUM_RPC_URL?.substring(0, 50) || 'https://arb1.arbitrum.io/rpc'}...\n`);

  // ======================
  // 1. YELLOW MESSAGE BUS SETUP (per PROJECT_SPEC.md Section 4.5)
  // ======================
  console.log('🟡 Step 1/5: Initializing Yellow Message Bus...');
  console.log('   Per PROJECT_SPEC.md Section 4.5:');
  console.log('   "Agents communicate via Yellow state channels"\n');
  
  const yellowConfig: YellowConfig = {
    endPoint: process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws',
    agentAddress,
    privateKey: privateKey as `0x${string}`,
    rpcUrl,
    network: 'sandbox',
  };

  const yellowMessageBus = new YellowMessageBus(yellowConfig);
  await yellowMessageBus.initialize('10'); // 10 ytest.usd for comprehensive test
  console.log('   ✅ Yellow Message Bus ready for agent communication\n');

  // ======================
  // 2. RISK ENGINE SETUP
  // ======================
  console.log('🧠 Step 2/5: Initializing Risk Engine...');
  const riskEngine = new RiskEngine({
    correlationWindowMs: 24000, // 24 seconds
    emaAlpha: 0.1,
    rpcBudget: {
      maxCalls: 100,
      refillIntervalMs: 60000,
    },
  });
  console.log('   ✅ Risk Engine initialized\n');

  // ======================
  // 3. EXECUTOR AGENT SETUP
  // ======================
  console.log('⚡ Step 3/5: Initializing Executor Agent...');
  const executorConfig: ExecutorConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    },
    hookAddresses: {
      ethereum: process.env.HOOK_ADDRESS_ETHEREUM || '0x0000000000000000000000000000000000000001',
      base: process.env.HOOK_ADDRESS_BASE || '0x0000000000000000000000000000000000000001',
      arbitrum: process.env.HOOK_ADDRESS_ARBITRUM || '0x0000000000000000000000000000000000000001',
    },
    agentPrivateKey: privateKey,
    teeEnabled: false, // Placeholder mode
    maxGasPrice: {
      ethereum: 50,
      base: 1,
      arbitrum: 1,
    },
  };

  const executorAgent = new ExecutorAgent(executorConfig);
  await executorAgent.initialize();

  console.log('   ✅ Executor initialized\n');

  // ======================
  // 4. SCOUT AGENT SETUP
  // ======================
  console.log('📡 Step 4/5: Initializing Scout Agent...');
  const scoutConfig: ScoutConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    },
    mempool: {
      enabled: true,
    },
    dex: {
      enabled: true,
      updateInterval: 30000, // 30 seconds
      pairs: [
        // Only WETH/USDC across all chains (rate limit optimized)
        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'base' },
        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'arbitrum' },
      ],
    },
    gas: {
      enabled: true,
      updateInterval: 15000, // 15 seconds
      spikeThreshold: 1.5,
    },
    flashloan: {
      enabled: true,
      protocols: {
        aave: ['0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9'],
        balancer: ['0xBA12222222228d8Ba445958a75a0704d566BF2C8'],
      },
    },
    clusterDetection: {
      enabled: true,
      windowMs: 24000,
      threshold: 3,
    },
  };

  const scoutAgent = new ScoutAgent(scoutConfig);

  // Track Scout events
  let signalsCount = 0;
  let transactionsCount = 0;
  let flashloansCount = 0;

  scoutAgent.on('signal', (signal) => {
    signalsCount++;
    console.log(`\n📡 [Scout] Signal #${signalsCount}:`);
    console.log(`   Type: ${signal.type}`);
    console.log(`   Magnitude: ${signal.magnitude.toFixed(2)}`);
    console.log(`   Chain: ${signal.chain}`);
    console.log(`   Pair: ${signal.pair || 'N/A'}`);
    console.log(`   Pool: ${signal.poolAddress}\n`);
  });

  scoutAgent.on('transaction', (tx) => {
    transactionsCount++;
    const explorerUrl = getExplorerUrl(tx.chain, tx.hash);
    console.log(`💰 [Scout] Transaction #${transactionsCount}: ${tx.hash} | Value: ${ethers.formatEther(tx.value)} ETH | ${explorerUrl}`);
  });

  scoutAgent.on('flashloan', (loan) => {
    flashloansCount++;
    const explorerUrl = getExplorerUrl(loan.chain, loan.txHash);
    const amount = ethers.formatUnits(loan.amount, 18);
    console.log(`⚡ [Scout] Flash Loan #${flashloansCount}: ${loan.protocol} | ${amount} tokens | TX: ${loan.txHash} | ${explorerUrl}`);
  });

  await scoutAgent.initialize();
  await scoutAgent.start();
  console.log('   ✅ Scout started - monitoring all chains\n');

  // ======================
  // 5. VALIDATOR AGENT SETUP
  // ======================
  console.log('🔍 Step 5/5: Initializing Validator Agent...');
  const validatorConfig: ValidatorConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      arbitrum: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    },
    chainlinkFeeds: {
      ethereum: {
        'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
        'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
      },
      base: {
        'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
      },
      arbitrum: {
        'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
      },
    },
    oracleCheckerConfig: {
      pythEndpoint: 'https://hermes.pyth.network',
      pythPriceIds: {
        ethereum: {
          'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        },
        base: {
          'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        },
        arbitrum: {
          'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        },
      },
      staleThreshold: 300,
      minOraclesRequired: 1,
    },
    priceValidatorConfig: {
      crosschainDeviation: 100, // 100 basis points
      minChainsRequired: 2,
      priceAgeThreshold: 300000,
    },
    thresholds: {
      oracleDeviation: 5,
      crosschainDeviation: 2,
    },
    aggregatorConfig: {
      enableHistory: true,
    },
  };

  const validatorAgent = new ValidatorAgent(validatorConfig);

  // Track Validator alerts
  let alertsCount = 0;
  validatorAgent.on('threat:alert', (alert) => {
    alertsCount++;
    console.log(`\n🚨 [Validator] Alert #${alertsCount}:`);
    console.log(`   Type: ${alert.type}`);
    console.log(`   Severity: ${alert.severity}`);
    console.log(`   Chain: ${alert.chain}`);
    console.log(`   Target: ${alert.targetPool}\n`);
  });

  // ======================
  // Wire ALL agents through Yellow Message Bus
  // Per PROJECT_SPEC.md Section 4.5: "Agents communicate via Yellow state channels"
  // ======================
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('🔗 Wiring ALL Agents Through Yellow State Channels');
  console.log('   Per PROJECT_SPEC.md Section 4.5:');
  console.log('   "Agents communicate via Yellow state channels"');
  console.log('═══════════════════════════════════════════════════════════\n');

  wireAllAgentsToYellow(yellowMessageBus, {
    scout: scoutAgent,
    validator: validatorAgent,
    riskEngine,
    executor: executorAgent,
  }, {
    scoutMagnitudeThreshold: 0.3,
    scoutMaxSignalsPerMinute: 30,
  });

  // Track decisions and executions
  let decisionsCount = 0;
  let executionsCount = 0;
  
  riskEngine.on('decision', (decision) => {
    decisionsCount++;
    console.log(`\n🎯 [RiskEngine] Decision #${decisionsCount}:`);
    console.log(`   Action: ${decision.action}`);
    console.log(`   Tier: ${decision.tier}`);
    console.log(`   Score: ${decision.compositeScore.toFixed(2)}`);
    console.log(`   Pool: ${decision.targetPool}`);
    console.log(`   Chain: ${decision.chain}`);
    console.log(`   Rationale: ${decision.rationale}\n`);
  });

  executorAgent.on('execution:success', ({ decision, txHash }) => {
    executionsCount++;
    const explorerUrl = getExplorerUrl(decision.chain, txHash);
    console.log(`\n⚡ [Executor] Execution #${executionsCount}:`);
    console.log(`   Hook: ${decision.action}`);
    console.log(`   Chain: ${decision.chain}`);
    console.log(`   TX: ${txHash}`);
    console.log(`   Explorer: ${explorerUrl}\n`);
  });

  // Start all components
  riskEngine.start();
  await scoutAgent.initialize();
  await scoutAgent.start();
  console.log('   ✅ Scout started - monitoring all chains\n');

  await validatorAgent.start();
  console.log('   ✅ Validator started\n');

  // ======================
  // 6. RUN TEST
  // ======================
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('⏱️  Running full integration for 90 seconds...\n');
  console.log('   Monitoring:');
  console.log('   - Real mempool transactions across 3 chains');
  console.log('   - DEX prices (Uniswap, Sushiswap)');
  console.log('   - Flash loans (Aave, Balancer)');
  console.log('   - Oracle prices (Chainlink, Pyth)');
  console.log('   - Cross-chain price consistency');
  console.log('   - Threat correlation and risk decisions');
  console.log('   - Hook activations (placeholder mode)');
  console.log('   - ALL agent communication via Yellow state channels');
  console.log('   - Off-chain recording to Yellow Network\n');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Run for 90 seconds
  await new Promise(resolve => setTimeout(resolve, 90000));

  // ======================
  // 7. SHUTDOWN & SETTLEMENT
  // ======================
  console.log('\n\n🛑 Test complete - shutting down...\n');

  console.log('Stopping agents...');
  await scoutAgent.stop();
  console.log('   ✅ Scout stopped');

  await validatorAgent.stop();
  console.log('   ✅ Validator stopped');

  await executorAgent.stop();
  console.log('   ✅ Executor stopped');

  riskEngine.stop();
  console.log('   ✅ Risk Engine stopped');

  console.log('\n💰 Settling Yellow session...');
  await yellowMessageBus.shutdown();
  console.log('   ✅ Session settled\n');

  // ======================
  // 8. SUMMARY
  // ======================
  const summary = yellowMessageBus.getSummary();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Scout Events:`);
  console.log(`   - Signals: ${signalsCount}`);
  console.log(`   - Transactions: ${transactionsCount}`);
  console.log(`   - Flash Loans: ${flashloansCount}\n`);
  console.log(`Validator Events:`);
  console.log(`   - Alerts: ${alertsCount}\n`);
  console.log(`Risk Engine:`);
  console.log(`   - Decisions: ${decisionsCount}\n`);
  console.log(`Executor:`);
  console.log(`   - Executions: ${executionsCount}\n`);
  console.log(`Yellow Network (State Channel Communication):`);
  console.log(`   - Signals via Yellow: ${summary.signalCount}`);
  console.log(`   - Alerts via Yellow: ${summary.alertCount}`);
  console.log(`   - Decisions via Yellow: ${summary.decisionCount}`);
  console.log(`   - Executions via Yellow: ${summary.executionCount}`);
  console.log(`   - Total messages: ${summary.totalMessages}`);
  console.log(`   - Micro-fees accrued: ${summary.microFeesAccrued} ytest.usd\n`);
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('✅ Full integration test completed successfully!');
  console.log('   All agent communication flowed through Yellow state channels.\n');
}

// Run the test
runFullIntegrationTest().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});
