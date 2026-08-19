import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { createReplayWallet } from './replayWallet';

describe('replay wallet', () => {
    it('creates a Solana-compatible Ed25519 identity', async () => {
        const wallet = await createReplayWallet();
        const message = new TextEncoder().encode('fervor replay authentication');
        const { signature } = await wallet.signMessage(message);
        const publicKey = await crypto.subtle.importKey(
            'raw',
            bs58.decode(wallet.publicKey),
            'Ed25519',
            false,
            ['verify']
        );

        expect(bs58.decode(wallet.publicKey)).toHaveLength(32);
        expect(signature).toHaveLength(64);
        await expect(crypto.subtle.verify('Ed25519', publicKey, signature, message)).resolves.toBe(true);
    });
});
