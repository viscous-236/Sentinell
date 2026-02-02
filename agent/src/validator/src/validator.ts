import { EventEmitter } from "events";
import { ethers } from "ethers";
import { OracleChecker, OracleCheckerConfig } from "./oracle-checker";
import { PriceValidator, PriceValidatorConfig } from "./price-validator";
import { ThreatAggregator, AggregatorConfig, ThreatAggregation } from "./aggregator";

export interface ValidatorConfig {
    rpcUrls: {
        ethereum: string;
        base: string;
        arbitrum: string;
    };

    chainlinkFeeds: {
        ethereum: {
            [pair: string]: string;
        };
        base: {
            [pair: string]: string;
        };
        arbitrum: {
            [pair: string]: string;
        };
    };

    oracleCheckerConfig: OracleCheckerConfig;
    priceValidatorConfig: PriceValidatorConfig;

    thresholds: {
        oracleDeviation: number;
        crosschainDeviation: number;
    };

    /** Optional aggregator config for threat metrics */
    aggregatorConfig?: AggregatorConfig;

    yellowNetwork?: {
        enabled: boolean;
        channelId?: string;
    };
}


export interface ScoutPriceData {
    pair: string;
    chain: 'ethereum' | 'base' | 'arbitrum';
    price: string;
    timestamp: number;
    source: string;
    poolAddress?: string;
}

export interface ValidationResult {
    pair: string;
    chain: string;
    valid: boolean;
    oraclePrice: string;
    dexPrice: string;
    deviation: number;
    timestamp: number;
    reason?: string;
}

export interface CrossChainValidation {
    pair: string;
    chains: string[];
    prices: { [chain: string]: string; };
    maxDeviation: number;
    consistent: boolean;
    timestamp: number;
}

export interface ThreatAlert {
    id: String;
    type: 'ORACLE_MANIPULATION' | 'CROSS_CHAIN_INCONSISTENCY';
    severity: number;
    pair: string;
    targetPool?: string;
    chain: string;
    detectedAt: number;
    evidence: {
        oraclePrice?: string;
        dexPrice?: string;
        deviation?: number;
        crossChainPrices?: { [chain: string]: string; };
    };
    consensusProof?: string[];//Validator signatures (Yellow Network)
}

export class ValidatorAgent extends EventEmitter {
    private config: ValidatorConfig;
    private providers: Map<string, ethers.Provider>;
    private validationCache: Map<string, ValidationResult>;
    private priceHistory: Map<string, ScoutPriceData[]>; // For TWAP calculation
    private isRunning: boolean = false;

    private oracleChecker?: OracleChecker;
    private priceValidator?: PriceValidator;
    private aggregator?: ThreatAggregator;

    constructor(config: ValidatorConfig) {
        super();
        this.config = config;
        this.providers = new Map();
        this.validationCache = new Map();
        this.priceHistory = new Map();

        this.initializeProviders();
    }

    private initializeProviders(): void {
        const chains = ["ethereum", "base", "arbitrum"] as const;

        for (const chain of chains) {
            const rpcUrl = this.config.rpcUrls[chain];

            if (rpcUrl) {
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                this.providers.set(chain, provider);
                console.log(`✅ Validator: Connected to ${chain} RPC`);
            } else {
                console.warn(`⚠️ Validator: No RPC URL configured for ${chain}`);
            }
        }
    }

    /// Start the Validator Agent
    async start(): Promise<void> {
        if (this.isRunning) {
            console.warn('⚠️  Validator already running');
            return;
        }

        console.log('🚀 Starting Validator Agent...');


        // Components will be initialized in later steps
        this.initializeOracleChecker();
        this.initializePriceValidator();
        this.initializeAggregator();
        this.isRunning = true;
        this.emit('validator:started');
        console.log('✅ Validator Agent started');
    }

    async stop(): Promise<void> {
        if (!this.isRunning) return;

        console.log('🛑 Stopping Validator Agent...')
        this.isRunning = false;
        this.emit('validator:stopped');
        console.log('✅ Validator Agent stopped');
    }

