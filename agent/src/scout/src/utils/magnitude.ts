/**
 * Normalize a raw wei value to [0, 1] magnitude.
 * Uses a log scale so that the difference between 1 ETH and 1000 ETH is
 * perceptible, not compressed into 0.001 vs 1.0.
 *
 * Scale anchors:
 *   1 ETH  (1e18 wei) → ~0.15
 *   10 ETH (1e19 wei) → ~0.30
 *   100 ETH            → ~0.50
 *   1000 ETH           → ~0.70
 *   10000 ETH          → ~0.85
 *   100000 ETH         → ~1.0
 */
export function normalizeWeiMagnitude(weiValue: string | bigint | number): number {
    let wei: number;
    try {
        wei = Number(BigInt(weiValue));
    } catch {
        wei = Number(weiValue) || 0;
    }
    if (wei <= 0) return 0;
    const log = Math.log10(wei);
    const normalized = (log - 18) / 5;
    return Math.min(1, Math.max(0, normalized));
}

/// Normalize percent change to [0,1] Magnitude
export function normalizePriceChangeMagnitude(changePercent: number): number {
    return Math.min(1, Math.max(0, Math.abs(changePercent)));
}

/// Normalize gas spike to [0,1] Magnitude
export function normalizeGasSpikeMagnitude(currentGas: bigint, averageGas: bigint): number {
    if (averageGas === 0n) return 0;
    const ratio = Number(currentGas) / Number(averageGas);
    // Map: 1.0x = 0, 3.0x = 1.0
    return Math.min(1, Math.max(0, (ratio - 1) / 2));
}