import { describe, expect, it } from 'vitest';
import { formatAxisValue, formatCompact, formatInterval, latestLogicalRange } from './chartData';

describe('chart axis labels', () => {
    it('keeps market-cap ticks at three significant digits', () => {
        expect(formatAxisValue(200_000, 'market_cap')).toBe('200K');
        expect(formatAxisValue(3_650, 'market_cap')).toBe('3.65K');
        expect(formatAxisValue(45_000, 'market_cap')).toBe('45.0K');
        expect(formatAxisValue(1_670_000, 'market_cap')).toBe('1.67M');
        expect(formatAxisValue(1_000_000, 'market_cap')).toBe('1.00M');
        expect(formatAxisValue(999_500, 'market_cap')).toBe('1.00M');
    });

    it('formats compact currency values with three significant digits', () => {
        expect(formatCompact(3_650)).toBe('$3.65K');
        expect(formatCompact(45_000)).toBe('$45.0K');
        expect(formatCompact(1_670_000)).toBe('$1.67M');
        expect(formatCompact(-1_670_000)).toBe('-$1.67M');
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
