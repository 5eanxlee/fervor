import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jupiterRate } from '../src/services/jupiterRateService';
import { JupiterTriggerProvider } from '../src/services/orders/jupiterTriggerProvider';
import { orderRequestSchema } from '../src/types';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const vault = 'So11111111111111111111111111111111111111112';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const inputAccount = bs58.encode(Buffer.alloc(32, 11));
const outputAccount = bs58.encode(Buffer.alloc(32, 12));
const token = 'provider-jwt';
const depositSig = bs58.encode(Buffer.alloc(64, 5));
const fillSig = bs58.encode(Buffer.alloc(64, 6));

const signedCancel = (): { transaction: string; signature: string } => {
    const keypair = nacl.sign.keyPair();
    const message = Buffer.concat([
        Buffer.from([1, 0, 1, 2]),
        Buffer.from(keypair.publicKey),
        Buffer.alloc(32),
        Buffer.alloc(32, 7),
        Buffer.from([0]),
    ]);
    const signature = nacl.sign.detached(message, keypair.secretKey);
    return {
        transaction: Buffer.concat([
            Buffer.from([1]), Buffer.from(signature), message,
        ]).toString('base64'),
        signature: bs58.encode(signature),
    };
};

const request = () => orderRequestSchema.parse({
    orderType: 'single',
    walletAddress: wallet,
    inputMint: vault,
    outputMint: usdc,
    inputAmount: '1000000000',
    triggerMint: vault,
    triggerCondition: 'above',
    triggerPriceUsd: 250,
    slippageBps: 100,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientOrderId: 'provider-order-00000001',
});

const otoco = () => orderRequestSchema.parse({
    orderType: 'otoco',
    walletAddress: wallet,
    inputMint: usdc,
    outputMint: vault,
    inputAmount: '200000000',
    triggerMint: vault,
    triggerCondition: 'below',
    triggerPriceUsd: 180,
    takeProfitPriceUsd: 220,
    stopLossPriceUsd: 160,
    slippageBps: 100,
    takeProfitSlippageBps: 125,
    stopLossSlippageBps: 150,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    clientOrderId: 'provider-otoco-00000001',
});

