/**
 * Dashboard State Manager
 * 
 * Aggregates real-time data from all Sentinel agents for dashboard consumption.
 * Tracks scout logs, risk engine decisions, executions, and price/gas history.
 */

import { EventEmitter } from 'events';
import type { RiskDecision } from '../RiskEngine';
import type { ScoutSignal, ScoutSignalType } from '../../../scout/src/types';

// ============================================================================
// Types
// ============================================================================

export interface DashboardLogEntry {
  id: string;
  timestamp: number;
  level: 'INFO' | 'WARN' | 'SIGNAL' | 'ERROR' | 'SUCCESS';
  source: 'scout' | 'validator' | 'riskengine' | 'executor' | 'yellow';
  message: string;
  data?: Record<string, unknown>;
}

export interface ExecutionEntry {
  id: string;
  timestamp: number;
  chain: string;
  action: string;
  poolId: string;
  txHash: string;
  status: 'pending' | 'success' | 'failed';
  tier: string;
  score: number;
}

export interface GasDataPoint {
  timestamp: number;
  chain: string;
  gasPrice: number; // in gwei
}

export interface PriceDataPoint {
  timestamp: number;
  pair: string;
  price: number;
  source: 'pyth' | 'chainlink' | 'dex';
}

export interface HysteresisState {
  poolId: string;
  tier: 'WATCH' | 'ELEVATED' | 'CRITICAL';
  score: number;
  timestamp: number;
}

export interface YellowChannelState {
  connected: boolean;
  sessionId: string | null;
  messagesCount: number;
  authorizationsCount: number;
  lastSignature: {
    poolId: string;
    signature: string;
    timestamp: number;
  } | null;
}

/**
 * E2E Flow Tracking - Scout → Yellow → Validator → Risk Engine → Executor → Settlement
 */
export type FlowStage = 'scout_signal' | 'yellow_session' | 'validator_alert' | 'risk_decision' | 'executor_action' | 'settlement';

export interface FlowStageData {
  stage: FlowStage;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface E2EFlow {
  id: string;
  startTime: number;
  chain: string;
  poolId: string;
  stages: FlowStageData[];
  currentStage: FlowStage;
  settlementTxHash?: string; // Final on-chain settlement
  status: 'active' | 'completed' | 'failed';
}

export interface DashboardSnapshot {
  status: 'running' | 'stopped' | 'error';
  uptime: number;
  logs: DashboardLogEntry[];
  executions: ExecutionEntry[];
  riskScore: {
    current: number;
    tier: string;
    contributingSignals: number;
  };
  gasHistory: GasDataPoint[];
  priceHistory: PriceDataPoint[];
  hysteresisHistory: HysteresisState[];
  yellowChannel: YellowChannelState;
  e2eFlows: E2EFlow[]; // Active E2E flows
}

// ============================================================================
// Dashboard State Manager
// ============================================================================

export class DashboardState extends EventEmitter {
  private startTime: number;
  private status: 'running' | 'stopped' | 'error' = 'stopped';
  
  // Data stores with limits
  private logs: DashboardLogEntry[] = [];
  private readonly MAX_LOGS = 200;
  
  private executions: ExecutionEntry[] = [];
  private readonly MAX_EXECUTIONS = 100;
  
  private gasHistory: GasDataPoint[] = [];
  private readonly MAX_GAS_POINTS = 50;
  
  private priceHistory: PriceDataPoint[] = [];
  private readonly MAX_PRICE_POINTS = 100;
  
  private hysteresisHistory: HysteresisState[] = [];
  private readonly MAX_HYSTERESIS_POINTS = 50;
  
  // Current state
  private currentRiskScore = 0;
  private currentTier = 'WATCH';
  private contributingSignals = 0;
  
  // Yellow channel state
  private yellowChannel: YellowChannelState = {
    connected: false,
    sessionId: null,
    messagesCount: 0,
    authorizationsCount: 0,
    lastSignature: null,
  };

  // E2E Flow Tracking
  private e2eFlows: Map<string, E2EFlow> = new Map();
  private readonly MAX_FLOWS = 20;

  constructor() {
    super();
    this.startTime = Date.now();
  }

  // ============================================================================
  // State Management
  // ============================================================================

  start(): void {
    this.status = 'running';
    this.startTime = Date.now();
    this.addLog('INFO', 'system', 'Dashboard state manager started');
  }

  stop(): void {
    this.status = 'stopped';
    this.addLog('INFO', 'system', 'Dashboard state manager stopped');
  }

  // ============================================================================
  // Log Management
  // ============================================================================

