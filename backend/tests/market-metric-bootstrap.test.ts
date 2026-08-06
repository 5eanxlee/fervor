import { describe, expect, it } from 'vitest';
import { MarketMetricBootstrap } from '../src/services/marketData/marketMetricBootstrap';

describe('market metric bootstrap', () => {
    it('replays the frozen horizon without publishing historical alert ticks', async () => {
        const cutoff = '2026-08-03T12:00:00.000Z';
        let complete = false;
        let coreReads = 0;
        const projected: any[] = [];
        const core = {
            query: async () => {
                coreReads += 1;
                return { rows: coreReads === 1 ? [{
                    idempotency_key: 'a'.repeat(64),
                    token_mint: 'Token111111111111111111111111111111111111111',
                    maker: 'wallet-1',
                    side: 'buy',
                    token_amount_raw: '100',
                    token_decimals: 6,
                    usd_amount: '25',
                    price_usd: '0.25',
                    signature: '5'.repeat(88),
                    slot: 42,
                    instruction_index: 0,
                    event_index: 0,
                    source: 'fixture',
                    source_event_id: 'legacy-event-1',
                    observed_at: '2026-08-03T11:59:00.000Z',
                    received_at: '2026-08-03T11:59:00.100Z',
                    confidence: '0.9',
                    stale: false,
                }] : [] } as any;
            },
        };
        const market = {
            query: async (sql: string, params: unknown[] = []) => {
                if (sql.includes('SELECT status')) {
                    return { rows: [{ status: complete ? 'complete' : 'pending' }] } as any;
                }
                if (sql.includes('RETURNING lease_token')) {
                    return { rows: [{
                        lease_token: 'lease-1',
                        horizon_start: '2026-08-02T12:00:00.000Z',
                        cutoff_at: cutoff,
                        cursor_at: null,
                        cursor_key: null,
                    }] } as any;
                }
                if (sql.includes('UPDATE market_metric_bootstrap')) {
                    complete = params[3] === true;
                    return { rows: [{ id: 1 }] } as any;
                }
                throw new Error(`Unexpected bootstrap query: ${sql}`);
            },
        };
        const projector = {
            project: async (...args: any[]) => {
                projected.push(args);
                return 'committed';
            },
        };

        await new MarketMetricBootstrap(
            projector as any,
            'metric-test',
            core as any,
            market as any
        ).run();

        expect(projected).toHaveLength(1);
        expect(projected[0][0]).toMatchObject({
            idempotencyKey: 'a'.repeat(64),
            usdAmount: 25,
            sourceEventId: 'legacy-event-1',
        });
        expect(projected[0][1]).toEqual({
            nowMs: Date.parse(cutoff),
            publish: false,
            loadInputs: false,
        });
        expect(complete).toBe(true);
    });
});
