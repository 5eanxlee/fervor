import { env } from '../../config/env';
import { FixtureWalletProvider } from './fixtureWalletProvider';
import { HeliusWalletProvider } from './heliusWalletProvider';
import { WalletHistoryProvider } from './provider';

export const createWalletProvider = (): WalletHistoryProvider => {
    if (env.WALLET_TRACKING_MODE === 'fixture') return new FixtureWalletProvider();
    if (env.WALLET_TRACKING_MODE === 'live' && env.HELIUS_API_KEY) return new HeliusWalletProvider();
    throw new Error('Wallet tracking is disabled');
};
