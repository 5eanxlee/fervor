import { describe, expect, it } from 'vitest';
import { mapProviderState } from '../src/services/orders/jupiterTriggerProvider';
import { OrderService } from '../src/services/orders/orderService';
import { orderAuthSchema, orderChallengeSchema, orderRequestSchema, orderUpdateSchema } from '../src/types';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const sol = 'So11111111111111111111111111111111111111112';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('conditional order contracts', () => {
    it('does not construct a mutation provider in the API service', async () => {
        const service = new OrderService();
        expect(service.capabilities()).toMatchObject({
            mode: 'disabled',
            provider: 'none',
            canPrepare: false,
            canActivate: false,
        });
        await expect(service.challenge(wallet, 'message'))
            .rejects.toMatchObject({ code: 'orders_disabled', status: 503 });
    });

    it('supports OCO risk brackets and rejects an inverted price band', () => {
        const common = {
            orderType: 'oco', walletAddress: wallet, inputMint: sol, outputMint: usdc,
            inputAmount: '1000000000', triggerMint: sol,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: 'client-order-00000002',
        } as const;
        expect(orderRequestSchema.parse({
            ...common, takeProfitPriceUsd: 250, stopLossPriceUsd: 150,
        }).orderType).toBe('oco');
        expect(() => orderRequestSchema.parse({
            ...common, takeProfitPriceUsd: 100, stopLossPriceUsd: 150,
        })).toThrow(/Take-profit/);
    });

    it('binds an OTOCO entry trigger to a valid exit bracket', () => {
        const common = {
            orderType: 'otoco', walletAddress: wallet, inputMint: usdc, outputMint: sol,
            inputAmount: '200000000', triggerMint: sol, triggerCondition: 'below',
            triggerPriceUsd: 180,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: 'client-order-00000004',
        } as const;
        expect(orderRequestSchema.parse({
            ...common, takeProfitPriceUsd: 220, stopLossPriceUsd: 160,
        }).orderType).toBe('otoco');
        expect(() => orderRequestSchema.parse({
            ...common, takeProfitPriceUsd: 150, stopLossPriceUsd: 160,
        })).toThrow(/Take-profit/);
    });

    it('enforces trailing-stop direction and mutually exclusive trigger modes', () => {
        const base = {
            orderType: 'single', walletAddress: wallet, inputMint: sol, outputMint: usdc,
            inputAmount: '1000000000', triggerMint: sol, triggerCondition: 'below',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: 'client-order-00000003',
        } as const;
        expect(orderRequestSchema.parse({ ...base, trailingBps: 500 }).orderType).toBe('single');
        expect(() => orderRequestSchema.parse({
            ...base, triggerPriceUsd: 150, trailingBps: 500,
        })).toThrow(/exactly one/);
        expect(() => orderRequestSchema.parse({
            ...base, triggerMint: usdc, trailingBps: 500,
        })).toThrow(/direction/);
    });

    it('maps the provider history lifecycle without regressing partial fills', () => {
        expect(mapProviderState('pending')).toBe('activating');
        expect(mapProviderState('open')).toBe('open');
        expect(mapProviderState('executing', 0)).toBe('executing');
        expect(mapProviderState('executing', 0.4)).toBe('partially_filled');
        expect(mapProviderState('filled', 1)).toBe('filled');
        expect(mapProviderState('pending_withdraw')).toBe('cancel_pending');
        expect(mapProviderState('cancelled')).toBe('cancelled');
        expect(mapProviderState('expired')).toBe('expired');
        expect(mapProviderState('unknown')).toBeNull();
    });

    it('validates static, trailing, and OCO updates without allowing mode conversion', () => {
        expect(orderUpdateSchema.parse({
            orderType: 'single', triggerPriceUsd: 275,
        })).toMatchObject({ triggerPriceUsd: 275 });
        expect(orderUpdateSchema.parse({
            orderType: 'single', trailingBps: 750, slippageBps: 125,
        })).toMatchObject({ trailingBps: 750 });
        expect(orderUpdateSchema.parse({
            orderType: 'oco', takeProfitPriceUsd: 275, stopLossPriceUsd: 140,
        })).toMatchObject({ takeProfitPriceUsd: 275 });
        expect(orderUpdateSchema.parse({
            orderType: 'otoco', triggerPriceUsd: 190,
            takeProfitPriceUsd: 230, stopLossPriceUsd: 170,
        })).toMatchObject({ orderType: 'otoco', triggerPriceUsd: 190 });
        expect(() => orderUpdateSchema.parse({
            orderType: 'single', triggerPriceUsd: 200, trailingBps: 500,
        })).toThrow(/mutually exclusive/);
        expect(() => orderUpdateSchema.parse({
            orderType: 'oco', takeProfitPriceUsd: 100, stopLossPriceUsd: 150,
        })).toThrow(/Take-profit/);
    });

    it('supports message and hardware-wallet transaction authentication contracts', () => {
        expect(orderChallengeSchema.parse({ walletAddress: wallet })).toMatchObject({ type: 'message' });
        expect(orderChallengeSchema.parse({ walletAddress: wallet, type: 'transaction' }))
            .toMatchObject({ type: 'transaction' });
        expect(orderAuthSchema.parse({
            type: 'message', walletAddress: wallet, signature: 'a'.repeat(64),
        })).toMatchObject({ type: 'message' });
        expect(orderAuthSchema.parse({
            type: 'transaction', walletAddress: wallet, signedTransaction: 'a'.repeat(32),
        })).toMatchObject({ type: 'transaction' });
        expect(() => orderAuthSchema.parse({
            type: 'transaction', walletAddress: wallet, signature: 'a'.repeat(64),
        })).toThrow();
    });
});
