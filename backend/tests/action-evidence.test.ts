import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ObservationSource, OrderAction, OrderActionKind } from '../src/types';
import {
    actionRules,
    deriveEffect,
    predicateFor,
    supportsSource,
} from '../src/services/orders/actionEvidence';
import {
    ActionObservationStore,
    strictProofPolicy,
} from '../src/services/orders/actionObservationStore';
import { canonicalJson } from '../src/services/orders/canonicalJson';

const kinds = Object.keys(actionRules) as OrderActionKind[];
const fact = (source: ObservationSource, verdict: 'context' | 'presence' | 'absence' | 'conflict') => ({
    source,
    verdict,
});

describe('action evidence rules', () => {
    it.each(kinds)('derives complete and partial evidence for %s', (kind) => {
        const sources = actionRules[kind].sources;
        expect(deriveEffect(kind, [])).toBe('possible');
        expect(deriveEffect(kind, sources.map((source) => fact(source, 'context')))).toBe('possible');
        expect(deriveEffect(kind, sources.map((source) => fact(source, 'presence')))).toBe('present');
        expect(deriveEffect(kind, sources.map((source) => fact(source, 'absence')))).toBe('absent');
        if (sources.length > 1) {
            expect(deriveEffect(kind, [fact(sources[0], 'presence')])).toBe('possible');
            expect(deriveEffect(kind, [fact(sources[0], 'absence')])).toBe('possible');
        }
    });

    it('makes contradictions sticky until corrected evidence is complete', () => {
        expect(deriveEffect('activate', [
            fact('provider', 'presence'),
            fact('chain', 'absence'),
        ])).toBe('conflict');
        expect(deriveEffect('provider_sync', [fact('provider', 'conflict')])).toBe('conflict');
    });

    it.each(kinds)('ignores unauthorized evidence sources for %s', (kind) => {
        for (const source of ['provider', 'chain'] as const) {
            const allowed = actionRules[kind].sources.includes(source);
            expect(supportsSource(kind, source)).toBe(allowed);
            if (!allowed) {
                expect(deriveEffect(kind, [fact(source, 'presence')])).toBe('possible');
                expect(deriveEffect(kind, [fact(source, 'absence')])).toBe('possible');
                expect(deriveEffect(kind, [fact(source, 'conflict')])).toBe('possible');
            }
        }
    });

    it('keeps correction lineages on one versioned predicate', () => {
        expect(predicateFor('activate', 'provider', 'presence'))
            .toBe('activate.provider.effect.v1');
        expect(predicateFor('activate', 'provider', 'absence'))
            .toBe('activate.provider.effect.v1');
        expect(predicateFor('activate', 'provider', 'conflict'))
            .toBe('activate.provider.effect.v1');
    });

    it('requires provider-specific proof before accepting absence', () => {
        const action = { provider: 'jupiter_trigger_v2' } as OrderAction;
        expect(strictProofPolicy.permits(action, {
            source: 'provider', verdict: 'absence', queryKind: 'found',
        } as never)).toBe(false);
        expect(strictProofPolicy.permits(action, {
            source: 'provider', verdict: 'absence', queryKind: 'queried_no_evidence',
        } as never)).toBe(false);
        expect(strictProofPolicy.permits(action, {
            source: 'chain', verdict: 'absence', queryKind: 'expired_unseen',
        } as never)).toBe(true);
        expect(strictProofPolicy.permits(action, {
            source: 'chain', verdict: 'absence', queryKind: 'queried_no_evidence',
        } as never)).toBe(false);
    });

    it('verifies canonical payload bytes before opening a transaction', async () => {
        const tx = vi.fn();
        const store = new ActionObservationStore(tx);
        const payload = { orderId: 'provider-order-1', state: 'open' };
        await expect(store.observe({
            id: '1c5540b7-17d3-4f69-b6d1-29d0e9e45d09',
            actionId: '2cb08ba3-f135-439b-a0ab-80282ee3febe',
            source: 'provider',
            cluster: 'mainnet-beta',
            sourceKey: 'provider:jupiter:order:1',
            factKey: 'provider:jupiter:order-state:1',
            factRev: 1,
            queryKind: 'found',
            verdict: 'presence',
            predicate: 'provider_sync.provider.effect.v1',
            ruleVer: 1,
            provider: 'jupiter_trigger_v2',
            desiredHash: 'a'.repeat(64),
            effectHash: 'a'.repeat(64),
            providerOrderId: 'provider-order-1',
            payloadHash: createHash('sha256')
                .update(`${canonicalJson(payload)}x`).digest('hex'),
            payloadVer: 1,
            payload,
            traceId: 'trace-evidence-1',
            actor: 'provider',
        })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(tx).not.toHaveBeenCalled();
    });
});