  addLog(
    level: DashboardLogEntry['level'],
    source: DashboardLogEntry['source'] | 'system',
    message: string,
    data?: Record<string, unknown>
  ): void {
    const entry: DashboardLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      level,
      source: source === 'system' ? 'scout' : source,
      message,
      data,
    };

    this.logs.push(entry);
    
    // Trim to max size
    if (this.logs.length > this.MAX_LOGS) {
      this.logs = this.logs.slice(-this.MAX_LOGS);
    }

    this.emit('log', entry);
  }

  getLogs(limit = 100): DashboardLogEntry[] {
    return this.logs.slice(-limit);
  }

  // ============================================================================
  // Scout Signal Ingestion
  // ============================================================================

  ingestScoutSignal(signal: ScoutSignal): void {
    this.addLog('SIGNAL', 'scout', `${signal.type} on ${signal.chain}`, {
      pair: signal.pair,
      magnitude: signal.magnitude,
      poolAddress: signal.poolAddress,
    });
  }

  // ============================================================================
  // Risk Engine Updates
  // ============================================================================

  updateRiskScore(decision: RiskDecision): void {
    this.currentRiskScore = decision.compositeScore;
    this.currentTier = decision.tier;
    this.contributingSignals = decision.contributingSignals.length;

    // Track hysteresis
    const hysteresisEntry: HysteresisState = {
      poolId: decision.targetPool,
      tier: decision.tier as 'WATCH' | 'ELEVATED' | 'CRITICAL',
      score: decision.compositeScore,
      timestamp: Date.now(),
    };
    
    this.hysteresisHistory.push(hysteresisEntry);
    if (this.hysteresisHistory.length > this.MAX_HYSTERESIS_POINTS) {
      this.hysteresisHistory = this.hysteresisHistory.slice(-this.MAX_HYSTERESIS_POINTS);
    }

    this.addLog(
      decision.tier === 'CRITICAL' ? 'ERROR' : decision.tier === 'ELEVATED' ? 'WARN' : 'INFO',
      'riskengine',
      `Decision: ${decision.action} (${decision.tier}) Score: ${decision.compositeScore.toFixed(1)}`,
      { action: decision.action, tier: decision.tier, score: decision.compositeScore }
    );

    this.emit('riskUpdate', { score: this.currentRiskScore, tier: this.currentTier });
  }

  getRiskScore(): { current: number; tier: string; contributingSignals: number } {
    return {
      current: this.currentRiskScore,
      tier: this.currentTier,
      contributingSignals: this.contributingSignals,
    };
  }

  getHysteresisHistory(): HysteresisState[] {
    return [...this.hysteresisHistory];
  }

  // ============================================================================
  // Execution Tracking
  // ============================================================================

  addExecution(
    chain: string,
    action: string,
    poolId: string,
    txHash: string,
    tier: string,
    score: number,
    status: 'pending' | 'success' | 'failed' = 'pending'
  ): string {
    const id = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const entry: ExecutionEntry = {
      id,
      timestamp: Date.now(),
      chain,
      action,
      poolId,
      txHash,
      status,
      tier,
      score,
    };

    this.executions.push(entry);
    
    if (this.executions.length > this.MAX_EXECUTIONS) {
      this.executions = this.executions.slice(-this.MAX_EXECUTIONS);
    }

    this.addLog('SUCCESS', 'executor', `Execution: ${action} on ${chain}`, {
      txHash,
      poolId,
    });

    this.emit('execution', entry);
    return id;
  }

  updateExecutionStatus(id: string, status: 'success' | 'failed'): void {
    const exec = this.executions.find(e => e.id === id);
    if (exec) {
      exec.status = status;
      this.emit('executionUpdate', exec);
    }
  }

  getExecutions(limit = 50): ExecutionEntry[] {
    return this.executions.slice(-limit);
  }

  // ============================================================================
  // Gas Price Tracking
  // ============================================================================

  addGasDataPoint(chain: string, gasPrice: number): void {
    const point: GasDataPoint = {
      timestamp: Date.now(),
      chain,
      gasPrice,
    };

    this.gasHistory.push(point);
    
    if (this.gasHistory.length > this.MAX_GAS_POINTS) {
      this.gasHistory = this.gasHistory.slice(-this.MAX_GAS_POINTS);
    }

    this.emit('gasUpdate', point);
  }

  getGasHistory(chain?: string): GasDataPoint[] {
    if (chain) {
      return this.gasHistory.filter(p => p.chain === chain);
    }
    return [...this.gasHistory];
  }

  // ============================================================================
  // Price Tracking (Pyth/Chainlink)
  // ============================================================================

