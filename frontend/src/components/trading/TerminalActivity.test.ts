import { describe, expect, it } from 'vitest';
import { matchesToken, orderSide } from './TerminalActivity';
import type { OrderRecord } from '../../services/api';

const order = (patch: Partial<OrderRecord> = {}): OrderRecord => ({
    id: 'order-1', clientOrderId: 'client-1', walletAddress: 'wallet', orderType: 'single', state: 'open',
    inputMint: 'sol', outputMint: 'token', inputAmount: '1000', triggerMint: 'token', params: {},
    expiresAt: new Date().toISOString(), createdAt: new Date().toISOString(), ...patch,
});

describe('terminal order projection', () => {
    it('keeps only orders that reference the active token', () => {
        expect(matchesToken(order(), 'token')).toBe(true);
        expect(matchesToken(order(), 'other')).toBe(false);
    });

    it('derives buy and sell from the active token leg', () => {
        expect(orderSide(order(), 'token')).toBe('buy');
        expect(orderSide(order({ inputMint: 'token', outputMint: 'sol' }), 'token')).toBe('sell');
    });
});
