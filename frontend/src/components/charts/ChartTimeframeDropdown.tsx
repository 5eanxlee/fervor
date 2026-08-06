'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import {
    CHART_TIMEFRAME_GROUPS,
    CHART_TIMEFRAME_OPTIONS,
    type ChartTimeframe,
} from '../../services/chartData';

interface ChartTimeframeDropdownProps {
    value: ChartTimeframe;
    onChange: (timeframe: ChartTimeframe) => void;
    align?: 'left' | 'right';
    disabled?: boolean;
}

export default function ChartTimeframeDropdown({
    value,
    onChange,
    align = 'left',
    disabled = false,
}: ChartTimeframeDropdownProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const selected = useMemo(
        () => CHART_TIMEFRAME_OPTIONS.find(option => option.id === value) ?? CHART_TIMEFRAME_OPTIONS[0],
        [value]
    );

    useEffect(() => {
        if (!isOpen) return;

        const closeOnOutsideClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('mousedown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [isOpen]);

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                disabled={disabled}
                onClick={() => {
                    if (!disabled) {
                        setIsOpen(current => !current);
                    }
                }}
                className="flex h-11 items-center gap-1.5 px-3 text-sm text-slate-200 transition-colors hover:bg-slate-900/70 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
                <span className="tabular-nums">{selected.label}</span>
                <ChevronDownIcon className={`h-3.5 w-3.5 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div
                    role="menu"
                    className={`absolute top-full z-50 mt-px w-56 border border-slate-700 bg-[#1b202c] py-2 shadow-2xl ${align === 'right' ? 'right-0' : 'left-0'}`}
                >
                    {CHART_TIMEFRAME_GROUPS.map(group => {
                        const options = CHART_TIMEFRAME_OPTIONS.filter(option => option.group === group);

                        return (
                            <div key={group} className="border-b border-slate-700/70 py-1 last:border-b-0">
                                <div className="flex items-center justify-between px-3 py-1.5 text-[11px] font-normal uppercase tracking-[0.18em] text-slate-500">
                                    <span>{group}</span>
                                    <ChevronDownIcon className="h-3 w-3" />
                                </div>
                                {options.map(option => {
                                    const isSelected = option.id === value;

                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={isSelected}
                                            onClick={() => {
                                                onChange(option.id);
                                                setIsOpen(false);
                                            }}
                                            className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${isSelected
                                                ? 'bg-blue-600 text-white'
                                                : 'text-slate-300 hover:bg-slate-700/70 hover:text-white'
                                                }`}
                                        >
                                            <span>{option.menuLabel}</span>
                                            {isSelected && <CheckIcon className="h-4 w-4" />}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
