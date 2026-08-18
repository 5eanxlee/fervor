import crypto, { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbQuery } from '../src/config/database';
import type { OrderProvider } from '../src/services/orders/provider';
import { OrderProviderError } from '../src/services/orders/provider';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;
const url = () => process.env.INFRA_DATABASE_URL ?? process.env.CORE_DATABASE_URL ?? process.env.DATABASE_URL
    ?? 'postgresql://fervor@localhost:55432/fervor';

const want = { orderType: 'single', triggerPriceUsd: 300 };
const factHash = crypto.createHash('sha256').update(JSON.stringify(want)).digest('hex');

suite('order ambiguity infrastructure', () => {
    const first = new pg.Client({ connectionString: url() });
    const second = new pg.Client({ connectionString: url() });
    const userId = randomUUID();
    const orderIds: string[] = [];
    let OrderService: typeof import('../src/services/orders/orderService').OrderService;

    beforeAll(async () => {
        process.env.ORDER_MODE = 'disabled';
        process.env.DATABASE_URL = url();
        process.env.CORE_DATABASE_URL = url();
        process.env.MARKET_DATABASE_URL = url();
        process.env.DB_COLOCATED = 'true';
        await Promise.all([first.connect(), second.connect()]);
        ({ OrderService } = await import('../src/services/orders/orderService'));
        await first.query(
            'INSERT INTO users (id, wallet_address) VALUES ($1, $2)',
            [userId, `AmbiguityWallet${randomBytes(8).toString('hex')}`]
        );
    });

    afterAll(async () => {
        await first.query(`
            UPDATE order_intents
               SET error_code = NULL, error_message = NULL,
                   op_token = NULL, op_lease_until = NULL,
                   op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                   op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                   op_writer = NULL
             WHERE user_id = $1 AND op_state IS NOT NULL
        `, [userId]);
        await first.query('DELETE FROM users WHERE id = $1', [userId]);
        await Promise.all([first.end(), second.end()]);
    });

    const addOrder = async (): Promise<string> => {
        const orderId = randomUUID();
        orderIds.push(orderId);
        await first.query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, provider_order_id
            ) VALUES (
                $1, $2, 'jupiter_trigger_v2', $3, repeat('a', 64), $4,
                'single', 'open', $5, $6, 1, $6,
                '{"triggerPriceUsd":250}'::jsonb, clock_timestamp() + INTERVAL '1 day', $7
            )
        `, [
            orderId, userId, `ambiguity-${randomUUID()}`,
            '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE',
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            `provider-${orderId}`,
        ]);
        return orderId;
    };

    const provider = (update: ReturnType<typeof vi.fn>) => ({
        name: 'jupiter_trigger_v2',
        requiresAuth: false,
        custody: 'none',
        update,
    }) as unknown as OrderProvider;

    it('rejects a stale reader after another session records an unknown fact', async () => {
        const orderId = await addOrder();
        const update = vi.fn();
        let firstRead = true;
        const db = (async (sql: string, values?: unknown[]) => {
            const result = await first.query(sql, values);
            if (firstRead && sql.startsWith('SELECT * FROM order_intents')) {
                firstRead = false;
                await second.query('BEGIN');
                try {
                    await second.query(`
                        UPDATE order_intents
                           SET op_token = 'ambiguity-race',
                               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
                               op_kind = 'edit', op_state = 'reserved',
                               op_req_hash = repeat('b', 64), op_want_hash = $2,
                               op_detail = $3::jsonb, op_writer = 2, op_ver = op_ver + 1
                         WHERE id = $1
                    `, [orderId, factHash, JSON.stringify({ request: want, want })]);
                    await second.query(`
                        UPDATE order_intents
                           SET op_state = 'started', op_started_at = clock_timestamp()
                         WHERE id = $1
                    `, [orderId]);
                    await second.query(`
                    UPDATE order_intents
                       SET error_code = 'provider_outcome_unknown', unknown_at = clock_timestamp(),
                           unknown_detail = '{"providerCode":"provider_timeout"}'::jsonb,
                           op_token = NULL, op_lease_until = NULL, op_ver = op_ver + 1
                     WHERE id = $1
                    `, [orderId]);
                    await second.query('COMMIT');
                } catch (error) {
                    await second.query('ROLLBACK');
                    throw error;
                }
            }
            return result;
        }) as DbQuery;
        const service = new OrderService(provider(update), db, async (work) => work(db));

        await expect(service.update(userId, orderId, want))
            .rejects.toMatchObject({ code: 'order_reconciliation_required' });
        expect(update).not.toHaveBeenCalled();
    });

    it('keeps the replay block committed when the event transaction rolls back', async () => {
        const orderId = await addOrder();
        const update = vi.fn().mockRejectedValue(new OrderProviderError(
            'provider_timeout', 'provider response was lost', true, 504, undefined, true
        ));
        const db = ((sql: string, values?: unknown[]) => first.query(sql, values)) as DbQuery;
        const service = new OrderService(provider(update), db, async () => {
            throw new Error('forced event transaction rollback');
        });

        await expect(service.update(userId, orderId, want))
            .rejects.toMatchObject({ code: 'provider_timeout', uncertain: true });
        const stored = await second.query(`
            SELECT error_code, op_state, op_token, op_kind, op_req_hash,
                   op_want_hash, op_writer, op_ver, unknown_at, unknown_detail
              FROM order_intents WHERE id = $1
        `, [orderId]);
        expect(stored.rows[0]).toMatchObject({
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_token: null,
            op_kind: 'edit',
            op_want_hash: factHash,
            op_writer: 2,
            op_ver: '2',
        });
        expect(stored.rows[0].unknown_at).toBeInstanceOf(Date);

        await expect(service.update(userId, orderId, want))
            .rejects.toMatchObject({ code: 'order_reconciliation_required' });
        expect(update).toHaveBeenCalledOnce();
    });

    it('cannot clear a later same-hash operation with an earlier history response', async () => {
        const orderId = await addOrder();
        const detail = JSON.stringify({ request: want, want });
        await first.query(`
            UPDATE order_intents
               SET op_token = 'old-ambiguity',
                   op_lease_until = clock_timestamp() + INTERVAL '1 minute',
                   op_kind = 'edit', op_state = 'reserved',
                   op_req_hash = repeat('d', 64), op_want_hash = $2,
                   op_detail = $3::jsonb, op_writer = 2, op_ver = op_ver + 1
             WHERE id = $1
        `, [orderId, factHash, detail]);
        await first.query(`
            UPDATE order_intents
               SET op_state = 'started', op_started_at = clock_timestamp()
             WHERE id = $1
        `, [orderId]);
        await first.query(`
            UPDATE order_intents
               SET error_code = 'provider_outcome_unknown', unknown_at = clock_timestamp(),
                   unknown_detail = jsonb_build_object(
                       'providerCode', 'provider_timeout',
                       'evidence', jsonb_build_object('providerOrderId', provider_order_id)
                   ),
                   op_token = NULL, op_lease_until = NULL, op_ver = op_ver + 1
             WHERE id = $1
        `, [orderId]);

        let historyDone = false;
        let installed = false;
        const history = vi.fn(async () => {
            historyDone = true;
            return [{
                providerOrderId: `provider-${orderId}`,
                state: 'open' as const,
                triggerPriceUsd: 300,
                updatedAt: '2100-01-01T00:00:00.000Z',
            }];
        });
        const db = (async (sql: string, values?: unknown[]) => {
            if (historyDone && !installed && sql.includes('UPDATE order_intents')) {
                installed = true;
                await second.query('BEGIN');
                try {
                    await second.query(`
                        UPDATE order_intents
                           SET error_code = NULL, error_message = NULL,
                               op_kind = NULL, op_state = NULL,
                               op_req_hash = NULL, op_want_hash = NULL, op_detail = NULL,
                               op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                               op_writer = NULL
                         WHERE id = $1
                    `, [orderId]);
                    await second.query(`
                        UPDATE order_intents
                           SET op_token = 'new-ambiguity',
                               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
                               op_kind = 'edit', op_state = 'reserved',
                               op_req_hash = repeat('d', 64), op_want_hash = $2,
                               op_detail = $3::jsonb, op_writer = 2, op_ver = op_ver + 1
                         WHERE id = $1
                    `, [orderId, factHash, detail]);
                    await second.query(`
                        UPDATE order_intents
                           SET op_state = 'started', op_started_at = clock_timestamp()
                         WHERE id = $1
                    `, [orderId]);
                    await second.query(`
                        UPDATE order_intents
                           SET error_code = 'provider_outcome_unknown', unknown_at = clock_timestamp(),
                               unknown_detail = jsonb_build_object(
                                   'providerCode', 'provider_timeout',
                                   'evidence', jsonb_build_object('providerOrderId', provider_order_id)
                               ),
                               op_token = NULL, op_lease_until = NULL, op_ver = op_ver + 1
                         WHERE id = $1
                    `, [orderId]);
                    await second.query('COMMIT');
                } catch (error) {
                    await second.query('ROLLBACK');
                    throw error;
                }
            }
            return first.query(sql, values);
        }) as DbQuery;
        const syncProvider = {
            ...provider(vi.fn()),
            history,
        } as unknown as OrderProvider;
        const service = new OrderService(syncProvider, db, async (work) => work(db));

        await service.sync(userId);
        const stored = await first.query(`
            SELECT error_code, op_state, op_want_hash, op_ver
              FROM order_intents WHERE id = $1
        `, [orderId]);
        expect(history).toHaveBeenCalledOnce();
        expect(installed).toBe(true);
        expect(stored.rows[0]).toMatchObject({
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_want_hash: factHash,
            op_ver: '4',
        });
    });
});
