use crate::contracts::Alert;
use crate::postgres::connect;
pub use crate::postgres::DbTls;
use anyhow::Result;
use tokio_postgres::{Client, Row};

pub struct AlertStore {
    client: Client,
}

impl AlertStore {
    pub async fn connect(database_url: &str, mode: DbTls, ca: Option<&str>) -> Result<Self> {
        let client = connect(database_url, mode, ca, "fervor-alert-matcher").await?;
        Ok(Self { client })
    }

    pub async fn load_shard(&self, shard_id: u32, shard_count: u32) -> Result<Vec<Alert>> {
        let rows = self
            .client
            .query(
                "SELECT a.id::text, a.user_id::text, a.token_address, a.threshold_type, \
                        a.threshold_value::float8, a.condition, a.notification_type, a.generation \
                 FROM token_alerts a \
                 INNER JOIN monitored_tokens m ON m.token_address = a.token_address \
                 WHERE a.is_active = true AND a.is_triggered = false \
                   AND m.shard_id = $1 AND m.shard_count = $2",
                &[&(shard_id as i32), &(shard_count as i32)],
            )
            .await?;
        Ok(rows.iter().map(alert_from_row).collect())
    }

    pub async fn load_token(&self, token_address: &str) -> Result<Vec<Alert>> {
        let rows = self
            .client
            .query(
                "SELECT id::text, user_id::text, token_address, threshold_type, \
                        threshold_value::float8, condition, notification_type, generation \
                 FROM token_alerts \
                 WHERE token_address = $1 AND is_active = true AND is_triggered = false",
                &[&token_address],
            )
            .await?;
        Ok(rows.iter().map(alert_from_row).collect())
    }
}

fn alert_from_row(row: &Row) -> Alert {
    Alert {
        id: row.get(0),
        user_id: row.get(1),
        token_address: row.get(2),
        threshold_type: row.get(3),
        threshold_value: row.get(4),
        condition: row.get(5),
        notification_type: row.get(6),
        generation: row.get::<_, i64>(7) as u64,
    }
}
