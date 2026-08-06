'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
    AdjustmentsHorizontalIcon,
    ArrowPathIcon,
    BellIcon,
    BoltIcon,
    BookmarkIcon,
    ChartBarIcon,
    CheckIcon,
    ChevronDownIcon,
    CircleStackIcon,
    ClockIcon,
    CubeTransparentIcon,
    EyeIcon,
    EyeSlashIcon,
    FireIcon,
    FunnelIcon,
    GlobeAltIcon,
    LinkIcon,
    MagnifyingGlassIcon,
    SpeakerWaveIcon,
    SpeakerXMarkIcon,
    UserGroupIcon,
    UserIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, DiscoveryCategory, DiscoveryToken } from '../../services/api';
import { terminalSkin, TerminalSettings, useTerminalSettings } from '../../services/terminalSettings';
import { SolanaMark } from './BrandMarks';
import { TerminalDock, TerminalHeader } from './TerminalChrome';
import TerminalSettingsModal from './TerminalSettingsModal';
import type { SettingsSection } from './TerminalSettingsModal';

const cols: Array<{ key: DiscoveryCategory; label: string }> = [
    { key: 'new', label: 'New' },
    { key: 'final', label: 'Soon' },
    { key: 'migrated', label: 'Migrated' },
];

const compact = (value?: number, digits = 2) => value === undefined || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: digits }).format(value);

const money = (value?: number, rounded = false) => value === undefined || !Number.isFinite(value)
    ? '—'
    : `$${value < 0.001 ? value.toPrecision(3) : compact(value, rounded ? 0 : 2)}`;

const age = (value?: string) => {
    if (!value) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
};

const short = (value?: string) => value ? `${value.slice(0, 3)}…${value.slice(-4)}` : '—';
const seedOf = (value: string) => Array.from(value).reduce((sum, char) => sum + char.charCodeAt(0), 0);

