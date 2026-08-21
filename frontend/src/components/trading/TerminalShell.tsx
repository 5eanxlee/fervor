'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../../contexts/AuthContext';
import { terminalSkin, useTerminalSettings } from '../../services/terminalSettings';
import { TerminalHeader } from './TerminalChrome';
import TerminalSettingsModal, { type SettingsSection } from './TerminalSettingsModal';

const terminalRoutes = [
    '/dashboard',
    '/integrations',
    '/link-discord',
    '/portfolio',
    '/replay',
    '/search',
    '/settings',
    '/tracker',
    '/trade',
    '/wallets',
    '/watchlist',
];

const isTerminalRoute = (pathname: string): boolean => terminalRoutes.some((route) =>
    pathname === route || pathname.startsWith(`${route}/`)
);

export default function TerminalShell({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { isAuthenticated, isLoading } = useAuth();
    const [settings, setSettings] = useTerminalSettings();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
    const showChrome = isTerminalRoute(pathname) && isAuthenticated && !isLoading;

    const openSettings = (section: SettingsSection = 'appearance') => {
        setSettingsSection(section);
        setSettingsOpen(true);
    };

    return (
        <div
            data-terminal-theme={showChrome ? settings.theme : undefined}
            className={showChrome
                ? `flex h-screen min-h-[40rem] flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-text)] ${terminalSkin(settings)}`
                : 'min-h-screen bg-ash'}
        >
            {showChrome && <TerminalHeader settings={settings} onSettings={openSettings} />}
            <div className={showChrome ? 'min-h-0 flex-1 overflow-hidden bg-[var(--term-bg)]' : ''}>
                {children}
            </div>
            {showChrome && (
                <TerminalSettingsModal
                    open={settingsOpen}
                    onClose={() => setSettingsOpen(false)}
                    settings={settings}
                    setSettings={setSettings}
                    initialSection={settingsSection}
                />
            )}
        </div>
    );
}
