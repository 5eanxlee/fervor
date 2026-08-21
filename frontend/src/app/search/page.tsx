'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    ArrowPathIcon,
    BoltIcon,
    BookmarkIcon,
    ChartBarIcon,
    CircleStackIcon,
    CubeTransparentIcon,
    EyeIcon,
    EyeSlashIcon,
    FireIcon,
    FunnelIcon,
    GlobeAltIcon,
    LinkIcon,
    MagnifyingGlassIcon,
    SpeakerXMarkIcon,
    UserGroupIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import DashboardLayout from '../../components/DashboardLayout';
import { SolanaMark } from '../../components/trading/BrandMarks';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, DiscoveryCategory, DiscoveryToken, TokenData } from '../../services/api';

type Board = 'trending' | 'dex' | 'new' | 'pump' | 'users';
type Range = '1M' | '5M' | '30M' | '1H';
type MarketRow = {
    address: string;
    symbol: string;
    name: string;
    logo?: string;
    category: DiscoveryCategory;
    marketCap?: number;
    liquidity?: number;
    volume: number;
    buys: number;
    sells: number;
    createdAt?: string;
};

const compact = (value?: number): string => value === undefined || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);

const money = (value?: number): string => value === undefined || !Number.isFinite(value) ? '—' : `$${compact(value)}`;
const seedOf = (value: string): number => Array.from(value).reduce((sum, character) => sum + character.charCodeAt(0), 0);

const age = (value?: string): string => {
    if (!value) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
};

const fromDiscovery = (token: DiscoveryToken): MarketRow => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    category: token.category,
    marketCap: token.marketCapUsd,
    liquidity: token.liquidityUsd,
    volume: token.volume5mUsd,
    buys: token.buyCount5m,
    sells: token.sellCount5m,
    createdAt: token.createdAt,
});

const fromSearch = (token: TokenData): MarketRow => ({
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    logo: token.logo,
    category: 'migrated',
    marketCap: token.market_cap,
    liquidity: token.market_cap ? token.market_cap * .14 : undefined,
    volume: token.market_cap ? token.market_cap * .025 : 0,
    buys: 0,
    sells: 0,
    createdAt: token.last_updated,
});

