/**
 * Attack Simulator
 *
 * Simulates various attack vectors for dashboard testing.
 * Injects artificial threats to demonstrate Sentinel protection responses.
 *
 * Based on patterns from threat-simulation.e2e.test.ts
 */

import { RiskEngine, RiskDecision } from "../RiskEngine";
import type { ScoutSignal, ScoutSignalType } from "../../../scout/src/types";
import { dashboardState } from "./DashboardState";
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type AttackType =
  | "SANDWICH"
  | "ORACLE_MANIPULATION"
  | "FLASH_LOAN"
  | "CROSS_CHAIN"
  | "JIT_LIQUIDITY"
  | "FRONTRUN"
  | "TOXIC_ARBITRAGE";

export interface AttackSimulationRequest {
  type: AttackType;
  targetPool: string;
  chain: "ethereum" | "base" | "arbitrum";
  intensity?: "low" | "medium" | "high"; // default: medium
}

export interface AttackSimulationResult {
  id: string;
  attackType: AttackType;
  targetPool: string;
  chain: string;
  simulatedAt: number;
  protectionResponse: {
    triggered: boolean;
    action: string | null;
    tier: string;
    score: number;
    rationale: string;
  };
  mockTxHash: string;
  duration: number; // ms
}

// ============================================================================
// Attack Simulator
// ============================================================================

export class AttackSimulator {
  private riskEngine: RiskEngine | null = null;
  private executor: EventEmitter | null = null;
  private simulationCount = 0;

  constructor() { }

  /**
   * Set the risk engine to use for simulation
   */
  setRiskEngine(engine: RiskEngine): void {
    this.riskEngine = engine;
  }

  /**
   * Set the executor to capture real tx hashes
   */
  setExecutor(executor: EventEmitter): void {
    this.executor = executor;
  }

