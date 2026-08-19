'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
    ArrowRightOnRectangleIcon,
    ChartBarIcon,
    ClipboardDocumentIcon,
    Cog6ToothIcon,
    CommandLineIcon,
    MagnifyingGlassIcon,
    NewspaperIcon,
    NoSymbolIcon,
    PresentationChartLineIcon,
    SparklesIcon,
    StarIcon,
    TrophyIcon,
    UserCircleIcon,
    WalletIcon,
} from '@heroicons/react/24/outline';
import { useAuth } from '../../contexts/AuthContext';
import { useWallet } from '../../contexts/WalletContext';
import toast from 'react-hot-toast';
import type { TerminalSettings } from '../../services/terminalSettings';
import { apiService } from '../../services/api';
import { getShelf, onShelf, setPositions, ShelfKind, ShelfToken } from '../../services/tokenShelf';
import {
    BitcoinMark,
    BnbMark,
    EthereumMark,
    FervorMark,
    SolanaMark,
    UsdcMark,
} from './BrandMarks';
import TerminalSearchModal from './TerminalSearchModal';
import DepositModal from './DepositModal';
import type { SettingsSection } from './TerminalSettingsModal';

const replayMode = process.env.NEXT_PUBLIC_DATA_MODE === 'replay';
const replayMint = process.env.NEXT_PUBLIC_REPLAY_MINT?.trim();
const nav = [
    { href: '/search', label: 'Trending' },
    { href: '/portfolio', label: 'Portfolio', key: 'portfolio' as const },
    { href: '/tracker', label: 'Track', key: 'watchlist' as const },
    { href: '/dashboard', label: 'Vision' },
    ...(replayMode && replayMint ? [{ href: '/replay', label: 'Replay' }] : []),
];

type Prices = Partial<Record<'sol' | 'bnb' | 'eth' | 'btc', number>>;
type StreamState = boolean | 'connecting' | 'live' | 'offline';

const usd = (value?: number): string => value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: value >= 10_000 ? 'compact' : 'standard',
        minimumFractionDigits: value >= 1_000 ? 0 : 2,
        maximumFractionDigits: value >= 1_000 ? 2 : 2,
    }).format(value);

const balance = (value?: number, digits = 3) => value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);

function useMarketPrices() {
    const [prices, setPrices] = useState<Prices>({});

    useEffect(() => {
        let active = true;
        let timer: number | undefined;
        const load = async () => {
            try {
                const response = await fetch('/api/market/prices', { cache: 'no-store' });
                if (!response.ok) return;
                const payload = await response.json() as { prices?: Prices };
                if (active && payload.prices) setPrices((current) => ({ ...current, ...payload.prices }));
            } catch {
                // Keep the last valid marks in place through a transient provider failure.
            } finally {
                if (active) timer = window.setTimeout(load, 20_000);
            }
        };
        void load();
        return () => {
            active = false;
            if (timer) window.clearTimeout(timer);
        };
    }, []);

    return prices;
}

