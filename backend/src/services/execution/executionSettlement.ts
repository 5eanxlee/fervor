import { U64_MAX, safeSlot, u64Text } from '../../types';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export type SettlementCommitment = 'confirmed' | 'finalized';
export type SettlementStatus = 'verified' | 'mismatch' | 'unsupported';

export interface SettlementInput {
    signature: string;
    wallet: string;
    feePayer: string;
    inputMint: string;
    outputMint: string;
    expectedInput: string;
    minOutput: string;
    providerInput?: string;
    providerOutput?: string;
    commitment: SettlementCommitment;
}

export interface ChainSettlement {
    commitment: SettlementCommitment;
    slot: number;
    status: SettlementStatus;
    inputAmount?: string;
    outputAmount?: string;
    feeLamports: string;
    payloadHash: string;
    reason?: string;
}

type JsonMap = Record<string, unknown>;

const asMap = (value: unknown): JsonMap | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonMap
        : undefined;

const exactFee = (value: unknown): string | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : undefined;

const exactLamports = (value: unknown): bigint | undefined => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
    return BigInt(value);
};

const accountKey = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    const key = asMap(value)?.pubkey;
    return typeof key === 'string' ? key : undefined;
};

const accountIndex = (value: unknown, length: number): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < length
        ? value
        : undefined;

const addU64 = (left: bigint, value: unknown): bigint => {
    const exact = u64Text(value);
    if (exact === undefined) throw new Error('Solana transaction contains an invalid token amount');
    const sum = left + BigInt(exact);
    if (sum > BigInt(U64_MAX)) throw new Error('Solana transaction token totals exceed u64');
    return sum;
};

const tokenTotal = (
    balances: unknown,
    wallet: string,
    mint: string
): { amount: bigint; found: boolean } => {
    if (!Array.isArray(balances)) throw new Error('Solana transaction omitted token balances');
    let amount = 0n;
    let found = false;
    const seen = new Set<number>();
    for (const raw of balances) {
        const balance = asMap(raw);
        if (!balance || balance.owner !== wallet || balance.mint !== mint) continue;
        const index = accountIndex(balance.accountIndex, 256);
        if (index === undefined || seen.has(index)) {
            throw new Error('Solana transaction contains an invalid token account index');
        }
        seen.add(index);
        const token = asMap(balance.uiTokenAmount);
        if (!token) throw new Error('Solana transaction contains an invalid token balance');
        amount = addU64(amount, token.amount);
        found = true;
    }
    return { amount, found };
};

const nativeDelta = (
    meta: JsonMap,
    wire: JsonMap,
    wallet: string,
    feePayer: string,
    feeLamports: string
): bigint => {
    const message = asMap(wire.message);
    const rawKeys = message?.accountKeys;
    const preBalances = meta.preBalances;
    const postBalances = meta.postBalances;
    if (!Array.isArray(rawKeys) || !Array.isArray(preBalances) || !Array.isArray(postBalances)
        || rawKeys.length !== preBalances.length || rawKeys.length !== postBalances.length) {
        throw new Error('Solana transaction omitted aligned native balance evidence');
    }

    const keys = rawKeys.map(accountKey);
    if (keys.some((key) => key === undefined) || new Set(keys).size !== keys.length
        || keys[0] !== feePayer) {
        throw new Error('Solana transaction contains invalid account key evidence');
    }
    const walletIndex = keys.indexOf(wallet);
    if (walletIndex < 0) throw new Error('Solana transaction omits the execution wallet');

    const indices = new Set<number>([walletIndex]);
    for (const balances of [meta.preTokenBalances, meta.postTokenBalances]) {
        if (!Array.isArray(balances)) throw new Error('Solana transaction omitted token balances');
        for (const raw of balances) {
            const balance = asMap(raw);
            if (!balance || balance.owner !== wallet) continue;
            const index = accountIndex(balance.accountIndex, keys.length);
            if (index === undefined) {
                throw new Error('Solana transaction contains an invalid token account index');
            }
            if (feePayer !== wallet && balance.mint !== WRAPPED_SOL_MINT) continue;
            indices.add(index);
        }
    }

    if (Array.isArray(meta.rewards)) {
        const owned = new Set([...indices].map((index) => keys[index]));
        for (const raw of meta.rewards) {
            const reward = asMap(raw);
            if (reward && owned.has(reward.pubkey as string) && reward.lamports !== 0) {
                throw new Error('Solana transaction native balance evidence includes a reward');
            }
        }
    }

    let pre = 0n;
    let post = 0n;
    for (const index of indices) {
        const before = exactLamports(preBalances[index]);
        const after = exactLamports(postBalances[index]);
        if (before === undefined || after === undefined) {
            throw new Error('Solana transaction contains an unsafe native balance');
        }
        pre += before;
        post += after;
    }
    return post - pre + (feePayer === wallet ? BigInt(feeLamports) : 0n);
};

