import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const tagBytes = 16;

const assertInputs = (key: Buffer, nonce: Buffer, aad: Buffer): void => {
    if (key.length !== 32) throw new Error('Transaction data key must contain 32 bytes');
    if (nonce.length !== 12) throw new Error('Transaction nonce must contain 12 bytes');
    if (!aad.length) throw new Error('Transaction authenticated data is required');
};

export interface TxEnvelope {
    alg: 'aes_256_gcm';
    ciphertext: Buffer;
    nonce: Buffer;
}

export const sealTx = (plaintext: Buffer, key: Buffer, aad: Buffer): TxEnvelope => {
    if (!plaintext.length || plaintext.length > 1232) {
        throw new Error('Signed transaction must contain 1 to 1232 bytes');
    }
    const nonce = randomBytes(12);
    assertInputs(key, nonce, aad);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        alg: 'aes_256_gcm',
        ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
        nonce,
    };
};

export const openTx = (
    ciphertext: Buffer,
    key: Buffer,
    nonce: Buffer,
    aad: Buffer
): Buffer => {
    if (ciphertext.length <= tagBytes || ciphertext.length > 1248) {
        throw new Error('Encrypted transaction has an invalid size');
    }
    assertInputs(key, nonce, aad);
    const body = ciphertext.subarray(0, -tagBytes);
    const tag = ciphertext.subarray(-tagBytes);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes });
    decipher.setAAD(aad, { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    let head: Buffer | undefined;
    let tail: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
        head = decipher.update(body);
        tail = decipher.final();
        plaintext = Buffer.allocUnsafe(head.length + tail.length);
        head.copy(plaintext);
        tail.copy(plaintext, head.length);
        return plaintext;
    } catch (error) {
        plaintext?.fill(0);
        throw error;
    } finally {
        head?.fill(0);
        tail?.fill(0);
    }
};
