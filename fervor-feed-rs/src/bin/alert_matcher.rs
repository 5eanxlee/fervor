use anyhow::{Context, Result};
use clap::Parser;
use fervor_feed_rs::alert_engine::AlertIndex;
use fervor_feed_rs::alert_store::{AlertStore, DbTls};
use fervor_feed_rs::contracts::{AlertIndexUpdate, FeedTick};
use fervor_feed_rs::stream_bus::{payload, tick_stream, StreamBus, CANDIDATE_STREAM, INDEX_STREAM};
use hdrhistogram::Histogram;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};

#[derive(Parser, Clone, Debug)]
#[command(name = "fervor-alert-matcher")]
struct Args {
    #[arg(long, env = "REDIS_URL", default_value = "redis://localhost:6379")]
    redis_url: String,
    #[arg(long, env = "CORE_DATABASE_URL")]
    core_database_url: String,
    #[arg(long, env = "DB_SSL_MODE", default_value = "disable")]
    db_ssl_mode: String,
    #[arg(long, env = "DB_SSL_CA")]
    db_ssl_ca: Option<String>,
    #[arg(long, env = "NODE_ENV", default_value = "development")]
    node_env: String,
    #[arg(long, env = "MATCHER_SHARD_ID", default_value_t = 0)]
    shard_id: u32,
    #[arg(long, env = "MATCHER_SHARD_COUNT", default_value_t = 1)]
    shard_count: u32,
    #[arg(long, env = "REDIS_STREAM_BATCH_SIZE", default_value_t = 250)]
    batch_size: usize,
    #[arg(long, env = "REDIS_STREAM_BLOCK_MS", default_value_t = 2_000)]
    block_ms: usize,
    #[arg(long, env = "REDIS_STREAM_STALE_MS", default_value_t = 60_000)]
    stale_ms: usize,
    #[arg(long, env = "RUST_MATCHER_RESYNC_SECS", default_value_t = 300)]
    resync_secs: u64,
    #[arg(
        long,
        env = "RUST_MATCHER_VERSION",
        default_value = "rust-alert-matcher-1.0.0"
    )]
    engine_version: String,
    #[arg(long, env = "RUST_MATCHER_CONSUMER")]
    consumer: Option<String>,
}

#[derive(Default)]
struct Stats {
    ticks: AtomicU64,
    candidates: AtomicU64,
    failures: AtomicU64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.shard_count == 0 || args.shard_id >= args.shard_count {
        anyhow::bail!("MATCHER_SHARD_ID must be smaller than MATCHER_SHARD_COUNT");
    }
    let tls = matcher_tls(&args.node_env, &args.db_ssl_mode)?;

    let store = Arc::new(
        AlertStore::connect(&args.core_database_url, tls, args.db_ssl_ca.as_deref()).await?,
    );
    let initial = store.load_shard(args.shard_id, args.shard_count).await?;
    let mut alert_index = AlertIndex::new(args.shard_id, args.shard_count);
    alert_index.replace_all(initial);
    let index = Arc::new(RwLock::new(alert_index));
    let running = Arc::new(AtomicBool::new(true));
    let stats = Arc::new(Stats::default());
    let consumer = args
        .consumer
        .clone()
        .unwrap_or_else(|| format!("rust-{}-{}", args.shard_id, std::process::id()));
    let group = "alert-matchers-v2".to_string();

