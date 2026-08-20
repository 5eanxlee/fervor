'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ArrowPathIcon,
    ArrowsUpDownIcon,
    CalendarDaysIcon,
    ChevronDownIcon,
    ClockIcon,
    EyeSlashIcon,
    ListBulletIcon,
    MagnifyingGlassIcon,
    NoSymbolIcon,
    ShareIcon,
    SparklesIcon,
    WalletIcon,
} from '@heroicons/react/24/outline';
import DashboardLayout from '../../components/DashboardLayout';
import { useAuth } from '../../contexts/AuthContext';
import {
    apiService,
    TrackedWallet,
    WalletActivity,
    WalletPortfolio,
    WalletPosition,
} from '../../services/api';
import { FervorMark, SolanaMark, UsdcMark } from '../../components/trading/BrandMarks';
import PortfolioPnlChart from '../../components/charts/PortfolioPnlChart';

type Range = '1d' | '7d' | '30d' | 'max';
type PositionTab = 'active' | 'history' | 'top';
type ActivityTab = 'activity' | 'transfers';
type PositionRow = WalletPosition & { wallet: TrackedWallet };

const short = (value: string): string => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';

const micro = (value?: string): number => {
    if (!value) return 0;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount / 1_000_000 : 0;
};

const sum = (values: Array<string | undefined>): string => values.reduce((total, value) => {
    try { return total + BigInt(value || '0'); } catch { return total; }
}, BigInt(0)).toString();

const usd = (value?: string): string => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
}).format(micro(value));

const signedUsd = (value?: string): string => {
    const amount = micro(value);
    return `${amount > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(amount)}`;
};

const isOpen = (position: WalletPosition): boolean => {
    try { return BigInt(position.quantityBase) > BigInt(0); } catch { return Number(position.quantityBase) > 0; }
};

const pnlPct = (position: WalletPosition): number => {
    const cost = micro(position.costMicroUsd);
    const pnl = micro(position.unrealizedPnlMicroUsd || position.realizedPnlMicroUsd);
    return cost ? pnl / cost * 100 : 0;
};

const quantity = (value?: string, decimals = 0): string => {
    if (!value) return '—';
    const amount = Number(value) / 10 ** decimals;
    return Number.isFinite(amount)
        ? new Intl.NumberFormat('en-US', { notation: amount >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 3 }).format(amount)
        : '—';
};

const ago = (value: string): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
};

