'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    AreaSeries,
    BarSeries,
    BaselineSeries,
    CandlestickSeries,
    ColorType,
    CrosshairMode,
    HistogramSeries,
    LineStyle,
    LineSeries,
    LineType,
    PriceScaleMode,
    createChart,
    createSeriesMarkers,
    createTextWatermark,
    type IChartApi,
    type IRange,
    type ISeriesApi,
    type ITextWatermarkPluginApi,
    type SeriesMarker,
    type SeriesType,
    type Time,
    type UTCTimestamp,
} from 'lightweight-charts';
import {
    DrawingManager,
    TextAnnotation,
    getToolRegistry,
    type Anchor,
    type DrawingStyle,
    type IDrawing,
} from 'lightweight-charts-drawing';
import {
    type ChartDataset,
    type ChartQuote,
    type ChartStyle,
    type ChartTimeframe,
    type ChartValueMode,
    formatAxisValue,
    formatCompact,
    formatInterval,
    formatPrice,
    formatQuoteValue,
    getTimeframeLabel,
    latestLogicalRange,
    toDisplayValue,
} from '../../services/chartData';
import {
    ArrowPathIcon,
    ArrowUturnLeftIcon,
    PauseIcon,
    PlayIcon,
    TrashIcon,
} from '@heroicons/react/24/outline';
import ChartTimeframeDropdown from './ChartTimeframeDropdown';

interface LightweightTokenChartProps {
    dataset: ChartDataset;
    height?: number | string;
    live?: boolean;
    replayMode?: boolean;
    speedMs?: number;
    timeframe?: ChartTimeframe;
    onTimeframeChange?: (timeframe: ChartTimeframe) => void;
    onReplayStart?: () => void;
    onReplayPause?: () => void;
    onReplayReset?: () => void;
    onReplayComplete?: () => void;
    axis?: ChartValueMode;
    onAxisChange?: (mode: ChartValueMode) => void;
    autoScale?: boolean;
    logScale?: boolean;
    onAutoScaleChange?: (enabled: boolean) => void;
    onLogScaleChange?: (enabled: boolean) => void;
    showVolume?: boolean;
    targetMarketCap?: number;
    compact?: boolean;
    drawTools?: boolean;
    chartStyle?: ChartStyle;
    quote?: ChartQuote;
    solUsd?: number;
}

type MainSeries = ISeriesApi<SeriesType>;

type LibraryTool =
    | 'trend-line'
    | 'horizontal-line'
    | 'vertical-line'
    | 'parallel-channel'
    | 'fib-retracement'
    | 'date-price-range'
    | 'brush'
    | 'text-annotation'
    | 'rectangle';
type DrawTool = 'cursor' | LibraryTool;
type TextDraft = { point: Anchor; x: number; y: number; value: string };
type BrushDraft = { anchors: Anchor[]; lastX: number; lastY: number };

const drawingTools = [
    ['cursor', 'Cursor'],
    ['trend-line', 'Trend line'],
    ['horizontal-line', 'Horizontal line'],
    ['vertical-line', 'Vertical line'],
    ['parallel-channel', 'Parallel channel'],
    ['fib-retracement', 'Fibonacci retracement'],
    ['date-price-range', 'Date and price range'],
    ['brush', 'Brush'],
    ['text-annotation', 'Text'],
    ['rectangle', 'Rectangle'],
] as const;

function DrawGlyph({ tool }: { tool: DrawTool }) {
    const common = {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };
    if (tool === 'cursor') return <svg {...common}><path d="M12 2v20M2 12h20" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" strokeWidth="1.8" /></svg>;
    if (tool === 'trend-line') return <svg {...common}><path d="M4 18L19 5" /><circle cx="4" cy="18" r="2" /><circle cx="19" cy="5" r="2" /></svg>;
    if (tool === 'horizontal-line') return <svg {...common}><path d="M3 12h18" /><circle cx="17" cy="12" r="2" fill="currentColor" /></svg>;
    if (tool === 'vertical-line') return <svg {...common}><path d="M12 3v18" /><path d="M9 6l3-3 3 3M9 18l3 3 3-3" /></svg>;
    if (tool === 'parallel-channel') return <svg {...common}><path d="M3 8h15M6 16h15" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="16" r="2" /></svg>;
    if (tool === 'fib-retracement') return <svg {...common}><path d="M3 5h18M3 9h18M3 14h18M3 19h18" /><circle cx="5" cy="5" r="1.5" /><circle cx="19" cy="19" r="1.5" /></svg>;
    if (tool === 'date-price-range') return <svg {...common}><path d="M5 5v14M19 5v14M2 12h20M8 9l-3 3 3 3M16 9l3 3-3 3" /></svg>;
    if (tool === 'brush') return <svg {...common}><path d="M4 18c4-8 6-11 10-11 3 0 2 4 5 4" /><path d="M3 20c5 1 10 0 15-4" /></svg>;
    if (tool === 'text-annotation') return <svg {...common}><path d="M5 4h14M12 4v16M8 20h8" /></svg>;
    return <svg {...common}><rect x="4" y="4" width="16" height="16" /><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" /></svg>;
}

function toTime(timestamp: number): UTCTimestamp {
    return Math.floor(timestamp / 1000) as UTCTimestamp;
}

function withAlpha(color: string, alpha: number) {
    const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
    if (hex) {
        const red = Number.parseInt(hex.slice(0, 2), 16);
        const green = Number.parseInt(hex.slice(2, 4), 16);
        const blue = Number.parseInt(hex.slice(4, 6), 16);
        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }
    const rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
    return `rgba(245, 158, 11, ${alpha})`;
}

function toOhlcData(
    candles: ChartDataset['candles'],
    totalSupply: number,
    valueMode: ChartValueMode,
    quoteRate: number
) {
    return candles.map(candle => ({
        time: toTime(candle.timestamp),
        open: toDisplayValue(candle.open, totalSupply, valueMode, quoteRate),
        high: toDisplayValue(candle.high, totalSupply, valueMode, quoteRate),
        low: toDisplayValue(candle.low, totalSupply, valueMode, quoteRate),
        close: toDisplayValue(candle.close, totalSupply, valueMode, quoteRate),
    }));
}

function toMainData(
    candles: ChartDataset['candles'],
    totalSupply: number,
    valueMode: ChartValueMode,
    quoteRate: number,
    style: ChartStyle,
    buyColor: string,
    sellColor: string
) {
    const ohlc = toOhlcData(candles, totalSupply, valueMode, quoteRate);
    if (style === 'bars' || style === 'candles' || style === 'hollow') return ohlc;
    return ohlc.map((candle, index) => ({
        time: candle.time,
        value: style === 'hlc-area'
            ? (candle.high + candle.low + candle.close) / 3
            : candle.close,
        color: candles[index].close >= candles[index].open ? buyColor : sellColor,
    }));
}

