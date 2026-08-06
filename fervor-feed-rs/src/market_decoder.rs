use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use yellowstone_grpc_proto::prelude::{
    CompiledInstruction, InnerInstruction, SubscribeUpdateTransaction, TokenBalance,
    TransactionStatusMeta,
};

pub const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const USDT_MINT: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const PUMP_FUN: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const RAYDIUM_AMM_V4: &str = "675kPX9MHTjS2zt1qfr1NYJSCfn6wUCwBK6n2UZMfw";
const RAYDIUM_CLMM: &str = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_CPMM: &str = "CPMMoo8L3F4NbTegBCKVNio1bsBk5wWK8Mwq1qkMzoC";
const RAYDIUM_LAUNCHLAB: &str = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const METEORA_DLMM: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DBC: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const ORCA_WHIRLPOOL: &str = "whirLbMiicVdio4qvUfM5KAg6CtVciGkn7hKfLiE6iQ";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Venue {
    PumpFun,
    PumpSwap,
    RaydiumAmmV4,
    RaydiumClmm,
    RaydiumCpmm,
    RaydiumLaunchlab,
    MeteoraDlmm,
    MeteoraDbc,
    OrcaWhirlpool,
}

impl Venue {
    pub fn program_id(self) -> &'static str {
        match self {
            Self::PumpFun => PUMP_FUN,
            Self::PumpSwap => PUMP_SWAP,
            Self::RaydiumAmmV4 => RAYDIUM_AMM_V4,
            Self::RaydiumClmm => RAYDIUM_CLMM,
            Self::RaydiumCpmm => RAYDIUM_CPMM,
            Self::RaydiumLaunchlab => RAYDIUM_LAUNCHLAB,
            Self::MeteoraDlmm => METEORA_DLMM,
            Self::MeteoraDbc => METEORA_DBC,
            Self::OrcaWhirlpool => ORCA_WHIRLPOOL,
        }
    }

    fn from_program(program_id: &str) -> Option<Self> {
        match program_id {
            PUMP_FUN => Some(Self::PumpFun),
            PUMP_SWAP => Some(Self::PumpSwap),
            RAYDIUM_AMM_V4 => Some(Self::RaydiumAmmV4),
            RAYDIUM_CLMM => Some(Self::RaydiumClmm),
            RAYDIUM_CPMM => Some(Self::RaydiumCpmm),
            RAYDIUM_LAUNCHLAB => Some(Self::RaydiumLaunchlab),
            METEORA_DLMM => Some(Self::MeteoraDlmm),
            METEORA_DBC => Some(Self::MeteoraDbc),
            ORCA_WHIRLPOOL => Some(Self::OrcaWhirlpool),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuoteKind {
    Wsol,
    Usdc,
    Usdt,
    NativeSol,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSwap {
    pub signature: String,
    pub slot: u64,
    pub instruction_index: u32,
    pub event_index: u32,
    pub trader: String,
    pub token_mint: String,
    pub quote_mint: String,
    pub token_amount: f64,
    pub quote_amount: f64,
    pub token_amount_raw: String,
    pub quote_amount_raw: String,
    pub token_decimals: u32,
    pub quote_decimals: u32,
    pub side: Side,
    pub price_quote: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sol_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_sol: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<f64>,
    pub protocol: Venue,
    pub program_id: String,
    pub pool_address: Option<String>,
    pub route: Vec<Venue>,
    pub quote_kind: QuoteKind,
    pub confidence: f64,
    pub decode_version: &'static str,
    pub compute_units: Option<u64>,
}

#[derive(Clone, Debug)]
struct Delta {
    mint: String,
    owner: String,
    raw: i128,
    decimals: u32,
}

#[derive(Clone, Copy)]
struct Ix<'a> {
    outer: u32,
    program_index: u32,
    accounts: &'a [u8],
    data: &'a [u8],
}

#[derive(Clone)]
struct SwapIx {
    outer: u32,
    venue: Venue,
    pool: Option<String>,
}

pub fn decode_swap(update: &SubscribeUpdateTransaction) -> Option<DecodedSwap> {
    let info = update.transaction.as_ref()?;
    let transaction = info.transaction.as_ref()?;
    let message = transaction.message.as_ref()?;
    let meta = info.meta.as_ref()?;
    if meta.err.is_some() || message.account_keys.is_empty() {
        return None;
    }

    let keys = resolve_keys(&message.account_keys, meta);
    let trader = encode_key(message.account_keys.first()?)?;
    let swaps = swap_instructions(message.instructions.as_slice(), meta, &keys);
    let primary = swaps.first()?;
    let deltas = token_deltas(meta)?;
    let base = deltas
        .iter()
        .filter(|delta| {
            delta.owner == trader && quote_kind(&delta.mint).is_none() && delta.raw != 0
        })
        .max_by(|left, right| ui_abs(left).total_cmp(&ui_abs(right)))?;

    let (quote_mint, quote_raw, quote_decimals, kind, confidence) = deltas
        .iter()
        .filter(|delta| {
            delta.owner == trader && quote_kind(&delta.mint).is_some() && delta.raw != 0
        })
        .max_by(|left, right| ui_abs(left).total_cmp(&ui_abs(right)))
        .map(|quote| {
            (
                quote.mint.clone(),
                quote.raw,
                quote.decimals,
                quote_kind(&quote.mint).expect("filtered quote mint"),
                0.99,
            )
        })
        .or_else(|| {
            native_sol_delta(meta)
                .map(|raw| (WSOL_MINT.to_string(), raw, 9, QuoteKind::NativeSol, 0.82))
        })?;

    if base.raw.signum() == quote_raw.signum() {
        return None;
    }

    let side = if base.raw > 0 { Side::Buy } else { Side::Sell };
    let token_raw = u64::try_from(base.raw.unsigned_abs()).ok()?;
    let quote_raw = u64::try_from(quote_raw.unsigned_abs()).ok()?;
    let token_amount = scaled(token_raw.into(), base.decimals);
    let quote_amount = scaled(quote_raw.into(), quote_decimals);
    if token_amount <= 0.0 || quote_amount <= 0.0 {
        return None;
    }

    let signature = bs58::encode(&info.signature).into_string();
    let mut route = Vec::new();
    for swap in &swaps {
        if !route.contains(&swap.venue) {
            route.push(swap.venue);
        }
    }

    let is_sol = matches!(kind, QuoteKind::Wsol | QuoteKind::NativeSol);
    let is_usd = matches!(kind, QuoteKind::Usdc | QuoteKind::Usdt);
    let price_quote = quote_amount / token_amount;

    Some(DecodedSwap {
        signature,
        slot: update.slot,
        instruction_index: primary.outer,
        event_index: 0,
        trader,
        token_mint: base.mint.clone(),
        quote_mint,
        token_amount,
        quote_amount,
        token_amount_raw: token_raw.to_string(),
        quote_amount_raw: quote_raw.to_string(),
        token_decimals: base.decimals,
        quote_decimals,
        side,
        price_quote,
        sol_amount: is_sol.then_some(quote_amount),
        usd_amount: is_usd.then_some(quote_amount),
        price_sol: is_sol.then_some(price_quote),
        price_usd: is_usd.then_some(price_quote),
        protocol: primary.venue,
        program_id: primary.venue.program_id().to_string(),
        pool_address: primary.pool.clone(),
        route,
        quote_kind: kind,
        confidence,
        decode_version: "balance-delta-v1",
        compute_units: meta.compute_units_consumed,
    })
}

fn resolve_keys(static_keys: &[Vec<u8>], meta: &TransactionStatusMeta) -> Vec<String> {
    static_keys
        .iter()
        .chain(meta.loaded_writable_addresses.iter())
        .chain(meta.loaded_readonly_addresses.iter())
        .map(|key| encode_key(key).unwrap_or_default())
        .collect()
}

fn encode_key(key: &[u8]) -> Option<String> {
    (key.len() == 32).then(|| bs58::encode(key).into_string())
}

fn all_instructions<'a>(
    outer: &'a [CompiledInstruction],
    meta: &'a TransactionStatusMeta,
) -> Vec<Ix<'a>> {
    let mut instructions = Vec::with_capacity(
        outer.len()
            + meta
                .inner_instructions
                .iter()
                .map(|item| item.instructions.len())
                .sum::<usize>(),
    );
    for (index, instruction) in outer.iter().enumerate() {
        instructions.push(Ix {
            outer: index as u32,
            program_index: instruction.program_id_index,
            accounts: &instruction.accounts,
            data: &instruction.data,
        });
        if let Some(inner) = meta
            .inner_instructions
            .iter()
            .find(|inner| inner.index as usize == index)
        {
            instructions.extend(
                inner
                    .instructions
                    .iter()
                    .map(|instruction: &InnerInstruction| Ix {
                        outer: index as u32,
                        program_index: instruction.program_id_index,
                        accounts: &instruction.accounts,
                        data: &instruction.data,
                    }),
            );
        }
    }
    instructions
}

