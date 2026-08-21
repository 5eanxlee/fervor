import { NextResponse } from 'next/server';

type Asset = 'sol' | 'bnb' | 'eth' | 'btc';

const coinbase = {
    sol: 'SOL-USD',
    eth: 'ETH-USD',
    btc: 'BTC-USD',
} as const;

const gecko = {
    sol: 'solana',
    bnb: 'binancecoin',
    eth: 'ethereum',
    btc: 'bitcoin',
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

async function fallbackPrices(): Promise<Partial<Record<Asset, number>>> {
    const ids = Object.values(gecko).join(',');
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
        headers: { accept: 'application/json' },
        next: { revalidate: 30 },
    });
    if (!response.ok) return {};
    const payload = await response.json() as Record<string, { usd?: number }>;
    return Object.fromEntries((Object.keys(gecko) as Asset[]).flatMap((asset) => {
        const price = validPrice(payload[gecko[asset]]?.usd);
        return price === undefined ? [] : [[asset, price]];
    }));
}

const safe = async (load: () => Promise<number | undefined>): Promise<number | undefined> => {
    try {
        return await load();
    } catch {
        return undefined;
    }
};

export async function GET() {
    try {
        const [sol, bnb, eth, btc] = await Promise.all([
            safe(() => coinbasePrice(coinbase.sol)),
            safe(bnbPrice),
            safe(() => coinbasePrice(coinbase.eth)),
            safe(() => coinbasePrice(coinbase.btc)),
        ]);
        const prices: Partial<Record<Asset, number>> = { sol, bnb, eth, btc };
        let missing = (Object.keys(prices) as Asset[]).filter((asset) => prices[asset] === undefined);
        if (missing.length) {
            const fallback: Partial<Record<Asset, number>> = await fallbackPrices()
                .catch(() => ({}));
            for (const asset of missing) prices[asset] = fallback[asset];
            missing = missing.filter((asset) => prices[asset] === undefined);
        }
        if (missing.length === Object.keys(prices).length) {
            throw new Error('No market source returned a valid price');
        }

        return NextResponse.json(
            { prices, missing, updatedAt: new Date().toISOString(), sources: { primary: 'coinbase/binance', fallback: 'coingecko' } },
            { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=120' } }
        );
    } catch {
        return NextResponse.json({ error: 'Market prices are temporarily unavailable' }, { status: 503 });
    }
}
