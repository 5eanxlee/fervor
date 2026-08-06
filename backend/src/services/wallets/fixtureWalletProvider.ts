import { WalletHistoryPage, WalletHistoryProvider } from './provider';

export class FixtureWalletProvider implements WalletHistoryProvider {
    readonly name = 'fixture' as const;

    async history(): Promise<WalletHistoryPage> {
        return { transactions: [] };
    }
}
