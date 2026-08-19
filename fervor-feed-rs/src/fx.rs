use crate::{
    fervor_tx::{Commitment, FervorTx, Quarantine, QuarantineReason},
    market_decoder::{economic_sol_delta, owner_delta, single_pool_swap, Venue, USDC_MINT},
};
use serde::Serialize;

pub const FX_CONTRACT: &str = "fervor-fx-observation-v1";
pub const FX_POLICY: &str = "raydium-sol-usdc-v1";
pub const SOL_USDC_POOL: &str = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

const SOL_DECIMALS: u32 = 9;
const USDC_DECIMALS: u32 = 6;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SolSource {
    WsolBalance,
    NativeBalance,
}

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
    pub sol_source: SolSource,
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
    let instruction_index = single_pool_swap(tx, Venue::RaydiumAmmV4, SOL_USDC_POOL)?;
    let (stable_delta, stable_decimals) = owner_delta(tx, trader, USDC_MINT)?;
    if stable_decimals != USDC_DECIMALS {
        return None;
    }
    let (sol_delta, sol_decimals, sol_source, confidence) = if let Some((delta, decimals)) =
        owner_delta(tx, trader, crate::market_decoder::WSOL_MINT)
    {
        (delta, decimals, SolSource::WsolBalance, 0.99)
    } else {
        (
            economic_sol_delta(tx)?,
            SOL_DECIMALS,
            SolSource::NativeBalance,
            0.82,
        )
    };
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
        pool_address: SOL_USDC_POOL,
        protocol: Venue::RaydiumAmmV4,
        program_id: Venue::RaydiumAmmV4.program_id(),
        trader: trader.clone(),
        stable_mint: USDC_MINT,
        sol_raw: sol_raw.to_string(),
        stable_raw: stable_raw.to_string(),
        sol_decimals,
        stable_decimals,
        sol_source,
        slot: tx.occurrence.slot,
        signature: tx.signed_id.signature.clone(),
        instruction_index,
        observed_at: tx.observed_at.clone(),
        confidence,
        stale: false,
        commitment: tx.commitment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::{FervorTx, TokenBalance, TxIx};

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

    fn sample() -> FervorTx {
        let mut tx: FervorTx =
            serde_json::from_str(include_str!("../../tests/contracts/fervor-tx-v1.json")).unwrap();
        let trader = tx.static_keys[0].clone();
        tx.static_keys = vec![
            trader.clone(),
            Venue::RaydiumAmmV4.program_id().to_string(),
            crate::market_decoder::WSOL_MINT.to_string(),
            SOL_USDC_POOL.to_string(),
            USDC_MINT.to_string(),
        ];
        tx.instructions = vec![TxIx {
            outer_index: 0,
            inner_index: None,
            stack_height: None,
            program_index: 1,
            accounts: vec![0, 3, 2, 4],
            data: vec![9],
        }];
        tx.pre_balances = vec![1_000_000_000; tx.static_keys.len()];
        tx.post_balances = tx.pre_balances.clone();
        tx.pre_tokens = vec![
            balance(
                2,
                crate::market_decoder::WSOL_MINT,
                &trader,
                "2000000000",
                9,
            ),
            balance(4, USDC_MINT, &trader, "0", 6),
        ];
        tx.post_tokens = vec![
            balance(
                2,
                crate::market_decoder::WSOL_MINT,
                &trader,
                "1000000000",
                9,
            ),
            balance(4, USDC_MINT, &trader, "240000000", 6),
        ];
        tx
    }

    #[test]
    fn emits_exact_raw_reference_evidence() {
        let observation = decode_fx(&sample()).unwrap().unwrap();
        assert_eq!(observation.contract, FX_CONTRACT);
        assert_eq!(observation.policy, FX_POLICY);
        assert_eq!(observation.sol_raw, "1000000000");
        assert_eq!(observation.stable_raw, "240000000");
        assert_eq!(observation.sol_source, SolSource::WsolBalance);
        assert_eq!(observation.instruction_index, 0);
    }

    #[test]
    fn removes_the_fee_from_native_sol_evidence() {
        let mut tx = sample();
        tx.pre_tokens.retain(|balance| balance.mint == USDC_MINT);
        tx.post_tokens.retain(|balance| balance.mint == USDC_MINT);
        tx.fee = 5_000;
        tx.pre_balances[0] = 2_000_000_000;
        tx.post_balances[0] = 999_995_000;

        let observation = decode_fx(&tx).unwrap().unwrap();
        assert_eq!(observation.sol_raw, "1000000000");
        assert_eq!(observation.sol_source, SolSource::NativeBalance);
        assert_eq!(observation.confidence, 0.82);
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
    }
}
