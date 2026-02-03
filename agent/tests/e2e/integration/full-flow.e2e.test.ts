/**
 * Full Integration E2E Test
 * 
 * End-to-end testing of the complete Sentinel protection flow:
 * Scout → Validator → RiskEngine → Executor
 * 
 * All agent communication flows through Yellow state channels.
 * 
 * Tests:
 * 1. All agents initialization
 * 2. Yellow Message Bus coordination
 * 3. Complete threat detection and response flow
 * 4. Cross-chain monitoring
 * 5. Session settlement
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ScoutAgent, ScoutConfig } from '../../../src/scout/src/scout';
import { ValidatorAgent, ValidatorConfig } from '../../../src/validator/src/validator';
import { ExecutorAgent, ExecutorConfig } from '../../../src/executor/src/Execution';
import { RiskEngine } from '../../../src/executor/src/RiskEngine';
import { YellowMessageBus } from '../../../src/shared/yellow/YellowMessageBus';
import { wireAllAgentsToYellow } from '../../../src/shared/yellow/YellowAgentAdapters';
import { YellowConfig } from '../../../src/shared/yellow/types';
import {
    TestRunner,
    loadTestConfig,
    sleep,
    logSection,
    logKeyValue,
    logSuccess,
    logWarning,
    assertDefined,
} from '../../shared/test-utils';
import { CHAINLINK_FEEDS, PYTH_PRICE_IDS, FLASHLOAN_POOLS } from '../../shared/mock-data';

dotenv.config();

// =============================================================================
// TEST CONFIGURATION
// =============================================================================

const TEST_DURATION_MS = 60_000; // 60 seconds full integration
const YELLOW_ALLOCATION = '10'; // 10 ytest.usd for comprehensive test

// Placeholder hook address for dry-run testing
const PLACEHOLDER_HOOK = '0x0000000000000000000000000000000000000001';

// =============================================================================
// MAIN TEST
// =============================================================================

async function runFullIntegrationE2ETest(): Promise<void> {
    const runner = new TestRunner('Full Integration E2E Test');
    runner.start();

    const config = loadTestConfig();

    // Agents
    let scoutAgent: ScoutAgent | null = null;
    let validatorAgent: ValidatorAgent | null = null;
    let executorAgent: ExecutorAgent | null = null;
    let riskEngine: RiskEngine | null = null;
    let yellowMessageBus: YellowMessageBus | null = null;

    // Event counters
    const counters = {
        scoutSignals: 0,
        scoutTransactions: 0,
        scoutFlashLoans: 0,
        validatorAlerts: 0,
        riskDecisions: 0,
        executorActions: 0,
        executorFailures: 0,
    };

    try {
        // =========================================================================
        // Test 1: Initialize Yellow Message Bus
        // =========================================================================
        await runner.runTest('Initialize Yellow Message Bus', async () => {
            const yellowConfig: YellowConfig = {
                endPoint: config.yellow.endpoint,
                agentAddress: config.yellow.agentAddress,
                privateKey: config.yellow.privateKey as `0x${string}`,
                rpcUrl: config.ethereum.rpcUrl,
                network: 'sandbox',
            };

            yellowMessageBus = new YellowMessageBus(yellowConfig);
            await yellowMessageBus.initialize(YELLOW_ALLOCATION);

            logSuccess(`Yellow session: ${YELLOW_ALLOCATION} ytest.usd allocated`);
            logKeyValue('Agent', yellowConfig.agentAddress);

            return { initialized: true };
        });

        // =========================================================================
        // Test 2: Initialize Risk Engine
        // =========================================================================
        await runner.runTest('Initialize Risk Engine', async () => {
            riskEngine = new RiskEngine({
                correlationWindowMs: 24000,
                emaAlpha: 0.1,
                rpcBudget: {
                    maxCalls: 100,
                    refillIntervalMs: 60000,
                },
            });

            // Track decisions
            riskEngine.on('decision', (decision) => {
                counters.riskDecisions++;
                console.log(`   🎯 Decision: ${decision.action} | Score: ${decision.compositeScore.toFixed(1)} | Pool: ${decision.targetPool.substring(0, 18)}...`);
            });

            logSuccess('Risk Engine initialized');
            return { initialized: true };
        });

        // =========================================================================
        // Test 3: Initialize Scout Agent
        // =========================================================================
        await runner.runTest('Initialize Scout Agent', async () => {
            const scoutConfig: ScoutConfig = {
                rpcUrls: {
                    ethereum: config.ethereum.rpcUrl,
                    base: config.base.rpcUrl,
                    arbitrum: config.arbitrum.rpcUrl,
                },
                mempool: { enabled: true },
                dex: {
                    enabled: true,
                    updateInterval: 20000,
                    pairs: [
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'base' },
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'arbitrum' },
                    ],
                },
                gas: {
                    enabled: true,
                    updateInterval: 15000,
                    spikeThreshold: 1.5,
                },
                flashloan: {
                    enabled: true,
                    protocols: {
                        aave: [FLASHLOAN_POOLS.aave.ethereum],
                        balancer: [FLASHLOAN_POOLS.balancer.ethereum],
                    },
                },
                clusterDetection: {
                    enabled: true,
                    windowMs: 24000,
                    threshold: 3,
                },
            };

            scoutAgent = new ScoutAgent(scoutConfig);
            await scoutAgent.initialize();

            // Track events
            scoutAgent.on('signal', () => counters.scoutSignals++);
            scoutAgent.on('transaction', () => counters.scoutTransactions++);
            scoutAgent.on('flashloan', () => counters.scoutFlashLoans++);

            logSuccess('Scout Agent initialized');
            return scoutAgent.getStatus();
        });

        // =========================================================================
        // Test 4: Initialize Validator Agent
        // =========================================================================
        await runner.runTest('Initialize Validator Agent', async () => {
            const validatorConfig: ValidatorConfig = {
                rpcUrls: {
                    ethereum: config.ethereum.rpcUrl,
                    base: config.base.rpcUrl,
                    arbitrum: config.arbitrum.rpcUrl,
                },
                chainlinkFeeds: {
                    ethereum: {
                        'ETH/USD': CHAINLINK_FEEDS.ethereum['ETH/USD'],
                        'BTC/USD': CHAINLINK_FEEDS.ethereum['BTC/USD'],
                    },
                    base: { 'ETH/USD': CHAINLINK_FEEDS.base['ETH/USD'] },
                    arbitrum: { 'ETH/USD': CHAINLINK_FEEDS.arbitrum['ETH/USD'] },
                },
                oracleCheckerConfig: {
                    pythEndpoint: 'https://hermes.pyth.network',
                    pythPriceIds: {
                        ethereum: { 'ETH/USD': PYTH_PRICE_IDS['ETH/USD'] },
                        base: { 'ETH/USD': PYTH_PRICE_IDS['ETH/USD'] },
                        arbitrum: { 'ETH/USD': PYTH_PRICE_IDS['ETH/USD'] },
                    },
                    staleThreshold: 300,
                    minOraclesRequired: 1,
                },
                priceValidatorConfig: {
                    crosschainDeviation: 100,
                    minChainsRequired: 2,
                    priceAgeThreshold: 300000,
                },
                thresholds: {
                    oracleDeviation: 5,
                    crosschainDeviation: 2,
                },
                aggregatorConfig: { enableHistory: true },
            };

            validatorAgent = new ValidatorAgent(validatorConfig);

            // Track alerts
            validatorAgent.on('threat:alert', () => counters.validatorAlerts++);

            logSuccess('Validator Agent initialized');
            return validatorAgent.getStatus();
        });

        // =========================================================================
        // Test 5: Initialize Executor Agent
        // =========================================================================
        await runner.runTest('Initialize Executor Agent', async () => {
            const executorConfig: ExecutorConfig = {
                rpcUrls: {
                    ethereum: config.ethereum.rpcUrl,
                    base: config.base.rpcUrl,
                    arbitrum: config.arbitrum.rpcUrl,
                },
                hookAddresses: {
                    ethereum: PLACEHOLDER_HOOK,
                    base: PLACEHOLDER_HOOK,
                    arbitrum: PLACEHOLDER_HOOK,
                },
                agentPrivateKey: config.yellow.privateKey,
                teeEnabled: false,
                maxGasPrice: { ethereum: 50, base: 1, arbitrum: 1 },
                crossChain: { enabled: true, dryRun: true },
            };

            executorAgent = new ExecutorAgent(executorConfig);
            await executorAgent.initialize();

            // Track executions
            executorAgent.on('execution:success', () => counters.executorActions++);
            executorAgent.on('execution:failed', () => counters.executorFailures++);

            logSuccess('Executor Agent initialized (dry-run mode)');
            return { initialized: true };
        });

        // =========================================================================
        // Test 6: Wire All Agents to Yellow
        // =========================================================================
        await runner.runTest('Wire All Agents via Yellow Message Bus', async () => {
            assertDefined(yellowMessageBus, 'Yellow Message Bus');
            assertDefined(scoutAgent, 'Scout Agent');
            assertDefined(validatorAgent, 'Validator Agent');
            assertDefined(riskEngine, 'Risk Engine');
            assertDefined(executorAgent, 'Executor Agent');

            wireAllAgentsToYellow(yellowMessageBus!, {
                scout: scoutAgent!,
                validator: validatorAgent!,
                riskEngine: riskEngine!,
                executor: executorAgent!,
            }, {
                scoutMagnitudeThreshold: 0.3,
                scoutMaxSignalsPerMinute: 30,
            });

            logSuccess('All agents wired through Yellow state channels');
            logSection('Communication Flow:');
            console.log('   Scout → Yellow → RiskEngine');
            console.log('   Validator → Yellow → RiskEngine');
            console.log('   RiskEngine → Yellow → Executor');

            return { wired: true };
        });

        // =========================================================================
        // Test 7: Start All Agents
        // =========================================================================
        await runner.runTest('Start All Agents', async () => {
            assertDefined(riskEngine, 'Risk Engine');
            assertDefined(scoutAgent, 'Scout Agent');
            assertDefined(validatorAgent, 'Validator Agent');
            assertDefined(executorAgent, 'Executor Agent');

            riskEngine!.start();
            logSuccess('Risk Engine started');

            await scoutAgent!.start();
            logSuccess('Scout Agent started');

            await validatorAgent!.start();
            logSuccess('Validator Agent started');

            await executorAgent!.start();
            logSuccess('Executor Agent started');

            return { allStarted: true };
        });

        // =========================================================================
        // Test 8: Run Full Integration Monitoring
        // =========================================================================
        await runner.runTest(`Full Integration Monitoring (${TEST_DURATION_MS / 1000}s)`, async () => {
            logSection('Monitoring Active');
            console.log('   📡 Scout: Mempool, DEX, Flash Loans, Gas');
            console.log('   🔍 Validator: Chainlink, Pyth Oracles');
            console.log('   🧠 RiskEngine: Threat Correlation');
            console.log('   ⚡ Executor: Hook Activation (dry-run)');
            console.log('   🟡 Yellow: State Channel Communication');
            console.log('');

            // Progress updates every 15 seconds
            const intervalMs = 15000;
            const iterations = Math.floor(TEST_DURATION_MS / intervalMs);

            for (let i = 0; i < iterations; i++) {
                await sleep(intervalMs);
                const elapsed = (i + 1) * intervalMs / 1000;
                console.log(`   ⏱️  ${elapsed}s - Signals: ${counters.scoutSignals} | TXs: ${counters.scoutTransactions} | Decisions: ${counters.riskDecisions}`);
            }

            return counters;
        });

        // =========================================================================
        // Test 9: Verify Yellow Network Activity
        // =========================================================================
        await runner.runTest('Verify Yellow Network Coordination', async () => {
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            const summary = yellowMessageBus!.getSummary();

            logSection('Yellow Network Summary');
            logKeyValue('Signals via Yellow', summary.signalCount);
            logKeyValue('Alerts via Yellow', summary.alertCount);
            logKeyValue('Decisions via Yellow', summary.decisionCount);
            logKeyValue('Executions via Yellow', summary.executionCount);
            logKeyValue('Total Messages', summary.totalMessages);
            logKeyValue('Micro-Fees Accrued', `${summary.microFeesAccrued} ytest.usd`);

            return summary;
        });

        // =========================================================================
        // Test 10: Final Summary
        // =========================================================================
        await runner.runTest('Generate Final Summary', async () => {
            logSection('INTEGRATION TEST RESULTS');

            console.log('   📡 Scout Agent:');
            logKeyValue('     Signals Emitted', counters.scoutSignals);
            logKeyValue('     Transactions Detected', counters.scoutTransactions);
            logKeyValue('     Flash Loans Detected', counters.scoutFlashLoans);

            console.log('   🔍 Validator Agent:');
            logKeyValue('     Threat Alerts', counters.validatorAlerts);

            console.log('   🧠 Risk Engine:');
            logKeyValue('     Decisions Made', counters.riskDecisions);

            console.log('   ⚡ Executor Agent:');
            logKeyValue('     Actions Executed', counters.executorActions);
            logKeyValue('     Failed (expected dry-run)', counters.executorFailures);

            return counters;
        });

    } catch (error) {
        console.error('\n❌ Integration test failed:', error);
    } finally {
        // Cleanup
        logSection('Cleanup');

        if (scoutAgent !== null) {
            await (scoutAgent as ScoutAgent).stop();
            logSuccess('Scout Agent stopped');
        }

        if (validatorAgent !== null) {
            await (validatorAgent as ValidatorAgent).stop();
            logSuccess('Validator Agent stopped');
        }

        if (executorAgent !== null) {
            await (executorAgent as ExecutorAgent).stop();
            logSuccess('Executor Agent stopped');
        }

        if (riskEngine !== null) {
            (riskEngine as RiskEngine).stop();
            logSuccess('Risk Engine stopped');
        }

        if (yellowMessageBus !== null) {
            await (yellowMessageBus as YellowMessageBus).shutdown();
            logSuccess('Yellow session settled');
        }
    }

    runner.printSummary();
    process.exit(runner.allPassed() ? 0 : 1);
}

// Run the test
runFullIntegrationE2ETest().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
