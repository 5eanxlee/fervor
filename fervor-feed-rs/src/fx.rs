use crate::{
    fervor_tx::{Commitment, FervorTx, Quarantine, QuarantineReason},
    market_decoder::{owner_delta, single_pool_swap, Venue, USDC_MINT, USDT_MINT, WSOL_MINT},
};
use serde::Serialize;

pub const FX_CONTRACT: &str = "fervor-fx-observation-v1";
pub const FX_POLICY: &str = "fervor-sol-usd-v1";

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

const SOL_DECIMALS: u32 = 9;
const USDC_DECIMALS: u32 = 6;

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
    if stable_decimals != USDC_DECIMALS {
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
}
