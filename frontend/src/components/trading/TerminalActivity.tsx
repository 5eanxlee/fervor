'use client';

import Image from 'next/image';
import { memo, useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
    ArrowUpIcon,
    ArrowPathIcon,
    BoltIcon,
    ChevronDownIcon,
    ChevronUpDownIcon,
    ChevronUpIcon,
    CubeTransparentIcon,
    FunnelIcon,
    MagnifyingGlassIcon,
    UserGroupIcon,
} from '@heroicons/react/24/outline';
import {
    apiService,
    OrderRecord,
    TokenHolders,
    TrackedWallet,
    WalletPosition,
} from '../../services/api';
import {
    replayParticipantStats,
    type ReplayParticipant,
    type ReplayParticipantStats,
    type ReplayParticipants,
} from '../../services/replay';
import { SolanaMark } from './BrandMarks';

export type ActivityTab = 'trades' | 'positions' | 'orders' | 'holders' | 'top' | 'dev';

export interface ActivityTrade {
    id: string;
    side: 'buy' | 'sell';
    maker?: string;
    usdAmount?: number;
    tokenAmount?: number;
    priceUsd?: number;
    marketCapUsd?: number;
    solAmount?: number;
    observedAt: string;
}

type PositionRow = WalletPosition & Pick<TrackedWallet, 'walletAddress' | 'label'>;
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const openStates = new Set([
    'preparing', 'prepared', 'activating', 'open', 'executing', 'partially_filled', 'cancel_pending',
]);

const compact = (value?: number): string => {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
};

const money = (value?: number): string => {
    if (value === undefined || !Number.isFinite(value)) return '—';
    if (value === 0) return '$0';
    return Math.abs(value) >= 1 ? `$${compact(value)}` : `$${value.toPrecision(5)}`;
};

const signedMoney = (value?: number): string => value === undefined || !Number.isFinite(value)
    ? '—'
    : `${value >= 0 ? '+' : '-'}${money(Math.abs(value))}`;

const shortAddress = (value?: string): string => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';
const whole = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);

function CandleMark({ className = '' }: { className?: string }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 18 18" fill="none" className={className}>
            <path d="M5 1.5v3m0 8v4m8-15v6m0 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <rect x="2.5" y="4.5" width="5" height="8" rx=".75" stroke="currentColor" strokeWidth="1.5" />
            <rect x="10.5" y="7.5" width="5" height="5" rx=".75" stroke="currentColor" strokeWidth="1.5" />
        </svg>
    );
}

export const elapsedLabel = (seconds: number): string => {
    const value = Math.max(0, Math.floor(seconds));
    if (value < 60) return `${value}s`;
    if (value < 3_600) return `${Math.floor(value / 60)}m`;
    if (value < 86_400) return `${Math.floor(value / 3_600)}h`;
    return `${Math.floor(value / 86_400)}d`;
};
const microUsd = (value?: string): number | undefined => value === undefined ? undefined : Number(value) / 1_000_000;
const amount = (value: string, decimals: number): number => Number(value) / 10 ** decimals;
const param = (order: OrderRecord, key: string): number | undefined => {
    const value = Number(order.params[key]);
    return Number.isFinite(value) ? value : undefined;
};

type SortDir = 'asc' | 'desc';
type SortValue = bigint | number | string | null | undefined;
type SortState<Key extends string> = { key: Key; dir: SortDir };
type HeadCell<Key extends string> = {
    label: string;
    key?: Key;
    align?: 'left' | 'center' | 'right';
    dir?: SortDir;
};

const compare = (left: SortValue, right: SortValue): number => {
    if (left === right) return 0;
    if (left === undefined || left === null || left === '') return 1;
    if (right === undefined || right === null || right === '') return -1;
    if (typeof left === 'bigint' && typeof right === 'bigint') return left > right ? 1 : -1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
};

const sorted = <Row, Key extends string>(
    rows: readonly Row[],
    sort: SortState<Key>,
    value: (row: Row, key: Key) => SortValue
): Row[] => rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const order = compare(value(left.row, sort.key), value(right.row, sort.key));
    return order === 0 ? left.index - right.index : sort.dir === 'asc' ? order : -order;
}).map(({ row }) => row);

const chooseSort = <Key extends string>(
    setSort: Dispatch<SetStateAction<SortState<Key>>>,
    key: Key,
    dir: SortDir
) => setSort((current) => current.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir });

export const matchesToken = (order: OrderRecord, tokenMint: string): boolean =>
    order.inputMint === tokenMint || order.outputMint === tokenMint || order.triggerMint === tokenMint;

export const orderSide = (order: OrderRecord, tokenMint: string): 'buy' | 'sell' =>
    order.outputMint === tokenMint ? 'buy' : 'sell';

