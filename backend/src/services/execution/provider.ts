import { ProviderQuote, QuoteRequest, SubmitResult } from '../../types';

export interface ProviderAck {
    signature?: string;
    rawStatus?: string;
}

export interface ProviderCall {
    signal?: AbortSignal;
}

export interface SwapProvider {
    readonly name: ProviderQuote['provider'];
    quote(request: QuoteRequest): Promise<ProviderQuote>;
    submit(input: {
        providerQuoteId: string;
        signedTransaction: string;
    }, call?: ProviderCall): Promise<SubmitResult>;
}

export class ExecutionProviderError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean,
        readonly status = 502,
        readonly retryAfterMs?: number,
        readonly uncertain = false,
        readonly ack?: ProviderAck
    ) {
        super(message);
        this.name = 'ExecutionProviderError';
    }
}
