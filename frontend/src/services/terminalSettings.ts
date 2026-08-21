'use client';

import {
    createContext,
    createElement,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import {
    CHART_STYLE_OPTIONS,
    CHART_TIMEFRAME_OPTIONS,
    type ChartQuote,
    type ChartStyle,
    type ChartTimeframe,
} from './chartData';

export type TerminalColumn = 'new' | 'final' | 'migrated';
export type TerminalDensity = 'compact' | 'spaced';
export type ChartAxis = 'market_cap' | 'price';
export type TerminalTheme = 'terminal' | 'dark' | 'noir';
export type TerminalFont = 'padre' | 'geist' | 'mono';
export type TerminalAccent = 'orange' | 'green' | 'blue' | 'purple';
export type TerminalNav = 'portfolio' | 'watchlist';
export type VisionSize = 'small' | 'large';
export type VisionTables = 'merged' | 'spaced';
export type VisionImage = 'square' | 'circle';
export type VisionProgress = 'ring' | 'bar';
export type VisionCaps = 'precise' | 'rounded';

export interface TerminalSettings {
    columns: Record<TerminalColumn, boolean>;
    density: TerminalDensity;
    pauseOnHover: boolean;
    chartAxis: ChartAxis;
    chartAutoScale: boolean;
    chartLogScale: boolean;
    chartVolume: boolean;
    chartQuote: ChartQuote;
    chartStyle: ChartStyle;
    chartPins: ChartTimeframe[];
    theme: TerminalTheme;
    font: TerminalFont;
    accent: TerminalAccent;
    quickBuySol: number;
    quickBuyOn: 'press' | 'release';
    slippageBps: number;
    clearOnSuccess: boolean;
    ticketSide: 'left' | 'right';
    showStats: boolean;
    showDock: boolean;
    visionSize: VisionSize;
    visionTables: VisionTables;
    visionSearch: boolean;
    visionImage: VisionImage;
    visionProgress: VisionProgress;
    visionCaps: VisionCaps;
    visionHidden: boolean;
    visionUnhide: boolean;
    nav: Record<TerminalNav, boolean>;
}

export const defaultTerminalSettings: TerminalSettings = {
    columns: { new: true, final: true, migrated: true },
    density: 'compact',
    pauseOnHover: true,
    chartAxis: 'market_cap',
    chartAutoScale: true,
    chartLogScale: false,
    chartVolume: true,
    chartQuote: 'usd',
    chartStyle: 'candles',
    chartPins: ['1s', '5s', '15s', '1m', '5m', '6h'],
    theme: 'terminal',
    font: 'padre',
    accent: 'orange',
    quickBuySol: 0.1,
    quickBuyOn: 'release',
    slippageBps: 100,
    clearOnSuccess: true,
    ticketSide: 'right',
    showStats: true,
    showDock: true,
    visionSize: 'large',
    visionTables: 'merged',
    visionSearch: true,
    visionImage: 'square',
    visionProgress: 'ring',
    visionCaps: 'precise',
    visionHidden: false,
    visionUnhide: false,
    nav: { portfolio: true, watchlist: true },
};

const storageKey = 'fervor_terminal_settings_v2';

type TerminalSettingsState = readonly [
    TerminalSettings,
    Dispatch<SetStateAction<TerminalSettings>>,
];

const TerminalSettingsContext = createContext<TerminalSettingsState | null>(null);

export const coerceTerminalSettings = (value: unknown): TerminalSettings => {
    if (!value || typeof value !== 'object') return defaultTerminalSettings;
    const raw = value as Partial<TerminalSettings>;
    const columns = raw.columns || defaultTerminalSettings.columns;
    const quickBuySol = Number(raw.quickBuySol);
    const slippageBps = Number(raw.slippageBps);
    const chartStyles = CHART_STYLE_OPTIONS.map(item => item.id);
    const chartFrames = CHART_TIMEFRAME_OPTIONS.map(item => item.id);
    const chartPins = Array.isArray(raw.chartPins)
        ? raw.chartPins.filter((item): item is ChartTimeframe => chartFrames.includes(item as ChartTimeframe)).slice(0, 7)
        : defaultTerminalSettings.chartPins;
    return {
        columns: {
            new: columns.new !== false,
            final: columns.final !== false,
            migrated: columns.migrated !== false,
        },
        density: raw.density === 'spaced' ? 'spaced' : 'compact',
        pauseOnHover: raw.pauseOnHover !== false,
        chartAxis: raw.chartAxis === 'price' ? 'price' : 'market_cap',
        chartAutoScale: raw.chartAutoScale !== false,
        chartLogScale: raw.chartLogScale === true,
        chartVolume: raw.chartVolume !== false,
        chartQuote: raw.chartQuote === 'sol' ? 'sol' : 'usd',
        chartStyle: chartStyles.includes(raw.chartStyle as ChartStyle)
            ? raw.chartStyle as ChartStyle
            : 'candles',
        chartPins: chartPins.length ? chartPins : defaultTerminalSettings.chartPins,
        theme: raw.theme === 'dark' || raw.theme === 'noir' ? raw.theme : 'terminal',
        font: raw.font === 'geist' || raw.font === 'mono' ? raw.font : 'padre',
        accent: raw.accent === 'green' || raw.accent === 'blue' || raw.accent === 'purple' ? raw.accent : 'orange',
        quickBuySol: Number.isFinite(quickBuySol) && quickBuySol > 0 ? Math.min(100, quickBuySol) : 0.1,
        quickBuyOn: raw.quickBuyOn === 'press' ? 'press' : 'release',
        slippageBps: Number.isFinite(slippageBps) ? Math.min(5000, Math.max(1, Math.round(slippageBps))) : 100,
        clearOnSuccess: raw.clearOnSuccess !== false,
        ticketSide: raw.ticketSide === 'left' ? 'left' : 'right',
        showStats: raw.showStats !== false,
        showDock: raw.showDock !== false,
        visionSize: raw.visionSize === 'small' ? 'small' : 'large',
        visionTables: raw.visionTables === 'spaced' ? 'spaced' : 'merged',
        visionSearch: raw.visionSearch !== false,
        visionImage: raw.visionImage === 'circle' ? 'circle' : 'square',
        visionProgress: raw.visionProgress === 'bar' ? 'bar' : 'ring',
        visionCaps: raw.visionCaps === 'rounded' ? 'rounded' : 'precise',
        visionHidden: raw.visionHidden === true,
        visionUnhide: raw.visionUnhide === true,
        nav: {
            portfolio: raw.nav?.portfolio !== false,
            watchlist: raw.nav?.watchlist !== false,
        },
    };
};

export const terminalSkin = (settings: Pick<TerminalSettings, 'theme' | 'font' | 'accent'>): string => [
    settings.theme === 'noir' ? 'saturate-0' : '',
    settings.theme === 'dark' ? 'brightness-[0.92]' : '',
    settings.font === 'mono' ? 'font-mono' : 'font-sans',
    `terminal-accent-${settings.accent}`,
].filter(Boolean).join(' ');

export function TerminalSettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<TerminalSettings>(defaultTerminalSettings);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(storageKey) || localStorage.getItem('fervor_terminal_settings_v1');
            setSettings(coerceTerminalSettings(JSON.parse(stored || 'null')));
        } catch {
            setSettings(defaultTerminalSettings);
        }
        setLoaded(true);
    }, []);

    useEffect(() => {
        if (!loaded) return;
        localStorage.setItem(storageKey, JSON.stringify(settings));
    }, [loaded, settings]);

    const value = useMemo<TerminalSettingsState>(() => [settings, setSettings], [settings]);

    return createElement(TerminalSettingsContext.Provider, { value }, children);
}

export function useTerminalSettings(): TerminalSettingsState {
    const value = useContext(TerminalSettingsContext);
    if (!value) throw new Error('useTerminalSettings must be used within TerminalSettingsProvider');
    return value;
}
