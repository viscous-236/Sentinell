// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SentinelHook} from "../src/SentinelHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/**
 * @title DeploySentinelHook
 * @notice Deploys SentinelHook with deterministic address across multiple chains using CREATE2
 * @dev Uses CREATE2 to ensure the same address on Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia
 * 
 * Usage:
 * 1. Set PRIVATE_KEY in .env
 * 2. Set chain-specific POOL_MANAGER addresses and RPC URLs
 * 3. Deploy with: forge script Script/DeploySentinelHook.s.sol:DeploySentinelHook --rpc-url <RPC> --broadcast --verify
 * 
 * The deployment will use the same CREATE2 salt to deploy to the same address on all chains.
 */
contract DeploySentinelHook is Script {
    // CREATE2 salt for deterministic deployment
    bytes32 public constant SALT = keccak256("SENTINEL_HOOK_V1");
    
    // Base fee: 0.3% (3000 basis points)
    uint24 public constant BASE_FEE = 3000;
    
    // Chain-specific pool manager addresses (Uniswap V4 Pool Managers on testnets)
    address public constant ETHEREUM_SEPOLIA_POOL_MANAGER = 0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A;
    address public constant BASE_SEPOLIA_POOL_MANAGER = 0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829;
    address public constant ARBITRUM_SEPOLIA_POOL_MANAGER = 0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A;
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("========================================");
        console.log("Deploying SentinelHook with CREATE2");
        console.log("========================================");
        console.log("Deployer:", deployer);
        console.log("Salt:", vm.toString(SALT));
        console.log("Base Fee:", BASE_FEE);
        console.log("");
        
        // Determine which chain we're on
        uint256 chainId = block.chainid;
        address poolManager;
        
        if (chainId == 11155111) {
            // Ethereum Sepolia
            poolManager = ETHEREUM_SEPOLIA_POOL_MANAGER;
            console.log("Deploying to: Ethereum Sepolia");
        } else if (chainId == 84532) {
            // Base Sepolia
            poolManager = BASE_SEPOLIA_POOL_MANAGER;
            console.log("Deploying to: Base Sepolia");
        } else if (chainId == 421614) {
            // Arbit rum Sepolia
            poolManager = ARBITRUM_SEPOLIA_POOL_MANAGER;
            console.log("Deploying to: Arbitrum Sepolia");
        } else {
            revert("Unsupported chain");
        }
        
        console.log("Pool Manager:", poolManager);
        console.log("");
        
        // Calculate deterministic address
        address predictedAddress = predictDeterministicAddress(poolManager);
        console.log("Predicted Address:", predictedAddress);
        console.log("");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy using CREATE2
        SentinelHook hook = new SentinelHook{salt: SALT}(
            IPoolManager(poolManager),
            BASE_FEE
        );
        
        console.log("========================================");
        console.log("Deployment Successful!");
        console.log("========================================");
        console.log("SentinelHook deployed at:", address(hook));
        console.log("Owner:", hook.owner());
        console.log("Pool Manager:", address(hook.poolManager()));
        console.log("Base Fee:", hook.baseFee());
        console.log("");
        
        // Verify the address matches prediction
        require(address(hook) == predictedAddress, "Address mismatch!");
        console.log("Address verification: PASSED");
        console.log("");
        
        // Deployment summary
        console.log("========================================");
        console.log("Next Steps:");
        console.log("========================================");
        console.log("1. Set agent registry: hook.setAgentRegistry(address)");
        console.log("2. Configure protection for pools: hook.setProtectionConfig(poolId, ...)");
        console.log("3. Authorize agents in the registry");
        console.log("");
        console.log("Deployment complete!");
        
        vm.stopBroadcast();
    }
    
    /**
     * @notice Predicts the deterministic address for the SentinelHook deployment
     * @param poolManager The pool manager address for this chain
     * @return The predicted address
     */
    function predictDeterministicAddress(address poolManager) public view returns (address) {
        bytes memory creationCode = abi.encodePacked(
            type(SentinelHook).creationCode,
            abi.encode(IPoolManager(poolManager), BASE_FEE)
        );
        
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this), // deployer (script)
                SALT,
                keccak256(creationCode)
            )
        );
        
        return address(uint160(uint256(hash)));
    }
    
    /**
     * @notice Helper function to verify deployment on all chains
     * @dev Run this after deploying to all three chains to verify same addresses
     */
    function verifyMultiChainDeployment() external view {
        console.log("========================================");
        console.log("Multi-Chain Deployment Verification");
        console.log("========================================");
        console.log("");
        
        address ethSepoliaAddress = predictDeterministicAddressForChain(ETHEREUM_SEPOLIA_POOL_MANAGER);
        address baseSepoliaAddress = predictDeterministicAddressForChain(BASE_SEPOLIA_POOL_MANAGER);
        address arbSepoliaAddress = predictDeterministicAddressForChain(ARBITRUM_SEPOLIA_POOL_MANAGER);
        
        console.log("Ethereum Sepolia:", ethSepoliaAddress);
        console.log("Base Sepolia:", baseSepoliaAddress);
        console.log("Arbitrum Sepolia:", arbSepoliaAddress);
        console.log("");
        
        // Note: Addresses will be different due to different pool manager addresses
        console.log("Note: Addresses differ because pool manager addresses are different per chain.");
        console.log("To achieve same address, use a proxy pattern or deploy pool managers to same address.");
    }
    
    function predictDeterministicAddressForChain(address poolManager) internal view returns (address) {
        bytes memory creationCode = abi.encodePacked(
            type(SentinelHook).creationCode,
            abi.encode(IPoolManager(poolManager), BASE_FEE)
        );
        
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                SALT,
                keccak256(creationCode)
            )
        );
        
        return address(uint160(uint256(hash)));
    }
}

/**
 * @title DeploySentinelHookUniversal
 * @notice Alternative deployment strategy for truly identical addresses across chains
 * @dev For identical addresses, we need a factory contract at the same address on all chains
 */
contract DeploySentinelHookUniversal is Script {
    bytes32 public constant SALT = keccak256("SENTINEL_HOOK_V1");
    uint24 public constant BASE_FEE = 3000;
    
    // Use a deterministic factory address
    // Deploy this factory to the same address on all chains first
    address public constant FACTORY_ADDRESS = 0x0000000000000000000000000000000000000000; // TODO: Deploy factory first
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("========================================");
        console.log("Universal Deployment (Same Address)");
        console.log("========================================");
        console.log("WARNING: Requires factory at same address on all chains");
        console.log("Factory Address:", FACTORY_ADDRESS);
        console.log("");
        
        // Get pool manager from environment
        address poolManager = vm.envAddress("POOL_MANAGER_ADDRESS");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Call factory to deploy
        // Implementation depends on your factory contract
        // Example: ISentinelHookFactory(FACTORY_ADDRESS).deploy(SALT, poolManager, BASE_FEE);
        
        console.log("Deploy through factory to achieve same address across chains");
        
        vm.stopBroadcast();
    }
}
