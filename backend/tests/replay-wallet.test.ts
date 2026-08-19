import { describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import type { ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    replayWalletPage,
    replayWalletPageContract,
    replayWalletTradeContract,
} from '../src/services/replay/replayWallet';
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
});