function TerminalActivity({
    tokenMint,
    tokenDecimals,
    trades,
    initialTab = 'trades',
    onInstantTrade,
    now,
    replayParticipants,
    replayMode = false,
    priceUsd,
    onWalletTrades,
}: {
    tokenMint: string;
    tokenDecimals: number;
    trades: ActivityTrade[];
    initialTab?: ActivityTab;
    onInstantTrade?: () => void;
    now?: string | null;
    replayParticipants?: ReplayParticipants;
    replayMode?: boolean;
    priceUsd?: number;
    onWalletTrades?: (wallet: string) => ActivityTrade[];
}) {
    const [tab, setTab] = useState<ActivityTab>(initialTab);
    const [positions, setPositions] = useState<PositionRow[]>([]);
    const [orders, setOrders] = useState<OrderRecord[]>([]);
    const [holders, setHolders] = useState<TokenHolders>();
    const [positionState, setPositionState] = useState<LoadState>('idle');
    const [orderState, setOrderState] = useState<LoadState>('idle');
    const [holderState, setHolderState] = useState<LoadState>('idle');
    const [orderView, setOrderView] = useState<'open' | 'history'>('open');
    const [walletFilter, setWalletFilter] = useState<string>();
    const [walletHistory, setWalletHistory] = useState<ActivityTrade[]>([]);

    const loadPositions = useCallback(async () => {
        setPositionState('loading');
        try {
            const walletResponse = await apiService.listTrackedWallets();
            const wallets = walletResponse.data || [];
            const responses = await Promise.all(wallets.map(async (wallet) => ({
                wallet,
                response: await apiService.getWalletPositions(wallet.id),
            })));
            setPositions(responses.flatMap(({ wallet, response }) => (response.data || [])
                .filter((position) => position.tokenMint === tokenMint)
                .map((position) => ({
                    ...position,
                    walletAddress: wallet.walletAddress,
                    label: wallet.label,
                }))));
            setPositionState('ready');
        } catch {
            setPositionState('error');
        }
    }, [tokenMint]);

    const loadOrders = useCallback(async () => {
        setOrderState('loading');
        try {
            const response = await apiService.listOrders();
            setOrders((response.data || []).filter((order) => matchesToken(order, tokenMint)));
            setOrderState('ready');
        } catch {
            setOrderState('error');
        }
    }, [tokenMint]);

    const loadHolders = useCallback(async () => {
        setHolderState('loading');
        try {
            const response = await apiService.getTokenHolders(tokenMint);
            if (!response.data) throw new Error(response.error || 'Holder data unavailable');
            setHolders(response.data);
            setHolderState('ready');
        } catch {
            setHolderState('error');
        }
    }, [tokenMint]);

    useEffect(() => {
        if (tab === 'positions' && positionState === 'idle') void loadPositions();
        if (tab === 'orders' && orderState === 'idle') void loadOrders();
        if (!replayMode && tab === 'holders' && holderState === 'idle') void loadHolders();
    }, [holderState, loadHolders, loadOrders, loadPositions, orderState, positionState, replayMode, tab]);

    const visibleOrders = useMemo(() => orders.filter((order) =>
        orderView === 'open' ? openStates.has(order.state) : !openStates.has(order.state)
    ), [orderView, orders]);
    const holderTotal = replayMode ? replayParticipants?.holderCount : holders?.total;
    const canRefresh = tab !== 'trades'
        && (!replayMode || (tab !== 'holders' && tab !== 'top'));

    const chooseTab = (next: ActivityTab) => {
        setTab(next);
        const url = new URL(window.location.href);
        if (next === 'trades') url.searchParams.delete('tab');
        else url.searchParams.set('tab', next);
        window.history.replaceState(null, '', url);
    };

    const filterWallet = (wallet: string) => {
        setWalletFilter(wallet);
        setWalletHistory(onWalletTrades?.(wallet) ?? trades.filter((trade) => trade.maker === wallet));
        chooseTab('trades');
        const url = new URL(window.location.href);
        url.searchParams.set('wallet', wallet);
        window.history.replaceState(null, '', url);
    };

    const clearWallet = () => {
        setWalletFilter(undefined);
        setWalletHistory([]);
        const url = new URL(window.location.href);
        url.searchParams.delete('wallet');
        window.history.replaceState(null, '', url);
    };

    const filteredTrades = useMemo(() => {
        if (!walletFilter) return trades;
        const values = new Map(walletHistory.map((trade) => [trade.id, trade]));
        for (const trade of trades) {
            if (trade.maker === walletFilter) values.set(trade.id, trade);
        }
        return Array.from(values.values());
    }, [trades, walletFilter, walletHistory]);

    const refresh = () => {
        if (tab === 'positions') void loadPositions();
        if (tab === 'orders') void loadOrders();
        if (tab === 'holders' && !replayMode) void loadHolders();
    };

    const tabs: Array<{ id: ActivityTab; label: string }> = [
        { id: 'trades', label: 'Trades' },
        { id: 'positions', label: 'Positions' },
        { id: 'orders', label: 'Orders' },
        { id: 'holders', label: `Holders${holderTotal === undefined ? '' : ` (${whole(holderTotal)})`}` },
        { id: 'top', label: 'Top Traders' },
        { id: 'dev', label: 'Dev Tokens' },
    ];

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--term-bg)]">
            <div role="tablist" aria-label="Token activity" className="activity-tabs flex shrink-0 items-center overflow-x-auto border-b border-[var(--term-border)] text-[clamp(.64rem,.8vw,.78rem)]">
                {tabs.map((item) => (
                    <button
                        key={item.id}
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => chooseTab(item.id)}
                        className={`activity-tab relative h-full shrink-0 px-[clamp(.75rem,1.3vw,1.25rem)] ${tab === item.id ? 'text-[var(--term-accent)]' : 'text-[var(--term-muted)] hover:text-white'}`}
                    >
                        {item.label}
                    </button>
                ))}
                <div className="ml-auto hidden h-full shrink-0 items-center gap-1 px-2 xl:flex">
                    {['All', 'Mine', 'Dev', 'KOL'].map((label) => <button key={label} className={`h-6 rounded-full px-2.5 text-[10px] ${label === 'All' ? 'bg-[color-mix(in_srgb,var(--term-accent)_18%,transparent)] text-[var(--term-accent)]' : 'text-[var(--term-muted)] hover:text-white'}`}>{label}</button>)}
                    <button onClick={onInstantTrade} className="ml-1 flex h-6 items-center gap-1 rounded-full border border-[var(--term-accent)]/50 px-2.5 text-[10px] text-[var(--term-accent)]"><BoltIcon className="h-3 w-3" />Instant trade</button>
                    <button className="grid h-7 w-7 place-items-center text-[var(--term-muted)] hover:text-white" aria-label="Activity filters"><FunnelIcon className="h-3.5 w-3.5" /></button>
                    {canRefresh && <button onClick={refresh} className="grid h-7 w-7 place-items-center text-[var(--term-muted)] hover:text-white" aria-label={`Refresh ${tab}`}><ArrowPathIcon className="h-3.5 w-3.5" /></button>}
                </div>
            </div>

            {tab === 'trades' && <TradeTable trades={filteredTrades} now={now} wallet={walletFilter} onClear={clearWallet} />}
            {tab === 'positions' && <PositionTable rows={positions} state={positionState} />}
            {tab === 'orders' && (
                <OrderTable
                    rows={visibleOrders}
                    state={orderState}
                    tokenMint={tokenMint}
                    tokenDecimals={tokenDecimals}
                    view={orderView}
                    setView={setOrderView}
                    openCount={orders.filter((order) => openStates.has(order.state)).length}
                />
            )}
            {tab === 'holders' && (replayMode
                ? <ReplayHolderTable data={replayParticipants} priceUsd={priceUsd} onFilter={filterWallet} />
                : <HolderTable data={holders} state={holderState} />)}
            {tab === 'top' && (replayMode
                ? <ReplayTopTable data={replayParticipants} priceUsd={priceUsd} onFilter={filterWallet} />
                : <TopTable trades={trades} />)}
            {tab === 'dev' && <DevTable tokenMint={tokenMint} />}
        </div>
    );
}

