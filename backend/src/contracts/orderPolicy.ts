import type { AttemptHttpClass, OrderActionKind } from '../types';
import data from './orderPolicy.json';

export const actionKinds = [
    'prepare',
    'activate',
    'edit',
    'cancel_init',
    'cancel_confirm',
    'provider_sync',
    'chain_sync',
    'expire',
    'compensate',
] as const satisfies readonly OrderActionKind[];

export const httpClasses = [
    'success',
    'client_error',
    'auth_error',
    'rate_limited',
    'conflict',
    'server_error',
    'transport_error',
    'timeout',
] as const satisfies readonly AttemptHttpClass[];

const exactKeys = (value: object, expected: readonly string[], name: string): void => {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error(`Order ${name} policy keys do not match the action contract`);
    }
};

if (data.version !== 1) throw new Error('Order action policy version is unsupported');
if (JSON.stringify(data.actions) !== JSON.stringify(actionKinds)) {
    throw new Error('Order action policy sequence does not match the typed contract');
}
if (JSON.stringify(data.httpClasses) !== JSON.stringify(httpClasses)) {
    throw new Error('Order HTTP policy sequence does not match the typed contract');
}
exactKeys(data.dispatch, data.actions, 'dispatch');
exactKeys(data.evidence, data.actions, 'evidence');
exactKeys(data.http, data.httpClasses, 'HTTP');
exactKeys(data.proof, [
    'providerAbsence', 'providerAbsenceQuery', 'chainAbsenceQuery',
], 'proof');

export const orderPolicy = data;
