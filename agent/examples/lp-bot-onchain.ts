/**
 * LP Bot Example - On-Chain Event Listener
 * 
 * This example shows how LP bots can listen to ThreatBroadcast events
 * emitted by SentinelHook.sol for ELEVATED tier threats.
 */

import { ethers } from 'ethers';

// SentinelHook ABI (only the event we need)
const HOOK_ABI = [
  "event ThreatBroadcast(bytes32 indexed poolId, string tier, string action, uint256 compositeScore, uint256 timestamp, uint256 expiresAt, string rationale, string[] signalTypes)",
];

interface ThreatEvent {
  poolId: string;
  tier: string;
  action: string;
  compositeScore: bigint;
  timestamp: bigint;
  expiresAt: bigint;
  rationale: string;
  signalTypes: string[];
}

class LPBotOnChain {
  private provider: ethers.Provider;
  private hookContract: ethers.Contract;
  private myPools: Set<string>; // Pools this LP is providing liquidity to

  constructor(
    rpcUrl: string,
    hookAddress: string,
    myPools: string[]
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.hookContract = new ethers.Contract(hookAddress, HOOK_ABI, this.provider);
    this.myPools = new Set(myPools);
  }

  async start() {
    console.log('🤖 LP Bot: Starting on-chain event listener...');
    console.log(`   Monitoring ${this.myPools.size} pools`);

    // Listen to ThreatBroadcast events
    this.hookContract.on(
      'ThreatBroadcast',
      async (
        poolId: string,
        tier: string,
        action: string,
        compositeScore: bigint,
        timestamp: bigint,
        expiresAt: bigint,
        rationale: string,
        signalTypes: string[],
        event: any
      ) => {
        const threat: ThreatEvent = {
          poolId,
          tier,
          action,
          compositeScore,
          timestamp,
          expiresAt,
          rationale,
          signalTypes,
        };

        await this.handleThreat(threat, event.log.transactionHash);
      }
    );

    console.log('✅ LP Bot: Listening for threats...');
  }

  async handleThreat(threat: ThreatEvent, txHash: string) {
    // Only act on pools we're providing liquidity to
    if (!this.myPools.has(threat.poolId)) {
      return;
    }

    const score = Number(threat.compositeScore);
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Number(threat.expiresAt) - now;

    console.log('\n🚨 Threat detected for my pool!');
    console.log(`   Pool ID: ${threat.poolId}`);
    console.log(`   Tier: ${threat.tier}`);
    console.log(`   Action: ${threat.action}`);
    console.log(`   Score: ${score}/100`);
    console.log(`   Signals: ${threat.signalTypes.join(', ')}`);
    console.log(`   Rationale: ${threat.rationale}`);
    console.log(`   Expires in: ${expiresIn}s`);
    console.log(`   Tx: ${txHash}`);

    // LP's custom decision logic
    if (score > 60) {
      console.log('   🔴 HIGH RISK - Reducing position by 50%');
      await this.reducePosition(threat.poolId, 50);
    } else if (score > 40) {
      console.log('   🟡 MEDIUM RISK - Reducing position by 30%');
      await this.reducePosition(threat.poolId, 30);
    } else {
      console.log('   🟢 LOW RISK - Pausing new positions only');
      await this.pauseNewDeposits(threat.poolId);
    }

    // MEV-specific actions
    if (threat.action === 'MEV_PROTECTION') {
      console.log('   ⚡ MEV detected - Increasing slippage tolerance');
      await this.increaseSlippageTolerance(threat.poolId, Math.floor(score / 10) * 5);
    }
  }

  async reducePosition(poolId: string, percentage: number) {
    console.log(`   → Reducing liquidity by ${percentage}% for pool ${poolId}`);
    // Implementation: Call Uniswap v4 PoolManager to remove liquidity
    // Example:
    // const liquidity = await this.getCurrentLiquidity(poolId);
    // const amountToRemove = (liquidity * BigInt(percentage)) / 100n;
    // await poolManager.modifyLiquidity(poolKey, { liquidityDelta: -amountToRemove });
  }

  async pauseNewDeposits(poolId: string) {
    console.log(`   → Pausing new deposits for pool ${poolId}`);
    // Implementation: Set internal flag to prevent new deposits
  }

  async increaseSlippageTolerance(poolId: string, bps: number) {
    console.log(`   → Increasing slippage tolerance by ${bps} bps for pool ${poolId}`);
    // Implementation: Update slippage settings for this pool
  }

  stop() {
    console.log('🛑 LP Bot: Stopping...');
    this.hookContract.removeAllListeners();
  }
}

// Example usage
async function main() {
  const bot = new LPBotOnChain(
    'https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY',
    '0xYourSentinelHookAddress',
    [
      '0x1234...', // Pool IDs you're providing liquidity to
      '0x5678...',
    ]
  );

  await bot.start();

  // Keep running
  process.on('SIGINT', () => {
    bot.stop();
    process.exit(0);
  });
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { LPBotOnChain };