const checkedAmount = (value: unknown, field: string): string => {
    const amount = u64Text(value);
    if (amount === undefined) throw new Error(`Execution contains an invalid ${field}`);
    return amount;
};

export const decodeSettlement = (
    input: SettlementInput,
    value: unknown,
    payloadHash: string
): ChainSettlement => {
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('Settlement payload hash is invalid');
    const expectedInput = checkedAmount(input.expectedInput, 'expected input amount');
    const minOutput = checkedAmount(input.minOutput, 'minimum output amount');
    const providerPair = input.providerInput !== undefined || input.providerOutput !== undefined;
    if (providerPair && (input.providerInput === undefined || input.providerOutput === undefined)) {
        throw new Error('Execution contains a partial provider amount pair');
    }
    const providerInput = input.providerInput === undefined
        ? undefined
        : checkedAmount(input.providerInput, 'provider input amount');
    const providerOutput = input.providerOutput === undefined
        ? undefined
        : checkedAmount(input.providerOutput, 'provider output amount');

    const transaction = asMap(value);
    const slot = safeSlot(transaction?.slot);
    const meta = asMap(transaction?.meta);
    const wire = asMap(transaction?.transaction);
    const signatures = wire?.signatures;
    const feeLamports = exactFee(meta?.fee);
    if (slot === undefined || !meta || !wire || meta.err !== null || feeLamports === undefined
        || !Array.isArray(signatures) || signatures[0] !== input.signature) {
        throw new Error('Solana transaction does not match a successful execution');
    }

    if (input.inputMint === input.outputMint) {
        throw new Error('Execution input and output mints must differ');
    }

    const native = input.inputMint === WRAPPED_SOL_MINT || input.outputMint === WRAPPED_SOL_MINT
        ? nativeDelta(meta, wire, input.wallet, input.feePayer, feeLamports)
        : undefined;
    const tokenDelta = (mint: string, direction: 'input' | 'output'): bigint => {
        const pre = tokenTotal(meta.preTokenBalances, input.wallet, mint);
        const post = tokenTotal(meta.postTokenBalances, input.wallet, mint);
        if (!(pre.found || post.found)) {
            throw new Error('Solana transaction lacks wallet balance evidence for the swap mints');
        }
        if (direction === 'input' && pre.amount > post.amount) return pre.amount - post.amount;
        if (direction === 'output' && post.amount > pre.amount) return post.amount - pre.amount;
        throw new Error('Solana transaction balance directions do not prove the swap');
    };
    const inputAmount = (input.inputMint === WRAPPED_SOL_MINT
        ? native !== undefined && native < 0n ? -native : undefined
        : tokenDelta(input.inputMint, 'input'));
    const outputAmount = (input.outputMint === WRAPPED_SOL_MINT
        ? native !== undefined && native > 0n ? native : undefined
        : tokenDelta(input.outputMint, 'output'));
    if (inputAmount === undefined || outputAmount === undefined
        || inputAmount > BigInt(U64_MAX) || outputAmount > BigInt(U64_MAX)) {
        throw new Error('Solana transaction balance directions do not prove the swap');
    }
    const inputText = inputAmount.toString();
    const outputText = outputAmount.toString();
    const reasons: string[] = [];
    if (inputText !== expectedInput) reasons.push('input_expected_mismatch');
    if (outputAmount < BigInt(minOutput)) reasons.push('output_below_minimum');
    if (providerInput !== undefined && inputText !== providerInput) reasons.push('provider_input_mismatch');
    if (providerOutput !== undefined && outputText !== providerOutput) reasons.push('provider_output_mismatch');

    return {
        commitment: input.commitment,
        slot,
        status: reasons.length ? 'mismatch' : 'verified',
        inputAmount: inputText,
        outputAmount: outputText,
        feeLamports,
        payloadHash,
        ...(reasons.length ? { reason: reasons.join(',') } : {}),
    };
};
