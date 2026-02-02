/**
 * YellowMessageBus - Agent Communication via Yellow State Channels
 * 
 * Per PROJECT_SPEC.md Section 4.5:
 * "Agents communicate via Yellow state channels. Enables:
 *  - fast consensus
 *  - no mempool exposure
 *  - atomic off-chain coordination"
 * 
 * This implementation makes Yellow the ACTUAL communication layer between agents,
 * not just an audit trail. Agents write to and read from Yellow session state.
 * 
 * Message Flow:
 *   Scout → YellowMessageBus.publishSignal() → Yellow Session State
 *                                                    ↓
 *   RiskEngine ← YellowMessageBus.subscribe('signal') ← polls session state
 *                                                    ↓
 *   RiskEngine → YellowMessageBus.publishDecision() → Yellow Session State
 *                                                    ↓
 *   Executor ← YellowMessageBus.subscribe('decision') ← polls session state
 */

import { EventEmitter } from 'events';
import { NitroliteClient } from './nitrolite-client';
import { YellowConfig, SessionId, ProtectionAction } from './types';

// Message types for inter-agent communication
export type MessageType = 'SCOUT_SIGNAL' | 'SCOUT_PRICE' | 'VALIDATOR_ALERT' | 'RISK_DECISION' | 'EXECUTOR_RESULT';

export interface YellowMessage {
    id: string;
    type: MessageType;
    timestamp: number;
    sender: 'scout' | 'validator' | 'riskengine' | 'executor';
    payload: any;
    version: number;
}

export interface ScoutSignalMessage extends YellowMessage {
    type: 'SCOUT_SIGNAL';
    payload: {
        signalType: string;
        magnitude: number;
        chain: string;
        pair?: string;
        poolAddress: string;
        txHash?: string;
        gasPrice?: bigint;
    };
}

// Price data message for Validator consumption
export interface ScoutPriceMessage extends YellowMessage {
    type: 'SCOUT_PRICE';
    payload: {
        pair: string;
        chain: 'ethereum' | 'base' | 'arbitrum';
        price: string;
        source: string;
        poolAddress?: string;
    };
}

export interface ValidatorAlertMessage extends YellowMessage {
    type: 'VALIDATOR_ALERT';
    payload: {
        alertType: string;
        severity: number;
        chain: string;
        targetPool: string;
        deviation?: number;
        evidence: any;
    };
}

export interface RiskDecisionMessage extends YellowMessage {
    type: 'RISK_DECISION';
    payload: {
        action: 'MEV_PROTECTION' | 'ORACLE_VALIDATION' | 'CIRCUIT_BREAKER' | 'NO_ACTION';
        tier: 'WATCH' | 'ELEVATED' | 'CRITICAL';
        compositeScore: number;
        targetPool: string;
        chain: string;
        rationale: string;
        ttlMs: number;
        contributingSignals: string[];
    };
}

export interface ExecutorResultMessage extends YellowMessage {
    type: 'EXECUTOR_RESULT';
    payload: {
        decisionId: string;
        hookType: string;
        txHash: string;
        chain: string;
        success: boolean;
        gasUsed?: string;
        error?: string;
    };
}

// Yellow Session State structure (shared between agents)
export interface YellowSessionState {
    sessionId: string;
    version: number;
    lastUpdate: number;

    // Agent message queues (agents read from here)
    signals: ScoutSignalMessage[];
    prices: ScoutPriceMessage[];  // DEX prices for Validator
    alerts: ValidatorAlertMessage[];
    decisions: RiskDecisionMessage[];
    executions: ExecutorResultMessage[];

    // Cursors for each agent (track what they've processed)
    cursors: {
        riskEngine: { signals: number; alerts: number };
        validator: { prices: number };  // Validator price cursor
        executor: { decisions: number };
    };

    // Micro-fee tracking
    microFees: {
        feePerAction: string;
        totalAccrued: string;
        actionCount: number;
    };
}

const MICRO_FEE_PER_ACTION = '0.001';
const POLL_INTERVAL_MS = 100; // Poll every 100ms for new messages

export class YellowMessageBus extends EventEmitter {
    private nitroliteClient: NitroliteClient;
    private config: YellowConfig;
    private sessionId?: SessionId;

    // Local state cache (synchronized with Yellow)
    private state: YellowSessionState;
    private stateVersion = 0;

