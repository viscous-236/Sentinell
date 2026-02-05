// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SentinelHook} from "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/**
 * @title DeploySentinelHook
 *
 * @notice
 * Deploys SentinelHook using CREATE2 for deterministic-per-chain deployment.
 *
 * IMPORTANT:
 * - The deployed address is deterministic WITHIN a chain.
 * - Addresses will DIFFER across chains because PoolManager addresses
 *   are different and are part of the constructor arguments.
 *
 * This is the correct and expected behavior for Uniswap v4 hooks.
 *
 * Why CREATE2 is still useful:
 * - Reproducible deployments
 * - Pre-computable hook addresses
 * - Easy verification in demos & scripts
 *
 * Usage:
 * forge script script/DeploySentinelHook.s.sol:DeploySentinelHook \
 *   --rpc-url <RPC_URL> \
 *   --broadcast \
 *   --verify
 */
contract DeploySentinelHook is Script {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev CREATE2 salt — keep constant across deployments
    bytes32 public constant SALT = keccak256("SENTINEL_HOOK_V3");

    /// @dev Base swap fee (0.3% expressed in Uniswap v4 fee units)
    uint24 public constant BASE_FEE = 3000;

    /*//////////////////////////////////////////////////////////////
                        UNISWAP V4 POOL MANAGERS
                        (TESTNET ADDRESSES)
    //////////////////////////////////////////////////////////////*/

    address public constant ETHEREUM_SEPOLIA_POOL_MANAGER =
        0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A;

    address public constant BASE_SEPOLIA_POOL_MANAGER =
        0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829;

    address public constant ARBITRUM_SEPOLIA_POOL_MANAGER =
        0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A;

    /*//////////////////////////////////////////////////////////////
                                DEPLOY
    //////////////////////////////////////////////////////////////*/

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        uint256 chainId = block.chainid;
        address poolManager = _getPoolManager(chainId);

        console.log("========================================");
        console.log(" SentinelHook CREATE2 Deployment");
        console.log("========================================");
        console.log("Deployer (EOA):", deployer);
        console.log("Chain ID:", chainId);
        console.log("PoolManager:", poolManager);
        console.log("Base Fee:", BASE_FEE);
        console.log("Salt:", vm.toString(SALT));
        console.log("");

        address predicted = predictAddress(deployer, poolManager);
        console.log("Predicted CREATE2 Address:", predicted);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        SentinelHook hook = new SentinelHook{salt: SALT}(
            IPoolManager(poolManager),
            BASE_FEE
        );

        vm.stopBroadcast();

        console.log("========================================");
        console.log(" Deployment Successful");
        console.log("========================================");
        console.log("SentinelHook Address:", address(hook));
        console.log("Owner:", hook.owner());
        console.log("PoolManager:", address(hook.poolManager()));
        console.log("Base Fee:", hook.baseFee());
        console.log("");

        require(address(hook) == predicted, "CREATE2 address mismatch");

        console.log("CREATE2 verification: OK");
        console.log("");

        console.log("========================================");
        console.log(" Next Steps");
        console.log("========================================");
        console.log("1. Set Agent Registry:");
        console.log("   hook.setAgentRegistry(<registry>)");
        console.log("");
        console.log("2. Configure pool protection:");
        console.log("   hook.setProtectionConfig(poolId, config)");
        console.log("");
        console.log("3. Authorize Executor agents");
        console.log("========================================");
    }

    /*//////////////////////////////////////////////////////////////
                            ADDRESS PREDICTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Predict the CREATE2 deployment address
     * @dev Forge's `new Contract{salt: SALT}()` uses Create2Deployer at 0x4e59b44847b379578588920cA78FbF26c0B4956C
     */
    function predictAddress(
        address deployer,
        address poolManager
    ) public pure returns (address) {
        // Forge uses its own Create2Deployer contract
        address create2Deployer = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

        bytes memory creationCode = abi.encodePacked(
            type(SentinelHook).creationCode,
            abi.encode(IPoolManager(poolManager), BASE_FEE)
        );

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                create2Deployer,
                SALT,
                keccak256(creationCode)
            )
        );

        return address(uint160(uint256(hash)));
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    function _getPoolManager(uint256 chainId) internal pure returns (address) {
        if (chainId == 11155111) {
            // Ethereum Sepolia
            return ETHEREUM_SEPOLIA_POOL_MANAGER;
        }

        if (chainId == 84532) {
            // Base Sepolia
            return BASE_SEPOLIA_POOL_MANAGER;
        }

        if (chainId == 421614) {
            // Arbitrum Sepolia
            return ARBITRUM_SEPOLIA_POOL_MANAGER;
        }

        revert("Unsupported chain");
    }
}
