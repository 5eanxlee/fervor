# QUANT historical pilot

This pilot targets `3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump` on Solana mainnet. The selected half-open slot range is `[302459600, 302461200)` in epoch 700: 1,588 produced slots and 12 skipped slots over 11 minutes 25 seconds.

The first produced slot is timestamped `2024-11-20T03:48:28Z` and the last `2024-11-20T03:59:53Z`, which is `2024-11-19 19:48:28–19:59:53` in America/Los_Angeles. Selection time was verified from Old Faithful's epoch-700 slot-to-blocktime index, SHA-256 `0c642a5eba7800f4941f5e5e90cf58ac21e20806c72ea85593ffc4b2b4fee3ac`.

`extract-plan.json` pins the source objects, revisions, hashes, exact byte range, and hard resource ceilings. The planned range is 2,379,382,552 bytes; with the 59-byte CAR header and 5,184,000-byte slot index, extraction transfers 2,384,566,611 bytes and reserves 2,385,615,187 workspace bytes. The 673,522,614,052-byte epoch CAR is never downloaded in full.

The large raw extract is internal and is not committed to Git. Two independent downloads passed `fervor-corpus verify` with raw SHA-256 `fd3b452cc000ba80cef1b71ec999d32fe2826764c9f631425b40a011f72cd579` and index SHA-256 `035e344ab21076a8ba59d1317ffa4c99e914bdfa0f43e6cfe6d5bf84b5b7ad1e`.

At commit `40d461c`, both downloads replay to 1,588 blocks, 2,723,843 scanned transactions, 13,722 mint-matched transactions, and 262 currently supported swaps. Four independent replay runs produced byte-identical artifacts:

- transactions: `478a4336d26f0778681830d92e89890175d39a07cbf1a4d6c933e2dd4da3706e`;
- swaps: `39f0bab13b0bab28bcd7f92fb6c4768a707bab2e7ab1314aadae5e6e25a7aa75`;
- domain-separated replay: `e6cf77a7791c004d3cb420c1ca0dda30ae3bb310dbd5347d2c76ec833cfc132e`.

The acceptance run used the second download on a 16-vCPU GCP VM. It completed in 37.27 seconds at 389% average CPU with 354,752 KiB peak RSS, compared with 14:02.95 before filtering archive scan noise at the source boundary. The verified raw extracts and canonical replay are retained in private, versioned object storage.