export default function DiscoveryTerminal() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();
    const [settings, setSettings] = useTerminalSettings();
    const [tokens, setTokens] = useState<DiscoveryToken[]>([]);
    const [query, setQuery] = useState<Record<DiscoveryCategory, string>>({ new: '', final: '', migrated: '' });
    const [muted, setMuted] = useState<Record<DiscoveryCategory, boolean>>({ new: false, final: false, migrated: false });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
    const [settingsSearch, setSettingsSearch] = useState('');
    const [live, setLive] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const hover = useRef<DiscoveryCategory | undefined>(undefined);
    const refresh = useRef<() => Promise<void>>(async () => undefined);
    const openSettings = (section: SettingsSection = 'appearance', search = '') => {
        setSettingsSection(section);
        setSettingsSearch(search);
        setSettingsOpen(true);
    };

    useEffect(() => {
        if (!isLoading && !isAuthenticated) router.replace('/');
    }, [isAuthenticated, isLoading, router]);

    useEffect(() => {
        if (!isAuthenticated) return;
        let active = true;
        let inFlight = false;
        let timer: number | undefined;
        const load = async () => {
            if (inFlight || document.visibilityState === 'hidden') return;
            inFlight = true;
            setRefreshing(true);
            try {
                const response = await apiService.getDiscovery(24);
                if (!active) return;
                const next = response.data || [];
                if (!(settings.pauseOnHover && hover.current)) setTokens(next);
                setLive(response.success);
            } catch {
                if (active) setLive(false);
            } finally {
                inFlight = false;
                if (active) setRefreshing(false);
            }
        };
        const poll = async () => {
            await load();
            if (active) timer = window.setTimeout(poll, document.visibilityState === 'hidden' ? 8_000 : 5_000);
        };
        refresh.current = load;
        void poll();
        return () => {
            active = false;
            if (timer) window.clearTimeout(timer);
        };
    }, [isAuthenticated, settings.pauseOnHover]);

    const visible = cols.filter((column) => settings.columns[column.key]);
    const groups = useMemo(() => Object.fromEntries(cols.map((column) => {
        const term = query[column.key].trim().toLowerCase();
        return [column.key, tokens.filter((token) => token.category === column.key && (!term || `${token.name} ${token.symbol} ${token.address}`.toLowerCase().includes(term)))];
    })) as Record<DiscoveryCategory, DiscoveryToken[]>, [query, tokens]);

    if (isLoading || !isAuthenticated) return <main className="grid h-screen place-items-center bg-[#0f0f12]"><div className="spinner" /></main>;

    return (
        <main data-terminal-theme={settings.theme} className={`flex h-screen min-h-[40rem] flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-text)] ${terminalSkin(settings)}`}>
            <TerminalHeader settings={settings} onSettings={(section) => openSettings(section)} />

            <section className="trenches-bar flex shrink-0 items-center px-[clamp(.9rem,1.8vw,1.5rem)]">
                <h1 className="text-[clamp(1.1rem,1.55vw,1.3rem)] font-[500] tracking-[-0.02em] text-white">Vision</h1>
                <SolanaMark className="ml-3 h-[1.05rem] w-[1.05rem]" />
                <button className="ml-4 text-[var(--term-muted)] hover:text-white" aria-label="Launchpad view"><CubeTransparentIcon className="h-4 w-4" /></button>
                <button className="ml-3 grid h-5 w-5 place-items-center rounded-full bg-[var(--term-control)] text-[var(--term-muted)] hover:text-white" aria-label="Pause feed"><span className="h-2 w-2 rounded-[2px] bg-current" /></button>
                <button className="ml-3 text-[var(--term-muted)] hover:text-white" aria-label="Fast feed"><FireIcon className="h-4 w-4" /></button>
                <div className="ml-auto flex items-center gap-[clamp(.5rem,1vw,.9rem)] text-[var(--term-muted)]">
                    <button onClick={() => openSettings('vision', 'Vision Display')} className="terminal-pill flex !h-8 items-center gap-1.5 !bg-[var(--term-raised)] !px-3 text-[clamp(.68rem,.8vw,.76rem)]"><AdjustmentsHorizontalIcon className="h-4 w-4" />Customize</button>
                    <button className="hidden hover:text-white sm:block" aria-label="Hide muted cards"><EyeSlashIcon className="h-4 w-4" /></button>
                    <button className="hidden hover:text-white md:block" aria-label="Bookmarks"><BookmarkIcon className="h-4 w-4" /></button>
                    <button className="hidden hover:text-white lg:block" aria-label="Alerts"><BellIcon className="h-4 w-4" /></button>
                    <button onClick={() => void refresh.current()} disabled={refreshing} className="grid h-7 w-7 place-items-center hover:text-white" aria-label="Refresh discovery"><ArrowPathIcon className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
                </div>
            </section>

            <section className="trenches-grid grid min-h-0 flex-1 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${Math.max(1, visible.length)}, minmax(min(19rem, 86vw), 1fr))` }}>
                {visible.map((column) => (
                    <section key={column.key} className="trench-col flex min-w-0 flex-col overflow-hidden" onMouseEnter={() => { hover.current = column.key; }} onMouseLeave={() => { hover.current = undefined; }}>
                        <header className="trench-head grid shrink-0 grid-cols-[minmax(4rem,1fr)_minmax(6.75rem,8rem)_minmax(7rem,1fr)] items-center gap-1 px-[clamp(.6rem,.9vw,.75rem)]">
                            <div className="flex min-w-0 items-center gap-1">
                                <h2 className="text-[clamp(.95rem,1.2vw,1rem)] font-[500] leading-[1.1] text-white">{column.label}</h2>
                                {column.key === 'final' && <ChevronDownIcon className="h-3 w-3 text-[var(--term-muted)]" />}
                            </div>
                            {settings.visionSearch ? <label className="trench-search mx-auto flex min-w-0 items-center">
                                <MagnifyingGlassIcon className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--term-dim)]" />
                                <input value={query[column.key]} onChange={(event) => setQuery((value) => ({ ...value, [column.key]: event.target.value }))} placeholder="Search" aria-label={`${column.label} search`} />
                            </label> : <span />}
                            <div className="ml-auto flex min-w-0 items-center justify-end">
                                <div className="trench-quick flex shrink-0 items-center gap-1 px-2"><BoltIcon className="h-3.5 w-3.5 fill-current" /><span>{settings.quickBuySol}</span><SolanaMark className="h-3 w-3" /></div>
                                <button className="trench-preset shrink-0">P1</button>
                                <button onClick={() => setMuted((value) => ({ ...value, [column.key]: !value[column.key] }))} className="trench-head-icon hidden xl:grid" aria-label={`${muted[column.key] ? 'Unmute' : 'Mute'} ${column.label}`}>{muted[column.key] ? <SpeakerXMarkIcon /> : <SpeakerWaveIcon />}</button>
                                <button className="trench-head-icon hidden xl:grid" aria-label={`Filter ${column.label}`}><FunnelIcon /></button>
                            </div>
                        </header>
                        <div className="trench-feed min-h-0 flex-1 overflow-y-auto overscroll-contain">
                            {groups[column.key].map((token) => (
                                <TokenCard key={`${column.key}:${token.address}:${token.poolAddress || ''}:${token.symbol}`} token={token} settings={settings} />
                            ))}
                            {!groups[column.key].length && <div className="grid h-32 place-items-center text-[11px] text-[var(--term-dim)]">No matching tokens</div>}
                        </div>
                    </section>
                ))}
            </section>

            {settings.showDock && <TerminalDock live={live} onSettings={() => openSettings()} />}
            <TerminalSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings} initialSection={settingsSection} initialSearch={settingsSearch} />
        </main>
    );
}

