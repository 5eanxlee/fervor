import type { ActionActor } from '../../types';
import { ActionStoreError } from './orderActionError';

export interface EventContext {
    traceId: string;
    actor: ActionActor;
}

const hashPattern = /^[0-9a-f]{64}$/;
const uintPattern = /^(0|[1-9][0-9]*)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pgBigintMax = 9223372036854775807n;
const actors = new Set<ActionActor>(['user', 'system', 'provider', 'chain', 'operator']);

export const invalid = (message: string): never => {
    throw new ActionStoreError('invalid_input', message);
};

export const bounded = (value: unknown, name: string, max: number, min = 1): string => {
    const text = typeof value === 'string'
        ? value : invalid(`${name} must contain ${min} to ${max} trimmed characters`);
    if (text.length < min || text.length > max || text.trim() !== text
        || /[\u0000-\u001f\u007f]/u.test(text)) {
        invalid(`${name} must contain ${min} to ${max} trimmed characters`);
    }
    return text;
};

export const uuid = (value: unknown, name: string): string => {
    const text = typeof value === 'string' ? value : invalid(`${name} must be a UUID`);
    if (!uuidPattern.test(text)) invalid(`${name} must be a UUID`);
    return text;
};

export const hash = (value: unknown, name: string): string => {
    const text = typeof value === 'string'
        ? value : invalid(`${name} must be a lowercase SHA-256 digest`);
    if (!hashPattern.test(text)) invalid(`${name} must be a lowercase SHA-256 digest`);
    return text;
};

export const uint = (value: unknown, name: string, positive = false): string => {
    const text = typeof value === 'string'
        ? value : invalid(`${name} must be a canonical unsigned integer`);
    if (!uintPattern.test(text)) invalid(`${name} must be a canonical unsigned integer`);
    const parsed = BigInt(text);
    if ((positive && parsed === 0n) || parsed > pgBigintMax) {
        invalid(`${name} is outside PostgreSQL bigint range`);
    }
    return text;
};

export const timestamp = (value: unknown, name: string): string => {
    const text = typeof value === 'string' ? value : invalid(`${name} must be an ISO timestamp`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
        || !Number.isFinite(Date.parse(text))
        || new Date(text).toISOString() !== text) {
        invalid(`${name} must be an ISO timestamp`);
    }
    return text;
};

export const eventContext = (value: EventContext): void => {
    bounded(value.traceId, 'traceId', 64);
    if (!actors.has(value.actor)) invalid('actor is unsupported');
};