    private initializeOracleChecker(): void {
        this.oracleChecker = new OracleChecker(
            this.providers,
            this.config.chainlinkFeeds,
            this.config.oracleCheckerConfig,
            this.config.thresholds.oracleDeviation
        );

        console.log('✅ Oracle Checker initialized');
    }

    private initializePriceValidator(): void {
        this.priceValidator = new PriceValidator(this.config.priceValidatorConfig);
        console.log('✅ Validator: Price validator initialized');
    }

    private initializeAggregator(): void {
        this.aggregator = new ThreatAggregator(this.config.aggregatorConfig || { enableHistory: true });
        console.log('✅ Validator: Threat aggregator initialized');
    }

    /// Subscribe to Scout Agent price events
    subscribeToScout(scoutAgent: EventEmitter): void {
        console.log('📡 Validator: Subscribing to Scout price events...');

        scoutAgent.on('price:update', (priceData: ScoutPriceData) => {
            this.handleScoutPrice(priceData);
        })

        scoutAgent.on('anomaly:detected', (anomaly: any) => {
            this.handleScoutAnomaly(anomaly);
        });

        console.log('✅ Validator: Subscribed to Scout price events');
    }

    /// Handle incoming price data from Scout Agent
    private async handleScoutPrice(priceData: ScoutPriceData): Promise<void> {
        if (!this.isRunning) return;

        try {
            this.storePriceHistory(priceData);
            // Validate against oracle (Step 2 - will implement)
            if (this.oracleChecker) {
                const validation = await this.oracleChecker.validateAgainstOracles(priceData);

                this.emitValidationComplete(validation);

                if (!validation.valid) {
                    const threatAlert: ThreatAlert = {
                        id: `oracle-${priceData.chain}-${priceData.pair}-${Date.now()}`,
                        type: 'ORACLE_MANIPULATION',
                        severity: this.calculateThreatSeverity(validation.deviation),
                        pair: priceData.pair,
                        targetPool: priceData.poolAddress,
                        chain: priceData.chain,
                        detectedAt: Date.now(),
                        evidence: {
                            oraclePrice: validation.oraclePrice,
                            dexPrice: validation.dexPrice,
                            deviation: validation.deviation,
                        },
                    };

                    this.emitThreatAlert(threatAlert);
                    // Log detailed threat information
                    console.log('🚨 THREAT DETECTED:', {
                        pair: priceData.pair,
                        chain: priceData.chain,
                        deviation: `${validation.deviation.toFixed(2)}%`,
                        severity: threatAlert.severity,
                        reason: validation.reason,
                    });
                }
            }

            // Check cross-chain consistency (Step 3 - will implement)
            if (this.priceValidator) {
                const crossChainValidation = this.priceValidator.validateCrossChainConsistency(
                    priceData.pair
                );
                if (crossChainValidation && !crossChainValidation.consistent) {
                    const threatAlert: ThreatAlert = {
                        id: `crosschain-${priceData.pair}-${Date.now()}`,
                        type: 'CROSS_CHAIN_INCONSISTENCY',
                        severity: this.calculateCrossChainThreatSeverity(
                            crossChainValidation.maxDeviation
                        ),
                        pair: priceData.pair,
                        chain: 'multi-chain',
                        detectedAt: Date.now(),
                        evidence: {
                            crossChainPrices: crossChainValidation.prices,
                            deviation: crossChainValidation.maxDeviation,
                        },
                    };
                    this.emitThreatAlert(threatAlert);
                    console.log('🚨 CROSS-CHAIN THREAT DETECTED:', {
                        pair: priceData.pair,
                        chains: crossChainValidation.chains,
                        maxDeviation: `${crossChainValidation.maxDeviation.toFixed(2)} bp`,
                        severity: threatAlert.severity,
                        prices: crossChainValidation.prices,
                    });
                }
            }

            // const crossChainCheck = await this.checkCrossChainConsistency(priceData);

            this.emit('validation:complete', {
                pair: priceData.pair,
                chain: priceData.chain,
                timestamp: Date.now(),
            });
        } catch (error) {
            console.error('❌ Validator: Error handling scout price data', error);
            this.emit('validator:error', { error, priceData });
        }
    }

