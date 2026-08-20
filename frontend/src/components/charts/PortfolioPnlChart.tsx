'use client';

import { useEffect, useRef } from 'react';
import {
    AreaSeries,
    ColorType,
    CrosshairMode,
    LineStyle,
    createChart,
    type IChartApi,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';

interface PortfolioPnlChartProps {
    values: number[];
}

function rgba(color: string, alpha: number) {
    const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
    if (!hex) return color;
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export default function PortfolioPnlChart({ values }: PortfolioPnlChartProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const styles = getComputedStyle(container);
        const fontFamily =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--font-geist')
                .trim() || 'Geist';
        const chart = createChart(container, {
            autoSize: true,
            layout: {
                background: { type: ColorType.Solid, color: styles.getPropertyValue('--term-bg').trim() || '#0f0f12' },
                textColor: styles.getPropertyValue('--term-muted').trim() || '#90909a',
                fontFamily: `${fontFamily}, system-ui, sans-serif`,
                attributionLogo: false,
            },
            rightPriceScale: {
                visible: false,
                scaleMargins: { top: 0.12, bottom: 0.08 },
            },
            timeScale: {
                visible: false,
                borderVisible: false,
                fixLeftEdge: true,
                fixRightEdge: true,
                lockVisibleTimeRangeOnResize: true,
            },
            grid: {
                vertLines: { visible: false },
                horzLines: {
                    color: rgba(styles.getPropertyValue('--term-border').trim() || '#252528', 0.55),
                    style: LineStyle.Solid,
                },
            },
            crosshair: {
                mode: CrosshairMode.Magnet,
                vertLine: { color: 'rgba(161, 161, 170, 0.3)', style: LineStyle.Dashed, labelVisible: false },
                horzLine: { color: 'rgba(161, 161, 170, 0.3)', style: LineStyle.Dashed, labelVisible: false },
            },
            handleScroll: false,
            handleScale: false,
        });
        const series = chart.addSeries(AreaSeries, {
            lastValueVisible: false,
            priceLineVisible: false,
            relativeGradient: true,
            lineWidth: 3,
            crosshairMarkerRadius: 3,
            priceFormat: {
                type: 'custom',
                minMove: 0.01,
                formatter: (value: number) => new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 2,
                }).format(value),
            },
        });

        chartRef.current = chart;
        seriesRef.current = series;
        return () => {
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
        };
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        const chart = chartRef.current;
        const series = seriesRef.current;
        if (!container || !chart || !series) return;

        const styles = getComputedStyle(container);
        const positive = (values.at(-1) ?? 0) >= (values[0] ?? 0);
        const color = styles.getPropertyValue(positive ? '--term-buy' : '--term-sell').trim()
            || (positive ? '#2eddb2' : '#f83279');
        series.applyOptions({
            lineColor: color,
            topColor: rgba(color, 0.34),
            bottomColor: rgba(color, 0.03),
            crosshairMarkerBackgroundColor: color,
            crosshairMarkerBorderColor: color,
        });
        series.setData(values.map((value, index) => ({
            time: (index + 1) as UTCTimestamp,
            value,
        })));
        chart.timeScale().fitContent();
    }, [values]);

    return (
        <div
            ref={containerRef}
            className="absolute inset-x-3 bottom-8 top-12"
            role="img"
            aria-label="Realized PNL chart"
        />
    );
}
