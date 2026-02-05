// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

/**
 * @title MockPoolManager
 * @notice Mock implementation of IPoolManager for testing
 */
contract MockPoolManager {
    mapping(PoolId => Slot0) private slots;

    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
    }

    function getSlot0(
        PoolId poolId
    ) external view returns (uint160, int24, uint24, uint24) {
        Slot0 memory slot = slots[poolId];
        return (slot.sqrtPriceX96, slot.tick, slot.protocolFee, slot.lpFee);
    }

    function setSlot0(PoolId poolId, uint160 sqrtPriceX96) external {
        slots[poolId] = Slot0({
            sqrtPriceX96: sqrtPriceX96,
            tick: 0,
            protocolFee: 0,
            lpFee: 0
        });
    }
}

/**
 * @title MockAgentRegistry
 * @notice Mock implementation of agent registry for testing
 */
contract MockAgentRegistry {
    mapping(address => bool) public authorizedAgents;

    function authorize(address agent) external {
        authorizedAgents[agent] = true;
    }

    function deauthorize(address agent) external {
        authorizedAgents[agent] = false;
    }

    function isAuthorized(
        address agent,
        bytes calldata
    ) external view returns (bool) {
        return authorizedAgents[agent];
    }
}

/**
 * @title MockChainlinkFeed
 * @notice Mock Chainlink price feed for testing oracle validation
 */
contract MockChainlinkFeed {
    int256 public price;
    uint256 public updatedAt;
    uint8 public decimals = 8;

    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAtRet,
            uint80 answeredInRound
        )
    {
        return (1, price, block.timestamp, updatedAt, 1);
    }
}

/**
 * @title SentinelHookTest
 * @notice Comprehensive test suite for SentinelHook
 */
