// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AgentRegistry.sol";

contract DeployAgentRegistry is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);

        // Deploy AgentRegistry
        AgentRegistry registry = new AgentRegistry();
        
        console.log("==============================================");
        console.log("AgentRegistry deployed at:", address(registry));
        console.log("Owner:", registry.owner());
        console.log("==============================================");

        vm.stopBroadcast();
    }
}