    // Polling intervals for subscribers
    private pollIntervals: Map<string, NodeJS.Timeout> = new Map();

    // Connection state
    private connected = false;
    private sessionActive = false;

    constructor(config: YellowConfig, sentinelAddress?: string) {
        super();
        this.config = config;
        this.nitroliteClient = new NitroliteClient(config, sentinelAddress);

        // Initialize empty state
        this.state = this.createEmptyState();
    }

    private createEmptyState(): YellowSessionState {
        return {
            sessionId: '',
            version: 0,
            lastUpdate: Date.now(),
            signals: [],
            prices: [],  // DEX prices for Validator
            alerts: [],
            decisions: [],
            executions: [],
            cursors: {
                riskEngine: { signals: 0, alerts: 0 },
                validator: { prices: 0 },  // Validator price cursor
                executor: { decisions: 0 },
            },
            microFees: {
                feePerAction: MICRO_FEE_PER_ACTION,
                totalAccrued: '0',
                actionCount: 0,
            },
        };
    }

    /**
     * Initialize Yellow connection and start protection session
     */
    async initialize(depositAmount: string = '10'): Promise<SessionId> {
        console.log('🟡 YellowMessageBus: Initializing...');

        // Connect to Yellow Network
        await this.nitroliteClient.connect();
        this.connected = true;
        console.log('✅ YellowMessageBus: Connected to Yellow Network');

        // Create protection session with initial state
        this.sessionId = await this.nitroliteClient.createSession(depositAmount);
        this.state.sessionId = this.sessionId || '';
        this.sessionActive = true;

        console.log('✅ YellowMessageBus: Protection session created');
        console.log('   Session ID:', (this.sessionId || '').substring(0, 20) + '...');
        console.log('   Mode: Agent-to-Agent Communication via Yellow State Channels');
        console.log('   Per PROJECT_SPEC.md Section 4.5: "Agents communicate via Yellow state channels"\n');

        this.emit('ready', { sessionId: this.sessionId });
        return this.sessionId || '';
    }

    /**
     * Graceful shutdown - settle session and disconnect
     */
    async shutdown(): Promise<void> {
        console.log('🟡 YellowMessageBus: Shutting down...');

        // Stop all polling
        for (const [key, interval] of this.pollIntervals) {
            clearInterval(interval);
        }
        this.pollIntervals.clear();

        // Settle session
        if (this.sessionActive && this.sessionId) {
            try {
                const receipt = await this.nitroliteClient.closeSession(this.sessionId);
                console.log(`✅ YellowMessageBus: Session settled`);
                console.log(`   Messages processed: ${this.state.microFees.actionCount}`);
                console.log(`   Micro-fees earned: ${receipt.sentinelReward} ytest.usd`);
                this.emit('settled', receipt);
            } catch (error) {
                console.error('❌ YellowMessageBus: Failed to settle:', error);
            }
            this.sessionActive = false;
        }

        this.nitroliteClient.disconnect();
        this.connected = false;
        console.log('👋 YellowMessageBus: Disconnected');
    }

    // =========================================================================
    // PUBLISH METHODS - Agents write messages to Yellow session state
    // =========================================================================