function useFps() {
    const [fps, setFps] = useState<number>();

    useEffect(() => {
        let frame = 0;
        let count = 0;
        let started = performance.now();
        const sample = (now: number) => {
            count += 1;
            const elapsed = now - started;
            if (elapsed >= 500) {
                setFps(Math.max(0, Math.round(count * 1_000 / elapsed)));
                count = 0;
                started = now;
            }
            frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        return () => cancelAnimationFrame(frame);
    }, []);

    return fps;
}

function useBalances(address?: string | null) {
    const [values, setValues] = useState<{ sol?: number; usdc?: number }>({});

    useEffect(() => {
        if (!address) {
            setValues({});
            return;
        }
        let active = true;
        let timer: number | undefined;
        const load = async () => {
            try {
                const response = await fetch(`/api/wallet/${encodeURIComponent(address)}/balances`, { cache: 'no-store' });
                if (!response.ok) return;
                const payload = await response.json() as { sol?: number; usdc?: number };
                if (active) setValues({ sol: payload.sol, usdc: payload.usdc });
            } catch {
                // A balance mark should not interfere with wallet connectivity.
            } finally {
                if (active) timer = window.setTimeout(load, 20_000);
            }
        };
        void load();
        return () => {
            active = false;
            if (timer) window.clearTimeout(timer);
        };
    }, [address]);

    return values;
}

function useTape() {
    const [mode, setMode] = useState<ShelfKind>('recent');
    const [tokens, setTokens] = useState<ShelfToken[]>([]);

    const sync = useCallback(() => setTokens(getShelf(mode)), [mode]);
    useEffect(sync, [sync]);
    useEffect(() => onShelf(sync), [sync]);

    useEffect(() => {
        if (mode !== 'positions') return;
        let active = true;
        const load = async () => {
            try {
                const wallets = (await apiService.listTrackedWallets()).data || [];
                const batches = await Promise.all(wallets.map((wallet) => apiService.getWalletPositions(wallet.id)));
                const unique = new Map<string, { updatedAt: string; price?: number }>();
                for (const item of batches.flatMap((batch) => batch.data || [])) {
                    let held = false;
                    try { held = BigInt(item.quantityBase) > BigInt(0); } catch { held = Number(item.quantityBase) > 0; }
                    if (held && !unique.has(item.tokenMint)) unique.set(item.tokenMint, { updatedAt: item.updatedAt, price: Number(item.priceUsd) || undefined });
                }
                const next = await Promise.all(Array.from(unique.entries()).slice(0, 12).map(async ([address, item]) => {
                    const metadata = await apiService.getTokenMetadata(address).catch(() => undefined);
                    return {
                        address,
                        symbol: metadata?.data?.symbol || `${address.slice(0, 4)}…`,
                        name: metadata?.data?.name,
                        logo: metadata?.data?.logo,
                        price: item.price,
                        seenAt: new Date(item.updatedAt).getTime(),
                    } satisfies ShelfToken;
                }));
                if (!active) return;
                setPositions(next);
                setTokens(next);
            } catch {
                if (active) setTokens(getShelf('positions'));
            }
        };
        void load();
        return () => { active = false; };
    }, [mode]);

    return { mode, setMode, tokens, sync };
}

export function TerminalHeader({ onSettings, settings }: { onSettings: (section?: SettingsSection) => void; settings?: TerminalSettings }) {
    const pathname = usePathname();
    const router = useRouter();
    const { user, signOut } = useAuth();
    const { connected, connecting, publicKey, walletName, wallets, connect, disconnect } = useWallet();
    const [profileOpen, setProfileOpen] = useState(false);
    const [walletOpen, setWalletOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [depositOpen, setDepositOpen] = useState(false);
    const address = publicKey || user?.walletAddress;
    const balances = useBalances(connected ? address : undefined);
    const tape = useTape();

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
            if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                setSearchOpen(true);
            }
            if (event.key === 'Escape') setSearchOpen(false);
        };
        window.addEventListener('keydown', shortcut);
        return () => window.removeEventListener('keydown', shortcut);
    }, []);

    const openToken = (value: string) => {
        const token = value.trim();
        if (token) router.push(`/trade/${encodeURIComponent(token)}`);
    };
    const links = nav.filter((item) => !item.key || settings?.nav[item.key] !== false);
    const copyAddress = async () => {
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            toast.success('Wallet copied');
        } catch {
            toast.error('Unable to copy wallet');
        }
    };
    const leave = async () => {
        setProfileOpen(false);
        setWalletOpen(false);
        signOut();
        await disconnect().catch(() => undefined);
        router.push('/');
    };
    const openWallet = async () => {
        if (!wallets.length) {
            toast.error('No compatible Solana wallet found');
            return;
        }
        try {
            await connect();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Wallet connection failed');
        }
    };

    return (
        <>
            <div className="terminal-chrome shrink-0 bg-[var(--term-bg)]">
                <header className="terminal-topbar flex items-center border-b border-[var(--term-border)] px-[clamp(.75rem,1.2vw,1rem)] text-[clamp(.72rem,.9vw,.84rem)]">
                    <Link href="/dashboard" aria-label="Fervor home" className="mr-[clamp(.8rem,1.2vw,1.15rem)] flex shrink-0 items-center gap-1.5 text-white">
                        <FervorMark className="h-[clamp(1.3rem,1.65vw,1.5rem)] w-[clamp(1.3rem,1.65vw,1.5rem)]" />
                        <span className="text-[clamp(1rem,1.3vw,1.2rem)] font-[680] tracking-[-0.025em] text-white">FERVOR</span>
                    </Link>

                    <nav className="hidden h-full min-w-0 items-center lg:flex">
                        {links.map(({ href, label }) => {
                            const active = label === 'Replay'
                                ? pathname === '/replay'
                                : label === 'Vision'
                                ? pathname === '/dashboard' || pathname.startsWith('/trade/')
                                : label === 'Track' ? pathname === '/tracker'
                                    : pathname === href;
                            return <Link key={`${href}:${label}`} href={href} className={`terminal-nav-link flex h-full items-center px-[clamp(.65rem,1.1vw,1rem)] ${active ? 'text-[var(--term-accent)]' : 'text-[var(--term-text)] hover:text-white'}`}>{label}</Link>;
                        })}
                    </nav>

                    <div className="ml-auto flex min-w-0 items-center gap-[clamp(.35rem,.55vw,.6rem)]">
                        <button onClick={() => setSearchOpen(true)} className="terminal-search hidden min-w-0 items-center text-left lg:flex" aria-label="Search coins"><MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--term-muted)]" /><span className="min-w-0 flex-1 truncate px-2 text-xs text-[var(--term-muted)]">Search coins...</span><kbd>/</kbd></button>
                        <button onClick={() => setDepositOpen(true)} className="terminal-deposit hidden lg:inline-flex">DEPOSIT</button>
                        {connected ? (
                            <div className="relative hidden xl:block">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setProfileOpen(false);
                                        setWalletOpen((value) => !value);
                                    }}
                                    className="terminal-wallet"
                                    aria-label="Trading wallet"
                                    aria-expanded={walletOpen}
                                >
                                    <span className="terminal-wallet-count"><WalletIcon /><span>1</span></span>
                                    <span className="terminal-wallet-sep" aria-hidden="true" />
                                    <span className="terminal-wallet-asset"><SolanaMark /><span>{balance(balances.sol, 3)}</span></span>
                                    <span className="terminal-wallet-sep" aria-hidden="true" />
                                    <span className="terminal-wallet-asset"><UsdcMark /><span>{balance(balances.usdc, 2)}</span></span>
                                </button>
                                {walletOpen && (
                                    <>
                                        <button className="fixed inset-0 z-40 cursor-default" onClick={() => setWalletOpen(false)} aria-label="Close wallet menu" />
                                        <section className="absolute right-0 top-[calc(100%+.5rem)] z-50 w-64 overflow-hidden rounded-xl border border-[var(--term-border-strong)] bg-[var(--term-panel)] shadow-2xl">
                                            <button onClick={copyAddress} className="flex w-full items-center gap-2.5 border-b border-[var(--term-border)] px-3 py-3 text-left hover:bg-[var(--term-raised)]">
                                                <WalletIcon className="h-4 w-4 shrink-0 text-[var(--term-muted)]" />
                                                <span className="min-w-0 flex-1 truncate text-xs text-white">{shortId(address)}</span>
                                                <ClipboardDocumentIcon className="h-3.5 w-3.5 text-[var(--term-dim)]" />
                                            </button>
                                            <div className="space-y-2 px-3 py-3 text-xs">
                                                <div className="flex items-center gap-2 text-[var(--term-muted)]"><UsdcMark className="h-4 w-4" /><span>USDC</span><span className="ml-auto tabular-nums text-white">{balance(balances.usdc, 2)}</span></div>
                                                <div className="flex items-center gap-2 text-[var(--term-muted)]"><SolanaMark className="h-4 w-4" /><span>SOL</span><span className="ml-auto tabular-nums text-white">{balance(balances.sol)}</span></div>
                                            </div>
                                            <button onClick={() => { setWalletOpen(false); void disconnect().catch(() => undefined); }} className="terminal-menu-row w-full border-t border-[var(--term-border)] hover:!text-[var(--term-danger)]"><ArrowRightOnRectangleIcon />Disconnect wallet</button>
                                        </section>
                                    </>
                                )}
                            </div>
                        ) : (
                            <button type="button" onClick={openWallet} disabled={connecting} className="terminal-wallet-empty hidden xl:grid" aria-label={connecting ? 'Connecting wallet' : 'Wallet not connected'} title={wallets.length ? 'Connect wallet' : 'No compatible Solana wallet found'}><NoSymbolIcon /></button>
                        )}
                        <button onClick={() => onSettings()} className="terminal-icon" aria-label="Terminal settings"><Cog6ToothIcon /></button>
                        <div className="relative">
                            <button onClick={() => { setWalletOpen(false); setProfileOpen((value) => !value); }} className="terminal-icon" aria-label="Account profile" aria-expanded={profileOpen}><UserCircleIcon /></button>
                            {profileOpen && (
                                <>
                                    <button className="fixed inset-0 z-40 cursor-default" onClick={() => setProfileOpen(false)} aria-label="Close profile" />
                                    <section className="absolute right-0 top-[calc(100%+.5rem)] z-50 w-72 overflow-hidden rounded-xl border border-[var(--term-border-strong)] bg-[var(--term-panel)] shadow-2xl">
                                        <button onClick={copyAddress} className="flex w-full items-start gap-3 border-b border-[var(--term-border)] px-4 py-3 text-left hover:bg-[var(--term-raised)]"><span className="mt-0.5 grid h-8 w-8 place-items-center rounded-full bg-[var(--term-control)] text-[var(--term-accent)]"><UserCircleIcon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs text-white">{user?.email || walletName || 'Solana account'}</span><span className="mt-1 flex items-center gap-1 text-[10px] text-[var(--term-dim)]">ID: {shortId(user?.id || address)} <ClipboardDocumentIcon className="h-3 w-3" /></span></span></button>
                                        <div className="py-1 text-xs">
                                            <Link href="/portfolio" onClick={() => setProfileOpen(false)} className="terminal-menu-row"><WalletIcon />Portfolio</Link>
                                            <button onClick={() => { setProfileOpen(false); onSettings('notifications'); }} className="terminal-menu-row w-full"><SparklesIcon />Notification channels</button>
                                            <button onClick={() => { setProfileOpen(false); onSettings('appearance'); }} className="terminal-menu-row w-full"><Cog6ToothIcon />Account settings</button>
                                            <button onClick={leave} className="terminal-menu-row w-full border-t border-[var(--term-border)] hover:!text-[var(--term-danger)]"><ArrowRightOnRectangleIcon />Sign out</button>
                                        </div>
                                    </section>
                                </>
                            )}
                        </div>
                    </div>
                </header>

                <div className="terminal-tape flex items-center border-b border-[var(--term-border)] px-[clamp(.75rem,1.2vw,1rem)] text-[clamp(.62rem,.75vw,.72rem)] text-[var(--term-muted)]">
                    <div className="mr-3 flex h-full shrink-0 items-center gap-3 border-r border-[var(--term-border)] pr-3">
                        <button onClick={() => { tape.setMode('recent'); tape.sync(); }} className={tape.mode === 'recent' ? 'text-[var(--term-accent)]' : 'transition-colors hover:text-white'} aria-label="Show recently opened tokens" title="Recent"><span aria-hidden="true">↻</span></button>
                        <button onClick={() => tape.setMode('positions')} className={tape.mode === 'positions' ? 'text-[var(--term-accent)]' : 'transition-colors hover:text-white'} aria-label="Show tokens with positions" title="Positions"><TrophyIcon className="h-3.5 w-3.5" /></button>
                        <button onClick={() => tape.setMode('starred')} className={tape.mode === 'starred' ? 'text-[var(--term-accent)]' : 'transition-colors hover:text-white'} aria-label="Show starred tokens" title="Starred"><StarIcon className="h-3.5 w-3.5" /></button>
                        <button onClick={() => onSettings()} className="transition-colors hover:text-white" aria-label="Market tape settings"><Cog6ToothIcon className="h-3.5 w-3.5" /></button>
                    </div>
                    <div className="flex min-w-0 items-center gap-[clamp(.8rem,1.8vw,1.5rem)] overflow-hidden">
                        {tape.tokens.map((item) => (
                            <button key={item.address} onClick={() => openToken(item.address)} className="flex shrink-0 items-center gap-1.5 hover:text-white"><span className="grid h-3.5 w-3.5 place-items-center rounded-[3px] bg-[var(--term-control)] text-[8px] font-semibold text-[var(--term-accent)]">{item.symbol.slice(0, 1)}</span><span>{item.symbol}</span><span className="font-[500] text-[var(--term-text)]">{item.marketCap ? usd(item.marketCap) : item.price ? usd(item.price) : ''}</span></button>
                        ))}
                        {!tape.tokens.length && <span className="text-[var(--term-dim)]">No {tape.mode} tokens</span>}
                    </div>
                </div>
            </div>
            <TerminalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
            <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} address={address} />
        </>
    );
}