  addPriceDataPoint(pair: string, price: number, source: 'pyth' | 'chainlink' | 'dex'): void {
    const point: PriceDataPoint = {
      timestamp: Date.now(),
      pair,
      price,
      source,
    };

    this.priceHistory.push(point);
    
    if (this.priceHistory.length > this.MAX_PRICE_POINTS) {
      this.priceHistory = this.priceHistory.slice(-this.MAX_PRICE_POINTS);
    }

    this.emit('priceUpdate', point);
  }

  getPriceHistory(pair?: string): PriceDataPoint[] {
    if (pair) {
      return this.priceHistory.filter(p => p.pair === pair);
    }
    return [...this.priceHistory];
  }

  // ============================================================================
  // Yellow Channel State
  // ============================================================================

  updateYellowChannel(updates: Partial<YellowChannelState>): void {
    this.yellowChannel = { ...this.yellowChannel, ...updates };
    
    if (updates.connected !== undefined) {
      this.addLog(
        updates.connected ? 'SUCCESS' : 'WARN',
        'yellow',
        updates.connected ? 'Yellow Network connected' : 'Yellow Network disconnected'
      );
    }

    this.emit('yellowUpdate', this.yellowChannel);
  }

  incrementYellowMessages(): void {
    this.yellowChannel.messagesCount++;
    this.emit('yellowUpdate', this.yellowChannel);
  }

  incrementYellowAuthorizations(): void {
    this.yellowChannel.authorizationsCount++;
    this.emit('yellowUpdate', this.yellowChannel);
  }

  setLastSignature(poolId: string, signature: string): void {
    this.yellowChannel.lastSignature = {
      poolId,
      signature,
      timestamp: Date.now(),
    };
    this.emit('yellowUpdate', this.yellowChannel);
  }

  getYellowChannelState(): YellowChannelState {
    return { ...this.yellowChannel };
  }

  // ============================================================================
  // E2E Flow Tracking Methods
  // ============================================================================

  /**
   * Start a new E2E flow (triggered by Scout signal)
   */
  startE2EFlow(chain: string, poolId: string, signalData?: Record<string, unknown>): string {
    const flowId = `flow_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const flow: E2EFlow = {
      id: flowId,
      startTime: Date.now(),
      chain,
      poolId,
      stages: [{
        stage: 'scout_signal',
        timestamp: Date.now(),
        data: signalData,
      }],
      currentStage: 'scout_signal',
      status: 'active',
    };

    this.e2eFlows.set(flowId, flow);

    // Limit size
    if (this.e2eFlows.size > this.MAX_FLOWS) {
      const oldest = Array.from(this.e2eFlows.keys())[0];
      this.e2eFlows.delete(oldest);
    }

    this.emit('flowStarted', flow);
    return flowId;
  }

  /**
   * Update E2E flow to next stage
   */
  updateE2EFlowStage(flowId: string, stage: FlowStage, stageData?: Record<string, unknown>): void {
    const flow = this.e2eFlows.get(flowId);
    if (!flow) return;

    flow.stages.push({
      stage,
      timestamp: Date.now(),
      data: stageData,
    });
    flow.currentStage = stage;

    this.emit('flowUpdated', flow);
  }

  /**
   * Complete E2E flow with settlement TX hash
   */
  completeE2EFlow(flowId: string, settlementTxHash: string): void {
    const flow = this.e2eFlows.get(flowId);
    if (!flow) return;

    flow.settlementTxHash = settlementTxHash;
    flow.status = 'completed';
    flow.stages.push({
      stage: 'settlement',
      timestamp: Date.now(),
      data: { txHash: settlementTxHash },
    });
    flow.currentStage = 'settlement';

    this.emit('flowCompleted', flow);
  }

  /**
   * Mark E2E flow as failed
   */
  failE2EFlow(flowId: string, error: string): void {
    const flow = this.e2eFlows.get(flowId);
    if (!flow) return;

    flow.status = 'failed';
    this.emit('flowFailed', { flow, error });
  }

  /**
   * Get all E2E flows
   */
  getE2EFlows(): E2EFlow[] {
    return Array.from(this.e2eFlows.values());
  }

  // ============================================================================
  // Full Snapshot
  // ============================================================================

  getSnapshot(): DashboardSnapshot {
    return {
      status: this.status,
      uptime: Date.now() - this.startTime,
      logs: this.getLogs(100),
      executions: this.getExecutions(50),
      riskScore: this.getRiskScore(),
      gasHistory: this.getGasHistory(),
      priceHistory: this.getPriceHistory(),
      hysteresisHistory: this.getHysteresisHistory(),
      yellowChannel: this.getYellowChannelState(),
      e2eFlows: this.getE2EFlows(),
    };
  }
}

// Singleton instance
export const dashboardState = new DashboardState();