fn swap_instructions(
    outer: &[CompiledInstruction],
    meta: &TransactionStatusMeta,
    keys: &[String],
) -> Vec<SwapIx> {
    all_instructions(outer, meta)
        .into_iter()
        .filter_map(|instruction| {
            let program = keys.get(instruction.program_index as usize)?;
            let venue = Venue::from_program(program)?;
            let pool_position = swap_pool_position(venue, instruction.data)?;
            Some(SwapIx {
                outer: instruction.outer,
                venue,
                pool: pool_address(pool_position, instruction.accounts, keys),
            })
        })
        .collect()
}

#[cfg(test)]
fn is_swap_instruction(venue: Venue, data: &[u8]) -> bool {
    swap_pool_position(venue, data).is_some()
}

fn swap_pool_position(venue: Venue, data: &[u8]) -> Option<usize> {
    if venue == Venue::RaydiumAmmV4 {
        return matches!(data.first(), Some(9 | 11)).then_some(1);
    }
    if data.len() < 8 {
        return None;
    }
    match venue {
        Venue::PumpFun => match_anchor(data, &["buy_v2", "sell_v2", "buy_exact_quote_in_v2"])
            .then_some(10)
            .or_else(|| match_anchor(data, &["buy", "sell", "buy_exact_sol_in"]).then_some(3)),
        Venue::PumpSwap => match_anchor(data, &["buy", "sell", "buy_exact_quote_in"]).then_some(0),
        Venue::RaydiumClmm => match_anchor(data, &["swap", "swap_v2"])
            .then_some(2)
            .or_else(|| match_anchor(data, &["swap_router_base_in"]).then_some(0)),
        Venue::RaydiumCpmm => {
            match_anchor(data, &["swap_base_input", "swap_base_output"]).then_some(3)
        }
        Venue::RaydiumLaunchlab => match_anchor(
            data,
            &[
                "buy_exact_in",
                "buy_exact_out",
                "sell_exact_in",
                "sell_exact_out",
            ],
        )
        .then_some(4),
        Venue::MeteoraDlmm => match_anchor(
            data,
            &[
                "swap",
                "swap2",
                "swap_exact_out",
                "swap_exact_out2",
                "swap_with_price_impact",
                "swap_with_price_impact2",
            ],
        )
        .then_some(0),
        Venue::MeteoraDbc => {
            match_anchor(data, &["swap", "swap2", "swap2_with_transfer_hook"]).then_some(2)
        }
        Venue::OrcaWhirlpool => match_anchor(data, &["swap"])
            .then_some(2)
            .or_else(|| match_anchor(data, &["swap_v2"]).then_some(4))
            .or_else(|| match_anchor(data, &["two_hop_swap"]).then_some(2))
            .or_else(|| match_anchor(data, &["two_hop_swap_v2"]).then_some(0)),
        Venue::RaydiumAmmV4 => None,
    }
}

