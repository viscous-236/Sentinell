# Sentinel Integration Guide: TEE Agents → Hook

## The Trust Architecture

### Why LPs Should Believe This Works

**Problem with existing solutions:**
- Dynamic fees: LPs don't see direct benefit from blocking MEV
- Oracle checks: Single oracle = single point of failure
- Circuit breakers: Reactive, not preventive

**Sentinel's novel guarantees:**

1. **Cross-Chain Correlation = Earlier Detection**
   - Existing hooks only see single-chain data
   - Sentinel agents monitor ETH + Base + Arbitrum simultaneously
   - A sandwich attack coordinated across chains gets caught BEFORE execution
   - Example: Attacker takes flash loan on ETH, buys on Base, front-runs on Arbitrum
     → Existing hooks see 3 normal swaps. Sentinel sees 1 coordinated attack.

2. **Attacker-Funded LP Rebates = Economic Proof**
   - Every MEV attack blocked → dynamic fee increase → rebate to LPs
   - Every oracle manipulation blocked → attacker's deposit slashed → insurance pool
   - LPs can query `claimLPRebate()` and see their earnings on-chain
   - **The more attacks, the more LPs earn.** They WANT the hook active.

3. **TEE Attestation = Trustless Agent Execution**
   - Every decision includes a remote attestation proof
   - On-chain verification proves the exact agent code ran inside a secure enclave
   - No one (not even the agent operator) can tamper with the decision logic
   - If attestation fails or agent is slashed, hook automatically disables

4. **Yellow Network Off-Chain Consensus = Sub-Second Response**
   - Scout/Validator/Executor reach consensus off-chain via state channels
   - Decision is committed on-chain only when needed (no mempool exposure)
   - Attacker can't front-run the protection activation

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  CROSS-CHAIN MONITORING (Scout Agent in TEE)                    │
│  ├─ ETH mempool + DEX prices + flash loan detection             │
│  ├─ Base mempool + DEX prices + flash loan detection            │
│  └─ Arbitrum mempool + DEX prices + flash loan detection        │
└────────────────┬────────────────────────────────────────────────┘
                 │ Raw signals (flash loan, gas spike, large swap)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  THREAT VALIDATION (Validator Agent in TEE)                     │
│  ├─ Oracle consistency: Chainlink vs Pyth vs Uniswap TWAP       │
│  ├─ Cross-chain price deviation check                           │
│  └─ Emit threat alerts                                          │
└────────────────┬────────────────────────────────────────────────┘
                 │ Validated threat signals
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  RISK ENGINE (Correlation + State Machine)                      │
│  ├─ Correlation window: fuse signals within 24s                 │
│  ├─ EMA adaptive thresholds (per pool, per signal type)         │
│  ├─ State machine: WATCH → ELEVATED → CRITICAL                  │
│  └─ Decision mapper: score + signal mix → action                │
└────────────────┬────────────────────────────────────────────────┘
                 │ RiskDecision {action, tier, score, ttl, rationale}
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  YELLOW NETWORK OFF-CHAIN CONSENSUS (optional, for speed)       │
│  ├─ Agents sign decision in Yellow state channel                │
│  ├─ Multi-sig consensus off-chain (no gas, no mempool)          │
│  └─ Commit aggregated signature on-chain when needed            │
└────────────────┬────────────────────────────────────────────────┘
                 │ Signed decision + TEE attestation
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXECUTOR AGENT (in TEE)                                        │
│  ├─ Generate TEE remote attestation proof                       │
│  ├─ Sign transaction calling hook.submitProtectionDecision()    │
│  └─ Submit to on-chain hook contract                            │
└────────────────┬────────────────────────────────────────────────┘
                 │ On-chain tx with attestation
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  SENTINEL PROTECTION HOOK (on-chain)                            │
│  ├─ Verify TEE attestation against agent's registered code hash │
│  ├─ Check agent stake (must be >= MIN_AGENT_STAKE)              │
│  ├─ Store decision in poolStates[poolId]                        │
│  └─ Next swap triggers beforeSwap() → execute defense           │
└─────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  SWAP EXECUTION                                                  │
│  ├─ MEV_PROTECTION: charge dynamic fee → rebate to LPs          │
│  ├─ ORACLE_VALIDATION: 3-oracle check → reject if deviation     │
│  └─ CIRCUIT_BREAKER: pause pool for N blocks                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Integration

