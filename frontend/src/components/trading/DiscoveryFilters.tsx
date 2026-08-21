'use client';

import { useEffect, useState } from 'react';
import {
    ArrowPathIcon,
    CheckIcon,
    MagnifyingGlassIcon,
    XMarkIcon,
} from '@heroicons/react/24/outline';
import type { DiscoveryCategory, DiscoveryToken } from '../../services/api';

export const discoveryCols: Array<{ key: DiscoveryCategory; label: string }> = [
    { key: 'new', label: 'New' },
    { key: 'final', label: 'Homestretch' },
    { key: 'migrated', label: 'Migrated' },
];

const auditFields = [
    ['visitors', 'Recent Visitors'],
    ['age', 'Age'],
    ['top10', 'Top 10 Holders %'],
    ['devHold', 'Dev Holding %'],
    ['snipers', 'Snipers %'],
    ['insiders', 'Insiders %'],
    ['bundle', 'Bundle %'],
    ['holders', 'Holders'],
    ['proTraders', 'Pro Traders'],
    ['devMigrations', 'Dev Migrations'],
    ['devPairs', 'Dev Pairs Created'],
] as const;

const metricFields = [
    ['liquidity', 'Liquidity ($)'],
    ['volume', 'Volume ($)'],
    ['marketCap', 'Market Cap ($)'],
    ['curve', 'B. curve %'],
    ['fees', 'Global Fees Paid (SOL)'],
    ['txns', 'Txns'],
    ['buys', 'Num Buys'],
    ['sells', 'Num Sells'],
] as const;

const protocolOptions = [
    { id: 'pump', label: 'Pump' },
    { id: 'pumpswap', label: 'PumpSwap' },
    { id: 'raydium', label: 'Raydium' },
    { id: 'meteora', label: 'Meteora' },
    { id: 'moonshot', label: 'Moonshot' },
    { id: 'bonk', label: 'Bonk' },
    { id: 'jupiter', label: 'Jupiter' },
] as const;

type AuditKey = typeof auditFields[number][0];
type MetricKey = typeof metricFields[number][0];
type FilterTab = 'protocols' | 'audit' | 'metrics';
type Range = { min: string; max: string };

export type ColumnFilter = {
    keywords: string;
    exclude: string;
    protocols: string[];
    audit: Record<AuditKey, Range>;
    metrics: Record<MetricKey, Range>;
};

export type FilterMap = Record<DiscoveryCategory, ColumnFilter>;

type FilterToken = DiscoveryToken & Partial<{
    recentVisitors: number;
    top10Pct: number;
    devHoldPct: number;
    sniperPct: number;
    insiderPct: number;
    bundlePct: number;
    holderCount: number;
    proTraderCount: number;
    devMigrationCount: number;
    devPairCount: number;
    curvePct: number;
    globalFeesSol: number;
}>;

const storeKey = 'fervor_discovery_filters_v1';

function emptyRanges<T extends readonly (readonly [string, string])[]>(fields: T): Record<T[number][0], Range> {
    return Object.fromEntries(fields.map(([key]) => [key, { min: '', max: '' }])) as Record<T[number][0], Range>;
}

function emptyColumn(): ColumnFilter {
    return {
        keywords: '',
        exclude: '',
        protocols: [],
        audit: emptyRanges(auditFields),
        metrics: emptyRanges(metricFields),
    };
}

export function emptyFilters(): FilterMap {
    return { new: emptyColumn(), final: emptyColumn(), migrated: emptyColumn() };
}

function cleanRange(value: unknown): Range {
    if (!value || typeof value !== 'object') return { min: '', max: '' };
    const range = value as Partial<Range>;
    return {
        min: typeof range.min === 'string' ? range.min : '',
        max: typeof range.max === 'string' ? range.max : '',
    };
}

function cleanColumn(value: unknown): ColumnFilter {
    const input = value && typeof value === 'object' ? value as Partial<ColumnFilter> : {};
    return {
        keywords: typeof input.keywords === 'string' ? input.keywords : '',
        exclude: typeof input.exclude === 'string' ? input.exclude : '',
        protocols: Array.isArray(input.protocols) ? input.protocols.filter((item): item is string => typeof item === 'string') : [],
        audit: Object.fromEntries(auditFields.map(([key]) => [key, cleanRange(input.audit?.[key])])) as ColumnFilter['audit'],
        metrics: Object.fromEntries(metricFields.map(([key]) => [key, cleanRange(input.metrics?.[key])])) as ColumnFilter['metrics'],
    };
}

export function loadFilters(): FilterMap {
    if (typeof window === 'undefined') return emptyFilters();
    try {
        const input = JSON.parse(localStorage.getItem(storeKey) || '{}') as Partial<FilterMap>;
        return {
            new: cleanColumn(input.new),
            final: cleanColumn(input.final),
            migrated: cleanColumn(input.migrated),
        };
    } catch {
        return emptyFilters();
    }
}

