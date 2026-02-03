// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

contract MockPoolManager {
    mapping(PoolId => Slot0) private slots;
    
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
    }
    
    function getSlot0(PoolId poolId) external view returns (uint160, int24, uint24, uint24) {
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

contract CircuitBreakerTest is Test {
    using PoolIdLibrary for PoolKey;
    
    SentinelHook hook;
    MockPoolManager poolManager;
    MockAgentRegistry agentRegistry;
    
    address owner = address(0x1);
    address agent = address(0x2);
    address user = address(0x3);
    
    PoolKey testKey;
    PoolId testPoolId;
    
    event CircuitBreakerActivated(
        PoolId indexed poolId,
        address indexed activatedBy,
        uint256 activatedAt,
        uint256 expiryBlock,
        string reason
    );
    
    event SwapBlockedByCircuitBreaker(
        PoolId indexed poolId,
        address indexed user,
        string reason
    );
    
    event CircuitBreakerDeactivated(
        PoolId indexed poolId,
        address indexed deactivatedBy
    );
    
    function setUp() public {
        vm.startPrank(owner);
        
        // Deploy mocks
        poolManager = new MockPoolManager();
        agentRegistry = new MockAgentRegistry();
        
        // Deploy hook
        hook = new SentinelHook(IPoolManager(address(poolManager)), 3000); // 0.3% base fee
        
        // Setup agent registry
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
        
        // Enable circuit breaker protection
        hook.setProtectionConfig(testPoolId, true, false, false);
        
        vm.stopPrank();
    }
    
    function testCircuitBreakerActivation() public {
        vm.startPrank(agent);
        
        string memory reason = "Suspicious activity detected";
        bytes memory proof = "";
        
        vm.expectEmit(true, true, false, true);
        emit CircuitBreakerActivated(testPoolId, agent, block.timestamp, block.number + 1, reason);
        
        hook.activateCircuitBreaker(testPoolId, reason, proof);
        
        assertTrue(hook.isCircuitBreakerActive(testPoolId));
        
        vm.stopPrank();
    }
    
    function testCircuitBreakerBlocksSwaps() public {
        // Activate circuit breaker
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Emergency stop", "");
        
        // Try to execute swap
        vm.startPrank(address(poolManager));
        
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        vm.expectRevert(SentinelHook.PoolPaused.selector);
        hook.beforeSwap(user, testKey, params, "");
        
        vm.stopPrank();
    }
    
    function testCircuitBreakerExpiry() public {
        // Activate circuit breaker
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test expiry", "");
        
        assertTrue(hook.isCircuitBreakerActive(testPoolId));
        
        // Move past expiry block
        vm.roll(block.number + 2);
        
        // Should auto-expire when checked
        vm.startPrank(address(poolManager));
        
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        // Should not revert - circuit breaker expired
        hook.beforeSwap(user, testKey, params, "");
        
        vm.stopPrank();
    }
    
    function testCircuitBreakerDeactivation() public {
        // Activate
        vm.prank(agent);
        hook.activateCircuitBreaker(testPoolId, "Test deactivation", "");
        
        assertTrue(hook.isCircuitBreakerActive(testPoolId));
        
        // Deactivate
        vm.prank(agent);
        vm.expectEmit(true, true, false, false);
        emit CircuitBreakerDeactivated(testPoolId, agent);
        hook.deactivateCircuitBreaker(testPoolId, "");
        
        assertFalse(hook.isCircuitBreakerActive(testPoolId));
    }
    
    function testCannotActivateCircuitBreakerWithoutAuthorization() public {
        vm.prank(user);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.activateCircuitBreaker(testPoolId, "Unauthorized attempt", "");
    }
    
    function testCannotReactivateActiveCircuitBreaker() public {
        vm.startPrank(agent);
        
        hook.activateCircuitBreaker(testPoolId, "First activation", "");
        
        vm.expectRevert(SentinelHook.ProtectionAlreadyActive.selector);
        hook.activateCircuitBreaker(testPoolId, "Second activation", "");
        
        vm.stopPrank();
    }
    
    function testCircuitBreakerReasonValidation() public {
        vm.startPrank(agent);
        
        // Test empty reason
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.activateCircuitBreaker(testPoolId, "", "");
        
        // Test reason too long
        string memory longReason = new string(300);
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.activateCircuitBreaker(testPoolId, longReason, "");
        
        vm.stopPrank();
    }
}