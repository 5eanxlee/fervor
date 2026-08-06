import { describe, expect, it } from 'vitest';
import {
    U64_MAX,
    amountSchema,
    parseU64,
    safeSlot,
    u64Schema,
    u64Text,
    wideUintSchema,
} from '../src/types';

describe('exact amount contracts', () => {
    it.each([
        '0',
        '1',
        '9007199254740991',
        '9007199254740992',
        '9223372036854775808',
        U64_MAX,
    ])('round-trips u64 boundary value %s without Number', (value) => {
        expect(u64Schema.parse(value)).toBe(value);
        expect(u64Text(JSON.parse(JSON.stringify(value)))).toBe(value);
        expect(parseU64(value)?.toString()).toBe(value);
    });

    it.each([
        -1,
        1,
        9007199254740992,
        '',
        '-1',
        '+1',
        '01',
        ' 1',
        '1 ',
        '1.0',
        '1e3',
        '18446744073709551616',
    ])('rejects noncanonical or out-of-range u64 value %s', (value) => {
        expect(u64Text(value)).toBeUndefined();
        expect(u64Schema.safeParse(value).success).toBe(false);
    });

    it('rejects oversized input before numeric parsing', () => {
        expect(u64Text('9'.repeat(1_000_000))).toBeUndefined();
        expect(wideUintSchema.safeParse('9'.repeat(1_000_000)).success).toBe(false);
    });

    it('distinguishes zero-capable wire values from positive trade amounts', () => {
        expect(u64Schema.parse('0')).toBe('0');
        expect(amountSchema.safeParse('0').success).toBe(false);
        expect(amountSchema.parse(U64_MAX)).toBe(U64_MAX);
    });

    it('accepts only slots that can cross the TypeScript Number boundary exactly', () => {
        expect(safeSlot(0)).toBe(0);
        expect(safeSlot('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
        for (const value of [-1, 1.5, '9007199254740992', 9007199254740992]) {
            expect(safeSlot(value)).toBeUndefined();
        }
    });

    it('bounds wider nonnegative accumulators at 78 decimal digits', () => {
        expect(wideUintSchema.parse('9'.repeat(78))).toBe('9'.repeat(78));
        for (const value of ['-1', '01', '1.5', '9'.repeat(79)]) {
            expect(wideUintSchema.safeParse(value).success).toBe(false);
        }
    });
});
