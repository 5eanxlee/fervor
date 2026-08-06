import { PublicKey } from '@solana/web3.js';
import { NextResponse } from 'next/server';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_URL = process.env.SOLANA_RPC_URL
    || process.env.NEXT_PUBLIC_SOLANA_RPC_URL
    || 'https://api.mainnet-beta.solana.com';

type RpcResult = {
    id: number;
    result?: {
        value?: number | Array<{
            account?: {
                data?: {
                    parsed?: {
                        info?: {
                            tokenAmount?: { uiAmountString?: string; uiAmount?: number };
                        };
                    };
                };
            };
        }>;
    };
    error?: { message?: string };
};

export async function GET(_request: Request, { params }: { params: Promise<{ address: string }> }) {
    const { address } = await params;
    try {
        const owner = new PublicKey(address).toBase58();
        const response = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify([
                { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [owner, { commitment: 'confirmed' }] },
                { jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner', params: [owner, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
            ]),
        });
        if (!response.ok) throw new Error(`RPC returned ${response.status}`);
        const payload = await response.json() as RpcResult[];
        const solResult = payload.find((item) => item.id === 1);
        const usdcResult = payload.find((item) => item.id === 2);
        if (solResult?.error || usdcResult?.error) throw new Error(solResult?.error?.message || usdcResult?.error?.message || 'RPC error');

        const lamports = Number(solResult?.result?.value || 0);
        const accounts = Array.isArray(usdcResult?.result?.value) ? usdcResult.result.value : [];
        const usdc = accounts.reduce((sum, account) => {
            const amount = account.account?.data?.parsed?.info?.tokenAmount;
            return sum + Number(amount?.uiAmountString ?? amount?.uiAmount ?? 0);
        }, 0);

        return NextResponse.json(
            { address: owner, sol: lamports / 1_000_000_000, usdc, updatedAt: new Date().toISOString() },
            { headers: { 'Cache-Control': 'private, no-store' } }
        );
    } catch {
        return NextResponse.json({ error: 'Wallet balances are unavailable' }, { status: 400 });
    }
}
