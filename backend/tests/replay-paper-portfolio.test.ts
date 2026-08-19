import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import type { ReplayEvent, ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    paperModelContract,
    ReplayPaperBroker,
    type PaperFact,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import {
    paperPortfolioContract,
    projectPaperPortfolio,
} from '../src/services/replay/paperPortfolio';
import { replayMint, replayQuoteMint, replaySha } from './helpers/replayTape';

const startMs = Date.UTC(2024, 10, 19);

const snapshot = (): ReplaySnapshot => ({
    runId: 'portfolio-a',
    epoch: 1,
    sourceReplaySha256: replaySha,
    cursor: 0,
    total: 10,
    status: 'paused',
    now: null,
});

const model = (fixed = true): PaperModelInput => ({
    contract: paperModelContract,
    latency: { clientMs: 0, buildMs: 0, submitMs: 0 },
    participationBps: 10_000,
    maxLookaheadMs: 60_000,
    priceGuardBps: 0,
    protocolFeeBps: 0,
    fixedFees: fixed ? [{
        kind: 'network',
        mint: replayQuoteMint,
        amountRaw: '5',
    }] : [],
    partialFill: 'allow',
});

const event = (
    cursor: number,
    side: 'buy' | 'sell',
    tokenAmountRaw: string,
    quoteAmountRaw: string
): ReplayEvent => {
    const observedAt = new Date(startMs + cursor * 1_000).toISOString();
    const trade: NormalizedTradeEvent = {
        kind: 'trade',
        source: 'old_faithful',
        sourceEventId: `source:${cursor}`,
        idempotencyKey: (cursor + 1).toString(16).padStart(64, '0'),
        tokenMint: replayMint,
        quoteMint: replayQuoteMint,
        side,
        tokenAmountRaw,
        quoteAmountRaw,
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
    };
    return {
        runId: 'portfolio-a',
        epoch: 1,
        sourceReplaySha256: replaySha,
        cursor,
        usdPriced: false,
        trade,
    };
};

const binding = (broker: ReplayPaperBroker) => ({
    sourceReplaySha256: replaySha,
    runId: 'portfolio-a',
    modelSha256: broker.modelSha256(),
});

describe('replay paper portfolio', () => {
    it('folds fill facts into deterministic flows, fees, and FIFO basis', () => {
        const broker = new ReplayPaperBroker(snapshot(), model());
        broker.place({
            id: 'buy',
            kind: 'market',
            side: 'buy',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '100',
            reference: { quoteRaw: '1', tokenRaw: '2' },
        });
        broker.apply(event(0, 'sell', '200', '100'));
        broker.place({
            id: 'buy-again',
            kind: 'market',
            side: 'buy',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '150',
            reference: { quoteRaw: '3', tokenRaw: '2' },
        });
        broker.apply(event(1, 'sell', '100', '150'));
        broker.place({
            id: 'sell',
            kind: 'market',
            side: 'sell',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '250',
            reference: { quoteRaw: '2', tokenRaw: '1' },
        });
        broker.apply(event(2, 'buy', '250', '500'));

        const portfolio = projectPaperPortfolio(binding(broker), broker.orders(), broker.facts());
        expect(portfolio).toMatchObject({
            contract: paperPortfolioContract,
            orderCount: 3,
            factCount: 12,
            fillCount: 3,
            basisComplete: true,
            netFlows: expect.arrayContaining([
                { mint: replayMint, netRaw: '50' },
                { mint: replayQuoteMint, netRaw: '235' },
            ]),
            feeTotals: [{ kind: 'network', mint: replayQuoteMint, amountRaw: '15' }],
            positions: [{
                tokenMint: replayMint,
                quoteMint: replayQuoteMint,
                openQuantityRaw: '50',
                openCostRaw: '75',
                realizedPnlRaw: '325',
                unmatchedSoldRaw: '0',
                basisComplete: true,
            }],
        });
        expect(Object.isFrozen(portfolio)).toBe(true);
        expect(projectPaperPortfolio(
            binding(broker),
            [...broker.orders()].reverse(),
            JSON.parse(JSON.stringify(broker.facts())) as PaperFact[]
        )).toEqual(portfolio);
    });

    it('labels sells without replay-local acquisition history as incomplete', () => {
        const broker = new ReplayPaperBroker(snapshot(), model(false));
        broker.place({
            id: 'untracked',
            kind: 'market',
            side: 'sell',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '20',
            reference: { quoteRaw: '2', tokenRaw: '1' },
        });
        broker.apply(event(0, 'buy', '20', '40'));

        const portfolio = projectPaperPortfolio(binding(broker), broker.orders(), broker.facts());
        expect(portfolio).toMatchObject({
            basisComplete: false,
            netFlows: expect.arrayContaining([
                { mint: replayMint, netRaw: '-20' },
                { mint: replayQuoteMint, netRaw: '40' },
            ]),
            positions: [{
                openQuantityRaw: '0',
                openCostRaw: '0',
                realizedPnlRaw: '0',
                unmatchedSoldRaw: '20',
                basisComplete: false,
            }],
        });
    });

    it('does not subtract an output-denominated protocol fee twice', () => {
        const broker = new ReplayPaperBroker(snapshot(), {
            ...model(false),
            protocolFeeBps: 100,
        });
        broker.place({
            id: 'protocol-fee',
            kind: 'market',
            side: 'buy',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '100',
            reference: { quoteRaw: '1', tokenRaw: '2' },
        });
        broker.apply(event(0, 'sell', '200', '100'));

        expect(projectPaperPortfolio(binding(broker), broker.orders(), broker.facts()))
            .toMatchObject({
                netFlows: expect.arrayContaining([
                    { mint: replayMint, netRaw: '198' },
                    { mint: replayQuoteMint, netRaw: '-100' },
                ]),
                feeTotals: [{ kind: 'protocol', mint: replayMint, amountRaw: '2' }],
                positions: [{ openQuantityRaw: '198', openCostRaw: '100' }],
            });
    });
});
