/**
 * Sentinel Risk Engine
 *
 * Replaces the flat linear-severity model in validator.ts with:
 *   1. Adaptive thresholds via Exponential Moving Average (EMA) that track
 *      per-pair volatility — quiet markets get tighter bounds, volatile ones
 *      get wider bounds automatically.
 *   2. A correlation window that fuses Scout signals (flash loan, gas spike,
 *      large swap, price move) into a single composite threat score per pool.
 *      Individual signals are weak; the combination is what triggers action.
 *   3. A 3-tier threat state machine (WATCH → ELEVATED → CRITICAL) with
 *      hysteresis on both transitions so the system doesn't flap.
 *   4. Escalation logic that maps composite scores to exactly one of three
 *      decisions: MEV protection, Oracle validation, or Circuit Breaker.
 *   5. A token-bucket RPC budget tracker so the TEE can run 24/7 on free
 *      RPC tiers without hitting rate limits.
 *
 * Integration contract with existing code:
 *   - Call `riskEngine.ingestScoutEvent(event)` from every Scout emission.
 *   - Call `riskEngine.ingestValidatorAlert(alert)` from every Validator threat alert.
 *   - Listen on `riskEngine.on('decision', handler)` — this is the single
 *     output the Executor needs.
 *   - The RpcBudget instance is exported separately; wire it into Scout's
 *     poll loops to throttle automatically.
 */

import { EventEmitter } from "events";
import type { ScoutSignal, ScoutSignalType } from "../../scout/src/types";



// ---------------------------------------------------------------------------
// 1. TYPES — all public interfaces the engine exposes or consumes
// ---------------------------------------------------------------------------

/** What the Validator already emits — consumed as-is. */
export interface ValidatorThreatSignal {
  type: "ORACLE_MANIPULATION" | "CROSS_CHAIN_INCONSISTENCY";
  chain: string;
  pair?: string; // Optional - will default to "UNKNOWN/UNKNOWN" if not provided
  poolAddress?: string;
  deviation: number; // percentage points
  timestamp: number;
  evidence?: Record<string, unknown>;
}

/** The three actions the Executor knows how to perform. */
export type DefenseAction =
  | "MEV_PROTECTION"       // beforeSwap: bump dynamic fee for this block
  | "ORACLE_VALIDATION"    // beforeSwap: reject swap if oracle deviation > threshold
  | "CIRCUIT_BREAKER"      // pause pool for N blocks
  // Cross-chain defense actions (via LI.FI Orchestrator)
  | "LIQUIDITY_REROUTE"           // Move at-risk liquidity to safer chain
  | "CROSS_CHAIN_ARBITRAGE_BLOCK" // Block detected cross-chain arb exploits
  | "EMERGENCY_BRIDGE";           // Fast exit to safe haven chain


/** Threat tier — drives hysteresis logic. */
export type ThreatTier = "WATCH" | "ELEVATED" | "CRITICAL";

/** The single output the engine emits to the Executor. */
export interface RiskDecision {
  id: string;
  action: DefenseAction;
  tier: ThreatTier;
  compositeScore: number;           // 0-100
  targetPool: string;               // pool address or "chain:pair" key
  chain: string;
  pair: string;
  timestamp: number;
  /** Human-readable explanation of why this decision was made. */
  rationale: string;
  /** The individual signal scores that fed into this decision. */
  contributingSignals: ScoredSignal[];
  /** How long (ms) the defense should remain active. Executor honours this. */
  ttlMs: number;
}

/** A single signal after it has been scored and windowed. */
export interface ScoredSignal {
  source: ScoutSignalType | ValidatorThreatSignal["type"];
  magnitude: number;
  weight: number;
  weightedScore: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 2. CONFIGURATION
// ---------------------------------------------------------------------------

export interface RiskEngineConfig {
  /**
   * Correlation window in milliseconds.
   * Signals outside this window relative to the latest signal are discarded
   * before scoring. Default: 24_000 (≈ 2 ETH blocks).
   */
  correlationWindowMs?: number;

  /**
   * EMA smoothing factor α ∈ (0, 1].
   * Lower = slower adaptation (more stable thresholds).
   * Higher = faster adaptation (tracks volatility closely).
   * Default: 0.1
   */
  emaAlpha?: number;

  /**
   * Base thresholds for each signal type before EMA adaptation kicks in.
   * The EMA-adjusted threshold is: base * (1 + emaMultiplier * normalised_volatility)
   */
  baseThresholds?: Partial<Record<ScoutSignalType | ValidatorThreatSignal["type"], number>>;

  /**
   * Weight assigned to each signal type in the composite score.
   * Must be > 0. They are normalised internally so they don't need to sum to 1.
   */
  signalWeights?: Partial<Record<ScoutSignalType | ValidatorThreatSignal["type"], number>>;

  /**
   * Hysteresis bands for state transitions.
   * upThreshold: composite score must exceed this to move UP a tier.
   * downThreshold: composite score must drop below this to move DOWN a tier.
   * Prevents flapping when the score hovers near a boundary.
   */
  hysteresis?: {
    watchToElevated: { up: number; down: number };
    elevatedToCritical: { up: number; down: number };
  };

