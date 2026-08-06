use crate::contracts::{Alert, AlertCandidate, FeedTick, MetricQuality};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const WINDOWS: &[&str] = &["1m", "5m", "1h", "6h", "24h"];

fn partition_index<T>(values: &[T], mut matches: impl FnMut(&T) -> bool) -> usize {
    let mut low = 0;
    let mut high = values.len();
    while low < high {
        let middle = low + (high - low) / 2;
        if matches(&values[middle]) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[derive(Debug, Default)]
struct Thresholds {
    above: Vec<Alert>,
    below: Vec<Alert>,
}

#[derive(Debug, Default)]
struct TokenIndex {
    metrics: HashMap<String, Thresholds>,
}

impl TokenIndex {
    fn build(alerts: Vec<Alert>) -> Self {
        let mut index = Self::default();
        for alert in alerts {
            if !alert.threshold_value.is_finite() {
                continue;
            }
            let thresholds = index
                .metrics
                .entry(alert.threshold_type.clone())
                .or_default();
            match alert.condition.as_str() {
                "above" => thresholds.above.push(alert),
                "below" => thresholds.below.push(alert),
                _ => {}
            }
        }
        for thresholds in index.metrics.values_mut() {
            thresholds
                .above
                .sort_by(|left, right| left.threshold_value.total_cmp(&right.threshold_value));
            thresholds
                .below
                .sort_by(|left, right| right.threshold_value.total_cmp(&left.threshold_value));
        }
        index
    }

    fn candidates(&self, tick: &FeedTick, engine_version: &str) -> Vec<AlertCandidate> {
        let mut candidates = Vec::new();
        for (kind, thresholds) in &self.metrics {
            let Some(value) = value_for_threshold(kind, tick) else {
                continue;
            };
            let Some(quality) = quality_for_threshold(kind, tick) else {
                continue;
            };
            if !eligible(value, quality) {
                continue;
            }
            let above = partition_index(&thresholds.above, |alert| alert.threshold_value <= value);
            let below = partition_index(&thresholds.below, |alert| alert.threshold_value >= value);
            candidates.extend(
                thresholds.above[..above]
                    .iter()
                    .chain(thresholds.below[..below].iter())
                    .map(|alert| candidate(alert, tick, value, quality, engine_version)),
            );
        }
        candidates
    }

    fn len(&self) -> usize {
        self.metrics
            .values()
            .map(|thresholds| thresholds.above.len() + thresholds.below.len())
            .sum::<usize>()
    }
}

#[derive(Debug)]
pub struct AlertIndex {
    tokens: HashMap<String, TokenIndex>,
    shard_id: u32,
    shard_count: u32,
}

impl AlertIndex {
    pub fn new(shard_id: u32, shard_count: u32) -> Self {
        Self {
            tokens: HashMap::new(),
            shard_id,
            shard_count,
        }
    }

    pub fn replace_all(&mut self, alerts: Vec<Alert>) {
        let mut grouped = HashMap::<String, Vec<Alert>>::new();
        for alert in alerts {
            if self.owns_token(&alert.token_address) {
                grouped
                    .entry(alert.token_address.clone())
                    .or_default()
                    .push(alert);
            }
        }
        self.tokens = grouped
            .into_iter()
            .map(|(token, alerts)| (token, TokenIndex::build(alerts)))
            .collect();
    }

    pub fn replace_token(&mut self, token_address: &str, alerts: Vec<Alert>) {
        if !self.owns_token(token_address) || alerts.is_empty() {
            self.tokens.remove(token_address);
            return;
        }
        self.tokens
            .insert(token_address.to_string(), TokenIndex::build(alerts));
    }

    pub fn owns_token(&self, token_address: &str) -> bool {
        shard_for_token(token_address, self.shard_count) == self.shard_id
    }

    pub fn candidates(&self, tick: &FeedTick, engine_version: &str) -> Vec<AlertCandidate> {
        if !self.owns_token(&tick.token_address) {
            return Vec::new();
        }
        self.tokens
            .get(&tick.token_address)
            .map(|index| index.candidates(tick, engine_version))
            .unwrap_or_default()
    }

    pub fn counts(&self) -> (usize, usize) {
        (
            self.tokens.len(),
            self.tokens.values().map(TokenIndex::len).sum(),
        )
    }
}

pub fn shard_for_token(token_address: &str, shard_count: u32) -> u32 {
    let digest = Sha256::digest(token_address.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % shard_count
}

pub fn value_for_threshold(threshold_type: &str, tick: &FeedTick) -> Option<f64> {
    match threshold_type {
        "price" => tick.price,
        "market_cap" => tick.market_cap,
        "liquidity" => tick.liquidity,
        _ => {
            for window in WINDOWS {
                if threshold_type == format!("volume_{window}") {
                    return tick.volume.get(*window).copied();
                }
                if threshold_type == format!("buy_count_{window}") {
                    return tick.buy_count.get(*window).copied();
                }
                if threshold_type == format!("sell_count_{window}") {
                    return tick.sell_count.get(*window).copied();
                }
                if threshold_type == format!("tx_count_{window}") {
                    return tick.tx_count.get(*window).copied();
                }
            }
            None
        }
    }
}

fn quality_for_threshold<'a>(kind: &str, tick: &'a FeedTick) -> Option<&'a MetricQuality> {
    let key = match kind {
        "price" => "price",
        "market_cap" => "market_cap",
        "liquidity" => "liquidity",
        _ => "rolling",
    };
    tick.metric_quality.get(key)
}

fn eligible(value: f64, quality: &MetricQuality) -> bool {
    value.is_finite()
        && quality.confidence.is_finite()
        && (0.0..=1.0).contains(&quality.confidence)
        && !quality.stale
}

fn candidate(
    alert: &Alert,
    tick: &FeedTick,
    current_value: f64,
    quality: &MetricQuality,
    engine_version: &str,
) -> AlertCandidate {
    let source_event_id = tick.source_event_id.as_deref().unwrap_or(&tick.signature);
    AlertCandidate {
        alert_id: alert.id.clone(),
        user_id: alert.user_id.clone(),
        token_address: alert.token_address.clone(),
        threshold_type: alert.threshold_type.clone(),
        threshold_value: alert.threshold_value,
        condition: alert.condition.clone(),
        current_value,
        notification_type: alert.notification_type.clone(),
        signature: tick.signature.clone(),
        slot: tick.slot,
        source_event_id: source_event_id.to_string(),
        observed_at: tick
            .observed_at
            .clone()
            .unwrap_or_else(|| tick.received_at.clone()),
        received_at: tick.received_at.clone(),
        matched_at: chrono::Utc::now().to_rfc3339(),
        idempotency_key: event_key(
            &alert.id,
            alert.generation,
            source_event_id,
            &alert.threshold_type,
        ),
        engine_version: engine_version.to_string(),
        alert_generation: alert.generation,
        basis_commitment: quality.commitment.clone(),
        metric_confidence: quality.confidence,
        metric_estimated: quality.estimated,
        metric_version: tick
            .metric_version
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        metric_revision: tick.metric_revision,
    }
}

pub fn event_key(
    alert_id: &str,
    generation: u64,
    source_event_id: &str,
    threshold_type: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{alert_id}:{generation}:{source_event_id}:{threshold_type}"
    ));
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quality(source: &str) -> MetricQuality {
        MetricQuality {
            source_event_id: source.into(),
            observed_at: "2026-08-03T00:00:00Z".into(),
            confidence: 0.9,
            stale: false,
            estimated: false,
            commitment: Some("confirmed".into()),
        }
    }

    fn tick() -> FeedTick {
        FeedTick {
            token_address: "Token111111111111111111111111111111111111111".into(),
            signature: "sig-1".into(),
            slot: 42,
            block_time: 0,
            price: Some(0.002),
            market_cap: Some(2_000_000.0),
            liquidity: Some(400_000.0),
            volume: HashMap::from([("5m".into(), 75_000.0)]),
            buy_count: HashMap::from([("5m".into(), 300.0)]),
            sell_count: HashMap::new(),
            tx_count: HashMap::new(),
            usd_value: 10.0,
            base_amount: None,
            swap_type: None,
            source_exchange: None,
            received_at: "2026-08-03T00:00:01Z".into(),
            source_event_id: Some("metric:event-1".into()),
            observed_at: Some("2026-08-03T00:00:00Z".into()),
            commitment: Some("confirmed".into()),
            confidence: Some(0.9),
            stale: false,
            metric_version: Some("rolling-v2".into()),
            metric_revision: Some(7),
            metric_quality: HashMap::from([
                ("price".into(), quality("price-1")),
                ("market_cap".into(), quality("supply-1")),
                ("liquidity".into(), quality("liquidity-1")),
                ("rolling".into(), quality("rolling-1")),
            ]),
        }
    }

    fn alert(id: &str, kind: &str, value: f64, condition: &str) -> Alert {
        Alert {
            id: id.into(),
            user_id: "user-1".into(),
            token_address: tick().token_address,
            threshold_type: kind.into(),
            threshold_value: value,
            condition: condition.into(),
            notification_type: "discord".into(),
            generation: 3,
        }
    }

    #[test]
    fn reads_every_supported_metric_family() {
        let tick = tick();
        assert_eq!(value_for_threshold("price", &tick), Some(0.002));
        assert_eq!(value_for_threshold("market_cap", &tick), Some(2_000_000.0));
        assert_eq!(value_for_threshold("liquidity", &tick), Some(400_000.0));
        assert_eq!(value_for_threshold("volume_5m", &tick), Some(75_000.0));
        assert_eq!(value_for_threshold("buy_count_5m", &tick), Some(300.0));
        assert_eq!(value_for_threshold("sell_count_1h", &tick), None);
    }

    #[test]
    fn matches_sorted_thresholds_and_carries_metric_basis() {
        let tick = tick();
        let mut index = AlertIndex::new(0, 1);
        index.replace_all(vec![
            alert("above-hit", "volume_5m", 50_000.0, "above"),
            alert("above-miss", "volume_5m", 80_000.0, "above"),
            alert("below-hit", "volume_5m", 90_000.0, "below"),
            alert("below-miss", "volume_5m", 70_000.0, "below"),
        ]);
        let mut candidates = index.candidates(&tick, "test");
        candidates.sort_by(|left, right| left.alert_id.cmp(&right.alert_id));
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.alert_id.as_str())
                .collect::<Vec<_>>(),
            vec!["above-hit", "below-hit"]
        );
        assert_eq!(candidates[0].source_event_id, "metric:event-1");
        assert_eq!(candidates[0].alert_generation, 3);
        assert_eq!(candidates[0].basis_commitment.as_deref(), Some("confirmed"));
    }

    #[test]
    fn stale_or_unproven_metrics_fail_closed() {
        let mut index = AlertIndex::new(0, 1);
        index.replace_all(vec![alert("alert-1", "price", 0.001, "above")]);
        let mut stale = tick();
        stale.metric_quality.get_mut("price").unwrap().stale = true;
        assert!(index.candidates(&stale, "test").is_empty());
        let mut missing = tick();
        missing.metric_quality.clear();
        assert!(index.candidates(&missing, "test").is_empty());
    }

    #[test]
    fn refresh_replaces_a_triggered_generation() {
        let tick = tick();
        let mut index = AlertIndex::new(0, 1);
        index.replace_all(vec![alert("alert-1", "price", 0.001, "above")]);
        assert_eq!(index.candidates(&tick, "test").len(), 1);
        index.replace_token(&tick.token_address, Vec::new());
        assert!(index.candidates(&tick, "test").is_empty());
        index.replace_token(
            &tick.token_address,
            vec![alert("alert-1", "price", 0.001, "above")],
        );
        assert_eq!(index.candidates(&tick, "test").len(), 1);
    }

    #[test]
    fn generation_changes_event_identity() {
        assert_ne!(
            event_key("alert-1", 1, "metric-1", "price"),
            event_key("alert-1", 2, "metric-1", "price")
        );
    }

    #[test]
    fn threshold_boundary_search_is_logarithmic() {
        use std::cell::Cell;

        let values = (0..100_000).collect::<Vec<_>>();
        let comparisons = Cell::new(0);
        let boundary = partition_index(&values, |value| {
            comparisons.set(comparisons.get() + 1);
            *value < 50_000
        });
        assert_eq!(boundary, 50_000);
        assert!(
            comparisons.get() <= 17,
            "used {} comparisons",
            comparisons.get()
        );
    }

    #[test]
    fn shard_hash_is_stable() {
        let token = "Token111111111111111111111111111111111111111";
        assert_eq!(shard_for_token(token, 1), 0);
        assert_eq!(shard_for_token(token, 16), shard_for_token(token, 16));
    }
}
