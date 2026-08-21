'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowsPointingInIcon,
    ArrowsPointingOutIcon,
    ChartBarIcon,
    ClipboardDocumentIcon,
    Cog6ToothIcon,
    EyeIcon,
    GlobeAltIcon,
    LinkIcon,
    MagnifyingGlassIcon,
    StarIcon,
} from '@heroicons/react/24/outline';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, TokenCandle, TokenData, TokenMetadata } from '../../services/api';
import {
    type ChartDataset,
    type ChartTimeframe,
    connectCandles,
    getTimeframeSeconds,
} from '../../services/chartData';
import LightweightTokenChart from '../charts/LightweightTokenChart';
import ChartToolbar from '../charts/ChartToolbar';
import TokenLogo from '../TokenLogo';
import TradeTicket from './TradeTicket';
import InstantTradePanel from './InstantTradePanel';
import TerminalActivity, { ActivityTab, ActivityTrade } from './TerminalActivity';
import { TerminalDock, TerminalHeader } from './TerminalChrome';
import TerminalSettingsModal from './TerminalSettingsModal';
import type { SettingsSection } from './TerminalSettingsModal';
import ReplayControls from './ReplayControls';
import { terminalSkin, useTerminalSettings } from '../../services/terminalSettings';
import { hasStar, onShelf, rememberToken, toggleStar } from '../../services/tokenShelf';
import { useRealtime } from '../../hooks/useRealtime';
import { frameDelay, type RtFrame } from '../../services/realtime';
import {
    advanceReplayParticipants,
    amountOf,
    chartPriceOf,
    isReplayDeltaPage,
    isReplayParticipants,
    isReplayProjection,
    isReplayState,
    isReplayTrade,
    mergeCandles,
    replayControlContract,
    replayClockAt,
    replayFromRt,
    replaySlice,
    stabilizeReplayPrices,
    supplyOf,
    type ReplayControl,
    type ReplayOp,
    type ReplayParticipants,
    type ReplaySpeed,
    type ReplayState,
    type ReplayTrade,
} from '../../services/replay';

type MarketView = {
    price?: number;
    marketCap?: number;
    liquidity?: number;
    volume5m?: number;
    buys5m?: number;
    sells5m?: number;
};

type ChartInterval = ChartTimeframe;
const replayBuild = process.env.NEXT_PUBLIC_DATA_MODE === 'replay';
const replaySymbol = process.env.NEXT_PUBLIC_REPLAY_SYMBOL || 'REPLAY';
const replayName = process.env.NEXT_PUBLIC_REPLAY_NAME || 'Token';
const replayLogo = process.env.NEXT_PUBLIC_REPLAY_LOGO?.trim();
const configuredSupply = Number(process.env.NEXT_PUBLIC_REPLAY_SUPPLY) > 0
    ? Number(process.env.NEXT_PUBLIC_REPLAY_SUPPLY)
    : undefined;
const replayStreams = ['trade', 'market', 'replay'] as const;
const replayHistoryLimit = 2_000;

const compact = (value?: number): string => {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
};

const money = (value?: number): string => value === undefined || !Number.isFinite(value)
    ? '—'
    : value >= 1 ? `$${compact(value)}` : `$${value.toPrecision(5)}`;

const shortAddress = (value?: string): string => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';

const activityTrade = (item: ReplayTrade, supply?: number): ActivityTrade => {
    const chartPrice = chartPriceOf(item);
    return {
        id: item.idempotencyKey,
        side: item.side || 'buy',
        maker: item.maker,
        usdAmount: item.usdAmount ?? item.chartUsdAmount,
        tokenAmount: amountOf(item),
        priceUsd: item.priceUsd,
        marketCapUsd: chartPrice !== undefined && supply !== undefined
            ? chartPrice * supply
            : undefined,
        solAmount: item.solAmount,
        observedAt: item.observedAt,
    };
};

const latestReplayPrice = (trades: ReplayTrade[]): number | undefined => {
    for (let index = trades.length - 1; index >= 0; index -= 1) {
        const price = chartPriceOf(trades[index]);
        if (price !== undefined) return price;
    }
    return undefined;
};

const mergeReplayTape = (history: ReplayTrade[], current: ReplayTrade[]): ReplayTrade[] => {
    const trades = new Map<string, ReplayTrade>();
    for (const item of [...history, ...current]) trades.set(item.idempotencyKey, item);
    return Array.from(trades.values()).sort((left, right) => {
        if (left.replayCursor !== undefined && right.replayCursor !== undefined) {
            return left.replayCursor - right.replayCursor;
        }
        const time = Date.parse(left.observedAt) - Date.parse(right.observedAt);
        return time || left.idempotencyKey.localeCompare(right.idempotencyKey);
    }).slice(-20_000);
};

