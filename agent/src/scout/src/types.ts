export type ScoutSignalType =
    | "FLASH_LOAN"
    | "GAS_SPIKE"
    | "LARGE_SWAP"
    | "PRICE_MOVE"
    | "MEMPOOL_CLUSTER"
    | "CROSS_CHAIN_ATTACK";


export interface ScoutSignal {
    type: ScoutSignalType;
    chain: string;
    pair: string;
    poolAddress?: string;
    timestamp: number;
    magnitude: number; // normalized 0-1 value
    raw?: any; // original event data for audit trail (MempoolTransaction | FlashLoan | GasData | DexPrice)
}

