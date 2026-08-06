import { env } from '../../config/env';
import { MarketDataProvider } from './provider';
import { FixtureProvider } from './providers/fixtureProvider';
import { HeliusLaserStreamProvider } from './providers/heliusLaserStreamProvider';

export const createMarketDataProvider = (providerName = env.MARKET_DATA_PROVIDER): MarketDataProvider => {
    if (providerName === 'fixture') return new FixtureProvider();
    if (providerName === 'helius_laserstream') return new HeliusLaserStreamProvider();
    return new FixtureProvider();
};
