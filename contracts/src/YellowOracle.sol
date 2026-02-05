// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title YellowOracle
 * @notice Stores and validates Yellow Network protection authorizations
 *
 * Per PROJECT_SPEC.md Section 4.5:
 * "Agents communicate via Yellow state channels. Enables:
 *  - fast consensus
 *  - no mempool exposure
 *  - atomic off-chain coordination"
 *
 * This contract is the ON-CHAIN component that receives batched settlements
 * from Yellow state channels. The SentinelHook checks this oracle before swaps.
 *
 * FLOW:
 *   1. Executor signs authorization OFF-CHAIN
 *   2. Broadcasts via Yellow state channel (INSTANT, <50ms)
 *   3. Later: Executor commits batch to this oracle (for finality)
 *   4. SentinelHook.beforeSwap() checks this oracle
 *
 * KEY INSIGHT: Protection is active via Yellow BEFORE on-chain settlement.
 * This oracle provides finality and dispute resolution.
 */

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    MessageHashUtils
} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract YellowOracle is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct Authorization {
        bytes32 poolId; // Target pool
        uint8 action; // 1=MEV, 2=OracleValidation, 3=CircuitBreaker
        uint24 fee; // Dynamic fee in basis points (0-50000)
        uint256 expiryBlock; // Block number when authorization expires
        uint256 timestamp; // Unix timestamp of signature
        uint256 nonce; // Unique nonce to prevent replay
        address signer; // Executor address that signed
        bytes signature; // EIP-712 signature
        bool active; // Whether authorization is active
    }

    enum Action {
        NONE,
        MEV_PROTECTION,
        ORACLE_VALIDATION,
        CIRCUIT_BREAKER
    }

    mapping(address => bool) public authorizedExecutors;
    mapping(bytes32 => Authorization) public authorizations;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    uint256 public totalAuthorizationsCommitted;
    uint256 public totalBatchesCommitted;

    event ExecutorAuthorized(address indexed executor);
    event ExecutorRevoked(address indexed executor);
    event AuthorizationCommitted(
        bytes32 indexed poolId,
        uint8 action,
        uint24 fee,
        uint256 expiryBlock,
        address indexed signer,
        uint256 timestamp
    );
    event AuthorizationRevoked(
        bytes32 indexed poolId,
        address indexed revokedBy
    );
    event BatchCommitted(uint256 count, address indexed committer);

    error UnauthorizedExecutor();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error AuthorizationExpired();
    error InvalidAction();
    error EmptyBatch();

    constructor() Ownable(msg.sender) {
        authorizedExecutors[msg.sender] = true;
        emit ExecutorAuthorized(msg.sender);
    }

    /**
     * @notice Authorize an executor to commit authorizations
     * @param executor Address to authorize
     */
    function authorizeExecutor(address executor) external onlyOwner {
        authorizedExecutors[executor] = true;
        emit ExecutorAuthorized(executor);
    }

    /**
     * @notice Revoke an executor's authorization
     * @param executor Address to revoke
     */
    function revokeExecutor(address executor) external onlyOwner {
        authorizedExecutors[executor] = false;
        emit ExecutorRevoked(executor);
    }

    /**
     * @notice Commit a single authorization from Yellow state channel
     *
     * This is called AFTER protection is already active via Yellow.
     * It provides on-chain finality and dispute resolution.
     *
     * @param poolId Target pool identifier
     * @param action Protection action type (1=MEV, 2=Oracle, 3=Circuit)
     * @param fee Dynamic fee in basis points
     * @param expiryBlock Block when authorization expires
     * @param timestamp Unix timestamp when signed
     * @param nonce Unique nonce to prevent replay
     * @param signature EIP-712 signature from Executor
     */
    function commitAuthorization(
        bytes32 poolId,
        uint8 action,
        uint24 fee,
        uint256 expiryBlock,
        uint256 timestamp,
        uint256 nonce,
        bytes calldata signature
    ) external {
        if (!authorizedExecutors[msg.sender]) revert UnauthorizedExecutor();
        if (action == 0 || action > 3) revert InvalidAction();
        if (block.number > expiryBlock) revert AuthorizationExpired();

        // Verify signature
        address signer = _verifySignature(
            poolId,
            action,
            fee,
            expiryBlock,
            timestamp,
            nonce,
            signature
        );

        // Check nonce hasn't been used
        if (usedNonces[signer][nonce]) revert NonceAlreadyUsed();
        usedNonces[signer][nonce] = true;

        // Store authorization
        authorizations[poolId] = Authorization({
            poolId: poolId,
            action: action,
            fee: fee,
            expiryBlock: expiryBlock,
            timestamp: timestamp,
            nonce: nonce,
            signer: signer,
            signature: signature,
            active: true
        });

        totalAuthorizationsCommitted++;

        emit AuthorizationCommitted(
            poolId,
            action,
            fee,
            expiryBlock,
            signer,
            timestamp
        );
    }

    /**
     * @notice Commit a batch of authorizations from Yellow state channel
     *
     * Gas-efficient way to commit multiple authorizations at once.
     * Used by Executor's processSettlementBatch().
     *
     * @param poolIds Array of pool identifiers
     * @param actions Array of action types
     * @param fees Array of dynamic fees
     * @param expiryBlocks Array of expiry blocks
     * @param timestamps Array of timestamps
     * @param nonces Array of nonces
     * @param signatures Array of signatures
     */
    function commitAuthorizationBatch(
        bytes32[] calldata poolIds,
        uint8[] calldata actions,
        uint24[] calldata fees,
        uint256[] calldata expiryBlocks,
        uint256[] calldata timestamps,
        uint256[] calldata nonces,
        bytes[] calldata signatures
    ) external {
        if (!authorizedExecutors[msg.sender]) revert UnauthorizedExecutor();
        if (poolIds.length == 0) revert EmptyBatch();

        uint256 length = poolIds.length;
        require(
            actions.length == length &&
                fees.length == length &&
                expiryBlocks.length == length &&
                timestamps.length == length &&
                nonces.length == length &&
                signatures.length == length,
            "Array length mismatch"
        );

        for (uint256 i = 0; i < length; i++) {
            if (actions[i] == 0 || actions[i] > 3) continue; // Skip invalid
            if (block.number > expiryBlocks[i]) continue; // Skip expired

            address signer = _verifySignature(
                poolIds[i],
                actions[i],
                fees[i],
                expiryBlocks[i],
                timestamps[i],
                nonces[i],
                signatures[i]
            );

            if (usedNonces[signer][nonces[i]]) continue; // Skip used nonce
            usedNonces[signer][nonces[i]] = true;

            authorizations[poolIds[i]] = Authorization({
                poolId: poolIds[i],
                action: actions[i],
                fee: fees[i],
                expiryBlock: expiryBlocks[i],
                timestamp: timestamps[i],
                nonce: nonces[i],
                signer: signer,
                signature: signatures[i],
                active: true
            });

            totalAuthorizationsCommitted++;

            emit AuthorizationCommitted(
                poolIds[i],
                actions[i],
                fees[i],
                expiryBlocks[i],
                signer,
                timestamps[i]
            );
        }

        totalBatchesCommitted++;
        emit BatchCommitted(length, msg.sender);
    }

    /**
     * @notice Revoke an authorization (emergency only)
     * @param poolId Pool to revoke authorization for
     */
    function revokeAuthorization(bytes32 poolId) external onlyOwner {
        authorizations[poolId].active = false;
        emit AuthorizationRevoked(poolId, msg.sender);
    }

    // =========================================================================
    // INSTANT VERIFICATION (No storage, called by SentinelHook during swaps)
    // =========================================================================

    /**
     * @notice Verify an off-chain signed authorization INSTANTLY
     *
     * This is the KEY to sub-50ms protection:
     *   1. Executor signs authorization OFF-CHAIN
     *   2. Broadcasts via Yellow state channel (INSTANT)
     *   3. Swap tx includes signature in hookData
     *   4. SentinelHook calls this function to verify
     *   5. Protection is INSTANT (no on-chain tx needed!)
     *
     * On-chain commitAuthorization() is only for settlement/accounting.
     *
     * @param poolId Pool identifier
     * @param action Protection action (1=MEV, 2=Oracle, 3=CircuitBreaker)
     * @param fee Dynamic fee in basis points
     * @param expiryBlock Block when authorization expires
     * @param timestamp Unix timestamp when signed
     * @param nonce Unique nonce (for replay prevention in settlement)
     * @param signature Executor's off-chain signature
     * @return valid Whether the signature is valid and from authorized executor
     * @return signer The executor who signed (if valid)
     */
    function verifyInstantAuthorization(
        bytes32 poolId,
        uint8 action,
        uint24 fee,
        uint256 expiryBlock,
        uint256 timestamp,
        uint256 nonce,
        bytes calldata signature
    ) external view returns (bool valid, address signer) {
        // Check action is valid
        if (action == 0 || action > 3) {
            return (false, address(0));
        }

        // Check not expired
        if (block.number > expiryBlock) {
            return (false, address(0));
        }

        // Verify signature and recover signer
        signer = _verifySignatureView(
            poolId,
            action,
            fee,
            expiryBlock,
            timestamp,
            nonce,
            signature
        );

        // Check signer is authorized executor
        if (signer == address(0) || !authorizedExecutors[signer]) {
            return (false, address(0));
        }

        return (true, signer);
    }

    /**
     * @notice View version of signature verification (doesn't revert)
     */
    function _verifySignatureView(
        bytes32 poolId,
        uint8 action,
        uint24 fee,
        uint256 expiryBlock,
        uint256 timestamp,
        uint256 nonce,
        bytes calldata signature
    ) internal view returns (address signer) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                poolId,
                _actionToString(action),
                fee,
                expiryBlock,
                timestamp,
                nonce
            )
        );

        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        // Use tryRecover to avoid revert on invalid signature
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(
            ethSignedMessageHash,
            signature
        );

        if (error != ECDSA.RecoverError.NoError) {
            return address(0);
        }

        return recovered;
    }

    // =========================================================================
    // QUERY FUNCTIONS (Called by SentinelHook)
    // =========================================================================

    /**
     * @notice Get active authorization for a pool
     *
     * Called by SentinelHook.beforeSwap() to check if Yellow-authorized
     * protection is active. Returns authorization data if valid.
     *
     * @param poolId Pool to check
     * @return hasAuth Whether an active authorization exists
     * @return fee Dynamic fee to apply (0 = circuit breaker)
     * @return expiryBlock Block when authorization expires
     * @return signer Executor who signed the authorization
     */
    function getAuthorization(
        bytes32 poolId
    )
        external
        view
        returns (bool hasAuth, uint24 fee, uint256 expiryBlock, address signer)
    {
        Authorization storage auth = authorizations[poolId];

        if (!auth.active || block.number > auth.expiryBlock) {
            return (false, 0, 0, address(0));
        }

        return (true, auth.fee, auth.expiryBlock, auth.signer);
    }

    /**
     * @notice Check if pool has active MEV protection
     * @param poolId Pool to check
     * @return active Whether MEV protection is active
     */
    function hasMEVProtection(
        bytes32 poolId
    ) external view returns (bool active) {
        Authorization storage auth = authorizations[poolId];
        return
            auth.active &&
            auth.action == uint8(Action.MEV_PROTECTION) &&
            block.number <= auth.expiryBlock;
    }

    /**
     * @notice Check if pool has active circuit breaker
     * @param poolId Pool to check
     * @return active Whether circuit breaker is active
     */
    function hasCircuitBreaker(
        bytes32 poolId
    ) external view returns (bool active) {
        Authorization storage auth = authorizations[poolId];
        return
            auth.active &&
            auth.action == uint8(Action.CIRCUIT_BREAKER) &&
            block.number <= auth.expiryBlock;
    }

    // =========================================================================
    // INTERNAL FUNCTIONS
    // =========================================================================

    /**
     * @notice Verify EIP-712 style signature from Executor
     *
     * Message format matches Executor's signYellowProtectionAuthorization():
     *   keccak256(abi.encodePacked(poolId, action, fee, expiryBlock, timestamp, nonce, chain))
     *
     * Note: We omit 'chain' in on-chain verification since this contract is chain-specific.
     */
    function _verifySignature(
        bytes32 poolId,
        uint8 action,
        uint24 fee,
        uint256 expiryBlock,
        uint256 timestamp,
        uint256 nonce,
        bytes calldata signature
    ) internal pure returns (address signer) {
        // Recreate message hash (matching Executor's format, minus chain which is implicit)
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                poolId,
                _actionToString(action),
                fee,
                expiryBlock,
                timestamp,
                nonce
            )
        );

        // Convert to Ethereum signed message hash
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        // Recover signer
        signer = ethSignedMessageHash.recover(signature);

        if (signer == address(0)) revert InvalidSignature();
    }

    /**
     * @notice Convert action enum to string for signature verification
     */
    function _actionToString(
        uint8 action
    ) internal pure returns (string memory) {
        if (action == 1) return "MEV_PROTECTION";
        if (action == 2) return "ORACLE_VALIDATION";
        if (action == 3) return "CIRCUIT_BREAKER";
        return "";
    }
}
