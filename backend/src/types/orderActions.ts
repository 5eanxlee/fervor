export type OrderActionKind =
    | 'prepare'
    | 'activate'
    | 'edit'
    | 'cancel_init'
    | 'cancel_confirm'
    | 'provider_sync'
    | 'chain_sync'
    | 'expire'
    | 'compensate';

export type ActionWorkState =
    | 'queued'
    | 'awaiting_sig'
    | 'ready'
    | 'dispatching'
    | 'reconciling'
    | 'parked'
    | 'done';

export type ActionEffectState = 'not_possible' | 'possible' | 'present' | 'absent' | 'conflict';
export type ActionOutcome = 'pending' | 'succeeded' | 'failed' | 'manual_review';
export type ActionBlock = 'needs_auth' | 'circuit_open' | 'operator_hold';
export type ActionActor = 'user' | 'system' | 'provider' | 'chain' | 'operator';
export type AttemptMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type AttemptHttpClass =
    | 'success'
    | 'client_error'
    | 'auth_error'
    | 'rate_limited'
    | 'conflict'
    | 'server_error'
    | 'transport_error'
    | 'timeout';

export type ActionRuleVer = 1;
export type ObservationSource = 'provider' | 'chain';
export type ObservationQuery = 'unchecked' | 'found' | 'queried_no_evidence' | 'expired_unseen';
export type ObservationVerdict = 'context' | 'presence' | 'absence' | 'conflict';

export interface ActionFence {
    owner: string;
    gen: string;
    scope: string;
    epoch: string;
}

export interface ActionLease extends ActionFence {
    until: string;
}

export interface OrderAction {
    id: string;
    orderId: string;
    userId: string;
    legId?: string;
    parentId?: string;
    kind: OrderActionKind;
    ruleVer: ActionRuleVer;
    clientKey: string;
    reqHash: string;
    desiredHash: string;
    expectedVer: string;
    version: string;
    workState: ActionWorkState;
    effectState: ActionEffectState;
    outcome: ActionOutcome;
    blockReason?: ActionBlock;
    provider: string;
    providerReqId?: string;
    providerOrderId?: string;
    firstSignature?: string;
    messageHash?: string;
    recentBlockhash?: string;
    lastValidHeight?: string;
    attemptCount: number;
    dueAt: string;
    lease?: ActionLease;
    ambiguityAt?: string;
    providerCheckAt?: string;
    chainCheckAt?: string;
    errorCode?: string;
    errorClass?: string;
    errorMessage?: string;
    httpClass?: string;
    retryAfter?: string;
    completedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ActionAttempt {
    id: string;
    actionId: string;
    seq: number;
    leaseGen: string;
    writeScope: string;
    writeEpoch: string;
    endpoint: string;
    method: AttemptMethod;
    provider: string;
    reqHash: string;
    bodyHash?: string;
    desiredHash: string;
    providerReqId?: string;
    blobActionId?: string;
    sendState: 'prepared' | 'started' | 'response_recorded';
    startedAt?: string;
    deadlineAt: string;
    completedAt?: string;
    httpStatus?: number;
    httpClass?: AttemptHttpClass;
    responseHash?: string;
    providerEffectId?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
}

export interface ActionObservation {
    id: string;
    actionId: string;
    attemptId?: string;
    source: ObservationSource;
    cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
    sourceKey: string;
    factKey: string;
    factRev: number;
    supersedes?: string;
    queryKind: ObservationQuery;
    verdict: ObservationVerdict;
    predicate: string;
    ruleVer: ActionRuleVer;
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
    commitment?: 'processed' | 'confirmed' | 'finalized';
    payloadHash: string;
    payloadVer: number;
    payload: Record<string, unknown>;
    sourceAt?: string;
    observedAt: string;
}