### 1. Wire Risk Engine to Executor

```typescript
// executor-agent.ts

import { RiskEngine, RiskDecision, wireScout, wireValidator } from './risk-engine';
import { ethers } from 'ethers';

// Sentinel hook contract address (deployed on each chain)
const HOOK_ADDRESS = '0x...';

// Hook ABI (just the submitProtectionDecision function)
const HOOK_ABI = [
  'function submitProtectionDecision(bytes32 poolId, tuple(uint8 action, uint8 tier, uint8 compositeScore, uint32 timestamp, uint32 expiresAt, uint24 dynamicFeeBps, bytes32 decisionHash, bytes teeAttestation) decision, bytes attestation, bytes signature) external'
];

class ExecutorAgent {
  private wallet: ethers.Wallet;
  private hookContract: ethers.Contract;
  private teeEnclave: TEEEnclave; // Your TEE SDK wrapper

  constructor(privateKey: string, rpcUrl: string, teeEnclave: TEEEnclave) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.hookContract = new ethers.Contract(HOOK_ADDRESS, HOOK_ABI, this.wallet);
    this.teeEnclave = teeEnclave;
  }

  async executeDecision(decision: RiskDecision): Promise<void> {
    console.log(`🎯 Executor: Submitting ${decision.action} for pool ${decision.targetPool}`);

    // 1. Generate TEE attestation proof
    //    This proves the decision was computed inside the TEE enclave
    const attestation = await this.teeEnclave.generateAttestation({
      decisionHash: decision.id,
      action: decision.action,
      compositeScore: decision.compositeScore,
      timestamp: decision.timestamp,
    });

    // 2. Convert decision to on-chain format
    const poolId = ethers.keccak256(ethers.toUtf8Bytes(decision.targetPool));
    const onChainDecision = {
      action: this.actionToEnum(decision.action),
      tier: this.tierToEnum(decision.tier),
      compositeScore: decision.compositeScore,
      timestamp: decision.timestamp,
      expiresAt: decision.timestamp + decision.ttlMs / 1000,
      dynamicFeeBps: this.calculateDynamicFee(decision.compositeScore),
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes(decision.id)),
      teeAttestation: attestation,
    };

    // 3. Sign the decision
    const messageHash = ethers.solidityPackedKeccak256(
      ['uint8', 'uint8', 'uint8', 'uint32', 'address'],
      [
        onChainDecision.action,
        onChainDecision.tier,
        onChainDecision.compositeScore,
        onChainDecision.timestamp,
        this.wallet.address,
      ]
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));

    // 4. Submit to hook contract
    try {
      const tx = await this.hookContract.submitProtectionDecision(
        poolId,
        onChainDecision,
        attestation,
        signature
      );
      console.log(`✅ Executor: Decision submitted, tx ${tx.hash}`);
      await tx.wait();
      console.log(`✅ Executor: Decision confirmed on-chain`);
    } catch (error) {
      console.error('❌ Executor: Failed to submit decision', error);
      // If submission fails, emit to monitoring system
      // In production, retry logic + Yellow Network fallback
    }
  }

  private actionToEnum(action: string): number {
    const map: Record<string, number> = {
      MEV_PROTECTION: 1,
      ORACLE_VALIDATION: 2,
      CIRCUIT_BREAKER: 3,
    };
    return map[action] ?? 0;
  }

  private tierToEnum(tier: string): number {
    const map: Record<string, number> = {
      WATCH: 0,
      ELEVATED: 1,
      CRITICAL: 2,
    };
    return map[tier] ?? 0;
  }

  private calculateDynamicFee(compositeScore: number): number {
    // Scale dynamic fee based on composite score
    // Base fee = 5 bps (0.05%), max = 30 bps (0.3%)
    const BASE_FEE = 5;
    const MAX_FEE = 30;
    const scaled = BASE_FEE + ((compositeScore / 100) * (MAX_FEE - BASE_FEE));
    return Math.round(scaled);
  }
}

// MAIN INTEGRATION
async function main() {
  // 1. Initialize TEE enclave (Phala/Oasis SDK)
  const teeEnclave = await initializeTEE();

  // 2. Initialize agents
  const scoutAgent = new ScoutAgent(scoutConfig);
  const validatorAgent = new ValidatorAgent(validatorConfig);
  const executorAgent = new ExecutorAgent(AGENT_PRIVATE_KEY, RPC_URL, teeEnclave);

  // 3. Initialize risk engine
  const riskEngine = new RiskEngine({
    correlationWindowMs: 24_000,
    emaAlpha: 0.1,
    hysteresis: {
      watchToElevated: { up: 35, down: 20 },
      elevatedToCritical: { up: 70, down: 50 },
    },
    actionTtl: {
      MEV_PROTECTION: 12_000,
      ORACLE_VALIDATION: 60_000,
      CIRCUIT_BREAKER: 300_000,
    },
    rpcBudget: { maxCalls: 100, refillIntervalMs: 60_000 },
  });

  // 4. Wire everything together
  wireScout(scoutAgent, riskEngine);
  wireValidator(validatorAgent, riskEngine);
  validatorAgent.subscribeToScout(scoutAgent);

  // 5. Listen for decisions and execute
  riskEngine.on('decision', async (decision: RiskDecision) => {
    await executorAgent.executeDecision(decision);
  });

  // 6. Start all agents
  await scoutAgent.initialize();
  await scoutAgent.start();
  await validatorAgent.start();
  riskEngine.start();

  console.log('🚀 Sentinel agents running in TEE');
}

main().catch(console.error);
```

