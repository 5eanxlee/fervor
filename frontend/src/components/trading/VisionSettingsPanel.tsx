'use client';

import { Dispatch, SetStateAction, useState } from 'react';
import { InformationCircleIcon } from '@heroicons/react/24/outline';
import type {
    TerminalAccent,
    TerminalColumn,
    TerminalSettings,
    VisionCaps,
    VisionImage,
    VisionProgress,
    VisionSize,
    VisionTables,
} from '../../services/terminalSettings';

type Tab = 'layout' | 'colors' | 'row' | 'extras';
type LayoutTab = 'display' | 'elements' | 'chart' | 'order';

export default function VisionSettingsPanel({
    settings,
    setSettings,
}: {
    settings: TerminalSettings;
    setSettings: Dispatch<SetStateAction<TerminalSettings>>;
}) {
    const [tab, setTab] = useState<Tab>('layout');
    const [layoutTab, setLayoutTab] = useState<LayoutTab>('display');
    const patch = (next: Partial<TerminalSettings>) => setSettings((value) => ({ ...value, ...next }));

    return (
        <div className="vision-settings">
            <nav className="flex gap-1.5 overflow-x-auto text-xs font-[500] text-[var(--term-muted)]" aria-label="Vision settings sections">
                {([['layout', 'Layout'], ['colors', 'Metric Colors'], ['row', 'Row'], ['extras', 'Extras']] as const).map(([value, label]) => (
                    <button key={value} onClick={() => setTab(value)} className={`h-8 shrink-0 rounded-full px-3.5 transition-colors ${tab === value ? 'bg-[var(--term-control)] text-white' : 'hover:bg-[var(--term-raised)] hover:text-white'}`}>{label}</button>
                ))}
            </nav>

            {tab === 'layout' && (
                <nav className="mt-3 flex gap-1 overflow-x-auto text-[11px] font-[500] text-[var(--term-muted)]" aria-label="Vision layout settings">
                    {([['display', 'Display'], ['elements', 'Row Elements'], ['chart', 'Mini Chart'], ['order', 'Table Order']] as const).map(([value, label]) => (
                        <button key={value} onClick={() => setLayoutTab(value)} className={`h-8 shrink-0 rounded-full px-3 ${layoutTab === value ? 'bg-[var(--term-raised)] text-white' : 'hover:text-white'}`}>{label}</button>
                    ))}
                </nav>
            )}

            <div className="mt-4">
                {tab === 'layout' && layoutTab === 'display' && (
                    <Panel flush>
                        <ChoiceRow label="Metrics Size" info>
                            <Pick active={settings.visionSize === 'small'} label="Small" onClick={() => patch({ visionSize: 'small' })}><MetricPreview size="small" /></Pick>
                            <Pick active={settings.visionSize === 'large'} label="Large" onClick={() => patch({ visionSize: 'large' })}><MetricPreview size="large" /></Pick>
                        </ChoiceRow>
                        <ChoiceRow label="Spaced Tables">
                            <Pick active={settings.visionTables === 'merged'} label="Merged" onClick={() => patch({ visionTables: 'merged', density: 'compact' })}><TablePreview spaced={false} /></Pick>
                            <Pick active={settings.visionTables === 'spaced'} label="Spaced" onClick={() => patch({ visionTables: 'spaced', density: 'spaced' })}><TablePreview spaced /></Pick>
                        </ChoiceRow>
                        <ChoiceRow label="Show Search Bar">
                            <Pick active={!settings.visionSearch} label="Hide" onClick={() => patch({ visionSearch: false })}><SearchPreview show={false} /></Pick>
                            <Pick active={settings.visionSearch} label="Show" onClick={() => patch({ visionSearch: true })}><SearchPreview show /></Pick>
                        </ChoiceRow>
                        <ChoiceRow label="Image Shape">
                            <Pick active={settings.visionImage === 'square'} label="Square" onClick={() => patch({ visionImage: 'square' })}><ImagePreview shape="square" /></Pick>
                            <Pick active={settings.visionImage === 'circle'} label="Circle" onClick={() => patch({ visionImage: 'circle' })}><ImagePreview shape="circle" /></Pick>
                        </ChoiceRow>
                        <ChoiceRow label="Progress Bar" info>
                            <Pick active={settings.visionProgress === 'ring'} label="Ring" onClick={() => patch({ visionProgress: 'ring' })}><ProgressPreview kind="ring" /></Pick>
                            <Pick active={settings.visionProgress === 'bar'} label="Bar" onClick={() => patch({ visionProgress: 'bar' })}><ProgressPreview kind="bar" /></Pick>
                        </ChoiceRow>
                        <ChoiceRow label="Round Market Caps" info>
                            <Pick active={settings.visionCaps === 'precise'} label="Precise" onClick={() => patch({ visionCaps: 'precise' })}><CapsPreview kind="precise" /></Pick>
                            <Pick active={settings.visionCaps === 'rounded'} label="Rounded" onClick={() => patch({ visionCaps: 'rounded' })}><CapsPreview kind="rounded" /></Pick>
                        </ChoiceRow>
                        <Toggle label="Show Hidden Tokens" checked={settings.visionHidden} onChange={(visionHidden) => patch({ visionHidden })} />
                        <Toggle label="Unhide on Migrated" checked={settings.visionUnhide} onChange={(visionUnhide) => patch({ visionUnhide })} />
                    </Panel>
                )}

                {tab === 'layout' && layoutTab === 'elements' && <Panel>
                    <Toggle label="Show token statistics" checked={settings.showStats} onChange={(showStats) => patch({ showStats })} />
                    <Toggle label="Show search bars" checked={settings.visionSearch} onChange={(visionSearch) => patch({ visionSearch })} />
                    <Toggle label="Pause updates while hovered" checked={settings.pauseOnHover} onChange={(pauseOnHover) => patch({ pauseOnHover })} />
                </Panel>}

                {tab === 'layout' && layoutTab === 'chart' && <Panel>
                    <Toggle label="Show token statistics" checked={settings.showStats} onChange={(showStats) => patch({ showStats })} />
                    <Toggle label="Show terminal status dock" checked={settings.showDock} onChange={(showDock) => patch({ showDock })} />
                </Panel>}

                {tab === 'layout' && layoutTab === 'order' && <Panel>
                    {([['new', 'New'], ['final', 'Homestretch'], ['migrated', 'Migrated']] as Array<[TerminalColumn, string]>).map(([column, label]) => <Toggle key={column} label={label} checked={settings.columns[column]} onChange={() => patch({ columns: { ...settings.columns, [column]: !settings.columns[column] } })} />)}
                </Panel>}

                {tab === 'colors' && <Panel>
                    <div className="pb-3 text-[10px] uppercase tracking-[.12em] text-[var(--term-dim)]">Fervor accent</div>
                    <div className="grid grid-cols-4 gap-2">
                        {([['orange', '#f59e0b'], ['green', '#5ddf6c'], ['blue', '#60a5fa'], ['purple', '#a78bfa']] as Array<[TerminalAccent, string]>).map(([accent, color]) => (
                            <button key={accent} onClick={() => patch({ accent })} className={`flex h-16 flex-col items-center justify-center rounded-xl border bg-[var(--term-raised)] capitalize ${settings.accent === accent ? 'border-[var(--term-accent)]' : 'border-[var(--term-border)]'}`}><span className="h-5 w-5 rounded-full" style={{ background: color }} /><span className="mt-1.5 text-[10px] text-white">{accent}</span></button>
                        ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2"><ColorSample label="Positive" color="var(--term-buy)" /><ColorSample label="Negative" color="var(--term-sell)" /></div>
                </Panel>}

                {tab === 'row' && <Panel>
                    <SimpleRow label="Metrics Size"><SimplePick value={settings.visionSize} onChange={(visionSize) => patch({ visionSize })} options={[['small', 'Small'], ['large', 'Large']]} /></SimpleRow>
                    <SimpleRow label="Image Shape"><SimplePick value={settings.visionImage} onChange={(visionImage) => patch({ visionImage })} options={[['square', 'Square'], ['circle', 'Circle']]} /></SimpleRow>
                    <SimpleRow label="Progress"><SimplePick value={settings.visionProgress} onChange={(visionProgress) => patch({ visionProgress })} options={[['ring', 'Ring'], ['bar', 'Bar']]} /></SimpleRow>
                </Panel>}

                {tab === 'extras' && <Panel>
                    <Toggle label="Show Hidden Tokens" checked={settings.visionHidden} onChange={(visionHidden) => patch({ visionHidden })} />
                    <Toggle label="Unhide on Migrated" checked={settings.visionUnhide} onChange={(visionUnhide) => patch({ visionUnhide })} />
                    <Toggle label="Show terminal status dock" checked={settings.showDock} onChange={(showDock) => patch({ showDock })} />
                </Panel>}
            </div>
        </div>
    );
}

function Panel({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
    return <div className={`overflow-hidden rounded-2xl border border-[var(--term-border-strong)] bg-[#1b1b1e] ${flush ? 'px-4' : 'p-4'}`}>{children}</div>;
}

function ChoiceRow({ label, info, children }: { label: string; info?: boolean; children: React.ReactNode }) {
    return <div className="grid min-h-[6rem] grid-cols-[minmax(7rem,.8fr)_minmax(14rem,1.3fr)] items-center gap-4 border-b border-[var(--term-border)] py-3 last:border-b-0"><div className="flex items-center gap-1.5 text-xs text-[var(--term-text)]">{label}{info && <InformationCircleIcon className="h-3.5 w-3.5 text-[var(--term-muted)]" />}</div><div className="grid grid-cols-2 gap-2">{children}</div></div>;
}

function SimpleRow({ label, children }: { label: string; children: React.ReactNode }) {
    return <div className="grid min-h-14 grid-cols-[minmax(7rem,.8fr)_minmax(14rem,1.3fr)] items-center gap-4 border-b border-[var(--term-border)] py-3 last:border-b-0"><div className="text-xs text-[var(--term-text)]">{label}</div><div className="grid grid-cols-2 gap-2">{children}</div></div>;
}

function Pick({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
    return <button onClick={onClick} className="min-w-0 text-center"><span className={`grid h-12 place-items-center rounded-lg border bg-[#18181b] px-2 transition-colors ${active ? 'border-[var(--term-accent)] ring-1 ring-[var(--term-accent)]' : 'border-[var(--term-border-strong)] hover:border-[var(--term-muted)]'}`}>{children}</span><span className={`mt-1 block text-[11px] ${active ? 'text-white' : 'text-[var(--term-muted)]'}`}>{label}</span></button>;
}

function MetricPreview({ size }: { size: VisionSize }) {
    return <span className={`flex items-baseline gap-1 text-white ${size === 'large' ? 'text-base' : 'text-xs'}`}><i className="text-[9px] not-italic text-[var(--term-muted)]">MC</i>77K</span>;
}

function TablePreview({ spaced }: { spaced: boolean }) {
    return <span className={`flex w-full items-center justify-center ${spaced ? 'gap-1.5' : 'gap-0'}`}>{[0, 1, 2].map((item) => <i key={item} className="h-7 w-[29%] rounded-[3px] border border-[var(--term-border-strong)] bg-[var(--term-bg)]" />)}</span>;
}

function SearchPreview({ show }: { show: boolean }) {
    return <span className="relative h-8 w-full border-y border-[var(--term-border-strong)]">{show && <i className="absolute inset-x-2 top-1.5 h-5 rounded-full border border-[var(--term-border-strong)] text-left text-[8px] not-italic leading-5 text-[var(--term-muted)]">&nbsp;&nbsp;Search</i>}</span>;
}

function ImagePreview({ shape }: { shape: VisionImage }) {
    return <span className="flex w-full items-center gap-2 text-left text-[9px] text-white"><i className={`h-7 w-7 shrink-0 border border-[var(--term-border-strong)] ${shape === 'circle' ? 'rounded-full' : 'rounded-md'}`} /><span className="min-w-0 flex-1">TICKER<i className="mt-1 block h-1 w-8 rounded bg-[var(--term-border-strong)]" /></span></span>;
}

function ProgressPreview({ kind }: { kind: VisionProgress }) {
    return <span className="relative flex w-full items-center gap-2 text-left text-[9px] text-white"><i className={`h-7 w-7 shrink-0 border border-[var(--term-border-strong)] ${kind === 'ring' ? 'rounded-lg ring-1 ring-[var(--term-accent)] ring-offset-1 ring-offset-[#18181b]' : 'rounded-md'}`} />TICKER{kind === 'bar' && <i className="absolute bottom-0 left-0 h-1 w-7 bg-[var(--term-accent)]" />}</span>;
}

function CapsPreview({ kind }: { kind: VisionCaps }) {
    return <span className="flex items-baseline gap-2 text-xs text-white"><i className="text-[9px] not-italic text-[var(--term-muted)]">MC</i>{kind === 'precise' ? '$77.7K' : '$77K'}</span>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
    return <label className="flex min-h-14 cursor-pointer items-center border-b border-[var(--term-border)] text-xs text-[var(--term-text)] last:border-b-0"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" /><span className="ml-auto flex h-6 w-10 items-center rounded-full bg-[var(--term-border-strong)] p-1 transition-colors peer-checked:bg-[var(--term-accent)]"><i className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} /></span></label>;
}

function ColorSample({ label, color }: { label: string; color: string }) {
    return <div className="flex h-12 items-center rounded-xl border border-[var(--term-border)] bg-[var(--term-raised)] px-3 text-[11px] text-white"><span className="mr-2 h-4 w-4 rounded-full" style={{ background: color }} />{label}</div>;
}

function SimplePick<T extends VisionSize | VisionImage | VisionProgress | VisionTables | VisionCaps>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
    return <>{options.map(([key, label]) => <button key={key} onClick={() => onChange(key)} className={`h-9 rounded-xl border text-[11px] ${value === key ? 'border-[var(--term-accent)] text-white' : 'border-[var(--term-border)] text-[var(--term-muted)] hover:text-white'}`}>{label}</button>)}</>;
}
