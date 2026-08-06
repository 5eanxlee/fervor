import { z } from 'zod';

export const U64_MAX = '18446744073709551615';

const uintPattern = /^(?:0|[1-9][0-9]*)$/;

export const u64Text = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0 || value.length > U64_MAX.length
        || !uintPattern.test(value)) return undefined;
    if (value.length < U64_MAX.length) return value;
    if (value.length === U64_MAX.length && value <= U64_MAX) return value;
    return undefined;
};

export const wideUintText = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 78
        || !uintPattern.test(value)) return undefined;
    return value;
};

export const parseU64 = (value: unknown): bigint | undefined => {
    const text = u64Text(value);
    return text === undefined ? undefined : BigInt(text);
};

export const safeSlot = (value: unknown): number | undefined => {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    }
    const text = u64Text(value);
    if (text === undefined) return undefined;
    const slot = Number(text);
    return Number.isSafeInteger(slot) ? slot : undefined;
};

export const u64Schema = z.string().refine(
    (value) => u64Text(value) !== undefined,
    'Value must be a canonical unsigned 64-bit integer string'
);

export const amountSchema = u64Schema.refine(
    (value) => value !== '0',
    'Amount must be greater than zero'
);

export const wideUintSchema = z.string().refine(
    (value) => wideUintText(value) !== undefined,
    'Value must be a canonical unsigned integer with at most 78 digits'
);
