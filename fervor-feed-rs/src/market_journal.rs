use crate::fervor_tx::RawEnvelope;
use crate::postgres::{connect, DbTls};
use anyhow::{bail, Context, Result};
use tokio_postgres::{Client, Statement};

pub struct MarketJournal {
    client: Client,
    insert: Statement,
    existing: Statement,
    checkpoint: Statement,
    resume: Statement,
}

impl MarketJournal {
    pub async fn connect(url: &str, mode: DbTls, ca: Option<&str>) -> Result<Self> {
        let client = connect(url, mode, ca, "fervor-market-indexer").await?;
        let insert = client
            .prepare(
                "INSERT INTO market_raw_events \
                 (provider, commitment, source_event_id, subscription_id, slot, signature, \
                  filters, wire_format, wire_payload, wire_hash, observed_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::timestamptz) \
                 ON CONFLICT (provider, commitment, source_event_id) DO NOTHING",
            )
            .await?;
        let existing = client
            .prepare(
                "SELECT wire_hash, wire_payload FROM market_raw_events \
                 WHERE provider = $1 AND commitment = $2 AND source_event_id = $3",
            )
            .await?;
        let checkpoint = client
            .prepare(
                "INSERT INTO market_ingest_checkpoints \
                 (provider, subscription_id, commitment, last_slot, last_event_id) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT (provider, subscription_id) DO UPDATE SET \
                   last_slot = GREATEST(market_ingest_checkpoints.last_slot, EXCLUDED.last_slot), \
                   last_event_id = CASE \
                     WHEN EXCLUDED.last_slot > market_ingest_checkpoints.last_slot \
                       THEN EXCLUDED.last_event_id \
                     WHEN EXCLUDED.last_slot = market_ingest_checkpoints.last_slot \
                       THEN GREATEST(market_ingest_checkpoints.last_event_id, EXCLUDED.last_event_id) \
                     ELSE market_ingest_checkpoints.last_event_id END, \
                   updated_at = clock_timestamp() \
                 WHERE market_ingest_checkpoints.commitment = EXCLUDED.commitment",
            )
            .await?;
        let resume = client
            .prepare(
                "SELECT last_slot FROM market_ingest_checkpoints \
                 WHERE provider = $1 AND subscription_id = $2 AND commitment = $3",
            )
            .await?;
        Ok(Self {
            client,
            insert,
            existing,
            checkpoint,
            resume,
        })
    }

    pub async fn resume_slot(
        &self,
        provider: &str,
        subscription_id: &str,
        commitment: &str,
    ) -> Result<Option<u64>> {
        let row = self
            .client
            .query_opt(&self.resume, &[&provider, &subscription_id, &commitment])
            .await?;
        row.map(|row| {
            let slot = row.get::<_, i64>(0);
            u64::try_from(slot).map_err(Into::into)
        })
        .transpose()
    }