  /**
   * TTL (time-to-live) in ms for each defense action once activated.
   * After this window the Executor should consider the action expired
   * unless a new decision refreshes it.
   */
  actionTtl?: {
    MEV_PROTECTION: number;
    ORACLE_VALIDATION: number;
    CIRCUIT_BREAKER: number;
    // Cross-chain action TTLs
    LIQUIDITY_REROUTE?: number;
    CROSS_CHAIN_ARBITRAGE_BLOCK?: number;
    EMERGENCY_BRIDGE?: number;
  };

  /** RPC budget config. See RpcBudget class. */
  rpcBudget?: RpcBudgetConfig;
}

/** Fully resolved config with every field populated. */
interface ResolvedConfig {
  correlationWindowMs: number;
  emaAlpha: number;
  baseThresholds: Record<string, number>;
  signalWeights: Record<string, number>;
  hysteresis: {
    watchToElevated: { up: number; down: number };
    elevatedToCritical: { up: number; down: number };
  };
  actionTtl: {
    MEV_PROTECTION: number;
    ORACLE_VALIDATION: number;
    CIRCUIT_BREAKER: number;
    // Cross-chain action TTLs
    LIQUIDITY_REROUTE: number;
    CROSS_CHAIN_ARBITRAGE_BLOCK: number;
    EMERGENCY_BRIDGE: number;
  };
}

// ---------------------------------------------------------------------------
// 3. EMA THRESHOLD TRACKER — per pool, per signal type
// ---------------------------------------------------------------------------

/**
 * Maintains an exponential moving average of observed magnitudes for a single
 * signal type on a single pool. The adaptive threshold is:
 *
 *   threshold = baseThreshold * (1 + 2 * normalisedEma)
 *
 * where normalisedEma ∈ [0, 1]. In a calm market the threshold stays near the
 * base. In a volatile market it expands up to 3× the base, reducing false
 * positives without manual tuning.
 */
class EmaTracker {
  private ema: number;
  private readonly alpha: number;
  private readonly base: number;
  private sampleCount = 0;

  constructor(baseThreshold: number, alpha: number) {
    this.base = baseThreshold;
    this.alpha = alpha;
    this.ema = baseThreshold; // start at base; first real sample will move it
  }

  /**
   * Feed a new observed magnitude. Returns the current adaptive threshold
   * AFTER updating the EMA.
   */
  update(magnitude: number): number {
    if (this.sampleCount === 0) {
      // First sample — seed the EMA directly instead of blending with stale init.
      this.ema = magnitude;
    } else {
      this.ema = this.alpha * magnitude + (1 - this.alpha) * this.ema;
    }
    this.sampleCount++;
    return this.getThreshold();
  }

  /** Current adaptive threshold without updating. */
  getThreshold(): number {
    // Normalise EMA to [0,1] relative to base. Clamp to avoid negative.
    const normalisedEma = Math.min(1, Math.max(0, this.ema / this.base));
    return this.base * (1 + 2 * normalisedEma);
  }

  get samples(): number {
    return this.sampleCount;
  }
}

// ---------------------------------------------------------------------------
// 4. CORRELATION WINDOW & COMPOSITE SCORER
// ---------------------------------------------------------------------------

/**
 * Holds the sliding window of signals for a single pool and computes the
 * weighted composite score on demand.
 */
class PoolCorrelationWindow {
  private signals: ScoredSignal[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /**
   * Add a scored signal. Automatically evicts anything older than the window
   * relative to `now`.
   */
  add(signal: ScoredSignal, now: number): void {
    this.signals.push(signal);
    this.evict(now);
  }

  /** Remove signals older than the correlation window. */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    this.signals = this.signals.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Compute composite score ∈ [0, 100].
   *
   * Logic:
   *   - Sum all weightedScores in the window.
   *   - The raw sum can exceed 100 when multiple strong signals correlate
   *     (this is intentional — correlation IS the threat).
   *   - Clamp to [0, 100] for the final output.
   *
   * This means: a single FLASH_LOAN at magnitude 0.4 might score 20.
   * But FLASH_LOAN + GAS_SPIKE + LARGE_SWAP within one block scores 75+.
   * That's the "brain" — the composite correlation, not any single signal.
   */
  getCompositeScore(): number {
    const raw = this.signals.reduce((sum, s) => sum + s.weightedScore, 0);
    return Math.min(100, Math.max(0, raw));
  }

  /** All signals currently in the window (for audit / rationale). */
  getSignals(): ScoredSignal[] {
    return [...this.signals];
  }

  /** How many distinct signal types are present in the window. */
  get uniqueSignalTypes(): number {
    return new Set(this.signals.map((s) => s.source)).size;
  }
}

// ---------------------------------------------------------------------------
// 5. THREAT STATE MACHINE WITH HYSTERESIS
// ---------------------------------------------------------------------------

/**
 * Per-pool state machine.  Transitions only when the composite score crosses
 * the hysteresis band — not on every tick.
 *
 *   WATCH  ──(score > watchToElevated.up)──>  ELEVATED
 *   ELEVATED ──(score < watchToElevated.down)──> WATCH
 *   ELEVATED ──(score > elevatedToCritical.up)──> CRITICAL
 *   CRITICAL ──(score < elevatedToCritical.down)──> ELEVATED
 *
 * The down-thresholds are intentionally lower than the up-thresholds so the
 * system stays in the elevated/critical state for a sustained period after
 * the score drops, preventing rapid oscillation.
 */
class ThreatStateMachine {
  private tier: ThreatTier = "WATCH";
  private readonly hysteresis: ResolvedConfig["hysteresis"];

