import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import TradingTerminal from '../../components/trading/TradingTerminal';

const replayMint = process.env.NEXT_PUBLIC_REPLAY_MINT?.trim();

export default function ReplayPage() {
    if (process.env.NEXT_PUBLIC_DATA_MODE !== 'replay' || !replayMint) notFound();
    return (
        <Suspense fallback={<main className="grid h-screen place-items-center bg-[#0f0f12]"><div className="spinner" /></main>}>
            <TradingTerminal tokenMint={replayMint} />
        </Suspense>
    );
}
