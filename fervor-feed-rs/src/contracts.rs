use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedTick {
    pub token_address: String,
    pub signature: String,
    pub slot: u64,
    #[serde(default)]
    pub block_time: u64,
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub liquidity: Option<f64>,
    #[serde(default)]
    pub volume: HashMap<String, f64>,
    #[serde(default)]
    pub buy_count: HashMap<String, f64>,
    #[serde(default)]
    pub sell_count: HashMap<String, f64>,
    #[serde(default)]
    pub tx_count: HashMap<String, f64>,
    #[serde(default)]
    pub usd_value: f64,
    pub base_amount: Option<String>,
    pub swap_type: Option<String>,
    pub source_exchange: Option<String>,
    pub received_at: String,
    pub source_event_id: Option<String>,
    pub observed_at: Option<String>,
    pub commitment: Option<String>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub stale: bool,
    pub metric_version: Option<String>,
    pub metric_revision: Option<u64>,
    #[serde(default)]
    pub metric_quality: HashMap<String, MetricQuality>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricQuality {
    pub source_event_id: String,
    pub observed_at: String,
    pub confidence: f64,
    pub stale: bool,
    pub estimated: bool,
    pub commitment: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Alert {
    pub id: String,
    pub user_id: String,
    pub token_address: String,
    pub threshold_type: String,
    pub threshold_value: f64,
    pub condition: String,
    pub notification_type: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertIndexUpdate {
    pub token_address: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertCandidate {
    pub alert_id: String,
    pub user_id: String,
    pub token_address: String,
    pub threshold_type: String,
    pub threshold_value: f64,
    pub condition: String,
    pub current_value: f64,
    pub notification_type: String,
    pub signature: String,
    pub slot: u64,
    pub source_event_id: String,
    pub observed_at: String,
    pub received_at: String,
    pub matched_at: String,
    pub idempotency_key: String,
    pub engine_version: String,
    pub alert_generation: u64,
    pub basis_commitment: Option<String>,
    pub metric_confidence: f64,
    pub metric_estimated: bool,
    pub metric_version: String,
    pub metric_revision: Option<u64>,
}
