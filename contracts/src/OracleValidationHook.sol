// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "./Interfaces/AggregatorV3Interface.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

abstract contract OracleValidationHook is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

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

    mapping(PoolId => OracleConfig) public oracleConfigs;
    mapping(PoolId => PriceSnapshot) public lastSnapshot;

    mapping(PoolId => PriceObservation[]) private priceObservations;
    uint256 public constant MAX_OBSERVATIONS = 100;

    uint256 public constant DEFAULT_DEVIATION_THRESHOLD = 200;
    uint32 public constant DEFAULT_TWAP_WINDOW = 1800;
    uint256 public constant MAX_DEVIATION_THRESHOLD = 1000;

    bool public paused;

    event OracleConfigured(
        PoolId indexed poolId, address chainlinkFeed, uint256 deviationThreshold, address indexed configuredBy
    );
    event PriceDeviationDetected(PoolId indexed poolId, uint256 chainlinkPrice, uint256 twapPrice, uint256 deviation);
    event SwapRejectedOracleManipulation(
        PoolId indexed poolId,
        address indexed user,
        uint256 chainlinkPrice,
        uint256 twapPrice,
        uint256 deviation,
        uint256 threshold
    );
    event OracleUnhealthy(PoolId indexed poolId, string reason);

    error Unauthorized();
    error InvalidThreshold();
    error InvalidOracle();
    error OracleManipulationDetected();
    error OracleNotConfigured();
    error Paused();
    error InvalidRegistry();
    error OnlyPoolManager();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _agentRegistry) Ownable(msg.sender) {
        if (address(_poolManager) == address(0)) revert InvalidOracle();
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        poolManager = _poolManager;
        agentRegistry = _agentRegistry;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (paused) revert Paused();

        PoolId poolId = key.toId();
        OracleConfig memory config = oracleConfigs[poolId];

        if (!config.enabled) {
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        (bool isValid, PriceSnapshot memory snapshot) = _validateOraclePrices(poolId, config);

        lastSnapshot[poolId] = snapshot;

        if (snapshot.deviation > 0 && snapshot.deviation < config.deviationThreshold) {
            emit PriceDeviationDetected(poolId, snapshot.chainlinkPrice, snapshot.twapPrice, snapshot.deviation);
        }

        if (!isValid) {
            emit SwapRejectedOracleManipulation(
                poolId,
                sender,
                snapshot.chainlinkPrice,
                snapshot.twapPrice,
                snapshot.deviation,
                config.deviationThreshold
            );
            revert OracleManipulationDetected();
        }

        _recordPriceObservation(poolId);

        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function configureOracle(PoolId poolId, address chainlinkFeed, uint256 deviationThreshold, bytes calldata proof)
        external
    {
        if (paused) revert Paused();
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        if (chainlinkFeed == address(0)) revert InvalidOracle();
        if (deviationThreshold > MAX_DEVIATION_THRESHOLD) {
            revert InvalidThreshold();
        }

        oracleConfigs[poolId] = OracleConfig({
            chainlinkFeed: chainlinkFeed,
            backupOracle: address(0),
            deviationThreshold: deviationThreshold == 0 ? DEFAULT_DEVIATION_THRESHOLD : deviationThreshold,
            twapWindow: DEFAULT_TWAP_WINDOW,
            enabled: true
        });

        emit OracleConfigured(poolId, chainlinkFeed, deviationThreshold, msg.sender);
    }

    function setDeviationThreshold(PoolId poolId, uint256 newThreshold, bytes calldata proof) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        if (newThreshold > MAX_DEVIATION_THRESHOLD) revert InvalidThreshold();

        OracleConfig storage config = oracleConfigs[poolId];
        if (!config.enabled) revert OracleNotConfigured();

        config.deviationThreshold = newThreshold;
        emit OracleConfigured(poolId, config.chainlinkFeed, newThreshold, msg.sender);
    }

    function disableOracle(PoolId poolId, bytes calldata proof) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();

        oracleConfigs[poolId].enabled = false;
    }

    function getPriceDeviation(PoolId poolId) external view returns (uint256 deviation) {
        OracleConfig memory config = oracleConfigs[poolId];
        if (!config.enabled) return 0;

        (, PriceSnapshot memory snapshot) = _validateOraclePrices(poolId, config);
        return snapshot.deviation;
    }

    function isOracleHealthy(PoolId poolId) external view returns (bool healthy) {
        OracleConfig memory config = oracleConfigs[poolId];
        if (!config.enabled) return true;

        (bool isValid,) = _validateOraclePrices(poolId, config);
        return isValid;
    }

    function getOracleConfig(PoolId poolId) external view returns (OracleConfig memory config) {
        return oracleConfigs[poolId];
    }

    function getLastSnapshot(PoolId poolId) external view returns (PriceSnapshot memory snapshot) {
        return lastSnapshot[poolId];
    }

    /**
     * @notice Get the number of price observations stored for a pool
     */
    function getObservationCount(PoolId poolId) external view returns (uint256 count) {
        return priceObservations[poolId].length;
    }

    /**
     * @notice Get the current spot price from the pool
     */
    function getPoolSpotPrice(PoolId poolId) external view returns (uint256 price) {
        return _getPoolSpotPrice(poolId);
    }

    /**
     * @notice Manually record a price observation (callable by authorized agents)
     */
    function recordObservation(PoolId poolId, bytes calldata proof) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();
        _recordPriceObservation(poolId);
    }

    /**
     * @notice Update agent registry address
     */
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        agentRegistry = _agentRegistry;
    }

    /**
     * @notice Emergency pause all oracle validation
     */
    function emergencyPause(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /**
     * @notice  Validate oracle prices for a pool by fetching Chainlink and TWAP prices and comparing deviation
     * @dev  If Chainlink or TWAP price is unavailable, validation is skipped (returns valid) same for TWAP price
     */
    function _validateOraclePrices(PoolId poolId, OracleConfig memory config)
        internal
        view
        returns (bool isValid, PriceSnapshot memory snapshot)
    {
        uint256 chainlinkPrice = _getChainlinkPrice(config.chainlinkFeed);

        if (chainlinkPrice == 0) {
            return (true, PriceSnapshot(0, 0, 0, block.timestamp)); // If Chainlink price is unavailable, skip validation
        }

        uint256 twapPrice = _getTwapPrice(poolId, config.twapWindow);

        if (twapPrice == 0) {
            return (true, PriceSnapshot(0, 0, 0, block.timestamp)); // If TWAP price is unavailable, skip validation
        }

        uint256 deviation = _calculateDeviation(chainlinkPrice, twapPrice);

        isValid = deviation <= config.deviationThreshold;

        snapshot = PriceSnapshot({
            chainlinkPrice: chainlinkPrice, twapPrice: twapPrice, deviation: deviation, timestamp: block.timestamp
        });

        return (isValid, snapshot);
    }

    /**
     * @notice  Fetch latest price from Chainlink oracle
     * @dev     If the oracle call fails or returns invalid data, returns 0
     */
    function _getChainlinkPrice(address feed) internal view returns (uint256 price) {
        if (feed == address(0)) return 0;

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (block.timestamp - updatedAt > 1 hours) {
                return 0;
            }

            if (answer <= 0) {
                return 0;
            }

            uint8 decimals = AggregatorV3Interface(feed).decimals();
            return uint256(answer) * 10 ** (18 - decimals);
        } catch {
            return 0;
        }
    }

    /**
     * @notice  Fetch TWAP price for a pool over a specified window
     * @dev     Calculates time-weighted average price from stored observations
     *          Returns 0 if insufficient observations exist
     */
    function _getTwapPrice(PoolId poolId, uint32 twapWindow) internal view returns (uint256 twapPrice) {
        PriceObservation[] storage observations = priceObservations[poolId];

        if (observations.length == 0) {
            return 0;
        }

        uint256 currentTime = block.timestamp;
        uint256 cutoffTime = currentTime - twapWindow;

        uint256 weightedSum = 0;
        uint256 totalWeight = 0;

        // Calculate time-weighted average from observations within the window
        for (uint256 i = 0; i < observations.length; i++) {
            if (observations[i].timestamp >= cutoffTime) {
                uint256 weight = currentTime - observations[i].timestamp;
                weightedSum += observations[i].price * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight == 0) {
            // If no observations in window, return the most recent price
            return observations[observations.length - 1].price;
        }

        return weightedSum / totalWeight;
    }

    /**
     * @notice  Get current spot price from the pool using Uniswap v4 StateLibrary
     * @dev     Fetches sqrtPriceX96 from pool's Slot0 and converts to 18 decimal price
     */
    function _getPoolSpotPrice(PoolId poolId) internal view returns (uint256 price) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);

        if (sqrtPriceX96 == 0) {
            return 0;
        }

        // Convert sqrtPriceX96 to price in 18 decimals
        // price = (sqrtPriceX96 / 2^96)^2
        // = (sqrtPriceX96)^2 / 2^192
        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);

        // Scale to 18 decimals: (priceX192 * 10^18) / 2^192
        return (priceX192 * 1e18) >> 192;
    }

    /**
     * @notice  Record a price observation for TWAP calculation
     * @dev     Stores current pool price and maintains a rolling window of observations
     */
    function _recordPriceObservation(PoolId poolId) internal {
        uint256 currentPrice = _getPoolSpotPrice(poolId);

        if (currentPrice == 0) {
            return;
        }

        PriceObservation[] storage observations = priceObservations[poolId];
        observations.push(PriceObservation({price: currentPrice, timestamp: block.timestamp}));

        if (observations.length > MAX_OBSERVATIONS) {
            for (uint256 i = 0; i < observations.length - 1; i++) {
                observations[i] = observations[i + 1];
            }
            observations.pop();
        }
    }

    /**
     * @notice  Calculate deviation between two prices in basis points
     * @dev     If either price is zero, returns zero deviation
     */
    function _calculateDeviation(uint256 price1, uint256 price2) internal pure returns (uint256 deviation) {
        if (price1 == 0 || price2 == 0) return 0;

        uint256 diff = price1 > price2 ? price1 - price2 : price2 - price1;
        uint256 avg = (price1 + price2) / 2;

        deviation = (diff * 10000) / avg; // deviation in basis points

        return deviation;
    }

    /**
     * @notice  Check if an agent is authorized using a proof
     * @dev     Performs a static call to the agent registry to verify authorization
     */
    function _isAuthorizedAgent(address agent, bytes calldata proof) internal view returns (bool authorized) {
        (bool success, bytes memory result) =
            agentRegistry.staticcall(abi.encodeWithSignature("isAuthorized(address,bytes)", agent, proof));

        if (!success || result.length == 0) {
            return false;
        }

        return abi.decode(result, (bool));
    }
}
