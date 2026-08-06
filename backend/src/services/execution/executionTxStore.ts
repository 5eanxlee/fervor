import { createHash } from 'crypto';
import { env } from '../../config/env';
import type { DbQuery } from '../../config/database';
import type { ExecutionProviderName } from '../../types';
import {
    parseSolanaTransactionBytes,
    transactionSignature,
    validateSignedTransaction,
    verifySolanaSignature,
    type SolanaTransaction,
} from '../solanaTransaction';
import { canonicalJson } from '../orders/canonicalJson';
import { openTx, sealTx } from '../orders/txEnvelope';
import {
    createTxKeyProvider,
    TxKeyError,
    type TxKeyProvider,
} from '../orders/txKeyProvider';

export interface ExecutionTxInput {
    executionId: string;
    quoteId: string;
    userId: string;
    provider: ExecutionProviderName;
    providerQuoteId: string;
    wallet: string;
    feePayer: string;
    transaction: SolanaTransaction;
}

export interface SealedExecutionTx {
    executionId: string;
    quoteId: string;
    userId: string;
    provider: ExecutionProviderName;
    providerQuoteId: string;
    wallet: string;
    feePayer: string;
    alg: 'aes_256_gcm';
    ciphertext: Buffer;
    nonce: Buffer;
    wrappedKey: Buffer;
    keyId: string;
    aadHash: string;
    messageHash: string;
    rawHash: string;
    byteSize: number;
}

interface RecoveryRow {
    claim_state: 'ready' | 'expired';
    execution_id: string;
    quote_id: string;
    user_id: string;
    provider: ExecutionProviderName;
    wallet_address: string;
    fee_payer: string;
    provider_quote_id: string;
    op_token: string;
    signature: string | null;
    signed_tx_digest: string;
    alg: 'aes_256_gcm' | null;
    ciphertext: Buffer | null;
    nonce: Buffer | null;
    wrapped_key: Buffer | null;
    key_id: string | null;
    aad_hash: string | null;
    message_hash: string | null;
    raw_hash: string | null;
    byte_size: number | null;
    aad_ver: number | null;
}

export interface RecoveredExecutionTx {
    executionId: string;
    opToken: string;
    providerQuoteId: string;
    signedTransaction: string;
    transaction: SolanaTransaction;
}

export type ExecutionTxFailure = 'blob_invalid' | 'key_unavailable' | 'replay_expired';

export class ExecutionTxError extends Error {
    constructor(
        readonly code: ExecutionTxFailure,
        readonly executionId: string,
        readonly opToken: string,
        message: string,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = 'ExecutionTxError';
    }
}

interface ExecutionTxAad {
    executionId: string;
    quoteId: string;
    userId: string;
    provider: ExecutionProviderName;
    providerQuoteId: string;
    wallet: string;
    feePayer: string;
    messageHash: string;
    rawHash: string;
    byteSize: number;
}

const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

const aadFor = (input: ExecutionTxAad): Buffer => Buffer.from(canonicalJson({
    version: 1,
    executionId: input.executionId,
    quoteId: input.quoteId,
    userId: input.userId,
    provider: input.provider,
    providerQuoteId: input.providerQuoteId,
    wallet: input.wallet,
    feePayer: input.feePayer,
    messageHash: input.messageHash,
    rawHash: input.rawHash,
    byteSize: input.byteSize,
}), 'utf8');

const aadInput = (input: ExecutionTxInput): ExecutionTxAad => ({
    executionId: input.executionId,
    quoteId: input.quoteId,
    userId: input.userId,
    provider: input.provider,
    providerQuoteId: input.providerQuoteId,
    wallet: input.wallet,
    feePayer: input.feePayer,
    messageHash: input.transaction.messageDigest,
    rawHash: input.transaction.rawDigest,
    byteSize: input.transaction.bytes.length,
});

const contextFor = (executionId: string, aadHash: string) => ({
    executionId,
    aadHash,
    service: 'fervor-swap-egress',
});

export class ExecutionTxStore {
    private defaultKeys?: TxKeyProvider;

