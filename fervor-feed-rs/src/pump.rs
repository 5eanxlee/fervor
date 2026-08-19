//! Strict legacy Pump lifecycle events derived from canonical Anchor self-CPI records.
//!
//! This layout is pinned to the November 2024 chain frames in Fervor's qualified
//! corpus. The first public Pump IDL later included an additional `creator` field
//! in `CreateEvent`; this decoder deliberately rejects that newer shape.

use crate::fervor_tx::{
    opt_u64_text, u64_text, FervorTx, Quarantine, QuarantineReason, SourceError, TxIx,
};
use serde::{Deserialize, Serialize};
use std::str;

pub const PUMP_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
pub const PUMP_LAYOUT: &str = "pump-event-2024-11-v1";

const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SELF_CPI: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];
const CREATE_EVENT: [u8; 8] = [27, 114, 169, 77, 222, 235, 99, 118];
const TRADE_EVENT: [u8; 8] = [189, 219, 127, 211, 78, 230, 97, 238];
const COMPLETE_EVENT: [u8; 8] = [95, 114, 97, 156, 212, 46, 152, 8];
const WITHDRAW_IX: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const VERSION: u16 = 1;
const PRICE_SCALE: u32 = 18;
const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpOrigin {
    pub signature: String,
    #[serde(with = "u64_text")]
    pub slot: u64,
    #[serde(with = "opt_u64_text")]
    pub tx_index: Option<u64>,
    pub instruction_index: u32,
    pub inner_index: Option<u32>,
    pub event_index: u32,
    pub block_time: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpEvent {
    pub version: u16,
    #[serde(flatten)]
    pub origin: PumpOrigin,
    #[serde(flatten)]
    pub data: PumpData,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PumpData {
    Create(Box<PumpCreate>),
    Trade(Box<PumpTrade>),
    Complete(Box<PumpComplete>),
    Withdraw(Box<PumpWithdraw>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpCreate {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub mint: String,
    pub bonding_curve: String,
    pub user: String,
    pub timestamp: i64,
    pub decimals: u32,
    #[serde(with = "u64_text")]
    pub supply_raw: u64,
    pub supply_fixed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpTrade {
    pub mint: String,
    #[serde(with = "u64_text")]
    pub sol_amount_raw: u64,
    #[serde(with = "u64_text")]
    pub token_amount_raw: u64,
    pub is_buy: bool,
    pub user: String,
    pub timestamp: i64,
    #[serde(with = "u64_text")]
    pub virtual_sol_raw: u64,
    #[serde(with = "u64_text")]
    pub virtual_token_raw: u64,
    #[serde(with = "u64_text")]
    pub real_sol_raw: u64,
    #[serde(with = "u64_text")]
    pub real_token_raw: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpComplete {
    pub user: String,
    pub mint: String,
    pub bonding_curve: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpWithdraw {
    pub mint: String,
    pub bonding_curve: String,
    pub user: String,
}

impl PumpEvent {
    pub fn mint(&self) -> &str {
        match &self.data {
            PumpData::Create(value) => &value.mint,
            PumpData::Trade(value) => &value.mint,
            PumpData::Complete(value) => &value.mint,
            PumpData::Withdraw(value) => &value.mint,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PumpPhase {
    Curve,
    Complete,
    Migrated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpState {
    pub version: u16,
    pub layout: String,
    pub mint: String,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub bonding_curve: String,
    pub deployer: String,
    pub decimals: u32,
    #[serde(with = "u64_text")]
    pub supply_raw: u64,
    pub supply_fixed: bool,
    pub phase: PumpPhase,
    #[serde(with = "u64_text")]
    pub event_count: u64,
    #[serde(with = "u64_text")]
    pub trade_count: u64,
    #[serde(with = "u64_text")]
    pub buy_count: u64,
    #[serde(with = "u64_text")]
    pub sell_count: u64,
    #[serde(with = "u64_text")]
    pub first_slot: u64,
    #[serde(with = "u64_text")]
    pub last_slot: u64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub migrated_at: Option<i64>,
    pub last_trade_at: Option<i64>,
    #[serde(with = "opt_u64_text")]
    pub virtual_sol_raw: Option<u64>,
    #[serde(with = "opt_u64_text")]
    pub virtual_token_raw: Option<u64>,
    #[serde(with = "opt_u64_text")]
    pub real_sol_raw: Option<u64>,
    #[serde(with = "opt_u64_text")]
    pub real_token_raw: Option<u64>,
    pub price_sol: Option<String>,
    pub fdv_sol: Option<String>,
}

impl PumpState {
    pub fn reconstruct(mint: &str, events: &[PumpEvent]) -> Result<Self, SourceError> {
        let mut state = None;
        let mut last_order = None;

        for event in events.iter().filter(|event| event.mint() == mint) {
            let tx_index = event.origin.tx_index.ok_or_else(|| {
                SourceError("Pump replay event has no transaction index".to_string())
            })?;
            let order = (event.origin.slot, tx_index, event.origin.event_index);
            if last_order.is_some_and(|last| order <= last) {
                return Err(SourceError(
                    "Pump replay events are not canonically ordered".to_string(),
                ));
            }
            last_order = Some(order);

            match &event.data {
                PumpData::Create(create) => {
                    if state.is_some() {
                        return Err(SourceError(
                            "Pump lifecycle contains more than one create event".to_string(),
                        ));
                    }
                    if !create.supply_fixed || create.supply_raw == 0 {
                        return Err(SourceError(
                            "Pump create transaction does not prove fixed supply".to_string(),
                        ));
                    }
                    state = Some(Self {
                        version: VERSION,
                        layout: PUMP_LAYOUT.to_string(),
                        mint: create.mint.clone(),
                        name: create.name.clone(),
                        symbol: create.symbol.clone(),
                        uri: create.uri.clone(),
                        bonding_curve: create.bonding_curve.clone(),
                        deployer: create.user.clone(),
                        decimals: create.decimals,
                        supply_raw: create.supply_raw,
                        supply_fixed: true,
                        phase: PumpPhase::Curve,
                        event_count: 1,
                        trade_count: 0,
                        buy_count: 0,
                        sell_count: 0,
                        first_slot: event.origin.slot,
                        last_slot: event.origin.slot,
                        created_at: create.timestamp,
                        completed_at: None,
                        migrated_at: None,
                        last_trade_at: None,
                        virtual_sol_raw: None,
                        virtual_token_raw: None,
                        real_sol_raw: None,
                        real_token_raw: None,
                        price_sol: None,
                        fdv_sol: None,
                    });
                }
                PumpData::Trade(trade) => {
                    let state = state.as_mut().ok_or_else(|| {
                        SourceError("Pump trade precedes its create event".to_string())
                    })?;
                    if state.phase != PumpPhase::Curve {
                        return Err(SourceError(
                            "Pump trade follows curve completion".to_string(),
                        ));
                    }
                    validate_reserves(state, trade)?;
                    state.event_count = add_one(state.event_count, "Pump event")?;
                    state.trade_count = add_one(state.trade_count, "Pump trade")?;
                    if trade.is_buy {
                        state.buy_count = add_one(state.buy_count, "Pump buy")?;
                    } else {
                        state.sell_count = add_one(state.sell_count, "Pump sell")?;
                    }
                    state.last_slot = event.origin.slot;
                    state.last_trade_at = Some(trade.timestamp);
                    state.virtual_sol_raw = Some(trade.virtual_sol_raw);
                    state.virtual_token_raw = Some(trade.virtual_token_raw);
                    state.real_sol_raw = Some(trade.real_sol_raw);
                    state.real_token_raw = Some(trade.real_token_raw);
                    state.refresh_price()?;
                }
                PumpData::Complete(complete) => {
                    let state = state.as_mut().ok_or_else(|| {
                        SourceError("Pump completion precedes its create event".to_string())
                    })?;
                    if state.phase != PumpPhase::Curve
                        || complete.bonding_curve != state.bonding_curve
                        || state.real_token_raw != Some(0)
                    {
                        return Err(SourceError(
                            "Pump completion is inconsistent with curve state".to_string(),
                        ));
                    }
                    state.event_count = add_one(state.event_count, "Pump event")?;
                    state.phase = PumpPhase::Complete;
                    state.completed_at = Some(complete.timestamp);
                    state.last_slot = event.origin.slot;
                }
                PumpData::Withdraw(withdraw) => {
                    let state = state.as_mut().ok_or_else(|| {
                        SourceError("Pump withdrawal precedes its create event".to_string())
                    })?;
                    if state.phase != PumpPhase::Complete
                        || withdraw.bonding_curve != state.bonding_curve
                    {
                        return Err(SourceError(
                            "Pump withdrawal is inconsistent with completion state".to_string(),
                        ));
                    }
                    state.event_count = add_one(state.event_count, "Pump event")?;
                    state.phase = PumpPhase::Migrated;
                    state.migrated_at = event.origin.block_time;
                    state.last_slot = event.origin.slot;
                }
            }
        }

        state.ok_or_else(|| SourceError(format!("Pump lifecycle has no create event for {mint}")))
    }

    fn refresh_price(&mut self) -> Result<(), SourceError> {
        let virtual_sol = self
            .virtual_sol_raw
            .ok_or_else(|| SourceError("Pump virtual SOL reserves are missing".to_string()))?;
        let virtual_token = self
            .virtual_token_raw
            .filter(|value| *value > 0)
            .ok_or_else(|| SourceError("Pump virtual token reserves are zero".to_string()))?;
        let token_scale = 10_u128
            .checked_pow(self.decimals)
            .ok_or_else(|| SourceError("Pump token decimals overflow".to_string()))?;
        let price_num = u128::from(virtual_sol)
            .checked_mul(token_scale)
            .ok_or_else(|| SourceError("Pump price numerator overflow".to_string()))?;
        let denominator = u128::from(virtual_token)
            .checked_mul(LAMPORTS_PER_SOL)
            .ok_or_else(|| SourceError("Pump price denominator overflow".to_string()))?;
        let fdv_num = u128::from(self.supply_raw)
            .checked_mul(u128::from(virtual_sol))
            .ok_or_else(|| SourceError("Pump FDV numerator overflow".to_string()))?;
        self.price_sol = Some(decimal_ratio(price_num, denominator)?);
        self.fdv_sol = Some(decimal_ratio(fdv_num, denominator)?);
        Ok(())
    }
}

pub fn decode_pump_events(tx: &FervorTx) -> Result<Vec<PumpEvent>, Quarantine> {
    tx.validate().map_err(|error| {
        Quarantine::from_tx(tx, QuarantineReason::InvalidIdentity, error.to_string())
    })?;
    if tx.error.is_some() {
        return Ok(Vec::new());
    }
    let keys = tx
        .static_keys
        .iter()
        .chain(&tx.loaded_writable)
        .chain(&tx.loaded_readonly)
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut events = Vec::new();

    for ix in &tx.instructions {
        if keys.get(ix.program_index as usize).copied() != Some(PUMP_PROGRAM) {
            continue;
        }
        let data = if ix.data.starts_with(&SELF_CPI) {
            parse_cpi(tx, ix, &keys).map_err(|detail| {
                Quarantine::from_tx(tx, QuarantineReason::UnsupportedWire, detail)
            })?
        } else if ix.data.starts_with(&WITHDRAW_IX) {
            Some(PumpData::Withdraw(Box::new(
                parse_withdraw(ix, &keys).map_err(|detail| {
                    Quarantine::from_tx(tx, QuarantineReason::MissingField, detail)
                })?,
            )))
        } else {
            None
        };
        if let Some(data) = data {
            let event_index = u32::try_from(events.len()).map_err(|_| {
                Quarantine::from_tx(
                    tx,
                    QuarantineReason::InvalidIdentity,
                    "Pump event index exceeds u32".to_string(),
                )
            })?;
            events.push(PumpEvent {
                version: VERSION,
                origin: PumpOrigin {
                    signature: tx.signed_id.signature.clone(),
                    slot: tx.occurrence.slot,
                    tx_index: tx.occurrence.tx_index,
                    instruction_index: ix.outer_index,
                    inner_index: ix.inner_index,
                    event_index,
                    block_time: tx.block_time,
                },
                data,
            });
        }
    }
    Ok(events)
}

fn parse_cpi(tx: &FervorTx, ix: &TxIx, keys: &[&str]) -> Result<Option<PumpData>, String> {
    if ix.data.len() < 16 {
        return Err("Pump self-CPI event is shorter than its discriminators".to_string());
    }
    let event = &ix.data[8..16];
    let body = &ix.data[16..];
    if event == CREATE_EVENT {
        return parse_create(body, tx, keys, ix.outer_index)
            .map(|value| Some(PumpData::Create(Box::new(value))));
    }
    if event == TRADE_EVENT {
        return parse_trade(body).map(|value| Some(PumpData::Trade(Box::new(value))));
    }
    if event == COMPLETE_EVENT {
        return parse_complete(body).map(|value| Some(PumpData::Complete(Box::new(value))));
    }
    Ok(None)
}

fn parse_create(
    bytes: &[u8],
    tx: &FervorTx,
    keys: &[&str],
    outer: u32,
) -> Result<PumpCreate, String> {
    let mut input = Input::new(bytes);
    let name = input.string("name", 128)?;
    let symbol = input.string("symbol", 32)?;
    let uri = input.string("URI", 2_048)?;
    let mint = input.pubkey("mint")?;
    let bonding_curve = input.pubkey("bonding curve")?;
    let user = input.pubkey("user")?;
    let timestamp = input.i64("timestamp")?;
    input.finish("create")?;
    let evidence = mint_evidence(tx, keys, outer, &mint)?;
    Ok(PumpCreate {
        name,
        symbol,
        uri,
        mint,
        bonding_curve,
        user,
        timestamp,
        decimals: evidence.decimals,
        supply_raw: evidence.supply_raw,
        supply_fixed: evidence.supply_fixed,
    })
}

fn parse_trade(bytes: &[u8]) -> Result<PumpTrade, String> {
    let mut input = Input::new(bytes);
    let value = PumpTrade {
        mint: input.pubkey("mint")?,
        sol_amount_raw: input.u64("SOL amount")?,
        token_amount_raw: input.u64("token amount")?,
        is_buy: input.boolean("trade side")?,
        user: input.pubkey("user")?,
        timestamp: input.i64("timestamp")?,
        virtual_sol_raw: input.u64("virtual SOL reserves")?,
        virtual_token_raw: input.u64("virtual token reserves")?,
        real_sol_raw: input.u64("real SOL reserves")?,
        real_token_raw: input.u64("real token reserves")?,
    };
    input.finish("trade")?;
    if value.sol_amount_raw == 0 || value.token_amount_raw == 0 {
        return Err("Pump trade amount is zero".to_string());
    }
    Ok(value)
}

fn parse_complete(bytes: &[u8]) -> Result<PumpComplete, String> {
    let mut input = Input::new(bytes);
    let value = PumpComplete {
        user: input.pubkey("user")?,
        mint: input.pubkey("mint")?,
        bonding_curve: input.pubkey("bonding curve")?,
        timestamp: input.i64("timestamp")?,
    };
    input.finish("complete")?;
    Ok(value)
}

fn parse_withdraw(ix: &TxIx, keys: &[&str]) -> Result<PumpWithdraw, String> {
    if ix.data.len() != WITHDRAW_IX.len() {
        return Err("Pump withdraw instruction has trailing data".to_string());
    }
    Ok(PumpWithdraw {
        mint: ix_account(ix, 2, keys, "mint")?.to_string(),
        bonding_curve: ix_account(ix, 3, keys, "bonding curve")?.to_string(),
        user: ix_account(ix, 6, keys, "user")?.to_string(),
    })
}

struct MintEvidence {
    decimals: u32,
    supply_raw: u64,
    supply_fixed: bool,
}

fn mint_evidence(
    tx: &FervorTx,
    keys: &[&str],
    outer: u32,
    mint: &str,
) -> Result<MintEvidence, String> {
    let mut decimals = None;
    let mut supply_raw = 0_u64;
    let mut minted = false;
    let mut supply_fixed = false;

    for ix in tx.instructions.iter().filter(|ix| ix.outer_index == outer) {
        let Some(program) = keys.get(ix.program_index as usize).copied() else {
            continue;
        };
        if program != TOKEN_PROGRAM
            || ix_account(ix, 0, keys, "token account")? != mint
            || ix.data.is_empty()
        {
            continue;
        }
        match ix.data[0] {
            0 | 20 if ix.data.len() >= 2 => {
                let value = u32::from(ix.data[1]);
                if decimals.replace(value).is_some_and(|prior| prior != value) {
                    return Err("Pump create has conflicting mint decimals".to_string());
                }
            }
            7 if ix.data.len() == 9 => {
                supply_raw = supply_raw
                    .checked_add(read_u64(&ix.data[1..9])?)
                    .ok_or_else(|| "Pump create mint supply overflow".to_string())?;
                minted = true;
            }
            14 if ix.data.len() == 10 => {
                supply_raw = supply_raw
                    .checked_add(read_u64(&ix.data[1..9])?)
                    .ok_or_else(|| "Pump create mint supply overflow".to_string())?;
                minted = true;
            }
            6 if ix.data.len() >= 3 && ix.data[1] == 0 => {
                supply_fixed |= ix.data[2..].iter().all(|value| *value == 0);
            }
            _ => {}
        }
    }

    let decimals = decimals.ok_or_else(|| "Pump create has no mint initialization".to_string())?;
    if !minted || supply_raw == 0 {
        return Err("Pump create has no initial mint supply".to_string());
    }
    Ok(MintEvidence {
        decimals,
        supply_raw,
        supply_fixed,
    })
}

fn ix_account<'a>(
    ix: &TxIx,
    position: usize,
    keys: &'a [&str],
    name: &str,
) -> Result<&'a str, String> {
    ix.accounts
        .get(position)
        .and_then(|index| keys.get(*index as usize))
        .copied()
        .ok_or_else(|| format!("Pump instruction has no {name} account"))
}

fn validate_reserves(state: &PumpState, trade: &PumpTrade) -> Result<(), SourceError> {
    let prior = (
        state.virtual_sol_raw,
        state.virtual_token_raw,
        state.real_sol_raw,
        state.real_token_raw,
    );
    let (Some(virtual_sol), Some(virtual_token), Some(real_sol), Some(real_token)) = prior else {
        return Ok(());
    };
    let valid = if trade.is_buy {
        trade.virtual_sol_raw >= virtual_sol
            && trade.virtual_token_raw <= virtual_token
            && trade.real_sol_raw >= real_sol
            && trade.real_token_raw <= real_token
    } else {
        trade.virtual_sol_raw <= virtual_sol
            && trade.virtual_token_raw >= virtual_token
            && trade.real_sol_raw <= real_sol
            && trade.real_token_raw >= real_token
    };
    if !valid {
        return Err(SourceError(
            "Pump trade reserve direction contradicts its side".to_string(),
        ));
    }
    Ok(())
}

fn decimal_ratio(numerator: u128, denominator: u128) -> Result<String, SourceError> {
    if denominator == 0 {
        return Err(SourceError("Pump decimal denominator is zero".to_string()));
    }
    let scale = 10_u128
        .checked_pow(PRICE_SCALE)
        .ok_or_else(|| SourceError("Pump decimal scale overflow".to_string()))?;
    let whole = numerator / denominator;
    let fraction = (numerator % denominator)
        .checked_mul(scale)
        .ok_or_else(|| SourceError("Pump decimal fraction overflow".to_string()))?
        / denominator;
    Ok(format!("{whole}.{fraction:018}"))
}

fn add_one(value: u64, name: &str) -> Result<u64, SourceError> {
    value
        .checked_add(1)
        .ok_or_else(|| SourceError(format!("{name} count overflow")))
}

fn read_u64(bytes: &[u8]) -> Result<u64, String> {
    let value: [u8; 8] = bytes
        .try_into()
        .map_err(|_| "Pump u64 field has the wrong length".to_string())?;
    Ok(u64::from_le_bytes(value))
}

struct Input<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Input<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take<const N: usize>(&mut self, name: &str) -> Result<[u8; N], String> {
        let end = self
            .offset
            .checked_add(N)
            .ok_or_else(|| format!("Pump {name} offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| format!("Pump {name} is truncated"))?;
        self.offset = end;
        bytes
            .try_into()
            .map_err(|_| format!("Pump {name} has the wrong length"))
    }

    fn u64(&mut self, name: &str) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(name)?))
    }

    fn i64(&mut self, name: &str) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take(name)?))
    }

    fn boolean(&mut self, name: &str) -> Result<bool, String> {
        match self.take::<1>(name)?[0] {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(format!("Pump {name} is not a canonical boolean")),
        }
    }

    fn pubkey(&mut self, name: &str) -> Result<String, String> {
        Ok(bs58::encode(self.take::<32>(name)?).into_string())
    }

    fn string(&mut self, name: &str, max: usize) -> Result<String, String> {
        let len = u32::from_le_bytes(self.take(name)?) as usize;
        if len > max {
            return Err(format!("Pump {name} exceeds {max} bytes"));
        }
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| format!("Pump {name} offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| format!("Pump {name} is truncated"))?;
        self.offset = end;
        str::from_utf8(bytes)
            .map(str::to_string)
            .map_err(|_| format!("Pump {name} is not UTF-8"))
    }

    fn finish(&self, name: &str) -> Result<(), String> {
        if self.offset != self.bytes.len() {
            return Err(format!("Pump {name} event has trailing bytes"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::{
        ChainOccurrence, Commitment, Network, ProviderObservation, SignedTxId, FERVOR_TX_VERSION,
    };

    fn key(seed: u8) -> String {
        bs58::encode([seed; 32]).into_string()
    }

    fn bytes(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn push_string(target: &mut Vec<u8>, value: &str) {
        target.extend_from_slice(&(value.len() as u32).to_le_bytes());
        target.extend_from_slice(value.as_bytes());
    }

    fn cpi(outer: u32, inner: u32, program_index: u32, event: [u8; 8], body: Vec<u8>) -> TxIx {
        let mut data = SELF_CPI.to_vec();
        data.extend_from_slice(&event);
        data.extend_from_slice(&body);
        TxIx {
            outer_index: outer,
            inner_index: Some(inner),
            stack_height: Some(2),
            program_index,
            accounts: Vec::new(),
            data,
        }
    }

    fn outer(index: u32, program_index: u32, data: Vec<u8>, accounts: Vec<u32>) -> TxIx {
        TxIx {
            outer_index: index,
            inner_index: None,
            stack_height: None,
            program_index,
            accounts,
            data,
        }
    }

    fn sample() -> FervorTx {
        let mint = bytes(2);
        let curve = bytes(3);
        let user = bytes(4);

        let mut create = Vec::new();
        push_string(&mut create, "QUANT");
        push_string(&mut create, "QUANT");
        push_string(&mut create, "https://example.invalid/quant.json");
        create.extend_from_slice(&mint);
        create.extend_from_slice(&curve);
        create.extend_from_slice(&user);
        create.extend_from_slice(&1_732_076_908_i64.to_le_bytes());

        let mut trade = Vec::new();
        trade.extend_from_slice(&mint);
        trade.extend_from_slice(&1_000_000_000_u64.to_le_bytes());
        trade.extend_from_slice(&10_000_000_u64.to_le_bytes());
        trade.push(1);
        trade.extend_from_slice(&user);
        trade.extend_from_slice(&1_732_076_909_i64.to_le_bytes());
        trade.extend_from_slice(&31_000_000_000_u64.to_le_bytes());
        trade.extend_from_slice(&1_000_000_000_000_000_u64.to_le_bytes());
        trade.extend_from_slice(&1_000_000_000_u64.to_le_bytes());
        trade.extend_from_slice(&0_u64.to_le_bytes());

        let mut complete = Vec::new();
        complete.extend_from_slice(&user);
        complete.extend_from_slice(&mint);
        complete.extend_from_slice(&curve);
        complete.extend_from_slice(&1_732_076_909_i64.to_le_bytes());

        let mut init = vec![20, 6];
        init.extend_from_slice(&[0; 33]);
        let mut mint_to = vec![7];
        mint_to.extend_from_slice(&1_000_000_000_000_000_u64.to_le_bytes());

        let pump = 4;
        let token = 5;
        let instructions = vec![
            outer(0, pump, vec![0; 8], vec![]),
            TxIx {
                outer_index: 0,
                inner_index: Some(0),
                stack_height: Some(2),
                program_index: token,
                accounts: vec![1],
                data: init,
            },
            TxIx {
                outer_index: 0,
                inner_index: Some(1),
                stack_height: Some(2),
                program_index: token,
                accounts: vec![1],
                data: mint_to,
            },
            TxIx {
                outer_index: 0,
                inner_index: Some(2),
                stack_height: Some(2),
                program_index: token,
                accounts: vec![1],
                data: vec![6, 0, 0],
            },
            cpi(0, 3, pump, CREATE_EVENT, create),
            outer(1, pump, vec![0; 8], vec![]),
            cpi(1, 0, pump, TRADE_EVENT, trade),
            cpi(1, 1, pump, COMPLETE_EVENT, complete),
            outer(2, pump, WITHDRAW_IX.to_vec(), vec![0, 0, 1, 2, 0, 0, 3]),
        ];
        let keys = vec![
            key(1),
            key(2),
            key(3),
            key(4),
            PUMP_PROGRAM.to_string(),
            TOKEN_PROGRAM.to_string(),
        ];
        FervorTx {
            version: FERVOR_TX_VERSION,
            signed_id: SignedTxId {
                network: Network::MainnetBeta,
                signature: bs58::encode([9_u8; 64]).into_string(),
            },
            occurrence: ChainOccurrence {
                network: Network::MainnetBeta,
                slot: 42,
                block_id: None,
                parent_slot: Some(41),
                tx_index: Some(7),
            },
            observation: ProviderObservation {
                provider: "test_source".to_string(),
                source_event_id: "pump-event-test".to_string(),
                wire_format: "test-wire".to_string(),
                wire_version: 1,
                raw_hash: "a".repeat(64),
            },
            commitment: Commitment::Finalized,
            observed_at: "2024-11-20T03:48:29Z".to_string(),
            error: None,
            static_keys: keys.clone(),
            loaded_writable: Vec::new(),
            loaded_readonly: Vec::new(),
            instructions,
            pre_balances: vec![0; keys.len()],
            post_balances: vec![0; keys.len()],
            pre_tokens: Vec::new(),
            post_tokens: Vec::new(),
            fee: 5_000,
            compute_units: Some(100_000),
            block_time: Some(1_732_076_909),
            signed_tx: None,
        }
    }

    #[test]
    fn reconstructs_fixed_supply_curve_lifecycle() {
        let tx = sample();
        let events = decode_pump_events(&tx).unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(
            events.iter().map(PumpEvent::mint).collect::<Vec<_>>(),
            vec![key(2); 4]
        );

        let state = PumpState::reconstruct(&key(2), &events).unwrap();
        assert_eq!(state.phase, PumpPhase::Migrated);
        assert_eq!(state.supply_raw, 1_000_000_000_000_000);
        assert_eq!(state.decimals, 6);
        assert_eq!(state.trade_count, 1);
        assert_eq!(state.real_token_raw, Some(0));
        assert_eq!(state.price_sol.as_deref(), Some("0.000000031000000000"));
        assert_eq!(state.fdv_sol.as_deref(), Some("31.000000000000000000"));

        let json = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(json["type"], "create");
        assert_eq!(json["supplyRaw"], "1000000000000000");
    }

    #[test]
    fn rejects_changed_known_event_layout() {
        let mut tx = sample();
        let trade = tx
            .instructions
            .iter_mut()
            .find(|ix| {
                ix.data
                    .starts_with(&[SELF_CPI.as_slice(), TRADE_EVENT.as_slice()].concat())
            })
            .unwrap();
        trade.data.push(0);
        assert!(matches!(
            decode_pump_events(&tx),
            Err(Quarantine {
                reason: QuarantineReason::UnsupportedWire,
                ..
            })
        ));
    }

    #[test]
    fn rejects_create_event_with_newer_creator_field() {
        let mut tx = sample();
        let create = tx
            .instructions
            .iter_mut()
            .find(|ix| {
                ix.data
                    .starts_with(&[SELF_CPI.as_slice(), CREATE_EVENT.as_slice()].concat())
            })
            .unwrap();
        let timestamp = create.data.split_off(create.data.len() - 8);
        create.data.extend_from_slice(&bytes(5));
        create.data.extend_from_slice(&timestamp);
        assert!(matches!(
            decode_pump_events(&tx),
            Err(Quarantine {
                reason: QuarantineReason::UnsupportedWire,
                ..
            })
        ));
    }

    #[test]
    fn mutable_supply_cannot_become_qualified_state() {
        let mut tx = sample();
        tx.instructions
            .iter_mut()
            .find(|ix| ix.data == [6, 0, 0])
            .unwrap()
            .data = vec![6, 0, 1, 7];
        let events = decode_pump_events(&tx).unwrap();
        assert!(PumpState::reconstruct(&key(2), &events)
            .unwrap_err()
            .to_string()
            .contains("fixed supply"));
    }

    #[test]
    fn failed_transactions_do_not_mutate_lifecycle_state() {
        let mut tx = sample();
        tx.error = Some(b"InstructionError(2, Custom(1))".to_vec());
        assert!(decode_pump_events(&tx).unwrap().is_empty());
    }
}
