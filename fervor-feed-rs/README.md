# Fervor feed engine

This crate is the canonical transaction ingest and decode authority. Provider-native records enter through a source adapter, retain their exact raw bytes in `RawEnvelope`, and become `FervorTx` before any market decoder runs.

```text
provider record -> RawEnvelope -> source adapter -> FervorTx v1 -> market decoder
                       |               |
                       |               +-> quarantine on contract failure
                       +-> durable raw journal
```

`FervorTx` keeps three identities separate:

- `SignedTxId`: network and Solana signature.
- `ChainOccurrence`: network, slot, optional block ID, and optional transaction index.
- `ProviderObservation`: provider, source event ID, native wire format/version, and raw hash.

Missing transaction fields remain `None`; adapters must never invent block IDs, parent slots, block times, or signed transaction bytes. Every source capability is explicitly `supported`, `unsupported`, `not_observable`, or `not_applicable`, and `SourceCaps::require` fails startup unless every requested capability is supported.

## Contracts

- `src/fervor_tx.rs` owns the v1 contract, exact integer serialization, validation, and quarantine types.
- `src/yellowstone.rs` is the only module that translates `yellowstone-protobuf-v12` into `FervorTx`.
- `src/market_decoder.rs` accepts only `FervorTx`.
- `tests/contracts/fervor-tx-v1.json` is read by both Rust and TypeScript tests.
- `tests/contracts/decoded-trade-v1.json` locks Rust event serialization to the TypeScript ingress validator.

The Rust indexer is the sole live transaction-ingest authority. TypeScript workers consume owned decoded events for enrichment, projection, alerts, and delivery; they do not open a second market stream.

Additive optional fields may remain v1. Any semantic, identity, integer encoding, or ordering change requires a new contract version. Persisted observations retain their original provider wire version.

## Live source configuration

`HELIUS_LASERSTREAM_ENDPOINT` implies `MARKET_SOURCE=helius_laserstream` and uses `HELIUS_API_KEY`. When `YELLOWSTONE_ENDPOINTS` is set directly, `MARKET_SOURCE` is required and only `YELLOWSTONE_X_TOKEN` is sent, so a Helius credential cannot leak to another endpoint. `SOLANA_NETWORK` defaults to `mainnet-beta`.

## Historical extracts

`fervor-corpus` creates bounded Old Faithful extracts for deterministic replay. `inspect` downloads only the fixed-width slot index and small provenance files. It computes the exact selected CAR byte range, checks both declared ceilings and free disk, and performs no CAR `GET`. `extract` refetches and hashes the index, requires exact `206 Content-Range` responses, resumes truncated streams without duplicating bytes, and publishes only an atomically completed directory. `verify` rechecks the stored index, range accounting, CAR header, file set, lengths, and SHA-256 hashes.

```bash
cargo run --release --bin fervor-corpus -- inspect \
  --epoch 700 \
  --start-slot 302459600 \
  --end-slot 302461200 \
  --mint 3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump \
  --max-download 10GiB \
  --max-workspace 40GiB \
  --workspace /path/with/free/space \
  --plan /path/to/extract-plan.json

cargo run --release --bin fervor-corpus -- extract \
  --plan /path/to/extract-plan.json \
  --out /path/to/quant-2024-11-19

cargo run --release --bin fervor-corpus -- verify \
  --dir /path/to/quant-2024-11-19

cargo run --release --features archive-replay --bin fervor-replay -- \
  --corpus /path/to/quant-2024-11-19 \
  --out /path/to/quant-2024-11-19-replay
```

Ranges are half-open: `start-slot` is included and `end-slot` is excluded. The pilot currently accepts one mainnet epoch and the HTTPS host `files.old-faithful.net`; a different HTTPS mirror requires an explicit `--allow-host`. Credentials, query strings, fragments, silent source fallback, whole-epoch mirroring, and non-range CAR responses are rejected.

`fervor-replay` verifies the extract before reading it and performs no network requests. Old Faithful cannot filter records remotely, so the reader validates every selected block while only transactions referencing the manifest mint enter `RawEnvelope`, `FervorTx`, and the decoders. The command atomically publishes `transactions.ndjson`, `swaps.ndjson`, `trades.ndjson`, `pump-events.ndjson`, `pump-state.json`, `pump-curve.ndjson`, `supply.json`, `fx-observations.ndjson`, `fx-tape.ndjson`, and `manifest.json`. `trades.ndjson` uses the same `fervor-trade-v1` constructor and idempotency key as live ingest; archive time is used for both `observedAt` and deterministic `receivedAt` because historical arrival latency is not observable. The Pump outputs pin the selected historical event layout, exclude failed transactions, prove fixed supply from SPL Token creation CPIs, reconstruct completion in protocol event order, and calculate price and FDV without floating point. `supply.json` uses the same `fervor-supply-v1` constructor emitted by the live indexer and must agree with the reconstructed Pump state before publication.

`pump-curve.ndjson` records each post-trade curve state under `fervor-pump-curve-v1`. The virtual reserves determine marginal price; they are never presented as deposited liquidity. Exact real and virtual reserve integers remain in every point. `fervor-pump-real-reserve-mark-v1` values the two real reserves at that marginal price and labels the result estimated because curve price impact makes the full mark unrealizable. This distinction follows Pump's [official reserve semantics](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md).

The FX tape derives SOL/USD evidence from exact WSOL and USDC or USDT balance changes in pinned pools. It aggregates 30-second buckets with per-pool outlier rejection and volume-weighted prices, rejects cross-pool spreads above 2%, and expires points 90 seconds after their last accepted observation. Raw amounts and micro-dollar prices remain integers. The manifest records full scan and matched counts plus every output SHA-256 and a domain-separated replay hash. Repeating a pinned extract on the same code must produce byte-identical files. Rayon uses the host's available parallelism by default; set `RAYON_NUM_THREADS` to enforce a benchmark or container CPU budget.

The format implementation is grounded in [Jetstreamer 0.7.0](https://github.com/anza-xyz/jetstreamer/tree/cffaf3d891b3cbe45a46dd963d6d3571b2aa1a24), licensed MIT or Apache-2.0. The recorded archive implementation is [Yellowstone Old Faithful v0.7.25](https://github.com/rpcpool/yellowstone-faithful/tree/a69a0d2e189006608e3b73b7659a957b00b3567e). Its repository is predominantly AGPL-3.0-only, so Fervor does not copy that implementation. Official OF1 documentation offers archive downloads; no standalone service-terms page was found during the 2026-08-18 review. Extracts remain internal until redistribution is separately approved.

## Verification

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
```
