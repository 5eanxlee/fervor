use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use clap::Parser;
use fervor_feed_rs::fervor_tx::{Commitment, Network, RawEnvelope, SourceAdapter, SourceCap};
use fervor_feed_rs::market_decoder::{decode_swap, QuoteKind, Side, Venue};
use fervor_feed_rs::market_journal::MarketJournal;
use fervor_feed_rs::postgres::DbTls;
use fervor_feed_rs::stream_bus::{StreamBus, RAW_SOURCE, TRADE_STREAM};
use fervor_feed_rs::yellowstone::{YellowstoneAdapter, WIRE_FORMAT, WIRE_VERSION};
use futures_util::StreamExt;
use prost::Message;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::time::{interval, sleep, MissedTickBehavior};
use url::Url;
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::prelude::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions,
};

const PROGRAM_IDS: &[&str] = &[
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "675kPX9MHTjS2zt1qfr1NYJSCfn6wUCwBK6n2UZMfw",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "CPMMoo8L3F4NbTegBCKVNio1bsBk5wWK8Mwq1qkMzoC",
    "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    "whirLbMiicVdio4qvUfM5KAg6CtVciGkn7hKfLiE6iQ",
];
const REPLAY_SLOTS: u64 = 2;

#[derive(Parser, Debug)]
#[command(name = "fervor-market-indexer")]
struct Args {
    #[arg(long, env = "MARKET_SOURCE", default_value = "")]
    source: String,
    #[arg(long, env = "SOLANA_NETWORK", default_value = "mainnet-beta")]
    network: String,
    #[arg(long, env = "YELLOWSTONE_ENDPOINTS", value_delimiter = ',')]
    endpoints: Vec<String>,
    #[arg(long, env = "HELIUS_LASERSTREAM_ENDPOINT")]
    helius_endpoint: Option<String>,
    #[arg(long, env = "YELLOWSTONE_X_TOKEN")]
    x_token: Option<String>,
    #[arg(long, env = "HELIUS_API_KEY")]
    helius_key: Option<String>,
    #[arg(long, env = "REDIS_URL", default_value = "redis://localhost:6379")]
    redis_url: String,
    #[arg(long, env = "MARKET_DATABASE_URL")]
    market_database_url: String,
    #[arg(long, env = "DB_SSL_MODE", default_value = "disable")]
    db_ssl_mode: String,
    #[arg(long, env = "DB_SSL_CA")]
    db_ssl_ca: Option<String>,
    #[arg(long, env = "NODE_ENV", default_value = "development")]
    node_env: String,
    #[arg(long, env = "MARKET_DATA_COMMITMENT", default_value = "processed")]
    commitment: String,
    #[arg(long = "program-id")]
    program_ids: Vec<String>,
    #[arg(long, env = "INDEXER_RECONNECT_MAX_MS", default_value_t = 30_000)]
    reconnect_max_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradeEvent<'a> {
    source: &'a str,
    source_event_id: &'a str,
    kind: &'static str,
    idempotency_key: String,
    token_mint: &'a str,
    quote_mint: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pool_address: Option<&'a str>,
    protocol: Venue,
    program_id: &'a str,
    maker: &'a str,
    side: Side,
    token_amount: f64,
    quote_amount: f64,
    token_amount_raw: &'a str,
    quote_amount_raw: &'a str,
    token_decimals: u32,
    quote_decimals: u32,
    price_quote: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    sol_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usd_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    price_sol: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    price_usd: Option<f64>,
    quote_kind: QuoteKind,
    route: &'a [Venue],
    instruction_index: u32,
    event_index: u32,
    slot: u64,
    signature: &'a str,
    received_at: &'a str,
    observed_at: &'a str,
    confidence: f64,
    stale: bool,
    commitment: &'a str,
    decode_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    compute_units: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health<'a> {
    status: &'static str,
    endpoint: &'a str,
    last_slot: u64,
    decoded: u64,
    skipped: u64,
    duplicates: u64,
    quarantined: u64,
    reconnects: u64,
    updated_at: String,
}

fn commitment(value: &str) -> Result<CommitmentLevel> {
    match value.to_ascii_lowercase().as_str() {
        "processed" => Ok(CommitmentLevel::Processed),
        "confirmed" => Ok(CommitmentLevel::Confirmed),
        "finalized" => Ok(CommitmentLevel::Finalized),
        _ => Err(anyhow!("unsupported commitment: {value}")),
    }
}

fn event_key(
    network: Network,
    signature: &str,
    instruction_index: u32,
    event_index: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{}:{signature}:{instruction_index}:{event_index}",
        network.as_str()
    ));
    hex::encode(hasher.finalize())
}

