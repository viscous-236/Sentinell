## Project Name
Sentinel

## Tagline
Verifiable AI Agent Network for Cross-Chain MEV Protection & Oracle Security

---

## 1. High-Level Overview

Sentinel is a decentralized security infrastructure that uses verifiable AI agents running inside Trusted Execution Environments (TEEs) to protect DeFi liquidity from MEV attacks and oracle manipulation across multiple chains.

The system continuously monitors cross-chain mempools, liquidity pools, and oracle prices, correlates weak signals into high-confidence threats using an on-chain/off-chain Risk Engine, and autonomously executes defensive actions using Uniswap v4 hooks.

All agent actions are cryptographically verifiable via TEE remote attestations, ensuring trustless, auditable, and non-custodial security automation.

---

## 2. Problem Statement

Modern DeFi attacks are no longer isolated or simple:

- MEV attacks rely on cross-chain liquidity fragmentation and mempool visibility.
- Oracle manipulation via flash loans remains a dominant exploit vector.
- AI agents are increasingly entrusted with capital, but execution correctness is unverifiable.
- Existing defenses are reactive, static, opaque, or centralized.

Sentinel addresses this gap by combining:
- cross-chain monitoring
- adaptive risk modeling
- autonomous agent execution
- verifiable compute guarantees
- protocol-native enforcement (Uniswap v4 hooks)

---

## 3. Targeted HackMoney Tracks

### 3.1 Uniswap Foundation — Agentic Finance + Privacy DeFi

How Sentinel aligns:
- Uses Uniswap v4 hooks as the *primary enforcement layer*.
- AI agents dynamically activate pool-level defenses.
- Hook logic is deterministic; intelligence lives off-chain.
- Demonstrates agent-controlled, protocol-native security.

Hooks supported:
- Anti-Sandwich Protection (dynamic fee escalation)
- Oracle Validation (swap rejection on price deviation)
- Circuit Breaker (temporary pool pause)

---

### 3.2 Yellow Network — State Channels / Session-Based Off-Chain Execution

How Sentinel aligns:
- Uses Yellow SDK (Nitrolite) to create **Sentinel Protection Sessions**.
- Funds are deposited once and reused for many instant off-chain actions.
- Enables sub-second agent decisions without mempool latency or gas.
- Final state and rewards are settled on-chain at session end.

Yellow is used for:
- off-chain agent consensus
- protection action authorization
- micro-fee accounting
- agent reward settlement

---

### 3.3 LI.FI — Best AI x LI.FI Smart App

How Sentinel aligns:
- Executor agents use LI.FI for cross-chain execution.
- Enables defensive actions on the chain where liquidity migrates.
- Demonstrates a full monitor → decide → act loop across chains.

---

## 4. System Architecture

### 4.1 Agent Roles (Strict Separation of Concerns)

#### Scout Agent (Signal Generator)
- Monitors mempools across multiple chains
- Detects:
  - flash loans
  - gas spikes
  - large swaps
  - abnormal price movements
  - suspicious transaction clustering
- Emits **weak, fast signals** (no decisions)

#### Validator Agent (Truth Verifier)
- Validates oracle prices against:
  - Chainlink / Pyth
  - DEX spot prices
  - TWAP
  - cross-chain consistency
- Emits **high-value threat alerts**
- Performs no execution

#### Risk Engine (Decision Brain)
- Correlates Scout + Validator signals
- Maintains adaptive thresholds using EMA per pool
- Computes composite risk scores over correlation windows
- Maintains a threat state machine:
  - WATCH → ELEVATED → CRITICAL (with hysteresis)
- Maps threats to exactly one defense action:
  - MEV_PROTECTION
  - ORACLE_VALIDATION
  - CIRCUIT_BREAKER
- Emits **time-bounded execution decisions**
- Enforces RPC budget constraints

> ⚠️ The Risk Engine is the *only* component allowed to decide actions.

#### Executor Agent (Deterministic Actor)
- Listens only to Risk Engine decisions
- Executes the instructed defense:
  - activates hook logic
  - respects TTL
- Uses LI.FI for cross-chain execution if needed
- Signs transactions inside TEE

