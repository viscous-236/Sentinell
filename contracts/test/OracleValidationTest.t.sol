// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

contract MockChainlinkFeed {
    int256 public price;
    uint256 public updatedAt;
    
    function setPrice(int256 _price) external {
        price = _price;
        updatedAt = block.timestamp;
    }
    
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 _updatedAt,
        uint80 answeredInRound
    ) {
        return (0, price, 0, updatedAt, 0);
    }
}

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

contract OracleValidationTest is Test {
    using PoolIdLibrary for PoolKey;
    
    SentinelHook hook;
    MockPoolManager poolManager;
    MockAgentRegistry agentRegistry;
    MockChainlinkFeed chainlinkFeed;
    
    address owner = address(0x1);
    address agent = address(0x2);
    address user = address(0x3);
    
    PoolKey testKey;
    PoolId testPoolId;
    
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
    
    function setUp() public {
        vm.startPrank(owner);
        
        // Deploy mocks
        poolManager = new MockPoolManager();
        agentRegistry = new MockAgentRegistry();
        chainlinkFeed = new MockChainlinkFeed();
        
        // Deploy hook
        hook = new SentinelHook(IPoolManager(address(poolManager)), 3000);
        
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
        
        // Initialize pool price (sqrtPriceX96 for price = 1.0)
        // sqrtPriceX96 = sqrt(1.0) * 2^96 = 79228162514264337593543950336
        poolManager.setSlot0(testPoolId, 79228162514264337593543950336);
        
        // Enable oracle validation
        hook.setProtectionConfig(testPoolId, false, true, false);
        
        vm.stopPrank();
    }
    
    function testOracleConfiguration() public {
        vm.prank(agent);
        
        vm.expectEmit(true, false, false, true);
        emit OracleConfigured(testPoolId, address(chainlinkFeed), 200);
        
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, "");
        
        (address feed, , uint256 threshold, , bool enabled) = hook.oracleConfigs(testPoolId);
        
        assertEq(feed, address(chainlinkFeed));
        assertEq(threshold, 200);
        assertTrue(enabled);
    }
    
    function testOracleValidationWithinThreshold() public {
        // Configure oracle
        vm.prank(agent);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, ""); // 2% threshold
        
        // Set Chainlink price (1 ETH = 2000 USD, 8 decimals)
        chainlinkFeed.setPrice(2000_00000000);
        
        // Set pool price close to oracle (1.5% deviation)
        // Price = 1.985 -> sqrtPriceX96 ≈ 1.409 * 2^96 = 111646374287468315685319590272
        poolManager.setSlot0(testPoolId, 111646374287468315685319590272);
        
        // Should not revert
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        hook.beforeSwap(user, testKey, params, "");
    }
    
    function testOracleValidationBlocksExcessiveDeviation() public {
        // Configure oracle
        vm.prank(agent);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, ""); // 2% threshold
        
        // Set Chainlink price
        chainlinkFeed.setPrice(2000_00000000);
        
        // Set pool price with 5% deviation (exceeds threshold)
        // This will trigger oracle validation failure
        poolManager.setSlot0(testPoolId, 120000000000000000000000000000);
        
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        vm.expectRevert(SentinelHook.OracleDeviation.selector);
        hook.beforeSwap(user, testKey, params, "");
    }
    
    function testStaleOraclePriceRejection() public {
        // Configure oracle
        vm.prank(agent);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, "");
        
        // Set stale price (more than 1 hour old)
        chainlinkFeed.setPrice(2000_00000000);
        vm.warp(block.timestamp + 3601);
        
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        vm.expectRevert(SentinelHook.StalePrice.selector);
        hook.beforeSwap(user, testKey, params, "");
    }
    
    function testInvalidOraclePrice() public {
        // Configure oracle
        vm.prank(agent);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, "");
        
        // Set invalid (negative) price
        chainlinkFeed.setPrice(-1);
        
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.beforeSwap(user, testKey, params, "");
    }
    
    function testOracleConfigurationValidation() public {
        vm.startPrank(agent);
        
        // Test zero address
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.configureOracle(testPoolId, address(0), 200, "");
        
        // Test zero threshold
        vm.expectRevert(SentinelHook.InvalidOracleConfig.selector);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 0, "");
        
        vm.stopPrank();
    }
    
    function testUnauthorizedOracleConfiguration() public {
        vm.prank(user);
        vm.expectRevert(SentinelHook.Unauthorized.selector);
        hook.configureOracle(testPoolId, address(chainlinkFeed), 200, "");
    }
    
    function testOracleSkippedWhenDisabled() public {
        // Don't configure oracle (disabled by default)
        
        // Set extreme pool price - should not revert
        poolManager.setSlot0(testPoolId, 200000000000000000000000000000);
        
        vm.prank(address(poolManager));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1000000,
            sqrtPriceLimitX96: 0
        });
        
        // Should not revert even with extreme deviation
        hook.beforeSwap(user, testKey, params, "");
    }
}