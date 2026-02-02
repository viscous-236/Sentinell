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

abstract contract AntiSandwichHook is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;

    struct ProtectionState {
        bool active;
        uint24 adjustedFee;
        uint256 expiryBlock;
        address activatedBy;
        uint256 activatedAt;
    }

    mapping(PoolId => ProtectionState) public protections;

    address public agentRegistry;
    uint24 public baseFee;
    bool public paused;
    uint24 public constant MAX_FEE = 50000;
    uint256 public constant PROTECTION_DURATION = 1;

    event HookActivated(PoolId indexed poolId, uint24 newFee,    uint256 expiryBlock, address indexed activatedBy);
    event SwapProtected(PoolId indexed poolId, address indexed user, uint24 appliedFee);
    event ThreatMitigated(PoolId indexed poolId, uint256 savedAmount);
    event ProtectionExpired(PoolId indexed poolId, uint256 expiredAt);

    error Unauthorized();
    error InvalidFee();
    error ProtectionAlreadyActive();
    error Paused();
    error InvalidRegistry();
    error NotPoolManager();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _agentRegistry, uint24 _baseFee) Ownable(msg.sender) {
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        if (_baseFee > MAX_FEE) revert InvalidFee();

        poolManager = _poolManager;
        agentRegistry = _agentRegistry;
        baseFee = _baseFee;
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
            afterSwap: true,
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
        ProtectionState storage protection = protections[poolId];

        if (protection.active && block.number > protection.expiryBlock) {
            protection.active = false;
            emit ProtectionExpired(poolId, block.number);
        }

        if (protection.active) {
            emit SwapProtected(poolId, sender, protection.adjustedFee);

            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, protection.adjustedFee);
        }

        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, baseFee);
    }

    function afterSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        if (paused) revert Paused();

        PoolId poolId = key.toId();
        ProtectionState storage protection = protections[poolId];

        if (protection.active) {
            emit ThreatMitigated(poolId, 0);
        }

        return (this.afterSwap.selector, 0);
    }

    /**
     * @notice  Activate sandwich protection for a specific pool by adjusting its fee temporarily.
     * @dev     Only callable by registerd Agents(verfied via AgentRegistry)
     */
    function activateProtection(PoolId poolId, int24 newFee, bytes calldata proof) external {
        if (paused) revert Paused();

        if (!_isAuthorizedAgent(msg.sender, proof)) {
            revert Unauthorized();
        }

        if (newFee > int24(uint24(MAX_FEE)) || newFee <= int24(baseFee)) {
            revert InvalidFee();
        }

        ProtectionState storage protection = protections[poolId];

        if (protection.active && block.number <= protection.expiryBlock) {
            revert ProtectionAlreadyActive();
        }

        uint256 expiryBlock = block.number + PROTECTION_DURATION;

        protection.active = true;
        protection.adjustedFee = uint24(newFee);
        protection.expiryBlock = expiryBlock;
        protection.activatedBy = msg.sender;
        protection.activatedAt = block.timestamp;

        emit HookActivated(poolId, uint24(newFee), expiryBlock, msg.sender);
    }

    /**
     * @notice  Manually deactivate protections (emergency only)
     * @dev     Only authorized agents can call this function
     */
    function deactivateProtection(PoolId poolId, bytes calldata proof) external {
        if (!_isAuthorizedAgent(msg.sender, proof)) {
            revert Unauthorized();
        }

        ProtectionState storage protection = protections[poolId];

        if (protection.active) {
            protection.active = false;
            emit ProtectionExpired(poolId, block.number);
        }
    }

    /*//////////////////////////////////////////////////////////////
                             VIEW_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    function isProtectionActive(PoolId poolId) external view returns (bool active) {
        ProtectionState memory protection = protections[poolId];
        return protection.active && block.number <= protection.expiryBlock;
    }

    /**
     * @notice Get current fee for a pool (adjusted or base)
     */
    function getActiveFee(PoolId poolId) external view returns (uint24 fee) {
        ProtectionState memory protection = protections[poolId];

        if (protection.active && block.number <= protection.expiryBlock) {
            return protection.adjustedFee;
        }

        return baseFee;
    }

    /**
     * @notice Get full protection state for off-chain monitoring
     */
    function getProtectionState(PoolId poolId) external view returns (ProtectionState memory state) {
        return protections[poolId];
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN_FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    /**
     * @notice Update agent registry address
     */
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        if (_agentRegistry == address(0)) revert InvalidRegistry();
        agentRegistry = _agentRegistry;
    }

    /**
     * @notice Update base fee for non-protected swaps
     */
    function setBaseFee(uint24 _baseFee) external onlyOwner {
        if (_baseFee > MAX_FEE) revert InvalidFee();
        baseFee = _baseFee;
    }

    /**
     * @notice Emergency pause (kills all hook functionality)
     */
    function emergencyPause(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /**
     * @notice Verify agent authorization via registry
     * @dev In production, this calls AgentRegistry.isAuthorized(agent, proof)
     */
    function _isAuthorizedAgent(address agent, bytes calldata proof) internal view returns (bool authorized) {
        // Call AgentRegistry to verify:
        // 1. Agent is registered
        // 2. Agent has valid TEE attestation
        // 3. Proof signature matches expected format

        // Interface call (pseudo-code):
        // return IAgentRegistry(agentRegistry).isAuthorized(agent, proof);

        // For initial deployment/testing, can simplify to:
        (bool success, bytes memory result) =
            agentRegistry.staticcall(abi.encodeWithSignature("isAuthorized(address,bytes)", agent, proof));

        if (!success || result.length == 0) {
            return false;
        }

        return abi.decode(result, (bool));
    }
}