fn match_anchor(data: &[u8], names: &[&str]) -> bool {
    names
        .iter()
        .any(|name| data[..8] == anchor_discriminator(name))
}

fn anchor_discriminator(name: &str) -> [u8; 8] {
    let digest = Sha256::digest(format!("global:{name}"));
    digest[..8]
        .try_into()
        .expect("sha256 prefix has eight bytes")
}

fn pool_address(position: usize, accounts: &[u8], keys: &[String]) -> Option<String> {
    accounts
        .get(position)
        .and_then(|index| keys.get(*index as usize))
        .filter(|key| !key.is_empty())
        .cloned()
}

fn token_deltas(meta: &TransactionStatusMeta) -> Option<Vec<Delta>> {
    let mut snapshots: HashMap<u32, (Option<&TokenBalance>, Option<&TokenBalance>)> =
        HashMap::new();
    for balance in &meta.pre_token_balances {
        snapshots.entry(balance.account_index).or_default().0 = Some(balance);
    }
    for balance in &meta.post_token_balances {
        snapshots.entry(balance.account_index).or_default().1 = Some(balance);
    }

    let mut aggregate: HashMap<(String, String, u32), i128> = HashMap::new();
    for (_index, (pre, post)) in snapshots {
        let sample = post.or(pre).expect("snapshot contains a balance");
        let mint = post
            .filter(|balance| !balance.mint.is_empty())
            .or(pre)
            .map(|balance| balance.mint.clone())
            .unwrap_or_default();
        let owner = post
            .filter(|balance| !balance.owner.is_empty())
            .or(pre)
            .map(|balance| balance.owner.clone())
            .unwrap_or_default();
        let decimals = sample
            .ui_token_amount
            .as_ref()
            .map_or(0, |amount| amount.decimals);
        let before = snapshot_amount(pre)?;
        let after = snapshot_amount(post)?;
        if mint.is_empty() || owner.is_empty() {
            continue;
        }
        let delta = i128::from(after) - i128::from(before);
        let total = aggregate.entry((mint, owner, decimals)).or_default();
        *total = total.checked_add(delta)?;
    }

    Some(
        aggregate
            .into_iter()
            .map(|((mint, owner, decimals), raw)| Delta {
                mint,
                owner,
                raw,
                decimals,
            })
            .filter(|delta| delta.raw != 0)
            .collect(),
    )
}

