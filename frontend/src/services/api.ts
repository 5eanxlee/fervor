import axios, { AxiosResponse } from 'axios';
import type { ReplayControl, ReplayControlResult, ReplayState } from './replay';

export const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010/api';
const replayMode = process.env.NEXT_PUBLIC_DATA_MODE === 'replay';

const getApiNetworkErrorMessage = () => {
    const apiUrl = apiBase.startsWith('/')
        ? `same-origin ${apiBase}`
        : apiBase;

    return `Unable to reach the FERVOR API at ${apiUrl}. Start the backend, then try again.`;
};

interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    error?: string;
}

export type AlertThresholdType =
    | 'price' | 'market_cap' | 'liquidity'
    | 'volume_1m' | 'volume_5m' | 'volume_1h' | 'volume_6h' | 'volume_24h'
    | 'buy_count_1m' | 'buy_count_5m' | 'buy_count_1h' | 'buy_count_6h' | 'buy_count_24h'
    | 'sell_count_1m' | 'sell_count_5m' | 'sell_count_1h' | 'sell_count_6h' | 'sell_count_24h'
    | 'tx_count_1m' | 'tx_count_5m' | 'tx_count_1h' | 'tx_count_6h' | 'tx_count_24h';

interface TokenAlert {
    id: string;
    user_id: string;
    token_address: string;
    token_name?: string;
    token_symbol?: string;
    threshold_type: AlertThresholdType;
    threshold_value: number;
    condition: 'above' | 'below';
    notification_type: 'telegram' | 'discord';
    is_active: boolean;
    is_triggered: boolean;
    triggered_at?: string;
    cleared_at?: string;
    created_at: string;
    updated_at: string;
}

interface CreateAlertRequest {
    tokenAddress: string;
    thresholdType: AlertThresholdType;
    thresholdValue: number;
    condition: 'above' | 'below';
    notificationType: 'telegram' | 'discord';
}

interface UpdateAlertRequest {
    thresholdValue?: number;
    condition?: 'above' | 'below';
    isActive?: boolean;
}

interface SignInRequest {
    walletAddress: string;
    signature: string;
    message: string;
}

export interface AuthUser {
    id: string;
    walletAddress: string;
    email?: string;
    telegramChatId?: string;
    discordUserId?: string;
}

interface AuthResponse {
    token: string;
    user: AuthUser;
}

interface NonceResponse {
    message: string;
    nonce: string;
}

interface TokenPair {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    tokenLogo: string;
    tokenDecimals: string;
    pairTokenType: string;
    liquidityUsd: number;
}

interface TokenPairData {
    exchangeAddress: string;
    exchangeName: string;
    exchangeLogo: string;
    pairLabel: string;
    pairAddress: string;
    usdPrice: number;
    usdPrice24hrPercentChange: number;
    usdPrice24hrUsdChange: number;
    liquidityUsd: number;
    baseToken: string;
    quoteToken: string;
    pair: TokenPair[];
}

interface TokenPairsResponse {
    cursor?: string;
    pageSize: number;
    page: number;
    pairs: TokenPairData[];
}

export interface TokenMetadata {
    name: string;
    symbol: string;
    decimals: number;
    logo?: string;
    totalSupply: string;
    totalSupplyFormatted: string;
    fullyDilutedValue?: string;
    links?: {
        website?: string;
        twitter?: string;
        telegram?: string;
        reddit?: string;
    };
    description?: string;
    isVerifiedContract?: boolean;
    possibleSpam?: boolean;
}

export interface TokenHolder {
    owner: string;
    amount: number;
    amountUsd?: number;
    supplyPercent?: number;
    avgBuyPrice?: number;
    avgSellPrice?: number;
    firstTradeAt?: string;
    lastTradeAt?: string;
}

export interface TokenHolders {
    items: TokenHolder[];
    total?: number;
    totalSupply?: number;
    top10Percent?: number;
    source: 'helius';
}

export interface NotificationPreferencesResponse {
    channels: {
        telegram: { enabled: boolean; linked: boolean };
        discord: { enabled: boolean; linked: boolean };
    };
}