function TokenCard({ token, settings }: {
    token: DiscoveryToken;
    settings: TerminalSettings;
}) {
    const router = useRouter();
    const href = `/trade/${encodeURIComponent(token.address)}`;
    const seed = seedOf(`${token.symbol}:${token.poolAddress || token.address}`);
    const trades = Math.max(1, token.buyCount5m + token.sellCount5m);
    const buyRate = Math.round(token.buyCount5m / trades * 100);
    const devRate = seed % 17;
    const freshRate = (seed * 3) % 21;
    const insiderRate = (seed * 7) % 32;
    const holders = 12 + (seed % 384);
    const curve = token.category === 'final' ? 65 + seed % 34 : token.category === 'migrated' ? 100 : seed % 28;
    const openTicket = () => router.push(`${href}?side=buy&amount=${settings.quickBuySol}&slippage=${settings.slippageBps}`);
    const openCard = (event: MouseEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return;
        router.push(href);
    };
    const openCardKey = (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        router.push(href);
    };
    const copy = async (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            await navigator.clipboard.writeText(token.address);
            toast.success('Contract copied');
        } catch {
            toast.error('Unable to copy contract');
        }
    };

    return (
        <article
            role="link"
            tabIndex={0}
            aria-label={`Open ${token.symbol} chart`}
            onClick={openCard}
            onKeyDown={openCardKey}
            className={`token-card group relative cursor-pointer !h-[7.375rem] !min-h-[7.375rem] border-b border-[var(--term-border)] !pb-[.4375rem] !pl-[clamp(.75rem,.85vw,.9375rem)] !pr-[clamp(.75rem,.8vw,.875rem)] !pt-[.625rem] ${settings.visionTables === 'spaced' ? 'token-card-spaced !h-[7.75rem] !min-h-[7.75rem]' : ''}`}
        >
            <div className="flex h-full min-w-0 items-start gap-[.5rem]">
                <div className="w-[clamp(4.9rem,5.75vw,5.25rem)] shrink-0">
                    <div className="relative h-[clamp(4.9rem,9.2vh,5.25rem)] w-full">
                        <Link
                            href={href}
                            className={`token-avatar relative block !h-full !w-full overflow-hidden border-2 ${settings.visionImage === 'circle' ? 'rounded-full' : 'rounded-md'}`}
                            style={{ borderColor: buyRate >= 50 ? 'var(--trench-good-edge)' : 'var(--trench-bad-edge)' }}
                        >
                            <TokenGlyph token={token} seed={seed} />
                        </Link>
                        {settings.visionProgress === 'ring' ? <span
                            className="pointer-events-none absolute -bottom-1 -right-1 z-10 grid h-[1.15rem] w-[1.15rem] place-items-center rounded-full border-2 bg-[var(--term-bg)] text-[7px] shadow-sm"
                            style={{ borderColor: buyRate >= 50 ? 'var(--trench-good-edge)' : 'var(--trench-bad-edge)', color: buyRate >= 50 ? 'var(--trench-positive)' : 'var(--trench-negative)' }}
                        >◒</span> : <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1 overflow-hidden rounded-b-md bg-[var(--term-border-strong)]"><i className="block h-full bg-[var(--term-accent)]" style={{ width: `${buyRate}%` }} /></span>}
                        <span className="pointer-events-none absolute -right-1 -top-1 z-10 grid h-[1.125rem] w-[1.125rem] place-items-center rounded-full border border-[var(--term-border-strong)] bg-[var(--term-bg)] shadow-sm"><CheckIcon className="h-[.6rem] w-[.6rem] text-[var(--term-muted)]" /></span>
                    </div>
                    <button onClick={copy} className="mt-1 block h-3.5 w-full truncate px-1 text-center text-[clamp(.53rem,.62vw,.62rem)] leading-3.5 text-[var(--term-muted)] hover:text-white" aria-label="Copy address">{short(token.address)}</button>
                </div>

                <div className="flex h-full min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-start gap-1.5 pr-[10.5rem]">
                        <Link href={href} className="min-w-0 truncate pt-[.1875rem] text-[clamp(.95rem,1.25vw,1rem)] font-[550] leading-[1.05] text-white hover:text-[var(--term-accent)]">{token.symbol}</Link>
                        <span className="min-w-0 flex-1 truncate pt-[.1875rem] text-[clamp(.8rem,1.1vw,.875rem)] leading-[1.05] text-[var(--term-dim)]">{token.name}</span>
                        <div className="absolute right-[clamp(.75rem,.8vw,.875rem)] top-[.5625rem] shrink-0 text-right text-[.75rem] leading-none tabular-nums">
                            <div className="flex items-center justify-end gap-2.5">
                                <span className="flex items-baseline gap-1"><span className="text-[var(--term-dim)]">V</span><span className={`${settings.visionSize === 'large' ? 'text-[1.125rem]' : 'text-[.875rem]'} font-[550] tracking-[-.02em] text-[var(--term-text)]`}>{money(token.volume5mUsd, settings.visionCaps === 'rounded')}</span></span>
                                <span className="flex items-baseline gap-1"><span className="text-[var(--term-dim)]">MC</span><span className={`${settings.visionSize === 'large' ? 'text-[1.125rem]' : 'text-[.875rem]'} font-[550] tracking-[-.02em] text-[var(--term-gold)]`}>{money(token.marketCapUsd, settings.visionCaps === 'rounded')}</span></span>
                            </div>
                            <div className="mt-[.1875rem] flex items-center justify-end gap-1 text-[.6875rem]"><span className="text-[var(--term-dim)]">F</span><SolanaMark className="h-3 w-3" /><span className="font-[500] text-[var(--term-text)]">{compact((token.volume5mUsd || 0) / 18)}</span></div>
                        </div>
                    </div>

                    <div className="token-meta mt-0 flex h-[1.125rem] min-w-max items-center gap-[.5rem] whitespace-nowrap text-[.75rem] text-[var(--term-muted)]">
                        <div className="token-meta-social flex min-w-0 items-center gap-[.5rem]">
                            <span className={`text-[.875rem] font-[600] ${token.category === 'final' ? 'text-[var(--trench-age-bad)]' : 'text-[var(--trench-age-good)]'}`}>{age(token.createdAt)}</span>
                            <span><LinkIcon className="h-4 w-4" /></span>
                            <span className="hidden text-[var(--term-muted)] 2xl:inline"><GlobeAltIcon className="h-4 w-4" /></span>
                            <Link href={href} className="text-[var(--term-muted)] hover:text-white" aria-label="Open token chart"><MagnifyingGlassIcon className="h-4 w-4" /></Link>
                        </div>
                        {settings.showStats && <div className="token-meta-stats flex min-w-0 items-center gap-[.5rem]">
                            <span className="flex items-center gap-1"><UserGroupIcon className="h-4 w-4" />{holders}</span>
                            <span className="flex items-center gap-1"><ChartBarIcon className="h-4 w-4" />{Math.max(0, Math.round(trades / 9) - 1)}</span>
                            <span className="flex items-center gap-1"><span className={devRate > 8 ? 'text-[var(--term-gold)]' : ''}>♕</span>{devRate}/{Math.max(devRate + 1, Math.round(holders / 3))}</span>
                            <span className="flex items-center gap-1"><EyeIcon className="h-4 w-4" />{Math.max(1, Math.round(trades / 5))}</span>
                        </div>}
                    </div>

                    {token.creator && <div className="token-creator mt-0 flex h-4 min-w-max items-center gap-1.5 whitespace-nowrap text-[.75rem] leading-none">
                        <span className="truncate text-[var(--term-cyan)]">@{short(token.creator)}</span>
                        <span className="text-[var(--term-cyan)]">♙ {seed % 900}</span>
                        <span className="text-[var(--term-cyan)]">♧ {holders}</span>
                    </div>}

                    <div className="token-chips mt-[.1875rem] flex min-w-0 items-center gap-[.25rem] overflow-hidden whitespace-nowrap text-[.75rem]">
                        <Chip icon={<UserIcon />} value={`${buyRate}%`} tone={buyRate > 55 ? 'good' : 'bad'} />
                        <Chip icon={<ClockIcon />} value={`${devRate}% ${seed % 3 ? `${seed % 29}m` : 'DS'}`} />
                        <Chip icon={<CircleStackIcon />} value={`${freshRate} · ${curve}%`} tone={curve > 80 ? 'bad' : 'good'} />
                        <Chip icon={<FireIcon />} value={`${insiderRate}%`} tone={insiderRate > 18 ? 'bad' : 'good'} />
                        <button
                            onPointerDown={settings.quickBuyOn === 'press' ? openTicket : undefined}
                            onClick={(event) => { if (settings.quickBuyOn === 'release' || event.detail === 0) openTicket(); }}
                            className="token-buy ml-auto flex !h-[1.5rem] !w-[5.625rem] shrink-0 items-center justify-center gap-1 rounded-full bg-[var(--trench-buy)] !text-[.75rem] font-[650] text-[var(--term-bg)] hover:bg-white"
                            title={`Open ${settings.quickBuySol} SOL buy ticket`}
                        ><BoltIcon className="h-2.5 w-2.5 fill-current" />{settings.quickBuySol} SOL</button>
                    </div>
                </div>
            </div>
        </article>
    );
}

