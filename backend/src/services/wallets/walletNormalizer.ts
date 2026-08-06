import { safeSlot, u64Text } from '../../types';

type Row = Record<string, unknown>;

export interface NormalizedWalletActivity {
    idempotencyKey: string;
    kind: 'swap' | 'transfer_in' | 'transfer_out';
    tokenMint: string;
    tokenDecimals: number;
    side: 'buy' | 'sell';
    quantityBase: string;
    valueMicroUsd?: string;
    signature: string;
    slot?: number;
    txIndex?: number;
    eventIndex: number;
    commitment?: 'confirmed' | 'finalized';
    occurredAt: string;
    summary: Record<string, unknown>;
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const map = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : {};
const text = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
const integer = (value: unknown): number | undefined => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};
const rawAmount = (value: unknown): string | undefined => {
    const exact = u64Text(value);
    return exact === '0' ? undefined : exact;
};

interface BalanceDelta {
    mint: string;
    decimals: number;
    delta: bigint;
}

const occurredAt = (seconds: unknown): string | undefined => {
    const value = Number(seconds);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return new Date(value * 1000).toISOString();
};

const activitiesFromDeltas = (input: {
    deltas: BalanceDelta[];
    signature: string;
    slot?: number;
    txIndex?: number;
    occurredAt: string;
    commitment?: 'confirmed' | 'finalized';
    summary: Record<string, unknown>;
    swapHint: boolean;
}): NormalizedWalletActivity[] => {
    const combined = new Map<string, BalanceDelta>();
    for (const delta of input.deltas) {
        const current = combined.get(delta.mint);
        if (current && current.decimals !== delta.decimals) continue;
        combined.set(delta.mint, {
            mint: delta.mint,
            decimals: delta.decimals,
            delta: (current?.delta || 0n) + delta.delta,
        });
    }
    const assets = Array.from(combined.values())
        .filter((delta) => delta.delta !== 0n)
        .sort((left, right) => left.mint.localeCompare(right.mint));
    const usdc = assets.find((delta) => delta.mint === USDC_MINT)?.delta || 0n;
    const tokens = assets
        .filter((delta) => delta.mint !== USDC_MINT && delta.delta !== 0n)
        .sort((left, right) => left.mint.localeCompare(right.mint));
    const priced = tokens.length === 1 && usdc !== 0n && (tokens[0].delta > 0n) !== (usdc > 0n);
    return assets.map((delta, eventIndex) => {
        const side = delta.delta > 0n ? 'buy' as const : 'sell' as const;
        const quantityBase = (delta.delta < 0n ? -delta.delta : delta.delta).toString();
        const isUsdc = delta.mint === USDC_MINT;
        return {
            idempotencyKey: `${input.signature}:${delta.mint}:${side}`,
            kind: priced || input.swapHint ? 'swap' : side === 'buy' ? 'transfer_in' : 'transfer_out',
            tokenMint: delta.mint,
            tokenDecimals: delta.decimals,
            side,
            quantityBase,
            valueMicroUsd: isUsdc
                ? quantityBase
                : priced ? (usdc < 0n ? -usdc : usdc).toString() : undefined,
            signature: input.signature,
            slot: input.slot,
            txIndex: input.txIndex,
            eventIndex,
            commitment: input.commitment,
            occurredAt: input.occurredAt,
            summary: input.summary,
        };
    });
};