const datasetFrom = (
    tokenMint: string,
    tokenSymbol: string,
    totalSupply: number,
    liquidity: number,
    intervalSeconds: number,
    candles: TokenCandle[],
    historical = false
): ChartDataset => {
    const chartCandles = connectCandles(candles).map((candle) => ({
        ...candle,
        volumeTokens: 0,
        tradeCount: candle.txCount,
        uniqueBuyers: 0,
        uniqueSellers: 0,
        marketCapUsd: candle.close * totalSupply,
        liquidityUsd: liquidity,
    }));
    const firstAt = chartCandles[0]?.timestamp;
    const lastAt = chartCandles.at(-1)?.timestamp;
    const durationSeconds = firstAt === undefined || lastAt === undefined
        ? 0
        : Math.max(intervalSeconds, (lastAt - firstAt) / 1_000 + intervalSeconds);
    return {
        tokenAddress: tokenMint,
        tokenSymbol,
        totalSupply,
        intervalSeconds,
        candles: chartCandles,
        markers: [],
        alertLines: [],
        source: { mode: historical ? 'historical_replay' : 'live' },
        metrics: {
            candleCount: chartCandles.length,
            tradeCount: chartCandles.reduce((sum, item) => sum + item.tradeCount, 0),
            buyCount: chartCandles.reduce((sum, item) => sum + item.buyCount, 0),
            sellCount: chartCandles.reduce((sum, item) => sum + item.sellCount, 0),
            volume1mUsd: chartCandles.at(-1)?.volumeUsd || 0,
            volume5mUsd: chartCandles.slice(-5).reduce((sum, item) => sum + item.volumeUsd, 0),
            peakMarketCapUsd: Math.max(0, ...chartCandles.map((item) => item.marketCapUsd)),
            finalMarketCapUsd: chartCandles.at(-1)?.marketCapUsd || 0,
            peakLiquidityUsd: liquidity,
            finalLiquidityUsd: liquidity,
            uniqueBuyers: 0,
            uniqueSellers: 0,
            durationSeconds,
        },
    };
};

