import { createHash, randomUUID } from 'crypto';
import type { OrderAction } from '../../types';
import type { DbQuery } from '../../config/database';
import type { EventOutbox } from '../eventOutbox';
import { STREAMS } from '../redisStreamService';
import { actionFact, iso, type ActionRow } from './orderActionModel';
import { ActionStoreError } from './orderActionError';
import { canonicalJson } from './canonicalJson';
import { eventContext, type EventContext } from './orderValidation';

export const emitOrderEvent = async (
    db: DbQuery,
    outbox: Pick<EventOutbox, 'enqueue'>,
    action: OrderAction,
    eventKey: string,
    eventType: string,
    state: string,
    context: EventContext,
    detail: Record<string, unknown> = {}
): Promise<void> => {
    eventContext(context);
    const order = await db<ActionRow>(
        `SELECT order_ver, clock_timestamp() AS event_at
           FROM order_intents WHERE id = $1 FOR SHARE`,
        [action.orderId]
    );
    if (!order.rows[0]) throw new ActionStoreError('not_found', 'Event order was not found');
    const eventId = randomUUID();
    const occurredAt = iso(order.rows[0].event_at);
    const orderVer = String(order.rows[0].order_ver);
    const payload = {
        order: { id: action.orderId, version: orderVer },
        action: actionFact(action),
        ...detail,
    };
    const eventHash = createHash('sha256').update(canonicalJson({
        actor: context.actor,
        eventKey,
        eventType,
        occurredAt,
        payload,
        state,
        traceId: context.traceId,
    })).digest('hex');
    await db(
        `INSERT INTO order_event_keys (
            event_key, event_id, order_id, action_id, event_type, order_ver,
            event_hash, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [eventKey, eventId, action.orderId, action.id, eventType, orderVer, eventHash, occurredAt]
    );
    await db(
        `INSERT INTO order_events (
            id, order_id, state, metadata, occurred_at, event_key, event_type,
            event_hash, order_ver, action_id, trace_id, actor_kind
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [eventId, action.orderId, state, canonicalJson(payload), occurredAt, eventKey,
            eventType, eventHash, orderVer, action.id, context.traceId, context.actor]
    );
    await outbox.enqueue(db, STREAMS.orderLifecycle, eventKey, {
        id: eventId,
        type: eventType,
        version: 1,
        key: action.orderId,
        source: 'order-action-store',
        occurredAt,
        receivedAt: occurredAt,
        traceId: context.traceId,
        actor: context.actor,
        eventHash,
        payload,
    });
};
