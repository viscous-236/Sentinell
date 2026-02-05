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
  const yellow: YellowConfig = {
    endPoint:
      process.env.YELLOW_ENDPOINT || "wss://clearnet-sandbox.yellow.com/ws",
    agentAddress,
    privateKey: privateKey as `0x${string}`,
    rpcUrl,
    network:
      (process.env.YELLOW_NETWORK as "sandbox" | "production") || "sandbox",
  };

  // Scout Agent config (per ScoutConfig interface in scout.ts)
  const scout: ScoutConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      arbitrum: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    },
    mempool: {
      enabled: process.env.SCOUT_MEMPOOL !== "false",
    },
    dex: {
      enabled: process.env.SCOUT_DEX !== "false",
      updateInterval: parseInt(process.env.SCOUT_DEX_INTERVAL || "30000"),
      pairs: [
        { token0: "WETH", token1: "USDC", dex: "uniswap", chain: "ethereum" },
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
  const validator: ValidatorConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      arbitrum: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
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
  const executor: ExecutorConfig = {
    rpcUrls: {
      ethereum: process.env.ETHEREUM_SEPOLIA_RPC || process.env.ETHEREUM_RPC_URL || rpcUrl,
      base: process.env.BASE_SEPOLIA_RPC || process.env.BASE_RPC_URL || "https://mainnet.base.org",
      arbitrum: process.env.ARBITRUM_SEPOLIA_RPC || process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
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
    yellowOracleAddresses: {
      ethereum: process.env.YELLOW_ORACLE_ETHEREUM_SEPOLIA || "0x0000000000000000000000000000000000000001",
      base: process.env.YELLOW_ORACLE_BASE_SEPOLIA || "0x0000000000000000000000000000000000000001",
      arbitrum: process.env.YELLOW_ORACLE_ARBITRUM_SEPOLIA || "0x0000000000000000000000000000000000000001",
    },
    agentPrivateKey: privateKey,
    teeEnabled: process.env.TEE_ENABLED === "true",
    maxGasPrice: {
      ethereum: parseInt(process.env.MAX_GAS_ETHEREUM || "50"),
      base: parseInt(process.env.MAX_GAS_BASE || "1"),
      arbitrum: parseInt(process.env.MAX_GAS_ARBITRUM || "1"),
    },
  };

  // Threat API config
  const threatAPI: ThreatAPIConfig = {
    port: parseInt(process.env.THREAT_API_PORT || "3001"),
    retentionMs: parseInt(process.env.THREAT_API_RETENTION_MS || "3600000"), // 1 hour default
  };

  return { yellow, scout, validator, riskEngine, executor, threatAPI };
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

  yellowMessageBus = new YellowMessageBus(config.yellow);

  try {
    await yellowMessageBus.initialize("5"); // 5 ytest.usd for session
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

  riskEngine.start();
  await scoutAgent.initialize();
  await scoutAgent.start();
  await validatorAgent.start();

  console.log("\n✅ Sentinel is now protecting pools!");
  console.log(
    "   All agent communication flows through Yellow state channels.",
  );
  console.log(
    `   Threat API available at http://localhost:${config.threatAPI.port}`,
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