export function saveFilters(filters: FilterMap): void {
    if (typeof window !== 'undefined') localStorage.setItem(storeKey, JSON.stringify(filters));
}

function terms(value: string): string[] {
    return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function protocolOf(token: DiscoveryToken): string {
    const value = `${token.protocol || ''} ${token.launchpad || ''}`.toLowerCase();
    if (value.includes('pump') && value.includes('swap')) return 'pumpswap';
    if (value.includes('pump')) return 'pump';
    if (value.includes('raydium')) return 'raydium';
    if (value.includes('meteora')) return 'meteora';
    if (value.includes('moonshot')) return 'moonshot';
    if (value.includes('bonk')) return 'bonk';
    if (value.includes('jupiter')) return 'jupiter';
    return value.trim();
}

function rangePass(value: number | undefined, range: Range): boolean {
    const min = range.min === '' ? undefined : Number(range.min);
    const max = range.max === '' ? undefined : Number(range.max);
    if (min === undefined && max === undefined) return true;
    if (value === undefined || !Number.isFinite(value)) return false;
    if (min !== undefined && Number.isFinite(min) && value < min) return false;
    if (max !== undefined && Number.isFinite(max) && value > max) return false;
    return true;
}

function ageMinutes(value: string): number | undefined {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 60_000) : undefined;
}

export function matchesFilters(token: DiscoveryToken, filters: ColumnFilter): boolean {
    const text = `${token.name} ${token.symbol} ${token.address} ${token.creator || ''}`.toLowerCase();
    if (!terms(filters.keywords).every((term) => text.includes(term))) return false;
    if (terms(filters.exclude).some((term) => text.includes(term))) return false;
    if (filters.protocols.length && !filters.protocols.includes(protocolOf(token))) return false;

    const item = token as FilterToken;
    const audit: Record<AuditKey, number | undefined> = {
        visitors: item.recentVisitors,
        age: ageMinutes(token.createdAt),
        top10: item.top10Pct,
        devHold: item.devHoldPct,
        snipers: item.sniperPct,
        insiders: item.insiderPct,
        bundle: item.bundlePct,
        holders: item.holderCount,
        proTraders: item.proTraderCount,
        devMigrations: item.devMigrationCount,
        devPairs: item.devPairCount,
    };
    const metrics: Record<MetricKey, number | undefined> = {
        liquidity: token.liquidityUsd,
        volume: token.volume5mUsd,
        marketCap: token.marketCapUsd,
        curve: item.curvePct,
        fees: item.globalFeesSol,
        txns: token.buyCount5m + token.sellCount5m,
        buys: token.buyCount5m,
        sells: token.sellCount5m,
    };

    return auditFields.every(([key]) => rangePass(audit[key], filters.audit[key]))
        && metricFields.every(([key]) => rangePass(metrics[key], filters.metrics[key]));
}

export function filterCount(filters: ColumnFilter): number {
    const auditCount = auditFields.filter(([key]) => filters.audit[key].min || filters.audit[key].max).length;
    const metricCount = metricFields.filter(([key]) => filters.metrics[key].min || filters.metrics[key].max).length;
    return Number(Boolean(filters.keywords.trim())) + Number(Boolean(filters.exclude.trim()))
        + filters.protocols.length + auditCount + metricCount;
}

