'use client';

import { Dispatch, SetStateAction, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { TerminalNav, TerminalSettings } from '../../services/terminalSettings';
import VisionSettingsPanel from './VisionSettingsPanel';

export type SettingsSection = 'appearance' | 'vision' | 'chart' | 'trading' | 'notifications' | 'layout' | 'navigation';

const toggleClass = (active: boolean) => active
    ? 'rounded-lg border border-[var(--term-accent)] bg-[var(--term-accent)] text-[#0f0f12]'
    : 'rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] text-[var(--term-muted)] hover:text-white';

const sections: Array<{ key: SettingsSection; label: string; terms: string }> = [
    { key: 'appearance', label: 'Appearance', terms: 'font theme accent color interface account' },
    { key: 'vision', label: 'Vision Display', terms: 'vision display metrics tables search image progress row extras columns pulse trenches' },
    { key: 'chart', label: 'Chart', terms: 'chart market cap price auto scale log volume axis' },
    { key: 'trading', label: 'Trading', terms: 'trade quick buy slippage confirmation execution' },
    { key: 'notifications', label: 'Notifications', terms: 'notification telegram discord channel integration' },
    { key: 'layout', label: 'Workspace', terms: 'layout columns density panel dock statistics' },
    { key: 'navigation', label: 'Navigation', terms: 'navigation portfolio track watchlist menu' },
];

export default function TerminalSettingsModal({
    open,
    onClose,
    settings,
    setSettings,
    initialSection = 'appearance',
    initialSearch = '',
}: {
    open: boolean;
    onClose: () => void;
    settings: TerminalSettings;
    setSettings: Dispatch<SetStateAction<TerminalSettings>>;
    initialSection?: SettingsSection;
    initialSearch?: string;
}) {
    const [section, setSection] = useState<SettingsSection>(initialSection);
    const [search, setSearch] = useState(initialSearch);

    useEffect(() => {
        if (!open) return;
        setSection(initialSection);
        setSearch(initialSearch);
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [initialSearch, initialSection, onClose, open]);

    const matches = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return sections;
        return sections.filter((item) => `${item.label} ${item.terms}`.toLowerCase().includes(query));
    }, [search]);

    useEffect(() => {
        if (!open || !matches.length || matches.some((item) => item.key === section)) return;
        setSection(matches[0].key);
    }, [matches, open, section]);

    if (!open) return null;

    const patch = (next: Partial<TerminalSettings>) => setSettings((value) => ({ ...value, ...next }));
    const toggleNav = (key: TerminalNav) => patch({ nav: { ...settings.nav, [key]: !settings.nav[key] } });

    return (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/75 p-3 backdrop-blur-[2px]" onMouseDown={onClose}>
            <section data-settings-dialog className="flex max-h-[86vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-3xl border border-[var(--term-border-strong)] bg-[#18181b] shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                <header className="flex h-13 shrink-0 items-center px-5">
                    <h2 className="text-sm font-[550] tracking-[-.01em] text-white">Settings</h2>
                    <button onClick={onClose} className="ml-auto grid h-8 w-8 place-items-center rounded-full text-[var(--term-muted)] hover:bg-[var(--term-raised)] hover:text-white" aria-label="Close settings"><XMarkIcon className="h-4 w-4" /></button>
                </header>

                <div className="px-5 pb-3">
                    <label className="flex h-9 items-center rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-3 focus-within:border-[var(--term-border-strong)]">
                        <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--term-dim)]" />
                        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search settings" aria-label="Search settings" className="min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-white outline-none ring-0 placeholder:text-[var(--term-dim)] focus:border-0 focus:outline-none focus:ring-0" />
                        {search && <button onClick={() => setSearch('')} className="grid h-6 w-6 place-items-center rounded-full text-[var(--term-dim)] hover:text-white" aria-label="Clear settings search"><XMarkIcon className="h-3.5 w-3.5" /></button>}
                    </label>
                </div>

                <nav role="tablist" aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-y border-[var(--term-border)] px-4 py-2">
                    {matches.map(({ key, label }) => (
                        <button key={key} role="tab" aria-selected={section === key} onClick={() => setSection(key)} className={`h-8 shrink-0 rounded-full px-3 text-[11px] ${section === key ? 'bg-[var(--term-control)] text-[var(--term-accent)]' : 'text-[var(--term-dim)] hover:bg-[var(--term-raised)] hover:text-white'}`}>{label}</button>
                    ))}
                    {!matches.length && <span className="flex h-8 items-center px-2 text-[11px] text-[var(--term-dim)]">No matching settings</span>}
                </nav>

                <div className="min-h-0 max-h-[calc(86vh-11.25rem)] overflow-y-auto px-5 py-4 text-xs text-[#abb2ad]">
                    {section === 'appearance' && <div className="space-y-5">
                        <Setting label="Font"><Choice value={settings.font} options={[["padre", 'Padre'], ['geist', 'Geist'], ['mono', 'Mono']]} onChange={(font) => patch({ font })} /></Setting>
                        <Setting label="Color theme"><Choice value={settings.theme} options={[["terminal", 'Terminal'], ['dark', 'Dark'], ['noir', 'Noir']]} onChange={(theme) => patch({ theme })} /></Setting>
                        <Setting label="Interface accent"><Choice value={settings.accent} options={[["orange", 'Fervor orange'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple']]} onChange={(accent) => patch({ accent })} /></Setting>
                        <p className="max-w-lg leading-5 text-[var(--term-dim)]">Theme, typography, and accent apply across every Fervor workspace.</p>
                    </div>}

                    {section === 'vision' && <VisionSettingsPanel settings={settings} setSettings={setSettings} />}

                    {section === 'chart' && <div className="space-y-4">
                        <Setting label="Default value axis"><Choice value={settings.chartAxis} options={[["market_cap", 'Market cap'], ['price', 'Price']]} onChange={(chartAxis) => patch({ chartAxis })} /></Setting>
                        <Check label="Open chart with auto scale" checked={settings.chartAutoScale} onChange={(chartAutoScale) => patch({ chartAutoScale })} />
                        <Check label="Use logarithmic price scale" checked={settings.chartLogScale} onChange={(chartLogScale) => patch({ chartLogScale })} />
                        <Check label="Show volume bars" checked={settings.chartVolume} onChange={(chartVolume) => patch({ chartVolume })} />
                    </div>}

                    {section === 'trading' && <div className="space-y-4">
                        <Setting label="Quick buy amount"><NumberField value={settings.quickBuySol} min={0.001} max={100} step={0.01} suffix="SOL" onChange={(quickBuySol) => patch({ quickBuySol })} /></Setting>
                        <Setting label="Quick buy activation"><Choice value={settings.quickBuyOn} options={[["release", 'On release'], ['press', 'On press']]} onChange={(quickBuyOn) => patch({ quickBuyOn })} /></Setting>
                        <Setting label="Default slippage"><NumberField value={settings.slippageBps} min={1} max={5000} step={1} suffix="bps" onChange={(slippageBps) => patch({ slippageBps: Math.round(slippageBps) })} /></Setting>
                        <Check label="Clear trade amount after confirmation" checked={settings.clearOnSuccess} onChange={(clearOnSuccess) => patch({ clearOnSuccess })} />
                    </div>}

                    {section === 'notifications' && <div className="space-y-4">
                        <Setting label="Delivery channels"><div className="grid grid-cols-2 gap-2"><StatusCard title="Telegram" /><StatusCard title="Discord" /></div></Setting>
                        <p className="leading-5 text-[var(--term-dim)]">Verified notification-channel connections will appear here. Channel setup is coming soon.</p>
                    </div>}

                    {section === 'layout' && <div className="space-y-4">
                        <Setting label="Visible Vision columns"><div className="flex flex-wrap gap-2">{([['new', 'New'], ['final', 'Soon'], ['migrated', 'Migrated']] as const).map(([key, label]) => <button key={key} onClick={() => patch({ columns: { ...settings.columns, [key]: !settings.columns[key] } })} className={`h-8 px-3 ${toggleClass(settings.columns[key])}`}>{label}</button>)}</div></Setting>
                        <Setting label="Discovery spacing"><Choice value={settings.density} options={[["compact", 'Compact'], ['spaced', 'Spaced']]} onChange={(density) => patch({ density })} /></Setting>
                        <Setting label="Trade panel"><Choice value={settings.ticketSide} options={[["right", 'Right'], ['left', 'Left']]} onChange={(ticketSide) => patch({ ticketSide })} /></Setting>
                        <Check label="Pause Vision updates while hovered" checked={settings.pauseOnHover} onChange={(pauseOnHover) => patch({ pauseOnHover })} />
                        <Check label="Show token statistics bar" checked={settings.showStats} onChange={(showStats) => patch({ showStats })} />
                        <Check label="Show terminal status dock" checked={settings.showDock} onChange={(showDock) => patch({ showDock })} />
                    </div>}

                    {section === 'navigation' && <div className="space-y-1">
                        <div className="mb-3 text-[10px] uppercase tracking-[0.12em] text-[var(--term-dim)]">Top navigation</div>
                        {([['portfolio', 'Portfolio'], ['watchlist', 'Track']] as const).map(([key, label]) => <Check key={key} label={label} checked={settings.nav[key]} onChange={() => toggleNav(key)} />)}
                    </div>}
                </div>

                <footer className="flex h-12 shrink-0 items-center justify-end px-5"><button onClick={onClose} className="h-8 rounded-full bg-[var(--term-accent)] px-5 text-xs font-[600] text-[#0f0f12]">Done</button></footer>
            </section>
        </div>
    );
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
    return <div><div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-[var(--term-dim)]">{label}</div>{children}</div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
    return <label className="flex cursor-pointer items-center justify-between border-t border-[var(--term-border)] py-3 first:border-t-0"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-[var(--term-border-strong)] bg-[var(--term-raised)] text-[var(--term-accent)] outline-none ring-0 focus:outline-none focus:ring-0" /></label>;
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void }) {
    return <div className="flex flex-wrap gap-2">{options.map(([key, label]) => <button key={key} onClick={() => onChange(key)} className={`h-8 px-3 ${toggleClass(value === key)}`}>{label}</button>)}</div>;
}

function NumberField({ value, min, max, step, suffix, onChange }: { value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
    return <div className="flex h-9 max-w-xs items-center rounded-xl border border-[var(--term-border)] bg-[var(--term-raised)] px-3"><input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))} className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-right text-white !outline-none !ring-0 !ring-offset-0 focus:!border-0 focus:!outline-none focus:!ring-0 focus:!ring-offset-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" /><span className="ml-2 text-[var(--term-dim)]">{suffix}</span></div>;
}

function StatusCard({ title }: { title: string }) {
    return <div className="rounded-xl border border-[var(--term-border)] bg-[var(--term-raised)] px-4 py-3 text-white"><span>{title}</span><span className="mt-1 block text-[10px] text-[var(--term-dim)]">Coming soon</span></div>;
}
