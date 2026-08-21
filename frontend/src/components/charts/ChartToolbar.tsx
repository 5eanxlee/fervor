'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
    ArrowPathIcon,
    ArrowsPointingInIcon,
    ArrowsPointingOutIcon,
    ChevronDownIcon,
    StarIcon,
} from '@heroicons/react/24/outline';
import {
    CHART_TIMEFRAME_GROUPS,
    CHART_TIMEFRAME_OPTIONS,
    CHART_STYLE_OPTIONS,
    type ChartQuote,
    type ChartStyle,
    type ChartTimeframe,
    type ChartValueMode,
} from '../../services/chartData';

interface ChartToolbarProps {
    timeframe: ChartTimeframe;
    pins: ChartTimeframe[];
    style: ChartStyle;
    quote: ChartQuote;
    axis: ChartValueMode;
    volume: boolean;
    solUsd?: number;
    full: boolean;
    onTimeframe: (value: ChartTimeframe) => void;
    onPins: (value: ChartTimeframe[]) => void;
    onStyle: (value: ChartStyle) => void;
    onQuote: (value: ChartQuote) => void;
    onAxis: (value: ChartValueMode) => void;
    onVolume: () => void;
    onRefresh: () => void;
    onFull: () => void;
}

function StyleIcon({ style, className = 'h-6 w-6' }: { style: ChartStyle; className?: string }) {
    const common = {
        className,
        viewBox: '0 0 28 28',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };

    if (style === 'bars') return <svg {...common}><path d="M7 4v20M4 9h3M7 18h4M19 3v22M16 8h3M19 20h5" /></svg>;
    if (style === 'candles') return <svg {...common}><path d="M8 3v22M5 8h6v11H5zM20 2v24M17 6h6v8h-6z" /></svg>;
    if (style === 'hollow') return <svg {...common}><path d="M8 3v22M5 8h6v11H5zM20 2v24M17 6h6v8h-6z" strokeDasharray="2 1" /></svg>;
    if (style === 'markers') return <svg {...common}><path d="M3 21l7-8 6 4 9-11" /><circle cx="10" cy="13" r="2" fill="currentColor" /><circle cx="16" cy="17" r="2" fill="currentColor" /></svg>;
    if (style === 'step') return <svg {...common}><path d="M3 21h7V9h8V4h7" /></svg>;
    if (style === 'area') return <svg {...common}><path d="M3 20l7-8 5 4 10-11v18H3z" fill="currentColor" fillOpacity=".18" /><path d="M3 20l7-8 5 4 10-11" /></svg>;
    if (style === 'hlc-area') return <svg {...common}><path d="M3 18l7-7 5 4 10-10M3 22l7-6 5 3 10-8" /><path d="M3 18l7-7 5 4 10-10v6l-10 8-5-3-7 6z" fill="currentColor" fillOpacity=".18" /></svg>;
    if (style === 'baseline') return <svg {...common}><path d="M3 14h22" strokeDasharray="2 2" /><path d="M3 20l7-8 5 4 10-11" /><path d="M3 20l7-8 5 4 10-11v9l-10 5-5-2-7 5z" fill="currentColor" fillOpacity=".16" /></svg>;
    if (style === 'columns') return <svg {...common}><path d="M4 24V13h5v11M12 24V6h5v18M20 24V10h5v14" fill="currentColor" fillOpacity=".6" /></svg>;
    return <svg {...common}><path d="M3 21l7-8 6 4 9-11" /></svg>;
}

function Choice({ active, children, onClick, disabled = false, label }: {
    active: boolean;
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
            className={`h-full px-1 text-[clamp(.78rem,.95vw,.94rem)] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active ? 'text-[#5874ff]' : 'text-[var(--term-text)] hover:text-white'}`}
        >{children}</button>
    );
}

