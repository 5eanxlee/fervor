import { randomUUID } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { OrderTxStore } from '../src/services/orders/orderTxStore';

const signedTransaction = () => {
    const signer = nacl.sign.keyPair();
    const message = Buffer.concat([
        Buffer.from([1, 0, 1, 2]),
        Buffer.from(signer.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 7),
        Buffer.from([0]),
    ]);
    const signature = nacl.sign.detached(message, signer.secretKey);
    const bytes = Buffer.concat([Buffer.from([1]), Buffer.from(signature), message]);
    return {
        bytes,
        base64: bytes.toString('base64'),
        prepared: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64'),
        wallet: bs58.encode(signer.publicKey),
    };
};

const missingCosignerTransaction = () => {
    const wallet = nacl.sign.keyPair();
    const cosigner = nacl.sign.keyPair();
    const message = Buffer.concat([
        Buffer.from([2, 0, 1, 3]),
        Buffer.from(wallet.publicKey),
        Buffer.from(cosigner.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 8),
        Buffer.from([0]),
    ]);
    const walletSig = nacl.sign.detached(message, wallet.secretKey);
    return {
        bytes: Buffer.concat([
            Buffer.from([2]), Buffer.from(walletSig), Buffer.alloc(64), message,
        ]),
        base64: Buffer.concat([
            Buffer.from([2]), Buffer.from(walletSig), Buffer.alloc(64), message,
        ]).toString('base64'),
        prepared: Buffer.concat([
            Buffer.from([2]), Buffer.alloc(128), message,
        ]).toString('base64'),
        wallet: bs58.encode(wallet.publicKey),
    };
};

const actionRow = (tx: ReturnType<typeof signedTransaction>) => ({
    id: randomUUID(),
    order_id: randomUUID(),
    user_id: randomUUID(),
    leg_id: null,
    parent_action: null,
    kind: 'cancel_confirm',
    rule_ver: 1,
    client_key: 'confirm-cancel:test',
    req_hash: 'a'.repeat(64),
    desired_hash: 'b'.repeat(64),
    expected_ver: '0',
    action_ver: '0',
    work_state: 'queued',
    effect_state: 'not_possible',
    outcome: 'pending',
    block_reason: null,
    provider: 'jupiter_trigger_v2',
    provider_req_id: null,
    provider_order_id: 'provider-order',
    first_signature: null,
    message_hash: null,
    recent_blockhash: null,
    last_valid_height: null,
    attempt_count: 0,
    due_at: new Date('2026-08-03T00:00:00.000Z'),
    lease_owner: null,
    lease_gen: '0',
    write_scope: null,
    write_epoch: null,
    lease_until: null,
    ambiguity_at: null,
    provider_check_at: null,
    chain_check_at: null,
    error_code: null,
    error_class: null,
    error_message: null,
    http_class: null,
    retry_after: null,
    completed_at: null,
    created_at: new Date('2026-08-03T00:00:00.000Z'),
    updated_at: new Date('2026-08-03T00:00:00.000Z'),
    tx_cluster: 'mainnet-beta',
    tx_wallet: tx.wallet,
    blob_aad_hash: null,
    blob_aad_ver: null,
    blob_alg: null,
    blob_ciphertext: null,
    blob_nonce: null,
    blob_wrapped_key: null,
    blob_key_id: null,
    blob_order: null,
    blob_cluster: null,
    blob_wallet: null,
    blob_message_hash: null,
    blob_raw_hash: null,
    blob_signature: null,
    blob_size: null,
    blob_expires_at: null,
    blob_purged_at: null,
    blob_live: null,
});

class FakeDb {
    readonly row;
    readonly outbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
    readonly inserts: unknown[][] = [];
    readonly access = new Map<string, unknown[]>();
    readonly sql: string[] = [];
    readonly transaction = vi.fn(async (work: (db: typeof this.query) => Promise<unknown>) => (
        work(this.query)
    ));

    constructor(tx: ReturnType<typeof signedTransaction>) {
        this.row = actionRow(tx);
    }

