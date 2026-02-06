/**
 * Sentinel Contract Addresses Configuration
 * 
 * Updated: February 6, 2026
 * Post-YellowOracle removal deployment
 */

export const SENTINEL_CONTRACTS = {
  ethereum: {
    chainId: 11155111,
    network: "ethereum-sepolia",
    sentinelHook: "0xb0dD144187F0e03De762E05F7097E77A9aB9765b",
    agentRegistry: "0x59e933aa18ACC69937e068873CF6EA62742D6a14",
    poolManager: "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A",
    explorer: "https://sepolia.etherscan.io",
    rpcUrl: "https://sepolia.ethereum.org",
  },
  base: {
    chainId: 84532,
    network: "base-sepolia",
    sentinelHook: "0x3cC61A0fC30b561881a39ece40E230DC02D4c99B",
    agentRegistry: "0x4267E4cB6d6595474a79220f8d9D96108052AC9E",
    poolManager: "0x7Da1D65F8B249183667cdE74C5CBD46dD38AA829",
    explorer: "https://sepolia.basescan.org",
    rpcUrl: "https://sepolia.base.org",
  },
  arbitrum: {
    chainId: 421614,
    network: "arbitrum-sepolia",
    sentinelHook: "0xb0dD144187F0e03De762E05F7097E77A9aB9765b",
    agentRegistry: "0x709C1e6fbA95A6C520E7AC1716d32Aef8b675a32",
    poolManager: "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A",
    explorer: "https://sepolia.arbiscan.io",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  },
} as const;

export type ChainKey = keyof typeof SENTINEL_CONTRACTS;

export function getHookAddress(chain: ChainKey): string {
  return SENTINEL_CONTRACTS[chain].sentinelHook;
}

export function getRegistryAddress(chain: ChainKey): string {
  return SENTINEL_CONTRACTS[chain].agentRegistry;
}

export function getExplorerUrl(chain: ChainKey, txHash: string): string {
  return `${SENTINEL_CONTRACTS[chain].explorer}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chain: ChainKey, address: string): string {
  return `${SENTINEL_CONTRACTS[chain].explorer}/address/${address}`;
}

// ABIs for common interactions
export const SENTINEL_HOOK_ABI = [
  "function protections(bytes32 poolId) view returns (bool active, uint24 fee, uint256 activatedAt)",
  "function breakers(bytes32 poolId) view returns (bool active, string reason, uint256 activatedAt)",
  "function oracleConfigs(bytes32 poolId) view returns (address chainlinkFeed, uint256 priceThreshold, bool active)",
  "function activateProtection(bytes32 poolId, uint24 dynamicFee, bytes proof) external",
  "function activateCircuitBreaker(bytes32 poolId, string reason, bytes proof) external",
  "function configureOracle(bytes32 poolId, address chainlinkFeed, uint256 priceThreshold, bytes proof) external",
  "function deactivateProtection(bytes32 poolId) external",
  "function deactivateCircuitBreaker(bytes32 poolId) external",
  "event ProtectionActivated(bytes32 indexed poolId, uint24 dynamicFee, uint256 timestamp)",
  "event CircuitBreakerActivated(bytes32 indexed poolId, string reason, uint256 timestamp)",
] as const;

export const AGENT_REGISTRY_ABI = [
  "function registerAgent(address agent, string agentType, string metadata) external",
  "function agents(address) view returns (string agentType, bool active, uint256 registeredAt)",
] as const;
