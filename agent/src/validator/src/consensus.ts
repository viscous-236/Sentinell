import { ThreatAlert } from './validator';

export interface ConsensusConfig {
    threatThreshold: number;
}

export interface ConsensusDecision {
    approved: boolean;
    reason: string;
    timestamp: number;
}

export class ConsensusEngine {
    private config: ConsensusConfig;
    private decisions: Map<string, ConsensusDecision> = new Map();
    constructor(config: ConsensusConfig) {
        this.config = config;
        console.log(`✅ Consensus Engine initialized (Threshold: ${config.threatThreshold})`);
    }

    evaluateThreat(threat: ThreatAlert): ConsensusDecision {
        const approved = threat.severity >= this.config.threatThreshold;
        const decision: ConsensusDecision = {
            approved,
            reason: approved
                ? `Severity ${threat.severity} exceeds threshold ${this.config.threatThreshold}`
                : `Severity ${threat.severity} below threshold ${this.config.threatThreshold}`,
            timestamp: Date.now(),
        };
        this.decisions.set(threat.id as string, decision);
        const emoji = approved ? '✅' : '❌';
        console.log(
            `${emoji} Consensus Decision: ${approved ? 'APPROVED' : 'REJECTED'} - ${decision.reason}`
        );
        return decision;
    }

    getDecision(threatId: string): ConsensusDecision | undefined {
        return this.decisions.get(threatId);
    }
    /**
     * Get all decisions
     */
    getAllDecisions(): Map<string, ConsensusDecision> {
        return new Map(this.decisions);
    }
    /**
     * Get consensus statistics
     */
    getStats(): {
        totalDecisions: number;
        approved: number;
        rejected: number;
        approvalRate: number;
    } {
        const total = this.decisions.size;
        const approved = Array.from(this.decisions.values()).filter((d) => d.approved).length;
        const rejected = total - approved;
        return {
            totalDecisions: total,
            approved,
            rejected,
            approvalRate: total > 0 ? (approved / total) * 100 : 0,
        };
    }

    updateThreshold(newThreshold: number): void {
        if (newThreshold < 0 || newThreshold > 100) {
            throw new Error('Threshold must be between 0 and 100');
        }
        this.config.threatThreshold = newThreshold;
        console.log(`🔧 Consensus threshold updated to ${newThreshold}`);
    }

    clearHistory(): void {
        this.decisions.clear();
        console.log('🧹 Consensus decision history cleared');
    }
}