import { notFound } from 'next/navigation';
import TradingTerminal from '../../components/trading/TradingTerminal';

const replayMint = process.env.NEXT_PUBLIC_REPLAY_MINT?.trim();

export default function ReplayPage() {
    if (process.env.NEXT_PUBLIC_DATA_MODE !== 'replay' || !replayMint) notFound();
    return <TradingTerminal tokenMint={replayMint} replayView />;
}
