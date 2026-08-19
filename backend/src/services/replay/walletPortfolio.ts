import { createHash } from 'node:crypto';
import type { NormalizedTradeEvent } from '../../types';
import { addressSchema } from '../../types/execution';
import type { ReplaySnapshot } from './coordinator';
import { FifoBasis } from './fifoBasis';
import { replayWalletCoverage } from './replayWallet';

export const walletPortfolioContract = 'fervor-replay-wallet-portfolio-v1' as const;

export interface WalletFlow {
    readonly mint: string;
    readonly netRaw: string;
}

export interface WalletPosition {
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly acquiredRaw: string;
    readonly soldRaw: string;
    readonly coveredSoldRaw: string;
    readonly unmatchedSoldRaw: string;
    readonly soldBasisCoverageBps: number;
    readonly openQuantityRaw: string;
    readonly openCostRaw: string;
    readonly realizedPnlRaw: string;
    readonly markPolicy: 'last_trade_ratio';
    readonly markCursor: number;
    readonly markTradeId: string;
    readonly markObservedAt: string;
    readonly markValueRaw: string;
    readonly unrealizedPnlRaw: string;
    readonly observedBasisComplete: boolean;
}

export interface WalletPortfolio {
    readonly contract: typeof walletPortfolioContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly wallet: string;
    readonly cutCursor: number;
    readonly windowStart: string | null;
    readonly windowEnd: string | null;
    readonly cutAt: string | null;
    readonly coverage: typeof replayWalletCoverage & {
        readonly basisPolicy: 'observed_fifo';
        readonly openingBalanceKnown: false;
        readonly transferComplete: false;
    };
    readonly tradeCount: number;
    readonly buyCount: number;
    readonly sellCount: number;
    readonly observedBasisComplete: boolean;
    readonly netFlows: readonly WalletFlow[];
    readonly positions: readonly WalletPosition[];
    readonly portfolioSha256: string;
}

interface MutablePosition {
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly basis: FifoBasis;
}

interface Mark {
    readonly cursor: number;
    readonly trade: NormalizedTradeEvent;
}

type PortfolioPayload = Omit<WalletPortfolio, 'portfolioSha256'>;

const pairKey = (trade: NormalizedTradeEvent): string =>
    `${trade.tokenMint}\0${trade.quoteMint!}`;

const add = (flows: Map<string, bigint>, mint: string, amount: bigint): void => {
    flows.set(mint, (flows.get(mint) ?? 0n) + amount);
};

const coverageBps = (covered: bigint, sold: bigint): number =>
    sold === 0n ? 10_000 : Number(covered * 10_000n / sold);

const digest = (payload: PortfolioPayload): string => {
    const stable = Object.fromEntries(Object.entries(payload)
        .filter(([key]) => key !== 'runId' && key !== 'epoch'));
    return createHash('sha256')
        .update(walletPortfolioContract)
        .update('\0')
        .update(JSON.stringify(stable))
        .digest('hex');
};

export const projectWalletPortfolio = (
    snapshot: ReplaySnapshot,
    trades: readonly NormalizedTradeEvent[],
    walletValue: unknown
): WalletPortfolio => {
    const wallet = addressSchema.parse(walletValue);
    if (snapshot.cursor > trades.length) throw new Error('Replay wallet cut is invalid');
    const flows = new Map<string, bigint>();
    const marks = new Map<string, Mark>();
    const positions = new Map<string, MutablePosition>();
    let tradeCount = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (let cursor = 0; cursor < snapshot.cursor; cursor += 1) {
        const trade = trades[cursor];
        const key = pairKey(trade);
        marks.set(key, { cursor, trade });
        if (trade.maker !== wallet) continue;
        const side = trade.side!;
        const token = BigInt(trade.tokenAmountRaw!);
        const quote = BigInt(trade.quoteAmountRaw!);
        const position = positions.get(key) ?? {
            tokenMint: trade.tokenMint,
            quoteMint: trade.quoteMint!,
            basis: new FifoBasis(),
        };
        positions.set(key, position);
        tradeCount += 1;
        if (side === 'buy') {
            buyCount += 1;
            add(flows, trade.tokenMint, token);
            add(flows, trade.quoteMint!, -quote);
            position.basis.buy(token, quote);
        } else {
            sellCount += 1;
            add(flows, trade.tokenMint, -token);
            add(flows, trade.quoteMint!, quote);
            position.basis.sell(token, quote);
        }
    }

    const netFlows = Object.freeze([...flows.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([mint, net]) => Object.freeze({ mint, netRaw: net.toString() })));
    const positionViews = Object.freeze([...positions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, position]) => {
            const basis = position.basis.state();
            const mark = marks.get(key)!;
            const markValue = basis.openQuantity * BigInt(mark.trade.quoteAmountRaw!)
                / BigInt(mark.trade.tokenAmountRaw!);
            return Object.freeze({
                tokenMint: position.tokenMint,
                quoteMint: position.quoteMint,
                acquiredRaw: basis.acquired.toString(),
                soldRaw: basis.sold.toString(),
                coveredSoldRaw: basis.coveredSold.toString(),
                unmatchedSoldRaw: basis.unmatchedSold.toString(),
                soldBasisCoverageBps: coverageBps(basis.coveredSold, basis.sold),
                openQuantityRaw: basis.openQuantity.toString(),
                openCostRaw: basis.openCost.toString(),
                realizedPnlRaw: basis.realized.toString(),
                markPolicy: 'last_trade_ratio' as const,
                markCursor: mark.cursor,
                markTradeId: mark.trade.idempotencyKey,
                markObservedAt: mark.trade.observedAt,
                markValueRaw: markValue.toString(),
                unrealizedPnlRaw: (markValue - basis.openCost).toString(),
                observedBasisComplete: basis.unmatchedSold === 0n,
            });
        }));
    const payload: PortfolioPayload = {
        contract: walletPortfolioContract,
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        wallet,
        cutCursor: snapshot.cursor,
        windowStart: trades[0]?.observedAt ?? null,
        windowEnd: trades.at(-1)?.observedAt ?? null,
        cutAt: snapshot.now,
        coverage: Object.freeze({
            ...replayWalletCoverage,
            basisPolicy: 'observed_fifo',
            openingBalanceKnown: false,
            transferComplete: false,
        }),
        tradeCount,
        buyCount,
        sellCount,
        observedBasisComplete: positionViews.every((position) => position.observedBasisComplete),
        netFlows,
        positions: positionViews,
    };
    return Object.freeze({ ...payload, portfolioSha256: digest(payload) });
};
