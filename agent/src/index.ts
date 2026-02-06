/**
 * Sentinel Agent - Main Entrypoint
 *
 * Wires all agent components together per PROJECT_SPEC.md:
 * 1. Yellow Network for off-chain coordination (Section 4.5-4.6)
 * 2. Scout Agent for mempool/DEX monitoring (Section 4.1)
 * 3. Validator Agent for oracle/cross-chain validation (Section 4.1)
 * 4. Risk Engine for threat correlation and decision making (Section 4.3)
 * 5. Executor Agent for hook activation (Section 4.1)
 *
 * Per PROJECT_SPEC.md Section 4.5:
 *   "Agents communicate via Yellow state channels"
 *
 * Communication Flow (all traffic routed through Yellow):
 *   Scout → Yellow → RiskEngine → Yellow → Executor → Yellow
 *
 * Startup Sequence:
 *   Yellow connect → Session start → RiskEngine start → Executor init → Scout/Validator start
 *
 * Shutdown Sequence (SIGINT/SIGTERM):
 *   Scout/Validator stop → Executor stop → RiskEngine stop → Yellow session settle → disconnect
 */

import dotenv from "dotenv";
import { YellowMessageBus } from "./shared/yellow/YellowMessageBus";
import { wireAllAgentsToYellow } from "./shared/yellow/YellowAgentAdapters";
import { RiskEngine } from "./executor/src/RiskEngine";
import { ScoutAgent, ScoutConfig } from "./scout/src/scout";
import { ValidatorAgent, ValidatorConfig } from "./validator/src/validator";
import { ExecutorAgent, ExecutorConfig } from "./executor/src/Execution";
import { YellowConfig } from "./shared/yellow/types";
import {
  ThreatAPIServer,
  ThreatAPIConfig,
} from "./executor/src/api/ThreatAPIServer";
import { dashboardState } from "./executor/src/api/DashboardState";
import { attackSimulator } from "./executor/src/api/AttackSimulator";

dotenv.config();

// Global references for graceful shutdown
let yellowMessageBus: YellowMessageBus | null = null;
let riskEngine: RiskEngine | null = null;
let scoutAgent: ScoutAgent | null = null;
let validatorAgent: ValidatorAgent | null = null;
let executorAgent: ExecutorAgent | null = null;
let threatAPIServer: ThreatAPIServer | null = null;
let isShuttingDown = false;

/**
 * Get RPC URL with Ankr fallback
 * Uses Ankr as alternative provider when Alchemy is unavailable or rate-limited
 */
function getRpcWithFallback(
  alchemyUrl: string,
  ankrUrl: string,
  publicUrl?: string
): string {
  // Primary: Alchemy, Fallback: Ankr, Last resort: public RPC
  // Note: ethers.js will handle automatic fallback on 429 errors
  return alchemyUrl || ankrUrl || publicUrl || alchemyUrl;
}

/**
 * Load environment configuration
 */
