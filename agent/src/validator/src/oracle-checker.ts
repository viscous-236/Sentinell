import { ethers } from "ethers";
import type { ScoutPriceData, ValidationResult } from "./validator";
import { HermesClient } from "@pythnetwork/hermes-client";


interface ChainlinkPrice {
    price: string;
    decimals: number;
    updatedAt: number;
    roundId: number;
    stale: boolean;
}

interface PythPrice {
    price: string;
    confidence: string;
    expo: number;
    publishTime: number;
    stale: boolean;
}

interface OracleAggregation {
    pair: string;
    chain: string;
    chainlinkPrice?: ChainlinkPrice;
    pythPrice?: PythPrice;
    consensusPrice: string;
    confidence: 'high' | 'medium' | 'low';
    timestamp: number;
}


export interface OracleCheckerConfig {
    pythEndpoint?: string;
    pythPriceIds: {
        ethereum: { [pair: string]: string };
        base: { [pair: string]: string };
        arbitrum: { [pair: string]: string };
    };
    staleThreshold: number;
    minOraclesRequired: number;
}

export class OracleChecker {
    private providers: Map<string, ethers.Provider>;
    private chainlinkFeeds: {
        ethereum: { [pair: string]: string; };
        base: { [pair: string]: string; };
        arbitrum: { [pair: string]: string; };
    }
    private pythPriceIds: {
        ethereum: { [pair: string]: string };
        base: { [pair: string]: string };
        arbitrum: { [pair: string]: string };
    };
    private deviationThreshold: number;
    private staleThreshold: number;
    private minOraclesRequired: number;
    private pythConnection?: HermesClient;

    private chainlinkABI = [
        "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
        "function decimals() external view returns (uint8)"
    ];

    constructor(
        providers: Map<string, ethers.Provider>,
        chainlinkFeeds: {
            ethereum: { [pair: string]: string };
            base: { [pair: string]: string };
            arbitrum: { [pair: string]: string };
        },
        config: OracleCheckerConfig,
        deviationThreshold: number
    ) {
        this.providers = providers;
        this.chainlinkFeeds = chainlinkFeeds;
        this.pythPriceIds = config.pythPriceIds;
        this.deviationThreshold = deviationThreshold;
        this.staleThreshold = config.staleThreshold || 3600;
        this.minOraclesRequired = config.minOraclesRequired || 1;
        if (config.pythEndpoint) {
            this.pythConnection = new HermesClient(config.pythEndpoint);
            console.log(`✅ OracleChecker: Connected to Pyth at ${config.pythEndpoint}`);
        }
    }

