/**
 * Validator Agent E2E Test
 * 
 * End-to-end testing of Validator Agent with real oracle connections and Yellow Network.
 * 
 * Tests:
 * 1. Chainlink oracle price fetching
 * 2. Pyth Network oracle integration
 * 3. Cross-chain price consistency validation
 * 4. Threat alert emission via Yellow state channels
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ValidatorAgent, ValidatorConfig } from '../../../src/validator/src/validator';
import { YellowMessageBus } from '../../../src/shared/yellow/YellowMessageBus';
import { ValidatorYellowAdapter } from '../../../src/shared/yellow/YellowAgentAdapters';
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
import { CHAINLINK_FEEDS, PYTH_PRICE_IDS } from '../../shared/mock-data';

dotenv.config();

// =============================================================================
// TEST CONFIGURATION
// =============================================================================

const TEST_DURATION_MS = 30_000; // 30 seconds monitoring window
const YELLOW_ALLOCATION = '3'; // 3 ytest.usd for test

// Chainlink AggregatorV3Interface ABI
const CHAINLINK_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
];

// =============================================================================
// MAIN TEST
// =============================================================================

async function runValidatorE2ETest(): Promise<void> {
    const runner = new TestRunner('Validator Agent E2E Tests');
    runner.start();

    const config = loadTestConfig();
    let validatorAgent: ValidatorAgent | null = null;
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

            return results;
        });

        // =========================================================================
        // Test 2: Direct Chainlink Oracle Access
        // =========================================================================
        await runner.runTest('Chainlink Oracle Direct Access', async () => {
            const provider = new ethers.JsonRpcProvider(config.ethereum.rpcUrl);
            const prices: Record<string, { price: string; decimals: number; updatedAt: number }> = {};

            for (const [pair, address] of Object.entries(CHAINLINK_FEEDS.ethereum)) {
                try {
                    const feed = new ethers.Contract(address, CHAINLINK_ABI, provider);
                    const [, answer, , updatedAt] = await feed.latestRoundData();
                    const decimals = await feed.decimals();

                    const price = Number(answer) / Math.pow(10, Number(decimals));
                    prices[pair] = {
                        price: `$${price.toFixed(2)}`,
                        decimals: Number(decimals),
                        updatedAt: Number(updatedAt),
                    };

                    logSuccess(`${pair}: $${price.toFixed(2)} (updated ${new Date(Number(updatedAt) * 1000).toISOString()})`);
                } catch (error) {
                    logWarning(`${pair}: Failed to fetch - ${(error as Error).message}`);
                }
            }

            return prices;
        });

        // =========================================================================
        // Test 3: Pyth Network Price Fetching
        // =========================================================================
        await runner.runTest('Pyth Network Oracle Access', async () => {
            const pythEndpoint = 'https://hermes.pyth.network';
            const prices: Record<string, { price: number; confidence: number; publishTime: number }> = {};

            try {
                // Fetch ETH/USD price from Pyth
                const priceId = PYTH_PRICE_IDS['ETH/USD'];
                const response = await fetch(`${pythEndpoint}/api/latest_price_feeds?ids[]=${priceId}`);

                if (response.ok) {
                    const data = await response.json() as any[];
                    if (data && data.length > 0) {
                        const feed = data[0];
                        const price = Number(feed.price.price) * Math.pow(10, feed.price.expo);
                        const confidence = Number(feed.price.conf) * Math.pow(10, feed.price.expo);

                        prices['ETH/USD'] = {
                            price,
                            confidence,
                            publishTime: feed.price.publish_time,
                        };

                        logSuccess(`ETH/USD: $${price.toFixed(2)} ± $${confidence.toFixed(2)}`);
                    }
                } else {
                    logWarning('Pyth API returned non-OK response');
                }
            } catch (error) {
                logWarning(`Pyth fetch failed: ${(error as Error).message}`);
            }

            return prices;
        });

        // =========================================================================
        // Test 4: Yellow Network Initialization
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
        // Test 5: Validator Agent Initialization
        // =========================================================================
        await runner.runTest('Validator Agent Initialization', async () => {
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
                    base: {
                        'ETH/USD': CHAINLINK_FEEDS.base['ETH/USD'],
                    },
                    arbitrum: {
                        'ETH/USD': CHAINLINK_FEEDS.arbitrum['ETH/USD'],
                    },
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
                    crosschainDeviation: 100, // 100 basis points (1%)
                    minChainsRequired: 2,
                    priceAgeThreshold: 300000,
                },
                thresholds: {
                    oracleDeviation: 5, // 5%
                    crosschainDeviation: 2, // 2%
                },
                aggregatorConfig: {
                    enableHistory: true,
                },
            };

            validatorAgent = new ValidatorAgent(validatorConfig);

            const status = validatorAgent.getStatus();
            logKeyValue('Status', status);

            return status;
        });

        // =========================================================================
        // Test 6: Wire Validator to Yellow
        // =========================================================================
        await runner.runTest('Wire Validator to Yellow Message Bus', async () => {
            assertDefined(validatorAgent, 'Validator Agent');
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            new ValidatorYellowAdapter(yellowMessageBus!, validatorAgent!);

            logSuccess('Validator Agent wired to Yellow Message Bus');

            return { wired: true };
        });

        // =========================================================================
        // Test 7: Track Threat Alerts
        // =========================================================================
        await runner.runTest('Start Validator & Track Alerts', async () => {
            assertDefined(validatorAgent, 'Validator Agent');

            const alerts: any[] = [];

            validatorAgent!.on('threat:alert', (alert) => {
                alerts.push(alert);
                console.log(`   🚨 Alert: ${alert.type} | Severity: ${alert.severity} | Chain: ${alert.chain}`);
            });

            validatorAgent!.on('validation:complete', (result) => {
                if (!result.valid) {
                    console.log(`   ⚠️  Validation failed: ${result.pair} on ${result.chain} - ${result.reason}`);
                }
            });

            await validatorAgent!.start();
            logSuccess('Validator Agent started');

            logSection(`Running for ${TEST_DURATION_MS / 1000} seconds...`);
            await sleep(TEST_DURATION_MS);

            logKeyValue('Alerts detected', alerts.length);

            return { alertCount: alerts.length, alerts };
        });

        // =========================================================================
        // Test 8: Cross-Chain Price Comparison
        // =========================================================================
        await runner.runTest('Cross-Chain Price Comparison', async () => {
            const provider = new ethers.JsonRpcProvider(config.ethereum.rpcUrl);
            const baseProvider = new ethers.JsonRpcProvider(config.base.rpcUrl);
            const arbProvider = new ethers.JsonRpcProvider(config.arbitrum.rpcUrl);

            const prices: Record<string, number> = {};

            // Fetch ETH/USD from all chains
            try {
                const ethFeed = new ethers.Contract(CHAINLINK_FEEDS.ethereum['ETH/USD'], CHAINLINK_ABI, provider);
                const [, answer] = await ethFeed.latestRoundData();
                const decimals = await ethFeed.decimals();
                prices['ethereum'] = Number(answer) / Math.pow(10, Number(decimals));
            } catch (e) {
                logWarning('Failed to fetch Ethereum price');
            }

            try {
                const baseFeed = new ethers.Contract(CHAINLINK_FEEDS.base['ETH/USD'], CHAINLINK_ABI, baseProvider);
                const [, answer] = await baseFeed.latestRoundData();
                const decimals = await baseFeed.decimals();
                prices['base'] = Number(answer) / Math.pow(10, Number(decimals));
            } catch (e) {
                logWarning('Failed to fetch Base price');
            }

            try {
                const arbFeed = new ethers.Contract(CHAINLINK_FEEDS.arbitrum['ETH/USD'], CHAINLINK_ABI, arbProvider);
                const [, answer] = await arbFeed.latestRoundData();
                const decimals = await arbFeed.decimals();
                prices['arbitrum'] = Number(answer) / Math.pow(10, Number(decimals));
            } catch (e) {
                logWarning('Failed to fetch Arbitrum price');
            }

            logSection('Cross-Chain ETH/USD Prices');
            for (const [chain, price] of Object.entries(prices)) {
                logKeyValue(chain, `$${price.toFixed(2)}`);
            }

            // Calculate max deviation
            const priceValues = Object.values(prices);
            if (priceValues.length >= 2) {
                const maxPrice = Math.max(...priceValues);
                const minPrice = Math.min(...priceValues);
                const deviation = ((maxPrice - minPrice) / minPrice) * 100;
                logKeyValue('Max Deviation', `${deviation.toFixed(4)}%`);

                return { prices, deviation };
            }

            return { prices, deviation: 0 };
        });

        // =========================================================================
        // Test 9: Verify Yellow Messages
        // =========================================================================
        await runner.runTest('Verify Yellow Message Bus Activity', async () => {
            assertDefined(yellowMessageBus, 'Yellow Message Bus');

            const summary = yellowMessageBus!.getSummary();

            logSection('Yellow Network Summary');
            logKeyValue('Alerts Published', summary.alertCount);
            logKeyValue('Total Messages', summary.totalMessages);
            logKeyValue('Micro-Fees Accrued', `${summary.microFeesAccrued} ytest.usd`);

            return summary;
        });

    } catch (error) {
        console.error('\n❌ Test suite failed:', error);
    } finally {
        // Cleanup
        logSection('Cleanup');

        if (validatorAgent !== null) {
            await (validatorAgent as ValidatorAgent).stop();
            logSuccess('Validator Agent stopped');
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
runValidatorE2ETest().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