function TokenGlyph({ token, seed }: { token: DiscoveryToken; seed: number }) {
    if (token.logo && token.logo !== '/logo.png') {
        // Token images may come from arbitrary decentralized gateways.
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={token.logo} alt={token.name} className="h-full w-full object-cover" />;
    }
    const hue = seed % 360;
    return (
        <span className="relative grid h-full w-full place-items-center overflow-hidden" style={{ background: `linear-gradient(145deg, hsl(${hue} 62% 54%), hsl(${(hue + 82) % 360} 58% 22%))` }}>
            <i className="absolute -right-3 -top-3 h-12 w-12 rounded-full bg-white/20 blur-[1px]" />
            <i className="absolute -bottom-4 -left-3 h-14 w-14 rounded-full bg-black/25" />
            <span className="relative text-[clamp(1.2rem,2.6vw,2.1rem)] font-[600] text-white/95">{token.symbol.slice(0, 1)}</span>
        </span>
    );
}

function Chip({ icon, value, tone = 'neutral' }: { icon: React.ReactNode; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
    return (
        <span className={`token-chip min-w-max flex-none !h-[1.5rem] !gap-1 !px-[.375rem] !text-[.75rem] ${tone === 'good' ? 'text-[var(--trench-positive)]' : tone === 'bad' ? 'text-[var(--trench-negative)]' : 'text-white/70'}`}>
            <i>{icon}</i><span>{value}</span>
        </span>
    );
}
