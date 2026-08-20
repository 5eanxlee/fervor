import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import {
    projectReplayParticipants,
    replayParticipantsContract,
} from '../src/services/replay/participants';
import type { ReplaySnapshot } from '../src/services/replay/coordinator';
import { replayMint, replayQuoteMint, replaySha } from './helpers/replayTape';

const makerA = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const makerB = 'So11111111111111111111111111111111111111112';
const at = (second: number): string => `2024-11-19T00:00:0${second}.000Z`;
const supply = { fixed: true, rawAmount: '1000', decimals: 0 } as const;

const trade = (
    index: number,
    maker: string,
    side: 'buy' | 'sell',
    tokenRaw: string,
    usd: number,
    sol: number
): NormalizedTradeEvent => ({
    kind: 'trade',
    source: 'old_faithful',
    sourceEventId: `source:${index}`,
    idempotencyKey: index.toString(16).padStart(64, '0'),
    tokenMint: replayMint,
    quoteMint: replayQuoteMint,
    maker,
    side,
    tokenAmountRaw: tokenRaw,
    quoteAmountRaw: String(sol * 1_000_000_000),
    tokenDecimals: 0,
    quoteDecimals: 9,
    usdAmount: usd,
    solAmount: sol,
    supply: supply as NormalizedTradeEvent['supply'],
    slot: index + 1,
    signature: String(index + 1).repeat(88),
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: at(index + 1),
    confidence: 1,
    stale: false,
    commitment: 'finalized',
});

const trades = [
    trade(0, makerA, 'buy', '100', 20, 1),
    trade(1, makerA, 'sell', '40', 12, 0.5),
    trade(2, makerB, 'buy', '200', 50, 2),
];

const snapshot: ReplaySnapshot = {
    runId: 'participant-run',
    epoch: 2,
    sourceReplaySha256: replaySha,
    cursor: trades.length,
    total: trades.length,
    status: 'paused',
    now: at(3),
};

describe('replay participants', () => {
    it('projects exact holder balances and trader flow at an explicit cursor', () => {
        const view = projectReplayParticipants(snapshot, trades);
        expect(view).toMatchObject({
            contract: replayParticipantsContract,
            epoch: 2,
            cutCursor: 3,
            traderCount: 2,
            holderCount: 2,
            top10Percent: 26,
            coverage: {
                source: 'verified_trade_tape',
                scope: 'observed_trade_balance',
                tradeCount: 3,
                pricedTradeCount: 3,
                priceCoverageBps: 10_000,
                openingBalanceKnown: false,
                transfersIncluded: false,
            },
        });
        expect(view.items).toEqual([
            expect.objectContaining({
                wallet: makerA,
                boughtRaw: '100',
                soldRaw: '40',
                balanceRaw: '60',
                boughtUsd: 20,
                soldUsd: 12,
                tradeCount: 2,
            }),
            expect.objectContaining({
                wallet: makerB,
                balanceRaw: '200',
                boughtSol: 2,
                tradeCount: 1,
            }),
        ]);

        const prefix = projectReplayParticipants(snapshot, trades, 2);
        expect(prefix).toMatchObject({
            cutCursor: 2,
            cutAt: at(2),
            traderCount: 1,
            holderCount: 1,
            top10Percent: 6,
        });
    });

    it('rejects cuts outside the currently verified replay prefix', () => {
        expect(() => projectReplayParticipants(snapshot, trades, 4))
            .toThrow('cut is invalid');
    });
});