function TradeTable({ trades, now, wallet, onClear }: {
    trades: ActivityTrade[];
    now?: string | null;
    wallet?: string;
    onClear: () => void;
}) {
    const clock = now ? new Date(now).getTime() : Date.now();
    type Key = 'time' | 'side' | 'mcap' | 'amount' | 'usd' | 'maker';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'time', dir: 'desc' });
    const rows = sorted(trades, sort, (row, key) => {
        if (key === 'time') return Date.parse(row.observedAt);
        if (key === 'side') return row.side;
        if (key === 'mcap') return row.marketCapUsd;
        if (key === 'amount') return row.tokenAmount;
        if (key === 'usd') return row.usdAmount;
        return row.maker;
    });
    return (
        <>
            {wallet && (
                <div className="flex h-8 shrink-0 items-center border-b border-[var(--term-border)] px-3 text-[10px] text-[var(--term-muted)]">
                    <FunnelIcon className="mr-1.5 h-3.5 w-3.5 text-[var(--term-accent)]" />
                    Trades by <span className="ml-1 text-[var(--term-text)]">{shortAddress(wallet)}</span>
                    <button type="button" onClick={onClear} className="ml-2 text-[var(--term-accent)] hover:text-white">Clear</button>
                </div>
            )}
            <TableHead columns="grid-cols-[80px_80px_1fr_1fr_1fr_150px]" cells={[
                { label: 'Age', key: 'time', align: 'center' },
                { label: 'Side', key: 'side', align: 'center', dir: 'asc' },
                { label: 'MCap', key: 'mcap', align: 'center' },
                { label: 'Amount', key: 'amount', align: 'center' },
                { label: 'Total USD', key: 'usd', align: 'center' },
                { label: 'Trader', key: 'maker', align: 'center', dir: 'asc' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((trade) => (
                    <div key={trade.id} className="activity-row trade-row grid grid-cols-[80px_80px_1fr_1fr_1fr_150px] items-center border-b border-[var(--term-border)] px-3 text-center text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{elapsedLabel((clock - new Date(trade.observedAt).getTime()) / 1_000)}</span>
                        <span className={trade.side === 'buy' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{trade.side === 'buy' ? 'Buy' : 'Sell'}</span>
                        <span>{money(trade.marketCapUsd)}</span>
                        <span>{compact(trade.tokenAmount)}</span>
                        <span className={trade.side === 'buy' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{money(trade.usdAmount)}</span>
                        <span className="flex min-w-0 items-center justify-center gap-1.5 text-[var(--term-muted)]">
                            <span className="truncate">{shortAddress(trade.maker)}</span>
                            {trade.maker && (
                                <a href={`https://solscan.io/account/${trade.maker}`} target="_blank" rel="noreferrer" className="shrink-0 opacity-75 hover:opacity-100" aria-label={`Open ${shortAddress(trade.maker)} on Solscan`} title="Open wallet on Solscan">
                                    <Image src="/solscan.svg" alt="" width={14} height={14} />
                                </a>
                            )}
                        </span>
                    </div>
                ))}
                {!trades.length && <Empty text={wallet ? 'No trades from this wallet at the current replay cut' : 'Waiting for live trades'} />}
            </div>
        </>
    );
}

function PositionTable({ rows, state }: { rows: PositionRow[]; state: LoadState }) {
    type Key = 'asset' | 'wallet' | 'cost' | 'remaining' | 'pnl' | 'pnlPct' | 'time';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'time', dir: 'desc' });
    const values = sorted(rows, sort, (row, key) => {
        const cost = microUsd(row.costMicroUsd) || 0;
        const remaining = microUsd(row.currentValueMicroUsd);
        const pnl = microUsd(row.unrealizedPnlMicroUsd) ?? microUsd(row.realizedPnlMicroUsd) ?? 0;
        if (key === 'asset') return amount(row.quantityBase, row.tokenDecimals);
        if (key === 'wallet') return row.label || row.walletAddress;
        if (key === 'cost') return cost;
        if (key === 'remaining') return remaining;
        if (key === 'pnl') return pnl;
        if (key === 'pnlPct') return cost > 0 ? pnl / cost : undefined;
        return Date.parse(row.updatedAt);
    });
    return (
        <>
            <TableHead columns="grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_110px]" cells={[
                { label: 'Asset', key: 'asset' }, { label: 'Wallet', key: 'wallet', dir: 'asc' },
                { label: 'Cost', key: 'cost' }, { label: 'Remaining', key: 'remaining' },
                { label: 'PnL', key: 'pnl' }, { label: 'PnL %', key: 'pnlPct' },
                { label: 'Activity', key: 'time', align: 'right' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {values.map((row) => {
                    const cost = microUsd(row.costMicroUsd) || 0;
                    const remaining = microUsd(row.currentValueMicroUsd);
                    const pnl = microUsd(row.unrealizedPnlMicroUsd) ?? microUsd(row.realizedPnlMicroUsd) ?? 0;
                    return (
                        <div key={`${row.trackedWalletId}:${row.tokenMint}`} className="activity-row grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_110px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                            <span>{compact(amount(row.quantityBase, row.tokenDecimals))}</span>
                            <span className="truncate text-[var(--term-muted)]">{row.label || shortAddress(row.walletAddress)}</span>
                            <span>{money(cost)}</span><span>{money(remaining)}</span>
                            <span className={pnl >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{money(pnl)}</span>
                            <span className={pnl >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{cost > 0 ? `${(pnl / cost * 100).toFixed(2)}%` : '—'}</span>
                            <span className="text-right text-[var(--term-dim)]">{new Date(row.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                    );
                })}
                {!rows.length && <StateEmpty state={state} empty="No position for this token" error="Portfolio data unavailable" />}
            </div>
        </>
    );
}

function OrderTable({ rows, state, tokenMint, tokenDecimals, view, setView, openCount }: {
    rows: OrderRecord[];
    state: LoadState;
    tokenMint: string;
    tokenDecimals: number;
    view: 'open' | 'history';
    setView: (view: 'open' | 'history') => void;
    openCount: number;
}) {
    type Key = 'date' | 'wallet' | 'type' | 'side' | 'price' | 'amount' | 'updated' | 'status';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'updated', dir: 'desc' });
    const values = sorted(rows, sort, (row, key) => {
        const side = orderSide(row, tokenMint);
        if (key === 'date' || key === 'updated') return Date.parse(row.createdAt);
        if (key === 'wallet') return row.walletAddress;
        if (key === 'type') return row.orderType;
        if (key === 'side') return side;
        if (key === 'price') return param(row, 'triggerPriceUsd') ?? param(row, 'takeProfitPriceUsd');
        if (key === 'amount') return Number(row.inputAmount) / 10 ** (side === 'buy' ? 9 : tokenDecimals);
        return row.state;
    });
    return (
        <>
            <div className="flex h-8 items-center border-b border-[var(--term-border)] px-3 text-[10px]">
                <button onClick={() => setView('open')} className={`mr-3 ${view === 'open' ? 'text-white' : 'text-[var(--term-muted)]'}`}>Open ({openCount})</button>
                <button onClick={() => setView('history')} className={view === 'history' ? 'text-white' : 'text-[var(--term-muted)]'}>Historical</button>
            </div>
            <TableHead columns="grid-cols-[90px_90px_70px_70px_1fr_1fr_95px_100px]" cells={[
                { label: 'Date', key: 'date' }, { label: 'Wallet', key: 'wallet', dir: 'asc' },
                { label: 'Type', key: 'type', dir: 'asc' }, { label: 'Side', key: 'side', dir: 'asc' },
                { label: 'Price', key: 'price' }, { label: 'Amount', key: 'amount' },
                { label: 'Updated', key: 'updated' }, { label: 'Status', key: 'status', dir: 'asc' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {values.map((order) => {
                    const side = orderSide(order, tokenMint);
                    const price = param(order, 'triggerPriceUsd') ?? param(order, 'takeProfitPriceUsd');
                    const displayAmount = Number(order.inputAmount) / 10 ** (side === 'buy' ? 9 : tokenDecimals);
                    return (
                        <div key={order.id} className="activity-row grid grid-cols-[90px_90px_70px_70px_1fr_1fr_95px_100px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                            <span className="text-[var(--term-dim)]">{new Date(order.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                            <span className="text-[var(--term-muted)]">{shortAddress(order.walletAddress)}</span>
                            <span className="uppercase text-[var(--term-muted)]">{order.orderType}</span>
                            <span className={side === 'buy' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{side === 'buy' ? 'Buy' : 'Sell'}</span>
                            <span>{money(price)}</span><span>{compact(displayAmount)}</span>
                            <span className="text-[var(--term-dim)]">{new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="truncate capitalize text-[var(--term-muted)]">{order.state.replace(/_/g, ' ')}</span>
                        </div>
                    );
                })}
                {!rows.length && <StateEmpty state={state} empty={`No ${view} orders for this token`} error="Order history unavailable" />}
            </div>
        </>
    );
}

type ParticipantMode = 'holders' | 'top';
type ParticipantKey = 'rank' | 'wallet' | 'sol' | 'bought' | 'sold' | 'pnl' | 'remaining' | 'held';
type ParticipantRow = { row: ReplayParticipant; stats: ReplayParticipantStats };

const participantCols = 'grid-cols-[36px_minmax(190px,1.4fr)_minmax(125px,.85fr)_minmax(165px,1.05fr)_minmax(165px,1.05fr)_minmax(110px,.72fr)_minmax(160px,1fr)_minmax(135px,.85fr)_65px_38px]';

function ReplayHolderTable({ data, priceUsd, onFilter }: {
    data?: ReplayParticipants;
    priceUsd?: number;
    onFilter: (wallet: string) => void;
}) {
    return <ReplayParticipantTable mode="holders" data={data} priceUsd={priceUsd} onFilter={onFilter} />;
}

function ReplayTopTable({ data, priceUsd, onFilter }: {
    data?: ReplayParticipants;
    priceUsd?: number;
    onFilter: (wallet: string) => void;
}) {
    return <ReplayParticipantTable mode="top" data={data} priceUsd={priceUsd} onFilter={onFilter} />;
}

function ReplayParticipantTable({ mode, data, priceUsd, onFilter }: {
    mode: ParticipantMode;
    data?: ReplayParticipants;
    priceUsd?: number;
    onFilter: (wallet: string) => void;
}) {
    const [sort, setSort] = useState<SortState<ParticipantKey>>({ key: 'rank', dir: 'asc' });
    if (!data) return <Empty text={mode === 'holders' ? 'Building the replay holder ledger…' : 'Building the replay trader rankings…'} />;

    const values: ParticipantRow[] = data.items.map((row) => ({
        row,
        stats: replayParticipantStats(row, data, priceUsd),
    })).filter(({ stats }) => mode === 'top' || stats.remainingTokens > 0);
    const ranked = [...values].sort((left, right) => {
        const value = mode === 'holders'
            ? right.stats.remainingTokens - left.stats.remainingTokens
            : right.stats.realizedPnlUsd - left.stats.realizedPnlUsd;
        return value || left.row.wallet.localeCompare(right.row.wallet);
    });
    const ranks = new Map(ranked.map(({ row }, index) => [row.wallet, index + 1]));
    const rows = sorted(ranked, sort, ({ row, stats }, key) => {
        if (key === 'rank') return ranks.get(row.wallet);
        if (key === 'wallet') return row.wallet;
        if (key === 'sol') return stats.solFlow;
        if (key === 'bought') return row.boughtUsd;
        if (key === 'sold') return row.soldUsd;
        if (key === 'pnl') return mode === 'holders' ? stats.unrealizedPnlUsd : stats.realizedPnlUsd;
        if (key === 'remaining') return stats.currentValueUsd ?? stats.remainingTokens;
        return stats.heldSeconds;
    }).slice(0, 100);

    return (
        <div className="min-h-0 flex-1 overflow-auto">
            <div className="min-w-[1180px]">
                <TableHead className="participant-head sticky top-0 z-10 bg-[var(--term-bg)]" columns={participantCols} cells={[
                    { label: '#', key: 'rank', dir: 'asc' },
                    { label: 'Wallet', key: 'wallet', dir: 'asc' },
                    { label: 'SOL Volume (Last Active)', key: 'sol' },
                    { label: 'Bought (Avg Buy)', key: 'bought' },
                    { label: 'Sold (Avg Sell)', key: 'sold' },
                    { label: mode === 'holders' ? 'U. PnL' : 'R. PnL', key: 'pnl' },
                    { label: 'Remaining', key: 'remaining' },
                    { label: 'Funding' },
                    { label: 'Held', key: 'held' },
                    { label: '' },
                ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
                <div>
                    {rows.map(({ row, stats }) => (
                        <ReplayParticipantRow
                            key={row.wallet}
                            row={row}
                            stats={stats}
                            rank={ranks.get(row.wallet) || 0}
                            pnl={mode === 'holders' ? stats.unrealizedPnlUsd : stats.realizedPnlUsd}
                            onFilter={onFilter}
                        />
                    ))}
                    {!rows.length && <Empty text={mode === 'holders' ? 'No positive replay balances at this point' : 'Top traders will appear with replay activity'} />}
                </div>
            </div>
        </div>
    );
}

function ReplayParticipantRow({ row, stats, rank, pnl, onFilter }: {
    row: ReplayParticipant;
    stats: ReplayParticipantStats;
    rank: number;
    pnl?: number;
    onFilter: (wallet: string) => void;
}) {
    const walletUrl = `https://solscan.io/account/${row.wallet}`;
    const percent = stats.remainingPercent === 0
        ? '0%'
        : `${stats.remainingPercent.toFixed(stats.remainingPercent < 10 ? 3 : 2)}%`;
    return (
        <div className={`activity-row participant-row grid ${participantCols} items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums`}>
            <span className="text-[var(--term-dim)]">{rank}</span>
            <span className="flex min-w-0 items-center gap-1.5">
                <button type="button" onClick={() => onFilter(row.wallet)} aria-label={`Filter trades by ${shortAddress(row.wallet)}`} className="text-[var(--term-muted)] hover:text-white"><FunnelIcon className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => onFilter(row.wallet)} aria-label={`Inspect ${shortAddress(row.wallet)} trades`} className="grid h-6 w-6 shrink-0 place-items-center text-[var(--term-text)] hover:text-white"><MagnifyingGlassIcon className="h-3.5 w-3.5 stroke-[2.5]" /></button>
                <a href={walletUrl} target="_blank" rel="noreferrer" className="truncate font-medium text-[var(--term-text)] hover:text-white">{shortAddress(row.wallet)}</a>
                <span className="shrink-0 rounded bg-[var(--term-raised)] px-1.5 py-0.5 text-[10px] text-[var(--term-muted)]">{row.tradeCount > 99 ? '99+' : row.tradeCount}</span>
                <span className="flex shrink-0 items-center gap-0.5" title={`${row.buyCount} buys · ${row.sellCount} sells`}><CubeTransparentIcon className="h-3.5 w-3.5 text-[var(--term-sell)]" /><CandleMark className="h-3.5 w-3.5 text-[var(--term-muted)]" /></span>
            </span>
            <span className="flex items-center gap-1.5 text-[var(--term-text)]"><SolanaMark className="h-3.5 w-3.5 shrink-0" /><span>{compact(stats.solFlow)}</span><span className="text-[var(--term-dim)]">({elapsedLabel(stats.lastActiveSeconds)})</span></span>
            <TradeMetric value={money(row.boughtUsd)} average={money(stats.avgBuyMcapUsd)} amount={compact(stats.boughtTokens)} count={row.buyCount} tone="buy" />
            <TradeMetric value={money(row.soldUsd)} average={money(stats.avgSellMcapUsd)} amount={compact(stats.soldTokens)} count={row.sellCount} tone="sell" />
            <span className={pnl === undefined || pnl >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{signedMoney(pnl)}</span>
            <span className="min-w-0 pr-3">
                <span className="flex items-center gap-2"><span>{money(stats.currentValueUsd)}</span><span className="rounded bg-[var(--term-raised)] px-1.5 py-0.5 text-[10px] text-[var(--term-text)]">{percent}</span></span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-[var(--term-raised)]"><span className="block h-full rounded-full bg-[#526fff]" style={{ width: `${Math.min(100, Math.max(0, stats.remainingPercent))}%` }} /></span>
            </span>
            <span className="flex min-w-0 items-center gap-2 text-[var(--term-muted)]" title="Funding source is not included in the verified replay tape"><ArrowUpIcon className="h-4 w-4 shrink-0" /><span className="min-w-0"><span className="block">—</span><span className="block truncate text-[9px] text-[var(--term-dim)]">Not observed</span></span></span>
            <span className="text-[#6482ff]">{elapsedLabel(stats.heldSeconds)}</span>
            <a href={walletUrl} target="_blank" rel="noreferrer" className="grid h-7 w-7 place-items-center opacity-75 hover:opacity-100" aria-label={`Open ${shortAddress(row.wallet)} on Solscan`}><Image src="/solscan.svg" alt="" width={14} height={14} /></a>
        </div>
    );
}

function TradeMetric({ value, average, amount: tokenAmount, count, tone }: {
    value: string;
    average: string;
    amount: string;
    count: number;
    tone: 'buy' | 'sell';
}) {
    const color = tone === 'buy' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]';
    return <span className="min-w-0"><span className={`flex items-center gap-2 ${color}`}><span>{value}</span><span className="truncate opacity-80">({average})</span></span><span className="mt-0.5 block text-[9px] text-[var(--term-dim)]">{tokenAmount} / {count}</span></span>;
}

function HolderTable({ data, state }: { data?: TokenHolders; state: LoadState }) {
    type Key = 'rank' | 'wallet' | 'balance' | 'supply' | 'value' | 'avgBuy' | 'time';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'rank', dir: 'asc' });
    const ranked = data?.items ?? [];
    const ranks = new Map(ranked.map((row, index) => [row.owner, index + 1]));
    const rows = sorted(ranked, sort, (row, key) => {
        if (key === 'rank') return ranks.get(row.owner);
        if (key === 'wallet') return row.owner;
        if (key === 'balance') return row.amount;
        if (key === 'supply') return row.supplyPercent;
        if (key === 'value') return row.amountUsd;
        if (key === 'avgBuy') return row.avgBuyPrice;
        return row.firstTradeAt ? Date.parse(row.firstTradeAt) : undefined;
    });
    return (
        <>
            <div className="flex h-8 items-center border-b border-[var(--term-border)] px-3 text-[10px] text-[var(--term-muted)]">
                <span>Wallet-grouped ownership</span>
                {data?.top10Percent !== undefined && <span className="ml-auto">Top 10: <span className="text-white">{data.top10Percent.toFixed(2)}%</span></span>}
            </div>
            <TableHead columns="grid-cols-[60px_1.2fr_1fr_1fr_1fr_1fr_110px]" cells={[
                { label: 'Rank', key: 'rank', dir: 'asc' }, { label: 'Address', key: 'wallet', dir: 'asc' },
                { label: 'Balance', key: 'balance' }, { label: 'Supply', key: 'supply' },
                { label: 'Value', key: 'value' }, { label: 'Avg buy', key: 'avgBuy' },
                { label: 'First trade', key: 'time', align: 'right', dir: 'asc' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((holder) => (
                    <div key={holder.owner} className="activity-row grid grid-cols-[60px_1.2fr_1fr_1fr_1fr_1fr_110px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{ranks.get(holder.owner)}</span><span>{shortAddress(holder.owner)}</span>
                        <span>{compact(holder.amount)}</span><span>{holder.supplyPercent === undefined ? '—' : `${holder.supplyPercent.toFixed(3)}%`}</span>
                        <span>{money(holder.amountUsd)}</span><span>{money(holder.avgBuyPrice)}</span>
                        <span className="text-right text-[var(--term-dim)]">{holder.firstTradeAt ? new Date(holder.firstTradeAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}</span>
                    </div>
                ))}
                {!rows.length && <StateEmpty state={state} empty="No holder rows returned" error="Holder provider unavailable" />}
            </div>
        </>
    );
}

function TopTable({ trades }: { trades: ActivityTrade[] }) {
    type Key = 'rank' | 'wallet' | 'volume' | 'bought' | 'sold' | 'net' | 'trades';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'rank', dir: 'asc' });
    const ranked = Array.from(trades.reduce((map, trade) => {
        const maker = trade.maker || 'Unknown';
        const current = map.get(maker) || { maker, trades: 0, volume: 0, bought: 0, sold: 0 };
        current.trades += 1;
        current.volume += trade.usdAmount || 0;
        if (trade.side === 'buy') current.bought += trade.usdAmount || 0;
        else current.sold += trade.usdAmount || 0;
        map.set(maker, current);
        return map;
    }, new Map<string, { maker: string; trades: number; volume: number; bought: number; sold: number }>()).values())
        .sort((left, right) => right.volume - left.volume);
    const ranks = new Map(ranked.map((row, index) => [row.maker, index + 1]));
    const rows = sorted(ranked, sort, (row, key) => {
        if (key === 'rank') return ranks.get(row.maker);
        if (key === 'wallet') return row.maker;
        if (key === 'volume') return row.volume;
        if (key === 'bought') return row.bought;
        if (key === 'sold') return row.sold;
        if (key === 'net') return row.bought - row.sold;
        return row.trades;
    }).slice(0, 50);
    return (
        <>
            <TableHead columns="grid-cols-[56px_1.3fr_1fr_1fr_1fr_1fr_80px]" cells={[
                { label: 'Rank', key: 'rank', dir: 'asc' }, { label: 'Trader', key: 'wallet', dir: 'asc' },
                { label: 'Volume', key: 'volume' }, { label: 'Bought', key: 'bought' },
                { label: 'Sold', key: 'sold' }, { label: 'Net', key: 'net' },
                { label: 'Trades', key: 'trades' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((row) => (
                    <div key={row.maker} className="activity-row grid grid-cols-[56px_1.3fr_1fr_1fr_1fr_1fr_80px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{ranks.get(row.maker)}</span>
                        <span className="flex items-center gap-1.5"><UserGroupIcon className="h-3.5 w-3.5 text-[var(--term-muted)]" />{shortAddress(row.maker)}</span>
                        <span>{money(row.volume)}</span><span className="text-[var(--term-buy)]">{money(row.bought)}</span><span className="text-[var(--term-sell)]">{money(row.sold)}</span>
                        <span className={row.bought - row.sold >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{money(row.bought - row.sold)}</span>
                        <span>{row.trades}</span>
                    </div>
                ))}
                {!rows.length && <Empty text="Top traders will appear with live activity" />}
            </div>
        </>
    );
}

function DevTable({ tokenMint }: { tokenMint: string }) {
    type Key = 'token' | 'relationship' | 'created' | 'mcap' | 'liquidity' | 'status';
    const [sort, setSort] = useState<SortState<Key>>({ key: 'token', dir: 'asc' });
    return (
        <>
            <TableHead columns="grid-cols-[1.4fr_1fr_1fr_1fr_1fr_100px]" cells={[
                { label: 'Token', key: 'token', dir: 'asc' },
                { label: 'Relationship', key: 'relationship', dir: 'asc' },
                { label: 'Created', key: 'created' }, { label: 'Market cap', key: 'mcap' },
                { label: 'Liquidity', key: 'liquidity' }, { label: 'Status', key: 'status', dir: 'asc' },
            ]} sort={sort} onSort={(key, dir) => chooseSort(setSort, key, dir)} />
            <div className="activity-row grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_100px] items-center border-b border-[var(--term-border)] px-3 text-[11px]">
                <span className="truncate text-[var(--term-text)]">{shortAddress(tokenMint)}</span>
                <span className="text-[var(--term-muted)]">Current token</span><span className="text-[var(--term-dim)]">—</span><span>—</span><span>—</span><span className="text-[var(--term-accent)]">Tracked</span>
            </div>
        </>
    );
}

function TableHead<Key extends string>({ columns, cells, sort, onSort, className = '' }: {
    columns: string;
    cells: HeadCell<Key>[];
    sort: SortState<Key>;
    onSort: (key: Key, dir: SortDir) => void;
    className?: string;
}) {
    return (
        <div role="row" className={`activity-head grid ${columns} shrink-0 items-center border-b border-[var(--term-border)] px-3 text-[10px] text-[var(--term-dim)] ${className}`}>
            {cells.map((cell, index) => {
                const active = cell.key !== undefined && sort.key === cell.key;
                const Icon = active
                    ? sort.dir === 'asc' ? ChevronUpIcon : ChevronDownIcon
                    : ChevronUpDownIcon;
                let align = 'justify-start text-left';
                if (cell.align === 'center') align = 'justify-center text-center';
                else if (cell.align === 'right' || (cell.align === undefined && index === cells.length - 1)) align = 'justify-end text-right';
                if (!cell.key) return <span key={`${cell.label}:${index}`} className={`flex items-center ${align}`}>{cell.label}</span>;
                return (
                    <button
                        key={`${cell.label}:${index}`}
                        type="button"
                        role="columnheader"
                        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        onClick={() => onSort(cell.key!, cell.dir ?? 'desc')}
                        className={`group flex min-w-0 items-center gap-1 ${align} transition-colors hover:text-white`}
                    >
                        <span className="truncate">{cell.label}</span>
                        <Icon className={`h-3 w-3 shrink-0 ${active ? 'text-[var(--term-accent)]' : 'opacity-0 group-hover:opacity-60'}`} />
                    </button>
                );
            })}
        </div>
    );
}

function StateEmpty({ state, empty, error }: { state: LoadState; empty: string; error: string }) {
    if (state === 'loading') return <Empty text="Loading…" />;
    if (state === 'error') return <Empty text={error} />;
    if (state === 'ready') return <Empty text={empty} />;
    return null;
}

function Empty({ text }: { text: string }) {
    return <div className="grid h-full min-h-20 place-items-center text-xs text-[var(--term-muted)]">{text}</div>;
}

export default memo(TerminalActivity);
