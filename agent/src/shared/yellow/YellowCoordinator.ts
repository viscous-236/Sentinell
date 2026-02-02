/**
 * YellowCoordinator - Central coordinator for Yellow Network integration
 * 
 * Bridges all Sentinel agents (Scout, Validator, RiskEngine) to Yellow app sessions
 * for off-chain consensus and coordination per PROJECT_SPEC.md Section 4.5-4.6.
 * 
 * Responsibilities:
 * - Manages NitroliteClient connection lifecycle
 * - Records Scout signals to Yellow session (with rate limiting)
 * - Records Validator alerts to Yellow session
 * - Records RiskEngine decisions to Yellow session
 * - Provides session health status
 * - Handles reconnection on WebSocket failures
 */

import { EventEmitter } from 'events';
import { NitroliteClient } from './nitrolite-client';
import { ProtectionSessionManager, SessionSummary } from './session-manager';
import { YellowConfig, SessionId, ProtectionAction } from './types';
import type { ScoutSignal } from '../../scout/src/types';
import type { RiskDecision } from '../../executor/src/RiskEngine';

// Rate limiting configuration for Scout signals
interface RateLimitConfig {
    maxSignalsPerMinute: number;    // Max signals to record per minute
    magnitudeThreshold: number;     // Only record signals with magnitude above this
    samplingRate: number;           // Record 1 in N signals (for high-frequency signals)
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
    maxSignalsPerMinute: 30,
    magnitudeThreshold: 0.3,        // Only record significant signals
    samplingRate: 5,                // Record 1 in 5 signals
};

export class YellowCoordinator extends EventEmitter {
    private nitroliteClient: NitroliteClient;
    private sessionManager: ProtectionSessionManager;
    private config: YellowConfig;
    private rateLimitConfig: RateLimitConfig;

    // Rate limiting state
    private signalCountThisMinute = 0;
    private signalCountByType: Record<string, number> = {};
    private lastMinuteReset = Date.now();

    // Connection state
    private isConnected = false;
    private isSessionActive = false;

