import { describe, expect, it } from 'vitest';
import { formatAxisValue } from './chartData';

describe('chart axis labels', () => {
    it('keeps market-cap ticks compact without redundant decimals', () => {
        expect(formatAxisValue(200_000, 'market_cap')).toBe('200K');
        expect(formatAxisValue(1_600_000, 'market_cap')).toBe('1.6M');
        expect(formatAxisValue(1_000_000, 'market_cap')).toBe('1M');
    });
});