export interface NotificationDelivery {
    id: string;
    alert_event_id: string;
    channel: 'telegram' | 'discord';
    status: string;
    provider?: string;
    provider_status?: string;
    attempts: number;
    next_attempt_at?: string;
    last_attempt_at?: string;
    sent_at?: string;
    failed_at?: string;
    created_at: string;
}

// Standard token data interface
export interface TokenData {
    address: string;
    name: string;
    symbol: string;
    price: number;
    market_cap?: number;
    last_updated?: string;
    logo?: string;
}

export type DiscoveryCategory = 'new' | 'final' | 'migrated';

export interface DiscoveryToken {
    category: DiscoveryCategory;
    address: string;
    poolAddress?: string;
    protocol?: string;
    name: string;
    symbol: string;
    logo?: string;
    socials?: Record<string, string>;
    creator?: string;
    launchpad?: string;
    lifecycle: string;
    priceUsd?: number;
    marketCapUsd?: number;
    liquidityUsd?: number;
    volume5mUsd: number;
    buyCount5m: number;
    sellCount5m: number;
    createdAt: string;
    observedAt?: string;
}

export interface ExecutionCapabilities {
    mode: 'disabled' | 'live';
    provider: 'jupiter_swap_v2' | 'none';
    canQuote: boolean;
    canSubmit: boolean;
    clientSigning: true;
    managedLanding: true;
    maxSlippageBps: number;
    maxPriorityFeeLamports: number;
    maxJitoTipLamports: number;
    quoteTtlMs: number;
}

export interface SwapQuote {
    id: string;
    provider: 'jupiter_swap_v2';
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    outputAmount: string;
    minOutputAmount: string;
    taker: string;
    feePayer: string;
    transaction: string;
    requiresSignature: boolean;
    expiresAt: string;
    priceImpactPct?: string;
    route: Array<{ venue: string; percent: number }>;
    fees: Record<string, string | undefined>;
}

export interface TradeExecution {
    id: string;
    quoteId: string;
    state: 'signed' | 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed' | 'expired' | 'replaced';
    signature?: string;
    errorCode?: string;
    errorMessage?: string;
    expectedInputAmount: string;
    expectedOutputAmount: string;
    providerInputAmount?: string;
    providerOutputAmount?: string;
    actualInputAmount?: string;
    actualOutputAmount?: string;
    settlementStatus: 'pending' | 'verified' | 'mismatch' | 'unsupported';
    settlementSlot?: string;
    settlementCommitment?: 'confirmed' | 'finalized';
    settlementFeeLamports?: string;
}

export interface OrderCapabilities {
    mode: 'disabled' | 'live';
    provider: 'jupiter_trigger_v2' | 'none';
    canPrepare: boolean;
    canActivate: boolean;
    requiresProviderAuth: boolean;
    custody: 'none' | 'third_party_vault';
    orderTypes: Array<'single' | 'trailing' | 'oco' | 'otoco'>;
}

interface OrderBaseInput {
    walletAddress: string;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    triggerMint: string;
    expiresAt: string;
    clientOrderId: string;
}

export type OrderInput = OrderBaseInput & ({
    orderType: 'single';
    triggerCondition: 'above' | 'below';
    triggerPriceUsd?: number;
    trailingBps?: number;
    slippageBps?: number;
} | {
    orderType: 'oco';
    takeProfitPriceUsd: number;
    stopLossPriceUsd: number;
    takeProfitSlippageBps?: number;
    stopLossSlippageBps?: number;
} | {
    orderType: 'otoco';
    triggerCondition: 'above' | 'below';
    triggerPriceUsd: number;
    takeProfitPriceUsd: number;
    stopLossPriceUsd: number;
    slippageBps?: number;
    takeProfitSlippageBps?: number;
    stopLossSlippageBps?: number;
});

