import type { NormalizedTradeEvent } from '../../types';
import type { ReplaySnapshot } from './coordinator';

export const replayParticipantsContract = 'fervor-replay-participants-v1' as const;

export interface ReplayParticipant {
    readonly wallet: string;
    readonly boughtRaw: string;
    readonly soldRaw: string;
    readonly balanceRaw: string;
    readonly pricedBuyRaw: string;
    readonly boughtUsd: number;
    readonly soldUsd: number;
    readonly boughtSol: number;
    readonly soldSol: number;
    readonly tradeCount: number;
    readonly buyCount: number;
    readonly sellCount: number;
    readonly pricedTradeCount: number;
    readonly firstTradeAt: string;
    readonly lastTradeAt: string;
}

export interface ReplayParticipants {
    readonly contract: typeof replayParticipantsContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly cutCursor: number;
    readonly cutAt: string | null;
    readonly tokenMint: string;
    readonly tokenDecimals: number;
    readonly supplyRaw: string;
    readonly traderCount: number;
    readonly holderCount: number;
    readonly top10Percent: number;
    readonly coverage: {
        readonly source: 'verified_trade_tape';
        readonly scope: 'observed_trade_balance';
        readonly openingBalanceKnown: false;
        readonly transfersIncluded: false;
        readonly tradeCount: number;
        readonly pricedTradeCount: number;
        readonly priceCoverageBps: number;
    };
    readonly items: readonly ReplayParticipant[];
}

interface MutableParticipant {
    wallet: string;
    bought: bigint;
    sold: bigint;
    pricedBuy: bigint;
    boughtUsd: number;
    soldUsd: number;
    boughtSol: number;
    soldSol: number;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    pricedTradeCount: number;
    firstTradeAt: string;
    lastTradeAt: string;
}

const positive = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

const coverageBps = (priced: number, total: number): number =>
    total === 0 ? 0 : Math.floor(priced * 10_000 / total);

export const projectReplayParticipants = (
    snapshot: ReplaySnapshot,
    trades: readonly NormalizedTradeEvent[],
    cursor = snapshot.cursor
): ReplayParticipants => {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > snapshot.cursor
        || snapshot.cursor > trades.length) {
        throw new Error('Replay participant cut is invalid');
    }
    const supply = trades[0]?.supply;
    if (!supply?.fixed || !/^\d+$/.test(supply.rawAmount)) {
        throw new Error('Replay participant supply is unavailable');
    }
    const rows = new Map<string, MutableParticipant>();
    let pricedTradeCount = 0;

    for (let index = 0; index < cursor; index += 1) {
        const trade = trades[index];
        if (!trade.maker || !trade.side || !trade.tokenAmountRaw
            || !/^\d+$/.test(trade.tokenAmountRaw)) {
            throw new Error('Replay participant trade is incomplete');
        }
        const amount = BigInt(trade.tokenAmountRaw);
        const row = rows.get(trade.maker) ?? {
            wallet: trade.maker,
            bought: 0n,
            sold: 0n,
            pricedBuy: 0n,
            boughtUsd: 0,
            soldUsd: 0,
            boughtSol: 0,
            soldSol: 0,
            tradeCount: 0,
            buyCount: 0,
            sellCount: 0,
            pricedTradeCount: 0,
            firstTradeAt: trade.observedAt,
            lastTradeAt: trade.observedAt,
        };
        rows.set(trade.maker, row);
        row.tradeCount += 1;
        row.lastTradeAt = trade.observedAt;
        if (trade.usdAmount !== undefined) {
            row.pricedTradeCount += 1;
            pricedTradeCount += 1;
        }
        if (trade.side === 'buy') {
            row.buyCount += 1;
            row.bought += amount;
            row.boughtUsd += positive(trade.usdAmount);
            row.boughtSol += positive(trade.solAmount);
            if (trade.usdAmount !== undefined) row.pricedBuy += amount;
        } else {
            row.sellCount += 1;
            row.sold += amount;
            row.soldUsd += positive(trade.usdAmount);
            row.soldSol += positive(trade.solAmount);
        }
    }

    const items = [...rows.values()]
        .sort((left, right) => left.wallet.localeCompare(right.wallet))
        .map((row): ReplayParticipant => Object.freeze({
            wallet: row.wallet,
            boughtRaw: row.bought.toString(),
            soldRaw: row.sold.toString(),
            balanceRaw: (row.bought - row.sold).toString(),
            pricedBuyRaw: row.pricedBuy.toString(),
            boughtUsd: row.boughtUsd,
            soldUsd: row.soldUsd,
            boughtSol: row.boughtSol,
            soldSol: row.soldSol,
            tradeCount: row.tradeCount,
            buyCount: row.buyCount,
            sellCount: row.sellCount,
            pricedTradeCount: row.pricedTradeCount,
            firstTradeAt: row.firstTradeAt,
            lastTradeAt: row.lastTradeAt,
        }));
    const balances = items
        .map((row) => BigInt(row.balanceRaw))
        .filter((balance) => balance > 0n)
        .sort((left, right) => left === right ? 0 : left > right ? -1 : 1);
    const top10 = balances.slice(0, 10).reduce((sum, balance) => sum + balance, 0n);
    const supplyRaw = BigInt(supply.rawAmount);

    return Object.freeze({
        contract: replayParticipantsContract,
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        cutCursor: cursor,
        cutAt: cursor === 0 ? null : trades[cursor - 1].observedAt,
        tokenMint: trades[0].tokenMint,
        tokenDecimals: supply.decimals,
        supplyRaw: supply.rawAmount,
        traderCount: items.length,
        holderCount: balances.length,
        top10Percent: supplyRaw === 0n ? 0 : Number(top10 * 1_000_000n / supplyRaw) / 10_000,
        coverage: Object.freeze({
            source: 'verified_trade_tape',
            scope: 'observed_trade_balance',
            openingBalanceKnown: false,
            transfersIncluded: false,
            tradeCount: cursor,
            pricedTradeCount,
            priceCoverageBps: coverageBps(pricedTradeCount, cursor),
        }),
        items: Object.freeze(items),
    });
};
