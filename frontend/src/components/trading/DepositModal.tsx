'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
    ArrowPathIcon,
    ChevronDownIcon,
    ClipboardDocumentIcon,
    XMarkIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { SolanaMark, UsdcMark } from './BrandMarks';

type ExchangeTab = 'convert' | 'deposit' | 'buy';

export default function DepositModal({
    open,
    onClose,
    address,
}: {
    open: boolean;
    onClose: () => void;
    address?: string | null;
}) {
    const [tab, setTab] = useState<ExchangeTab>('deposit');

    useEffect(() => {
        if (!open) return;
        setTab('deposit');
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [onClose, open]);

    if (!open) return null;

    const copy = async () => {
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            toast.success('Deposit address copied');
        } catch {
            toast.error('Unable to copy address');
        }
    };

    return (
        <div className="terminal-overlay fixed inset-0 z-[100] grid place-items-center p-3" onMouseDown={onClose}>
            <section role="dialog" aria-modal="true" aria-label="Exchange" className="w-full max-w-[25rem] overflow-hidden rounded-2xl border border-[var(--term-border-strong)] bg-[#18181b] shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                <header className="flex h-12 items-center border-b border-[var(--term-border)] px-4">
                    <h2 className="text-sm font-[550] text-white">Exchange</h2>
                    <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-full text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white" aria-label="Close exchange"><XMarkIcon className="h-4 w-4" /></button>
                </header>

                <div className="p-4">
                    <nav className="grid h-9 grid-cols-3 rounded-lg border border-[var(--term-border)] bg-[var(--term-bg)] p-1 text-[11px] text-[var(--term-muted)]" aria-label="Exchange action">
                        {(['convert', 'deposit', 'buy'] as ExchangeTab[]).map((value) => <button key={value} onClick={() => setTab(value)} className={`rounded-md capitalize ${tab === value ? 'bg-[var(--term-control)] text-white' : 'hover:text-white'}`}>{value}</button>)}
                    </nav>

                    {tab !== 'deposit' ? (
                        <div className="grid h-52 place-items-center text-sm text-[var(--term-muted)]"><span>{tab === 'convert' ? 'Convert' : 'Buy'} is coming soon</span></div>
                    ) : (
                        <div className="pt-4">
                            <div className="grid grid-cols-[1fr_1fr_2.25rem] gap-2">
                                <TokenSelect label="Deposit from" />
                                <TokenSelect label="Receive on" />
                                <button className="mt-[1.125rem] grid h-9 place-items-center rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] text-[var(--term-muted)] hover:text-white" aria-label="Reverse deposit route"><ArrowPathIcon className="h-4 w-4" /></button>
                            </div>

                            <p className="mt-3 text-[10px] leading-4 text-[var(--term-muted)]">Deposit SOL or SPL tokens directly to your wallet address.</p>

                            <div className="mt-3 grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 rounded-xl border border-[var(--term-border)] bg-[var(--term-bg)] p-2.5">
                                <div className="relative grid aspect-square place-items-center overflow-hidden rounded-lg bg-white p-2">
                                    {address ? <QRCodeSVG value={address} size={136} level="H" bgColor="#ffffff" fgColor="#050506" marginSize={0} /> : <span className="px-2 text-center text-[10px] text-[#555]">Connect a wallet to create a deposit QR</span>}
                                    {address && <span className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-4 border-white bg-black"><SolanaMark className="h-4 w-4" /></span>}
                                </div>
                                <div className="flex min-w-0 flex-col py-1">
                                    <span className="text-[10px] text-[var(--term-muted)]">SOL Deposit Address</span>
                                    <span className="mt-1 break-all text-[11px] leading-4 text-white">{address || 'Wallet not connected'}</span>
                                    <button onClick={() => void copy()} disabled={!address} className="mt-auto ml-auto grid h-7 w-7 place-items-center rounded-md text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white disabled:opacity-40" aria-label="Copy deposit address"><ClipboardDocumentIcon className="h-4 w-4" /></button>
                                </div>
                            </div>

                            <div className="mt-4">
                                <div className="mb-2 text-[10px] text-[var(--term-muted)]">Accepting</div>
                                <div className="flex flex-wrap gap-1.5">
                                    <CoinChip label="EURC" tone="#2775ca" />
                                    <CoinChip label="PYUSD" tone="#22252c" />
                                    <span className="flex h-6 items-center gap-1 rounded-full border border-[var(--term-border)] bg-[var(--term-bg)] px-2 text-[9px] text-white"><SolanaMark className="h-3 w-3" />SOL</span>
                                    <CoinChip label="USD1" tone="#d59f23" />
                                    <span className="flex h-6 items-center gap-1 rounded-full border border-[var(--term-border)] bg-[var(--term-bg)] px-2 text-[9px] text-white"><UsdcMark className="h-3 w-3" />USDC</span>
                                    <CoinChip label="USDG" tone="#a8d84f" />
                                    <CoinChip label="USDT" tone="#26a17b" />
                                    <CoinChip label="XO" tone="#10d56b" />
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <footer className="px-4 pb-4">
                    {tab === 'deposit' && <button onClick={() => void copy()} disabled={!address} className="h-10 w-full rounded-full bg-[#f59e0b] text-xs font-[650] text-white transition hover:bg-[#f6aa24] disabled:cursor-not-allowed disabled:opacity-45">Copy Address</button>}
                </footer>
            </section>
        </div>
    );
}

function TokenSelect({ label }: { label: string }) {
    return <label className="min-w-0"><span className="mb-1 block text-[9px] text-[var(--term-dim)]">{label}</span><button type="button" className="flex h-9 w-full min-w-0 items-center rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-2.5 text-[11px] text-white"><SolanaMark className="h-3.5 w-3.5 shrink-0" /><span className="ml-2 truncate">SOL</span><ChevronDownIcon className="ml-auto h-3 w-3 shrink-0 text-[var(--term-muted)]" /></button></label>;
}

function CoinChip({ label, tone }: { label: string; tone: string }) {
    return <span className="flex h-6 items-center gap-1 rounded-full border border-[var(--term-border)] bg-[var(--term-bg)] px-2 text-[9px] text-white"><i className="h-3 w-3 rounded-full" style={{ background: tone }} />{label}</span>;
}
