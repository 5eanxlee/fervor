'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowPathIcon, BoltIcon, Cog6ToothIcon, FunnelIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import {
    apiService,
    OrderRecord,
    TokenHolders,
    TrackedWallet,
    WalletPosition,
} from '../../services/api';

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

const money = (value?: number): string => value === undefined || !Number.isFinite(value)
    ? '—'
    : value >= 1 ? `$${compact(value)}` : `$${value.toPrecision(5)}`;

const shortAddress = (value?: string): string => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';
const microUsd = (value?: string): number | undefined => value === undefined ? undefined : Number(value) / 1_000_000;
const amount = (value: string, decimals: number): number => Number(value) / 10 ** decimals;
const param = (order: OrderRecord, key: string): number | undefined => {
    const value = Number(order.params[key]);
    return Number.isFinite(value) ? value : undefined;
};

export const matchesToken = (order: OrderRecord, tokenMint: string): boolean =>
    order.inputMint === tokenMint || order.outputMint === tokenMint || order.triggerMint === tokenMint;

export const orderSide = (order: OrderRecord, tokenMint: string): 'buy' | 'sell' =>
    order.outputMint === tokenMint ? 'buy' : 'sell';

export default function TerminalActivity({
    tokenMint,
    tokenDecimals,
    trades,
    initialTab = 'trades',
    onInstantTrade,
    now,
}: {
    tokenMint: string;
    tokenDecimals: number;
    trades: ActivityTrade[];
    initialTab?: ActivityTab;
    onInstantTrade?: () => void;
    now?: string | null;
}) {
    const [tab, setTab] = useState<ActivityTab>(initialTab);
    const [positions, setPositions] = useState<PositionRow[]>([]);
    const [orders, setOrders] = useState<OrderRecord[]>([]);
    const [holders, setHolders] = useState<TokenHolders>();
    const [positionState, setPositionState] = useState<LoadState>('idle');
    const [orderState, setOrderState] = useState<LoadState>('idle');
    const [holderState, setHolderState] = useState<LoadState>('idle');
    const [orderView, setOrderView] = useState<'open' | 'history'>('open');

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
        if (tab === 'holders' && holderState === 'idle') void loadHolders();
    }, [holderState, loadHolders, loadOrders, loadPositions, orderState, positionState, tab]);

    const visibleOrders = useMemo(() => orders.filter((order) =>
        orderView === 'open' ? openStates.has(order.state) : !openStates.has(order.state)
    ), [orderView, orders]);

    const chooseTab = (next: ActivityTab) => {
        setTab(next);
        const url = new URL(window.location.href);
        if (next === 'trades') url.searchParams.delete('tab');
        else url.searchParams.set('tab', next);
        window.history.replaceState(null, '', url);
    };

    const refresh = () => {
        if (tab === 'positions') void loadPositions();
        if (tab === 'orders') void loadOrders();
        if (tab === 'holders') void loadHolders();
    };

    const tabs: Array<{ id: ActivityTab; label: string }> = [
        { id: 'trades', label: 'Trades' },
        { id: 'positions', label: 'Positions' },
        { id: 'orders', label: 'Orders' },
        { id: 'holders', label: `Holders${holders?.total ? ` (${compact(holders.total)})` : ''}` },
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
                    {tab !== 'trades' && <button onClick={refresh} className="grid h-7 w-7 place-items-center text-[var(--term-muted)] hover:text-white" aria-label={`Refresh ${tab}`}><ArrowPathIcon className="h-3.5 w-3.5" /></button>}
                </div>
            </div>

            {tab === 'trades' && <TradeTable trades={trades} now={now} />}
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
            {tab === 'holders' && <HolderTable data={holders} state={holderState} />}
            {tab === 'top' && <TopTable trades={trades} />}
            {tab === 'dev' && <DevTable tokenMint={tokenMint} />}
        </div>
    );
}

function TradeTable({ trades, now }: { trades: ActivityTrade[]; now?: string | null }) {
    const clock = now ? new Date(now).getTime() : Date.now();
    return (
        <>
            <TableHead columns="grid-cols-[70px_90px_70px_1fr_1fr_1fr_1fr_105px_28px]" labels={['Age ↓', 'Tip & Prio', 'Side', 'MCap ↔', 'Amount', 'Total USD', 'Total SOL', 'Maker', '']} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {trades.map((trade) => (
                    <div key={trade.id} className="activity-row grid grid-cols-[70px_90px_70px_1fr_1fr_1fr_1fr_105px_28px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{Math.max(0, Math.floor((clock - new Date(trade.observedAt).getTime()) / 1000))}s</span>
                        <span className="text-[var(--term-dim)]">—</span>
                        <span className={trade.side === 'buy' ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]'}>{trade.side === 'buy' ? 'Buy' : 'Sell'}</span>
                        <span>{money(trade.marketCapUsd)}</span><span>{compact(trade.tokenAmount)}</span>
                        <span>{money(trade.usdAmount)}</span><span>{compact(trade.solAmount)}</span>
                        <span className="text-right text-[var(--term-muted)]">{shortAddress(trade.maker)}</span>
                        <Cog6ToothIcon className="ml-auto h-3.5 w-3.5 text-[var(--term-dim)]" />
                    </div>
                ))}
                {!trades.length && <Empty text="Waiting for live trades" />}
            </div>
        </>
    );
}

