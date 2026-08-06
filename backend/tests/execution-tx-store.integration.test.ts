import { randomBytes, randomUUID } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

suite('execution transaction blob infrastructure', () => {
    let query: typeof import('../src/config/database').query;
    let transaction: typeof import('../src/config/database').transaction;
    const wallet = bs58.encode(nacl.sign.keyPair().publicKey);
    const sol = 'So11111111111111111111111111111111111111112';
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= process.env.INFRA_DATABASE_URL
            ?? 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        ({ query, transaction } = await import('../src/config/database'));
    });

    it('forbids managed broadcast until the exact immutable blob exists', async () => {
        const userId = randomUUID();
        const quoteId = randomUUID();
        const executionId = randomUUID();
        const messageHash = 'a'.repeat(64);
        const rawHash = randomBytes(32).toString('hex');
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(
            `INSERT INTO trade_quotes (
                id, user_id, wallet_address, provider, provider_quote_id,
                input_mint, output_mint, input_amount, output_amount,
                min_output_amount, slippage_bps, fee_payer, transaction_digest,
                integrity_digest, state, expires_at
             ) VALUES (
                $1, $2, $3, 'jupiter_swap_v2', $4, $5, $6, 1, 2, 1, 100,
                $3, $7, repeat('c', 64), 'consumed', clock_timestamp() + INTERVAL '1 hour'
             )`,
            [quoteId, userId, wallet, `blob-${quoteId}`, sol, usdc, messageHash]
        );
        await expect(query(
            `INSERT INTO trade_executions (
                id, quote_id, user_id, wallet_address, provider, idempotency_key,
                state, input_mint, output_mint, expected_input_amount,
                expected_output_amount, signed_tx_digest, broadcast_started_at,
                broadcast_count
             ) VALUES (
                $1, $2, $3, $4, 'jupiter_swap_v2', $5, 'signed', $6, $7, 1, 2,
                $8, clock_timestamp(), 1
             )`,
            [executionId, quoteId, userId, wallet, `blob-${executionId}`, sol, usdc, rawHash]
        )).rejects.toThrow(/persisted before its first broadcast/);

        await query(
            `INSERT INTO trade_executions (
                id, quote_id, user_id, wallet_address, provider, idempotency_key,
                state, input_mint, output_mint, expected_input_amount,
                expected_output_amount, signed_tx_digest
             ) VALUES (
                $1, $2, $3, $4, 'jupiter_swap_v2', $5, 'signed', $6, $7, 1, 2, $8
             )`,
            [executionId, quoteId, userId, wallet, `blob-${executionId}`, sol, usdc, rawHash]
        );

        await expect(query(
            `UPDATE trade_executions
                SET broadcast_started_at = clock_timestamp(), broadcast_count = 1
              WHERE id = $1`,
            [executionId]
        )).rejects.toThrow(/requires a live encrypted transaction blob/);

        await query(
            `INSERT INTO execution_tx_blobs (
                execution_id, quote_id, user_id, provider, provider_quote_id,
                wallet_address, fee_payer,
                alg, ciphertext, nonce, wrapped_key, key_id, aad_hash, message_hash,
                raw_hash, byte_size, aad_ver, expires_at
             ) VALUES (
                $1, $2, $3, 'jupiter_swap_v2', $5, $4, $4, 'aes_256_gcm',
                decode(repeat('11', 17), 'hex'), decode(repeat('22', 12), 'hex'),
                decode(repeat('33', 32), 'hex'), 'test-key', repeat('d', 64),
                $6, $7, 1, 1, clock_timestamp() + INTERVAL '15 minutes'
             )`,
            [executionId, quoteId, userId, wallet, `blob-${quoteId}`, messageHash, rawHash]
        );
        await expect(query(
            `UPDATE trade_quotes
                SET provider_quote_id = 'different-request'
              WHERE id = $1`,
            [quoteId]
        )).rejects.toThrow(/request identity is immutable/);
        await expect(query('SELECT * FROM claim_execution_blob(30000, 1, 0)'))
            .resolves.toMatchObject({ rowCount: 0 });
        await expect(query(
            `UPDATE trade_executions
                SET broadcast_started_at = clock_timestamp(), broadcast_count = 1
              WHERE id = $1`,
            [executionId]
        )).rejects.toThrow(/requires a live encrypted transaction blob/);
        await query(
            `UPDATE trade_executions
                SET op_token = 'foreground-claim',
                    op_lease_until = clock_timestamp() + INTERVAL '1 minute'
              WHERE id = $1`,
            [executionId]
        );
        await expect(query(
            `UPDATE trade_executions
                SET broadcast_started_at = clock_timestamp(), broadcast_count = 1
              WHERE id = $1 AND op_token = 'stale-claim'`,
            [executionId]
        )).resolves.toMatchObject({ rowCount: 0 });
        await expect(query(
            `UPDATE trade_executions
                SET broadcast_started_at = clock_timestamp(), broadcast_count = 1
              WHERE id = $1 AND op_token = 'foreground-claim'`,
            [executionId]
        )).resolves.toMatchObject({ rowCount: 1 });
        await expect(query(
            `UPDATE trade_executions
                SET signed_tx_digest = repeat('e', 64)
              WHERE id = $1`,
            [executionId]
        )).rejects.toThrow(/transaction identity is immutable/);
        await expect(query(
            `UPDATE trade_executions
                SET broadcast_started_at = NULL, broadcast_count = 0
              WHERE id = $1`,
            [executionId]
        )).rejects.toThrow(/broadcast markers are immutable/);
        await expect(query(
            'UPDATE execution_tx_blobs SET key_id = $2 WHERE execution_id = $1',
            [executionId, 'changed']
        )).rejects.toThrow(/immutable/);
        await query(
            `UPDATE trade_executions
                SET state = 'confirmed', op_token = NULL, op_lease_until = NULL
              WHERE id = $1`,
            [executionId]
        );
    });

    it('decrypts and replays the exact crash-window request end to end', async () => {
        const { ExecutionService } = await import('../src/services/execution/executionService');
        const { ExecutionTxStore } = await import('../src/services/execution/executionTxStore');
        const { parseSolanaTransaction } = await import('../src/services/solanaTransaction');
        const pair = nacl.sign.keyPair();
        const swapWallet = bs58.encode(pair.publicKey);
        const message = Buffer.concat([
            Buffer.from([1, 0, 1]),
            Buffer.from([2]),
            Buffer.from(pair.publicKey),
            Buffer.alloc(32),
            Buffer.alloc(32, 11),
            Buffer.from([0]),
        ]);
        const signature = nacl.sign.detached(message, pair.secretKey);
        const bytes = Buffer.concat([
            Buffer.from([1]),
            Buffer.from(signature),
            message,
        ]);
        const wire = bytes.toString('base64');
        const parsed = parseSolanaTransaction(wire, 1232);
        const userId = randomUUID();
        const quoteId = randomUUID();
        const executionId = randomUUID();
        const keys = {
            generate: async () => ({
                plaintext: Buffer.alloc(32, 7),
                wrapped: Buffer.alloc(32, 9),
                keyId: 'test-key',
            }),
            unwrap: async () => Buffer.alloc(32, 7),
        };
        const store = new ExecutionTxStore(keys);
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, swapWallet]);
        await query(
            `INSERT INTO trade_quotes (
                id, user_id, wallet_address, provider, provider_quote_id,
                input_mint, output_mint, input_amount, output_amount,
                min_output_amount, slippage_bps, fee_payer, transaction_digest,
                integrity_digest, state, expires_at
             ) VALUES (
                $1, $2, $3, 'jupiter_swap_v2', $4, $5, $6, 1, 2, 1, 100,
                $3, $7, repeat('c', 64), 'consumed', clock_timestamp() + INTERVAL '1 hour'
             )`,
            [quoteId, userId, swapWallet, `e2e-${quoteId}`, sol, usdc, parsed.messageDigest]
        );
        await query(
            `INSERT INTO trade_executions (
                id, quote_id, user_id, wallet_address, provider, idempotency_key,
                state, signature, input_mint, output_mint, expected_input_amount,
                expected_output_amount, signed_tx_digest
             ) VALUES (
                $1, $2, $3, $4, 'jupiter_swap_v2', $5, 'signed', $6,
                $7, $8, 1, 2, $9
             )`,
            [executionId, quoteId, userId, swapWallet, `e2e-${executionId}`,
                bs58.encode(signature), sol, usdc, parsed.rawDigest]
        );
        const sealed = await store.seal({
            executionId,
            quoteId,
            userId,
            provider: 'jupiter_swap_v2',
            providerQuoteId: `e2e-${quoteId}`,
            wallet: swapWallet,
            feePayer: swapWallet,
            transaction: parsed,
        });
        await transaction((db) => store.insert(db, sealed));
        await query(
            `UPDATE trade_executions
                SET op_token = 'crashed-call',
                    op_lease_until = clock_timestamp() + INTERVAL '30 seconds'
              WHERE id = $1`,
            [executionId]
        );
        await query(
            `UPDATE trade_executions
                SET broadcast_started_at = clock_timestamp(), broadcast_count = 1
              WHERE id = $1 AND op_token = 'crashed-call'`,
            [executionId]
        );
        await query(
            `UPDATE trade_executions
                SET op_token = NULL, op_lease_until = NULL
              WHERE id = $1`,
            [executionId]
        );
        const submit = vi.fn(async () => ({
            provider: 'jupiter_swap_v2' as const,
            state: 'confirmed' as const,
            signature: bs58.encode(signature),
            inputAmount: '1',
            outputAmount: '2',
            rawStatus: 'Success',
        }));
        const provider = {
            name: 'jupiter_swap_v2' as const,
            quote: vi.fn(),
            submit,
        };

        const recoveredBatches = await Promise.all([
            new ExecutionService(provider, query, transaction, store).recoverBatch(),
            new ExecutionService(provider, query, transaction, store).recoverBatch(),
        ]);
        expect(recoveredBatches.reduce((sum, batch) => sum + batch.checked, 0)).toBe(1);
        expect(recoveredBatches.reduce((sum, batch) => sum + batch.replayed, 0)).toBe(1);
        expect(submit).toHaveBeenCalledOnce();
        expect(submit.mock.calls[0][0]).toEqual({
            providerQuoteId: `e2e-${quoteId}`,
            signedTransaction: wire,
        });
        const recovered = await query(
            `SELECT state, signature, provider_status, broadcast_count,
                    op_token, op_lease_until
               FROM trade_executions WHERE id = $1`,
            [executionId]
        );
        expect(recovered.rows[0]).toMatchObject({
            state: 'confirmed',
            signature: bs58.encode(signature),
            provider_status: 'Success',
            broadcast_count: 2,
            op_token: null,
            op_lease_until: null,
        });
    });
});
