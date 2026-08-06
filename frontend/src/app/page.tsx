'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    ArrowRightIcon,
    BoltIcon,
    ChartBarSquareIcon,
    ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { FervorMark } from '../components/trading/BrandMarks';
import { useAuth } from '../contexts/AuthContext';

const cards = [
    { icon: BoltIcon, title: 'Fast execution', text: 'Move from discovery to an order without leaving the terminal.' },
    { icon: ChartBarSquareIcon, title: 'Live market context', text: 'Charts, flow, holders, and positions remain visible as you trade.' },
    { icon: ShieldCheckIcon, title: 'Self-custody', text: 'Your wallet signs. FERVOR never takes custody of your assets.' },
];

export default function Home() {
    const { isAuthenticated, isLoading, signIn } = useAuth();
    const [opening, setOpening] = useState(false);
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && isAuthenticated) router.replace('/dashboard');
    }, [isAuthenticated, isLoading, router]);

    const enter = async () => {
        if (isAuthenticated) {
            router.push('/dashboard');
            return;
        }
        setOpening(true);
        try {
            await signIn();
            router.push('/dashboard');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Unable to open FERVOR');
        } finally {
            setOpening(false);
        }
    };

    return (
        <main data-terminal-theme="terminal" className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-text)]">
            <div className="pointer-events-none absolute inset-0 opacity-35" aria-hidden="true" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px)', backgroundSize: 'clamp(2.5rem,5vw,4.5rem) clamp(2.5rem,5vw,4.5rem)' }} />
            <div className="pointer-events-none absolute left-1/2 top-[22%] h-[min(42rem,70vw)] w-[min(42rem,70vw)] -translate-x-1/2 rounded-full bg-[var(--term-accent)] opacity-[.055] blur-[130px]" aria-hidden="true" />

            <header className="relative z-10 flex h-[clamp(3.2rem,6vh,3.75rem)] items-center border-b border-[var(--term-border)] px-[clamp(1rem,3vw,2.5rem)]">
                <Link href="/" className="flex items-center gap-2 text-[var(--term-accent)]" aria-label="FERVOR home">
                    <FervorMark className="h-6 w-6" />
                    <span className="text-sm font-[650] tracking-[.06em]">FERVOR</span>
                </Link>
                <nav className="ml-auto hidden items-center gap-[clamp(1rem,2vw,2rem)] text-xs text-[var(--term-muted)] sm:flex">
                    <span>Discovery</span>
                    <span>Charts</span>
                    <span>Execution</span>
                </nav>
                <button onClick={enter} disabled={opening || isLoading} className="ml-[clamp(1rem,2.5vw,2.5rem)] h-8 rounded-lg border border-[var(--term-border-strong)] bg-[var(--term-raised)] px-4 text-xs text-white transition-colors hover:bg-[var(--term-control)] disabled:opacity-50">
                    {opening || isLoading ? 'Opening…' : 'Launch terminal'}
                </button>
            </header>

            <section className="relative z-10 mx-auto grid w-full max-w-[90rem] flex-1 items-center gap-[clamp(2rem,5vw,5rem)] px-[clamp(1rem,5vw,5rem)] py-[clamp(3rem,8vh,6rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,.95fr)]">
                <div className="max-w-3xl">
                    <p className="mb-5 flex items-center gap-2 text-[10px] font-[600] uppercase tracking-[.22em] text-[var(--term-accent)]"><span className="h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_12px_currentColor]" />Solana trading terminal</p>
                    <h1 className="text-[clamp(3.1rem,8vw,7.6rem)] font-[600] leading-[.82] tracking-[-.075em] text-white">Trade with<br /><span className="text-[var(--term-muted)]">FERVOR.</span></h1>
                    <p className="mt-[clamp(1.5rem,3vw,2.4rem)] max-w-xl text-[clamp(.92rem,1.3vw,1.08rem)] leading-relaxed text-[var(--term-muted)]">A compact workspace for finding fast markets, reading live flow, and executing from one consistent interface.</p>
                    <button onClick={enter} disabled={opening || isLoading} className="mt-[clamp(1.5rem,3vw,2.5rem)] inline-flex h-11 items-center gap-3 rounded-xl bg-[var(--term-accent)] px-6 text-sm font-[650] text-[#111114] transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:opacity-50">
                        {opening || isLoading ? 'Connecting wallet…' : 'Enter FERVOR'}<ArrowRightIcon className="h-4 w-4" />
                    </button>
                </div>

                <div className="overflow-hidden rounded-2xl border border-[var(--term-border)] bg-[color-mix(in_srgb,var(--term-panel)_94%,transparent)] shadow-2xl backdrop-blur-sm">
                    <div className="flex h-10 items-center border-b border-[var(--term-border)] px-4 text-[10px] uppercase tracking-[.16em] text-[var(--term-dim)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--term-accent)]" /><span className="ml-2">Terminal overview</span><span className="ml-auto">Live workspace</span></div>
                    <div className="divide-y divide-[var(--term-border)]">
                        {cards.map(({ icon: Icon, title, text }, index) => (
                            <article key={title} className="group flex gap-4 p-[clamp(1rem,2vw,1.5rem)] transition-colors hover:bg-[var(--term-raised)]">
                                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--term-border)] bg-[var(--term-raised)] text-[var(--term-accent)]"><Icon className="h-5 w-5" /></span>
                                <div className="min-w-0"><div className="flex items-center gap-2"><span className="text-[10px] tabular-nums text-[var(--term-dim)]">0{index + 1}</span><h2 className="text-sm font-[500] text-white">{title}</h2></div><p className="mt-1.5 text-xs leading-relaxed text-[var(--term-muted)]">{text}</p></div>
                            </article>
                        ))}
                    </div>
                    <div className="grid grid-cols-3 border-t border-[var(--term-border)] text-center text-[9px] uppercase tracking-[.12em] text-[var(--term-dim)]"><span className="border-r border-[var(--term-border)] px-2 py-3">Self-custody</span><span className="border-r border-[var(--term-border)] px-2 py-3">Low latency</span><span className="px-2 py-3">One terminal</span></div>
                </div>
            </section>

            <footer className="relative z-10 flex min-h-10 items-center border-t border-[var(--term-border)] px-[clamp(1rem,3vw,2.5rem)] text-[10px] text-[var(--term-dim)]"><span>© 2026 FERVOR</span><span className="ml-auto">Self-custody · Client-signed</span></footer>
        </main>
    );
}
