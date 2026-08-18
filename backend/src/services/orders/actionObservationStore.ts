import { createHash, randomUUID } from 'crypto';
import type {
    ActionObservation,
    ObservationQuery,
    ObservationSource,
    ObservationVerdict,
    OrderAction,
} from '../../types';
import { DbQuery, transaction } from '../../config/database';
import { orderPolicy } from '../../contracts/orderPolicy';
import { eventOutbox, type EventOutbox } from '../eventOutbox';
import { canonicalJson } from './canonicalJson';
import {
    deriveEffect,
    mapObservation,
    observationFact,
    predicateFor,
    supportsSource,
} from './actionEvidence';
import { ActionStoreError } from './orderActionError';
import { iso, mapAction, type ActionRow as Row } from './orderActionModel';
import { emitOrderEvent } from './orderEventWriter';
import {
    bounded,
    eventContext,
    hash,
    invalid,
    timestamp,
    uint,
    uuid,
    type EventContext,
} from './orderValidation';

type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;

export interface ObserveAction extends EventContext {
    id: string;
    actionId: string;
    attemptId?: string;
    source: ObservationSource;
    cluster: ActionObservation['cluster'];
    sourceKey: string;
    factKey: string;
    factRev: number;
    supersedes?: string;
    queryKind: ObservationQuery;
    verdict: ObservationVerdict;
    predicate: string;
    ruleVer: 1;
    provider?: string;
    rawState?: string;
    normState?: string;
    desiredHash: string;
    effectHash?: string;
    providerReqId?: string;
    providerOrderId?: string;
    signature?: string;
    slot?: string;
    instructionIndex?: number;
    eventIndex?: number;
    commitment?: ActionObservation['commitment'];
    payloadHash: string;
    payloadVer: number;
    payload: Record<string, unknown>;
    sourceAt?: string;
}

export interface ProofPolicy {
    permits(action: OrderAction, observation: ObserveAction): boolean;
}

const absenceProviders = new Set<string>(orderPolicy.proof.providerAbsence);

export const strictProofPolicy: ProofPolicy = {
    permits(action, item) {
        if (item.verdict !== 'absence') return true;
        if (item.source === 'chain') {
            return item.queryKind === orderPolicy.proof.chainAbsenceQuery;
        }
        return item.queryKind === orderPolicy.proof.providerAbsenceQuery
            && absenceProviders.has(action.provider);
    },
};

const clusters = new Set<ActionObservation['cluster']>([
    'mainnet-beta', 'devnet', 'testnet', 'localnet',
]);
const sources = new Set<ObservationSource>(['provider', 'chain']);
const queries = new Set<ObservationQuery>([
    'unchecked', 'found', 'queried_no_evidence', 'expired_unseen',
]);
const verdicts = new Set<ObservationVerdict>(['context', 'presence', 'absence', 'conflict']);
const commitments = new Set<NonNullable<ActionObservation['commitment']>>([
    'processed', 'confirmed', 'finalized',
]);
const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const maxSlot = 9007199254740991n;