    pub async fn accept(&mut self, raw: &RawEnvelope) -> Result<bool> {
        raw.validate().context("raw envelope is invalid")?;
        let slot =
            i64::try_from(raw.slot).context("source slot exceeds the PostgreSQL bigint domain")?;
        let hash = hex::decode(&raw.raw_hash).context("raw envelope hash is invalid")?;
        let commitment = raw.commitment.as_str();
        let tx = self.client.transaction().await?;
        let inserted = tx
            .execute(
                &self.insert,
                &[
                    &raw.provider,
                    &commitment,
                    &raw.source_event_id,
                    &raw.subscription_id,
                    &slot,
                    &raw.signature,
                    &raw.filters,
                    &raw.wire_format,
                    &raw.payload,
                    &hash,
                    &raw.observed_at,
                ],
            )
            .await?
            == 1;

        if !inserted {
            let stored = tx
                .query_one(
                    &self.existing,
                    &[&raw.provider, &commitment, &raw.source_event_id],
                )
                .await?;
            if stored.get::<_, Vec<u8>>(0) != hash || stored.get::<_, Vec<u8>>(1) != raw.payload {
                bail!(
                    "source replay changed bytes for event {}",
                    raw.source_event_id
                );
            }
        }

        let checkpointed = tx
            .execute(
                &self.checkpoint,
                &[
                    &raw.provider,
                    &raw.subscription_id,
                    &commitment,
                    &slot,
                    &raw.source_event_id,
                ],
            )
            .await?;
        if checkpointed != 1 {
            bail!("market checkpoint commitment differs from its subscription identity");
        }
        tx.commit().await?;
        Ok(inserted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::{Commitment, Network};
    use futures_util::future::join_all;
    use sha2::{Digest, Sha256};

    const PROVIDER: &str = "test_source";

    fn test_input(
        source_id: &str,
        subscription_id: &str,
        signature: &str,
        payload: &[u8],
    ) -> RawEnvelope {
        RawEnvelope::new(
            PROVIDER.to_string(),
            "test-wire".to_string(),
            1,
            source_id.to_string(),
            subscription_id.to_string(),
            Network::MainnetBeta,
            Commitment::Confirmed,
            42,
            signature.to_string(),
            Vec::new(),
            "2026-08-05T00:00:00Z".to_string(),
            payload.to_vec(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn concurrent_replay_is_idempotent_and_conflicts_fail_closed() -> Result<()> {
        let Ok(url) = std::env::var("MARKET_DATABASE_URL") else {
            return Ok(());
        };
        let tls: DbTls = std::env::var("DB_SSL_MODE")
            .unwrap_or_else(|_| "disable".to_string())
            .parse()?;
        let ca = std::env::var("DB_SSL_CA").ok();
        let marker = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_string();
        let source_id = format!("test:market-journal:{marker}");
        let subscription_id = hex::encode(Sha256::digest(marker.as_bytes()));
        let signature = bs58::encode([7_u8; 64]).into_string();
        let payload = b"yellowstone-payload".to_vec();

        let attempts = (0..8).map(|_| {
            let url = url.clone();
            let ca = ca.clone();
            let source_id = source_id.clone();
            let subscription_id = subscription_id.clone();
            let signature = signature.clone();
            let payload = payload.clone();
            async move {
                let mut journal = MarketJournal::connect(&url, tls, ca.as_deref()).await?;
                journal
                    .accept(&test_input(
                        &source_id,
                        &subscription_id,
                        &signature,
                        &payload,
                    ))
                    .await
            }
        });
        let outcomes = join_all(attempts)
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(outcomes.into_iter().filter(|inserted| *inserted).count(), 1);

        let mut journal = MarketJournal::connect(&url, tls, ca.as_deref()).await?;
        assert_eq!(
            journal
                .resume_slot(PROVIDER, &subscription_id, "confirmed")
                .await?,
            Some(42)
        );
        let changed = b"changed-payload";
        let conflict = journal
            .accept(&test_input(
                &source_id,
                &subscription_id,
                &signature,
                changed,
            ))
            .await;
        assert!(conflict.is_err());

        let other_source = format!("{source_id}:other");
        let mut wrong_commitment =
            test_input(&other_source, &subscription_id, &signature, &payload);
        wrong_commitment.commitment = Commitment::Finalized;
        assert!(journal.accept(&wrong_commitment).await.is_err());
        let rolled_back: i64 = journal
            .client
            .query_one(
                "SELECT count(*) FROM market_raw_events WHERE provider = $1 AND source_event_id = $2",
                &[&PROVIDER, &other_source],
            )
            .await?
            .get(0);
        assert_eq!(rolled_back, 0);

        let ordered_subscription = hex::encode(Sha256::digest(format!("{marker}:order")));
        let high_source = format!("{source_id}:z");
        let low_source = format!("{source_id}:a");
        assert!(
            journal
                .accept(&test_input(
                    &high_source,
                    &ordered_subscription,
                    &signature,
                    &payload,
                ))
                .await?
        );
        assert!(
            journal
                .accept(&test_input(
                    &low_source,
                    &ordered_subscription,
                    &signature,
                    &payload,
                ))
                .await?
        );
        let checkpoint: String = journal
            .client
            .query_one(
                "SELECT last_event_id FROM market_ingest_checkpoints \
                 WHERE provider = $1 AND subscription_id = $2",
                &[&PROVIDER, &ordered_subscription],
            )
            .await?
            .get(0);
        assert_eq!(checkpoint, high_source);

        let update = journal
            .client
            .execute(
                "UPDATE market_raw_events SET slot = slot + 1 \
                 WHERE provider = $1 AND commitment = 'confirmed' AND source_event_id = $2",
                &[&PROVIDER, &source_id],
            )
            .await;
        assert_eq!(
            update.unwrap_err().code().map(|code| code.code()),
            Some("55000")
        );
        Ok(())
    }
}