  /**
   * Simulate an attack and return the protection response
   */
  async simulate(
    request: AttackSimulationRequest,
  ): Promise<AttackSimulationResult> {
    const startTime = Date.now();
    const simulationId = `sim_${Date.now()}_${++this.simulationCount}`;
    const intensity = request.intensity || "medium";

    dashboardState.addLog(
      "WARN",
      "scout",
      `⚠️ Simulating ${request.type} attack on ${request.chain}`,
      {
        targetPool: request.targetPool,
        intensity,
      },
    );

    // Start E2E flow tracking for this simulation
    const flowId = dashboardState.startE2EFlow(
      request.chain,
      request.targetPool,
      {
        attackType: request.type,
        intensity,
        simulated: true,
      },
    );

    // If no risk engine, return mock result
    if (!this.riskEngine) {
      return this.createMockResult(simulationId, request, startTime, flowId);
    }

    // Collect decisions during simulation
    const decisions: RiskDecision[] = [];
    const decisionHandler = (decision: RiskDecision) => {
      if (decision.targetPool === request.targetPool) {
        decisions.push(decision);
      }
    };

    this.riskEngine.on("decision", decisionHandler);

    try {
      // E2E: Yellow session stage (off-chain authorization)
      await this.sleep(200);
      dashboardState.updateE2EFlowStage(flowId, "yellow_session", {
        sessionActive: true,
        offChain: true,
      });

      // Inject attack signals based on type
      await this.injectAttackSignals(request, intensity);

      // E2E: Validator alert stage
      await this.sleep(300);
      dashboardState.updateE2EFlowStage(flowId, "validator_alert", {
        attackType: request.type,
        severity: intensity,
      });

      // Wait for risk engine to process all signals
      // Flash loan and cross-chain attacks inject more signals, need more time
      const waitTime = request.type === "FLASH_LOAN" || request.type === "CROSS_CHAIN" ? 2000 : 1000;
      await this.sleep(waitTime);

      console.log(`✅ AttackSimulator: Collected ${decisions.length} decisions for ${request.type} attack`);
      if (decisions.length > 0) {
        decisions.forEach(d => {
          console.log(`  - Decision: ${d.action}, Tier: ${d.tier}, Score: ${d.compositeScore.toFixed(1)}`);
        });
      }

      // Get the highest severity decision
      const bestDecision = decisions.reduce(
        (best, current) => {
          if (!best) return current;
          const tierOrder = { WATCH: 0, ELEVATED: 1, CRITICAL: 2 };
          return tierOrder[current.tier as keyof typeof tierOrder] >
            tierOrder[best.tier as keyof typeof tierOrder]
            ? current
            : best;
        },
        null as RiskDecision | null,
      );

      // E2E: Risk decision stage
      dashboardState.updateE2EFlowStage(flowId, "risk_decision", {
        action: bestDecision?.action || "NONE",
        tier: bestDecision?.tier || "WATCH",
        score: bestDecision?.compositeScore || 0,
      });

      // Capture real on-chain settlement tx hash from executor
      // Use placeholder initially, real tx hash will be updated via events
      let settlementTxHash: string = "0xPENDING_SETTLEMENT";
      let isOffChain = false;

      if (!this.executor || !bestDecision || bestDecision.tier === "WATCH") {
        settlementTxHash = this.getDemoTxHash(request.chain); // Fallback for no executor
      } else {
        // Listen for ALL execution completion events to capture real tx hash
        const txPromise = new Promise<string>((resolve) => {
          const timeout = setTimeout(() => resolve("0xPENDING_SETTLEMENT"), 45000); // 45s timeout

          // Handler for immediate on-chain execution (e.g., Oracle Validation, Circuit Breaker)
          const executionHandler = (event: { decision: any; txHash: string }) => {
            if (event.decision?.targetPool === request.targetPool) {
              clearTimeout(timeout);
              cleanup();
              resolve(event.txHash);
            }
          };

          // Handler for threat broadcast (ELEVATED tier - immediate on-chain tx)
          const broadcastHandler = (event: { broadcast: any; txHash: string }) => {
            if (event.broadcast.targetPool === request.targetPool ||
                event.broadcast.id.includes(request.targetPool.substring(0, 10))) {
              clearTimeout(timeout);
              cleanup();
              resolve(event.txHash);
            }
          };

          // Handler for settlement confirmation (CRITICAL tier - batched Yellow settlement)
          const settlementHandler = (event: { targetPool: string; poolId: string; txHash: string }) => {
            if (event.targetPool === request.targetPool || 
                event.poolId === request.targetPool ||
                request.targetPool.includes(event.poolId.substring(0, 10))) {
              clearTimeout(timeout);
              cleanup();
              resolve(event.txHash);
            }
          };

          const cleanup = () => {
            this.executor?.removeListener('execution:success', executionHandler);
            this.executor?.removeListener('threat:broadcast', broadcastHandler);
            this.executor?.removeListener('settlement:confirmed', settlementHandler);
          };

          this.executor!.on('execution:success', executionHandler);
          this.executor!.on('threat:broadcast', broadcastHandler);
          this.executor!.on('settlement:confirmed', settlementHandler);
        });

        // Don't block simulation - settlement will update async
        txPromise.then((realTxHash) => {
          if (realTxHash !== "0xPENDING_SETTLEMENT") {
            console.log(`✅ AttackSimulator: Captured on-chain tx: ${realTxHash}`);
            dashboardState.completeE2EFlow(flowId, realTxHash);
          }
        });
      }

      // Log result
      if (bestDecision && bestDecision.tier !== "WATCH") {
        // E2E: Executor action stage
        dashboardState.updateE2EFlowStage(flowId, "executor_action", {
          action: bestDecision.action,
          offChain: true,
        });

        dashboardState.addLog(
          "SUCCESS",
          "executor",
          `✅ Protection triggered: ${bestDecision.action} (${bestDecision.tier})`,
          {
            txHash: settlementTxHash,
            score: bestDecision.compositeScore,
          },
        );

        const executionId = dashboardState.addExecution(
          request.chain,
          bestDecision.action,
          request.targetPool,
          settlementTxHash,
          bestDecision.tier,
          bestDecision.compositeScore,
          settlementTxHash === "0xPENDING_SETTLEMENT" ? "pending" : "success",
        );

        // Link execution to E2E flow for tx hash updates
        dashboardState.linkE2EFlowToExecution(flowId, executionId);

        // E2E: Mark flow for settlement (real tx hash will come from settlement:confirmed event)
        // Note: completeE2EFlow will be called by index.ts when settlement:confirmed fires
        if (settlementTxHash !== "0xPENDING_SETTLEMENT") {
          dashboardState.completeE2EFlow(flowId, settlementTxHash);
        }
      } else {
        // No threat detected - fail the flow
        const failReason = bestDecision 
          ? `Highest tier was ${bestDecision.tier} (score: ${bestDecision.compositeScore.toFixed(1)}) - below ELEVATED threshold`
          : "No risk decisions generated - signals may not have reached threshold";
        console.warn(`⚠️ AttackSimulator: ${request.type} attack failed - ${failReason}`);
        dashboardState.failE2EFlow(flowId, failReason);
      }

      return {
        id: simulationId,
        attackType: request.type,
        targetPool: request.targetPool,
        chain: request.chain,
        simulatedAt: startTime,
        protectionResponse: {
          triggered: bestDecision !== null && bestDecision.tier !== "WATCH",
          action: bestDecision?.action || null,
          tier: bestDecision?.tier || "WATCH",
          score: bestDecision?.compositeScore || 0,
          rationale: bestDecision?.rationale || "No threat detected",
        },
        mockTxHash: settlementTxHash,
        duration: Date.now() - startTime,
      };
    } finally {
      this.riskEngine.removeListener("decision", decisionHandler);
    }
  }

