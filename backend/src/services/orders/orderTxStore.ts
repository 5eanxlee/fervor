import { createHash, randomUUID } from 'crypto';
import type { QueryResultRow } from 'pg';
import { coreDb, type Database, type DbQuery } from '../../config/database';
import { env } from '../../config/env';
import type { ActionFence, OrderAction, OrderActionKind } from '../../types';
import {
    parseSolanaTransaction,
    parseSolanaTransactionBytes,
    transactionSignature,
    validatePreparedTransaction,
    verifySolanaSigner,
    verifySolanaSignerAt,
} from '../solanaTransaction';
import { eventOutbox, type EventOutbox } from '../eventOutbox';
import { canonicalJson } from './canonicalJson';
import { dispatchRules } from './actionPolicies';
import { ActionStoreError } from './orderActionError';
import { iso, mapAction, optional, type ActionRow } from './orderActionModel';
import { emitOrderEvent } from './orderEventWriter';
import { bounded, eventContext, uint, uuid, type EventContext } from './orderValidation';
import { openTx, sealTx } from './txEnvelope';
import {
    createTxKeyProvider,
    type KeyContext,
    type TxKeyProvider,
} from './txKeyProvider';

type TxDb = Pick<Database, 'query' | 'transaction'>;

interface TxRow extends ActionRow {
    tx_cluster: string;
    tx_wallet: string;
    blob_aad_hash: string | null;
    blob_aad_ver: number | null;
    blob_alg: 'aes_256_gcm' | null;
    blob_ciphertext: Buffer | null;
    blob_nonce: Buffer | null;
    blob_wrapped_key: Buffer | null;
    blob_key_id: string | null;
    blob_order: string | null;
    blob_cluster: string | null;
    blob_wallet: string | null;
    blob_message_hash: string | null;
    blob_raw_hash: string | null;
    blob_signature: string | null;
    blob_size: number | null;
    blob_expires_at: Date | null;
    blob_purged_at: Date | null;
    blob_live: boolean | null;
}

interface BlobRow extends QueryResultRow {
    expires_at: Date;
}

interface AccessRow extends QueryResultRow {
    id: string;
}

interface OrderLockRow extends QueryResultRow {
    order_id: string;
}

export interface BindTx extends EventContext {
    actionId: string;
    expectedVer: string;
    signedTx: string;
}

export interface ExpectTx extends EventContext {
    actionId: string;
    expectedVer: string;
    preparedTx: string;
    lastValidHeight?: string;
}

export interface TxExpectation {
    actionId: string;
    orderId: string;
    messageHash: string;
    recentBlockhash: string;
    lastValidHeight?: string;
    byteSize: number;
}

export interface ReadTx {
    actionId: string;
    attemptId: string;
    accessKey: string;
    fence: ActionFence;
    gateway: string;
    purpose: 'dispatch' | 'replay';
}

export interface TxBinding {
    actionId: string;
    orderId: string;
    alg: 'aes_256_gcm';
    aadHash: string;
    messageHash: string;
    rawHash: string;
    firstSignature: string;
    recentBlockhash: string;
    byteSize: number;
    expiresAt: string;
}

const digest = (value: Buffer | string): string => (
    createHash('sha256').update(value).digest('hex')
);

const contextFor = (actionId: string, aadHash: string): KeyContext => ({
    actionId,
    aadHash,
    service: 'fervor-order-egress',
});

