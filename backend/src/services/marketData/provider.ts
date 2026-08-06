import { ProviderCheckpoint, ProviderRawEvent } from '../../types';

export type ProviderEventHandler = (event: ProviderRawEvent) => void | Promise<void>;
export type ProviderErrorHandler = (error: Error, context?: Record<string, unknown>) => void | Promise<void>;

export interface MarketDataProviderRuntime {
    onEvent: ProviderEventHandler;
    onError?: ProviderErrorHandler;
}

export interface MarketDataProvider {
    readonly name: ProviderRawEvent['provider'];
    readonly configured: boolean;
    connect(runtime: MarketDataProviderRuntime): Promise<void>;
    subscribeTokens(tokenMints: string[]): Promise<void>;
    subscribePrograms(programIds: string[]): Promise<void>;
    resumeFromCheckpoint(checkpoint: ProviderCheckpoint | null): Promise<void>;
    disconnect(): Promise<void>;
}

export const providerEventId = (provider: ProviderRawEvent['provider'], parts: Array<string | number | undefined | null>): string =>
    `${provider}:${parts.filter((part) => part !== undefined && part !== null && String(part).length > 0).join(':')}`;
