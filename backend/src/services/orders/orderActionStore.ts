import { DbQuery, transaction } from '../../config/database';
import {
    actionKinds as actionKindList,
    httpClasses as httpClassList,
    orderPolicy,
} from '../../contracts/orderPolicy';
import {
    ActionAttempt,
    ActionFence,
    AttemptHttpClass,
    AttemptMethod,
    OrderAction,
    OrderActionKind,
} from '../../types';
import { eventOutbox, EventOutbox } from '../eventOutbox';
import { ActionStoreError } from './orderActionError';
import {
    attemptFact,
    iso,
    mapAction,
    mapAttempt,
    optional,
    type ActionRow as Row,
} from './orderActionModel';
import { emitOrderEvent } from './orderEventWriter';
import { dispatchRules, matchesStatus } from './actionPolicies';
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

export { ActionStoreError } from './orderActionError';

type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;

export interface AdmitAction extends EventContext {
    id: string;
    orderId: string;
    userId: string;
    legId?: string;
    parentId?: string;
    kind: OrderActionKind;
    ruleVer: 1;
    clientKey: string;
    reqHash: string;
    desiredHash: string;
    expectedVer: string;
    provider: string;
    dueAt: string;
}

export interface ClaimActions {
    provider: string;
    owner: string;
    epoch: string;
    leaseMs: number;
    limit: number;
}

export interface ReadyAction extends EventContext {
    actionId: string;
    expectedVer: string;
    fence: ActionFence;
    dueAt: string;
}

export interface StartAttempt extends EventContext {
    id: string;
    actionId: string;
    expectedVer: string;
    fence: ActionFence;
    endpoint: string;
    method: AttemptMethod;
    reqHash: string;
    bodyHash?: string;
    providerReqId?: string;
    blobActionId?: string;
    deadlineAt: string;
}

export interface AttemptResponse extends EventContext {
    attemptId: string;
    completedAt: string;
    httpClass: AttemptHttpClass;
    httpStatus?: number;
    responseHash?: string;
    providerEffectId?: string;
    errorCode?: string;
    errorMessage?: string;
}

export interface ReconcileAction extends EventContext {
    actionId: string;
    expectedVer: string;
    fence: ActionFence;
    dueAt: string;
    errorCode?: string;
    errorClass?: string;
    errorMessage?: string;
    httpClass?: AttemptHttpClass;
    retryAfter?: string;
}

export type DeferAction = ReconcileAction;

const actionKinds = new Set<OrderActionKind>(actionKindList);
const reconcileKinds = ['provider_sync', 'chain_sync'] as const satisfies readonly OrderActionKind[];
const reconcileKindSet = new Set<OrderActionKind>(reconcileKinds);
const methods = new Set<AttemptMethod>(Object.values(orderPolicy.dispatch)
    .flatMap((rule) => rule.methods) as AttemptMethod[]);
const blobActions = actionKindList.filter((kind) => orderPolicy.dispatch[kind].blob);
const httpClasses = new Set<AttemptHttpClass>(httpClassList);

const sameFence = (action: OrderAction, fence: ActionFence): boolean => (
    action.lease?.owner === fence.owner
    && action.lease.gen === fence.gen
    && action.lease.scope === fence.scope
    && action.lease.epoch === fence.epoch
);

export class OrderActionStore {
    constructor(
        private readonly tx: TxFn = transaction,
        private readonly outbox: Pick<EventOutbox, 'enqueue'> = eventOutbox
    ) {}

