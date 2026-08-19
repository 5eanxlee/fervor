# Market data

This folder owns Fervor's normalized trade, price, candle, rolling-window, supply, FDV, and supported-liquidity semantics. Providers contribute observations; they do not contribute authoritative market cap or FDV values.

```text
fervor-trade-v1
      │
      ├─ quote price source ─> USD-enriched trade
      │                            │
      ├─ fervor-supply-v1          ├─ candles
      │                            ├─ rolling windows
      └─ supported liquidity       └─ fervor-market-v2 state
```

## Ownership

- `tradeEnricher.ts` is the shared quote-to-USD enrichment boundary.
- `fxTape.ts` validates and reads the historical `fervor-fx-tape-v1` contract. It never returns a point observed after the trade and never carries a point beyond `validUntil`.
- `metricEngine.ts` is the canonical FDV and supported-liquidity derivation boundary. Circulating market cap remains unavailable.
- `metricReplay.ts` verifies every source artifact and deterministically drives the same enrichment, candle, rolling-window, and metric engines under event time. It publishes through an atomic directory rename and refuses existing output.
- `rollingMetricBook.ts` owns bounded rolling counts, volume, and wallet cardinality. Callers must provide the event-time horizon; the engine has no wall-clock fallback.
- `marketMetricService.ts` obtains live time through the shared `Clock` port and still accepts an explicit replay/bootstrap horizon.
- `candleProjector.ts` owns event-time OHLCV aggregation and durable candle projection.
- Repositories persist projections; they must not reinterpret metric semantics.

Historical SOL/USD is derived from the pinned Raydium WSOL/USDC and WSOL/USDT pool policy. Stablecoin-quoted trades use the explicit estimated `fervor-stable-usd-v1` at-par policy. Missing, future, expired, corrupt, or unsupported evidence yields no USD price.

Live enrichment still uses the configured reference-price adapter. Replacing that adapter with the streaming form of the owned FX tape is a remaining Gate D task; replay must never fall back to the live adapter.

## Verification

```bash
npm test -- --run tests/fx-tape.test.ts tests/reference-price.test.ts \
  tests/metric-engine.test.ts tests/rolling-metric-book.test.ts \
  tests/candle-projector.test.ts tests/metric-replay.test.ts \
  tests/market-clock.test.ts
npm run build
```

After building, a verified replay is projected with:

```bash
npm run project:replay -- --replay <replay-dir> --out <new-output-dir>
```
