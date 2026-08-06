import { env } from '../../config/env';
import { safeSlot } from '../../types';
import {
    WalletHistoryPage,
    WalletHistoryProvider,
    WalletHistoryRequest,
    WalletProviderError,
} from './provider';

interface RpcBody {
    result?: { data?: unknown; paginationToken?: unknown };
    error?: { code?: unknown; message?: unknown };
}

const signatureOf = (value: any): string | undefined => {
    const signature = value?.transaction?.signatures?.[0] ?? value?.signature;
    return typeof signature === 'string' ? signature : undefined;
};

const retryAfter = (response: Response): number | undefined => {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

export class HeliusWalletProvider implements WalletHistoryProvider {
    readonly name = 'helius_history_v2' as const;

    async history(walletAddress: string, request: WalletHistoryRequest = {}): Promise<WalletHistoryPage> {
        if (!env.HELIUS_API_KEY) {
            throw new WalletProviderError('provider_not_configured', 'Wallet provider is not configured', false, 503);
        }
        const url = new URL(env.HELIUS_API_URL);
        url.searchParams.set('api-key', env.HELIUS_API_KEY);
        const filters: Record<string, unknown> = {
            status: 'succeeded',
            tokenAccounts: 'balanceChanged',
        };
        if (request.afterSlot !== undefined) filters.slot = { gt: request.afterSlot };
        const config: Record<string, unknown> = {
            transactionDetails: 'full',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'finalized',
            sortOrder: 'desc',
            limit: env.WALLET_BACKFILL_LIMIT,
            filters,
        };
        if (request.cursor) config.paginationToken = request.cursor;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), env.WALLET_TIMEOUT_MS);
        timeout.unref?.();
        try {
            const response = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: `wallet-${Date.now()}`,
                    method: 'getTransactionsForAddress',
                    params: [walletAddress, config],
                }),
            });
            const body = await response.json().catch(() => null) as RpcBody | null;
            const data = body?.result?.data;
            if (!response.ok || !Array.isArray(data)) {
                const limited = response.status === 429 || body?.error?.code === -32429;
                const rpcCode = Number(body?.error?.code);
                const rpcServerError = Number.isInteger(rpcCode) && rpcCode <= -32000 && rpcCode >= -32099;
                throw new WalletProviderError(
                    limited ? 'provider_rate_limited' : 'provider_request_failed',
                    `Wallet provider returned ${String(body?.error?.message || response.status || 'an invalid response')}`,
                    limited || response.status >= 500 || rpcServerError,
                    limited ? 429 : response.ok ? 502 : response.status,
                    retryAfter(response)
                );
            }
            const newest = data[0];
            return {
                transactions: data,
                nextCursor: typeof body?.result?.paginationToken === 'string'
                    ? body.result.paginationToken
                    : undefined,
                newestSignature: signatureOf(newest),
                newestSlot: safeSlot(newest?.slot),
            };
        } catch (error) {
            if (error instanceof WalletProviderError) throw error;
            if (error instanceof Error && error.name === 'AbortError') {
                throw new WalletProviderError('provider_timeout', 'Wallet provider timed out', true, 504);
            }
            throw new WalletProviderError('provider_unavailable', 'Wallet provider is unavailable', true, 502);
        } finally {
            clearTimeout(timeout);
        }
    }
}
