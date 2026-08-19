# Realtime gateway

`/api/realtime/v1` is an authenticated WebSocket endpoint. It currently serves the isolated historical replay; the live Redis source remains behind the compatibility SSE route until it has an equivalent coherent snapshot cut.

The browser sends UTF-8 JSON as binary WebSocket frames. The first frame must be `auth`; the JWT is never accepted in the URL. After `fervor-realtime-v1` `hello`, a client may subscribe to the replay token's `trade`, `market`, and `replay` streams. A fresh subscription receives one exact snapshot followed by deltas after that cut. A reconnect may provide the prior session, epoch, and per-stream cursors. The feed resumes only when the entire retained chain is present; otherwise it sends `resync_required` and a new snapshot.

Delivery classes are behavioral contracts:

- `exact`: control and error state that cannot be discarded silently.
- `ordered`: trades and other append-only facts; overload closes the connection with a resync signal.
- `state`: replaceable views such as market state; only a newer value for the same key may replace an unsent value.

`ReplayFeed` is shared by every connection. It reads each upstream delta page once, validates source/run/epoch/cursor continuity, retains a bounded resume journal, and fans validated frames out in process. Replay state has its own content cursor because pause, play, and paper state can change without advancing a trade.

`FrameQueue` bounds both bytes and frame count per connection. WebSocket compression is disabled to avoid CPU and memory amplification. Server ping/pong detects dead peers; application heartbeats make an idle but healthy stream visible to the client. The initial encoding is JSON bytes by design: benchmark evidence, rather than assumption, is the gate for adding MessagePack or a Rust gateway.

`MarketFanout` is the compatibility bridge for `/api/stream/tokens/:mint`. One Redis `XREAD` loop serves every connected SSE client in the API process. Per-client queues use the same lossless-versus-replaceable policy and honor Node response backpressure. Source failures retry with bounded backoff, subscriber failures cannot poison the shared loop, and an overloaded client is disconnected with `resync_required`. This removes per-browser Redis reads, but it is not the future live WebSocket source because the current Redis contract still lacks an atomic snapshot cut.

Relevant settings are `RT_AUTH_MS`, `RT_HEARTBEAT_MS`, `RT_POLL_MS`, `RT_QUEUE_BYTES`, `RT_QUEUE_FRAMES`, `RT_MAX_SUBS`, `RT_RESUME_EVENTS`, and `RT_MAX_PAYLOAD_BYTES`.

Run focused verification with:

```bash
npm test -- realtime-protocol.test.ts realtime-replay-feed.test.ts realtime-server.test.ts
```

Run the bounded transport qualification with `npm run bench:realtime`. It sends 1,000 production-contract frames to 32 authenticated loopback clients and fails on delivery loss or regression thresholds. This benchmark qualifies encoding, bounded queues, and WebSocket fanout; it does not claim live-provider, WAN, or market-correctness coverage. Retained results live with the selected historical corpus in `corpora/quant-2024-11-19/realtime-evidence.json`.
