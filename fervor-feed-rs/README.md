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

## Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```