function PositionTable({ rows, state }: { rows: PositionRow[]; state: LoadState }) {
    return (
        <>
            <TableHead columns="grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_110px]" labels={['Asset', 'Wallet', 'Cost', 'Remaining', 'PnL', 'PnL %', 'Activity']} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((row) => {
                    const cost = microUsd(row.costMicroUsd) || 0;
                    const remaining = microUsd(row.currentValueMicroUsd);
                    const pnl = microUsd(row.unrealizedPnlMicroUsd) ?? microUsd(row.realizedPnlMicroUsd) ?? 0;
                    return (
                        <div key={`${row.trackedWalletId}:${row.tokenMint}`} className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_110px] border-b border-[var(--term-border)] px-3 py-2 text-[11px] tabular-nums">
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
    return (
        <>
            <div className="flex h-8 items-center border-b border-[var(--term-border)] px-3 text-[10px]">
                <button onClick={() => setView('open')} className={`mr-3 ${view === 'open' ? 'text-white' : 'text-[var(--term-muted)]'}`}>Open ({openCount})</button>
                <button onClick={() => setView('history')} className={view === 'history' ? 'text-white' : 'text-[var(--term-muted)]'}>Historical</button>
            </div>
            <TableHead columns="grid-cols-[90px_90px_70px_70px_1fr_1fr_95px_100px]" labels={['Date', 'Wallet', 'Type', 'Side', 'Price', 'Amount', 'Updated', 'Status']} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((order) => {
                    const side = orderSide(order, tokenMint);
                    const price = param(order, 'triggerPriceUsd') ?? param(order, 'takeProfitPriceUsd');
                    const displayAmount = Number(order.inputAmount) / 10 ** (side === 'buy' ? 9 : tokenDecimals);
                    return (
                        <div key={order.id} className="grid grid-cols-[90px_90px_70px_70px_1fr_1fr_95px_100px] border-b border-[var(--term-border)] px-3 py-2 text-[11px] tabular-nums">
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

function HolderTable({ data, state }: { data?: TokenHolders; state: LoadState }) {
    return (
        <>
            <div className="flex h-8 items-center border-b border-[var(--term-border)] px-3 text-[10px] text-[var(--term-muted)]">
                <span>Wallet-grouped ownership</span>
                {data?.top10Percent !== undefined && <span className="ml-auto">Top 10: <span className="text-white">{data.top10Percent.toFixed(2)}%</span></span>}
            </div>
            <TableHead columns="grid-cols-[60px_1.2fr_1fr_1fr_1fr_1fr_110px]" labels={['Rank', 'Address', 'Balance', 'Supply', 'Value', 'Avg buy', 'First trade']} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {data?.items.map((holder, index) => (
                    <div key={`${holder.owner}:${index}`} className="grid grid-cols-[60px_1.2fr_1fr_1fr_1fr_1fr_110px] border-b border-[var(--term-border)] px-3 py-2 text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{index + 1}</span><span>{shortAddress(holder.owner)}</span>
                        <span>{compact(holder.amount)}</span><span>{holder.supplyPercent === undefined ? '—' : `${holder.supplyPercent.toFixed(3)}%`}</span>
                        <span>{money(holder.amountUsd)}</span><span>{money(holder.avgBuyPrice)}</span>
                        <span className="text-right text-[var(--term-dim)]">{holder.firstTradeAt ? new Date(holder.firstTradeAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}</span>
                    </div>
                ))}
                {!data?.items.length && <StateEmpty state={state} empty="No holder rows returned" error="Holder provider unavailable" />}
            </div>
        </>
    );
}

function TopTable({ trades }: { trades: ActivityTrade[] }) {
    const rows = Array.from(trades.reduce((map, trade) => {
        const maker = trade.maker || 'Unknown';
        const current = map.get(maker) || { maker, trades: 0, volume: 0, bought: 0, sold: 0 };
        current.trades += 1;
        current.volume += trade.usdAmount || 0;
        if (trade.side === 'buy') current.bought += trade.usdAmount || 0;
        else current.sold += trade.usdAmount || 0;
        map.set(maker, current);
        return map;
    }, new Map<string, { maker: string; trades: number; volume: number; bought: number; sold: number }>()).values())
        .sort((left, right) => right.volume - left.volume)
        .slice(0, 50);
    return (
        <>
            <TableHead columns="grid-cols-[56px_1.3fr_1fr_1fr_1fr_1fr_80px]" labels={['Rank', 'Trader', 'Volume', 'Bought', 'Sold', 'Net', 'Trades']} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((row, index) => (
                    <div key={row.maker} className="activity-row grid grid-cols-[56px_1.3fr_1fr_1fr_1fr_1fr_80px] items-center border-b border-[var(--term-border)] px-3 text-[11px] tabular-nums">
                        <span className="text-[var(--term-dim)]">{index + 1}</span>
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
    return (
        <>
            <TableHead columns="grid-cols-[1.4fr_1fr_1fr_1fr_1fr_100px]" labels={['Token', 'Relationship', 'Created', 'Market cap', 'Liquidity', 'Status']} />
            <div className="activity-row grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_100px] items-center border-b border-[var(--term-border)] px-3 text-[11px]">
                <span className="truncate text-[var(--term-text)]">{shortAddress(tokenMint)}</span>
                <span className="text-[var(--term-muted)]">Current token</span><span className="text-[var(--term-dim)]">—</span><span>—</span><span>—</span><span className="text-[var(--term-accent)]">Tracked</span>
            </div>
        </>
    );
}

function TableHead({ columns, labels }: { columns: string; labels: string[] }) {
    return <div className={`activity-head grid ${columns} shrink-0 items-center border-b border-[var(--term-border)] px-3 text-[10px] text-[var(--term-dim)]`}>{labels.map((label, index) => <span key={`${label}:${index}`} className={index === labels.length - 1 ? 'text-right' : ''}>{label}</span>)}</div>;
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
