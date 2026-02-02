# Yellow Network Integration

This directory contains the Yellow Network state channel integration for Sentinel off-chain coordination.

## Overview

Yellow Network provides Layer 3 state channels for:
- **Off-chain signal recording** (Scout signals, Validator threat alerts)
- **Decision tracking** (RiskEngine decisions before on-chain execution)
- **Multi-validator consensus** (Signature aggregation)
- **Settlement** (Batch on-chain finalization with gas efficiency)

**Key Principle**: Yellow Network provides off-chain coordination layer. No TEE (Trusted Execution Environment) integration yet - using standard session keys and challenge-response authentication.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Yellow Network Layer                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ClearNode (Sandbox)                                  │  │
│  │  wss://clearnet-sandbox.yellow.com/ws                 │  │
│  │                                                        │  │
│  │  - Authentication (EIP-712)                           │  │
│  │  - Channel Lifecycle (Create → Fund → Close)          │  │
│  │  - Off-Chain Action Recording                         │  │
│  │  - Multi-Signature Aggregation                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
           ▲                        ▲                ▲
           │                        │                │
    ┌──────┴──────┐         ┌──────┴──────┐  ┌─────┴──────┐
    │   Scout     │         │  Validator  │  │ RiskEngine │
    │             │         │             │  │            │
    │ - Signals   │────────▶│ - Threats   │─▶│ - Decisions│
    │ - Clusters  │         │ - Consensus │  │ - Actions  │
    └─────────────┘         └─────────────┘  └────────────┘
```

## Files

- **`nitrolite-client.ts`** - Yellow Network client using `@erc7824/nitrolite` SDK
- **`session-manager.ts`** - High-level session lifecycle management
- **`types.ts`** - TypeScript interfaces for Yellow integration

## Quick Start

### 1. Setup Environment

```bash
# .env
YELLOW_PRIVATE_KEY=0x...
YELLOW_AGENT_ADDRESS=0x...
ALCHEMY_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
```

### 2. Get Test Tokens

Request `ytest.usd` tokens from Yellow Network faucet:

```bash
curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens \
  -H "Content-Type: application/json" \
  -d '{"userAddress":"YOUR_ADDRESS"}'
```

These tokens land in your **Unified Balance** (off-chain clearing layer).

### 3. Initialize Client

```typescript
import { NitroliteClient } from './shared/yellow/nitrolite-client';
import { ProtectionSessionManager } from './shared/yellow/session-manager';

const yellowConfig = {
  endPoint: 'wss://clearnet-sandbox.yellow.com/ws',
  agentAddress: process.env.YELLOW_AGENT_ADDRESS!,
  privateKey: process.env.YELLOW_PRIVATE_KEY! as `0x${string}`,
  rpcUrl: process.env.ALCHEMY_RPC_URL!,
  network: 'sandbox' as const,
};

const yellowClient = new NitroliteClient(yellowConfig);
await yellowClient.connect(); // Auto-authenticates via EIP-712 challenge

const sessionManager = new ProtectionSessionManager(yellowClient);
```

### 4. Channel Lifecycle

```typescript
// Create channel and fund with 20 ytest.usd from Unified Balance
const sessionId = await sessionManager.startSession('20');
console.log('Session started:', sessionId);

// Record threat detection
await sessionManager.recordThreat({
  id: 'threat_123',
  type: 'SANDWICH_ATTACK',
  chain: 'ethereum',
  severity: 85,
  evidence: { /* ... */ },
});

// Record RiskEngine decision
await sessionManager.recordAction({
  type: 'THREAT_APPROVED',
  threatId: 'threat_123',
  txHash: '0xabc...',
});

// Settle and close
const receipt = await sessionManager.settleSession();
console.log('Settlement:', receipt);
```

## Integration with Agents

### Scout Integration

```typescript
// In scout.ts
const scout = new SentinelScout({
  chains: ['ethereum', 'base', 'arbitrum'],
  rpcBudget, // Token bucket for rate limiting
  yellowClient, // Add Yellow client
});

// Scout automatically records signals off-chain
scout.on('signal', async (signal) => {
  if (yellowClient) {
    await yellowClient.recordAction(currentSessionId, {
      type: 'THREAT_DETECTED',
      threatId: signal.id || `signal_${Date.now()}`,
      timestamp: signal.timestamp,
      severity: signal.magnitude * 100,
      metadata: { signalType: signal.type, chain: signal.chain },
    });
  }
  // Continue with normal signal emission
});
```

### Validator Integration

```typescript
// In validator.ts
const validator = new SentinelValidator({
  chains: ['ethereum', 'base', 'arbitrum'],
  aggregator, // ThreatAggregator (metrics-only)
  yellowClient, // Add Yellow client
});