    private calculateCrossChainThreatSeverity(deviation: number): number {
        const threshold = this.config.thresholds.crosschainDeviation;
        // Linear scale: threshold = 50% severity, 2x threshold = 100% severity
        const severity = Math.min(100, (deviation / threshold) * 50);
        return Math.round(severity);
    }

    /// Handle anomalies detected by Scout Agent
    private async handleScoutAnomaly(anomaly: any): Promise<void> {
        console.log('🚨 Validator: Scout detected anomaly:', anomaly.type);

        // Trigger urgent validation
        // Will implement in Step 2-4
        this.emit('validation:priority', anomaly);
    }

    /// Store price data for TWAP calculations
    private storePriceHistory(priceData: ScoutPriceData): void {
        const key = `${priceData.chain}:${priceData.pair}`;
        if (!this.priceHistory.has(key)) {
            this.priceHistory.set(key, []);
        }

        const history = this.priceHistory.get(key)!;
        history.push(priceData);

        const MAX_HISTORY = 1800;
        if (history.length > MAX_HISTORY) {
            history.shift();
        }
    }

    private calculateThreatSeverity(deviation: number): number {
        const threshold = this.config.thresholds.oracleDeviation;
        const severity = Math.min(100, (deviation / threshold) * 50);
        return Math.round(severity);
    }


    getValidationStatus(chain: string, pair: string): ValidationResult | null {
        const key = `${chain}:${pair}`;
        return this.validationCache.get(key) || null;
    }

    getPriceHistory(chain: string, pair: string, windowSeconds: number = 1800): ScoutPriceData[] {
        const key = `${chain}:${pair}`;
        const history = this.priceHistory.get(key) || [];
        const cutoff = Date.now() - windowSeconds * 1000;
        return history.filter(data => data.timestamp >= cutoff);
    }

    getStatus(): {
        running: boolean;
        connectedChains: string[];
        validatedPairs: number;
        lastValidation?: number;
    } {
        return {
            running: this.isRunning,
            connectedChains: Array.from(this.providers.keys()),
            validatedPairs: this.validationCache.size,
            lastValidation: this.getLastValidationTimestamp(),
        };
    }

    async getOracleHealth(chain: 'ethereum' | 'base' | 'arbitrum', pair: string): Promise<{
        healthy: boolean;
        chainlinkHealthy: boolean;
        pythHealthy: boolean;
        lastUpdate: number;
    } | null> {
        if (!this.oracleChecker) {
            return null;
        }
        return await this.oracleChecker.getOracleHealth(chain, pair);
    }

    private getLastValidationTimestamp(): number | undefined {
        let latest = 0;
        for (const validation of this.validationCache.values()) {
            if (validation.timestamp > latest) {
                latest = validation.timestamp;
            }
        }

        return latest > 0 ? latest : undefined;
    }

    getCrossChainStatus(pair: string): CrossChainValidation | null {
        if (!this.priceValidator) return null;
        return this.priceValidator.validateCrossChainConsistency(pair);
    }

    getCrossChainStats(pair: string) {
        if (!this.priceValidator) return null;
        return this.priceValidator.getPriceStatistics(pair);
    }

    getMonitoredPairs(): string[] {
        if (!this.priceValidator) return [];
        return this.priceValidator.getMonitoredPairs();
    }

    /**
     * Emit threat alert with aggregation.
     * Aggregates threat metrics and emits to RiskEngine.
     * NO decision logic - only metrics aggregation.
     */
    private emitThreatAlert(alert: ThreatAlert): void {
        console.log(`🚨 Validator: Threat detected - ${alert.type} on ${alert.chain}`);
        
        // Aggregate threat metrics (no decisions)
        if (this.aggregator) {
            const aggregation = this.aggregator.aggregate(alert);
            // Emit aggregation to RiskEngine for decision-making
            this.emit('threat:aggregation', { alert, aggregation });
        } else {
            // Fallback: emit raw alert if aggregator not initialized
            this.emit('threat:alert', alert);
        }
    }

    private emitValidationComplete(result: ValidationResult): void {
        this.emit('validation:complete', result);

        const key: string = `${result.chain}:${result.pair}`;
        this.validationCache.set(key, result);
    }
}

export function createValidatorAgent(config: ValidatorConfig): ValidatorAgent {
    return new ValidatorAgent(config);
}