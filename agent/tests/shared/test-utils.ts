/**
 * Shared Test Utilities for E2E Tests
 * 
 * Common helpers for all Sentinel agent E2E tests.
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface TestConfig {
    ethereum: {
        rpcUrl: string;
        chainId: number;
    };
    base: {
        rpcUrl: string;
        chainId: number;
    };
    arbitrum: {
        rpcUrl: string;
        chainId: number;
    };
    yellow: {
        endpoint: string;
        privateKey: string;
        agentAddress: string;
    };
    timeouts: {
        short: number;
        medium: number;
        long: number;
    };
}

export function loadTestConfig(): TestConfig {
    const privateKey = process.env.YELLOW_PRIVATE_KEY || process.env.PRIVATE_KEY;

    if (!privateKey) {
        throw new Error('YELLOW_PRIVATE_KEY or PRIVATE_KEY environment variable required');
    }

    // Derive agent address from private key
    const wallet = new ethers.Wallet(privateKey);

    return {
        ethereum: {
            rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo',
            chainId: 1,
        },
        base: {
            rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
            chainId: 8453,
        },
        arbitrum: {
            rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
            chainId: 42161,
        },
        yellow: {
            endpoint: process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws',
            privateKey: privateKey,
            agentAddress: wallet.address,
        },
        timeouts: {
            short: 10_000,   // 10 seconds
            medium: 30_000,  // 30 seconds
            long: 90_000,    // 90 seconds
        },
    };
}

// =============================================================================
// PROVIDERS
// =============================================================================

export function createProviders(config: TestConfig): Map<string, ethers.JsonRpcProvider> {
    const providers = new Map<string, ethers.JsonRpcProvider>();

    providers.set('ethereum', new ethers.JsonRpcProvider(config.ethereum.rpcUrl));
    providers.set('base', new ethers.JsonRpcProvider(config.base.rpcUrl));
    providers.set('arbitrum', new ethers.JsonRpcProvider(config.arbitrum.rpcUrl));

    return providers;
}

// =============================================================================
// TEST HELPERS
// =============================================================================

export interface TestResult {
    name: string;
    passed: boolean;
    duration: number;
    details?: any;
    error?: string;
}

export class TestRunner {
    private results: TestResult[] = [];
    private startTime: number = 0;

    constructor(private suiteName: string) { }

    start(): void {
        this.startTime = Date.now();
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`🧪 ${this.suiteName}`);
        console.log(`${'═'.repeat(60)}\n`);
    }

    async runTest(name: string, testFn: () => Promise<any>): Promise<TestResult> {
        const testStart = Date.now();
        console.log(`📋 Running: ${name}...`);

        try {
            const details = await testFn();
            const duration = Date.now() - testStart;
            const result: TestResult = { name, passed: true, duration, details };
            this.results.push(result);
            console.log(`   ✅ Passed (${duration}ms)\n`);
            return result;
        } catch (error) {
            const duration = Date.now() - testStart;
            const result: TestResult = {
                name,
                passed: false,
                duration,
                error: (error as Error).message
            };
            this.results.push(result);
            console.log(`   ❌ Failed: ${(error as Error).message}\n`);
            return result;
        }
    }

    printSummary(): void {
        const totalDuration = Date.now() - this.startTime;
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`📊 TEST SUMMARY: ${this.suiteName}`);
        console.log(`${'═'.repeat(60)}\n`);
        console.log(`   Total Tests: ${this.results.length}`);
        console.log(`   ✅ Passed: ${passed}`);
        console.log(`   ❌ Failed: ${failed}`);
        console.log(`   ⏱️  Duration: ${(totalDuration / 1000).toFixed(1)}s\n`);

        if (failed > 0) {
            console.log('   Failed Tests:');
            this.results
                .filter(r => !r.passed)
                .forEach(r => console.log(`     - ${r.name}: ${r.error}`));
            console.log('');
        }

        console.log(`${'═'.repeat(60)}\n`);
    }

    getResults(): TestResult[] {
        return this.results;
    }

    allPassed(): boolean {
        return this.results.every(r => r.passed);
    }
}

// =============================================================================
// TIMING HELPERS
// =============================================================================

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string = 'Operation timed out'
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId!);
        return result;
    } catch (error) {
        clearTimeout(timeoutId!);
        throw error;
    }
}

// =============================================================================
// ASSERTION HELPERS
// =============================================================================

export function assertDefined<T>(value: T | undefined | null, name: string): T {
    if (value === undefined || value === null) {
        throw new Error(`Expected ${name} to be defined`);
    }
    return value;
}

export function assertGreaterThan(actual: number, expected: number, name: string): void {
    if (actual <= expected) {
        throw new Error(`Expected ${name} (${actual}) to be greater than ${expected}`);
    }
}

export function assertArrayNotEmpty<T>(arr: T[], name: string): void {
    if (!arr || arr.length === 0) {
        throw new Error(`Expected ${name} to not be empty`);
    }
}

// =============================================================================
// LOGGING HELPERS
// =============================================================================

export function logSection(title: string): void {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${title}`);
    console.log(`${'─'.repeat(50)}\n`);
}

export function logKeyValue(key: string, value: any): void {
    console.log(`   ${key}: ${JSON.stringify(value)}`);
}

export function logSuccess(message: string): void {
    console.log(`   ✅ ${message}`);
}

export function logWarning(message: string): void {
    console.log(`   ⚠️  ${message}`);
}

export function logError(message: string): void {
    console.log(`   ❌ ${message}`);
}

export function logInfo(message: string): void {
    console.log(`   ℹ️  ${message}`);
}