    constructor(config: YellowConfig, sentinelAddress?: string, rateLimit?: Partial<RateLimitConfig>) {
        super();
        this.config = config;
        this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT, ...rateLimit };
        this.nitroliteClient = new NitroliteClient(config, sentinelAddress);
        this.sessionManager = new ProtectionSessionManager(this.nitroliteClient);
    }

    /**
     * Initialize Yellow connection and start protection session
     */
    async initialize(depositAmount: string = '5'): Promise<SessionId> {
        console.log('🟡 YellowCoordinator: Initializing...');

        // Connect to Yellow Network
        await this.nitroliteClient.connect();
        this.isConnected = true;
        console.log('✅ YellowCoordinator: Connected to Yellow Network');

        // Start protection session
        const sessionId = await this.sessionManager.startSession(depositAmount);
        this.isSessionActive = true;

        // Start rate limit reset timer
        setInterval(() => this.resetRateLimitCounters(), 60_000);

        console.log('✅ YellowCoordinator: Ready for agent coordination');
        this.emit('ready', { sessionId });

        return sessionId;
    }

    /**
     * Graceful shutdown - settle session and disconnect
     */
    async shutdown(): Promise<void> {
        console.log('🟡 YellowCoordinator: Shutting down...');

        if (this.isSessionActive) {
            try {
                const receipt = await this.sessionManager.settleSession();
                console.log(`✅ YellowCoordinator: Session settled. Micro-fees: ${receipt.sentinelReward || '0'} ytest.usd`);
                this.emit('settled', receipt);
            } catch (error) {
                console.error('❌ YellowCoordinator: Failed to settle session:', error);
            }
            this.isSessionActive = false;
        }

        this.nitroliteClient.disconnect();
        this.isConnected = false;
        console.log('👋 YellowCoordinator: Disconnected');
    }

    // =========================================================================
    // Agent Wiring Methods
    // =========================================================================

    /**
     * Wire to Scout agent - records significant signals to Yellow session
     * 
     * Rate limiting applied:
     * - Only signals with magnitude > threshold
     * - Maximum N signals per minute
     * - Sampling for high-frequency signal types
     */
    wireToScout(scout: EventEmitter): void {
        scout.on('signal', (signal: ScoutSignal) => {
            this.recordScoutSignal(signal);
        });
        console.log('🔗 YellowCoordinator: Wired to Scout agent');
    }

    /**
     * Wire to Validator agent - records threat alerts to Yellow session
     */
    wireToValidator(validator: EventEmitter): void {
        validator.on('threat:alert', (alert: any) => {
            this.recordValidatorAlert(alert);
        });
        console.log('🔗 YellowCoordinator: Wired to Validator agent');
    }

    /**
     * Wire to RiskEngine - records decisions to Yellow session
     */
    wireToRiskEngine(riskEngine: EventEmitter): void {
        riskEngine.on('decision', (decision: RiskDecision) => {
            this.recordRiskDecision(decision);
        });
        console.log('🔗 YellowCoordinator: Wired to RiskEngine');
    }

    /**
     * Wire to Executor agent - records successful hook activations to Yellow session
     * 
     * Per PROJECT_SPEC.md Section 4.6:
     * - Records HOOK_ACTIVATED events with txHash for on-chain verification
     * - Completes the protection loop: Scout → Validator → RiskEngine → Executor
     */
    wireToExecutor(executor: EventEmitter): void {
        executor.on('execution:success', (event: { decision: RiskDecision; txHash: string }) => {
            this.recordExecutorAction(event);
        });
        console.log('🔗 YellowCoordinator: Wired to Executor agent');
    }

    // =========================================================================
    // Signal Recording Methods (with rate limiting)
    // =========================================================================

    /**
     * Record Scout signal to Yellow session (rate-limited)
     */
    private async recordScoutSignal(signal: ScoutSignal): Promise<void> {
        if (!this.shouldRecordSignal(signal)) {
            return;
        }

        if (!this.isSessionActive) {
            console.warn('⚠️ YellowCoordinator: No active session, signal not recorded');
            return;
        }

        const action: ProtectionAction = {
            type: 'SCOUT_SIGNAL',
            threatId: `scout-${signal.type}-${signal.timestamp}`,
            timestamp: signal.timestamp,
            severity: Math.round(signal.magnitude * 100), // Convert 0-1 to 0-100
            metadata: {
                signalType: signal.type,
                chain: signal.chain,
                pair: signal.pair,
                poolAddress: signal.poolAddress,
                magnitude: signal.magnitude,
            },
        };

        try {
            await this.nitroliteClient.recordAction(
                this.sessionManager['currentSessionId']!,
                action
            );
            this.signalCountThisMinute++;
            this.signalCountByType[signal.type] = (this.signalCountByType[signal.type] || 0) + 1;
            console.log(`📡 Scout signal recorded: ${signal.type} (mag: ${signal.magnitude.toFixed(2)})`);
        } catch (error) {
            console.error('❌ Failed to record Scout signal:', error);
        }
    }

    /**
     * Record Validator alert to Yellow session
     */
    private async recordValidatorAlert(alert: any): Promise<void> {
        if (!this.isSessionActive) {
            console.warn('⚠️ YellowCoordinator: No active session, alert not recorded');
            return;
        }

        const action: ProtectionAction = {
            type: 'VALIDATOR_ALERT',
            threatId: alert.id || `validator-${alert.type}-${Date.now()}`,
            timestamp: alert.detectedAt || Date.now(),
            severity: alert.severity,
            metadata: {
                alertType: alert.type,
                chain: alert.chain,
                targetPool: alert.targetPool,
                deviation: alert.evidence?.deviation,
                evidence: alert.evidence,
            },
        };

        try {
            await this.nitroliteClient.recordAction(
                this.sessionManager['currentSessionId']!,
                action
            );
            console.log(`🚨 Validator alert recorded: ${alert.type} (severity: ${alert.severity})`);
        } catch (error) {
            console.error('❌ Failed to record Validator alert:', error);
        }
    }

    /**
     * Record RiskEngine decision to Yellow session
     */
    private async recordRiskDecision(decision: RiskDecision): Promise<void> {
        if (!this.isSessionActive) {
            console.warn('⚠️ YellowCoordinator: No active session, decision not recorded');
            return;
        }

        const action: ProtectionAction = {
            type: 'RISK_DECISION',
            threatId: decision.id,
            timestamp: decision.timestamp,
            severity: decision.compositeScore,
            metadata: {
                action: decision.action,
                tier: decision.tier,
                targetPool: decision.targetPool,
                chain: decision.chain,
                pair: decision.pair,
                rationale: decision.rationale,
                ttlMs: decision.ttlMs,
                contributingSignals: decision.contributingSignals?.length || 0,
            },
        };

        try {
            await this.nitroliteClient.recordAction(
                this.sessionManager['currentSessionId']!,
                action
            );
            console.log(`🧠 RiskDecision recorded: ${decision.action} for ${decision.targetPool} (score: ${decision.compositeScore})`);
            this.emit('decision:recorded', decision);
        } catch (error) {
            console.error('❌ Failed to record RiskDecision:', error);
        }
    }

    /**
     * Record Executor action (HOOK_ACTIVATED) to Yellow session
     * 
     * Per PROJECT_SPEC.md Section 4.6:
     * - Final step in the protection loop
     * - Records on-chain txHash for verification
     * - Completes: Scout → Validator → RiskEngine → Executor → Yellow
     */
    private async recordExecutorAction(event: { decision: RiskDecision; txHash: string }): Promise<void> {
        if (!this.isSessionActive) {
            console.warn('⚠️ YellowCoordinator: No active session, executor action not recorded');
            return;
        }

        const action: ProtectionAction = {
            type: 'HOOK_ACTIVATED',
            threatId: event.decision.id,
            timestamp: Date.now(),
            severity: event.decision.compositeScore,
            txHash: event.txHash,
            metadata: {
                action: event.decision.action,
                tier: event.decision.tier,
                targetPool: event.decision.targetPool,
                chain: event.decision.chain,
                pair: event.decision.pair,
                rationale: event.decision.rationale,
            },
        };

        try {
            await this.nitroliteClient.recordAction(
                this.sessionManager['currentSessionId']!,
                action
            );
            console.log(`⚡ Executor action recorded: ${event.decision.action} (tx: ${event.txHash.slice(0, 10)}...)`);
            this.emit('execution:recorded', event);
        } catch (error) {
            console.error('❌ Failed to record Executor action:', error);
        }
    }

    // =========================================================================
    // Rate Limiting
    // =========================================================================

    /**
     * Determine if a Scout signal should be recorded based on rate limits
     */
    private shouldRecordSignal(signal: ScoutSignal): boolean {
        // Always record high-magnitude signals
        if (signal.magnitude >= this.rateLimitConfig.magnitudeThreshold * 2) {
            return true;
        }

        // Skip if below magnitude threshold
        if (signal.magnitude < this.rateLimitConfig.magnitudeThreshold) {
            return false;
        }

        // Check per-minute limit
        if (this.signalCountThisMinute >= this.rateLimitConfig.maxSignalsPerMinute) {
            return false;
        }

        // Apply sampling for high-frequency signal types
        const typeCount = this.signalCountByType[signal.type] || 0;
        if (typeCount > 0 && typeCount % this.rateLimitConfig.samplingRate !== 0) {
            return false;
        }

        return true;
    }

    /**
     * Reset rate limit counters (called every minute)
     */
    private resetRateLimitCounters(): void {
        this.signalCountThisMinute = 0;
        this.signalCountByType = {};
        this.lastMinuteReset = Date.now();
    }

    // =========================================================================
    // Status Methods
    // =========================================================================

    isReady(): boolean {
        return this.isConnected && this.isSessionActive;
    }

    getSessionSummary(): SessionSummary | null {
        if (!this.isSessionActive) {
            return null;
        }
        try {
            return this.sessionManager.getSessionSummary();
        } catch {
            return null;
        }
    }

    getRateLimitStatus(): { signalsThisMinute: number; limit: number } {
        return {
            signalsThisMinute: this.signalCountThisMinute,
            limit: this.rateLimitConfig.maxSignalsPerMinute,
        };
    }
}
