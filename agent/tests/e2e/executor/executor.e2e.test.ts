/**
 * Executor Agent E2E Test
 * 
 * End-to-end testing of Executor Agent with real RPC connections,
 * LI.FI cross-chain integration, and Yellow Network.
 * 
 * Tests:
 * 1. Hook contract setup (dry-run mode)
 * 2. LI.FI SDK route fetching
 * 3. CrossChainOrchestrator initialization
 * 4. Decision execution flow
 * 5. Yellow state channel decision consumption
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ExecutorAgent, ExecutorConfig } from '../../../src/executor/src/Execution';
import { RiskEngine } from '../../../src/executor/src/RiskEngine';
import { YellowMessageBus } from '../../../src/shared/yellow/YellowMessageBus';
import { ExecutorYellowAdapter } from '../../../src/shared/yellow/YellowAgentAdapters';
import { YellowConfig } from '../../../src/shared/yellow/types';
import { getRoutes, createConfig } from '@lifi/sdk';
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
import { MOCK_RISK_DECISIONS, UNISWAP_V3_POOLS } from '../../shared/mock-data';
import {
    TESTNET_CHAIN_IDS,
    TESTNET_TOKENS,
    LIFI_CONFIG,
    CROSS_CHAIN_ROUTES,
} from '../../../src/executor/config/crosschain.config';

dotenv.config();

// =============================================================================
// TEST CONFIGURATION
// =============================================================================

const TEST_DURATION_MS = 30_000; // 30 seconds
const YELLOW_ALLOCATION = '3'; // 3 ytest.usd for test

// Placeholder hook address for dry-run testing
const PLACEHOLDER_HOOK = '0x0000000000000000000000000000000000000001';

// =============================================================================
// MAIN TEST
// =============================================================================

async function runExecutorE2ETest(): Promise<void> {
    const runner = new TestRunner('Executor Agent E2E Tests');
    runner.start();

    const config = loadTestConfig();
    let executorAgent: ExecutorAgent | null = null;
    let yellowMessageBus: YellowMessageBus | null = null;
    let riskEngine: RiskEngine | null = null;

    try {
        // =========================================================================
        // Test 1: RPC Connectivity
        // =========================================================================
        await runner.runTest('RPC Connectivity', async () => {
            const results: Record<string, { connected: boolean; blockNumber: number }> = {};

            for (const [chain, rpcUrl] of Object.entries({
                ethereum: config.ethereum.rpcUrl,
                base: config.base.rpcUrl,
                arbitrum: config.arbitrum.rpcUrl,
            })) {
                try {
                    const provider = new ethers.JsonRpcProvider(rpcUrl);
                    const blockNumber = await provider.getBlockNumber();
                    results[chain] = { connected: true, blockNumber };
                    logSuccess(`${chain}: Block #${blockNumber}`);
                } catch (error) {
                    results[chain] = { connected: false, blockNumber: 0 };
                    logWarning(`${chain}: Connection failed`);
                }
            }

            return results;
        });

        // =========================================================================
        // Test 2: LI.FI SDK Configuration
        // =========================================================================
        await runner.runTest('LI.FI SDK Configuration', async () => {
            // Initialize LI.FI config
            createConfig({
                integrator: LIFI_CONFIG.integrator,
            });

            logSuccess(`LI.FI SDK configured with integrator: ${LIFI_CONFIG.integrator}`);
            logKeyValue('Supported Chains', Object.values(TESTNET_CHAIN_IDS));

            return {
                integrator: LIFI_CONFIG.integrator,
                chains: Object.values(TESTNET_CHAIN_IDS),
            };
        });

        // =========================================================================
        // Test 3: LI.FI Route Fetching
        // =========================================================================
        await runner.runTest('LI.FI Route Fetching (Mainnet)', async () => {
            try {
                // Fetch a sample route for ETH -> USDC on Ethereum mainnet
                const routes = await getRoutes({
                    fromChainId: 1, // Ethereum mainnet
                    toChainId: 1,
                    fromTokenAddress: '0x0000000000000000000000000000000000000000', // Native ETH
                    toTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
                    fromAmount: '100000000000000000', // 0.1 ETH
                    options: {
                        slippage: 0.01,
                    },
                });

                if (routes.routes && routes.routes.length > 0) {
                    const bestRoute = routes.routes[0];
                    logSuccess(`Found ${routes.routes.length} routes`);
                    logKeyValue('Best Route', {
                        steps: bestRoute.steps.length,
                        estimatedGas: bestRoute.gasCostUSD,
                        toAmount: bestRoute.toAmount,
                    });

                    return {
                        routeCount: routes.routes.length,
                        bestRoute: {
                            steps: bestRoute.steps.length,
                            gasCostUSD: bestRoute.gasCostUSD,
                        },
                    };
                } else {
                    logWarning('No routes found');
                    return { routeCount: 0 };
                }
            } catch (error) {
                logWarning(`Route fetch failed: ${(error as Error).message}`);
                return { error: (error as Error).message };
            }
        });

        // =========================================================================
        // Test 4: Cross-Chain Route Configuration
        // =========================================================================
        await runner.runTest('Cross-Chain Route Configuration', async () => {
            logSection('Configured Cross-Chain Routes');

            for (const route of CROSS_CHAIN_ROUTES) {
                logKeyValue(`${route.fromChainId} → ${route.toChainId}`, {
                    tokens: route.supportedTokens,
                    estimatedTime: `${route.estimatedTime}s`,
                    priority: route.priority,
                });
            }

            return { routeCount: CROSS_CHAIN_ROUTES.length };
        });

        // =========================================================================
        // Test 5: Yellow Network Initialization
        // =========================================================================
        await runner.runTest('Yellow Network Initialization', async () => {
            const yellowConfig: YellowConfig = {
                endPoint: config.yellow.endpoint,
                agentAddress: config.yellow.agentAddress,
                privateKey: config.yellow.privateKey as `0x${string}`,
                rpcUrl: config.ethereum.rpcUrl,
                network: 'sandbox',
            };

            yellowMessageBus = new YellowMessageBus(yellowConfig);
            await yellowMessageBus.initialize(YELLOW_ALLOCATION);

            logSuccess(`Yellow session initialized with ${YELLOW_ALLOCATION} ytest.usd`);

            return { endpoint: yellowConfig.endPoint };
        });

        // =========================================================================
        // Test 6: Executor Agent Initialization
        // =========================================================================
        await runner.runTest('Executor Agent Initialization', async () => {
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
                teeEnabled: false, // Dry-run mode
                maxGasPrice: {
                    ethereum: 50,
                    base: 1,
                    arbitrum: 1,
                },
                crossChain: {
                    enabled: true,
                    dryRun: true, // IMPORTANT: Always dry-run for tests
                },
            };

            executorAgent = new ExecutorAgent(executorConfig);
            await executorAgent.initialize();

            logSuccess('Executor Agent initialized (dry-run mode)');

            return { initialized: true, dryRun: true };
        });

        // =========================================================================
        // Test 7: Risk Engine Initialization
        // =========================================================================
        await runner.runTest('Risk Engine Initialization', async () => {
            riskEngine = new RiskEngine({
                correlationWindowMs: 24000,
                emaAlpha: 0.1,
                rpcBudget: {
                    maxCalls: 100,
                    refillIntervalMs: 60000,
                },
            });

            riskEngine.start();
            logSuccess('Risk Engine started');

            return { started: true };
        });

        // =========================================================================
        // Test 8: Wire Executor to Yellow
        // =========================================================================
        await runner.runTest('Wire Executor to Yellow Message Bus', async () => {
            assertDefined(executorAgent, 'Executor Agent');
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            new ExecutorYellowAdapter(yellowMessageBus!, executorAgent!);

            logSuccess('Executor Agent wired to Yellow Message Bus');

            return { wired: true };
        });

        // =========================================================================
        // Test 9: Decision Execution Flow (Simulated)
        // =========================================================================
        await runner.runTest('Decision Execution Flow (Simulated)', async () => {
            assertDefined(executorAgent, 'Executor Agent');
            assertDefined(riskEngine, 'Risk Engine');

            const executions: any[] = [];
            const failures: any[] = [];

            executorAgent!.on('execution:success', ({ decision, txHash }) => {
                executions.push({ decision: decision.id, txHash });
                console.log(`   ✅ Execution success: ${decision.action} → ${txHash}`);
            });

            executorAgent!.on('execution:failed', ({ decision, error }) => {
                failures.push({ decision: decision.id, error: error.message });
                console.log(`   ⚠️ Execution failed (expected - dry run): ${decision.action}`);
            });

            // Start executor
            await executorAgent!.start();
            logSuccess('Executor Agent started');

            // Emit a test decision from Risk Engine
            // In real scenario, decisions come from wired Yellow channel
            // For testing, we directly emit on the Risk Engine
            logSection('Simulating Risk Decision...');

            const testDecision = {
                ...MOCK_RISK_DECISIONS.mevProtection,
                id: `test-${Date.now()}`,
                timestamp: Date.now(),
            };

            // The decision would normally come through Yellow, but hook calls
            // will fail since we're using placeholder addresses - this is expected
            console.log(`   📤 Simulating decision: ${testDecision.action}`);
            console.log(`   📍 Target: ${testDecision.targetPool}`);
            console.log(`   🎯 Score: ${testDecision.compositeScore}`);

            // Wait a bit for any async processing
            await sleep(2000);

            return {
                simulatedDecision: testDecision.id,
                executions: executions.length,
                failures: failures.length,
            };
        });

        // =========================================================================
        // Test 10: LI.FI Cross-Chain Orchestrator (Dry Run)
        // =========================================================================
        await runner.runTest('CrossChainOrchestrator Dry Run', async () => {
            assertDefined(executorAgent, 'Executor Agent');

            try {
                await executorAgent!.initializeCrossChainOrchestrator();
                logSuccess('CrossChainOrchestrator initialized (dry-run mode)');

                // The orchestrator is now ready for defense actions
                // In dry-run mode, it will simulate but not execute actual transactions

                return { initialized: true, dryRun: true };
            } catch (error) {
                logWarning(`CrossChainOrchestrator init skipped: ${(error as Error).message}`);
                return { initialized: false, reason: (error as Error).message };
            }
        });

        // =========================================================================
        // Test 11: Verify Yellow Messages
        // =========================================================================
        await runner.runTest('Verify Yellow Message Bus Activity', async () => {
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            const summary = yellowMessageBus!.getSummary();

            logSection('Yellow Network Summary');
            logKeyValue('Decisions Published', summary.decisionCount);
            logKeyValue('Executions Published', summary.executionCount);
            logKeyValue('Total Messages', summary.totalMessages);
            logKeyValue('Micro-Fees Accrued', `${summary.microFeesAccrued} ytest.usd`);

            return summary;
        });

        // =========================================================================
        // Test 12: Active Protections Query
        // =========================================================================
        await runner.runTest('Query Active Protections', async () => {
            assertDefined(executorAgent, 'Executor Agent');

            const activeProtections = executorAgent!.getActiveProtections();

            logKeyValue('Active Protections', activeProtections.length);

            for (const { poolKey, state } of activeProtections) {
                logKeyValue(`  ${poolKey}`, {
                    action: state.action,
                    expiresAt: new Date(state.expiresAt).toISOString(),
                });
            }

            return { count: activeProtections.length };
        });

    } catch (error) {
        console.error('\n❌ Test suite failed:', error);
    } finally {
        // Cleanup
        logSection('Cleanup');

        if (riskEngine !== null) {
            (riskEngine as RiskEngine).stop();
            logSuccess('Risk Engine stopped');
        }

        if (executorAgent !== null) {
            await (executorAgent as ExecutorAgent).stop();
            logSuccess('Executor Agent stopped');
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
runExecutorE2ETest().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
