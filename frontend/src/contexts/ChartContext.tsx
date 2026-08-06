'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { ChartTimeframe } from '../services/chartData';

interface ChartSettings {
    showHoldersChart: boolean;
    chartTimeframe: ChartTimeframe;
}

interface ChartContextType {
    settings: ChartSettings;
    isLoaded: boolean;
    updateShowHoldersChart: (show: boolean) => void;
    updateChartTimeframe: (timeframe: ChartTimeframe) => void;
}

const defaultSettings: ChartSettings = {
    showHoldersChart: true,
    chartTimeframe: '1s',
};

const ChartContext = createContext<ChartContextType | undefined>(undefined);

interface ChartProviderProps {
    children: ReactNode;
}

export const ChartProvider: React.FC<ChartProviderProps> = ({ children }) => {
    const [settings, setSettings] = useState<ChartSettings>(defaultSettings);
    const [isLoaded, setIsLoaded] = useState(false);

    // Load settings from localStorage on mount
    useEffect(() => {
        try {
            const savedSettings = localStorage.getItem('chart_settings');
            if (savedSettings) {
                const parsedSettings = JSON.parse(savedSettings);
                setSettings({ ...defaultSettings, ...parsedSettings });
            }
        } catch {
            // Invalid or unavailable browser storage falls back to defaults.
        } finally {
            // Mark as loaded regardless of success/failure
            setIsLoaded(true);
        }
    }, []);

    // Save settings to localStorage whenever they change (but only after initial load)
    useEffect(() => {
        if (!isLoaded) return; // Don't save during initial load

        try {
            localStorage.setItem('chart_settings', JSON.stringify(settings));
        } catch {
            // Settings remain available for the current session.
        }
    }, [settings, isLoaded]);

    const updateShowHoldersChart = (show: boolean) => {
        setSettings(prev => ({
            ...prev,
            showHoldersChart: show
        }));
    };

    const updateChartTimeframe = (timeframe: ChartTimeframe) => {
        setSettings(prev => ({
            ...prev,
            chartTimeframe: timeframe,
        }));
    };

    return (
        <ChartContext.Provider value={{
            settings,
            isLoaded,
            updateShowHoldersChart,
            updateChartTimeframe,
        }}>
            {children}
        </ChartContext.Provider>
    );
};

export const useChart = () => {
    const context = useContext(ChartContext);
    if (context === undefined) {
        throw new Error('useChart must be used within a ChartProvider');
    }
    return context;
}; 