export function ProtocolMark({ id, className = 'h-4 w-4' }: { id: string; className?: string }) {
    if (id === 'pump' || id === 'pumpswap') return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5.2 14.4 14.4 5.2a3.1 3.1 0 0 1 4.4 4.4l-9.2 9.2a3.1 3.1 0 0 1-4.4-4.4Z" fill="#53e29c" />
            <path d="m7.1 12.5 4.4 4.4" stroke="#0f1814" strokeWidth="1.8" />
            {id === 'pumpswap' && <path d="M14.8 13.2h5m-1.8-2 2 2-2 2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
    );
    if (id === 'raydium') return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m12 2.8 8.2 4.7v9L12 21.2l-8.2-4.7v-9L12 2.8Z" stroke="#63d2ff" strokeWidth="1.7" />
            <path d="m8.1 14.8 3.9-6.6 3.9 6.6M10 12h4" stroke="#9b7cff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    );
    if (id === 'meteora') return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3.5 17.8 7 6.2l5 7 5-7 3.5 11.6" stroke="#8c7cff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5.5 18h13" stroke="#53e5d2" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    );
    if (id === 'moonshot') return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18.5 15.8A8 8 0 0 1 8.2 5.5a8.2 8.2 0 1 0 10.3 10.3Z" fill="#f08cff" />
            <path d="m17 5 .5 1.5L19 7l-1.5.5L17 9l-.5-1.5L15 7l1.5-.5L17 5Z" fill="#fff" />
        </svg>
    );
    if (id === 'bonk') return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="13" r="4.2" fill="#ff8b2d" />
            <circle cx="6.2" cy="8.2" r="2" fill="#ff8b2d" /><circle cx="10" cy="5.8" r="2" fill="#ff8b2d" />
            <circle cx="14" cy="5.8" r="2" fill="#ff8b2d" /><circle cx="17.8" cy="8.2" r="2" fill="#ff8b2d" />
        </svg>
    );
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 7.2c4-3 10-3 14 0M4 11.6c5-3 11-3 16 0M5 16c4-3 10-3 14 0" stroke="#7c70ff" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function RangeRow({ label, range, ageField, onChange }: {
    label: string;
    range: Range;
    ageField?: boolean;
    onChange: (next: Range) => void;
}) {
    const inputClass = 'h-10 min-w-0 flex-1 rounded-md border border-[var(--term-border-strong)] !bg-[var(--term-bg)] px-3 text-xs tabular-nums text-white outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-accent)] focus:ring-0';
    return (
        <label className="block">
            <span className="mb-1.5 block text-[11px] text-[var(--term-muted)]">{label}</span>
            <span className="grid grid-cols-2 gap-4">
                <span className="flex min-w-0">
                    <input inputMode="decimal" value={range.min} onChange={(event) => onChange({ ...range, min: event.target.value })} className={`${inputClass} ${ageField ? 'rounded-r-none' : ''}`} placeholder="Min" aria-label={`${label} minimum`} />
                    {ageField && <span className="grid h-10 w-10 shrink-0 place-items-center rounded-r-md border border-l-0 border-[var(--term-border-strong)] bg-[var(--term-control)] text-xs text-[var(--term-text)]">m</span>}
                </span>
                <span className="flex min-w-0">
                    <input inputMode="decimal" value={range.max} onChange={(event) => onChange({ ...range, max: event.target.value })} className={`${inputClass} ${ageField ? 'rounded-r-none' : ''}`} placeholder="Max" aria-label={`${label} maximum`} />
                    {ageField && <span className="grid h-10 w-10 shrink-0 place-items-center rounded-r-md border border-l-0 border-[var(--term-border-strong)] bg-[var(--term-control)] text-xs text-[var(--term-text)]">m</span>}
                </span>
            </span>
        </label>
    );
}

