# Replay runtime

`coordinator.ts` is the first isolated runtime boundary over a verified replay. It requires canonical `fervor-trade-v2` chain order, emits every decoded trade once, substitutes USD-enriched trades only where eligible historical evidence exists, and advances a monotonic virtual clock to each emitted event.

The coordinator is deliberately pull-based. Pause, resume, single-step, completion, and stop are state transitions with no wall-clock timer, network, Redis, database, credential, or external-delivery dependency.

A caller supplies the run ID. Every seek treats its target as the next event index, increments the run epoch, resets virtual time to the preceding event, and pauses before further emission. Events carry the source replay hash, run ID, and epoch so work from another corpus, another run, an earlier seek, or a stopped run can be rejected.

`fervor-replay-cut-v1` is a portable cursor cut. It binds the source replay, next-event cursor, virtual time, and a domain-separated digest of every event identity in the prefix. Restore verifies the entire cut before changing cursor or epoch. The cut excludes run ID so a clean process can restore it.

`projection.ts` owns the deterministic trade projection over that cursor. It accepts only the bound run, epoch, source, and next event; maintains all-trade and USD-priced rolling books; and retains compact latest trade, USD, and SOL state. A `fervor-replay-checkpoint-v1` can be taken only while paused or complete. Restore validates its checksum, current canonical rollup contracts, priced/all subset invariants, source cut, and latest pointers against the verified tape before moving the coordinator.

`checkpointStore.ts` durably publishes that object beneath a provisioned parent directory as a write-once, source-and-cursor-addressed local file. It validates before touching disk, writes and syncs a private temporary file, atomically links the final name without overwrite, removes the temporary name, and syncs each created or changed directory. Concurrent identical writers converge on one file. Reads refuse symlinks, non-files, oversized or noncanonical bytes, key mismatches, and invalid checkpoint state. This is the replay-local persistence boundary; remote replication and checkpoint-retention policy remain separate concerns.

Run its focused verification with:

```bash
npm test -- --run tests/metric-replay.test.ts tests/replay-projection.test.ts
```
