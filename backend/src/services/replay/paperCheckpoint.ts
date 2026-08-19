import { createHash } from 'node:crypto';
import { z } from 'zod';
import { amountSchema, u64Schema } from '../../types/amount';
import { addressSchema } from '../../types/execution';
import {
    addMs,
    cloneFact,
    cloneOrder,
    grossOf,
    limitPriceOk,
    marketPriceOk,
    modelDigest,
    normalizeModel,
    paperCheckpointContract,
    paperFactContract,
    paperHash,
    paperModelSchema,
    paperOrderId,
    paperStatusSchema,
    paperTime,
    parseCanonicalTime,
    priceOf,
    protocolFee,
    rawPriceSchema,
    sameJson,
    terminal,
    type PaperFact,
    type PaperModel,
    type PaperOrder,
    type PaperStatus,
} from './paperTypes';

export interface PaperCheckpoint {
    readonly contract: typeof paperCheckpointContract;
    readonly runId: string;
    readonly epoch: number;
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly total: number;
    readonly now: string | null;
    readonly model: PaperModel;
    readonly modelSha256: string;
    readonly orders: readonly PaperOrder[];
    readonly facts: readonly PaperFact[];
    readonly checkpointSha256: string;
}

export type PaperPayload = Omit<PaperCheckpoint, 'checkpointSha256'>;

const feeSchema = z.object({
    kind: z.enum(['protocol', 'network', 'priority', 'rent']),
    mint: addressSchema,
    amountRaw: u64Schema,
}).strict();
const fillSchema = z.object({
    tradeId: paperHash,
    cursor: z.number().int().nonnegative(),
    observedAt: paperTime,
    inputMint: addressSchema,
    outputMint: addressSchema,
    inputRaw: amountSchema,
    grossOutputRaw: amountSchema,
    netOutputRaw: amountSchema,
    price: rawPriceSchema,
    fees: z.array(feeSchema).max(4),
}).strict();
const orderSchema = z.object({
    id: paperOrderId,
    kind: z.enum(['market', 'limit']),
    side: z.enum(['buy', 'sell']),
    status: paperStatusSchema,
    tokenMint: addressSchema,
    quoteMint: addressSchema,
    inputRaw: amountSchema,
    remainingRaw: u64Schema,
    filledInputRaw: u64Schema,
    grossOutputRaw: u64Schema,
    netOutputRaw: u64Schema,
    placedCursor: z.number().int().nonnegative(),
    placedAt: paperTime.nullable(),
    eligibleAt: paperTime.nullable(),
    expiresAt: paperTime.nullable(),
    price: rawPriceSchema,
    modelSha256: paperHash,
    fills: z.array(fillSchema).max(100_000),
}).strict();
const factSchema = z.object({
    contract: z.literal(paperFactContract),
    key: z.string().min(5).max(300),
    runId: paperOrderId,
    epoch: z.number().int().positive(),
    sourceReplaySha256: paperHash,
    modelSha256: paperHash,
    orderId: paperOrderId,
    seq: z.number().int().nonnegative(),
    kind: z.enum(['intent', 'eligible', 'fill', 'filled', 'expired', 'cancelled']),
    status: paperStatusSchema,
    cursor: z.number().int().nonnegative(),
    observedAt: paperTime.nullable(),
    reason: z.enum(['user', 'lookahead_elapsed', 'end_of_tape']).optional(),
    fill: fillSchema.optional(),
}).strict();
const checkpointSchema = z.object({
    contract: z.literal(paperCheckpointContract),
    runId: paperOrderId,
    epoch: z.number().int().positive(),
    sourceReplaySha256: paperHash,
    cursor: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    now: paperTime.nullable(),
    model: paperModelSchema,
    modelSha256: paperHash,
    orders: z.array(orderSchema).max(100_000),
    facts: z.array(factSchema).max(500_000),
    checkpointSha256: paperHash,
}).strict();

const digest = (payload: PaperPayload): string => createHash('sha256')
    .update(paperCheckpointContract)
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');

export const createPaperCheckpoint = (payload: PaperPayload): PaperCheckpoint =>
    Object.freeze({ ...payload, checkpointSha256: digest(payload) });

export const parsePaperCheckpoint = (value: unknown): PaperCheckpoint => {
    const parsed = checkpointSchema.parse(value);
    const model = normalizeModel(parsed.model);
    if (!sameJson(model, parsed.model)) throw new Error('Paper checkpoint model is not canonical');
    const payload: PaperPayload = {
        contract: paperCheckpointContract,
        runId: parsed.runId,
        epoch: parsed.epoch,
        sourceReplaySha256: parsed.sourceReplaySha256,
        cursor: parsed.cursor,
        total: parsed.total,
        now: parsed.now,
        model,
        modelSha256: parsed.modelSha256,
        orders: Object.freeze(parsed.orders.map(cloneOrder)),
        facts: Object.freeze(parsed.facts.map(cloneFact)),
    };
    if (modelDigest(model) !== payload.modelSha256
        || digest(payload) !== parsed.checkpointSha256) {
        throw new Error('Paper checkpoint checksum differs');
    }
    const checkpoint = createPaperCheckpoint(payload);
    validateState(checkpoint);
    return checkpoint;
};