export default function ChartToolbar({
    timeframe,
    pins,
    style,
    quote,
    axis,
    volume,
    solUsd,
    full,
    onTimeframe,
    onPins,
    onStyle,
    onQuote,
    onAxis,
    onVolume,
    onRefresh,
    onFull,
}: ChartToolbarProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [timeOpen, setTimeOpen] = useState(false);
    const [styleOpen, setStyleOpen] = useState(false);
    const [groups, setGroups] = useState<Record<string, boolean>>({ Seconds: false, Minutes: true, Hours: true });

    useEffect(() => {
        if (!timeOpen && !styleOpen) return;
        const close = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setTimeOpen(false);
                setStyleOpen(false);
            }
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setTimeOpen(false);
                setStyleOpen(false);
            }
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', escape);
        };
    }, [styleOpen, timeOpen]);

    const togglePin = (value: ChartTimeframe) => {
        if (pins.includes(value)) {
            if (pins.length > 1) onPins(pins.filter(item => item !== value));
            return;
        }
        onPins([...pins, value].slice(-7));
    };

    return (
        <div ref={rootRef} className="chart-tools relative z-30 flex shrink-0 items-center border-b border-[var(--term-border)] bg-[var(--term-bg)] text-[var(--term-muted)]">
            <div className="flex h-full shrink-0 items-center pl-1">
                {pins.map(value => (
                    <button
                        type="button"
                        key={value}
                        data-active={timeframe === value}
                        onClick={() => onTimeframe(value)}
                        className="chart-tool timeframe-tool"
                    >{value}</button>
                ))}
                <div className="relative h-full">
                    <button
                        type="button"
                        aria-label="Choose chart timeframe"
                        aria-haspopup="menu"
                        aria-expanded={timeOpen}
                        onClick={() => {
                            setTimeOpen(value => !value);
                            setStyleOpen(false);
                        }}
                        className={`chart-tool !min-w-8 !px-1 ${timeOpen ? 'text-white' : ''}`}
                    ><ChevronDownIcon className={`h-4 w-4 transition-transform ${timeOpen ? 'rotate-180' : ''}`} /></button>
                    {timeOpen && (
                        <div role="menu" className="chart-menu absolute left-0 top-full z-50 w-[17.5rem] overflow-hidden border border-[#313642] bg-[#20242e] text-[#d4d6dd] shadow-2xl">
                            {CHART_TIMEFRAME_GROUPS.map(group => (
                                <section key={group} className="border-b border-[#3a3f4a] last:border-0">
                                    <button
                                        type="button"
                                        onClick={() => setGroups(value => ({ ...value, [group]: !value[group] }))}
                                        className="flex h-9 w-full items-center justify-between bg-[#292e38] px-4 text-[.72rem] uppercase tracking-[.13em] text-[#9297a3]"
                                    >
                                        <span>{group}</span>
                                        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${groups[group] ? 'rotate-180' : ''}`} />
                                    </button>
                                    {groups[group] && CHART_TIMEFRAME_OPTIONS.filter(option => option.group === group).map(option => (
                                        <div key={option.id} className={`flex h-10 items-center transition-colors hover:bg-[#2b303b] ${timeframe === option.id ? 'text-white' : ''}`}>
                                            <button
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={timeframe === option.id}
                                                onClick={() => {
                                                    onTimeframe(option.id);
                                                    setTimeOpen(false);
                                                }}
                                                className="h-full flex-1 px-4 text-left text-[.91rem]"
                                            >{option.menuLabel}</button>
                                            <button
                                                type="button"
                                                onClick={() => togglePin(option.id)}
                                                className={`grid h-full w-12 place-items-center ${pins.includes(option.id) ? 'text-[#ffad24]' : 'text-[#777d89] hover:text-[#ffad24]'}`}
                                                aria-label={`${pins.includes(option.id) ? 'Unpin' : 'Pin'} ${option.menuLabel}`}
                                                aria-pressed={pins.includes(option.id)}
                                            ><StarIcon className={`h-5 w-5 ${pins.includes(option.id) ? 'fill-current' : ''}`} /></button>
                                        </div>
                                    ))}
                                </section>
                            ))}
                        </div>
                    )}
                </div>
                <span className="mx-1 h-5 border-l border-[var(--term-border-strong)]" />
                <div className="relative h-full">
                    <button
                        type="button"
                        aria-label="Choose chart style"
                        aria-haspopup="menu"
                        aria-expanded={styleOpen}
                        onClick={() => {
                            setStyleOpen(value => !value);
                            setTimeOpen(false);
                        }}
                        className={`chart-tool !min-w-10 !px-2 ${styleOpen ? 'text-white' : ''}`}
                    ><StyleIcon style={style} className="h-5 w-5" /></button>
                    {styleOpen && (
                        <div role="menu" className="chart-menu absolute left-0 top-full z-50 w-[18rem] overflow-hidden border border-[#313642] bg-[#20242e] py-1 text-[#d4d6dd] shadow-2xl">
                            {CHART_STYLE_OPTIONS.map((option, index) => (
                                <button
                                    key={option.id}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={style === option.id}
                                    onClick={() => {
                                        onStyle(option.id);
                                        setStyleOpen(false);
                                    }}
                                    className={`flex h-10 w-full items-center gap-4 px-4 text-left text-[.91rem] transition-colors ${style === option.id ? 'bg-[#2f63f5] text-white' : 'hover:bg-[#2b303b]'} ${index === 3 || index === 6 || index === 9 ? 'border-t border-[#3a3f4a]' : ''}`}
                                >
                                    <StyleIcon style={option.id} className="h-6 w-6 shrink-0" />
                                    <span>{option.label}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <span className="ml-1 h-5 border-l border-[var(--term-border-strong)]" />
            <div className="flex h-full items-center gap-0.5 px-3">
                <Choice active={quote === 'usd'} onClick={() => onQuote('usd')} label="Display values in USD">USD</Choice>
                <span className="text-[var(--term-text)]">/</span>
                <Choice active={quote === 'sol'} onClick={() => onQuote('sol')} disabled={!solUsd} label={solUsd ? `Display values in SOL at $${solUsd.toFixed(2)} per SOL` : 'Loading SOL price'}>SOL</Choice>
            </div>
            <span className="h-5 border-l border-[var(--term-border-strong)]" />
            <div className="flex h-full items-center gap-0.5 px-3">
                <Choice active={axis === 'market_cap'} onClick={() => onAxis('market_cap')} label="Show market cap">MarketCap</Choice>
                <span className="text-[var(--term-text)]">/</span>
                <Choice active={axis === 'price'} onClick={() => onAxis('price')} label="Show token price">Price</Choice>
            </div>
            <span className="h-5 border-l border-[var(--term-border-strong)]" />
            <button type="button" onClick={onVolume} className={`chart-tool !min-w-11 ${volume ? 'text-[#5874ff]' : ''}`} aria-pressed={volume}>Vol</button>
            <button type="button" onClick={onRefresh} className="chart-tool !min-w-10" aria-label="Refresh chart"><ArrowPathIcon className="h-4 w-4" /></button>
            <button type="button" onClick={onFull} className="chart-tool !min-w-10" aria-label={full ? 'Exit full chart' : 'Expand chart'}>{full ? <ArrowsPointingInIcon className="h-4 w-4" /> : <ArrowsPointingOutIcon className="h-4 w-4" />}</button>
        </div>
    );
}
