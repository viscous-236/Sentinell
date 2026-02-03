/**
 * Yellow Network Test Helper
 * 
 * Helper utilities for setting up and tearing down Yellow Network 
 * connections in E2E tests.
 */

import { YellowMessageBus } from '../../src/shared/yellow/YellowMessageBus';
import { YellowConfig } from '../../src/shared/yellow/types';
import { loadTestConfig, logSuccess, logError } from './test-utils';

export interface YellowTestContext {
    messageBus: YellowMessageBus;
    config: YellowConfig;
}

/**
 * Initialize Yellow Message Bus for testing.
 * Allocates a small amount for test operations.
 */
export async function initializeYellowForTest(
    testAmount: string = '5'
): Promise<YellowTestContext> {
    const testConfig = loadTestConfig();

    const config: YellowConfig = {
        endPoint: testConfig.yellow.endpoint,
        agentAddress: testConfig.yellow.agentAddress,
        privateKey: testConfig.yellow.privateKey as `0x${string}`,
        rpcUrl: testConfig.ethereum.rpcUrl,
        network: 'sandbox',
    };

    console.log('   🟡 Initializing Yellow Message Bus...');
    console.log(`      Endpoint: ${config.endPoint}`);
    console.log(`      Agent: ${config.agentAddress}`);

    const messageBus = new YellowMessageBus(config);

    try {
        await messageBus.initialize(testAmount);
        logSuccess(`Yellow Message Bus ready (${testAmount} ytest.usd allocated)`);
    } catch (error) {
        logError(`Yellow initialization failed: ${(error as Error).message}`);
        throw error;
    }

    return { messageBus, config };
}

/**
 * Shutdown Yellow Message Bus and settle session.
 */
export async function shutdownYellow(context: YellowTestContext): Promise<void> {
    console.log('   🟡 Shutting down Yellow session...');

    try {
        await context.messageBus.shutdown();
        logSuccess('Yellow session settled');
    } catch (error) {
        logError(`Yellow shutdown failed: ${(error as Error).message}`);
        // Don't throw - we still want tests to complete
    }
}

/**
 * Get Yellow Message Bus summary for test assertions.
 */
export function getYellowSummary(context: YellowTestContext): {
    signalCount: number;
    alertCount: number;
    decisionCount: number;
    executionCount: number;
    totalMessages: number;
    microFeesAccrued: string;
} {
    return context.messageBus.getSummary();
}

/**
 * Wait for Yellow messages to be processed.
 */
export async function waitForYellowMessages(
    context: YellowTestContext,
    expectedCount: number,
    timeoutMs: number = 10000
): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const summary = getYellowSummary(context);
        if (summary.totalMessages >= expectedCount) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
}

/**
 * Create a mock Yellow context for tests that don't need real Yellow.
 */
export function createMockYellowContext(): YellowTestContext {
    const testConfig = loadTestConfig();

    return {
        messageBus: {
            publishSignal: async () => { },
            publishAlert: async () => { },
            publishDecision: async () => { },
            publishExecution: async () => { },
            getSummary: () => ({
                signalCount: 0,
                alertCount: 0,
                decisionCount: 0,
                executionCount: 0,
                totalMessages: 0,
                microFeesAccrued: '0',
            }),
            shutdown: async () => { },
        } as unknown as YellowMessageBus,
        config: {
            endPoint: testConfig.yellow.endpoint,
            agentAddress: testConfig.yellow.agentAddress,
            privateKey: testConfig.yellow.privateKey as `0x${string}`,
            rpcUrl: testConfig.ethereum.rpcUrl,
            network: 'sandbox',
        },
    };
}