    admit(input: AdmitAction): Promise<{ action: OrderAction; replayed: boolean }> {
        return this.guard(async () => {
            this.validateAdmit(input);
            return this.tx(async (db) => {
                const replay = await db<Row>(
                    `SELECT * FROM order_actions WHERE user_id = $1 AND client_key = $2`,
                    [input.userId, input.clientKey]
                );
                if (replay.rows[0]) {
                    if (!this.sameAdmission(replay.rows[0], input)) {
                        throw new ActionStoreError(
                            'idempotency_conflict',
                            'Action client key was reused for a different effect'
                        );
                    }
                    return { action: mapAction(replay.rows[0]), replayed: true };
                }

                const advanced = await db<Row>(
                    `UPDATE order_intents
                        SET order_ver = order_ver + 1
                      WHERE id = $1 AND user_id = $2 AND order_ver = $3
                        AND NOT EXISTS (
                            SELECT 1 FROM order_actions active
                             WHERE active.order_id = order_intents.id
                               AND active.work_state <> 'done'
                        )
                      RETURNING order_ver`,
                    [input.orderId, input.userId, input.expectedVer]
                );
                if (!advanced.rows[0]) {
                    const raced = await db<Row>(
                        `SELECT * FROM order_actions WHERE user_id = $1 AND client_key = $2`,
                        [input.userId, input.clientKey]
                    );
                    if (raced.rows[0]) {
                        if (!this.sameAdmission(raced.rows[0], input)) {
                            throw new ActionStoreError(
                                'idempotency_conflict',
                                'Action client key was reused for a different effect'
                            );
                        }
                        return { action: mapAction(raced.rows[0]), replayed: true };
                    }
                    const order = await db<Row>(
                        `SELECT order_row.user_id, order_row.order_ver,
                                EXISTS (
                                    SELECT 1 FROM order_actions active
                                     WHERE active.order_id = order_row.id
                                       AND active.work_state <> 'done'
                                ) AS has_active
                           FROM order_intents order_row WHERE order_row.id = $1`,
                        [input.orderId]
                    );
                    if (!order.rows[0] || String(order.rows[0].user_id) !== input.userId) {
                        throw new ActionStoreError('not_found', 'Order was not found for this user');
                    }
                    if (order.rows[0].has_active === true) {
                        throw new ActionStoreError(
                            'state_conflict', 'Order already has an unfinished action'
                        );
                    }
                    throw new ActionStoreError('version_conflict', 'Order version changed', true);
                }
                await this.assertCircuit(db, input.orderId, input.id, input.kind);
                const inserted = await db<Row>(
                    `INSERT INTO order_actions (
                        id, order_id, user_id, leg_id, parent_action, kind, client_key,
                        rule_ver, req_hash, desired_hash, expected_ver, work_state,
                        effect_state, outcome, provider, due_at
                     ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                        'queued', 'not_possible', 'pending', $12, $13
                     )
                     ON CONFLICT DO NOTHING
                     RETURNING *`,
                    [input.id, input.orderId, input.userId, input.legId ?? null, input.parentId ?? null,
                        input.kind, input.clientKey, input.ruleVer, input.reqHash, input.desiredHash,
                        input.expectedVer, input.provider, input.dueAt]
                );
                if (inserted.rows[0]) {
                    const action = mapAction(inserted.rows[0]);
                    await this.emit(db, action, `action:${action.id}:v0:admitted`, 'action.admitted',
                        'queued', input);
                    return { action, replayed: false };
                }
                const existing = await db<Row>(
                    `SELECT * FROM order_actions WHERE user_id = $1 AND client_key = $2`,
                    [input.userId, input.clientKey]
                );
                const row = existing.rows[0];
                if (!row || !this.sameAdmission(row, input)) {
                    throw new ActionStoreError(
                        'idempotency_conflict',
                        'Action client key or identifier was reused for a different effect'
                    );
                }
                return { action: mapAction(row), replayed: true };
            });
        });
    }

