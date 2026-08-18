use anyhow::{Context, Result};
use redis::aio::MultiplexedConnection;
use redis::streams::{StreamAutoClaimReply, StreamId, StreamReadReply};
use serde::Serialize;

pub const INDEX_STREAM: &str = "alerts.index_updates";
pub const CANDIDATE_STREAM: &str = "alerts.candidates";
pub const DEAD_LETTER_STREAM: &str = "pipeline.dead_letters";
pub const RAW_SOURCE: &str = "market.raw_journal";
pub const TRADE_STREAM: &str = "market.trades.decoded";

pub fn tick_stream(shard_id: u32, shard_count: u32) -> String {
    if shard_count == 1 {
        "ticks.normalized".to_string()
    } else {
        format!("ticks.normalized.{shard_id}")
    }
}

pub struct StreamBus {
    conn: MultiplexedConnection,
}

impl StreamBus {
    pub async fn connect(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { conn })
    }

    pub async fn ensure_group(&mut self, stream: &str, group: &str) -> Result<()> {
        let result: redis::RedisResult<String> = redis::cmd("XGROUP")
            .arg("CREATE")
            .arg(stream)
            .arg(group)
            .arg("0")
            .arg("MKSTREAM")
            .query_async(&mut self.conn)
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error) if error.to_string().contains("BUSYGROUP") => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn read_group(
        &mut self,
        stream: &str,
        group: &str,
        consumer: &str,
        batch: usize,
        block_ms: usize,
    ) -> Result<Vec<StreamId>> {
        let reply: Option<StreamReadReply> = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(group)
            .arg(consumer)
            .arg("COUNT")
            .arg(batch)
            .arg("BLOCK")
            .arg(block_ms)
            .arg("STREAMS")
            .arg(stream)
            .arg(">")
            .query_async(&mut self.conn)
            .await?;
        Ok(reply
            .into_iter()
            .flat_map(|reply| reply.keys)
            .flat_map(|key| key.ids)
            .collect())
    }

    pub async fn read(
        &mut self,
        stream: &str,
        last_id: &str,
        batch: usize,
        block_ms: usize,
    ) -> Result<Vec<StreamId>> {
        let reply: Option<StreamReadReply> = redis::cmd("XREAD")
            .arg("COUNT")
            .arg(batch)
            .arg("BLOCK")
            .arg(block_ms)
            .arg("STREAMS")
            .arg(stream)
            .arg(last_id)
            .query_async(&mut self.conn)
            .await?;
        Ok(reply
            .into_iter()
            .flat_map(|reply| reply.keys)
            .flat_map(|key| key.ids)
            .collect())
    }

    pub async fn reclaim(
        &mut self,
        stream: &str,
        group: &str,
        consumer: &str,
        stale_ms: usize,
        batch: usize,
    ) -> Result<Vec<StreamId>> {
        let reply: StreamAutoClaimReply = redis::cmd("XAUTOCLAIM")
            .arg(stream)
            .arg(group)
            .arg(consumer)
            .arg(stale_ms)
            .arg("0-0")
            .arg("COUNT")
            .arg(batch)
            .query_async(&mut self.conn)
            .await?;
        Ok(reply.claimed)
    }

    pub async fn ack(&mut self, stream: &str, group: &str, id: &str) -> Result<()> {
        let _: usize = redis::cmd("XACK")
            .arg(stream)
            .arg(group)
            .arg(id)
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }

    pub async fn publish<T: Serialize>(&mut self, stream: &str, value: &T) -> Result<String> {
        let payload = serde_json::to_string(value)?;
        redis::cmd("XADD")
            .arg(stream)
            .arg("MAXLEN")
            .arg("~")
            .arg(500_000)
            .arg("*")
            .arg("payload")
            .arg(payload)
            .query_async(&mut self.conn)
            .await
            .context("failed to publish Redis stream event")
    }

    pub async fn dead_letter(
        &mut self,
        worker: &str,
        source_stream: &str,
        source_id: &str,
        payload: &str,
        error: &str,
    ) -> Result<()> {
        let value = serde_json::json!({
            "sourceStream": source_stream,
            "sourceId": source_id,
            "payload": payload,
            "error": error,
            "failedAt": chrono::Utc::now().to_rfc3339(),
            "worker": worker
        });
        self.publish(DEAD_LETTER_STREAM, &value).await?;
        Ok(())
    }

    pub async fn heartbeat<T: Serialize>(&mut self, key: &str, value: &T) -> Result<()> {
        let payload = serde_json::to_string(value)?;
        let _: String = redis::cmd("SET")
            .arg(key)
            .arg(payload)
            .arg("EX")
            .arg(15)
            .query_async(&mut self.conn)
            .await?;
        Ok(())
    }
}

pub fn payload(entry: &StreamId) -> Result<String> {
    entry
        .get::<String>("payload")
        .context("stream entry has no payload field")
}

#[cfg(test)]
mod tests {
    use super::tick_stream;

    #[test]
    fn partitions_tick_streams_only_when_sharded() {
        assert_eq!(tick_stream(0, 1), "ticks.normalized");
        assert_eq!(tick_stream(3, 8), "ticks.normalized.3");
    }
}
