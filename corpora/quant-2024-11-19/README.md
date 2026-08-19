# QUANT historical pilot

This pilot targets `3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump` on Solana mainnet. The selected half-open slot range is `[302459600, 302461200)` in epoch 700: 1,588 produced slots and 12 skipped slots over 11 minutes 25 seconds.

The first produced slot is timestamped `2024-11-20T03:48:28Z` and the last `2024-11-20T03:59:53Z`, which is `2024-11-19 19:48:28–19:59:53` in America/Los_Angeles. Selection time was verified from Old Faithful's epoch-700 slot-to-blocktime index, SHA-256 `0c642a5eba7800f4941f5e5e90cf58ac21e20806c72ea85593ffc4b2b4fee3ac`.

`extract-plan.json` pins the source objects, revisions, hashes, exact byte range, and hard resource ceilings. The planned range is 2,379,382,552 bytes; with the 59-byte CAR header and 5,184,000-byte slot index, extraction transfers 2,384,566,611 bytes and reserves 2,385,615,187 workspace bytes. The 673,522,614,052-byte epoch CAR is never downloaded in full.

The large raw extract is internal and is not committed to Git. Two independent downloads passed `fervor-corpus verify` with raw SHA-256 `fd3b452cc000ba80cef1b71ec999d32fe2826764c9f631425b40a011f72cd579` and index SHA-256 `035e344ab21076a8ba59d1317ffa4c99e914bdfa0f43e6cfe6d5bf84b5b7ad1e`.

At commit `40d461c`, both downloads replay to 1,588 blocks, 2,723,843 scanned transactions, 13,722 mint-matched transactions, and 262 currently supported swaps. Four independent replay runs produced byte-identical artifacts:

- transactions: `478a4336d26f0778681830d92e89890175d39a07cbf1a4d6c933e2dd4da3706e`;
- swaps: `39f0bab13b0bab28bcd7f92fb6c4768a707bab2e7ab1314aadae5e6e25a7aa75`;
- domain-separated replay: `e6cf77a7791c004d3cb420c1ca0dda30ae3bb310dbd5347d2c76ec833cfc132e`.

The acceptance run used the second download on a 16-vCPU GCP VM. It completed in 37.27 seconds at 389% average CPU with 354,752 KiB peak RSS, compared with 14:02.95 before filtering archive scan noise at the source boundary.

At commit `c21e448`, replay schema v2 also decodes the exact November 2024 Pump self-CPI layout and reconstructs lifecycle state. The two independent extracts produced byte-identical directories containing:

- manifest: `f18166d205a58e042b2967521f53acf9fda7e458acc464e3437ff3069acf0d7f`;
- transactions: `478a4336d26f0778681830d92e89890175d39a07cbf1a4d6c933e2dd4da3706e`;
- swaps: `39f0bab13b0bab28bcd7f92fb6c4768a707bab2e7ab1314aadae5e6e25a7aa75`;
- Pump events: `9ec4b7440554e4cc1b4994009b6cb5d6b82f72dee2e8193fac80dda1302c3f2b`;
- Pump state: `15f54ac175b27e8270791645f4f6d018309cd4ec9db1d2ea4489f7fcfb518a03`;
- domain-separated replay: `c3f46e619ad4c4d37fc5f8338770b67812e7c33287df21d08076c4d9ebf9d238`.

The qualified lifecycle contains one create, 250 committed trades, one complete, and one legacy withdraw. Nine Pump event CPIs from failed transactions are intentionally excluded because their state never committed. Creation CPIs prove six decimals, an initial raw supply of `1000000000000000`, and revoked mint authority. The final state is migrated with zero real token reserves, a price of `0.000000410880168542` SOL, and an FDV of `410.880168542336548767` SOL.

The independent v2 runs completed in 37.93 and 38.02 seconds at 384% average CPU, with 352,400 and 354,640 KiB peak RSS.

At commit `9c5ed16`, replay schema v3 emits the same `fervor-supply-v1` evidence contract consumed by the live and TypeScript metric paths. The event is anchored to Pump creation at slot `302459624`, signature `4mhRTtkQZLF6CL7joHwWwWdaSLP38or5WfhVY6DtZC4vKG3je1sxrDUbNtr2gyTvMXHGTynEUPC6M1NpQF7mbS8d`, instruction index 3, event index 0. It proves raw supply `1000000000000000`, six decimals, the `pump-event-2024-11-v1` layout, finalized commitment, and exact Old Faithful provenance. No RPC or metadata provider supplies this value.

Both independent extracts again produced byte-identical directories:

- manifest: `e0257286de86cde1382e4bb396ff2a5913c15037e3966f31f92050ea579d13a3`;
- transactions: `478a4336d26f0778681830d92e89890175d39a07cbf1a4d6c933e2dd4da3706e`;
- swaps: `39f0bab13b0bab28bcd7f92fb6c4768a707bab2e7ab1314aadae5e6e25a7aa75`;
- Pump events: `9ec4b7440554e4cc1b4994009b6cb5d6b82f72dee2e8193fac80dda1302c3f2b`;
- Pump state: `15f54ac175b27e8270791645f4f6d018309cd4ec9db1d2ea4489f7fcfb518a03`;
- supply: `b6a84094d265ea6ec2e68b10ffa9e6ae4f36f9c03bac9f834b80fbff76269e42`;
- domain-separated replay: `545b3c5dffe645387ecebc55a5267c6464810d91ab9267b9c550a85b9b42cacd`.

The v3 runs completed in 38.77 and 38.44 seconds at 381% and 384% average CPU, with 353,132 and 352,632 KiB peak RSS. The verified raw extracts and each qualified replay revision are retained in separate private, versioned GCP object-storage prefixes together with timing and build evidence.
