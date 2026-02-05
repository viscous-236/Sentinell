// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/**
 * @title AgentRegistry
 * @notice Manages authorization of Sentinel agents running in TEEs
 * @dev Agents register with their TEE attestation proofs and get authorized
 */
contract AgentRegistry is Ownable {
    struct AgentInfo {
        bool authorized;
        bytes32 attestationHash; // Hash of TEE attestation
        uint256 registeredAt;
        uint256 lastActiveAt;
        string agentType; // "scout", "validator", "executor", "risk-engine"
    }

    mapping(address => AgentInfo) public agents;
    
    mapping(string => address[]) public agentsByType;
    
    uint256 public totalAgents;

    event AgentRegistered(
        address indexed agent,
        string agentType,
        bytes32 attestationHash,
        uint256 timestamp
    );
    
    event AgentRevoked(address indexed agent, uint256 timestamp);
    
    event AgentActivityUpdated(address indexed agent, uint256 timestamp);

    error AgentAlreadyRegistered();
    error AgentNotRegistered();
    error InvalidAgentType();
    error InvalidAttestationHash();

    constructor() Ownable(msg.sender) {}


    function registerAgent(
        address agent,
        bytes32 attestationHash,
        string calldata agentType
    ) external onlyOwner {
        if (agents[agent].authorized) revert AgentAlreadyRegistered();
        if (attestationHash == bytes32(0)) revert InvalidAttestationHash();
        if (!_isValidAgentType(agentType)) revert InvalidAgentType();

        agents[agent] = AgentInfo({
            authorized: true,
            attestationHash: attestationHash,
            registeredAt: block.timestamp,
            lastActiveAt: block.timestamp,
            agentType: agentType
        });

        agentsByType[agentType].push(agent);
        totalAgents++;

        emit AgentRegistered(agent, agentType, attestationHash, block.timestamp);
    }

    function revokeAgent(address agent) external onlyOwner {
        if (!agents[agent].authorized) revert AgentNotRegistered();

        agents[agent].authorized = false;
        totalAgents--;

        emit AgentRevoked(agent, block.timestamp);
    }

    function isAuthorized(
        address agent,
        bytes calldata proof
    ) external view returns (bool) {
        return agents[agent].authorized;
    }

    function updateActivity(address agent) external {
        if (!agents[agent].authorized) revert AgentNotRegistered();
        
        agents[agent].lastActiveAt = block.timestamp;
        emit AgentActivityUpdated(agent, block.timestamp);
    }

    function getAgentsByType(
        string calldata agentType
    ) external view returns (address[] memory) {
        return agentsByType[agentType];
    }

    function getAgentInfo(
        address agent
    ) external view returns (AgentInfo memory) {
        return agents[agent];
    }

    function _isValidAgentType(
        string calldata agentType
    ) internal pure returns (bool) {
        bytes32 typeHash = keccak256(abi.encodePacked(agentType));
        return (
            typeHash == keccak256(abi.encodePacked("scout")) ||
            typeHash == keccak256(abi.encodePacked("validator")) ||
            typeHash == keccak256(abi.encodePacked("executor")) ||
            typeHash == keccak256(abi.encodePacked("risk-engine"))
        );
    }
}
