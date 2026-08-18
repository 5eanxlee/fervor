export interface WalletHistoryPage {
    transactions: unknown[];
    nextCursor?: string;
    newestSignature?: string;
    newestSlot?: number;
}

export interface WalletHistoryRequest {
    cursor?: string;
    afterSlot?: number;
}

export interface WalletHistoryProvider {
    readonly name: 'helius_history_v2';
    history(walletAddress: string, request?: WalletHistoryRequest): Promise<WalletHistoryPage>;
}

export class WalletProviderError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean,
        readonly status = 502,
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'WalletProviderError';
    }
}
