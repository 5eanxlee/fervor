'use client';

import Link from 'next/link';
import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    AdjustmentsHorizontalIcon,
    ArrowTopRightOnSquareIcon,
    BellIcon,
    BookmarkIcon,
    Cog6ToothIcon,
    EllipsisVerticalIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    PauseIcon,
    PlayIcon,
    SpeakerXMarkIcon,
    TrashIcon,
    UserGroupIcon,
    WalletIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import DashboardLayout from '../../components/DashboardLayout';
import { fieldClass, iconClass } from '../../components/FervorPage';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, TrackedWallet, WalletActivity, WalletPortfolio } from '../../services/api';
import { getShelf, onShelf, ShelfToken, toggleStar } from '../../services/tokenShelf';

type View = 'wallets' | 'tokens';
type Area = 'wallets' | 'kols' | 'trades' | 'transfers';
type Feed = 'accounts' | 'feed';

const short = (value: string): string => `${value.slice(0, 6)}…${value.slice(-5)}`;

const microUsd = (value: string): string => {
    try {
        const amount = BigInt(value);
        const whole = amount / BigInt(1_000_000);
        const cents = ((amount < BigInt(0) ? -amount : amount) % BigInt(1_000_000)) / BigInt(10_000);
        return `${amount < BigInt(0) && whole === BigInt(0) ? '-' : ''}$${whole.toLocaleString()}.${cents.toString().padStart(2, '0')}`;
    } catch {
        return '—';
    }
};

const tone = (value?: string): string => value?.startsWith('-') ? 'text-[var(--term-sell)]' : 'text-[var(--term-buy)]';

