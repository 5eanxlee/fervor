import { randomUUID } from 'node:crypto';
import type { RetentionDb } from '../../config/retention';
import { withDbClient } from '../dbWork';
import { metrics } from '../metrics';

interface PurgeRow {
    purged: number;
}

export class BlobRetention {
    constructor(
        private readonly db: RetentionDb,
        private readonly batchSize: number,
        private readonly timeoutMs: number
    ) {}

    async runBatch(batch = this.batchSize, signal?: AbortSignal): Promise<number> {
        try {
            const purged = await withDbClient(
                this.db, this.timeoutMs, signal, 'Blob retention',
                async (client) => {
                    const result = await client.query<PurgeRow>(
                        'SELECT purge_expired_blobs($1, $2) AS purged',
                        [batch, `retention:${randomUUID()}`]
                    );
                    const count = Number(result.rows[0]?.purged);
                    if (!Number.isInteger(count) || count < 0 || count > batch) {
                        throw new Error('Blob retention returned an invalid purge count');
                    }
                    return count;
                }
            );
            metrics.increment('fervor_blob_retention_runs', { outcome: 'ok' });
            metrics.gauge('fervor_blob_retention_last_batch', purged);
            if (purged > 0) metrics.increment('fervor_blob_retention_purged', undefined, purged);
            return purged;
        } catch (error) {
            metrics.increment('fervor_blob_retention_runs', { outcome: 'error' });
            throw error;
        }
    }
}