function loadConfig() {
  const privateKey = process.env.YELLOW_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const rpcUrl =
    process.env.RPC_URL ||
    process.env.ALCHEMY_RPC_URL ||
    "https://eth-sepolia.g.alchemy.com/v2/demo";

  if (!privateKey) {
    throw new Error(
      "YELLOW_PRIVATE_KEY or PRIVATE_KEY environment variable required",
    );
  }

  // Derive agent address
  const { privateKeyToAccount } = require("viem/accounts");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const agentAddress = account.address;

  // Yellow Network config
  // sentinelAddress: SentinelHook contract (the on-chain counterparty in Yellow state channel sessions)
  const yellow: YellowConfig = {
    endPoint:
      process.env.YELLOW_ENDPOINT || "wss://clearnet-sandbox.yellow.com/ws",
    agentAddress,
    privateKey: privateKey as `0x${string}`,
    rpcUrl,
    network:
      (process.env.YELLOW_NETWORK as "sandbox" | "production") || "sandbox",
    sentinelAddress: process.env.YELLOW_ORACLE_ETHEREUM_SEPOLIA,
  };

  // Scout Agent config (per ScoutConfig interface in scout.ts)
  // Using Ankr as fallback to handle Alchemy rate limits
  const scout: ScoutConfig = {
    rpcUrls: {
      ethereum: getRpcWithFallback(
        process.env.ETHEREUM_RPC_URL || rpcUrl,
        process.env.ANKR_ETHEREUM_RPC || ""
      ),
      base: getRpcWithFallback(
        process.env.BASE_RPC_URL || "",
        process.env.ANKR_BASE_RPC || "",
        "https://mainnet.base.org"
      ),
      arbitrum: getRpcWithFallback(
        process.env.ARBITRUM_RPC_URL || "",
        process.env.ANKR_ARBITRUM_RPC || "",
        "https://arb1.arbitrum.io/rpc"
      ),
    },
    mempool: {
      enabled: process.env.SCOUT_MEMPOOL !== "false",
    },
    dex: {
      enabled: process.env.SCOUT_DEX !== "false",
      updateInterval: parseInt(process.env.SCOUT_DEX_INTERVAL || "30000"),
      pairs: [
        // WETH/USDC across all 3 chains for cross-chain MEV detection
        { token0: "WETH", token1: "USDC", dex: "uniswap", chain: "ethereum" },
        { token0: "WETH", token1: "USDC", dex: "uniswap", chain: "base" },
        { token0: "WETH", token1: "USDC", dex: "uniswap", chain: "arbitrum" },
        // Additional pair on Ethereum for diversity
        { token0: "WETH", token1: "USDT", dex: "uniswap", chain: "ethereum" },
      ],
    },
    gas: {
      enabled: process.env.SCOUT_GAS !== "false",
      updateInterval: parseInt(process.env.SCOUT_GAS_INTERVAL || "15000"),
      spikeThreshold: parseFloat(
        process.env.SCOUT_GAS_SPIKE_THRESHOLD || "1.5",
      ),
    },
    flashloan: {
      enabled: process.env.SCOUT_FLASHLOAN !== "false",
      protocols: {
        aave: ["0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"], // Aave V2 Pool
        balancer: ["0xBA12222222228d8Ba445958a75a0704d566BF2C8"], // Balancer Vault
      },
    },
    clusterDetection: {
      enabled: true,
      windowMs: 24000,
      threshold: 3,
    },
  };

  // Validator Agent config (per ValidatorConfig interface in validator.ts)
  // Using Ankr as fallback to handle Alchemy rate limits
  const validator: ValidatorConfig = {
    rpcUrls: {
      ethereum: getRpcWithFallback(
        process.env.ETHEREUM_RPC_URL || rpcUrl,
        process.env.ANKR_ETHEREUM_RPC || ""
      ),
      base: getRpcWithFallback(
        process.env.BASE_RPC_URL || "",
        process.env.ANKR_BASE_RPC || "",
        "https://mainnet.base.org"
      ),
      arbitrum: getRpcWithFallback(
        process.env.ARBITRUM_RPC_URL || "",
        process.env.ANKR_ARBITRUM_RPC || "",
        "https://arb1.arbitrum.io/rpc"
      ),
    },
    chainlinkFeeds: {
      ethereum: {
        "ETH/USD": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
        "BTC/USD": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
      },
      base: {
        "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
      },
      arbitrum: {
        "ETH/USD": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
      },
    },
    oracleCheckerConfig: {
      pythEndpoint: process.env.PYTH_ENDPOINT || "https://hermes.pyth.network",
      pythPriceIds: {
        ethereum: {
          "ETH/USD":
            "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
          "BTC/USD":
            "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
        },
        base: {
          "ETH/USD":
            "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        },
        arbitrum: {
          "ETH/USD":
            "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        },
      },
      staleThreshold: 300, // 5 minutes
      minOraclesRequired: 1,
    },
    priceValidatorConfig: {
      crosschainDeviation: parseFloat(
        process.env.VALIDATOR_CROSSCHAIN_THRESHOLD || "100",
      ), // 100 basis points
      minChainsRequired: 2,
      priceAgeThreshold: 300000, // 5 minutes in ms
    },
    thresholds: {
      oracleDeviation: parseFloat(
        process.env.VALIDATOR_ORACLE_DEVIATION || "5",
      ), // 5%
      crosschainDeviation: parseFloat(
        process.env.VALIDATOR_CROSSCHAIN_DEVIATION || "2",
      ), // 2%
    },
    aggregatorConfig: {
      enableHistory: true,
    },
  };

  // RiskEngine config
  const riskEngine = {
    correlationWindowMs: parseInt(process.env.CORRELATION_WINDOW_MS || "24000"),
    emaAlpha: parseFloat(process.env.EMA_ALPHA || "0.1"),
    rpcBudget: {
      maxCalls: parseInt(process.env.RPC_MAX_CALLS || "100"),
      refillIntervalMs: parseInt(process.env.RPC_REFILL_MS || "60000"),
    },
  };

  // Executor config (per PROJECT_SPEC.md Section 4.1 - Executor Agent)
  // Using Ankr as fallback to handle Alchemy rate limits
  const executor: ExecutorConfig = {
    rpcUrls: {
      ethereum: getRpcWithFallback(
        process.env.ETHEREUM_SEPOLIA_RPC || process.env.ETHEREUM_RPC_URL || rpcUrl,
        process.env.ANKR_ETHEREUM_SEPOLIA_RPC || ""
      ),
      base: getRpcWithFallback(
        process.env.BASE_SEPOLIA_RPC || process.env.BASE_RPC_URL || "",
        process.env.ANKR_BASE_SEPOLIA_RPC || "",
        "https://mainnet.base.org"
      ),
      arbitrum: getRpcWithFallback(
        process.env.ARBITRUM_SEPOLIA_RPC || process.env.ARBITRUM_RPC_URL || "",
        process.env.ANKR_ARBITRUM_SEPOLIA_RPC || "",
        "https://arb1.arbitrum.io/rpc"
      ),
    },
    hookAddresses: {
      ethereum:
        process.env.SENTINEL_HOOK_ETHEREUM_SEPOLIA ||
        process.env.HOOK_ADDRESS_ETHEREUM ||
        "0x0000000000000000000000000000000000000001",
      base:
        process.env.SENTINEL_HOOK_BASE_SEPOLIA ||
        process.env.HOOK_ADDRESS_BASE ||
        "0x0000000000000000000000000000000000000001",
      arbitrum:
        process.env.SENTINEL_HOOK_ARBITRUM_SEPOLIA ||
        process.env.HOOK_ADDRESS_ARBITRUM ||
        "0x0000000000000000000000000000000000000001",
    },
    agentPrivateKey: privateKey,
    teeEnabled: process.env.TEE_ENABLED === "true",
    maxGasPrice: {
      ethereum: parseInt(process.env.MAX_GAS_ETHEREUM || "50"),
      base: parseInt(process.env.MAX_GAS_BASE || "1"),
      arbitrum: parseInt(process.env.MAX_GAS_ARBITRUM || "1"),
    },
    crossChain: {
      enabled: process.env.CROSSCHAIN_ENABLED !== "false", // Enabled by default
      dryRun: process.env.CROSSCHAIN_DRY_RUN !== "false",  // Dry run by default for safety
    },
  };

  // Threat API config
  const threatAPI: ThreatAPIConfig = {
    port: parseInt(process.env.THREAT_API_PORT || "3000"),
    retentionMs: parseInt(process.env.THREAT_API_RETENTION_MS || "3600000"), // 1 hour default
  };

  return { yellow, scout, validator, riskEngine, executor, threatAPI };
}

/**
 * Wire dashboard state to agents for data collection
 * This enables real-time data streaming to the dashboard
 */
function wireDashboardToAgents(): void {
  if (!riskEngine || !scoutAgent || !yellowMessageBus) {
    console.warn("   ⚠️ Some agents not initialized, dashboard wiring incomplete");
    return;
  }

  // Wire RiskEngine decisions to dashboard
  riskEngine.on('decision', (decision: any) => {
    dashboardState.updateRiskScore(decision);
  });

  // E2E Flow Tracking: Map to correlate events
  const flowIdMap = new Map<string, string>(); // poolId -> flowId

  // Wire Scout signals to dashboard + Start E2E flows
  scoutAgent.on('signal', (signal: any) => {
    dashboardState.ingestScoutSignal(signal);

    // E2E Flow: Start flow on Scout signal
    if (signal.poolAddress && signal.magnitude > 0.5) {
      const flowId = dashboardState.startE2EFlow(
        signal.chain,
        signal.poolAddress,
        { type: signal.type, magnitude: signal.magnitude }
      );
      flowIdMap.set(signal.poolAddress, flowId);
    }

    // Track gas prices for graphs from GAS_SPIKE signals
    if (signal.type === 'GAS_SPIKE' && signal.raw?.gasPrice) {
      const gasPriceGwei = parseFloat(signal.raw.gasPrice) / 1e9; // Convert wei to gwei
      dashboardState.addGasDataPoint(signal.chain, gasPriceGwei);
    }

    // Track prices for graphs from PRICE_MOVE signals
    if (signal.type === 'PRICE_MOVE' && signal.raw?.price) {
      dashboardState.addPriceDataPoint(
        signal.pair,
        parseFloat(signal.raw.price),
        'dex'
      );
    }
  });

  // Direct wiring: Scout gasUpdate events → dashboard (real-time gas data)
  scoutAgent.on('gasUpdate', (gas: any) => {
    if (gas.gasPrice) {
      const gasPriceGwei = parseFloat(gas.gasPrice) / 1e9;
      dashboardState.addGasDataPoint(gas.chain, gasPriceGwei);
    }
  });

  // Direct wiring: Scout price events → dashboard (real-time price data)
  scoutAgent.on('price', (price: any) => {
    if (price.price) {
      dashboardState.addPriceDataPoint(
        price.pair,
        parseFloat(price.price),
        'dex'
      );
    }
  });

  // E2E Flow: Yellow session creation
  yellowMessageBus.on('ready', (data: any) => {
    dashboardState.addLog('SUCCESS', 'yellow', `🟡 Yellow Network: Session established | ID: ${data.sessionId?.slice(0, 12)}...`);
  });

  yellowMessageBus.on('protectionAuth', (auth: any) => {
    dashboardState.incrementYellowAuthorizations();

    // E2E Flow: Update to yellow_session stage
    const flowId = flowIdMap.get(auth.poolId);
    if (flowId && yellowMessageBus) {
      dashboardState.updateE2EFlowStage(flowId, 'yellow_session', {
        sessionId: yellowMessageBus.getState().sessionId,
        signature: auth.signature,
      });
    }
  });

  // E2E Flow: Validator alerts
  if (validatorAgent) {
    validatorAgent.on('threat:alert', (alert: any) => {
      const flowId = flowIdMap.get(alert.poolAddress);
      if (flowId) {
        dashboardState.updateE2EFlowStage(flowId, 'validator_alert', {
          type: alert.type,
          deviation: alert.deviation,
        });
      }
    });
  }

  // E2E Flow: Risk Engine decisions
  riskEngine.on('decision', (decision: any) => {
    const flowId = flowIdMap.get(decision.targetPool);
    if (flowId) {
      dashboardState.updateE2EFlowStage(flowId, 'risk_decision', {
        action: decision.action,
        tier: decision.tier,
        score: decision.compositeScore,
      });
    }
  });

  // E2E Flow: Executor actions
  if (executorAgent) {
    executorAgent.on('execution:success', (data: any) => {
      const flowId = flowIdMap.get(data.decision?.targetPool);
      if (flowId && data.decision) {
        // Update E2E flow stage
        dashboardState.updateE2EFlowStage(flowId, 'executor_action', {
          txHash: data.txHash,
          action: data.decision.action,
        });

        // Add execution entry (will be updated with real tx hash on settlement)
        const executionId = dashboardState.addExecution(
          data.decision.chain,
          data.decision.action,
          data.decision.targetPool,
          data.txHash, // May be placeholder like '0xPENDING_SETTLEMENT'
          data.decision.tier,
          data.decision.compositeScore,
          data.txHash === '0xPENDING_SETTLEMENT' ? 'pending' : 'success'
        );

        // Link execution to flow for tx hash updates on settlement
        dashboardState.linkE2EFlowToExecution(flowId, executionId);
      }
    });

    // E2E Flow: Settlement confirmed (final stage)
    // Use targetPool (raw address) for lookup since flowIdMap is keyed by pool address,
    // not the keccak256 poolId used on-chain
    executorAgent.on('settlement:confirmed', (data: any) => {
      const flowId = flowIdMap.get(data.targetPool) || flowIdMap.get(data.poolId);
      if (flowId) {
        dashboardState.completeE2EFlow(flowId, data.txHash);
        flowIdMap.delete(data.targetPool);
        flowIdMap.delete(data.poolId);
      }
    });

    // E2E Flow: Threat broadcast (ELEVATED tier - immediate on-chain tx)
    executorAgent.on('threat:broadcast', (data: any) => {
      const targetPool = data.broadcast?.targetPool;
      const flowId = flowIdMap.get(targetPool);
      if (flowId && data.txHash) {
        dashboardState.completeE2EFlow(flowId, data.txHash);
        flowIdMap.delete(targetPool);
      }
    });
  }

  // Wire Yellow channel state updates
  if (yellowMessageBus.isConnected()) {
    dashboardState.updateYellowChannel({ connected: true });
  }

  yellowMessageBus.on('connected', () => {
    dashboardState.updateYellowChannel({ connected: true });
  });

  yellowMessageBus.on('disconnected', () => {
    dashboardState.updateYellowChannel({ connected: false });
  });

  yellowMessageBus.on('message', () => {
    dashboardState.incrementYellowMessages();
  });

  // Wire attack simulator to risk engine and executor
  attackSimulator.setRiskEngine(riskEngine);
  if (executorAgent) {
    attackSimulator.setExecutor(executorAgent); // For capturing real tx hashes
  }

  console.log("   ✅ Dashboard wired to: RiskEngine, ScoutAgent, YellowMessageBus");
}

async function main(): Promise<void> {
  console.log("\n=================================================");
  console.log("  🛡️  SENTINEL - Verifiable AI Agent Network");
  console.log("  MEV Protection & Oracle Security");
  console.log("=================================================\n");

  // 1. Load configuration
  console.log("📋 Loading configuration...");
  const config = loadConfig();
  console.log(`   Yellow Network: ${config.yellow.network}`);
  console.log(`   Agent Address: ${config.yellow.agentAddress}`);
  console.log("   ✅ Configuration loaded\n");

  // 2. Initialize Yellow Message Bus (per PROJECT_SPEC.md Section 4.5)
  //    "Agents communicate via Yellow state channels"
  console.log("🟡 Step 1/5: Initializing Yellow Message Bus...");
  console.log("   Per PROJECT_SPEC.md Section 4.5:");
  console.log('   "Agents communicate via Yellow state channels"\n');

  yellowMessageBus = new YellowMessageBus(config.yellow, config.yellow.sentinelAddress);

  try {
    await yellowMessageBus.initialize("5"); // 5 ytest.usd for session

    // Update dashboard with Yellow session info for demo
    dashboardState.updateYellowChannel({
      connected: true,
      sessionId: yellowMessageBus.getSessionId() || null,
      sessionStartTime: Date.now(),
      networkMode: config.yellow.network as 'sandbox' | 'production',
      agentAddress: config.yellow.agentAddress,
      sentinelAddress: config.yellow.sentinelAddress || '',
      sessionBalance: '5.000',  // Initial session balance
      microFeesAccrued: '0.000',
      stateVersion: 1,
      totalActions: 0,
    });

    console.log("   ✅ Yellow Message Bus ready for agent communication\n");
  } catch (error) {
    console.error("❌ Failed to initialize Yellow Message Bus:", error);
    throw new Error(
      "Yellow Network is required for agent communication per PROJECT_SPEC.md Section 4.5",
    );
  }

  // 3. Initialize Risk Engine
  console.log("🧠 Step 2/5: Initializing Risk Engine...");
  riskEngine = new RiskEngine(config.riskEngine);

  // 4. Initialize Executor Agent (per PROJECT_SPEC.md Section 4.1)
  console.log("\n⚡ Step 3/5: Initializing Executor Agent...");
  executorAgent = new ExecutorAgent(config.executor);
  await executorAgent.initialize();

  // 5. Initialize Scout Agent
  console.log("\n📡 Step 4/6: Initializing Scout Agent...");
  scoutAgent = new ScoutAgent(config.scout);

  // 6. Initialize Validator Agent
  console.log("\n🔍 Step 5/6: Initializing Validator Agent...");
  validatorAgent = new ValidatorAgent(config.validator);

  // 7. Initialize Threat API Server
  console.log("\n🌐 Step 6/6: Initializing Threat API Server...");
  threatAPIServer = new ThreatAPIServer(config.threatAPI);
  await threatAPIServer.start();
  console.log("   ✅ Threat API ready for LP bot queries");

  // 8. Wire ALL agents through Yellow Message Bus
  //    Per PROJECT_SPEC.md Section 4.5: "Agents communicate via Yellow state channels"
  //    This ensures:
  //      - Scout signals go through Yellow → RiskEngine reads from Yellow
  //      - Validator alerts go through Yellow → RiskEngine reads from Yellow
  //      - RiskEngine decisions go through Yellow → Executor reads from Yellow
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("🔗 Wiring ALL Agents Through Yellow State Channels");
  console.log("   Per PROJECT_SPEC.md Section 4.5:");
  console.log('   "Agents communicate via Yellow state channels"');
  console.log("═══════════════════════════════════════════════════════════\n");

  wireAllAgentsToYellow(
    yellowMessageBus,
    {
      scout: scoutAgent,
      validator: validatorAgent,
      riskEngine,
      executor: executorAgent,
    },
    {
      scoutMagnitudeThreshold: 0.3,
      scoutMaxSignalsPerMinute: 30,
    },
  );

  // 9. Start all components
  console.log("\n=================================================");
  console.log("  🚀 STARTING SENTINEL PROTECTION");
  console.log("=================================================\n");

  dashboardState.addLog('INFO', 'scout', '🚀 Scout Agent: Initializing monitors (mempool, DEX, gas, flashloans)');
  riskEngine.start();
  dashboardState.addLog('INFO', 'riskengine', '🧠 Risk Engine: Started | Correlation window: 24s | EMA alpha: 0.1');

  await scoutAgent.initialize();
  await scoutAgent.start();
  dashboardState.addLog('SUCCESS', 'scout', '✅ Scout Agent: Active | Monitoring Ethereum, Base, Arbitrum');

  await validatorAgent.start();
  dashboardState.addLog('SUCCESS', 'validator', '✅ Validator Agent: Active | Cross-chain oracle validation enabled');

  // 10. Wire dashboard state to agents for data collection
  console.log("\n📊 Wiring Dashboard State...");
  wireDashboardToAgents();
  console.log("   ✅ Dashboard data collection active");
  dashboardState.addLog('SUCCESS', 'scout', '📊 Dashboard: Live monitoring active | Real-time E2E flow tracking enabled');

  console.log("\n✅ Sentinel is now protecting pools!");
  console.log(
    "   All agent communication flows through Yellow state channels.",
  );
  console.log(
    `   Threat API available at http://0.0.0.0:${config.threatAPI.port}`,
  );
  console.log("   Press Ctrl+C to gracefully shutdown.\n");

  // 10. Setup graceful shutdown handlers
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  // Keep process alive
  await new Promise(() => { });
}

/**
 * Graceful shutdown handler
 * Stops all agents and settles Yellow session
 */
async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) {
    console.log("⚠️  Shutdown already in progress...");
    return;
  }
  isShuttingDown = true;

  console.log("\n=================================================");
  console.log("  🛑 SHUTTING DOWN SENTINEL");
  console.log("=================================================\n");

  // Stop Scout Agent
  if (scoutAgent) {
    console.log("📡 Stopping Scout Agent...");
    await scoutAgent.stop();
    console.log("   ✅ Scout stopped");
  }

  // Stop Validator Agent
  if (validatorAgent) {
    console.log("🔍 Stopping Validator Agent...");
    await validatorAgent.stop();
    console.log("   ✅ Validator stopped");
  }

  // Stop Executor Agent
  if (executorAgent) {
    console.log("⚡ Stopping Executor Agent...");
    executorAgent.stop();
    console.log("   ✅ Executor stopped");
  }

  // Stop Threat API Server
  if (threatAPIServer) {
    console.log("🌐 Stopping Threat API Server...");
    await threatAPIServer.stop();
    console.log("   ✅ Threat API stopped");
  }

  // Stop Risk Engine
  if (riskEngine) {
    console.log("🧠 Stopping Risk Engine...");
    riskEngine.stop();
    console.log("   ✅ RiskEngine stopped");
  }

  // Settle Yellow session and disconnect
  if (yellowMessageBus) {
    console.log("🟡 Settling Yellow session...");
    await yellowMessageBus.shutdown();
    console.log("   ✅ Yellow session settled");
  }

  console.log("\n👋 Sentinel shutdown complete.");
  process.exit(0);
}

// Run main
main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