    claim(input: ClaimActions): Promise<OrderAction[]> {
        return this.guard(async () => {
            const scope = this.validateClaim(input);
            return this.tx(async (db) => {
                await db('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 1937006964))', [scope]);
                const epoch = await db<Row>(
                    `SELECT epoch, mode FROM order_epoch_current WHERE scope = $1`, [scope]
                );
                if (!epoch.rows[0] || String(epoch.rows[0].epoch) !== input.epoch
                    || epoch.rows[0].mode !== 'live') {
                    throw new ActionStoreError('epoch_closed', 'Provider write epoch is not live', true);
                }
                const claimed = await db<Row>(
                    `WITH tick AS MATERIALIZED (
                        SELECT clock_timestamp() AS now_at
                     ), due AS (
                        SELECT action.id, tick.now_at
                          FROM order_actions action
                          JOIN order_intents order_row ON order_row.id = action.order_id
                          CROSS JOIN tick
                         WHERE action.provider = $1
                           AND order_row.order_ver = action.expected_ver + 1
                           AND action.work_state IN ('queued', 'ready', 'reconciling')
                           AND action.outcome = 'pending'
                           AND action.block_reason IS NULL
                           AND action.due_at <= tick.now_at
                           AND (action.lease_owner IS NULL OR action.lease_until <= tick.now_at)
                           AND (
                               NOT (action.kind = ANY($7::varchar[]) AND action.work_state = 'ready')
                               OR EXISTS (
                                   SELECT 1 FROM order_tx_blobs blob
                                    WHERE blob.action_id = action.id
                                      AND blob.aad_ver = 2
                                      AND blob.purged_at IS NULL
                                      AND blob.expires_at > tick.now_at
                               )
                           )
                           AND NOT EXISTS (
                               SELECT 1 FROM order_actions prior
                                WHERE prior.order_id = action.order_id
                                  AND prior.expected_ver < action.expected_ver
                                  AND prior.work_state <> 'done'
                           )
                           AND (action.parent_action IS NULL OR EXISTS (
                               SELECT 1 FROM order_actions parent
                                WHERE parent.id = action.parent_action
                                  AND parent.work_state = 'done'
                                  AND parent.effect_state = 'present'
                                  AND parent.outcome = 'succeeded'
                           ))
                           AND (
                               action.kind = ANY($8::varchar[])
                               OR action.work_state = 'reconciling'
                               OR NOT EXISTS (
                                   SELECT 1
                                     FROM asset_obligations obligation
                                    WHERE obligation.state IN ('open', 'review')
                                      AND obligation.blocks_actions
                                      AND (
                                          obligation.order_id = action.order_id
                                          OR obligation.action_id = action.id
                                          OR (
                                              obligation.cluster = order_row.cluster
                                              AND obligation.wallet_address = order_row.wallet_address
                                              AND (
                                                  obligation.mint IN (
                                                      order_row.input_mint, order_row.output_mint
                                                  )
                                                  OR EXISTS (
                                                      SELECT 1
                                                        FROM asset_claim_parts part
                                                       WHERE part.obligation_id = obligation.id
                                                         AND part.mint IN (
                                                             order_row.input_mint,
                                                             order_row.output_mint
                                                         )
                                                  )
                                              )
                                          )
                                      )
                               )
                           )
                         ORDER BY action.due_at, action.id
                         FOR UPDATE SKIP LOCKED
                         LIMIT $2
                     )
                     UPDATE order_actions action
                        SET action_ver = action.action_ver + 1,
                            lease_owner = $3,
                            lease_gen = action.lease_gen + 1,
                            lease_until = due.now_at + ($4::text || ' milliseconds')::interval,
                            write_scope = $5,
                            write_epoch = $6
                       FROM due
                      WHERE action.id = due.id
                      RETURNING action.*`,
                    [input.provider, input.limit, input.owner, input.leaseMs, scope, input.epoch,
                        blobActions, reconcileKinds]
                );
                return claimed.rows.map(mapAction);
            });
        });
    }