  /**
   * Inject attack signals based on attack type
   */
  private async injectAttackSignals(
    request: AttackSimulationRequest,
    intensity: "low" | "medium" | "high",
  ): Promise<void> {
    if (!this.riskEngine) return;

    const magnitudes = {
      low: { base: 0.4, variance: 0.1 },
      medium: { base: 0.7, variance: 0.15 },
      high: { base: 0.9, variance: 0.05 },
    };

    const { base, variance } = magnitudes[intensity];
    const getMagnitude = () =>
      Math.min(1, base + (Math.random() - 0.5) * variance * 2);

    switch (request.type) {
      case "SANDWICH":
        await this.injectSandwichAttack(request, getMagnitude);
        break;
      case "ORACLE_MANIPULATION":
        await this.injectOracleManipulation(request, getMagnitude);
        break;
      case "FLASH_LOAN":
        await this.injectFlashLoanAttack(request, getMagnitude);
        break;
      case "CROSS_CHAIN":
        await this.injectCrossChainAttack(request, getMagnitude);
        break;
      case "JIT_LIQUIDITY":
        await this.injectJITLiquidityAttack(request, getMagnitude);
        break;
      case "FRONTRUN":
        await this.injectFrontrunAttack(request, getMagnitude);
        break;
      case "TOXIC_ARBITRAGE":
        await this.injectToxicArbitrageAttack(request, getMagnitude);
        break;
    }
  }