fn subscription_id(network: Network, commitment: &str, programs: &[String]) -> String {
    let mut programs = programs.to_vec();
    programs.sort_unstable();
    programs.dedup();
    let mut hasher = Sha256::new();
    hasher.update(network.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(commitment.as_bytes());
    for program in programs {
        hasher.update([0]);
        hasher.update(program.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn source_id(
    source: &str,
    network: Network,
    commitment: &str,
    slot: u64,
    signature: &str,
) -> String {
    format!(
        "{source}:{}:{commitment}:{slot}:{signature}",
        network.as_str()
    )
}

fn resume_from(slot: u64) -> u64 {
    slot.saturating_sub(REPLAY_SLOTS)
}

fn transaction_signature(
    update: &yellowstone_grpc_proto::prelude::SubscribeUpdateTransaction,
) -> Result<String> {
    let signature = update
        .transaction
        .as_ref()
        .map(|info| info.signature.as_slice())
        .ok_or_else(|| anyhow!("Yellowstone transaction omitted its signature"))?;
    if signature.len() != 64 {
        return Err(anyhow!(
            "Yellowstone transaction signature must contain 64 bytes"
        ));
    }
    Ok(bs58::encode(signature).into_string())
}

fn database_tls(node_env: &str, value: &str) -> Result<DbTls> {
    let tls: DbTls = value.parse()?;
    if node_env == "production" && tls != DbTls::VerifyFull {
        return Err(anyhow!(
            "production market indexer requires DB_SSL_MODE=verify-full"
        ));
    }
    Ok(tls)
}

fn validate_endpoint(value: &str, production: bool) -> Result<()> {
    let endpoint = Url::parse(value).context("Yellowstone endpoint is not a valid URL")?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(anyhow!(
            "Yellowstone endpoint must be an HTTP(S) URL without embedded credentials, query, or fragment"
        ));
    }
    if production && endpoint.scheme() != "https" {
        return Err(anyhow!("production Yellowstone endpoints require HTTPS"));
    }
    Ok(())
}

fn event_time(
    created_at: Option<prost_types::Timestamp>,
    fallback: DateTime<Utc>,
) -> DateTime<Utc> {
    created_at
        .and_then(|value| DateTime::from_timestamp(value.seconds, value.nanos as u32))
        .unwrap_or(fallback)
}

async fn run_endpoint(args: &Args, endpoint: &str, reconnects: u64, tls: DbTls) -> Result<()> {
    let network: Network = args.network.parse()?;
    let source_commitment: Commitment = args.commitment.parse()?;
    let adapter = YellowstoneAdapter::new(args.source.clone(), network)?;
    adapter.caps().require(&[
        SourceCap::Transactions,
        SourceCap::RawPayload,
        SourceCap::TxIndex,
        source_commitment.cap(),
    ])?;
    let mut bus = StreamBus::connect(&args.redis_url)
        .await
        .context("failed to connect to the market stream bus")?;
    let mut journal =
        MarketJournal::connect(&args.market_database_url, tls, args.db_ssl_ca.as_deref())
            .await
            .context("failed to connect to the market journal")?;
    let mut builder = GeyserGrpcClient::build_from_shared(endpoint.to_string())?;
    if let Some(token) = args.x_token.clone() {
        builder = builder.x_token(Some(token))?;
    }
    let mut client = builder
        .connect()
        .await
        .with_context(|| format!("failed to connect to Yellowstone endpoint {endpoint}"))?;
    let programs = if args.program_ids.is_empty() {
        PROGRAM_IDS.iter().map(|value| value.to_string()).collect()
    } else {
        args.program_ids.clone()
    };
    let commitment_name = args.commitment.to_ascii_lowercase();
    let subscription_id = subscription_id(network, &commitment_name, &programs);
    let from_slot = journal
        .resume_slot(&args.source, &subscription_id, &commitment_name)
        .await?
        .map(resume_from);
    let mut request = SubscribeRequest {
        commitment: Some(commitment(&args.commitment)? as i32),
        from_slot,
        ..Default::default()
    };
    request.transactions.insert(
        "fervor-swaps".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            account_include: programs,
            ..Default::default()
        },
    );
    let (_sink, mut stream) = client.subscribe_with_request(Some(request)).await?;
    let mut decoded = 0_u64;
    let mut skipped = 0_u64;
    let mut last_slot = 0_u64;
    let mut duplicates = 0_u64;
    let mut quarantined = 0_u64;
    let mut heartbeat = interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = heartbeat.tick() => {
                bus.heartbeat(
                    "health:rust-market-indexer",
                    &Health {
                        status: "healthy",
                        endpoint,
                        last_slot,
                        decoded,
                        skipped,
                        duplicates,
                        quarantined,
                        reconnects,
                        updated_at: Utc::now().to_rfc3339(),
                    },
                )
                .await?;
            }
            update = stream.next() => {
                let update = update.ok_or_else(|| anyhow!("Yellowstone stream closed"))??;
                let received = Utc::now();
                let observed = event_time(update.created_at, received).to_rfc3339();
                let received = received.to_rfc3339();
                let filters = update.filters;
                let Some(UpdateOneof::Transaction(transaction)) = update.update_oneof else {
                    continue;
                };
                let signature = transaction_signature(&transaction)?;
                let raw_source_id = source_id(
                    &args.source,
                    network,
                    &commitment_name,
                    transaction.slot,
                    &signature,
                );
                let payload = transaction.encode_to_vec();
                let raw = RawEnvelope::new(
                    args.source.clone(),
                    WIRE_FORMAT.to_string(),
                    WIRE_VERSION,
                    raw_source_id,
                    subscription_id.clone(),
                    network,
                    source_commitment,
                    transaction.slot,
                    signature,
                    filters,
                    observed.clone(),
                    payload,
                )?;
                let inserted = journal.accept(&raw).await?;
                if !inserted {
                    duplicates += 1;
                }
                last_slot = transaction.slot;
                let tx = match adapter.adapt(raw, &transaction) {
                    Ok(tx) => tx,
                    Err(item) => {
                        quarantined += 1;
                        bus.dead_letter(
                            "rust-market-indexer",
                            RAW_SOURCE,
                            &item.source_event_id,
                            &serde_json::to_string(&item)?,
                            "source adapter quarantined transaction",
                        ).await?;
                        continue;
                    }
                };
                let swap = match decode_swap(&tx) {
                    Ok(Some(swap)) => swap,
                    Ok(None) => {
                        skipped += 1;
                        continue;
                    }
                    Err(item) => {
                        quarantined += 1;
                        bus.dead_letter(
                            "rust-market-indexer",
                            RAW_SOURCE,
                            &item.source_event_id,
                            &serde_json::to_string(&item)?,
                            "FervorTx decoder quarantined transaction",
                        ).await?;
                        continue;
                    }
                };
                decoded += 1;
                let source_id = format!(
                    "{}:{}:{}:{}:{}:{}",
                    args.source,
                    network.as_str(),
                    swap.slot, swap.signature, swap.instruction_index, swap.event_index
                );
                let trade = TradeEvent {
                    source: &args.source,
                    source_event_id: &source_id,
                    kind: "trade",
                    idempotency_key: event_key(
                        network,
                        &swap.signature,
                        swap.instruction_index,
                        swap.event_index,
                    ),
                    token_mint: &swap.token_mint,
                    quote_mint: &swap.quote_mint,
                    pool_address: swap.pool_address.as_deref(),
                    protocol: swap.protocol,
                    program_id: &swap.program_id,
                    maker: &swap.trader,
                    side: swap.side,
                    token_amount: swap.token_amount,
                    quote_amount: swap.quote_amount,
                    token_amount_raw: &swap.token_amount_raw,
                    quote_amount_raw: &swap.quote_amount_raw,
                    token_decimals: swap.token_decimals,
                    quote_decimals: swap.quote_decimals,
                    price_quote: swap.price_quote,
                    sol_amount: swap.sol_amount,
                    usd_amount: swap.usd_amount,
                    price_sol: swap.price_sol,
                    price_usd: swap.price_usd,
                    quote_kind: swap.quote_kind,
                    route: &swap.route,
                    instruction_index: swap.instruction_index,
                    event_index: swap.event_index,
                    slot: swap.slot,
                    signature: &swap.signature,
                    received_at: &received,
                    observed_at: &observed,
                    confidence: swap.confidence,
                    stale: false,
                    commitment: &commitment_name,
                    decode_version: swap.decode_version,
                    compute_units: swap.compute_units,
                };
                bus.publish(TRADE_STREAM, &trade).await?;
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = Args::parse();
    if args.endpoints.is_empty() {
        if let Some(endpoint) = args.helius_endpoint.clone() {
            args.endpoints.push(endpoint);
            if args.source.is_empty() {
                args.source = "helius_laserstream".to_string();
            }
            if args.x_token.is_none() {
                args.x_token = args.helius_key.clone();
            }
        }
    }
    if args.endpoints.is_empty() {
        return Err(anyhow!(
            "set YELLOWSTONE_ENDPOINTS or HELIUS_LASERSTREAM_ENDPOINT"
        ));
    }
    if args.source.trim().is_empty() {
        return Err(anyhow!(
            "set MARKET_SOURCE when using explicit Yellowstone endpoints"
        ));
    }
    for endpoint in &args.endpoints {
        validate_endpoint(endpoint, args.node_env == "production")?;
    }
    let tls = database_tls(&args.node_env, &args.db_ssl_mode)?;

    let mut reconnects = 0_u64;
    let mut delay_ms = 250_u64;
    loop {
        let index = reconnects as usize % args.endpoints.len();
        let endpoint = args.endpoints[index].clone();
        match run_endpoint(&args, &endpoint, reconnects, tls).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                reconnects += 1;
                eprintln!(
                    "market indexer disconnected endpoint={endpoint} attempt={reconnects} error={error:#}"
                );
                sleep(Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(args.reconnect_max_ms);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_identity_is_order_independent() {
        let first = vec!["program-b".to_string(), "program-a".to_string()];
        let second = vec!["program-a".to_string(), "program-b".to_string()];
        assert_eq!(
            subscription_id(Network::MainnetBeta, "confirmed", &first),
            subscription_id(Network::MainnetBeta, "confirmed", &second)
        );
        assert_ne!(
            subscription_id(Network::MainnetBeta, "confirmed", &first),
            subscription_id(Network::MainnetBeta, "finalized", &first)
        );
        assert_ne!(
            subscription_id(Network::MainnetBeta, "confirmed", &first),
            subscription_id(Network::Devnet, "confirmed", &first)
        );
        assert_ne!(
            event_key(Network::MainnetBeta, "signature", 0, 0),
            event_key(Network::Devnet, "signature", 0, 0)
        );
    }

    #[test]
    fn decoded_trade_matches_the_shared_backend_contract() {
        let signature = "BUguQsv2ZuHus54HAFzjdJHzZBkygAjKhEeYwSG19tUfUyvvz3worsdQCdAXDNjakJHioSiyxhFiDJrm8XpSXRA";
        let source_id = format!("helius_laserstream:mainnet-beta:42:{signature}:0:0");
        let route = [Venue::PumpFun];
        let trade = TradeEvent {
            source: "helius_laserstream",
            source_event_id: &source_id,
            kind: "trade",
            idempotency_key: event_key(Network::MainnetBeta, signature, 0, 0),
            token_mint: "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf",
            quote_mint: "So11111111111111111111111111111111111111112",
            pool_address: Some("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8"),
            protocol: Venue::PumpFun,
            program_id: Venue::PumpFun.program_id(),
            maker: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
            side: Side::Buy,
            token_amount: 2.0,
            quote_amount: 4.0,
            token_amount_raw: "2000000",
            quote_amount_raw: "4000000000",
            token_decimals: 6,
            quote_decimals: 9,
            price_quote: 2.0,
            sol_amount: Some(4.0),
            usd_amount: None,
            price_sol: Some(2.0),
            price_usd: None,
            quote_kind: QuoteKind::Wsol,
            route: &route,
            instruction_index: 0,
            event_index: 0,
            slot: 42,
            signature,
            received_at: "2024-11-19T00:00:00Z",
            observed_at: "2024-11-19T00:00:00Z",
            confidence: 0.94,
            stale: false,
            commitment: "confirmed",
            decode_version: "balance-delta-v1",
            compute_units: Some(88_000),
        };
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/contracts/decoded-trade-v1.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(trade).unwrap(), expected);
    }

    #[test]
    fn production_requires_verified_database_tls() {
        assert_eq!(
            database_tls("production", "verify-full").unwrap(),
            DbTls::VerifyFull
        );
        assert!(database_tls("production", "disable").is_err());
        assert_eq!(database_tls("test", "disable").unwrap(), DbTls::Disable);
        assert!(validate_endpoint("https://geyser.example", true).is_ok());
        assert!(validate_endpoint("http://127.0.0.1:10000", false).is_ok());
        assert!(validate_endpoint("http://geyser.example", true).is_err());
        assert!(validate_endpoint("https://token@geyser.example", false).is_err());
    }

    #[test]
    fn resume_replays_a_bounded_overlap() {
        assert_eq!(resume_from(0), 0);
        assert_eq!(resume_from(1), 0);
        assert_eq!(resume_from(2), 0);
        assert_eq!(resume_from(42), 40);
    }
}