  constructor(hysteresis: ResolvedConfig["hysteresis"]) {
    this.hysteresis = hysteresis;
  }

  /**
   * Feed the current composite score. Returns the new tier (which may be
   * the same as the old one if no transition fired).
   */
  update(score: number): { tier: ThreatTier; transitioned: boolean } {
    const prev = this.tier;

    switch (this.tier) {
      case "WATCH":
        if (score > this.hysteresis.watchToElevated.up) {
          this.tier = "ELEVATED";
        }
        break;

      case "ELEVATED":
        if (score < this.hysteresis.watchToElevated.down) {
          this.tier = "WATCH";
        } else if (score > this.hysteresis.elevatedToCritical.up) {
          this.tier = "CRITICAL";
        }
        break;

      case "CRITICAL":
        if (score < this.hysteresis.elevatedToCritical.down) {
          this.tier = "ELEVATED";
        }
        break;
    }

    return { tier: this.tier, transitioned: this.tier !== prev };
  }

  get currentTier(): ThreatTier {
    return this.tier;
  }
}

// ---------------------------------------------------------------------------
// 6. DECISION MAPPER — composite score + signal mix → DefenseAction
// ---------------------------------------------------------------------------

/**
 * Maps (tier, compositeScore, signalMix) → DefenseAction.
 *
 * The mapping prioritizes keeping the pool operational while protecting LPs:
 *
 * STRATEGY:
 *   • MEV_PROTECTION (dynamic fees): First line of defense for MEV attacks
 *     - Sandwich, frontrun, JIT liquidity
 *     - Toxic arbitrage: Moderate oracle deviation (<30%) + MEV patterns
 *     - Scales fees 32-200 bps based on threat score (0.32%-2%)
 *     - Higher fees make attacks unprofitable while benefiting LPs
 *     - Keeps pool operational
 *
 *   • ORACLE_VALIDATION: For significant price manipulation (30-75% deviation)
 *     - Rejects swaps when Chainlink/TWAP deviation exceeds threshold
 *     - Prevents LP drainage from stale/manipulated prices
 *     - Used when oracle is the primary attack vector
 *
 *   • CIRCUIT_BREAKER: Nuclear option for catastrophic scenarios
 *     - Extreme oracle deviation (>75%) that would definitely drain LPs, OR
 *     - Multi-vector attack: oracle manipulation + 4+ correlated MEV signals
 *     - Completely pauses the pool
 *     - Use sparingly - loses trading fees and user experience
 *
 * SIGNAL INTERPRETATION:
 *   • ORACLE_MANIPULATION / CROSS_CHAIN_INCONSISTENCY → Oracle validation
 *   • FLASH_LOAN / GAS_SPIKE / LARGE_SWAP / MEMPOOL_CLUSTER → MEV protection
 *   • CROSS_CHAIN_ATTACK → Cross-chain defenses (reroute, arbitrage block)
 */
function mapToDefenseAction(
  tier: ThreatTier,
  compositeScore: number,
  signals: ScoredSignal[],
): { action: DefenseAction; rationale: string } | null {
  // WATCH tier → no action needed, system is just monitoring
  if (tier === "WATCH") {
    return null;
  }

  const signalTypes = new Set(signals.map((s) => s.source));
  const hasOracleSignal =
    signalTypes.has("ORACLE_MANIPULATION") ||
    signalTypes.has("CROSS_CHAIN_INCONSISTENCY");
  const hasMevSignals =
    signalTypes.has("FLASH_LOAN") ||
    signalTypes.has("GAS_SPIKE") ||
    signalTypes.has("LARGE_SWAP") ||
    signalTypes.has("MEMPOOL_CLUSTER");
  const hasCrossChainSignal = signalTypes.has("CROSS_CHAIN_ATTACK");
  const distinctSignalCount = signalTypes.size;

  // --- Cross-chain attack detection (highest priority) ---
  // Cross-chain attacks require cross-chain defense
  if (hasCrossChainSignal) {
    const crossChainSignal = signals.find((s) => s.source === "CROSS_CHAIN_ATTACK");
    
    // CRITICAL + cross-chain → EMERGENCY_BRIDGE (get liquidity out ASAP)
    if (tier === "CRITICAL" && compositeScore > 85) {
      return {
        action: "EMERGENCY_BRIDGE",
        rationale: `CRITICAL tier + cross-chain attack detected (score ${compositeScore.toFixed(1)}). Emergency bridge to safe haven chain initiated.`,
      };
    }
    
    // CRITICAL with cross-chain + oracle → LIQUIDITY_REROUTE
    if (tier === "CRITICAL" && hasOracleSignal) {
      return {
        action: "LIQUIDITY_REROUTE",
        rationale: `CRITICAL tier + cross-chain + oracle deviation. Rerouting liquidity to safer chain (score ${compositeScore.toFixed(1)}).`,
      };
    }
    
    // ELEVATED with cross-chain + MEV patterns → CROSS_CHAIN_ARBITRAGE_BLOCK
    if (hasMevSignals) {
      return {
        action: "CROSS_CHAIN_ARBITRAGE_BLOCK",
        rationale: `${tier} tier + cross-chain arbitrage pattern detected. Blocking cross-chain arb exploit (score ${compositeScore.toFixed(1)}).`,
      };
    }
    
    // Cross-chain signal alone at ELEVATED → LIQUIDITY_REROUTE as precaution
    if (tier === "ELEVATED") {
      return {
        action: "LIQUIDITY_REROUTE",
        rationale: `ELEVATED tier + cross-chain attack signal. Precautionary liquidity reroute (score ${compositeScore.toFixed(1)}).`,
      };
    }
  }


  // --- CRITICAL tier decision logic ---
  if (tier === "CRITICAL") {
    // Circuit breaker is the NUCLEAR OPTION - use it sparingly.
    // 
    // Trigger CIRCUIT_BREAKER only when:
    // 1. Extreme oracle deviation (>75%) that could drain LPs, OR
    // 2. Catastrophic correlation: oracle manipulation + 3+ MEV signals simultaneously
    //
    // For pure MEV attacks (sandwich, frontrun, JIT, toxic arb), prefer dynamic
    // fee increases (MEV_PROTECTION) to keep the pool operational while extracting
    // value from attackers via higher fees that go to LPs.
    
    const oracleDevSignal = signals.find(
      (s) => s.source === "ORACLE_MANIPULATION" || s.source === "CROSS_CHAIN_INCONSISTENCY"
    );
    const extremeOracle = oracleDevSignal && oracleDevSignal.magnitude > 0.75;
    const moderateOracle = oracleDevSignal && oracleDevSignal.magnitude > 0.05 && oracleDevSignal.magnitude <= 0.3;
    
    // Catastrophic correlation: oracle manipulation + multiple MEV patterns
    // This suggests a coordinated, multi-vector attack
    const catastrophicCorrelation = hasOracleSignal && distinctSignalCount >= 4 && hasMevSignals;

    if (extremeOracle || catastrophicCorrelation) {
      return {
        action: "CIRCUIT_BREAKER",
        rationale: extremeOracle
          ? `CRITICAL tier + extreme oracle deviation (magnitude ${oracleDevSignal!.magnitude.toFixed(2)}). Pool pause required to prevent LP drainage.`
          : `CRITICAL tier + ${distinctSignalCount} correlated signal types with oracle manipulation. Catastrophic multi-vector attack detected — emergency pool pause.`,
      };
    }

    // Toxic arbitrage detection: Moderate oracle deviation + strong MEV signals
    // These are MEV attacks that cause incidental price impact, not pure oracle manipulation
    // Example: Large swaps that move price slightly while extracting MEV
    // Strategy: Use dynamic fees to make the attack unprofitable
    if (moderateOracle && hasMevSignals) {
      return {
        action: "MEV_PROTECTION",
        rationale: `CRITICAL tier toxic arbitrage detected (oracle magnitude ${oracleDevSignal!.magnitude.toFixed(2)}, score ${compositeScore.toFixed(1)}). Moderate price impact with MEV patterns — dynamic fees applied to extract value from attacker. Signal types: ${[...signalTypes].join(", ")}.`,
      };
    }

    // CRITICAL with significant oracle deviation (30-75%) → Oracle validation
    if (hasOracleSignal && !moderateOracle) {
      return {
        action: "ORACLE_VALIDATION",
        rationale: `CRITICAL tier with oracle manipulation (magnitude ${oracleDevSignal?.magnitude.toFixed(2) || 'unknown'}, score ${compositeScore.toFixed(1)}). Oracle validation enforced; swaps will be rejected if price deviation exceeds threshold.`,
      };
    }

    // CRITICAL with only MEV-pattern signals → Dynamic fees to extract value from attackers
    // This handles: sandwich, frontrun, JIT liquidity
    // Strategy: Make attacks unprofitable via high fees while keeping pool operational
    return {
      action: "MEV_PROTECTION",
      rationale: `CRITICAL tier with MEV-pattern attack (score ${compositeScore.toFixed(1)}). Dynamic fees increased to 32-200 bps to make attack unprofitable. Fees benefit LPs. Signal types: ${[...signalTypes].join(", ")}.`,
    };
  }

  // --- ELEVATED tier decision logic ---
  if (hasOracleSignal && hasMevSignals) {
    // Check if it's toxic arbitrage (moderate oracle deviation with MEV)
    const oracleDevSignal = signals.find(
      (s) => s.source === "ORACLE_MANIPULATION" || s.source === "CROSS_CHAIN_INCONSISTENCY"
    );
    const moderateOracle = oracleDevSignal && oracleDevSignal.magnitude <= 0.3;
    
    if (moderateOracle) {
      // Toxic arbitrage at ELEVATED tier — use dynamic fees
      return {
        action: "MEV_PROTECTION",
        rationale: `ELEVATED tier toxic arbitrage (oracle magnitude ${oracleDevSignal!.magnitude.toFixed(2)}, score ${compositeScore.toFixed(1)}). Moderate price impact with MEV patterns — dynamic fees applied.`,
      };
    }
    
    // Significant oracle deviation takes priority
    return {
      action: "ORACLE_VALIDATION",
      rationale: `ELEVATED tier with both oracle and MEV signals. Oracle validation takes priority (score ${compositeScore.toFixed(1)}).`,
    };
  }

  if (hasOracleSignal) {
    return {
      action: "ORACLE_VALIDATION",
      rationale: `ELEVATED tier with oracle manipulation signal (score ${compositeScore.toFixed(1)}). Swap rejection enabled.`,
    };
  }

  if (hasMevSignals) {
    return {
      action: "MEV_PROTECTION",
      rationale: `ELEVATED tier with MEV-pattern signals (score ${compositeScore.toFixed(1)}). Dynamic fee bump activated for current block.`,
    };
  }

  // Fallback: elevated score but unrecognised signal mix — MEV protection is safest default
  return {
    action: "MEV_PROTECTION",
    rationale: `ELEVATED tier, fallback to MEV protection. Signal types: ${[...signalTypes].join(", ")}. Score: ${compositeScore.toFixed(1)}.`,
  };
}

// ---------------------------------------------------------------------------
// 7. RPC BUDGET — token-bucket rate limiter for free-tier RPC survival
// ---------------------------------------------------------------------------

export interface RpcBudgetConfig {
  /**
   * Maximum RPC calls allowed per refill interval.
   * Free tiers typically allow 100-300 calls/min across all chains.
   * Default: 100
   */
  maxCalls?: number;