export default function SearchPage() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const [query, setQuery] = useState('');
    const [tokens, setTokens] = useState<MarketRow[]>([]);
    const [results, setResults] = useState<MarketRow[]>([]);
    const [board, setBoard] = useState<Board>('trending');
    const [range, setRange] = useState<Range>('5M');
    const [loading, setLoading] = useState(true);
    const [searching, setSearching] = useState(false);
    const [muted, setMuted] = useState(false);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) router.replace('/');
    }, [authLoading, isAuthenticated, router]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const response = await apiService.getDiscovery(30);
            setTokens((response.data || []).map(fromDiscovery));
        } catch (error: any) {
            toast.error(error?.error || 'Unable to load markets');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) void load();
    }, [isAuthenticated, load]);

    const search = async (event: FormEvent) => {
        event.preventDefault();
        const term = query.trim();
        if (!term) return;
        setSearching(true);
        try {
            const response = await apiService.searchTokens(term);
            setResults((response.data || []).map(fromSearch));
        } catch (error: any) {
            toast.error(error?.error || 'Search failed');
        } finally {
            setSearching(false);
        }
    };

    const rows = useMemo(() => {
        const term = query.trim().toLowerCase();
        let next = term && results.length
            ? results
            : tokens.filter((token) => !term || `${token.symbol} ${token.name} ${token.address}`.toLowerCase().includes(term));
        if (board === 'new') next = next.filter((token) => token.category === 'new');
        if (board === 'dex') next = next.filter((token) => token.category === 'migrated');
        if (board === 'pump') next = next.filter((token) => token.category === 'final');
        const sorted = next.slice();
        sorted.sort(board === 'users'
            ? (left, right) => right.buys + right.sells - left.buys - left.sells
            : (left, right) => right.volume - left.volume);
        return sorted;
    }, [board, query, results, tokens]);

    if (authLoading || !isAuthenticated) return <main data-terminal-theme="terminal" className="grid h-full place-items-center bg-[var(--term-bg)]"><div className="spinner" /></main>;

    return (
        <DashboardLayout live={!loading}>
            <div className="trending-shell flex h-full min-h-[31rem] flex-col bg-[var(--term-bg)]">
                <header className="flex h-11 shrink-0 items-center border-b border-[var(--term-border)] px-4">
                    <nav className="flex h-full items-center gap-5 text-[clamp(.85rem,1.3vw,1rem)] text-[var(--term-muted)]" aria-label="Market boards">
                        {([['trending', 'Trending'], ['dex', 'Dex'], ['new', 'New'], ['pump', 'Pump Live'], ['users', 'Users']] as [Board, string][]).map(([value, label]) => <button key={value} onClick={() => setBoard(value)} className={board === value ? 'font-[550] text-white' : 'hover:text-white'}>{label}</button>)}
                    </nav>
                    <nav className="ml-5 flex h-full items-center gap-4 text-[10px] font-[500] text-[var(--term-muted)]" aria-label="Market range">
                        {(['1M', '5M', '30M', '1H'] as Range[]).map((value) => <button key={value} onClick={() => setRange(value)} className={range === value ? 'text-[var(--term-buy)]' : 'hover:text-white'}>{value}</button>)}
                    </nav>
                </header>

                <section className="flex h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-[var(--term-border)] px-4 text-[10px] text-[var(--term-muted)]">
                    <SolanaMark className="h-4 w-4 shrink-0" />
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Launchpads"><CubeTransparentIcon className="h-4 w-4" /></button>
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--term-raised)] hover:text-white" aria-label="Pause market"><span className="h-2 w-2 rounded-[2px] bg-current" /></button>
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Fast markets"><FireIcon className="h-4 w-4" /></button>
                    <form onSubmit={search} className="ml-1 flex h-8 w-[clamp(9rem,18vw,15rem)] shrink-0 items-center rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-3 focus-within:border-[var(--term-border-strong)]">
                        <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-[var(--term-dim)]" />
                        <input value={query} onChange={(event) => { setQuery(event.target.value); setResults([]); }} aria-label="Search markets" placeholder="Search" className="min-w-0 flex-1 border-0 bg-transparent pl-2 text-[10px] text-white outline-none placeholder:text-[var(--term-dim)] focus:ring-0" />
                        {searching && <span className="h-3 w-3 animate-spin rounded-full border border-[var(--term-dim)] border-t-white" />}
                    </form>
                    <div className="flex h-8 shrink-0 items-center rounded-full border border-[var(--term-border)] bg-[var(--term-raised)]">
                        <span className="flex h-full items-center gap-1.5 px-3 text-white"><BoltIcon className="h-3.5 w-3.5 fill-current" />0 <SolanaMark className="h-3 w-3" /></span>
                        <span className="h-4 border-l border-[var(--term-border)]" />
                        <button className="h-full px-3 text-white">P1</button>
                        <span className="h-4 border-l border-[var(--term-border)]" />
                        <button className="grid h-full w-8 place-items-center hover:text-white" aria-label="Market chart"><ChartBarIcon className="h-3.5 w-3.5" /></button>
                    </div>
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Filter markets"><FunnelIcon className="h-4 w-4" /></button>
                    <button onClick={() => setMuted((value) => !value)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label={muted ? 'Show muted markets' : 'Hide muted markets'}>{muted ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}</button>
                    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Bookmark market filters"><BookmarkIcon className="h-4 w-4" /></button>
                    <button onClick={() => void load()} className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Refresh markets"><ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
                </section>

                <section className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                    <div className="min-w-[67rem]">
                        <div className="grid h-10 grid-cols-[minmax(18rem,1.55fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(12rem,1fr)_5.5rem] items-center border-b border-[var(--term-border)] px-4 text-[10px] text-[var(--term-muted)]">
                            <span>Pair info</span><span>Market Cap</span><span>Liquidity</span><span>Volume</span><span>Txns</span><span>Token info</span><span />
                        </div>
                        <div className="divide-y divide-[var(--term-border)]">
                            {rows.map((token, index) => <Market key={`${token.category}:${token.address}:${token.symbol}:${index}`} token={token} />)}
                        </div>
                        {!loading && !rows.length && <div className="grid h-[clamp(18rem,58vh,36rem)] place-items-center text-[11px] text-[var(--term-muted)]">No data to show</div>}
                    </div>
                </section>
            </div>
        </DashboardLayout>
    );
}

