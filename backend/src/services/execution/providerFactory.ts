import { env } from '../../config/env';
import { FixtureSwapProvider } from './fixtureSwapProvider';
import { JupiterSwapProvider } from './jupiterSwapProvider';
import { SwapProvider } from './provider';

export const createSwapProvider = (): SwapProvider => {
    if (env.TRADING_MODE === 'fixture') return new FixtureSwapProvider();
    if (env.TRADING_MODE === 'live' && env.ALLOW_LIVE_SUBMISSION && env.JUPITER_API_KEY) {
        return new JupiterSwapProvider();
    }
    throw new Error('Trading is disabled');
};