    async validateAgainstOracles(priceData: ScoutPriceData): Promise<ValidationResult> {
        const { pair, chain, price: dexPrice } = priceData;

        try {
            const oracleData = await this.getOracleAggregation(chain, pair);
            if (!oracleData.consensusPrice) {
                console.warn(`⚠️ OracleChecker: No valid oracle data for ${pair} on ${chain}`);
                return {
                    pair,
                    chain,
                    valid: true, // Skip validation if no oracle data
                    oraclePrice: '0',
                    dexPrice,
                    deviation: 0,
                    timestamp: Date.now(),
                    reason: 'No oracle data available'
                };
            }

            const deviation = this.calculateDeviation(
                oracleData.consensusPrice,
                dexPrice
            );
            const isValid = deviation <= this.deviationThreshold;
            const result: ValidationResult = {
                pair,
                chain,
                valid: isValid,
                oraclePrice: oracleData.consensusPrice,
                dexPrice,
                deviation,
                timestamp: Date.now(),
                reason: isValid
                    ? undefined
                    : `Deviation ${deviation.toFixed(2)}% exceeds threshold ${this.deviationThreshold}%`
            };

            if (!isValid) {
                console.log('🚨 OracleChecker: Oracle manipulation suspected:', {
                    pair,
                    chain,
                    oraclePrice: oracleData.consensusPrice,
                    dexPrice,
                    deviation: `${deviation.toFixed(2)}%`,
                    confidence: oracleData.confidence,
                    attestationRequired: true
                });
            }
            return result;
        } catch (error) {
            console.error('❌ OracleChecker: Validation error:', error);
            return {
                pair,
                chain,
                valid: true, // Don't block on errors
                oraclePrice: '0',
                dexPrice,
                deviation: 0,
                timestamp: Date.now(),
                reason: `Oracle check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getOracleAggregation(chain: 'ethereum' | 'base' | 'arbitrum', pair: string): Promise<OracleAggregation> {
        const results: OracleAggregation = {
            pair,
            chain,
            consensusPrice: '0',
            confidence: 'low',
            timestamp: Date.now()
        };

        const validPrices: number[] = [];

        try {
            const chainlinkPrice = await this.getChainlinkPrice(chain, pair);
            if (chainlinkPrice && !chainlinkPrice.stale) {
                results.chainlinkPrice = chainlinkPrice;
                validPrices.push(parseFloat(chainlinkPrice.price));
            }
        } catch (error) {
            console.warn(`⚠️ Chainlink fetch failed for ${pair} on ${chain}:`, error);
        }

        try {
            const pythPrice = await this.getPythPrice(chain, pair);
            if (pythPrice && !pythPrice.stale) {
                results.pythPrice = pythPrice;
                validPrices.push(parseFloat(pythPrice.price));
            }
        } catch (error) {
            console.warn(`⚠️ Pyth fetch failed for ${pair} on ${chain}:`, error);
        }

        if (validPrices.length >= this.minOraclesRequired) {
            results.consensusPrice = this.calculateConsensusPrice(validPrices);
            results.confidence = this.determineConfidence(validPrices.length, validPrices);
        }

        return results;
    }

    private async getChainlinkPrice(
        chain: 'ethereum' | 'base' | 'arbitrum',
        pair: string
    ): Promise<ChainlinkPrice | null> {
        const feedAddress = this.chainlinkFeeds[chain]?.[pair];
        if (!feedAddress) {
            return null;
        }
        const provider = this.providers.get(chain);
        if (!provider) {
            throw new Error(`No provider for chain: ${chain}`);
        }
        const aggregator = new ethers.Contract(feedAddress, this.chainlinkABI, provider);
        const [roundId, answer, , updatedAt] = await aggregator.latestRoundData();
        const decimals = await aggregator.decimals();
        const currentTime = Math.floor(Date.now() / 1000);
        const isStale = currentTime - Number(updatedAt) > this.staleThreshold;
        const price = ethers.formatUnits(answer, decimals);
        return {
            price,
            decimals,
            updatedAt: Number(updatedAt),
            roundId: Number(roundId),
            stale: isStale
        };
    }

    private async getPythPrice(
        chain: 'ethereum' | 'base' | 'arbitrum',
        pair: string
    ): Promise<PythPrice | null> {
        if (!this.pythConnection) {
            return null;
        }
        const priceId = this.pythPriceIds[chain]?.[pair];
        if (!priceId) {
            return null;
        }

        try {
            const priceUpdate = await this.pythConnection.getLatestPriceUpdates(
                [priceId],
                { parsed: true }
            );

            if (!priceUpdate.parsed || priceUpdate.parsed.length === 0) {
                return null;
            }

            const parsedPrice = priceUpdate.parsed[0];
            const priceData = parsedPrice.price;

            const currentTime = Math.floor(Date.now() / 1000);
            const isStale = currentTime - priceData.publish_time > this.staleThreshold;

            // Convert Pyth price to standard format (account for exponent)
            const price = (Number(priceData.price) * Math.pow(10, priceData.expo)).toString();

            return {
                price,
                confidence: priceData.conf,
                expo: priceData.expo,
                publishTime: priceData.publish_time,
                stale: isStale
            };
        } catch (error) {
            console.warn(`⚠️ Failed to fetch Pyth price for ${pair} on ${chain}:`, error);
            return null;
        }
    }

    private calculateConsensusPrice(prices: number[]): string {
        if (prices.length === 0) return '0';
        if (prices.length === 1) return prices[0].toString();
        const sorted = [...prices].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
        return median.toString();
    }

    private determineConfidence(
        oracleCount: number,
        prices: number[]
    ): 'high' | 'medium' | 'low' {
        if (oracleCount < this.minOraclesRequired) return 'low';
        if (oracleCount === 1) return 'medium';
        // Check if oracles agree within 1%
        const deviation = this.calculatePriceSpread(prices);
        if (deviation < 1) return 'high';
        if (deviation < 3) return 'medium';
        return 'low';
    }

    private calculatePriceSpread(prices: number[]): number {
        if (prices.length <= 1) return 0;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return ((max - min) / avg) * 100;
    }

    private calculateDeviation(oraclePrice: string, dexPrice: string): number {
        const oracle = parseFloat(oraclePrice);
        const dex = parseFloat(dexPrice);
        if (oracle === 0 || dex === 0) return 0;
        const diff = Math.abs(oracle - dex);
        const avg = (oracle + dex) / 2;
        return (diff / avg) * 100; // Percentage deviation
    }

    async getOracleHealth(
        chain: 'ethereum' | 'base' | 'arbitrum',
        pair: string
    ): Promise<{
        healthy: boolean;
        chainlinkHealthy: boolean;
        pythHealthy: boolean;
        lastUpdate: number;
    }> {
        const oracleData = await this.getOracleAggregation(chain, pair);
        const chainlinkHealthy = !!(oracleData.chainlinkPrice && !oracleData.chainlinkPrice.stale);
        const pythHealthy = !!(oracleData.pythPrice && !oracleData.pythPrice.stale);
        return {
            healthy: chainlinkHealthy || pythHealthy,
            chainlinkHealthy,
            pythHealthy,
            lastUpdate: oracleData.timestamp
        };
    }

    async prepareAttestationData(validationResult: ValidationResult): Promise<{
        eventType: 'ORACLE_VALIDATION';
        payload: ValidationResult;
        timestamp: number;
        requiresAttestation: boolean;
    }> {
        return {
            eventType: 'ORACLE_VALIDATION',
            payload: validationResult,
            timestamp: Date.now(),
            requiresAttestation: !validationResult.valid // Attest manipulation events
        };
    }
}

export function createOracleChecker(
    providers: Map<string, ethers.Provider>,
    chainlinkFeeds: {
        ethereum: { [pair: string]: string };
        base: { [pair: string]: string };
        arbitrum: { [pair: string]: string };
    },
    config: OracleCheckerConfig,
    deviationThreshold: number
): OracleChecker {
    return new OracleChecker(providers, chainlinkFeeds, config, deviationThreshold);
}