  /**
   * Refill interval in milliseconds. Every this many ms, the bucket is
   * topped back up to maxCalls.
   * Default: 60_000 (1 minute)
   */
  refillIntervalMs?: number;

  /**
   * Number of chains being monitored. Budget is shared across all chains.
   * Default: 3
   */
  chains?: number;

  /**
   * When the remaining budget drops below this fraction of maxCalls,
   * the engine switches Scout to "quiet mode" — longer poll intervals,
   * skip non-critical checks.
   * Default: 0.2 (20% remaining triggers quiet mode)
   */
  quietThreshold?: number;
}

export type RpcBudgetStatus = "NORMAL" | "QUIET" | "EXHAUSTED";

/**
 * Token-bucket rate limiter.  The TEE process should hold a single instance
 * and pass it to every component that makes RPC calls.
 *
 * Usage:
 *   const budget = new RpcBudget({ maxCalls: 100, refillIntervalMs: 60_000 });
 *   budget.start(); // begins the refill timer
 *
 *   // Before each RPC call:
 *   if (budget.tryConsume(1)) { // returns false if exhausted
 *     await provider.getBlock('latest');
 *   }
 *
 *   // Check polling mode:
 *   const mode = budget.getStatus(); // "NORMAL" | "QUIET" | "EXHAUSTED"
 */
export class RpcBudget extends EventEmitter {
  private remaining: number;
  private readonly maxCalls: number;
  private readonly refillIntervalMs: number;
  private readonly quietThreshold: number;
  private refillTimer?: ReturnType<typeof setInterval>;
  private totalConsumed = 0;

