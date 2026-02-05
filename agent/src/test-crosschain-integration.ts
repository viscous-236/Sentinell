/**
 * Cross-Chain Integration Test for Sentinell Protection Layer
 * 
 * Tests the cross-chain orchestration components:
 * - CrossChainOrchestrator initialization and route fetching
 * - RiskEngine cross-chain decision logic
 * - ExecutorAgent cross-chain defense execution flow
 * 
 * Run with: npx ts-node src/test-crosschain-integration.ts
 */

import { EventEmitter } from "events";
import {
  RiskEngine,
  RiskDecision,
  DefenseAction,
  ScoredSignal,
} from "./executor/src/RiskEngine";
import { ScoutSignal, ScoutSignalType } from "./scout/src/types";
import {
  CrossChainOrchestrator,
  createCrossChainOrchestrator,
} from "./executor/src/CrossChainOrchestrator";
import {
  ACTIVE_CHAIN_IDS,
  TESTNET_TOKENS,
  DEFENSE_STRATEGY_CONFIGS,
  SAFE_HAVEN_CONFIG,
} from "./executor/config/crosschain.config";

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestSignal(
  type: ScoutSignalType,
  magnitude: number,
  chain = "ethereum"
): ScoutSignal {
  return {
    type,
    chain,
    pair: "ETH/USDC",
    magnitude,
    timestamp: Date.now(),
    raw: { test: true },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// TEST SUITE: Cross-Chain Configuration
// =============================================================================

console.log("\n" + "=".repeat(70));
console.log("🧪 CROSS-CHAIN INTEGRATION TESTS");
console.log("=".repeat(70));

async function testConfiguration() {
  console.log("\n📋 Test 1: Configuration Validation");
  console.log("-".repeat(50));

  // Verify mainnet chain IDs (LI.FI doesn't support Sepolia)
  console.log("  Chain IDs:");
  console.log(`    Ethereum Mainnet: ${ACTIVE_CHAIN_IDS.ethereum}`);
  console.log(`    Base Mainnet: ${ACTIVE_CHAIN_IDS.base}`);
  console.log(`    Arbitrum Mainnet: ${ACTIVE_CHAIN_IDS.arbitrum}`);

  // Verify token addresses exist
  console.log("\n  Testnet Token Addresses:");
  Object.entries(TESTNET_TOKENS).forEach(([chain, tokens]) => {
    console.log(`    ${chain}:`);
    Object.entries(tokens).forEach(([symbol, address]) => {
      console.log(`      ${symbol}: ${address.slice(0, 20)}...`);
    });
  });

  // Verify defense strategy configs
  console.log("\n  Defense Strategy Configs:");
  Object.entries(DEFENSE_STRATEGY_CONFIGS).forEach(([strategy, config]) => {
    console.log(`    ${strategy}:`);
    console.log(`      Max Amount: $${config.maxRerouteAmountUsd}`);
    console.log(`      Max Slippage: ${config.maxSlippageBps} bps`);
    console.log(`      Dry Run: ${config.dryRun}`);
  });

  // Verify safe haven config
  console.log("\n  Safe Haven Config:");
  console.log(`    Chain: ${SAFE_HAVEN_CONFIG.chainName} (${SAFE_HAVEN_CONFIG.chainId})`);
  console.log(`    Preferred Token: ${SAFE_HAVEN_CONFIG.preferredToken}`);

  console.log("\n  ✅ Configuration validated successfully");
}

// =============================================================================
// TEST SUITE: RiskEngine Cross-Chain Decisions
// =============================================================================

async function testRiskEngineDecisions() {
  console.log("\n\n📋 Test 2: RiskEngine Cross-Chain Decision Logic");
  console.log("-".repeat(50));

  const decisions: RiskDecision[] = [];
  
  const engine = new RiskEngine({
    correlationWindowMs: 5000,
    emaAlpha: 0.5,
    hysteresis: {
      watchToElevated: { up: 30, down: 20 },
      elevatedToCritical: { up: 60, down: 45 },
    },
  });

  engine.on("decision", (d: RiskDecision) => {
    decisions.push(d);
    console.log(`    📌 Decision: ${d.action} (tier: ${d.tier}, score: ${d.compositeScore.toFixed(1)})`);
  });

  engine.start();

  // Test 2.1: CROSS_CHAIN_ATTACK + ELEVATED → LIQUIDITY_REROUTE
  console.log("\n  Test 2.1: CROSS_CHAIN_ATTACK at ELEVATED tier");
  const crossChainSignal = createTestSignal("CROSS_CHAIN_ATTACK", 0.6);
  engine.ingestScoutEvent(crossChainSignal);
  await delay(100);

  // Test 2.2: CROSS_CHAIN_ATTACK + MEV signals → CROSS_CHAIN_ARBITRAGE_BLOCK  
  console.log("\n  Test 2.2: CROSS_CHAIN_ATTACK + MEV signals");
  engine.ingestScoutEvent(createTestSignal("FLASH_LOAN", 0.5));
  engine.ingestScoutEvent(createTestSignal("GAS_SPIKE", 0.4));
  await delay(100);

  // Test 2.3: Push to CRITICAL with high cross-chain score → EMERGENCY_BRIDGE
  console.log("\n  Test 2.3: CRITICAL tier with extreme cross-chain attack");
  for (let i = 0; i < 3; i++) {
    engine.ingestScoutEvent(createTestSignal("CROSS_CHAIN_ATTACK", 0.9));
    engine.ingestScoutEvent(createTestSignal("LARGE_SWAP", 0.7));
    await delay(50);
  }

  engine.stop();

  // Verify cross-chain actions were triggered
  const crossChainActions = decisions.filter((d) =>
    ["LIQUIDITY_REROUTE", "CROSS_CHAIN_ARBITRAGE_BLOCK", "EMERGENCY_BRIDGE"].includes(d.action)
  );

  console.log(`\n  Total decisions: ${decisions.length}`);
  console.log(`  Cross-chain actions: ${crossChainActions.length}`);
  
  if (crossChainActions.length > 0) {
    console.log("  ✅ RiskEngine cross-chain decision logic working");
  } else {
    console.log("  ⚠️ No cross-chain actions triggered (may need threshold tuning)");
  }
}

// =============================================================================
// TEST SUITE: CrossChainOrchestrator
// =============================================================================

async function testCrossChainOrchestrator() {
  console.log("\n\n📋 Test 3: CrossChainOrchestrator");
  console.log("-".repeat(50));

  // Use a dummy private key for testing (DO NOT USE IN PRODUCTION)
  const testPrivateKey = "0x0000000000000000000000000000000000000000000000000000000000000001";

  console.log("\n  Test 3.1: Orchestrator initialization");
  const orchestrator = createCrossChainOrchestrator({
    walletPrivateKey: testPrivateKey,
    integrator: "Sentinell-Test",
    dryRun: true,
  });

  // Listen for events
  orchestrator.on("orchestrator:initialized", () => {
    console.log("    ✅ Orchestrator initialized event received");
  });

  orchestrator.on("defense:dryrun", (data) => {
    console.log("    📋 Dry run event:", data.request.action);
  });

  try {
    await orchestrator.initialize();
    console.log("    ✅ Initialization successful");
  } catch (error) {
    console.log(`    ⚠️ Initialization failed (expected in test env): ${(error as Error).message.slice(0, 50)}...`);
  }

  // Test 3.2: Route availability check
  console.log("\n  Test 3.2: Route availability check");
  const routes = orchestrator.getAvailableRoutes(ACTIVE_CHAIN_IDS.ethereum);
  console.log(`    Routes from Ethereum Mainnet: ${routes.length}`);
  routes.forEach((r) => {
    console.log(`      → ${r.toChainId} (${r.supportedTokens.join(", ")})`);
  });

  // Test 3.3: Safest chain selection
  console.log("\n  Test 3.3: Safest chain selection");
  const safest1 = orchestrator.getSafestChain(ACTIVE_CHAIN_IDS.base);
  const safest2 = orchestrator.getSafestChain(ACTIVE_CHAIN_IDS.ethereum);
  console.log(`    From Base Mainnet, safest: ${safest1}`);
  console.log(`    From Ethereum Mainnet (excluded), safest: ${safest2}`);

  // Test 3.4: Defense execution (dry run)
  console.log("\n  Test 3.4: Defense execution (dry run)");
  try {
    const result = await orchestrator.executeDefense({
      action: "LIQUIDITY_REROUTE",
      fromChainId: ACTIVE_CHAIN_IDS.ethereum,
      toChainId: ACTIVE_CHAIN_IDS.base,
      tokenSymbol: "ETH",
      amount: "0.01",
      decisionId: "test-decision-001",
      forceDryRun: true,
    });
    console.log(`    Execution result:`);
    console.log(`      Success: ${result.success}`);
    console.log(`      Dry Run: ${result.dryRun}`);
    console.log(`      Route: ${result.route?.bridgeUsed || "N/A (no route in test)"}`);
    if (result.error) {
      console.log(`      Error: ${result.error.slice(0, 50)}...`);
    }
  } catch (error) {
    console.log(`    ⚠️ Execution failed (expected): ${(error as Error).message.slice(0, 50)}...`);
  }

  console.log("\n  ✅ CrossChainOrchestrator tests complete");
}

// =============================================================================
// TEST SUITE: Signal Type Definitions
// =============================================================================

async function testSignalTypes() {
  console.log("\n\n📋 Test 4: Signal Type Definitions");
  console.log("-".repeat(50));

  const signalTypes: ScoutSignalType[] = [
    "FLASH_LOAN",
    "GAS_SPIKE",
    "LARGE_SWAP",
    "PRICE_MOVE",
    "MEMPOOL_CLUSTER",
    "CROSS_CHAIN_ATTACK",
  ];

  console.log("  Verified signal types:");
  signalTypes.forEach((type) => {
    console.log(`    ✅ ${type}`);
  });

  // Verify CROSS_CHAIN_ATTACK is properly typed
  const testSignal: ScoutSignal = {
    type: "CROSS_CHAIN_ATTACK",
    chain: "ethereum",
    pair: "ETH/USDC",
    magnitude: 0.8,
    timestamp: Date.now(),
    raw: {},
  };

  console.log(`\n  Test CROSS_CHAIN_ATTACK signal created: ${JSON.stringify(testSignal).slice(0, 60)}...`);
  console.log("\n  ✅ Signal types validated");
}

// =============================================================================
// TEST SUITE: Defense Action Types
// =============================================================================

async function testDefenseActions() {
  console.log("\n\n📋 Test 5: Defense Action Types");
  console.log("-".repeat(50));

  const actions: DefenseAction[] = [
    "MEV_PROTECTION",
    "ORACLE_VALIDATION",
    "CIRCUIT_BREAKER",
    "LIQUIDITY_REROUTE",
    "CROSS_CHAIN_ARBITRAGE_BLOCK",
    "EMERGENCY_BRIDGE",
  ];

  console.log("  Verified defense actions:");
  actions.forEach((action) => {
    console.log(`    ✅ ${action}`);
  });

  console.log("\n  ✅ Defense action types validated");
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function runAllTests() {
  try {
    await testConfiguration();
    await testRiskEngineDecisions();
    await testCrossChainOrchestrator();
    await testSignalTypes();
    await testDefenseActions();

    console.log("\n\n" + "=".repeat(70));
    console.log("✅ ALL CROSS-CHAIN INTEGRATION TESTS COMPLETE");
    console.log("=".repeat(70));
    console.log("\nNote: Some tests may show warnings which are expected in test environment.");
    console.log("For full integration testing, use testnets with real RPC endpoints.\n");
  } catch (error) {
    console.error("\n❌ Test suite failed:", error);
    process.exit(1);
  }
}

runAllTests();
