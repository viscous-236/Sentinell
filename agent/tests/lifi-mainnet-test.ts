/**
 * Quick test to verify LI.FI SDK works with mainnet chains
 * Run: ts-node tests/lifi-mainnet-test.ts
 */

import { getChains } from "@lifi/sdk";
import { MAINNET_CHAIN_IDS } from "../src/executor/config/crosschain.config";

async function testLiFiMainnet() {
  console.log("🧪 Testing LI.FI Mainnet Integration\n");

  try {
    // Test 1: Fetch supported chains
    console.log("1️⃣ Fetching LI.FI supported chains...");
    const chains = await getChains();
    
    const supportedChainIds = chains.map((c) => c.id);
    console.log(`   ✅ LI.FI supports ${chains.length} chains`);
    console.log(`   Chain IDs: ${supportedChainIds.slice(0, 10).join(", ")}...`);

    // Test 2: Verify our mainnet chains are supported
    console.log("\n2️⃣ Verifying Sentinel mainnet chains...");
    
    const ethereumSupported = supportedChainIds.includes(MAINNET_CHAIN_IDS.ethereum);
    const baseSupported = supportedChainIds.includes(MAINNET_CHAIN_IDS.base);
    const arbitrumSupported = supportedChainIds.includes(MAINNET_CHAIN_IDS.arbitrum);

    console.log(`   Ethereum (${MAINNET_CHAIN_IDS.ethereum}): ${ethereumSupported ? "✅ Supported" : "❌ NOT SUPPORTED"}`);
    console.log(`   Base (${MAINNET_CHAIN_IDS.base}): ${baseSupported ? "✅ Supported" : "❌ NOT SUPPORTED"}`);
    console.log(`   Arbitrum (${MAINNET_CHAIN_IDS.arbitrum}): ${arbitrumSupported ? "✅ Supported" : "❌ NOT SUPPORTED"}`);

    if (ethereumSupported && baseSupported && arbitrumSupported) {
      console.log("\n🎉 SUCCESS: All Sentinel mainnet chains are supported by LI.FI!");
      return true;
    } else {
      console.log("\n❌ FAILURE: Some mainnet chains are not supported");
      return false;
    }

  } catch (error) {
    console.error("❌ Error testing LI.FI:", error);
    return false;
  }
}

// Run test
testLiFiMainnet()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