export default function TradingTerminal({ tokenMint, replayView = false }: { tokenMint: string; replayView?: boolean }) {
    const replayMode = replayBuild && replayView;
    const { isAuthenticated, isLoading: authLoading, token: authToken } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [settings, setSettings] = useTerminalSettings();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
    const openSettings = (section: SettingsSection = 'appearance') => {
        setSettingsSection(section);
        setSettingsOpen(true);
    };
    const [token, setToken] = useState<TokenData>();
    const [metadata, setMetadata] = useState<TokenMetadata>();
    const [market, setMarket] = useState<MarketView>({});
    const [candles, setCandles] = useState<TokenCandle[]>([]);
    const [trades, setTrades] = useState<ActivityTrade[]>([]);
    const [interval, setIntervalName] = useState<ChartInterval>(replayMode ? '1s' : '1m');
    const intervalSeconds = getTimeframeSeconds(interval);
    const [solUsd, setSolUsd] = useState<number>();
    const [streamState, setStreamState] = useState<'connecting' | 'live' | 'offline'>('connecting');
    const [loading, setLoading] = useState(true);
    const [sessionKey, setSessionKey] = useState(0);
    const [chartKey, setChartKey] = useState(0);
    const [chartFull, setChartFull] = useState(false);
    const [instantOpen, setInstantOpen] = useState(false);
    const [starred, setStarred] = useState(false);
    const [chartShare, setChartShare] = useState(56);
    const [limitTarget, setLimitTarget] = useState<number>();
    const [replay, setReplay] = useState<ReplayState>();
    const [replayNow, setReplayNow] = useState<string>();
    const [participants, setParticipants] = useState<ReplayParticipants>();
    const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(1);
    const [replaySupply, setReplaySupply] = useState<number | undefined>(configuredSupply);
    const [replayError, setReplayError] = useState<string>();
    const [controlBusy, setControlBusy] = useState(false);
    const chartSplitRef = useRef<HTMLElement>(null);
    const queue = useRef<Array<{ event: string; data: any }>>([]);
    const renderTimer = useRef<number | undefined>(undefined);
    const lastRenderAt = useRef(0);
    const replayTrades = useRef<ReplayTrade[]>([]);
    const participantView = useRef<ReplayParticipants | undefined>(undefined);
    const replayCut = useRef<{ epoch: number; cursor: number } | undefined>(undefined);
    const replayResync = useRef(false);
    const supplyRef = useRef<number | undefined>(configuredSupply);
    const intervalRef = useRef(intervalSeconds);
    const hydrateSeq = useRef(0);
    const participantSeq = useRef(0);

    useEffect(() => {
        intervalRef.current = intervalSeconds;
    }, [intervalSeconds]);

    useEffect(() => {
        if (replayMode && replay?.solUsd) setSolUsd(replay.solUsd);
    }, [replay?.solUsd, replayMode]);

    useEffect(() => {
        const controller = new AbortController();
        const loadSol = async () => {
            try {
                const response = await fetch('/api/market/sol', { signal: controller.signal });
                if (!response.ok) return;
                const payload = await response.json() as { price?: number };
                const price = Number(payload.price);
                if (Number.isFinite(price) && price > 0) setSolUsd(price);
            } catch {
                // Keep the last valid price through transient provider failures.
            }
        };
        void loadSol();
        const timer = window.setInterval(loadSol, 30_000);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, []);

    const changeInterval = (next: ChartInterval) => {
        if (next === interval) return;
        const seconds = getTimeframeSeconds(next);
        intervalRef.current = seconds;
        setIntervalName(next);
        setSettings((current) => current.chartAutoScale
            ? current
            : { ...current, chartAutoScale: true });
        setCandles(replayMode
            ? mergeCandles([], replayTrades.current, seconds)
            : []);
    };

    const resizeChart = useCallback((clientY: number) => {
        const region = chartSplitRef.current;
        if (!region) return;
        const rect = region.getBoundingClientRect();
        const next = (clientY - rect.top) / rect.height * 100;
        setChartShare(Math.min(78, Math.max(34, next)));
    }, []);

    const startChartResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const move = (next: PointerEvent) => resizeChart(next.clientY);
        const stop = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
    };

    const syncLimitTarget = useCallback((state: { active: boolean; marketCap?: number }) => {
        const next = state.active && Number.isFinite(state.marketCap) ? state.marketCap : undefined;
        setLimitTarget((current) => current === next ? current : next);
    }, []);

    const applyProjection = useCallback((projection: ReplayState['projection'], includePrice = true) => {
        const price = projection.latestUsd?.value;
        const supply = supplyRef.current;
        setMarket((current) => ({
            ...current,
            ...(includePrice ? {
                price,
                marketCap: price !== undefined && supply !== undefined ? price * supply : undefined,
            } : {}),
            volume5m: projection.rolling.volumeUsd['5m'],
            buys5m: projection.rolling.buyCount['5m'],
            sells5m: projection.rolling.sellCount['5m'],
        }));
    }, []);

    const applyReplay = useCallback((state: ReplayState) => {
        if (state.tokenMint !== tokenMint) {
            setReplayError('Replay tape does not match this token');
            setLoading(false);
            return;
        }
        const prior = replayCut.current;
        if (prior && (state.snapshot.epoch < prior.epoch
            || (state.snapshot.epoch === prior.epoch && state.snapshot.cursor < prior.cursor))) return;
        if (replayResync.current || (prior && prior.epoch !== state.snapshot.epoch)) {
            hydrateSeq.current += 1;
            participantSeq.current += 1;
            replayTrades.current = [];
            participantView.current = undefined;
            setTrades([]);
            setCandles([]);
            setParticipants(undefined);
        }
        replayResync.current = false;
        replayCut.current = { epoch: state.snapshot.epoch, cursor: state.snapshot.cursor };
        setReplay(state);
        applyProjection(state.projection);
        setReplayError(state.failure || undefined);
        setLoading(false);
    }, [applyProjection, tokenMint]);

    const hydrateReplayHistory = useCallback(async (state: ReplayState) => {
        const target = state.snapshot.cursor;
        if (target === 0) return;
        const sequence = ++hydrateSeq.current;
        const epoch = state.snapshot.epoch;
        let after = Math.max(0, target - replayHistoryLimit);
        const history: ReplayTrade[] = [];

        while (after < target) {
            const limit = Math.min(500, target - after);
            const response = await apiService.getReplayDeltas(epoch, after, limit);
            const page = response.data?.page;
            if (!isReplayDeltaPage(page) || page.epoch !== epoch || page.after !== after) return;
            for (const event of page.items) {
                if (event.cursor >= target) break;
                history.push({ ...event.trade, replayCursor: event.cursor });
            }
            if (page.items.length === 0) return;
            after += page.items.length;
        }

        const cut = replayCut.current;
        if (sequence !== hydrateSeq.current || !cut || cut.epoch !== epoch || cut.cursor < target) return;
        const combined = stabilizeReplayPrices(mergeReplayTape(history, replayTrades.current));
        replayTrades.current = combined;

        for (const item of combined) {
            const supply = supplyOf(item);
            if (supply !== undefined) supplyRef.current = supply;
        }
        if (supplyRef.current !== undefined) setReplaySupply(supplyRef.current);
        setCandles(mergeCandles([], combined, intervalRef.current));
        setTrades(combined.slice(-500).reverse().map((item) => activityTrade(item, supplyRef.current)));
        const price = latestReplayPrice(combined);
        if (price !== undefined) setMarket((current) => ({
            ...current,
            price,
            marketCap: supplyRef.current === undefined ? undefined : price * supplyRef.current,
        }));
    }, []);

    const hydrateParticipants = useCallback(async (state: ReplayState) => {
        const sequence = ++participantSeq.current;
        const response = await apiService.getReplayParticipants(
            state.snapshot.epoch,
            state.snapshot.cursor
        );
        const base = response.data?.participants;
        if (!isReplayParticipants(base)
            || base.tokenMint !== tokenMint
            || base.epoch !== state.snapshot.epoch
            || base.cutCursor !== state.snapshot.cursor) {
            throw new Error('Replay participant data is invalid');
        }
        const cut = replayCut.current;
        if (sequence !== participantSeq.current || !cut || cut.epoch !== base.epoch
            || cut.cursor < base.cutCursor) return;
        const tail = replayTrades.current.filter((trade) =>
            trade.replayCursor !== undefined && trade.replayCursor >= base.cutCursor
        );
        const next = advanceReplayParticipants(base, tail);
        if (!next || next.cutCursor !== cut.cursor) return;
        participantView.current = next;
        setParticipants(next);
    }, [tokenMint]);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) router.replace('/');
    }, [authLoading, isAuthenticated, router]);

    useEffect(() => {
        if (!isAuthenticated) return;
        let active = true;
        setLoading(true);
        if (replayMode) {
            apiService.getReplaySnapshot().then((response) => {
                const state = response.data?.state;
                if (active && isReplayState(state)) {
                    applyReplay(state);
                    void hydrateReplayHistory(state).catch((error) => {
                        if (active) setReplayError(error?.error || 'Replay history is unavailable');
                    });
                    void hydrateParticipants(state).catch((error) => {
                        if (active) setReplayError(error?.error || 'Replay participant data is unavailable');
                    });
                }
                else if (active) setReplayError('Replay snapshot is invalid');
            }).catch((error) => {
                if (active) setReplayError(error?.error || 'Replay snapshot is unavailable');
            }).finally(() => active && setLoading(false));
            return () => { active = false; };
        }
        Promise.all([
            apiService.getTokenData(tokenMint),
            apiService.getTokenMetadata(tokenMint),
            apiService.getTokenMarketData(tokenMint),
        ]).then(([tokenResponse, metadataResponse, marketResponse]) => {
            if (!active) return;
            if (tokenResponse.data) setToken(tokenResponse.data as TokenData);
            if (metadataResponse.data) setMetadata(metadataResponse.data);
            if (marketResponse.data) {
                const raw = marketResponse.data as any;
                setMarket({
                    price: Number(raw.price), marketCap: Number(raw.market_cap), liquidity: Number(raw.liquidity),
                    volume5m: Number(raw.volume?.['5m'] || raw.volume5m),
                    buys5m: Number(raw.buys?.['5m']), sells5m: Number(raw.sells?.['5m']),
                });
            }
        }).catch(() => undefined).finally(() => active && setLoading(false));
        return () => { active = false; };
    }, [applyReplay, hydrateParticipants, hydrateReplayHistory, isAuthenticated, replayMode, sessionKey, tokenMint]);

    useEffect(() => {
        if (!isAuthenticated || replayMode) return;
        let active = true;
        apiService.getCandles(tokenMint, interval, 750).then((response) => {
            if (active) setCandles(response.data || []);
        }).catch(() => undefined);
        return () => { active = false; };
    }, [chartKey, interval, isAuthenticated, replayMode, tokenMint]);

    const flush = useCallback(() => {
        renderTimer.current = undefined;
        lastRenderAt.current = performance.now();
        const events = queue.current.splice(0);
        if (!events.length) return;
        let marketPatch: MarketView = {};
        const nextTrades: ActivityTrade[] = [];
        const nextCandles: TokenCandle[] = [];
        for (const entry of events) {
            if (entry.event === 'market_state') {
                const value = entry.data;
                marketPatch = {
                    price: value.priceUsd,
                    marketCap: value.marketCapUsd,
                    liquidity: value.liquidityUsd,
                    volume5m: value.volumeUsd?.['5m'],
                    buys5m: value.buyCount?.['5m'],
                    sells5m: value.sellCount?.['5m'],
                };
            }
            if (entry.event === 'trade') {
                const value = entry.data;
                nextTrades.push({
                    id: value.idempotencyKey || `${value.signature}:${value.eventIndex || 0}`,
                    side: value.side || 'buy', maker: value.maker, usdAmount: value.usdAmount,
                    tokenAmount: value.tokenAmount, priceUsd: value.priceUsd, marketCapUsd: value.marketCapUsd,
                    solAmount: value.solAmount, observedAt: value.observedAt,
                });
            }
            if (entry.event === 'candle') {
                const value = entry.data;
                if (value.intervalName && value.intervalName !== interval) continue;
                nextCandles.push({
                    timestamp: new Date(value.bucketStart || value.timestamp).getTime(),
                    open: Number(value.openUsd || value.open), high: Number(value.highUsd || value.high),
                    low: Number(value.lowUsd || value.low), close: Number(value.closeUsd || value.close),
                    volumeUsd: Number(value.volumeUsd || 0), buyCount: Number(value.buyCount || 0),
                    sellCount: Number(value.sellCount || 0), txCount: Number(value.txCount || 0),
                });
            }
        }
        if (Object.keys(marketPatch).length) setMarket((current) => ({ ...current, ...marketPatch }));
        if (nextTrades.length) setTrades((current) => [...nextTrades.reverse(), ...current].slice(0, 500));
        if (nextCandles.length) setCandles((current) => {
            const merged = new Map<number, TokenCandle>();
            for (const candle of [...current, ...nextCandles]) merged.set(candle.timestamp, candle);
            return Array.from(merged.values()).sort((left, right) => left.timestamp - right.timestamp).slice(-2000);
        });
    }, [interval]);

    useEffect(() => {
        if (!isAuthenticated || replayMode) return;
        const source = new EventSource(`${apiService.getTokenStreamUrl(tokenMint)}?batch=1`);
        const enqueue = (event: string, data: any) => {
            if (event === 'batch' && Array.isArray(data.events)) queue.current.push(...data.events);
            else queue.current.push({ event, data });
            if (queue.current.length > 4_000) queue.current.splice(0, queue.current.length - 4_000);
            if (renderTimer.current === undefined) {
                const delay = frameDelay(lastRenderAt.current, performance.now());
                renderTimer.current = window.setTimeout(flush, delay);
            }
        };
        const parsed = (message: Event) => {
            try { return JSON.parse((message as MessageEvent).data); } catch { return undefined; }
        };
        source.addEventListener('batch', (message) => { const data = parsed(message); if (data) enqueue('batch', data); });
        source.addEventListener('decode_status', (message) => {
            const data = parsed(message);
            if (!data) return;
            setStreamState(data.status === 'connected' ? 'live' : 'offline');
        });
        source.onopen = () => setStreamState('live');
        source.onerror = () => setStreamState('offline');
        return () => {
            source.close();
            if (renderTimer.current !== undefined) window.clearTimeout(renderTimer.current);
            renderTimer.current = undefined;
            lastRenderAt.current = 0;
        };
    }, [flush, isAuthenticated, replayMode, tokenMint]);

    const totalSupply = replayMode
        ? replaySupply ?? 1
        : Number(metadata?.totalSupplyFormatted || 1_000_000_000);
    const tokenDecimals = participants?.tokenDecimals ?? metadata?.decimals ?? 9;
    const symbol = replayMode ? replaySymbol : token?.symbol || metadata?.symbol || 'TOKEN';
    const displayName = replayMode ? replayName : token?.name || metadata?.name || shortAddress(tokenMint);
    const displayLogo = replayMode ? replayLogo : metadata?.logo;
    useEffect(() => () => {
        hydrateSeq.current += 1;
        participantSeq.current += 1;
    }, []);

    const onReplayFrames = useCallback((frames: RtFrame[]) => {
        const batch: ReplayTrade[] = [];
        for (const current of frames) {
            if (current.type === 'snapshot') {
                const state = replayFromRt(current.data);
                if (state) {
                    applyReplay(state);
                    if (!replayTrades.current.length && state.snapshot.cursor > 0) {
                        void hydrateReplayHistory(state).catch((error) => {
                            setReplayError(error?.error || 'Replay history is unavailable');
                        });
                    }
                    void hydrateParticipants(state).catch((error) => {
                        setReplayError(error?.error || 'Replay participant data is unavailable');
                    });
                }
                continue;
            }
            if (current.type !== 'delta') {
                if (current.type === 'control' && current.code === 'resync_required') {
                    replayResync.current = true;
                }
                continue;
            }
            if (replayCut.current && current.epoch !== replayCut.current.epoch) continue;
            if (current.stream === 'trade' && isReplayTrade(current.data)) {
                const cursor = Number(current.cursor) - 1;
                batch.push({
                    ...current.data,
                    ...(Number.isSafeInteger(cursor) && cursor >= 0 ? { replayCursor: cursor } : {}),
                });
            }
            if (current.stream === 'market' && isReplayProjection(current.data)) {
                const projection = current.data;
                applyProjection(projection, false);
                setReplay((prior) => prior ? { ...prior, projection } : prior);
            }
            if (current.stream === 'replay') {
                setReplay((prior) => {
                    if (!prior) return prior;
                    const next = replaySlice(prior, current.data);
                    if (!next) return prior;
                    replayCut.current = { epoch: next.snapshot.epoch, cursor: next.snapshot.cursor };
                    setReplayError(next.failure || undefined);
                    return next;
                });
            }
        }
        if (!batch.length) return;
        const known = new Set(replayTrades.current.map((item) => item.idempotencyKey));
        const fresh = batch.filter((item) => !known.has(item.idempotencyKey));
        if (!fresh.length) return;
        for (const item of fresh) {
            const supply = supplyOf(item);
            if (supply !== undefined && supplyRef.current !== supply) {
                supplyRef.current = supply;
                setReplaySupply(supply);
            }
        }
        const stableFresh = stabilizeReplayPrices(fresh, latestReplayPrice(replayTrades.current));
        replayTrades.current = mergeReplayTape(replayTrades.current, stableFresh);
        if (participantView.current) {
            const next = advanceReplayParticipants(participantView.current, stableFresh);
            participantView.current = next;
            setParticipants(next);
        }
        setTrades((current) => [
            ...stableFresh.map((item) => activityTrade(item, supplyRef.current)).reverse(),
            ...current,
        ].slice(0, 500));
        setCandles((current) => mergeCandles(current, stableFresh, intervalRef.current));
        const price = latestReplayPrice(stableFresh);
        if (price !== undefined) setMarket((current) => ({
            ...current,
            price,
            marketCap: supplyRef.current === undefined ? undefined : price * supplyRef.current,
        }));
    }, [applyProjection, applyReplay, hydrateParticipants, hydrateReplayHistory]);

    const realtime = useRealtime({
        enabled: replayMode && isAuthenticated,
        token: authToken,
        tokenMint,
        streams: [...replayStreams],
        onFrames: onReplayFrames,
    });

    useEffect(() => {
        if (!replayMode) return;
        setCandles(mergeCandles([], replayTrades.current, intervalRef.current));
    }, [chartKey, replayMode]);

    useEffect(() => {
        const cut = replay?.snapshot;
        if (!replayMode || !cut) {
            setReplayNow(undefined);
            return;
        }
        const started = performance.now();
        const update = () => {
            const value = replayClockAt(cut, replaySpeed, performance.now() - started);
            setReplayNow(value === undefined ? undefined : new Date(value).toISOString());
        };
        update();
        if (cut.status !== 'running' || replaySpeed === 'max') return;
        const timer = window.setInterval(update, 100);
        return () => window.clearInterval(timer);
    }, [replay?.snapshot, replayMode, replaySpeed]);

    const chartDataset = useMemo(
        () => datasetFrom(tokenMint, symbol, totalSupply, market.liquidity || 0, intervalSeconds, candles, replayMode),
        [candles, intervalSeconds, market.liquidity, replayMode, symbol, tokenMint, totalSupply]
    );
    const ticketFlow = useMemo(() => ({
        volumeUsd: market.volume5m,
        buys: market.buys5m,
        sells: market.sells5m,
    }), [market.buys5m, market.sells5m, market.volume5m]);

    const controlReplay = useCallback(async (command: ReplayOp) => {
        if (!replay || controlBusy) return;
        setControlBusy(true);
        setReplayError(undefined);
        try {
            const send = async (state: ReplayState, action: ReplayOp): Promise<ReplayState> => {
                const response = await apiService.controlReplay({
                    contract: replayControlContract,
                    epoch: state.snapshot.epoch,
                    cursor: state.snapshot.cursor,
                    fact: state.paper.factCount,
                    ...action,
                } as ReplayControl);
                if (!response.data || !isReplayState(response.data.state)) {
                    throw new Error('Replay control returned invalid state');
                }
                return response.data.state;
            };

            let state = replay;
            if (command.op === 'play' && state.snapshot.status === 'complete') {
                state = await send(state, { op: 'seek', target: 0 });
                applyReplay(state);
            }
            const next = await send(state, command);
            applyReplay(next);
            if (next.snapshot.cursor > 0 && command.op !== 'play') {
                await Promise.all([
                    hydrateReplayHistory(next),
                    hydrateParticipants(next),
                ]);
            } else if (command.op !== 'play') {
                await hydrateParticipants(next);
            }
        } catch (error: any) {
            setReplayError(error?.error || error?.message || 'Replay control failed');
            setSessionKey((value) => value + 1);
        } finally {
            setControlBusy(false);
        }
    }, [applyReplay, controlBusy, hydrateParticipants, hydrateReplayHistory, replay]);

    useEffect(() => {
        if (!replayMode && !token && !metadata) return;
        rememberToken({
            address: tokenMint,
            symbol,
            name: displayName,
            logo: displayLogo,
            marketCap: token?.market_cap,
            price: token?.price,
        });
    }, [displayLogo, displayName, metadata, replayMode, symbol, token, tokenMint]);

    useEffect(() => {
        const sync = () => setStarred(hasStar(tokenMint));
        sync();
        return onShelf(sync);
    }, [tokenMint]);

    if (authLoading || loading || !isAuthenticated) {
        return <main className="grid h-screen place-items-center bg-[#0f0f12] text-[#a1a1aa]"><div className="spinner" /></main>;
    }

    const ticketAmount = searchParams.get('amount') || String(settings.quickBuySol);
    const ticketSlippage = Number(searchParams.get('slippage')) || settings.slippageBps;
    const requestedTab = searchParams.get('tab');
    const activityTab: ActivityTab = requestedTab === 'positions' || requestedTab === 'orders' || requestedTab === 'holders' || requestedTab === 'top' || requestedTab === 'dev'
        ? requestedTab
        : 'trades';
    const replayNotice = replayError || (realtime.state === 'offline' ? realtime.reason : undefined);
    const solscanUrl = `https://solscan.io/token/${tokenMint}`;
    const dexUrl = `https://dexscreener.com/solana/${tokenMint}`;
    const xUrl = `https://x.com/search?q=${encodeURIComponent(`$${symbol}`)}&src=typed_query`;
    const toggleCurrentStar = () => setStarred(toggleStar({
        address: tokenMint,
        symbol,
        name: displayName,
        logo: displayLogo,
        marketCap: market.marketCap ?? token?.market_cap,
        price: market.price ?? token?.price,
    }));

    return (
        <main data-terminal-theme={settings.theme} className={`flex h-screen min-h-[680px] flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-text)] ${terminalSkin(settings)}`}>
            <TerminalHeader settings={settings} onSettings={openSettings} />

            {settings.showStats && (
                <section className="token-strip grid shrink-0 border-b border-[var(--term-border)] bg-[var(--term-bg)]" data-full={chartFull}>
                    <div className="flex min-w-0 items-center overflow-hidden px-[clamp(.75rem,1.2vw,1rem)]">
                        <div className="flex min-w-0 shrink-0 items-center gap-[clamp(.5rem,.8vw,.7rem)] pr-[clamp(.9rem,1.4vw,1.25rem)]">
                            <TokenLogo tokenAddress={tokenMint} tokenSymbol={symbol} logoUrl={displayLogo} size="md" />
                            <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    <h1 className="truncate text-[clamp(.75rem,1vw,.88rem)] font-[500]">{symbol}/SOL</h1>
                                    <a href={solscanUrl} target="_blank" rel="noreferrer" aria-label={`Open ${symbol} on Solscan`} title="Open token on Solscan" className="shrink-0 text-[var(--term-muted)] hover:text-white"><LinkIcon className="h-3.5 w-3.5" /></a>
                                    <a href={dexUrl} target="_blank" rel="noreferrer" aria-label={`Open ${symbol} on Dexscreener`} title="Open market on Dexscreener" className="hidden shrink-0 text-[var(--term-muted)] hover:text-white sm:block"><GlobeAltIcon className="h-3.5 w-3.5" /></a>
                                    <a href={xUrl} target="_blank" rel="noreferrer" aria-label={`Search X for $${symbol}`} title={`Search X for $${symbol}`} className="hidden shrink-0 text-[var(--term-muted)] hover:text-white sm:block"><MagnifyingGlassIcon className="h-3.5 w-3.5" /></a>
                                    <button onClick={toggleCurrentStar} className={starred ? 'text-[var(--term-accent)]' : 'text-[var(--term-muted)] hover:text-white'} aria-label={starred ? 'Remove from starred tokens' : 'Star token'} aria-pressed={starred}><StarIcon className="h-3.5 w-3.5 shrink-0" fill={starred ? 'currentColor' : 'none'} /></button>
                                </div>
                                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[clamp(.58rem,.72vw,.7rem)] text-[var(--term-muted)]">
                                    {!replayMode && <span className="shrink-0">Live</span>}
                                    <span className="truncate">{displayName}</span>
                                    <button onClick={() => navigator.clipboard.writeText(tokenMint)} className="hover:text-white" title="Copy address"><ClipboardDocumentIcon className="h-3.5 w-3.5" /></button>
                                    <span className="hidden items-center gap-0.5 rounded-full border border-[var(--term-border)] px-1.5 py-0.5 text-[var(--term-text)] md:flex"><EyeIcon className="h-3 w-3" />{compact(market.buys5m)}</span>
                                </div>
                            </div>
                        </div>

                        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end overflow-hidden">
                            <div className="token-main-stat shrink-0 px-[clamp(.7rem,1.35vw,1.2rem)] text-[clamp(1rem,1.55vw,1.28rem)] font-[500] tabular-nums">{money(market.marketCap ?? token?.market_cap)}</div>
                            {[
                                ['Price', money(market.price ?? token?.price)],
                                ['Liquidity', money(market.liquidity)],
                                ['Supply', compact(replayMode ? replaySupply : totalSupply)],
                                ['5m volume', money(market.volume5m)],
                            ].map(([label, value], index) => (
                                <div key={label} className={`token-stat min-w-0 px-[clamp(.55rem,1vw,.9rem)] ${index > 1 ? 'hidden xl:block' : ''}`}>
                                    <div className="truncate text-[clamp(.55rem,.65vw,.64rem)] text-[var(--term-muted)]">{label}</div>
                                    <div className="mt-0.5 truncate text-[clamp(.66rem,.78vw,.76rem)] tabular-nums text-[var(--term-text)]">{value}</div>
                                </div>
                            ))}
                            {replayMode && (
                                <ReplayControls
                                    replay={replay}
                                    now={replayNow}
                                    speed={replaySpeed}
                                    busy={controlBusy}
                                    notice={replayNotice}
                                    onSpeed={setReplaySpeed}
                                    onControl={(command) => void controlReplay(command)}
                                />
                            )}
                            <div className="ml-auto hidden items-center gap-1 md:flex">
                                <button onClick={() => setSettingsOpen(true)} className="terminal-icon !h-8 !w-8" aria-label="Token layout settings"><Cog6ToothIcon /></button>
                                <button className="terminal-icon !h-8 !w-8" aria-label="Market chart"><ChartBarIcon /></button>
                                <button onClick={() => setChartFull((value) => !value)} className="terminal-icon !h-8 !w-8" aria-label={chartFull ? 'Exit full chart' : 'Expand chart'}>{chartFull ? <ArrowsPointingInIcon /> : <ArrowsPointingOutIcon />}</button>
                            </div>
                        </div>
                    </div>

                    {!chartFull && (
                        <div className="hidden min-w-0 items-center border-l border-[var(--term-border)] px-[clamp(.65rem,1vw,.9rem)] lg:flex">
                            {['Invested', 'Sold', 'Remaining', 'Total PNL'].map((label) => (
                                <div key={label} className="min-w-0 flex-1 text-center">
                                    <div className="truncate text-[clamp(.55rem,.65vw,.64rem)] text-[var(--term-muted)]">{label}</div>
                                    <div className="mt-1 text-[clamp(.64rem,.74vw,.72rem)]">–</div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            )}

            <div className="token-workspace grid min-h-0 flex-1" data-full={chartFull} data-ticket={settings.ticketSide}>
                <section
                    ref={chartSplitRef}
                    className="token-left grid min-h-0 min-w-0"
                    style={{ '--chart-top': `${chartShare}fr`, '--chart-bottom': `${100 - chartShare}fr` } as CSSProperties}
                >
                    <div className="chart-panel flex min-h-0 flex-col overflow-hidden bg-[var(--term-bg)]">
                        <ChartToolbar
                            timeframe={interval}
                            pins={settings.chartPins}
                            style={settings.chartStyle}
                            quote={settings.chartQuote}
                            axis={settings.chartAxis}
                            volume={settings.chartVolume}
                            solUsd={solUsd}
                            full={chartFull}
                            onTimeframe={changeInterval}
                            onPins={(chartPins) => setSettings(value => ({ ...value, chartPins }))}
                            onStyle={(chartStyle) => setSettings(value => ({ ...value, chartStyle }))}
                            onQuote={(chartQuote) => setSettings(value => ({ ...value, chartQuote }))}
                            onAxis={(chartAxis) => setSettings(value => ({ ...value, chartAxis }))}
                            onVolume={() => setSettings(value => ({ ...value, chartVolume: !value.chartVolume }))}
                            onRefresh={() => setChartKey(value => value + 1)}
                            onFull={() => setChartFull(value => !value)}
                        />
                        <div className="relative min-h-0 flex-1">
                            <LightweightTokenChart dataset={chartDataset} height="100%" live={false} replayMode={false} axis={settings.chartAxis} onAxisChange={(chartAxis) => setSettings((value) => ({ ...value, chartAxis }))} autoScale={settings.chartAutoScale} onAutoScaleChange={(chartAutoScale) => setSettings((value) => ({ ...value, chartAutoScale }))} logScale={settings.chartLogScale} onLogScaleChange={(chartLogScale) => setSettings((value) => ({ ...value, chartLogScale }))} showVolume={settings.chartVolume} targetMarketCap={limitTarget} chartStyle={settings.chartStyle} quote={settings.chartQuote} solUsd={solUsd} compact drawTools />
                            {!candles.length && <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-[var(--term-dim)]">{replayMode ? replay?.snapshot.cursor ? 'Loading replay history…' : 'Play the replay to populate the chart' : 'Waiting for market candles'}</div>}
                        </div>
                    </div>
                    {!chartFull && (
                        <div
                            role="separator"
                            aria-label="Resize chart and activity panels"
                            aria-orientation="horizontal"
                            aria-valuemin={34}
                            aria-valuemax={78}
                            aria-valuenow={Math.round(chartShare)}
                            tabIndex={0}
                            onPointerDown={startChartResize}
                            onKeyDown={(event) => {
                                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                                event.preventDefault();
                                setChartShare((value) => Math.min(78, Math.max(34, value + (event.key === 'ArrowUp' ? -2 : 2))));
                            }}
                            className="chart-divider group relative cursor-row-resize touch-none select-none focus:outline-none"
                        >
                            <span className="pointer-events-none absolute left-1/2 top-1/2 h-[2px] w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/30 transition group-hover:bg-white/65 group-focus:bg-[var(--term-accent)]" />
                        </div>
                    )}
                    {!chartFull && <div className="activity-panel min-h-0 overflow-hidden"><TerminalActivity key={tokenMint} tokenMint={tokenMint} tokenDecimals={tokenDecimals} trades={trades} replayParticipants={participants} replayMode={replayMode} priceUsd={market.price} initialTab={activityTab} onInstantTrade={() => setInstantOpen(true)} now={replayMode ? replayNow : undefined} /></div>}
                </section>
                {!chartFull && <aside className="ticket-panel hidden min-h-0 overflow-hidden border-l border-[var(--term-border)] lg:block"><TradeTicket tokenMint={tokenMint} tokenSymbol={symbol} tokenDecimals={tokenDecimals} defaultAmount={ticketAmount} defaultSlippage={ticketSlippage} clearOnSuccess={settings.clearOnSuccess} currentMarketCap={market.marketCap ?? token?.market_cap} currentPrice={market.price ?? token?.price} totalSupply={totalSupply} flow={ticketFlow} participants={participants} replayMode={replayMode} onLimitChange={syncLimitTarget} /></aside>}
            </div>
            <div className="border-t border-[var(--term-border)] lg:hidden"><TradeTicket tokenMint={tokenMint} tokenSymbol={symbol} tokenDecimals={tokenDecimals} defaultAmount={ticketAmount} defaultSlippage={ticketSlippage} clearOnSuccess={settings.clearOnSuccess} currentMarketCap={market.marketCap ?? token?.market_cap} currentPrice={market.price ?? token?.price} totalSupply={totalSupply} flow={ticketFlow} participants={participants} replayMode={replayMode} /></div>
            {settings.showDock && <TerminalDock live={replayMode ? realtime.state : streamState} onSettings={() => openSettings()} />}
            <InstantTradePanel open={instantOpen} onClose={() => setInstantOpen(false)} tokenSymbol={symbol} />
            <TerminalSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings} initialSection={settingsSection} />
        </main>
    );
}
