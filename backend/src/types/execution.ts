import bs58 from 'bs58';
import { z } from 'zod';
import { amountSchema } from './amount';

export { amountSchema };

export const MAX_CUSTOM_FEE_LAMPORTS = 100_000_000;

export const addressSchema = z.string().trim().refine((value) => {
    try {
        return bs58.decode(value).length === 32;
    } catch {
        return false;
    }
}, 'Invalid Solana address');

export const signatureSchema = z.string().refine((value) => {
    try {
        return bs58.decode(value).length === 64;
    } catch {
        return false;
    }
}, 'Invalid Solana transaction signature');

export const quoteRequestSchema = z.object({
    inputMint: addressSchema,
    outputMint: addressSchema,
    inputAmount: amountSchema,
    taker: addressSchema,
    slippageBps: z.number().int().min(1).max(10000).optional(),
    priorityFeeLamports: z.number().int().min(1).max(MAX_CUSTOM_FEE_LAMPORTS).optional(),
    jitoTipLamports: z.number().int().min(1000).max(MAX_CUSTOM_FEE_LAMPORTS).optional(),
    broadcastFeeType: z.enum(['maxCap', 'exactFee']).optional(),
}).strict();

export const submitRequestSchema = z.object({
    signedTransaction: z.string().min(16),
    idempotencyKey: z.string().trim().min(16).max(128),
}).strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type SubmitRequest = z.infer<typeof submitRequestSchema>;
export type ExecutionProviderName = 'fixture' | 'jupiter_swap_v2';
export type ExecutionState =
    | 'requested'
    | 'quoted'
    | 'prepared'
    | 'signed'
    | 'submitted'
    | 'processed'
    | 'confirmed'
    | 'finalized'
    | 'failed'
    | 'expired'
    | 'replaced';

export interface SwapQuote {
    id: string;
    provider: ExecutionProviderName;
    providerQuoteId: string;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    outputAmount: string;
    minOutputAmount: string;
    taker: string;
    feePayer: string;
    slippageBps: number;
    priceImpactPct?: string;
    transaction: string;
    transactionDigest: string;
    integrityDigest: string;
    requiresSignature: boolean;
    createdAt: string;
    expiresAt: string;
    route: Array<{
        venue: string;
        percent: number;
    }>;
    fees: {
        networkLamports?: string;
        priorityLamports?: string;
        platformAmount?: string;
    };
}

export interface ProviderQuote {
    provider: ExecutionProviderName;
    providerQuoteId: string;
    inputAmount: string;
    outputAmount: string;
    minOutputAmount: string;
    taker: string;
    feePayer: string;
    slippageBps: number;
    priceImpactPct?: string;
    transaction: string;
    route: Array<{ venue: string; percent: number }>;
    fees: SwapQuote['fees'];
}

export interface SubmitResult {
    provider: ExecutionProviderName;
    state: Extract<ExecutionState, 'submitted' | 'confirmed' | 'failed'>;
    signature?: string;
    inputAmount?: string;
    outputAmount?: string;
    errorCode?: string;
    errorMessage?: string;
    rawStatus?: string;
}

export interface TradeExecution {
    id: string;
    quoteId: string;
    provider: ExecutionProviderName;
    walletAddress: string;
    state: ExecutionState;
    signature?: string;
    inputMint: string;
    outputMint: string;
    expectedInputAmount: string;
    expectedOutputAmount: string;
    providerInputAmount?: string;
    providerOutputAmount?: string;
    actualInputAmount?: string;
    actualOutputAmount?: string;
    settlementStatus: 'pending' | 'verified' | 'mismatch' | 'unsupported';
    settlementSlot?: string;
    settlementCommitment?: 'confirmed' | 'finalized';
    settlementFeeLamports?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ExecutionCapabilities {
    mode: 'disabled' | 'fixture' | 'live';
    provider: ExecutionProviderName | 'none';
    canQuote: boolean;
    canSubmit: boolean;
    clientSigning: true;
    managedLanding: true;
    maxSlippageBps: number;
    maxPriorityFeeLamports: number;
    maxJitoTipLamports: number;
    quoteTtlMs: number;
}
