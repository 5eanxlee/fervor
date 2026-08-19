# Replay runtime

`coordinator.ts` is the first isolated runtime boundary over a verified replay. It preserves source-file trade order, emits every decoded trade once, substitutes USD-enriched trades only where eligible historical evidence exists, and advances a monotonic virtual clock to each emitted event.

The coordinator is deliberately pull-based. Pause, resume, single-step, completion, and stop are state transitions with no wall-clock timer, network, Redis, database, credential, or external-delivery dependency.

A caller supplies the run ID. Every seek treats its target as the next event index, increments the run epoch, resets virtual time to the preceding event, and pauses before further emission. Events carry the source replay hash, run ID, and epoch so work from another corpus, another run, an earlier seek, or a stopped run can be rejected. This in-memory cursor does not claim to restore downstream projections; durable state cuts and checkpoints belong to a later Gate E checkpoint.

Run its focused verification with:

```bash
npm test -- --run tests/metric-replay.test.ts
```