const int = (value: unknown, name: string, min: number, max: number): number => {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
        invalid(`${name} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
};

const payloadDigest = (payload: Record<string, unknown>): { json: string; hash: string } => {
    const json = canonicalJson(payload);
    if (Buffer.byteLength(json, 'utf8') > 65_536) invalid('payload exceeds 65536 canonical bytes');
    return { json, hash: createHash('sha256').update(json).digest('hex') };
};

export class ActionObservationStore {
    constructor(
        private readonly tx: TxFn = transaction,
        private readonly outbox: Pick<EventOutbox, 'enqueue'> = eventOutbox,
        private readonly policy: ProofPolicy = strictProofPolicy
    ) {}

    observe(input: ObserveAction): Promise<{
        action: OrderAction;
        observation: ActionObservation;
        replayed: boolean;
    }> {
        return this.guard(async () => {
            const payload = this.validate(input);
            return this.tx(async (db) => {
                const aggregate = await db<Row>(
                    `SELECT order_row.id, order_row.cluster
                       FROM order_intents order_row
                       JOIN order_actions action ON action.order_id = order_row.id
                      WHERE action.id = $1
                      FOR UPDATE OF order_row`,
                    [input.actionId]
                );
                if (!aggregate.rows[0]) throw new ActionStoreError('not_found', 'Action was not found');
                const current = await db<Row>(
                    'SELECT * FROM order_actions WHERE id = $1 FOR UPDATE', [input.actionId]
                );
                const action = mapAction(current.rows[0]);
                this.authorize(action, aggregate.rows[0], input);

                const inserted = await db<Row>(
                    `INSERT INTO action_obs (
                        id, action_id, attempt_id, source, cluster, source_key,
                        fact_key, fact_rev, supersedes, query_kind, verdict, predicate,
                        rule_ver, provider, raw_state, norm_state, desired_hash, effect_hash,
                        provider_req_id, provider_order_id, signature, slot, instruction_index,
                        event_index, commitment, payload_hash, payload_ver, payload, source_at
                     ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                        $25, $26, $27, $28::jsonb, $29
                     )
                     ON CONFLICT DO NOTHING
                     RETURNING *`,
                    [input.id, input.actionId, input.attemptId ?? null, input.source, input.cluster,
                        input.sourceKey, input.factKey, input.factRev, input.supersedes ?? null,
                        input.queryKind, input.verdict, input.predicate, input.ruleVer,
                        input.provider ?? null, input.rawState ?? null, input.normState ?? null,
                        input.desiredHash, input.effectHash ?? null, input.providerReqId ?? null,
                        input.providerOrderId ?? null, input.signature ?? null, input.slot ?? null,
                        input.instructionIndex ?? null, input.eventIndex ?? null,
                        input.commitment ?? null, input.payloadHash, input.payloadVer,
                        payload.json, input.sourceAt ?? null]
                );
                if (!inserted.rows[0]) {
                    const conflict = await db<Row>(
                        `SELECT * FROM action_obs
                          WHERE id = $1
                             OR (source = $2 AND cluster = $3 AND source_key = $4)
                             OR (action_id = $5 AND fact_key = $6 AND fact_rev = $7)
                             OR ($8::uuid IS NOT NULL AND supersedes = $8::uuid)
                          FOR SHARE`,
                        [input.id, input.source, input.cluster, input.sourceKey, input.actionId,
                            input.factKey, input.factRev, input.supersedes ?? null]
                    );
                    if (conflict.rowCount !== 1 || !this.sameObservation(conflict.rows[0], input)) {
                        throw new ActionStoreError(
                            'observation_conflict', 'Observation identity was reused for different evidence'
                        );
                    }
                    return {
                        action,
                        observation: mapObservation(conflict.rows[0]),
                        replayed: true,
                    };
                }

                const observation = mapObservation(inserted.rows[0]);
                const evidence = await db<Row>(
                    `SELECT source, verdict
                       FROM action_obs_current
                      WHERE action_id = $1 AND rule_ver = $2 AND fact_key IS NOT NULL`,
                    [action.id, action.ruleVer]
                );
                const derived = deriveEffect(action.kind, evidence.rows as Array<{
                    source: ObservationSource;
                    verdict: ObservationVerdict;
                }>);
                const reduction = await this.reduce(
                    db, action, input.source, derived, observation.id
                );
                await emitOrderEvent(
                    db,
                    this.outbox,
                    reduction.action,
                    `observation:${observation.id}:recorded`,
                    'action.observed',
                    reduction.action.workState,
                    input,
                    {
                        anomalyId: reduction.anomalyId ?? null,
                        derivedEffect: derived,
                        observation: observationFact(observation),
                    }
                );
                return { action: reduction.action, observation, replayed: false };
            });
        });
    }

    private async reduce(
        db: DbQuery,
        action: OrderAction,
        source: ObservationSource,
        derived: OrderAction['effectState'],
        observationId: string
    ): Promise<{ action: OrderAction; anomalyId?: string }> {
        if (action.workState === 'done') {
            if (derived === action.effectState) return { action };
            const anomalyId = await this.recordTerminalConflict(
                db, action, observationId, derived
            );
            return { action, anomalyId };
        }
        if (action.effectState === 'not_possible' && derived !== 'absent') {
            throw new ActionStoreError(
                'state_conflict', 'Presence evidence cannot reduce an action before dispatch'
            );
        }
        if (!['dispatching', 'reconciling', 'parked'].includes(action.workState)
            && !(action.effectState === 'not_possible' && derived === 'absent')) {
            throw new ActionStoreError('state_conflict', 'Action is not awaiting external evidence');
        }

        const effect = action.effectState === 'conflict' && derived === 'possible'
            ? 'conflict' : derived;
        const terminal = effect === 'present' || effect === 'absent';
        const parked = action.workState === 'parked' && !terminal;
        const changed = await db<Row>(
            `UPDATE order_actions
                SET action_ver = action_ver + 1,
                    work_state = CASE
                        WHEN $3 THEN 'done'
                        WHEN $4 THEN 'parked'
                        ELSE 'reconciling'
                    END,
                    effect_state = $2::varchar,
                    outcome = CASE
                        WHEN $2::varchar = 'present' THEN 'succeeded'
                        WHEN $2::varchar = 'absent' THEN 'failed'
                        WHEN $4 THEN outcome
                        ELSE 'pending'
                    END,
                    block_reason = CASE WHEN $3 THEN NULL ELSE block_reason END,
                    provider_check_at = CASE WHEN $5 = 'provider'
                        THEN clock_timestamp() ELSE provider_check_at END,
                    chain_check_at = CASE WHEN $5 = 'chain'
                        THEN clock_timestamp() ELSE chain_check_at END,
                    completed_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
                    lease_owner = NULL,
                    lease_until = NULL,
                    write_scope = NULL,
                    write_epoch = NULL
              WHERE id = $1 AND action_ver = $6
              RETURNING *`,
            [action.id, effect, terminal, parked, source, action.version]
        );
        if (!changed.rows[0]) {
            throw new ActionStoreError('version_conflict', 'Action changed during evidence reduction', true);
        }
        return { action: mapAction(changed.rows[0]) };
    }

    private async recordTerminalConflict(
        db: DbQuery,
        action: OrderAction,
        observationId: string,
        derived: OrderAction['effectState']
    ): Promise<string> {
        const id = randomUUID();
        const detail = {
            actionId: action.id,
            derivedEffect: derived,
            observationId,
            ruleVer: action.ruleVer,
            storedEffect: action.effectState,
        };
        const json = canonicalJson(detail);
        const digest = createHash('sha256').update(json).digest('hex');
        await db(
            `INSERT INTO order_anomalies (
                id, anomaly_key, order_id, action_id, scope, kind, severity,
                state, blocks_actions, detail_hash, detail
             ) VALUES (
                $1, $2, $3, $4, 'action', 'policy_violation', 'critical',
                'open', true, $5, $6::jsonb
             )`,
            [id, `action-evidence:${action.id}:${observationId}`, action.orderId,
                action.id, digest, json]
        );
        return id;
    }

    private authorize(action: OrderAction, aggregate: Row, input: ObserveAction): void {
        if (action.desiredHash !== input.desiredHash || action.ruleVer !== input.ruleVer) {
            throw new ActionStoreError('state_conflict', 'Observation targets a different action rule');
        }
        if (String(aggregate.cluster) !== input.cluster) {
            throw new ActionStoreError('state_conflict', 'Observation targets a different cluster');
        }
        if (!supportsSource(action.kind, input.source)) {
            throw new ActionStoreError(
                'state_conflict', 'Observation source is not authorized for this action rule'
            );
        }
        if (input.source === 'provider' && action.provider !== input.provider) {
            throw new ActionStoreError('state_conflict', 'Observation targets a different provider');
        }
        if (input.predicate !== predicateFor(action.kind, input.source, input.verdict)) {
            throw new ActionStoreError('state_conflict', 'Observation predicate does not match the action rule');
        }
        if (!this.policy.permits(action, input)) {
            throw new ActionStoreError(
                'state_conflict', 'Provider policy does not support this decisive proof predicate'
            );
        }
    }

    private validate(input: ObserveAction): { json: string; hash: string } {
        eventContext(input);
        if (input.actor !== input.source) invalid('observation actor must match its evidence source');
        uuid(input.id, 'id');
        uuid(input.actionId, 'actionId');
        if (input.attemptId !== undefined) uuid(input.attemptId, 'attemptId');
        if (!sources.has(input.source)) invalid('source is unsupported');
        if (!clusters.has(input.cluster)) invalid('cluster is unsupported');
        bounded(input.sourceKey, 'sourceKey', 220);
        bounded(input.factKey, 'factKey', 220);
        int(input.factRev, 'factRev', 1, 2147483647);
        if (input.supersedes !== undefined) uuid(input.supersedes, 'supersedes');
        if ((input.factRev === 1) !== (input.supersedes === undefined)) {
            invalid('factRev one must start a lineage and later revisions must supersede one fact');
        }
        if (!queries.has(input.queryKind)) invalid('queryKind is unsupported');
        if (!verdicts.has(input.verdict)) invalid('verdict is unsupported');
        bounded(input.predicate, 'predicate', 80);
        if (input.ruleVer !== 1) invalid('ruleVer is unsupported');
        if (input.provider !== undefined) bounded(input.provider, 'provider', 32);
        if (input.rawState !== undefined) bounded(input.rawState, 'rawState', 80);
        if (input.normState !== undefined) bounded(input.normState, 'normState', 80);
        hash(input.desiredHash, 'desiredHash');
        if (input.effectHash !== undefined) hash(input.effectHash, 'effectHash');
        if (input.providerReqId !== undefined) bounded(input.providerReqId, 'providerReqId', 180);
        if (input.providerOrderId !== undefined) bounded(input.providerOrderId, 'providerOrderId', 180);
        if (input.signature !== undefined && !signaturePattern.test(input.signature)) {
            invalid('signature must be a base58 Solana transaction signature');
        }
        if (input.slot !== undefined && BigInt(uint(input.slot, 'slot')) > maxSlot) {
            invalid('slot exceeds the exact JavaScript interoperability range');
        }
        if (input.instructionIndex !== undefined) {
            int(input.instructionIndex, 'instructionIndex', 0, 2147483647);
        }
        if (input.eventIndex !== undefined) int(input.eventIndex, 'eventIndex', 0, 2147483647);
        if (input.commitment !== undefined && !commitments.has(input.commitment)) {
            invalid('commitment is unsupported');
        }
        hash(input.payloadHash, 'payloadHash');
        int(input.payloadVer, 'payloadVer', 1, 32767);
        if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
            invalid('payload must be a canonical object');
        }
        if (input.sourceAt !== undefined) timestamp(input.sourceAt, 'sourceAt');

        const chainFacts = [input.signature, input.slot, input.instructionIndex,
            input.eventIndex, input.commitment];
        if (input.source === 'provider') {
            if (input.provider === undefined || chainFacts.some((value) => value !== undefined)) {
                invalid('provider evidence requires a provider and forbids chain identity');
            }
            if (input.queryKind === 'found'
                && input.providerReqId === undefined && input.providerOrderId === undefined) {
                invalid('found provider evidence requires a request or order identity');
            }
        } else if (input.provider !== undefined) {
            invalid('chain evidence must not carry a provider');
        } else if (input.queryKind === 'found'
            && chainFacts.some((value) => value === undefined)) {
            invalid('found chain evidence requires its complete transaction identity');
        }

        if (input.verdict === 'presence'
            && (input.queryKind !== 'found' || input.effectHash !== input.desiredHash)) {
            invalid('presence requires a found effect matching the desired hash');
        }
        if (input.verdict === 'absence') {
            const query = input.source === 'chain'
                ? orderPolicy.proof.chainAbsenceQuery
                : orderPolicy.proof.providerAbsenceQuery;
            if (input.queryKind !== query || input.effectHash !== undefined) {
                invalid('absence requires its source-specific decisive negative predicate');
            }
        }
        if (input.verdict === 'conflict'
            && (input.queryKind !== 'found' || input.effectHash === undefined
                || input.effectHash === input.desiredHash)) {
            invalid('conflict requires a found non-matching effect hash');
        }
        if (input.verdict === 'context'
            && input.queryKind === orderPolicy.proof.chainAbsenceQuery) {
            invalid(`${orderPolicy.proof.chainAbsenceQuery} is a decisive absence fact`);
        }
        const payload = payloadDigest(input.payload);
        if (payload.hash !== input.payloadHash) invalid('payloadHash does not match canonical payload bytes');
        return payload;
    }

    private sameObservation(row: Row, input: ObserveAction): boolean {
        const stored = mapObservation(row);
        return stored.id === input.id
            && stored.actionId === input.actionId
            && stored.attemptId === input.attemptId
            && stored.source === input.source
            && stored.cluster === input.cluster
            && stored.sourceKey === input.sourceKey
            && stored.factKey === input.factKey
            && stored.factRev === input.factRev
            && stored.supersedes === input.supersedes
            && stored.queryKind === input.queryKind
            && stored.verdict === input.verdict
            && stored.predicate === input.predicate
            && stored.ruleVer === input.ruleVer
            && stored.provider === input.provider
            && stored.rawState === input.rawState
            && stored.normState === input.normState
            && stored.desiredHash === input.desiredHash
            && stored.effectHash === input.effectHash
            && stored.providerReqId === input.providerReqId
            && stored.providerOrderId === input.providerOrderId
            && stored.signature === input.signature
            && stored.slot === input.slot
            && stored.instructionIndex === input.instructionIndex
            && stored.eventIndex === input.eventIndex
            && stored.commitment === input.commitment
            && stored.payloadHash === input.payloadHash
            && stored.payloadVer === input.payloadVer
            && canonicalJson(stored.payload) === canonicalJson(input.payload)
            && stored.sourceAt === input.sourceAt;
    }

    private async guard<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (error instanceof ActionStoreError) throw error;
            const code = (error as { code?: string }).code;
            if (code === '23505') {
                throw new ActionStoreError(
                    'observation_conflict', 'A durable observation identity already exists'
                );
            }
            if (code === '40001') {
                throw new ActionStoreError('version_conflict', 'Action changed during reduction', true);
            }
            if (code === '23514' || code === '55000') {
                throw new ActionStoreError('db_invariant', 'The database rejected invalid evidence');
            }
            throw error;
        }
    }
}
