import { env } from '../../../config/env';
import { ProviderRawEvent } from '../../../types';
import { MarketDataProvider, MarketDataProviderRuntime, providerEventId } from '../provider';

const nowIso = () => new Date().toISOString();

const DEFAULT_FIXTURE_TOKEN = 'So11111111111111111111111111111111111111112';

export class FixtureProvider implements MarketDataProvider {
    readonly name = 'fixture' as const;
    readonly configured = true;
    private runtime: MarketDataProviderRuntime | null = null;
    private timer: NodeJS.Timeout | null = null;
    private sequence = 0;
    private tokenMints: string[] = [DEFAULT_FIXTURE_TOKEN];

    async connect(runtime: MarketDataProviderRuntime): Promise<void> {
        this.runtime = runtime;
    }

    async subscribeTokens(tokenMints: string[]): Promise<void> {
        this.tokenMints = tokenMints.length > 0 ? tokenMints : [DEFAULT_FIXTURE_TOKEN];
        if (!this.timer) {
            this.timer = setInterval(() => {
                void this.emitNext();
            }, env.MARKET_DATA_FIXTURE_INTERVAL_MS);
            this.timer.unref?.();
        }
        await this.emitNext();
    }

    async subscribePrograms(_programIds: string[]): Promise<void> {
        return;
    }

    async resumeFromCheckpoint(): Promise<void> {
        return;
    }

    async disconnect(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.runtime = null;
    }

    private async emitNext(): Promise<void> {
        if (!this.runtime) return;
        const tokenMint = this.tokenMints[this.sequence % this.tokenMints.length];
        const observedAt = nowIso();
        const slot = 1_000_000 + this.sequence;
        const priceUsd = 100 + (this.sequence % 25);
        const signature = `fixture-signature-${this.sequence}`;
        const payload = {
            tokenMint,
            signature,
            slot,
            protocol: 'fixture_cpmm',
            poolAddress: `fixture-pool-${tokenMint.slice(0, 8)}`,
            maker: `fixture-maker-${this.sequence % 10}`,
            side: this.sequence % 2 === 0 ? 'buy' : 'sell',
            tokenAmount: 10 + this.sequence,
            solAmount: 1.5,
            usdAmount: priceUsd * (10 + this.sequence),
            priceUsd,
            priceSol: 0.5,
            totalSupply: 1_000_000,
            circulatingSupply: 800_000,
            liquidityUsd: 250_000,
            instructionIndex: 0,
            eventIndex: this.sequence,
        };
        const event: ProviderRawEvent = {
            provider: this.name,
            source: this.name,
            sourceEventId: providerEventId(this.name, [signature, 0, this.sequence]),
            type: 'fixture_trade',
            tokenMint,
            poolAddress: payload.poolAddress,
            slot,
            signature,
            receivedAt: observedAt,
            observedAt,
            confidence: 0.95,
            stale: false,
            payload,
        };
        this.sequence += 1;
        await this.runtime.onEvent(event);
    }
}
