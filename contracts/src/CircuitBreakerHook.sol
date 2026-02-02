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

abstract contract CircuitBreakerHook is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;

    struct CircuitBreakerState{
        bool active;
        uint256 expiryBlock;
        address activatedBy;
        uint256 activatedAt;
        string reason;
    }

    IPoolManager public immutable poolManager;
    address public agentRegistry;
    uint256 public constant CIRCUIT_BREAKER_DURATION_BLOCKS = 1;// Dureation in blocks
    uint256 public constant MAX_REASON_LENGTH = 256;
    mapping(PoolId => CircuitBreakerState) public breakers;
    bool public paused;

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
        uint256 blockedAt,
        string reason
    );
    event CircuitBreakerExpired(
        PoolId indexed poolId,
        uint256 expiredAt
    );
    event CircuitBreakerDeactivated(
        PoolId indexed poolId,
        address indexed deactivatedBy,
        uint256 deactivatedAt
    );
    event AgentRegistryUpdated(address newRegistry);

    error Unauthorized();
    error PoolPaused();
    error CircuitBreakerAlreadyActive();
    error InvalidRegistry();
    error NotPoolManager();
    error Paused();
    error InvalidReason();
    error ReasonTooLong();
    

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _agentRegistry) Ownable(msg.sender) {
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        if (address(_poolManager) == address(0)) revert NotPoolManager();
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

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata , bytes calldata) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (paused) revert Paused();

        PoolId poolId = key.toId();
        CircuitBreakerState storage breaker = breakers[poolId];

        if (breaker.active) {
            if (block.number > breaker.expiryBlock){
                breaker.active = false;
                emit CircuitBreakerExpired(poolId, block.number);
            } else {
                emit SwapBlockedByCircuitBreaker(poolId, sender, block.number, breaker.reason);
                revert PoolPaused();
            }
        }

        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }


    /*//////////////////////////////////////////////////////////////
                            AGENT_FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice  Activates the circuit breaker for a specific pool.
     * @dev    Only callable by authorized agents.
     */
    function activeCircuitBreaker(PoolId poolId, string calldata reason, bytes calldata proof) external {
        if (paused) revert Paused();

        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();

        if (bytes(reason).length == 0) revert InvalidReason();
        if (bytes(reason).length > MAX_REASON_LENGTH) revert ReasonTooLong();

        CircuitBreakerState storage breaker = breakers[poolId];

        if (breaker.active && block.number <= breaker.expiryBlock){
            revert CircuitBreakerAlreadyActive();
        }

        uint256 expiryBlock = block.number + CIRCUIT_BREAKER_DURATION_BLOCKS;

        breaker.active = true;
        breaker.expiryBlock = expiryBlock;
        breaker.activatedBy = msg.sender;
        breaker.activatedAt = block.number;
        breaker.reason = reason;

        emit CircuitBreakerActivated(poolId, msg.sender, block.number, expiryBlock, reason);
    }

    /**
     * @notice  Deactivates the circuit breaker for a specific pool.
     * @dev     Only callable by authorized agents.
     */
    function deactivateCircuitBreaker(
        PoolId poolId,
        bytes calldata proof
    ) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) revert Unauthorized();

        CircuitBreakerState storage breaker = breakers[poolId];

        if (breaker.active) {
            breaker.active = false;
            emit CircuitBreakerDeactivated(poolId, msg.sender, block.number);
        }
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert InvalidRegistry();
        agentRegistry = newRegistry;
        emit AgentRegistryUpdated(newRegistry);
    }

    function emergencyPause(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNAL_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function _isAuthorizedAgent(address agent, bytes calldata proof) internal view returns (bool) {
        (bool success, bytes memory result) = agentRegistry.staticcall(
            abi.encodeWithSignature("isAuthorized(address,bytes)", agent, proof)
        );

        if (!success || result.length == 0) {
            return false;
        }

        return abi.decode(result, (bool));
    }

    /*//////////////////////////////////////////////////////////////
                             VIEW_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function isPaused(PoolId poolId) external view returns (bool active) {
        CircuitBreakerState memory breaker = breakers[poolId];
        return breaker.active && block.number <= breaker.expiryBlock;
    }

    function getPauseExpiry(PoolId poolId) external view returns (uint256 expiryBlock) {
        CircuitBreakerState memory breaker = breakers[poolId];
        if (!breaker.active) return 0;
        return breaker.expiryBlock;
    }

    function getBreakerState(PoolId poolId) external view returns (CircuitBreakerState memory state) {
        return breakers[poolId];
    }

    function getBlocksRemaining(PoolId poolId) external view returns (uint256 blocksRemaining) {
        CircuitBreakerState memory breaker = breakers[poolId];
        
        if (!breaker.active) return 0;
        if (block.number > breaker.expiryBlock) return 0;
        
        return breaker.expiryBlock - block.number;
    }
}