function TrackerContent() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const params = useSearchParams();
    const view: View = params.get('view') === 'tokens' ? 'tokens' : 'wallets';
    const [wallets, setWallets] = useState<TrackedWallet[]>([]);
    const [tokens, setTokens] = useState<ShelfToken[]>([]);
    const [selected, setSelected] = useState<string>();
    const [portfolio, setPortfolio] = useState<WalletPortfolio>();
    const [activity, setActivity] = useState<WalletActivity[]>([]);
    const [address, setAddress] = useState('');
    const [label, setLabel] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [area, setArea] = useState<Area>('wallets');
    const [feed, setFeed] = useState<Feed>('accounts');
    const [addOpen, setAddOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [split, setSplit] = useState(61);
    const splitRef = useRef<HTMLDivElement>(null);

    const resizeSplit = (clientX: number) => {
        if (!splitRef.current) return;
        const rect = splitRef.current.getBoundingClientRect();
        const next = (clientX - rect.left) / rect.width * 100;
        setSplit(Math.min(74, Math.max(36, next)));
    };

    const startSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const move = (next: PointerEvent) => resizeSplit(next.clientX);
        const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
    };

    useEffect(() => {
        if (!authLoading && !isAuthenticated) router.replace('/');
    }, [authLoading, isAuthenticated, router]);

    const loadWallets = useCallback(async () => {
        setLoading(true);
        try {
            const response = await apiService.listTrackedWallets();
            const items = response.data || [];
            setWallets(items);
            setSelected((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id);
        } catch (error: any) {
            toast.error(error?.error || 'Unable to load tracked wallets');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) void loadWallets();
    }, [isAuthenticated, loadWallets]);

    useEffect(() => {
        const loadTokens = () => setTokens(getShelf('starred'));
        loadTokens();
        return onShelf(loadTokens);
    }, []);

    useEffect(() => {
        if (!selected) {
            setPortfolio(undefined);
            setActivity([]);
            return;
        }
        let active = true;
        setPortfolio(undefined);
        setActivity([]);
        Promise.all([apiService.getWalletPortfolio(selected), apiService.getWalletActivity(selected, 150)])
            .then(([portfolioResponse, activityResponse]) => {
                if (!active) return;
                setPortfolio(portfolioResponse.data);
                setActivity(activityResponse.data?.items || []);
            })
            .catch(() => {
                if (!active) return;
                setPortfolio(undefined);
                setActivity([]);
            });
        return () => { active = false; };
    }, [selected]);

    const create = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            const response = await apiService.trackWallet({ walletAddress: address.trim(), label: label.trim() || undefined });
            setAddress('');
            setLabel('');
            toast.success('Wallet tracking started');
            await loadWallets();
            if (response.data) setSelected(response.data.id);
        } catch (error: any) {
            toast.error(error?.error || 'Unable to track wallet');
        } finally {
            setBusy(false);
        }
    };

    const update = async (wallet: TrackedWallet) => {
        setBusy(true);
        try {
            const response = await apiService.updateTrackedWallet(wallet.id, { status: wallet.status === 'active' ? 'paused' : 'active' });
            if (response.data) setWallets((current) => current.map((item) => item.id === wallet.id ? response.data! : item));
        } catch (error: any) {
            toast.error(error?.error || 'Unable to update wallet');
        } finally {
            setBusy(false);
        }
    };

    const remove = async (wallet: TrackedWallet) => {
        if (!window.confirm(`Stop tracking ${wallet.label || short(wallet.walletAddress)}?`)) return;
        setBusy(true);
        try {
            await apiService.deleteTrackedWallet(wallet.id);
            toast.success('Wallet removed');
            await loadWallets();
        } catch (error: any) {
            toast.error(error?.error || 'Unable to remove wallet');
        } finally {
            setBusy(false);
        }
    };

    const removeToken = (token: ShelfToken) => {
        toggleStar(token);
        toast.success(`${token.symbol} removed`);
    };

    if (authLoading || !isAuthenticated) {
        return <main data-terminal-theme="terminal" className="grid h-full place-items-center bg-[var(--term-bg)]"><div className="spinner" /></main>;
    }

    const current = wallets.find((wallet) => wallet.id === selected);

    const shownWallets = wallets.filter((wallet) => {
        const value = query.trim().toLowerCase();
        return !value || wallet.walletAddress.toLowerCase().includes(value) || wallet.label?.toLowerCase().includes(value);
    });

    return (
        <DashboardLayout live={!loading}>
            <div className="flex h-full min-h-[31rem] flex-col bg-[var(--term-bg)]">
                <nav className="flex h-10 shrink-0 items-center border-b border-[var(--term-border)] px-4 text-[clamp(.64rem,.76vw,.74rem)] text-[var(--term-muted)]" aria-label="Tracker workspace">
                    {([
                        ['wallets', 'Wallet Manager'],
                        ['kols', 'KOLs Manager'],
                        ['trades', 'Live Trades'],
                        ['transfers', 'Transfers'],
                    ] as [Area, string][]).map(([value, label]) => (
                        <button key={value} onClick={() => { setArea(value); router.replace('/tracker?view=wallets'); }} className={`mr-[clamp(1rem,2vw,1.8rem)] h-full border-b-2 transition-colors ${area === value && view === 'wallets' ? 'border-[var(--term-accent)] text-white' : 'border-transparent hover:text-white'}`}>{label}</button>
                    ))}
                    <span className="ml-auto hidden h-4 border-l border-[var(--term-border)] sm:block" />
                    <button className="ml-3 hidden text-[var(--term-muted)] hover:text-white sm:block" aria-label="Tracker settings"><Cog6ToothIcon className="h-4 w-4" /></button>
                    <button className="ml-3 hidden text-[var(--term-muted)] hover:text-white sm:block" aria-label="Mute tracker"><SpeakerXMarkIcon className="h-4 w-4" /></button>
                    <button className="ml-3 hidden text-[var(--term-accent)] sm:block" aria-label="Tracker notifications"><BellIcon className="h-4 w-4" /></button>
                </nav>

                {view === 'tokens' ? (
                    <section className="min-h-0 flex-1 overflow-auto bg-[var(--term-panel)]">
                        <div className="flex h-11 items-center border-b border-[var(--term-border)] px-4"><BookmarkIcon className="mr-2 h-4 w-4 text-[var(--term-accent)]" /><span className="text-xs font-[500] text-white">Starred tokens</span><span className="ml-2 rounded-full bg-[var(--term-raised)] px-2 py-0.5 text-[9px] text-[var(--term-muted)]">{tokens.length}</span></div>
                        <div className="overflow-x-auto">
                            <div className="grid min-w-[35rem] grid-cols-[minmax(12rem,1fr)_minmax(12rem,.8fr)_7rem] border-b border-[var(--term-border)] px-4 py-2.5 text-[9px] uppercase tracking-[.12em] text-[var(--term-dim)]"><span>Token</span><span>Contract</span><span className="text-right">Actions</span></div>
                            <div className="min-w-[35rem] divide-y divide-[var(--term-border)]">
                                {tokens.map((token) => (
                                    <article key={token.address} className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,.8fr)_7rem] items-center px-4 py-3 text-xs transition-colors hover:bg-[var(--term-raised)]">
                                        <Link href={`/trade/${token.address}`} className="flex min-w-0 items-center gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--term-control)] font-[650] text-[var(--term-accent)]">{token.symbol.slice(0, 1)}</span><span className="min-w-0"><span className="block truncate font-[500] text-white">{token.name || token.symbol}</span><span className="mt-0.5 block text-[10px] text-[var(--term-muted)]">{token.symbol}</span></span></Link>
                                        <span className="truncate font-mono text-[10px] text-[var(--term-dim)]">{token.address}</span>
                                        <span className="flex justify-end gap-2"><Link href={`/trade/${token.address}`} className={iconClass} title="Open chart"><ArrowTopRightOnSquareIcon className="h-4 w-4" /></Link><button onClick={() => removeToken(token)} className={iconClass} title="Remove"><TrashIcon className="h-4 w-4" /></button></span>
                                    </article>
                                ))}
                                {!tokens.length && <div className="grid min-h-[26rem] place-items-center px-5 text-center"><div><BookmarkIcon className="mx-auto h-8 w-8 text-[var(--term-dim)]" /><h2 className="mt-3 text-sm text-white">No starred tokens</h2><p className="mt-1.5 text-xs text-[var(--term-muted)]">Star a token from its chart to keep it here.</p><Link href="/search" className="mt-4 inline-flex rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-4 py-2 text-xs text-[var(--term-accent)] hover:bg-[var(--term-control)]">Find tokens</Link></div></div>}
                            </div>
                        </div>
                    </section>
                ) : area === 'wallets' ? (
                    <div
                        ref={splitRef}
                        className="tracker-split min-h-0 flex-1"
                        style={{ '--tracker-left': `${split}fr`, '--tracker-right': `${100 - split}fr` } as CSSProperties}
                    >
                        <section className="flex min-h-0 min-w-0 flex-col border-b border-[var(--term-border)] lg:border-b-0">
                            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--term-border)] px-4">
                                <button className="flex h-7 items-center gap-1.5 rounded-full border border-[var(--term-border-strong)] bg-[var(--term-raised)] px-2.5 text-[10px] text-white"><span>⭐</span>Default<svg className="h-3 w-3 text-[var(--term-dim)]" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m15 5 4 4L8 20H4v-4L15 5Z" strokeWidth="1.6" /></svg></button>
                                <button className="ml-[clamp(2rem,8.4vw,6.75rem)] flex h-7 items-center gap-1 rounded-full bg-[var(--term-accent)] px-3 text-[10px] font-[600] text-[#111114]"><PlusIcon className="h-3.5 w-3.5" />Group</button>
                                <label className="ml-2 flex h-8 min-w-0 max-w-[19rem] flex-1 items-center rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-3"><MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-[var(--term-dim)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 border-0 bg-transparent pl-2 text-[10px] text-white outline-none placeholder:text-[var(--term-dim)] focus:ring-0" placeholder="Search by name or address" /></label>
                                <button className="text-[var(--term-dim)] hover:text-white" aria-label="Wallet manager menu"><EllipsisVerticalIcon className="h-4 w-4" /></button>
                            </div>

                            {addOpen && (
                                <form onSubmit={create} className="grid shrink-0 gap-2 border-b border-[var(--term-border)] bg-[var(--term-panel)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(8rem,.35fr)_auto]">
                                    <input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Solana wallet address" className={fieldClass} />
                                    <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" maxLength={80} className={fieldClass} />
                                    <button disabled={busy} className="h-9 rounded-lg bg-[var(--term-accent)] px-4 text-xs font-[650] text-[#111114] hover:brightness-110 disabled:opacity-40">Track</button>
                                </form>
                            )}

                            <div className="min-h-0 flex-1 overflow-y-auto">
                                {shownWallets.map((wallet) => (
                                    <button key={wallet.id} onClick={() => { setSelected(wallet.id); setFeed('accounts'); }} className={`flex w-full items-center gap-3 border-b border-[var(--term-border)] px-4 py-3 text-left transition-colors ${selected === wallet.id ? 'bg-[var(--term-control)]' : 'hover:bg-[var(--term-raised)]'}`}>
                                        <span className={`h-2 w-2 rounded-full ${wallet.status === 'active' ? 'bg-[var(--term-buy)]' : 'bg-[var(--term-dim)]'}`} />
                                        <span className="min-w-0 flex-1"><span className="block truncate text-xs text-white">{wallet.label || short(wallet.walletAddress)}</span><span className="mt-1 block truncate font-mono text-[10px] text-[var(--term-dim)]">{wallet.walletAddress}</span></span>
                                        <span className="text-[9px] uppercase tracking-wide text-[var(--term-dim)]">{wallet.status}</span>
                                    </button>
                                ))}
                                {!loading && !shownWallets.length && <div className="grid h-full min-h-[20rem] place-items-center text-xs text-[var(--term-dim)]">{query ? 'No matching wallets' : 'No addresses in group yet'}</div>}
                            </div>
                            <div className="flex h-12 shrink-0 items-center border-t border-[var(--term-border)] px-4">
                                <button onClick={() => setAddOpen(true)} className="rounded-full bg-[var(--term-raised)] px-4 py-2 text-[10px] text-white hover:bg-[var(--term-control)]">Import</button>
                                <button onClick={() => setAddOpen((value) => !value)} className="ml-auto rounded-full bg-[var(--term-accent)] px-5 py-2 text-[10px] font-[600] text-[#111114] hover:brightness-110">{addOpen ? 'Close' : 'Add wallet'}</button>
                            </div>
                        </section>

                        <div
                            role="separator"
                            aria-label="Resize wallet manager and tracked accounts"
                            aria-orientation="vertical"
                            aria-valuemin={36}
                            aria-valuemax={74}
                            aria-valuenow={Math.round(split)}
                            tabIndex={0}
                            onPointerDown={startSplit}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowLeft') setSplit((value) => Math.max(36, value - 2));
                                if (event.key === 'ArrowRight') setSplit((value) => Math.min(74, value + 2));
                            }}
                            className="tracker-divider group relative cursor-col-resize touch-none select-none border-x border-[var(--term-border)] bg-[var(--term-bg)] focus:outline-none"
                        >
                            <span className="absolute left-1/2 top-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--term-border-strong)] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
                        </div>

                        <section className="flex min-h-0 min-w-0 flex-col bg-[var(--term-panel)]">
                            <div className="flex h-11 shrink-0 items-center border-b border-[var(--term-border)] px-4 text-[11px] text-[var(--term-muted)]">
                                <button onClick={() => setFeed('accounts')} className={`mr-6 h-full border-b-2 ${feed === 'accounts' ? 'border-[var(--term-accent)] text-white' : 'border-transparent hover:text-white'}`}>Tracked Accounts</button>
                                <button onClick={() => setFeed('feed')} className={`h-full border-b-2 ${feed === 'feed' ? 'border-[var(--term-accent)] text-white' : 'border-transparent hover:text-white'}`}>X Feed</button>
                                <button className="ml-auto text-[var(--term-dim)] hover:text-white" aria-label="Mute feed"><SpeakerXMarkIcon className="h-4 w-4" /></button>
                                <button className="ml-3 text-[var(--term-muted)] hover:text-white" aria-label="Feed settings"><Cog6ToothIcon className="h-4 w-4" /></button>
                                <button className="ml-2 flex h-7 items-center gap-1 rounded-md border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-[var(--term-buy)]"><BellIcon className="h-3.5 w-3.5" />On</button>
                                <button className="ml-2 flex h-7 items-center gap-1 rounded-md border border-[var(--term-border)] bg-[var(--term-raised)] px-2 hover:text-white"><AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />Filter</button>
                            </div>

                            <div className="min-h-0 flex-1 overflow-auto">
                                {feed === 'feed' ? (
                                    <div className="grid h-full min-h-[24rem] place-items-center px-8 text-center"><div><div className="text-xs text-[var(--term-muted)]">No connected X accounts</div><Link href="/integrations" className="mt-3 inline-flex rounded-full border border-[var(--term-border-strong)] bg-[var(--term-raised)] px-4 py-2 text-[10px] text-[var(--term-accent)] hover:bg-[var(--term-control)]">Open integrations</Link></div></div>
                                ) : current ? (
                                    <div>
                                        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--term-border)] px-4 py-3">
                                            <div className="min-w-0 flex-1"><div className="text-xs font-[500] text-white">{current.label || short(current.walletAddress)}</div><div className="mt-1 truncate text-[10px] text-[var(--term-dim)]">{current.backfillComplete ? `Checkpoint ${current.lastSlot?.toLocaleString() || 'ready'}` : `Indexing history · ${current.backfillPages} pages`}</div></div>
                                            <button disabled={busy} onClick={() => update(current)} className={iconClass} title={current.status === 'active' ? 'Pause' : 'Resume'}>{current.status === 'active' ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}</button>
                                            <button disabled={busy} onClick={() => remove(current)} className={`${iconClass} !border-[color-mix(in_srgb,var(--term-danger)_30%,transparent)] !text-[var(--term-danger)] hover:!bg-[color-mix(in_srgb,var(--term-danger)_10%,transparent)]`} title="Remove"><TrashIcon className="h-4 w-4" /></button>
                                        </div>
                                        <div className="grid grid-cols-2 border-b border-[var(--term-border)] md:grid-cols-4">
                                            <Metric label="Portfolio" value={portfolio ? microUsd(portfolio.marketValueMicroUsd) : '—'} note={portfolio ? `${portfolio.pricedAssets} priced · ${portfolio.unpricedAssets} unpriced` : 'Loading marks'} />
                                            <Metric label="Known cost" value={portfolio ? microUsd(portfolio.costMicroUsd) : '—'} />
                                            <Metric label="Realized" value={portfolio ? microUsd(portfolio.realizedPnlMicroUsd) : '—'} valueClass={portfolio ? tone(portfolio.realizedPnlMicroUsd) : 'text-[var(--term-dim)]'} />
                                            <Metric label="Unrealized" value={portfolio?.unrealizedPnlMicroUsd ? microUsd(portfolio.unrealizedPnlMicroUsd) : 'Incomplete'} valueClass={portfolio?.unrealizedPnlMicroUsd ? tone(portfolio.unrealizedPnlMicroUsd) : 'text-[var(--term-dim)]'} />
                                        </div>
                                        <div className="min-w-[35rem]">
                                            <div className="grid grid-cols-[minmax(9rem,1fr)_7.5rem_7.5rem_7.5rem] border-b border-[var(--term-border)] px-4 py-2.5 text-[9px] uppercase tracking-[.12em] text-[var(--term-dim)]"><span>Token</span><span className="text-right">Value</span><span className="text-right">Cost</span><span className="text-right">Realized</span></div>
                                            <div className="divide-y divide-[var(--term-border)]">
                                                {(portfolio?.positions || []).map((position) => <Link key={position.tokenMint} href={`/trade/${position.tokenMint}`} className="grid grid-cols-[minmax(9rem,1fr)_7.5rem_7.5rem_7.5rem] items-center px-4 py-3 text-xs transition-colors hover:bg-[var(--term-raised)]"><span className="truncate font-mono text-[var(--term-text)]">{short(position.tokenMint)}</span><span className="text-right tabular-nums text-[var(--term-muted)]">{position.currentValueMicroUsd ? microUsd(position.currentValueMicroUsd) : '—'}</span><span className="text-right tabular-nums text-[var(--term-muted)]">{microUsd(position.costMicroUsd)}</span><span className={`text-right tabular-nums ${tone(position.realizedPnlMicroUsd)}`}>{microUsd(position.realizedPnlMicroUsd)}</span></Link>)}
                                                {!portfolio?.positions.length && <div className="px-5 py-20 text-center text-xs text-[var(--term-dim)]">No indexed positions yet</div>}
                                            </div>
                                        </div>
                                    </div>
                                ) : <div className="grid h-full min-h-[24rem] place-items-center text-xs text-[var(--term-dim)]">Select or add a wallet</div>}
                            </div>
                        </section>
                    </div>
                ) : (
                    <TrackerArea area={area} activity={activity} wallets={wallets} />
                )}
            </div>
        </DashboardLayout>
    );
}

