// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {YellowOracle} from "../src/YellowOracle.sol";

/**
 * @title DeployYellowOracle
 * @notice Deploys YellowOracle contract for Yellow Network pre-authorization
 *
 * The YellowOracle stores off-chain signed protection authorizations
 * from Executor agents. This enables instant MEV protection without
 * mempool exposure.
 *
 * Usage:
 * forge script Script/DeployYellowOracle.s.sol:DeployYellowOracle \
 *   --rpc-url <RPC_URL> \
 *   --broadcast \
 *   --verify
 */
contract DeployYellowOracle is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("========================================");
        console.log(" YellowOracle Deployment");
        console.log("========================================");
        console.log("Deployer (EOA):", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy YellowOracle
        // Deployer becomes the owner and is automatically authorized as executor
        YellowOracle oracle = new YellowOracle();

        vm.stopBroadcast();

        console.log("========================================");
        console.log(" Deployment Successful");
        console.log("========================================");
        console.log("YellowOracle Address:", address(oracle));
        console.log("Owner:", oracle.owner());
        console.log(
            "Deployer authorized:",
            oracle.authorizedExecutors(deployer)
        );
        console.log("");

        console.log("========================================");
        console.log(" Next Steps");
        console.log("========================================");
        console.log("1. Authorize Executor agent:");
        console.log("   oracle.authorizeExecutor(<executor_address>)");
        console.log("");
        console.log("2. Link to SentinelHook:");
        console.log("   hook.setYellowOracle(", address(oracle), ")");
        console.log("");
        console.log("3. Executor can now commit authorizations:");
        console.log("   oracle.commitAuthorization(...)");
        console.log("========================================");
    }
}
