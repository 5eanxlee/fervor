import { Router } from 'express';

const solMint = 'So11111111111111111111111111111111111111112';
const jupUrl = `https://api.jup.ag/price/v3?ids=${solMint}`;
const cbUrl = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';
const router = Router();

const validPrice = (value: unknown): number | undefined => {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : undefined;
};

const getJson = async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    return response.json();
};

router.get('/sol', async (_req, res) => {
    try {
        const jupiter = await getJson(jupUrl) as Record<string, { usdPrice?: number }> | undefined;
        let price = validPrice(jupiter?.[solMint]?.usdPrice);
        let source = 'jupiter';
        if (price === undefined) {
            const coinbase = await getJson(cbUrl) as { data?: { amount?: string } } | undefined;
            price = validPrice(coinbase?.data?.amount);
            source = 'coinbase';
        }
        if (price === undefined) throw new Error('No SOL price source returned a valid value');
        res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
        res.json({ price, source, updatedAt: new Date().toISOString() });
    } catch {
        res.status(503).json({ error: 'SOL price is temporarily unavailable' });
    }
});

export default router;
