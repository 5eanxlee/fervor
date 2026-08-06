import { randomUUID } from 'crypto';
import { DbQuery, transaction } from '../config/database';
import { env } from '../config/env';
import { metrics } from './metrics';
import { redisStreams, StreamName } from './redisStreamService';
import { mapConcurrent } from './streamWorker';

interface OutboxRow {
    id: string;
    stream: StreamName;
    event_key: string;
    payload: unknown;
    attempts: number;
}

const retryMs = (attempts: number): number => {
    const cap = Math.min(60_000, 250 * 2 ** Math.max(0, attempts - 1));
    return Math.round(cap * (0.75 + Math.random() * 0.5));
};

export class EventOutbox {
    private readonly workerId = `${process.pid}-${randomUUID()}`;

    async enqueue(
        db: DbQuery,
        stream: StreamName,
        eventKey: string,
        payload: unknown
    ): Promise<void> {
        const json = JSON.stringify(payload);
        const inserted = await db(
            `INSERT INTO event_outbox (stream, event_key, payload)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (stream, event_key) DO NOTHING
             RETURNING id`,
            [stream, eventKey, json]
        );
        if (inserted.rows[0]) return;
        const replay = await db(
            `SELECT id FROM event_outbox
              WHERE stream = $1 AND event_key = $2 AND payload = $3::jsonb
              FOR SHARE`,
            [stream, eventKey, json]
        );
        if (!replay.rows[0]) {
            throw new Error('Outbox event key was reused with a different payload');
        }
    }

    async flushDue(limit = env.OUTBOX_BATCH_SIZE): Promise<number> {
        const rows = await this.claim(limit);
        await mapConcurrent(rows, env.OUTBOX_CONCURRENCY, async (row) => {
            try {
                await redisStreams.publishOnce(
                    row.stream,
                    row.event_key,
                    row.payload,
                    env.OUTBOX_DEDUP_TTL_SEC
                );
                await this.markPublished(row.id);
                metrics.increment('fervor_outbox_published', { stream: row.stream });
            } catch (error) {
                await this.markFailed(row, error);
                metrics.increment('fervor_outbox_publish_errors', { stream: row.stream });
            }
        });
        metrics.gauge('fervor_outbox_claimed', rows.length);
        return rows.length;
    }

    async prune(days = 7): Promise<number> {
        const result = await transaction((db) => db(
            `DELETE FROM event_outbox
             WHERE status = 'published'
               AND published_at < NOW() - ($1::text || ' days')::interval`,
            [days]
        ));
        return result.rowCount || 0;
    }

    private async claim(limit: number): Promise<OutboxRow[]> {
        return transaction(async (db) => {
            const result = await db<OutboxRow>(
                `WITH due AS (
                    SELECT id
                    FROM event_outbox
                    WHERE attempts < $1
                      AND (
                        (status = 'pending' AND next_attempt_at <= NOW())
                        OR (status = 'publishing' AND lease_until <= NOW())
                      )
                    ORDER BY next_attempt_at, created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT $2
                 )
                 UPDATE event_outbox outbox
                 SET status = 'publishing',
                     attempts = outbox.attempts + 1,
                     lease_until = NOW() + ($3::text || ' milliseconds')::interval,
                     locked_by = $4,
                     updated_at = CURRENT_TIMESTAMP
                 FROM due
                 WHERE outbox.id = due.id
                 RETURNING outbox.id, outbox.stream, outbox.event_key, outbox.payload, outbox.attempts`,
                [env.OUTBOX_MAX_ATTEMPTS, limit, env.OUTBOX_LEASE_MS, this.workerId]
            );
            return result.rows;
        });
    }

    private async markPublished(id: string): Promise<void> {
        await transaction((db) => db(
            `UPDATE event_outbox
             SET status = 'published',
                 published_at = CURRENT_TIMESTAMP,
                 lease_until = NULL,
                 locked_by = NULL,
                 last_error = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND locked_by = $2`,
            [id, this.workerId]
        )).then(() => undefined);
    }

    private async markFailed(row: OutboxRow, error: unknown): Promise<void> {
        const exhausted = row.attempts >= env.OUTBOX_MAX_ATTEMPTS;
        await transaction((db) => db(
            `UPDATE event_outbox
             SET status = $1,
                 next_attempt_at = CURRENT_TIMESTAMP + ($2::text || ' milliseconds')::interval,
                 lease_until = NULL,
                 locked_by = NULL,
                 last_error = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND locked_by = $5`,
            [
                exhausted ? 'failed' : 'pending',
                retryMs(row.attempts),
                error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
                row.id,
                this.workerId,
            ]
        )).then(() => undefined);
    }
}

export const eventOutbox = new EventOutbox();
