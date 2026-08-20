'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { FervorMark } from '../components/trading/BrandMarks';
import { useAuth } from '../contexts/AuthContext';

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
        <main data-terminal-theme="terminal" className="flex min-h-screen flex-col bg-[var(--term-bg)] text-[var(--term-text)]">
            <header className="terminal-topbar flex items-center border-b border-[var(--term-border)] px-[clamp(.75rem,1.2vw,1rem)]">
                <Link href="/" className="flex items-center gap-1.5 text-white" aria-label="FERVOR home">
                    <FervorMark className="h-[clamp(1.3rem,1.65vw,1.5rem)] w-[clamp(1.3rem,1.65vw,1.5rem)]" />
                    <span className="text-[clamp(1rem,1.3vw,1.2rem)] font-[680] tracking-[-.025em]">FERVOR</span>
                </Link>
                <button onClick={enter} disabled={opening || isLoading} className="ml-auto h-9 rounded-lg border border-[var(--term-border-strong)] bg-[var(--term-raised)] px-4 text-xs font-[500] text-white transition-colors hover:bg-[var(--term-control)] disabled:opacity-50">
                    {opening || isLoading ? 'Opening…' : 'Open terminal'}
                </button>
            </header>

            <section className="flex flex-1 items-center px-[clamp(1rem,4vw,3rem)] py-12">
                <div className="mx-auto w-full max-w-[34rem] border-x border-[var(--term-border)] px-[clamp(1rem,3vw,2rem)]">
                    <div className="flex flex-col items-center border-y border-[var(--term-border)] bg-[var(--term-panel)] px-[clamp(1.5rem,5vw,3rem)] py-[clamp(2.75rem,7vw,4.5rem)] text-center">
                        <span className="grid h-12 w-12 place-items-center rounded-xl border border-[var(--term-border-strong)] bg-[var(--term-raised)]">
                            <FervorMark className="h-6 w-6" />
                        </span>
                        <h1 className="mt-6 text-[clamp(1.8rem,4vw,2.4rem)] font-[600] tracking-[-.045em] text-white">FERVOR</h1>
                        <p className="mt-2 text-sm text-[var(--term-muted)]">A focused Solana trading terminal.</p>
                        <button onClick={enter} disabled={opening || isLoading} className="mt-8 inline-flex h-11 w-full max-w-64 items-center justify-center gap-2 rounded-lg bg-[var(--term-accent)] px-5 text-sm font-[650] text-[#111114] transition-colors hover:bg-[var(--term-accent-strong)] disabled:opacity-50">
                            {opening || isLoading ? 'Connecting…' : 'Continue to terminal'}
                            <ArrowRightIcon className="h-4 w-4" />
                        </button>
                        <p className="mt-4 text-[10px] text-[var(--term-dim)]">Self-custodial · Wallet signed</p>
                    </div>
                </div>
            </section>

            <footer className="terminal-tape flex items-center border-t border-[var(--term-border)] px-[clamp(.75rem,1.2vw,1rem)] text-[10px] text-[var(--term-dim)]">
                <span>FERVOR</span>
                <span className="ml-auto">Solana</span>
            </footer>
        </main>
    );
}
