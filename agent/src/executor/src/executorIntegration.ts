/**
 * Integration layer: RiskEngine → Executor
 * 
 * Wires the risk engine's decision output to the executor's on-chain actions.
 * Single function call to set up the entire pipeline.
 */

import { EventEmitter } from "events";
import { RiskEngine, RiskDecision } from "../risk-engine/RiskEngine";
import { ExecutorAgent } from "./executor";

/**
 * Wire the Executor to the RiskEngine.
 * Call once after both are initialized:
 * 
 *   wireExecutor(riskEngine, executorAgent);
 */
export function wireExecutor(riskEngine: RiskEngine, executor: ExecutorAgent): void {
  // Listen for risk decisions
  riskEngine.on("decision", async (decision: RiskDecision) => {
    console.log(`🔗 Integration: RiskEngine emitted decision ${decision.id}`);
    
    try {
      // Execute the decision on-chain
      await executor.executeDecision(decision);
    } catch (error) {
      console.error(`❌ Integration: Failed to execute decision ${decision.id}`, error);
      // In production, retry logic or alert monitoring system
    }
  });

  // Listen for decision cleared (tier dropped to WATCH)
  riskEngine.on("decision:cleared", async ({ poolKey, tier, compositeScore, timestamp }) => {
    console.log(`🔗 Integration: RiskEngine cleared decision for ${poolKey} (tier=${tier})`);
    
    // Deactivate any active protections
    // Extract chain and pair from poolKey
    const [chain, pair] = poolKey.split(":");
    const state = executor.getProtectionState(chain, pair);
    
    if (state && state.action !== null) {
      console.log(`   Deactivating protection for ${poolKey}`);
      // The executor's monitor loop will handle this automatically when TTL expires
      // Or we can explicitly trigger deactivation here if needed
    }
  });

  console.log("🔗 Integration: RiskEngine → Executor wired successfully");
}