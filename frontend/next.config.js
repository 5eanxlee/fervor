const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    turbopack: { root: path.join(__dirname, '..') },
    env: {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010/api',
        NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'mainnet-beta',
        NEXT_PUBLIC_DATA_MODE: process.env.NEXT_PUBLIC_DATA_MODE || 'live',
        NEXT_PUBLIC_REPLAY_MINT: process.env.NEXT_PUBLIC_REPLAY_MINT || '',
        NEXT_PUBLIC_REPLAY_SYMBOL: process.env.NEXT_PUBLIC_REPLAY_SYMBOL || 'REPLAY',
        NEXT_PUBLIC_REPLAY_NAME: process.env.NEXT_PUBLIC_REPLAY_NAME || 'Historical replay',
        NEXT_PUBLIC_REPLAY_SUPPLY: process.env.NEXT_PUBLIC_REPLAY_SUPPLY || '',
    },
}

module.exports = nextConfig
