import { coreDb, type Database, type DbQuery } from '../../config/database';
import { env } from '../../config/env';
import { safeSlot } from '../../types';
import { mapConcurrent } from '../streamWorker';
import { metrics } from '../metrics';
import { redisStreams, STREAMS } from '../redisStreamService';
import { createWalletProvider } from './providerFactory';
import { WalletHistoryPage, WalletHistoryProvider, WalletProviderError } from './provider';
import { normalizeWalletActivity, type NormalizedWalletActivity } from './walletNormalizer';
import {
    WalletProjectionRepository,
    walletProjectionRepository,
} from './walletProjectionRepository';

type Row = Record<string, any>;
type CorePlane = Pick<Database, 'query'>;

const asPlane = (value: CorePlane | DbQuery): CorePlane => typeof value === 'function'
    ? { query: value }
    : value;

const signatureOf = (value: any): string | undefined => {
    const signature = value?.transaction?.signatures?.[0] ?? value?.signature;
    return typeof signature === 'string' ? signature : undefined;
};

const newestOf = (page: WalletHistoryPage): { signature?: string; slot?: number } => {
    const first = page.transactions[0] as any;
    return {
        signature: page.newestSignature || signatureOf(first),
        slot: page.newestSlot ?? safeSlot(first?.slot),
    };
};

export { normalizeWalletActivity as normalizeHeliusActivity } from './walletNormalizer';

export class WalletIndexerService {
    private readonly core: CorePlane;

    constructor(
        private readonly provider: WalletHistoryProvider = createWalletProvider(),
        core: CorePlane | DbQuery = coreDb,
        private readonly projections: WalletProjectionRepository = walletProjectionRepository,
        private readonly owner = `wallet-indexer-${process.pid}`
    ) {
        this.core = asPlane(core);
    }

    async runBatch(limit = 100): Promise<number> {
        const claimed = await this.claim(limit);
        await mapConcurrent(claimed, env.WALLET_CONCURRENCY, async (source) => this.poll(source));
        await this.redrive().catch((error) => {
            console.error('[wallet-indexer] Fanout redrive failed', error);
        });
        return claimed.length;
    }

    private async claim(limit: number): Promise<Row[]> {
        const result = await this.core.query(
            `WITH due AS (
               SELECT source.id
               FROM wallet_sources source
               WHERE source.status = 'active'
                 AND source.next_poll_at <= CURRENT_TIMESTAMP
                 AND (source.lease_until IS NULL OR source.lease_until <= CURRENT_TIMESTAMP)
                 AND mod(mod(hashtextextended(source.wallet_address, 0), $1) + $1, $1) = $2
                 AND EXISTS (
                   SELECT 1 FROM tracked_wallets tracked
                   WHERE tracked.source_id = source.id AND tracked.status = 'active'
                 )
               ORDER BY source.next_poll_at, source.last_polled_at NULLS FIRST
               FOR UPDATE SKIP LOCKED
               LIMIT $3
             )
             UPDATE wallet_sources source
             SET poll_seq = source.poll_seq + 1,
                 lease_token = gen_random_uuid(),
                 lease_owner = $4,
                 lease_until = CURRENT_TIMESTAMP + ($5::text || ' milliseconds')::interval
             FROM due
             WHERE source.id = due.id
             RETURNING source.*`,
            [env.WALLET_SHARD_COUNT, env.WALLET_SHARD_ID, limit, this.owner, env.WALLET_LEASE_MS]
        );
        return result.rows as Row[];
    }