  constructor(config: RpcBudgetConfig = {}) {
    super();
    this.maxCalls = config.maxCalls ?? 100;
    this.refillIntervalMs = config.refillIntervalMs ?? 60_000;
    this.quietThreshold = config.quietThreshold ?? 0.2;
    this.remaining = this.maxCalls;
  }

  /** Start the periodic refill. Call once at process startup. */
  start(): void {
    if (this.refillTimer) return;
    this.refillTimer = setInterval(() => this.refill(), this.refillIntervalMs);
    console.log(
      `💰 RpcBudget: ${this.maxCalls} calls per ${this.refillIntervalMs / 1000}s window`
    );
  }

  /** Stop the refill timer. Call at shutdown. */
  stop(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = undefined;
    }
  }

  /**
   * Attempt to consume `n` calls from the bucket.
   * Returns true if successful, false if insufficient budget.
   */
  tryConsume(n = 1): boolean {
    if (this.remaining < n) {
      return false;
    }
    this.remaining -= n;
    this.totalConsumed += n;

    if (this.getStatus() === "QUIET") {
      this.emit("budget:quiet", { remaining: this.remaining, max: this.maxCalls });
    }
    if (this.getStatus() === "EXHAUSTED") {
      this.emit("budget:exhausted");
    }

    return true;
  }

