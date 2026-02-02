import { ThreatAlert } from './validator';

/**
 * Configuration for ThreatAggregator.
 * No decision thresholds - only aggregation metrics.
 */
export interface AggregatorConfig {
    /** Optional: Track aggregation history for analytics */
    enableHistory?: boolean;
}

/**
 * Output of threat aggregation.
 * Contains ONLY metrics - no decisions (approved/rejected).
 * RiskEngine receives this and applies its own decision logic.
 */
export interface ThreatAggregation {
    /** Aggregate severity score 0-100 (weighted if multiple signals) */
    aggregateSeverity: number;
    /** How many threat signals contributed to this aggregation */
    signalCount: number;
    /** Peak severity among all contributing signals */
    highestSeverity: number;
    /** Types of threats detected */
    signalTypes: string[];
    /** Human-readable summary of evidence */
    evidenceSummary: string;
    /** When aggregation was computed */
    timestamp: number;
}

/**
 * ThreatAggregator - Aggregates multiple threat signals into composite metrics.
 * 
 * CRITICAL: This class does NOT make decisions (no approved/rejected).
 */
export class ThreatAggregator {
    private config: AggregatorConfig;
    private aggregationHistory: Map<string, ThreatAggregation> = new Map();
    
    constructor(config: AggregatorConfig = {}) {
        this.config = config;
        console.log(`✅ Threat Aggregator initialized (metrics-only mode)`);
    }

    /**
     * Aggregate a threat alert into metrics.
     * Returns aggregation metadata for RiskEngine consumption.
     */
    aggregate(threat: ThreatAlert): ThreatAggregation {
        const aggregation: ThreatAggregation = {
            aggregateSeverity: threat.severity,
            signalCount: 1, // Single signal for now (multi-validator later)
            highestSeverity: threat.severity,
            signalTypes: [threat.type],
            evidenceSummary: this.buildEvidenceSummary(threat),
            timestamp: Date.now(),
        };

        // Store in history if enabled
        if (this.config.enableHistory) {
            this.aggregationHistory.set(threat.id as string, aggregation);
        }

        console.log(
            `📊 Aggregated: ${threat.type} | severity=${aggregation.aggregateSeverity} | signals=${aggregation.signalCount}`
        );

        return aggregation;
    }

    /**
     * Aggregate multiple threat alerts into a single composite metric.
     * Useful for multi-validator consensus (future: Yellow Network integration).
     */
    aggregateMultiple(threats: ThreatAlert[]): ThreatAggregation {
        if (threats.length === 0) {
            throw new Error('Cannot aggregate empty threat array');
        }

        // Calculate weighted average severity
        const totalSeverity = threats.reduce((sum, t) => sum + t.severity, 0);
        const aggregateSeverity = totalSeverity / threats.length;

        // Get highest severity
        const highestSeverity = Math.max(...threats.map(t => t.severity));

        // Collect unique signal types
        const signalTypes = [...new Set(threats.map(t => t.type))];

        const aggregation: ThreatAggregation = {
            aggregateSeverity,
            signalCount: threats.length,
            highestSeverity,
            signalTypes,
            evidenceSummary: this.buildMultiEvidenceSummary(threats),
            timestamp: Date.now(),
        };

        console.log(
            `📊 Multi-aggregated: ${signalTypes.join(', ')} | avg=${aggregateSeverity.toFixed(1)} | signals=${threats.length}`
        );

        return aggregation;
    }

    private buildEvidenceSummary(threat: ThreatAlert): string {
        const parts: string[] = [];
        
        if (threat.evidence?.oraclePrice && threat.evidence?.dexPrice) {
            parts.push(`Oracle: ${threat.evidence.oraclePrice}, DEX: ${threat.evidence.dexPrice}`);
        }
        
        if (threat.evidence?.deviation) {
            parts.push(`Deviation: ${threat.evidence.deviation.toFixed(2)}%`);
        }
        
        if (threat.evidence?.crossChainPrices) {
            const chains = Object.keys(threat.evidence.crossChainPrices).join(', ');
            parts.push(`Cross-chain: ${chains}`);
        }

        return parts.length > 0 
            ? parts.join(' | ') 
            : `${threat.type} detected on ${threat.chain}`;
    }

    private buildMultiEvidenceSummary(threats: ThreatAlert[]): string {
        const chains = [...new Set(threats.map(t => t.chain))];
        const types = [...new Set(threats.map(t => t.type))];
        return `${types.join('+')} across ${chains.join(', ')} (${threats.length} signals)`;
    }

    /**
     * Get aggregation by threat ID (if history enabled)
     */
    getAggregation(threatId: string): ThreatAggregation | undefined {
        return this.aggregationHistory.get(threatId);
    }

    /**
     * Get all aggregations (if history enabled)
     */
    getAllAggregations(): Map<string, ThreatAggregation> {
        return new Map(this.aggregationHistory);
    }

    /**
     * Get aggregation statistics (for monitoring/dashboard)
     */
    getStats(): {
        totalAggregations: number;
        averageSeverity: number;
        highestSeverity: number;
    } {
        const aggregations = Array.from(this.aggregationHistory.values());
        const total = aggregations.length;

        if (total === 0) {
            return { totalAggregations: 0, averageSeverity: 0, highestSeverity: 0 };
        }

        const avgSeverity = aggregations.reduce((sum, a) => sum + a.aggregateSeverity, 0) / total;
        const maxSeverity = Math.max(...aggregations.map(a => a.highestSeverity));

        return {
            totalAggregations: total,
            averageSeverity: avgSeverity,
            highestSeverity: maxSeverity,
        };
    }

    /**
     * Clear aggregation history
     */
    clearHistory(): void {
        this.aggregationHistory.clear();
        console.log('🧹 Aggregation history cleared');
    }
}