    readonly query = async (sql: string, params: unknown[] = []) => {
        this.sql.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('SELECT action.order_id FROM order_actions')) {
            return { rows: [{ order_id: this.row.order_id }], rowCount: 1 };
        }
        if (sql.includes('SELECT 1 FROM order_intents order_row')) {
            return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        if (sql.includes('SELECT action.*')) return { rows: [{ ...this.row }], rowCount: 1 };
        if (sql.includes('UPDATE order_actions')) {
            if (params.length === 5) {
                this.row.action_ver = '1';
                this.row.work_state = 'awaiting_sig';
                this.row.message_hash = String(params[2]);
                this.row.recent_blockhash = String(params[3]);
                this.row.last_valid_height = params[4] === null ? null : String(params[4]);
            } else {
                this.row.action_ver = '2';
                this.row.work_state = 'ready';
                this.row.first_signature = String(params[2]);
            }
            return { rows: [this.row], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO order_tx_blobs')) {
            this.inserts.push(params);
            const expires = new Date(Date.now() + 900_000);
            this.row.blob_aad_hash = String(params[9]);
            this.row.blob_aad_ver = 2;
            this.row.blob_alg = String(params[4]);
            this.row.blob_ciphertext = params[5] as Buffer;
            this.row.blob_nonce = params[6] as Buffer;
            this.row.blob_wrapped_key = params[7] as Buffer;
            this.row.blob_key_id = String(params[8]);
            this.row.blob_order = this.row.order_id;
            this.row.blob_cluster = this.row.tx_cluster;
            this.row.blob_wallet = this.row.tx_wallet;
            this.row.blob_message_hash = String(params[10]);
            this.row.blob_raw_hash = String(params[11]);
            this.row.blob_signature = String(params[12]);
            this.row.blob_size = Number(params[13]);
            this.row.blob_expires_at = expires;
            this.row.blob_live = true;
            return { rows: [{ expires_at: expires }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO order_blob_reads')) {
            const key = String(params[1]);
            if (this.access.has(key)) return { rows: [], rowCount: 0 };
            this.access.set(key, params);
            return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        if (sql.includes('FROM order_blob_reads')) {
            const stored = this.access.get(String(params[0]));
            const exact = stored !== undefined && [2, 3, 4, 5, 6, 7, 8, 9]
                .every((index, offset) => stored[index] === params[offset + 1]);
            return { rows: exact ? [{ id: stored![0] }] : [], rowCount: exact ? 1 : 0 };
        }
        if (sql.includes('assert_blob_access')) return { rows: [{}], rowCount: 1 };
        if (sql.includes('SELECT order_ver')) {
            return {
                rows: [{ order_ver: '1', event_at: new Date('2026-08-03T00:00:01.000Z') }],
                rowCount: 1,
            };
        }
        return { rows: [], rowCount: 1 };
    };
}

describe('order signed transaction store', () => {
    it('binds exact signed bytes once and never writes plaintext to PostgreSQL', async () => {
        const tx = signedTransaction();
        const db = new FakeDb(tx);
        const plaintext = Buffer.alloc(32, 5);
        const keys = {
            generate: vi.fn().mockResolvedValue({
                plaintext,
                wrapped: Buffer.alloc(64, 9),
                keyId: 'arn:aws:kms:us-west-2:123456789012:key/fervor',
            }),
            unwrap: vi.fn().mockImplementation(async () => Buffer.alloc(32, 5)),
        };
        const store = new OrderTxStore(db as never, keys, db.outbox, 900_000);
        const input = {
            actionId: db.row.id,
            expectedVer: '1',
            signedTx: tx.base64,
            traceId: 'trace-bind-tx',
            actor: 'user' as const,
        };

        await expect(store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            lastValidHeight: '420000000',
            traceId: 'trace-expect-tx',
            actor: 'provider',
        })).resolves.toMatchObject({
            replayed: false,
            expectation: { actionId: db.row.id, orderId: db.row.order_id },
        });
        await expect(store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            lastValidHeight: '420000001',
            traceId: 'trace-expect-height-conflict',
            actor: 'provider',
        })).rejects.toMatchObject({ code: 'idempotency_conflict' });
        await expect(store.bind({
            ...input,
            signedTx: signedTransaction().base64,
        })).rejects.toMatchObject({ code: 'idempotency_conflict' });
        expect(keys.generate).not.toHaveBeenCalled();

        const first = await store.bind(input);
        expect(first).toMatchObject({
            replayed: false,
            binding: {
                actionId: db.row.id,
                orderId: db.row.order_id,
                alg: 'aes_256_gcm',
                byteSize: tx.bytes.length,
            },
        });
        expect(plaintext.equals(Buffer.alloc(32))).toBe(true);
        expect(db.inserts).toHaveLength(1);
        expect(db.inserts[0][5]).not.toEqual(tx.bytes);
        expect(db.inserts.flat().some((value) => value === tx.base64)).toBe(false);
        expect(db.outbox.enqueue).toHaveBeenCalledTimes(2);

        const reloaded = new OrderTxStore(db as never, keys, db.outbox, 900_000);
        let borrowed = Buffer.alloc(0);
        const access = {
            actionId: db.row.id,
            attemptId: randomUUID(),
            accessKey: `dispatch:${randomUUID()}`,
            fence: { owner: 'gateway-1', gen: '1', scope: 'provider:jupiter', epoch: '1' },
            gateway: 'gateway-1',
            purpose: 'dispatch',
        } as const;
        await expect(reloaded.withTx(access, (bytes) => {
            borrowed = bytes;
            return Buffer.from(bytes);
        })).resolves.toEqual(tx.bytes);
        expect(borrowed).toEqual(Buffer.alloc(tx.bytes.length));
        await expect(reloaded.withTx(access, (bytes) => Buffer.from(bytes)))
            .resolves.toEqual(tx.bytes);
        await expect(reloaded.withTx({ ...access, gateway: 'gateway-2' }, () => undefined))
            .rejects.toMatchObject({ code: 'idempotency_conflict' });
        expect(keys.unwrap).toHaveBeenCalledWith(
            Buffer.alloc(64, 9),
            'arn:aws:kms:us-west-2:123456789012:key/fervor',
            expect.objectContaining({ actionId: db.row.id, aadHash: first.binding.aadHash })
        );

        await expect(store.bind(input)).resolves.toMatchObject({ replayed: true });
        expect(keys.generate).toHaveBeenCalledTimes(1);
        expect(db.transaction).toHaveBeenCalledTimes(6);
        expect(db.outbox.enqueue).toHaveBeenCalledTimes(2);

        db.row.blob_expires_at = new Date(Date.now() - 1);
        db.row.blob_live = false;
        await expect(store.bind(input)).rejects.toMatchObject({ code: 'state_conflict' });
        expect(keys.generate).toHaveBeenCalledTimes(1);
    });

    it('rejects a provider message that does not require the order wallet', async () => {
        const tx = signedTransaction();
        const db = new FakeDb(tx);
        db.row.tx_wallet = bs58.encode(nacl.sign.keyPair().publicKey);
        const keys = { generate: vi.fn(), unwrap: vi.fn() };
        const store = new OrderTxStore(db as never, keys, db.outbox);

        await expect(store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            traceId: 'trace-wrong-wallet',
            actor: 'provider',
        })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(keys.generate).not.toHaveBeenCalled();
    });