    private async poll(source: Row): Promise<void> {
        const sourceId = String(source.id);
        const walletAddress = String(source.wallet_address);
        const pollSeq = String(source.poll_seq || '1');
        const leaseToken = String(source.lease_token || 'test-lease');
        const done = metrics.timer('fervor_wallet_poll_ms', { provider: this.provider.name });
        try {
            if (this.provider.name !== 'fixture') {
                const delay = await redisStreams.rateDelay('wallet', [`${this.provider.name}:global`])
                    .catch(() => 0);
                if (delay > 0) {
                    await this.finish(sourceId, pollSeq, leaseToken, source, delay);
                    return;
                }
            }

            const next = { ...source };
            const isNew = !source.last_signature && source.last_slot === null;
            if (isNew) await this.initial(next, walletAddress);
            else await this.incremental(next, walletAddress);
            await this.finish(sourceId, pollSeq, leaseToken, next, env.WALLET_POLL_INTERVAL_MS);
            metrics.increment('fervor_wallet_polls_total', { provider: this.provider.name });
        } catch (error) {
            await this.fail(sourceId, pollSeq, leaseToken, source, error);
            metrics.increment('fervor_wallet_poll_errors', { provider: this.provider.name });
        } finally {
            done();
        }
    }

    private async initial(source: Row, walletAddress: string): Promise<void> {
        const page = await this.provider.history(walletAddress);
        await this.persistPage(source, walletAddress, page, false);
        const newest = newestOf(page);
        source.last_signature = newest.signature || source.last_signature;
        source.last_slot = newest.slot ?? source.last_slot;
        source.backfill_before = page.nextCursor || null;
        source.backfill_pages = page.transactions.length > 0 ? 1 : 0;
        source.backfill_complete = !page.nextCursor;
        if (source.backfill_complete) {
            await this.projections.rebuild(String(source.id), this.heartbeat(source));
        }
    }

    private async incremental(source: Row, walletAddress: string): Promise<void> {
        const live = await this.provider.history(walletAddress, {
            cursor: source.live_cursor || undefined,
            // Provider slot filters are exclusive. Overlap the previous slot so a
            // later signature in that slot cannot fall behind the checkpoint.
            afterSlot: Math.max(0, (safeSlot(source.last_slot) || 0) - 1),
        });
        await this.persistPage(source, walletAddress, live, Boolean(source.backfill_complete));
        const newest = newestOf(live);
        if (!source.live_cursor) {
            source.live_high_signature = newest.signature || null;
            source.live_high_slot = newest.slot ?? null;
        }
        source.live_cursor = live.nextCursor || null;
        if (!live.nextCursor) {
            source.last_signature = source.live_high_signature || newest.signature || source.last_signature;
            source.last_slot = source.live_high_slot ?? newest.slot ?? source.last_slot;
            source.live_high_signature = null;
            source.live_high_slot = null;
        }

        if (!source.backfill_complete && source.backfill_before) {
            const historical = await this.provider.history(walletAddress, {
                cursor: String(source.backfill_before),
            });
            await this.persistPage(source, walletAddress, historical, false);
            source.backfill_pages = Number(source.backfill_pages || 0) + 1;
            source.backfill_before = historical.nextCursor || null;
            source.backfill_complete = !historical.nextCursor;
            if (source.backfill_complete) {
                await this.projections.rebuild(String(source.id), this.heartbeat(source));
            }
        }
        if (source.backfill_complete) await this.projections.snapshotNow(String(source.id));
    }

    private async persistPage(
        source: Row,
        walletAddress: string,
        page: WalletHistoryPage,
        projectNow: boolean
    ): Promise<void> {
        const activities: NormalizedWalletActivity[] = [];
        for (const raw of [...page.transactions].reverse()) {
            activities.push(...normalizeWalletActivity(walletAddress, raw));
        }
        const sourceId = String(source.id);
        const stored = await this.projections.appendMany(
            sourceId,
            walletAddress,
            activities,
            projectNow,
            this.provider.name,
            this.heartbeat(source)
        );
        await mapConcurrent(
            stored.filter((event) => !event.published),
            env.WALLET_CONCURRENCY,
            async (event) => this.deliver(sourceId, event.key, event.payload)
        );
    }

    private async deliver(sourceId: string, key: string, payload: Record<string, unknown>): Promise<void> {
        try {
            await redisStreams.publishOnce(STREAMS.walletEvents, key, payload, 604_800);
            await this.projections.markPublished(sourceId, key);
        } catch (error) {
            await this.projections.markPublishError(sourceId, key, error).catch(() => undefined);
            throw error;
        }
    }

