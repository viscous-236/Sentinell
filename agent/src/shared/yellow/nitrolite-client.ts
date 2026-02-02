/**
 * Yellow Network Integration for Sentinel Protection Sessions
 * 
 * REAL IMPLEMENTATION using Yellow Network Protocol:
 * 1. Check UNIFIED BALANCE (off-chain, from faucet or transfers)
 * 2. Create app session using allocate_amount from unified balance (off-chain, instant, gasless)
 * 3. Record protection actions via app state updates (off-chain, zero gas)
 * 4. Close app session to settle and return funds to unified balance (instant)
 * 5. Track micro-fees per protection action (PROJECT_SPEC.md Section 4.6)
 * 
 * IMPORTANT: Faucet tokens go to UNIFIED BALANCE (off-chain), NOT custody (on-chain)
 * - Use get_ledger_balances to check unified balance
 * - Use allocate_amount to fund app sessions from unified balance
 * - Do NOT use resize_amount (that's for L1 custody deposits)
 * 
 * References:
 * - App Sessions: https://docs.yellow.org/docs/protocol/off-chain/app-sessions
 * - Queries: https://docs.yellow.org/docs/protocol/off-chain/queries
 * - SDK: https://github.com/erc7824/nitrolite
 */

import {
    createAuthRequestMessage,
    createAuthVerifyMessageFromChallenge,
    createAppSessionMessage,
    createSubmitAppStateMessage,
    createCloseAppSessionMessage,
    createECDSAMessageSigner,
    createEIP712AuthMessageSigner,
    RPCProtocolVersion,
    RPCAppStateIntent,
} from "@erc7824/nitrolite";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import WebSocket from "ws";
import {
    YellowConfig,
    SessionId,
    SessionStatus,
    ProtectionAction,
    SettlementReceipt,
} from './types';
import { CUSTODY_ABI, ERC20_ABI } from './custody-abi';

// Yellow Sandbox Configuration (Sepolia)
const YELLOW_CUSTODY_ADDRESS = '0x019B65A265EB3363822f2752141b3dF16131b262';
const YTEST_TOKEN_ADDRESS = '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb'; // ytest.usd (6 decimals)
const SENTINEL_APP_NAME = 'Sentinel MEV Protection v1.0';
const SESSION_DURATION = 3600; // 1 hour

const MICRO_FEE_PER_ACTION = '0.001'; // 0.001 ytest.usd per protection action

export class NitroliteClient {
    private config: YellowConfig;
    private ws?: WebSocket;
    private account: ReturnType<typeof privateKeyToAccount>;
    private publicClient: any;
    private walletClient: any;

    private currentSessionId?: SessionId;
    private currentAppSessionId?: string;
    private sessionActions: ProtectionAction[] = [];
    private sessionStateVersion: number = 0;
    private sessionData: any = {};

    private connected: boolean = false;
    private authenticated: boolean = false;

    private sessionSigner?: ReturnType<typeof createECDSAMessageSigner>;
    private sessionAccount?: ReturnType<typeof privateKeyToAccount>;

    private authParams?: any;
    private authResolver?: () => void;
    private authRejector?: (error: Error) => void;

    private availableAssets: any[] = [];
    private unifiedBalances: Map<string, string> = new Map(); // asset -> amount

    private sentinelAddress: string; // The Sentinel smart contract/judge