    it('locks the aggregate before the action on every prepared-message write', async () => {
        const tx = signedTransaction();
        const db = new FakeDb(tx);
        const store = new OrderTxStore(db as never, { generate: vi.fn(), unwrap: vi.fn() }, db.outbox);

        await store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            traceId: 'trace-lock-order',
            actor: 'provider',
        });

        const orderLock = db.sql.findIndex((sql) => (
            sql.includes('FROM order_intents order_row') && sql.includes('FOR UPDATE')
        ));
        const actionLock = db.sql.findIndex((sql) => (
            sql.includes('SELECT action.*') && sql.includes('FOR UPDATE OF action')
        ));
        expect(orderLock).toBeGreaterThanOrEqual(0);
        expect(actionLock).toBeGreaterThan(orderLock);
    });

    it('erases parsed bytes when a provider submits an already-signed preparation', async () => {
        const tx = signedTransaction();
        const db = new FakeDb(tx);
        const wiped: Buffer[] = [];
        const fill = Buffer.prototype.fill;
        const spy = vi.spyOn(Buffer.prototype, 'fill').mockImplementation(function (...args) {
            const result = fill.apply(this, args as Parameters<Buffer['fill']>);
            if (this.length === tx.bytes.length && this.every((byte) => byte === 0)) {
                wiped.push(this);
            }
            return result;
        });
        try {
            const store = new OrderTxStore(
                db as never,
                { generate: vi.fn(), unwrap: vi.fn() },
                db.outbox
            );
            await expect(store.expect({
                actionId: db.row.id,
                expectedVer: '0',
                preparedTx: tx.base64,
                traceId: 'trace-signed-preparation',
                actor: 'provider',
            })).rejects.toMatchObject({ code: 'invalid_input' });
            expect(wiped).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('rejects a signed transaction with any missing required signer', async () => {
        const tx = missingCosignerTransaction();
        const db = new FakeDb(tx);
        const keys = { generate: vi.fn(), unwrap: vi.fn() };
        const store = new OrderTxStore(db as never, keys, db.outbox);
        await store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            traceId: 'trace-cosigner-expect',
            actor: 'provider',
        });

        await expect(store.bind({
            actionId: db.row.id,
            expectedVer: '1',
            signedTx: tx.base64,
            traceId: 'trace-cosigner-bind',
            actor: 'user',
        })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(keys.generate).not.toHaveBeenCalled();
    });

    it('rejects prepared identity drift observed under the binding row lock', async () => {
        const tx = signedTransaction();
        const db = new FakeDb(tx);
        const plaintext = Buffer.alloc(32, 6);
        const keys = {
            generate: vi.fn().mockResolvedValue({
                plaintext,
                wrapped: Buffer.alloc(64),
                keyId: 'arn:aws:kms:us-west-2:123456789012:key/fervor',
            }),
            unwrap: vi.fn(),
        };
        const store = new OrderTxStore(db as never, keys, db.outbox);
        await store.expect({
            actionId: db.row.id,
            expectedVer: '0',
            preparedTx: tx.prepared,
            lastValidHeight: '420000000',
            traceId: 'trace-drift-expect',
            actor: 'provider',
        });
        db.transaction.mockImplementationOnce(async (work) => {
            db.row.last_valid_height = '420000001';
            return work(db.query);
        });

        await expect(store.bind({
            actionId: db.row.id,
            expectedVer: '1',
            signedTx: tx.base64,
            traceId: 'trace-drift-bind',
            actor: 'user',
        })).rejects.toMatchObject({ code: 'idempotency_conflict' });
        expect(plaintext).toEqual(Buffer.alloc(32));
        expect(db.inserts).toHaveLength(0);
    });
});