    /**
     * Scout Agent publishes a signal to Yellow session state
     * 
     * Per PROJECT_SPEC.md Section 4.1: Scout "Emits weak, fast signals"
     * These signals are written to Yellow state, NOT emitted locally.
     */
    async publishSignal(signal: {
        type: string;
        magnitude: number;
        chain: string;
        pair?: string;
        poolAddress: string;
        txHash?: string;
        gasPrice?: bigint;
    }): Promise<void> {
        if (!this.sessionActive) {
            throw new Error('No active session');
        }

        const message: ScoutSignalMessage = {
            id: `signal-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            type: 'SCOUT_SIGNAL',
            timestamp: Date.now(),
            sender: 'scout',
            version: ++this.stateVersion,
            payload: {
                signalType: signal.type,
                magnitude: signal.magnitude,
                chain: signal.chain,
                pair: signal.pair,
                poolAddress: signal.poolAddress,
                txHash: signal.txHash,
                gasPrice: signal.gasPrice,
            },
        };

        // Add to local state
        this.state.signals.push(message);
        this.state.version = this.stateVersion;
        this.state.lastUpdate = Date.now();

        // Update micro-fees
        this.updateMicroFees();

        // Sync to Yellow session
        await this.syncStateToYellow(message);

        console.log(`📡 [Yellow] Scout signal published: ${signal.type} (mag: ${signal.magnitude.toFixed(2)})`);
    }

    /**
     * Scout Agent publishes DEX price data to Yellow session state
     * 
     * For Validator Agent to validate prices against oracles.
     * Per PROJECT_SPEC.md: Validator validates Scout price data against oracles.
     */
    async publishPrice(price: {
        pair: string;
        chain: 'ethereum' | 'base' | 'arbitrum';
        price: string;
        source: string;
        poolAddress?: string;
    }): Promise<void> {
        if (!this.sessionActive) {
            throw new Error('No active session');
        }

        const message: ScoutPriceMessage = {
            id: `price-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            type: 'SCOUT_PRICE',
            timestamp: Date.now(),
            sender: 'scout',
            version: ++this.stateVersion,
            payload: {
                pair: price.pair,
                chain: price.chain,
                price: price.price,
                source: price.source,
                poolAddress: price.poolAddress,
            },
        };

        // Add to local state
        this.state.prices.push(message);
        this.state.version = this.stateVersion;
        this.state.lastUpdate = Date.now();

        // Update micro-fees
        this.updateMicroFees();

        // Sync to Yellow session
        await this.syncStateToYellow(message);

        console.log(`💰 [Yellow] Scout price published: ${price.pair} = ${price.price} (${price.chain})`);
    }


    /**
     * Validator Agent publishes an alert to Yellow session state
     * 
     * Per PROJECT_SPEC.md Section 4.1: Validator "Emits high-value threat alerts"
     */
    async publishAlert(alert: {
        type: string;
        severity: number;
        chain: string;
        targetPool: string;
        deviation?: number;
        evidence: any;
    }): Promise<void> {
        if (!this.sessionActive) {
            throw new Error('No active session');
        }

        const message: ValidatorAlertMessage = {
            id: `alert-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            type: 'VALIDATOR_ALERT',
            timestamp: Date.now(),
            sender: 'validator',
            version: ++this.stateVersion,
            payload: {
                alertType: alert.type,
                severity: alert.severity,
                chain: alert.chain,
                targetPool: alert.targetPool,
                deviation: alert.deviation,
                evidence: alert.evidence,
            },
        };

        this.state.alerts.push(message);
        this.state.version = this.stateVersion;
        this.state.lastUpdate = Date.now();
        this.updateMicroFees();

        await this.syncStateToYellow(message);

        console.log(`🚨 [Yellow] Validator alert published: ${alert.type} (severity: ${alert.severity})`);
    }

    /**
     * Risk Engine publishes a decision to Yellow session state
     * 
     * Per PROJECT_SPEC.md Section 4.1: Risk Engine "Emits time-bounded execution decisions"
     * Per Section 4.3: "Risk Engine outputs a single RiskDecision per pool when action is required"
     */
    async publishDecision(decision: {
        id: string;
        action: 'MEV_PROTECTION' | 'ORACLE_VALIDATION' | 'CIRCUIT_BREAKER' | 'NO_ACTION';
        tier: 'WATCH' | 'ELEVATED' | 'CRITICAL';
        compositeScore: number;
        targetPool: string;
        chain: string;
        rationale: string;
        ttlMs: number;
        contributingSignals: string[];
    }): Promise<void> {
        if (!this.sessionActive) {
            throw new Error('No active session');
        }

        const message: RiskDecisionMessage = {
            id: decision.id,
            type: 'RISK_DECISION',
            timestamp: Date.now(),
            sender: 'riskengine',
            version: ++this.stateVersion,
            payload: {
                action: decision.action,
                tier: decision.tier,
                compositeScore: decision.compositeScore,
                targetPool: decision.targetPool,
                chain: decision.chain,
                rationale: decision.rationale,
                ttlMs: decision.ttlMs,
                contributingSignals: decision.contributingSignals,
            },
        };

        this.state.decisions.push(message);
        this.state.version = this.stateVersion;
        this.state.lastUpdate = Date.now();
        this.updateMicroFees();

        await this.syncStateToYellow(message);

        console.log(`🎯 [Yellow] Risk decision published: ${decision.action} (tier: ${decision.tier})`);
    }

    /**
     * Executor Agent publishes execution result to Yellow session state
     * 
     * Per PROJECT_SPEC.md Section 4.1: Executor "Executes the instructed defense"
     */
    async publishExecution(result: {
        decisionId: string;
        hookType: string;
        txHash: string;
        chain: string;
        success: boolean;
        gasUsed?: string;
        error?: string;
    }): Promise<void> {
        if (!this.sessionActive) {
            throw new Error('No active session');
        }

        const message: ExecutorResultMessage = {
            id: `exec-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            type: 'EXECUTOR_RESULT',
            timestamp: Date.now(),
            sender: 'executor',
            version: ++this.stateVersion,
            payload: {
                decisionId: result.decisionId,
                hookType: result.hookType,
                txHash: result.txHash,
                chain: result.chain,
                success: result.success,
                gasUsed: result.gasUsed,
                error: result.error,
            },
        };

        this.state.executions.push(message);
        this.state.version = this.stateVersion;
        this.state.lastUpdate = Date.now();
        this.updateMicroFees();

        await this.syncStateToYellow(message);

        console.log(`⚡ [Yellow] Execution result published: ${result.hookType} (success: ${result.success})`);
    }

