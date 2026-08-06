import { query } from '../../config/database';
import { env } from '../../config/env';
import { MarketDataProviderName, ProviderCheckpoint } from '../../types';

export class ProviderCheckpointService {
    async get(provider: MarketDataProviderName, subscriptionId: string): Promise<ProviderCheckpoint | null> {
        const result = await query(
            `SELECT provider, subscription_id, region, commitment, last_processed_slot, updated_at
             FROM provider_checkpoints
             WHERE provider = $1 AND subscription_id = $2`,
            [provider, subscriptionId]
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
            provider: row.provider,
            subscriptionId: row.subscription_id,
            region: row.region,
            commitment: row.commitment,
            lastProcessedSlot: Number(row.last_processed_slot || 0),
            updatedAt: row.updated_at?.toISOString?.() || new Date().toISOString(),
        };
    }

    async mark(provider: MarketDataProviderName, subscriptionId: string, slot: number): Promise<void> {
        if (!Number.isFinite(slot) || slot <= 0) return;
        await query(
            `INSERT INTO provider_checkpoints
             (provider, subscription_id, region, commitment, last_processed_slot, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (provider, subscription_id) DO UPDATE SET
               region = EXCLUDED.region,
               commitment = EXCLUDED.commitment,
               last_processed_slot = GREATEST(provider_checkpoints.last_processed_slot, EXCLUDED.last_processed_slot),
               updated_at = CURRENT_TIMESTAMP`,
            [provider, subscriptionId, env.HELIUS_LASERSTREAM_REGION, env.MARKET_DATA_COMMITMENT, slot]
        );
    }

    async recordError(provider: MarketDataProviderName, payload: {
        sourceEventId?: string;
        eventType?: string;
        slot?: number;
        signature?: string;
        errorClass: string;
        errorMessage: string;
        payloadSummary?: unknown;
    }): Promise<void> {
        await query(
            `INSERT INTO provider_event_errors
             (provider, source_event_id, event_type, slot, signature, error_class, error_message, payload_summary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [
                provider,
                payload.sourceEventId || null,
                payload.eventType || null,
                payload.slot || null,
                payload.signature || null,
                payload.errorClass,
                payload.errorMessage,
                JSON.stringify(payload.payloadSummary || {}),
            ]
        );
    }
}