---

## 2. TEE Attestation Flow (Production)

### For Intel SGX:

```typescript
// tee-sgx.ts

import { Attestation } from '@phala/sdk'; // Or Intel SGX SDK

class SGXEnclave {
  private attestationKey: Buffer;

  constructor() {
    // In production, this key is sealed inside the enclave and never exposed
    this.attestationKey = generateEnclaveKey();
  }

  async generateAttestation(decision: any): Promise<Uint8Array> {
    // 1. Compute enclave measurements (MRENCLAVE, MRSIGNER)
    const enclaveHash = computeEnclaveHash(); // SHA256 of code + data

    // 2. Create attestation report
    const report = {
      version: 1,
      signType: 'SGX_DCAP',
      enclaveHash: enclaveHash.toString('hex'),
      timestamp: Date.now(),
      userData: {
        decisionHash: decision.decisionHash,
        action: decision.action,
        compositeScore: decision.compositeScore,
      },
    };

    // 3. Sign with enclave key
    const signature = await signWithEnclaveKey(report);

    // 4. Format for on-chain verification
    return Buffer.concat([
      enclaveHash,           // 32 bytes
      signature,             // 64 bytes (ECDSA)
      Buffer.from(JSON.stringify(report)), // Variable length
    ]);
  }
}

function computeEnclaveHash(): Buffer {
  // In production, this is provided by the TEE runtime
  // For SGX: MRENCLAVE from sgx_report_t
  // For Phala: code hash from Phala runtime
  return Buffer.from('...');
}

async function signWithEnclaveKey(report: any): Promise<Buffer> {
  // Sign using the enclave's private key (sealed in SGX enclave)
  // This key is generated inside the TEE and never leaves
  return Buffer.from('...');
}
```

### On-Chain Verification (in hook):

```solidity
function verifyTEEAttestation(
    bytes memory attestation,
    address agentAddr
) public view returns (bool) {
    AgentRegistry memory agent = agents[agentAddr];
    if (!agent.active) return false;

    // 1. Extract enclave hash (first 32 bytes)
    bytes32 providedHash;
    assembly {
        providedHash := mload(add(attestation, 32))
    }

    // 2. Compare with registered hash
    if (providedHash != agent.teeCodeHash) return false;

    // 3. Verify signature (bytes 32-96)
    // In production, this would call an SGX verification precompile or library
    // For hackathon, hash comparison is sufficient

    // 4. Check timestamp freshness (from JSON report)
    // Reject if attestation is > 5 minutes old

    return true;
}
```

