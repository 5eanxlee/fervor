import crypto from 'crypto';

export const stableHash = (parts: Array<string | number | undefined | null>): string =>
    crypto.createHash('sha256').update(parts.map((part) => part ?? '').join(':')).digest('hex');
