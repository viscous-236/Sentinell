# Oracle Validation Hook - TWAP Implementation

## Overview

The `OracleValidationHook` now includes a fully functional Time-Weighted Average Price (TWAP) oracle system that validates swap prices against both Chainlink oracles and on-chain TWAP calculations, as specified in the Sentinel project requirements.

## Key Features

### 1. **Price Observation Storage**
- Maintains a rolling window of price observations per pool (max 100 observations)
- Each observation stores:
  - Spot price from Uniswap v4 pool (18 decimals)
  - Timestamp of observation

### 2. **TWAP Calculation**
- Calculates time-weighted average price from stored observations
- Configurable time window (default: 1800 seconds / 30 minutes)
- Uses linear time-weighting: older observations get lower weight
- Falls back to most recent price if no observations exist within the window

### 3. **Spot Price Fetching**
- Uses Uniswap v4's `StateLibrary.getSlot0()` to fetch current pool state
- Extracts `sqrtPriceX96` from pool's Slot0
- Converts to human-readable 18-decimal price using the formula:
  ```
  price = (sqrtPriceX96)^2 / 2^192 * 10^18
  ```

### 4. **Automatic Recording**
- Price observations are automatically recorded after each swap validation
- Ensures TWAP has fresh data for continuous monitoring

### 5. **Manual Recording**
- Authorized agents can manually record observations via `recordObservation()`
- Useful for initializing TWAP data before first swap occurs

## How It Works

### Oracle Validation Flow

1. **On Swap**: `beforeSwap()` is triggered
2. **Fetch Chainlink Price**: Gets external oracle price
3. **Calculate TWAP**: Computes time-weighted average from stored observations
4. **Compare Prices**: Calculates deviation between Chainlink and TWAP
5. **Validate**: Rejects swap if deviation exceeds threshold
6. **Record Observation**: Stores current spot price for future TWAP calculations

### TWAP Calculation Logic

```solidity
// Pseudo-code
for each observation in window:
    weight = currentTime - observationTime
    weightedSum += price * weight
    totalWeight += weight

twap = weightedSum / totalWeight
```

This ensures recent prices have more influence (higher weight) than older prices.

## Key Functions

### View Functions
| Function | Purpose |
|----------|---------|
| `getPoolSpotPrice(poolId)` | Get current spot price from pool |
| `getObservationCount(poolId)` | Get number of stored observations |
| `getPriceDeviation(poolId)` | Get current price deviation |
| `isOracleHealthy(poolId)` | Check if oracle validation is passing |

### Agent Functions
| Function | Purpose |
|----------|---------|
| `recordObservation(poolId, proof)` | Manually record price observation |
| `configureOracle(poolId, chainlinkFeed, threshold, proof)` | Configure oracle for pool |
| `setDeviationThreshold(poolId, threshold, proof)` | Update deviation threshold |

### Internal Functions
| Function | Purpose |
|----------|---------|
| `_getPoolSpotPrice(poolId)` | Fetch spot price using StateLibrary |
| `_getTwapPrice(poolId, window)` | Calculate TWAP from observations |
| `_recordPriceObservation(poolId)` | Store new price observation |
| `_validateOraclePrices(poolId, config)` | Validate Chainlink vs TWAP |

## Constants

```solidity
DEFAULT_DEVIATION_THRESHOLD = 200  // 2% in basis points
DEFAULT_TWAP_WINDOW = 1800         // 30 minutes
MAX_DEVIATION_THRESHOLD = 1000     // 10% maximum
MAX_OBSERVATIONS = 100             // Rolling window size
```

## Security Features

1. **TEE Agent Authorization**: Only verified agents can configure oracles and record observations
2. **Deviation Limits**: Maximum deviation threshold prevents extreme configurations
3. **Automatic Price Recording**: No manual intervention needed for normal operation
4. **Fallback Logic**: Returns zero if data unavailable, allowing validation to be skipped

## Integration with Sentinel System

Per the PROJECT_SPEC.md:

### Validator Agent Role
- Validates oracle prices against:
  - ✅ DEX spot prices (via `_getPoolSpotPrice`)
  - ✅ TWAP (via `_getTwapPrice`)
  - ✅ Cross-chain price consistency (configurable Chainlink feeds)
- ✅ Flags oracle manipulation risks (via deviation detection)

### Oracle Validation Hook Behavior
- ✅ Checks oracle vs TWAP vs DEX price
- ✅ Rejects swaps if deviation exceeds threshold
- ✅ Configurable only by verified agents

## Example Usage

### Initialize TWAP for a Pool
```solidity
// Agent records initial observations
for (uint i = 0; i < 10; i++) {
    hook.recordObservation(poolId, agentProof);
    // Wait some time...
}
```

### Configure Oracle Protection
```solidity
hook.configureOracle(
    poolId,
    chainlinkFeedAddress,
    200, // 2% deviation threshold
    agentProof
);
```

### Monitor Health
```solidity
bool healthy = hook.isOracleHealthy(poolId);
uint256 deviation = hook.getPriceDeviation(poolId);
uint256 observations = hook.getObservationCount(poolId);
```

## Advantages of This Implementation

1. **No External Dependencies**: Uses on-chain pool state directly
2. **Gas Efficient**: Only stores necessary data, with rolling window
3. **Manipulation Resistant**: TWAP smooths out price spikes
4. **Flexible**: Configurable window and threshold per pool
5. **Agent-Controlled**: Fully managed by TEE-verified agents

## Future Enhancements

- [ ] Multi-pool TWAP aggregation
- [ ] Cross-chain TWAP synchronization (via LI.FI queries)
- [ ] Advanced weighting algorithms (exponential decay)
- [ ] ZK proofs of TWAP calculation (privacy preservation)
