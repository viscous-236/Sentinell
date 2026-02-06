# RPC Configuration & Rate Limiting

## Multiple RPC  Providers

The agent automatically uses **Ankr RPC as fallback** when Alchemy hits rate limits (HTTP 429 errors).

Configure in `.env`:
```bash
# Primary: Alchemy RPC URLs
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Fallback: Ankr RPC URLs (automatically used on 429 errors)
ANKR_ETHEREUM_RPC=https://rpc.ankr.com/eth/YOUR_ANKR_KEY
ANKR_BASE_RPC=https://rpc.ankr.com/base/YOUR_ANKR_KEY
ANKR_ARBITRUM_RPC=https://rpc.ankr.com/arbitrum/YOUR_ANKR_KEY
```

## Rate Limit Mitigation

If you encounter rate limit errors:

### 1. Increase polling intervals (recommended)
```bash
SCOUT_DEX_INTERVAL=60000    # 60 seconds (default: 30s)
SCOUT_GAS_INTERVAL=20000    # 20 seconds (default: 15s)
```

### 2. Temporarily disable monitors
```bash
SCOUT_DEX=false             # Disable DEX price monitoring
SCOUT_GAS=false             # Disable gas tracking
SCOUT_MEMPOOL=false         # Disable mempool monitoring
```

### 3. Upgrade Alchemy plan
Upgrade to Growth or Enterprise tier for higher rate limits.

## Automatic Retry Logic

The agent automatically:
- Retries failed RPC calls up to **3 times** with exponential backoff (2s, 4s, 8s delays)
- Falls back to Ankr RPC when Alchemy returns 429 errors
- Logs rate limit warnings without crashing the agent
- Switches between providers transparently

## How It Works

```
RPC Call → Try Alchemy → 429 Error? → Retry with Ankr → Still failing? → Use public RPC
```

## Current Configuration

Your configured Ankr endpoints:
- Ethereum: `https://rpc.ankr.com/eth/35528...c93b`
- Base: `https://rpc.ankr.com/base/35528...c93b`
- Arbitrum: `https://rpc.ankr.com/arbitrum/35528...c93b`

Testnet endpoints also configured for Sepolia networks.
