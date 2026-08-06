FROM rust:1.90-bookworm AS build
WORKDIR /app
COPY fervor-feed-rs/Cargo.toml fervor-feed-rs/Cargo.lock ./
COPY fervor-feed-rs/src ./src
RUN cargo build --locked --release --bin fervor-alert-matcher --bin fervor-market-indexer

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/fervor-alert-matcher /usr/local/bin/fervor-alert-matcher
COPY --from=build /app/target/release/fervor-market-indexer /usr/local/bin/fervor-market-indexer
USER 65532:65532
CMD ["fervor-alert-matcher"]
