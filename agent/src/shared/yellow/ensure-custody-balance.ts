/**
 * Helper to check and ensure custody balance for Yellow Network testing
 * Based on Yellow SDK examples: deposit_to_custody.ts and get_custody_balance.ts
 */

import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const CUSTODY_CONTRACT = '0x019B65A265EB3363822f2752141b3dF16131b262'; // Yellow Sandbox
const YTEST_USD_TOKEN = '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb'; // ytest.usd on Sepolia

// Minimal ERC20 ABI for balance and approve
const ERC20_ABI = [
    {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        name: 'approve',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
    },
] as const;

// Minimal Custody ABI for deposits
const CUSTODY_ABI = [
    {
        inputs: [
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        name: 'deposit',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'token', type: 'address' },
        ],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const;

export async function ensureCustodyBalance(
    privateKey: `0x${string}`,
    rpcUrl: string,
    requiredUSDC: number = 20
): Promise<void> {
    const account = privateKeyToAccount(privateKey);
    
    const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
        chain: sepolia,
        transport: http(rpcUrl),
        account,
    });

    console.log('\n💰 Checking custody balance...');
    console.log(`   Wallet: ${account.address}`);
    console.log(`   Required: ${requiredUSDC} USDC`);

    // Check current custody balance
    const custodyBalance = await publicClient.readContract({
        address: CUSTODY_CONTRACT,
        abi: CUSTODY_ABI,
        functionName: 'balanceOf',
        args: [account.address, YTEST_USD_TOKEN],
    });

    const custodyBalanceFormatted = Number(custodyBalance) / 1e6;
    console.log(`   Current custody balance: ${custodyBalanceFormatted} USDC`);

    if (custodyBalanceFormatted >= requiredUSDC) {
        console.log(`✅ Sufficient custody balance`);
        return;
    }

    // Need to deposit more
    const depositAmount = requiredUSDC - custodyBalanceFormatted;
    console.log(`\n⚠️  Insufficient custody balance`);
    console.log(`   Need to deposit: ${depositAmount} USDC`);

    // Check wallet token balance
    const walletBalance = await publicClient.readContract({
        address: YTEST_USD_TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });

    const walletBalanceFormatted = Number(walletBalance) / 1e6;
    console.log(`   Wallet token balance: ${walletBalanceFormatted} USDC`);

    if (walletBalanceFormatted < depositAmount) {
        console.log(`\n❌ Insufficient wallet balance to deposit`);
        console.log(`\n📝 Get test tokens from Yellow faucet:`);
        console.log(`   curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens \\`);
        console.log(`     -H "Content-Type: application/json" \\`);
        console.log(`     -d '{"userAddress":"${account.address}"}'`);
        throw new Error('Insufficient wallet balance - use faucet to get test tokens');
    }

    // Deposit to custody
    console.log(`\n📤 Depositing ${depositAmount} USDC to custody...`);
    
    const depositAmountWei = parseUnits(depositAmount.toString(), 6);

    // 1. Approve custody contract
    console.log(`   Step 1/2: Approving custody contract...`);
    const approveTx = await walletClient.writeContract({
        address: YTEST_USD_TOKEN,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CUSTODY_CONTRACT, depositAmountWei],
    });

    console.log(`   Approval tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`   ✅ Approved`);

    // 2. Deposit
    console.log(`   Step 2/2: Depositing to custody...`);
    const depositTx = await walletClient.writeContract({
        address: CUSTODY_CONTRACT,
        abi: CUSTODY_ABI,
        functionName: 'deposit',
        args: [YTEST_USD_TOKEN, depositAmountWei],
    });

    console.log(`   Deposit tx: ${depositTx}`);
    await publicClient.waitForTransactionReceipt({ hash: depositTx });

    console.log(`\n✅ Deposit complete!`);
    console.log(`   Transaction: ${depositTx}`);

    // Verify new balance
    const newBalance = await publicClient.readContract({
        address: CUSTODY_CONTRACT,
        abi: CUSTODY_ABI,
        functionName: 'balanceOf',
        args: [account.address, YTEST_USD_TOKEN],
    });

    console.log(`   New custody balance: ${Number(newBalance) / 1e6} USDC\n`);
}
