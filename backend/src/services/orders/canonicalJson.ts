import { Buffer } from 'buffer';

const byteCompare = (left: string, right: string): number => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
);

const unicode = (value: string): string => {
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
                throw new TypeError('Canonical JSON strings must contain valid Unicode scalar values');
            }
            index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new TypeError('Canonical JSON strings must contain valid Unicode scalar values');
        }
    }
    return value;
};

const encode = (value: unknown): string => {
    if (value === null || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'string') return JSON.stringify(unicode(value));
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
            throw new TypeError('Canonical JSON numbers must be finite safe integers');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        const names = Object.getOwnPropertyNames(value);
        if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== value.length + 1) {
            throw new TypeError('Canonical JSON arrays must not be sparse or contain extra properties');
        }
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical JSON arrays must not be sparse or contain extra properties');
            }
            items.push(encode(descriptor.value));
        }
        return `[${items.join(',')}]`;
    }
    if (typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Canonical JSON objects must have a plain prototype');
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        if (Object.getOwnPropertySymbols(record).length > 0
            || Object.getOwnPropertyNames(record).length !== keys.length) {
            throw new TypeError('Canonical JSON objects must contain only enumerable string properties');
        }
        const entries = keys.map(unicode).sort(byteCompare).map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(record, key);
            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError('Canonical JSON objects must contain only data properties');
            }
            if (descriptor.value === undefined) throw new TypeError('Canonical JSON cannot contain undefined');
            return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
        });
        return `{${entries.join(',')}}`;
    }
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
};

export const canonicalJson = (value: unknown): string => encode(value);
