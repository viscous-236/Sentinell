# SentinelHook Deployment Guide

## Overview

This guide explains how to deploy the SentinelHook contract to Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia using CREATE2 for deterministic addresses.

## Prerequisites

1. **Foundry** installed (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
2. **Private Key** with testnet ETH on all three chains
3. **RPC URLs** for each testnet
4. **API Keys** for block explorers (optional, for verification)

## Quick Start

### 1. Setup Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your credentials
nano .env
```

### 2. Deploy to All Chains

```bash
# Make script executable
chmod +x deploy-multichain.sh

# Run deployment
./deploy-multichain.sh
```

### 3. Manual Deployment (Single Chain)

```bash
# Ethereum Sepolia
forge script Script/DeploySentinelHook.s.sol:DeploySentinelHook \
    --rpc-url $ETHEREUM_SEPOLIA_RPC \
    --broadcast \
    --verify

# Base Sepolia
forge script Script/DeploySentinelHook.s.sol:DeploySentinelHook \
    --rpc-url $BASE_SEPOLIA_RPC \
    --broadcast \
    --verify

# Arbitrum Sepolia
forge script Script/DeploySentinelHook.s.sol:DeploySentinelHook \
    --rpc-url $ARBITRUM_SEPOLIA_RPC \
    --broadcast \
    --verify
```

## CREATE2 Deployment

The deployment uses CREATE2 with a consistent salt (`SENTINEL_HOOK_V1`) to achieve deterministic addresses. However, **note that the addresses will differ across chains** because:

1. Different pool manager addresses per chain
2. Constructor arguments include chain-specific pool managers

### Achieving Identical Addresses

To deploy to the same address on all chains, you would need:

1. **Same pool manager address** on all chains, OR
2. **Factory pattern** with a factory deployed to the same address on all chains

The script includes a `DeploySentinelHookUniversal` contract template for achieving truly identical addresses using a factory.

## Post-Deployment Configuration

After deploying, you need to configure the hook:

### 1. Set Agent Registry

```solidity
hook.setAgentRegistry(agentRegistryAddress);
```

### 2. Configure Protection for Pools

```solidity
hook.setProtectionConfig(
    poolId,
    true,  // circuitBreakerEnabled
    true,  // oracleValidationEnabled
    true   // antiSandwichEnabled
);
```

### 3. Authorize Agents

In your agent registry contract:

```solidity
agentRegistry.authorize(agentAddress);
```

## Deployment Addresses

After deployment, record your addresses:

| Chain | Address | Explorer |
|-------|---------|----------|
| Ethereum Sepolia | `0x...` | [Etherscan](https://sepolia.etherscan.io) |
| Base Sepolia | `0x...` | [Basescan](https://base-sepolia.blockscout.com) |
| Arbitrum Sepolia | `0x...` | [Arbiscan](https://sepolia.arbiscan.io) |

## Verification

The deployment script automatically verifies contracts. If verification fails, manually verify:

```bash
forge verify-contract \
    --chain-id <CHAIN_ID> \
    --num-of-optimizations 200 \
    --watch \
    --constructor-args $(cast abi-encode "constructor(address,uint24)" <POOL_MANAGER> 3000) \
    --compiler-version v0.8.24 \
    <CONTRACT_ADDRESS> \
    src/SentinelHook.sol:SentinelHook \
    --etherscan-api-key <API_KEY>
```

## Testing

Run comprehensive tests:

```bash
# Run all tests
forge test -vv

# Run specific test file
forge test --match-path test/ComprehensiveHookTest.t.sol -vvv

# Run with coverage
forge coverage

# Generate coverage report
forge coverage --report lcov
```

### Test Coverage

The test suite includes:

- ✅ **Admin Functions**: `setBaseFee`, `emergencyPause`, `setAgentRegistry`, `setProtectionConfig`
- ✅ **Circuit Breaker**: Activation, deactivation, expiry, blocking swaps
- ✅ **Anti-Sandwich**: Protection activation, fee application, expiry
- ✅ **Oracle Validation**: Configuration, deviation detection, stale price handling
- ✅ **Threat Broadcasting**: Event emission, validation, authorization
- ✅ **Hook Permissions**: All hook functions return correct selectors
- ✅ **Edge Cases**: Paused state, access control, expiry handling

## Troubleshooting

### Deployment Fails

- **Insufficient gas**: Increase gas limit in foundry.toml
- **RPC errors**: Check RPC URL and API key
- **Nonce too low**: Wait for previous transaction to confirm

### Verification Fails

- **Constructor args mismatch**: Ensure pool manager address is correct
- **API rate limit**: Wait and retry
- **Wrong compiler version**: Use v0.8.24

### Tests Fail

- **Missing dependencies**: Run `forge install`
- **Compilation errors**: Run `forge build --force`
- **RPC errors**: Use `forge test --fork-url <RPC>` if needed

## Additional Resources

- [Foundry Book](https://book.getfoundry.sh/)
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/overview)
- [CREATE2 Deployments](https://eips.ethereum.org/EIPS/eip-1014)

## Support

For issues or questions:

1. Check existing tests for examples
2. Review SentinelHook.sol documentation
3. Open an issue on GitHub
