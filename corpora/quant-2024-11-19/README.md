# QUANT historical pilot

This pilot targets `3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump` on Solana mainnet. The selected half-open slot range is `[302459600, 302461200)` in epoch 700: 1,588 produced slots and 12 skipped slots over 11 minutes 25 seconds.

The first produced slot is timestamped `2024-11-20T03:48:28Z` and the last `2024-11-20T03:59:53Z`, which is `2024-11-19 19:48:28–19:59:53` in America/Los_Angeles. Selection time was verified from Old Faithful's epoch-700 slot-to-blocktime index, SHA-256 `0c642a5eba7800f4941f5e5e90cf58ac21e20806c72ea85593ffc4b2b4fee3ac`.

`extract-plan.json` pins the source objects, revisions, hashes, exact byte range, and hard resource ceilings. The planned range is 2,379,382,552 bytes; with the 59-byte CAR header and 5,184,000-byte slot index, extraction transfers 2,384,566,611 bytes and reserves 2,385,615,187 workspace bytes. The 673,522,614,052-byte epoch CAR is never downloaded in full.

The large raw extract is internal and is not committed to Git. A completed artifact is not qualified until `fervor-corpus verify` passes and an independent second extraction produces the same raw SHA-256.