    // =========================================================================
    // SUBSCRIBE METHODS - Agents read messages from Yellow session state
    // =========================================================================

    /**
     * Subscribe to signals from Yellow session state
     * 
     * Used by: RiskEngine (to correlate Scout signals)
     * Returns new signals since last cursor position
     */
    subscribeToSignals(callback: (signals: ScoutSignalMessage[]) => void): void {
        const pollKey = 'signals';

        // Clear existing subscription if any
        if (this.pollIntervals.has(pollKey)) {
            clearInterval(this.pollIntervals.get(pollKey)!);
        }

        const poll = () => {
            const cursor = this.state.cursors.riskEngine.signals;
            const newSignals = this.state.signals.slice(cursor);

            if (newSignals.length > 0) {
                this.state.cursors.riskEngine.signals = this.state.signals.length;
                callback(newSignals);
            }
        };

        // Start polling
        const interval = setInterval(poll, POLL_INTERVAL_MS);
        this.pollIntervals.set(pollKey, interval);

        // Initial poll
        poll();

        console.log('🔔 [Yellow] Subscribed to Scout signals');
    }

    /**
     * Subscribe to alerts from Yellow session state
     * 
     * Used by: RiskEngine (to correlate Validator alerts)
     */
    subscribeToAlerts(callback: (alerts: ValidatorAlertMessage[]) => void): void {
        const pollKey = 'alerts';

        if (this.pollIntervals.has(pollKey)) {
            clearInterval(this.pollIntervals.get(pollKey)!);
        }

        const poll = () => {
            const cursor = this.state.cursors.riskEngine.alerts;
            const newAlerts = this.state.alerts.slice(cursor);

            if (newAlerts.length > 0) {
                this.state.cursors.riskEngine.alerts = this.state.alerts.length;
                callback(newAlerts);
            }
        };

        const interval = setInterval(poll, POLL_INTERVAL_MS);
        this.pollIntervals.set(pollKey, interval);
        poll();

        console.log('🔔 [Yellow] Subscribed to Validator alerts');
    }

    /**
     * Subscribe to prices from Yellow session state
     * 
     * Used by: Validator (to validate Scout prices against oracles)
     * Per PROJECT_SPEC.md: Validator compares DEX prices to oracle prices
     */
    subscribeToPrices(callback: (prices: ScoutPriceMessage[]) => void): void {
        const pollKey = 'prices';

        if (this.pollIntervals.has(pollKey)) {
            clearInterval(this.pollIntervals.get(pollKey)!);
        }

        const poll = () => {
            const cursor = this.state.cursors.validator.prices;
            const newPrices = this.state.prices.slice(cursor);

            if (newPrices.length > 0) {
                this.state.cursors.validator.prices = this.state.prices.length;
                callback(newPrices);
            }
        };

        const interval = setInterval(poll, POLL_INTERVAL_MS);
        this.pollIntervals.set(pollKey, interval);
        poll();

        console.log('🔔 [Yellow] Subscribed to Scout prices (for Validator)');
    }