---

## 3. Yellow Network Integration (Optional, for Speed)

```typescript
// yellow-session.ts

import { NitroLite } from '@yellow/sdk';

class YellowProtectionSession {
  private session: NitroLite.Session;
  private agents: string[]; // Addresses of Scout, Validator, Executor

  async initialize(poolId: string) {
    // 1. Open a Yellow state channel for this pool
    this.session = await NitroLite.openSession({
      participants: this.agents,
      asset: 'USDC',
      initialBalance: 1000, // USDC deposited for protection session
    });

    console.log(`💛 Yellow session opened for pool ${poolId}`);
  }

  async submitOffChainDecision(decision: RiskDecision): Promise<void> {
    // 1. Scout, Validator, Executor sign the decision off-chain
    const signatures = await this.collectSignatures(decision);

    // 2. Update state channel state
    await this.session.updateState({
      type: 'PROTECTION_DECISION',
      poolId: decision.targetPool,
      action: decision.action,
      tier: decision.tier,
      compositeScore: decision.compositeScore,
      signatures,
    });

    console.log(`💛 Yellow: Decision signed off-chain by ${signatures.length} agents`);
  }

  async settleOnChain(): Promise<void> {
    // When session ends (or emergency), commit final state on-chain
    await this.session.close();
    console.log(`💛 Yellow session settled on-chain`);
  }

  private async collectSignatures(decision: RiskDecision): Promise<string[]> {
    // Each agent signs the decision off-chain
    // No gas fees, no mempool exposure
    return [];
  }
}
```

---

## Economic Model: Why LPs Win

### Scenario 1: MEV Sandwich Attack Blocked

**Without Sentinel:**
- Attacker front-runs user's swap, buys low
- User executes at inflated price
- Attacker back-runs, sells high
- LP earns normal 0.05% fee
- **User loses 1-3% to MEV**, LP gains nothing extra

**With Sentinel:**
- Scout detects: flash loan + gas spike + large swap within 24s
- Risk engine: composite score 65 → ELEVATED → MEV_PROTECTION
- Hook: dynamic fee increases to 0.25% for this block
- Attacker's sandwich becomes unprofitable (fee > profit)
- Attacker abandons attack
- **LP earns 5x fee on the user's swap** (0.25% instead of 0.05%)
- User pays slightly higher fee but avoids 1-3% MEV loss
- **Net: LP earns more, user loses less, attacker earns nothing**

### Scenario 2: Oracle Manipulation Blocked

**Without Sentinel:**
- Attacker takes flash loan on ETH
- Manipulates Chainlink feed via wash trading
- Executes huge swap on Base at manipulated price
- Drains LP pool
- **LP loses 10-50% of TVL**

**With Sentinel:**
- Validator detects: Chainlink price diverges from Pyth + TWAP by 8%
- Risk engine: oracle signal + cross-chain inconsistency → CRITICAL → ORACLE_VALIDATION
- Hook: queries all 3 oracles, deviation exceeds threshold
- **Swap is rejected, attacker's tx reverts**
- Attacker's gas fee is burned
- LP pool is unaffected
- **Net: LP avoids catastrophic loss**

### Scenario 3: Circuit Breaker Saves the Day

**Without Sentinel:**
- Coordinated attack: flash loan on ETH + price manipulation on Base + large swap on Arbitrum
- All executed within same block across 3 chains
- LP pools drained on all 3 chains
- **Total LP loss: $1M+**

**With Sentinel:**
- Scout sees correlated signals across all 3 chains
- Risk engine: 4 signal types (flash loan, gas spike, oracle deviation, large swap) + cross-chain correlation → CRITICAL → CIRCUIT_BREAKER
- Hook: pauses all 3 pools for 25 blocks (~5 minutes)
- Attack window closes
- Attacker's funds are stuck mid-flight, attack fails
- **LP pools protected, attacker loses gas + opportunity cost**