  /** Current status based on remaining budget. */
  getStatus(): RpcBudgetStatus {
    if (this.remaining <= 0) return "EXHAUSTED";
    if (this.remaining / this.maxCalls < this.quietThreshold) return "QUIET";
    return "NORMAL";
  }

  /** Recommended poll interval in ms based on current budget status. */
  getRecommendedPollIntervalMs(): number {
    switch (this.getStatus()) {
      case "NORMAL":
        return 12_000;   // 12s — aggressive, catches most blocks
      case "QUIET":
        return 45_000;   // 45s — back off significantly
      case "EXHAUSTED":
        return 120_000;  // 2 min — bare minimum to stay alive
    }
  }

  get remainingCalls(): number {
    return this.remaining;
  }

  get totalCallsConsumed(): number {
    return this.totalConsumed;
  }

  private refill(): void {
    this.remaining = this.maxCalls;
    this.totalConsumed = 0;
    this.emit("budget:refill", { maxCalls: this.maxCalls });
  }
}

// ---------------------------------------------------------------------------
// 8. RISK ENGINE — the main class that wires everything together
// ---------------------------------------------------------------------------

/** Per-pool state held by the engine. */
interface PoolState {
  correlationWindow: PoolCorrelationWindow;
  stateMachine: ThreatStateMachine;
  emaTrackers: Map<string, EmaTracker>;  // keyed by signal type
  lastDecision: RiskDecision | null;
  lastDecisionAt: number;
}

export class RiskEngine extends EventEmitter {
  private readonly config: ResolvedConfig;
  private pools: Map<string, PoolState> = new Map(); // keyed by "chain:pair" or poolAddress
  readonly rpcBudget: RpcBudget;
  private decisionCounter = 0;

  constructor(config: RiskEngineConfig = {}) {
    super();
    this.config = this.resolveConfig(config);
    this.rpcBudget = new RpcBudget(config.rpcBudget);
    
    // Per PROJECT_SPEC.md Section 4.5: "Agents communicate via Yellow state channels"
    // Listen for signals/alerts that come FROM Yellow Message Bus
    // These are emitted by the RiskEngineYellowAdapter when it receives messages from Yellow
    this.on('yellow:signal', (signal: any) => {
      // Convert Yellow signal format to ScoutSignal
      const scoutSignal: ScoutSignal = {
        type: signal.type as ScoutSignalType,
        magnitude: signal.magnitude,
        chain: signal.chain,
        pair: signal.pair,
        poolAddress: signal.poolAddress,
        timestamp: signal.timestamp,
      };
      this.ingestScoutEvent(scoutSignal);
    });
    
    this.on('yellow:alert', (alert: any) => {
      // Convert Yellow alert format to ValidatorThreatSignal
      this.ingestValidatorAlert({
        type: alert.type,
        chain: alert.chain,
        pair: alert.pair ?? 'unknown',
        poolAddress: alert.targetPool,
        deviation: alert.evidence?.deviation ?? 0,
        timestamp: alert.detectedAt ?? Date.now(),
        evidence: alert.evidence,
      });
    });
  }

  /** Start the RPC budget timer. Call once at process startup. */
  start(): void {
    this.rpcBudget.start();
    console.log("🧠 RiskEngine: started");
    console.log("   Listening for signals/alerts via Yellow state channels");
  }

  /** Tear down timers. */
  stop(): void {
    this.rpcBudget.stop();
    console.log("🧠 RiskEngine: stopped");
  }

  // -----------------------------------------------------------------------
  // Public ingest methods — called by Scout / Validator adapters
  // -----------------------------------------------------------------------

  /**
   * Ingest a signal from the Scout agent.
   * Normalise, score, window, evaluate state, and potentially emit a decision.
   */
  ingestScoutEvent(signal: ScoutSignal): void {
    const poolKey = signal.poolAddress ?? `${signal.chain}:${signal.pair}`;
    const pool = this.getOrCreatePool(poolKey);
    const now = signal.timestamp;

    // 1. Update EMA tracker for this signal type → get adaptive threshold
    const emaKey = signal.type;
    if (!pool.emaTrackers.has(emaKey)) {
      const baseThreshold = this.config.baseThresholds[signal.type] ?? 0.5;
      pool.emaTrackers.set(emaKey, new EmaTracker(baseThreshold, this.config.emaAlpha));
    }
    const adaptiveThreshold = pool.emaTrackers.get(emaKey)!.update(signal.magnitude);

    // 2. Score the signal: how far above the adaptive threshold is the magnitude?
    //    If magnitude <= threshold → score is 0 (noise).
    //    If magnitude > threshold → score scales linearly up to 1.0 at 2× threshold.
    const excessRatio = Math.max(0, (signal.magnitude - adaptiveThreshold) / adaptiveThreshold);
    const normalisedScore = Math.min(1, excessRatio); // 0 to 1

    // 3. Apply signal weight
    const rawWeight = this.config.signalWeights[signal.type] ?? 1;
    const totalWeight = Object.values(this.config.signalWeights).reduce((a, b) => a + b, 0);
    const normalisedWeight = rawWeight / totalWeight;

    // weightedScore contributes to composite. Scale to [0, 100] range.
    const weightedScore = normalisedScore * normalisedWeight * 100;

    const scored: ScoredSignal = {
      source: signal.type,
      magnitude: signal.magnitude,
      weight: normalisedWeight,
      weightedScore,
      timestamp: now,
    };

    // 4. Add to correlation window
    pool.correlationWindow.add(scored, now);

    // 5. Evaluate
    this.evaluate(poolKey, pool, signal.chain, signal.pair, now);
  }

