import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import type { ReplayEvent, ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    paperModelContract,
    ReplayPaperBroker,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import { replayMint, replaySha } from './helpers/replayTape';

const quoteMint = 'So11111111111111111111111111111111111111112';
const otherMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const startMs = Date.UTC(2024, 10, 19, 0, 0, 0);

const snapshot = (value: Partial<ReplaySnapshot> = {}): ReplaySnapshot => ({
    runId: 'paper-a',
    epoch: 1,
    sourceReplaySha256: replaySha,
    cursor: 0,
    total: 20,
    status: 'paused',
    now: null,
    ...value,
});

const model = (value: Partial<PaperModelInput> = {}): PaperModelInput => ({
    contract: paperModelContract,
    latency: { clientMs: 0, buildMs: 0, submitMs: 0 },
    participationBps: 10_000,
    maxLookaheadMs: 10_000,
    priceGuardBps: 500,
    protocolFeeBps: 0,
    fixedFees: [],
    partialFill: 'allow',
    ...value,
});

const tradeEvent = (
    cursor: number,
    offsetMs: number,
    side: 'buy' | 'sell',
    tokenRaw: string,
    quoteRaw: string,
    value: Partial<NormalizedTradeEvent> = {}
): ReplayEvent => {
    const observedAt = new Date(startMs + offsetMs).toISOString();
    const trade: NormalizedTradeEvent = {
        kind: 'trade',
        source: 'old_faithful',
        sourceEventId: `source:${cursor}`,
        idempotencyKey: (cursor + 1).toString(16).padStart(64, '0'),
        tokenMint: replayMint,
        quoteMint,
        side,
        tokenAmountRaw: tokenRaw,
        quoteAmountRaw: quoteRaw,
        tokenDecimals: 6,
        quoteDecimals: 9,
        slot: 100 + cursor,
        txIndex: 0,
        instructionIndex: 0,
        eventIndex: 0,
        observedAt,
        receivedAt: observedAt,
        confidence: 1,
        stale: false,
        ...value,
    };
    return {
        runId: 'paper-a',
        epoch: 1,
        sourceReplaySha256: replaySha,
        cursor,
        usdPriced: false,
        trade,
    };
};

const marketBuy = (id: string, inputRaw = '100') => ({
    id,
    kind: 'market' as const,
    side: 'buy' as const,
    tokenMint: replayMint,
    quoteMint,
    inputRaw,
    reference: { quoteRaw: '1', tokenRaw: '1' },
});

describe('replay paper broker', () => {
    it('uses only later, eligible, opposite-side trades from the exact pair', () => {
        const broker = new ReplayPaperBroker(snapshot(), model({
            latency: { clientMs: 40, buildMs: 30, submitMs: 30 },
            priceGuardBps: 0,
        }));
        broker.place(marketBuy('later-only'));

        expect(broker.apply(tradeEvent(0, 0, 'sell', '100', '100'))).toEqual([]);
        expect(broker.apply(tradeEvent(1, 99, 'sell', '100', '100'))).toEqual([]);
        expect(broker.apply(tradeEvent(2, 100, 'sell', '100', '100', {
            quoteMint: otherMint,
        })).map((fact) => fact.kind)).toEqual(['eligible']);
        expect(broker.apply(tradeEvent(3, 101, 'buy', '100', '100'))).toEqual([]);
        expect(broker.apply(tradeEvent(4, 102, 'sell', '100', '100'))
            .map((fact) => fact.kind)).toEqual(['fill', 'filled']);

        expect(broker.order('later-only')).toMatchObject({
            status: 'filled',
            placedCursor: 0,
            placedAt: null,
            eligibleAt: new Date(startMs + 100).toISOString(),
            filledInputRaw: '100',
            remainingRaw: '0',
            grossOutputRaw: '100',
            netOutputRaw: '100',
        });
        expect(broker.order('later-only').fills[0]).toMatchObject({ cursor: 4, inputRaw: '100' });
    });

    it('shares participation capacity and fills limit gaps at later tape prices', () => {
        const broker = new ReplayPaperBroker(snapshot(), model({ participationBps: 5_000 }));
        const limit = { quoteRaw: '1', tokenRaw: '2' };
        broker.place({
            id: 'too-tight', kind: 'limit', side: 'buy', tokenMint: replayMint,
            quoteMint, inputRaw: '100', limit: { quoteRaw: '2', tokenRaw: '5' },
        });
        broker.place({
            id: 'first', kind: 'limit', side: 'buy', tokenMint: replayMint,
            quoteMint, inputRaw: '100', limit,
        });
        broker.place({
            id: 'second', kind: 'limit', side: 'buy', tokenMint: replayMint,
            quoteMint, inputRaw: '100', limit,
        });

        broker.apply(tradeEvent(0, 0, 'sell', '600', '300'));
        expect(broker.order('first')).toMatchObject({
            status: 'filled', filledInputRaw: '100', grossOutputRaw: '200',
        });
        expect(broker.order('second')).toMatchObject({
            status: 'partially_filled', filledInputRaw: '50', remainingRaw: '50',
        });
        expect(broker.order('too-tight').filledInputRaw).toBe('0');
        broker.cancel('too-tight');

        broker.apply(tradeEvent(1, 1, 'sell', '400', '100'));
        const second = broker.order('second');
        expect(second).toMatchObject({
            status: 'filled',
            filledInputRaw: '100',
            grossOutputRaw: '300',
            remainingRaw: '0',
        });
        expect(second.fills.map((fill) => fill.price)).toEqual([
            { quoteRaw: '1', tokenRaw: '2' },
            { quoteRaw: '1', tokenRaw: '4' },
        ]);
        expect(broker.orders().reduce((sum, order) =>
            sum + BigInt(order.fills[0]?.inputRaw ?? '0'), 0n)).toBe(150n);
    });

    it('applies exact raw-unit rounding and records modeled fees separately', () => {
        const fees: PaperModelInput['fixedFees'] = [
            { kind: 'priority', mint: quoteMint, amountRaw: '100' },
            { kind: 'network', mint: quoteMint, amountRaw: '5000' },
        ];
        const config = model({ protocolFeeBps: 100, fixedFees: fees, priceGuardBps: 0 });
        const broker = new ReplayPaperBroker(snapshot(), config);
        const reordered = new ReplayPaperBroker(snapshot(), model({
            protocolFeeBps: 100,
            priceGuardBps: 0,
            fixedFees: [...fees].reverse(),
        }));
        expect(reordered.modelSha256()).toBe(broker.modelSha256());

        broker.place({
            ...marketBuy('fee-rounding', '101'),
            reference: { quoteRaw: '101', tokenRaw: '303' },
        });
        broker.apply(tradeEvent(0, 0, 'sell', '3', '2'));
        expect(broker.order('fee-rounding').filledInputRaw).toBe('0');
        broker.apply(tradeEvent(1, 1, 'sell', '303', '101'));

        const order = broker.order('fee-rounding');
        expect(order.price).toEqual({ quoteRaw: '1', tokenRaw: '3' });
        expect(order).toMatchObject({
            grossOutputRaw: '303',
            netOutputRaw: '299',
        });
        expect(order.fills[0].fees).toEqual([
            { kind: 'protocol', mint: replayMint, amountRaw: '4' },
            { kind: 'network', mint: quoteMint, amountRaw: '5000' },
            { kind: 'priority', mint: quoteMint, amountRaw: '100' },
        ]);
    });

    it('expires at the exact boundary and makes same-cursor cancellation win', () => {
        const broker = new ReplayPaperBroker(snapshot(), model({
            maxLookaheadMs: 100,
            priceGuardBps: 0,
        }));
        broker.place(marketBuy('expires'));
        broker.apply(tradeEvent(0, 0, 'buy', '100', '100'));
        expect(broker.order('expires').status).toBe('eligible');

        expect(broker.apply(tradeEvent(1, 100, 'sell', '100', '100'))
            .map((fact) => [fact.kind, fact.reason])).toEqual([
            ['expired', 'lookahead_elapsed'],
        ]);
        expect(broker.order('expires')).toMatchObject({
            status: 'expired', filledInputRaw: '0', remainingRaw: '100',
        });
        expect(broker.apply(tradeEvent(2, 101, 'sell', '1000000', '1'))).toEqual([]);

        broker.place(marketBuy('cancel-wins'));
        expect(broker.cancel('cancel-wins')).toMatchObject({
            status: 'cancelled', placedCursor: 3,
        });
        expect(broker.apply(tradeEvent(3, 102, 'sell', '100', '100'))).toEqual([]);
        expect(broker.order('cancel-wins').filledInputRaw).toBe('0');
        expect(broker.facts().find((fact) => fact.kind === 'cancelled')).toMatchObject({
            cursor: 3,
            reason: 'user',
        });
    });

    it('fills sell limits only from later buys at or above the limit', () => {
        const broker = new ReplayPaperBroker(snapshot(), model());
        broker.place({
            id: 'sell-limit',
            kind: 'limit',
            side: 'sell',
            tokenMint: replayMint,
            quoteMint,
            inputRaw: '3',
            limit: { quoteRaw: '2', tokenRaw: '3' },
        });
        broker.apply(tradeEvent(0, 0, 'sell', '10', '7'));
        expect(broker.order('sell-limit').filledInputRaw).toBe('0');
        broker.apply(tradeEvent(1, 1, 'buy', '10', '6'));
        expect(broker.order('sell-limit').filledInputRaw).toBe('0');
        broker.apply(tradeEvent(2, 2, 'buy', '10', '7'));
        expect(broker.order('sell-limit')).toMatchObject({
            status: 'filled',
            filledInputRaw: '3',
            grossOutputRaw: '2',
            netOutputRaw: '2',
        });
    });
});