function toVolumeData(candles: ChartDataset['candles'], quoteRate: number) {
    return candles.map(candle => ({
        time: toTime(candle.timestamp),
        value: candle.volumeUsd * quoteRate,
        color: candle.close >= candle.open ? 'rgba(93, 223, 108, 0.3)' : 'rgba(248, 113, 113, 0.32)',
    }));
}

function priceFormat(valueMode: ChartValueMode, quote: ChartQuote) {
    return {
        type: 'custom' as const,
        minMove: valueMode === 'market_cap' ? 0.01 : 0.000000001,
        formatter: (value: number) => formatAxisValue(Number(value), valueMode, quote),
    };
}

function addMainSeries(
    chart: IChartApi,
    style: ChartStyle,
    buyColor: string,
    sellColor: string,
    valueMode: ChartValueMode,
    quote: ChartQuote,
    baseValue: number,
    empty: boolean
): MainSeries {
    const clear = empty ? '#0f0f12' : undefined;
    const common = {
        priceFormat: priceFormat(valueMode, quote),
        lastValueVisible: !empty,
        priceLineVisible: !empty,
    };

    if (style === 'bars') return chart.addSeries(BarSeries, {
        ...common,
        upColor: clear ?? buyColor,
        downColor: clear ?? sellColor,
        openVisible: true,
        thinBars: true,
    });
    if (style === 'candles' || style === 'hollow') return chart.addSeries(CandlestickSeries, {
        ...common,
        upColor: style === 'hollow' && !empty ? 'transparent' : clear ?? buyColor,
        downColor: clear ?? sellColor,
        borderUpColor: clear ?? buyColor,
        borderDownColor: clear ?? sellColor,
        wickUpColor: clear ?? buyColor,
        wickDownColor: clear ?? sellColor,
    });
    if (style === 'line' || style === 'markers' || style === 'step') return chart.addSeries(LineSeries, {
        ...common,
        color: clear ?? buyColor,
        lineWidth: 2,
        lineType: style === 'step' ? LineType.WithSteps : LineType.Simple,
        pointMarkersVisible: style === 'markers' && !empty,
        pointMarkersRadius: 2.5,
    });
    if (style === 'baseline') return chart.addSeries(BaselineSeries, {
        ...common,
        baseValue: { type: 'price', price: baseValue },
        topLineColor: clear ?? buyColor,
        topFillColor1: empty ? 'transparent' : withAlpha(buyColor, 0.28),
        topFillColor2: 'transparent',
        bottomLineColor: clear ?? sellColor,
        bottomFillColor1: 'transparent',
        bottomFillColor2: empty ? 'transparent' : withAlpha(sellColor, 0.28),
    });
    if (style === 'columns') return chart.addSeries(HistogramSeries, {
        ...common,
        color: clear ?? buyColor,
        base: 0,
    });
    return chart.addSeries(AreaSeries, {
        ...common,
        lineColor: clear ?? (style === 'hlc-area' ? '#7c8dff' : buyColor),
        lineWidth: 2,
        topColor: empty ? 'transparent' : withAlpha(style === 'hlc-area' ? '#7c8dff' : buyColor, 0.3),
        bottomColor: 'transparent',
    });
}

function applyMainColors(
    series: MainSeries,
    style: ChartStyle,
    buyColor: string,
    sellColor: string,
    empty: boolean
) {
    const clear = empty ? '#0f0f12' : undefined;
    const visibility = { lastValueVisible: !empty, priceLineVisible: !empty };
    if (style === 'bars') {
        (series as ISeriesApi<'Bar'>).applyOptions({ ...visibility, upColor: clear ?? buyColor, downColor: clear ?? sellColor });
    } else if (style === 'candles' || style === 'hollow') {
        (series as ISeriesApi<'Candlestick'>).applyOptions({
            ...visibility,
            upColor: style === 'hollow' && !empty ? 'transparent' : clear ?? buyColor,
            downColor: clear ?? sellColor,
            borderUpColor: clear ?? buyColor,
            borderDownColor: clear ?? sellColor,
            wickUpColor: clear ?? buyColor,
            wickDownColor: clear ?? sellColor,
        });
    } else if (style === 'line' || style === 'markers' || style === 'step') {
        (series as ISeriesApi<'Line'>).applyOptions({ ...visibility, color: clear ?? buyColor, pointMarkersVisible: style === 'markers' && !empty });
    } else if (style === 'area' || style === 'hlc-area') {
        const color = style === 'hlc-area' ? '#7c8dff' : buyColor;
        (series as ISeriesApi<'Area'>).applyOptions({ ...visibility, lineColor: clear ?? color, topColor: empty ? 'transparent' : withAlpha(color, 0.3) });
    } else if (style === 'baseline') {
        (series as ISeriesApi<'Baseline'>).applyOptions({ ...visibility, topLineColor: clear ?? buyColor, bottomLineColor: clear ?? sellColor });
    } else {
        (series as ISeriesApi<'Histogram'>).applyOptions({ ...visibility, color: clear ?? buyColor });
    }
}

function axisModeButtonClass(isActive: boolean) {
    return [
        'h-11 border-l border-slate-800 px-3 text-xs font-normal transition-colors',
        isActive
            ? 'bg-slate-800/80 text-white'
            : 'text-slate-500 hover:bg-slate-900/80 hover:text-slate-200',
    ].join(' ');
}

function focusLatest(chart: IChartApi, candleCount: number, compact: boolean) {
    chart.timeScale().setVisibleLogicalRange(latestLogicalRange(candleCount, compact));
}

const emptyGridBars = 181;

function emptyCandles(intervalSeconds: number, valueMode: ChartValueMode) {
    const step = Math.max(1, Math.floor(intervalSeconds));
    const end = Math.floor(Date.now() / 1_000 / step) * step;
    const high = valueMode === 'market_cap' ? 100_000 : 0.0001;
    return Array.from({ length: emptyGridBars }, (_, index) => {
        const value = index % 2 === 0 ? 0 : high;
        return {
            time: (end - (emptyGridBars - index - 1) * step) as UTCTimestamp,
            open: value,
            high: value,
            low: value,
            close: value,
        };
    });
}

function emptyMainData(intervalSeconds: number, valueMode: ChartValueMode, style: ChartStyle) {
    const data = emptyCandles(intervalSeconds, valueMode);
    if (style === 'bars' || style === 'candles' || style === 'hollow') return data;
    return data.map(item => ({ time: item.time, value: item.close, color: '#0f0f12' }));
}

