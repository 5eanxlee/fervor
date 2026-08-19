use crate::{
    fervor_tx::{Commitment, FervorTx, Quarantine, QuarantineReason},
    market_decoder::{owner_delta, single_pool_swap, Venue, USDC_MINT, USDT_MINT, WSOL_MINT},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

pub const FX_CONTRACT: &str = "fervor-fx-observation-v1";
pub const FX_POLICY: &str = "fervor-sol-usd-v1";
pub const FX_TAPE_CONTRACT: &str = "fervor-fx-tape-v1";
pub const FX_BUCKET_MS: i64 = 30_000;
pub const FX_MAX_AGE_MS: i64 = 90_000;

const BPS: u128 = 10_000;
const MAX_OBSERVATION_BPS: u128 = 500;
const MAX_POOL_BPS: u128 = 200;
const MIN_STABLE_RAW: u128 = 100_000_000;

#[derive(Clone, Copy)]
pub struct FxPool {
    pub address: &'static str,
    pub venue: Venue,
    pub stable_mint: &'static str,
}

pub const FX_POOLS: &[FxPool] = &[
    FxPool {
        address: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
        venue: Venue::RaydiumAmmV4,
        stable_mint: USDC_MINT,
    },
    FxPool {
        address: "7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX",
        venue: Venue::RaydiumAmmV4,
        stable_mint: USDT_MINT,
    },
    FxPool {
        address: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
        venue: Venue::RaydiumClmm,
        stable_mint: USDC_MINT,
    },
    FxPool {
        address: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF",
        venue: Venue::RaydiumClmm,
        stable_mint: USDT_MINT,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FxQuality {
    CrossPool,
    SinglePool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolVwap {
    pub pool_address: &'static str,
    pub protocol: Venue,
    pub stable_mint: &'static str,
    pub sol_raw: String,
    pub stable_raw: String,
    pub price_micro_usd: String,
    pub observation_count: usize,
    pub first_observed_at: String,
    pub last_observed_at: String,
    pub source_event_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPoint {
    pub contract: &'static str,
    pub policy: &'static str,
    pub source_event_id: String,
    pub bucket_start: String,
    pub bucket_ms: i64,
    pub observed_at: String,
    pub valid_until: String,
    pub max_age_ms: i64,
    pub price_micro_usd: String,
    pub pool_spread_bps: u128,
    pub quality: FxQuality,
    pub estimated: bool,
    pub confidence: f64,
    pub input_count: usize,
    pub observation_count: usize,
    pub pool_count: usize,
    pub pools: Vec<PoolVwap>,
    pub commitment: Commitment,
}

const SOL_DECIMALS: u32 = 9;
const STABLE_DECIMALS: u32 = 6;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxObservation {
    pub contract: &'static str,
    pub policy: &'static str,
    pub source: String,
    pub source_event_id: String,
    pub pool_address: &'static str,
    pub protocol: Venue,
    pub program_id: &'static str,
    pub trader: String,
    pub stable_mint: &'static str,
    pub sol_raw: String,
    pub stable_raw: String,
    pub sol_decimals: u32,
    pub stable_decimals: u32,
    pub slot: u64,
    pub signature: String,
    pub instruction_index: u32,
    pub observed_at: String,
    pub confidence: f64,
    pub stale: bool,
    pub commitment: Commitment,
}

struct TimedObservation<'a> {
    value: &'a FxObservation,
    observed_ms: i64,
    sol_raw: u128,
    stable_raw: u128,
    price_micro_usd: u128,
}

struct BuiltPool {
    value: PoolVwap,
    price_micro_usd: u128,
    last_ms: i64,
    confidence: f64,
}

pub fn build_fx_tape(observations: &[FxObservation]) -> Result<Vec<FxPoint>, String> {
    let mut seen = HashSet::new();
    let mut buckets = BTreeMap::<i64, Vec<TimedObservation<'_>>>::new();
    for value in observations {
        validate_observation(value)?;
        if !seen.insert(value.source_event_id.as_str()) {
            return Err(format!(
                "duplicate FX source event {}",
                value.source_event_id
            ));
        }
        let observed_ms = DateTime::parse_from_rfc3339(&value.observed_at)
            .map_err(|_| format!("invalid FX observation time {}", value.observed_at))?
            .timestamp_millis();
        let sol_raw = value
            .sol_raw
            .parse::<u128>()
            .map_err(|_| "invalid FX SOL amount".to_string())?;
        let stable_raw = value
            .stable_raw
            .parse::<u128>()
            .map_err(|_| "invalid FX stable amount".to_string())?;
        let price_micro_usd = micro_usd(stable_raw, sol_raw)?;
        let bucket = observed_ms.div_euclid(FX_BUCKET_MS) * FX_BUCKET_MS;
        buckets.entry(bucket).or_default().push(TimedObservation {
            value,
            observed_ms,
            sol_raw,
            stable_raw,
            price_micro_usd,
        });
    }

    let mut tape = Vec::new();
    for (bucket, mut input) in buckets {
        input.sort_unstable_by(|left, right| {
            left.observed_ms
                .cmp(&right.observed_ms)
                .then_with(|| left.value.source_event_id.cmp(&right.value.source_event_id))
        });
        let input_count = input.len();
        let mut groups = BTreeMap::<&str, Vec<&TimedObservation<'_>>>::new();
        for item in &input {
            groups
                .entry(item.value.pool_address)
                .or_default()
                .push(item);
        }
        let mut pools = Vec::new();
        for items in groups.values() {
            let center = median(items.iter().map(|item| item.price_micro_usd).collect())?;
            let accepted = items
                .iter()
                .copied()
                .filter(|item| within_bps(item.price_micro_usd, center, MAX_OBSERVATION_BPS))
                .collect::<Vec<_>>();
            let Some(first) = accepted.first() else {
                continue;
            };
            let Some(last) = accepted.last() else {
                continue;
            };
            let sol_raw = checked_sum(accepted.iter().map(|item| item.sol_raw))?;
            let stable_raw = checked_sum(accepted.iter().map(|item| item.stable_raw))?;
            if stable_raw < MIN_STABLE_RAW {
                continue;
            }
            let price_micro_usd = micro_usd(stable_raw, sol_raw)?;
            pools.push(BuiltPool {
                value: PoolVwap {
                    pool_address: first.value.pool_address,
                    protocol: first.value.protocol,
                    stable_mint: first.value.stable_mint,
                    sol_raw: sol_raw.to_string(),
                    stable_raw: stable_raw.to_string(),
                    price_micro_usd: price_micro_usd.to_string(),
                    observation_count: accepted.len(),
                    first_observed_at: timestamp(first.observed_ms)?,
                    last_observed_at: timestamp(last.observed_ms)?,
                    source_event_ids: accepted
                        .iter()
                        .map(|item| item.value.source_event_id.clone())
                        .collect(),
                },
                price_micro_usd,
                last_ms: last.observed_ms,
                confidence: accepted
                    .iter()
                    .map(|item| item.value.confidence)
                    .fold(1.0_f64, f64::min),
            });
        }
        if pools.is_empty() {
            continue;
        }
        let prices = pools
            .iter()
            .map(|pool| pool.price_micro_usd)
            .collect::<Vec<_>>();
        let price_micro_usd = median(prices.clone())?;
        let min_price = prices.iter().copied().min().unwrap_or(price_micro_usd);
        let max_price = prices.iter().copied().max().unwrap_or(price_micro_usd);
        let pool_spread_bps = max_price
            .abs_diff(min_price)
            .checked_mul(BPS)
            .ok_or_else(|| "FX pool spread overflow".to_string())?
            / price_micro_usd;
        if pools.len() > 1 && pool_spread_bps > MAX_POOL_BPS {
            continue;
        }
        let last_ms = pools
            .iter()
            .map(|pool| pool.last_ms)
            .max()
            .unwrap_or(bucket);
        let quality = if pools.len() > 1 {
            FxQuality::CrossPool
        } else {
            FxQuality::SinglePool
        };
        let confidence = pools
            .iter()
            .map(|pool| pool.confidence)
            .fold(1.0_f64, f64::min)
            .min(if quality == FxQuality::CrossPool {
                0.99
            } else {
                0.90
            });
        let observation_count = pools.iter().map(|pool| pool.value.observation_count).sum();
        let valid_until = last_ms
            .checked_add(FX_MAX_AGE_MS)
            .ok_or_else(|| "FX validity overflow".to_string())?;
        tape.push(FxPoint {
            contract: FX_TAPE_CONTRACT,
            policy: FX_POLICY,
            source_event_id: format!("{FX_POLICY}:{bucket}"),
            bucket_start: timestamp(bucket)?,
            bucket_ms: FX_BUCKET_MS,
            observed_at: timestamp(last_ms)?,
            valid_until: timestamp(valid_until)?,
            max_age_ms: FX_MAX_AGE_MS,
            price_micro_usd: price_micro_usd.to_string(),
            pool_spread_bps,
            quality,
            estimated: true,
            confidence,
            input_count,
            observation_count,
            pool_count: pools.len(),
            pools: pools.into_iter().map(|pool| pool.value).collect(),
            commitment: Commitment::Finalized,
        });
    }
    Ok(tape)
}

fn validate_observation(value: &FxObservation) -> Result<(), String> {
    let approved = FX_POOLS.iter().any(|pool| {
        pool.address == value.pool_address
            && pool.venue == value.protocol
            && pool.stable_mint == value.stable_mint
    });
    if value.contract != FX_CONTRACT
        || value.policy != FX_POLICY
        || !approved
        || value.program_id != value.protocol.program_id()
        || value.sol_decimals != SOL_DECIMALS
        || value.stable_decimals != STABLE_DECIMALS
        || value.stale
        || value.commitment != Commitment::Finalized
        || !value.confidence.is_finite()
        || !(0.0..=1.0).contains(&value.confidence)
    {
        return Err(format!(
            "FX observation {} violates the tape contract",
            value.source_event_id
        ));
    }
    Ok(())
}

fn micro_usd(stable_raw: u128, sol_raw: u128) -> Result<u128, String> {
    if stable_raw == 0 || sol_raw == 0 {
        return Err("FX observation has a zero amount".to_string());
    }
    let price = stable_raw
        .checked_mul(1_000_000_000)
        .ok_or_else(|| "FX price overflow".to_string())
        .map(|scaled| scaled / sol_raw)?;
    if price == 0 {
        return Err("FX price is below one micro-dollar".to_string());
    }
    Ok(price)
}

fn median(mut values: Vec<u128>) -> Result<u128, String> {
    if values.is_empty() {
        return Err("FX median has no values".to_string());
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Ok(values[middle])
    } else {
        values[middle - 1]
            .checked_add(values[middle])
            .ok_or_else(|| "FX median overflow".to_string())
            .map(|sum| sum / 2)
    }
}

fn within_bps(value: u128, center: u128, max_bps: u128) -> bool {
    value
        .abs_diff(center)
        .checked_mul(BPS)
        .zip(center.checked_mul(max_bps))
        .is_some_and(|(difference, limit)| difference <= limit)
}

fn checked_sum(mut values: impl Iterator<Item = u128>) -> Result<u128, String> {
    values.try_fold(0_u128, |total, value| {
        total
            .checked_add(value)
            .ok_or_else(|| "FX aggregate overflow".to_string())
    })
}

fn timestamp(value: i64) -> Result<String, String> {
    DateTime::<Utc>::from_timestamp_millis(value)
        .ok_or_else(|| "FX timestamp is out of range".to_string())
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn decode_fx(tx: &FervorTx) -> Result<Option<FxObservation>, Quarantine> {
    if let Err(error) = tx.validate() {
        return Err(Quarantine::from_tx(
            tx,
            if tx.version == crate::fervor_tx::FERVOR_TX_VERSION {
                QuarantineReason::InvalidIdentity
            } else {
                QuarantineReason::UnsupportedContract
            },
            error.to_string(),
        ));
    }
    Ok(decode_v1(tx))
}

fn decode_v1(tx: &FervorTx) -> Option<FxObservation> {
    if tx.error.is_some() {
        return None;
    }
    let trader = tx.static_keys.first()?;
    let (pool, instruction_index) = FX_POOLS.iter().find_map(|pool| {
        single_pool_swap(tx, pool.venue, pool.address).map(|index| (pool, index))
    })?;
    let (stable_delta, stable_decimals) = owner_delta(tx, trader, pool.stable_mint)?;
    if stable_decimals != STABLE_DECIMALS {
        return None;
    }
    let (sol_delta, sol_decimals) = owner_delta(tx, trader, WSOL_MINT)?;
    if sol_decimals != SOL_DECIMALS || sol_delta.signum() == stable_delta.signum() {
        return None;
    }
    let sol_raw = u64::try_from(sol_delta.unsigned_abs()).ok()?;
    let stable_raw = u64::try_from(stable_delta.unsigned_abs()).ok()?;
    if sol_raw == 0 || stable_raw == 0 {
        return None;
    }
    let source = &tx.observation.provider;
    Some(FxObservation {
        contract: FX_CONTRACT,
        policy: FX_POLICY,
        source: source.clone(),
        source_event_id: format!(
            "{source}:fx:{}:{}:{instruction_index}",
            tx.occurrence.slot, tx.signed_id.signature
        ),
        pool_address: pool.address,
        protocol: pool.venue,
        program_id: pool.venue.program_id(),
        trader: trader.clone(),
        stable_mint: pool.stable_mint,
        sol_raw: sol_raw.to_string(),
        stable_raw: stable_raw.to_string(),
        sol_decimals,
        stable_decimals,
        slot: tx.occurrence.slot,
        signature: tx.signed_id.signature.clone(),
        instruction_index,
        observed_at: tx.observed_at.clone(),
        confidence: 0.99,
        stale: false,
        commitment: tx.commitment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::{FervorTx, TokenBalance, TxIx};
    use sha2::{Digest, Sha256};

    fn balance(index: u32, mint: &str, owner: &str, raw: &str, decimals: u32) -> TokenBalance {
        TokenBalance {
            account_index: index,
            mint: mint.to_string(),
            owner: Some(owner.to_string()),
            program_id: None,
            raw_amount: raw.to_string(),
            decimals,
        }
    }

    fn sample_for(pool: &FxPool) -> FervorTx {
        let mut tx: FervorTx =
            serde_json::from_str(include_str!("../../tests/contracts/fervor-tx-v1.json")).unwrap();
        let trader = tx.static_keys[0].clone();
        tx.static_keys = vec![
            trader.clone(),
            pool.venue.program_id().to_string(),
            WSOL_MINT.to_string(),
            pool.address.to_string(),
            pool.stable_mint.to_string(),
        ];
        let (accounts, data) = match pool.venue {
            Venue::RaydiumAmmV4 => (vec![0, 3, 2, 4], vec![9]),
            Venue::RaydiumClmm => (
                vec![0, 2, 3, 4],
                Sha256::digest("global:swap")[..8].to_vec(),
            ),
            _ => unreachable!("reference pool venue is statically constrained"),
        };
        tx.instructions = vec![TxIx {
            outer_index: 0,
            inner_index: None,
            stack_height: None,
            program_index: 1,
            accounts,
            data,
        }];
        tx.pre_balances = vec![1_000_000_000; tx.static_keys.len()];
        tx.post_balances = tx.pre_balances.clone();
        tx.pre_tokens = vec![
            balance(2, WSOL_MINT, &trader, "2000000000", 9),
            balance(4, pool.stable_mint, &trader, "0", 6),
        ];
        tx.post_tokens = vec![
            balance(2, WSOL_MINT, &trader, "1000000000", 9),
            balance(4, pool.stable_mint, &trader, "240000000", 6),
        ];
        tx
    }

    fn sample() -> FervorTx {
        sample_for(&FX_POOLS[0])
    }

    fn observation(
        pool: usize,
        id: &str,
        observed_at: &str,
        sol_raw: u64,
        stable_raw: u64,
    ) -> FxObservation {
        let mut value = decode_fx(&sample_for(&FX_POOLS[pool])).unwrap().unwrap();
        value.source_event_id = id.to_string();
        value.observed_at = observed_at.to_string();
        value.sol_raw = sol_raw.to_string();
        value.stable_raw = stable_raw.to_string();
        value.commitment = Commitment::Finalized;
        value
    }

    #[test]
    fn emits_exact_raw_reference_evidence() {
        let observation = decode_fx(&sample()).unwrap().unwrap();
        assert_eq!(observation.contract, FX_CONTRACT);
        assert_eq!(observation.policy, FX_POLICY);
        assert_eq!(observation.pool_address, FX_POOLS[0].address);
        assert_eq!(observation.sol_raw, "1000000000");
        assert_eq!(observation.stable_raw, "240000000");
        assert_eq!(observation.instruction_index, 0);
    }

    #[test]
    fn rejects_routes_and_unapproved_pools() {
        let mut routed = sample();
        routed.instructions.push(routed.instructions[0].clone());
        routed.instructions[1].outer_index = 1;
        assert_eq!(decode_fx(&routed), Ok(None));

        let mut unknown = sample();
        unknown.static_keys[3] = bs58::encode([7_u8; 32]).into_string();
        assert_eq!(decode_fx(&unknown), Ok(None));

        let mut native_only = sample();
        native_only
            .pre_tokens
            .retain(|balance| balance.mint != WSOL_MINT);
        native_only
            .post_tokens
            .retain(|balance| balance.mint != WSOL_MINT);
        assert_eq!(decode_fx(&native_only), Ok(None));
    }

    #[test]
    fn allowlist_contains_valid_distinct_pools() {
        let mut seen = std::collections::HashSet::new();
        for pool in FX_POOLS {
            assert_eq!(bs58::decode(pool.address).into_vec().unwrap().len(), 32);
            assert!(seen.insert(pool.address));
            assert!(matches!(pool.stable_mint, USDC_MINT | USDT_MINT));
            let observation = decode_fx(&sample_for(pool)).unwrap().unwrap();
            assert_eq!(observation.pool_address, pool.address);
            assert_eq!(observation.stable_mint, pool.stable_mint);
        }
    }

    #[test]
    fn tape_uses_pool_vwap_and_cross_pool_median() {
        let tape = build_fx_tape(&[
            observation(
                0,
                "fx-a",
                "2024-11-20T03:50:41Z",
                1_000_000_000,
                200_000_000,
            ),
            observation(
                0,
                "fx-b",
                "2024-11-20T03:50:42Z",
                1_000_000_000,
                204_000_000,
            ),
            observation(
                2,
                "fx-c",
                "2024-11-20T03:50:44Z",
                2_000_000_000,
                406_000_000,
            ),
            observation(
                0,
                "fx-outlier",
                "2024-11-20T03:50:45Z",
                1_000_000_000,
                1_000_000_000,
            ),
        ])
        .unwrap();

        assert_eq!(tape.len(), 1);
        let point = &tape[0];
        assert_eq!(point.price_micro_usd, "202500000");
        assert_eq!(point.quality, FxQuality::CrossPool);
        assert_eq!(point.input_count, 4);
        assert_eq!(point.observation_count, 3);
        assert_eq!(point.pool_count, 2);
        assert_eq!(point.pool_spread_bps, 49);
        assert_eq!(point.bucket_start, "2024-11-20T03:50:30.000Z");
        assert_eq!(point.valid_until, "2024-11-20T03:52:14.000Z");
        assert_eq!(
            point
                .pools
                .iter()
                .map(|pool| pool.price_micro_usd.as_str())
                .collect::<Vec<_>>(),
            vec!["203000000", "202000000"]
        );
    }

    #[test]
    fn tape_fails_closed_on_identity_and_pool_divergence() {
        let duplicate = observation(
            0,
            "fx-duplicate",
            "2024-11-20T03:50:41Z",
            1_000_000_000,
            200_000_000,
        );
        assert!(build_fx_tape(&[duplicate.clone(), duplicate]).is_err());

        let diverged = build_fx_tape(&[
            observation(
                0,
                "fx-a",
                "2024-11-20T03:50:41Z",
                1_000_000_000,
                200_000_000,
            ),
            observation(
                2,
                "fx-b",
                "2024-11-20T03:50:42Z",
                1_000_000_000,
                208_000_000,
            ),
        ])
        .unwrap();
        assert!(diverged.is_empty());
    }
}