fn raw_amount(balance: Option<&TokenBalance>) -> Option<u64> {
    balance?.ui_token_amount.as_ref()?.amount.parse().ok()
}

fn snapshot_amount(balance: Option<&TokenBalance>) -> Option<u64> {
    balance.map_or(Some(0), |value| raw_amount(Some(value)))
}

fn native_sol_delta(meta: &TransactionStatusMeta) -> Option<i128> {
    let before = *meta.pre_balances.first()? as i128;
    let after = *meta.post_balances.first()? as i128;
    let economic = after - before + meta.fee as i128;
    (economic != 0).then_some(economic)
}

fn quote_kind(mint: &str) -> Option<QuoteKind> {
    match mint {
        WSOL_MINT => Some(QuoteKind::Wsol),
        USDC_MINT => Some(QuoteKind::Usdc),
        USDT_MINT => Some(QuoteKind::Usdt),
        _ => None,
    }
}

fn ui_abs(delta: &Delta) -> f64 {
    scaled(delta.raw.unsigned_abs(), delta.decimals)
}

fn scaled(raw: u128, decimals: u32) -> f64 {
    raw as f64 / 10_f64.powi(decimals as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yellowstone_grpc_proto::prelude::{
        Message, MessageHeader, SubscribeUpdateTransactionInfo, Transaction, UiTokenAmount,
    };

    fn key(seed: u8) -> Vec<u8> {
        vec![seed; 32]
    }

    fn balance(index: u32, mint: &str, owner: &str, raw: &str, decimals: u32) -> TokenBalance {
        TokenBalance {
            account_index: index,
            mint: mint.to_string(),
            ui_token_amount: Some(UiTokenAmount {
                amount: raw.to_string(),
                decimals,
                ..Default::default()
            }),
            owner: owner.to_string(),
            ..Default::default()
        }
    }

    fn fixture(venue: Venue, data: Vec<u8>, native_sol: bool) -> SubscribeUpdateTransaction {
        let trader_key = key(1);
        let trader = bs58::encode(&trader_key).into_string();
        let program_key = bs58::decode(venue.program_id()).into_vec().unwrap();
        let token_mint = bs58::encode(key(8)).into_string();
        let mut pre = vec![balance(2, &token_mint, &trader, "1000000", 6)];
        let mut post = vec![balance(2, &token_mint, &trader, "3000000", 6)];
        if !native_sol {
            pre.push(balance(3, USDC_MINT, &trader, "10000000", 6));
            post.push(balance(3, USDC_MINT, &trader, "6000000", 6));
        }
        SubscribeUpdateTransaction {
            slot: 42,
            transaction: Some(SubscribeUpdateTransactionInfo {
                signature: vec![9; 64],
                transaction: Some(Transaction {
                    message: Some(Message {
                        header: Some(MessageHeader {
                            num_required_signatures: 1,
                            ..Default::default()
                        }),
                        account_keys: vec![trader_key, program_key, key(2), key(3), key(4), key(5)],
                        instructions: vec![CompiledInstruction {
                            program_id_index: 1,
                            accounts: vec![2, 3, 4, 5, 0],
                            data,
                        }],
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                meta: Some(TransactionStatusMeta {
                    fee: 5_000,
                    pre_balances: vec![10_000_000_000, 0, 0, 0, 0, 0],
                    post_balances: vec![
                        if native_sol {
                            7_999_995_000
                        } else {
                            9_999_995_000
                        },
                        0,
                        0,
                        0,
                        0,
                        0,
                    ],
                    pre_token_balances: pre,
                    post_token_balances: post,
                    compute_units_consumed: Some(88_000),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        }
    }

    fn meta(update: &mut SubscribeUpdateTransaction) -> &mut TransactionStatusMeta {
        update
            .transaction
            .as_mut()
            .and_then(|info| info.meta.as_mut())
            .expect("fixture meta")
    }

    #[test]
    fn decodes_anchor_swap_with_exact_raw_amounts() {
        let mut data = anchor_discriminator("buy").to_vec();
        data.extend_from_slice(&[0; 16]);
        let swap = decode_swap(&fixture(Venue::PumpFun, data, false)).unwrap();

        assert_eq!(swap.protocol, Venue::PumpFun);
        assert_eq!(swap.side, Side::Buy);
        assert_eq!(swap.token_amount_raw, "2000000");
        assert_eq!(swap.quote_amount_raw, "4000000");
        assert_eq!(swap.price_quote, 2.0);
        assert_eq!(swap.quote_kind, QuoteKind::Usdc);
        assert_eq!(swap.compute_units, Some(88_000));
    }

    #[test]
    fn derives_native_sol_after_removing_network_fee() {
        let mut data = anchor_discriminator("swap").to_vec();
        data.extend_from_slice(&[0; 16]);
        let swap = decode_swap(&fixture(Venue::OrcaWhirlpool, data, true)).unwrap();

        assert_eq!(swap.quote_kind, QuoteKind::NativeSol);
        assert_eq!(swap.quote_amount_raw, "2000000000");
        assert_eq!(swap.quote_amount, 2.0);
        assert_eq!(swap.confidence, 0.82);
    }

    #[test]
    fn accepts_the_full_u64_raw_amount_domain() {
        let mut data = anchor_discriminator("buy").to_vec();
        data.extend_from_slice(&[0; 16]);
        let mut update = fixture(Venue::PumpFun, data, false);
        let before = meta(&mut update)
            .pre_token_balances
            .first_mut()
            .and_then(|balance| balance.ui_token_amount.as_mut())
            .expect("token amount");
        before.amount = "0".to_string();
        let token = meta(&mut update)
            .post_token_balances
            .first_mut()
            .and_then(|balance| balance.ui_token_amount.as_mut())
            .expect("token amount");
        token.amount = u64::MAX.to_string();

        let swap = decode_swap(&update).expect("u64 max is valid");
        assert_eq!(swap.token_amount_raw, u64::MAX.to_string());
    }

    #[test]
    fn rejects_malformed_or_aggregated_out_of_range_amounts() {
        let mut data = anchor_discriminator("buy").to_vec();
        data.extend_from_slice(&[0; 16]);

        let mut malformed = fixture(Venue::PumpFun, data.clone(), false);
        meta(&mut malformed).pre_token_balances[0]
            .ui_token_amount
            .as_mut()
            .expect("token amount")
            .amount = (u128::from(u64::MAX) + 1).to_string();
        assert!(decode_swap(&malformed).is_none());

        let mut aggregate = fixture(Venue::PumpFun, data, false);
        let token = meta(&mut aggregate).post_token_balances[0].mint.clone();
        let trader = meta(&mut aggregate).post_token_balances[0].owner.clone();
        meta(&mut aggregate)
            .pre_token_balances
            .push(balance(4, &token, &trader, "0", 6));
        meta(&mut aggregate).post_token_balances.push(balance(
            4,
            &token,
            &trader,
            &u64::MAX.to_string(),
            6,
        ));
        assert!(decode_swap(&aggregate).is_none());
    }

    #[test]
    fn rejects_non_swap_instructions() {
        let data = anchor_discriminator("add_liquidity").to_vec();
        assert!(decode_swap(&fixture(Venue::RaydiumCpmm, data, false)).is_none());
    }

    #[test]
    fn recognizes_raydium_v4_swap_tags() {
        assert!(is_swap_instruction(Venue::RaydiumAmmV4, &[9]));
        assert!(is_swap_instruction(Venue::RaydiumAmmV4, &[11]));
        assert!(!is_swap_instruction(Venue::RaydiumAmmV4, &[3]));
    }

    #[test]
    fn follows_versioned_idl_pool_positions() {
        assert_eq!(
            swap_pool_position(Venue::PumpFun, &anchor_discriminator("buy_v2")),
            Some(10)
        );
        assert_eq!(
            swap_pool_position(Venue::OrcaWhirlpool, &anchor_discriminator("swap_v2")),
            Some(4)
        );
        assert_eq!(
            swap_pool_position(Venue::MeteoraDlmm, &anchor_discriminator("swap2")),
            Some(0)
        );
    }

    #[test]
    fn resolves_loaded_address_table_keys() {
        let meta = TransactionStatusMeta {
            loaded_writable_addresses: vec![key(2)],
            loaded_readonly_addresses: vec![key(3)],
            ..Default::default()
        };
        let resolved = resolve_keys(&[key(1)], &meta);
        assert_eq!(resolved.len(), 3);
        assert_eq!(resolved[2], bs58::encode(key(3)).into_string());
    }
}
