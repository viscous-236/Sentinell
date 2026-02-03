// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
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
    
    function isAuthorized(address agent, bytes calldata) external view returns (bool) {
        return authorizedAgents[agent];
    }
}

contract AntiSandwichTest is Test {
    using PoolIdLibrary for PoolKey;

    SentinelHook hook;
    MockPoolManager poolManager;
    MockAgentRegistry agentRegistry;

    address owner = address(0x1);
    address agent = address(0x2);
    address user = address(0x3);
    address attacker = address(0x4);

    PoolKey testKey;
    PoolId testPoolId;

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

    function setUp() public {
        vm.startPrank(owner);

        // Deploy mocks
        poolManager = new MockPoolManager();
        agentRegistry = new MockAgentRegistry();

        // Deploy hook
        hook = new SentinelHook(IPoolManager(address(poolManager)), 3000); // 0.3% base fee

        // Setup registries
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

        // Initialize pool price
        poolManager.setSlot0(testPoolId, 79228162514264337593543950336);

        // Enable anti-sandwich protection
        hook.setProtectionConfig(testPoolId, false, false, true);

        vm.stopPrank();
    }

    function testProtectionActivation() public {
        vm.prank(agent);

        uint24 highFee = 10000; // 1%

        vm.expectEmit(true, false, false, true);
        emit ProtectionActivated(testPoolId, highFee, block.number + 1, agent);

        hook.activateProtection(testPoolId, highFee, "");

        assertTrue(hook.isProtectionActive(testPoolId));
        assertEq(hook.getActiveFee(testPoolId), highFee);
    }

    function testHighFeeAppliedDuringProtection() public {
        uint24 protectionFee = 15000; // 1.5%

        // Activate protection
        vm.prank(agent);
        hook.activateProtection(testPoolId, protectionFee, "");

        // Execute swap during protection
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (bytes4 selector, BeforeSwapDelta delta, uint24 appliedFee) = hook
            .beforeSwap(user, testKey, params, "");

        assertEq(appliedFee, protectionFee);
        assertEq(selector, IHooks.beforeSwap.selector);
    }

    function testBaseFeeAppliedWithoutProtection() public {
        // No protection active
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (, , uint24 appliedFee) = hook.beforeSwap(user, testKey, params, "");

        assertEq(appliedFee, 3000); // Base fee
    }

    function testProtectionExpiry() public {
        uint24 protectionFee = 12000;

        // Activate protection
        vm.prank(agent);
        hook.activateProtection(testPoolId, protectionFee, "");

        assertTrue(hook.isProtectionActive(testPoolId));

        // Move past expiry block
        vm.roll(block.number + 2);

        // Execute swap - should use base fee
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (, , uint24 appliedFee) = hook.beforeSwap(user, testKey, params, "");

        assertEq(appliedFee, 3000); // Back to base fee
        assertFalse(hook.isProtectionActive(testPoolId));
    }

    function testProtectionDeactivation() public {
        // Activate protection
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        assertTrue(hook.isProtectionActive(testPoolId));

        // Deactivate
        vm.prank(agent);
        hook.deactivateProtection(testPoolId, "");

        assertFalse(hook.isProtectionActive(testPoolId));
        assertEq(hook.getActiveFee(testPoolId), 3000); // Base fee
    }

    function testCannotActivateProtectionWithInvalidFee() public {
        vm.startPrank(agent);

        // Fee too high
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.activateProtection(testPoolId, 60000, ""); // > MAX_FEE

        // Fee too low (not higher than base fee)
        vm.expectRevert(SentinelHook.InvalidFee.selector);
        hook.activateProtection(testPoolId, 2000, ""); // < baseFee

        vm.stopPrank();
    }

    function testCannotReactivateActiveProtection() public {
        vm.startPrank(agent);

        hook.activateProtection(testPoolId, 10000, "");

        vm.expectRevert(SentinelHook.ProtectionAlreadyActive.selector);
        hook.activateProtection(testPoolId, 15000, "");

        vm.stopPrank();
    }

    function testUnauthorizedCannotActivateProtection() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.activateProtection(testPoolId, 10000, "");
    }

    function testSwapProtectedEventEmitted() public {
        uint24 protectionFee = 10000;

        // Activate protection
        vm.prank(agent);
        hook.activateProtection(testPoolId, protectionFee, "");

        // Execute swap
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        vm.expectEmit(true, true, false, true);
        emit SwapProtected(testPoolId, user, protectionFee);

        hook.beforeSwap(user, testKey, params, "");
    }

    function testMultipleProtectionCycles() public {
        vm.startPrank(agent);

        // First protection cycle
        hook.activateProtection(testPoolId, 10000, "");
        assertTrue(hook.isProtectionActive(testPoolId));

        // Wait for expiry
        vm.roll(block.number + 2);

        // Second protection cycle
        hook.activateProtection(testPoolId, 15000, "");
        assertTrue(hook.isProtectionActive(testPoolId));
        assertEq(hook.getActiveFee(testPoolId), 15000);

        vm.stopPrank();
    }

    function testProtectionConfigCanBeDisabled() public {
        // Disable anti-sandwich protection
        vm.prank(owner);
        hook.setProtectionConfig(testPoolId, false, false, false);

        // Activate protection (should still work for authorized agents)
        vm.prank(agent);
        hook.activateProtection(testPoolId, 10000, "");

        // Execute swap - protection is active but config is disabled
        // Fee should be base fee since antiSandwichEnabled = false
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });

        (, , uint24 appliedFee) = hook.beforeSwap(user, testKey, params, "");

        assertEq(appliedFee, 3000); // Base fee applied when config disabled
    }
}