function watermarkLines(
    dataset: ChartDataset,
    candle: ChartDataset['candles'][number] | undefined,
    valueMode: ChartValueMode,
    timeframe: ChartTimeframe | undefined,
    fontFamily: string,
    quote: ChartQuote,
    quoteRate: number
) {
    const priceChange = candle && candle.open > 0 ? (candle.close - candle.open) / candle.open : 0;
    let value = 'Waiting for chart data';
    if (candle && valueMode === 'market_cap') {
        value = `MCap ${formatQuoteValue(candle.marketCapUsd * quoteRate, quote)} · Price ${quote === 'sol' ? `${formatPrice(candle.close * quoteRate)} SOL` : `$${formatPrice(candle.close)}`}`;
    } else if (candle) {
        value = `Price ${quote === 'sol' ? `${formatPrice(candle.close * quoteRate)} SOL` : `$${formatPrice(candle.close)}`} · MCap ${formatQuoteValue(candle.marketCapUsd * quoteRate, quote)}`;
    }

    return [
        {
            text: ' ',
            color: 'transparent',
            fontSize: 7,
            lineHeight: 9,
            fontFamily,
            fontStyle: '400',
        },
        {
            text: `  ${dataset.tokenSymbol}/SOL · ${timeframe ? getTimeframeLabel(timeframe) : formatInterval(dataset.intervalSeconds)}`,
            color: '#e4e4e7',
            fontSize: 14,
            lineHeight: 22,
            fontFamily,
            fontStyle: '500',
        },
        {
            text: `  ${value}`,
            color: priceChange >= 0 ? '#2eddb2' : '#f83279',
            fontSize: 13,
            lineHeight: 19,
            fontFamily,
            fontStyle: '500',
        },
    ];
}