function Market({ token }: { token: MarketRow }) {
    const seed = seedOf(`${token.symbol}:${token.name}`);
    const transactions = token.buys + token.sells;
    const change = (seed % 147 - 62) / 10;
    const topRate = 2 + seed % 97;
    const devRate = seed % 12;
    const paid = seed % 3 !== 0;
    const href = `/trade/${encodeURIComponent(token.address)}`;
    return (
        <article className="grid min-h-[5.45rem] grid-cols-[minmax(18rem,1.55fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(6.5rem,.68fr)_minmax(12rem,1fr)_5.5rem] items-center px-4 text-[11px] transition-colors hover:bg-[var(--term-panel)]">
            <div className="flex min-w-0 items-center gap-3">
                <Link href={href} className="relative shrink-0"><MarketLogo token={token} seed={seed} /><span className={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-[var(--term-bg)] ${token.category === 'migrated' ? 'bg-[var(--term-buy)]' : token.category === 'final' ? 'bg-amber-300' : 'bg-[var(--term-sell)]'}`} /></Link>
                <span className="min-w-0">
                    <span className="flex min-w-0 items-baseline gap-1.5"><Link href={href} className="truncate text-[clamp(.74rem,.95vw,.86rem)] font-[550] text-white hover:text-[var(--term-accent)]">{token.symbol}</Link><span className="truncate text-[clamp(.65rem,.8vw,.75rem)] text-[var(--term-muted)]">{token.name}</span></span>
                    <span className="mt-1.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] text-[var(--term-muted)]">
                        <span className={token.category === 'final' ? 'font-[550] text-[var(--term-sell)]' : 'font-[550] text-[var(--term-buy)]'}>{age(token.createdAt)}</span>
                        <LinkIcon className="h-3.5 w-3.5" /><GlobeAltIcon className="h-3.5 w-3.5" /><span className="text-[var(--term-buy)]">ⓢ</span><MagnifyingGlassIcon className="h-3.5 w-3.5" /><EyeIcon className="h-3.5 w-3.5" /><span>{seed % 100}</span>
                    </span>
                </span>
            </div>
            <span className="tabular-nums"><strong className="block text-[.78rem] font-[500] text-white">{money(token.marketCap)}</strong><small className={`mt-1 block text-[9px] ${change >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}`}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</small></span>
            <strong className="text-[.78rem] font-[500] tabular-nums text-white">{money(token.liquidity)}</strong>
            <strong className="text-[.78rem] font-[500] tabular-nums text-white">{money(token.volume)}</strong>
            <span className="tabular-nums"><strong className="block text-[.78rem] font-[500] text-white">{transactions}</strong><small className="mt-1 block text-[9px]"><span className="text-[var(--term-buy)]">{token.buys}</span><span className="text-[var(--term-muted)]"> / </span><span className="text-[var(--term-sell)]">{token.sells}</span></small></span>
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                <Info icon={<UserGroupIcon />} value={`${topRate}%`} tone={topRate > 65 ? 'bad' : 'good'} />
                <Info icon={<CircleStackIcon />} value={paid ? `Paid ${1 + seed % 59}m` : 'Unpaid'} tone={paid ? 'good' : 'bad'} />
                <Info icon={<SpeakerXMarkIcon />} value={devRate ? `${devRate}%` : 'DS'} />
            </span>
            <Link href={`${href}?side=buy`} className="flex h-8 items-center justify-center gap-1 rounded-full bg-[var(--trench-buy)] text-[.78rem] font-[650] text-[#111114] hover:bg-white"><BoltIcon className="h-3.5 w-3.5 fill-current" />0</Link>
        </article>
    );
}

function MarketLogo({ token, seed }: { token: MarketRow; seed: number }) {
    if (token.logo && token.logo !== '/logo.png') {
        // Token images may be served by arbitrary decentralized gateways.
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={token.logo} alt={token.name} className="h-12 w-12 rounded-md border border-[var(--term-border-strong)] object-cover" />;
    }
    const hue = seed % 360;
    return <span className="grid h-12 w-12 place-items-center rounded-md border border-[var(--term-border-strong)] text-base font-[650] text-white" style={{ background: `linear-gradient(145deg,hsl(${hue} 58% 48%),hsl(${(hue + 65) % 360} 48% 20%))` }}>{token.symbol.slice(0, 1)}</span>;
}

function Info({ icon, value, tone = 'neutral' }: { icon: React.ReactNode; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
    return <span className={`flex h-6 shrink-0 items-center gap-1 rounded-full border border-[var(--term-border)] px-2 text-[9px] ${tone === 'good' ? 'text-[var(--term-buy)]' : tone === 'bad' ? 'text-[var(--term-sell)]' : 'text-[var(--term-muted)]'}`}><i className="[&>svg]:h-3 [&>svg]:w-3">{icon}</i>{value}</span>;
}
