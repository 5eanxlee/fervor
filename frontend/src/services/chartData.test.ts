import { describe, expect, it } from 'vitest';
import { formatAxisValue, formatInterval, latestLogicalRange } from './chartData';

describe('chart axis labels', () => {
    it('keeps market-cap ticks compact without redundant decimals', () => {
        expect(formatAxisValue(200_000, 'market_cap')).toBe('200K');
        expect(formatAxisValue(1_600_000, 'market_cap')).toBe('1.6M');
        expect(formatAxisValue(1_000_000, 'market_cap')).toBe('1M');
    });
});

describe('chart viewport', () => {
    it('keeps the latest candle inside a stable compact window', () => {
        expect(latestLogicalRange(500, true)).toEqual({ from: 367, to: 507 });
    });

    it('reserves a useful window before enough candles exist', () => {
        expect(latestLogicalRange(1, false)).toEqual({ from: -168, to: 12 });
    });
});

describe('chart interval labels', () => {
    it('uses human time units once intervals reach a minute', () => {
        expect(formatInterval(1)).toBe('1s');
        expect(formatInterval(60)).toBe('1m');
        expect(formatInterval(120)).toBe('2m');
        expect(formatInterval(3_600)).toBe('1h');
        expect(formatInterval(86_400)).toBe('1d');
    });
});