    ready(input: ReadyAction): Promise<OrderAction> {
        return this.guard(async () => {
            this.validateFenceInput(input);
            timestamp(input.dueAt, 'dueAt');
            return this.tx(async (db) => {
                await this.gate(db, input.actionId);
                const changed = await db<Row>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            work_state = 'ready',
                            due_at = $6
                      WHERE id = $1
                        AND action_ver = $2
                        AND lease_owner = $3
                        AND lease_gen = $4
                        AND write_scope = $5
                        AND write_epoch = $7
                        AND lease_until > clock_timestamp()
                        AND work_state IN ('queued', 'awaiting_sig')
                        AND effect_state = 'not_possible'
                        AND outcome = 'pending'
                        AND block_reason IS NULL
                      RETURNING *`,
                    [input.actionId, input.expectedVer, input.fence.owner, input.fence.gen,
                        input.fence.scope, input.dueAt, input.fence.epoch]
                );
                const action = await this.requireChange(db, input.actionId, input.expectedVer,
                    input.fence, changed.rows[0], 'Action cannot become ready');
                await this.emit(db, action, `action:${action.id}:v${action.version}:ready`,
                    'action.ready', 'ready', input);
                return action;
            });
        });
    }

    start(input: StartAttempt): Promise<{ action: OrderAction; attempt: ActionAttempt }> {
        return this.guard(async () => {
            this.validateStart(input);
            return this.tx(async (db) => {
                const gated = await this.gate(db, input.actionId);
                await this.assertEgress(db, gated);
                this.assertDispatch(gated, input);
                const changed = await db<Row>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            work_state = 'dispatching',
                            effect_state = 'possible',
                            ambiguity_at = COALESCE(ambiguity_at, clock_timestamp()),
                            attempt_count = attempt_count + 1
                      WHERE id = $1
                        AND action_ver = $2
                        AND lease_owner = $3
                        AND lease_gen = $4
                        AND write_scope = $5
                        AND write_epoch = $6
                        AND lease_until > clock_timestamp()
                        AND work_state = 'ready'
                        AND effect_state = 'not_possible'
                        AND outcome = 'pending'
                        AND block_reason IS NULL
                      RETURNING *`,
                    [input.actionId, input.expectedVer, input.fence.owner, input.fence.gen,
                        input.fence.scope, input.fence.epoch]
                );
                const action = await this.requireChange(db, input.actionId, input.expectedVer,
                    input.fence, changed.rows[0], 'Action cannot start an outbound attempt');
                const attempt = await db<Row>(
                    `INSERT INTO action_attempts (
                        id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
                        method, provider, req_hash, body_hash, desired_hash, provider_req_id,
                        blob_action_id, send_state, started_at, deadline_at
                     ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                        'started', clock_timestamp(), $15
                     )
                     RETURNING *`,
                    [input.id, action.id, action.attemptCount, input.fence.gen, input.fence.scope,
                        input.fence.epoch, input.endpoint, input.method, action.provider,
                        input.reqHash, input.bodyHash ?? null, action.desiredHash,
                        input.providerReqId ?? null, input.blobActionId ?? null, input.deadlineAt]
                );
                const attemptRow = mapAttempt(attempt.rows[0]);
                await this.emit(db, action,
                    `action:${action.id}:v${action.version}:attempt:${attemptRow.seq}:started`,
                    'attempt.started', 'dispatching', input, { attempt: attemptFact(attemptRow) });
                return { action, attempt: attemptRow };
            });
        });
    }

    respond(input: AttemptResponse): Promise<{ attempt: ActionAttempt; replayed: boolean }> {
        return this.guard(async () => {
            this.validateResponse(input);
            return this.tx(async (db) => {
                const scope = await db<Row>(
                    `SELECT order_row.id
                       FROM action_attempts attempt
                       JOIN order_actions action ON action.id = attempt.action_id
                       JOIN order_intents order_row ON order_row.id = action.order_id
                      WHERE attempt.id = $1
                      FOR SHARE OF order_row`,
                    [input.attemptId]
                );
                if (!scope.rows[0]) throw new ActionStoreError('not_found', 'Attempt was not found');
                const changed = await db<Row>(
                    `UPDATE action_attempts
                        SET send_state = 'response_recorded',
                            completed_at = $2,
                            http_status = $3,
                            http_class = $4,
                            response_hash = $5,
                            provider_effect_id = $6,
                            error_code = $7,
                            error_message = $8
                      WHERE id = $1 AND send_state = 'started'
                      RETURNING *`,
                    [input.attemptId, input.completedAt, input.httpStatus ?? null, input.httpClass,
                        input.responseHash ?? null, input.providerEffectId ?? null,
                        input.errorCode ?? null, input.errorMessage ?? null]
                );
                if (!changed.rows[0]) {
                    const existing = await db<Row>('SELECT * FROM action_attempts WHERE id = $1', [input.attemptId]);
                    if (!existing.rows[0]) throw new ActionStoreError('not_found', 'Attempt was not found');
                    const attempt = mapAttempt(existing.rows[0]);
                    if (!this.sameResponse(attempt, input)) {
                        throw new ActionStoreError('attempt_conflict', 'Attempt already has a different response fact');
                    }
                    return { attempt, replayed: true };
                }
                const attempt = mapAttempt(changed.rows[0]);
                const actionResult = await db<Row>('SELECT * FROM order_actions WHERE id = $1', [attempt.actionId]);
                const action = mapAction(actionResult.rows[0]);
                await this.emit(db, action, `attempt:${attempt.id}:response`, 'attempt.response',
                    'response_recorded', input, { attempt: attemptFact(attempt) });
                return { attempt, replayed: false };
            });
        });
    }

    reconcile(input: ReconcileAction): Promise<OrderAction> {
        return this.guard(async () => {
            this.validateReconcile(input);
            return this.tx(async (db) => {
                await this.gate(db, input.actionId);
                const changed = await db<Row>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            work_state = 'reconciling',
                            due_at = $6,
                            error_code = $7,
                            error_class = $8,
                            error_message = $9,
                            http_class = $10,
                            retry_after = $11,
                            lease_owner = NULL,
                            lease_until = NULL,
                            write_scope = NULL,
                            write_epoch = NULL
                      WHERE id = $1
                        AND action_ver = $2
                        AND lease_owner = $3
                        AND lease_gen = $4
                        AND write_scope = $5
                        AND write_epoch = $12
                        AND lease_until > clock_timestamp()
                        AND work_state = 'dispatching'
                        AND effect_state = 'possible'
                        AND outcome = 'pending'
                      RETURNING *`,
                    [input.actionId, input.expectedVer, input.fence.owner, input.fence.gen,
                        input.fence.scope, input.dueAt, input.errorCode ?? null,
                        input.errorClass ?? null, input.errorMessage ?? null,
                        input.httpClass ?? null, input.retryAfter ?? null, input.fence.epoch]
                );
                const action = await this.requireChange(db, input.actionId, input.expectedVer,
                    input.fence, changed.rows[0], 'Action cannot enter reconciliation');
                await this.emit(db, action, `action:${action.id}:v${action.version}:reconciling`,
                    'action.reconciling', 'reconciling', input);
                return action;
            });
        });
    }

    defer(input: DeferAction): Promise<OrderAction> {
        return this.guard(async () => {
            this.validateReconcile(input);
            return this.tx(async (db) => {
                await this.gate(db, input.actionId);
                const changed = await db<Row>(
                    `UPDATE order_actions
                        SET action_ver = action_ver + 1,
                            due_at = $6,
                            error_code = $7,
                            error_class = $8,
                            error_message = $9,
                            http_class = $10,
                            retry_after = $11,
                            lease_owner = NULL,
                            lease_until = NULL,
                            write_scope = NULL,
                            write_epoch = NULL
                      WHERE id = $1
                        AND action_ver = $2
                        AND lease_owner = $3
                        AND lease_gen = $4
                        AND write_scope = $5
                        AND write_epoch = $12
                        AND lease_until > clock_timestamp()
                        AND work_state = 'reconciling'
                        AND effect_state IN ('possible', 'conflict')
                        AND outcome = 'pending'
                      RETURNING *`,
                    [input.actionId, input.expectedVer, input.fence.owner, input.fence.gen,
                        input.fence.scope, input.dueAt, input.errorCode ?? null,
                        input.errorClass ?? null, input.errorMessage ?? null,
                        input.httpClass ?? null, input.retryAfter ?? null, input.fence.epoch]
                );
                const action = await this.requireChange(db, input.actionId, input.expectedVer,
                    input.fence, changed.rows[0], 'Action cannot defer reconciliation');
                await this.emit(db, action, `action:${action.id}:v${action.version}:deferred`,
                    'action.deferred', 'reconciling', input);
                return action;
            });
        });
    }

    private async emit(
        db: DbQuery,
        action: OrderAction,
        eventKey: string,
        eventType: string,
        state: string,
        context: EventContext,
        detail: Record<string, unknown> = {}
    ): Promise<void> {
        await emitOrderEvent(db, this.outbox, action, eventKey, eventType, state, context, detail);
    }

    private async gate(db: DbQuery, actionId: string): Promise<OrderAction> {
        const current = await db<Row>(
            `SELECT action.*, order_row.order_ver AS aggregate_ver
               FROM order_intents order_row
               JOIN order_actions action ON action.order_id = order_row.id
              WHERE action.id = $1
              FOR UPDATE OF order_row`,
            [actionId]
        );
        if (!current.rows[0]) throw new ActionStoreError('not_found', 'Action was not found');
        const action = mapAction(current.rows[0]);
        const requiredVer = (BigInt(action.expectedVer) + 1n).toString();
        if (String(current.rows[0].aggregate_ver) !== requiredVer) {
            throw new ActionStoreError(
                'version_conflict', 'Order version no longer authorizes this action', true
            );
        }
        const predecessor = await db<Row>(
            `SELECT id FROM order_actions
              WHERE order_id = $1
                AND expected_ver < $2
                AND work_state <> 'done'
              ORDER BY expected_ver, id
              LIMIT 1
              FOR SHARE`,
            [action.orderId, action.expectedVer]
        );
        if (predecessor.rows[0]) {
            throw new ActionStoreError('state_conflict', 'A predecessor action is unfinished');
        }
        if (action.parentId) {
            const parentResult = await db<Row>(
                `SELECT id, order_id, work_state, effect_state, outcome
                   FROM order_actions WHERE id = $1 FOR SHARE`,
                [action.parentId]
            );
            const parent = parentResult.rows[0];
            if (!parent || parent.effect_state !== 'present' || parent.outcome !== 'succeeded') {
                throw new ActionStoreError('state_conflict', 'Parent action success is not proven');
            }
            if (String(parent.order_id) !== action.orderId || parent.work_state !== 'done') {
                throw new ActionStoreError('state_conflict', 'Parent action belongs to another aggregate');
            }
        }
        return action;
    }

    private async assertEgress(db: DbQuery, action: OrderAction): Promise<void> {
        if (reconcileKindSet.has(action.kind)) return;
        const blocked = await db<Row>(
            `SELECT id FROM order_anomalies
              WHERE order_id = $1
                AND state <> 'resolved'
                AND blocks_actions
              ORDER BY opened_at, id
              LIMIT 1
              FOR SHARE`,
            [action.orderId]
        );
        if (blocked.rows[0]) {
            throw new ActionStoreError(
                'state_conflict', 'A blocking order anomaly prohibits outbound mutation'
            );
        }
        await this.assertCircuit(db, action.orderId, action.id, action.kind);
    }

    private async assertCircuit(
        db: DbQuery,
        orderId: string,
        actionId: string,
        kind: OrderActionKind
    ): Promise<void> {
        if (reconcileKindSet.has(kind)) return;
        const blocked = await db<Row>(
            `SELECT obligation.id
               FROM asset_obligations obligation
               JOIN order_intents order_row ON order_row.id = $1
              WHERE obligation.state IN ('open', 'review')
                AND obligation.blocks_actions
                AND (
                    obligation.order_id = order_row.id
                    OR obligation.action_id = $2
                    OR (
                        obligation.cluster = order_row.cluster
                        AND obligation.wallet_address = order_row.wallet_address
                        AND (
                            obligation.mint IN (order_row.input_mint, order_row.output_mint)
                            OR EXISTS (
                                SELECT 1
                                  FROM asset_claim_parts part
                                 WHERE part.obligation_id = obligation.id
                                   AND part.mint IN (order_row.input_mint, order_row.output_mint)
                            )
                        )
                    )
                )
              ORDER BY obligation.opened_at, obligation.id
              LIMIT 1
              FOR SHARE OF obligation`,
            [orderId, actionId]
        );
        if (blocked.rows[0]) {
            throw new ActionStoreError(
                'state_conflict', 'An unresolved asset obligation prohibits financial mutation'
            );
        }
    }

    private assertDispatch(action: OrderAction, input: StartAttempt): void {
        const rule = dispatchRules[action.kind];
        if (!rule.methods.has(input.method)) {
            invalid(`${action.kind} does not permit ${input.method} dispatch`);
        }
        if (action.reqHash !== input.reqHash) {
            invalid('Attempt request hash must match its admitted action');
        }
        const hasBody = input.bodyHash !== undefined;
        if (hasBody !== rule.body) {
            invalid(`${action.kind} ${rule.body ? 'requires' : 'forbids'} a request body hash`);
        }
        const hasBlob = input.blobActionId !== undefined;
        if (hasBlob !== rule.blob || (hasBlob && input.blobActionId !== action.id)) {
            invalid(`${action.kind} ${rule.blob ? 'requires its own' : 'forbids a'} signed blob`);
        }
    }

    private async requireChange(
        db: DbQuery,
        actionId: string,
        expectedVer: string,
        fence: ActionFence,
        changed: Row | undefined,
        message: string
    ): Promise<OrderAction> {
        if (changed) return mapAction(changed);
        const current = await db<Row>('SELECT * FROM order_actions WHERE id = $1', [actionId]);
        if (!current.rows[0]) throw new ActionStoreError('not_found', 'Action was not found');
        const action = mapAction(current.rows[0]);
        if (action.version !== expectedVer) {
            throw new ActionStoreError('version_conflict', 'Action version changed', true);
        }
        if (!sameFence(action, fence) || Date.parse(action.lease!.until) <= Date.now()) {
            throw new ActionStoreError('lease_conflict', 'Action lease is no longer active', true);
        }
        throw new ActionStoreError('state_conflict', message);
    }

    private sameAdmission(row: Row, input: AdmitAction): boolean {
        return String(row.order_id) === input.orderId
            && String(row.user_id) === input.userId
            && optional(row.leg_id) === input.legId
            && optional(row.parent_action) === input.parentId
            && row.kind === input.kind
            && Number(row.rule_ver) === input.ruleVer
            && String(row.req_hash) === input.reqHash
            && String(row.desired_hash) === input.desiredHash
            && String(row.expected_ver) === input.expectedVer
            && String(row.provider) === input.provider
            && iso(row.due_at) === input.dueAt;
    }

    private sameResponse(attempt: ActionAttempt, input: AttemptResponse): boolean {
        return attempt.sendState === 'response_recorded'
            && attempt.completedAt === iso(input.completedAt)
            && attempt.httpClass === input.httpClass
            && attempt.httpStatus === input.httpStatus
            && attempt.responseHash === input.responseHash
            && attempt.providerEffectId === input.providerEffectId
            && attempt.errorCode === input.errorCode
            && attempt.errorMessage === input.errorMessage;
    }

    private validateAdmit(input: AdmitAction): void {
        eventContext(input);
        uuid(input.id, 'id');
        uuid(input.orderId, 'orderId');
        uuid(input.userId, 'userId');
        if (input.legId !== undefined) uuid(input.legId, 'legId');
        if (input.parentId !== undefined) uuid(input.parentId, 'parentId');
        if (!actionKinds.has(input.kind)) invalid('kind is unsupported');
        if (input.ruleVer !== 1) invalid('ruleVer is unsupported');
        bounded(input.clientKey, 'clientKey', 128);
        hash(input.reqHash, 'reqHash');
        hash(input.desiredHash, 'desiredHash');
        uint(input.expectedVer, 'expectedVer');
        bounded(input.provider, 'provider', 32);
        timestamp(input.dueAt, 'dueAt');
    }

    private validateClaim(input: ClaimActions): string {
        bounded(input.provider, 'provider', 32);
        bounded(input.owner, 'owner', 128);
        uint(input.epoch, 'epoch', true);
        if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 100 || input.leaseMs > 300_000) {
            invalid('leaseMs must be an integer from 100 to 300000');
        }
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
            invalid('limit must be an integer from 1 to 500');
        }
        return `provider:${input.provider}`;
    }

    private validateFenceInput(input: EventContext & {
        actionId: string;
        expectedVer: string;
        fence: ActionFence;
    }): void {
        eventContext(input);
        uuid(input.actionId, 'actionId');
        uint(input.expectedVer, 'expectedVer');
        bounded(input.fence.owner, 'fence.owner', 128);
        uint(input.fence.gen, 'fence.gen', true);
        bounded(input.fence.scope, 'fence.scope', 64);
        uint(input.fence.epoch, 'fence.epoch', true);
    }

    private validateStart(input: StartAttempt): void {
        this.validateFenceInput(input);
        uuid(input.id, 'id');
        bounded(input.endpoint, 'endpoint', 180);
        if (!methods.has(input.method)) invalid('method is unsupported');
        hash(input.reqHash, 'reqHash');
        if (input.bodyHash !== undefined) hash(input.bodyHash, 'bodyHash');
        if (input.providerReqId !== undefined) bounded(input.providerReqId, 'providerReqId', 180);
        if (input.blobActionId !== undefined) uuid(input.blobActionId, 'blobActionId');
        timestamp(input.deadlineAt, 'deadlineAt');
    }

    private validateResponse(input: AttemptResponse): void {
        eventContext(input);
        uuid(input.attemptId, 'attemptId');
        timestamp(input.completedAt, 'completedAt');
        if (!httpClasses.has(input.httpClass)) invalid('httpClass is unsupported');
        if (input.httpStatus !== undefined
            && (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
            invalid('httpStatus must be an integer from 100 to 599');
        }
        if (input.responseHash !== undefined) hash(input.responseHash, 'responseHash');
        if (input.providerEffectId !== undefined) bounded(input.providerEffectId, 'providerEffectId', 180);
        if (input.errorCode !== undefined) bounded(input.errorCode, 'errorCode', 80);
        if (input.errorMessage !== undefined) bounded(input.errorMessage, 'errorMessage', 500);
        const transport = input.httpClass === 'transport_error' || input.httpClass === 'timeout';
        if (transport && input.httpStatus !== undefined) {
            invalid(`${input.httpClass} must not carry an HTTP status`);
        }
        if (!transport && (input.httpStatus === undefined
            || !matchesStatus(input.httpClass, input.httpStatus))) {
            invalid(`${input.httpClass} does not match its HTTP status`);
        }
        if (input.httpClass === 'success'
            && (input.errorCode !== undefined || input.errorMessage !== undefined)) {
            invalid('Successful responses must not carry normalized errors');
        }
        if (input.httpClass !== 'success' && input.errorCode === undefined) {
            invalid('Non-success responses require a normalized error code');
        }
    }

    private validateReconcile(input: ReconcileAction): void {
        this.validateFenceInput(input);
        timestamp(input.dueAt, 'dueAt');
        if (input.retryAfter !== undefined) timestamp(input.retryAfter, 'retryAfter');
        if (input.errorCode !== undefined) bounded(input.errorCode, 'errorCode', 80);
        if (input.errorClass !== undefined) bounded(input.errorClass, 'errorClass', 32);
        if (input.errorMessage !== undefined) bounded(input.errorMessage, 'errorMessage', 500);
        if (input.httpClass !== undefined && !httpClasses.has(input.httpClass)) {
            invalid('httpClass is unsupported');
        }
    }

    private async guard<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (error instanceof ActionStoreError) throw error;
            const code = (error as { code?: string }).code;
            if (code === '40001') {
                throw new ActionStoreError('lease_conflict', 'Action fence changed', true);
            }
            if (code === '23505') {
                throw new ActionStoreError('attempt_conflict', 'A durable action identity already exists');
            }
            if (code === '23514' || code === '55000') {
                throw new ActionStoreError('db_invariant', 'The database rejected an invalid action fact');
            }
            throw error;
        }
    }
}
