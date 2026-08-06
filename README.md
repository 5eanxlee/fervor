# Fervor

Fervor is a self-custody Solana trading terminal with live market data, client-signed swaps, conditional orders, alerts, wallet tracking, and portfolio analytics.

## Local development

Requirements: Node.js 22, npm, Docker, and Rust.

```bash
npm ci
docker compose up -d
cp env.example backend/.env
npm run migrate
npm run dev
```

The frontend runs at `http://localhost:3002` and the API at `http://localhost:3010`. Live trading and order submission remain disabled unless explicitly configured.

## Verification

```bash
npm run test:spec
npm run lint
npm test
npm run test:frontend
npm run build
npm run test:rust
```

Database integration tests require isolated configured databases. Never use production credentials or funded wallets for local testing.

