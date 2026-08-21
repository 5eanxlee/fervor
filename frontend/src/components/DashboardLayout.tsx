'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTerminalSettings } from '../services/terminalSettings';
import { TerminalDock } from './trading/TerminalChrome';
import TerminalSettingsModal from './trading/TerminalSettingsModal';
import type { SettingsSection } from './trading/TerminalSettingsModal';

interface DashboardLayoutProps {
    children: ReactNode;
    live?: boolean;
}

export default function DashboardLayout({ children, live = true }: DashboardLayoutProps) {
    const [settings, setSettings] = useTerminalSettings();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
    const openSettings = (section: SettingsSection = 'appearance') => {
        setSettingsSection(section);
        setSettingsOpen(true);
    };

    return (
        <main
            data-terminal-theme={settings.theme}
            className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-text)]"
        >
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--term-bg)]">
                {children}
            </div>
            {settings.showDock && <TerminalDock live={live} onSettings={() => openSettings()} />}
            <TerminalSettingsModal
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                settings={settings}
                setSettings={setSettings}
                initialSection={settingsSection}
            />
        </main>
    );
}
