import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../src/services/clock';
import { MarketMetricService } from '../src/services/marketData/marketMetricService';
import type { NormalizedTradeEvent } from '../src/types';
import type { MetricBase, MetricEvent, MetricOutput } from '../src/services/marketData/marketMetricRepository';
import type { StoredRollup } from '../src/services/marketData/rollingMetricBook';

const at = Date.parse('2024-11-20T03:59:53.000Z');

describe('market clock', () => {
    it('advances monotonically under explicit control', () => {
        const clock = new VirtualClock(at);
        clock.advanceTo(at + 1_000);
        expect(clock.nowMs()).toBe(at + 1_000);
        expect(() => clock.advanceTo(at)).toThrow('cannot move backward');
        expect(() => new VirtualClock(Number.NaN)).toThrow('start is invalid');
    });

    it('timestamps market projection from the injected clock', async () => {
        const clock = new VirtualClock(at);
        let receivedAt: string | undefined;
        const repository = {
            apply: async (
                _event: MetricEvent,
                empty: StoredRollup,
                build: (base: MetricBase) => MetricOutput
            ) => {
                const output = build({
                    rollup: empty,
                    state: null,
                    latestObservedAt: null,
                    latestSlot: null,
                    latestEventKey: null,
                });
                receivedAt = output.state.receivedAt;
                return { created: true, published: false, state: output.state, tick: output.tick };
            },
            markPublished: async () => undefined,
        };
        const trade: NormalizedTradeEvent = {
            kind: 'trade',
            idempotencyKey: 'a'.repeat(64),
            tokenMint: 'Token111111111111111111111111111111111111111',
            source: 'old_faithful',
            sourceEventId: 'old_faithful:trade:1',
            maker: 'Wallet11111111111111111111111111111111111111',
            side: 'buy',
            priceUsd: 1,
            usdAmount: 10,
            observedAt: '2024-11-20T03:59:52.000Z',
            receivedAt: '2024-11-20T03:59:52.000Z',
            confidence: 1,
            stale: false,
        };
        const service = new MarketMetricService(
            { get: async () => ({ contract: 'fervor-market-input-v2', tokenMint: trade.tokenMint }) },
            repository as never,
            {} as never,
            clock
        );

        await service.project(trade, { publish: false });
        expect(receivedAt).toBe('2024-11-20T03:59:53.000Z');
    });
});
