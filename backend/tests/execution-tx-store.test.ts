import { randomUUID } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTxStore } from '../src/services/execution/executionTxStore';
import { canonicalJson } from '../src/services/orders/canonicalJson';
import { openTx } from '../src/services/orders/txEnvelope';
import { parseSolanaTransaction } from '../src/services/solanaTransaction';

const signedTransaction = () => {
    const signer = nacl.sign.keyPair();
    const message = Buffer.concat([
        Buffer.from([1, 0, 1, 2]),
        Buffer.from(signer.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 7),
        Buffer.from([0]),
    ]);
    const bytes = Buffer.concat([
        Buffer.from([1]),
        Buffer.from(nacl.sign.detached(message, signer.secretKey)),
        message,
    ]);
    return {
        transaction: parseSolanaTransaction(bytes.toString('base64'), 1232),
        wallet: bs58.encode(signer.publicKey),
    };
};

describe('execution transaction store', () => {
    it('seals exact signed bytes under their complete immutable identity', async () => {
        const tx = signedTransaction();
        const keyBytes = Buffer.alloc(32, 5);
        const plaintext = Buffer.from(keyBytes);
        const keys = {
            generate: vi.fn().mockResolvedValue({
                plaintext,
                wrapped: Buffer.alloc(64, 9),
                keyId: 'arn:aws:kms:us-west-2:123456789012:key/fervor',
            }),
            unwrap: vi.fn(),
        };
        const input = {
            executionId: randomUUID(),
            quoteId: randomUUID(),
            userId: randomUUID(),
            provider: 'jupiter_swap_v2' as const,
            providerQuoteId: 'jupiter-request',
            wallet: tx.wallet,
            feePayer: tx.wallet,
            transaction: tx.transaction,
        };
        const store = new ExecutionTxStore(keys, 900_000);
        const sealed = await store.seal(input);

        const aad = Buffer.from(canonicalJson({
            version: 1,
            executionId: input.executionId,
            quoteId: input.quoteId,
            userId: input.userId,
            provider: input.provider,
            providerQuoteId: input.providerQuoteId,
            wallet: input.wallet,
            feePayer: input.feePayer,
            messageHash: tx.transaction.messageDigest,
            rawHash: tx.transaction.rawDigest,
            byteSize: tx.transaction.bytes.length,
        }), 'utf8');
        expect(keys.generate).toHaveBeenCalledWith({
            executionId: input.executionId,
            aadHash: sealed.aadHash,
            service: 'fervor-swap-egress',
        });
        expect(plaintext.every((byte) => byte === 0)).toBe(true);
        const opened = openTx(sealed.ciphertext, keyBytes, sealed.nonce, aad);
        expect(opened).toEqual(tx.transaction.bytes);
        opened.fill(0);

        let stored: unknown[] = [];
        const db = vi.fn(async (_sql: string, params: unknown[] = []) => {
            stored = params;
            return { rows: [], rowCount: 1 } as never;
        });
        await store.insert(db, sealed);
        expect(stored).toEqual([
            input.executionId, input.quoteId, input.userId, input.provider,
            input.providerQuoteId, input.wallet, input.feePayer, 'aes_256_gcm',
            sealed.ciphertext, sealed.nonce, sealed.wrappedKey, sealed.keyId,
            sealed.aadHash, tx.transaction.messageDigest, tx.transaction.rawDigest,
            tx.transaction.bytes.length, 900_000,
        ]);
        expect(stored.some((value) => value === tx.transaction.bytes)).toBe(false);
    });

    it('rejects retention outside the bounded transaction window', () => {
        expect(() => new ExecutionTxStore(undefined, 59_999)).toThrow(/TTL/);
        expect(() => new ExecutionTxStore(undefined, 86_400_001)).toThrow(/TTL/);
    });
});