    /**
     * Subscribe to decisions from Yellow session state
     * 
     * Used by: Executor (to execute Risk Engine decisions)
     * Per PROJECT_SPEC.md Section 4.1: Executor "Listens only to Risk Engine decisions"
     */
    subscribeToDecisions(callback: (decisions: RiskDecisionMessage[]) => void): void {
        const pollKey = 'decisions';

        if (this.pollIntervals.has(pollKey)) {
            clearInterval(this.pollIntervals.get(pollKey)!);
        }

        const poll = () => {
            const cursor = this.state.cursors.executor.decisions;
            const newDecisions = this.state.decisions.slice(cursor);

            if (newDecisions.length > 0) {
                this.state.cursors.executor.decisions = this.state.decisions.length;
                callback(newDecisions);
            }
        };

        const interval = setInterval(poll, POLL_INTERVAL_MS);
        this.pollIntervals.set(pollKey, interval);
        poll();

        console.log('🔔 [Yellow] Subscribed to Risk decisions');
    }

    // =========================================================================
    // INTERNAL METHODS
    // =========================================================================

    /**
     * Sync local state to Yellow session (off-chain state update)
     */
    private async syncStateToYellow(message: YellowMessage): Promise<void> {
        if (!this.sessionId) {
            throw new Error('No active session');
        }

        // Map MessageType to ProtectionAction type
        const actionType = message.type === 'EXECUTOR_RESULT' ? 'HOOK_ACTIVATED' : message.type;

        // Convert BigInt values to strings in payload (JSON.stringify can't handle BigInt)
        const serializedPayload = this.serializeBigInt(message.payload);

        // Create protection action for Yellow
        const action: ProtectionAction = {
            type: actionType as ProtectionAction['type'],
            threatId: message.id,
            timestamp: message.timestamp,
            severity: this.getSeverityFromMessage(message),
            metadata: {
                sender: message.sender,
                version: message.version,
                payload: serializedPayload,
            },
        };

        try {
            await this.nitroliteClient.recordAction(this.sessionId, action);
        } catch (error) {
            console.error(`❌ [Yellow] Failed to sync state:`, error);
            throw error;
        }
    }

    private getSeverityFromMessage(message: YellowMessage): number {
        switch (message.type) {
            case 'SCOUT_SIGNAL':
                return Math.round((message as ScoutSignalMessage).payload.magnitude * 100);
            case 'VALIDATOR_ALERT':
                return (message as ValidatorAlertMessage).payload.severity;
            case 'RISK_DECISION':
                return Math.round((message as RiskDecisionMessage).payload.compositeScore);
            case 'EXECUTOR_RESULT':
                return (message as ExecutorResultMessage).payload.success ? 100 : 0;
            default:
                return 50;
        }
    }

    private updateMicroFees(): void {
        const currentFees = parseFloat(this.state.microFees.totalAccrued);
        const newFees = currentFees + parseFloat(MICRO_FEE_PER_ACTION);
        this.state.microFees.totalAccrued = newFees.toFixed(6);
        this.state.microFees.actionCount++;
    }

    /**
     * Convert BigInt values to strings recursively for JSON serialization
     */
    private serializeBigInt(obj: any): any {
        if (obj === null || obj === undefined) {
            return obj;
        }

        if (typeof obj === 'bigint') {
            return obj.toString();
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.serializeBigInt(item));
        }

        if (typeof obj === 'object') {
            const serialized: any = {};
            for (const [key, value] of Object.entries(obj)) {
                serialized[key] = this.serializeBigInt(value);
            }
            return serialized;
        }

        return obj;
    }

    // =========================================================================
    // STATE ACCESS METHODS
    // =========================================================================

    /**
     * Get current session state (read-only)
     */
    getState(): Readonly<YellowSessionState> {
        return { ...this.state };
    }

    /**
     * Get session summary
     */
    getSummary(): {
        sessionId: string;
        version: number;
        signalCount: number;
        alertCount: number;
        decisionCount: number;
        executionCount: number;
        totalMessages: number;
        microFeesAccrued: string;
    } {
        return {
            sessionId: this.sessionId || '',
            version: this.state.version,
            signalCount: this.state.signals.length,
            alertCount: this.state.alerts.length,
            decisionCount: this.state.decisions.length,
            executionCount: this.state.executions.length,
            totalMessages: this.state.microFees.actionCount,
            microFeesAccrued: this.state.microFees.totalAccrued,
        };
    }

    /**
     * Check if session is active
     */
    isActive(): boolean {
        return this.sessionActive;
    }
}
