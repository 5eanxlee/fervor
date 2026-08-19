import bs58 from 'bs58';

export interface ReplayWallet {
    publicKey: string;
    signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
}

export const createReplayWallet = async (webCrypto: Crypto = globalThis.crypto): Promise<ReplayWallet> => {
    const keys = await webCrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const publicKey = new Uint8Array(await webCrypto.subtle.exportKey('raw', keys.publicKey));

    return {
        publicKey: bs58.encode(publicKey),
        signMessage: async (message) => ({
            signature: new Uint8Array(await webCrypto.subtle.sign('Ed25519', keys.privateKey, message)),
        }),
    };
};
