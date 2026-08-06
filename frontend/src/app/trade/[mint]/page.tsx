import TradingTerminal from '../../../components/trading/TradingTerminal';

export default async function TradePage({ params }: { params: Promise<{ mint: string }> }) {
    const { mint } = await params;
    return <TradingTerminal tokenMint={mint} />;
}
