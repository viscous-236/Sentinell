# YellowOracle Removal - Architecture Refactor

## Summary

Removed YellowOracle intermediate authorization layer. Executor now calls SentinelHook methods directly.

## Rationale

**User insight**: "Why are we using YellowOracle at all? If we've moved on-chain, let Executor directly call inbuilt activation functions in the hook after Yellow message bus coordination."

YellowOracle created unnecessary indirection:
- Hook already has activation functions: `activateProtection()`, `activateCircuitBreaker()`, `configureOracle()`
- Hook already maintains state: `protections[]`, `breakers[]`, `oracleConfigs[]`
- YellowOracle duplicated this state → synchronization complexity

## Architecture Changes

### Before (with YellowOracle)
```
Scout → RiskEngine → Executor → YellowOracle → Hook checks Oracle → Apply protection
                      ↓
                Yellow MessageBus (coordination)
```

### After (direct Hook calls)
```
Scout → RiskEngine → Executor → Hook directly → Apply protection
                      ↓
                Yellow MessageBus (coordination only)
```

## Code Changes

### Solidity (contracts/src/SentinelHook.sol)

**Removed**:
- `IYellowOracle` interface (~30 lines)
- `yellowOracle` state variable
- `YellowProtectionApplied` event
- `YellowOracleUpdated` event
- `beforeSwap()` YellowOracle check logic (~50 lines)

**Simplified**:
- `beforeSwap()` now only checks internal state
- `setYellowOracle()` deprecated (no-op for backward compatibility)

**Total removed**: ~80 lines

### TypeScript (agent/src/executor/src/Execution.ts)

**Removed**:
- `YELLOW_ORACLE_ABI` constant
- `yellowOracleContracts` Map
- `yellowOracleAddresses` from ExecutorConfig
- YellowOracle initialization in `initialize()`
- `signYellowProtectionAuthorization()` method (~90 lines)
- `yellowNonce` variable
- Settlement queue logic (~350 lines, removed in previous phase)

**Updated**:
```typescript
// OLD: Sign message, commit to YellowOracle, then Hook checks Oracle
await yellowOracleContract.commitProtection(poolId, signature, proof);

// NEW: Call Hook method directly
await hookContract.activateProtection(poolId, dynamicFee, proof);
```

**Total removed**: ~440 lines across all refactor phases

### Configuration (agent/src/index.ts)

**Removed**:
- `yellowOracleAddresses` from Executor config

**Updated**:
- Comments clarifying `sentinelAddress` now points to SentinelHook (not YellowOracle)

### Documentation Updates

- Updated all comment references from "YellowOracle" to "Hook"
- Clarified Yellow MessageBus is for agent coordination only
- Updated flow diagrams showing direct Hook calls

## What Remains

### Yellow MessageBus
**Still used** for off-chain agent-to-agent coordination:
- Scout → RiskEngine → Executor communication
- <50ms latency for time-sensitive detection
- State channel management for agent coordination

### YellowOracle Contract
**Deprecated but not deleted**:
- `contracts/src/YellowOracle.sol` still exists
- Deployed contracts still on-chain (but not called)
- Can be removed in future cleanup

### Environment Variables
**Backward compatibility**:
- `YELLOW_ORACLE_*` env vars still work (but now point to Hook addresses)
- No breaking changes to deployment scripts

## Benefits

1. **Simpler architecture**: One less contract to maintain
2. **Single source of truth**: Hook state is authoritative
3. **Reduced gas costs**: One less contract call per protection activation
4. **Clearer separation**: Yellow MessageBus for coordination, Hook for state
5. **Easier reasoning**: No synchronization between YellowOracle and Hook states

## Testing Status

✅ Solidity compilation: Successful (only linting warnings)
✅ TypeScript compilation: No errors
⚠️ End-to-end tests: Need updates (still reference YellowOracle)
⚠️ Contract deployment: Old deployments reference YellowOracle

## Next Steps

1. Update test files to remove YellowOracle references
2. Redeploy contracts to testnets
3. Test full protection activation flow end-to-end
4. Update deployment documentation
5. (Optional) Delete YellowOracle.sol in future version

## Migration Notes

**No breaking changes** for users:
- Swaps still work on vanilla Uniswap v4 interface
- Protections still activate automatically in `beforeSwap()`
- No hookData required
- No custom frontend needed

**Breaking changes** for operators:
- Executor config: Remove `yellowOracleAddresses`
- Deployment: Use `SENTINEL_HOOK_*` addresses (not `YELLOW_ORACLE_*`)
- Tests: Update to call Hook methods directly

## References

- PROJECT_SPEC.md Section 4.5: Yellow MessageBus coordination
- PROTECTION_IMPLEMENTATION.md: Hook protection mechanisms
- Session conversation: User's breakthrough insight on architecture simplification