function TrackerArea({ area, activity, wallets }: { area: Exclude<Area, 'wallets'>; activity: WalletActivity[]; wallets: TrackedWallet[] }) {
    const copy = area === 'kols'
        ? { title: 'KOL accounts', text: 'Add an X handle to organize tracked creators.', columns: ['Account', 'Followers', 'Last post', 'Actions'] }
        : area === 'trades'
            ? { title: 'Live wallet trades', text: 'Trades from active tracked wallets appear here as they are indexed.', columns: ['Age', 'Wallet', 'Side', 'Token', 'Amount', 'Value'] }
            : { title: 'Wallet transfers', text: 'Transfers for active tracked wallets appear here as they are indexed.', columns: ['Age', 'Wallet', 'Direction', 'Asset', 'Amount', 'Counterparty'] };

    const rows = area === 'trades' ? activity.filter((item) => item.kind === 'swap') : area === 'transfers' ? activity.filter((item) => item.kind !== 'swap') : [];
    const walletName = (id: string) => {
        const wallet = wallets.find((item) => item.id === id);
        return wallet?.label || (wallet ? short(wallet.walletAddress) : 'Wallet');
    };

    return (
        <section className="flex min-h-0 flex-1 flex-col bg-[var(--term-panel)]">
            <div className="flex h-11 shrink-0 items-center border-b border-[var(--term-border)] px-4">
                <span className="text-xs font-[500] text-white">{copy.title}</span>
                {area === 'kols' && <label className="ml-4 flex h-7 w-[min(22rem,45vw)] items-center rounded-full border border-[var(--term-border)] bg-transparent px-3 focus-within:border-[var(--term-border-strong)]"><MagnifyingGlassIcon className="h-3.5 w-3.5 text-[var(--term-dim)]" /><input className="min-w-0 flex-1 appearance-none border-0 !bg-transparent pl-2 text-[10px] text-white !shadow-none outline-none placeholder:text-[var(--term-dim)] focus:border-transparent focus:outline-none focus:ring-0" placeholder="Search handle or name" /></label>}
                <button className="ml-auto flex h-7 items-center gap-1 rounded-md border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-[10px] text-[var(--term-muted)] hover:text-white"><AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />Filter</button>
                {area === 'kols' && <button className="ml-2 flex h-7 items-center gap-1 rounded-full bg-[var(--term-accent)] px-3 text-[10px] font-[600] text-[#111114]"><PlusIcon className="h-3.5 w-3.5" />Add KOL</button>}
            </div>
            <div className={`grid shrink-0 border-b border-[var(--term-border)] px-4 py-2.5 text-[9px] uppercase tracking-[.12em] text-[var(--term-dim)] ${copy.columns.length === 4 ? 'grid-cols-[minmax(12rem,1fr)_8rem_8rem_6rem]' : 'grid-cols-[5rem_minmax(10rem,1fr)_6rem_minmax(9rem,1fr)_8rem_10rem]'}`}>
                {copy.columns.map((column, index) => <span key={column} className={index > 1 ? 'text-right' : ''}>{column}</span>)}
            </div>
            {rows.length ? (
                <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-[var(--term-border)]">
                    {rows.map((item) => (
                        <div key={item.id} className="grid min-h-12 grid-cols-[5rem_minmax(10rem,1fr)_6rem_minmax(9rem,1fr)_8rem_10rem] items-center px-4 text-[10px] text-[var(--term-muted)] hover:bg-[var(--term-raised)]">
                            <span>{activityAge(item.occurredAt)}</span>
                            <span className="truncate text-white">{walletName(item.trackedWalletId)}</span>
                            <span className={item.side === 'buy' || item.kind === 'transfer_in' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{item.side || (item.kind === 'transfer_in' ? 'In' : 'Out')}</span>
                            {item.tokenMint ? <Link href={`/trade/${item.tokenMint}`} className="truncate font-mono text-[var(--term-text)] hover:text-white">{short(item.tokenMint)}</Link> : <span>—</span>}
                            <span className="text-right tabular-nums">{item.quantityBase ? compactBase(item.quantityBase) : '—'}</span>
                            <span className="truncate text-right tabular-nums">{item.valueMicroUsd ? microUsd(item.valueMicroUsd) : short(item.signature)}</span>
                        </div>
                    ))}
                </div>
            ) : <div className="grid min-h-[24rem] flex-1 place-items-center px-6 text-[11px] text-[var(--term-dim)]">{area === 'kols' ? 'No tracked KOLs' : 'No activity to show'}</div>}
        </section>
    );
}

function activityAge(value: string): string {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
}

function compactBase(value: string): string {
    const amount = Number(value);
    return Number.isFinite(amount) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(amount) : '—';
}

function Metric({ label, value, note, valueClass = 'text-white' }: { label: string; value: string; note?: string; valueClass?: string }) {
    return <div className="min-h-[5.3rem] border-b border-r border-[var(--term-border)] p-3 md:border-b-0"><div className="text-[9px] uppercase tracking-[.12em] text-[var(--term-dim)]">{label}</div><div className={`mt-2 text-sm tabular-nums ${valueClass}`}>{value}</div>{note && <div className="mt-1 text-[9px] text-[var(--term-dim)]">{note}</div>}</div>;
}

export default function TrackerPage() {
    return <Suspense fallback={<main data-terminal-theme="terminal" className="grid h-full place-items-center bg-[var(--term-bg)]"><div className="spinner" /></main>}><TrackerContent /></Suspense>;
}