export default function DiscoveryFilters({ openFor, value, onClose, onApply }: {
    openFor?: DiscoveryCategory;
    value: FilterMap;
    onClose: () => void;
    onApply: (next: FilterMap) => void;
}) {
    const [category, setCategory] = useState<DiscoveryCategory>('new');
    const [tab, setTab] = useState<FilterTab>('protocols');
    const [draft, setDraft] = useState<FilterMap>(() => emptyFilters());

    useEffect(() => {
        if (!openFor) return;
        setCategory(openFor);
        setDraft(structuredClone(value));
        setTab('protocols');
    }, [openFor, value]);

    if (!openFor) return null;
    const current = draft[category];
    const update = (next: Partial<ColumnFilter>) => setDraft((filters) => ({
        ...filters,
        [category]: { ...filters[category], ...next },
    }));
    const reset = () => setDraft((filters) => ({ ...filters, [category]: emptyColumn() }));

    return (
        <div className="fixed inset-0 z-[110] grid place-items-center overflow-hidden bg-transparent p-4" onMouseDown={onClose}>
            <section
                role="dialog"
                aria-modal="true"
                aria-label="Discovery filters"
                className="flex h-[min(86vh,49rem)] w-full max-w-[54rem] flex-col overflow-hidden rounded-[.55rem] border border-[var(--term-border-strong)] bg-[var(--term-panel)] shadow-[0_30px_100px_rgba(0,0,0,.72)]"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header className="flex h-14 shrink-0 items-center border-b border-[var(--term-border)] px-5">
                    <h2 className="text-lg font-[600] tracking-[-.02em] text-white">Filters</h2>
                    <button onClick={onClose} className="ml-auto grid h-8 w-8 place-items-center rounded-md text-[var(--term-muted)] hover:bg-[var(--term-control)] hover:text-white" aria-label="Close filters"><XMarkIcon className="h-5 w-5" /></button>
                </header>

                <nav className="flex h-14 shrink-0 items-end gap-8 border-b border-[var(--term-border)] px-5" aria-label="Filter columns">
                    {discoveryCols.map((column) => {
                        const count = filterCount(draft[column.key]);
                        return <button key={column.key} onClick={() => setCategory(column.key)} className={`flex h-full items-center gap-2 border-b-2 px-0.5 text-sm font-[550] ${category === column.key ? 'border-white text-white' : 'border-transparent text-[var(--term-muted)] hover:text-white'}`}>{column.label}{count > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--term-accent)] px-1 text-[10px] font-[700] text-[#111114]">{count}</span>}</button>;
                    })}
                    <button onClick={reset} className="ml-auto mb-3 grid h-8 w-8 place-items-center rounded-md text-[var(--term-muted)] hover:bg-[var(--term-control)] hover:text-white" aria-label={`Reset ${discoveryCols.find((item) => item.key === category)?.label} filters`}><ArrowPathIcon className="h-5 w-5" /></button>
                </nav>

                <div className="grid shrink-0 grid-cols-2 gap-4 border-b border-[var(--term-border)] px-5 py-4">
                    <label><span className="mb-1.5 block text-[11px] text-[var(--term-muted)]">Search Keywords</span><span className="flex h-10 items-center rounded-md border border-[var(--term-border-strong)] bg-[var(--term-bg)] px-3 focus-within:border-[var(--term-accent)]"><MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--term-dim)]" /><input value={current.keywords} onChange={(event) => update({ keywords: event.target.value })} className="min-w-0 flex-1 border-0 !bg-transparent pl-2 text-xs text-white outline-none placeholder:text-[var(--term-dim)] focus:ring-0" placeholder="keyword1, keyword2…" /></span></label>
                    <label><span className="mb-1.5 block text-[11px] text-[var(--term-muted)]">Exclude Keywords</span><span className="flex h-10 items-center rounded-md border border-[var(--term-border-strong)] bg-[var(--term-bg)] px-3 focus-within:border-[var(--term-accent)]"><XMarkIcon className="h-4 w-4 shrink-0 text-[var(--term-dim)]" /><input value={current.exclude} onChange={(event) => update({ exclude: event.target.value })} className="min-w-0 flex-1 border-0 !bg-transparent pl-2 text-xs text-white outline-none placeholder:text-[var(--term-dim)] focus:ring-0" placeholder="keyword1, keyword2…" /></span></label>
                </div>

                <nav className="flex h-14 shrink-0 items-center gap-4 px-5" aria-label="Filter sections">
                    {([['protocols', 'Protocols'], ['audit', 'Audit'], ['metrics', 'Metrics']] as Array<[FilterTab, string]>).map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`h-9 rounded-full px-4 text-sm font-[550] ${tab === key ? 'bg-[var(--term-control)] text-white' : 'text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white'}`}>{label}</button>)}
                </nav>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
                    {tab === 'protocols' && <div>
                        <div className="mb-3 flex items-center"><h3 className="text-xs font-[550] text-[var(--term-text)]">Protocols</h3>{current.protocols.length > 0 && <button onClick={() => update({ protocols: [] })} className="ml-auto rounded-full bg-[var(--term-control)] px-3 py-1.5 text-[10px] text-white hover:bg-[var(--term-border-strong)]">Unselect All</button>}</div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                            {protocolOptions.map((option) => {
                                const selected = current.protocols.includes(option.id);
                                return <button key={option.id} onClick={() => update({ protocols: selected ? current.protocols.filter((id) => id !== option.id) : [...current.protocols, option.id] })} className={`flex h-11 items-center gap-3 rounded-lg border px-3 text-left text-xs transition-colors ${selected ? 'border-[var(--term-accent)] bg-[color-mix(in_srgb,var(--term-accent)_12%,transparent)] text-white' : 'border-[var(--term-border)] bg-[var(--term-bg)] text-[var(--term-muted)] hover:border-[var(--term-border-strong)] hover:text-white'}`}><ProtocolMark id={option.id} className="h-5 w-5 shrink-0" /><span>{option.label}</span>{selected && <CheckIcon className="ml-auto h-4 w-4 text-[var(--term-accent)]" />}</button>;
                            })}
                        </div>
                    </div>}
                    {tab === 'audit' && <div className="grid gap-4">
                        {auditFields.map(([key, label]) => <RangeRow key={key} label={label} range={current.audit[key]} ageField={key === 'age'} onChange={(range) => update({ audit: { ...current.audit, [key]: range } })} />)}
                    </div>}
                    {tab === 'metrics' && <div className="grid gap-4">
                        {metricFields.map(([key, label]) => <RangeRow key={key} label={label} range={current.metrics[key]} onChange={(range) => update({ metrics: { ...current.metrics, [key]: range } })} />)}
                    </div>}
                </div>

                <footer className="flex h-[4.75rem] shrink-0 items-center border-t border-[var(--term-border)] px-5">
                    <span className="text-[10px] text-[var(--term-dim)]">Each column keeps its own saved criteria.</span>
                    <button onClick={() => { onApply(draft); onClose(); }} className="ml-auto h-10 rounded-full bg-[var(--term-accent)] px-6 text-sm font-[700] text-[#111114] hover:brightness-110">Apply All</button>
                </footer>
            </section>
        </div>
    );
}
