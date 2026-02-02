/**
 * Yellow Agent Adapters - Wire Sentinel Agents to Yellow Message Bus
 * 
 * Per PROJECT_SPEC.md Section 4.5:
 * "Agents communicate via Yellow state channels"
 * 
 * These adapters transform local EventEmitter-based agents to use
 * Yellow Message Bus for inter-agent communication.
 * 
 * Communication Flow:
 *   Scout Agent → ScoutYellowAdapter.publishSignal() → YellowMessageBus → Yellow Session
 *                                                                              ↓
 *   RiskEngine ← RiskEngineYellowAdapter.subscribeToSignals() ← YellowMessageBus
 *                                                                              ↓
 *   RiskEngine → RiskEngineYellowAdapter.publishDecision() → YellowMessageBus → Yellow Session
 *                                                                              ↓
 *   Executor ← ExecutorYellowAdapter.subscribeToDecisions() ← YellowMessageBus
 */

import { EventEmitter } from 'events';
import {
    YellowMessageBus,
    ScoutSignalMessage,
    ScoutPriceMessage,
    ValidatorAlertMessage,
    RiskDecisionMessage
} from './YellowMessageBus';

/**
 * Adapts Scout Agent to publish signals via Yellow
 * 
 * Instead of: scout.emit('signal', data) → local listener
 * Now: scout.emit('signal', data) → YellowMessageBus.publishSignal() → Yellow Session → subscribers
 */
export class ScoutYellowAdapter {
    private messageBus: YellowMessageBus;
    private scout: EventEmitter;
    private magnitudeThreshold: number;
    private rateLimit: {
        maxPerMinute: number;
        count: number;
        lastReset: number;
    };

    constructor(
        messageBus: YellowMessageBus,
        scout: EventEmitter,
        options?: {
            magnitudeThreshold?: number;
            maxSignalsPerMinute?: number;
        }
    ) {
        this.messageBus = messageBus;
        this.scout = scout;
        this.magnitudeThreshold = options?.magnitudeThreshold ?? 0.3;
        this.rateLimit = {
            maxPerMinute: options?.maxSignalsPerMinute ?? 30,
            count: 0,
            lastReset: Date.now(),
        };

        this.wireScout();
    }

    private wireScout(): void {
        this.scout.on('signal', async (signal: any) => {
            // Rate limiting
            const now = Date.now();
            if (now - this.rateLimit.lastReset > 60000) {
                this.rateLimit.count = 0;
                this.rateLimit.lastReset = now;
            }

            if (this.rateLimit.count >= this.rateLimit.maxPerMinute) {
                return; // Rate limited
            }

            // Magnitude filter
            if (signal.magnitude < this.magnitudeThreshold) {
                return; // Below threshold
            }

            this.rateLimit.count++;

            try {
                await this.messageBus.publishSignal({
                    type: signal.type,
                    magnitude: signal.magnitude,
                    chain: signal.chain,
                    pair: signal.pair,
                    poolAddress: signal.poolAddress,
                    txHash: signal.txHash,
                    gasPrice: signal.gasPrice,
                });
            } catch (error) {
                console.error('❌ ScoutYellowAdapter: Failed to publish signal:', error);
            }
        });

        // Wire price events to Yellow for Validator consumption
        this.scout.on('price', async (price: any) => {
            try {
                await this.messageBus.publishPrice({
                    pair: price.pair,
                    chain: price.chain,
                    price: price.price,
                    source: price.dex || 'unknown',
                    poolAddress: price.poolAddress,
                });
            } catch (error) {
                console.error('❌ ScoutYellowAdapter: Failed to publish price:', error);
            }
        });

        console.log('🔗 ScoutYellowAdapter: Scout wired to Yellow Message Bus');
        console.log('   - Signals → Yellow (for RiskEngine)');
        console.log('   - Prices → Yellow (for Validator)');
    }
}

/**
 * Adapts Validator Agent to:
 * 1. Subscribe to prices FROM Yellow (from Scout)
 * 2. Publish alerts TO Yellow (for RiskEngine)
 * 
 * Per PROJECT_SPEC.md: Validator validates Scout prices against oracles
 */
export class ValidatorYellowAdapter {
    private messageBus: YellowMessageBus;
    private validator: EventEmitter;

    constructor(messageBus: YellowMessageBus, validator: EventEmitter) {
        this.messageBus = messageBus;
        this.validator = validator;

        this.wireValidator();
    }

