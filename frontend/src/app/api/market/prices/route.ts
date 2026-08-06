import { NextResponse } from 'next/server';

type Asset = 'sol' | 'bnb' | 'eth' | 'btc';

const coinbase = {
    sol: 'SOL-USD',
    eth: 'ETH-USD',
    btc: 'BTC-USD',
} as const;

const validPrice = (value: unknown): number | undefined => {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : undefined;
};

async function coinbasePrice(product: string): Promise<number | undefined> {
    const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
        headers: { accept: 'application/json' },
        next: { revalidate: 20 },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { price?: string };
    return validPrice(payload.price);
}

async function bnbPrice(): Promise<number | undefined> {
    const response = await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT', {
        headers: { accept: 'application/json' },
        next: { revalidate: 20 },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { price?: string };
    return validPrice(payload.price);
}

export async function GET() {
    try {
        const [sol, bnb, eth, btc] = await Promise.all([
            coinbasePrice(coinbase.sol),
            bnbPrice(),
            coinbasePrice(coinbase.eth),
            coinbasePrice(coinbase.btc),
        ]);
        const prices: Partial<Record<Asset, number>> = { sol, bnb, eth, btc };
        const missing = (Object.keys(prices) as Asset[]).filter((asset) => prices[asset] === undefined);
        if (missing.length === Object.keys(prices).length) {
            throw new Error('No market source returned a valid price');
        }

        return NextResponse.json(
            { prices, missing, updatedAt: new Date().toISOString(), sources: { sol: 'coinbase', bnb: 'binance', eth: 'coinbase', btc: 'coinbase' } },
            { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=120' } }
        );
    } catch {
        return NextResponse.json({ error: 'Market prices are temporarily unavailable' }, { status: 503 });
    }
}