    constructor(
        private readonly keys?: TxKeyProvider,
        private readonly ttlMs = env.TX_BLOB_TTL_MS
    ) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) {
            throw new Error('Transaction blob TTL must be 60000 to 86400000 milliseconds');
        }
    }

    async seal(input: ExecutionTxInput): Promise<SealedExecutionTx> {
        const aad = aadFor(aadInput(input));
        const aadHash = digest(aad);
        const context = contextFor(input.executionId, aadHash);
        const key = await this.keyProvider().generate(context);
        try {
            const envelope = sealTx(input.transaction.bytes, key.plaintext, aad);
            return {
                executionId: input.executionId,
                quoteId: input.quoteId,
                userId: input.userId,
                provider: input.provider,
                providerQuoteId: input.providerQuoteId,
                wallet: input.wallet,
                feePayer: input.feePayer,
                alg: envelope.alg,
                ciphertext: envelope.ciphertext,
                nonce: envelope.nonce,
                wrappedKey: key.wrapped,
                keyId: key.keyId,
                aadHash,
                messageHash: input.transaction.messageDigest,
                rawHash: input.transaction.rawDigest,
                byteSize: input.transaction.bytes.length,
            };
        } finally {
            key.plaintext.fill(0);
            aad.fill(0);
        }
    }

    async insert(db: DbQuery, blob: SealedExecutionTx): Promise<void> {
        await db(
            `INSERT INTO execution_tx_blobs (
                execution_id, quote_id, user_id, provider, provider_quote_id,
                wallet_address, fee_payer,
                alg, ciphertext, nonce, wrapped_key, key_id, aad_hash, message_hash,
                raw_hash, byte_size, expires_at, aad_ver
             ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, clock_timestamp() + ($17::text || ' milliseconds')::interval, 1
             )`,
            [blob.executionId, blob.quoteId, blob.userId, blob.provider,
                blob.providerQuoteId, blob.wallet, blob.feePayer, blob.alg,
                blob.ciphertext, blob.nonce, blob.wrappedKey, blob.keyId, blob.aadHash,
                blob.messageHash, blob.rawHash, blob.byteSize, this.ttlMs]
        );
    }

    async withRecovery<T>(
        db: DbQuery,
        leaseMs: number,
        shardCount: number,
        shardId: number,
        use: (recovery: RecoveredExecutionTx) => T | Promise<T>
    ): Promise<T | undefined> {
        const result = await db<RecoveryRow>(
            'SELECT * FROM claim_execution_blob($1, $2, $3)',
            [leaseMs, shardCount, shardId]
        );
        const row = result.rows[0];
        if (!row) return undefined;
        if (row.claim_state === 'expired') {
            throw new ExecutionTxError(
                'replay_expired', row.execution_id, row.op_token,
                'Signed transaction recovery authorization expired'
            );
        }

        const aad = this.recoveryAad(row);
        let bytes: Buffer | undefined;
        try {
            if (digest(aad) !== row.aad_hash) {
                throw this.invalid(row, 'Stored transaction authenticated data is invalid');
            }
            const provider = this.keyProvider();
            let key: Buffer;
            try {
                key = await provider.unwrap(
                    Buffer.from(row.wrapped_key!),
                    String(row.key_id),
                    contextFor(row.execution_id, String(row.aad_hash))
                );
            } catch (error) {
                if (!(error instanceof TxKeyError) || error.kind !== 'unavailable') {
                    throw this.invalid(row, 'Stored transaction key is invalid', error);
                }
                throw new ExecutionTxError(
                    'key_unavailable', row.execution_id, row.op_token,
                    'Signed transaction key is temporarily unavailable', error
                );
            }
            try {
                try {
                    bytes = openTx(
                        Buffer.from(row.ciphertext!),
                        key,
                        Buffer.from(row.nonce!),
                        aad
                    );
                } catch (error) {
                    throw this.invalid(row, 'Stored transaction ciphertext is invalid', error);
                }
            } finally {
                key.fill(0);
            }

            const transaction = this.validateRecovery(row, bytes);
            return await use({
                executionId: row.execution_id,
                opToken: row.op_token,
                providerQuoteId: row.provider_quote_id,
                signedTransaction: bytes.toString('base64'),
                transaction,
            });
        } finally {
            bytes?.fill(0);
            aad.fill(0);
        }
    }

    private recoveryAad(row: RecoveryRow): Buffer {
        if (row.provider !== 'jupiter_swap_v2' || row.aad_ver !== 1
            || row.alg !== 'aes_256_gcm' || !row.ciphertext || !row.nonce
            || !row.wrapped_key || !row.key_id || !row.aad_hash || !row.message_hash
            || !row.raw_hash || !row.byte_size) {
            throw this.invalid(row, 'Signed transaction recovery material is incomplete');
        }
        return aadFor({
            executionId: row.execution_id,
            quoteId: row.quote_id,
            userId: row.user_id,
            provider: row.provider,
            providerQuoteId: row.provider_quote_id,
            wallet: row.wallet_address,
            feePayer: row.fee_payer,
            messageHash: row.message_hash,
            rawHash: row.raw_hash,
            byteSize: row.byte_size,
        });
    }

    private validateRecovery(row: RecoveryRow, bytes: Buffer): SolanaTransaction {
        let transaction: SolanaTransaction;
        try {
            transaction = parseSolanaTransactionBytes(bytes, 1232);
        } catch (error) {
            throw this.invalid(row, 'Decrypted signed transaction is invalid', error);
        }
        const signers = row.fee_payer === row.wallet_address
            ? [row.wallet_address] : [row.fee_payer, row.wallet_address];
        const firstSignature = transactionSignature(transaction);
        try {
            if (bytes.length !== row.byte_size
                || digest(bytes) !== row.raw_hash
                || transaction.rawDigest !== row.raw_hash
                || row.signed_tx_digest !== row.raw_hash
                || transaction.messageDigest !== row.message_hash
                || transaction.requiredSigners.length !== signers.length
                || transaction.requiredSigners.some((signer, index) => signer !== signers[index])) {
                throw new Error('Transaction identity does not match storage');
            }
            validateSignedTransaction(
                { ...transaction, messageDigest: row.message_hash, feePayer: row.fee_payer },
                transaction,
                row.wallet_address,
                row.fee_payer === row.wallet_address ? undefined : new Set([row.fee_payer])
            );
            if (row.signature && (firstSignature
                ? row.signature !== firstSignature
                : !verifySolanaSignature(transaction, row.fee_payer, row.signature))) {
                throw new Error('Execution signature does not match the transaction');
            }
            return transaction;
        } catch (error) {
            throw this.invalid(row, 'Decrypted signed transaction identity does not match storage', error);
        }
    }

    private invalid(row: Pick<RecoveryRow, 'execution_id' | 'op_token'>, message: string, cause?: unknown) {
        return new ExecutionTxError('blob_invalid', row.execution_id, row.op_token, message, cause);
    }

    private keyProvider(): TxKeyProvider {
        return this.keys ?? (this.defaultKeys ??= createTxKeyProvider());
    }
}