export type OrderUpdateInput = {
    orderType: 'single';
    triggerPriceUsd?: number;
    trailingBps?: number;
    slippageBps?: number;
} | {
    orderType: 'oco';
    takeProfitPriceUsd?: number;
    stopLossPriceUsd?: number;
    takeProfitSlippageBps?: number;
    stopLossSlippageBps?: number;
} | {
    orderType: 'otoco';
    triggerPriceUsd?: number;
    takeProfitPriceUsd?: number;
    stopLossPriceUsd?: number;
    slippageBps?: number;
    takeProfitSlippageBps?: number;
    stopLossSlippageBps?: number;
};

export type OrderChallenge =
    | { type: 'message'; challenge: string }
    | { type: 'transaction'; transaction: string };

export type OrderAuth =
    | { type: 'message'; signature: string }
    | { type: 'transaction'; signedTransaction: string };

export interface PreparedOrder {
    orderId: string;
    state: 'prepared';
    depositRequestId: string;
    transaction: string;
    custody: 'none' | 'third_party_vault';
    expiresAt: string;
}

export interface OrderRecord {
    id: string;
    providerOrderId?: string;
    clientOrderId: string;
    walletAddress: string;
    orderType: 'single' | 'oco' | 'otoco';
    state: string;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    triggerMint: string;
    params: Record<string, unknown>;
    expiresAt: string;
    createdAt: string;
}

export interface TrackedWallet {
    id: string;
    walletAddress: string;
    label?: string;
    notify: boolean;
    status: 'active' | 'paused';
    lastSignature?: string;
    lastSlot?: number;
    backfillComplete: boolean;
    backfillPages: number;
    createdAt: string;
    updatedAt: string;
}

export interface WalletPosition {
    trackedWalletId: string;
    tokenMint: string;
    tokenDecimals: number;
    quantityBase: string;
    costMicroUsd: string;
    unknownCostBase: string;
    realizedPnlMicroUsd: string;
    unresolvedSoldBase: string;
    untrackedSoldBase: string;
    currentValueMicroUsd?: string;
    unrealizedPnlMicroUsd?: string;
    priceUsd?: string;
    priceObservedAt?: string;
    updatedAt: string;
}

export interface WalletActivity {
    id: string;
    trackedWalletId: string;
    walletAddress: string;
    kind: 'swap' | 'transfer_in' | 'transfer_out';
    tokenMint?: string;
    tokenDecimals?: number;
    side?: 'buy' | 'sell';
    quantityBase?: string;
    valueMicroUsd?: string;
    signature: string;
    slot?: number;
    source: string;
    occurredAt: string;
}

export interface WalletActivityPage {
    items: WalletActivity[];
    nextCursor?: string;
}

export interface WalletPortfolio {
    trackedWalletId: string;
    marketValueMicroUsd: string;
    costMicroUsd: string;
    realizedPnlMicroUsd: string;
    unrealizedPnlMicroUsd?: string;
    pnlComplete: boolean;
    historyComplete: boolean;
    pricedAssets: number;
    unpricedAssets: number;
    positions: WalletPosition[];
}

export interface TokenCandle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
    buyCount: number;
    sellCount: number;
    txCount: number;
}

class ApiService {
    private authToken: string | null = null;

    constructor() {
        // Set up axios interceptors
        axios.interceptors.response.use(
            (response) => response,
            (error) => {
                const errorCode = error.response?.data?.error?.code;
                if (error.response?.status === 401 && errorCode !== 'provider_auth_expired') {
                    // Handle unauthorized - clear auth and redirect
                    this.setAuthToken(null);
                    if (typeof window !== 'undefined') {
                        localStorage.removeItem('auth_token');
                        localStorage.removeItem('auth_user');
                        window.location.href = '/';
                    }
                }
                return Promise.reject(error);
            }
        );
    }

    setAuthToken(token: string | null) {
        this.authToken = token;
    }

    private getHeaders(providerToken?: string) {
        const headers: any = {
            'Content-Type': 'application/json',
        };

        if (this.authToken) {
            if (replayMode) headers['X-Fervor-Replay-Session'] = this.authToken;
            else headers.Authorization = `Bearer ${this.authToken}`;
        }
        if (providerToken) headers['X-Order-Provider-Token'] = providerToken;

        return headers;
    }

