import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { ProviderQuote, QuoteRequest, SubmitResult } from '../../src/types';
import type { SwapProvider } from '../../src/services/execution/provider';

const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));

export const testSwapWallet = bs58.encode(signer.publicKey);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const message = (taker: string): Buffer => Buffer.concat([
    Buffer.from([1, 0, 1, 2]),
    Buffer.from(bs58.decode(taker)),
    Buffer.alloc(32),
    Buffer.alloc(32, 11),
    Buffer.from([0]),
]);

const unsignedTx = (taker: string): string => Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    message(taker),
]).toString('base64');

export const signTestSwap = (transaction: string): string => {
    const wire = Buffer.from(transaction, 'base64');
    const payload = wire.subarray(65);
    const signed = Buffer.concat([
        Buffer.from([1]),
        Buffer.from(nacl.sign.detached(payload, signer.secretKey)),
        payload,
    ]);
    return signed.toString('base64');
};

export const testSwapSignature = (transaction: string): string => {
    const wire = Buffer.from(transaction, 'base64');
    return bs58.encode(wire.subarray(1, 65));
};

export class TestSwapProvider implements SwapProvider {
    readonly name = 'jupiter_swap_v2' as const;

    async quote(request: QuoteRequest): Promise<ProviderQuote> {
        const input = BigInt(request.inputAmount);
        const output = input * 99n / 100n;
        const slippageBps = request.slippageBps ?? 100;

        return {
            provider: this.name,
            providerQuoteId: `test_${hash(JSON.stringify(request)).slice(0, 24)}`,
            inputAmount: request.inputAmount,
            outputAmount: output.toString(),
            minOutputAmount: (output * BigInt(10_000 - slippageBps) / 10_000n).toString(),
            taker: request.taker,
            feePayer: request.taker,
            slippageBps,
            priceImpactPct: '0.01',
            transaction: unsignedTx(request.taker),
            route: [{ venue: 'test_pool', percent: 100 }],
            fees: {
                networkLamports: '5000',
                priorityLamports: String(request.priorityFeeLamports ?? 0),
                platformAmount: '0',
            },
        };
    }

    async submit(input: { signedTransaction: string }): Promise<SubmitResult> {
        return {
            provider: this.name,
            state: 'confirmed',
            signature: testSwapSignature(input.signedTransaction),
            rawStatus: 'test_confirmed',
        };
    }
}