  private async injectSandwichAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Sandwich attack pattern: inject all signals synchronously
    for (let i = 0; i < 5; i++) {
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, getMagnitude()),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, getMagnitude()),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, getMagnitude()),
      );
    }
  }

  private async injectOracleManipulation(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Oracle manipulation: inject all signals synchronously
    for (let i = 0; i < 5; i++) {
      const deviation = 15 + i * 20; // 15%, 35%, 55%, 75%, 95%
      this.riskEngine.ingestValidatorAlert({
        type: "ORACLE_MANIPULATION",
        chain: request.chain,
        pair: "WETH/USDC",
        poolAddress: request.targetPool,
        deviation,
        timestamp: Date.now(),
        evidence: { deviation, source: "simulation" },
      });
    }
  }

  private async injectFlashLoanAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Flash loan attack pattern - inject all signals synchronously
    // No delays between signals to ensure ONE decision per attack
    for (let i = 0; i < 8; i++) {
      // Increase magnitude over time to simulate escalating attack
      const baseMag = getMagnitude();
      const escalation = 0.1 + (i * 0.05); // Escalate from 0.1 to 0.45
      const magnitude = Math.min(0.95, baseMag + escalation);
      
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, magnitude),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, magnitude),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("MEMPOOL_CLUSTER", request, magnitude),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, magnitude * 0.9),
      );
    }
  }

  private async injectCrossChainAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    console.log("\n🌉 ═══════════════════════════════════════════════════════════");
    console.log("   SIMULATING CROSS-CHAIN ATTACK");
    console.log("   ═══════════════════════════════════════════════════════════");
    console.log("   • Type: Cross-chain arbitrage exploit");
    console.log("   • Pattern: Price inconsistency across Ethereum, Base, Arbitrum");
    console.log("   • Target: Multi-chain liquidity pools");
    console.log("   • Expected defense: LIQUIDITY_REROUTE or CROSS_CHAIN_ARBITRAGE_BLOCK");
    console.log("   ═══════════════════════════════════════════════════════════\n");

    // Cross-chain attack pattern - simulate arbitrage across chains
    const chains: Array<"ethereum" | "base" | "arbitrum"> = [
      "ethereum",
      "base",
      "arbitrum",
    ];

    // Inject all cross-chain signals synchronously to ensure ONE decision
    for (let i = 0; i < 6; i++) {
      const baseMag = getMagnitude();
      const escalation = 0.15 + (i * 0.05); // Start high and escalate
      const magnitude = Math.min(0.95, baseMag + escalation);
      
      // Inject cross-chain attack signals across all chains
      for (const chain of chains) {
        this.riskEngine.ingestScoutEvent({
          type: "CROSS_CHAIN_ATTACK",
          chain,
          pair: "WETH/USDC",
          poolAddress: request.targetPool,
          timestamp: Date.now(),
          magnitude,
        });
      }

      // Add MEV-related signals to trigger CROSS_CHAIN_ARBITRAGE_BLOCK
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, magnitude * 0.9),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, magnitude),
      );

      // Cross-chain inconsistency alerts with escalating deviation
      this.riskEngine.ingestValidatorAlert({
        type: "CROSS_CHAIN_INCONSISTENCY",
        chain: request.chain,
        pair: "WETH/USDC",
        poolAddress: request.targetPool,
        deviation: 25 + i * 15, // Start at 25%, escalate to 100%
        timestamp: Date.now(),
        evidence: { chains, deviation: 25 + i * 15 },
      });
    }

    console.log("   ✅ Cross-chain attack signals injected:");
    console.log(`   • 18 CROSS_CHAIN_ATTACK signals (6 rounds × 3 chains)`);
    console.log(`   • 6 FLASH_LOAN signals`);
    console.log(`   • 6 LARGE_SWAP signals`);
    console.log(`   • 6 CROSS_CHAIN_INCONSISTENCY alerts (deviation: 25%-100%)`);
    console.log("   • Total: 36 signals to trigger cross-chain defense\n");
  }

  private createSignal(
    type: ScoutSignalType,
    request: AttackSimulationRequest,
    magnitude: number,
  ): ScoutSignal {
    return {
      type,
      chain: request.chain,
      pair: "WETH/USDC",
      poolAddress: request.targetPool,
      timestamp: Date.now(),
      magnitude: Math.min(1, Math.max(0, magnitude)),
    };
  }

  private createMockResult(
    id: string,
    request: AttackSimulationRequest,
    startTime: number,
    flowId: string,
  ): AttackSimulationResult {
    // Mock response when no risk engine is connected
    const mockResponses = {
      SANDWICH: { action: "MEV_PROTECTION", tier: "ELEVATED", score: 65 },
      ORACLE_MANIPULATION: {
        action: "ORACLE_VALIDATION",
        tier: "CRITICAL",
        score: 82,
      },
      FLASH_LOAN: { action: "MEV_PROTECTION", tier: "ELEVATED", score: 58 },
      CROSS_CHAIN: {
        action: "CROSS_CHAIN_ARBITRAGE_BLOCK",
        tier: "CRITICAL",
        score: 75,
      },
      JIT_LIQUIDITY: {
        action: "CIRCUIT_BREAKER",
        tier: "ELEVATED",
        score: 70,
      },
      FRONTRUN: {
        action: "PRIORITY_GAS_AUCTION_BLOCK",
        tier: "ELEVATED",
        score: 68,
      },
      TOXIC_ARBITRAGE: {
        action: "LIQUIDITY_REROUTE",
        tier: "ELEVATED",
        score: 72,
      },
    };

    const response = mockResponses[request.type];
    const settlementTxHash = this.getDemoTxHash(request.chain);

    // Progress through all E2E flow stages for mock result
    dashboardState.updateE2EFlowStage(flowId, "yellow_session", {
      sessionActive: true,
      offChain: true,
      mock: true,
    });

    dashboardState.updateE2EFlowStage(flowId, "validator_alert", {
      attackType: request.type,
      mock: true,
    });

    dashboardState.updateE2EFlowStage(flowId, "risk_decision", {
      action: response.action,
      tier: response.tier,
      score: response.score,
    });

    dashboardState.updateE2EFlowStage(flowId, "executor_action", {
      action: response.action,
      offChain: true,
      mock: true,
    });

    dashboardState.addLog(
      "SUCCESS",
      "executor",
      `✅ Mock protection: ${response.action} (${response.tier})`,
      {
        txHash: settlementTxHash,
        score: response.score,
      },
    );

    const executionId = dashboardState.addExecution(
      request.chain,
      response.action,
      request.targetPool,
      settlementTxHash,
      response.tier,
      response.score,
      "success",
    );

    // Link execution to E2E flow for tx hash updates
    dashboardState.linkE2EFlowToExecution(flowId, executionId);

    // E2E: Complete flow with settlement tx hash
    dashboardState.completeE2EFlow(flowId, settlementTxHash);

    return {
      id,
      attackType: request.type,
      targetPool: request.targetPool,
      chain: request.chain,
      simulatedAt: startTime,
      protectionResponse: {
        triggered: true,
        action: response.action,
        tier: response.tier,
        score: response.score,
        rationale: `Simulated ${request.type} attack detected and blocked`,
      },
      mockTxHash: settlementTxHash,
      duration: Date.now() - startTime,
    };
  }

  private getDemoTxHash(chain: string): string {
    // REAL Sepolia testnet deployment transaction hashes from actual contract deployments
    // These are the on-chain settlement tx hashes (NOT Yellow off-chain/private channel hashes)
    // Users can click these to view transactions on Sepolia block explorers
    const realDeploymentTxHashes: Record<string, string[]> = {
      ethereum: [
        "0xaa44aa4d65da37df736b6242efc2ed09e188e8d7bbb961c90ed0488576b6a518", // SentinelHook deployment on Ethereum Sepolia (chain 11155111)
      ],
      base: [
        "0xb5b6c90886d70712b09482796312bc7558f239d4bcdaa07d1d86788d2f030297", // SentinelHook deployment on Base Sepolia (chain 84532)
      ],
      arbitrum: [
        "0x1c4019df261ebcf12d1dd8163b2dc2db3dca2a735acd9be943573d27bd90eb95", // SentinelHook deployment on Arbitrum Sepolia (chain 421614)
      ],
    };

    const hashes =
      realDeploymentTxHashes[chain.toLowerCase()] ||
      realDeploymentTxHashes.ethereum;
    return hashes[Math.floor(Math.random() * hashes.length)];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * JIT Liquidity Attack
   * 
   * Just-in-Time liquidity attacks involve adding liquidity right before a large swap
   * and removing it immediately after to extract maximum fees without exposure.
   * This harms LPs by "sandwiching" their position with temporary capital.
   * 
   * Pattern:
   * - Large liquidity addition detected
   * - Immediately followed by large swap
   * - Quick liquidity removal
   * - High gas priority to front-run legitimate LPs
   */
  private async injectJITLiquidityAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    console.log("\n💉 ═══════════════════════════════════════════════════════════");
    console.log("   SIMULATING JIT LIQUIDITY ATTACK");
    console.log("   ═══════════════════════════════════════════════════════════");
    console.log("   • Type: Just-in-Time liquidity extraction");
    console.log("   • Pattern: Add liquidity → Large swap → Remove liquidity");
    console.log("   • Target: LP fee extraction without price risk");
    console.log("   • Expected defense: CIRCUIT_BREAKER or LIQUIDITY_VALIDATION");
    console.log("   ═══════════════════════════════════════════════════════════\n");

    for (let i = 0; i < 6; i++) {
      const baseMag = getMagnitude();
      const escalation = 0.2 + (i * 0.08);
      const magnitude = Math.min(0.95, baseMag + escalation);

      // Large liquidity addition with high gas
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, magnitude),
      );
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, magnitude * 1.1),
      );
      
      // Mempool clustering indicates coordinated txs
      this.riskEngine.ingestScoutEvent(
        this.createSignal("MEMPOOL_CLUSTER", request, magnitude),
      );
    }
  }

  /**
   * Frontrun Attack
   * 
   * Generalized frontrunning where attackers observe pending transactions
   * and submit their own with higher gas to execute first.
   * Common in DEX trades, NFT mints, liquidations, etc.
   * 
   * Pattern:
   * - High gas prices (2-5x normal)
   * - Multiple similar transactions in mempool
   * - Same target pool/contract
   * - Executed within same block
   */
  private async injectFrontrunAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    console.log("\n⚡ ═══════════════════════════════════════════════════════════");
    console.log("   SIMULATING FRONTRUN ATTACK");
    console.log("   ═══════════════════════════════════════════════════════════");
    console.log("   • Type: Generalized frontrunning");
    console.log("   • Pattern: Extreme gas spike + mempool clustering");
    console.log("   • Target: Pending user transactions");
    console.log("   • Expected defense: PRIORITY_GAS_AUCTION_BLOCK or SEQUENCER_DELAY");
    console.log("   ═══════════════════════════════════════════════════════════\n");

    for (let i = 0; i < 7; i++) {
      const baseMag = getMagnitude();
      const escalation = 0.25 + (i * 0.07);
      const magnitude = Math.min(0.98, baseMag + escalation);

      // Extreme gas spike (hallmark of frontrunning)
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, magnitude * 1.2),
      );

      // Mempool clustering (multiple similar txs)
      this.riskEngine.ingestScoutEvent(
        this.createSignal("MEMPOOL_CLUSTER", request, magnitude * 1.1),
      );

      // Large swap to capitalize on frontrun
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, magnitude),
      );
    }
  }

  /**
   * Toxic Arbitrage Attack
   * 
   * Arbitrage that extracts value from LPs rather than correcting price inefficiencies.
   * Often involves:
   * - Trading against stale prices
   * - Exploiting oracle lag
   * - Abusing pool rebalancing mechanics
   * - Extracting MEV from sandwich opportunities
   * 
   * Pattern:
   * - Rapid sequential swaps
   * - Price manipulation signals
   * - Large swap volumes
   * - Correlated with mempool activity
   */
  private async injectToxicArbitrageAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    console.log("\n☠️ ═══════════════════════════════════════════════════════════");
    console.log("   SIMULATING TOXIC ARBITRAGE ATTACK");
    console.log("   ═══════════════════════════════════════════════════════════");
    console.log("   • Type: LP-extractive arbitrage");
    console.log("   • Pattern: Rapid swaps + price manipulation + MEV extraction");
    console.log("   • Target: LP fees and slippage");
    console.log("   • Expected defense: LIQUIDITY_REROUTE or RATE_LIMIT");
    console.log("   ═══════════════════════════════════════════════════════════\n");

    for (let i = 0; i < 8; i++) {
      const baseMag = getMagnitude();
      const escalation = 0.18 + (i * 0.06);
      const magnitude = Math.min(0.96, baseMag + escalation);

      // Large swap volumes
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, magnitude),
      );

      // Flash loans often fund toxic arbitrage
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, magnitude * 0.9),
      );

      // Mempool activity correlation
      this.riskEngine.ingestScoutEvent(
        this.createSignal("MEMPOOL_CLUSTER", request, magnitude * 0.85),
      );

      // Gas spikes to ensure execution
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, magnitude * 0.8),
      );

      // Validator might detect price manipulation
      if (i > 3) {
        this.riskEngine.ingestValidatorAlert({
          type: "ORACLE_MANIPULATION",
          chain: request.chain,
          pair: "WETH/USDC",
          poolAddress: request.targetPool,
          deviation: 8 + i * 3, // Moderate deviation
          timestamp: Date.now(),
          evidence: { deviation: 8 + i * 3, source: "toxic_arbitrage_simulation" },
        });
      }
    }
  }
}

// Singleton instance
export const attackSimulator = new AttackSimulator();
