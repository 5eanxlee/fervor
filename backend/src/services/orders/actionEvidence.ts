import type {
    ActionEffectState,
    ActionObservation,
    ObservationSource,
    ObservationVerdict,
    OrderActionKind,
} from '../../types';
import { actionKinds, orderPolicy } from '../../contracts/orderPolicy';
import { iso, optional, type ActionRow } from './orderActionModel';

interface EffectRule {
    sources: readonly ObservationSource[];
}

const buildRules = (): Record<OrderActionKind, EffectRule> => {
    const rules = {} as Record<OrderActionKind, EffectRule>;
    for (const kind of actionKinds) {
        rules[kind] = { sources: orderPolicy.evidence[kind] as ObservationSource[] };
    }
    return rules;
};

export const actionRules = buildRules();

export const supportsSource = (
    kind: OrderActionKind,
    source: ObservationSource
): boolean => actionRules[kind].sources.includes(source);

export const predicateFor = (
    kind: OrderActionKind,
    source: ObservationSource,
    _verdict: ObservationVerdict
): string => `${kind}.${source}.effect.v1`;

export const deriveEffect = (
    kind: OrderActionKind,
    observations: readonly Pick<ActionObservation, 'source' | 'verdict'>[]
): ActionEffectState => {
    const required = actionRules[kind].sources;
    const decisive = observations.filter((item) => (
        item.verdict !== 'context' && required.includes(item.source)
    ));
    if (decisive.some((item) => item.verdict === 'conflict')) return 'conflict';

    const presence = new Set(decisive
        .filter((item) => item.verdict === 'presence')
        .map((item) => item.source));
    const absence = new Set(decisive
        .filter((item) => item.verdict === 'absence')
        .map((item) => item.source));
    if (presence.size > 0 && absence.size > 0) return 'conflict';

    if (required.every((source) => presence.has(source))) return 'present';
    if (required.every((source) => absence.has(source))) return 'absent';
    return 'possible';
};

export const mapObservation = (row: ActionRow): ActionObservation => ({
    id: String(row.id),
    actionId: String(row.action_id),
    attemptId: optional(row.attempt_id),
    source: row.source as ActionObservation['source'],
    cluster: row.cluster as ActionObservation['cluster'],
    sourceKey: String(row.source_key),
    factKey: String(row.fact_key),
    factRev: Number(row.fact_rev),
    supersedes: optional(row.supersedes),
    queryKind: row.query_kind as ActionObservation['queryKind'],
    verdict: row.verdict as ActionObservation['verdict'],
    predicate: String(row.predicate),
    ruleVer: Number(row.rule_ver) as 1,
    provider: optional(row.provider),
    rawState: optional(row.raw_state),
    normState: optional(row.norm_state),
    desiredHash: String(row.desired_hash),
    effectHash: optional(row.effect_hash),
    providerReqId: optional(row.provider_req_id),
    providerOrderId: optional(row.provider_order_id),
    signature: optional(row.signature),
    slot: optional(row.slot),
    instructionIndex: row.instruction_index === null || row.instruction_index === undefined
        ? undefined : Number(row.instruction_index),
    eventIndex: row.event_index === null || row.event_index === undefined
        ? undefined : Number(row.event_index),
    commitment: optional(row.commitment) as ActionObservation['commitment'],
    payloadHash: String(row.payload_hash),
    payloadVer: Number(row.payload_ver),
    payload: row.payload as Record<string, unknown>,
    sourceAt: row.source_at ? iso(row.source_at) : undefined,
    observedAt: iso(row.observed_at),
});

export const observationFact = (item: ActionObservation): Record<string, unknown> => ({
    id: item.id,
    actionId: item.actionId,
    attemptId: item.attemptId ?? null,
    source: item.source,
    cluster: item.cluster,
    sourceKey: item.sourceKey,
    factKey: item.factKey,
    factRev: item.factRev,
    supersedes: item.supersedes ?? null,
    queryKind: item.queryKind,
    verdict: item.verdict,
    predicate: item.predicate,
    ruleVer: item.ruleVer,
    provider: item.provider ?? null,
    rawState: item.rawState ?? null,
    normState: item.normState ?? null,
    desiredHash: item.desiredHash,
    effectHash: item.effectHash ?? null,
    providerReqId: item.providerReqId ?? null,
    providerOrderId: item.providerOrderId ?? null,
    signature: item.signature ?? null,
    slot: item.slot ?? null,
    instructionIndex: item.instructionIndex ?? null,
    eventIndex: item.eventIndex ?? null,
    commitment: item.commitment ?? null,
    payloadHash: item.payloadHash,
    payloadVer: item.payloadVer,
    payload: item.payload,
    sourceAt: item.sourceAt ?? null,
    observedAt: item.observedAt,
});