  /**
   * Ingest a threat alert from the Validator agent.
   * Validator alerts carry pre-computed deviation — we convert that to a
   * magnitude [0,1] and route through the same scoring pipeline.
   */
  ingestValidatorAlert(alert: ValidatorThreatSignal): void {
    const poolKey = alert.poolAddress ?? `${alert.chain}:${alert.pair}`;
    const pool = this.getOrCreatePool(poolKey);
    const now = alert.timestamp;

    // Convert deviation (percentage) to magnitude [0, 1].
    // Deviation of 5% → magnitude 0.05; 50% → 0.5; >100% → clamped to 1.0.
    const magnitude = Math.min(1, alert.deviation / 100);

    // EMA tracking
    const emaKey = alert.type;
    if (!pool.emaTrackers.has(emaKey)) {
      const baseThreshold = this.config.baseThresholds[alert.type] ?? 0.05;
      pool.emaTrackers.set(emaKey, new EmaTracker(baseThreshold, this.config.emaAlpha));
    }
    const adaptiveThreshold = pool.emaTrackers.get(emaKey)!.update(magnitude);

    // Score
    const excessRatio = Math.max(0, (magnitude - adaptiveThreshold) / adaptiveThreshold);
    const normalisedScore = Math.min(1, excessRatio);

    const rawWeight = this.config.signalWeights[alert.type] ?? 3; // oracle signals weighted heavily by default
    const totalWeight = Object.values(this.config.signalWeights).reduce((a, b) => a + b, 0);
    const normalisedWeight = rawWeight / totalWeight;
    const weightedScore = normalisedScore * normalisedWeight * 100;

    const scored: ScoredSignal = {
      source: alert.type,
      magnitude,
      weight: normalisedWeight,
      weightedScore,
      timestamp: now,
    };

    pool.correlationWindow.add(scored, now);
    this.evaluate(poolKey, pool, alert.chain, alert.pair || "UNKNOWN/UNKNOWN", now);
  }

  // -----------------------------------------------------------------------
  // Query methods — for dashboard / status endpoints
  // -----------------------------------------------------------------------

  /** Get current threat tier for a pool. */
  getPoolThreatTier(poolKey: string): ThreatTier {
    return this.pools.get(poolKey)?.stateMachine.currentTier ?? "WATCH";
  }

  /** Get the last decision emitted for a pool (or null). */
  getLastDecision(poolKey: string): RiskDecision | null {
    return this.pools.get(poolKey)?.lastDecision ?? null;
  }

