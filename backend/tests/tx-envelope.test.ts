import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { openTx, sealTx } from '../src/services/orders/txEnvelope';

describe('signed transaction envelope', () => {
    it('authenticates the bytes and immutable action context', () => {
        const plaintext = randomBytes(512);
        const key = randomBytes(32);
        const aad = Buffer.from('action-context-v1');
        const sealed = sealTx(plaintext, key, aad);

        expect(sealed.alg).toBe('aes_256_gcm');
        expect(sealed.nonce).toHaveLength(12);
        expect(sealed.ciphertext).toHaveLength(plaintext.length + 16);
        expect(openTx(sealed.ciphertext, key, sealed.nonce, aad)).toEqual(plaintext);

        const tampered = Buffer.from(sealed.ciphertext);
        tampered[0] ^= 1;
        expect(() => openTx(tampered, key, sealed.nonce, aad)).toThrow();
        expect(() => openTx(sealed.ciphertext, key, sealed.nonce, Buffer.from('other'))).toThrow();
    });

    it('enforces the Solana wire and AES-256 contracts', () => {
        expect(() => sealTx(Buffer.alloc(0), randomBytes(32), Buffer.from('aad'))).toThrow(/1232/);
        expect(() => sealTx(Buffer.alloc(1233), randomBytes(32), Buffer.from('aad'))).toThrow(/1232/);
        expect(() => sealTx(Buffer.alloc(10), randomBytes(31), Buffer.from('aad'))).toThrow(/32/);
    });
});
