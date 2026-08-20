import { describe, expect, it } from 'vitest';
import { formatAxisValue, latestLogicalRange } from './chartData';

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
