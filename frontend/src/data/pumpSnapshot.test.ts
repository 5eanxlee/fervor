import { describe, expect, it } from 'vitest';
import { pumpSnapshot, snapshotCounts } from './pumpSnapshot';

describe('pump snapshot', () => {
    it('contains twenty unique, renderable tokens', () => {
        expect(pumpSnapshot).toHaveLength(20);
        expect(new Set(pumpSnapshot.map((token) => token.address)).size).toBe(20);
        expect(pumpSnapshot.every((token) => Boolean(token.logo))).toBe(true);
        expect(pumpSnapshot.every((token) => Boolean(token.name && token.symbol))).toBe(true);
    });

    it('fills every discovery column', () => {
        expect(snapshotCounts).toEqual({ new: 8, final: 6, migrated: 6 });
    });

    it('uses measured market values instead of generated card metrics', () => {
        expect(pumpSnapshot.every((token) => token.marketCapUsd !== undefined)).toBe(true);
        expect(pumpSnapshot.every((token) => token.liquidityUsd !== undefined)).toBe(true);
        expect(pumpSnapshot.every((token) => token.volume5mUsd >= 0)).toBe(true);
        expect(pumpSnapshot.every((token) => token.buyCount5m >= 0 && token.sellCount5m >= 0)).toBe(true);
    });
});