---

### 4.2 Trusted Execution Environment (TEE)

Agents run inside TEEs (Phala / Oasis / EigenCompute).

Properties:
- Deterministic code hash
- Private keys sealed inside enclave
- Remote attestation proves execution integrity
- No external key exposure

TEE outputs:
- signed transactions
- execution logs
- attestation proofs

---

## 4.3 Risk Engine (Core Intelligence Layer)

The Risk Engine replaces static thresholds with adaptive, correlation-based decision-making.

Key properties:
- Adaptive thresholds using Exponential Moving Average (EMA)
- Sliding correlation windows (multi-signal fusion)
- Threat tiers with hysteresis (anti-flapping)
- Deterministic action mapping
- TTL-based decisions (automatic expiry)
- Token-bucket RPC budget enforcement

Risk Engine outputs:
- a single `RiskDecision` per pool when action is required
- no decisions when in WATCH state

The Executor must **never** implement risk logic directly.

---

## 4.4 Uniswap v4 Hook Architecture

Sentinel uses a **single composite hook contract per pool**.

The hook internally supports:
- Circuit Breaker (highest priority)
- Oracle Validation
- Anti-Sandwich Protection

Execution order in `beforeSwap`:
1. Circuit Breaker (may revert)
2. Oracle Validation (may revert)
3. Anti-Sandwich (fee adjustment)

Hooks are:
- attached at pool creation
- dormant by default
- configurable only by authorized Sentinel agents

---

## 4.5 Cross-Chain Coordination (Yellow)

- Agents communicate via Yellow state channels.
- Enables:
  - fast consensus
  - no mempool exposure
  - atomic off-chain coordination
- On-chain settlement exists for disputes or exits.

---

## 4.6 Sentinel Protection Session (Yellow-Powered)

### Session Lifecycle

1. Session Start (On-Chain)
- Protocol or LP opens a Protection Session.
- Funds (e.g. USDC) are deposited into Yellow contracts.
- Nitrolite session is established.

2. Off-Chain Protection Loop
- Scout emits signals.
- Validator verifies threats.
- Risk Engine decides actions.
- Decisions are recorded and authorized off-chain.
- Micro-fees accrue per protection action.

3. Session End (On-Chain Settlement)
- Final balances settled.
- Agent rewards distributed.
- Unused funds returned.
- Protection logs committed.

---

## 5. End-to-End Flow

1. Agents boot inside TEEs and generate attestations.
2. Agents register identities via AgentRegistry.
3. Scout emits raw signals.
4. Validator emits threat alerts.
5. Risk Engine correlates signals and computes threat tier.
6. If action required, Risk Engine emits `RiskDecision`.
7. Executor executes the instructed defense.
8. Hooks enforce protection at pool level.
9. Cross-chain execution occurs via LI.FI if required.
10. Yellow session settles on-chain.
11. UI displays attack → response → outcome.

---

## 6. Security & Verifiability

- All execution occurs inside TEEs.
- Remote attestation proves:
  - correct code
  - correct agent
- No private mempools required.
- Optional: on-chain commitment of decision hashes.

---

## 7. Demo Scope (Hackathon-Feasible)

### Required
- Scout Agent
- Risk Engine
- Executor Agent
- Yellow Protection Session
- One composite Uniswap v4 hook
- Two EVM chains
- Dashboard UI

### Optional / Stretch
- Validator Agent
- Oracle hook activation
- Insurance pool
- Agent reputation & slashing

---

## 8. Frontend (Demo UI)

Dashboard shows:
- live threat signals
- current threat tier per pool
- last RiskDecision
- hook activations
- estimated value saved

---

## 9. What This Project Is NOT

- Not a private mempool
- Not a centralized bot
- Not an oracle aggregator
- Not a trading strategy

Sentinel is **security infrastructure**, not a trading system.

---

## 10. One-Line Summary for IDE Agent

"Build a verifiable AI security system where Scout and Validator agents emit signals, a Risk Engine correlates them into deterministic defense decisions, and an Executor activates Uniswap v4 protection hooks, with off-chain coordination via Yellow and cross-chain execution via LI.FI."