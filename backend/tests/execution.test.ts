import { createHash } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbQuery } from '../src/config/database';
import { env, parseEnv } from '../src/config/env';
import { ExecutionService } from '../src/services/execution/executionService';
import type { ExecutionTxStore } from '../src/services/execution/executionTxStore';
import { JupiterSwapProvider } from '../src/services/execution/jupiterSwapProvider';
import { ExecutionReconciler, resolveChainState } from '../src/services/execution/executionReconciler';
import { ExecutionProviderError, SwapProvider } from '../src/services/execution/provider';
import { jupiterRate } from '../src/services/jupiterRateService';
import { quoteRequestSchema } from '../src/types';
import {
    signTestSwap,
    TestSwapProvider,
    testSwapSignature,
    testSwapWallet,
} from './helpers/testSwapProvider';

const wallet = testSwapWallet;
const inputMint = 'So11111111111111111111111111111111111111112';
const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length }) as any;
const vec = (value: number): Buffer => Buffer.from([value]);
const signerMessage = (...signers: Uint8Array[]): Buffer => Buffer.concat([
    Buffer.from([signers.length, 0, 1]),
    vec(signers.length + 1),
    ...signers.map((signer) => Buffer.from(signer)),
    Buffer.alloc(32),
    Buffer.alloc(32, 11),
    vec(0),
]);
const twoSignerMessage = (feePayer: Uint8Array, signer: Uint8Array): Buffer =>
    signerMessage(feePayer, signer);
const signedWire = (message: Buffer, signatures: Uint8Array[]): string => Buffer.concat([
    vec(signatures.length),
    ...signatures.map((signature) => Buffer.from(signature)),
    message,
]).toString('base64');

const liveSubmission = (id: string) => {
    const taker = nacl.sign.keyPair();
    const address = bs58.encode(taker.publicKey);
    const message = signerMessage(taker.publicKey);
    const signature = nacl.sign.detached(message, taker.secretKey);
    return {
        transaction: signedWire(message, [signature]),
        signature: bs58.encode(signature),
        quote: {
            id,
            user_id: 'user-1',
            wallet_address: address,
            fee_payer: address,
            provider: 'jupiter_swap_v2',
            provider_quote_id: `request-${id}`,
            input_mint: inputMint,
            output_mint: outputMint,
            input_amount: '1',
            output_amount: '2',
            transaction_digest: createHash('sha256').update(message).digest('hex'),
            state: 'quoted',
            expires_at: new Date(Date.now() + 60_000),
        },
    };
};

const executionHarness = () => {
    const quotes = new Map<string, Record<string, unknown>>();
    const executions = new Map<string, Record<string, unknown>>();
    const published: Record<string, unknown>[] = [];
    const db = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO trade_quotes')) {
            const now = new Date();
            quotes.set(String(params[0]), {
                id: params[0], user_id: params[1], wallet_address: params[2], provider: params[3],
                provider_quote_id: params[4], input_mint: params[5], output_mint: params[6],
                input_amount: params[7], output_amount: params[8], min_output_amount: params[9],
                transaction_digest: params[11], state: 'quoted', expires_at: params[13],
                fee_payer: params[14], created_at: now, updated_at: now,
            });
            return result();
        }
        if (sql.includes('pg_advisory_xact_lock')) return result([{}]);
        if (sql.includes('FROM trade_executions') && sql.includes('WHERE user_id')) {
            const row = [...executions.values()].find((item) =>
                item.user_id === params[0] && item.idempotency_key === params[1]
            );
            return result(row ? [row] : []);
        }
        if (sql.includes('SELECT * FROM trade_quotes WHERE id')) {
            const quote = quotes.get(String(params[0]));
            return result(quote && quote.user_id === params[1] ? [quote] : []);
        }
        if (sql.includes('UPDATE trade_quotes')) {
            const quote = quotes.get(String(params[0]));
            if (!quote || quote.state !== 'quoted' || quote.user_id !== params[1]
                || quote.provider !== params[2]) return result();
            quote.state = 'consumed';
            return result([quote]);
        }
        if (sql.includes('INSERT INTO trade_executions')) {
            const now = new Date();
            const row = {
                id: params[0], quote_id: params[1], user_id: params[2], wallet_address: params[3],
                provider: params[4], idempotency_key: params[5], state: 'signed', input_mint: params[6],
                output_mint: params[7], expected_input_amount: params[8], expected_output_amount: params[9],
                signed_tx_digest: params[10], signature: params[11], broadcast_count: 0,
                broadcast_started_at: null, created_at: now, updated_at: now,
            };
            executions.set(String(row.id), row);
            return result([row]);
        }
        if (sql.includes('SELECT provider_quote_id FROM trade_quotes')) {
            const quote = quotes.get(String(params[0]));
            return result(quote ? [{ provider_quote_id: quote.provider_quote_id }] : []);
        }
        if (sql.includes('SET op_token = $2')) {
            const row = executions.get(String(params[0]))!;
            if (row.state !== 'signed' || row.op_token) return result();
            row.op_token = params[1];
            row.op_lease_until = new Date(Date.now() + Number(params[2]));
            return result([row]);
        }
        if (sql.includes('SET op_lease_until = clock_timestamp()')) {
            const row = executions.get(String(params[0]))!;
            if (row.state !== 'signed' || row.op_token !== params[1]
                || (row.op_lease_until as Date).getTime() <= Date.now()) return result();
            row.op_lease_until = new Date(Date.now() + Number(params[2]));
            row.broadcast_started_at ||= new Date();
            row.broadcast_count = Number(row.broadcast_count) + 1;
            return result([row]);
        }
        if (sql.includes('state = CASE WHEN $4')) {
            const row = executions.get(String(params[0]))!;
            Object.assign(row, {
                state: params[3] ? 'submitted' : row.state,
                signature: row.signature || params[3],
                error_code: params[1],
                error_message: params[2],
                provider_status: params[4],
                op_token: null,
                op_lease_until: null,
                updated_at: new Date(),
            });
            return result([{ id: row.id, state: row.state }]);
        }
        if (sql.includes('provider_status = $4')) {
            const row = executions.get(String(params[0]))!;
            Object.assign(row, {
                error_code: params[1],
                error_message: params[2],
                provider_status: params[3],
                op_token: null,
                op_lease_until: null,
                updated_at: new Date(),
            });
            return result([{ id: row.id }]);
        }
        if (sql.includes('UPDATE trade_executions')) {
            const row = executions.get(String(params[0]))!;
            Object.assign(row, {
                state: params[1], signature: row.signature || params[2],
                provider_input_amount: params[3], provider_output_amount: params[4],
                error_code: params[5], error_message: params[6], provider_status: params[7],
                op_token: null, op_lease_until: null, updated_at: new Date(),
            });
            return result([row]);
        }
        if (sql.includes('INSERT INTO execution_events')) return result();
        if (sql.includes('INSERT INTO event_outbox')) {
            published.push(JSON.parse(String(params[2])));
            return result([{ id: `outbox-${published.length}` }]);
        }
        throw new Error(`Unexpected SQL in execution test: ${sql}`);
    }) as unknown as DbQuery;
    const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
    return { db, tx, quotes, executions, published };
};

