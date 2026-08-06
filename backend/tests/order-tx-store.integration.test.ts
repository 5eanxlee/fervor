import { randomBytes, randomUUID } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

const transaction = () => {
    const signer = nacl.sign.keyPair();
    const message = Buffer.concat([
        Buffer.from([1, 0, 1, 2]),
        Buffer.from(signer.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 12),
        Buffer.from([0]),
    ]);
    const signature = nacl.sign.detached(message, signer.secretKey);
    return {
        wallet: bs58.encode(signer.publicKey),
        prepared: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64'),
        signed: Buffer.concat([
            Buffer.from([1]), Buffer.from(signature), message,
        ]).toString('base64'),
    };
};

suite('order transaction store infrastructure', () => {
    let closeDatabase: typeof import('../src/config/database').closeDatabase;
    let getClient: typeof import('../src/config/database').getClient;
    let query: typeof import('../src/config/database').query;
    let actions: import('../src/services/orders/orderActionStore').OrderActionStore;
    let txs: import('../src/services/orders/orderTxStore').OrderTxStore;
    let OrderTxStore: typeof import('../src/services/orders/orderTxStore').OrderTxStore;
    const dataKey = randomBytes(32);

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= process.env.INFRA_DATABASE_URL ?? process.env.DATABASE_URL
            ?? 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        ({ query, getClient, closeDatabase } = await import('../src/config/database'));
        const { OrderActionStore } = await import('../src/services/orders/orderActionStore');
        ({ OrderTxStore } = await import('../src/services/orders/orderTxStore'));
        actions = new OrderActionStore();
        txs = new OrderTxStore(undefined, {
            generate: async () => ({
                plaintext: Buffer.from(dataKey),
                wrapped: randomBytes(160),
                keyId: `arn:aws:kms:us-west-2:123456789012:key/${'k'.repeat(150)}`,
            }),
            unwrap: async () => Buffer.from(dataKey),
        });
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it('commits prepared identity, encrypted bytes, and blob-gated claims atomically', async () => {
        const marker = randomBytes(8).toString('hex');
        const wire = transaction();
        const userId = randomUUID();
        const actionId = randomUUID();
        const orderId = randomUUID();
        const emptyActionId = randomUUID();
        const emptyOrderId = randomUUID();
        const provider = `tx_fixture_${marker}`;
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wire.wallet]);
        for (const [id, clientId] of [
            [orderId, `tx-order-${marker}`],
            [emptyOrderId, `empty-order-${marker}`],
        ]) {
            await query(`
                INSERT INTO order_intents (
                    id, user_id, provider, client_order_id, request_digest, wallet_address,
                    order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                    params, expires_at, cluster, family, strategy_kind, trigger_state,
                    fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
                ) VALUES (
                    $1, $2, $3, $4, repeat('c', 64), $5, 'single', 'prepared',
                    $6, $7, 1000, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                    'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                    1000, 0, 0, 1
                )
            `, [id, userId, provider, clientId, wire.wallet, inputMint, outputMint]);
        }
        await query(`
            INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
            VALUES ($1, 1, 'ci', 'live', 'integration', repeat('d', 64), $2)
        `, [`provider:${provider}`, `tx:epoch:${marker}:1`]);

        const admit = (id: string, target: string, key: string) => actions.admit({
            id,
            orderId: target,
            userId,
            kind: 'cancel_confirm',
            ruleVer: 1,
            clientKey: key,
            reqHash: 'a'.repeat(64),
            desiredHash: 'b'.repeat(64),
            expectedVer: '0',
            provider,
            dueAt: new Date(Date.now() - 1_000).toISOString(),
            traceId: `trace-${key}`,
            actor: 'user',
        });
        await admit(actionId, orderId, `confirm:${marker}`);
        await admit(emptyActionId, emptyOrderId, `empty:${marker}`);
        await query(`
            UPDATE order_actions
               SET action_ver = 1, work_state = 'awaiting_sig',
                   message_hash = repeat('1', 64), recent_blockhash = repeat('2', 44),
                   last_valid_height = 500000000
             WHERE id = $1
        `, [emptyActionId]);
        await query(`
            UPDATE order_actions
               SET action_ver = 2, work_state = 'ready', first_signature = repeat('3', 88)
             WHERE id = $1
        `, [emptyActionId]);

        await expect(txs.expect({
            actionId,
            expectedVer: '0',
            preparedTx: wire.prepared,
            lastValidHeight: '500000000',
            traceId: `trace-expect-${marker}`,
            actor: 'provider',
        })).resolves.toMatchObject({ replayed: false });
        const bound = await txs.bind({
            actionId,
            expectedVer: '1',
            signedTx: wire.signed,
            traceId: `trace-bind-${marker}`,
            actor: 'user',
        });
        await expect(txs.bind({
            actionId,
            expectedVer: '1',
            signedTx: wire.signed,
            traceId: `trace-bind-${marker}`,
            actor: 'user',
        })).resolves.toMatchObject({ replayed: true, binding: bound.binding });

        const stored = await query(`
            SELECT action.work_state, action.action_ver, action.message_hash,
                   action.first_signature, action.recent_blockhash,
                   blob.ciphertext, blob.key_id, blob.aad_hash, blob.aad_ver,
                   blob.raw_hash, blob.byte_size,
                   array_agg(event.event_type ORDER BY event.occurred_at) AS events
              FROM order_actions action
              JOIN order_tx_blobs blob ON blob.action_id = action.id
              JOIN order_events event ON event.action_id = action.id
             WHERE action.id = $1
             GROUP BY action.id, blob.action_id
        `, [actionId]);
        expect(stored.rows[0]).toMatchObject({
            work_state: 'ready',
            action_ver: '2',
            message_hash: bound.binding.messageHash,
            first_signature: bound.binding.firstSignature,
            recent_blockhash: bound.binding.recentBlockhash,
            aad_hash: bound.binding.aadHash,
            aad_ver: 2,
            raw_hash: bound.binding.rawHash,
            byte_size: bound.binding.byteSize,
        });
        expect(stored.rows[0].key_id.length).toBeGreaterThan(128);
        expect(stored.rows[0].ciphertext.equals(Buffer.from(wire.signed, 'base64'))).toBe(false);
        expect(stored.rows[0].events).toEqual([
            'action.admitted', 'action.awaiting_signature', 'action.signed',
        ]);

        const blocker = await getClient();
        const replayClient = await getClient();
        const purgeClient = await getClient();
        let blocked = false;
        let blockerDone = false;
        try {
            await blocker.query('BEGIN');
            await blocker.query(
                'SELECT 1 FROM order_intents WHERE id = $1 FOR UPDATE',
                [orderId]
            );
            await replayClient.query("SET application_name = 'fervor-tx-replay-lock'");
            await purgeClient.query("SET application_name = 'fervor-tx-purge-lock'");
            const replayDb = {
                query: (text: string, params?: unknown[]) => replayClient.query(text, params),
                transaction: async <T>(work: (db: typeof query) => Promise<T>): Promise<T> => {
                    await replayClient.query('BEGIN');
                    try {
                        const value = await work((text, params) => replayClient.query(text, params));
                        await replayClient.query('COMMIT');
                        return value;
                    } catch (error) {
                        await replayClient.query('ROLLBACK');
                        throw error;
                    }
                },
            };
            const replayStore = new OrderTxStore(replayDb as never, {
                generate: async () => { throw new Error('replay generated a key'); },
                unwrap: async () => Buffer.from(dataKey),
            });
            const replay = replayStore.expect({
                actionId,
                expectedVer: '0',
                preparedTx: wire.prepared,
                lastValidHeight: '500000000',
                traceId: `trace-lock-replay-${marker}`,
                actor: 'provider',
            });
            const purge = purgeClient.query(
                "SELECT purge_order_tx_blob($1, 'integration-lock-proof', clock_timestamp())",
                [actionId]
            ).then(() => null, (error) => error);
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const waits = await query(`
                    SELECT application_name, wait_event_type
                      FROM pg_stat_activity
                     WHERE application_name IN ('fervor-tx-replay-lock', 'fervor-tx-purge-lock')
                `);
                blocked = waits.rowCount === 2
                    && waits.rows.every((row) => row.wait_event_type === 'Lock');
                if (blocked) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (!blocked) throw new Error('Replay and purge did not converge on the aggregate lock');
            await blocker.query('COMMIT');
            blockerDone = true;
            await expect(replay).resolves.toMatchObject({ replayed: true });
            const purgeError = await purge;
            expect(purgeError).toBeInstanceOf(Error);
            expect(purgeError).not.toMatchObject({ code: '40P01' });
        } finally {
            if (!blockerDone) await blocker.query('ROLLBACK').catch(() => {});
            await replayClient.query('ROLLBACK').catch(() => {});
            blocker.release();
            replayClient.release();
            purgeClient.release();
        }

        const claimed = await actions.claim({
            provider,
            owner: `tx-worker-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 10,
        });
        expect(claimed.map((action) => action.id)).toEqual([actionId]);
        const active = claimed[0];
        const started = await actions.start({
            id: randomUUID(),
            actionId,
            expectedVer: active.version,
            fence: active.lease!,
            endpoint: '/trigger/v2/orders/price/confirm-cancel/provider-order',
            method: 'POST',
            reqHash: active.reqHash,
            bodyHash: 'e'.repeat(64),
            blobActionId: actionId,
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId: `trace-start-${marker}`,
            actor: 'system',
        });
        const access = {
            actionId,
            attemptId: started.attempt.id,
            accessKey: `dispatch:${marker}`,
            fence: active.lease!,
            gateway: `tx-gateway-${marker}`,
            purpose: 'dispatch' as const,
        };
        let borrowed = Buffer.alloc(0);
        const recovered = await txs.withTx(access, (bytes) => {
            borrowed = bytes;
            return Buffer.from(bytes);
        });
        expect(recovered).toEqual(Buffer.from(wire.signed, 'base64'));
        expect(borrowed).toEqual(Buffer.alloc(recovered.length));
        await expect(txs.withTx(access, (bytes) => Buffer.from(bytes)))
            .resolves.toEqual(recovered);
        await expect(txs.withTx({ ...access, gateway: 'wrong-gateway' }, () => undefined))
            .rejects.toMatchObject({ code: 'idempotency_conflict' });

        const race = await Promise.allSettled([
            txs.withTx({ ...access, accessKey: `dispatch-race:${marker}` }, async (bytes) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return Buffer.from(bytes);
            }),
            actions.respond({
                attemptId: started.attempt.id,
                completedAt: new Date().toISOString(),
                httpClass: 'success',
                httpStatus: 202,
                responseHash: 'f'.repeat(64),
                providerEffectId: `tx-effect-${marker}`,
                traceId: `trace-response-${marker}`,
                actor: 'provider',
            }),
        ]);
        expect(race[1]).toMatchObject({ status: 'fulfilled' });
        if (race[0].status === 'rejected') {
            expect(race[0].reason).not.toMatchObject({ code: '40P01' });
        } else {
            expect(race[0].value).toEqual(recovered);
        }
        await expect(txs.withTx(access, () => undefined))
            .rejects.toMatchObject({ code: '40001' });
    });
});
