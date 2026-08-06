import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/services/orders/canonicalJson';
import { httpClasses, orderPolicy } from '../src/contracts/orderPolicy';
import { ActionStoreError, OrderActionStore } from '../src/services/orders/orderActionStore';
import { dispatchRules, matchesStatus } from '../src/services/orders/actionPolicies';

describe('order action store contracts', () => {
    it('covers every action dispatch policy and normalized HTTP boundary', () => {
        expect(Object.fromEntries(Object.entries(dispatchRules).map(([kind, rule]) => [kind, {
            methods: [...rule.methods], body: rule.body, blob: rule.blob,
        }]))).toEqual({
            prepare: { methods: ['POST'], body: true, blob: false },
            activate: { methods: ['POST'], body: true, blob: true },
            edit: { methods: ['POST', 'PATCH', 'PUT'], body: true, blob: false },
            cancel_init: { methods: ['POST', 'DELETE'], body: true, blob: false },
            cancel_confirm: { methods: ['POST'], body: true, blob: true },
            provider_sync: { methods: ['GET'], body: false, blob: false },
            chain_sync: { methods: ['GET'], body: false, blob: false },
            expire: { methods: ['POST', 'DELETE'], body: true, blob: false },
            compensate: { methods: ['POST'], body: true, blob: true },
        });
        const accepted = [
            ['success', 200], ['success', 299],
            ['client_error', 400], ['client_error', 499],
            ['auth_error', 401], ['auth_error', 403],
            ['rate_limited', 429], ['conflict', 409],
            ['server_error', 500], ['server_error', 599],
        ] as const;
        for (const [kind, status] of accepted) expect(matchesStatus(kind, status)).toBe(true);
        const rejected = [
            ['success', 300], ['client_error', 401], ['client_error', 403],
            ['client_error', 409], ['client_error', 429], ['auth_error', 400],
            ['rate_limited', 430], ['conflict', 408], ['server_error', 499],
            ['transport_error', 500], ['timeout', 504],
        ] as const;
        for (const [kind, status] of rejected) expect(matchesStatus(kind, status)).toBe(false);

        for (const kind of httpClasses) {
            const rule = orderPolicy.http[kind];
            for (let status = 100; status <= 599; status += 1) {
                const expected = rule.ranges.some(([low, high]) => status >= low && status <= high)
                    && !rule.exclude.includes(status);
                expect(matchesStatus(kind, status), `${kind}:${status}`).toBe(expected);
            }
        }
    });

    it('canonicalizes nested event payloads without lossy numbers', () => {
        expect(canonicalJson({ z: 1, a: { y: true, x: ['2', null] } }))
            .toBe('{"a":{"x":["2",null],"y":true},"z":1}');
        expect(() => canonicalJson({ amount: 9_007_199_254_740_992 }))
            .toThrow(/safe integers/);
        expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
        expect(() => canonicalJson({ at: new Date() })).toThrow(/plain prototype/);
        expect(canonicalJson({ '𐀀': 1, '\ue000': 2 })).toBe('{"":2,"𐀀":1}');
        expect(() => canonicalJson({ value: '\ud800' })).toThrow(/Unicode scalar/);
        expect(() => canonicalJson({ ['\ud801']: 1, ['\ud800']: 2 })).toThrow(/Unicode scalar/);
        expect(() => canonicalJson(new Array(1))).toThrow(/must not be sparse/);
        expect(() => canonicalJson([, 1])).toThrow(/must not be sparse/);
        const extended = [1] as number[] & { extra?: number };
        extended.extra = 2;
        expect(() => canonicalJson(extended)).toThrow(/extra properties/);
        const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
        expect(() => canonicalJson(accessor)).toThrow(/data properties/);
        const arrayAccessor = Object.defineProperty([], '0', {
            enumerable: true, get: () => 1,
        });
        expect(() => canonicalJson(arrayAccessor)).toThrow(/must not be sparse/);
    });

    it('rejects invalid durable identities before opening a transaction', async () => {
        const db = vi.fn();
        const tx = vi.fn();
        const store = new OrderActionStore(tx);
        await expect(store.admit({
            id: 'not-a-uuid',
            orderId: 'c6bf0d9e-178b-4f6f-8a45-241dbdf855b0',
            userId: '8ecf26c5-40dc-4c86-9678-996f51b85594',
            kind: 'activate',
            ruleVer: 1,
            clientKey: 'activate:fixture:1',
            reqHash: 'a'.repeat(64),
            desiredHash: 'b'.repeat(64),
            expectedVer: '0',
            provider: 'fixture',
            dueAt: new Date().toISOString(),
            traceId: 'trace-1',
            actor: 'user',
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        expect(tx).not.toHaveBeenCalled();
        expect(db).not.toHaveBeenCalled();
    });

    it('bounds claims before touching PostgreSQL', async () => {
        const db = vi.fn();
        const tx = vi.fn();
        const store = new OrderActionStore(tx);
        await expect(store.claim({
            provider: 'fixture', owner: 'worker-a', epoch: '1', leaseMs: 30_000, limit: 501,
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        expect(tx).not.toHaveBeenCalled();
    });

    it('rejects erased enum violations before touching PostgreSQL', async () => {
        const tx = vi.fn();
        const store = new OrderActionStore(tx);
        await expect(store.respond({
            attemptId: 'c6bf0d9e-178b-4f6f-8a45-241dbdf855b0',
            completedAt: new Date().toISOString(),
            httpClass: 'not-a-class' as never,
            errorCode: 'invalid_fixture',
            traceId: 'trace-1',
            actor: 'provider',
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        expect(tx).not.toHaveBeenCalled();
    });

    it('rejects contradictory response facts and non-round-trippable timestamps', async () => {
        const tx = vi.fn();
        const store = new OrderActionStore(tx);
        const response = {
            attemptId: 'c6bf0d9e-178b-4f6f-8a45-241dbdf855b0',
            completedAt: new Date().toISOString(),
            httpClass: 'success' as const,
            httpStatus: 500,
            traceId: 'trace-1',
            actor: 'provider' as const,
        };
        await expect(store.respond(response)).rejects.toMatchObject<ActionStoreError>({
            code: 'invalid_input',
        });
        await expect(store.respond({
            ...response,
            httpClass: 'timeout',
            httpStatus: 200,
            errorCode: 'timeout',
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        await expect(store.respond({
            ...response,
            completedAt: '2026-02-30T00:00:00.000Z',
            httpStatus: 200,
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        await expect(store.respond({
            ...response,
            httpStatus: 200,
            providerEffectId: '',
        })).rejects.toMatchObject<ActionStoreError>({ code: 'invalid_input' });
        expect(tx).not.toHaveBeenCalled();
    });
});