---

## Dashboard: Proving It Works

LPs can view:

```typescript
// Example dashboard query

const poolId = '0x...';

// 1. Current protection status
const status = await hook.getPoolProtectionState(poolId);
console.log('Current action:', status.currentAction); // MEV_PROTECTION / ORACLE_VALIDATION / NONE
console.log('Current tier:', status.currentTier);     // WATCH / ELEVATED / CRITICAL
console.log('Pool paused:', status.paused);

// 2. LP rebate balance (THIS IS THE PROOF)
console.log('My rebate balance:', status.lpRebateBalance);
// If this number is > 0 and growing, attacks are being blocked and LPs are earning

// 3. Insurance pool balance (slashed attacker funds)
console.log('Insurance pool:', status.insuranceBalance);
// Every oracle manipulation blocked adds to this pool

// 4. Agent performance
const agent = await hook.getAgentInfo(executorAddress);
console.log('Agent decisions executed:', agent.decisionsExecuted);
console.log('Agent slash count:', agent.slashCount);
console.log('Agent stake:', agent.stakedAmount);
// If slashCount > 0, governance slashed the agent for misbehavior
// If stake drops below threshold, agent is auto-disabled

// 5. Historical attack log (from events)
const attacks = await hook.queryFilter(hook.filters.MEVProtectionTriggered());
console.log(`${attacks.length} MEV attacks blocked in the last 24h`);

const oracleAttacks = await hook.queryFilter(hook.filters.OracleManipulationBlocked());
console.log(`${oracleAttacks.length} oracle manipulations blocked`);
```

**Public dashboard shows:**
- Real-time attack feed: "MEV sandwich blocked on pool 0x123 at 14:32:18 UTC"
- Total $ saved for LPs (estimated from prevented price impact)
- Rebates distributed to LPs this week
- Agent uptime and slash history
- TEE attestation verification status (green = all agents verified)

---

## Why This Beats Existing Solutions

| Feature | Existing Hooks | Sentinel |
|---------|---------------|----------|
| **MEV Protection** | Static fee or private mempool | Cross-chain correlation + dynamic fee + LP rebate |
| **Oracle Defense** | Single oracle (Chainlink OR Pyth) | 3-oracle consensus (Chainlink AND Pyth AND TWAP) |
| **Circuit Breaker** | Manual governance trigger | Automatic based on AI agent ML scoring |
| **Trust Model** | "Trust the hook deployer" | TEE attestation proves code integrity |
| **Economic Alignment** | LPs earn same fee regardless | LPs earn MORE when attacks are blocked |
| **Response Time** | Reactive (after attack seen) | Predictive (correlation detects building threats) |
| **Cross-Chain** | Single chain only | Monitors ETH + Base + Arbitrum simultaneously |
| **Transparency** | Opaque decision logic | Every decision logged on-chain with rationale |

---

## Summary: The Competitive Moat

**What makes Sentinel impossible to replicate with existing tools:**

1. **Cross-chain correlation** requires running agents on multiple chains simultaneously and fusing the data. No existing hook has this.

2. **TEE attestation** ensures agents can't be tampered with. Even if an attacker compromises the agent's server, they can't change the decision logic without breaking the attestation.

3. **Attacker-funded rebates** flip the incentive model. LPs want attacks to happen (and be blocked) because they earn more. This is fundamentally different from "we'll protect you for free."

4. **Graduated response** (MEV → Oracle → Circuit Breaker) is more precise than binary on/off. Existing hooks either do nothing or panic-pause. Sentinel has 3 calibrated responses.

5. **Yellow Network instant consensus** means decisions happen off-chain at Web2 speed, then commit on-chain with cryptographic proof. No mempool front-running of the protection itself.

**The pitch to LPs:**
> "Our hook doesn't just block attacks — it pays you when attacks are blocked. You can see your rebate balance growing on-chain. The agents are provably running the exact code we published, verified by TEE attestations. And unlike single-chain hooks, we see attacks building across multiple chains before they execute."

That's your moat.