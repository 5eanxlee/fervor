import { describe, expect, it } from 'vitest';
import { coerceTerminalSettings, defaultTerminalSettings } from './terminalSettings';

describe('terminal settings', () => {
    it('bounds persisted trading values and preserves column choices', () => {
        expect(coerceTerminalSettings({
            columns: { new: false, final: true, migrated: false },
            quickBuySol: 500,
            slippageBps: -10,
            chartAxis: 'price',
            quickBuyOn: 'press',
        })).toMatchObject({
            columns: { new: false, final: true, migrated: false },
            quickBuySol: 100,
            slippageBps: 1,
            chartAxis: 'price',
            quickBuyOn: 'press',
        });
    });

    it('rejects corrupt persisted values', () => {
        expect(coerceTerminalSettings({
            quickBuySol: 'nope', slippageBps: Infinity, theme: 'neon', ticketSide: 'center',
            nav: { portfolio: false, watchlist: false },
        }))
            .toMatchObject({
                quickBuySol: defaultTerminalSettings.quickBuySol,
                slippageBps: defaultTerminalSettings.slippageBps,
                theme: 'terminal',
                ticketSide: 'right',
                nav: { portfolio: false, watchlist: false },
            });
    });

    it('restores Vision display preferences', () => {
        expect(coerceTerminalSettings({
            visionSize: 'small',
            visionTables: 'spaced',
            visionSearch: false,
            visionImage: 'circle',
            visionProgress: 'bar',
            visionCaps: 'rounded',
            visionHidden: true,
            visionUnhide: true,
        })).toMatchObject({
            visionSize: 'small',
            visionTables: 'spaced',
            visionSearch: false,
            visionImage: 'circle',
            visionProgress: 'bar',
            visionCaps: 'rounded',
            visionHidden: true,
            visionUnhide: true,
        });
    });
});