// Validator records threat alerts with multi-validator signatures
validator.on('threat:aggregation', async (aggregation) => {
  if (yellowClient) {
    await yellowClient.recordAction(currentSessionId, {
      type: 'THREAT_DETECTED',
      threatId: `threat_${Date.now()}`,
      timestamp: aggregation.timestamp,
      severity: aggregation.aggregateSeverity,
      metadata: {
        signalCount: aggregation.signalCount,
        signalTypes: aggregation.signalTypes,
      },
    });
  }
  // Continue to RiskEngine
});
```

### RiskEngine Integration

```typescript
// In RiskEngine.ts
riskEngine.on('decision', async (decision) => {
  if (yellowClient) {
    await yellowClient.recordAction(currentSessionId, {
      type: 'THREAT_APPROVED',
      threatId: decision.poolKey,
      timestamp: Date.now(),
      metadata: {
        tier: decision.tier,
        compositeScore: decision.compositeScore,
      },
    });
  }
  // Continue to Executor
});
```

## Session Lifecycle States

```
┌──────────────┐
│  CREATED     │ ← Channel opened, not funded
└──────┬───────┘
       │ allocate_amount (from Unified Balance)
       ▼
┌──────────────┐
│  FUNDED      │ ← Channel active, can record actions
└──────┬───────┘
       │ off-chain actions recorded
       ▼
┌──────────────┐
│  CLOSING     │ ← Cooperative close initiated
└──────┬───────┘
       │ on-chain settlement
       ▼
┌──────────────┐
│  SETTLED     │ ← Final balances committed to L1
└──────────────┘
```

## Key Concepts

### 1. **Unified Balance vs Channel Balance**

- **Unified Balance**: Off-chain balance in Yellow's clearing layer (from faucet)
- **Channel Balance**: Allocated to specific state channel for transactions
- Use `allocate_amount` to move funds: Unified Balance → Channel
- Use `resize_amount` only if depositing directly to L1 Custody Contract

### 2. **Session Keys**

- **Main Wallet**: Signs EIP-712 auth challenge (once per session)
- **Session Key**: Temporary key for signing off-chain actions (gasless)
- Session keys expire after 1 hour (configurable in `expires_at`)

### 3. **Challenge-Response Authentication**

```typescript
// Flow:
1. Client sends auth_request with session_key
2. ClearNode responds with auth_challenge
3. Client signs challenge with MAIN wallet (EIP-712)
4. Client sends auth_verify
5. ClearNode confirms → authenticated ✅
```

### 4. **Action Recording**

All Sentinel actions are recorded off-chain with signatures:
- `THREAT_DETECTED` - Scout signals, Validator alerts
- `THREAT_APPROVED` - RiskEngine decides to activate protection
- `THREAT_REJECTED` - RiskEngine decides no action needed
- `HOOK_ACTIVATED` - Executor confirms on-chain hook activation

### 5. **Settlement**

Periodic settlement batches all off-chain actions to L1:
- Reduces gas costs (1 tx per session vs N txs per action)
- Provides cryptographic proof of all decisions
- Enables dispute resolution if needed

## Configuration

```typescript
interface YellowConfig {
  endPoint: string;        // WebSocket endpoint
  agentAddress: string;    // Ethereum address
  privateKey: `0x${string}`; // Private key for signing
  rpcUrl: string;          // RPC for on-chain operations (Sepolia)
  network: 'sandbox' | 'production';
}
```

## Sandbox vs Production

| Feature | Sandbox | Production |
|---------|---------|------------|
| Endpoint | `wss://clearnet-sandbox.yellow.com/ws` | TBD |
| Token | `ytest.usd` (Sepolia testnet) | Real tokens |
| Custody | `0x019B65A265EB3363822f2752141b3dF16131b262` | TBD |
| Adjudicator | `0x7c7ccbc98469190849BCC6c926307794fDfB11F2` | TBD |
| Challenge Duration | 3600s (1 hour) | TBD |

## Troubleshooting

### `InsufficientBalance`
**Cause**: Trying to use `resize_amount` without L1 deposit.  
**Fix**: Use `allocate_amount` to fund from Unified Balance (faucet).

### `DepositAlreadyFulfilled`
**Cause**: Double-submitting channel creation or funding.  
**Fix**: Check if channel already exists before creating.

### `InvalidState`
**Cause**: Operating on closed channel or version mismatch.  
**Fix**: Create new session after previous one closes.

### `operation denied: non-zero allocation`
**Cause**: Too many open channels.  
**Fix**: Close old channels before creating new ones.

## Future Enhancements

- [ ] TEE attestation integration (EigenLayer Compute)
- [ ] Multi-validator signature aggregation
- [ ] Automatic session rotation (time-based or action-count-based)
- [ ] Session resumption after disconnect
- [ ] Gas optimization via batched settlements
- [ ] Cross-chain Yellow Network bridges (Ethereum ↔ Base ↔ Arbitrum)

## References

- [Yellow Network Docs](https://docs.yellow.org/docs/learn/)
- [Quickstart Guide](https://docs.yellow.org/docs/learn/getting-started/quickstart)
- [Nitrolite SDK](https://github.com/layer-3/nitrolite)
- [State Channels vs L1/L2](https://docs.yellow.org/docs/learn/core-concepts/state-channels-vs-l1-l2)
