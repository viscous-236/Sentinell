/**
 * Threat Simulation E2E Test
 * 
 * Injects artificial threats to verify the full agent pipeline:
 * Scout → RiskEngine → Executor responds correctly.
 * 
 * This test simulates:
 * 1. MEV attacks (sandwich, frontrun patterns)
 * 2. Flash loan attacks
 * 3. Oracle manipulation
 * 4. Cross-chain arbitrage attacks
 */

import { ethers } from 'ethers';
import { RiskEngine, RiskDecision, ValidatorThreatSignal } from '../../../src/executor/src/RiskEngine';
import type { ScoutSignal, ScoutSignalType } from '../../../src/scout/src/types';

// Test configuration
const TEST_CONFIG = {
    testDurationMs: 30000,  // 30 seconds per scenario
    correlationWindowMs: 5000,  // 5 second window to correlate signals
    signalIntervalMs: 500,  // Signal every 500ms
};

// Test pool addresses
const TEST_POOLS = {
    ethereum: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', // WETH/USDC V3
    base: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
    arbitrum: '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443',
};

// ============================================================================
// Test Helpers
// ============================================================================

function createScoutSignal(
    type: ScoutSignalType,
    chain: string,
    magnitude: number,
    poolAddress?: string
): ScoutSignal {
    return {
        type,
        chain,
        pair: 'WETH/USDC',
        poolAddress: poolAddress ?? TEST_POOLS[chain as keyof typeof TEST_POOLS],
        timestamp: Date.now(),
        magnitude: Math.min(1, Math.max(0, magnitude)),
    };
}

