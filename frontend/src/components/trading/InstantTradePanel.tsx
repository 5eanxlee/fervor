'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
    ArrowsRightLeftIcon,
    CalculatorIcon,
    ClockIcon,
    Cog6ToothIcon,
    PencilSquareIcon,
    ShieldCheckIcon,
    WalletIcon,
    XMarkIcon,
} from '@heroicons/react/24/outline';
import { SolanaMark } from './BrandMarks';

const BUY_COLOR = 'var(--term-buy, #32dfb4)';
const SELL_COLOR = 'var(--term-sell, #ff2e78)';
const EDGE = 12;

export type InstantTradeCurrency = 'SOL' | 'USDC' | 'uSOL';

export interface InstantTradePanelProps {
    open: boolean;
    onClose: () => void;
    tokenSymbol: string;
    solBalance?: string | number;
    tokenBalance?: string | number;
    walletCount?: number;
    onBuy?: (amount: number, currency: InstantTradeCurrency) => void;
    onSell?: (percentage: number) => void;
}

type Point = { x: number; y: number };
type Drag = { pointerId: number; offsetX: number; offsetY: number };
type PanelSize = { width: number; height: number };
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
type ResizeDrag = {
    pointerId: number;
    corner: ResizeCorner;
    startX: number;
    startY: number;
    position: Point;
    size: PanelSize;
};

const MIN_WIDTH = 460;
const MIN_HEIGHT = 400;
const START_SIZE: PanelSize = { width: 540, height: 490 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function UsdcMark({ className = '' }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
            <circle cx="12" cy="12" r="11" fill="#2775ca" />
            <path d="M12 5.3v13.4M15.1 8.3c-.7-.6-1.7-1-3-1-1.8 0-3 .9-3 2.2 0 3.4 6.1 1.7 6.1 5 0 1.4-1.3 2.3-3.3 2.3-1.3 0-2.6-.5-3.4-1.2M6.5 6.7a7.1 7.1 0 0 0 0 10.6M17.5 6.7a7.1 7.1 0 0 1 0 10.6" fill="none" stroke="white" strokeWidth="1.45" strokeLinecap="round" />
        </svg>
    );
}

function DragHandle({
    onPointerDown,
    onPointerMove,
    onPointerUp,
}: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
    return (
        <button
            type="button"
            aria-label="Drag instant trade panel"
            title="Drag panel"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="absolute left-1/2 top-1 z-10 grid -translate-x-1/2 touch-none grid-cols-3 gap-[3px] rounded-md px-3 py-1.5 text-[var(--term-muted)] transition hover:bg-[var(--term-control)] cursor-grab active:cursor-grabbing"
        >
            {Array.from({ length: 6 }, (_, index) => <span key={index} className="h-[3px] w-[3px] rounded-full bg-current opacity-45" />)}
        </button>
    );
}

