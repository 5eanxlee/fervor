import { env } from '../../config/env';
import { MarketDataProvider } from './provider';
import { HeliusLaserStreamProvider } from './providers/heliusLaserStreamProvider';

export const createMarketDataProvider = (providerName: string = env.MARKET_DATA_PROVIDER): MarketDataProvider => {
    if (providerName === 'helius_laserstream') return new HeliusLaserStreamProvider();
    throw new Error(`Unsupported market data provider: ${providerName}`);
};