const validateState = (checkpoint: PaperCheckpoint): void => {
    if (checkpoint.cursor > checkpoint.total
        || (checkpoint.cursor === 0) !== (checkpoint.now === null)) {
        throw new Error('Paper checkpoint cursor is invalid');
    }
    const checkpointMs = checkpoint.now === null ? null : parseCanonicalTime(checkpoint.now);
    const orderMap = new Map<string, PaperOrder>();
    for (const order of checkpoint.orders) {
        if (orderMap.has(order.id)
            || order.modelSha256 !== checkpoint.modelSha256
            || order.placedCursor > checkpoint.cursor
            || !sameJson(priceOf(order.price), order.price)
            || (order.placedCursor === 0) !== (order.placedAt === null)
            || (order.eligibleAt === null) !== (order.expiresAt === null)) {
            throw new Error('Paper checkpoint order identity is invalid');
        }
        if (order.placedAt !== null) parseCanonicalTime(order.placedAt);
        if (order.eligibleAt !== null) {
            const eligibleMs = parseCanonicalTime(order.eligibleAt);
            if (parseCanonicalTime(order.expiresAt!)
                !== addMs(eligibleMs, checkpoint.model.maxLookaheadMs)) {
                throw new Error('Paper checkpoint order window is invalid');
            }
        }
        validateFills(checkpoint, order, checkpointMs);
        orderMap.set(order.id, order);
    }
    validateFacts(checkpoint, orderMap, checkpointMs);
};

const validateFills = (
    checkpoint: PaperCheckpoint,
    order: PaperOrder,
    checkpointMs: number | null
): void => {
    const input = BigInt(order.inputRaw);
    const remaining = BigInt(order.remainingRaw);
    const filledInput = BigInt(order.filledInputRaw);
    let fillInput = 0n;
    let grossOutput = 0n;
    let netOutput = 0n;
    let priorCursor = -1;
    for (const [index, fill] of order.fills.entries()) {
        const fillInputRaw = BigInt(fill.inputRaw);
        const gross = BigInt(fill.grossOutputRaw);
        const net = BigInt(fill.netOutputRaw);
        const inputMint = order.side === 'buy' ? order.quoteMint : order.tokenMint;
        const outputMint = order.side === 'buy' ? order.tokenMint : order.quoteMint;
        const expectedGross = grossOf(order.side, fillInputRaw, fill.price);
        const expectedFee = protocolFee(expectedGross, checkpoint.model.protocolFeeBps);
        const expectedProtocol = expectedFee === 0n ? [] : [{
            kind: 'protocol',
            mint: outputMint,
            amountRaw: expectedFee.toString(),
        }];
        const expectedFixed = index === 0
            ? checkpoint.model.fixedFees.filter((fee) => fee.amountRaw !== '0') : [];
        const expectedFees = [...expectedProtocol, ...expectedFixed];
        if (fill.cursor < order.placedCursor
            || fill.cursor >= checkpoint.cursor
            || fill.cursor <= priorCursor
            || checkpointMs === null
            || parseCanonicalTime(fill.observedAt) > checkpointMs
            || fill.inputMint !== inputMint
            || fill.outputMint !== outputMint
            || gross !== expectedGross
            || expectedFee >= gross
            || net !== gross - expectedFee
            || !sameJson(priceOf(fill.price), fill.price)
            || !(order.kind === 'market'
                ? marketPriceOk(order.side, fill.price, order.price, checkpoint.model.priceGuardBps)
                : limitPriceOk(order.side, fill.price, order.price))
            || !sameJson(fill.fees, expectedFees)) {
            throw new Error('Paper checkpoint fill is invalid');
        }
        priorCursor = fill.cursor;
        fillInput += fillInputRaw;
        grossOutput += gross;
        netOutput += net;
    }
    if (remaining + filledInput !== input
        || fillInput !== filledInput
        || grossOutput !== BigInt(order.grossOutputRaw)
        || netOutput !== BigInt(order.netOutputRaw)
        || (order.status === 'filled') !== (remaining === 0n)) {
        throw new Error('Paper checkpoint order totals are invalid');
    }
};

