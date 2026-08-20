import { describe, expect, it } from 'vitest';
import { elapsedLabel, matchesToken, orderSide } from './TerminalActivity';
import type { OrderRecord } from '../../services/api';

const order = (patch: Partial<OrderRecord> = {}): OrderRecord => ({
    id: 'order-1', clientOrderId: 'client-1', walletAddress: 'wallet', orderType: 'single', state: 'open',
    inputMint: 'sol', outputMint: 'token', inputAmount: '1000', triggerMint: 'token', params: {},
    expiresAt: new Date().toISOString(), createdAt: new Date().toISOString(), ...patch,
});

describe('activity duration labels', () => {
    it('promotes seconds to minutes, hours, and days', () => {
        expect(elapsedLabel(59)).toBe('59s');
        expect(elapsedLabel(60)).toBe('1m');
        expect(elapsedLabel(120)).toBe('2m');
        expect(elapsedLabel(3_600)).toBe('1h');
        expect(elapsedLabel(86_400)).toBe('1d');
    });
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
