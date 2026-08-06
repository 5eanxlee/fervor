import bs58 from 'bs58';
import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DbQuery } from '../src/config/database';
import { canonicalJson } from '../src/services/orders/canonicalJson';
import { ProviderMoneySync } from '../src/services/orders/providerMoneySync';
import type { ProviderOrderSnapshot } from '../src/services/orders/provider';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const inputMint = 'So11111111111111111111111111111111111111112';
const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const orderId = '10000000-0000-4000-8000-000000000001';
const depositSignature = bs58.encode(Buffer.alloc(64, 7));
const signature = bs58.encode(Buffer.alloc(64, 8));
const secondSignature = bs58.encode(Buffer.alloc(64, 9));

const order = {
    id: orderId,
    provider: 'jupiter_trigger_v2',
    provider_order_id: 'provider-order-1',
    order_type: 'single',
    cluster: 'mainnet-beta',
    wallet_address: wallet,
    receiver_address: vault,
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount: '10',
};

const snapshot = (): ProviderOrderSnapshot => ({
    providerOrderId: 'provider-order-1',
    orderType: 'single',
    updatedAt: '2026-08-03T20:00:01.000Z',
    walletAddress: wallet,
    vaultAddress: vault,
    inputMint,
    outputMint,
    inputAmount: '10',
    remainingInput: '7',
    inputUsed: '3',
    outputAmount: '9',
    state: 'partially_filled',
    moneyEvents: [
        {
            type: 'deposit',
            state: 'success',
            signature: depositSignature,
            occurredAt: '2026-08-03T19:59:59.000Z',
            mint: inputMint,
            amount: '10',
        },
        {
            type: 'fill',
            state: 'success',
            signature,
            occurredAt: '2026-08-03T20:00:00.000Z',
            mint: inputMint,
            amount: '3',
            outputMint,
            outputAmount: '9',
            orderContext: 'buy_above',
        },
    ],
});

const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length }) as any;

const sourceKey = (
    type: 'deposit' | 'fill' | 'withdrawal',
    eventSignature: string,
    role: 'input' | 'output' | 'movement',
    partMint: string
): string => `provider:jupiter_trigger_v2:part:${crypto.createHash('sha256').update(canonicalJson({
    provider: 'jupiter_trigger_v2',
    providerOrderId: 'provider-order-1',
    type,
    signature: eventSignature,
    role,
    mint: partMint,
})).digest('hex')}`;

const evidenceRow = (params: unknown[], id: string) => ({
    id,
    journal_id: params[1],
    effect_key: params[2],
    evidence_hash: params[3],
    order_id: params[4],
    action_id: params[5],
    source: params[6],
    source_key: params[7],
    cluster: params[8],
    wallet_address: params[9],
    vault_address: params[10],
    mint: params[11],
    raw_state: params[12],
    commitment: params[13],
    signature: params[14],
    slot: params[15],
    instruction_index: params[16],
    event_index: params[17],
    payload_hash: params[18],
    payload: typeof params[19] === 'string' ? JSON.parse(params[19] as string) : params[19],
    payload_canon: params[20],
    source_at: params[21],
    chain_event_id: params[22],
});

const acceptingDb = (): DbQuery => vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO asset_evidence')) {
        return result([evidenceRow(params, crypto.randomUUID())]);
    }
    if (sql.includes('INSERT INTO asset_obligations')) return result([{
        id: crypto.randomUUID(), req_hash: params[2], claim_ver: params[14],
        claim_count: params[15], claim_hash: params[16],
    }]);
    if (sql.includes('INSERT INTO asset_claim_parts')) {
        return result([{ obligation_id: params[0] }]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
}) as unknown as DbQuery;

