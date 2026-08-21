import { NextResponse } from 'next/server';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_URL = `https://api.jup.ag/price/v3?ids=${SOL_MINT}`;
const CB_URL = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';

const validPrice = (value: unknown): number | undefined => {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : undefined;
};

async function fromJupiter(): Promise<number | undefined> {
    const response = await fetch(JUP_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
        next: { revalidate: 30 },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as Record<string, { usdPrice?: number }>;
    return validPrice(payload[SOL_MINT]?.usdPrice);
}

async function fromCoinbase(): Promise<number | undefined> {
    const response = await fetch(CB_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
        next: { revalidate: 30 },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: { amount?: string } };
    return validPrice(payload.data?.amount);
}

export async function GET() {
    try {
        const jupiter = await fromJupiter();
        const price = jupiter ?? await fromCoinbase();
        if (price === undefined) throw new Error('No SOL price source returned a valid value');

        return NextResponse.json(
            { price, source: jupiter === undefined ? 'coinbase' : 'jupiter', updatedAt: new Date().toISOString() },
            { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } }
        );
    } catch {
        return NextResponse.json({ error: 'SOL price is temporarily unavailable' }, { status: 503 });
    }
}