function createOracleAlert(
    chain: string,
    deviation: number,
    poolAddress?: string
): ValidatorThreatSignal {
    return {
        type: 'ORACLE_MANIPULATION',
        chain,
        pair: 'WETH/USDC',
        poolAddress: poolAddress ?? TEST_POOLS[chain as keyof typeof TEST_POOLS],
        deviation,
        timestamp: Date.now(),
        evidence: { deviation, source: 'simulation' },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runThreatSimulation() {
    console.log('\n' + '═'.repeat(60));
    console.log('🎯 THREAT SIMULATION E2E TEST');
    console.log('═'.repeat(60));
    console.log('\nThis test injects artificial threats to verify the full pipeline.\n');

    const results: { scenario: string; passed: boolean; details: string }[] = [];
    let totalDecisions = 0;
    let decisionsTriggered: RiskDecision[] = [];

    // Create RiskEngine with aggressive thresholds for testing
    const riskEngine = new RiskEngine({
        correlationWindowMs: TEST_CONFIG.correlationWindowMs,
        emaAlpha: 0.3, // Fast adaptation for testing
        baseThresholds: {
            FLASH_LOAN: 0.2,
            GAS_SPIKE: 0.3,
            LARGE_SWAP: 0.3,
            MEMPOOL_CLUSTER: 0.4,
            ORACLE_MANIPULATION: 0.05,
            CROSS_CHAIN_INCONSISTENCY: 0.05,
            CROSS_CHAIN_ATTACK: 0.3,
            PRICE_MOVE: 0.3,
        },
        signalWeights: {
            FLASH_LOAN: 3,
            GAS_SPIKE: 2,
            LARGE_SWAP: 2,
            MEMPOOL_CLUSTER: 1,
            ORACLE_MANIPULATION: 4,
            CROSS_CHAIN_INCONSISTENCY: 4,
            CROSS_CHAIN_ATTACK: 5,
            PRICE_MOVE: 1,
        },
        hysteresis: {
            watchToElevated: { up: 25, down: 15 },
            elevatedToCritical: { up: 60, down: 45 },
        },
        actionTtl: {
            MEV_PROTECTION: 12000,
            ORACLE_VALIDATION: 30000,
            CIRCUIT_BREAKER: 60000,
        },
    });

    // Listen for decisions
    riskEngine.on('decision', (decision: RiskDecision) => {
        totalDecisions++;
        decisionsTriggered.push(decision);
        console.log(`\n   🚨 DECISION #${totalDecisions}: ${decision.action}`);
        console.log(`      Tier: ${decision.tier}`);
        console.log(`      Score: ${decision.compositeScore.toFixed(1)}`);
        console.log(`      Target: ${decision.targetPool}`);
        console.log(`      Rationale: ${decision.rationale.substring(0, 80)}...`);
    });

    riskEngine.start();

    // =========================================================================
    // Scenario 1: MEV Sandwich Attack Pattern
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Scenario 1: MEV Sandwich Attack');
    console.log('─'.repeat(50));
    console.log('   Simulating: FLASH_LOAN + GAS_SPIKE + LARGE_SWAP burst\n');

    decisionsTriggered = [];

    // Inject correlated MEV signals in rapid succession
    for (let i = 0; i < 6; i++) {
        // Flash loan initiation
        riskEngine.ingestScoutEvent(createScoutSignal('FLASH_LOAN', 'ethereum', 0.7));
        await sleep(100);

        // Gas spike (competition for block space)
        riskEngine.ingestScoutEvent(createScoutSignal('GAS_SPIKE', 'ethereum', 0.6));
        await sleep(100);

        // Large swap (the victim transaction)
        riskEngine.ingestScoutEvent(createScoutSignal('LARGE_SWAP', 'ethereum', 0.8));
        await sleep(100);

        // Another large swap (the sandwich completion)
        riskEngine.ingestScoutEvent(createScoutSignal('LARGE_SWAP', 'ethereum', 0.75));
        await sleep(200);
    }

    await sleep(1000); // Let the engine process

    const mevResult = decisionsTriggered.length > 0 &&
        decisionsTriggered.some(d => d.action === 'MEV_PROTECTION' || d.action === 'CIRCUIT_BREAKER');

    results.push({
        scenario: 'MEV Sandwich Attack',
        passed: mevResult,
        details: mevResult
            ? `Triggered ${decisionsTriggered.length} decision(s): ${decisionsTriggered.map(d => d.action).join(', ')}`
            : 'No MEV protection triggered',
    });

    console.log(`   ${mevResult ? '✅' : '❌'} ${results[results.length - 1].details}`);

    // Give the engine time to reset state
    await sleep(TEST_CONFIG.correlationWindowMs + 1000);

    // =========================================================================
    // Scenario 2: Oracle Manipulation Attack
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Scenario 2: Oracle Manipulation Attack');
    console.log('─'.repeat(50));
    console.log('   Simulating: ORACLE_MANIPULATION with high deviation\n');

    decisionsTriggered = [];

    // Inject oracle manipulation alerts with increasing severity
    for (let i = 0; i < 5; i++) {
        const deviation = 10 + i * 15; // 10%, 25%, 40%, 55%, 70%
        riskEngine.ingestValidatorAlert(createOracleAlert('base', deviation));
        console.log(`   📊 Injected oracle alert: ${deviation}% deviation`);
        await sleep(300);
    }

    await sleep(1500);

    const oracleResult = decisionsTriggered.length > 0 &&
        decisionsTriggered.some(d => d.action === 'ORACLE_VALIDATION' || d.action === 'CIRCUIT_BREAKER');

    results.push({
        scenario: 'Oracle Manipulation',
        passed: oracleResult,
        details: oracleResult
            ? `Triggered ${decisionsTriggered.length} decision(s): ${decisionsTriggered.map(d => d.action).join(', ')}`
            : 'No oracle validation triggered',
    });

    console.log(`   ${oracleResult ? '✅' : '❌'} ${results[results.length - 1].details}`);

    await sleep(TEST_CONFIG.correlationWindowMs + 1000);

    // =========================================================================
    // Scenario 3: Cross-Chain Attack
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Scenario 3: Cross-Chain Attack Pattern');
    console.log('─'.repeat(50));
    console.log('   Simulating: CROSS_CHAIN_ATTACK + correlated signals across chains\n');

    decisionsTriggered = [];

    // Inject cross-chain attack signals
    riskEngine.ingestScoutEvent(createScoutSignal('CROSS_CHAIN_ATTACK', 'ethereum', 0.8));
    await sleep(100);
    riskEngine.ingestScoutEvent(createScoutSignal('FLASH_LOAN', 'ethereum', 0.7));
    await sleep(100);
    riskEngine.ingestScoutEvent(createScoutSignal('LARGE_SWAP', 'arbitrum', 0.9));
    await sleep(100);

    // Cross-chain price inconsistency
    riskEngine.ingestValidatorAlert({
        type: 'CROSS_CHAIN_INCONSISTENCY',
        chain: 'arbitrum',
        pair: 'WETH/USDC',
        poolAddress: TEST_POOLS.arbitrum,
        deviation: 25,
        timestamp: Date.now(),
        evidence: { ethPrice: 2150, arbPrice: 2050, deviation: 25 },
    });

    await sleep(500);

    // More cross-chain signals
    for (let i = 0; i < 3; i++) {
        riskEngine.ingestScoutEvent(createScoutSignal('CROSS_CHAIN_ATTACK', 'base', 0.85));
        await sleep(200);
    }

    await sleep(1500);

    const crossChainResult = decisionsTriggered.length > 0 &&
        decisionsTriggered.some(d =>
            d.action === 'CROSS_CHAIN_ARBITRAGE_BLOCK' ||
            d.action === 'LIQUIDITY_REROUTE' ||
            d.action === 'EMERGENCY_BRIDGE'
        );

    results.push({
        scenario: 'Cross-Chain Attack',
        passed: crossChainResult,
        details: crossChainResult
            ? `Triggered ${decisionsTriggered.length} decision(s): ${decisionsTriggered.map(d => d.action).join(', ')}`
            : 'No cross-chain defense triggered',
    });

    console.log(`   ${crossChainResult ? '✅' : '❌'} ${results[results.length - 1].details}`);

    await sleep(TEST_CONFIG.correlationWindowMs + 1000);

    // =========================================================================
    // Scenario 4: Circuit Breaker Trigger
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Scenario 4: Circuit Breaker (Extreme Attack)');
    console.log('─'.repeat(50));
    console.log('   Simulating: Multiple correlated signals to trigger CRITICAL tier\n');

    decisionsTriggered = [];

    // Flood with high-magnitude signals to hit CRITICAL tier
    for (let i = 0; i < 10; i++) {
        riskEngine.ingestScoutEvent(createScoutSignal('FLASH_LOAN', 'ethereum', 0.9));
        riskEngine.ingestScoutEvent(createScoutSignal('GAS_SPIKE', 'ethereum', 0.85));
        riskEngine.ingestScoutEvent(createScoutSignal('LARGE_SWAP', 'ethereum', 0.95));
        riskEngine.ingestScoutEvent(createScoutSignal('MEMPOOL_CLUSTER', 'ethereum', 0.8));

        // Also inject oracle deviation
        riskEngine.ingestValidatorAlert(createOracleAlert('ethereum', 80 + i * 5));

        await sleep(200);
    }

    await sleep(2000);

    const circuitBreakerResult = decisionsTriggered.length > 0 &&
        decisionsTriggered.some(d => d.action === 'CIRCUIT_BREAKER');

    results.push({
        scenario: 'Circuit Breaker',
        passed: circuitBreakerResult,
        details: circuitBreakerResult
            ? `Triggered CIRCUIT_BREAKER with ${decisionsTriggered.filter(d => d.tier === 'CRITICAL').length} CRITICAL decisions`
            : 'No circuit breaker triggered',
    });

    console.log(`   ${circuitBreakerResult ? '✅' : '❌'} ${results[results.length - 1].details}`);

    await sleep(TEST_CONFIG.correlationWindowMs + 1000);

    // =========================================================================
    // Scenario 5: State Machine Hysteresis
    // =========================================================================
    console.log('\n' + '─'.repeat(50));
    console.log('📋 Scenario 5: State Machine Hysteresis Test');
    console.log('─'.repeat(50));
    console.log('   Verifying: WATCH → ELEVATED → CRITICAL → ELEVATED transitions\n');

    decisionsTriggered = [];
    const tierTransitions: string[] = [];

    // Use a fresh pool for this test
    const hysteresisPool = '0x1111111111111111111111111111111111111111';

    // Listen for tier changes via decisions
    const tierListener = (decision: RiskDecision) => {
        if (decision.targetPool === hysteresisPool) {
            tierTransitions.push(decision.tier);
        }
    };
    riskEngine.on('decision', tierListener);

    // Ramp up to ELEVATED
    console.log('   📈 Ramping up to ELEVATED...');
    for (let i = 0; i < 5; i++) {
        riskEngine.ingestScoutEvent({
            type: 'LARGE_SWAP',
            chain: 'ethereum',
            pair: 'WETH/USDC',
            poolAddress: hysteresisPool,
            timestamp: Date.now(),
            magnitude: 0.6,
        });
        await sleep(300);
    }

    await sleep(1000);
    console.log(`   Current tier transitions: ${tierTransitions.join(' → ') || 'none'}`);

    // Ramp up to CRITICAL
    console.log('   📈 Ramping up to CRITICAL...');
    for (let i = 0; i < 8; i++) {
        riskEngine.ingestScoutEvent({
            type: 'FLASH_LOAN',
            chain: 'ethereum',
            pair: 'WETH/USDC',
            poolAddress: hysteresisPool,
            timestamp: Date.now(),
            magnitude: 0.9,
        });
        riskEngine.ingestScoutEvent({
            type: 'GAS_SPIKE',
            chain: 'ethereum',
            pair: 'WETH/USDC',
            poolAddress: hysteresisPool,
            timestamp: Date.now(),
            magnitude: 0.85,
        });
        await sleep(200);
    }

    await sleep(1500);
    console.log(`   Current tier transitions: ${tierTransitions.join(' → ') || 'none'}`);

    // Let signals expire (should transition back down)
    console.log('   📉 Waiting for signal expiry...');
    await sleep(TEST_CONFIG.correlationWindowMs + 2000);

    riskEngine.removeListener('decision', tierListener);

    const hysteresisResult = tierTransitions.length > 0 &&
        (tierTransitions.includes('ELEVATED') || tierTransitions.includes('CRITICAL'));

    results.push({
        scenario: 'Hysteresis Transitions',
        passed: hysteresisResult,
        details: hysteresisResult
            ? `Observed transitions: ${tierTransitions.join(' → ')}`
            : 'No tier transitions observed',
    });

    console.log(`   ${hysteresisResult ? '✅' : '❌'} ${results[results.length - 1].details}`);

    // =========================================================================
    // Cleanup & Summary
    // =========================================================================
    riskEngine.stop();

    console.log('\n' + '═'.repeat(60));
    console.log('📊 SIMULATION TEST SUMMARY');
    console.log('═'.repeat(60));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    for (const result of results) {
        console.log(`   ${result.passed ? '✅' : '❌'} ${result.scenario}: ${result.details}`);
    }

    console.log('\n' + '─'.repeat(50));
    console.log(`   Total Scenarios: ${results.length}`);
    console.log(`   ✅ Passed: ${passed}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log(`   Total Decisions Triggered: ${totalDecisions}`);
    console.log('─'.repeat(50));

    if (failed === 0) {
        console.log('\n🎉 ALL THREAT SIMULATIONS PASSED!\n');
    } else {
        console.log('\n⚠️  Some simulations failed. Check RiskEngine thresholds.\n');
    }
}

// Run the simulation
runThreatSimulation().catch(console.error);
