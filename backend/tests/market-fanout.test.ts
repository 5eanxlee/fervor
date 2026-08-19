import { describe, expect, it, vi } from 'vitest';
import { STREAMS, type StreamMessage, type StreamName } from '../src/services/redisStreamService';
import {
    MarketFanout,
    streamMessagesToSseEvents,
    type MarketNotice,
    type MarketReader,
} from '../src/services/realtime/marketFanout';

const mint = 'So11111111111111111111111111111111111111112';

class Reader implements MarketReader {
    readonly connect = vi.fn(async () => undefined);
    readonly read = vi.fn(<T>() => new Promise<Array<StreamMessage<T> & { stream: StreamName }>>(
        (resolve) => this.pending.push(resolve as (messages: any[]) => void)
    ));
    private readonly pending: Array<(messages: any[]) => void> = [];

    resolve(messages: any[]): void {
        const next = this.pending.shift();
        if (!next) throw new Error('No pending market read');
        next(messages);
    }
}

const until = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for market fanout');
};

describe('market stream fanout', () => {
    it('uses one upstream read for multiple subscribers and filters by token', async () => {
        const reader = new Reader();
        const fanout = new MarketFanout(reader, {
            blockMs: 5_000,
            batchSize: 100,
            heartbeatMs: 60_000,
        });
        const notices: MarketNotice[][] = [[], []];
        let firstOff = (): void => undefined;
        let secondOff = (): void => undefined;
        firstOff = fanout.subscribe(mint, (notice) => {
            notices[0].push(notice);
            if (notice.type === 'events') firstOff();
        });
        secondOff = fanout.subscribe(mint, (notice) => {
            notices[1].push(notice);
            if (notice.type === 'events') secondOff();
        });

        await until(() => reader.read.mock.calls.length === 1);
        reader.resolve([{
            stream: STREAMS.marketTrades,
            id: '1-0',
            payload: { tokenMint: mint, side: 'buy' },
        }, {
            stream: STREAMS.marketTrades,
            id: '2-0',
            payload: { tokenMint: '11111111111111111111111111111111', side: 'sell' },
        }]);
        await until(() => notices.every((list) => list.length === 1));
        await fanout.close();

        expect(reader.read).toHaveBeenCalledTimes(1);
        for (const list of notices) {
            expect(list[0]).toMatchObject({
                type: 'events',
                events: [{ event: 'trade', id: '1-0', delivery: 'ordered' }],
            });
        }
    });

    it('marks only replaceable market views as state and strips alert internals', () => {
        const events = streamMessagesToSseEvents([{
            stream: STREAMS.marketStates,
            id: '1-0',
            payload: { tokenMint: mint, priceUsd: 1 },
        }, {
            stream: STREAMS.marketCandles,
            id: '2-0',
            payload: { tokenMint: mint, close: 1 },
        }, {
            stream: STREAMS.alertsTriggered,
            id: '3-0',
            payload: {
                tokenAddress: mint,
                thresholdType: 'price',
                condition: 'above',
                currentValue: 1,
                triggeredAt: '2026-08-19T00:00:00.000Z',
                engineVersion: 'test',
                userId: 'must-not-leak',
            },
        }], mint);

        expect(events.map(({ event, delivery }) => ({ event, delivery }))).toEqual([
            { event: 'market_state', delivery: 'state' },
            { event: 'candle', delivery: 'ordered' },
            { event: 'alert_triggered', delivery: 'exact' },
        ]);
        expect(events[2].data).not.toHaveProperty('userId');
    });
});
