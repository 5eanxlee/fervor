import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import type { ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    replayWalletPage,
    replayWalletPageContract,
    replayWalletTradeContract,
} from '../src/services/replay/replayWallet';
import {
    projectWalletPortfolio,
    walletPortfolioContract,
} from '../src/services/replay/walletPortfolio';
import { replayMint, replayQuoteMint, replaySha, replayTape } from './helpers/replayTape';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';

const trades = (): NormalizedTradeEvent[] => replayTape(4).sourceTrades.map(
    (trade, cursor) => ({
        ...trade,
        maker: cursor % 2 === 0 ? wallet : replayMint,
        protocol: 'pump_fun',
        signature: String(cursor + 5).repeat(88),
        commitment: 'finalized',
    })
);

const snapshot = (epoch = 1): ReplaySnapshot => ({
    runId: 'wallet-a',
    epoch,
    sourceReplaySha256: replaySha,
    cursor: 4,
    total: 4,
    status: 'complete',
    now: '2024-11-19T00:00:30.000Z',
});

const portfolioTrades = (): NormalizedTradeEvent[] => {
    const source = trades();
    const makers = [wallet, replayMint, wallet, replayMint];
    const sides = ['buy', 'sell', 'sell', 'buy'] as const;
    const tokenRaw = ['100', '10', '40', '10'];
    const quoteRaw = ['200', '30', '120', '50'];
    return source.map((trade, cursor) => ({
        ...trade,
        maker: makers[cursor],
        side: sides[cursor],
        tokenAmountRaw: tokenRaw[cursor],
        quoteAmountRaw: quoteRaw[cursor],
    }));
};

describe('replay wallet activity', () => {
    it('pages exact maker trades with signed raw deltas and explicit coverage', () => {
        const source = trades();
        const first = replayWalletPage(snapshot(), source, wallet, 0, 1);
        expect(first).toMatchObject({
            contract: replayWalletPageContract,
            wallet,
            afterCursor: 0,
            nextCursor: 1,
            cutCursor: 4,
            coverage: {
                source: 'verified_trade_tape',
                scope: 'trade_only',
                history: 'selected_window',
                historyComplete: false,
                balanceComplete: false,
                feeComplete: false,
            },
            items: [{
                contract: replayWalletTradeContract,
                cursor: 0,
                side: 'buy',
                tokenMint: replayMint,
                quoteMint: replayQuoteMint,
                tokenDeltaRaw: '100',
                quoteDeltaRaw: '-100',
            }],
        });

        const second = replayWalletPage(snapshot(), source, wallet, first.nextCursor, 1);
        expect(second).toMatchObject({
            nextCursor: 3,
            items: [{ cursor: 2, tokenDeltaRaw: '100', quoteDeltaRaw: '-100' }],
        });
        expect(replayWalletPage(snapshot(), source, wallet, second.nextCursor, 1))
            .toMatchObject({ nextCursor: 4, items: [] });
        expect(Object.isFrozen(first)).toBe(true);
        expect(replayWalletPage(snapshot(2), source, wallet, 0, 1).items[0].activityKey)
            .toBe(first.items[0].activityKey);
    });

    it('rejects invalid wallets and cursors beyond the current cut', () => {
        const source = trades();
        expect(() => replayWalletPage(snapshot(), source, 'not-a-wallet'))
            .toThrow();
        expect(() => replayWalletPage(snapshot(), source, wallet, 5))
            .toThrow('page is invalid');
        expect(() => replayWalletPage(snapshot(), source, wallet, 0, 501))
            .toThrow('page is invalid');
    });

    it('derives observed FIFO basis and a last-trade mark without claiming history', () => {
        expect(projectWalletPortfolio(snapshot(), portfolioTrades(), wallet)).toMatchObject({
            contract: walletPortfolioContract,
            tradeCount: 2,
            buyCount: 1,
            sellCount: 1,
            observedBasisComplete: true,
            coverage: {
                basisPolicy: 'observed_fifo',
                historyComplete: false,
                balanceComplete: false,
                openingBalanceKnown: false,
                transferComplete: false,
            },
            netFlows: expect.arrayContaining([
                { mint: replayMint, netRaw: '60' },
                { mint: replayQuoteMint, netRaw: '-80' },
            ]),
            positions: [{
                acquiredRaw: '100',
                soldRaw: '40',
                coveredSoldRaw: '40',
                unmatchedSoldRaw: '0',
                soldBasisCoverageBps: 10_000,
                openQuantityRaw: '60',
                openCostRaw: '120',
                realizedPnlRaw: '40',
                markPolicy: 'last_trade_ratio',
                markCursor: 3,
                markValueRaw: '300',
                unrealizedPnlRaw: '180',
                observedBasisComplete: true,
            }],
        });
    });

    it('separates unmatched sales from covered basis', () => {
        const source = portfolioTrades();
        source[0] = {
            ...source[0],
            side: 'sell',
            tokenAmountRaw: '30',
            quoteAmountRaw: '90',
        };
        source[1] = {
            ...source[1],
            maker: wallet,
            side: 'buy',
            tokenAmountRaw: '100',
            quoteAmountRaw: '200',
        };
        source[2] = {
            ...source[2],
            tokenAmountRaw: '20',
            quoteAmountRaw: '60',
        };

        expect(projectWalletPortfolio(snapshot(), source, wallet)).toMatchObject({
            tradeCount: 3,
            observedBasisComplete: false,
            netFlows: expect.arrayContaining([
                { mint: replayMint, netRaw: '50' },
                { mint: replayQuoteMint, netRaw: '-50' },
            ]),
            positions: [{
                acquiredRaw: '100',
                soldRaw: '50',
                coveredSoldRaw: '20',
                unmatchedSoldRaw: '30',
                soldBasisCoverageBps: 4_000,
                openQuantityRaw: '80',
                openCostRaw: '160',
                realizedPnlRaw: '20',
                markValueRaw: '400',
                unrealizedPnlRaw: '240',
                observedBasisComplete: false,
            }],
        });
    });
});