export default function PortfolioPage() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const [wallets, setWallets] = useState<TrackedWallet[]>([]);
    const [portfolios, setPortfolios] = useState<Record<string, WalletPortfolio>>({});
    const [activities, setActivities] = useState<Record<string, WalletActivity[]>>({});
    const [walletId, setWalletId] = useState('all');
    const [walletMenu, setWalletMenu] = useState<'select' | 'search' | null>(null);
    const [walletQuery, setWalletQuery] = useState('');
    const [positionQuery, setPositionQuery] = useState('');
    const [range, setRange] = useState<Range>('max');
    const [positionTab, setPositionTab] = useState<PositionTab>('active');
    const [activityTab, setActivityTab] = useState<ActivityTab>('activity');
    const [showHidden, setShowHidden] = useState(false);
    const [solPrice, setSolPrice] = useState<number>();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) router.replace('/');
    }, [authLoading, isAuthenticated, router]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const list = (await apiService.listTrackedWallets()).data || [];
            setWallets(list);
            const portfolioRows = await Promise.all(list.map(async (wallet) => [
                wallet.id,
                await apiService.getWalletPortfolio(wallet.id).then((response) => response.data).catch(() => undefined),
            ] as const));
            const activityRows = await Promise.all(list.map(async (wallet) => [
                wallet.id,
                await apiService.getWalletActivity(wallet.id, 200).then((response) => response.data?.items || []).catch(() => []),
            ] as const));
            setPortfolios(Object.fromEntries(portfolioRows.filter((row): row is readonly [string, WalletPortfolio] => Boolean(row[1]))));
            setActivities(Object.fromEntries(activityRows));
            setWalletId((current) => current === 'all' || list.some((wallet) => wallet.id === current) ? current : 'all');
        } catch {
            setWallets([]);
            setPortfolios({});
            setActivities({});
            setWalletId('all');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) void load();
    }, [isAuthenticated, load]);

    useEffect(() => {
        fetch('/api/market/prices', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : undefined)
            .then((payload: { prices?: { sol?: number } } | undefined) => setSolPrice(payload?.prices?.sol))
            .catch(() => undefined);
    }, []);

    const pickedWallets = useMemo(() => walletId === 'all' ? wallets : wallets.filter((wallet) => wallet.id === walletId), [walletId, wallets]);
    const pickedPortfolios = useMemo(() => pickedWallets.flatMap((wallet) => portfolios[wallet.id] ? [portfolios[wallet.id]] : []), [pickedWallets, portfolios]);
    const allPositions = useMemo(() => pickedWallets.flatMap((wallet) => (portfolios[wallet.id]?.positions || []).map((position) => ({ ...position, wallet }))), [pickedWallets, portfolios]);
    const allActivity = useMemo(() => pickedWallets.flatMap((wallet) => activities[wallet.id] || []).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)), [activities, pickedWallets]);
    const total = sum(pickedPortfolios.map((portfolio) => portfolio.marketValueMicroUsd));
    const realized = sum(pickedPortfolios.map((portfolio) => portfolio.realizedPnlMicroUsd));
    const unrealized = sum(pickedPortfolios.map((portfolio) => portfolio.unrealizedPnlMicroUsd));
    const totalPnl = sum([realized, unrealized]);
    const currentWallet = wallets.find((wallet) => wallet.id === walletId);
    const walletLabel = walletId === 'all' ? 'Fervor Main' : currentWallet?.label || short(currentWallet?.walletAddress || '');

    const positions = useMemo(() => {
        const base = positionTab === 'active'
            ? allPositions.filter(isOpen)
            : positionTab === 'top'
                ? [...allPositions].sort((a, b) => pnlPct(b) - pnlPct(a)).slice(0, 100)
                : [...allPositions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        const query = positionQuery.trim().toLowerCase();
        return base.filter((position) => !query || position.tokenMint.toLowerCase().includes(query) || position.wallet.label?.toLowerCase().includes(query));
    }, [allPositions, positionQuery, positionTab]);

    const walletMatches = wallets.filter((wallet) => {
        const query = walletQuery.trim().toLowerCase();
        return !query || wallet.walletAddress.toLowerCase().includes(query) || wallet.label?.toLowerCase().includes(query);
    });
    const activity = activityTab === 'transfers' ? allActivity.filter((item) => item.kind !== 'swap') : allActivity;
    const buys = allActivity.filter((item) => item.side === 'buy').length;
    const sells = allActivity.filter((item) => item.side === 'sell').length;
    const buckets = [
        ['>500%', allPositions.filter((position) => pnlPct(position) > 500).length, '#164e3e'],
        ['200% ~ 500%', allPositions.filter((position) => pnlPct(position) > 200 && pnlPct(position) <= 500).length, '#1d5d48'],
        ['0% ~ 200%', allPositions.filter((position) => pnlPct(position) >= 0 && pnlPct(position) <= 200).length, 'var(--term-buy)'],
        ['0% ~ -50%', allPositions.filter((position) => pnlPct(position) < 0 && pnlPct(position) >= -50).length, '#5b2137'],
        ['< -50%', allPositions.filter((position) => pnlPct(position) < -50).length, '#6d1e3d'],
    ] as const;

    const chartValues = (() => {
        const ordered = [...allPositions].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
        let current = 0;
        const values = [0, ...ordered.map((position) => {
            current += micro(position.realizedPnlMicroUsd);
            return current;
        })];
        if (values.length === 1 && micro(realized) !== 0) return [0, micro(realized)];
        return values.length > 1 ? values : [0, 0];
    })();

    if (authLoading || !isAuthenticated) {
        return <main data-terminal-theme="terminal" className="grid h-screen place-items-center bg-[var(--term-bg)]"><div className="spinner" /></main>;
    }

    return (
        <DashboardLayout live={!loading}>
            <div className="h-full min-h-[43rem] overflow-auto bg-[var(--term-bg)]">
                <div className="flex min-h-full min-w-[70rem] flex-col">
                    <header className="flex h-[3.75rem] shrink-0 items-center px-[clamp(1rem,1.5vw,1.5rem)]">
                        <nav className="flex h-full items-center gap-8 text-[clamp(.9rem,1.1vw,1.05rem)] font-[550]">
                            <span className="flex h-full items-center text-white">Spot</span>
                            <Link href="/tracker" className="flex h-full items-center text-[var(--term-muted)] transition-colors hover:text-white">Wallets</Link>
                        </nav>
                        <div className="relative ml-auto">
                            <label className="flex h-9 w-[min(24rem,30vw)] items-center rounded-full border border-[var(--term-border-strong)] bg-transparent px-4 text-[11px] text-[var(--term-muted)]">
                                <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-white" />
                                <input
                                    value={walletQuery}
                                    onFocus={() => setWalletMenu('search')}
                                    onPointerDown={() => setWalletMenu('search')}
                                    onClick={() => setWalletMenu('search')}
                                    onChange={(event) => { setWalletQuery(event.target.value); setWalletMenu('search'); }}
                                    className="min-w-0 flex-1 border-0 bg-transparent px-2 text-white outline-none ring-0 placeholder:text-[var(--term-muted)] focus:border-0 focus:outline-none focus:ring-0"
                                    placeholder="Search for other wallets..."
                                />
                            </label>
                            {walletMenu === 'search' && <WalletMenu wallets={walletMatches} onPick={(id) => { setWalletId(id); setWalletMenu(null); setWalletQuery(''); }} onClose={() => setWalletMenu(null)} className="right-0 top-[calc(100%+.45rem)] w-full" />}
                        </div>
                    </header>

                    <section className="relative flex h-[3.25rem] shrink-0 items-center px-[clamp(1rem,1.5vw,1.5rem)]">
                        <button onClick={() => setWalletMenu((value) => value === 'select' ? null : 'select')} className="flex h-9 min-w-[10.5rem] items-center rounded-full border border-[var(--term-border-strong)] px-3.5 text-[12px] text-white" aria-haspopup="listbox" aria-expanded={walletMenu === 'select'}>
                            <span className="truncate">{walletLabel}</span><ChevronDownIcon className={`ml-auto h-3.5 w-3.5 text-[var(--term-muted)] transition-transform ${walletMenu === 'select' ? 'rotate-180' : ''}`} />
                        </button>
                        {walletMenu === 'select' && <WalletMenu wallets={wallets} onPick={(id) => { setWalletId(id); setWalletMenu(null); setWalletQuery(''); }} onClose={() => setWalletMenu(null)} className="left-[clamp(1rem,1.5vw,1.5rem)] top-[calc(100%-.25rem)] w-64" />}
                        <span className="ml-5 flex items-center gap-2 text-[13px] tabular-nums text-white"><SolanaMark className="h-[1.15rem] w-[1.15rem]" />{solPrice ? (micro(total) / solPrice).toLocaleString('en-US', { maximumFractionDigits: 3 }) : '—'}</span>
                        <span className="ml-5 flex items-center gap-2 text-[13px] tabular-nums text-white"><WalletIcon className="h-4 w-4 text-[var(--term-dim)]" />{pickedWallets.length}</span>
                        <div className="ml-auto flex items-center gap-4 text-[12px] font-[550] text-[var(--term-muted)]">
                            <button onClick={() => void load()} className="grid h-7 w-7 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Refresh portfolio"><ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
                            <button className="grid h-7 w-7 place-items-center rounded-full hover:bg-[var(--term-raised)] hover:text-white" aria-label="Inspect portfolio"><MagnifyingGlassIcon className="h-4 w-4" /></button>
                            {(['1d', '7d', '30d', 'max'] as Range[]).map((value) => <button key={value} onClick={() => setRange(value)} className={`min-w-8 px-1 py-1 ${range === value ? 'text-[var(--term-accent)]' : 'hover:text-white'}`}>{value === 'max' ? 'Max' : value}</button>)}
                        </div>
                    </section>

                    <section className="grid h-[clamp(21rem,40vh,25rem)] shrink-0 grid-cols-[31%_38%_31%] border border-[var(--term-border)]">
                        <section className="flex min-w-0 flex-col border-r border-[var(--term-border)]">
                            <PanelTitle title="Balance"><ArrowsUpDownIcon className="h-4 w-4" />USD</PanelTitle>
                            <div className="flex flex-1 flex-col">
                                <div className="flex flex-1 flex-col justify-center px-5">
                                    <Label>Total Value</Label><Value>{usd(total)}</Value>
                                    <Label className="mt-4">Unrealized PNL</Label><Value tone={micro(unrealized) < 0 ? 'sell' : undefined}>{signedUsd(unrealized)}</Value>
                                </div>
                                <div className="grid min-h-[8.5rem] grid-cols-[1fr_auto] border-t border-[var(--term-border)] px-5 py-5">
                                    <div><Label>Tradeable Balance</Label><Value>{usd(total)}</Value><Label className="mt-4">Stable Coin Balance</Label><Value>—</Value></div>
                                    <div className="text-right"><Label>Wallet Funding</Label><span className="mt-3 flex h-7 items-center gap-2 rounded-full bg-[var(--term-raised)] px-3 text-[11px] text-[var(--term-muted)]"><WalletIcon className="h-3.5 w-3.5" /><SolanaMark className="h-3.5 w-3.5" />{pickedWallets.length}<ClockIcon className="h-3.5 w-3.5" />5m</span><span className="mt-5 flex items-center justify-end gap-2 text-[13px] text-white"><UsdcMark className="h-4 w-4" />—</span></div>
                                </div>
                            </div>
                        </section>

                        <section className="relative min-w-0 border-r border-[var(--term-border)]">
                            <PanelTitle title="Realized PNL"><CalendarDaysIcon className="h-4 w-4" /></PanelTitle>
                            <PortfolioPnlChart values={chartValues} />
                            <FervorMark className="absolute bottom-4 left-4 h-6 w-6 text-white" />
                        </section>

                        <section className="flex min-w-0 flex-col">
                            <PanelTitle title="Performance"><ShareIcon className="h-4 w-4" /></PanelTitle>
                            <div className="flex flex-1 flex-col px-5 pb-5 pt-3 text-[11px] text-[var(--term-muted)]">
                                <Stat label="Total PnL" value={signedUsd(totalPnl)} tone={micro(totalPnl) >= 0 ? 'buy' : 'sell'} />
                                <Stat label="Realized PNL" value={signedUsd(realized)} tone={micro(realized) >= 0 ? 'buy' : 'sell'} />
                                <Stat label="Total TXNS" value={`${allActivity.length} ${buys} / ${sells}`} split />
                                <div className="mt-auto space-y-2.5">
                                    {buckets.map(([label, count, color]) => <div key={label} className="flex items-center"><span className="mr-2 h-2.5 w-2.5 rounded-full" style={{ background: color }} /><span>{label}</span><span className="ml-auto tabular-nums text-white">{count}</span></div>)}
                                </div>
                                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--term-border)]"><span className="block h-full w-full bg-[var(--term-buy)]" /></div>
                            </div>
                        </section>
                    </section>

                    <section className="grid min-h-[22rem] flex-1 grid-cols-[62%_38%] border-x border-b border-[var(--term-border)]">
                        <section className="flex min-w-0 flex-col border-r border-[var(--term-border)]">
                            <div className="flex h-12 shrink-0 items-center border-b border-[var(--term-border)] px-4 text-[11px] text-[var(--term-muted)]">
                                {([['active', 'Active Positions'], ['history', 'History'], ['top', 'Top 100']] as const).map(([value, label]) => <button key={value} onClick={() => setPositionTab(value)} className={`relative mr-7 h-full font-[550] ${positionTab === value ? 'text-white' : 'hover:text-white'}`}>{label}{positionTab === value && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-white" />}</button>)}
                                <ListBulletIcon className="mr-4 h-4 w-4" />
                                <label className="flex h-8 w-[min(17rem,22vw)] items-center rounded-full border border-[var(--term-border)] px-3"><MagnifyingGlassIcon className="h-3.5 w-3.5" /><input value={positionQuery} onChange={(event) => setPositionQuery(event.target.value)} className="min-w-0 flex-1 border-0 bg-transparent px-2 text-white outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0" placeholder="Search by name or address" /></label>
                                <button className="ml-auto hidden items-center gap-1.5 hover:text-white xl:flex"><SparklesIcon className="h-4 w-4" />Optimize Dust</button>
                                <button onClick={() => setShowHidden((value) => !value)} className={`ml-5 hidden items-center gap-1.5 hover:text-white xl:flex ${showHidden ? 'text-[var(--term-accent)]' : ''}`}><EyeSlashIcon className="h-4 w-4" />Show Hidden</button>
                                <button className="ml-5 flex items-center gap-1.5 hover:text-white"><ArrowsUpDownIcon className="h-4 w-4" />USD</button>
                            </div>
                            <div className="grid h-9 shrink-0 grid-cols-[minmax(12rem,1.5fr)_repeat(4,minmax(6rem,.72fr))_5rem] items-center border-b border-[var(--term-border)] px-4 text-[10px] text-[var(--term-muted)]"><span>Token</span><span>Bought</span><span>Sold</span><span>Remaining</span><span>PNL</span><span className="text-right">Action</span></div>
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                {positions.map((position) => <Position key={`${position.wallet.id}:${position.tokenMint}`} position={position} />)}
                                {!loading && !positions.length && <Empty icon="positions" text="No active positions" />}
                                {loading && <div className="grid h-full min-h-[15rem] place-items-center"><div className="spinner" /></div>}
                            </div>
                        </section>

                        <section className="flex min-w-0 flex-col">
                            <div className="flex h-12 shrink-0 items-center border-b border-[var(--term-border)] px-4 text-[11px] text-[var(--term-muted)]">
                                <button onClick={() => setActivityTab('activity')} className={`relative mr-7 h-full font-[550] ${activityTab === 'activity' ? 'text-white' : 'hover:text-white'}`}>Activity{activityTab === 'activity' && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-white" />}</button>
                                <button onClick={() => setActivityTab('transfers')} className={`relative h-full font-[550] ${activityTab === 'transfers' ? 'text-white' : 'hover:text-white'}`}>Transfers{activityTab === 'transfers' && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-white" />}</button>
                            </div>
                            <div className="grid h-9 shrink-0 grid-cols-[5rem_minmax(8rem,1fr)_6rem_7rem_4rem] items-center border-b border-[var(--term-border)] px-4 text-[10px] text-[var(--term-muted)]"><span>Type</span><span>Token</span><span>Amount</span><span>Market Cap</span><span className="text-right">Age</span></div>
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                {activity.map((item) => <Activity key={item.id} item={item} />)}
                                {!loading && !activity.length && <Empty icon="activity" text="No activity" />}
                            </div>
                        </section>
                    </section>
                </div>
            </div>
        </DashboardLayout>
    );
}

function WalletMenu({ wallets, onPick, onClose, className }: { wallets: TrackedWallet[]; onPick: (id: string) => void; onClose: () => void; className: string }) {
    return (
        <>
            <button onPointerDown={onClose} className="fixed inset-0 z-30 cursor-default" aria-label="Close wallet selector" />
            <div role="listbox" className={`absolute z-40 overflow-hidden rounded-xl border border-[var(--term-border-strong)] bg-[var(--term-panel)] p-1.5 shadow-2xl ${className}`}>
                <button role="option" aria-selected={false} onClick={() => onPick('all')} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-[11px] text-white hover:bg-[var(--term-raised)]"><span className="mr-2 grid h-5 w-5 place-items-center rounded-full bg-[var(--term-control)]"><FervorMark className="h-3 w-3" /></span>Fervor Main</button>
                {wallets.map((wallet) => <button role="option" aria-selected={false} key={wallet.id} onClick={() => onPick(wallet.id)} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-[11px] text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white"><span className="mr-2 grid h-5 w-5 place-items-center rounded-full bg-[var(--term-control)] text-[9px] text-[var(--term-accent)]">{(wallet.label || wallet.walletAddress).slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate">{wallet.label || short(wallet.walletAddress)}</span></button>)}
                {!wallets.length && <div className="px-3 py-4 text-center text-[10px] text-[var(--term-dim)]">No matching wallets</div>}
            </div>
        </>
    );
}

function PanelTitle({ title, children }: { title: string; children?: React.ReactNode }) {
    return <header className="flex h-12 shrink-0 items-center px-5 text-[13px] font-[500] text-white"><span>{title}</span><span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--term-muted)]">{children}</span></header>;
}

function Label({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return <div className={`text-[11px] text-[var(--term-muted)] ${className}`}>{children}</div>;
}

function Value({ children, tone }: { children: React.ReactNode; tone?: 'buy' | 'sell' }) {
    return <div className={`mt-1 text-[1.15rem] font-[500] tabular-nums ${tone === 'buy' ? 'text-[var(--term-buy)]' : tone === 'sell' ? 'text-[var(--term-sell)]' : 'text-white'}`}>{children}</div>;
}

function Stat({ label, value, tone, split }: { label: string; value: string; tone?: 'buy' | 'sell'; split?: boolean }) {
    return <div className="mb-3 flex items-center"><span>{label}</span><span className={`ml-auto tabular-nums ${tone === 'buy' ? 'text-[var(--term-buy)]' : tone === 'sell' ? 'text-[var(--term-sell)]' : 'text-white'}`}>{split ? <>{value.split(' ')[0]} <i className="not-italic text-[var(--term-buy)]">{value.split(' ')[1]}</i> / <i className="not-italic text-[var(--term-sell)]">{value.split(' ')[3]}</i></> : value}</span></div>;
}

function Position({ position }: { position: PositionRow }) {
    const percent = pnlPct(position);
    const positive = percent >= 0;
    return (
        <div className="grid min-h-14 grid-cols-[minmax(12rem,1.5fr)_repeat(4,minmax(6rem,.72fr))_5rem] items-center border-b border-[var(--term-border)] px-4 text-[10px] tabular-nums hover:bg-[var(--term-panel)]">
            <Link href={`/trade/${position.tokenMint}`} className="flex min-w-0 items-center gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--term-border-strong)] bg-[var(--term-raised)] text-[10px] font-[650] text-[var(--term-accent)]">{position.tokenMint.slice(0, 1)}</span><span className="min-w-0"><span className="block truncate text-[11px] text-white">{short(position.tokenMint)}</span><span className="mt-0.5 block truncate text-[9px] text-[var(--term-dim)]">{position.wallet.label || short(position.wallet.walletAddress)}</span></span></Link>
            <span className="text-[var(--term-muted)]">{usd(position.costMicroUsd)}</span>
            <span className="text-[var(--term-muted)]">{usd(position.realizedPnlMicroUsd)}</span>
            <span className="text-white">{usd(position.currentValueMicroUsd)}</span>
            <span className={positive ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{signedUsd(position.unrealizedPnlMicroUsd)} <small>{percent >= 0 ? '+' : ''}{percent.toFixed(1)}%</small></span>
            <Link href={`/trade/${position.tokenMint}`} className="ml-auto rounded-full border border-[var(--term-border)] px-2.5 py-1 text-[var(--term-muted)] hover:border-[var(--term-border-strong)] hover:text-white">View</Link>
        </div>
    );
}

function Activity({ item }: { item: WalletActivity }) {
    const label = item.kind === 'swap' ? item.side || 'Swap' : item.kind === 'transfer_in' ? 'In' : 'Out';
    const positive = label === 'buy' || label === 'In';
    return (
        <div className="grid min-h-12 grid-cols-[5rem_minmax(8rem,1fr)_6rem_7rem_4rem] items-center border-b border-[var(--term-border)] px-4 text-[10px] text-[var(--term-muted)] hover:bg-[var(--term-panel)]">
            <span className={positive ? 'capitalize text-[var(--term-buy)]' : 'capitalize text-[var(--term-sell)]'}>{label}</span>
            {item.tokenMint ? <Link href={`/trade/${item.tokenMint}`} className="truncate font-mono text-white hover:text-[var(--term-accent)]">{short(item.tokenMint)}</Link> : <span>—</span>}
            <span>{quantity(item.quantityBase, item.tokenDecimals)}</span><span>—</span><span className="text-right">{ago(item.occurredAt)}</span>
        </div>
    );
}

function Empty({ icon, text }: { icon: 'positions' | 'activity'; text: string }) {
    return <div className="grid h-full min-h-[15rem] place-items-center text-center text-[11px] text-[var(--term-muted)]"><div>{icon === 'positions' ? <WalletIcon className="mx-auto h-10 w-10 text-[var(--term-border-strong)]" /> : <NoSymbolIcon className="mx-auto h-10 w-10 text-[var(--term-border-strong)]" />}<div className="mt-3">{text}</div></div></div>;
}
