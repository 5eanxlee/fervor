import {
    OrderAuth,
    OrderAuthType,
    OrderChallenge,
    OrderProviderName,
    OrderRequest,
    OrderState,
    OrderUpdate,
} from '../../types';

export interface ProviderPreparedOrder {
    provider: OrderProviderName;
    depositRequestId: string;
    transaction: string;
    receiverAddress?: string;
    inputAccount: string;
    outputAccount?: string;
}

export interface ProviderActiveOrder {
    providerOrderId: string;
    state: 'activating' | 'open' | 'failed';
    depositSignature?: string;
    rawState?: string;
}

export interface ProviderCancelOrder {
    requestId: string;
    transaction: string;
}

export interface ProviderCancelledOrder {
    state: 'cancelled' | 'failed';
    signature?: string;
    rawState?: string;
}

export interface ProviderMoneyEvent {
    type: 'deposit' | 'fill' | 'withdrawal';
    state: string;
    signature: string;
    occurredAt: string;
    mint: string;
    amount: string;
    outputMint?: string;
    outputAmount?: string;
    orderContext?: string;
}

export interface ProviderOrderSnapshot {
    providerOrderId: string;
    orderType: OrderRequest['orderType'];
    updatedAt?: string;
    walletAddress?: string;
    vaultAddress?: string;
    inputMint?: string;
    outputMint?: string;
    inputAmount?: string;
    remainingInput?: string;
    moneyEvents?: ProviderMoneyEvent[];
    state: OrderState;
    rawState?: string;
    depositSignature?: string;
    fillSignature?: string;
    cancelSignature?: string;
    fillPercent?: number;
    outputAmount?: string;
    inputUsed?: string;
    triggerPriceUsd?: number;
    trailingBps?: number;
    slippageBps?: number;
    takeProfitPriceUsd?: number;
    stopLossPriceUsd?: number;
    takeProfitSlippageBps?: number;
    stopLossSlippageBps?: number;
    highWatermark?: number;
    lowWatermark?: number;
}

export interface OrderProvider {
    readonly name: OrderProviderName;
    readonly requiresAuth: boolean;
    readonly custody: 'none' | 'third_party_vault';
    challenge(walletAddress: string, type: OrderAuthType, signal?: AbortSignal): Promise<OrderChallenge>;
    verify(walletAddress: string, auth: OrderAuth, signal?: AbortSignal): Promise<string>;
    prepare(request: OrderRequest, authToken?: string, signal?: AbortSignal): Promise<ProviderPreparedOrder>;
    activate(request: OrderRequest, depositRequestId: string, signedTransaction: string, authToken?: string, signal?: AbortSignal): Promise<ProviderActiveOrder>;
    update(providerOrderId: string, input: OrderUpdate, authToken?: string, signal?: AbortSignal): Promise<void>;
    cancel(providerOrderId: string, authToken?: string, signal?: AbortSignal): Promise<ProviderCancelOrder>;
    confirmCancel(providerOrderId: string, cancelRequestId: string, signedTransaction: string, authToken?: string, signal?: AbortSignal): Promise<ProviderCancelledOrder>;
    history?(authToken?: string, signal?: AbortSignal): Promise<ProviderOrderSnapshot[]>;
}

export class OrderProviderError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean,
        readonly status = 502,
        readonly retryAfterMs?: number,
        readonly uncertain = false
    ) {
        super(message);
        this.name = 'OrderProviderError';
    }
}