const normalizeEnhanced = (walletAddress: string, tx: Row): NormalizedWalletActivity[] => {
    const signature = text(tx.signature);
    const at = occurredAt(tx.timestamp);
    if (!signature || !at) return [];
    const balances = new Map<string, { decimals: number; delta: bigint }>();
    const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers.map(map) : [];
    for (const transfer of transfers) {
        const mint = text(transfer.mint);
        const raw = map(transfer.rawTokenAmount);
        const amount = rawAmount(raw.tokenAmount);
        const decimals = integer(raw.decimals);
        if (!mint || !amount || decimals === undefined || decimals > 255) continue;
        const incoming = transfer.toUserAccount === walletAddress;
        const outgoing = transfer.fromUserAccount === walletAddress;
        if (incoming === outgoing) continue;
        const current = balances.get(mint) || { decimals, delta: 0n };
        if (current.decimals !== decimals) continue;
        current.delta += incoming ? BigInt(amount) : -BigInt(amount);
        balances.set(mint, current);
    }
    const nativeTransfers = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers.map(map) : [];
    for (const transfer of nativeTransfers) {
        const amount = rawAmount(transfer.amount);
        if (!amount) continue;
        const incoming = transfer.toUserAccount === walletAddress;
        const outgoing = transfer.fromUserAccount === walletAddress;
        if (incoming === outgoing) continue;
        const current = balances.get(SOL_MINT) || { decimals: 9, delta: 0n };
        current.delta += incoming ? BigInt(amount) : -BigInt(amount);
        balances.set(SOL_MINT, current);
    }
    return activitiesFromDeltas({
        deltas: Array.from(balances, ([mint, balance]) => ({ mint, ...balance })),
        signature,
        slot: safeSlot(tx.slot),
        txIndex: integer(tx.transactionIndex),
        occurredAt: at,
        commitment: tx.confirmationStatus === 'confirmed' ? 'confirmed' : 'finalized',
        swapHint: String(tx.type || '').toUpperCase() === 'SWAP',
        summary: {
            type: text(tx.type),
            source: text(tx.source),
            description: text(tx.description)?.slice(0, 240),
        },
    });
};

const tokenBalances = (value: unknown, walletAddress: string): Map<string, { amount: bigint; decimals: number }> => {
    const balances = new Map<string, { amount: bigint; decimals: number }>();
    if (!Array.isArray(value)) return balances;
    for (const item of value.map(map)) {
        if (item.owner !== walletAddress) continue;
        const mint = text(item.mint);
        const ui = map(item.uiTokenAmount);
        const amount = rawAmount(ui.amount) || (u64Text(ui.amount) === '0' ? '0' : undefined);
        const decimals = integer(ui.decimals);
        if (!mint || amount === undefined || decimals === undefined || decimals > 255) continue;
        const current = balances.get(mint) || { amount: 0n, decimals };
        if (current.decimals !== decimals) continue;
        current.amount += BigInt(amount);
        balances.set(mint, current);
    }
    return balances;
};

const normalizeFull = (walletAddress: string, tx: Row): NormalizedWalletActivity[] => {
    const transaction = map(tx.transaction);
    const signatures = Array.isArray(transaction.signatures) ? transaction.signatures : [];
    const signature = text(signatures[0]);
    const at = occurredAt(tx.blockTime);
    const meta = map(tx.meta);
    if (!signature || !at || meta.err) return [];
    const pre = tokenBalances(meta.preTokenBalances, walletAddress);
    const post = tokenBalances(meta.postTokenBalances, walletAddress);
    const mints = new Set([...pre.keys(), ...post.keys()]);
    const deltas: BalanceDelta[] = [];
    for (const mint of mints) {
        const before = pre.get(mint);
        const after = post.get(mint);
        const decimals = after?.decimals ?? before?.decimals;
        if (decimals === undefined || (before && after && before.decimals !== after.decimals)) continue;
        const delta = (after?.amount || 0n) - (before?.amount || 0n);
        if (delta !== 0n) deltas.push({ mint, decimals, delta });
    }
    const message = map(transaction.message);
    const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
    const walletIndex = keys.findIndex((key) => {
        const value = map(key);
        return (typeof key === 'string' ? key : text(value.pubkey)) === walletAddress;
    });
    const preBalances = Array.isArray(meta.preBalances) ? meta.preBalances : [];
    const postBalances = Array.isArray(meta.postBalances) ? meta.postBalances : [];
    if (walletIndex >= 0) {
        const before = u64Text(preBalances[walletIndex]);
        const after = u64Text(postBalances[walletIndex]);
        if (before !== undefined && after !== undefined) {
            const delta = BigInt(after) - BigInt(before);
            if (delta !== 0n) deltas.push({ mint: SOL_MINT, decimals: 9, delta });
        }
    }
    return activitiesFromDeltas({
        deltas,
        signature,
        slot: safeSlot(tx.slot),
        txIndex: integer(tx.transactionIndex),
        occurredAt: at,
        commitment: 'finalized',
        swapHint: false,
        summary: { source: 'helius_get_transactions_for_address', parser: 'token-balance-delta-v1' },
    });
};

export const normalizeWalletActivity = (
    walletAddress: string,
    value: unknown
): NormalizedWalletActivity[] => {
    const tx = map(value);
    return tx.transaction && tx.meta
        ? normalizeFull(walletAddress, tx)
        : normalizeEnhanced(walletAddress, tx);
};