    private wireValidator(): void {
        // Subscribe to prices FROM Yellow (Scout publishes these)
        // Convert to 'price:update' events that Validator expects
        this.messageBus.subscribeToPrices((prices) => {
            for (const priceMsg of prices) {
                // Convert Yellow message to Validator's expected format (ScoutPriceData)
                const priceData = {
                    pair: priceMsg.payload.pair,
                    chain: priceMsg.payload.chain,
                    price: priceMsg.payload.price,
                    timestamp: priceMsg.timestamp,
                    source: priceMsg.payload.source,
                    poolAddress: priceMsg.payload.poolAddress,
                };

                // Emit to Validator's internal processing
                this.validator.emit('price:update', priceData);
            }
        });

        // When Validator detects threats, publish TO Yellow
        this.validator.on('threat:alert', async (alert: any) => {
            try {
                await this.messageBus.publishAlert({
                    type: alert.type,
                    severity: alert.severity,
                    chain: alert.chain,
                    targetPool: alert.targetPool,
                    deviation: alert.evidence?.deviation,
                    evidence: alert.evidence,
                });
            } catch (error) {
                console.error('❌ ValidatorYellowAdapter: Failed to publish alert:', error);
            }
        });

        // Also handle threat:aggregation events (from ThreatAggregator)
        this.validator.on('threat:aggregation', async (data: { alert: any; aggregation: any }) => {
            try {
                await this.messageBus.publishAlert({
                    type: data.alert.type,
                    severity: data.alert.severity,
                    chain: data.alert.chain,
                    targetPool: data.alert.targetPool,
                    deviation: data.alert.evidence?.deviation,
                    evidence: {
                        ...data.alert.evidence,
                        aggregation: data.aggregation,
                    },
                });
            } catch (error) {
                console.error('❌ ValidatorYellowAdapter: Failed to publish aggregated alert:', error);
            }
        });

        console.log('🔗 ValidatorYellowAdapter: Validator wired to Yellow Message Bus');
        console.log('   - Receiving prices FROM Yellow (Scout data)');
        console.log('   - Publishing alerts TO Yellow (for RiskEngine)');
    }
}

/**
 * Adapts Risk Engine to:
 * 1. Subscribe to signals and alerts FROM Yellow (instead of local events)
 * 2. Publish decisions TO Yellow (for Executor to consume)
 * 
 * Per PROJECT_SPEC.md Section 4.3:
 * "Risk Engine correlates Scout + Validator signals"
 * "Risk Engine outputs a single RiskDecision per pool when action is required"
 */
export class RiskEngineYellowAdapter {
    private messageBus: YellowMessageBus;
    private riskEngine: EventEmitter;

    // Internal correlation buffer
    private signalBuffer: ScoutSignalMessage[] = [];
    private alertBuffer: ValidatorAlertMessage[] = [];

    constructor(messageBus: YellowMessageBus, riskEngine: EventEmitter) {
        this.messageBus = messageBus;
        this.riskEngine = riskEngine;

        this.wireRiskEngine();
    }

    private wireRiskEngine(): void {
        // Subscribe to signals FROM Yellow (not local events)
        this.messageBus.subscribeToSignals((signals) => {
            for (const signal of signals) {
                // Convert Yellow message to RiskEngine signal format
                const riskSignal = {
                    type: signal.payload.signalType,
                    magnitude: signal.payload.magnitude,
                    chain: signal.payload.chain,
                    pair: signal.payload.pair,
                    poolAddress: signal.payload.poolAddress,
                    timestamp: signal.timestamp,
                };

                // Emit to RiskEngine's internal processing
                this.riskEngine.emit('yellow:signal', riskSignal);
            }
        });

        // Subscribe to alerts FROM Yellow
        this.messageBus.subscribeToAlerts((alerts) => {
            for (const alert of alerts) {
                // Convert Yellow message to RiskEngine alert format
                const riskAlert = {
                    id: alert.id,
                    type: alert.payload.alertType,
                    severity: alert.payload.severity,
                    chain: alert.payload.chain,
                    targetPool: alert.payload.targetPool,
                    evidence: alert.payload.evidence,
                    detectedAt: alert.timestamp,
                };

                // Emit to RiskEngine's internal processing
                this.riskEngine.emit('yellow:alert', riskAlert);
            }
        });

        // When RiskEngine makes a decision, publish it TO Yellow
        this.riskEngine.on('decision', async (decision: any) => {
            try {
                await this.messageBus.publishDecision({
                    id: decision.id,
                    action: decision.action,
                    tier: decision.tier,
                    compositeScore: decision.compositeScore,
                    targetPool: decision.targetPool,
                    chain: decision.chain,
                    rationale: decision.rationale,
                    ttlMs: decision.ttlMs,
                    contributingSignals: decision.contributingSignals || [],
                });
            } catch (error) {
                console.error('❌ RiskEngineYellowAdapter: Failed to publish decision:', error);
            }
        });

        console.log('🔗 RiskEngineYellowAdapter: RiskEngine wired to Yellow Message Bus');
        console.log('   - Receiving signals FROM Yellow (not local events)');
        console.log('   - Receiving alerts FROM Yellow (not local events)');
        console.log('   - Publishing decisions TO Yellow (for Executor)');
    }
}

