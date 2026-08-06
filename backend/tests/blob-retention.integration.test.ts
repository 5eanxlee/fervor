import { randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

suite('blob retention infrastructure', () => {
    let closeDatabase: typeof import('../src/config/database').closeDatabase;
    let getClient: typeof import('../src/config/database').getClient;
    let query: typeof import('../src/config/database').query;
    let transaction: typeof import('../src/config/database').transaction;
    let retention: import('../src/services/orders/blobRetention').BlobRetention;

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= process.env.INFRA_DATABASE_URL
            ?? process.env.DATABASE_URL ?? 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        ({ query, getClient, transaction, closeDatabase } = await import('../src/config/database'));
        const { BlobRetention } = await import('../src/services/orders/blobRetention');
        retention = new BlobRetention({ getClient, close: closeDatabase }, 1, 2_000);
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it('skips locked aggregates and tombstones expired envelopes in bounded batches', async () => {
        const marker = randomBytes(6).toString('hex');
        const userId = randomUUID();
        const wallet = bs58.encode(randomBytes(32));
        const provider = `ret_${marker}`;
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(`
            INSERT INTO order_epochs (
                scope, epoch, region, mode, authority, proof_hash, source_key
            ) VALUES (
                $1, 1, 'ci', 'live', 'integration',
                repeat('f', 64), $2
            )
        `, [`provider:${provider}`, `retention:epoch:${marker}`]);

        const createBlob = async (terminal: boolean) => {
            const orderId = randomUUID();
            const actionId = randomUUID();
            const message = randomBytes(32).toString('hex');
            const signature = '6'.repeat(88);
            await query(`
                INSERT INTO order_intents (
                    id, user_id, provider, client_order_id, request_digest, wallet_address,
                    order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                    params, expires_at, cluster, family, strategy_kind, trigger_state,
                    fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
                ) VALUES (
                    $1, $2, $3, $4, repeat('a', 64), $5, 'single', 'prepared',
                    $6, $7, 1, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                    'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                    1, 0, 0, 1
                )
            `, [orderId, userId, provider, `retention-${marker}-${actionId}`,
                wallet, inputMint, outputMint]);
            await query(`
                INSERT INTO order_actions (
                    id, order_id, user_id, kind, client_key, req_hash, desired_hash,
                    expected_ver, work_state, effect_state, outcome, provider, message_hash,
                    first_signature, due_at
                ) VALUES (
                    $1, $2, $3, 'provider_sync', $4, repeat('b', 64), repeat('c', 64),
                    0, 'queued', 'not_possible', 'pending',
                    $5, $6, $7, clock_timestamp()
                )
            `, [actionId, orderId, userId, `retention:${marker}:${actionId}`,
                provider, message, signature]);
            if (terminal) {
                await query(`
                    UPDATE order_actions
                       SET action_ver = 1, work_state = 'ready',
                           lease_owner = 'retention-fixture', lease_gen = 1,
                           lease_until = clock_timestamp() + INTERVAL '5 minutes',
                           write_scope = $2, write_epoch = 1
                     WHERE id = $1
                `, [actionId, `provider:${provider}`]);
                await query(`
                    UPDATE order_actions
                       SET action_ver = 2, work_state = 'dispatching',
                           effect_state = 'possible', ambiguity_at = clock_timestamp(),
                           attempt_count = 1
                     WHERE id = $1
                `, [actionId]);
                await transaction(async (db) => {
                    await db(`
                        INSERT INTO action_obs (
                            id, action_id, source, cluster, source_key, fact_key, fact_rev,
                            query_kind, verdict, predicate, rule_ver, provider, norm_state,
                            desired_hash, effect_hash, provider_order_id,
                            payload_hash, payload_ver, payload
                        ) VALUES (
                            gen_random_uuid(), $1, 'provider', 'mainnet-beta', $2, $3, 1,
                            'found', 'presence', 'provider_sync.provider.effect.v1', 1,
                            $4, 'present', repeat('c', 64), repeat('c', 64),
                            $5, repeat('d', 64), 1, '{}'
                        )
                    `, [actionId, `retention:source:${actionId}`,
                        `retention:fact:${actionId}`, provider, `provider:${actionId}`]);
                    await db(`
                        UPDATE order_actions
                           SET action_ver = 3, work_state = 'done', effect_state = 'present',
                               outcome = 'succeeded', completed_at = clock_timestamp(),
                               lease_owner = NULL, lease_until = NULL,
                               write_scope = NULL, write_epoch = NULL
                         WHERE id = $1
                    `, [actionId]);
                });
            }
            await query(`
                INSERT INTO order_tx_blobs (
                    action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
                    wrapped_key, key_id, aad_hash, message_hash, raw_hash,
                    first_signature, byte_size, expires_at, aad_ver
                ) VALUES (
                    $1, $2, 'mainnet-beta', $3, 'aes_256_gcm',
                    decode(repeat('44', 33), 'hex'), decode(repeat('55', 12), 'hex'),
                    decode(repeat('66', 32), 'hex'), 'kms:retention', repeat('d', 64),
                    $4, repeat('e', 64), $5, 256,
                    clock_timestamp() + INTERVAL '100 milliseconds', 2
                )
            `, [actionId, orderId, wallet, message, signature]);
            return { actionId, orderId };
        };

        const first = await createBlob(true);
        const second = await createBlob(true);
        const pending = await createBlob(false);
        await new Promise((resolve) => setTimeout(resolve, 150));

        const blocker = await getClient();
        try {
            await blocker.query('BEGIN');
            await blocker.query(
                'SELECT id FROM order_intents WHERE id = ANY($1::uuid[]) FOR UPDATE',
                [[first.orderId, second.orderId]]
            );
            await expect(retention.runBatch(10)).resolves.toBe(0);
            await blocker.query('COMMIT');
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            blocker.release();
        }

        await expect(retention.runBatch()).resolves.toBe(1);
        await expect(retention.runBatch()).resolves.toBe(1);
        await expect(retention.runBatch()).resolves.toBe(0);

        const rows = await query(`
            SELECT action_id, key_id, destroy_ref, purged_at IS NOT NULL AS purged,
                   octet_length(ciphertext) AS cipher_size,
                   octet_length(wrapped_key) AS key_size
              FROM order_tx_blobs
             WHERE action_id = ANY($1::uuid[])
             ORDER BY action_id
        `, [[first.actionId, second.actionId, pending.actionId]]);
        const tombstones = rows.rows.filter((row) => row.action_id !== pending.actionId);
        expect(tombstones).toHaveLength(2);
        for (const row of tombstones) {
            expect(row).toMatchObject({
                key_id: 'destroyed', purged: true, cipher_size: 17, key_size: 32,
            });
            expect(row.destroy_ref).toMatch(
                new RegExp(`^retention:[0-9a-f-]{36}:${row.action_id}$`)
            );
        }
        expect(rows.rows.find((row) => row.action_id === pending.actionId)).toMatchObject({
            key_id: 'kms:retention', purged: false,
        });
    });
});
