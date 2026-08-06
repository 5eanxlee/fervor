import crypto from 'crypto';
import { query } from '../config/database';
import { env } from '../config/env';
import { metrics } from './metrics';
import { redisStreams, STREAMS } from './redisStreamService';

export const shardForToken = (tokenAddress: string, shardCount = env.FEED_SHARD_COUNT): number => {
    const hash = crypto.createHash('sha256').update(tokenAddress).digest();
    const value = hash.readUInt32BE(0);
    return value % shardCount;
};

export interface AlertIndexUpdate {
    type: 'alert_created' | 'alert_updated' | 'alert_deleted';
    alertId?: string;
    tokenAddress: string;
    shardId: number;
    createdAt: string;
}

export class SubscriptionRegistry {
    private readonly lastTickFlushByToken = new Map<string, number>();
    private readonly pendingTickFlushes = new Set<string>();

    async syncToken(tokenAddress: string, tokenName?: string | null, tokenSymbol?: string | null): Promise<void> {
        const activeResult = await query(
            `SELECT COUNT(*)::int as count
             FROM token_alerts
             WHERE token_address = $1 AND is_active = true AND is_triggered = false`,
            [tokenAddress]
        );
        const activeAlertCount = Number(activeResult.rows[0]?.count || 0);
        const shardId = shardForToken(tokenAddress);
        const status = activeAlertCount > 0 ? 'active' : 'disabled';

        await query(
            `INSERT INTO monitored_tokens
             (token_address, token_name, token_symbol, active_alert_count, shard_id, shard_count, status, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
             ON CONFLICT (token_address) DO UPDATE SET
               token_name = COALESCE(EXCLUDED.token_name, monitored_tokens.token_name),
               token_symbol = COALESCE(EXCLUDED.token_symbol, monitored_tokens.token_symbol),
               active_alert_count = EXCLUDED.active_alert_count,
               shard_id = EXCLUDED.shard_id,
               shard_count = EXCLUDED.shard_count,
               status = EXCLUDED.status,
               updated_at = CURRENT_TIMESTAMP`,
            [tokenAddress, tokenName || null, tokenSymbol || null, activeAlertCount, shardId, env.FEED_SHARD_COUNT, status]
        );

        metrics.gauge('fervor_monitored_token_active_alerts', activeAlertCount, { token: tokenAddress });
        metrics.increment('fervor_subscription_registry_syncs', { status });
    }

    async emitAlertIndexUpdate(update: Omit<AlertIndexUpdate, 'shardId' | 'createdAt'>): Promise<void> {
        const payload: AlertIndexUpdate = {
            ...update,
            shardId: shardForToken(update.tokenAddress),
            createdAt: new Date().toISOString(),
        };
        await redisStreams.publish(STREAMS.alertIndexUpdates, payload);
    }

    async syncAndEmit(
        type: AlertIndexUpdate['type'],
        tokenAddress: string,
        alertId?: string,
        tokenName?: string | null,
        tokenSymbol?: string | null
    ): Promise<void> {
        await this.syncToken(tokenAddress, tokenName, tokenSymbol);
        await this.emitAlertIndexUpdate({ type, tokenAddress, alertId });
    }

    async getTokensForShard(shardId = env.FEED_SHARD_ID, shardCount = env.FEED_SHARD_COUNT): Promise<string[]> {
        const result = await query(
            `SELECT token_address
             FROM monitored_tokens
             WHERE status = 'active'
               AND shard_id = $1
               AND shard_count = $2
             ORDER BY updated_at ASC`,
            [shardId, shardCount]
        );
        return result.rows.map((row) => row.token_address);
    }

    async markTick(tokenAddress: string): Promise<void> {
        const now = Date.now();
        const lastFlush = this.lastTickFlushByToken.get(tokenAddress) || 0;
        this.pendingTickFlushes.add(tokenAddress);
        if (now - lastFlush < 10_000 && this.pendingTickFlushes.size < 100) {
            return;
        }

        const tokens = Array.from(this.pendingTickFlushes);
        this.pendingTickFlushes.clear();
        for (const token of tokens) {
            this.lastTickFlushByToken.set(token, now);
        }

        await query(
            `UPDATE monitored_tokens
             SET last_tick_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE token_address = ANY($1::varchar[])`,
            [tokens]
        );
    }
}

export const subscriptionRegistry = new SubscriptionRegistry();
