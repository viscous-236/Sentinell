/**
 * LP Threat Broadcast Types
 * 
 * Types for broadcasting ELEVATED tier threats to LP bots/agents.
 * Threats can be consumed via:
 * 1. On-chain events (SentinelHook.ThreatBroadcast)
 * 2. REST API endpoints
 */

import type { DefenseAction, ThreatTier, ScoredSignal } from '../RiskEngine';

/**
 * Complete threat broadcast message for LP decision-making
 */
export interface LPThreatBroadcast {
  id: string;
  tier: 'ELEVATED';
  action: DefenseAction;
  compositeScore: number;
  targetPool: string;
  chain: string;
  pair: string;
  timestamp: number;
  expiresAt: number;
  
  // Complete threat details for LP decision-making
  threatDetails: {
    rationale: string;
    contributingSignals: ScoredSignal[];
    signalTypes: string[];
    correlationWindow: number;
    recommendedAction: string;
  };
  
  // Risk metrics
  riskMetrics: {
    severity: number;      // 0-100
    confidence: number;    // 0-100
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  
  // Suggested LP actions
  suggestedActions: {
    withdrawLiquidity?: boolean;
    reduceLiquidity?: number; // percentage (0-100)
    pauseNewPositions?: boolean;
    increaseSlippage?: number; // basis points
  };
}

/**
 * On-chain event parameters (matches SentinelHook.ThreatBroadcast event)
 */
export interface OnChainThreatEvent {
  poolId: string;          // bytes32
  tier: string;            // "ELEVATED"
  action: string;          // "MEV_PROTECTION", "ORACLE_VALIDATION", etc.
  compositeScore: bigint;  // 0-100
  timestamp: bigint;
  expiresAt: bigint;
  rationale: string;
  signalTypes: string[];
}

/**
 * Threat cache entry for REST API
 */
export interface CachedThreat extends LPThreatBroadcast {
  onChainTxHash?: string;  // Transaction hash of broadcast
  broadcastedAt: number;   // When it was broadcast
}
