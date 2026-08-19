import { createHash } from 'node:crypto';
import type { NormalizedTradeEvent } from '../../types';
import { addressSchema } from '../../types/execution';
import type { ReplaySnapshot } from './coordinator';

export const replayWalletTradeContract = 'fervor-replay-wallet-trade-v1' as const;
export const replayWalletPageContract = 'fervor-replay-wallet-page-v1' as const;

export interface ReplayWalletTrade {
    readonly contract: typeof replayWalletTradeContract;
    readonly activityKey: string;
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly tradeId: string;
    readonly sourceEventId: string;
    readonly wallet: string;
    readonly side: 'buy' | 'sell';
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly tokenAmountRaw: string;
    readonly quoteAmountRaw: string;
    readonly tokenDeltaRaw: string;
    readonly quoteDeltaRaw: string;
    readonly tokenDecimals: number;
    readonly quoteDecimals: number;
    readonly protocol: string;
    readonly signature: string;
    readonly slot: number;
    readonly txIndex: number;
    readonly instructionIndex: number;
    readonly eventIndex: number;
    readonly observedAt: string;
    readonly commitment: 'processed' | 'confirmed' | 'finalized';
}

export interface ReplayWalletPage {
    readonly contract: typeof replayWalletPageContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly wallet: string;
    readonly afterCursor: number;
    readonly nextCursor: number;
    readonly cutCursor: number;
    readonly windowStart: string | null;
    readonly windowEnd: string | null;
    readonly cutAt: string | null;
    readonly coverage: {
        readonly source: 'verified_trade_tape';
        readonly scope: 'trade_only';
        readonly history: 'selected_window';
        readonly historyComplete: false;
        readonly balanceComplete: false;
        readonly feeComplete: false;
    };
    readonly items: readonly ReplayWalletTrade[];
}

const signed = (value: string, positive: boolean): string => positive ? value : `-${value}`;

const activityKey = (sourceSha: string, wallet: string, tradeId: string): string =>
    createHash('sha256')
        .update(replayWalletTradeContract)
        .update('\0')
        .update(sourceSha)
        .update('\0')
        .update(wallet)
        .update('\0')
        .update(tradeId)
        .digest('hex');

const activity = (
    sourceSha: string,
    cursor: number,
    trade: NormalizedTradeEvent
): ReplayWalletTrade => {
    const side = trade.side!;
    const tokenRaw = trade.tokenAmountRaw!;
    const quoteRaw = trade.quoteAmountRaw!;
    return Object.freeze({
        contract: replayWalletTradeContract,
        activityKey: activityKey(sourceSha, trade.maker!, trade.idempotencyKey),
        sourceReplaySha256: sourceSha,
        cursor,
        tradeId: trade.idempotencyKey,
        sourceEventId: trade.sourceEventId,
        wallet: trade.maker!,
        side,
        tokenMint: trade.tokenMint,
        quoteMint: trade.quoteMint!,
        tokenAmountRaw: tokenRaw,
        quoteAmountRaw: quoteRaw,
        tokenDeltaRaw: signed(tokenRaw, side === 'buy'),
        quoteDeltaRaw: signed(quoteRaw, side === 'sell'),
        tokenDecimals: trade.tokenDecimals!,
        quoteDecimals: trade.quoteDecimals!,
        protocol: trade.protocol!,
        signature: trade.signature!,
        slot: trade.slot!,
        txIndex: trade.txIndex!,
        instructionIndex: trade.instructionIndex!,
        eventIndex: trade.eventIndex!,
        observedAt: trade.observedAt,
        commitment: trade.commitment!,
    });
};

export const replayWalletPage = (
    snapshot: ReplaySnapshot,
    trades: readonly NormalizedTradeEvent[],
    walletValue: unknown,
    afterCursor = 0,
    limit = 100
): ReplayWalletPage => {
    const wallet = addressSchema.parse(walletValue);
    if (!Number.isSafeInteger(afterCursor)
        || !Number.isSafeInteger(limit)
        || afterCursor < 0
        || afterCursor > snapshot.cursor
        || limit < 1
        || limit > 500
        || snapshot.cursor > trades.length) {
        throw new Error('Replay wallet page is invalid');
    }
    const items: ReplayWalletTrade[] = [];
    let nextCursor = snapshot.cursor;
    for (let cursor = afterCursor; cursor < snapshot.cursor; cursor += 1) {
        const trade = trades[cursor];
        if (trade.maker !== wallet) continue;
        items.push(activity(snapshot.sourceReplaySha256, cursor, trade));
        if (items.length === limit) {
            nextCursor = cursor + 1;
            break;
        }
    }
    return Object.freeze({
        contract: replayWalletPageContract,
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        wallet,
        afterCursor,
        nextCursor,
        cutCursor: snapshot.cursor,
        windowStart: trades[0]?.observedAt ?? null,
        windowEnd: trades.at(-1)?.observedAt ?? null,
        cutAt: snapshot.now,
        coverage: Object.freeze({
            source: 'verified_trade_tape',
            scope: 'trade_only',
            history: 'selected_window',
            historyComplete: false,
            balanceComplete: false,
            feeComplete: false,
        }),
        items: Object.freeze(items),
    });
};
