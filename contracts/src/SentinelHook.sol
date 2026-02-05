// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "v4-core/src/types/BeforeSwapDelta.sol";
import {
    Ownable2Step
} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./Interfaces/AggregatorV3Interface.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

contract SentinelHook is IHooks, Ownable2Step {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct ProtectionConfig {
        bool circuitBreakerEnabled;
        bool oracleValidationEnabled;
        bool antiSandwichEnabled;
    }

    struct CircuitBreakerState {
        bool active;
        uint256 expiryBlock;
        address activatedBy;
        uint256 activatedAt;
        string reason;
    }

    struct ProtectionState {
        bool active;
        uint24 adjustedFee;
        uint256 expiryBlock;
        address activatedBy;
        uint256 activatedAt;
    }

    struct OracleConfig {
        address chainlinkFeed;
        address backupOracle;
        uint256 deviationThreshold; // in basis points
        uint32 twapWindow; // in seconds
        bool enabled;
    }

    struct PriceSnapshot {
        uint256 chainlinkPrice;
        uint256 twapPrice;
        uint256 deviation;
        uint256 timestamp;
    }

    struct PriceObservation {
        uint256 price; // price in 18 decimals
        uint256 timestamp;
    }

    IPoolManager public immutable poolManager;
    address public agentRegistry;
    uint24 public baseFee;
    bool public paused;

    // Per-pool configurations
    mapping(PoolId => ProtectionConfig) public configs;
    mapping(PoolId => CircuitBreakerState) public breakers;
    mapping(PoolId => ProtectionState) public protections;
    mapping(PoolId => OracleConfig) public oracleConfigs;
    mapping(PoolId => PriceSnapshot) public lastSnapshot;
    mapping(PoolId => PriceObservation[]) private priceObservations;
    uint24 public constant MAX_FEE = 50000; // 5%
    uint256 public constant PROTECTION_DURATION = 1; // blocks
    uint256 public constant CIRCUIT_BREAKER_DURATION_BLOCKS = 1;
    uint256 public constant MAX_REASON_LENGTH = 256;
    uint256 public constant DEFAULT_DEVIATION_THRESHOLD = 200; // 2%
    uint32 public constant DEFAULT_TWAP_WINDOW = 1800; // 30 minutes
    uint256 public constant MAX_OBSERVATIONS = 100;

    event CircuitBreakerActivated(
        PoolId indexed poolId,
        address indexed activatedBy,
        uint256 activatedAt,
        uint256 expiryBlock,
        string reason
    );
    event CircuitBreakerDeactivated(
        PoolId indexed poolId,
        address indexed deactivatedBy
    );
    event SwapBlockedByCircuitBreaker(
        PoolId indexed poolId,
        address indexed user,
        string reason
    );

    event OracleConfigured(
        PoolId indexed poolId,
        address chainlinkFeed,
        uint256 threshold
    );
    event OracleDeviationDetected(
        PoolId indexed poolId,
        uint256 deviation,
        uint256 threshold
    );
    event SwapBlockedByOracle(PoolId indexed poolId, uint256 deviation);

    event ProtectionActivated(
        PoolId indexed poolId,
        uint24 newFee,
        uint256 expiryBlock,
        address activatedBy
    );
    event SwapProtected(
        PoolId indexed poolId,
        address indexed user,
        uint24 appliedFee
    );
    event ThreatMitigated(PoolId indexed poolId, uint256 savedAmount);

    event ProtectionConfigUpdated(
        PoolId indexed poolId,
        bool circuitBreaker,
        bool oracle,
        bool antiSandwich
    );
    event AgentRegistryUpdated(address newRegistry);

    // LP Threat Broadcast Event (for ELEVATED tier threats)
    event ThreatBroadcast(
        PoolId indexed poolId,
        string tier, // "ELEVATED"
        string action, // "MEV_PROTECTION", "ORACLE_VALIDATION", etc.
        uint256 compositeScore, // 0-100
        uint256 timestamp,
        uint256 expiresAt,
        string rationale,
        string[] signalTypes
    );

    error Unauthorized();
    error InvalidFee();
    error ProtectionAlreadyActive();
    error Paused();
    error InvalidRegistry();
    error NotPoolManager();
    error PoolPaused();
    error OracleDeviation();
    error InvalidOracleConfig();
    error StalePrice();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager _poolManager,
        uint24 _baseFee
    ) {
        if (_baseFee > MAX_FEE) revert InvalidFee();

        poolManager = _poolManager;
        baseFee = _baseFee;
        _transferOwnership(msg.sender);
    }

    function getHookPermissions()
        public
        pure
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (paused) revert Paused();

        PoolId poolId = key.toId();
        ProtectionConfig memory config = configs[poolId];

        if (config.circuitBreakerEnabled) {
            _checkCircuitBreaker(poolId, sender);
        }
        if (config.oracleValidationEnabled) {
            _validateOracle(poolId, key);
        }

        uint24 fee = baseFee;
        if (config.antiSandwichEnabled) {
            fee = _applyAntiSandwich(poolId, sender);
        }

        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            fee
        );
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        if (paused) revert Paused();

        PoolId poolId = key.toId();
        ProtectionState storage protection = protections[poolId];

        if (protection.active) {
            // Dynamic fee has already been applied in beforeSwap
            // Uniswap v4 automatically distributes fees to LPs
            emit ThreatMitigated(poolId, 0);
        }

        return (IHooks.afterSwap.selector, 0);
    }

    // Stub implementations for unused hooks
    function beforeInitialize(
        address,
        PoolKey calldata,
        uint160
    ) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(
        address,
        PoolKey calldata,
        uint160,
        int24
    ) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.afterDonate.selector;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function _checkCircuitBreaker(PoolId poolId, address sender) internal {
        CircuitBreakerState storage breaker = breakers[poolId];

        if (breaker.active && block.number > breaker.expiryBlock) {
            breaker.active = false;
            return;
        }

        if (breaker.active) {
            emit SwapBlockedByCircuitBreaker(poolId, sender, breaker.reason);
            revert PoolPaused();
        }
    }

    function _validateOracle(PoolId poolId, PoolKey calldata key) internal {
        OracleConfig memory oracleConfig = oracleConfigs[poolId];

        if (!oracleConfig.enabled || oracleConfig.chainlinkFeed == address(0)) {
            return;
        }

        uint256 chainlinkPrice = _getChainlinkPrice(oracleConfig.chainlinkFeed);
        uint256 twapPrice = _getTwapPrice(poolId, key);

        uint256 deviation;
        if (chainlinkPrice > twapPrice) {
            deviation = ((chainlinkPrice - twapPrice) * 10000) / twapPrice;
        } else {
            deviation = ((twapPrice - chainlinkPrice) * 10000) / chainlinkPrice;
        }
        lastSnapshot[poolId] = PriceSnapshot({
            chainlinkPrice: chainlinkPrice,
            twapPrice: twapPrice,
            deviation: deviation,
            timestamp: block.timestamp
        });
        if (deviation > oracleConfig.deviationThreshold) {
            emit OracleDeviationDetected(
                poolId,
                deviation,
                oracleConfig.deviationThreshold
            );
            emit SwapBlockedByOracle(poolId, deviation);
            revert OracleDeviation();
        }

        _recordPriceObservation(poolId);
    }

    function _applyAntiSandwich(
        PoolId poolId,
        address sender
    ) internal returns (uint24 fee) {
        ProtectionState storage protection = protections[poolId];

        if (protection.active && block.number > protection.expiryBlock) {
            protection.active = false;
        }

        if (protection.active) {
            emit SwapProtected(poolId, sender, protection.adjustedFee);
            return protection.adjustedFee;
        }

        return baseFee;
    }

    function _getChainlinkPrice(address feed) internal view returns (uint256) {
        AggregatorV3Interface priceFeed = AggregatorV3Interface(feed);

        (, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();

        if (price <= 0) revert InvalidOracleConfig();
        if (block.timestamp - updatedAt > 3600) revert StalePrice(); // 1 hour staleness

        return uint256(price);
    }

    function _getTwapPrice(
        PoolId poolId,
        PoolKey calldata key
    ) internal view returns (uint256) {
        OracleConfig memory oracleConfig = oracleConfigs[poolId];
        uint32 twapWindow = oracleConfig.twapWindow > 0
            ? oracleConfig.twapWindow
            : DEFAULT_TWAP_WINDOW;

        return _calculateTwap(poolId, twapWindow);
    }

    function _calculateTwap(
        PoolId poolId,
        uint32 twapWindow
    ) internal view returns (uint256) {
        PriceObservation[] storage observations = priceObservations[poolId];

        if (observations.length == 0) {
            return 0;
        }

        uint256 currentTime = block.timestamp;
        uint256 cutoffTime = currentTime - twapWindow;

        uint256 weightedSum = 0;
        uint256 totalWeight = 0;

        for (uint256 i = 0; i < observations.length; i++) {
            if (observations[i].timestamp >= cutoffTime) {
                uint256 weight = currentTime - observations[i].timestamp;
                weightedSum += observations[i].price * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight == 0) {
            return observations[observations.length - 1].price;
        }

        return weightedSum / totalWeight;
    }

    function _getPoolSpotPrice(PoolId poolId) internal view returns (uint256) {
        (uint160 sqrtPriceX96, , , ) = poolManager.getSlot0(poolId);

        if (sqrtPriceX96 == 0) {
            return 0;
        }
        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);

        // Scale to 18 decimals: (priceX192 * 10^18) >> 192
        return (priceX192 * 1e18) >> 192;
    }

    function _recordPriceObservation(PoolId poolId) internal {
        uint256 currentPrice = _getPoolSpotPrice(poolId);

        if (currentPrice == 0) {
            return;
        }

        PriceObservation[] storage observations = priceObservations[poolId];
        observations.push(
            PriceObservation({price: currentPrice, timestamp: block.timestamp})
        );

        // Maintain rolling window of observations
        if (observations.length > MAX_OBSERVATIONS) {
            for (uint256 i = 0; i < observations.length - 1; i++) {
                observations[i] = observations[i + 1];
            }
            observations.pop();
        }
    }

    /*//////////////////////////////////////////////////////////////
                         AGENT-CALLABLE FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function activateCircuitBreaker(
        PoolId poolId,
        string calldata reason,
        bytes calldata proof
    ) external {
        if (paused) revert Paused();
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        if (
            bytes(reason).length == 0 ||
            bytes(reason).length > MAX_REASON_LENGTH
        ) revert InvalidOracleConfig();

        CircuitBreakerState storage breaker = breakers[poolId];

        if (breaker.active && block.number <= breaker.expiryBlock) {
            revert ProtectionAlreadyActive();
        }

        uint256 expiryBlock = block.number + CIRCUIT_BREAKER_DURATION_BLOCKS;

        breaker.active = true;
        breaker.expiryBlock = expiryBlock;
        breaker.activatedBy = msg.sender;
        breaker.activatedAt = block.timestamp;
        breaker.reason = reason;

        emit CircuitBreakerActivated(
            poolId,
            msg.sender,
            block.timestamp,
            expiryBlock,
            reason
        );
    }

    function deactivateCircuitBreaker(
        PoolId poolId,
        bytes calldata proof
    ) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();

        CircuitBreakerState storage breaker = breakers[poolId];
        if (breaker.active) {
            breaker.active = false;
            emit CircuitBreakerDeactivated(poolId, msg.sender);
        }
    }

    function activateProtection(
        PoolId poolId,
        uint24 newFee,
        bytes calldata proof
    ) external {
        if (paused) revert Paused();
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        if (newFee > MAX_FEE || newFee <= baseFee) revert InvalidFee();

        ProtectionState storage protection = protections[poolId];

        if (protection.active && block.number <= protection.expiryBlock) {
            revert ProtectionAlreadyActive();
        }

        uint256 expiryBlock = block.number + PROTECTION_DURATION;

        protection.active = true;
        protection.adjustedFee = newFee;
        protection.expiryBlock = expiryBlock;
        protection.activatedBy = msg.sender;
        protection.activatedAt = block.timestamp;

        emit ProtectionActivated(poolId, newFee, expiryBlock, msg.sender);
    }

    function deactivateProtection(
        PoolId poolId,
        bytes calldata proof
    ) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();

        ProtectionState storage protection = protections[poolId];
        if (protection.active) {
            protection.active = false;
        }
    }

    function configureOracle(
        PoolId poolId,
        address chainlinkFeed,
        uint256 deviationThreshold,
        bytes calldata proof
    ) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        if (chainlinkFeed == address(0)) revert InvalidOracleConfig();
        if (deviationThreshold == 0) revert InvalidOracleConfig();

        oracleConfigs[poolId] = OracleConfig({
            chainlinkFeed: chainlinkFeed,
            backupOracle: address(0),
            deviationThreshold: deviationThreshold,
            twapWindow: DEFAULT_TWAP_WINDOW,
            enabled: true
        });

        emit OracleConfigured(poolId, chainlinkFeed, deviationThreshold);
    }

    /**
     * @notice Broadcast ELEVATED tier threat to LP bots via on-chain event
     * @dev Only emits event, does not execute any protection
     * @param poolId The pool identifier
     * @param tier Must be "ELEVATED"
     * @param action The recommended defense action
     * @param compositeScore Risk score 0-100
     * @param expiresAt Timestamp when threat expires
     * @param rationale Human-readable explanation
     * @param signalTypes Array of contributing signal types
     * @param proof TEE attestation proof
     */
    function broadcastThreat(
        PoolId poolId,
        string calldata tier,
        string calldata action,
        uint256 compositeScore,
        uint256 expiresAt,
        string calldata rationale,
        string[] calldata signalTypes,
        bytes calldata proof
    ) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        require(
            keccak256(bytes(tier)) == keccak256("ELEVATED"),
            "Only ELEVATED tier"
        );
        require(compositeScore <= 100, "Invalid score");
        require(expiresAt > block.timestamp, "Invalid expiry");
        require(bytes(rationale).length > 0, "Empty rationale");

        emit ThreatBroadcast(
            poolId,
            tier,
            action,
            compositeScore,
            block.timestamp,
            expiresAt,
            rationale,
            signalTypes
        );
    }

    /*//////////////////////////////////////////////////////////////
                          ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function setProtectionConfig(
        PoolId poolId,
        bool circuitBreakerEnabled,
        bool oracleValidationEnabled,
        bool antiSandwichEnabled
    ) external onlyOwner {
        configs[poolId] = ProtectionConfig({
            circuitBreakerEnabled: circuitBreakerEnabled,
            oracleValidationEnabled: oracleValidationEnabled,
            antiSandwichEnabled: antiSandwichEnabled
        });

        emit ProtectionConfigUpdated(
            poolId,
            circuitBreakerEnabled,
            oracleValidationEnabled,
            antiSandwichEnabled
        );
    }

    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        agentRegistry = _agentRegistry;
        emit AgentRegistryUpdated(_agentRegistry);
    }

    function setBaseFee(uint24 _baseFee) external onlyOwner {
        if (_baseFee > MAX_FEE) revert InvalidFee();
        baseFee = _baseFee;
    }

    function emergencyPause(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /*//////////////////////////////////////////////////////////////
                           VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function isProtectionActive(PoolId poolId) external view returns (bool) {
        ProtectionState memory protection = protections[poolId];
        return protection.active && block.number <= protection.expiryBlock;
    }

    function isCircuitBreakerActive(
        PoolId poolId
    ) external view returns (bool) {
        CircuitBreakerState memory breaker = breakers[poolId];
        return breaker.active && block.number <= breaker.expiryBlock;
    }

    function getActiveFee(PoolId poolId) external view returns (uint24) {
        ProtectionState memory protection = protections[poolId];
        if (protection.active && block.number <= protection.expiryBlock) {
            return protection.adjustedFee;
        }
        return baseFee;
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    function _isAuthorizedAgent(
        address agent,
        bytes calldata proof
    ) internal view returns (bool) {
        (bool success, bytes memory result) = agentRegistry.staticcall(
            abi.encodeWithSignature("isAuthorized(address,bytes)", agent, proof)
        );

        if (!success || result.length == 0) {
            return false;
        }

        return abi.decode(result, (bool));
    }
}
