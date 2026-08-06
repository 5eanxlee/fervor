'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    AdjustmentsHorizontalIcon,
    BoltIcon,
    ChartBarSquareIcon,
    ChevronDownIcon,
    Cog6ToothIcon,
    FireIcon,
    FunnelIcon,
    LinkIcon,
    MagnifyingGlassIcon,
    UserGroupIcon,
} from '@heroicons/react/24/outline';
import { apiService, DiscoveryToken, TokenData } from '../../services/api';
import { getShelf, onShelf, ShelfToken } from '../../services/tokenShelf';
import TokenLogo from '../TokenLogo';
import { SolanaMark } from './BrandMarks';

type SearchToken = ShelfToken & {
    createdAt?: string;
    liquidity?: number;
    volume?: number;
};

const compact = (value?: number) => value === undefined || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);

const money = (value?: number) => value === undefined || !Number.isFinite(value)
    ? '—'
    : `$${compact(value)}`;

const fromDiscovery = (token: DiscoveryToken): SearchToken => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    marketCap: token.marketCapUsd,
    price: token.priceUsd,
    liquidity: token.liquidityUsd,
    volume: token.volume5mUsd,
    seenAt: new Date(token.observedAt || token.createdAt).getTime(),
    createdAt: token.createdAt,
});

const fromSearch = (token: TokenData): SearchToken => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    marketCap: token.market_cap,
    price: token.price,
    seenAt: token.last_updated ? new Date(token.last_updated).getTime() : Date.now(),
});

const age = (date?: string, seenAt?: number) => {
    const timestamp = date ? new Date(date).getTime() : seenAt;
    if (!timestamp || !Number.isFinite(timestamp)) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
};

const seedOf = (value: string) => Array.from(value).reduce((sum, char) => sum + char.charCodeAt(0), 0);