export default function LightweightTokenChart({
    dataset,
    height = 520,
    live = false,
    replayMode = live,
    speedMs = 80,
    timeframe,
    onTimeframeChange,
    onReplayStart,
    onReplayPause,
    onReplayReset,
    onReplayComplete,
    axis,
    onAxisChange,
    autoScale = true,
    logScale = false,
    onAutoScaleChange,
    onLogScaleChange,
    showVolume = true,
    targetMarketCap,
    compact = false,
    drawTools = false,
    chartStyle = 'candles',
    quote = 'usd',
    solUsd,
}: LightweightTokenChartProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const drawLayerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<MainSeries | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
    const replayIndexRef = useRef(0);
    const onReplayCompleteRef = useRef(onReplayComplete);
    const onAutoScaleRef = useRef(onAutoScaleChange);
    const datasetRef = useRef(dataset);
    const followRef = useRef(true);
    const priceAutoRef = useRef(autoScale);
    const logRef = useRef(logScale);
    const volumeVisibleRef = useRef(showVolume);
    const timeRangeRef = useRef<IRange<number> | null>(null);
    const priceRangeRef = useRef<IRange<number> | null>(null);
    const intervalRef = useRef(dataset.intervalSeconds);
    const dataKeyRef = useRef('');
    const firstTimeRef = useRef<number | undefined>(undefined);
    const lastTimeRef = useRef<number | undefined>(undefined);
    const dataCountRef = useRef(0);
    const trimCountRef = useRef(0);
    const drawManagerRef = useRef<DrawingManager | null>(null);
    const pendingRef = useRef<Anchor[]>([]);
    const previewRef = useRef<IDrawing | null>(null);
    const brushRef = useRef<BrushDraft | null>(null);
    const [renderMs, setRenderMs] = useState<number | null>(null);
    const [visibleCount, setVisibleCount] = useState(0);
    const [internalMode, setInternalMode] = useState<ChartValueMode>('market_cap');
    const [drawTool, setDrawTool] = useState<DrawTool>('cursor');
    const [drawingIds, setDrawingIds] = useState<string[]>([]);
    const [textDraft, setTextDraft] = useState<TextDraft>();
    const [drawApi, setDrawApi] = useState<{
        chart: IChartApi;
        series: MainSeries;
    }>();
    const [autoActive, setAutoActive] = useState(autoScale);
    const [logActive, setLogActive] = useState(logScale);
    const valueMode = axis || internalMode;
    const quoteRate = quote === 'sol' && solUsd && solUsd > 0 ? 1 / solUsd : 1;
    const setValueMode = (mode: ChartValueMode) => {
        if (axis === undefined) setInternalMode(mode);
        onAxisChange?.(mode);
    };
    useEffect(() => {
        followRef.current = true;
        timeRangeRef.current = null;
        priceRangeRef.current = null;
    }, [dataset.tokenAddress]);

    useEffect(() => {
        drawManagerRef.current?.clearAll();
        pendingRef.current = [];
        previewRef.current = null;
        brushRef.current = null;
        setDrawingIds([]);
        setTextDraft(undefined);
        setDrawTool('cursor');
        drawManagerRef.current?.setActiveTool(null);
    }, [dataset.tokenAddress, valueMode]);

    useEffect(() => {
        datasetRef.current = dataset;
    }, [dataset]);

    useEffect(() => {
        onReplayCompleteRef.current = onReplayComplete;
    }, [onReplayComplete]);

    useEffect(() => {
        onAutoScaleRef.current = onAutoScaleChange;
    }, [onAutoScaleChange]);

    useEffect(() => {
        priceAutoRef.current = autoScale;
        setAutoActive(autoScale);
        if (autoScale) priceRangeRef.current = null;
        candleSeriesRef.current?.priceScale().setAutoScale(autoScale);
    }, [autoScale]);

    useEffect(() => {
        if (intervalRef.current === dataset.intervalSeconds) return;
        intervalRef.current = dataset.intervalSeconds;
        followRef.current = true;
        priceAutoRef.current = true;
        timeRangeRef.current = null;
        priceRangeRef.current = null;
        chartRef.current?.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: true });
        candleSeriesRef.current?.priceScale().setAutoScale(true);
        setAutoActive(true);
        onAutoScaleRef.current?.(true);
    }, [dataset.intervalSeconds]);

    useEffect(() => {
        volumeVisibleRef.current = showVolume;
        volumeSeriesRef.current?.applyOptions({ visible: showVolume });
    }, [showVolume]);

    useEffect(() => {
        setLogActive(logScale);
        logRef.current = logScale;
        chartRef.current?.priceScale('right').applyOptions({
            mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        });
    }, [logScale]);

    const initialCount = useMemo(() => {
        const length = dataset.candles.length;
        if (!replayMode) return length;
        return Math.min(length, Math.max(1, Math.min(140, Math.max(20, Math.floor(length * 0.38)))));
    }, [dataset.candles.length, replayMode]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const current = datasetRef.current;
        const currentCount = replayMode
            ? Math.min(current.candles.length, Math.max(1, Math.min(140, Math.max(20, Math.floor(current.candles.length * 0.38)))))
            : current.candles.length;
        const startedAt = performance.now();
        const chartFontFamily =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--font-geist')
                .trim() || 'Geist';
        const styles = getComputedStyle(container);
        const buyColor = styles.getPropertyValue('--term-buy').trim() || '#5ddf6c';
        const sellColor = styles.getPropertyValue('--term-sell').trim() || '#f87171';
        const chart = createChart(container, {
            autoSize: true,
            layout: {
                background: { type: ColorType.Solid, color: '#0f0f12' },
                textColor: '#f5f5f5',
                fontFamily: `${chartFontFamily}, system-ui, sans-serif`,
            },
            grid: {
                vertLines: { visible: true, color: 'rgba(161, 161, 170, 0.13)', style: LineStyle.Dotted },
                horzLines: { visible: true, color: 'rgba(161, 161, 170, 0.13)', style: LineStyle.Dotted },
            },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: { color: 'rgba(161, 161, 170, 0.62)', style: LineStyle.Dashed, labelBackgroundColor: '#222225' },
                horzLine: { color: 'rgba(161, 161, 170, 0.62)', style: LineStyle.Dashed, labelBackgroundColor: '#222225' },
            },
            rightPriceScale: {
                visible: true,
                autoScale: true,
                mode: logRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
                borderColor: 'rgba(161, 161, 170, 0.24)',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: {
                visible: true,
                borderColor: 'rgba(161, 161, 170, 0.24)',
                timeVisible: true,
                secondsVisible: true,
                rightOffset: compact ? 8 : 12,
                barSpacing: 6,
                minBarSpacing: 1.5,
                maxBarSpacing: compact ? 24 : 30,
                fixLeftEdge: false,
                fixRightEdge: false,
                lockVisibleTimeRangeOnResize: true,
                rightBarStaysOnScroll: true,
                shiftVisibleRangeOnNewBar: followRef.current,
            },
            handleScale: {
                mouseWheel: true,
                pinch: true,
                axisPressedMouseMove: true,
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: true,
            },
        });

        const initialCandles = current.candles.slice(0, currentCount);
        const initialBase = toDisplayValue(
            initialCandles[0]?.close ?? 0,
            current.totalSupply,
            valueMode,
            quoteRate
        );
        const candleSeries = addMainSeries(
            chart,
            chartStyle,
            buyColor,
            sellColor,
            valueMode,
            quote,
            initialBase,
            !initialCandles.length
        );
        const volumeSeries = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            lastValueVisible: false,
            priceLineVisible: false,
        });

        volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.78, bottom: 0 },
        });

        candleSeries.setData(initialCandles.length
            ? toMainData(initialCandles, current.totalSupply, valueMode, quoteRate, chartStyle, buyColor, sellColor)
            : emptyMainData(current.intervalSeconds, valueMode, chartStyle));
        applyMainColors(candleSeries, chartStyle, buyColor, sellColor, !initialCandles.length);
        volumeSeries.setData(toVolumeData(initialCandles, quoteRate));
        volumeSeries.applyOptions({ visible: volumeVisibleRef.current });
        dataKeyRef.current = `${current.tokenAddress}:${current.intervalSeconds}:${valueMode}:${quote}:${chartStyle}`;
        firstTimeRef.current = initialCandles[0]?.timestamp;
        lastTimeRef.current = initialCandles.at(-1)?.timestamp;
        dataCountRef.current = initialCandles.length;
        trimCountRef.current = 0;

        current.alertLines.forEach(line => {
            candleSeries.createPriceLine({
                price: (valueMode === 'market_cap' ? line.marketCapUsd : line.priceUsd) * quoteRate,
                color: line.color,
                lineWidth: 1,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: line.label,
            });
        });

        const markers: SeriesMarker<Time>[] = current.markers.map(marker => ({
            time: toTime(marker.timestamp),
            position: marker.side === 'buy' ? 'belowBar' : 'aboveBar',
            color: marker.side === 'buy' ? buyColor : marker.side === 'sell' ? sellColor : '#f59e0b',
            shape: marker.side === 'buy' ? 'arrowUp' : marker.side === 'sell' ? 'arrowDown' : 'circle',
            text: marker.label,
            size: marker.intensity === 'high' ? 1.6 : 1.2,
            price: toDisplayValue(marker.price, current.totalSupply, valueMode, quoteRate),
        }));
        createSeriesMarkers(candleSeries, markers);

        const watermark = createTextWatermark(chart.panes()[0], {
            horzAlign: 'left',
            vertAlign: 'top',
            lines: watermarkLines(
                current,
                initialCandles.at(-1),
                valueMode,
                undefined,
                `${chartFontFamily}, system-ui, sans-serif`,
                quote,
                quoteRate
            ),
        });
        watermarkRef.current = watermark;

        let disposed = false;
        let emptyFitFrame: number | undefined;
        const fitEmptyChart = () => {
            if (emptyFitFrame !== undefined) window.cancelAnimationFrame(emptyFitFrame);
            emptyFitFrame = window.requestAnimationFrame(() => {
                if (!disposed && dataCountRef.current === 0 && followRef.current) {
                    chart.timeScale().fitContent();
                }
            });
        };
        const emptyResize = new ResizeObserver(fitEmptyChart);
        emptyResize.observe(container);
        if (followRef.current) {
            if (initialCandles.length) focusLatest(chart, initialCandles.length, compact);
            else {
                chart.timeScale().fitContent();
                fitEmptyChart();
            }
        }
        else if (timeRangeRef.current) chart.timeScale().setVisibleLogicalRange(timeRangeRef.current);
        if (!priceAutoRef.current) {
            const range = priceRangeRef.current;
            candleSeries.priceScale().setAutoScale(false);
            if (range) candleSeries.priceScale().setVisibleRange(range);
        }

        chartRef.current = chart;
        candleSeriesRef.current = candleSeries;
        volumeSeriesRef.current = volumeSeries;
        const drawManager = drawManagerRef.current ?? new DrawingManager();
        drawManagerRef.current = drawManager;
        drawManager.attach(chart, candleSeries, container);
        setDrawApi({ chart, series: candleSeries });
        setAutoActive(priceAutoRef.current);
        replayIndexRef.current = currentCount;
        setVisibleCount(initialCandles.length);
        setRenderMs(performance.now() - startedAt);

        let dragStart: { x: number; y: number } | undefined;
        const captureRange = () => {
            if (disposed) return;
            priceRangeRef.current = candleSeries.priceScale().getVisibleRange();
        };
        const trackRange = (range: IRange<number> | null) => {
            if (!followRef.current) timeRangeRef.current = range;
        };
        const suspendFollow = () => {
            if (followRef.current) {
                followRef.current = false;
                chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: false });
            }
            if (priceAutoRef.current) {
                priceAutoRef.current = false;
                candleSeries.priceScale().setAutoScale(false);
                setAutoActive(false);
                onAutoScaleRef.current?.(false);
            }
            window.requestAnimationFrame(captureRange);
        };
        const beginDrag = (event: PointerEvent) => {
            dragStart = { x: event.clientX, y: event.clientY };
        };
        const trackDrag = (event: PointerEvent) => {
            if (!dragStart || event.buttons === 0) return;
            if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) >= 3) {
                suspendFollow();
            }
        };
        const endDrag = () => {
            dragStart = undefined;
            window.requestAnimationFrame(captureRange);
        };

        const chartElement = chart.chartElement();
        chart.timeScale().subscribeVisibleLogicalRangeChange(trackRange);
        chartElement.addEventListener('wheel', suspendFollow, { passive: true });
        chartElement.addEventListener('pointerdown', beginDrag);
        chartElement.addEventListener('pointermove', trackDrag);
        chartElement.addEventListener('pointerup', endDrag);
        chartElement.addEventListener('pointercancel', endDrag);

        return () => {
            if (!followRef.current) captureRange();
            disposed = true;
            if (emptyFitFrame !== undefined) window.cancelAnimationFrame(emptyFitFrame);
            emptyResize.disconnect();
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(trackRange);
            chartElement.removeEventListener('wheel', suspendFollow);
            chartElement.removeEventListener('pointerdown', beginDrag);
            chartElement.removeEventListener('pointermove', trackDrag);
            chartElement.removeEventListener('pointerup', endDrag);
            chartElement.removeEventListener('pointercancel', endDrag);
            drawManager.detach();
            watermark.detach();
            chart.remove();
            setDrawApi(undefined);
            chartRef.current = null;
            candleSeriesRef.current = null;
            volumeSeriesRef.current = null;
            watermarkRef.current = null;
            dataKeyRef.current = '';
            firstTimeRef.current = undefined;
            lastTimeRef.current = undefined;
            dataCountRef.current = 0;
            trimCountRef.current = 0;
        };
    }, [chartStyle, compact, dataset.tokenAddress, dataset.totalSupply, quote, quoteRate, replayMode, valueMode]);

    useEffect(() => {
        const series = drawApi?.series;
        if (!series || !Number.isFinite(targetMarketCap) || Number(targetMarketCap) <= 0) return;
        const target = valueMode === 'market_cap'
            ? Number(targetMarketCap) * quoteRate
            : Number(targetMarketCap) / dataset.totalSupply * quoteRate;
        if (!Number.isFinite(target) || target <= 0) return;
        const line = series.createPriceLine({
            price: target,
            color: '#fde047',
            lineWidth: 2,
            lineStyle: LineStyle.Dotted,
            lineVisible: true,
            axisLabelVisible: true,
            title: 'Limit Order Target',
            axisLabelColor: '#fde047',
            axisLabelTextColor: '#18181b',
        });
        return () => {
            try {
                series.removePriceLine(line);
            } catch {
                // The chart may already be disposing during a token or axis change.
            }
        };
    }, [dataset.totalSupply, drawApi, quoteRate, targetMarketCap, valueMode]);

    useEffect(() => {
        if (live) return;
        const candleSeries = candleSeriesRef.current;
        const volumeSeries = volumeSeriesRef.current;
        const container = containerRef.current;
        if (!candleSeries || !volumeSeries || !container) return;
        const gridData = dataset.candles.length
            ? []
            : emptyMainData(dataset.intervalSeconds, valueMode, chartStyle);
        const styles = getComputedStyle(container);
        const buyColor = styles.getPropertyValue('--term-buy').trim() || '#5ddf6c';
        const sellColor = styles.getPropertyValue('--term-sell').trim() || '#f87171';
        const empty = dataset.candles.length === 0;
        applyMainColors(candleSeries, chartStyle, buyColor, sellColor, empty);
        const nextKey = `${dataset.tokenAddress}:${dataset.intervalSeconds}:${valueMode}:${quote}:${chartStyle}`;
        const firstTime = dataset.candles[0]?.timestamp;
        const lastTime = dataset.candles.at(-1)?.timestamp;
        const previousLast = lastTimeRef.current;
        const firstPopulation = dataCountRef.current === 0 && dataset.candles.length > 0;
        const previousLastIndex = previousLast === undefined
            ? -1
            : dataset.candles.findIndex((candle) => candle.timestamp === previousLast);
        const advanced = previousLast !== undefined && lastTime !== undefined && lastTime > previousLast;
        const windowShift = firstTimeRef.current !== firstTime
            && dataset.candles.length === dataCountRef.current
            && advanced;
        const shiftedBars = windowShift && previousLastIndex >= 0
            ? dataset.candles.length - previousLastIndex - 1
            : 0;
        const requiresReset = dataKeyRef.current !== nextKey
            || dataset.candles.length < dataCountRef.current
            || (firstTimeRef.current !== firstTime
                && (!windowShift || trimCountRef.current + shiftedBars >= 250))
            || (previousLast !== undefined && lastTime !== undefined && lastTime < previousLast)
            || (advanced && previousLastIndex < 0);
        if (requiresReset) {
            const priceRange = candleSeries.priceScale().getVisibleRange();
            const timeRange = chartRef.current?.timeScale().getVisibleLogicalRange();
            const removedBars = previousLastIndex >= 0
                ? trimCountRef.current + shiftedBars
                : 0;
            candleSeries.setData(empty
                ? gridData
                : toMainData(dataset.candles, dataset.totalSupply, valueMode, quoteRate, chartStyle, buyColor, sellColor));
            volumeSeries.setData(toVolumeData(dataset.candles, quoteRate));
            if (!priceAutoRef.current && priceRange) {
                candleSeries.priceScale().setVisibleRange(priceRange);
                priceRangeRef.current = priceRange;
            }
            if (!followRef.current && timeRange) {
                const range = removedBars > 0
                    ? { from: timeRange.from - removedBars, to: timeRange.to - removedBars }
                    : timeRange;
                chartRef.current?.timeScale().setVisibleLogicalRange(range);
                timeRangeRef.current = range;
            }
            trimCountRef.current = 0;
        } else if (dataset.candles.length) {
            const from = previousLast === undefined
                ? 0
                : Math.max(0, dataset.candles.findIndex((candle) => candle.timestamp >= previousLast));
            for (const candle of dataset.candles.slice(from)) {
                candleSeries.update(toMainData([candle], dataset.totalSupply, valueMode, quoteRate, chartStyle, buyColor, sellColor)[0]);
                volumeSeries.update(toVolumeData([candle], quoteRate)[0]);
            }
            if (windowShift) trimCountRef.current += shiftedBars;
        }
        volumeSeries.applyOptions({ visible: volumeVisibleRef.current });
        candleSeries.priceScale().setAutoScale(priceAutoRef.current);
        if (followRef.current && (firstPopulation || requiresReset)) {
            const chart = chartRef.current;
            if (chart) {
                if (dataset.candles.length) focusLatest(chart, dataset.candles.length, compact);
                else chart.timeScale().fitContent();
            }
        }
        setAutoActive(priceAutoRef.current);
        dataKeyRef.current = nextKey;
        firstTimeRef.current = firstTime;
        lastTimeRef.current = lastTime;
        dataCountRef.current = dataset.candles.length;
        setVisibleCount(dataset.candles.length);
    }, [chartStyle, compact, dataset.candles, dataset.intervalSeconds, dataset.tokenAddress, dataset.totalSupply, live, quote, quoteRate, valueMode]);

    useEffect(() => {
        if (!live) return;
        const interval = window.setInterval(() => {
            const candleSeries = candleSeriesRef.current;
            const volumeSeries = volumeSeriesRef.current;
            if (!candleSeries || !volumeSeries) return;

            const next = dataset.candles[replayIndexRef.current];
            if (!next) {
                replayIndexRef.current = dataset.candles.length;
                setVisibleCount(dataset.candles.length);
                onReplayCompleteRef.current?.();
                window.clearInterval(interval);
                return;
            }

            const container = containerRef.current;
            const styles = container ? getComputedStyle(container) : undefined;
            const buyColor = styles?.getPropertyValue('--term-buy').trim() || '#5ddf6c';
            const sellColor = styles?.getPropertyValue('--term-sell').trim() || '#f87171';
            candleSeries.update(toMainData([next], dataset.totalSupply, valueMode, quoteRate, chartStyle, buyColor, sellColor)[0]);
            volumeSeries.update(toVolumeData([next], quoteRate)[0]);
            replayIndexRef.current += 1;
            setVisibleCount(replayIndexRef.current);
        }, speedMs);

        return () => window.clearInterval(interval);
    }, [chartStyle, dataset.candles, dataset.totalSupply, live, quoteRate, speedMs, valueMode]);

    const pointFrom = (clientX: number, clientY: number) => {
        const layer = drawLayerRef.current;
        const chart = chartRef.current;
        const series = candleSeriesRef.current;
        if (!layer || !chart || !series) return undefined;

        const rect = layer.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
        const time = chart.timeScale().coordinateToTime(x);
        const price = series.coordinateToPrice(y);
        if (time === null || price === null) return undefined;

        return { point: { time, price: Number(price) }, x, y };
    };

    const getAccent = () => {
        const node = drawLayerRef.current ?? containerRef.current;
        if (!node) return '#f97316';
        return getComputedStyle(node).getPropertyValue('--term-accent').trim() || '#f97316';
    };

    const getDrawStyle = (preview = false): Partial<DrawingStyle> => {
        const accent = getAccent();
        return {
            lineColor: accent,
            lineWidth: preview ? 1 : 1.5,
            lineDash: preview ? [4, 4] : [],
            fillColor: withAlpha(accent, preview ? 0.06 : 0.12),
            fillOpacity: 1,
            showLabels: !preview,
            labelFont: '500 11px Geist, system-ui, sans-serif',
            labelColor: accent,
        };
    };

    const removePreview = () => {
        const preview = previewRef.current;
        if (preview) drawManagerRef.current?.removeDrawing(preview.id);
        previewRef.current = null;
    };

    const cancelPlacement = () => {
        removePreview();
        pendingRef.current = [];
        brushRef.current = null;
        setTextDraft(undefined);
        setDrawTool('cursor');
        drawManagerRef.current?.setActiveTool(null);
    };

    const showPreview = (tool: LibraryTool, anchors: Anchor[], pointer?: Anchor) => {
        const manager = drawManagerRef.current;
        const definition = getToolRegistry().get(tool);
        if (!manager || !definition || anchors.length === 0) return;

        const previewAnchors = [...anchors];
        if (pointer) previewAnchors.push(pointer);
        const last = previewAnchors.at(-1);
        if (!last) return;
        while (previewAnchors.length < definition.requiredAnchors) {
            previewAnchors.push(last);
        }

        if (previewRef.current?.type === tool) {
            previewRef.current.setAnchors(previewAnchors);
            return;
        }

        removePreview();
        const preview = getToolRegistry().createDrawing(
            tool,
            `preview-${crypto.randomUUID()}`,
            previewAnchors,
            getDrawStyle(true),
            { locked: true }
        );
        if (!preview) return;
        manager.addDrawing(preview);
        previewRef.current = preview;
    };

    const finishDrawing = (tool: LibraryTool, anchors: Anchor[], text?: string) => {
        const manager = drawManagerRef.current;
        if (!manager) return;
        removePreview();

        const id = crypto.randomUUID();
        const style = getDrawStyle();
        const drawing = tool === 'text-annotation'
            ? new TextAnnotation(id, anchors, style, {
                text: text ?? '',
                fontSize: 12,
                fontFamily: 'Geist, system-ui, sans-serif',
                fontWeight: '500',
                backgroundColor: 'rgba(15, 15, 18, 0.92)',
                borderColor: getAccent(),
                padding: 5,
            })
            : getToolRegistry().createDrawing(tool, id, anchors, style);

        if (drawing) {
            manager.addDrawing(drawing);
            manager.selectDrawing(id);
            setDrawingIds((current) => [...current, id]);
        }

        pendingRef.current = [];
        brushRef.current = null;
        setTextDraft(undefined);
        setDrawTool('cursor');
        manager.setActiveTool(null);
    };

    const chooseTool = (tool: DrawTool) => {
        removePreview();
        pendingRef.current = [];
        brushRef.current = null;
        setTextDraft(undefined);
        setDrawTool(tool);
        const manager = drawManagerRef.current;
        manager?.deselectAll();
        manager?.setActiveTool(tool === 'cursor' ? null : tool);
    };

    const placeAnchor = (tool: LibraryTool, point: Anchor) => {
        const definition = getToolRegistry().get(tool);
        if (!definition) return;
        const anchors = [...pendingRef.current, point];
        if (anchors.length >= definition.requiredAnchors) {
            finishDrawing(tool, anchors);
            return;
        }
        pendingRef.current = anchors;
        showPreview(tool, anchors);
    };

    const handleDrawDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drawTool === 'cursor') return;
        const next = pointFrom(event.clientX, event.clientY);
        if (!next) return;
        event.preventDefault();

        if (drawTool === 'text-annotation') {
            setTextDraft({ point: next.point, x: next.x, y: next.y, value: '' });
            return;
        }
        if (drawTool === 'brush') {
            removePreview();
            pendingRef.current = [];
            brushRef.current = { anchors: [next.point], lastX: next.x, lastY: next.y };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
        }
        placeAnchor(drawTool, next.point);
    };

    const handleDrawMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const next = pointFrom(event.clientX, event.clientY);
        if (!next) return;
        const brush = brushRef.current;
        if (brush) {
            if (Math.hypot(next.x - brush.lastX, next.y - brush.lastY) < 3) return;
            brush.anchors.push(next.point);
            brush.lastX = next.x;
            brush.lastY = next.y;
            if (brush.anchors.length >= 2) showPreview('brush', brush.anchors);
            return;
        }
        if (drawTool !== 'cursor' && drawTool !== 'text-annotation' && pendingRef.current.length) {
            showPreview(drawTool, pendingRef.current, next.point);
        }
    };

    const handleDrawUp = (event: React.PointerEvent<HTMLDivElement>) => {
        const brush = brushRef.current;
        if (!brush) return;
        const next = pointFrom(event.clientX, event.clientY);
        if (next && Math.hypot(next.x - brush.lastX, next.y - brush.lastY) >= 1) {
            brush.anchors.push(next.point);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (brush.anchors.length >= 2) finishDrawing('brush', brush.anchors);
        else cancelPlacement();
    };

    const commitText = () => {
        if (!textDraft) return;
        const text = textDraft.value.trim();
        if (text) finishDrawing('text-annotation', [textDraft.point], text);
        else cancelPlacement();
    };

    const undoDrawing = () => {
        cancelPlacement();
        setDrawingIds((current) => {
            const id = current.at(-1);
            if (id) drawManagerRef.current?.removeDrawing(id);
            return current.slice(0, -1);
        });
    };

    const clearDrawings = () => {
        cancelPlacement();
        drawManagerRef.current?.clearAll();
        setDrawingIds([]);
    };

    useEffect(() => {
        if (!drawTools) return;
        const handleKey = (event: KeyboardEvent) => {
            const target = event.target;
            const isTyping = target instanceof HTMLElement
                && (target.matches('input, textarea, [contenteditable="true"]'));

            if (event.key === 'Escape') {
                const preview = previewRef.current;
                if (preview) drawManagerRef.current?.removeDrawing(preview.id);
                previewRef.current = null;
                pendingRef.current = [];
                brushRef.current = null;
                setTextDraft(undefined);
                setDrawTool('cursor');
                drawManagerRef.current?.setActiveTool(null);
                return;
            }
            if (isTyping || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
            const selected = drawManagerRef.current?.getSelectedDrawing();
            if (!selected) return;
            event.preventDefault();
            drawManagerRef.current?.removeDrawing(selected.id);
            setDrawingIds((current) => current.filter((id) => id !== selected.id));
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [drawTools]);

    const latest = useMemo(() => (
        dataset.candles[Math.min(visibleCount || initialCount, dataset.candles.length) - 1]
        ?? dataset.candles[0]
        ?? {
            timestamp: 0, open: 0, high: 0, low: 0, close: 0, volumeUsd: 0, volumeTokens: 0,
            tradeCount: 0, buyCount: 0, sellCount: 0, uniqueBuyers: 0, uniqueSellers: 0,
            marketCapUsd: 0, liquidityUsd: 0,
        }
    ), [dataset.candles, initialCount, visibleCount]);
    const isReplayComplete = replayMode && visibleCount >= dataset.candles.length;
    const hasReplayControls = replayMode && onReplayStart && onReplayPause;
    const feedLabel = dataset.source.mode === 'historical_replay' ? 'Replay' : 'Live';
    useEffect(() => {
        const watermark = watermarkRef.current;
        const container = containerRef.current;
        if (!watermark || !container) return;
        const fontFamily =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--font-geist')
                .trim() || 'Geist';
        watermark.applyOptions({
            lines: watermarkLines(
                dataset,
                latest,
                valueMode,
                timeframe,
                `${fontFamily}, system-ui, sans-serif`,
                quote,
                quoteRate
            ),
        });
    }, [dataset, latest, quote, quoteRate, timeframe, valueMode]);

    const startReplay = () => {
        if (isReplayComplete && onReplayReset) {
            onReplayReset();
        }

        onReplayStart?.();
    };

    const enableAutoScale = () => {
        const series = candleSeriesRef.current;
        if (!series) return;
        priceAutoRef.current = true;
        priceRangeRef.current = null;
        series.priceScale().setAutoScale(true);
        setAutoActive(true);
        onAutoScaleChange?.(true);
    };

    const toggleLogScale = () => {
        const enabled = !logActive;
        chartRef.current?.priceScale('right').applyOptions({
            mode: enabled ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        });
        setLogActive(enabled);
        onLogScaleChange?.(enabled);
    };

    const priceChangePercent = latest.open > 0 ? ((latest.close - latest.open) / latest.open) * 100 : 0;
    const priceChangeClass = priceChangePercent >= 0 ? 'text-[var(--term-buy)]' : 'text-[var(--term-sell)]';
    const primaryValue = valueMode === 'market_cap'
        ? formatQuoteValue(latest.marketCapUsd * quoteRate, quote)
        : quote === 'sol' ? `${formatPrice(latest.close * quoteRate)} SOL` : `$${formatPrice(latest.close)}`;
    const openValue = toDisplayValue(latest.open, dataset.totalSupply, valueMode, quoteRate);
    const highValue = toDisplayValue(latest.high, dataset.totalSupply, valueMode, quoteRate);
    const lowValue = toDisplayValue(latest.low, dataset.totalSupply, valueMode, quoteRate);
    const closeValue = toDisplayValue(latest.close, dataset.totalSupply, valueMode, quoteRate);

    return (
        <section className={`h-full overflow-hidden bg-[#0f0f12] text-slate-200 ${compact ? '' : 'min-h-[420px] border-y border-slate-800'}`}>
            {!compact && <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-slate-800/90 px-4 py-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1">
                    <div className="text-2xl font-normal tracking-tight text-white">{primaryValue}</div>
                    <div className="text-sm uppercase tracking-[0.14em] text-slate-500">{valueMode === 'market_cap' ? 'MCap Axis' : 'Price Axis'}</div>
                    <div className="text-sm text-slate-400">Price <span className="ml-2 text-slate-100">${formatPrice(latest.close)}</span></div>
                    <div className="text-sm text-slate-400">MC <span className="ml-2 text-slate-100">{formatCompact(latest.marketCapUsd)}</span></div>
                    <div className="text-sm text-slate-400">Liquidity <span className="ml-2 text-slate-100">{formatCompact(latest.liquidityUsd)}</span></div>
                    <div className="text-sm text-slate-400">Supply <span className="ml-2 text-slate-100">{formatCompact(dataset.totalSupply).replace('$', '')}</span></div>
                    <div className="text-sm text-slate-400">Volume <span className="ml-2 text-slate-100">{formatCompact(latest.volumeUsd)}</span></div>
                </div>
                <div className="text-xs text-slate-500">
                    {visibleCount}/{dataset.metrics.candleCount} candles · init {renderMs === null ? '--' : `${renderMs.toFixed(1)}ms`}
                </div>
            </div>}
            {!compact && <div className="flex h-11 items-center border-b border-slate-800/90 text-sm text-slate-300">
                {timeframe && onTimeframeChange && (
                    <ChartTimeframeDropdown value={timeframe} onChange={onTimeframeChange} />
                )}
                <div className="h-6 w-px bg-slate-800" />
                <div className="px-3 text-slate-400">TradingView Lightweight</div>
                <div className="h-6 w-px bg-slate-800" />
                <div className="hidden min-w-0 flex-1 items-center gap-2 truncate px-3 md:flex">
                    <span className="truncate text-slate-300">{dataset.tokenSymbol}/SOL {feedLabel} feed</span>
                    <span className="text-slate-600">·</span>
                    <span>{timeframe ? getTimeframeLabel(timeframe) : formatInterval(dataset.intervalSeconds)}</span>
                    <span className={priceChangeClass}>
                        O {formatAxisValue(openValue, valueMode, quote)} H {formatAxisValue(highValue, valueMode, quote)} L {formatAxisValue(lowValue, valueMode, quote)} C {formatAxisValue(closeValue, valueMode, quote)} {priceChangePercent.toFixed(2)}%
                    </span>
                </div>
                <div className="ml-auto flex h-full items-center">
                    <div className="flex h-full items-center border-l border-slate-800">
                        <button
                            type="button"
                            onClick={() => setValueMode('price')}
                            className={axisModeButtonClass(valueMode === 'price')}
                            title="Show price on the Y axis"
                        >
                            Price
                        </button>
                        <button
                            type="button"
                            onClick={() => setValueMode('market_cap')}
                            className={axisModeButtonClass(valueMode === 'market_cap')}
                            title="Show market cap on the Y axis"
                        >
                            MCap
                        </button>
                    </div>
                    {hasReplayControls && (
                        <>
                            <button
                                type="button"
                                onClick={live ? onReplayPause : startReplay}
                                className={`flex h-11 items-center gap-1.5 px-3 transition-colors hover:bg-slate-900/80 ${live ? 'text-amber-300' : 'text-blue-400'}`}
                            >
                                {live ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                                {live ? 'Pause' : isReplayComplete ? 'Run Again' : 'Run Sim'}
                            </button>
                            {onReplayReset && (
                                <button
                                    type="button"
                                    onClick={onReplayReset}
                                    className="flex h-11 items-center gap-1.5 px-3 text-slate-400 transition-colors hover:bg-slate-900/80 hover:text-white"
                                >
                                    <ArrowPathIcon className="h-4 w-4" />
                                    Reset
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>}
            <div className="flex min-h-0 bg-[#0f0f12]" style={{ height }}>
                {drawTools && (
                    <aside
                        className="chart-drawbar flex shrink-0 flex-col items-center border-r border-[var(--term-border)] bg-[var(--term-bg)] py-1 text-[var(--term-muted)]"
                        aria-label="Chart drawing tools"
                        data-drawing-count={drawingIds.length}
                    >
                        {drawingTools.map(([tool, label]) => (
                            <button
                                key={tool}
                                type="button"
                                onClick={() => chooseTool(tool)}
                                className={`chart-drawtool ${drawTool === tool ? 'text-[var(--term-accent)]' : ''}`}
                                aria-label={label}
                                title={label}
                                aria-pressed={drawTool === tool}
                                data-drawing-tool={tool}
                            >
                                <DrawGlyph tool={tool} />
                            </button>
                        ))}
                        <span className="my-1 w-4 border-t border-[var(--term-border)]" />
                        <button
                            type="button"
                            onClick={undoDrawing}
                            disabled={!drawingIds.length}
                            className="chart-drawtool disabled:opacity-25"
                            aria-label="Undo drawing"
                            title="Undo drawing"
                        ><ArrowUturnLeftIcon /></button>
                        <button
                            type="button"
                            onClick={clearDrawings}
                            disabled={!drawingIds.length}
                            className="chart-drawtool disabled:opacity-25"
                            aria-label="Clear drawings"
                            title="Clear drawings"
                        ><TrashIcon /></button>
                    </aside>
                )}
                <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                    <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" title="Drag to pan · wheel or pinch to zoom · drag the price axis to scale" />
                    <div
                        ref={drawLayerRef}
                        data-chart-draw-layer
                        className={`absolute inset-0 z-[5] ${drawTool === 'cursor' && !textDraft ? 'pointer-events-none' : 'cursor-crosshair'}`}
                        onPointerDown={handleDrawDown}
                        onPointerMove={handleDrawMove}
                        onPointerUp={handleDrawUp}
                        onPointerCancel={cancelPlacement}
                    >
                        {textDraft && (
                            <input
                                autoFocus
                                value={textDraft.value}
                                onPointerDown={(event) => event.stopPropagation()}
                                onChange={(event) => setTextDraft((current) => current ? { ...current, value: event.target.value } : current)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') commitText();
                                    if (event.key === 'Escape') {
                                        cancelPlacement();
                                    }
                                }}
                                className="chart-text-input absolute z-10"
                                style={{ left: textDraft.x + 7, top: Math.max(4, textDraft.y - 15) }}
                                aria-label="Chart text"
                                placeholder="Type note…"
                            />
                        )}
                    </div>
                    <div className="absolute bottom-0 right-0 z-[7] flex h-6 items-stretch overflow-hidden border-l border-t border-[var(--term-border)] bg-[color:var(--term-bg)] text-[10px]">
                        <button
                            type="button"
                            onClick={toggleLogScale}
                            className={`border-r border-[var(--term-border)] px-2.5 transition-colors hover:bg-[var(--term-raised)] hover:text-white ${logActive ? 'bg-[var(--term-raised)] text-[var(--term-accent)]' : 'text-white/80'}`}
                            aria-pressed={logActive}
                            title="Toggle logarithmic price scale"
                        >Log</button>
                        <button
                            type="button"
                            onClick={enableAutoScale}
                            className={`px-2.5 transition-colors hover:bg-[var(--term-raised)] hover:text-white ${autoActive ? 'bg-[var(--term-raised)] text-[#5874ff]' : 'text-white/80'}`}
                            aria-pressed={autoActive}
                            title="Automatically fit the visible price range"
                        >Auto</button>
                    </div>
                </div>
            </div>
        </section>
    );
}