/**
 * Adapts Executor Agent to:
 * 1. Subscribe to decisions FROM Yellow (not local events)
 * 2. Publish execution results TO Yellow
 * 
 * Per PROJECT_SPEC.md Section 4.1:
 * "Executor Agent: Listens only to Risk Engine decisions"
 */
export class ExecutorYellowAdapter {
    private messageBus: YellowMessageBus;
    private executor: EventEmitter;

    constructor(messageBus: YellowMessageBus, executor: EventEmitter) {
        this.messageBus = messageBus;
        this.executor = executor;

        this.wireExecutor();
    }

    private wireExecutor(): void {
        // Subscribe to decisions FROM Yellow (not local events)
        this.messageBus.subscribeToDecisions((decisions) => {
            for (const decision of decisions) {
                // Only process actionable decisions
                if (decision.payload.action === 'NO_ACTION') {
                    continue;
                }

                // Check TTL
                const now = Date.now();
                const expiresAt = decision.timestamp + decision.payload.ttlMs;
                if (now > expiresAt) {
                    console.log(`⏰ Decision ${decision.id} expired, skipping`);
                    continue;
                }

                // Convert Yellow message to Executor decision format
                const execDecision = {
                    id: decision.id,
                    action: decision.payload.action,
                    tier: decision.payload.tier,
                    compositeScore: decision.payload.compositeScore,
                    targetPool: decision.payload.targetPool,
                    chain: decision.payload.chain,
                    rationale: decision.payload.rationale,
                    ttlMs: decision.payload.ttlMs,
                    timestamp: decision.timestamp,
                    contributingSignals: decision.payload.contributingSignals,
                };

                // Emit to Executor's internal processing
                this.executor.emit('yellow:decision', execDecision);
            }
        });

        // When Executor completes, publish result TO Yellow
        this.executor.on('execution:success', async (event: { decision: any; txHash: string }) => {
            try {
                await this.messageBus.publishExecution({
                    decisionId: event.decision.id,
                    hookType: event.decision.action,
                    txHash: event.txHash,
                    chain: event.decision.chain,
                    success: true,
                    gasUsed: event.decision.gasUsed,
                });
            } catch (error) {
                console.error('❌ ExecutorYellowAdapter: Failed to publish execution:', error);
            }
        });

        this.executor.on('execution:failure', async (event: { decision: any; error: string }) => {
            try {
                await this.messageBus.publishExecution({
                    decisionId: event.decision.id,
                    hookType: event.decision.action,
                    txHash: '',
                    chain: event.decision.chain,
                    success: false,
                    error: event.error,
                });
            } catch (error) {
                console.error('❌ ExecutorYellowAdapter: Failed to publish execution failure:', error);
            }
        });

        console.log('🔗 ExecutorYellowAdapter: Executor wired to Yellow Message Bus');
        console.log('   - Receiving decisions FROM Yellow (not local events)');
        console.log('   - Publishing execution results TO Yellow');
    }
}

/**
 * Factory function to wire all agents to Yellow Message Bus
 * 
 * This is the main entry point for the refactored architecture
 * where all agent communication happens VIA Yellow state channels.
 */
export function wireAllAgentsToYellow(
    messageBus: YellowMessageBus,
    agents: {
        scout: EventEmitter;
        validator?: EventEmitter;
        riskEngine: EventEmitter;
        executor: EventEmitter;
    },
    options?: {
        scoutMagnitudeThreshold?: number;
        scoutMaxSignalsPerMinute?: number;
    }
): {
    scoutAdapter: ScoutYellowAdapter;
    validatorAdapter?: ValidatorYellowAdapter;
    riskEngineAdapter: RiskEngineYellowAdapter;
    executorAdapter: ExecutorYellowAdapter;
} {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🔗 Wiring All Agents to Yellow Message Bus');
    console.log('   Per PROJECT_SPEC.md Section 4.5:');
    console.log('   "Agents communicate via Yellow state channels"');
    console.log('═══════════════════════════════════════════════════════════\n');

    const scoutAdapter = new ScoutYellowAdapter(messageBus, agents.scout, {
        magnitudeThreshold: options?.scoutMagnitudeThreshold,
        maxSignalsPerMinute: options?.scoutMaxSignalsPerMinute,
    });

    let validatorAdapter: ValidatorYellowAdapter | undefined;
    if (agents.validator) {
        validatorAdapter = new ValidatorYellowAdapter(messageBus, agents.validator);
    }

    const riskEngineAdapter = new RiskEngineYellowAdapter(messageBus, agents.riskEngine);
    const executorAdapter = new ExecutorYellowAdapter(messageBus, agents.executor);

    console.log('\n✅ All agents wired to Yellow Message Bus');
    console.log('   Communication flow:');
    console.log('   Scout → Yellow → RiskEngine → Yellow → Executor → Yellow\n');

    return {
        scoutAdapter,
        validatorAdapter,
        riskEngineAdapter,
        executorAdapter,
    };
}