describe('execution contracts', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not construct a mutation provider in the API service', async () => {
        const service = new ExecutionService();
        expect(service.capabilities()).toMatchObject({
            mode: 'disabled',
            provider: 'none',
            canQuote: false,
            canSubmit: false,
        });
        await expect(service.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '1',
            taker: wallet,
        })).rejects.toMatchObject({ code: 'trading_disabled', status: 503 });
    });

    it('rejects malformed public keys and decimal base-unit amounts', () => {
        expect(() => quoteRequestSchema.parse({
            inputMint: 'not-a-key',
            outputMint,
            inputAmount: '1.5',
            taker: wallet,
        })).toThrow();
    });

    it('forwards explicit landing caps while leaving managed fees opt-in', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            expect(url.searchParams.get('priorityFeeLamports')).toBe('250000');
            expect(url.searchParams.get('jitoTipLamports')).toBe('1000');
            expect(url.searchParams.get('broadcastFeeType')).toBe('maxCap');
            return new Response(JSON.stringify({
                transaction: Buffer.from('fixture transaction').toString('base64'),
                requestId: 'jupiter-request-1',
                inAmount: '1000000',
                outAmount: '990000',
                signatureFeeLamports: 5000,
                prioritizationFeeLamports: 250000,
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetcher);

        const quote = await new JupiterSwapProvider().quote(quoteRequestSchema.parse({
            inputMint,
            outputMint,
            inputAmount: '1000000',
            taker: wallet,
            priorityFeeLamports: 250000,
            jitoTipLamports: 1000,
            broadcastFeeType: 'maxCap',
        }));

        expect(fetcher).toHaveBeenCalledOnce();
        expect(quote.fees.networkLamports).toBe('5000');
        expect(quote.fees.priorityLamports).toBe('250000');
    });

    it('rejects numeric JSON amounts at provider trust boundaries', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            transaction: Buffer.from('fixture transaction').toString('base64'),
            requestId: 'jupiter-request-unsafe',
            inAmount: '1000000',
            outAmount: 9007199254740993,
        })));

        await expect(new JupiterSwapProvider().quote(quoteRequestSchema.parse({
            inputMint,
            outputMint,
            inputAmount: '1000000',
            taker: wallet,
        }))).rejects.toMatchObject({ code: 'provider_contract_error' });
    });

    it('rejects provider fee numbers outside the exact Number boundary', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            transaction: Buffer.from('fixture transaction').toString('base64'),
            requestId: 'jupiter-fee-unsafe',
            inAmount: '1000000',
            outAmount: '990000',
            signatureFeeLamports: Number.MAX_SAFE_INTEGER + 1,
        })));

        await expect(new JupiterSwapProvider().quote(quoteRequestSchema.parse({
            inputMint,
            outputMint,
            inputAmount: '1000000',
            taker: wallet,
        }))).rejects.toMatchObject({ code: 'provider_contract_error' });
    });

    it('treats unknown Jupiter outcomes as uncertain and preserves valid acknowledgements', async () => {
        const signature = '5'.repeat(88);
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            status: 'Failed',
            code: -1001,
            signature,
            error: 'Unknown error',
        })));

        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-unknown',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).rejects.toMatchObject({
            code: 'provider_contract_error',
            uncertain: true,
            ack: { signature, rawStatus: 'Failed' },
        });
    });

    it('rejects malformed signatures instead of confirming or reconciling them', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            status: 'Success',
            code: 0,
            signature: 'not-a-solana-signature',
            totalInputAmount: '1',
            totalOutputAmount: '2',
        })));

        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-malformed',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).rejects.toMatchObject({
            code: 'provider_contract_error',
            uncertain: true,
            ack: { signature: undefined, rawStatus: 'Success' },
        });
    });

    it('retains a valid signature from a Jupiter server error for reconciliation', async () => {
        const signature = '6'.repeat(88);
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            signature,
            error: 'Internal server error',
        }, { status: 500 })));

        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-error',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).rejects.toMatchObject({
            code: 'provider_request_failed',
            retryable: true,
            uncertain: true,
            ack: { signature, rawStatus: 'http_500' },
        });
    });

    it('cancels before execute when rate reservation outlives the call deadline', async () => {
        let reserveResolve!: (delay: number) => void;
        const reserve = new Promise<number>((resolve) => { reserveResolve = resolve; });
        const reserved = vi.spyOn(jupiterRate, 'reserve').mockReturnValue(reserve);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const controller = new AbortController();

        const pending = new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-rate-delay',
            signedTransaction: Buffer.from('signed').toString('base64'),
        }, { signal: controller.signal });
        await vi.waitFor(() => expect(reserved).toHaveBeenCalledWith(
            'execute', expect.any(AbortSignal)
        ));
        const providerSignal = reserved.mock.calls[0][1]!;
        expect(providerSignal).not.toBe(controller.signal);
        controller.abort();
        expect(providerSignal.aborted).toBe(true);

        await expect(pending).rejects.toMatchObject({
            code: 'provider_timeout',
            uncertain: true,
        });
        reserveResolve(0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not hold execution acknowledgement on rate-header persistence', async () => {
        const signature = '5'.repeat(88);
        vi.spyOn(jupiterRate, 'reserve').mockResolvedValue(0);
        const observed = vi.spyOn(jupiterRate, 'observeResult')
            .mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            status: 'Success',
            code: 0,
            signature,
            totalInputAmount: '1',
            totalOutputAmount: '2',
        })));

        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-rate-observe',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).resolves.toMatchObject({ state: 'submitted', signature });
        expect(observed).toHaveBeenCalledOnce();
    });

    it('observes rate headers before a stalled response body times out', async () => {
        vi.spyOn(jupiterRate, 'reserve').mockResolvedValue(0);
        const observed = vi.spyOn(jupiterRate, 'observeResult').mockResolvedValue(1000);
        let parseStarted!: () => void;
        const parsing = new Promise<void>((resolve) => { parseStarted = resolve; });
        const response = new Response(null, {
            status: 429,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.ceil((Date.now() + 1000) / 1000)),
            },
        });
        response.json = vi.fn(async () => {
            parseStarted();
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', vi.fn(async () => response));
        const controller = new AbortController();

        const pending = new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-stalled-body',
            signedTransaction: Buffer.from('signed').toString('base64'),
        }, { signal: controller.signal });
        await parsing;
        expect(observed).toHaveBeenCalledOnce();
        controller.abort();

        await expect(pending).rejects.toMatchObject({
            code: 'provider_timeout',
            uncertain: true,
        });
    });

    it('accepts only documented terminal Jupiter failure codes as failed', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            status: 'Failed',
            code: -1002,
            error: 'Invalid transaction',
        })));

        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-failed',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).resolves.toMatchObject({
            state: 'failed',
            errorCode: '-1002',
            rawStatus: 'Failed',
        });
    });

    it('requires code zero and exact wallet amounts before accepting Jupiter success', async () => {
        const signature = '5'.repeat(88);
        for (const body of [
            { status: 'Success', signature, totalInputAmount: '1', totalOutputAmount: '2' },
            { status: 'Success', code: '0', signature, totalInputAmount: '1', totalOutputAmount: '2' },
            { status: 'Success', code: 0, signature },
        ]) {
            vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
            await expect(new JupiterSwapProvider().submit({
                providerQuoteId: 'jupiter-request-incomplete',
                signedTransaction: Buffer.from('signed').toString('base64'),
            })).rejects.toMatchObject({
                code: 'provider_contract_error',
                uncertain: true,
                ack: { signature, rawStatus: 'Success' },
            });
        }

        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            status: 'Success',
            code: 0,
            signature,
            totalInputAmount: '3',
            totalOutputAmount: '4',
        })));
        await expect(new JupiterSwapProvider().submit({
            providerQuoteId: 'jupiter-request-complete',
            signedTransaction: Buffer.from('signed').toString('base64'),
        })).resolves.toMatchObject({
            state: 'submitted',
            signature,
            inputAmount: '3',
            outputAmount: '4',
        });
    });

    it('enforces deployment fee caps before calling a provider', async () => {
        const provider = new TestSwapProvider();
        const providerQuote = vi.spyOn(provider, 'quote');
        const db = vi.fn() as unknown as DbQuery;
        const service = new ExecutionService(provider, db);

        await expect(service.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '1',
            taker: wallet,
            priorityFeeLamports: 10_000_001,
        })).rejects.toMatchObject({ code: 'priority_fee_too_high', status: 400 });
        expect(providerQuote).not.toHaveBeenCalled();
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects malformed provider transaction encoding before persistence', async () => {
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: async (request) => ({
                provider: 'jupiter_swap_v2', providerQuoteId: 'bad-provider-quote', inputAmount: request.inputAmount,
                outputAmount: '1', minOutputAmount: '1', taker: request.taker, feePayer: request.taker,
                slippageBps: 100, transaction: 'not+canonical/base64!', route: [], fees: {},
            }),
            submit: async () => ({ provider: 'jupiter_swap_v2', state: 'confirmed' }),
        };
        const db = vi.fn() as unknown as DbQuery;
        const service = new ExecutionService(provider, db);
        await expect(service.createQuote('user-1', {
            inputMint, outputMint, inputAmount: '1', taker: wallet,
        })).rejects.toMatchObject({ code: 'provider_contract_error', status: 502 });
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects provider quotes that drift from the signed user intent', async () => {
        const testProvider = new TestSwapProvider();
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: async (request) => ({
                ...await testProvider.quote(request),
                inputAmount: '999999',
            }),
            submit: (input) => testProvider.submit(input),
        };
        const db = vi.fn() as unknown as DbQuery;
        const service = new ExecutionService(provider, db);

        await expect(service.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '1000000',
            taker: wallet,
        })).rejects.toMatchObject({ code: 'provider_contract_error', status: 502 });
        expect(db).not.toHaveBeenCalled();
    });

    it('keeps live financial mutation disabled in the API runtime', () => {
        const base = {
            DATABASE_URL: 'postgres://local/fervor',
            DB_COLOCATED: 'true',
            JWT_SECRET: 'a'.repeat(64),
        } as NodeJS.ProcessEnv;

        expect(() => parseEnv({ ...base, TRADING_MODE: 'fixture' })).toThrow(/Invalid enum value/);
        expect(() => parseEnv({ ...base, ORDER_MODE: 'fixture' })).toThrow(/Invalid enum value/);
        expect(() => parseEnv({ ...base, TRADING_MODE: 'live' })).toThrow(/isolated mutation gateway/);
        expect(() => parseEnv({ ...base, ORDER_MODE: 'live' })).toThrow(/isolated mutation gateway/);
        expect(() => parseEnv({ ...base, ALLOW_LIVE_SUBMISSION: 'true' }))
            .toThrow(/isolated mutation gateway/);
        expect(parseEnv(base)).toMatchObject({
            TRADING_MODE: 'disabled',
            ORDER_MODE: 'disabled',
            ALLOW_LIVE_SUBMISSION: false,
        });
    });

    it('keeps the execution lease beyond the provider timeout boundary', () => {
        const base = {
            DATABASE_URL: 'postgres://local/fervor',
            DB_COLOCATED: 'true',
            JWT_SECRET: 'a'.repeat(64),
            EXECUTION_TIMEOUT_MS: '30000',
        } as NodeJS.ProcessEnv;
        expect(() => parseEnv({
            ...base,
            EXECUTION_OP_LEASE_MS: '34999',
            EXECUTION_RECONCILE_LEASE_MS: '65000',
        }))
            .toThrow(/at least 5000ms/);
        expect(() => parseEnv({
            ...base,
            EXECUTION_OP_LEASE_MS: '35000',
            EXECUTION_RECONCILE_LEASE_MS: '64999',
        })).toThrow(/EXECUTION_RECONCILE_LEASE_MS/);
        expect(parseEnv({
            ...base,
            EXECUTION_OP_LEASE_MS: '35000',
            EXECUTION_RECONCILE_LEASE_MS: '65000',
        })).toMatchObject({
            EXECUTION_OP_LEASE_MS: 35000,
            EXECUTION_RECONCILE_LEASE_MS: 65000,
        });
    });

    it('requires a named KMS key when encrypted transaction storage is configured', () => {
        const base = {
            DATABASE_URL: 'postgres://local/fervor',
            DB_COLOCATED: 'true',
            JWT_SECRET: 'a'.repeat(64),
            TX_KEY_PROVIDER: 'aws_kms',
        } as NodeJS.ProcessEnv;

        expect(() => parseEnv(base)).toThrow(/TX_KMS_KEY_ID/);
        expect(parseEnv({
            ...base,
            TX_KMS_KEY_ID: 'alias/fervor-transactions',
        }).TX_KEY_PROVIDER).toBe('aws_kms');
    });

    it('rejects an unauthenticated fee payer before persistence or provider submission', async () => {
        const feePayer = nacl.sign.keyPair();
        const walletSigner = nacl.sign.keyPair();
        const attacker = nacl.sign.keyPair();
        const message = twoSignerMessage(feePayer.publicKey, walletSigner.publicKey);
        const transaction = signedWire(message, [
            nacl.sign.detached(message, attacker.secretKey),
            nacl.sign.detached(message, walletSigner.secretKey),
        ]);
        const submit = vi.fn();
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: vi.fn(),
            submit,
        };
        const db = vi.fn() as unknown as DbQuery;
        const tx = vi.fn() as unknown as <T>(work: (query: DbQuery) => Promise<T>) => Promise<T>;
        const service = new ExecutionService(provider, db, tx);

        await expect(service.submit('user-1', 'quote-1', {
            signedTransaction: transaction,
            idempotencyKey: 'forged-fee-payer',
        }, 'trace-1')).rejects.toMatchObject({
            code: 'invalid_transaction',
            status: 400,
        });
        expect(bs58.encode(walletSigner.publicKey)).not.toBe(bs58.encode(feePayer.publicKey));
        expect(tx).not.toHaveBeenCalled();
        expect(db).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
    });

    it('accepts only standard or provider-sponsored unsigned quote signer shapes', async () => {
        const taker = nacl.sign.keyPair();
        const payer = nacl.sign.keyPair();
        const extra = nacl.sign.keyPair();
        const takerAddress = bs58.encode(taker.publicKey);
        const provider = (message: Buffer, feePayer: string): SwapProvider => ({
            name: 'jupiter_swap_v2',
            quote: async (request) => ({
                provider: 'jupiter_swap_v2',
                providerQuoteId: 'signer-shape-quote',
                inputAmount: request.inputAmount,
                outputAmount: '2',
                minOutputAmount: '1',
                taker: request.taker,
                feePayer,
                slippageBps: 100,
                transaction: signedWire(message, message[0] === 1
                    ? [Buffer.alloc(64)]
                    : Array.from({ length: message[0] }, () => Buffer.alloc(64))),
                route: [],
                fees: {},
            }),
            submit: vi.fn(),
        });
        const request = {
            inputMint,
            outputMint,
            inputAmount: '1',
            taker: takerAddress,
        };

        for (const [message, feePayer] of [
            [signerMessage(taker.publicKey), takerAddress],
            [twoSignerMessage(payer.publicKey, taker.publicKey), bs58.encode(payer.publicKey)],
        ] as const) {
            const db = vi.fn().mockResolvedValue(result()) as unknown as DbQuery;
            await expect(new ExecutionService(provider(message, feePayer), db).createQuote(
                'user-1', request
            )).resolves.toMatchObject({ feePayer });
            expect(db).toHaveBeenCalledOnce();
        }

        const db = vi.fn() as unknown as DbQuery;
        await expect(new ExecutionService(provider(
            signerMessage(payer.publicKey, taker.publicKey, extra.publicKey),
            bs58.encode(payer.publicKey)
        ), db).createQuote('user-1', request)).rejects.toMatchObject({
            code: 'provider_contract_error',
        });
        expect(db).not.toHaveBeenCalled();
    });

    it('adopts only a sponsored signature bound to the quoted message', async () => {
        const payer = nacl.sign.keyPair();
        const taker = nacl.sign.keyPair();
        const attacker = nacl.sign.keyPair();
        const message = twoSignerMessage(payer.publicKey, taker.publicKey);
        const transaction = signedWire(message, [
            Buffer.alloc(64),
            nacl.sign.detached(message, taker.secretKey),
        ]);
        const quote = {
            id: 'quote-sponsored',
            user_id: 'user-1',
            wallet_address: bs58.encode(taker.publicKey),
            fee_payer: bs58.encode(payer.publicKey),
            provider: 'jupiter_swap_v2',
            provider_quote_id: 'request-sponsored',
            input_mint: inputMint,
            output_mint: outputMint,
            input_amount: '1',
            output_amount: '2',
            transaction_digest: createHash('sha256').update(message).digest('hex'),
        };

        const submit = (signature: string, uncertain = false) => {
            const harness = executionHarness();
            harness.quotes.set(quote.id, { ...quote, state: 'quoted' });
            const provider: SwapProvider = {
                name: 'jupiter_swap_v2',
                quote: vi.fn(),
                submit: vi.fn(async () => {
                    if (uncertain) {
                        throw new ExecutionProviderError(
                            'provider_timeout', 'Timed out', true, 504, undefined, true,
                            { signature, rawStatus: 'timeout' }
                        );
                    }
                    return {
                        provider: 'jupiter_swap_v2',
                        state: 'confirmed',
                        signature,
                        inputAmount: '1',
                        outputAmount: '2',
                        rawStatus: 'Success',
                    };
                }),
            };
            const service = new ExecutionService(provider, harness.db, harness.tx);
            const request = { signedTransaction: transaction, idempotencyKey: `sponsor-${signature}` };
            return { harness, pending: service.submit('user-1', quote.id, request, 'trace-1') };
        };

        const valid = bs58.encode(nacl.sign.detached(message, payer.secretKey));
        await expect(submit(valid).pending).resolves.toMatchObject({
            state: 'confirmed',
            signature: valid,
        });

        const forged = bs58.encode(nacl.sign.detached(message, attacker.secretKey));
        const rejected = await submit(forged);
        await expect(rejected.pending).rejects.toMatchObject({ code: 'submission_ambiguous' });
        expect([...rejected.harness.executions.values()][0]).toMatchObject({
            state: 'signed',
            signature: null,
            provider_status: 'ambiguous:Success',
            error_code: 'provider_contract_error',
        });

        const uncertain = submit(forged, true);
        await expect(uncertain.pending).rejects.toMatchObject({ code: 'submission_ambiguous' });
        expect([...uncertain.harness.executions.values()][0]).toMatchObject({
            state: 'signed',
            signature: null,
            provider_status: 'ambiguous:timeout',
            error_code: 'provider_contract_error',
        });
    });

    it('commits a live execution and its encrypted transaction atomically', async () => {
        const input = liveSubmission('quote-encrypted');
        const harness = executionHarness();
        harness.quotes.set(input.quote.id, input.quote);
        let txDepth = 0;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => {
            txDepth += 1;
            try {
                return await work(harness.db);
            } finally {
                txDepth -= 1;
            }
        };
        const sealed = { marker: 'sealed' };
        const txStore = {
            seal: vi.fn(async (input: Parameters<ExecutionTxStore['seal']>[0]) => ({
                ...sealed,
                executionId: input.executionId,
            })),
            insert: vi.fn(async (db: DbQuery, blob: { executionId: string }) => {
                expect(db).toBe(harness.db);
                expect(txDepth).toBe(1);
                expect(harness.executions.get(blob.executionId)).toMatchObject({
                    broadcast_count: 0,
                    broadcast_started_at: null,
                });
            }),
        } as unknown as ExecutionTxStore;
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: vi.fn(),
            submit: vi.fn(async () => ({
                provider: 'jupiter_swap_v2',
                state: 'confirmed',
                signature: input.signature,
                inputAmount: '1',
                outputAmount: '2',
                rawStatus: 'Success',
            })),
        };
        const priorMode = env.TRADING_MODE;
        (env as { TRADING_MODE: string }).TRADING_MODE = 'live';
        try {
            await expect(new ExecutionService(provider, harness.db, tx, txStore).submit(
                'user-1', input.quote.id, {
                    signedTransaction: input.transaction,
                    idempotencyKey: 'encrypted-execution',
                }, 'trace-encrypted'
            )).resolves.toMatchObject({ state: 'confirmed', signature: input.signature });
        } finally {
            (env as { TRADING_MODE: string }).TRADING_MODE = priorMode;
        }
        expect(txStore.seal).toHaveBeenCalledOnce();
        expect(txStore.insert).toHaveBeenCalledOnce();
        expect(provider.submit).toHaveBeenCalledOnce();
    });

    it('does not persist or execute when live transaction sealing fails', async () => {
        const input = liveSubmission('quote-kms-failure');
        const harness = executionHarness();
        harness.quotes.set(input.quote.id, input.quote);
        const tx = vi.fn(async <T>(work: (query: DbQuery) => Promise<T>) => work(harness.db));
        const txStore = {
            seal: vi.fn().mockRejectedValue(new Error('kms unavailable')),
            insert: vi.fn(),
        } as unknown as ExecutionTxStore;
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: vi.fn(),
            submit: vi.fn(),
        };
        const priorMode = env.TRADING_MODE;
        (env as { TRADING_MODE: string }).TRADING_MODE = 'live';
        try {
            await expect(new ExecutionService(provider, harness.db, tx, txStore).submit(
                'user-1', input.quote.id, {
                    signedTransaction: input.transaction,
                    idempotencyKey: 'kms-failure',
                }, 'trace-kms-failure'
            )).rejects.toThrow('kms unavailable');
        } finally {
            (env as { TRADING_MODE: string }).TRADING_MODE = priorMode;
        }
        expect(tx).not.toHaveBeenCalled();
        expect(txStore.insert).not.toHaveBeenCalled();
        expect(provider.submit).not.toHaveBeenCalled();
        expect(harness.executions.size).toBe(0);
    });

    it('keeps a recovery claim live through the configured KMS timeout', async () => {
        const harness = executionHarness();
        const withRecovery = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return undefined;
        });
        const txStore = { withRecovery } as unknown as ExecutionTxStore;
        const provider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: vi.fn(),
            submit: vi.fn(),
        };
        const previous = {
            batch: env.EXECUTION_RECONCILE_BATCH,
            pool: env.EGRESS_DB_POOL_MAX,
            kms: env.TX_KMS_TIMEOUT_MS,
            op: env.EXECUTION_OP_LEASE_MS,
            reconcile: env.EXECUTION_RECONCILE_LEASE_MS,
        };
        Object.assign(env, {
            EXECUTION_RECONCILE_BATCH: 1,
            EGRESS_DB_POOL_MAX: 1,
            TX_KMS_TIMEOUT_MS: 30_000,
            EXECUTION_OP_LEASE_MS: 6_000,
            EXECUTION_RECONCILE_LEASE_MS: 6_000,
        });
        try {
            await new ExecutionService(provider, harness.db, harness.tx, txStore).recoverBatch();
        } finally {
            Object.assign(env, {
                EXECUTION_RECONCILE_BATCH: previous.batch,
                EGRESS_DB_POOL_MAX: previous.pool,
                TX_KMS_TIMEOUT_MS: previous.kms,
                EXECUTION_OP_LEASE_MS: previous.op,
                EXECUTION_RECONCILE_LEASE_MS: previous.reconcile,
            });
        }

        expect(withRecovery).toHaveBeenCalledWith(
            harness.db,
            35_000,
            env.EXECUTION_SHARD_COUNT,
            env.EXECUTION_SHARD_ID,
            expect.any(Function)
        );
    });

    it('rejects misaligned and out-of-range worker shards', () => {
        const base = {
            NODE_ENV: 'production',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            JWT_SECRET: 'a'.repeat(64),
        } as NodeJS.ProcessEnv;
        expect(() => parseEnv({
            ...base,
            FEED_SHARD_COUNT: '4',
            MATCHER_SHARD_COUNT: '2',
        })).toThrow(/partition-aligned/);
        expect(() => parseEnv({
            ...base,
            FEED_SHARD_COUNT: '4',
            MATCHER_SHARD_COUNT: '4',
            MATCHER_SHARD_ID: '4',
        })).toThrow(/MATCHER_SHARD_ID/);
    });

    it('persists a quote and submits through a transactionally claimed execution', async () => {
        const { db, tx, executions, published } = executionHarness();
        let providerSubmits = 0;
        const provider = new TestSwapProvider();
        const originalSubmit = provider.submit.bind(provider);
        provider.submit = async (input) => {
            providerSubmits += 1;
            return originalSubmit(input);
        };
        const service = new ExecutionService(provider, db, tx);

        const quote = await service.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '1000000',
            taker: wallet,
        });
        const signedQuote = signTestSwap(quote.transaction);
        const execution = await service.submit('user-1', quote.id, {
            signedTransaction: signedQuote,
            idempotencyKey: 'client-order-00000001',
        }, 'trace-0001');

        expect(execution.state).toBe('confirmed');
        expect(bs58.decode(execution.signature!)).toHaveLength(64);
        expect(providerSubmits).toBe(1);
        expect(published.map((event) => (event.payload as Record<string, unknown>).state))
            .toEqual(['signed', 'signed', 'confirmed']);

        const retry = await service.submit('user-1', quote.id, {
            signedTransaction: signedQuote,
            idempotencyKey: 'client-order-00000001',
        }, 'trace-0002');
        expect(retry.id).toBe(execution.id);
        expect(providerSubmits).toBe(1);

        const jupiterProvider = new JupiterSwapProvider();
        const quoteProvider = new TestSwapProvider();
        const unsafeProvider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: (request) => quoteProvider.quote(request),
            submit: (input) => jupiterProvider.submit(input),
        };
        const jupiter = new ExecutionService(unsafeProvider, db, tx);
        const second = await jupiter.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '2000000',
            taker: wallet,
        });
        const secondSigned = signTestSwap(second.transaction);
        const signature = testSwapSignature(secondSigned);
        const executeFetch = vi.fn(async () => Response.json({
            status: 'Success',
            code: 0,
            signature,
            totalInputAmount: Number.MAX_SAFE_INTEGER + 1,
            totalOutputAmount: '1900000',
        }));
        vi.stubGlobal('fetch', executeFetch);
        await expect(jupiter.submit('user-1', second.id, {
            signedTransaction: secondSigned,
            idempotencyKey: 'client-order-00000002',
        }, 'trace-0003')).rejects.toMatchObject({
            code: 'submission_ambiguous',
        });
        const ambiguous = [...executions.values()].find((row) =>
            row.idempotency_key === 'client-order-00000002'
        );
        expect(ambiguous).toMatchObject({
            state: 'submitted',
            signature,
            provider_status: 'ambiguous:Success',
            error_code: 'provider_contract_error',
            op_token: null,
        });
        await expect(jupiter.submit('user-1', second.id, {
            signedTransaction: secondSigned,
            idempotencyKey: 'client-order-00000002',
        }, 'trace-0004')).resolves.toMatchObject({
            state: 'submitted',
            signature,
        });
        expect(executeFetch).toHaveBeenCalledOnce();

        let timeoutSubmits = 0;
        const timeoutBase = new TestSwapProvider();
        const timeoutProvider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: timeoutBase.quote.bind(timeoutBase),
            submit: async (input) => {
                timeoutSubmits += 1;
                if (timeoutSubmits === 1) {
                    throw new ExecutionProviderError(
                        'provider_timeout', 'Timed out after broadcast', true, 504, undefined, true
                    );
                }
                return timeoutBase.submit(input);
            },
        };
        const timeoutService = new ExecutionService(timeoutProvider, db, tx);
        const third = await timeoutService.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '3000000',
            taker: wallet,
        });
        const timeoutRequest = {
            signedTransaction: signTestSwap(third.transaction),
            idempotencyKey: 'client-order-00000003',
        };
        await expect(timeoutService.submit('user-1', third.id, timeoutRequest, 'trace-0005'))
            .rejects.toMatchObject({ code: 'submission_ambiguous', retryable: false });
        await expect(timeoutService.submit('user-1', third.id, timeoutRequest, 'trace-0006'))
            .resolves.toMatchObject({ state: 'submitted' });
        expect(timeoutSubmits).toBe(1);

        const quotaBase = new TestSwapProvider();
        let quotaSubmits = 0;
        const quotaProvider: SwapProvider = {
            name: 'jupiter_swap_v2',
            quote: quotaBase.quote.bind(quotaBase),
            submit: async (input) => {
                quotaSubmits += 1;
                if (quotaSubmits === 1) {
                    throw new ExecutionProviderError(
                        'provider_rate_limited', 'Local provider quota is exhausted', true, 429
                    );
                }
                return quotaBase.submit(input);
            },
        };
        const quotaService = new ExecutionService(quotaProvider, db, tx);
        const fourth = await quotaService.createQuote('user-1', {
            inputMint,
            outputMint,
            inputAmount: '4000000',
            taker: wallet,
        });
        const quotaRequest = {
            signedTransaction: signTestSwap(fourth.transaction),
            idempotencyKey: 'client-order-00000004',
        };
        await expect(quotaService.submit('user-1', fourth.id, quotaRequest, 'trace-0007'))
            .rejects.toMatchObject({ code: 'provider_rate_limited', retryable: true });
        await expect(quotaService.submit('user-1', fourth.id, quotaRequest, 'trace-0008'))
            .resolves.toMatchObject({ state: 'confirmed' });
        expect(quotaSubmits).toBe(2);

    });
});

