export interface YellowConfig {
    endPoint: string; // WebSocket endpoint (e.g., wss://clearnet-sandbox.yellow.com/ws)
    agentAddress: string; // Ethereum address of the agent
    privateKey: `0x${string}`; // Private key for signing
    rpcUrl: string; // RPC URL for on-chain operations (e.g., Sepolia)
    network: 'sandbox' | 'production';
}

export type SessionId = string;

export interface SessionStatus {
    sessionId: SessionId;
    active: boolean;
    startTime: number;
    endTime?: number;
    actionsRecorded: number;
}

export interface ProtectionAction {
    type: 'THREAT_DETECTED' | 'THREAT_APPROVED' | 'THREAT_REJECTED' | 'HOOK_ACTIVATED' | 'SCOUT_SIGNAL' | 'VALIDATOR_ALERT' | 'RISK_DECISION';
    threatId: string;
    timestamp: number;
    severity?: number;
    txHash?: string;
    metadata?: Record<string, any>;
}

export interface SettlementReceipt {
    sessionId: SessionId;
    txHash: string;
    finalBalance: string;
    actionsSettled: number;
    gasUsed: string;
    sentinelReward?: string; // Micro-fees earned by Sentinel (PROJECT_SPEC.md Section 4.6)
}

export interface AppSessionDefinition {
    protocol: string;
    participants: string[];
    weights: number[];
    quorum: number;
    challenge: number;
    nonce: number;
}

export interface SessionAllocation {
    participant: string;
    asset: string;
    amount: string;
}
