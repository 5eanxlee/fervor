# Replay runtime

`coordinator.ts` is the first isolated runtime boundary over a verified replay. It requires canonical `fervor-trade-v2` chain order, emits every decoded trade once, substitutes USD-enriched trades only where eligible historical evidence exists, and advances a monotonic virtual clock to each emitted event.

The coordinator is deliberately pull-based. Pause, resume, single-step, completion, and stop are state transitions with no wall-clock timer, network, Redis, database, credential, or external-delivery dependency.

A caller supplies the run ID. Every seek treats its target as the next event index, increments the run epoch, resets virtual time to the preceding event, and pauses before further emission. Events carry the source replay hash, run ID, and epoch so work from another corpus, another run, an earlier seek, or a stopped run can be rejected.

`fervor-replay-cut-v1` is a portable cursor cut. It binds the source replay, next-event cursor, virtual time, and a domain-separated digest of every event identity in the prefix. Restore verifies the entire cut before changing cursor or epoch. The cut excludes run ID so a clean process can restore it.

`projection.ts` owns the deterministic trade projection over that cursor. It accepts only the bound run, epoch, source, and next event; maintains all-trade and USD-priced rolling books; and retains compact latest trade, USD, and SOL state. A `fervor-replay-checkpoint-v1` can be taken only while paused or complete. Restore validates its checksum, current canonical rollup contracts, priced/all subset invariants, source cut, and latest pointers against the verified tape before moving the coordinator.

`checkpointStore.ts` durably publishes that object beneath a provisioned parent directory as a write-once source, checkpoint-contract, and cursor file. It validates before touching disk, writes and syncs a private temporary file, atomically links the final name without overwrite, removes the temporary name, and syncs each created or changed directory. Concurrent identical writers converge; divergent state at one cursor collides instead of creating an ambiguous recovery point. Reads refuse symlinked directories or files, non-files, oversized or noncanonical bytes, key mismatches, and invalid checkpoint state. Nearest-checkpoint selection ignores only recognizable crash temporaries and otherwise fails on malformed directory state. This is the replay-local persistence boundary; remote replication and checkpoint-retention policy remain separate concerns.

`scheduler.ts` is the only wall-time pacing layer. It supports 1x, 20x, 100x, and maximum speed while the coordinator remains the sole owner of event time. Finite speeds use cumulative monotonic deadlines, so projection work reduces the following delay instead of accumulating drift. Maximum speed yields every 512 events to keep pause and abort controls responsive. A pause or abort cannot cross the next event boundary; a sink failure stops the run because its cursor can no longer be assumed to match downstream state.

`runtime.ts` is the single control owner. It serializes play, pause, step, seek, checkpoint, and stop over one coordinator and projection; seek restores the nearest source-and-contract checkpoint on the same epoch-fenced coordinator before replaying to the exact target. The runtime refuses inherited database, Redis, live-provider, wallet, KMS, transaction, Telegram, Discord, and cloud-credential environment variables without reading or logging their values.

`paperBroker.ts` is the provider-free execution model. It records intent at the current replay cursor, applies a pinned latency and look-ahead window, and consumes only later opposite-side trades from the exact mint pair. Market price guards and limit comparisons use rational raw-unit prices; all active orders share one participation-capped slice of each trade. Fills use conservative integer rounding, keep modeled fees separate, and emit epoch-bound facts that identify every partial fill, completion, expiry, and cancellation. It never reads candles, future trades, USD display values, AMM reserves, credentials, or provider IDs.

`fervor-paper-checkpoint-v1` stores the pinned model, order state, fills, and fact log at one replay cursor. Restore checks the digest, model identity, raw totals, fee reconciliation, price rules, fact state machine, and replay binding before hydration. Economic fact keys bind source, run, order, and sequence but deliberately exclude the replay epoch, so reprocessing after a crash converges on the same key while the fact's epoch still fences delayed work.

`fervor-replay-session-v1` places the market projection and paper checkpoint in one checksummed envelope at the same source, cursor, and time. `ReplaySessionStore` writes an immutable per-run sequence under one atomic filesystem target. Each entry names its parent digest, so concurrent writers either converge on identical bytes or one is rejected as stale; the sequence also permits paper commands to change state without advancing the tape cursor. The runtime does not consume this composite store yet.

`replay-lab.ts` exposes that owner as newline-delimited JSON over stdin and stdout, not an HTTP listener. It imports no application environment loader and starts paused after verifying the corpus. Launch it from a clean environment with `npm run replay:lab --workspace backend -- --replay <dir> --checkpoints <dir> --run <id>`. Commands are `status`, `play`, `pause`, `step`, `seek`, `checkpoint`, and `stop`; graceful EOF or a termination signal pauses and checkpoints before exit.

`docker-compose.replay.yml` is the portable OS sandbox. It attaches no network, env file, or secret; mounts the immutable corpus read-only and a separate checkpoint directory read-write; makes the container root read-only; drops every capability; denies privilege escalation; and bounds memory, CPU, PIDs, file descriptors, and temporary storage. Both host directories must already exist. Run it with `FERVOR_REPLAY_DIR=<dir> FERVOR_CHECKPOINT_DIR=<dir> FERVOR_REPLAY_RUN=<id> docker compose -f docker-compose.replay.yml run --rm replay`.

Run its focused verification with:

```bash
npm test -- --run tests/metric-replay.test.ts tests/replay-projection.test.ts
npm test -- --run tests/replay-paper-broker.test.ts
```