    let (failure_tx, mut failure_rx) = mpsc::channel(3);
    let tick_task = {
        let failure_tx = failure_tx.clone();
        let args = args.clone();
        let group = group.clone();
        let consumer = consumer.clone();
        let index = Arc::clone(&index);
        let running = Arc::clone(&running);
        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            let result = tick_loop(args, group, consumer, index, running, stats).await;
            if let Err(error) = &result {
                let _ = failure_tx
                    .send(anyhow::anyhow!("tick loop failed: {error:#}"))
                    .await;
            }
            result
        })
    };
    let update_task = {
        let failure_tx = failure_tx.clone();
        let args = args.clone();
        let store = Arc::clone(&store);
        let index = Arc::clone(&index);
        let running = Arc::clone(&running);
        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            let result = update_loop(args, store, index, running, stats).await;
            if let Err(error) = &result {
                let _ = failure_tx
                    .send(anyhow::anyhow!("index loop failed: {error:#}"))
                    .await;
            }
            result
        })
    };
    let heartbeat_task = {
        let failure_tx = failure_tx.clone();
        let args = args.clone();
        let consumer = consumer.clone();
        let index = Arc::clone(&index);
        let running = Arc::clone(&running);
        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            let result = heartbeat_loop(args, consumer, index, running, stats).await;
            if let Err(error) = &result {
                let _ = failure_tx
                    .send(anyhow::anyhow!("heartbeat loop failed: {error:#}"))
                    .await;
            }
            result
        })
    };

    println!(
        "{}",
        json!({
            "level": "info",
            "service": "rust-alert-matcher",
            "message": "matcher started",
            "consumer": consumer,
            "group": group,
            "shardId": args.shard_id,
            "shardCount": args.shard_count,
            "engineVersion": args.engine_version,
        })
    );

    let failure = tokio::select! {
        signal = shutdown_signal() => {
            signal?;
            None
        },
        failure = failure_rx.recv() => failure,
    };
    running.store(false, Ordering::Relaxed);

    for task in [tick_task, update_task, heartbeat_task] {
        match tokio::time::timeout(Duration::from_secs(8), task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => eprintln!("worker stopped with error: {error:#}"),
            Ok(Err(error)) => eprintln!("worker join failed: {error}"),
            Err(_) => eprintln!("worker did not stop within the grace period"),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn matcher_tls(node_env: &str, value: &str) -> Result<DbTls> {
    let tls: DbTls = value.parse()?;
    if node_env == "production" && tls != DbTls::VerifyFull {
        anyhow::bail!("production matcher requires DB_SSL_MODE=verify-full");
    }
    Ok(tls)
}

async fn tick_loop(
    args: Args,
    group: String,
    consumer: String,
    index: Arc<RwLock<AlertIndex>>,
    running: Arc<AtomicBool>,
    stats: Arc<Stats>,
) -> Result<()> {
    let mut bus = StreamBus::connect(&args.redis_url).await?;
    let stream = tick_stream(args.shard_id, args.shard_count);
    bus.ensure_group(&stream, &group).await?;
    let mut reclaim_at = Instant::now();
    let mut histogram = Histogram::<u64>::new(3)?;

    while running.load(Ordering::Relaxed) {
        let entries = if reclaim_at.elapsed() >= Duration::from_millis(args.stale_ms as u64) {
            reclaim_at = Instant::now();
            bus.reclaim(&stream, &group, &consumer, args.stale_ms, args.batch_size)
                .await?
        } else {
            bus.read_group(&stream, &group, &consumer, args.batch_size, args.block_ms)
                .await?
        };

        for entry in entries {
            let raw = match payload(&entry) {
                Ok(raw) => raw,
                Err(error) => {
                    bus.dead_letter(&stream, &entry.id, "", &error.to_string())
                        .await?;
                    bus.ack(&stream, &group, &entry.id).await?;
                    stats.failures.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };
            let tick: FeedTick = match serde_json::from_str(&raw) {
                Ok(tick) => tick,
                Err(error) => {
                    bus.dead_letter(&stream, &entry.id, &raw, &error.to_string())
                        .await?;
                    bus.ack(&stream, &group, &entry.id).await?;
                    stats.failures.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };

            let started = Instant::now();
            let candidates = index.read().await.candidates(&tick, &args.engine_version);
            for candidate in &candidates {
                bus.publish(CANDIDATE_STREAM, candidate).await?;
            }
            histogram.record(started.elapsed().as_micros() as u64)?;
            stats.ticks.fetch_add(1, Ordering::Relaxed);
            stats
                .candidates
                .fetch_add(candidates.len() as u64, Ordering::Relaxed);
            bus.ack(&stream, &group, &entry.id).await?;
        }
    }

    if !histogram.is_empty() {
        println!(
            "{}",
            json!({
                "level": "info",
                "service": "rust-alert-matcher",
                "message": "matcher stopped",
                "latencyMicros": {
                    "p50": histogram.value_at_quantile(0.5),
                    "p95": histogram.value_at_quantile(0.95),
                    "p99": histogram.value_at_quantile(0.99),
                }
            })
        );
    }
    Ok(())
}

async fn update_loop(
    args: Args,
    store: Arc<AlertStore>,
    index: Arc<RwLock<AlertIndex>>,
    running: Arc<AtomicBool>,
    stats: Arc<Stats>,
) -> Result<()> {
    let mut bus = StreamBus::connect(&args.redis_url).await?;
    let mut last_id = "$".to_string();
    let mut last_resync = Instant::now();

    while running.load(Ordering::Relaxed) {
        if last_resync.elapsed() >= Duration::from_secs(args.resync_secs) {
            match store.load_shard(args.shard_id, args.shard_count).await {
                Ok(alerts) => index.write().await.replace_all(alerts),
                Err(error) => {
                    stats.failures.fetch_add(1, Ordering::Relaxed);
                    eprintln!("alert index resync failed: {error:#}");
                }
            }
            last_resync = Instant::now();
        }

        for entry in bus
            .read(INDEX_STREAM, &last_id, args.batch_size, args.block_ms)
            .await?
        {
            last_id = entry.id.clone();
            let raw = payload(&entry)?;
            let update: AlertIndexUpdate = serde_json::from_str(&raw)
                .with_context(|| format!("invalid alert index update {}", entry.id))?;
            if !index.read().await.owns_token(&update.token_address) {
                continue;
            }
            match store.load_token(&update.token_address).await {
                Ok(alerts) => index
                    .write()
                    .await
                    .replace_token(&update.token_address, alerts),
                Err(error) => {
                    stats.failures.fetch_add(1, Ordering::Relaxed);
                    eprintln!("alert token refresh failed: {error:#}");
                }
            }
        }
    }
    Ok(())
}

async fn heartbeat_loop(
    args: Args,
    consumer: String,
    index: Arc<RwLock<AlertIndex>>,
    running: Arc<AtomicBool>,
    stats: Arc<Stats>,
) -> Result<()> {
    let mut bus = StreamBus::connect(&args.redis_url).await?;
    let key = format!("fervor:worker:rust-alert-matcher:{consumer}");
    while running.load(Ordering::Relaxed) {
        let (tokens, alerts) = index.read().await.counts();
        bus.heartbeat(
            &key,
            &json!({
                "consumer": consumer,
                "shardId": args.shard_id,
                "shardCount": args.shard_count,
                "tokens": tokens,
                "alerts": alerts,
                "ticks": stats.ticks.load(Ordering::Relaxed),
                "candidates": stats.candidates.load(Ordering::Relaxed),
                "failures": stats.failures.load(Ordering::Relaxed),
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .await?;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    Ok(())
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_matcher_fails_closed_without_verified_tls() {
        assert_eq!(
            matcher_tls("production", "verify-full").unwrap(),
            DbTls::VerifyFull
        );
        assert!(matcher_tls("production", "disable").is_err());
        assert!(matcher_tls("production", "require").is_err());
        assert_eq!(
            matcher_tls("development", "disable").unwrap(),
            DbTls::Disable
        );
    }
}