function ResizeHandle({
    corner,
    onPointerDown,
    onPointerMove,
    onPointerUp,
}: {
    corner: ResizeCorner;
    onPointerDown: (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
    const placement = {
        nw: '-left-1 -top-1 cursor-nwse-resize',
        ne: '-right-1 -top-1 cursor-nesw-resize',
        sw: '-bottom-1 -left-1 cursor-nesw-resize',
        se: '-bottom-1 -right-1 cursor-nwse-resize',
    }[corner];
    const edge = {
        nw: 'left-1 top-1 border-l-2 border-t-2',
        ne: 'right-1 top-1 border-r-2 border-t-2',
        sw: 'bottom-1 left-1 border-b-2 border-l-2',
        se: 'bottom-1 right-1 border-b-2 border-r-2',
    }[corner];

    return (
        <button
            type="button"
            aria-label={`Resize instant trade panel from ${corner.toUpperCase()} corner`}
            title="Drag to resize"
            onPointerDown={(event) => onPointerDown(corner, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`absolute z-30 h-6 w-6 touch-none ${placement}`}
        >
            <span className={`absolute h-3 w-3 border-[var(--term-muted)] opacity-45 transition-opacity hover:opacity-90 ${edge}`} />
        </button>
    );
}

export default function InstantTradePanel({
    open,
    onClose,
    tokenSymbol,
    solBalance = '1.655',
    tokenBalance = '0',
    walletCount = 1,
    onBuy,
    onSell,
}: InstantTradePanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<Drag | null>(null);
    const resizeRef = useRef<ResizeDrag | null>(null);
    const positionedRef = useRef(false);
    const [position, setPosition] = useState<Point>({ x: EDGE, y: 72 });
    const [size, setSize] = useState<PanelSize>(START_SIZE);
    const [preset, setPreset] = useState<'P1' | 'P2' | 'P3'>('P1');
    const [currency, setCurrency] = useState<InstantTradeCurrency>('SOL');
    const [buyPreset, setBuyPreset] = useState(0.1);
    const [sellPreset, setSellPreset] = useState(0);
    const [advanced, setAdvanced] = useState(false);

    useEffect(() => {
        if (!open) return;

        const place = () => {
            const panel = panelRef.current;
            if (!panel) return;
            const nextSize = {
                width: Math.min(Math.max(MIN_WIDTH, window.innerWidth * .38), 700, window.innerWidth - EDGE * 2),
                height: Math.min(Math.max(MIN_HEIGHT, window.innerHeight * .68), 620, window.innerHeight - EDGE * 2),
            };
            setSize(nextSize);
            setPosition({
                x: Math.max(EDGE, (window.innerWidth - nextSize.width) / 2),
                y: Math.max(EDGE, (window.innerHeight - nextSize.height) / 2),
            });
            positionedRef.current = true;
        };

        if (!positionedRef.current) {
            const frame = requestAnimationFrame(place);
            return () => cancelAnimationFrame(frame);
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;

        const onResize = () => {
            const panel = panelRef.current;
            if (!panel) return;
            const nextSize = {
                width: Math.min(size.width, window.innerWidth - EDGE * 2),
                height: Math.min(size.height, window.innerHeight - EDGE * 2),
            };
            setSize(nextSize);
            setPosition((current) => ({
                x: clamp(current.x, EDGE, Math.max(EDGE, window.innerWidth - nextSize.width - EDGE)),
                y: clamp(current.y, EDGE, Math.max(EDGE, window.innerHeight - nextSize.height - EDGE)),
            }));
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        window.addEventListener('resize', onResize);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose, open, size.height, size.width]);

    const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - position.x,
            offsetY: event.clientY - position.y,
        };
    };

    const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        const panel = panelRef.current;
        if (!drag || !panel || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const rect = panel.getBoundingClientRect();
        setPosition({
            x: Math.min(Math.max(EDGE, event.clientX - drag.offsetX), Math.max(EDGE, window.innerWidth - rect.width - EDGE)),
            y: Math.min(Math.max(EDGE, event.clientY - drag.offsetY), Math.max(EDGE, window.innerHeight - rect.height - EDGE)),
        });
    };

    const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        dragRef.current = null;
    };

    const startResize = (corner: ResizeCorner, event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
            pointerId: event.pointerId,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            position,
            size,
        };
    };

    const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        event.preventDefault();

        const dx = event.clientX - resize.startX;
        const dy = event.clientY - resize.startY;
        const fromLeft = resize.corner.includes('w');
        const fromTop = resize.corner.includes('n');
        const minWidth = Math.min(MIN_WIDTH, window.innerWidth - EDGE * 2);
        const minHeight = Math.min(MIN_HEIGHT, window.innerHeight - EDGE * 2);
        const maxWidth = fromLeft
            ? resize.position.x + resize.size.width - EDGE
            : window.innerWidth - resize.position.x - EDGE;
        const maxHeight = fromTop
            ? resize.position.y + resize.size.height - EDGE
            : window.innerHeight - resize.position.y - EDGE;
        const width = clamp(resize.size.width + (fromLeft ? -dx : dx), minWidth, maxWidth);
        const height = clamp(resize.size.height + (fromTop ? -dy : dy), minHeight, maxHeight);

        setSize({ width, height });
        setPosition({
            x: fromLeft ? resize.position.x + resize.size.width - width : resize.position.x,
            y: fromTop ? resize.position.y + resize.size.height - height : resize.position.y,
        });
    };

    const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (resizeRef.current?.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        resizeRef.current = null;
    };

    if (!open) return null;

    const buyValues = [0.1, 0.2, 0.3, 1];
    const sellValues = [10, 25, 50, 100];

    return (
        <div
            ref={panelRef}
            role="dialog"
            aria-label={`Instant trade ${tokenSymbol}`}
            className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-[var(--term-border-strong)] bg-[var(--term-bg)] text-[var(--term-text)] shadow-[0_24px_72px_rgba(0,0,0,.58)]"
            style={{
                left: position.x,
                top: position.y,
                width: size.width,
                height: size.height,
                maxWidth: 'calc(100vw - 24px)',
                maxHeight: 'calc(100vh - 24px)',
            }}
        >
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <ResizeHandle key={corner} corner={corner} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} />
            ))}
            <header className="relative flex h-[3.75rem] shrink-0 items-center border-b border-[var(--term-border)] px-4 pt-1">
                <DragHandle onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} />
                <button aria-label="Trade keypad" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--term-text)] transition hover:bg-[var(--term-control)]"><CalculatorIcon className="h-5 w-5" /></button>
                <div className="ml-1 flex items-center gap-0.5 sm:ml-2 sm:gap-1">
                    {(['P1', 'P2', 'P3'] as const).map((value) => (
                        <button
                            key={value}
                            onClick={() => setPreset(value)}
                            className="h-9 min-w-8 rounded-lg px-1 text-[clamp(.82rem,2vw,1.08rem)] font-medium transition hover:bg-[var(--term-control)] sm:min-w-11 sm:px-2"
                            style={{ color: preset === value ? 'var(--term-accent)' : 'var(--term-text)' }}
                        >
                            {value}
                        </button>
                    ))}
                    <button aria-label="Edit instant presets" className="grid h-9 w-8 place-items-center rounded-lg text-[var(--term-text)] transition hover:bg-[var(--term-control)] sm:w-9"><PencilSquareIcon className="h-5 w-5" /></button>
                </div>
                <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
                    <button aria-label="Instant trade settings" className="hidden h-9 w-9 place-items-center rounded-lg text-[var(--term-text)] transition hover:bg-[var(--term-control)] sm:grid"><Cog6ToothIcon className="h-5 w-5" /></button>
                    <button aria-label="Trade timer" className="hidden h-9 w-9 place-items-center rounded-lg bg-[var(--term-raised)] text-[var(--term-muted)] transition hover:text-[var(--term-text)] sm:grid"><ClockIcon className="h-5 w-5" /></button>
                    <button className="flex h-9 items-center gap-1.5 rounded-full border border-[var(--term-border-strong)] px-2 text-[var(--term-text)] sm:gap-2 sm:px-3">
                        <WalletIcon className="h-[1.125rem] w-[1.125rem] text-[var(--term-muted)]" />{walletCount}
                    </button>
                    <button onClick={onClose} aria-label="Close instant trade" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--term-text)] transition hover:bg-[var(--term-control)]"><XMarkIcon className="h-5 w-5" /></button>
                </div>
            </header>

            <section className="min-h-0 flex-1 overflow-y-auto px-3 pb-0 pt-3 sm:px-4">
                <div className="flex min-w-0 items-center gap-2 text-[clamp(.82rem,2vw,1rem)]">
                    <span className="shrink-0">Buy</span>
                    <div className="flex min-w-0 items-center rounded-full border border-[var(--term-border-strong)] bg-[var(--term-raised)] p-[2px]">
                        {(['SOL', 'USDC', 'uSOL'] as const).map((value) => (
                            <button
                                key={value}
                                onClick={() => setCurrency(value)}
                                className={`flex h-7 items-center gap-1 rounded-full px-2 text-[clamp(.69rem,1.6vw,.82rem)] transition ${currency === value ? 'bg-[var(--term-control)] text-white' : 'text-[var(--term-muted)] hover:text-white'}`}
                            >
                                {value === 'SOL' ? <SolanaMark className="h-4 w-4" /> : value === 'USDC' ? <UsdcMark className="h-4 w-4" /> : <span className="grid h-4 w-4 place-items-center rounded-full bg-[#2c8aff]"><SolanaMark className="h-2.5 w-2.5" /></span>}
                                {value}
                            </button>
                        ))}
                    </div>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-[var(--term-muted)]"><SolanaMark className="h-5 w-5" />{solBalance}</span>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-[clamp(.45rem,2vw,1rem)]">
                    {buyValues.map((value) => (
                        <button
                            key={value}
                            onClick={() => {
                                setBuyPreset(value);
                                onBuy?.(value, currency);
                            }}
                            className="h-[clamp(3.25rem,8vh,4.65rem)] rounded-full border text-[clamp(.9rem,2.4vw,1.2rem)] font-medium transition hover:brightness-125"
                            style={{
                                borderColor: BUY_COLOR,
                                color: BUY_COLOR,
                                background: buyPreset === value ? 'color-mix(in srgb, var(--term-buy, #32dfb4) 9%, transparent)' : 'transparent',
                            }}
                        >
                            {value}
                        </button>
                    ))}
                </div>

                <div className="mt-4 flex min-w-0 items-center gap-2 whitespace-nowrap text-[clamp(.67rem,1.8vw,.82rem)] text-[var(--term-muted)]">
                    <span>♨ 99%</span><span className="h-4 w-px bg-[var(--term-border)]" /><span>⛽ 0.005</span><span className="h-4 w-px bg-[var(--term-border)]" /><span>◉ 0.005</span><span className="h-4 w-px bg-[var(--term-border)]" /><span className="flex items-center gap-1"><ShieldCheckIcon className="h-4 w-4" />On</span>
                    <button onClick={() => setAdvanced((value) => !value)} className="ml-auto flex items-center gap-2">
                        <span className="grid h-5 w-5 place-items-center rounded-md border border-[var(--term-border-strong)] text-[10px]" style={advanced ? { background: 'var(--term-accent)', color: '#0e0f12' } : undefined}>{advanced ? '✓' : ''}</span>
                        Adv.
                    </button>
                </div>

                <div className="mt-5 flex min-w-0 items-center gap-3 text-[clamp(.82rem,2vw,1rem)]">
                    <span>Sell</span>
                    <span className="text-[var(--term-muted)]">%</span>
                    <ArrowsRightLeftIcon className="h-4 w-4 text-[var(--term-muted)]" />
                    <span className="ml-auto truncate text-[var(--term-muted)]">{tokenBalance} {tokenSymbol} · $0 · <SolanaMark className="inline h-4 w-4" /> 0</span>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-[clamp(.45rem,2vw,1rem)]">
                    {sellValues.map((value) => (
                        <button
                            key={value}
                            onClick={() => {
                                setSellPreset(value);
                                onSell?.(value);
                            }}
                            className="h-[clamp(3.25rem,8vh,4.65rem)] rounded-full border text-[clamp(.9rem,2.4vw,1.2rem)] font-medium transition hover:brightness-125"
                            style={{
                                borderColor: SELL_COLOR,
                                color: SELL_COLOR,
                                background: sellPreset === value ? 'color-mix(in srgb, var(--term-sell, #ff2e78) 9%, transparent)' : 'transparent',
                            }}
                        >
                            {value}%
                        </button>
                    ))}
                </div>

                <div className="mt-4 flex min-w-0 items-center gap-2 whitespace-nowrap pb-4 text-[clamp(.67rem,1.8vw,.82rem)] text-[var(--term-muted)]">
                    <span>♨ 99%</span><span className="h-4 w-px bg-[var(--term-border)]" /><span>⛽ 0.003</span><span className="h-4 w-px bg-[var(--term-border)]" /><span className="text-[#e2c522]">◉ 0.003 ⚠</span><span className="h-4 w-px bg-[var(--term-border)]" /><span>◇ Off</span>
                    <button className="ml-auto font-medium" style={{ color: SELL_COLOR }}>Sell Init.</button>
                </div>
            </section>

            <footer className="grid shrink-0 grid-cols-4 border-t border-[var(--term-border)] px-3 py-2.5">
                {[
                    ['0', 'buy'],
                    ['0', 'sell'],
                    ['0', 'neutral'],
                    ['+0(+0%)', 'buy'],
                ].map(([value, tone], index) => (
                    <div key={`${tone}-${index}`} className={`flex min-w-0 items-center justify-center gap-1.5 px-2 text-[clamp(.72rem,1.7vw,.86rem)] ${index > 0 ? 'border-l border-[var(--term-border)]' : ''}`} style={{ color: tone === 'buy' ? BUY_COLOR : tone === 'sell' ? SELL_COLOR : 'var(--term-text)' }}>
                        <SolanaMark className="h-[1.125rem] w-[1.125rem] shrink-0" /><span className="truncate">{value}</span>
                    </div>
                ))}
            </footer>
        </div>
    );
}
