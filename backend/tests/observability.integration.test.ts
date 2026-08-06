import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('observability query infrastructure', () => {
    let query: any;
    let userId = '';
    const marker = crypto.randomBytes(8).toString('hex');
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const sol = 'So11111111111111111111111111111111111111112';
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        process.env.DB_COLOCATED ??= 'true';
        ({ query } = await import('../src/config/database'));
        const user = await query(
            'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
            [`ObservabilityWallet${marker}`]
        );
        userId = user.rows[0].id;

        await query(
            `INSERT INTO event_outbox
             (stream, event_key, payload, status, published_at, created_at, updated_at)
             SELECT 'execution.lifecycle', concat('observe-plan-${marker}-', sequence), '{}'::jsonb,
                    CASE sequence WHEN 1 THEN 'pending'
                                  WHEN 2 THEN 'publishing'
                                  WHEN 3 THEN 'failed'
                                  ELSE 'published' END,
                    CASE WHEN sequence > 3 THEN CURRENT_TIMESTAMP ELSE NULL END,
                    CURRENT_TIMESTAMP - INTERVAL '1 hour',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour'
               FROM generate_series(1, 20000) AS series(sequence)`
        );
        await query(
            `INSERT INTO notification_deliveries
             (channel, idempotency_key, status, created_at, updated_at)
             SELECT 'email', concat('observe-plan-${marker}-', sequence),
                    CASE sequence WHEN 1 THEN 'pending'
                                  WHEN 2 THEN 'sending'
                                  WHEN 3 THEN 'retry_scheduled'
                                  ELSE 'delivered' END,
                    CURRENT_TIMESTAMP - INTERVAL '1 hour',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour'
               FROM generate_series(1, 20000) AS series(sequence)`
        );
        await query(
            `INSERT INTO order_intents
             (id, user_id, provider, client_order_id, request_digest, wallet_address,
              order_type, state, input_mint, output_mint, input_amount, trigger_mint,
              params, expires_at, created_at, updated_at)
             SELECT gen_random_uuid(), $1, 'fixture', concat('observe-plan-${marker}-', sequence),
                    repeat('a', 64), $2, 'single',
                    CASE WHEN sequence <= 2 THEN 'preparing'
                         WHEN sequence <= 4 THEN 'activating'
                         WHEN sequence <= 6 THEN 'cancel_pending'
                         ELSE 'filled' END,
                    $3, $4, '1', $3, '{}'::jsonb,
                    CURRENT_TIMESTAMP + INTERVAL '1 day',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour'
               FROM generate_series(1, 20000) AS series(sequence)`,
            [userId, wallet, sol, usdc]
        );
        await query(
            `WITH data AS (
                SELECT sequence, gen_random_uuid() AS quote_id,
                       concat('observe-plan-${marker}-', sequence) AS request_id
                  FROM generate_series(1, 20000) AS series(sequence)
             ), quotes AS (
                INSERT INTO trade_quotes
                (id, user_id, wallet_address, provider, provider_quote_id, input_mint, output_mint,
                 input_amount, output_amount, min_output_amount, slippage_bps, fee_payer,
                 transaction_digest, integrity_digest, state, expires_at)
                SELECT quote_id, $1, $2, 'fixture', request_id, $3, $4,
                       '1', '1', '1', 100, $2, repeat('b', 64), repeat('c', 64),
                       'consumed', CURRENT_TIMESTAMP + INTERVAL '1 day'
                  FROM data
                RETURNING id
             )
             INSERT INTO trade_executions
             (id, quote_id, user_id, wallet_address, provider, idempotency_key, state,
              signature, input_mint, output_mint, expected_input_amount, expected_output_amount,
              signed_tx_digest, provider_status, broadcast_started_at, broadcast_count,
              submitted_at, created_at, updated_at)
             SELECT gen_random_uuid(), data.quote_id, $1, $2, 'fixture', data.request_id,
                    CASE sequence WHEN 1 THEN 'signed'
                                  WHEN 2 THEN 'submitted'
                                  WHEN 3 THEN 'processed'
                                  WHEN 4 THEN 'confirmed'
                                  WHEN 5 THEN 'signed'
                                  ELSE 'finalized' END,
                    repeat('9', 88), $3, $4, '1', '1', repeat('d', 64),
                    CASE WHEN sequence <= 2 THEN 'ambiguous:timeout' ELSE NULL END,
                    CASE WHEN sequence = 1 THEN CURRENT_TIMESTAMP - INTERVAL '1 hour' ELSE NULL END,
                    CASE WHEN sequence = 1 THEN 2 ELSE 0 END,
                    CASE WHEN sequence IN (2, 3, 4)
                         THEN CURRENT_TIMESTAMP - INTERVAL '1 hour' ELSE NULL END,
                    CURRENT_TIMESTAMP - INTERVAL '1 hour',
                    CURRENT_TIMESTAMP - INTERVAL '1 hour'
               FROM data JOIN quotes ON quotes.id = data.quote_id`,
            [userId, wallet, sol, usdc]
        );
        await query(
            `INSERT INTO tokens (mint, observed_at, source)
             SELECT concat('Observe${marker}', sequence),
                    CURRENT_TIMESTAMP - (sequence::text || ' milliseconds')::interval,
                    'fixture'
               FROM generate_series(1, 20000) AS series(sequence)`
        );
        await query(
            'ANALYZE event_outbox, notification_deliveries, order_intents, trade_executions, tokens'
        );
    }, 30_000);

    afterAll(async () => {
        if (!query) return;
        await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`observe-plan-${marker}-%`]);
        await query('DELETE FROM notification_deliveries WHERE idempotency_key LIKE $1', [`observe-plan-${marker}-%`]);
        await query('DELETE FROM tokens WHERE mint LIKE $1', [`Observe${marker}%`]);
        if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    });

    it('uses only hot-set indexes for the periodic aggregate', async () => {
        const { OPS_QUERY, collectOpsMetrics } = await import('../src/services/observability');
        const result = await collectOpsMetrics(query);
        expect(result).toMatchObject({
            executionRecoveries: expect.any(Number),
            executionAmbiguous: expect.any(Number),
            executionRepeated: expect.any(Number),
        });
        const explained = await query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${OPS_QUERY}`,
            [300000, 300000]
        );
        const root = explained.rows[0]['QUERY PLAN'][0].Plan as Record<string, any>;
        const indexes = new Set<string>();
        const seqScans = new Set<string>();
        const visit = (node: Record<string, any>): void => {
            if (node['Index Name']) indexes.add(node['Index Name']);
            if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) {
                seqScans.add(node['Relation Name']);
            }
            for (const child of node.Plans || []) visit(child);
        };
        visit(root);

        for (const index of [
            'idx_event_outbox_due',
            'event_outbox_failed_idx',
            'notification_backlog_idx',
            'order_stuck_idx',
            'tokens_observed_idx',
            'trade_exec_signed_stuck_idx',
            'trade_exec_chain_stuck_idx',
            'trade_exec_recovery_stats_idx',
        ]) {
            expect(indexes.has(index), `missing plan index ${index}`).toBe(true);
        }
        for (const table of [
            'event_outbox',
            'notification_deliveries',
            'order_intents',
            'trade_executions',
            'tokens',
        ]) {
            expect(seqScans.has(table), `unexpected full scan of ${table}`).toBe(false);
        }
    }, 15_000);
});
