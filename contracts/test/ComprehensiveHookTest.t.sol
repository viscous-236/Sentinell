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
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";

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
 * @title ComprehensiveHookTest
 * @notice Comprehensive tests for all SentinelHook functions
 * @dev Covers admin functions, threat broadcasting, hooks, and edge cases
 */
contract ComprehensiveHookTest is Test {
    using PoolIdLibrary for PoolKey;

    SentinelHook hook;
    MockPoolManager poolManager;
    MockAgentRegistry agentRegistry;

    address owner = address(0x1);
    address agent = address(0x2);
    address user = address(0x3);
    address attacker = address(0x4);
    address newOwner = address(0x5);

    PoolKey testKey;
    PoolId testPoolId;

    // Events
    event AgentRegistryUpdated(address newRegistry);
    event ProtectionConfigUpdated(
        PoolId indexed poolId,
        bool circuitBreaker,
        bool oracle,
        bool antiSandwich
    );
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

        // Deploy hook
        hook = new SentinelHook(IPoolManager(address(poolManager)), 3000);

        // Setup
        hook.setAgentRegistry(address(agentRegistry));
        agentRegistry.authorize(agent);

        // Create test pool
        testKey = PoolKey({
            currency0: Currency.wrap(address(0x1000)),
            currency1: Currency.wrap(address(0x2000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        testPoolId = testKey.toId();

        poolManager.setSlot0(testPoolId, 79228162514264337593543950336);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN FUNCTION TESTS
    //////////////////////////////////////////////////////////////*/

    function testSetBaseFee() public {
        vm.prank(owner);

        uint24 newFee = 5000; // 0.5%
        hook.setBaseFee(newFee);

        assertEq(hook.baseFee(), newFee);
    }

    function testSetBaseFeeRevertsIfTooHigh() public {
        vm.prank(owner);

        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.setBaseFee(60000); // > MAX_FEE (50000)
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

        // Try to execute swap - should revert
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectRevert(SentinelHook.Paused.selector);
        hook.beforeSwap(user, testKey, params, "");
    }

    function testEmergencyUnpause() public {
        vm.startPrank(owner);

        hook.emergencyPause(true);
        assertTrue(hook.paused());

        hook.emergencyPause(false);
        assertFalse(hook.paused());

        vm.stopPrank();
    }

    function testEmergencyPauseRevertsIfNotOwner() public {
        vm.prank(attacker);

        vm.expectRevert();
        hook.emergencyPause(true);
    }

    function testSetAgentRegistryUpdates() public {
        vm.prank(owner);

        address newRegistry = address(0x999);

        vm.expectEmit(false, false, false, true);
        emit AgentRegistryUpdated(newRegistry);

        hook.setAgentRegistry(newRegistry);

        assertEq(hook.agentRegistry(), newRegistry);
    }

    function testSetAgentRegistryRevertsZeroAddress() public {
        vm.prank(owner);

        vm.expectRevert(SentinelHook.InvalidRegistry.selector);
        hook.setAgentRegistry(address(0));
    }

    function testSetAgentRegistryRevertsIfNotOwner() public {
        vm.prank(attacker);

        vm.expectRevert();
        hook.setAgentRegistry(address(0x999));
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

    function testOwnershipTransfer() public {
        vm.prank(owner);
        hook.transferOwnership(newOwner);

        vm.prank(newOwner);
        hook.acceptOwnership();

        assertEq(hook.owner(), newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                        THREAT BROADCAST TESTS
    //////////////////////////////////////////////////////////////*/

    function testBroadcastThreat() public {
        vm.prank(agent);

        string[] memory signalTypes = new string[](2);
        signalTypes[0] = "LARGE_SWAP";
        signalTypes[1] = "GAS_SPIKE";

        vm.expectEmit(true, false, false, false);
        emit ThreatBroadcast(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp,
            block.timestamp + 300,
            "Suspici ous MEV activity detected",
            signalTypes
        );

        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "Suspicious MEV activity detected",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfUnauthorized() public {
        vm.prank(attacker);

        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

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
        vm.prank(agent);

        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.expectRevert("Only ELEVATED tier");
        hook.broadcastThreat(
            testPoolId,
            "CRITICAL", // Invalid - should be ELEVATED
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfInvalidScore() public {
        vm.prank(agent);

        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.expectRevert("Invalid score");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            101, // Invalid - max is 100
            block.timestamp + 300,
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfPastExpiry() public {
        vm.prank(agent);

        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.expectRevert("Invalid expiry");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp - 1, // Past timestamp
            "Test",
            signalTypes,
            ""
        );
    }

    function testBroadcastThreatRevertsIfEmptyRationale() public {
        vm.prank(agent);

        string[] memory signalTypes = new string[](1);
        signalTypes[0] = "LARGE_SWAP";

        vm.expectRevert("Empty rationale");
        hook.broadcastThreat(
            testPoolId,
            "ELEVATED",
            "MEV_PROTECTION",
            75,
            block.timestamp + 300,
            "", // Empty rationale
            signalTypes,
            ""
        );
    }

    /*//////////////////////////////////////////////////////////////
                        HOOK PERMISSION TESTS
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
        assertFalse(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwapReturnDelta);
        assertFalse(permissions.afterAddLiquidityReturnDelta);
        assertFalse(permissions.afterRemoveLiquidityReturnDelta);
    }

    function testBeforeInitializeReturnsCorrectSelector() public {
        bytes4 selector = hook.beforeInitialize(address(0), testKey, 0);
        assertEq(selector, IHooks.beforeInitialize.selector);
    }

    function testAfterInitializeReturnsCorrectSelector() public {
        bytes4 selector = hook.afterInitialize(address(0), testKey, 0, 0);
        assertEq(selector, IHooks.afterInitialize.selector);
    }

    function testBeforeAddLiquidityReturnsCorrectSelector() public {
        IPoolManager.ModifyLiquidityParams memory params;
        bytes4 selector = hook.beforeAddLiquidity(
            address(0),
            testKey,
            params,
            ""
        );
        assertEq(selector, IHooks.beforeAddLiquidity.selector);
    }

    function testAfterAddLiquidityReturnsCorrectSelector() public {
        IPoolManager.ModifyLiquidityParams memory params;
        (bytes4 selector, ) = hook.afterAddLiquidity(
            address(0),
            testKey,
            params,
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            ""
        );
        assertEq(selector, IHooks.afterAddLiquidity.selector);
    }

    function testBeforeRemoveLiquidityReturnsCorrectSelector() public {
        IPoolManager.ModifyLiquidityParams memory params;
        bytes4 selector = hook.beforeRemoveLiquidity(
            address(0),
            testKey,
            params,
            ""
        );
        assertEq(selector, IHooks.beforeRemoveLiquidity.selector);
    }

    function testAfterRemoveLiquidityReturnsCorrectSelector() public {
        IPoolManager.ModifyLiquidityParams memory params;
        (bytes4 selector, ) = hook.afterRemoveLiquidity(
            address(0),
            testKey,
            params,
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            ""
        );
        assertEq(selector, IHooks.afterRemoveLiquidity.selector);
    }

    function testBeforeDonateReturnsCorrectSelector() public {
        bytes4 selector = hook.beforeDonate(address(0), testKey, 0, 0, "");
        assertEq(selector, IHooks.beforeDonate.selector);
    }

    function testAfterDonateReturnsCorrectSelector() public {
        bytes4 selector = hook.afterDonate(address(0), testKey, 0, 0, "");
        assertEq(selector, IHooks.afterDonate.selector);
    }

    /*//////////////////////////////////////////////////////////////
                            EDGE CASE TESTS
    //////////////////////////////////////////////////////////////*/

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

    function testAfterSwapEmitsThreatMitigatedWhenProtectionActive() public {
        // Activate protection
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        // Execute swap
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        // beforeSwap first
        hook.beforeSwap(user, testKey, params, "");

        // afterSwap should emit ThreatMitigated
        vm.expectEmit(true, false, false, false);
        emit ThreatMitigated(testPoolId, 0);

        hook.afterSwap(user, testKey, params, BalanceDelta.wrap(0), "");
    }

    function testPausedBlocksCircuitBreakerActivation() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(agent);
        vm.expectRevert(SentinelHook.Paused.selector);
        hook.activateCircuitBreaker(testPoolId, "Test", "");
    }

    function testPausedBlocksProtectionActivation() public {
        vm.prank(owner);
        hook.emergencyPause(true);

        vm.prank(agent);
        vm.expectRevert(SentinelHook.Paused.selector);
        hook.activateProtection(testPoolId, 10000, "");
    }

    function testDeactivateInactiveCircuitBreakerDoesNothing() public {
        vm.prank(agent);

        // Deactivate when not active - should not revert
        hook.deactivateCircuitBreaker(testPoolId, "");

        assertFalse(hook.isCircuitBreakerActive(testPoolId));
    }

    function testDeactivateInactiveProtectionDoesNothing() public {
        vm.prank(agent);

        // Deactivate when not active - should not revert
        hook.deactivateProtection(testPoolId, "");

        assertFalse(hook.isProtectionActive(testPoolId));
    }

    function testGetActiveFeeReturnsBaseFeeWhenNoProtection() public {
        uint24 fee = hook.getActiveFee(testPoolId);
        assertEq(fee, 3000); // base fee
    }

    function testGetActiveFeeReturnsAdjustedFeeWhenProtectionActive() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 15000, "");

        uint24 fee = hook.getActiveFee(testPoolId);
        assertEq(fee, 15000);
    }

    function testIsProtectionActiveReturnsFalseAfterExpiry() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        assertTrue(hook.isProtectionActive(testPoolId));

        // Move past expiry
        vm.roll(block.number + 2);

        assertFalse(hook.isProtectionActive(testPoolId));
    }

    function testIsCircuitBreakerActiveReturnsFalseAfterExpiry() public {
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, true, false, false);

        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test", "");

        assertTrue(hook.isCircuitBreakerActive(testPoolId));

        // Move past expiry
        vm.roll(block.number + 2);

        assertFalse(hook.isCircuitBreakerActive(testPoolId));
    }

    event ThreatMitigated(PoolId indexed poolId, uint256 savedAmount);
}
