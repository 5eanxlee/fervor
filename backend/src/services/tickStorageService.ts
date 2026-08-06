import { query } from '../config/database';
import { env } from '../config/env';
import { FeedTick } from '../types';
import { metrics } from './metrics';

export class TickStorageService {
    private buffer: FeedTick[] = [];
    private flushTimer: NodeJS.Timeout | null = null;

    start(): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => {
            void this.flush();
        }, env.TICK_FLUSH_INTERVAL_MS);
    }

    stop(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }

    async append(tick: FeedTick): Promise<void> {
        this.buffer.push(tick);
        if (this.buffer.length >= env.TICK_BATCH_SIZE) {
            await this.flush();
        }
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const batch = this.buffer.splice(0, env.TICK_BATCH_SIZE);
        const done = metrics.timer('fervor_tick_batch_insert_ms');
        try {
            const values: any[] = [];
            const rows = batch.map((tick, index) => {
                const offset = index * 9;
                values.push(
                    tick.tokenAddress,
                    tick.signature,
                    tick.slot,
                    new Date(tick.blockTime ? tick.blockTime * 1000 : tick.receivedAt),
                    tick.price ?? null,
                    tick.marketCap ?? null,
                    tick.usdValue,
                    tick.swapType || null,
                    tick.receivedAt
                );
                return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
            });

            await query(
                `INSERT INTO token_ticks
                 (token_address, signature, slot, block_time, price, market_cap, usd_value, swap_type, received_at)
                 VALUES ${rows.join(', ')}
                 ON CONFLICT DO NOTHING`,
                values
            );

            metrics.increment('fervor_ticks_persisted', undefined, batch.length);
        } finally {
            done();
        }
    }

    async enforceRetention(): Promise<void> {
        await query(
            `DELETE FROM token_ticks
             WHERE received_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [env.TICK_RETENTION_DAYS]
        );
    }
}
