import { describe, expect, it } from 'vitest';
import { getLimitTrigger, parseFee, parseUnits, ticketFlowStats } from './TradeTicket';

describe('trade amount conversion', () => {
    it('converts display amounts to exact integer base units', () => {
        expect(parseUnits('0.1', 9)).toBe('100000000');
        expect(parseUnits('1.250001', 6)).toBe('1250001');
        expect(parseUnits('0002', 0)).toBe('2');
    });

    it('rejects precision loss, zero, and malformed amounts', () => {
        expect(() => parseUnits('0.0000001', 6)).toThrow(/6 decimals/);
        expect(() => parseUnits('0', 9)).toThrow(/greater than zero/);
        expect(() => parseUnits('1e6', 9)).toThrow(/valid amount/);
    });

    it('converts optional SOL fee caps without unsafe integers', () => {
        expect(parseFee('', 10_000_000, 'Priority fee')).toBeUndefined();
        expect(parseFee('0.001', 10_000_000, 'Priority fee')).toBe(1_000_000);
        expect(() => parseFee('0.02', 10_000_000, 'Priority fee')).toThrow(/maximum/);
    });

    it('derives limit direction and token price from market cap', () => {
        expect(getLimitTrigger(175_000, 182_000, 1_000_000_000)).toEqual({
            condition: 'below',
            price: 0.000175,
        });
        expect(getLimitTrigger(208_000, 182_000, 1_000_000_000)).toEqual({
            condition: 'above',
            price: 0.000208,
        });
        expect(() => getLimitTrigger(175_000, 0, 1_000_000_000)).toThrow(/unavailable/);
    });

    it('renders exact flow values without demo volume splits', () => {
        expect(ticketFlowStats({ volumeUsd: 5_270, buys: 40, sells: 29 })).toEqual([
            { label: '5m Volume', value: '$5.27K', tone: 'neutral' },
            { label: 'Buys', value: '40', tone: 'buy' },
            { label: 'Sells', value: '29', tone: 'sell' },
            { label: 'Net trades', value: '+11', tone: 'buy' },
        ]);
    });

    it('shows unavailable metrics instead of fabricated values', () => {
        expect(ticketFlowStats()).toEqual([
            { label: '5m Volume', value: '—', tone: 'neutral' },
            { label: 'Buys', value: '—', tone: 'buy' },
            { label: 'Sells', value: '—', tone: 'sell' },
            { label: 'Net trades', value: '—', tone: 'neutral' },
        ]);
    });
});
