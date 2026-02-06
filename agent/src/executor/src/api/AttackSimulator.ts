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

// ============================================================================
// Types
// ============================================================================

export type AttackType =
  | "SANDWICH"
  | "ORACLE_MANIPULATION"
  | "FLASH_LOAN"
  | "CROSS_CHAIN";

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
  private simulationCount = 0;

  constructor() {}

  /**
   * Set the risk engine to use for simulation
   */
  setRiskEngine(engine: RiskEngine): void {
    this.riskEngine = engine;
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

      // Wait for risk engine to process
      await this.sleep(1000);

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

      const settlementTxHash = this.getDemoTxHash(request.chain);

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

        dashboardState.addExecution(
          request.chain,
          bestDecision.action,
          request.targetPool,
          settlementTxHash,
          bestDecision.tier,
          bestDecision.compositeScore,
          "success",
        );

        // E2E: Settlement stage (on-chain settlement of the off-chain Yellow tx)
        dashboardState.completeE2EFlow(flowId, settlementTxHash);
      } else {
        // No threat detected - fail the flow
        dashboardState.failE2EFlow(flowId, "Signals below threat threshold");
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
    }
  }

  private async injectSandwichAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Sandwich attack pattern: FLASH_LOAN + GAS_SPIKE + LARGE_SWAP burst
    for (let i = 0; i < 5; i++) {
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, getMagnitude()),
      );
      await this.sleep(50);
      this.riskEngine.ingestScoutEvent(
        this.createSignal("GAS_SPIKE", request, getMagnitude()),
      );
      await this.sleep(50);
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, getMagnitude()),
      );
      await this.sleep(100);
    }
  }

  private async injectOracleManipulation(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Oracle manipulation: High deviation signals
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
      await this.sleep(150);
    }
  }

  private async injectFlashLoanAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Flash loan attack pattern
    for (let i = 0; i < 6; i++) {
      this.riskEngine.ingestScoutEvent(
        this.createSignal("FLASH_LOAN", request, getMagnitude()),
      );
      await this.sleep(50);
      this.riskEngine.ingestScoutEvent(
        this.createSignal("LARGE_SWAP", request, getMagnitude()),
      );
      await this.sleep(50);
      this.riskEngine.ingestScoutEvent(
        this.createSignal("MEMPOOL_CLUSTER", request, getMagnitude()),
      );
      await this.sleep(100);
    }
  }

  private async injectCrossChainAttack(
    request: AttackSimulationRequest,
    getMagnitude: () => number,
  ): Promise<void> {
    if (!this.riskEngine) return;

    // Cross-chain attack pattern
    const chains: Array<"ethereum" | "base" | "arbitrum"> = [
      "ethereum",
      "base",
      "arbitrum",
    ];

    for (let i = 0; i < 4; i++) {
      for (const chain of chains) {
        this.riskEngine.ingestScoutEvent({
          type: "CROSS_CHAIN_ATTACK",
          chain,
          pair: "WETH/USDC",
          poolAddress: request.targetPool,
          timestamp: Date.now(),
          magnitude: getMagnitude(),
        });
        await this.sleep(30);
      }

      // Cross-chain inconsistency alert
      this.riskEngine.ingestValidatorAlert({
        type: "CROSS_CHAIN_INCONSISTENCY",
        chain: request.chain,
        pair: "WETH/USDC",
        poolAddress: request.targetPool,
        deviation: 20 + i * 10,
        timestamp: Date.now(),
        evidence: { chains, deviation: 20 + i * 10 },
      });
      await this.sleep(100);
    }
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

    dashboardState.addExecution(
      request.chain,
      response.action,
      request.targetPool,
      settlementTxHash,
      response.tier,
      response.score,
      "success",
    );

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
}

// Singleton instance
export const attackSimulator = new AttackSimulator();