const shortId = (value?: string): string => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';

export function TerminalDock({ live, onSettings }: { live: StreamState; onSettings?: () => void }) {
    const prices = useMarketPrices();
    const fps = useFps();
    const state = typeof live === 'boolean' ? (live ? 'live' : 'offline') : live;
    const status = state === 'live' ? 'Stable' : state === 'connecting' ? 'Connecting' : 'Offline';
    const tone = state === 'live' ? 'text-[var(--term-buy)]' : state === 'connecting' ? 'text-[var(--term-accent)]' : 'text-[var(--term-sell)]';
    const markets = [
        ['SOL', prices.sol, SolanaMark],
        ['BNB', prices.bnb, BnbMark],
        ['ETH', prices.eth, EthereumMark],
        ['BTC', prices.btc, BitcoinMark],
    ] as const;

    return (
        <footer className="terminal-dock flex shrink-0 items-center border-t border-[var(--term-border)] bg-[var(--term-bg)] px-[clamp(.5rem,.75vw,.75rem)] text-[clamp(.58rem,.68vw,.66rem)] text-[var(--term-dim)]">
            <span className={`flex items-center gap-1 ${tone}`}><i className="flex items-end gap-px" aria-hidden="true"><b className="h-1 w-px bg-current" /><b className="h-2 w-px bg-current" /><b className="h-3 w-px bg-current" /></i>{status}</span>
            <span className="ml-2 tabular-nums">{fps ?? '—'} FPS</span>
            <span className="mx-3 h-3.5 border-l border-[var(--term-border)]" />
            <nav className="hidden min-w-0 items-center lg:flex">
                <button type="button" onClick={onSettings} className="terminal-dock-link" aria-label="Settings"><Cog6ToothIcon /></button>
                <Link href="/watchlist" className="terminal-dock-link"><StarIcon />Watchlist</Link>
                <Link href="/tracker" className="terminal-dock-link"><WalletIcon />Wallets</Link>
                <Link href="/portfolio" className="terminal-dock-link"><PresentationChartLineIcon />PnL</Link>
                <Link href="/tracker" className="terminal-dock-link"><CommandLineIcon />Feed</Link>
                <Link href="/dashboard" className="terminal-dock-link"><ChartBarIcon />Vision</Link>
                <Link href="/search" className="terminal-dock-link"><NewspaperIcon />News</Link>
            </nav>
            <div className="ml-auto flex h-full min-w-0 items-center gap-[clamp(.55rem,1vw,1rem)] overflow-hidden">
                {markets.map(([symbol, price, Mark]) => <span key={symbol} className="flex shrink-0 items-center gap-1 tabular-nums"><Mark className="h-3 w-3" /><span className="hidden text-[var(--term-muted)] xl:inline">{symbol}</span><span className="text-[var(--term-text)]">{usd(price)}</span></span>)}
                <span className="hidden 2xl:inline">🇺🇸 English</span>
            </div>
        </footer>
    );
}
