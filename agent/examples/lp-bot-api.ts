/**
 * LP Bot Example - REST API Polling
 * 
 * This example shows how LP bots can poll the Threat API server
 * to fetch ELEVATED tier threats via HTTP.
 */

interface ThreatDetails {
  rationale: string;
  contributingSignals: any[];
  signalTypes: string[];
  correlationWindow: number;
  recommendedAction: string;
}

interface RiskMetrics {
  severity: number;
  confidence: number;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

interface SuggestedActions {
  withdrawLiquidity?: boolean;
  reduceLiquidity?: number;
  pauseNewPositions?: boolean;
  increaseSlippage?: number;
}

interface Threat {
  id: string;
  tier: 'ELEVATED';
  action: string;
  compositeScore: number;
  targetPool: string;
  chain: string;
  pair: string;
  timestamp: number;
  expiresAt: number;
  threatDetails: ThreatDetails;
  riskMetrics: RiskMetrics;
  suggestedActions: SuggestedActions;
}

interface ThreatsResponse {
  threats: Threat[];
  count: number;
  timestamp: number;
}

class LPBotAPI {
  private apiUrl: string;
  private myPools: Set<string>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private seenThreats: Set<string>; // Track threats we've already acted on

  constructor(apiUrl: string, myPools: string[]) {
    this.apiUrl = apiUrl;
    this.myPools = new Set(myPools);
    this.seenThreats = new Set();
  }

  async start(pollIntervalMs: number = 10000) {
    console.log('🤖 LP Bot: Starting API polling...');
    console.log(`   API: ${this.apiUrl}`);
    console.log(`   Monitoring ${this.myPools.size} pools`);
    console.log(`   Poll interval: ${pollIntervalMs}ms`);

    // Initial poll
    await this.pollThreats();

    // Set up polling interval
    this.pollInterval = setInterval(async () => {
      await this.pollThreats();
    }, pollIntervalMs);

    console.log('✅ LP Bot: Polling for threats...');
  }

  private async pollThreats() {
    try {
      const response = await fetch(`${this.apiUrl}/api/threats`);
      
      if (!response.ok) {
        console.error(`❌ API error: ${response.status} ${response.statusText}`);
        return;
      }

      const data: ThreatsResponse = await response.json();

      // Filter for our pools and new threats only
      const relevantThreats = data.threats.filter(
        t => this.myPools.has(t.targetPool) && !this.seenThreats.has(t.id)
      );

      for (const threat of relevantThreats) {
        await this.handleThreat(threat);
        this.seenThreats.add(threat.id);
      }

      // Clean up old seen threats (older than 1 hour)
      const oneHourAgo = Date.now() - 3600000;
      for (const id of this.seenThreats) {
        const threat = data.threats.find(t => t.id === id);
        if (!threat || threat.timestamp < oneHourAgo) {
          this.seenThreats.delete(id);
        }
      }
    } catch (error) {
      console.error('❌ Failed to poll threats:', error);
    }
  }

  private async handleThreat(threat: Threat) {
    const now = Date.now();
    const expiresIn = Math.floor((threat.expiresAt - now) / 1000);

    console.log('\n🚨 New threat detected for my pool!');
    console.log(`   Pool: ${threat.targetPool} (${threat.pair})`);
    console.log(`   Chain: ${threat.chain}`);
    console.log(`   Tier: ${threat.tier}`);
    console.log(`   Action: ${threat.action}`);
    console.log(`   Score: ${threat.compositeScore.toFixed(1)}/100`);
    console.log(`   Urgency: ${threat.riskMetrics.urgency}`);
    console.log(`   Confidence: ${threat.riskMetrics.confidence}%`);
    console.log(`   Signals: ${threat.threatDetails.signalTypes.join(', ')}`);
    console.log(`   Recommendation: ${threat.threatDetails.recommendedAction}`);
    console.log(`   Expires in: ${expiresIn}s`);

    // Use suggested actions from the API
    const actions = threat.suggestedActions;

    if (actions.withdrawLiquidity) {
      console.log('   🔴 CRITICAL - Withdrawing all liquidity');
      await this.withdrawAllLiquidity(threat.targetPool);
    } else if (actions.reduceLiquidity) {
      console.log(`   🟡 Reducing liquidity by ${actions.reduceLiquidity}%`);
      await this.reducePosition(threat.targetPool, actions.reduceLiquidity);
    }

    if (actions.pauseNewPositions) {
      console.log('   ⏸️  Pausing new positions');
      await this.pauseNewDeposits(threat.targetPool);
    }

    if (actions.increaseSlippage) {
      console.log(`   ⚡ Increasing slippage by ${actions.increaseSlippage} bps`);
      await this.increaseSlippageTolerance(threat.targetPool, actions.increaseSlippage);
    }
  }

  private async reducePosition(poolId: string, percentage: number) {
    console.log(`   → Reducing liquidity by ${percentage}% for pool ${poolId}`);
    // Implementation: Call Uniswap v4 PoolManager to remove liquidity
  }

  private async withdrawAllLiquidity(poolId: string) {
    console.log(`   → Withdrawing ALL liquidity from pool ${poolId}`);
    // Implementation: Remove all liquidity from pool
  }

  private async pauseNewDeposits(poolId: string) {
    console.log(`   → Pausing new deposits for pool ${poolId}`);
    // Implementation: Set internal flag to prevent new deposits
  }

  private async increaseSlippageTolerance(poolId: string, bps: number) {
    console.log(`   → Increasing slippage tolerance by ${bps} bps for pool ${poolId}`);
    // Implementation: Update slippage settings
  }

  stop() {
    console.log('🛑 LP Bot: Stopping...');
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }
}

// Example usage
async function main() {
  const bot = new LPBotAPI(
    'http://localhost:3000', // Threat API server URL
    [
      'ethereum:ETH/USDC',
      'ethereum:WBTC/USDC',
      'base:ETH/USDC',
    ]
  );

  await bot.start(10000); // Poll every 10 seconds

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

export { LPBotAPI };