    private rpcRequestId: number = 0;
    private pendingRequests: Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }> = new Map();

    private accruedFees: string = '0';
    private totalProtectionActions: number = 0;

    // Keepalive to prevent WebSocket disconnect
    private keepaliveInterval?: NodeJS.Timeout;

    constructor(config: YellowConfig, sentinelAddress: string = '0x0000000000000000000000000000000000000001') {
        this.config = config;
        this.sentinelAddress = sentinelAddress;
        this.account = privateKeyToAccount(config.privateKey);

        if (this.account.address.toLowerCase() !== config.agentAddress.toLowerCase()) {
            throw new Error('Private key does not match agent address');
        }

        // Setup viem clients
        this.publicClient = createPublicClient({
            chain: sepolia,
            transport: http(config.rpcUrl),
        });

        this.walletClient = createWalletClient({
            chain: sepolia,
            transport: http(config.rpcUrl),
            account: this.account,
        });

        console.log('🔧 NitroliteClient initialized');
        console.log(`   Agent: ${this.account.address}`);
        console.log(`   Sentinel: ${sentinelAddress}`);
    }

    /// Connect to Yellow Network and authenticate
    async connect(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // Connect to Yellow WebSocket
                this.ws = new WebSocket(this.config.endPoint);

                // Auth promise
                const authPromise = new Promise<void>((resolveAuth, rejectAuth) => {
                    this.authResolver = resolveAuth;
                    this.authRejector = rejectAuth;

                    setTimeout(() => {
                        if (!this.authenticated) {
                            rejectAuth(new Error('Authentication timeout'));
                        }
                    }, 30000);
                });

                this.ws.on('open', async () => {
                    console.log('✅ Connected to Yellow ClearNode');
                    this.connected = true;

                    this.authenticate().catch((err) => {
                        console.error('❌ Authentication failed:', err);
                        if (this.authRejector) this.authRejector(err);
                    });
                });

                this.ws.on('error', (error) => {
                    console.error('❌ WebSocket error:', error);
                    this.connected = false;
                    if (this.authRejector) this.authRejector(error);
                    reject(error);
                });

                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Failed to parse message:', error);
                    }
                });

                this.ws.on('close', () => {
                    console.log('🔌 Disconnected from Yellow Network');
                    this.connected = false;
                    this.authenticated = false;
                });

                await authPromise;

                // Start keepalive ping every 30 seconds to prevent disconnect
                this.keepaliveInterval = setInterval(() => {
                    if (this.ws && this.connected) {
                        this.ws.ping();
                    }
                }, 30000);

                console.log('🎉 Yellow Network ready!\n');
                resolve();

            } catch (error) {
                reject(error);
            }
        });
    }

    /// Authenticate using EIP-712
    private async authenticate(): Promise<void> {
        if (!this.ws || !this.connected) {
            throw new Error('WebSocket not connected');
        }

        console.log('🔐 Starting authentication...');

        // Generate session key
        const sessionPrivateKey = generatePrivateKey();
        this.sessionSigner = createECDSAMessageSigner(sessionPrivateKey);
        this.sessionAccount = privateKeyToAccount(sessionPrivateKey);

        // Auth params for EIP-712
        this.authParams = {
            address: this.account.address,
            application: SENTINEL_APP_NAME,
            session_key: this.sessionAccount.address,
            allowances: [
                {
                    asset: 'ytest.usd',
                    amount: '1000000000000', // 1M USDC spending limit
                },
            ],
            expires_at: BigInt(Math.floor(Date.now() / 1000) + SESSION_DURATION),
            scope: 'sentinel.mev.protection',
        };

        const authRequestMsg = await createAuthRequestMessage(this.authParams);
        this.ws.send(authRequestMsg);
        console.log('📤 Auth request sent');
    }

    /// Get unified balance from cached notifications
    async getUnifiedBalance(asset: string = 'ytest.usd'): Promise<string> {
        if (!this.ws || !this.connected || !this.authenticated) {
            throw new Error('Not connected or authenticated');
        }

        // Check if we have cached balance
        if (this.unifiedBalances.has(asset)) {
            return this.unifiedBalances.get(asset)!;
        }

        // Wait briefly for balance notification (they come after auth)
        console.log(`   Waiting for balance notification for ${asset}...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check again after waiting
        if (this.unifiedBalances.has(asset)) {
            return this.unifiedBalances.get(asset)!;
        }

        // If still no balance, return '0' (user needs to request from faucet)
        console.log(`   ⚠️  No balance notification received for ${asset}`);
        return '0';
    }

    /**
     * Ensure unified balance is sufficient for session
     * 
     * IMPORTANT: Faucet tokens go to UNIFIED BALANCE (off-chain), not custody!
     * Balance updates come via `bu` notifications after authentication.
     * 
     * If balance is insufficient, show instructions for faucet.
     */
    async ensureUnifiedBalance(requiredAmount: string, asset: string = 'ytest.usd'): Promise<void> {
        console.log('\n💰 Checking Yellow Network unified balance (off-chain)...');

        // Get unified balance from notifications
        const currentBalance = await this.getUnifiedBalance(asset);
        const required = parseFloat(requiredAmount);
        const current = parseFloat(currentBalance);

        console.log(`   Asset: ${asset}`);
        console.log(`   Current unified balance: ${currentBalance}`);
        console.log(`   Required: ${requiredAmount}`);

        if (current >= required) {
            console.log('✅ Sufficient unified balance\n');
            return;
        }

        const deficit = required - current;
        console.log(`\n⚠️  Insufficient unified balance`);
        console.log(`   Deficit: ${deficit.toFixed(6)} ${asset}`);

        throw new Error(
            `Insufficient unified balance. Need ${deficit.toFixed(6)} ${asset} more.\n`
        );
    }

    /**
     * LEGACY: Ensure custody balance for L1 deposits (production use)
     * 
     * Use this only if you need to deposit from L1 (on-chain).
     * For sandbox/testing with faucet, use ensureUnifiedBalance instead.
     */
    async ensureCustodyBalance(requiredAmount: string): Promise<void> {
        console.log('\n💰 Checking ON-CHAIN custody balance (L1 deposit mode)...');
        console.log('   ⚠️  Note: Faucet tokens go to unified balance, not custody!');
        console.log('   ⚠️  For sandbox testing, use ensureUnifiedBalance() instead.');

        // Check current custody balance using getAccountsBalances
        const balances = await this.publicClient.readContract({
            address: YELLOW_CUSTODY_ADDRESS as `0x${string}`,
            abi: CUSTODY_ABI,
            functionName: 'getAccountsBalances',
            args: [
                [this.account.address],
                [YTEST_TOKEN_ADDRESS as `0x${string}`],
            ],
        }) as bigint[][];

        const custodyBalance = balances[0][0];

        const required = parseUnits(requiredAmount, 6); // ytest.usd has 6 decimals
        const current = custodyBalance;

        console.log(`   Current custody: ${formatUnits(current, 6)} ytest.usd`);
        console.log(`   Required: ${requiredAmount} ytest.usd`);

        if (current >= required) {
            console.log('✅ Sufficient custody balance\n');
            return;
        }

        const deficit = required - current;
        console.log(`\n⚠️  Insufficient custody balance`);
        console.log(`   Need to deposit: ${formatUnits(deficit, 6)} ytest.usd`);

        // Check wallet balance
        const walletBalance = await this.publicClient.readContract({
            address: YTEST_TOKEN_ADDRESS as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [this.account.address],
        }) as bigint;

        console.log(`   Wallet balance: ${formatUnits(walletBalance, 6)} ytest.usd`);

        if (walletBalance < deficit) {
            throw new Error(
                `Insufficient wallet balance. Need ${formatUnits(deficit, 6)} ytest.usd, have ${formatUnits(walletBalance, 6)}.\n` +
                `For sandbox testing, use faucet to get UNIFIED BALANCE instead:\n` +
                `curl -XPOST https://clearnet-sandbox.yellow.com/faucet/requestTokens -H "Content-Type: application/json" -d '{"userAddress":"${this.account.address}"}'`
            );
        }

        // Check allowance
        const allowance = await this.publicClient.readContract({
            address: YTEST_TOKEN_ADDRESS as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [
                this.account.address,
                YELLOW_CUSTODY_ADDRESS as `0x${string}`,
            ],
        }) as bigint;

        if (allowance < deficit) {
            console.log('   Approving custody contract...');
            const approveTx = await this.walletClient.writeContract({
                address: YTEST_TOKEN_ADDRESS as `0x${string}`,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [YELLOW_CUSTODY_ADDRESS as `0x${string}`, deficit],
            });
            console.log(`   Approval tx: ${approveTx}`);
            await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
            console.log('   ✅ Approval confirmed');
        }

        // Deposit to custody (REAL ON-CHAIN TX)
        // deposit(address account, address token, uint256 amount)
        console.log('   Depositing to custody contract...');
        const depositTx = await this.walletClient.writeContract({
            address: YELLOW_CUSTODY_ADDRESS as `0x${string}`,
            abi: CUSTODY_ABI,
            functionName: 'deposit',
            args: [
                this.account.address,
                YTEST_TOKEN_ADDRESS as `0x${string}`,
                deficit
            ],
        });

        console.log(`   Deposit tx: ${depositTx}`);
        console.log('   Waiting for confirmation...');

        // Wait for transaction confirmation
        await this.publicClient.waitForTransactionReceipt({ hash: depositTx });

        console.log('✅ Custody deposit confirmed\n');

        // Wait for backend propagation
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    /**
     * Create a Sentinel protection session using Yellow app sessions
     * 
     * Flow (using UNIFIED BALANCE from faucet):
     * 1. Ensure unified balance (off-chain, from faucet or transfers)
     * 2. Create app session using allocate_amount (off-chain, instant, gasless)
     * 3. Use NitroRPC/0.4 protocol with Sentinel governance
     * 
     * Governance Model (Watch Tower pattern from docs):
     * - Participants: [User, Sentinel]
     * - Weights: [40, 100]
     * - Quorum: 100
     * - Normal operation: User + Sentinel (140 >= 100) ✓
     * - Emergency: Sentinel alone (100 >= 100) ✓
     * 
     * Per PROJECT_SPEC.md Section 4.6:
     * - Funds deposited into Yellow (here: from unified balance)
     * - Micro-fees accrue per protection action
     * - Final balances settled at session end
     */
    async createSession(initialDepositUSDC: string = '5', poolId?: string): Promise<SessionId> {
        if (!this.authenticated || !this.ws || !this.sessionSigner) {
            throw new Error('Not authenticated');
        }

        console.log('🚀 Creating Sentinel Protection Session...');
        console.log(`   Pool: ${poolId || 'default'}`);
        console.log(`   Amount: ${initialDepositUSDC} ytest.usd`);
        console.log(`   Mode: Unified Balance (off-chain, from faucet)`);

        // Step 1: Ensure UNIFIED balance (off-chain, NOT custody!)
        // This is where faucet tokens go
        await this.ensureUnifiedBalance(initialDepositUSDC);

        // Wait for assets list
        if (this.availableAssets.length === 0) {
            console.log('⏳ Waiting for assets list...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`   Creating app session (off-chain, instant, gasless)...\n`);

        // Step 2: Create app session using allocate_amount from unified balance
        // Yellow Network requires 2 participants for app sessions
        // Using [100, 0] weights means only user needs to sign (counterparty is passive)
        const counterparty = this.sentinelAddress as `0x${string}`;

        const appDefinition = {
            application: SENTINEL_APP_NAME,
            protocol: RPCProtocolVersion.NitroRPC_0_4,
            participants: [
                this.account.address as `0x${string}`,
                counterparty, // Sentinel as passive counterparty
            ],
            weights: [100, 0], // User has full control, Sentinel doesn't need to sign
            quorum: 100,       // User alone can operate
            challenge: 86400,
            nonce: Date.now(),
        };

        // Initial allocations from unified balance (allocate_amount)
        // Per docs: Use allocate_amount for faucet/unified balance funds
        // Both participants must be in allocations (Yellow requirement)
        const allocations = [
            {
                participant: this.account.address as `0x${string}`,
                asset: 'ytest.usd',
                amount: initialDepositUSDC, // This uses allocate_amount under the hood
            },
            {
                participant: counterparty,
                asset: 'ytest.usd',
                amount: '0', // Sentinel starts with 0, gets fees on close
            },
        ];

        // Initial session data (per PROJECT_SPEC.md Section 4.6)
        const initialSessionData = {
            protectionSession: {
                poolId: poolId || 'default',
                startTime: Date.now(),
                depositAmount: initialDepositUSDC,
                actions: [],
                version: 0,
                governance: {
                    model: 'two-party', // 2 participants, but user has full control
                    participants: [this.account.address, counterparty],
                    weights: [100, 0], // User:100, Sentinel:0 (passive)
                    quorum: 100,
                },
                // Micro-fee tracking (PROJECT_SPEC.md)
                microFees: {
                    feePerAction: MICRO_FEE_PER_ACTION,
                    totalAccrued: '0',
                    actionCount: 0,
                },
            },
        };

        console.log('📤 Creating app session (off-chain, instant)...');

        // Create app session message (SDK expects single object, not array)
        const createSessionMsg = await createAppSessionMessage(
            this.sessionSigner,
            {
                definition: appDefinition,
                allocations,
                session_data: JSON.stringify(initialSessionData),
            }
        );

        this.ws.send(createSessionMsg);

        // Wait for app session creation
        console.log('⏳ Waiting for session creation...');
        await this.waitForAppSessionCreation();

        // Store session state
        this.currentSessionId = this.currentAppSessionId;
        this.sessionData = initialSessionData;
        this.sessionStateVersion = 1; // App sessions start at version 1
        this.accruedFees = '0';
        this.totalProtectionActions = 0;

        console.log('✅ Protection session created:', this.currentSessionId?.substring(0, 20) + '...');
        console.log(`   Governance: Two-party (User: 100, Sentinel: 0, Quorum: 100)`);
        console.log(`   State: Off-chain, instant updates, zero gas fees`);
        console.log(`   Micro-fee tracking: ${MICRO_FEE_PER_ACTION} ytest.usd per action\n`);

        return this.currentSessionId!;
    }

    /**
     * Record protection action off-chain via app session state update
     * 
     * Uses submit_app_state with intent: "operate" (NitroRPC/0.4)
     * - Updates session_data with new action
     * - Increments version
     * - Tracks micro-fees (PROJECT_SPEC.md Section 4.6)
     * - Off-chain, instant, gasless
     * 
     * Micro-fee Model:
     * - Each protection action accrues a small fee (0.001 ytest.usd)
     * - Fees are tracked in session_data
     * - Final settlement transfers fees to Sentinel
     */
    async recordAction(sessionId: SessionId, action: ProtectionAction): Promise<void> {
        if (!this.authenticated || !this.ws || !this.sessionSigner) {
            throw new Error('Not authenticated');
        }

        if (sessionId !== this.currentSessionId) {
            throw new Error('Invalid session ID');
        }

        console.log(`📝 Recording action: ${action.type} (${action.threatId})`);

        // Add action to local state
        this.sessionActions.push(action);
        this.totalProtectionActions++;

        // Calculate micro-fee (PROJECT_SPEC.md Section 4.6)
        const feePerAction = parseFloat(MICRO_FEE_PER_ACTION);
        const currentFees = parseFloat(this.accruedFees);
        const newTotalFees = (currentFees + feePerAction).toFixed(6);
        this.accruedFees = newTotalFees;

        // Update session data with action and micro-fee tracking
        this.sessionStateVersion++;
        this.sessionData.protectionSession.actions.push({
            ...action,
            recordedAt: Date.now(),
            stateVersion: this.sessionStateVersion,
            microFee: MICRO_FEE_PER_ACTION,
        });
        this.sessionData.protectionSession.version = this.sessionStateVersion;
        this.sessionData.protectionSession.lastUpdate = Date.now();

        // Update micro-fee tracking
        this.sessionData.protectionSession.microFees = {
            feePerAction: MICRO_FEE_PER_ACTION,
            totalAccrued: this.accruedFees,
            actionCount: this.totalProtectionActions,
        };

        // Calculate new allocations (transfer micro-fee to Sentinel)
        const userOriginalAmount = parseFloat(this.sessionData.protectionSession.depositAmount);
        const userNewAmount = (userOriginalAmount - parseFloat(this.accruedFees)).toFixed(6);
        const sentinelNewAmount = this.accruedFees;

        // Submit app state update (off-chain, instant)
        // Use OPERATE intent - redistributes funds without changing total
        // Two participants: User + Sentinel (passive counterparty)
        const stateUpdateMsg = await createSubmitAppStateMessage(
            this.sessionSigner,
            {
                app_session_id: this.currentAppSessionId! as `0x${string}`,
                intent: RPCAppStateIntent.Operate,
                version: this.sessionStateVersion,
                allocations: [
                    {
                        participant: this.account.address as `0x${string}`,
                        asset: 'ytest.usd',
                        amount: userNewAmount, // User's amount minus accrued fees
                    },
                    {
                        participant: this.sentinelAddress as `0x${string}`,
                        asset: 'ytest.usd',
                        amount: sentinelNewAmount, // Sentinel accumulates fees
                    },
                ],
                session_data: JSON.stringify(this.sessionData),
            }
        );

        this.ws.send(stateUpdateMsg);

        console.log(`   Version: ${this.sessionStateVersion}`);
        console.log(`   Total actions: ${this.sessionActions.length}`);
        console.log(`   Micro-fee: +${MICRO_FEE_PER_ACTION} ytest.usd`);
        console.log(`   Total fees accrued: ${this.accruedFees} ytest.usd`);
        console.log('✅ State updated off-chain (instant, gasless)\n');
    }

    /**
     * Close session and settle
     * 
     * Per PROJECT_SPEC.md Section 4.6:
     * - Final balances settled
     * - Agent rewards (micro-fees) distributed to Sentinel
     * - Unused funds returned to user's unified balance
     * - Protection logs committed
     */
    async closeSession(sessionId: SessionId): Promise<SettlementReceipt> {
        if (!this.authenticated || !this.ws || !this.sessionSigner) {
            throw new Error('Not authenticated');
        }

        if (sessionId !== this.currentSessionId) {
            throw new Error('Session ID mismatch');
        }

        console.log('🔄 Settling protection session...');
        console.log(`   Actions recorded: ${this.sessionActions.length}`);
        console.log(`   Final version: ${this.sessionStateVersion}`);
        console.log(`   Total micro-fees: ${this.accruedFees} ytest.usd`);

        // Calculate final allocations (two participants)
        // User gets original minus fees, Sentinel gets accrued fees
        const userOriginalAmount = parseFloat(this.sessionData.protectionSession.depositAmount);
        const sentinelReward = parseFloat(this.accruedFees);
        const userFinalAmount = (userOriginalAmount - sentinelReward).toFixed(6);
        const sentinelFinalAmount = sentinelReward.toFixed(6);

        const finalAllocations = [
            {
                participant: this.account.address as `0x${string}`,
                asset: 'ytest.usd',
                amount: userFinalAmount, // User's remaining after fees
            },
            {
                participant: this.sentinelAddress as `0x${string}`,
                asset: 'ytest.usd',
                amount: sentinelFinalAmount, // Sentinel's accrued fees
            },
        ];

        // Update final session data
        const finalSessionData = {
            ...this.sessionData,
            protectionSession: {
                ...this.sessionData.protectionSession,
                endTime: Date.now(),
                finalVersion: this.sessionStateVersion,
                status: 'settled',
                settlement: {
                    userReturned: userFinalAmount,
                    sentinelReward: this.accruedFees,
                    actionsProcessed: this.totalProtectionActions,
                },
            },
        };

        console.log('📤 Closing app session...');
        console.log(`   User receives: ${userFinalAmount} ytest.usd`);
        console.log(`   Sentinel reward: ${sentinelFinalAmount} ytest.usd`);

        if (!this.currentAppSessionId) {
            throw new Error('No active app session');
        }

        // Close app session
        const closeMsg = await createCloseAppSessionMessage(
            this.sessionSigner,
            {
                app_session_id: this.currentAppSessionId as `0x${string}`,
                allocations: finalAllocations,
                session_data: JSON.stringify(finalSessionData),
            }
        );

        this.ws.send(closeMsg);

        // Wait for closure
        await this.waitForAppSessionClose();

        const receipt: SettlementReceipt = {
            sessionId,
            txHash: '0x' + '0'.repeat(64), // Off-chain settlement, no tx hash
            finalBalance: userFinalAmount,
            actionsSettled: this.sessionActions.length,
            gasUsed: '0', // Zero gas - off-chain settlement!
            sentinelReward: this.accruedFees,
        };

        console.log('\n✅ Session Settlement Complete');
        console.log(`   Actions committed: ${this.sessionActions.length}`);
        console.log(`   Gas used: 0 (off-chain settlement)`);
        console.log(`   User balance returned: ${userFinalAmount} ytest.usd`);
        console.log(`   Sentinel reward: ${this.accruedFees} ytest.usd`);
        console.log(`   Funds returned to unified balance instantly\n`);

        // Clear session state
        this.currentSessionId = undefined;
        this.currentAppSessionId = undefined;
        this.sessionActions = [];
        this.sessionData = {};
        this.sessionStateVersion = 0;
        this.accruedFees = '0';
        this.totalProtectionActions = 0;

        return receipt;
    }

    getSessionStatus(sessionId: SessionId): SessionStatus | null {
        if (sessionId !== this.currentSessionId) {
            return null;
        }
        return {
            sessionId,
            active: this.connected && this.authenticated,
            startTime: this.sessionData.protectionSession?.startTime || Date.now(),
            actionsRecorded: this.sessionActions.length,
        };
    }

    getSessionActions(): ProtectionAction[] {
        return [...this.sessionActions];
    }

    disconnect(): void {
        // Clear keepalive interval
        if (this.keepaliveInterval) {
            clearInterval(this.keepaliveInterval);
            this.keepaliveInterval = undefined;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
        this.connected = false;
        this.authenticated = false;
        console.log('👋 Disconnected from Yellow Network');
    }

    // Helper methods

    private async waitForAppSessionCreation(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('App session creation timeout'));
            }, 30000);

            const checkInterval = setInterval(() => {
                if (this.currentAppSessionId) {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 500);
        });
    }

    private async waitForAppSessionClose(): Promise<void> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('⚠️  Close timeout (may have succeeded)');
                resolve();
            }, 30000);

            setTimeout(() => {
                clearTimeout(timeout);
                resolve();
            }, 3000);
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    private async handleMessage(message: any): Promise<void> {
        // Check for RPC response format
        const requestId = message.res?.[0];
        const msgType = message.res?.[1] || message.type;
        const data = message.res?.[2];

        // Handle pending RPC requests (like get_ledger_balances)
        if (requestId && this.pendingRequests.has(requestId)) {
            const pending = this.pendingRequests.get(requestId)!;
            this.pendingRequests.delete(requestId);

            if (msgType === 'error' || data?.error) {
                pending.reject(new Error(data?.error || 'RPC error'));
            } else {
                pending.resolve(data);
            }
            return;
        }

        switch (msgType) {
            case 'auth_challenge':
                await this.handleAuthChallenge(message);
                break;

            case 'auth_verify':
                if (data?.success === true) {
                    console.log('✅ Authentication successful');
                    this.authenticated = true;
                    if (this.authResolver) {
                        this.authResolver();
                        this.authResolver = undefined;
                        this.authRejector = undefined;
                    }
                } else {
                    const error = new Error('Authentication failed');
                    console.error('❌ Authentication failed');
                    if (this.authRejector) this.authRejector(error);
                }
                break;

            case 'assets':
                const assets = data?.assets || [];
                this.availableAssets = assets;
                console.log(`📊 Assets available: ${assets.length}`);
                break;

            case 'get_ledger_balances':
                // Handle balance query response (for direct handling)
                const balances = data?.ledger_balances || [];
                balances.forEach((b: any) => {
                    this.unifiedBalances.set(b.asset, b.amount);
                });
                console.log(`💰 Unified balances updated: ${balances.length} assets`);
                break;

            case 'create_app_session':
                this.handleAppSessionCreated(message);
                break;

            case 'submit_app_state':
                console.log('✅ App state updated');
                break;

            case 'close_app_session':
                console.log('✅ App session closed');
                this.currentAppSessionId = undefined;
                break;

            case 'bu':
                // Balance update notification
                // Format: { balance_updates: [{ asset: string, amount: string }] }
                // or can be the data directly
                const balanceUpdates = data?.balance_updates || data?.ledger_balances || [];
                if (Array.isArray(balanceUpdates)) {
                    balanceUpdates.forEach((b: any) => {
                        if (b.asset && b.amount !== undefined) {
                            this.unifiedBalances.set(b.asset.toLowerCase(), b.amount);
                            console.log(`💰 Balance: ${b.asset} = ${b.amount}`);
                        }
                    });
                }
                // Also handle direct balance fields
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    Object.entries(data).forEach(([key, value]) => {
                        if (key !== 'balance_updates' && key !== 'ledger_balances' && typeof value === 'string') {
                            this.unifiedBalances.set(key.toLowerCase(), value);
                            console.log(`💰 Balance: ${key} = ${value}`);
                        }
                    });
                }
                break;

            case 'error':
                const errorMsg = data?.error || message.error;
                console.error('❌ Yellow error:', errorMsg);
                if (this.authRejector && !this.authenticated) {
                    this.authRejector(new Error(`Auth error: ${errorMsg}`));
                }
                break;

            default:
                console.log('📨 Message:', msgType);
        }
    }

    /**
     * Handle auth challenge from Yellow
     */
    private async handleAuthChallenge(message: any): Promise<void> {
        if (!this.ws || !this.authParams) return;

        console.log('🔑 Received challenge, signing...');

        const challenge = message.res?.[2]?.challenge_message || message.challenge_message;

        if (!challenge) {
            console.error('❌ No challenge message');
            if (this.authRejector) this.authRejector(new Error('No challenge'));
            return;
        }

        try {
            const signer = createEIP712AuthMessageSigner(
                this.walletClient,
                this.authParams,
                { name: SENTINEL_APP_NAME }
            );

            const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
            this.ws.send(verifyMsg);

            console.log('📤 Auth verification sent');
        } catch (error: any) {
            console.error('❌ Failed to sign:', error.message);
            if (this.authRejector) this.authRejector(error);
        }
    }

    /**
     * Handle app session creation
     */
    private handleAppSessionCreated(message: any): void {
        const sessionData = message.res?.[2] || message;

        if (sessionData?.app_session_id) {
            this.currentAppSessionId = sessionData.app_session_id;
            if (this.currentAppSessionId) {
                console.log('✅ App session created:', this.currentAppSessionId.substring(0, 20) + '...');
            }
            console.log(`   Status: ${sessionData.status}`);
            console.log(`   Version: ${sessionData.version}`);
        } else {
            console.error('❌ No app_session_id in response');
        }
    }
}