    private async request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        endpoint: string,
        data?: any,
        providerToken?: string
    ): Promise<ApiResponse<T>> {
        try {
            const fullUrl = `${apiBase}${endpoint}`;
            const response: AxiosResponse<ApiResponse<T>> = await axios({
                method,
                url: fullUrl,
                data,
                headers: this.getHeaders(providerToken),
                timeout: 10000, // 10 second timeout
            });

            if (typeof response.data.success !== 'boolean') {
                return { success: true, data: response.data.data };
            }
            return response.data;
        } catch (error: any) {
            if (error.response?.data) {
                const payload = error.response.data;
                if (payload.error && typeof payload.error === 'object') {
                    throw { success: false, error: payload.error.message, code: payload.error.code, traceId: payload.error.traceId };
                }
                throw payload;
            }

            if (
                error.code === 'ECONNREFUSED' ||
                error.code === 'ERR_NETWORK' ||
                error.message === 'Network Error' ||
                (!error.response && error.request)
            ) {
                throw {
                    success: false,
                    error: getApiNetworkErrorMessage()
                };
            }

            if (error.code === 'ECONNABORTED') {
                throw {
                    success: false,
                    error: 'Request timeout. Please try again.'
                };
            }

            throw {
                success: false,
                error: error.message || 'Network error occurred'
            };
        }
    }

    // Auth endpoints
    async getNonce(walletAddress: string): Promise<ApiResponse<NonceResponse>> {
        return this.request<NonceResponse>('GET', `/auth/nonce?walletAddress=${walletAddress}`);
    }

    async signIn(data: SignInRequest): Promise<ApiResponse<AuthResponse>> {
        return this.request<AuthResponse>('POST', '/auth/signin', data);
    }

    async getCurrentUser(): Promise<ApiResponse<AuthResponse['user']>> {
        return this.request<AuthResponse['user']>('GET', '/auth/me');
    }

    // Alert endpoints
    async getAlerts(): Promise<ApiResponse<TokenAlert[]>> {
        return this.request<TokenAlert[]>('GET', '/alerts');
    }

    async createAlert(data: CreateAlertRequest): Promise<ApiResponse<TokenAlert>> {
        return this.request<TokenAlert>('POST', '/alerts', data);
    }

    async updateAlert(id: string, data: UpdateAlertRequest): Promise<ApiResponse<TokenAlert>> {
        return this.request<TokenAlert>('PUT', `/alerts/${id}`, data);
    }

    async deleteAlert(id: string): Promise<ApiResponse> {
        return this.request('DELETE', `/alerts/${id}`);
    }

    // Token endpoints
    async validateToken(tokenAddress: string): Promise<ApiResponse<{ isValid: boolean }>> {
        return this.request('GET', `/tokens/validate?address=${tokenAddress}`);
    }

    async getTokenData(tokenAddress: string): Promise<ApiResponse<{
        address: string;
        name: string;
        symbol: string;
        price: number;
        market_cap?: number;
        last_updated?: string;
    }>> {
        return this.request('GET', `/tokens/${tokenAddress}`);
    }

    async getTokenMarketData(tokenAddress: string): Promise<ApiResponse<{
        address: string;
        price: number;
        liquidity: number;
        total_supply: number;
        circulating_supply: number;
        fdv: number;
        market_cap: number;
    }>> {
        return this.request('GET', `/tokens/${tokenAddress}/market-data`);
    }

    async searchTokens(query: string): Promise<ApiResponse<TokenData[]>> {
        const response = await this.request<{
            address: string;
            name: string;
            symbol: string;
            price: number;
            market_cap?: number;
            last_updated?: string;
        }[]>('GET', `/tokens/search?query=${encodeURIComponent(query)}`);

        if (response.success && response.data) {
            const mappedData: TokenData[] = response.data.map(token => ({
                address: token.address,
                name: token.name,
                symbol: token.symbol,
                price: token.price,
                market_cap: token.market_cap,
                last_updated: token.last_updated,
                logo: undefined
            }));

            return {
                ...response,
                data: mappedData
            };
        }

        return response as ApiResponse<TokenData[]>;
    }

    async getDiscovery(limit = 16): Promise<ApiResponse<DiscoveryToken[]>> {
        return this.request<DiscoveryToken[]>('GET', `/tokens/discovery?limit=${limit}`);
    }

    async getTokenPairs(tokenAddress: string): Promise<ApiResponse<TokenPairsResponse>> {
        return this.request('GET', `/tokens/${tokenAddress}/pairs`);
    }

    async getTokenMetadata(tokenAddress: string): Promise<ApiResponse<TokenMetadata>> {
        return this.request('GET', `/tokens/${tokenAddress}/metadata`);
    }

    async getTokenHolders(tokenAddress: string, limit = 20): Promise<ApiResponse<TokenHolders>> {
        return this.request('GET', `/tokens/${encodeURIComponent(tokenAddress)}/holders?limit=${Math.min(20, Math.max(1, limit))}`);
    }

    // Profile endpoints
    async updateProfile(data: {
        telegramChatId?: string;
    }): Promise<ApiResponse> {
        return this.request('PUT', '/profile', data);
    }

    async getNotificationPreferences(): Promise<ApiResponse<NotificationPreferencesResponse>> {
        return this.request<NotificationPreferencesResponse>('GET', '/notification-preferences');
    }

    async getNotificationDeliveries(cursor?: string, limit = 50): Promise<ApiResponse<{
        items: NotificationDelivery[];
        nextCursor?: string;
    }>> {
        const params = new URLSearchParams();
        params.set('limit', String(limit));
        if (cursor) params.set('cursor', cursor);
        return this.request('GET', `/notification-deliveries?${params.toString()}`);
    }

    // Discord linking
    async getDiscordLinkingStatus(): Promise<ApiResponse<{ isLinked: boolean; discordUserId?: string }>> {
        return this.request('GET', '/auth/discord-status');
    }

    async getDiscordTokenInfo(token: string): Promise<ApiResponse<{
        discordUsername: string;
        discordUserId: string;
        isExpired: boolean;
        isUsed: boolean;
    }>> {
        return this.request('GET', `/auth/discord/token-info/${token}`);
    }

    async linkDiscordWithToken(linkingToken: string): Promise<ApiResponse<{
        discordUsername: string;
    }>> {
        return this.request('POST', '/auth/discord/link-with-token', { linkingToken });
    }

    async createTelegramLink(): Promise<ApiResponse<{ token: string }>> {
        return this.request('POST', '/auth/telegram/link-token');
    }

    getTokenStreamUrl(tokenAddress: string): string {
        return `${apiBase}/stream/tokens/${encodeURIComponent(tokenAddress)}`;
    }

    async getCandles(tokenMint: string, interval = '1m', limit = 500): Promise<ApiResponse<TokenCandle[]>> {
        return this.request<TokenCandle[]>('GET', `/tokens/${encodeURIComponent(tokenMint)}/candles?interval=${encodeURIComponent(interval)}&limit=${limit}`);
    }

    async getReplaySnapshot(): Promise<ApiResponse<{ state: ReplayState }>> {
        return this.request('GET', '/replay/v1/snapshot');
    }

    async controlReplay(command: ReplayControl): Promise<ApiResponse<ReplayControlResult>> {
        return this.request('POST', '/replay/v1/controls', command);
    }

    async getExecutionCapabilities(): Promise<ApiResponse<ExecutionCapabilities>> {
        return this.request<ExecutionCapabilities>('GET', '/execution/capabilities');
    }

    async createSwapQuote(input: {
        inputMint: string;
        outputMint: string;
        inputAmount: string;
        taker: string;
        slippageBps?: number;
        priorityFeeLamports?: number;
        jitoTipLamports?: number;
        broadcastFeeType?: 'maxCap' | 'exactFee';
    }): Promise<ApiResponse<SwapQuote>> {
        return this.request<SwapQuote>('POST', '/execution/quotes', input);
    }

    async submitSwap(quoteId: string, signedTransaction: string, idempotencyKey: string): Promise<ApiResponse<TradeExecution>> {
        return this.request<TradeExecution>('POST', `/execution/quotes/${encodeURIComponent(quoteId)}/submit`, {
            signedTransaction,
            idempotencyKey,
        });
    }

    async getOrderCapabilities(): Promise<ApiResponse<OrderCapabilities>> {
        return this.request<OrderCapabilities>('GET', '/orders/capabilities');
    }

    async getOrderChallenge(
        walletAddress: string,
        type: OrderChallenge['type']
    ): Promise<ApiResponse<OrderChallenge>> {
        return this.request('POST', '/orders/provider/challenge', { walletAddress, type });
    }

    async verifyOrderProvider(walletAddress: string, auth: OrderAuth): Promise<ApiResponse<{ token: string }>> {
        return this.request('POST', '/orders/provider/verify', { walletAddress, ...auth });
    }

    async prepareOrder(input: OrderInput, providerToken?: string): Promise<ApiResponse<PreparedOrder>> {
        return this.request('POST', '/orders/prepare', input, providerToken);
    }

    async activateOrder(orderId: string, signedTransaction: string, providerToken?: string): Promise<ApiResponse<OrderRecord>> {
        return this.request('POST', `/orders/${encodeURIComponent(orderId)}/activate`, { signedTransaction }, providerToken);
    }

    async updateOrder(orderId: string, input: OrderUpdateInput, providerToken?: string): Promise<ApiResponse<OrderRecord>> {
        return this.request('PATCH', `/orders/${encodeURIComponent(orderId)}`, input, providerToken);
    }

    async listOrders(): Promise<ApiResponse<OrderRecord[]>> {
        return this.request('GET', '/orders');
    }

    async syncOrders(providerToken?: string): Promise<ApiResponse<OrderRecord[]>> {
        return this.request('POST', '/orders/sync', undefined, providerToken);
    }

    async prepareCancelOrder(orderId: string, providerToken?: string): Promise<ApiResponse<{ requestId: string; transaction: string }>> {
        return this.request('POST', `/orders/${encodeURIComponent(orderId)}/cancel`, undefined, providerToken);
    }

    async confirmCancelOrder(
        orderId: string,
        cancelRequestId: string,
        signedTransaction: string,
        providerToken?: string
    ): Promise<ApiResponse<OrderRecord>> {
        return this.request('POST', `/orders/${encodeURIComponent(orderId)}/confirm-cancel`, {
            cancelRequestId,
            signedTransaction,
        }, providerToken);
    }

    async listTrackedWallets(): Promise<ApiResponse<TrackedWallet[]>> {
        return this.request('GET', '/wallets');
    }

    async trackWallet(input: { walletAddress: string; label?: string; notify?: boolean }): Promise<ApiResponse<TrackedWallet>> {
        return this.request('POST', '/wallets', input);
    }

    async updateTrackedWallet(id: string, input: { label?: string | null; notify?: boolean; status?: 'active' | 'paused' }): Promise<ApiResponse<TrackedWallet>> {
        return this.request('PATCH', `/wallets/${encodeURIComponent(id)}`, input);
    }

    async deleteTrackedWallet(id: string): Promise<ApiResponse<void>> {
        return this.request('DELETE', `/wallets/${encodeURIComponent(id)}`);
    }

    async getWalletPositions(id: string): Promise<ApiResponse<WalletPosition[]>> {
        return this.request('GET', `/wallets/${encodeURIComponent(id)}/positions`);
    }

    async getWalletActivity(id: string, limit = 100): Promise<ApiResponse<WalletActivityPage>> {
        return this.request('GET', `/wallets/${encodeURIComponent(id)}/activity?limit=${Math.min(Math.max(limit, 1), 500)}`);
    }

    async getWalletPortfolio(id: string): Promise<ApiResponse<WalletPortfolio>> {
        return this.request('GET', `/wallets/${encodeURIComponent(id)}/portfolio`);
    }

}

export const apiService = new ApiService();
export type {
    TokenAlert,
    CreateAlertRequest,
    UpdateAlertRequest,
    ApiResponse,
    TokenPair,
    TokenPairData,
    TokenPairsResponse
}; 
