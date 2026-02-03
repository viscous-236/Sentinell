/**
 * Scout Agent E2E Test
 * 
 * End-to-end testing of Scout Agent with real RPC connections and Yellow Network.
 * 
 * Tests:
 * 1. Mempool monitoring on Ethereum/Base/Arbitrum
 * 2. DEX price aggregation from Uniswap V3
 * 3. Flash loan detection (Aave, Balancer)
 * 4. Gas spike monitoring
 * 5. Signal emission via Yellow state channels
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ScoutAgent, ScoutConfig } from '../../../src/scout/src/scout';
import { YellowMessageBus } from '../../../src/shared/yellow/YellowMessageBus';
import { ScoutYellowAdapter } from '../../../src/shared/yellow/YellowAgentAdapters';
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
    assertGreaterThan,
} from '../../shared/test-utils';
import { FLASHLOAN_POOLS, UNISWAP_V3_POOLS } from '../../shared/mock-data';

dotenv.config();

// =============================================================================
// TEST CONFIGURATION
// =============================================================================

const TEST_DURATION_MS = 60_000; // 60 seconds monitoring window
const YELLOW_ALLOCATION = '5'; // 5 ytest.usd for test

// =============================================================================
// MAIN TEST
// =============================================================================

async function runScoutE2ETest(): Promise<void> {
    const runner = new TestRunner('Scout Agent E2E Tests');
    runner.start();

    const config = loadTestConfig();
    let scoutAgent: ScoutAgent | null = null;
    let yellowMessageBus: YellowMessageBus | null = null;

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

            // At least 2 chains should be connected
            const connectedCount = Object.values(results).filter(r => r.connected).length;
            assertGreaterThan(connectedCount, 1, 'Connected chains');

            return results;
        });

        // =========================================================================
        // Test 2: Yellow Network Initialization
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

            return { endpoint: yellowConfig.endPoint, agent: yellowConfig.agentAddress };
        });

        // =========================================================================
        // Test 3: Scout Agent Initialization
        // =========================================================================
        await runner.runTest('Scout Agent Initialization', async () => {
            const scoutConfig: ScoutConfig = {
                rpcUrls: {
                    ethereum: config.ethereum.rpcUrl,
                    base: config.base.rpcUrl,
                    arbitrum: config.arbitrum.rpcUrl,
                },
                mempool: {
                    enabled: true,
                },
                dex: {
                    enabled: true,
                    updateInterval: 15000, // 15 seconds
                    pairs: [
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'ethereum' },
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'base' },
                        { token0: 'WETH', token1: 'USDC', dex: 'uniswap', chain: 'arbitrum' },
                    ],
                },
                gas: {
                    enabled: true,
                    updateInterval: 10000,
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

            const status = scoutAgent.getStatus();
            logKeyValue('Status', status);

            return status;
        });

        // =========================================================================
        // Test 4: Wire Scout to Yellow
        // =========================================================================
        await runner.runTest('Wire Scout to Yellow Message Bus', async () => {
            assertDefined(scoutAgent, 'Scout Agent');
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            new ScoutYellowAdapter(yellowMessageBus!, scoutAgent!, {
                magnitudeThreshold: 0.3,
                maxSignalsPerMinute: 30,
            });

            logSuccess('Scout Agent wired to Yellow Message Bus');

            return { wired: true };
        });

        // =========================================================================
        // Test 5: Start Monitoring
        // =========================================================================
        await runner.runTest('Start Monitoring & Data Collection', async () => {
            assertDefined(scoutAgent, 'Scout Agent');

            // Track events
            const events = {
                signals: 0,
                transactions: 0,
                flashloans: 0,
                gasSpikes: 0,
                prices: 0,
            };

            scoutAgent!.on('signal', (signal) => {
                events.signals++;
                console.log(`   📡 Signal: ${signal.type} | Chain: ${signal.chain} | Magnitude: ${signal.magnitude.toFixed(2)}`);
            });

            scoutAgent!.on('transaction', (tx) => {
                events.transactions++;
                if (events.transactions <= 5) {
                    console.log(`   💰 TX: ${tx.hash.substring(0, 18)}... | Value: ${ethers.formatEther(tx.value)} ETH`);
                }
            });

            scoutAgent!.on('flashloan', (loan) => {
                events.flashloans++;
                console.log(`   ⚡ Flash Loan: ${loan.protocol} | Amount: ${loan.amount}`);
            });

            scoutAgent!.on('price', (price) => {
                events.prices++;
                if (events.prices <= 3) {
                    console.log(`   💹 Price: ${price.pair} on ${price.chain} = ${price.price}`);
                }
            });

            await scoutAgent!.start();
            logSuccess('Scout Agent started');

            logSection(`Running for ${TEST_DURATION_MS / 1000} seconds...`);
            await sleep(TEST_DURATION_MS);

            logKeyValue('Events collected', events);

            return events;
        });

        // =========================================================================
        // Test 6: Verify Data Collection
        // =========================================================================
        await runner.runTest('Verify Collected Data', async () => {
            assertDefined(scoutAgent, 'Scout Agent');

            const data = scoutAgent!.getComprehensiveData();

            const summary = {
                transactions: data.allTransactions.length,
                prices: data.allPrices.length,
                flashLoans: data.allFlashLoans.length,
                gasData: data.allGasData.length,
                byChain: {
                    ethereum: data.byChain.ethereum.transactions.length,
                    base: data.byChain.base.transactions.length,
                    arbitrum: data.byChain.arbitrum.transactions.length,
                },
            };

            logSection('Data Summary');
            logKeyValue('Total Transactions', summary.transactions);
            logKeyValue('Total Prices', summary.prices);
            logKeyValue('Flash Loans', summary.flashLoans);
            logKeyValue('Gas Data Points', summary.gasData);
            logKeyValue('Ethereum TXs', summary.byChain.ethereum);
            logKeyValue('Base TXs', summary.byChain.base);
            logKeyValue('Arbitrum TXs', summary.byChain.arbitrum);

            return summary;
        });

        // =========================================================================
        // Test 7: Verify Yellow Messages
        // =========================================================================
        await runner.runTest('Verify Yellow Message Bus Activity', async () => {
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            const summary = yellowMessageBus!.getSummary();

            logSection('Yellow Network Summary');
            logKeyValue('Signals Published', summary.signalCount);
            logKeyValue('Total Messages', summary.totalMessages);
            logKeyValue('Micro-Fees Accrued', `${summary.microFeesAccrued} ytest.usd`);

            return summary;
        });

        // =========================================================================
        // Test 8: Gas Data Validation
        // =========================================================================
        await runner.runTest('Validate Gas Data', async () => {
            assertDefined(scoutAgent, 'Scout Agent');

            const gasData: Record<string, { current: string; average: string }> = {};

            for (const chain of ['ethereum', 'base', 'arbitrum']) {
                const current = scoutAgent!.getCurrentGas(chain);
                const average = scoutAgent!.getAverageGas(chain, 10);

                gasData[chain] = {
                    current: current?.gasPrice || 'N/A',
                    average,
                };
            }

            logSection('Gas Data');
            for (const [chain, data] of Object.entries(gasData)) {
                logKeyValue(`${chain} Current`, data.current);
                logKeyValue(`${chain} Average`, data.average);
            }

            return gasData;
        });

        // =========================================================================
        // Test 9: Price Data Validation
        // =========================================================================
        await runner.runTest('Validate Price Data', async () => {
            assertDefined(scoutAgent, 'Scout Agent');

            const prices = scoutAgent!.getCurrentPrices();

            logSection(`Current Prices (${prices.length} pairs)`);

            const priceMap: Record<string, string> = {};
            for (const price of prices) {
                const key = `${price.chain}:${price.pair}`;
                priceMap[key] = price.price;
                logKeyValue(key, price.price);
            }

            return priceMap;
        });

    } catch (error) {
        console.error('\n❌ Test suite failed:', error);
    } finally {
        // Cleanup
        logSection('Cleanup');

        if (scoutAgent !== null) {
            await (scoutAgent as ScoutAgent).stop();
            logSuccess('Scout Agent stopped');
        }

        if (yellowMessageBus !== null) {
            await (yellowMessageBus as YellowMessageBus).shutdown();
            logSuccess('Yellow session settled');
        }
    }

    runner.printSummary();

    // Exit with appropriate code
    process.exit(runner.allPassed() ? 0 : 1);
}

// Run the test
runScoutE2ETest().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