describe('provider money synchronization', () => {
    it('turns a deposit and fill into exact unresolved claims', async () => {
        let evidenceNo = 0;
        const calls: string[] = [];
        const evidence: unknown[][] = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            calls.push(sql);
            if (sql.includes('INSERT INTO asset_evidence')) {
                evidenceNo += 1;
                evidence.push(params);
                return result([evidenceRow(params, `40000000-0000-4000-8000-00000000000${evidenceNo}`)]);
            }
            if (sql.includes('INSERT INTO asset_obligations')) {
                return result([{
                    id: '50000000-0000-4000-8000-000000000001',
                    req_hash: params[2],
                    claim_ver: params[14],
                    claim_count: params[15],
                    claim_hash: params[16],
                }]);
            }
            if (sql.includes('INSERT INTO asset_claim_parts')) {
                return result([{ obligation_id: '50000000-0000-4000-8000-000000000001' }]);
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;

        await expect(new ProviderMoneySync(db).ingest(
            order, 'jupiter_trigger_v2', snapshot()
        )).resolves.toBe(2);
        expect(calls.filter((sql) => sql.includes('INSERT INTO asset_evidence'))).toHaveLength(3);
        expect(calls.filter((sql) => sql.includes('INSERT INTO asset_obligations'))).toHaveLength(2);
        expect(calls.filter((sql) => sql.includes('INSERT INTO asset_claim_parts'))).toHaveLength(3);
        expect(evidence.map((params) => params[14]).sort()).toEqual([
            depositSignature, signature, signature,
        ].sort());
        expect(evidence.map((params) => params[7]).sort()).toEqual([
            sourceKey('deposit', depositSignature, 'movement', inputMint),
            sourceKey('fill', signature, 'input', inputMint),
            sourceKey('fill', signature, 'output', outputMint),
        ].sort());
        expect(evidence.map((params) => JSON.parse(String(params[19])))).toEqual([
            expect.objectContaining({ event: expect.objectContaining({ type: 'deposit' }) }),
            expect.objectContaining({ event: expect.objectContaining({ orderContext: 'buy_above' }) }),
            expect.objectContaining({ event: expect.objectContaining({ orderContext: 'buy_above' }) }),
        ]);
        expect(evidence.every((params) => params[18] === crypto.createHash('sha256')
            .update(String(params[19])).digest('hex'))).toBe(true);
        expect(evidence.every((params) => params[20] === params[19])).toBe(true);
    });

    it('requires exact conservation of provider fill events', async () => {
        const db = vi.fn() as unknown as DbQuery;
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...snapshot(), remainingInput: '0' }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });

    it('retains every signature and document across partial fills', async () => {
        let evidenceNo = 0;
        let obligationNo = 0;
        const stored: unknown[][] = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO asset_evidence')) {
                evidenceNo += 1;
                stored.push(params);
                return result([evidenceRow(
                    params,
                    `40000000-0000-4000-8000-${String(evidenceNo).padStart(12, '0')}`
                )]);
            }
            if (sql.includes('INSERT INTO asset_obligations')) {
                obligationNo += 1;
                return result([{
                    id: `50000000-0000-4000-8000-${String(obligationNo).padStart(12, '0')}`,
                    req_hash: params[2],
                    claim_ver: params[14],
                    claim_count: params[15],
                    claim_hash: params[16],
                }]);
            }
            if (sql.includes('INSERT INTO asset_claim_parts')) {
                return result([{ obligation_id: params[0] }]);
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const history = snapshot();
        history.remainingInput = '5';
        history.inputUsed = '5';
        history.outputAmount = '13';
        history.moneyEvents = [
            ...(history.moneyEvents || []),
            {
                type: 'fill', state: 'success', signature: secondSignature,
                occurredAt: '2026-08-03T20:00:01.000Z',
                mint: inputMint, amount: '2', outputMint, outputAmount: '4',
                orderContext: 'buy_above',
            },
        ];

        await expect(new ProviderMoneySync(db).ingest(
            order, 'jupiter_trigger_v2', history
        )).resolves.toBe(3);
        expect(stored.map((params) => params[14]).sort()).toEqual([
            depositSignature, signature, signature, secondSignature, secondSignature,
        ].sort());
        expect(new Set(stored.map((params) => JSON.parse(String(params[19])).event.signature)))
            .toEqual(new Set([depositSignature, signature, secondSignature]));
    });

    it('rejects aggregate drift before recording financial facts', async () => {
        const db = vi.fn() as unknown as DbQuery;
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...snapshot(), inputUsed: '4' }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects cross-vault provider events before recording financial facts', async () => {
        const db = vi.fn() as unknown as DbQuery;
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...snapshot(), vaultAddress: inputMint }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects missing and duplicate deposits before recording financial facts', async () => {
        const db = vi.fn() as unknown as DbQuery;
        const history = snapshot();
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...history, moneyEvents: history.moneyEvents?.filter((event) => event.type !== 'deposit') }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...history, moneyEvents: [...(history.moneyEvents || []), {
                type: 'deposit', state: 'success', signature: secondSignature,
                occurredAt: '2026-08-03T19:59:58.000Z', mint: inputMint, amount: '10',
            }] }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects input and output over-withdrawal before recording financial facts', async () => {
        const db = vi.fn() as unknown as DbQuery;
        const history = snapshot();
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...history, moneyEvents: [...(history.moneyEvents || []), {
                type: 'withdrawal', state: 'success', signature: secondSignature,
                occurredAt: '2026-08-03T20:00:02.000Z', mint: outputMint, amount: '10',
            }] }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...history, moneyEvents: [...(history.moneyEvents || []), {
                type: 'withdrawal', state: 'success', signature: secondSignature,
                occurredAt: '2026-08-03T20:00:02.000Z', mint: inputMint, amount: '8',
            }] }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });

    it('requires cancelled orders to return remaining input and produced output', async () => {
        const db = vi.fn() as unknown as DbQuery;
        const history = snapshot();
        const closed = {
            ...history,
            state: 'cancelled' as const,
            rawState: 'cancelled',
            moneyEvents: [...(history.moneyEvents || []), {
                type: 'withdrawal' as const, state: 'success', signature: secondSignature,
                occurredAt: '2026-08-03T20:00:02.000Z', mint: inputMint, amount: '7',
            }],
        };
        await expect(new ProviderMoneySync(db).ingest(
            order, 'jupiter_trigger_v2', closed
        )).rejects.toMatchObject({ code: 'provider_contract_error' });

        closed.moneyEvents.push({
            type: 'withdrawal', state: 'success', signature: bs58.encode(Buffer.alloc(64, 10)),
            occurredAt: '2026-08-03T20:00:03.000Z', mint: outputMint, amount: '9',
        });
        await expect(new ProviderMoneySync(acceptingDb()).ingest(
            order, 'jupiter_trigger_v2', closed
        )).resolves.toBe(4);
    });

    it('requires filled orders to withdraw every produced output unit', async () => {
        const filled: ProviderOrderSnapshot = {
            ...snapshot(),
            state: 'filled',
            rawState: 'fill_success',
            remainingInput: '0',
            inputUsed: '10',
            outputAmount: '20',
            moneyEvents: [
                snapshot().moneyEvents![0],
                {
                    type: 'fill', state: 'success', signature,
                    occurredAt: '2026-08-03T20:00:00.000Z',
                    mint: inputMint, amount: '10', outputMint, outputAmount: '20',
                },
            ],
        };
        const db = vi.fn() as unknown as DbQuery;
        await expect(new ProviderMoneySync(db).ingest(
            order, 'jupiter_trigger_v2', filled
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        filled.moneyEvents!.push({
            type: 'withdrawal', state: 'success', signature: secondSignature,
            occurredAt: '2026-08-03T20:00:01.000Z', mint: outputMint, amount: '20',
        });
        await expect(new ProviderMoneySync(acceptingDb()).ingest(
            order, 'jupiter_trigger_v2', filled
        )).resolves.toBe(3);
    });

    it('fails closed on ungrouped OCO cancellation history', async () => {
        const db = vi.fn() as unknown as DbQuery;
        await expect(new ProviderMoneySync(db).ingest(
            order,
            'jupiter_trigger_v2',
            { ...snapshot(), state: 'cancelled', rawState: 'oco_cancelled' }
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).not.toHaveBeenCalled();
    });
});
