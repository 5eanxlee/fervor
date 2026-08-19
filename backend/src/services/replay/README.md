# Replay runtime

`coordinator.ts` is the first isolated runtime boundary over a verified replay. It preserves source-file trade order, emits every decoded trade once, substitutes USD-enriched trades only where eligible historical evidence exists, and advances a monotonic virtual clock to each emitted event.

The coordinator is deliberately pull-based. Pause, resume, single-step, completion, and stop are state transitions with no wall-clock timer, network, Redis, database, credential, or external-delivery dependency. Speed control, seek epochs, persistence, checkpoints, and process topology belong to later Gate E checkpoints.

Run its focused verification with:

```bash
npm test -- --run tests/metric-replay.test.ts
```
