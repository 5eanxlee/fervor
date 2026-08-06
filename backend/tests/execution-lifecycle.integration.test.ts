import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('execution lifecycle infrastructure', () => {
    let query: any;
    let transaction: any;
    let service: any;
    let userId = '';
    let executionId = '';
    let recoveryId = '';
    let leaseId = '';
    let operationId = '';
    let submits = 0;
    const marker = crypto.randomBytes(8).toString('hex');
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const sol = 'So11111111111111111111111111111111111111112';
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        process.env.DB_COLOCATED ??= 'true';
        process.env.TRADING_MODE = 'fixture';
        process.env.REDIS_URL ??= 'redis://localhost:6379';
        process.env.EXECUTION_TIMEOUT_MS = '1000';
        process.env.EXECUTION_OP_LEASE_MS = '6000';
        process.env.EXECUTION_RECONCILE_LEASE_MS = '8000';
        ({ query, transaction } = await import('../src/config/database'));
        const { ExecutionService } = await import('../src/services/execution/executionService');
        const { ExecutionProviderError } = await import('../src/services/execution/provider');
        const { FixtureSwapProvider } = await import('../src/services/execution/fixtureSwapProvider');
        const fixture = new FixtureSwapProvider();
        const provider = {
            name: 'fixture' as const,
            quote: fixture.quote.bind(fixture),
            submit: async (input: { providerQuoteId: string; signedTransaction: string }) => {
                submits += 1;
                if (submits === 1) {
                    throw new ExecutionProviderError(
                        'provider_timeout', 'Timed out after broadcast', true, 504, undefined, true
                    );
                }
                return fixture.submit(input);
            },
        };
        service = new ExecutionService(provider, query);
        const user = await query(
            'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
            [`ExecutionWallet${marker}`]
        );
        userId = user.rows[0].id;
    });

    afterAll(async () => {
        if (executionId) {
            await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`execution:${executionId}:%`]);
        }
        if (recoveryId) {
            await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`execution:${recoveryId}:%`]);
        }
        if (leaseId) {
            await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`execution:${leaseId}:%`]);
        }
        if (operationId) {
            await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`execution:${operationId}:%`]);
        }
        if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    });

    it('recovers a signature-less ambiguity only through the identical submission', async () => {
        const quote = await service.createQuote(userId, {
            inputMint: sol,
            outputMint: usdc,
            inputAmount: '1000000',
            taker: wallet,
            slippageBps: 100,
        });
        const request = {
            signedTransaction: quote.transaction,
            idempotencyKey: `infra-execution-${marker}`,
        };

        await expect(service.submit(userId, quote.id, request, `trace-${marker}-1`))
            .rejects.toMatchObject({ code: 'submission_ambiguous', retryable: false });
        const pending = await query(
            `SELECT id, state, provider_status, error_code, op_token, op_lease_until,
                    broadcast_started_at, broadcast_count
             FROM trade_executions WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, request.idempotencyKey]
        );
        executionId = pending.rows[0].id;
        expect(pending.rows[0]).toMatchObject({
            state: 'signed',
            provider_status: 'ambiguous',
            error_code: 'provider_timeout',
            op_token: null,
            op_lease_until: null,
            broadcast_count: 1,
        });
        expect(pending.rows[0].broadcast_started_at).toBeInstanceOf(Date);

        await expect(service.submit(userId, quote.id, request, `trace-${marker}-2`))
            .resolves.toMatchObject({ id: executionId, state: 'confirmed' });
        expect(submits).toBe(2);
        const durable = await query(
            `SELECT state, provider_status, error_code, broadcast_count,
                    (SELECT COUNT(*)::int FROM execution_events WHERE execution_id = trade_executions.id) AS event_count
             FROM trade_executions WHERE id = $1`,
            [executionId]
        );
        expect(durable.rows[0]).toMatchObject({
            state: 'confirmed',
            provider_status: 'fixture_confirmed',
            error_code: null,
            broadcast_count: 2,
            event_count: 5,
        });
        const outbox = await query(
            'SELECT COUNT(*)::int AS count FROM event_outbox WHERE event_key LIKE $1',
            [`execution:${executionId}:%`]
        );
        expect(outbox.rows[0].count).toBe(5);
    });

    it('reconciles a known signature after a broadcast-window process death', async () => {
        await query(
            `UPDATE trade_executions
             SET state = 'finalized', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
             WHERE id = $1 AND state = 'confirmed'`,
            [executionId]
        );
        const quote = await service.createQuote(userId, {
            inputMint: sol,
            outputMint: usdc,
            inputAmount: '2000000',
            taker: wallet,
            slippageBps: 100,
        });
        recoveryId = crypto.randomUUID();
        const signature = '5'.repeat(88);
        await query(
            `INSERT INTO trade_executions
             (id, quote_id, user_id, wallet_address, provider, idempotency_key, state,
              signature, input_mint, output_mint, expected_input_amount, expected_output_amount,
              signed_tx_digest, broadcast_started_at, broadcast_count, op_lease_until)
             VALUES ($1, $2, $3, $4, 'fixture', $5, 'signed', $6, $7, $8, $9, $10,
                     $11, CURRENT_TIMESTAMP - INTERVAL '1 minute', 1,
                     CURRENT_TIMESTAMP - INTERVAL '30 seconds')`,
            [recoveryId, quote.id, userId, wallet, `crash-${marker}-execution`, signature,
                sol, usdc, '2000000', quote.outputAmount, 'f'.repeat(64)]
        );

        const { ExecutionReconciler } = await import('../src/services/execution/executionReconciler');
        const fetcher = async () => Response.json({
            jsonrpc: '2.0',
            result: { value: [{ slot: 84, err: null, confirmationStatus: 'processed' }] },
        });
        const reconciler = new ExecutionReconciler(
            'https://rpc.example.com', query, transaction, fetcher as typeof fetch
        );
        await expect(reconciler.runBatch()).resolves.toEqual({ checked: 1, updated: 1 });

        const recovered = await query(
            `SELECT state, submitted_at, confirmed_at, op_token, op_lease_until,
                    (SELECT COUNT(*)::int FROM execution_events WHERE execution_id = trade_executions.id) AS event_count
               FROM trade_executions WHERE id = $1`,
            [recoveryId]
        );
        expect(recovered.rows[0]).toMatchObject({
            state: 'processed',
            op_token: null,
            op_lease_until: null,
            event_count: 1,
        });
        expect(recovered.rows[0].submitted_at).toBeInstanceOf(Date);
        expect(recovered.rows[0].confirmed_at).toBeNull();
    });

    it('keeps a second worker fenced beyond the RPC timeout boundary', async () => {
        await query(
            `UPDATE trade_executions
             SET state = 'finalized', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
             WHERE id = $1 AND state = 'processed'`,
            [recoveryId]
        );
        const quote = await service.createQuote(userId, {
            inputMint: sol,
            outputMint: usdc,
            inputAmount: '3000000',
            taker: wallet,
            slippageBps: 100,
        });
        leaseId = crypto.randomUUID();
        await query(
            `INSERT INTO trade_executions
             (id, quote_id, user_id, wallet_address, provider, idempotency_key, state,
              signature, input_mint, output_mint, expected_input_amount, expected_output_amount,
              signed_tx_digest, broadcast_started_at, broadcast_count)
             VALUES ($1, $2, $3, $4, 'fixture', $5, 'signed', $6, $7, $8, $9, $10,
                     $11, CURRENT_TIMESTAMP, 1)`,
            [leaseId, quote.id, userId, wallet, `lease-${marker}-execution`, '6'.repeat(88),
                sol, usdc, '3000000', quote.outputAmount, 'e'.repeat(64)]
        );

        let startResolve!: () => void;
        let responseResolve!: (response: Response) => void;
        const started = new Promise<void>((resolve) => { startResolve = resolve; });
        const response = new Promise<Response>((resolve) => { responseResolve = resolve; });
        const firstFetch = async () => {
            startResolve();
            return response;
        };
        const secondFetch = vi.fn(async () => Response.json({
            jsonrpc: '2.0', result: { value: [] },
        }));
        const { ExecutionReconciler } = await import('../src/services/execution/executionReconciler');
        const first = new ExecutionReconciler(
            'https://rpc.example.com', query, transaction, firstFetch as typeof fetch
        );
        const second = new ExecutionReconciler(
            'https://rpc.example.com', query, transaction, secondFetch as typeof fetch
        );
        const running = first.runBatch();
        await started;

        const lease = await query(
            `SELECT EXTRACT(EPOCH FROM (op_lease_until - CURRENT_TIMESTAMP)) * 1000 AS remaining_ms
               FROM trade_executions WHERE id = $1`,
            [leaseId]
        );
        expect(Number(lease.rows[0].remaining_ms)).toBeGreaterThan(5000);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(second.runBatch()).resolves.toEqual({ checked: 0, updated: 0 });
        expect(secondFetch).not.toHaveBeenCalled();

        responseResolve(Response.json({
            jsonrpc: '2.0',
            result: { value: [{ slot: 85, err: null, confirmationStatus: 'processed' }] },
        }));
        await expect(running).resolves.toEqual({ checked: 1, updated: 1 });
        const recovered = await query('SELECT state, op_token, op_lease_until FROM trade_executions WHERE id = $1', [leaseId]);
        expect(recovered.rows[0]).toMatchObject({ state: 'processed', op_token: null, op_lease_until: null });
    }, 10_000);

    it('fences a second worker while a late rate reservation crosses the deadline', async () => {
        const { ExecutionService } = await import('../src/services/execution/executionService');
        const { FixtureSwapProvider } = await import('../src/services/execution/fixtureSwapProvider');
        const { JupiterSwapProvider } = await import('../src/services/execution/jupiterSwapProvider');
        const { redisStreams } = await import('../src/services/redisStreamService');
        const fixture = new FixtureSwapProvider();
        const jupiter = new JupiterSwapProvider();
        await redisStreams.connect();
        await redisStreams.command.del(
            'provider:gate:jupiter:execute',
            'provider:sliding:jupiter:execute'
        );
        let reserveResolve!: (delay: number) => void;
        const reserve = new Promise<number>((resolve) => { reserveResolve = resolve; });
        const sliding = vi.spyOn(redisStreams, 'reserveSliding').mockReturnValueOnce(reserve);
        const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
        const originalFetch = global.fetch;
        global.fetch = fetcher as typeof fetch;
        let calls = 0;
        let running: Promise<unknown> | undefined;
        const provider = {
            name: 'fixture' as const,
            quote: fixture.quote.bind(fixture),
            submit: async (
                input: { providerQuoteId: string; signedTransaction: string },
                call?: { signal?: AbortSignal }
            ) => {
                calls += 1;
                return jupiter.submit(input, call);
            },
        };
        try {
            const first = new ExecutionService(provider, query, transaction);
            const second = new ExecutionService(provider, query, transaction);
            const quote = await first.createQuote(userId, {
                inputMint: sol,
                outputMint: usdc,
                inputAmount: '4000000',
                taker: wallet,
                slippageBps: 100,
            });
            const request = {
                signedTransaction: quote.transaction,
                idempotencyKey: `operation-${marker}-execution`,
            };
            const startedAt = Date.now();
            running = first.submit(userId, quote.id, request, `trace-${marker}-operation-1`);
            await vi.waitFor(() => expect(sliding).toHaveBeenCalledOnce());

            const claimed = await query(
                `SELECT id, EXTRACT(EPOCH FROM (op_lease_until - CURRENT_TIMESTAMP)) * 1000 AS remaining_ms
                   FROM trade_executions WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, request.idempotencyKey]
            );
            operationId = claimed.rows[0].id;
            expect(Number(claimed.rows[0].remaining_ms)).toBeGreaterThan(5000);
            await expect(second.submit(
                userId, quote.id, request, `trace-${marker}-operation-2`
            )).rejects.toMatchObject({ code: 'execution_in_progress', retryable: true });
            expect(calls).toBe(1);

            await expect(running).rejects.toMatchObject({ code: 'submission_ambiguous' });
            expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
            const ambiguous = await query(
                `SELECT state, provider_status, broadcast_count, op_token, op_lease_until
                   FROM trade_executions WHERE id = $1`,
                [operationId]
            );
            expect(ambiguous.rows[0]).toMatchObject({
                state: 'signed',
                provider_status: 'ambiguous:timeout',
                broadcast_count: 1,
                op_token: null,
                op_lease_until: null,
            });
            reserveResolve(0);
            await new Promise((resolve) => setImmediate(resolve));
            expect(fetcher).not.toHaveBeenCalled();
            expect(calls).toBe(1);
        } finally {
            reserveResolve(0);
            await running?.catch(() => undefined);
            await new Promise((resolve) => setImmediate(resolve));
            sliding.mockRestore();
            global.fetch = originalFetch;
            await redisStreams.command.del(
                'provider:gate:jupiter:execute',
                'provider:sliding:jupiter:execute'
            );
            await redisStreams.close();
        }
    }, 10_000);

    it('reports the complete database recovery hot set', async () => {
        const { collectOpsMetrics } = await import('../src/services/observability');
        const before = await collectOpsMetrics(query);
        await query(
            `WITH data AS (
                SELECT sequence, gen_random_uuid() AS quote_id,
                       concat('observe-${marker}-', sequence) AS request_id
                  FROM generate_series(1, 6) AS series(sequence)
             ), quotes AS (
                INSERT INTO trade_quotes
                (id, user_id, wallet_address, provider, provider_quote_id, input_mint, output_mint,
                 input_amount, output_amount, min_output_amount, slippage_bps, fee_payer,
                 transaction_digest, integrity_digest, state, expires_at)
                SELECT quote_id, $1, $2, 'fixture', request_id, $3, $4,
                       '1', '1', '1', 100, $2, repeat('d', 64), repeat('e', 64),
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
                    repeat('8', 88), $3, $4, '1', '1', repeat('f', 64),
                    CASE WHEN sequence <= 2 THEN 'ambiguous:timeout' ELSE NULL END,
                    CASE WHEN sequence = 1 THEN CURRENT_TIMESTAMP - INTERVAL '7 minutes' ELSE NULL END,
                    CASE WHEN sequence = 1 THEN 2 ELSE 0 END,
                    CASE WHEN sequence IN (2, 3, 4, 6)
                         THEN CURRENT_TIMESTAMP - INTERVAL '7 minutes'
                         ELSE NULL END,
                    CURRENT_TIMESTAMP - INTERVAL '8 minutes',
                    CURRENT_TIMESTAMP - INTERVAL '8 minutes'
               FROM data JOIN quotes ON quotes.id = data.quote_id`,
            [userId, wallet, sol, usdc]
        );

        const after = await collectOpsMetrics(query);
        expect(after.executionRecoveries - before.executionRecoveries).toBe(4);
        expect(after.executionAmbiguous - before.executionAmbiguous).toBe(2);
        expect(after.executionRepeated - before.executionRepeated).toBe(1);
        expect(after.executions - before.executions).toBe(5);
        expect(after.executionRecoveryAgeMs).not.toBeNull();
        expect(after.executionRecoveryAgeMs!).toBeGreaterThanOrEqual(6 * 60 * 1000);
    });

    it('uses the online partial index for a production-shaped recovery hot set', async () => {
        await query(
            `WITH data AS (
                SELECT sequence, gen_random_uuid() AS quote_id,
                       concat('plan-${marker}-', sequence) AS request_id
                  FROM generate_series(1, 20000) AS series(sequence)
             ), quotes AS (
                INSERT INTO trade_quotes
                (id, user_id, wallet_address, provider, provider_quote_id, input_mint, output_mint,
                 input_amount, output_amount, min_output_amount, slippage_bps, fee_payer,
                 transaction_digest, integrity_digest, state, expires_at)
                SELECT quote_id, $1, $2, 'fixture', request_id, $3, $4,
                       '1', '1', '1', 100, $2, repeat('a', 64), repeat('b', 64),
                       'consumed', CURRENT_TIMESTAMP + INTERVAL '1 day'
                  FROM data
                RETURNING id
             )
             INSERT INTO trade_executions
             (id, quote_id, user_id, wallet_address, provider, idempotency_key, state,
              signature, input_mint, output_mint, expected_input_amount, expected_output_amount,
              signed_tx_digest, broadcast_started_at, broadcast_count, submitted_at,
              created_at, updated_at)
             SELECT gen_random_uuid(), data.quote_id, $1, $2, 'fixture', data.request_id,
                    CASE WHEN sequence <= 8 THEN 'signed'
                         WHEN sequence <= 16 THEN 'submitted'
                         WHEN sequence <= 24 THEN 'processed'
                         WHEN sequence <= 32 THEN 'confirmed'
                         ELSE 'finalized' END,
                    repeat('7', 88), $3, $4, '1', '1', repeat('c', 64),
                    CASE WHEN sequence <= 8 THEN CURRENT_TIMESTAMP ELSE NULL END,
                    CASE WHEN sequence <= 8 THEN 1 ELSE 0 END,
                    CASE WHEN sequence BETWEEN 9 AND 32 THEN CURRENT_TIMESTAMP ELSE NULL END,
                    CURRENT_TIMESTAMP - (sequence::text || ' seconds')::interval,
                    CURRENT_TIMESTAMP - (sequence::text || ' seconds')::interval
               FROM data JOIN quotes ON quotes.id = data.quote_id`,
            [userId, wallet, sol, usdc]
        );
        await query('ANALYZE trade_executions');
        const explained = await query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
             SELECT id
               FROM trade_executions
              WHERE signature IS NOT NULL
                AND idempotency_key LIKE $1
                AND (state IN ('submitted', 'processed', 'confirmed')
                     OR (state = 'signed' AND broadcast_started_at IS NOT NULL))
                AND (op_lease_until IS NULL OR op_lease_until <= NOW())
                AND ((hashtextextended(id::text, 0) & 9223372036854775807) % 1) = 0
              ORDER BY updated_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 256`,
            [`plan-${marker}-%`]
        );
        const plan = explained.rows[0]['QUERY PLAN'][0].Plan as Record<string, any>;
        const indexes = new Set<string>();
        const collectPlan = (node: Record<string, any>): void => {
            if (node['Index Name']) indexes.add(node['Index Name']);
            expect(node['Node Type']).not.toBe('Seq Scan');
            for (const child of node.Plans || []) collectPlan(child);
        };
        collectPlan(plan);
        expect([
            'trade_exec_reconcile_due_idx',
            'trade_exec_recovery_stats_idx',
        ].some((index) => indexes.has(index))).toBe(true);
        expect(plan['Actual Rows']).toBe(32);
    }, 15_000);
});