const validateFacts = (
    checkpoint: PaperCheckpoint,
    orderMap: ReadonlyMap<string, PaperOrder>,
    checkpointMs: number | null
): void => {
    const factsByOrder = new Map<string, PaperFact[]>();
    let priorCursor = 0;
    let priorEpoch = 0;
    for (const fact of checkpoint.facts) {
        if (!orderMap.has(fact.orderId)
            || fact.runId !== checkpoint.runId
            || fact.sourceReplaySha256 !== checkpoint.sourceReplaySha256
            || fact.modelSha256 !== checkpoint.modelSha256
            || fact.epoch > checkpoint.epoch
            || fact.epoch < priorEpoch
            || fact.cursor > checkpoint.cursor
            || fact.cursor < priorCursor
            || fact.key !== `${checkpoint.sourceReplaySha256}:${checkpoint.runId}:${fact.orderId}:${fact.seq}`
            || (fact.kind === 'fill') !== (fact.fill !== undefined)
            || (fact.observedAt !== null
                && (checkpointMs === null
                    || parseCanonicalTime(fact.observedAt) > checkpointMs))) {
            throw new Error('Paper checkpoint fact binding is invalid');
        }
        priorCursor = fact.cursor;
        priorEpoch = fact.epoch;
        const orderFacts = factsByOrder.get(fact.orderId) ?? [];
        orderFacts.push(fact);
        factsByOrder.set(fact.orderId, orderFacts);
    }
    for (const order of orderMap.values()) {
        validateOrderFacts(checkpoint, order, factsByOrder.get(order.id) ?? []);
    }
};

const validateOrderFacts = (
    checkpoint: PaperCheckpoint,
    order: PaperOrder,
    facts: PaperFact[]
): void => {
    let state: PaperStatus | null = null;
    let fillIndex = 0;
    let filledInput = 0n;
    for (const [seq, fact] of facts.entries()) {
        if (fact.seq !== seq) throw new Error('Paper checkpoint fact sequence is invalid');
        if (fact.kind === 'intent') {
            if (seq !== 0
                || fact.status !== 'pending'
                || fact.cursor !== order.placedCursor
                || fact.observedAt !== order.placedAt
                || fact.reason !== undefined) {
                throw new Error('Paper checkpoint intent fact is invalid');
            }
            state = 'pending';
        } else if (fact.kind === 'eligible') {
            if (state !== 'pending'
                || fact.status !== 'eligible'
                || fact.observedAt === null
                || order.eligibleAt === null
                || parseCanonicalTime(fact.observedAt) < parseCanonicalTime(order.eligibleAt)
                || fact.reason !== undefined) {
                throw new Error('Paper checkpoint eligibility fact is invalid');
            }
            state = 'eligible';
        } else if (fact.kind === 'fill') {
            const fill = order.fills[fillIndex];
            if (fill !== undefined) filledInput += BigInt(fill.inputRaw);
            const expected = filledInput === BigInt(order.inputRaw) ? 'filled' : 'partially_filled';
            if ((state !== 'eligible' && state !== 'partially_filled')
                || fact.status !== expected
                || !sameJson(fact.fill, fill)
                || fact.cursor !== fill?.cursor
                || fact.observedAt !== fill?.observedAt
                || fact.reason !== undefined) {
                throw new Error('Paper checkpoint fill fact is invalid');
            }
            fillIndex += 1;
            state = fact.status;
        } else if (fact.kind === 'filled') {
            const fill = order.fills[fillIndex - 1];
            if (state !== 'filled'
                || fact.status !== 'filled'
                || fact.cursor !== fill?.cursor
                || fact.observedAt !== fill?.observedAt
                || fact.reason !== undefined) {
                throw new Error('Paper checkpoint completion fact is invalid');
            }
        } else {
            const expected = fact.kind === 'expired' ? 'expired' : 'cancelled';
            const reasonOk = fact.kind === 'cancelled'
                ? fact.reason === 'user'
                : fact.reason === 'lookahead_elapsed' || fact.reason === 'end_of_tape';
            const expiryOk = fact.reason !== 'lookahead_elapsed'
                || (fact.observedAt !== null
                    && order.expiresAt !== null
                    && parseCanonicalTime(fact.observedAt)
                        >= parseCanonicalTime(order.expiresAt));
            const tapeEndOk = fact.reason !== 'end_of_tape'
                || (fact.cursor === checkpoint.cursor && fact.observedAt === checkpoint.now);
            if (state === null
                || terminal(state)
                || fact.status !== expected
                || !reasonOk
                || !expiryOk
                || !tapeEndOk) {
                throw new Error('Paper checkpoint terminal fact is invalid');
            }
            state = expected;
        }
    }
    const lastKind = facts.length === 0 ? undefined : facts[facts.length - 1].kind;
    if (state !== order.status
        || fillIndex !== order.fills.length
        || (order.status === 'filled' && lastKind !== 'filled')
        || (order.status === 'expired' && lastKind !== 'expired')
        || (order.status === 'cancelled' && lastKind !== 'cancelled')) {
        throw new Error('Paper checkpoint facts differ from order state');
    }
};