  /** Snapshot of all monitored pools. */
  getMonitoredPools(): Array<{
    key: string;
    tier: ThreatTier;
    compositeScore: number;
    lastDecision: RiskDecision | null;
  }> {
    const result: Array<{
      key: string;
      tier: ThreatTier;
      compositeScore: number;
      lastDecision: RiskDecision | null;
    }> = [];

    for (const [key, pool] of this.pools) {
      result.push({
        key,
        tier: pool.stateMachine.currentTier,
        compositeScore: pool.correlationWindow.getCompositeScore(),
        lastDecision: pool.lastDecision,
      });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Private — pool lifecycle & evaluation loop
  // -----------------------------------------------------------------------

  private getOrCreatePool(key: string): PoolState {
    if (!this.pools.has(key)) {
      this.pools.set(key, {
        correlationWindow: new PoolCorrelationWindow(this.config.correlationWindowMs),
        stateMachine: new ThreatStateMachine(this.config.hysteresis),
        emaTrackers: new Map(),
        lastDecision: null,
        lastDecisionAt: 0,
      });
    }
    return this.pools.get(key)!;
  }

  /**
   * Core evaluation: update state machine, map to action, emit if needed.
   */
  private evaluate(
    poolKey: string,
    pool: PoolState,
    chain: string,
    pair: string,
    now: number,
  ): void {
    const compositeScore = pool.correlationWindow.getCompositeScore();
    const { tier, transitioned } = pool.stateMachine.update(compositeScore);

    // Only emit a decision when:
    //   a) The tier transitioned (state changed), OR
    //   b) We're in ELEVATED or CRITICAL and the previous decision has expired.
    const prevTtl = pool.lastDecision
      ? this.config.actionTtl[pool.lastDecision.action]
      : 0;
    const prevExpired = now - pool.lastDecisionAt > prevTtl;
    const shouldEmit =
      transitioned ||
      (tier !== "WATCH" && prevExpired);

    if (!shouldEmit) return;

    const signals = pool.correlationWindow.getSignals();
    const mapped = mapToDefenseAction(tier, compositeScore, signals);

    if (!mapped) {
      // Tier is WATCH — no action. Clear last decision if we transitioned down.
      if (transitioned) {
        pool.lastDecision = null;
        this.emit("decision:cleared", { poolKey, tier, compositeScore, timestamp: now });
      }
      return;
    }

    this.decisionCounter++;
    const decision: RiskDecision = {
      id: `risk-${this.decisionCounter}-${now}`,
      action: mapped.action,
      tier,
      compositeScore,
      targetPool: poolKey,
      chain,
      pair,
      timestamp: now,
      rationale: mapped.rationale,
      contributingSignals: signals,
      ttlMs: this.config.actionTtl[mapped.action],
    };

    pool.lastDecision = decision;
    pool.lastDecisionAt = now;

    console.log(
      `🧠 RiskEngine [${poolKey}] → ${decision.action} | tier=${tier} score=${compositeScore.toFixed(1)} | ${mapped.rationale}`
    );

    this.emit("decision", decision);
  }

  // -----------------------------------------------------------------------
  // Config resolution — fills in defaults
  // -----------------------------------------------------------------------

  private resolveConfig(input: RiskEngineConfig): ResolvedConfig {
    return {
      correlationWindowMs: input.correlationWindowMs ?? 24_000,
      emaAlpha: input.emaAlpha ?? 0.1,
      baseThresholds: {
        FLASH_LOAN: 0.3,
        GAS_SPIKE: 0.4,
        LARGE_SWAP: 0.35,
        PRICE_MOVE: 0.25,
        MEMPOOL_CLUSTER: 0.2,
        ORACLE_MANIPULATION: 0.05,       // oracle signals are high-value; low base threshold
        CROSS_CHAIN_INCONSISTENCY: 0.08,
        ...input.baseThresholds,
      },
      signalWeights: {
        FLASH_LOAN: 2.5,
        GAS_SPIKE: 1.5,
        LARGE_SWAP: 2.0,
        PRICE_MOVE: 1.0,
        MEMPOOL_CLUSTER: 3.0,            // multiple suspicious txs = strong signal
        ORACLE_MANIPULATION: 3.5,        // oracle attacks are highest priority
        CROSS_CHAIN_INCONSISTENCY: 2.8,
        ...input.signalWeights,
      },
      hysteresis: {
        watchToElevated: { up: 35, down: 20 },
        elevatedToCritical: { up: 70, down: 50 },
        ...input.hysteresis,
      },
      actionTtl: {
        MEV_PROTECTION: 12_000,       // 12s — one block window on most chains
        ORACLE_VALIDATION: 60_000,    // 60s — persist while oracle is suspicious
        CIRCUIT_BREAKER: 300_000,     // 5 min — pool pause is a serious action
        // Cross-chain action TTLs (longer due to bridge finality)
        LIQUIDITY_REROUTE: 600_000,           // 10 min — temp liquidity move
        CROSS_CHAIN_ARBITRAGE_BLOCK: 120_000, // 2 min — arb window
        EMERGENCY_BRIDGE: 900_000,            // 15 min — emergency action
        ...input.actionTtl,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 9. ADAPTER HELPERS — wire Scout/Validator events into the engine with
//    minimal code in the caller
// ---------------------------------------------------------------------------

/**
 * Attach the RiskEngine to a Scout agent's event emitter.
 * Scout now emits unified 'signal' events with pre-normalized ScoutSignal objects.
 * 
 * Call once after both Scout and RiskEngine are constructed:
 *   wireScout(scoutAgent, riskEngine);
 */
export function wireScout(scout: EventEmitter, engine: RiskEngine): void {
  // Scout emits unified 'signal' events - direct pass-through
  scout.on("signal", (signal: ScoutSignal) => {
    engine.ingestScoutEvent(signal);
  });

  console.log("🔗 RiskEngine: wired to Scout agent");
}

/**
 * Attach the RiskEngine to a Validator agent's event emitter.
 * Translates Validator's ThreatAlert events into ValidatorThreatSignal.
 */
export function wireValidator(validator: EventEmitter, engine: RiskEngine): void {
  validator.on("threat:alert", (alert: any) => {
    engine.ingestValidatorAlert({
      type: alert.type,
      chain: alert.chain,
      pair: alert.pair ?? "unknown",
      poolAddress: alert.targetPool,
      deviation: alert.evidence?.deviation ?? 0,
      timestamp: alert.detectedAt ?? Date.now(),
      evidence: alert.evidence,
    });
  });

  console.log("🔗 RiskEngine: wired to Validator agent");
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export {
  EmaTracker,
  PoolCorrelationWindow,
  ThreatStateMachine,
  mapToDefenseAction,
};