    private async redrive(): Promise<void> {
        for (const event of await this.projections.pending(env.REDIS_STREAM_BATCH_SIZE)) {
            await this.deliver(event.sourceId, event.key, event.payload);
        }
    }

    private heartbeat(source: Row): (() => Promise<void>) | undefined {
        if (this.provider.name === 'fixture') return undefined;
        return () => this.renew(
            String(source.id),
            String(source.poll_seq),
            String(source.lease_token)
        );
    }

    private async renew(sourceId: string, pollSeq: string, leaseToken: string): Promise<void> {
        const result = await this.core.query(
            `UPDATE wallet_sources
             SET lease_until = CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval
             WHERE id = $1 AND poll_seq = $2 AND lease_token = $3
             RETURNING id`,
            [sourceId, pollSeq, leaseToken, env.WALLET_LEASE_MS]
        );
        if (!result.rows[0]) throw new Error('Wallet poll lease was lost during projection');
    }

    private async finish(
        sourceId: string,
        pollSeq: string,
        leaseToken: string,
        state: Row,
        delayMs: number
    ): Promise<void> {
        await this.core.query(
            `UPDATE wallet_sources
             SET last_signature = COALESCE($2, last_signature),
                 last_slot = CASE
                   WHEN $3::bigint IS NULL THEN last_slot
                   WHEN last_slot IS NULL THEN $3::bigint
                   ELSE GREATEST(last_slot, $3::bigint)
                 END,
                 backfill_before = $4,
                 backfill_pages = $5,
                 backfill_complete = $6,
                 projection_version = CASE WHEN $6 THEN 2 ELSE projection_version END,
                 live_cursor = $7,
                 live_high_signature = $8,
                 live_high_slot = $9,
                 provider = $10,
                 last_polled_at = CURRENT_TIMESTAMP,
                 next_poll_at = CURRENT_TIMESTAMP + ($11::text || ' milliseconds')::interval,
                 failure_count = 0,
                 error_code = NULL,
                 lease_token = NULL,
                 lease_owner = NULL,
                 lease_until = NULL
             WHERE id = $1 AND poll_seq = $12 AND lease_token = $13`,
            [sourceId, state.last_signature || null, safeSlot(state.last_slot) ?? null,
                state.backfill_before || null, Number(state.backfill_pages || 0),
                Boolean(state.backfill_complete), state.live_cursor || null,
                state.live_high_signature || null, safeSlot(state.live_high_slot) ?? null,
                this.provider.name, delayMs, pollSeq, leaseToken]
        );
    }

    private async fail(
        sourceId: string,
        pollSeq: string,
        leaseToken: string,
        source: Row,
        error: unknown
    ): Promise<void> {
        const failures = Number(source.failure_count || 0) + 1;
        const providerError = error instanceof WalletProviderError ? error : undefined;
        const backoff = Math.min(
            env.WALLET_BACKOFF_MAX_MS,
            providerError?.retryAfterMs
                || env.WALLET_POLL_INTERVAL_MS * 2 ** Math.min(failures, 10)
        );
        if (providerError?.code === 'provider_rate_limited') {
            await redisStreams.setRateGate('wallet', `${this.provider.name}:global`, backoff).catch(() => undefined);
        }
        await this.core.query(
            `UPDATE wallet_sources
             SET last_polled_at = CURRENT_TIMESTAMP,
                 next_poll_at = CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval,
                 failure_count = $5,
                 error_code = $6,
                 lease_token = NULL,
                 lease_owner = NULL,
                 lease_until = NULL
             WHERE id = $1 AND poll_seq = $2 AND lease_token = $3`,
            [sourceId, pollSeq, leaseToken, backoff, failures,
                providerError?.code || (error instanceof Error ? error.name : 'wallet_poll_failed')]
        );
    }
}
