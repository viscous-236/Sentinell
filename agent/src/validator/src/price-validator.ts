import { ScoutPriceData, CrossChainValidation } from "./validator";

export interface PriceValidatorConfig {
    crosschainDeviation: number;
    minChainsRequired: number;
    priceAgeThreshold: number;
}

interface ChainPriceSnapshot {
    chain: string;
    price: string;
    timestamp: number;
    source: string;
}

export class PriceValidator {
    private config: PriceValidatorConfig;
    private priceCache: Map<string, Map<string, ChainPriceSnapshot>>;

    constructor(config: PriceValidatorConfig) {
        this.config = config;
        this.priceCache = new Map();
    }

    updatePriceSnapshot(priceData: ScoutPriceData): void {
        const { pair, chain, price, timestamp, source } = priceData;

        if (!this.priceCache.has(pair)) {
            this.priceCache.set(pair, new Map());
        }

        const chainPrices = this.priceCache.get(pair)!;
        chainPrices.set(chain, { chain, price, timestamp, source });
    }

    validateCrossChainConsistency(pair: string): CrossChainValidation | null {
        const chainPrices = this.priceCache.get(pair);
        if (!chainPrices || chainPrices.size === 0) {
            console.warn(`⚠️ PriceValidator: No price data for ${pair}`);
            return null;
        }

        const validSnapshots = this.filterStaleSnapshots(Array.from(chainPrices.values()));

        if (validSnapshots.length < this.config.minChainsRequired) {
            console.warn(
                `⚠️ PriceValidator: Insufficient chains for ${pair} (${validSnapshots.length}/${this.config.minChainsRequired})`
            );
            return null;
        }

        const prices: { [chain: string]: string } = {};

        const priceValues: number[] = [];

        for (const snapshot of validSnapshots) {
            prices[snapshot.chain] = snapshot.price;
            priceValues.push(parseFloat(snapshot.price));
        }
        const maxDeviation = this.calculateMaxDeviation(priceValues);
        const isConsistent = maxDeviation <= this.config.crosschainDeviation;

        const validation: CrossChainValidation = {
            pair,
            chains: validSnapshots.map(s => s.chain),
            prices,
            maxDeviation,
            consistent: isConsistent,
            timestamp: Date.now(),
        };

        if (!isConsistent) {
            console.log(`🚨 PriceValidator: Cross-chain inconsistency detected for ${pair}:`, {
                maxDeviation: `${maxDeviation.toFixed(2)} bp`,
                threshold: `${this.config.crosschainDeviation} bp`,
                prices,
            });
        }
        return validation;
    }

    getCrossChainSnapshot(pair: string): {
        pair: string;
        snapshots: ChainPriceSnapshot[];
        timestamp: number;
    } | null {
        const chainPrices = this.priceCache.get(pair);
        if (!chainPrices || chainPrices.size === 0) {
            return null;
        }
        const validSnapshots = this.filterStaleSnapshots(Array.from(chainPrices.values()));
        return {
            pair,
            snapshots: validSnapshots,
            timestamp: Date.now(),
        };
    }

    private calculateMaxDeviation(prices: number[]): number {
        if (prices.length <= 1) return 0;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        const deviation = ((max - min) / avg) * 10000;
        return deviation;
    }

    private filterStaleSnapshots(snapshots: ChainPriceSnapshot[]): ChainPriceSnapshot[] {
        const now = Date.now();
        return snapshots.filter(snapshot => {
            const age = now - snapshot.timestamp;
            return age <= this.config.priceAgeThreshold;
        });
    }

    getPriceStatistics(pair: string): {
        pair: string;
        count: number;
        min: number;
        max: number;
        avg: number;
        median: number;
        deviation: number;
    } | null {
        const chainPrices = this.priceCache.get(pair);
        if (!chainPrices || chainPrices.size === 0) {
            return null;
        }
        const validSnapshots = this.filterStaleSnapshots(Array.from(chainPrices.values()));
        if (validSnapshots.length === 0) {
            return null;
        }
        const priceValues = validSnapshots.map(s => parseFloat(s.price));
        priceValues.sort((a, b) => a - b);
        const min = priceValues[0];
        const max = priceValues[priceValues.length - 1];
        const avg = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
        const median =
            priceValues.length % 2 === 0
                ? (priceValues[priceValues.length / 2 - 1] + priceValues[priceValues.length / 2]) / 2
                : priceValues[Math.floor(priceValues.length / 2)];
        const deviation = this.calculateMaxDeviation(priceValues);
        return {
            pair,
            count: priceValues.length,
            min,
            max,
            avg,
            median,
            deviation,
        };
    }

    clearStalePrices(): void {
        for (const [pair, chainPrices] of this.priceCache.entries()) {
            const validSnapshots = this.filterStaleSnapshots(Array.from(chainPrices.values()));
            if (validSnapshots.length === 0) {
                this.priceCache.delete(pair);
            } else {
                const newMap = new Map<string, ChainPriceSnapshot>();
                for (const snapshot of validSnapshots) {
                    newMap.set(snapshot.chain, snapshot);
                }
                this.priceCache.set(pair, newMap);
            }
        }
    }

    getMonitoredPairs(): string[] {
        return Array.from(this.priceCache.keys());
    }

    hasSufficientCoverage(pair: string): boolean {
        const chainPrices = this.priceCache.get(pair);
        if (!chainPrices) return false;
        const validSnapshots = this.filterStaleSnapshots(Array.from(chainPrices.values()));
        return validSnapshots.length >= this.config.minChainsRequired;
    }
}

export function createPriceValidator(config: PriceValidatorConfig): PriceValidator {
    return new PriceValidator(config);
}