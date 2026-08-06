import crypto from 'crypto';
import { ProviderQuote, QuoteRequest, SubmitResult } from '../../types';
import { SwapProvider } from './provider';

const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export class FixtureSwapProvider implements SwapProvider {
    readonly name = 'fixture' as const;

    async quote(request: QuoteRequest): Promise<ProviderQuote> {
        const input = BigInt(request.inputAmount);
        const output = input * 99n / 100n;
        const slippageBps = request.slippageBps ?? 100;
        const minOutput = output * BigInt(10_000 - slippageBps) / 10_000n;
        const providerQuoteId = `fixture_${digest(JSON.stringify(request)).slice(0, 24)}`;
        const transaction = Buffer.from(JSON.stringify({
            version: 1,
            providerQuoteId,
            inputMint: request.inputMint,
            outputMint: request.outputMint,
            inputAmount: request.inputAmount,
            taker: request.taker,
        })).toString('base64');

        return {
            provider: this.name,
            providerQuoteId,
            inputAmount: request.inputAmount,
            outputAmount: output.toString(),
            minOutputAmount: minOutput.toString(),
            taker: request.taker,
            feePayer: request.taker,
            slippageBps,
            priceImpactPct: '0.01',
            transaction,
            route: [{ venue: 'fixture_pool', percent: 100 }],
            fees: {
                networkLamports: '5000',
                priorityLamports: String(request.priorityFeeLamports ?? 0),
                platformAmount: '0',
            },
        };
    }

    async submit(input: { providerQuoteId: string; signedTransaction: string }): Promise<SubmitResult> {
        return {
            provider: this.name,
            state: 'confirmed',
            signature: `fixture_${digest(`${input.providerQuoteId}:${input.signedTransaction}`).slice(0, 48)}`,
            rawStatus: 'fixture_confirmed',
        };
    }
}
