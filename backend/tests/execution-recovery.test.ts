import { randomUUID } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import type { DbQuery } from '../src/config/database';
import {
    ExecutionTxError,
    ExecutionTxStore,
    type SealedExecutionTx,
} from '../src/services/execution/executionTxStore';
import { parseSolanaTransaction } from '../src/services/solanaTransaction';
import { TxKeyError, type TxKeyProvider } from '../src/services/orders/txKeyProvider';

const vec = (value: number): Buffer => Buffer.from([value]);

const signedWire = (pair = nacl.sign.keyPair()): string => {
    const message = Buffer.concat([
        Buffer.from([1, 0, 1]),
        vec(2),
        Buffer.from(pair.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 11),
        vec(0),
    ]);
    return Buffer.concat([
        vec(1),
        Buffer.from(nacl.sign.detached(message, pair.secretKey)),
        message,
    ]).toString('base64');
};

const fixture = async (wire = signedWire()) => {
    const transaction = parseSolanaTransaction(wire, 1232);
    const executionId = randomUUID();
    const quoteId = randomUUID();
    const userId = randomUUID();
    const wallet = transaction.feePayer;
    let openedKey: Buffer | undefined;
    const keys: TxKeyProvider = {
        generate: vi.fn(async () => ({
            plaintext: Buffer.alloc(32, 7),
            wrapped: Buffer.alloc(32, 9),
            keyId: 'test-key',
        })),
        unwrap: vi.fn(async () => {
            openedKey = Buffer.alloc(32, 7);
            return openedKey;
        }),
    };
    const store = new ExecutionTxStore(keys);
    const sealed = await store.seal({
        executionId,
        quoteId,
        userId,
        provider: 'jupiter_swap_v2',
        providerQuoteId: 'jupiter-request',
        wallet,
        feePayer: wallet,
        transaction,
    });
    const row = recoveryRow(sealed, 'claim-token');
    const db = vi.fn(async () => ({ rows: [row], rowCount: 1 })) as unknown as DbQuery;
    return { db, keys, openedKey: () => openedKey, row, store, transaction, wire };
};

const recoveryRow = (sealed: SealedExecutionTx, opToken: string) => ({
    claim_state: 'ready',
    execution_id: sealed.executionId,
    quote_id: sealed.quoteId,
    user_id: sealed.userId,
    provider: sealed.provider,
    wallet_address: sealed.wallet,
    fee_payer: sealed.feePayer,
    provider_quote_id: sealed.providerQuoteId,
    op_token: opToken,
    signature: bs58.encode(Buffer.from(sealed.ciphertext.subarray(0, 64))),
    signed_tx_digest: sealed.rawHash,
    alg: sealed.alg,
    ciphertext: Buffer.from(sealed.ciphertext),
    nonce: Buffer.from(sealed.nonce),
    wrapped_key: Buffer.from(sealed.wrappedKey),
    key_id: sealed.keyId,
    aad_hash: sealed.aadHash,
    message_hash: sealed.messageHash,
    raw_hash: sealed.rawHash,
    byte_size: sealed.byteSize,
    aad_ver: 1,
});

describe('execution recovery', () => {
    it('opens only the exact transaction and zeroes borrowed plaintext and key bytes', async () => {
        const test = await fixture();
        test.row.signature = bs58.encode(test.transaction.signatures[0]);
        let borrowed: Buffer | undefined;
        const output = await test.store.withRecovery(
            test.db, 30_000, 1, 0,
            async (recovery) => {
                borrowed = recovery.transaction.bytes;
                expect(recovery.signedTransaction).toBe(test.wire);
                expect(recovery.providerQuoteId).toBe('jupiter-request');
                return recovery.signedTransaction;
            }
        );

        expect(output).toBe(test.wire);
        expect(borrowed?.every((byte) => byte === 0)).toBe(true);
        expect(test.openedKey()?.every((byte) => byte === 0)).toBe(true);
        expect(test.keys.unwrap).toHaveBeenCalledWith(
            expect.any(Buffer),
            'test-key',
            {
                executionId: test.row.execution_id,
                aadHash: test.row.aad_hash,
                service: 'fervor-swap-egress',
            }
        );
    });

    it('rejects authenticated-data and ciphertext tampering before the callback', async () => {
        for (const mutate of [
            (row: Awaited<ReturnType<typeof fixture>>['row']) => { row.aad_hash = '0'.repeat(64); },
            (row: Awaited<ReturnType<typeof fixture>>['row']) => { row.ciphertext[0] ^= 1; },
            (row: Awaited<ReturnType<typeof fixture>>['row']) => {
                row.provider_quote_id = 'different-request';
            },
        ]) {
            const test = await fixture();
            test.row.signature = bs58.encode(test.transaction.signatures[0]);
            mutate(test.row);
            const use = vi.fn();
            await expect(test.store.withRecovery(test.db, 30_000, 1, 0, use))
                .rejects.toMatchObject({ code: 'blob_invalid' });
            expect(use).not.toHaveBeenCalled();
        }
    });

    it('distinguishes key outages and expired replay authorization without exposing bytes', async () => {
        const test = await fixture();
        test.row.signature = bs58.encode(test.transaction.signatures[0]);
        vi.mocked(test.keys.unwrap).mockRejectedValueOnce(
            new TxKeyError('kms down', 'unavailable')
        );
        const use = vi.fn();
        await expect(test.store.withRecovery(test.db, 30_000, 1, 0, use))
            .rejects.toMatchObject({ code: 'key_unavailable' });
        expect(use).not.toHaveBeenCalled();

        test.row.claim_state = 'expired';
        await expect(test.store.withRecovery(test.db, 30_000, 1, 0, use))
            .rejects.toEqual(expect.objectContaining<Partial<ExecutionTxError>>({
                code: 'replay_expired',
                executionId: test.row.execution_id,
            }));
        expect(use).not.toHaveBeenCalled();
    });

    it('parks permanent key failures instead of retrying them', async () => {
        for (const error of [
            new TxKeyError('stored key is disallowed', 'invalid'),
            new Error('unclassified key provider failure'),
        ]) {
            const test = await fixture();
            test.row.signature = bs58.encode(test.transaction.signatures[0]);
            vi.mocked(test.keys.unwrap).mockRejectedValueOnce(error);
            const use = vi.fn();

            await expect(test.store.withRecovery(test.db, 30_000, 1, 0, use))
                .rejects.toMatchObject({ code: 'blob_invalid' });
            expect(use).not.toHaveBeenCalled();
        }
    });

});
