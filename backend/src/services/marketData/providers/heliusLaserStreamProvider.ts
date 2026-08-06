import bs58 from 'bs58';
import {
    CommitmentLevel,
    LaserstreamConfig,
    StreamHandle,
    subscribe,
} from 'helius-laserstream';
import { env } from '../../../config/env';
import { ProviderCheckpoint, ProviderRawEvent } from '../../../types';
import { metrics } from '../../metrics';
import { MarketDataProvider, MarketDataProviderRuntime, providerEventId } from '../provider';

const commitmentMap = {
    processed: CommitmentLevel.PROCESSED,
    confirmed: CommitmentLevel.CONFIRMED,
    finalized: CommitmentLevel.FINALIZED,
} as const;

const encodeSignature = (value: unknown): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return bs58.encode(Buffer.from(value));
    if (Array.isArray(value)) return bs58.encode(Buffer.from(value as number[]));
    return undefined;
};

const sanitizeForJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, inner) => {
    if (typeof inner === 'bigint') return inner.toString();
    if (inner instanceof Uint8Array || Buffer.isBuffer(inner)) return bs58.encode(Buffer.from(inner));
    return inner;
}));

export class HeliusLaserStreamProvider implements MarketDataProvider {
    readonly name = 'helius_laserstream' as const;
    readonly configured = !!env.HELIUS_API_KEY;
    private runtime: MarketDataProviderRuntime | null = null;
    private stream: StreamHandle | null = null;
    private tokenMints: string[] = [];
    private programIds: string[] = [];
    private checkpoint: ProviderCheckpoint | null = null;

    async connect(runtime: MarketDataProviderRuntime): Promise<void> {
        if (!this.configured) {
            throw new Error('HELIUS_API_KEY is required for helius_laserstream provider');
        }
        this.runtime = runtime;
        metrics.gauge('fervor_market_provider_connected', 0, { provider: this.name });
    }

    async subscribeTokens(tokenMints: string[]): Promise<void> {
        this.tokenMints = Array.from(new Set(tokenMints));
        await this.startOrUpdateStream();
    }

    async subscribePrograms(programIds: string[]): Promise<void> {
        this.programIds = Array.from(new Set(programIds));
        await this.startOrUpdateStream();
    }

    async resumeFromCheckpoint(checkpoint: ProviderCheckpoint | null): Promise<void> {
        this.checkpoint = checkpoint;
        await this.startOrUpdateStream();
    }

    async disconnect(): Promise<void> {
        this.stream?.cancel();
        this.stream = null;
        metrics.gauge('fervor_market_provider_connected', 0, { provider: this.name });
    }

    private buildRequest(): any {
        const transactions: Record<string, unknown> = {};

        if (this.programIds.length > 0) {
            transactions.programs = {
                accountInclude: this.programIds,
                accountExclude: [],
                accountRequired: [],
                vote: false,
                failed: false,
            };
        }

        if (this.tokenMints.length > 0) {
            transactions.tokens = {
                accountInclude: this.tokenMints,
                accountExclude: [],
                accountRequired: [],
                vote: false,
                failed: false,
            };
        }

        return {
            transactions,
            slots: {
                feed: {
                    filterByCommitment: true,
                },
            },
            commitment: commitmentMap[env.MARKET_DATA_COMMITMENT],
            fromSlot: this.checkpoint?.lastProcessedSlot
                ? String(Math.max(0, this.checkpoint.lastProcessedSlot - 1))
                : undefined,
        };
    }

    private async startOrUpdateStream(): Promise<void> {
        if (!this.runtime || (!this.programIds.length && !this.tokenMints.length)) return;

        const request = this.buildRequest();
        if (this.stream) {
            await this.stream.write(request);
            metrics.increment('fervor_market_provider_subscription_updates', { provider: this.name });
            return;
        }

        const config: LaserstreamConfig = {
            apiKey: env.HELIUS_API_KEY || '',
            endpoint: env.HELIUS_LASERSTREAM_ENDPOINT,
            replay: env.LASERSTREAM_REPLAY_ENABLED,
        };

        this.stream = await subscribe(
            config,
            request,
            async (update: any) => this.handleUpdate(update),
            async (error: Error) => {
                metrics.increment('fervor_market_provider_errors', { provider: this.name });
                await this.runtime?.onError?.(error, { provider: this.name });
            }
        );
        metrics.gauge('fervor_market_provider_connected', 1, { provider: this.name });
    }

    private async handleUpdate(update: any): Promise<void> {
        if (!this.runtime) return;
        const transaction = update.transaction;
        const account = update.account;
        const slotUpdate = update.slot;
        const slot = Number(transaction?.slot ?? account?.slot ?? slotUpdate?.slot ?? update.slot ?? 0);
        const signature = encodeSignature(transaction?.transaction?.signature);
        const type = transaction ? 'transaction' : account ? 'account' : 'unknown';
        const observedAt = new Date().toISOString();

        const event: ProviderRawEvent = {
            provider: this.name,
            source: this.name,
            sourceEventId: providerEventId(this.name, [signature, slot, type]),
            type,
            subscriptionId: this.stream?.id,
            signature,
            slot,
            receivedAt: observedAt,
            observedAt,
            confidence: 0.9,
            stale: false,
            payload: sanitizeForJson(update),
        };
        metrics.increment('fervor_market_provider_events', { provider: this.name, type });
        await this.runtime.onEvent(event);
    }
}
