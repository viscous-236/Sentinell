import { NitroliteClient } from './nitrolite-client';
import { SessionId, ProtectionAction, SettlementReceipt } from './types';
import type { ThreatAlert } from '../../validator/src/validator';


export interface SessionSummary {
    sessionId: string;
    threatsDetected: number;
    actionsApproved: number;
    actionsRejected: number;
    hooksActivated: number;
    totalActions: number;
    startTime: number;
    endTime?: number;
}

export class ProtectionSessionManager {
    private nitroliteClient: NitroliteClient;
    private currentSessionId?: SessionId;
    private sessionStartTime?: number;
    private stats = {
        threatsDetected: 0,
        actionsApproved: 0,
        actionsRejected: 0,
        hooksActivated: 0,
    };

    constructor(nitroliteClient: NitroliteClient) {
        this.nitroliteClient = nitroliteClient;
    }

    async startSession(depositAmount: string = '1000000'): Promise<SessionId> {
        if (this.currentSessionId) {
            throw new Error('Session already active. Close existing session first.');
        }
        console.log('🚀 Starting Sentinel Protection Session...');
        this.currentSessionId = await this.nitroliteClient.createSession(depositAmount);
        this.sessionStartTime = Date.now();
        this.stats = {
            threatsDetected: 0,
            actionsApproved: 0,
            actionsRejected: 0,
            hooksActivated: 0,
        };
        console.log(`✅ Protection Session started: ${this.currentSessionId}`);
        return this.currentSessionId;
    }


    async recordThreat(threat: ThreatAlert): Promise<void> {
        if (!this.currentSessionId) {
            throw new Error('No active session');
        }
        const action: ProtectionAction = {
            type: 'THREAT_DETECTED',
            threatId: threat.id as string,
            timestamp: Date.now(),
            severity: threat.severity,
            metadata: {
                type: threat.type,
                chain: threat.chain,
                evidence: threat.evidence,
            },
        };

        await this.nitroliteClient.recordAction(this.currentSessionId, action);
        this.stats.threatsDetected++;
        console.log(`🚨 Threat recorded in session: ${threat.id} (Severity: ${threat.severity})`);
    }

    async recordAction(actionData: {
        type: 'THREAT_APPROVED' | 'THREAT_REJECTED' | 'HOOK_ACTIVATED';
        threatId: string;
        txHash?: string;
    }): Promise<void> {
        if (!this.currentSessionId) {
            throw new Error('No active session');
        }
        const action: ProtectionAction = {
            type: actionData.type,
            threatId: actionData.threatId,
            timestamp: Date.now(),
            txHash: actionData.txHash,
        };
        await this.nitroliteClient.recordAction(this.currentSessionId, action);
        // Update stats
        if (actionData.type === 'THREAT_APPROVED') {
            this.stats.actionsApproved++;
        } else if (actionData.type === 'THREAT_REJECTED') {
            this.stats.actionsRejected++;
        } else if (actionData.type === 'HOOK_ACTIVATED') {
            this.stats.hooksActivated++;
        }
        console.log(`📝 Action recorded: ${actionData.type} for threat ${actionData.threatId}`);
    }

    async settleSession(): Promise<SettlementReceipt> {
        if (!this.currentSessionId) {
            throw new Error('No active session to settle');
        }
        console.log('🔄 Settling protection session...');
        const receipt = await this.nitroliteClient.closeSession(this.currentSessionId);
        console.log('✅ Session settled on-chain');
        console.log(`📊 Final stats:
      - Threats Detected: ${this.stats.threatsDetected}
      - Actions Approved: ${this.stats.actionsApproved}
      - Actions Rejected: ${this.stats.actionsRejected}
      - Hooks Activated: ${this.stats.hooksActivated}
      - Total Off-Chain Actions: ${receipt.actionsSettled}
    `);
        this.currentSessionId = undefined;
        return receipt;
    }

    getSessionSummary(): SessionSummary {
        if (!this.currentSessionId || !this.sessionStartTime) {
            throw new Error('No active session');
        }
        const actions = this.nitroliteClient.getSessionActions();
        return {
            sessionId: this.currentSessionId,
            threatsDetected: this.stats.threatsDetected,
            actionsApproved: this.stats.actionsApproved,
            actionsRejected: this.stats.actionsRejected,
            hooksActivated: this.stats.hooksActivated,
            totalActions: actions.length,
            startTime: this.sessionStartTime,
        };
    }

    isSessionActive(): boolean {
        return !!this.currentSessionId;
    }
}