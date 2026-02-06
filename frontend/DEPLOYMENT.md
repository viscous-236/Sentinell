# Sentinel Frontend Dashboard

## Contract Addresses (Updated Feb 6, 2026)

### Ethereum Sepolia
- **SentinelHook**: `0xb0dD144187F0e03De762E05F7097E77A9aB9765b`
- **AgentRegistry**: `0x59e933aa18ACC69937e068873CF6EA62742D6a14`
- **PoolManager**: `0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A`

### Base Sepolia
- **SentinelHook**: `0x3cC61A0fC30b561881a39ece40E230DC02D4c99B`
- **AgentRegistry**: `0x4267E4cB6d6595474a79220f8d9D96108052AC9E`
- **PoolManager**: `0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829`

### Arbitrum Sepolia
- **SentinelHook**: `0xb0dD144187F0e03De762E05F7097E77A9aB9765b`
- **AgentRegistry**: `0x709C1e6fbA95A6C520E7AC1716d32Aef8b675a32`
- **PoolManager**: `0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A`

## Architecture

**Post-YellowOracle Removal:**
```
Scout → RiskEngine → Executor → Hook (direct)
           ↓
    Yellow MessageBus (coordination only)
```

The YellowOracle intermediate layer has been removed. The Executor now calls Hook methods directly:
- `activateProtection(poolId, fee, proof)`
- `activateCircuitBreaker(poolId, reason, proof)`
- `configureOracle(poolId, chainlinkFeed, threshold, proof)`

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Features

- Real-time agent activity monitoring
- Protection status across all chains
- Threat detection dashboard
- Pool protection management
- Agent coordination visualization

## API Integration

The dashboard connects to the Sentinel agent backend via:
- WebSocket for real-time updates
- REST API for historical data
- RPC calls for on-chain state

Configure backend URL in `.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3030
NEXT_PUBLIC_WS_URL=ws://localhost:3030
```
