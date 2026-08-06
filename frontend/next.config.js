const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    turbopack: { root: path.join(__dirname, '..') },
    env: {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010/api',
        NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'mainnet-beta',
    },
}

module.exports = nextConfig