export class OrderTxStore {
    constructor(
        private readonly db: TxDb = coreDb,
        private readonly keyProvider?: TxKeyProvider,
        private readonly outbox: Pick<EventOutbox, 'enqueue'> = eventOutbox,
        private readonly ttlMs = env.TX_BLOB_TTL_MS
    ) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) {
            throw new Error('Transaction blob TTL must be 60000 to 86400000 milliseconds');
        }
    }

    async expect(input: ExpectTx): Promise<{ expectation: TxExpectation; replayed: boolean }> {
        this.validateExpect(input);
        return this.db.transaction(async (db) => {
            const current = await this.load(db, input.actionId, true);
            this.assertBlobKind(current);
            const prepared = this.prepared(current, input.preparedTx);
            try {
                const expectation = this.expectation(current, prepared, input.lastValidHeight);
                if (current.message_hash !== null) {
                    if (String(current.message_hash) !== prepared.messageDigest
                        || String(current.recent_blockhash) !== prepared.recentBlockhash
                        || optional(current.last_valid_height) !== input.lastValidHeight) {
                        throw new ActionStoreError(
                            'idempotency_conflict', 'Action already expects a different transaction message'
                        );
                    }
                    return { expectation, replayed: true };
                }
                this.assertExpectWritable(current, input.expectedVer);
                const changed = await db<ActionRow>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            work_state = 'awaiting_sig',
                            message_hash = $3,
                            recent_blockhash = $4,
                            last_valid_height = $5
                      WHERE id = $1
                        AND action_ver = $2
                        AND work_state = 'queued'
                        AND effect_state = 'not_possible'
                        AND outcome = 'pending'
                        AND lease_owner IS NULL
                        AND message_hash IS NULL
                        AND first_signature IS NULL
                      RETURNING *`,
                    [input.actionId, input.expectedVer, prepared.messageDigest,
                        prepared.recentBlockhash, input.lastValidHeight ?? null]
                );
                if (!changed.rows[0]) {
                    throw new ActionStoreError(
                        'version_conflict', 'Action changed before its transaction was prepared', true
                    );
                }
                const action = mapAction(changed.rows[0]);
                await emitOrderEvent(
                    db,
                    this.outbox,
                    action,
                    `action:${action.id}:v${action.version}:awaiting-signature`,
                    'action.awaiting_signature',
                    action.workState,
                    input,
                    { transaction: expectation }
                );
                return { expectation, replayed: false };
            } finally {
                prepared.bytes.fill(0);
            }
        });
    }

    async bind(input: BindTx): Promise<{ binding: TxBinding; replayed: boolean }> {
        this.validateBind(input);
        const snapshot = await this.load(this.db.query, input.actionId);
        this.assertBlobKind(snapshot);
        const identity = this.identity(snapshot, input.signedTx);
        try {
            const replay = this.replay(snapshot, identity);
            if (replay) return { binding: replay, replayed: true };
            this.assertBindWritable(snapshot, input.expectedVer);

            const key = await (this.keyProvider ?? createTxKeyProvider()).generate(
                contextFor(input.actionId, identity.aadHash)
            );
            let envelope;
            try {
                envelope = sealTx(identity.bytes, key.plaintext, identity.aad);
            } finally {
                key.plaintext.fill(0);
            }

            return await this.db.transaction(async (db) => {
                const current = await this.load(db, input.actionId, true);
                this.assertPreparedSame(snapshot, current);
                const raced = this.replay(current, identity);
                if (raced) return { binding: raced, replayed: true };
                this.assertBindWritable(current, input.expectedVer);

                const changed = await db<ActionRow>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            work_state = 'ready',
                            first_signature = $3
                      WHERE id = $1
                        AND action_ver = $2
                        AND work_state = 'awaiting_sig'
                        AND effect_state = 'not_possible'
                        AND outcome = 'pending'
                        AND lease_owner IS NULL
                        AND message_hash = $4
                        AND first_signature IS NULL
                      RETURNING *`,
                    [input.actionId, input.expectedVer, identity.firstSignature, identity.messageHash]
                );
                if (!changed.rows[0]) {
                    throw new ActionStoreError(
                        'version_conflict', 'Action changed before its signed transaction was bound', true
                    );
                }

                const inserted = await db<BlobRow>(
                    `INSERT INTO order_tx_blobs (
                        action_id, order_id, cluster, wallet_address, alg, ciphertext,
                        nonce, wrapped_key, key_id, aad_hash, message_hash,
                        raw_hash, first_signature, byte_size, expires_at, aad_ver
                     ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                        clock_timestamp() + ($15::text || ' milliseconds')::interval, 2
                     )
                     RETURNING expires_at`,
                    [input.actionId, String(current.order_id), String(current.tx_cluster),
                        String(current.tx_wallet), envelope.alg, envelope.ciphertext,
                        envelope.nonce, key.wrapped, key.keyId, identity.aadHash,
                        identity.messageHash, identity.rawHash, identity.firstSignature,
                        identity.bytes.length, this.ttlMs]
                );
                const action = mapAction(changed.rows[0]);
                const binding = this.binding(action, identity, inserted.rows[0].expires_at);
                await emitOrderEvent(
                    db,
                    this.outbox,
                    action,
                    `action:${action.id}:v${action.version}:signed`,
                    'action.signed',
                    action.workState,
                    input,
                    { transaction: binding }
                );
                return { binding, replayed: false };
            });
        } finally {
            identity.bytes.fill(0);
        }
    }

    async withTx<T>(
        input: ReadTx,
        use: (bytes: Buffer) => T | Promise<T>
    ): Promise<T> {
        this.validateRead(input);
        const row = await this.db.transaction(async (db) => {
            const access = await db<AccessRow>(
                `INSERT INTO order_blob_reads (
                    id, access_key, action_id, attempt_id, lease_owner,
                    lease_gen, write_scope, write_epoch, gateway, purpose
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (access_key) DO NOTHING
                 RETURNING id`,
                [randomUUID(), input.accessKey, input.actionId, input.attemptId,
                    input.fence.owner, input.fence.gen, input.fence.scope,
                    input.fence.epoch, input.gateway, input.purpose]
            );
            if (!access.rows[0]) {
                const replay = await db<AccessRow>(
                    `SELECT id
                       FROM order_blob_reads
                      WHERE access_key = $1
                        AND action_id = $2
                        AND attempt_id = $3
                        AND lease_owner = $4
                        AND lease_gen = $5
                        AND write_scope = $6
                        AND write_epoch = $7
                        AND gateway = $8
                        AND purpose = $9`,
                    [input.accessKey, input.actionId, input.attemptId, input.fence.owner,
                        input.fence.gen, input.fence.scope, input.fence.epoch,
                        input.gateway, input.purpose]
                );
                if (!replay.rows[0]) {
                    throw new ActionStoreError(
                        'idempotency_conflict', 'Blob access key already owns a different authorization'
                    );
                }
                await db(
                    'SELECT assert_blob_access($1, $2, $3, $4, $5, $6)',
                    [input.actionId, input.attemptId, input.fence.owner, input.fence.gen,
                        input.fence.scope, input.fence.epoch]
                );
            }
            return this.load(db, input.actionId);
        });
        const aad = this.aad(row);
        if (digest(aad) !== row.blob_aad_hash) {
            throw new ActionStoreError('state_conflict', 'Transaction authenticated data is invalid');
        }
        const provider = this.keyProvider ?? createTxKeyProvider();
        const key = await provider.unwrap(
            Buffer.from(row.blob_wrapped_key!),
            String(row.blob_key_id),
            contextFor(input.actionId, String(row.blob_aad_hash))
        );
        let bytes: Buffer;
        try {
            bytes = openTx(
                Buffer.from(row.blob_ciphertext!),
                key,
                Buffer.from(row.blob_nonce!),
                aad
            );
        } finally {
            key.fill(0);
        }
        try {
            this.assertPlaintext(row, bytes);
            return await use(bytes);
        } finally {
            bytes.fill(0);
        }
    }

    private async load(db: DbQuery, actionId: string, lock = false): Promise<TxRow> {
        if (lock) {
            const owner = await db<OrderLockRow>(
                'SELECT action.order_id FROM order_actions action WHERE action.id = $1',
                [actionId]
            );
            if (!owner.rows[0]) throw new ActionStoreError('not_found', 'Action was not found');
            await db(
                'SELECT 1 FROM order_intents order_row WHERE order_row.id = $1 FOR UPDATE',
                [owner.rows[0].order_id]
            );
        }
        const result = await db<TxRow>(
            `SELECT action.*,
                    order_row.cluster AS tx_cluster,
                    order_row.wallet_address AS tx_wallet,
                    blob.aad_hash AS blob_aad_hash,
                    blob.aad_ver AS blob_aad_ver,
                    blob.alg AS blob_alg,
                    blob.ciphertext AS blob_ciphertext,
                    blob.nonce AS blob_nonce,
                    blob.wrapped_key AS blob_wrapped_key,
                    blob.key_id AS blob_key_id,
                    blob.order_id AS blob_order,
                    blob.cluster AS blob_cluster,
                    blob.wallet_address AS blob_wallet,
                    blob.message_hash AS blob_message_hash,
                    blob.raw_hash AS blob_raw_hash,
                    blob.first_signature AS blob_signature,
                    blob.byte_size AS blob_size,
                    blob.expires_at AS blob_expires_at,
                    blob.purged_at AS blob_purged_at,
                    CASE WHEN blob.action_id IS NULL THEN NULL
                         ELSE blob.purged_at IS NULL
                              AND blob.expires_at > clock_timestamp()
                    END AS blob_live
               FROM order_actions action
               JOIN order_intents order_row ON order_row.id = action.order_id
               LEFT JOIN order_tx_blobs blob ON blob.action_id = action.id
              WHERE action.id = $1
              ${lock ? 'FOR UPDATE OF action' : ''}`,
            [actionId]
        );
        if (!result.rows[0]) throw new ActionStoreError('not_found', 'Action was not found');
        return result.rows[0];
    }

    private identity(row: TxRow, signedTx: string) {
        let transaction;
        try {
            transaction = parseSolanaTransaction(signedTx, 1232);
        } catch (error) {
            throw new ActionStoreError(
                'invalid_input', error instanceof Error ? error.message : 'Signed transaction is invalid'
            );
        }
        try {
            const wallet = String(row.tx_wallet);
            if (optional(row.message_hash) === undefined || optional(row.recent_blockhash) === undefined) {
                throw new ActionStoreError(
                    'state_conflict', 'Action has no committed provider transaction message'
                );
            }
            if (transaction.messageDigest !== String(row.message_hash)
                || transaction.recentBlockhash !== String(row.recent_blockhash)) {
                throw new ActionStoreError(
                    'idempotency_conflict', 'Signed transaction differs from the prepared message'
                );
            }
            if (!verifySolanaSigner(transaction, wallet)) {
                throw new ActionStoreError(
                    'invalid_input', 'Signed transaction does not contain the order wallet signature'
                );
            }
            const firstSignature = transactionSignature(transaction);
            if (!firstSignature) {
                throw new ActionStoreError(
                    'invalid_input', 'Signed transaction does not contain a valid fee-payer signature'
                );
            }
            for (let index = 0; index < transaction.requiredSigners.length; index += 1) {
                if (!verifySolanaSignerAt(transaction, index)) {
                    throw new ActionStoreError(
                        'invalid_input', 'Signed transaction is missing a required signer signature'
                    );
                }
            }
            const record = {
                actionId: String(row.id),
                alg: 'aes_256_gcm',
                byteSize: transaction.bytes.length,
                cluster: String(row.tx_cluster),
                firstSignature,
                messageHash: transaction.messageDigest,
                orderId: String(row.order_id),
                rawHash: transaction.rawDigest,
                recentBlockhash: transaction.recentBlockhash,
                lastValidHeight: optional(row.last_valid_height) ?? null,
                version: 2,
                wallet,
            } as const;
            const aad = Buffer.from(canonicalJson(record), 'utf8');
            return { ...record, aad, aadHash: digest(aad), bytes: transaction.bytes };
        } catch (error) {
            transaction.bytes.fill(0);
            throw error;
        }
    }

    private prepared(row: TxRow, preparedTx: string) {
        let transaction;
        try {
            transaction = parseSolanaTransaction(preparedTx, 1232);
            validatePreparedTransaction(transaction, String(row.tx_wallet));
            if (verifySolanaSigner(transaction, String(row.tx_wallet))) {
                throw new Error('Provider-prepared transaction is already signed by the order wallet');
            }
        } catch (error) {
            transaction?.bytes.fill(0);
            throw new ActionStoreError(
                'invalid_input', error instanceof Error
                    ? error.message : 'Prepared transaction is invalid'
            );
        }
        return transaction;
    }

    private aad(row: TxRow): Buffer {
        this.assertReadable(row);
        return Buffer.from(canonicalJson({
            actionId: String(row.id),
            alg: row.blob_alg,
            byteSize: Number(row.blob_size),
            cluster: String(row.blob_cluster),
            firstSignature: String(row.blob_signature),
            messageHash: String(row.blob_message_hash),
            orderId: String(row.blob_order),
            rawHash: String(row.blob_raw_hash),
            recentBlockhash: String(row.recent_blockhash),
            lastValidHeight: optional(row.last_valid_height) ?? null,
            version: 2,
            wallet: String(row.blob_wallet),
        }), 'utf8');
    }

    private assertReadable(row: TxRow): void {
        if (row.blob_aad_ver !== 2 || row.blob_alg !== 'aes_256_gcm'
            || row.blob_live !== true || row.blob_purged_at !== null
            || !row.blob_ciphertext || !row.blob_nonce || !row.blob_wrapped_key
            || !row.blob_key_id || !row.blob_aad_hash || !row.blob_message_hash
            || !row.blob_raw_hash || !row.blob_signature || !row.blob_size
            || !row.blob_order || !row.blob_cluster || !row.blob_wallet
            || !row.blob_expires_at) {
            throw new ActionStoreError(
                'state_conflict', 'Signed transaction recovery material is unavailable'
            );
        }
    }

    private assertPlaintext(row: TxRow, bytes: Buffer): void {
        let transaction;
        try {
            transaction = parseSolanaTransactionBytes(bytes, 1232);
        } catch {
            bytes.fill(0);
            throw new ActionStoreError('state_conflict', 'Decrypted signed transaction is invalid');
        }
        if (transaction.rawDigest !== row.blob_raw_hash
            || transaction.messageDigest !== row.blob_message_hash
            || transaction.recentBlockhash !== row.recent_blockhash
            || transactionSignature(transaction) !== row.blob_signature
            || transaction.bytes.length !== Number(row.blob_size)
            || !verifySolanaSigner(transaction, String(row.blob_wallet))
            || !transaction.requiredSigners.every((_, index) => verifySolanaSignerAt(transaction, index))) {
            bytes.fill(0);
            throw new ActionStoreError(
                'state_conflict', 'Decrypted signed transaction identity does not match storage'
            );
        }
    }

    private assertPreparedSame(snapshot: TxRow, current: TxRow): void {
        const fields: Array<keyof TxRow> = [
            'id', 'order_id', 'kind', 'rule_ver', 'tx_cluster', 'tx_wallet',
            'message_hash', 'recent_blockhash', 'last_valid_height',
        ];
        if (fields.some((field) => optional(snapshot[field]) !== optional(current[field]))) {
            throw new ActionStoreError(
                'idempotency_conflict', 'Prepared transaction identity changed during signing'
            );
        }
    }

    private replay(row: TxRow, identity: ReturnType<OrderTxStore['identity']>): TxBinding | undefined {
        if (row.blob_aad_hash === null) return undefined;
        if (row.blob_aad_ver !== 2) {
            throw new ActionStoreError('state_conflict', 'Signed transaction policy requires review');
        }
        if (row.blob_purged_at !== null) {
            throw new ActionStoreError('state_conflict', 'Signed transaction key was destroyed');
        }
        if (!row.blob_expires_at || row.blob_live !== true) {
            throw new ActionStoreError('state_conflict', 'Signed transaction recovery window expired');
        }
        if (String(row.blob_aad_hash) !== identity.aadHash
            || String(row.blob_message_hash) !== identity.messageHash
            || String(row.blob_raw_hash) !== identity.rawHash
            || String(row.blob_signature) !== identity.firstSignature
            || Number(row.blob_size) !== identity.bytes.length
            || String(row.message_hash) !== identity.messageHash
            || String(row.first_signature) !== identity.firstSignature) {
            throw new ActionStoreError(
                'idempotency_conflict', 'Action already owns a different signed transaction'
            );
        }
        return this.binding(mapAction(row), identity, row.blob_expires_at!);
    }

    private assertExpectWritable(row: TxRow, expectedVer: string): void {
        this.assertBlobKind(row);
        if (String(row.action_ver) !== expectedVer) {
            throw new ActionStoreError('version_conflict', 'Action version changed', true);
        }
        if (row.work_state !== 'queued'
            || row.effect_state !== 'not_possible' || row.outcome !== 'pending'
            || optional(row.lease_owner) !== undefined
            || optional(row.message_hash) !== undefined
            || optional(row.first_signature) !== undefined) {
            throw new ActionStoreError('state_conflict', 'Action cannot accept a signed transaction');
        }
    }

    private assertBindWritable(row: TxRow, expectedVer: string): void {
        this.assertBlobKind(row);
        if (String(row.action_ver) !== expectedVer) {
            throw new ActionStoreError('version_conflict', 'Action version changed', true);
        }
        if (row.work_state !== 'awaiting_sig'
            || row.effect_state !== 'not_possible' || row.outcome !== 'pending'
            || optional(row.lease_owner) !== undefined
            || optional(row.message_hash) === undefined
            || optional(row.recent_blockhash) === undefined
            || optional(row.first_signature) !== undefined) {
            throw new ActionStoreError('state_conflict', 'Action cannot accept a signed transaction');
        }
    }

    private assertBlobKind(row: TxRow): void {
        const kind = row.kind as OrderActionKind;
        if (!dispatchRules[kind]?.blob) {
            throw new ActionStoreError('state_conflict', `${kind} does not accept a signed transaction`);
        }
    }

    private expectation(
        row: TxRow,
        prepared: ReturnType<OrderTxStore['prepared']>,
        lastValidHeight?: string
    ): TxExpectation {
        return {
            actionId: String(row.id),
            orderId: String(row.order_id),
            messageHash: prepared.messageDigest,
            recentBlockhash: prepared.recentBlockhash,
            ...(lastValidHeight === undefined ? {} : { lastValidHeight }),
            byteSize: prepared.bytes.length,
        };
    }

    private binding(
        action: OrderAction,
        identity: ReturnType<OrderTxStore['identity']>,
        expiresAt: Date
    ): TxBinding {
        return {
            actionId: action.id,
            orderId: action.orderId,
            alg: 'aes_256_gcm',
            aadHash: identity.aadHash,
            messageHash: identity.messageHash,
            rawHash: identity.rawHash,
            firstSignature: identity.firstSignature,
            recentBlockhash: identity.recentBlockhash,
            byteSize: identity.bytes.length,
            expiresAt: iso(expiresAt),
        };
    }

    private validateBind(input: BindTx): void {
        eventContext(input);
        uuid(input.actionId, 'actionId');
        uint(input.expectedVer, 'expectedVer');
        if (typeof input.signedTx !== 'string') {
            throw new ActionStoreError('invalid_input', 'signedTx must be base64 encoded');
        }
    }

    private validateExpect(input: ExpectTx): void {
        eventContext(input);
        uuid(input.actionId, 'actionId');
        uint(input.expectedVer, 'expectedVer');
        if (input.lastValidHeight !== undefined) {
            uint(input.lastValidHeight, 'lastValidHeight');
        }
        if (typeof input.preparedTx !== 'string') {
            throw new ActionStoreError('invalid_input', 'preparedTx must be base64 encoded');
        }
    }

    private validateRead(input: ReadTx): void {
        uuid(input.actionId, 'actionId');
        uuid(input.attemptId, 'attemptId');
        bounded(input.accessKey, 'accessKey', 180);
        bounded(input.gateway, 'gateway', 128);
        bounded(input.fence.owner, 'fence.owner', 128);
        bounded(input.fence.scope, 'fence.scope', 64);
        uint(input.fence.gen, 'fence.gen', true);
        uint(input.fence.epoch, 'fence.epoch', true);
        if (!['dispatch', 'replay'].includes(input.purpose)) {
            throw new ActionStoreError('invalid_input', 'purpose is unsupported');
        }
    }
}
