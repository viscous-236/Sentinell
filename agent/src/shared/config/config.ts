/**
 * Sentinel Agent Configuration Loader
 * 
 * Loads configuration from environment variables for all agent components.
 * Per PROJECT_SPEC.md, supports Yellow Network, Scout, Validator, and RiskEngine config.
 */

import { YellowConfig } from '../yellow/types';
import type { RiskEngineConfig } from '../../executor/src/RiskEngine';

// Scout configuration interface
export interface ScoutConfig {
    chains: string[];
    mempoolEnabled: boolean;
    dexEnabled: boolean;
    gasEnabled: boolean;
    flashLoanEnabled: boolean;
    pollIntervalMs: number;
}

// Validator configuration interface  
export interface ValidatorConfig {
    chains: string[];
    oracleEnabled: boolean;
    crossChainEnabled: boolean;
    deviationThreshold: number;
    pollIntervalMs: number;
}

// Full Sentinel configuration
export interface SentinelConfig {
    yellow: YellowConfig;
    riskEngine: RiskEngineConfig;
    scout: ScoutConfig;
    validator: ValidatorConfig;
}

/**
 * Load configuration from environment variables
 * Falls back to sensible defaults for development/testing
 */
export function loadConfigFromEnv(): SentinelConfig {
    const privateKey = process.env.YELLOW_PRIVATE_KEY || process.env.PRIVATE_KEY;

    if (!privateKey) {
        throw new Error('YELLOW_PRIVATE_KEY or PRIVATE_KEY environment variable required');
    }

    // Derive agent address from private key
    const agentAddress = process.env.AGENT_ADDRESS || deriveAddress(privateKey);

    return {
        yellow: {
            endPoint: process.env.YELLOW_ENDPOINT || 'wss://clearnet-sandbox.yellow.com/ws',
            agentAddress,
            privateKey: privateKey as `0x${string}`,
            rpcUrl: process.env.RPC_URL || process.env.ALCHEMY_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo',
            network: (process.env.YELLOW_NETWORK as 'sandbox' | 'production') || 'sandbox',
        },

        riskEngine: {
            correlationWindowMs: parseInt(process.env.CORRELATION_WINDOW_MS || '24000'),
            emaAlpha: parseFloat(process.env.EMA_ALPHA || '0.1'),
            rpcBudget: {
                maxCalls: parseInt(process.env.RPC_MAX_CALLS || '100'),
                refillIntervalMs: parseInt(process.env.RPC_REFILL_MS || '60000'),
            },
        },

        scout: {
            chains: (process.env.SCOUT_CHAINS || 'ethereum,base').split(','),
            mempoolEnabled: process.env.SCOUT_MEMPOOL !== 'false',
            dexEnabled: process.env.SCOUT_DEX !== 'false',
            gasEnabled: process.env.SCOUT_GAS !== 'false',
            flashLoanEnabled: process.env.SCOUT_FLASHLOAN !== 'false',
            pollIntervalMs: parseInt(process.env.SCOUT_POLL_MS || '12000'),
        },

        validator: {
            chains: (process.env.VALIDATOR_CHAINS || 'ethereum,base').split(','),
            oracleEnabled: process.env.VALIDATOR_ORACLE !== 'false',
            crossChainEnabled: process.env.VALIDATOR_CROSSCHAIN !== 'false',
            deviationThreshold: parseFloat(process.env.VALIDATOR_DEVIATION_THRESHOLD || '0.05'),
            pollIntervalMs: parseInt(process.env.VALIDATOR_POLL_MS || '30000'),
        },
    };
}

/**
 * Derive Ethereum address from private key (simple implementation)
 */
function deriveAddress(privateKey: string): string {
    // In production, use viem or ethers to properly derive
    // For now, return placeholder that will be overwritten
    try {
        const { privateKeyToAccount } = require('viem/accounts');
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        return account.address;
    } catch {
        throw new Error('Unable to derive address from private key. Set AGENT_ADDRESS explicitly.');
    }
}

/**
 * Validate configuration
 */
export function validateConfig(config: SentinelConfig): void {
    if (!config.yellow.privateKey.startsWith('0x')) {
        throw new Error('Private key must start with 0x');
    }
    if (config.yellow.privateKey.length !== 66) {
        throw new Error('Private key must be 64 hex characters (32 bytes) + 0x prefix');
    }
    if (!config.yellow.agentAddress.startsWith('0x')) {
        throw new Error('Agent address must start with 0x');
    }
    console.log('✅ Configuration validated');
}