describe('execution reconciliation', () => {
    it('maps RPC responses into canonical lifecycle states', () => {
        expect(resolveChainState(null)).toBeNull();
        expect(resolveChainState({ slot: 1, err: null, confirmationStatus: 'processed' })).toBe('processed');
        expect(resolveChainState({ slot: 1, err: null, confirmationStatus: 'confirmed' })).toBe('confirmed');
        expect(resolveChainState({ slot: 1, err: null, confirmationStatus: 'finalized' })).toBe('finalized');
        expect(resolveChainState({ slot: 1, err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' })).toBe('failed');
    });

    it('persists and publishes only forward state changes', async () => {
        const rows = [{
            id: 'execution-1',
            signature: '5'.repeat(88),
            state: 'signed',
            wallet_address: wallet,
            fee_payer: wallet,
            input_mint: 'input-mint',
            output_mint: 'output-mint',
            expected_input_amount: '1000',
            min_output_amount: '900',
            provider_input_amount: '1000',
            provider_output_amount: '1000',
            settlement_commitment: null,
        }];
        let selected = false;
        let settlement: unknown[] | undefined;
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('RETURNING execution.id, execution.signature, execution.state')) {
                if (selected) return result();
                selected = true;
                return result(rows);
            }
            if (sql.includes('INSERT INTO execution_settlements')) {
                settlement = params;
                return result();
            }
            if (sql.includes('UPDATE trade_executions')) {
                return result([{ id: 'execution-1', state: 'finalized' }]);
            }
            if (sql.includes('INSERT INTO execution_events')) return result();
            throw new Error(`Unexpected SQL in test: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body));
            if (request.method === 'getSignatureStatuses') {
                return Response.json({
                    jsonrpc: '2.0',
                    result: { value: [{ slot: 42, err: null, confirmationStatus: 'finalized' }] },
                });
            }
            expect(request).toMatchObject({
                method: 'getTransaction',
                params: ['5'.repeat(88), {
                    commitment: 'finalized',
                    encoding: 'jsonParsed',
                    maxSupportedTransactionVersion: 0,
                }],
            });
            return Response.json({
                jsonrpc: '2.0',
                result: {
                    slot: 42,
                    transaction: { signatures: ['5'.repeat(88)] },
                    meta: {
                        err: null,
                        fee: 5000,
                        preTokenBalances: [
                            { accountIndex: 1, mint: 'input-mint', owner: wallet, uiTokenAmount: { amount: '1000' } },
                            { accountIndex: 2, mint: 'output-mint', owner: wallet, uiTokenAmount: { amount: '0' } },
                        ],
                        postTokenBalances: [
                            { accountIndex: 1, mint: 'input-mint', owner: wallet, uiTokenAmount: { amount: '0' } },
                            { accountIndex: 2, mint: 'output-mint', owner: wallet, uiTokenAmount: { amount: '1000' } },
                        ],
                    },
                },
            });
        }) as unknown as typeof fetch;
        const published: Record<string, unknown>[] = [];
        const dbWithOutbox = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO event_outbox')) {
                published.push(JSON.parse(String(params[2])));
                return result([{ id: `outbox-${published.length}` }]);
            }
            return db(sql, params);
        }) as unknown as DbQuery;
        const txWithOutbox = async <T>(work: (query: DbQuery) => Promise<T>) => work(dbWithOutbox);
        const reconciler = new ExecutionReconciler(
            'https://rpc.example.com', dbWithOutbox, txWithOutbox, fetcher
        );

        await expect(reconciler.runBatch()).resolves.toEqual({ checked: 1, updated: 1 });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(settlement?.slice(2, 10)).toEqual([
            'finalized', 42, 'verified', '1000', '1000', '5000', '1000', '1000',
        ]);
        expect(published).toHaveLength(1);
        expect((published[0].payload as Record<string, unknown>).state).toBe('finalized');
        expect(db).toHaveBeenCalledWith(
            expect.stringContaining("state = 'signed' AND broadcast_started_at IS NOT NULL"),
            expect.any(Array)
        );
        expect(db).toHaveBeenCalledWith(
            expect.stringContaining("settlement_commitment IS DISTINCT FROM 'finalized'"),
            expect.any(Array)
        );
    });

    it('quarantines an unsafe RPC slot without starving valid rows in the batch', async () => {
        const rows = [
            { id: 'execution-unsafe', signature: '5'.repeat(88), state: 'submitted' },
            { id: 'execution-valid', signature: '6'.repeat(88), state: 'submitted' },
        ];
        let selected = false;
        let quarantined = false;
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('RETURNING execution.id, execution.signature, execution.state')) {
                if (selected) return result();
                selected = true;
                return result(rows);
            }
            if (sql.includes("provider_status = 'rpc_malformed'")) {
                quarantined = true;
                return result();
            }
            if (sql.includes('UPDATE trade_executions')) return result([{ id: 'execution-valid' }]);
            if (sql.includes('INSERT INTO event_outbox')) return result([{ id: 'outbox-unsafe-slot' }]);
            if (sql.includes('INSERT INTO execution_events')) return result();
            throw new Error(`Unexpected SQL in test: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const fetcher = vi.fn(async () => Response.json({
            jsonrpc: '2.0',
            result: {
                value: [
                    { slot: Number.MAX_SAFE_INTEGER + 1, err: null, confirmationStatus: 'confirmed' },
                    { slot: 43, err: null, confirmationStatus: 'processed' },
                ],
            },
        })) as unknown as typeof fetch;
        const reconciler = new ExecutionReconciler(
            'https://rpc.example.com', db, tx, fetcher
        );

        const pool = env.EGRESS_DB_POOL_MAX;
        const batch = env.EXECUTION_RECONCILE_BATCH;
        Object.assign(env, { EGRESS_DB_POOL_MAX: 2, EXECUTION_RECONCILE_BATCH: 2 });
        try {
            await expect(reconciler.runBatch()).resolves.toEqual({ checked: 2, updated: 1 });
            expect(quarantined).toBe(true);
        } finally {
            Object.assign(env, { EGRESS_DB_POOL_MAX: pool, EXECUTION_RECONCILE_BATCH: batch });
        }
    });

    it('quarantines malformed stored signatures without poisoning valid RPC rows', async () => {
        const rows = [
            { id: 'execution-malformed', signature: 'malformed', state: 'submitted' },
            { id: 'execution-valid', signature: '5'.repeat(88), state: 'submitted' },
        ];
        let selected = false;
        let quarantined = false;
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('RETURNING execution.id, execution.signature, execution.state')) {
                if (selected) return result();
                selected = true;
                return result(rows);
            }
            if (sql.includes("provider_status = 'rpc_malformed'")) {
                quarantined = true;
                return result();
            }
            if (sql.includes('UPDATE trade_executions')) return result([{ id: 'execution-valid' }]);
            if (sql.includes('INSERT INTO event_outbox')) return result([{ id: 'outbox-bad-signature' }]);
            if (sql.includes('INSERT INTO execution_events')) return result();
            throw new Error(`Unexpected SQL in test: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.params[0]).toEqual(['5'.repeat(88)]);
            return Response.json({
                jsonrpc: '2.0',
                result: { value: [{ slot: 44, err: null, confirmationStatus: 'processed' }] },
            });
        }) as unknown as typeof fetch;
        const reconciler = new ExecutionReconciler(
            'https://rpc.example.com', db, tx, fetcher
        );

        const pool = env.EGRESS_DB_POOL_MAX;
        const batch = env.EXECUTION_RECONCILE_BATCH;
        Object.assign(env, { EGRESS_DB_POOL_MAX: 2, EXECUTION_RECONCILE_BATCH: 2 });
        try {
            await expect(reconciler.runBatch()).resolves.toEqual({ checked: 2, updated: 1 });
            expect(quarantined).toBe(true);
            expect(fetcher).toHaveBeenCalledOnce();
        } finally {
            Object.assign(env, { EGRESS_DB_POOL_MAX: pool, EXECUTION_RECONCILE_BATCH: batch });
        }
    });

    it('claims the configured batch while bounding concurrent database work', async () => {
        const rows = Array.from({ length: 5 }, (_, index) => ({
            id: `execution-${index + 1}`,
            signature: bs58.encode(Buffer.alloc(64, index + 1)),
            state: 'submitted',
        }));
        let selected = false;
        let active = 0;
        let maxActive = 0;
        let claimLimit: unknown;
        const renewSizes: number[] = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('RETURNING execution.id, execution.signature, execution.state')) {
                selected = true;
                claimLimit = params[0];
                return result(rows);
            }
            if (sql.includes('SET op_lease_until = clock_timestamp()')) {
                renewSizes.push((params[0] as string[]).length);
                return result((params[0] as string[]).map((id) => ({ id })));
            }
            if (sql.includes('SET state = $2')) {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return result([{ id: params[0] }]);
            }
            if (sql.includes('INSERT INTO execution_events')) return result();
            if (sql.includes('INSERT INTO event_outbox')) return result([{ id: `outbox-${params[0]}` }]);
            if (sql.includes('SET op_token = NULL')) return result();
            throw new Error(`Unexpected SQL in test: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const fetcher = vi.fn(async () => Response.json({
            jsonrpc: '2.0',
            result: {
                value: rows.map((_, index) => ({
                    slot: 50 + index,
                    err: null,
                    confirmationStatus: 'processed',
                })),
            },
        })) as unknown as typeof fetch;
        const reconciler = new ExecutionReconciler('https://rpc.example.com', db, tx, fetcher);

        const pool = env.EGRESS_DB_POOL_MAX;
        const batch = env.EXECUTION_RECONCILE_BATCH;
        Object.assign(env, { EGRESS_DB_POOL_MAX: 2, EXECUTION_RECONCILE_BATCH: 5 });
        try {
            await expect(reconciler.runBatch()).resolves.toEqual({ checked: 5, updated: 5 });
            expect(selected).toBe(true);
            expect(claimLimit).toBe(5);
            expect(maxActive).toBe(2);
            expect(renewSizes).toEqual([2, 1]);
        } finally {
            Object.assign(env, { EGRESS_DB_POOL_MAX: pool, EXECUTION_RECONCILE_BATCH: batch });
        }
    });

    it('uses a new claim generation for every batch', async () => {
        const tokens: unknown[] = [];
        const row = { id: 'execution-1', signature: '5'.repeat(88), state: 'submitted' };
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('RETURNING execution.id, execution.signature, execution.state')) {
                tokens.push(params[3]);
                return result([row]);
            }
            if (sql.includes('SET op_token = NULL')) return result();
            throw new Error(`Unexpected SQL in test: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const fetcher = vi.fn(async () => Response.json({
            jsonrpc: '2.0',
            result: { value: [null] },
        })) as unknown as typeof fetch;
        const reconciler = new ExecutionReconciler('https://rpc.example.com', db, tx, fetcher);

        await reconciler.runBatch();
        await reconciler.runBatch();

        expect(tokens).toHaveLength(2);
        expect(tokens[0]).not.toBe(tokens[1]);
    });
});
