# Scout Agent - RPC Connection Guide

## Quick Start

### 1. Test Your Connection
```bash
cd agent/src/scout
ts-node test-connection.ts
```

This will verify both HTTP and WebSocket connectivity.

### 2. Run the Scout Agent
```bash
ts-node example.ts
```

## Understanding Your API Key

Your current Alchemy API key works with **HTTP but NOT WebSocket**.

### What Works (Free Tier)
- ✅ Flash loan detection
- ✅  Gas price tracking
- ✅ DEX price monitoring
- ✅ On-chain data queries

### What Needs Upgrade (WebSocket Required)
- ❌ Real-time mempool monitoring
- ❌ Pending transaction streams

## Configuration Options

### Option 1: HTTP Only (Current - Free Tier) ✅

```env
# .env
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

```typescript
// scout.config.ts
mempool: {
  enabled: false,  // Disabled for HTTP
}
```

### Option 2: WebSocket (Requires Paid Plan)

1. Upgrade to Alchemy Growth plan
2. Update `.env`:
```env
ETHEREUM_RPC_URL=wss://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
BASE_RPC_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

3. Enable mempool in config:
```typescript
mempool: {
  enabled: true,
}
```

## Troubleshooting

### 401 Unauthorized Error
**Cause:** Trying to use WebSocket on free tier  
**Solution:** Use HTTPS URLs (already configured)

### Connection Timeout
**Cause:** Invalid API key or network issue  
**Solution:** Verify API key from Alchemy dashboard

### DEX "Pair address not implemented"
**Normal:** DEX aggregator needs pair addresses configured  
**Not an error** - flash loans and gas tracking still work

## Testing Different Providers

The code automatically detects protocols:
- `https://` → Uses `JsonRpcProvider`
- `wss://` → Uses `WebSocketProvider`

You can mix and match:
```env
ETHEREUM_RPC_URL=https://eth.llamarpc.com
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
```

## Support

- [x] Verified working with HTTP endpoints  
- [x] Error handling prevents crashes
- [x] Clear messages for configuration issues