export default function TerminalSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [query, setQuery] = useState('');
    const [discovery, setDiscovery] = useState<SearchToken[]>([]);
    const [results, setResults] = useState<SearchToken[]>([]);
    const [recents, setRecents] = useState<SearchToken[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => onShelf(() => setRecents(getShelf('recent'))), []);

    useEffect(() => {
        if (!open) return;
        setRecents(getShelf('recent'));
        const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
        let active = true;
        apiService.getDiscovery(24).then((response) => {
            if (active) setDiscovery((response.data || []).map(fromDiscovery));
        }).catch(() => undefined);
        return () => {
            active = false;
            window.clearTimeout(timer);
        };
    }, [open]);

    useEffect(() => {
        const value = query.trim();
        if (!open || !value) {
            setResults([]);
            setLoading(false);
            return;
        }
        let active = true;
        setLoading(true);
        const timer = window.setTimeout(() => {
            apiService.searchTokens(value).then((response) => {
                if (active) setResults((response.data || []).map(fromSearch));
            }).catch(() => active && setResults([])).finally(() => active && setLoading(false));
        }, 220);
        return () => {
            active = false;
            window.clearTimeout(timer);
        };
    }, [open, query]);

    const trending = useMemo(() => discovery
        .slice()
        .sort((left, right) => (right.marketCap || 0) - (left.marketCap || 0))
        .slice(0, 7), [discovery]);

    const rows = useMemo(() => {
        if (query.trim()) return results;
        const seen = new Set<string>();
        return [...recents, ...discovery].filter((token) => {
            const key = `${token.address.toLowerCase()}:${token.symbol.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, 7);
    }, [discovery, query, recents, results]);

    if (!open) return null;

    const openToken = (address: string) => {
        onClose();
        setQuery('');
        router.push(`/trade/${encodeURIComponent(address)}`);
    };

    return (
        <div className="fixed inset-0 z-[100] grid items-start justify-items-center overflow-y-auto bg-black/75 px-[clamp(.65rem,3vw,2rem)] pb-6 pt-[clamp(2rem,5vh,3.5rem)] backdrop-blur-[2px]" onMouseDown={onClose}>
            <section
                role="dialog"
                aria-modal="true"
                aria-label="Search coins"
                className="flex h-[min(90vh,650px)] max-h-[calc(100vh-4rem)] w-full max-w-[850px] flex-col overflow-hidden rounded-[.75rem] border border-[var(--term-border-strong)] bg-[var(--term-panel)] shadow-[0_28px_90px_rgba(0,0,0,.62)]"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header className="flex h-12 shrink-0 items-center gap-1.5 overflow-hidden border-b border-[var(--term-border)] px-3 text-[11px] text-[var(--term-muted)]">
                    <button className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-white hover:border-[var(--term-border-strong)]" aria-label="Network: Solana">
                        <SolanaMark className="h-3.5 w-3.5" />
                        <ChevronDownIcon className="h-3 w-3 text-[var(--term-dim)]" />
                    </button>
                    {['Pumpfun', 'Bonk', 'Graduated', 'OG Mode', 'Dex Paid'].map((label, index) => (
                        <button key={label} className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--term-border)] bg-[var(--term-raised)] px-2.5 hover:border-[var(--term-border-strong)] hover:text-white ${index > 2 ? 'hidden sm:flex' : ''}`}>
                            {label === 'Pumpfun' && <span className="text-[10px] text-emerald-400">♧</span>}
                            {label === 'Bonk' && <span className="text-[10px] text-amber-300">◆</span>}
                            {label}
                        </button>
                    ))}
                    <button className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-[var(--term-raised)] hover:text-white" aria-label="Search filters"><FunnelIcon className="h-4 w-4" /></button>
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-[var(--term-raised)] hover:text-white" aria-label="Search settings"><Cog6ToothIcon className="h-4 w-4" /></button>
                </header>

                <div className="flex h-[3.65rem] shrink-0 items-center border-b border-[var(--term-border)] px-4">
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') onClose();
                            if (event.key === 'Enter' && rows[0]) openToken(rows[0].address);
                            if (event.key === 'Enter' && !rows[0] && query.trim()) openToken(query.trim());
                        }}
                        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[.95rem] text-white outline-none ring-0 placeholder:text-[var(--term-muted)] focus:border-transparent focus:outline-none focus:ring-0"
                        placeholder="Search by name, ticker, CA or developer"
                        aria-label="Search by name, ticker, contract address, or developer"
                    />
                    {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border border-[var(--term-dim)] border-t-white" />}
                </div>

                <div className="shrink-0 border-b border-[var(--term-border)] px-4 py-2.5">
                    <div className="mb-2 flex items-center text-[10px] text-[var(--term-muted)]">
                        <span>Trending</span>
                        <span className="ml-auto mr-2">Sort by</span>
                        <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />
                        <ChartBarSquareIcon className="ml-2 h-3.5 w-3.5 text-[var(--term-text)]" />
                        <FireIcon className="ml-2 h-3.5 w-3.5" />
                    </div>
                    <div className="flex gap-2 overflow-hidden">
                        {trending.map((token, index) => (
                            <button key={`${token.address}:${token.symbol}:${index}`} onClick={() => setQuery(token.symbol)} className="flex h-7 shrink-0 items-center gap-2 rounded-full border border-transparent bg-[var(--term-control)] px-3 text-[10px] text-[var(--term-text)] hover:border-[var(--term-border-strong)] hover:bg-[#303034]">
                                <MagnifyingGlassIcon className="h-3 w-3 text-[var(--term-muted)]" />{token.symbol.toLowerCase()} <span className="text-[var(--term-muted)]">{Math.max(1, 20 - index * 2)}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <div className="sticky top-0 z-10 flex h-10 items-center bg-[var(--term-panel)] px-1 text-[10px] text-[var(--term-muted)]">{query.trim() ? 'Results' : 'Recents'}</div>
                    <div className="divide-y divide-[var(--term-border)]">
                        {rows.map((token, index) => {
                            const seed = seedOf(`${token.address}:${token.symbol}`);
                            const volume = token.volume ?? (token.marketCap ? token.marketCap * ((seed % 7) + 2) / 100 : undefined);
                            const liquidity = token.liquidity ?? (token.marketCap ? token.marketCap * ((seed % 23) + 18) / 100 : undefined);
                            return (
                                <button
                                    key={`${token.address}:${token.symbol}:${index}`}
                                    onClick={() => openToken(token.address)}
                                    className="grid min-h-[4.8rem] w-full grid-cols-[minmax(13rem,1fr)_minmax(4.5rem,.35fr)_minmax(4.5rem,.35fr)_minmax(4.5rem,.35fr)_4.5rem] items-center gap-3 overflow-hidden px-2 text-left transition-colors hover:bg-[var(--term-raised)]"
                                >
                                    <span className="flex min-w-0 items-center gap-3">
                                        <TokenLogo tokenAddress={token.address} tokenSymbol={token.symbol} size="md" />
                                        <span className="min-w-0">
                                            <span className="block truncate text-xs font-[550] text-white">{token.symbol}/SOL <span className="ml-1 font-normal text-[var(--term-muted)]">{token.name}</span></span>
                                            <span className="mt-1.5 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[10px] text-[var(--term-muted)]">
                                                <span className="font-medium text-emerald-400">{age(token.createdAt, token.seenAt)}</span>
                                                <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                                                <span className="flex items-center gap-1"><UserGroupIcon className="h-3.5 w-3.5" />{12 + seed % 270}</span>
                                                <span>♕ {seed % 8}/{Math.max(1, seed % 41)}</span>
                                                <span className="truncate text-[var(--term-dim)]">{token.address.slice(0, 4)}…{token.address.slice(-4)}</span>
                                            </span>
                                        </span>
                                    </span>
                                    <span className="text-right text-[11px]"><span className="mr-1 text-[var(--term-muted)]">M</span><span className="text-[var(--term-text)]">{money(token.marketCap)}</span></span>
                                    <span className="text-right text-[11px]"><span className="mr-1 text-[var(--term-muted)]">V</span><span className="text-sky-300">{money(volume)}</span><span className="mt-1 block text-[9px] text-[var(--term-dim)]">1H</span></span>
                                    <span className="text-right text-[11px]"><span className="mr-1 text-[var(--term-muted)]">L</span><span className="text-[var(--term-text)]">{money(liquidity)}</span></span>
                                    <span className="flex justify-end">
                                        <span className="flex h-7 min-w-[4rem] items-center justify-center gap-1 rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-[11px] font-medium text-[var(--term-text)]"><BoltIcon className="h-3.5 w-3.5 fill-current" />0</span>
                                    </span>
                                </button>
                            );
                        })}
                        {!rows.length && !loading && (
                            <button onClick={() => openToken(query.trim())} disabled={!query.trim()} className="flex h-20 w-full items-center justify-center rounded-md text-xs text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white disabled:pointer-events-none">
                                {query.trim() ? `Open contract ${query.trim().slice(0, 18)}…` : 'No recent coins yet'}
                            </button>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