contract SentinelHookTest is Test {
    using PoolIdLibrary for PoolKey;

    SentinelHook hook;
    MockPoolManager poolManager;
    MockAgentRegistry agentRegistry;
    MockChainlinkFeed chainlinkFeed;

    address owner = address(0x1);
    address agent = address(0x2);
    address user = address(0x3);
    address attacker = address(0x4);

    PoolKey testKey;
    PoolId testPoolId;

    uint24 constant BASE_FEE = 3000; // 0.3%

    // Events to test
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
    event ThreatBroadcast(
        PoolId indexed poolId,
        string tier,
        string action,
        uint256 compositeScore,
        uint256 timestamp,
        uint256 expiresAt,
        string rationale,
        string[] signalTypes
    );

    function setUp() public {
        vm.startPrank(owner);

        // Deploy mocks
        poolManager = new MockPoolManager();
        agentRegistry = new MockAgentRegistry();
        chainlinkFeed = new MockChainlinkFeed();

        // Deploy hook
        hook = new SentinelHook(
            IPoolManager(address(poolManager)),
            BASE_FEE,
            address(this)
        );

        // Setup
        hook.setAgentRegistry(address(agentRegistry));
        agentRegistry.authorize(agent);

        // Set mock oracle price
        chainlinkFeed.setPrice(2000 * 1e8); // $2000

        // Create test pool
        testKey = PoolKey({
            currency0: Currency.wrap(address(0x1000)),
            currency1: Currency.wrap(address(0x2000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        testPoolId = testKey.toId();

        // Set pool price (sqrtPriceX96 for 1:1 ratio approximately)
        poolManager.setSlot0(testPoolId, 79228162514264337593543950336);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR AND INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function testConstructorSetsCorrectValues() public {
        assertEq(address(hook.poolManager()), address(poolManager));
        assertEq(hook.baseFee(), BASE_FEE);
        assertEq(hook.owner(), owner);
        assertFalse(hook.paused());
    }

    function testConstructorRevertsOnInvalidFee() public {
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        new SentinelHook(
            IPoolManager(address(poolManager)),
            60000,
            address(this)
        ); // > MAX_FEE
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function testSetAgentRegistry() public {
        address newRegistry = address(0x999);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit AgentRegistryUpdated(newRegistry);
        hook.setAgentRegistry(newRegistry);

        assertEq(hook.agentRegistry(), newRegistry);
    }

    function testSetAgentRegistryRevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(SentinelHook.InvalidRegistry.selector);
        hook.setAgentRegistry(address(0));
    }

    function testSetAgentRegistryRevertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        hook.setAgentRegistry(address(0x999));
    }

    function testSetBaseFee() public {
        uint24 newFee = 5000;

        vm.prank(owner);
        hook.setBaseFee(newFee);

        assertEq(hook.baseFee(), newFee);
    }

    function testSetBaseFeeRevertsOnInvalidFee() public {
        vm.prank(owner);
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.setBaseFee(60000);
    }

    function testSetBaseFeeRevertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        hook.setBaseFee(5000);
    }

    function testEmergencyPause() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        assertTrue(hook.paused());
    }

    function testEmergencyUnpause() public {
        vm.startPrank(owner);
        hook.emergencyPause(true);
        hook.emergencyPause(false);
        vm.stopPrank();

        assertFalse(hook.paused());
    }

    function testEmergencyPauseRevertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        hook.emergencyPause(true);
    }

    function testSetProtectionConfig() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ProtectionConfigUpdated(testPoolId, true, true, true);
        hook.setProtectionConfig(testPoolId, true, true, true);

        (bool cb, bool oracle, bool anti) = hook.configs(testPoolId);
        assertTrue(cb);
        assertTrue(oracle);
        assertTrue(anti);
    }

    function testSetProtectionConfigRevertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        hook.setProtectionConfig(testPoolId, true, true, true);
    }

    /*//////////////////////////////////////////////////////////////
                    CIRCUIT BREAKER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function testActivateCircuitBreaker() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, true, false, false);

        vm.prank(agent);
        vm.expectEmit(true, true, false, false);
        emit CircuitBreakerActivated(
            testPoolId,
            agent,
            block.timestamp,
            block.number + 1,
            "MEV attack detected"
        );
        hook.activateCircuitBreaker(testPoolId, "MEV attack detected", "");

        assertTrue(hook.isCircuitBreakerActive(testPoolId));
    }

    function testActivateCircuitBreakerRevertsIfUnauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.activateCircuitBreaker(testPoolId, "Test", "");
    }

    function testActivateCircuitBreakerRevertsIfPaused() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(agent);
        vm.expectRevert(SentinelHook.Paused.selector);
        hook.activateCircuitBreaker(testPoolId, "Test", "");
    }

    function testActivateCircuitBreakerRevertsIfEmptyReason() public {
        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.activateCircuitBreaker(testPoolId, "", "");
    }

    function testActivateCircuitBreakerRevertsIfReasonTooLong() public {
        string memory longReason = new string(300);

        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.activateCircuitBreaker(testPoolId, longReason, "");
    }

    function testActivateCircuitBreakerRevertsIfAlreadyActive() public {
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        vm.prank(agent);
        vm.expectRevert(SentinelHook.ProtectionAlreadyActive.selector);
        hook.activateCircuitBreaker(testPoolId, "Test", "");
    }

    function testDeactivateCircuitBreaker() public {
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        vm.prank(agent);
        vm.expectEmit(true, true, false, false);
        emit CircuitBreakerDeactivated(testPoolId, agent);
        hook.deactivateCircuitBreaker(testPoolId, "");

        assertFalse(hook.isCircuitBreakerActive(testPoolId));
    }

    function testDeactivateCircuitBreakerRevertsIfUnauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.deactivateCircuitBreaker(testPoolId, "");
    }

    function testCircuitBreakerAutoExpires() public {
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        assertTrue(hook.isCircuitBreakerActive(testPoolId));

        // Move past expiry
        vm.roll(block.number + 2);

        assertFalse(hook.isCircuitBreakerActive(testPoolId));
    }

    function testCircuitBreakerBlocksSwap() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, true, false, false);

        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.PoolPaused.selector);
        hook.beforeSwap(user, testKey, params, "");
    }

    /*//////////////////////////////////////////////////////////////
                    ANTI-SANDWICH PROTECTION
    //////////////////////////////////////////////////////////////*/

    function testActivateProtection() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        uint24 newFee = 10000;
        vm.prank(agent);
        vm.expectEmit(true, false, false, false);
        emit ProtectionActivated(testPoolId, newFee, block.number + 1, agent);
        hook.activateProtection(testPoolId, newFee, "");

        assertTrue(hook.isProtectionActive(testPoolId));
    }

    function testActivateProtectionRevertsIfUnauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.activateProtection(testPoolId, 10000, "");
    }

    function testActivateProtectionRevertsIfPaused() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(agent);
        vm.expectRevert(SentinelHook.Paused.selector);
        hook.activateProtection(testPoolId, 10000, "");
    }

    function testActivateProtectionRevertsIfFeeTooHigh() public {
        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.activateProtection(testPoolId, 60000, "");
    }

    function testActivateProtectionRevertsIfFeeTooLow() public {
        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.activateProtection(testPoolId, 2000, ""); // <= baseFee
    }

    function testActivateProtectionRevertsIfAlreadyActive() public {
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        vm.prank(agent);
        vm.expectRevert(SentinelHook.ProtectionAlreadyActive.selector);
        hook.activateProtection(testPoolId, 10000, "");
    }

    function testDeactivateProtection() public {
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        vm.prank(agent);
        hook.deactivateProtection(testPoolId, "");

        assertFalse(hook.isProtectionActive(testPoolId));
    }

    function testDeactivateProtectionRevertsIfUnauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.deactivateProtection(testPoolId, "");
    }

    function testProtectionAutoExpires() public {
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        assertTrue(hook.isProtectionActive(testPoolId));

        // Move past expiry
        vm.roll(block.number + 2);

        assertFalse(hook.isProtectionActive(testPoolId));
    }

    function testAntiSandwichAppliesHigherFee() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (, , uint24 fee) = hook.beforeSwap(user, testKey, params, "");

        assertEq(fee, 10000);
    }

    /*//////////////////////////////////////////////////////////////
                    ORACLE VALIDATION
    //////////////////////////////////////////////////////////////*/

    function testConfigureOracle() public {
        uint256 threshold = 500; // 5%

        vm.prank(agent);
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(testPoolId, address(chainlinkFeed), threshold);
        hook.configureOracle(testPoolId, address(chainlinkFeed), threshold, "");

        (address feed, , uint256 dev, , bool enabled) = hook.oracleConfigs(
            testPoolId
        );

        assertEq(feed, address(chainlinkFeed));
        assertEq(dev, threshold);
        assertTrue(enabled);
    }

    function testConfigureOracleRevertsIfUnauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 500, "");
    }

    function testConfigureOracleRevertsOnZeroAddress() public {
        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.configureOracle(testPoolId, address(0), 500, "");
    }

    function testConfigureOracleRevertsOnZeroThreshold() public {
        vm.prank(agent);
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 0, "");
    }

    /*//////////////////////////////////////////////////////////////
                    THREAT BROADCAST
    //////////////////////////////////////////////////////////////*/

    function testBroadcastThreat() public {
        string[] memory signalTypes = new string[](2);
        signalTypes[0] = "LARGE_SWAP";
        signalTypes[1] = "GAS_SPIKE";

        vm.prank(agent);
        vm.expectEmit(true, false, false, false);
        emit ThreatBroadcast(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp,
            block.timestamp + 300,
            "MEV detected",
            signalTypes
        );

        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "MEV detected",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfUnauthorized() public {
        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfNotElevated() public {
        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.prank(agent);
        vm.expectRevert("Only ELEVATED tier");
        hook.broadcastThreat(
            testPoolId,
            "CRITICAL",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfInvalidScore() public {
        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.prank(agent);
        vm.expectRevert("Invalid score");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            101,
            block.timestamp + 300,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfPastExpiry() public {
        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.prank(agent);
        vm.expectRevert("Invalid expiry");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp - 1,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfEmptyRationale() public {
        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.prank(agent);
        vm.expectRevert("Empty rationale");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "",
            signalTypes,
            ""
        );
    }

    /*//////////////////////////////////////////////////////////////
                    HOOK FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function testGetHookPermissions() public {
        Hooks.Permissions memory permissions = hook.getHookPermissions();

        assertFalse(permissions.beforeInitialize);
        assertFalse(permissions.afterInitialize);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.afterAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
        assertFalse(permissions.afterRemoveLiquidity);
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.afterSwap);
        assertFalse(permissions.beforeDonate);
        assertFalse(permissions.afterDonate);
    }

    function testBeforeSwapReturnsCorrectSelector() public {
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (bytes4 selector, , ) = hook.beforeSwap(user, testKey, params, "");

        assertEq(selector, IHooks.beforeSwap.selector);
    }

    function testBeforeSwapRevertsIfNotPoolManager() public {
        vm.prank(attacker);
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.NotPoolManager.selector);
        hook.beforeSwap(user, testKey, params, "");
    }

    function testBeforeSwapRevertsIfPaused() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.Paused.selector);
        hook.beforeSwap(user, testKey, params, "");
    }

    function testAfterSwapReturnsCorrectSelector() public {
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (bytes4 selector, ) = hook.afterSwap(
            user,
            testKey,
            params,
            BalanceDelta.wrap(0),
            ""
        );

        assertEq(selector, IHooks.afterSwap.selector);
    }

    function testAfterSwapRevertsIfNotPoolManager() public {
        vm.prank(attacker);
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.NotPoolManager.selector);
        hook.afterSwap(user, testKey, params, BalanceDelta.wrap(0), "");
    }

    function testAfterSwapRevertsIfPaused() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.Paused.selector);
        hook.afterSwap(user, testKey, params, BalanceDelta.wrap(0), "");
    }

    function testAfterSwapEmitsThreatMitigatedWhenProtectionActive() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        vm.startPrank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        hook.beforeSwap(user, testKey, params, "");

        vm.expectEmit(true, false, false, false);
        emit ThreatMitigated(testPoolId, 0);

        hook.afterSwap(user, testKey, params, BalanceDelta.wrap(0), "");
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function testIsProtectionActive() public {
        assertFalse(hook.isProtectionActive(testPoolId));

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        assertTrue(hook.isProtectionActive(testPoolId));
    }

    function testIsCircuitBreakerActive() public {
        assertFalse(hook.isCircuitBreakerActive(testPoolId));

        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        assertTrue(hook.isCircuitBreakerActive(testPoolId));
    }

    function testGetActiveFee() public {
        assertEq(hook.getActiveFee(testPoolId), BASE_FEE);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        assertEq(hook.getActiveFee(testPoolId), 10000);
    }

    function testGetActiveFeeReturnsBaseFeeAfterExpiry() public {
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        vm.roll(block.number + 2);

        assertEq(hook.getActiveFee(testPoolId), BASE_FEE);
    }

    /*//////////////////////////////////////////////////////////////
                    INTEGRATION TESTS
    //////////////////////////////////////////////////////////////*/

    function testFullProtectionFlow() public {
        // Setup protection config
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        // Agent detects threat and activates protection
        vm.prank(agent);
        hook.activateProtection(testPoolId, 15000, "");

        // User tries to swap
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        // BeforeSwap applies higher fee
        (, , uint24 fee) = hook.beforeSwap(user, testKey, params, "");
        assertEq(fee, 15000);

        // AfterSwap emits mitigation event
        vm.expectEmit(true, false, false, false);
        emit ThreatMitigated(testPoolId, 0);

        vm.prank(address(poolManager));
        hook.afterSwap(user, testKey, params, BalanceDelta.wrap(0), "");

        vm.stopPrank();
    }

    function testMultipleProtectionMechanisms() public {
        // Enable all protections
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, true, false, true);

        // Activate circuit breaker
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Severe threat", "");

        // Swaps should be blocked
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.PoolPaused.selector);
        hook.beforeSwap(user, testKey, params, "");
    }
}