describe('Jupiter Trigger V2 adapter', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('supports non-broadcast transaction challenges for hardware wallets', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/auth/challenge')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    walletPubkey: wallet, type: 'transaction',
                });
                return Response.json({ type: 'transaction', transaction: 'unsigned-challenge' });
            }
            if (url.pathname.endsWith('/auth/verify')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    walletPubkey: wallet,
                    type: 'transaction',
                    signedTransaction: 'signed-challenge',
                });
                return Response.json({ token: 'hardware-wallet-token' });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);
        const provider = new JupiterTriggerProvider();

        await expect(provider.challenge(wallet, 'transaction')).resolves.toEqual({
            type: 'transaction', transaction: 'unsigned-challenge',
        });
        await expect(provider.verify(wallet, {
            type: 'transaction', signedTransaction: 'signed-challenge',
        })).resolves.toBe('hardware-wallet-token');
    });

    it('registers a missing vault and validates the crafted deposit contract', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            expect(init?.headers).toMatchObject({
                Authorization: `Bearer ${token}`,
                'x-api-key': 'test-jupiter-api-key',
            });
            if (url.pathname.endsWith('/vault')) {
                return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 });
            }
            if (url.pathname.endsWith('/vault/register')) {
                expect(init?.method).toBeUndefined();
                return Response.json({ userPubkey: wallet, vaultPubkey: vault });
            }
            if (url.pathname.endsWith('/deposit/craft')) {
                expect(init?.method).toBe('POST');
                expect(JSON.parse(String(init.body))).toMatchObject({
                    amount: '1000000000',
                    inputMint: vault,
                    orderType: 'price',
                    orderSubType: 'single',
                    userAddress: wallet,
                });
                return Response.json({
                    transaction: Buffer.from('deposit').toString('base64'),
                    requestId: 'deposit-request-1',
                    receiverAddress: vault,
                    mint: vault,
                    amount: '1000000000',
                    inputTokenAccount: inputAccount,
                });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);

        const prepared = await new JupiterTriggerProvider().prepare(request(), token);
        expect(prepared).toMatchObject({
            depositRequestId: 'deposit-request-1',
            receiverAddress: vault,
            inputAccount,
        });
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('rejects numeric deposit amounts even when they are within Number precision', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/vault')) {
                return Response.json({ userPubkey: wallet, vaultPubkey: vault });
            }
            return Response.json({
                transaction: Buffer.from('deposit').toString('base64'),
                requestId: 'deposit-request-unsafe',
                receiverAddress: vault,
                mint: vault,
                amount: 1000000000,
                inputTokenAccount: inputAccount,
            });
        }));

        await expect(new JupiterTriggerProvider().prepare(request(), token)).rejects.toMatchObject({
            code: 'provider_contract_error',
        });
    });

    it('binds OTOCO deposit accounts and parent and child trigger parameters', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/vault')) {
                return Response.json({ userPubkey: wallet, vaultPubkey: vault });
            }
            if (url.pathname.endsWith('/deposit/craft')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    inputMint: usdc,
                    outputMint: vault,
                    userAddress: wallet,
                    amount: '200000000',
                    orderType: 'price',
                    orderSubType: 'otoco',
                });
                return Response.json({
                    transaction: Buffer.from('otoco-deposit').toString('base64'),
                    requestId: 'deposit-otoco-1',
                    receiverAddress: vault,
                    mint: usdc,
                    amount: '200000000',
                    inputTokenAccount: inputAccount,
                    outputTokenAccount: outputAccount,
                });
            }
            if (url.pathname.endsWith('/orders/price/provider-otoco-1')) {
                expect(init?.method).toBe('PATCH');
                expect(JSON.parse(String(init.body))).toEqual({
                    orderType: 'otoco',
                    triggerPriceUsd: 185,
                    slippageBps: 110,
                    tpPriceUsd: 225,
                    slPriceUsd: 165,
                });
                return Response.json({ id: 'provider-otoco-1' });
            }
            if (url.pathname.endsWith('/orders/price')) {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    orderType: 'otoco',
                    depositRequestId: 'deposit-otoco-1',
                    triggerCondition: 'below',
                    triggerPriceUsd: 180,
                    slippageBps: 100,
                    tpPriceUsd: 220,
                    slPriceUsd: 160,
                    tpSlippageBps: 125,
                    slSlippageBps: 150,
                });
                return Response.json({ id: 'provider-otoco-1' });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);
        const provider = new JupiterTriggerProvider();
        await expect(provider.prepare(otoco(), token)).resolves.toMatchObject({
            inputAccount, outputAccount,
        });
        await expect(provider.activate(
            otoco(), 'deposit-otoco-1', 'signed-deposit', token
        )).resolves.toMatchObject({ providerOrderId: 'provider-otoco-1', state: 'open' });
        await expect(provider.update('provider-otoco-1', {
            orderType: 'otoco', triggerPriceUsd: 185, slippageBps: 110,
            takeProfitPriceUsd: 225, stopLossPriceUsd: 165,
        }, token)).resolves.toBeUndefined();
    });

    it('rejects an OTOCO deposit without its dedicated output account', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/vault')) {
                return Response.json({ userPubkey: wallet, vaultPubkey: vault });
            }
            return Response.json({
                transaction: Buffer.from('otoco-deposit').toString('base64'),
                requestId: 'deposit-otoco-missing',
                receiverAddress: vault,
                mint: usdc,
                amount: '200000000',
                inputTokenAccount: inputAccount,
            });
        }));

        await expect(new JupiterTriggerProvider().prepare(otoco(), token)).rejects.toMatchObject({
            code: 'provider_contract_error', uncertain: true,
        });
    });

    it('keeps an unconfirmed deposit activating and supports in-place updates', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/orders/price')) {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    depositRequestId: 'deposit-request-1',
                    depositSignedTx: 'signed-deposit',
                    triggerPriceUsd: 250,
                });
                return Response.json({ id: 'provider-order-1', depositConfirmed: false });
            }
            if (url.pathname.endsWith('/orders/price/provider-order-1')) {
                expect(init?.method).toBe('PATCH');
                expect(JSON.parse(String(init.body))).toEqual({
                    orderType: 'single',
                    triggerPriceUsd: 300,
                });
                return Response.json({ id: 'provider-order-1' });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);
        const provider = new JupiterTriggerProvider();

        await expect(provider.activate(request(), 'deposit-request-1', 'signed-deposit', token))
            .resolves.toMatchObject({ state: 'activating', rawState: 'depositing' });
        await expect(provider.update('provider-order-1', {
            orderType: 'single', triggerPriceUsd: 300,
        }, token)).resolves.toBeUndefined();
    });

    it('merges active and past history and exposes provider retry timing', async () => {
        const fetcher = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.searchParams.get('state') === 'active') {
                return Response.json({
                    orders: [{
                        id: 'provider-order-1',
                        orderType: 'single',
                        updatedAt: 1800000000,
                        userPubkey: wallet,
                        privyWalletPubkey: vault,
                        inputMint: vault,
                        outputMint: usdc,
                        initialInputAmount: '1000000000',
                        remainingInputAmount: '750000000',
                        orderState: 'executing',
                        rawState: 'partial_fill_success',
                        fillPercent: 0.25,
                        inputUsed: '250000000',
                        outputAmount: '125000000',
                        triggerPriceUsd: 210,
                        trailingBps: 500,
                        slippageBps: 150,
                        tpPriceUsd: 260,
                        slPriceUsd: 180,
                        tpSlippageBps: 100,
                        slSlippageBps: 200,
                        highWatermark: 220,
                        events: [{
                            type: 'deposit', timestamp: 1799999900000, txSignature: depositSig,
                            state: 'success', mint: vault, amount: '1000000000',
                        }, {
                            type: 'fill', timestamp: 1799999950000, state: 'failed',
                        }, {
                            type: 'fill', timestamp: 1800000000000, txSignature: fillSig,
                            state: 'success', mint: vault, amount: '250000000',
                            outputMint: usdc, outputAmount: '125000000', orderContext: 'buy_above',
                        }],
                    }],
                    pagination: { total: 1 },
                });
            }
            if (url.searchParams.get('state') === 'past') {
                return Response.json({
                    orders: [{
                        id: 'provider-order-2', orderType: 'single', updatedAt: 1800000100000,
                        userPubkey: wallet, privyWalletPubkey: vault,
                        inputMint: vault, outputMint: usdc,
                        initialInputAmount: '1000000000', remainingInputAmount: '0',
                        orderState: 'filled', rawState: 'fill_success', fillPercent: 1,
                        inputUsed: '1000000000', outputAmount: '500000000',
                        events: [{
                            type: 'deposit', timestamp: 1799999900000, txSignature: depositSig,
                            state: 'success', mint: vault, amount: '1000000000',
                        }, {
                            type: 'fill', timestamp: 1800000100000,
                            txSignature: bs58.encode(Buffer.alloc(64, 7)),
                            state: 'success', mint: vault, amount: '1000000000',
                            outputMint: usdc, outputAmount: '500000000', orderContext: 'buy_above',
                        }, {
                            type: 'withdrawal', timestamp: 1800000101000,
                            txSignature: bs58.encode(Buffer.alloc(64, 8)),
                            state: 'success', mint: usdc, amount: '500000000',
                        }],
                    }],
                    pagination: { total: 1 },
                });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);

        await expect(new JupiterTriggerProvider().history(token)).resolves.toEqual([
            expect.objectContaining({
                providerOrderId: 'provider-order-1',
                updatedAt: '2027-01-15T08:00:00.000Z',
                state: 'partially_filled',
                fillPercent: 0.25,
                trailingBps: 500,
                triggerPriceUsd: 210,
                slippageBps: 150,
                takeProfitPriceUsd: 260,
                stopLossPriceUsd: 180,
                takeProfitSlippageBps: 100,
                stopLossSlippageBps: 200,
                fillSignature: fillSig,
                inputUsed: '250000000',
                outputAmount: '125000000',
                moneyEvents: expect.arrayContaining([
                    expect.objectContaining({ type: 'deposit', amount: '1000000000' }),
                    expect.objectContaining({ type: 'fill', outputAmount: '125000000' }),
                ]),
            }),
            expect.objectContaining({ providerOrderId: 'provider-order-2', state: 'filled' }),
        ]);

        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ error: { message: 'slow down' } }),
            { status: 429, headers: { 'retry-after': '3' } }
        )));
        await expect(new JupiterTriggerProvider().history(token)).rejects.toMatchObject({
            code: 'provider_rate_limited',
            retryable: true,
            retryAfterMs: 3000,
        });
    });

    it('rejects numeric provider history amounts before projection', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            orders: [{
                id: 'provider-order-unsafe',
                orderType: 'single',
                updatedAt: 1800000000,
                userPubkey: wallet,
                privyWalletPubkey: vault,
                inputMint: vault,
                outputMint: usdc,
                initialInputAmount: '1000000000',
                remainingInputAmount: '500000000',
                orderState: 'executing',
                fillPercent: 0.5,
                inputUsed: 9007199254740993,
                events: [],
            }],
            pagination: { total: 1 },
        })));

        await expect(new JupiterTriggerProvider().history(token)).rejects.toMatchObject({
            code: 'provider_contract_error',
        });
    });

    it('validates the two-step cancellation contract', async () => {
        const signed = signedCancel();
        const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.includes('/confirm-cancel/')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    signedTransaction: signed.transaction,
                    cancelRequestId: 'cancel-request-1',
                });
                return Response.json({ id: 'provider-order-1', txSignature: signed.signature });
            }
            if (url.pathname.includes('/cancel/')) {
                return Response.json({
                    id: 'provider-order-1',
                    transaction: 'unsigned-withdrawal',
                    requestId: 'cancel-request-1',
                });
            }
            throw new Error(`Unexpected provider request: ${url}`);
        });
        vi.stubGlobal('fetch', fetcher);
        const provider = new JupiterTriggerProvider();

        await expect(provider.cancel('provider-order-1', token)).resolves.toEqual({
            requestId: 'cancel-request-1', transaction: 'unsigned-withdrawal',
        });
        await expect(provider.confirmCancel(
            'provider-order-1', 'cancel-request-1', signed.transaction, token
        )).resolves.toEqual({
            state: 'cancelled', signature: signed.signature, rawState: 'cancelled',
        });
    });

    it('rejects mismatched cancellation identities and signatures', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            id: 'different-order',
            transaction: 'unsigned-withdrawal',
            requestId: 'cancel-request-1',
        })));
        const provider = new JupiterTriggerProvider();
        await expect(provider.cancel('provider-order-1', token)).rejects.toMatchObject({
            code: 'provider_contract_error',
        });

        const sent = signedCancel();
        const other = signedCancel();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            id: 'provider-order-1', txSignature: other.signature,
        })));
        await expect(provider.confirmCancel(
            'provider-order-1', 'cancel-request-1', sent.transaction, token
        )).rejects.toMatchObject({ code: 'provider_contract_error', uncertain: true });
    });

    it('cancels before transport when rate admission stalls', async () => {
        let reserveResolve!: (delay: number) => void;
        const reserve = new Promise<number>((resolve) => { reserveResolve = resolve; });
        const reserved = vi.spyOn(jupiterRate, 'reserve').mockReturnValue(reserve);
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const controller = new AbortController();

        const result = new JupiterTriggerProvider().history(token, controller.signal);
        await vi.waitFor(() => expect(reserved).toHaveBeenCalledWith(
            'main', expect.any(AbortSignal)
        ));
        const providerSignal = reserved.mock.calls[0][1]!;
        controller.abort(new Error('gateway deadline'));
        expect(providerSignal.aborted).toBe(true);
        await expect(result).rejects.toMatchObject({
            code: 'provider_timeout', retryable: true, status: 504,
        });
        reserveResolve(0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not hold responses on rate persistence', async () => {
        vi.spyOn(jupiterRate, 'reserve').mockResolvedValue(0);
        const observed = vi.spyOn(jupiterRate, 'observeResult')
            .mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            orders: [], pagination: { total: 0 },
        })));

        await expect(new JupiterTriggerProvider().history(token)).resolves.toEqual([]);
        expect(observed).toHaveBeenCalledTimes(2);
    });

    it('cancels stalled response parsing', async () => {
        vi.spyOn(jupiterRate, 'reserve').mockResolvedValue(0);
        let parseStarted!: () => void;
        const parsing = new Promise<void>((resolve) => { parseStarted = resolve; });
        const response = Response.json({});
        response.json = vi.fn(async () => {
            parseStarted();
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', vi.fn(async () => response));
        const controller = new AbortController();

        const result = new JupiterTriggerProvider().history(token, controller.signal);
        await parsing;
        controller.abort(new Error('gateway deadline'));
        await expect(result).rejects.toMatchObject({
            code: 'provider_timeout', retryable: true, status: 504, uncertain: false,
        });
    });

    it('marks a mutating response-body timeout as uncertain', async () => {
        vi.spyOn(jupiterRate, 'reserve').mockResolvedValue(0);
        let parseStarted!: () => void;
        const parsing = new Promise<void>((resolve) => { parseStarted = resolve; });
        const response = Response.json({});
        response.json = vi.fn(async () => {
            parseStarted();
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', vi.fn(async () => response));
        const controller = new AbortController();

        const result = new JupiterTriggerProvider().update('provider-order-1', {
            orderType: 'single', triggerPriceUsd: 300,
        }, token, controller.signal);
        await parsing;
        controller.abort(new Error('gateway deadline'));

        await expect(result).rejects.toMatchObject({
            code: 'provider_timeout', uncertain: true,
        });
    });

    it('distinguishes mutating 5xx ambiguity from read-only failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(
            { error: 'upstream failed' }, { status: 503 }
        )));
        const provider = new JupiterTriggerProvider();

        await expect(provider.update('provider-order-1', {
            orderType: 'single', triggerPriceUsd: 300,
        }, token)).rejects.toMatchObject({
            code: 'provider_request_failed', status: 503, uncertain: true,
        });
        await expect(provider.history(token)).rejects.toMatchObject({
            code: 'provider_request_failed', status: 503, uncertain: false,
        });
    });

    it('propagates gateway cancellation into the provider transport', async () => {
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
            entered();
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                    once: true,
                });
            });
        }));
        const controller = new AbortController();
        const result = new JupiterTriggerProvider().history(token, controller.signal);
        await ready;
        controller.abort(new Error('gateway deadline'));
        await expect(result).rejects.toMatchObject({
            code: 'provider_timeout', retryable: true, status: 504,
        });
    });
});
