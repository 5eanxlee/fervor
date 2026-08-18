use chrono::DateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, error::Error, fmt, str::FromStr};

pub const FERVOR_TX_VERSION: u16 = 1;

pub(crate) mod u64_text {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

pub(crate) mod opt_u64_text {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse().map_err(D::Error::custom))
            .transpose()
    }
}

mod opt_i64_text {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse().map_err(D::Error::custom))
            .transpose()
    }
}

mod u64_vec {
    use serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &[u64], serializer: S) -> Result<S::Ok, S::Error> {
        value
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
        Vec::<String>::deserialize(deserializer)?
            .into_iter()
            .map(|value| value.parse().map_err(D::Error::custom))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Network {
    #[serde(rename = "mainnet-beta")]
    MainnetBeta,
    #[serde(rename = "devnet")]
    Devnet,
    #[serde(rename = "testnet")]
    Testnet,
    #[serde(rename = "localnet")]
    Localnet,
}

impl Network {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MainnetBeta => "mainnet-beta",
            Self::Devnet => "devnet",
            Self::Testnet => "testnet",
            Self::Localnet => "localnet",
        }
    }
}

impl FromStr for Network {
    type Err = SourceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "mainnet-beta" => Ok(Self::MainnetBeta),
            "devnet" => Ok(Self::Devnet),
            "testnet" => Ok(Self::Testnet),
            "localnet" => Ok(Self::Localnet),
            _ => Err(SourceError(format!("unsupported Solana network: {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Commitment {
    Processed,
    Confirmed,
    Finalized,
}

impl Commitment {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Processed => "processed",
            Self::Confirmed => "confirmed",
            Self::Finalized => "finalized",
        }
    }
}

impl FromStr for Commitment {
    type Err = SourceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "processed" => Ok(Self::Processed),
            "confirmed" => Ok(Self::Confirmed),
            "finalized" => Ok(Self::Finalized),
            _ => Err(SourceError(format!("unsupported commitment: {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapState {
    Supported,
    Unsupported,
    NotObservable,
    NotApplicable,
}

impl CapState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Unsupported => "unsupported",
            Self::NotObservable => "not observable",
            Self::NotApplicable => "not applicable",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceCap {
    Transactions,
    Accounts,
    SlotParent,
    Processed,
    Confirmed,
    Finalized,
    Retractions,
    Resume,
    History,
    RawPayload,
    TxIndex,
    BlockTime,
    BlockId,
    SignedTx,
}

impl SourceCap {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Transactions => "transactions",
            Self::Accounts => "accounts",
            Self::SlotParent => "slot_parent",
            Self::Processed => "processed",
            Self::Confirmed => "confirmed",
            Self::Finalized => "finalized",
            Self::Retractions => "retractions",
            Self::Resume => "resume",
            Self::History => "history",
            Self::RawPayload => "raw_payload",
            Self::TxIndex => "tx_index",
            Self::BlockTime => "block_time",
            Self::BlockId => "block_id",
            Self::SignedTx => "signed_tx",
        }
    }
}

impl Commitment {
    pub const fn cap(self) -> SourceCap {
        match self {
            Self::Processed => SourceCap::Processed,
            Self::Confirmed => SourceCap::Confirmed,
            Self::Finalized => SourceCap::Finalized,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCaps {
    pub transactions: CapState,
    pub accounts: CapState,
    pub slot_parent: CapState,
    pub processed: CapState,
    pub confirmed: CapState,
    pub finalized: CapState,
    pub retractions: CapState,
    pub resume: CapState,
    pub history: CapState,
    pub raw_payload: CapState,
    pub tx_index: CapState,
    pub block_time: CapState,
    pub block_id: CapState,
    pub signed_tx: CapState,
}

impl SourceCaps {
    pub const fn state(self, cap: SourceCap) -> CapState {
        match cap {
            SourceCap::Transactions => self.transactions,
            SourceCap::Accounts => self.accounts,
            SourceCap::SlotParent => self.slot_parent,
            SourceCap::Processed => self.processed,
            SourceCap::Confirmed => self.confirmed,
            SourceCap::Finalized => self.finalized,
            SourceCap::Retractions => self.retractions,
            SourceCap::Resume => self.resume,
            SourceCap::History => self.history,
            SourceCap::RawPayload => self.raw_payload,
            SourceCap::TxIndex => self.tx_index,
            SourceCap::BlockTime => self.block_time,
            SourceCap::BlockId => self.block_id,
            SourceCap::SignedTx => self.signed_tx,
        }
    }

    pub fn require(self, needed: &[SourceCap]) -> Result<(), SourceError> {
        let missing = needed
            .iter()
            .filter_map(|cap| {
                let state = self.state(*cap);
                (state != CapState::Supported)
                    .then(|| format!("{} ({})", cap.as_str(), state.as_str()))
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(SourceError(format!(
                "source lacks required capabilities: {}",
                missing.join(", ")
            )))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceError(pub String);

impl fmt::Display for SourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for SourceError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEnvelope {
    pub provider: String,
    pub wire_format: String,
    pub wire_version: u16,
    pub source_event_id: String,
    pub subscription_id: String,
    pub network: Network,
    pub commitment: Commitment,
    #[serde(with = "u64_text")]
    pub slot: u64,
    pub signature: String,
    pub filters: Vec<String>,
    pub observed_at: String,
    pub raw_hash: String,
    pub payload: Vec<u8>,
}

impl RawEnvelope {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: String,
        wire_format: String,
        wire_version: u16,
        source_event_id: String,
        subscription_id: String,
        network: Network,
        commitment: Commitment,
        slot: u64,
        signature: String,
        filters: Vec<String>,
        observed_at: String,
        payload: Vec<u8>,
    ) -> Result<Self, SourceError> {
        let raw_hash = hex::encode(Sha256::digest(&payload));
        let raw = Self {
            provider,
            wire_format,
            wire_version,
            source_event_id,
            subscription_id,
            network,
            commitment,
            slot,
            signature,
            filters,
            observed_at,
            raw_hash,
            payload,
        };
        raw.validate()?;
        Ok(raw)
    }

    pub fn validate(&self) -> Result<(), SourceError> {
        for (name, value, max_len) in [
            ("provider", self.provider.as_str(), 32),
            ("wire_format", self.wire_format.as_str(), 40),
            ("source_event_id", self.source_event_id.as_str(), 180),
            ("subscription_id", self.subscription_id.as_str(), 64),
            ("signature", self.signature.as_str(), 88),
        ] {
            if value.trim().is_empty() {
                return Err(SourceError(format!("raw envelope {name} is empty")));
            }
            if value.len() > max_len {
                return Err(SourceError(format!("raw envelope {name} is too long")));
            }
        }
        if self.wire_version == 0 {
            return Err(SourceError("raw envelope wire_version is zero".to_string()));
        }
        if !valid_provider(&self.provider) {
            return Err(SourceError("raw envelope provider is invalid".to_string()));
        }
        if self.payload.is_empty() || self.payload.len() > 4 * 1024 * 1024 {
            return Err(SourceError(
                "raw envelope payload is outside the journal limit".to_string(),
            ));
        }
        if self.subscription_id.len() != 64
            || !self
                .subscription_id
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
        {
            return Err(SourceError(
                "raw envelope subscription_id is invalid".to_string(),
            ));
        }
        DateTime::parse_from_rfc3339(&self.observed_at)
            .map_err(|_| SourceError("raw envelope observed_at is not RFC 3339".to_string()))?;
        if bs58::decode(&self.signature)
            .into_vec()
            .map_or(true, |value| value.len() != 64)
        {
            return Err(SourceError("raw envelope signature is invalid".to_string()));
        }
        let expected = hex::encode(Sha256::digest(&self.payload));
        if self.raw_hash != expected {
            return Err(SourceError(
                "raw envelope hash differs from its payload".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedTxId {
    pub network: Network,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainOccurrence {
    pub network: Network,
    #[serde(with = "u64_text")]
    pub slot: u64,
    pub block_id: Option<String>,
    #[serde(with = "opt_u64_text")]
    pub parent_slot: Option<u64>,
    #[serde(with = "opt_u64_text")]
    pub tx_index: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderObservation {
    pub provider: String,
    pub source_event_id: String,
    pub wire_format: String,
    pub wire_version: u16,
    pub raw_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxIx {
    pub outer_index: u32,
    pub inner_index: Option<u32>,
    pub stack_height: Option<u32>,
    pub program_index: u32,
    pub accounts: Vec<u32>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalance {
    pub account_index: u32,
    pub mint: String,
    pub owner: Option<String>,
    pub program_id: Option<String>,
    pub raw_amount: String,
    pub decimals: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FervorTx {
    pub version: u16,
    pub signed_id: SignedTxId,
    pub occurrence: ChainOccurrence,
    pub observation: ProviderObservation,
    pub commitment: Commitment,
    pub observed_at: String,
    pub error: Option<Vec<u8>>,
    pub static_keys: Vec<String>,
    pub loaded_writable: Vec<String>,
    pub loaded_readonly: Vec<String>,
    pub instructions: Vec<TxIx>,
    #[serde(with = "u64_vec")]
    pub pre_balances: Vec<u64>,
    #[serde(with = "u64_vec")]
    pub post_balances: Vec<u64>,
    pub pre_tokens: Vec<TokenBalance>,
    pub post_tokens: Vec<TokenBalance>,
    #[serde(with = "u64_text")]
    pub fee: u64,
    #[serde(with = "opt_u64_text")]
    pub compute_units: Option<u64>,
    #[serde(with = "opt_i64_text")]
    pub block_time: Option<i64>,
    pub signed_tx: Option<Vec<u8>>,
}

impl FervorTx {
    pub fn validate(&self) -> Result<(), SourceError> {
        if self.version != FERVOR_TX_VERSION {
            return Err(SourceError(format!(
                "unsupported FervorTx version {}",
                self.version
            )));
        }
        if self.signed_id.network != self.occurrence.network {
            return Err(SourceError(
                "transaction identity networks differ".to_string(),
            ));
        }
        if bs58::decode(&self.signed_id.signature)
            .into_vec()
            .map_or(true, |value| value.len() != 64)
        {
            return Err(SourceError("transaction signature is invalid".to_string()));
        }
        if self.observation.raw_hash.len() != 64
            || !self
                .observation
                .raw_hash
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
        {
            return Err(SourceError("transaction raw hash is invalid".to_string()));
        }
        if self.static_keys.is_empty() {
            return Err(SourceError(
                "transaction has no static account keys".to_string(),
            ));
        }
        if !valid_provider(&self.observation.provider)
            || self.observation.source_event_id.trim().is_empty()
            || self.observation.source_event_id.len() > 180
            || self.observation.wire_format.trim().is_empty()
            || self.observation.wire_format.len() > 40
            || self.observation.wire_version == 0
        {
            return Err(SourceError(
                "transaction provenance is incomplete".to_string(),
            ));
        }
        DateTime::parse_from_rfc3339(&self.observed_at)
            .map_err(|_| SourceError("transaction observed_at is not RFC 3339".to_string()))?;
        let keys = self
            .static_keys
            .iter()
            .chain(&self.loaded_writable)
            .chain(&self.loaded_readonly)
            .collect::<Vec<_>>();
        if keys.len() > 256 {
            return Err(SourceError(
                "transaction has more than 256 account keys".to_string(),
            ));
        }
        if keys.iter().any(|key| {
            bs58::decode(key)
                .into_vec()
                .map_or(true, |value| value.len() != 32)
        }) {
            return Err(SourceError(
                "transaction contains an invalid account key".to_string(),
            ));
        }
        if keys.iter().copied().collect::<HashSet<_>>().len() != keys.len() {
            return Err(SourceError(
                "transaction account keys are not unique".to_string(),
            ));
        }
        if self.pre_balances.len() != keys.len() || self.post_balances.len() != keys.len() {
            return Err(SourceError(
                "transaction balance vectors do not match its account keys".to_string(),
            ));
        }
        if self.instructions.iter().any(|ix| {
            ix.program_index as usize >= keys.len()
                || ix
                    .accounts
                    .iter()
                    .any(|index| *index as usize >= keys.len())
                || (ix.inner_index.is_none() && ix.stack_height.is_some())
        }) {
            return Err(SourceError(
                "transaction instruction references an unknown account".to_string(),
            ));
        }
        let mut next_outer = 0_u32;
        let mut active_outer = None;
        let mut next_inner = 0_u32;
        for ix in &self.instructions {
            match ix.inner_index {
                None if ix.outer_index == next_outer => {
                    active_outer = Some(ix.outer_index);
                    next_outer = next_outer.checked_add(1).ok_or_else(|| {
                        SourceError("transaction outer instruction index overflowed".to_string())
                    })?;
                    next_inner = 0;
                }
                Some(index) if active_outer == Some(ix.outer_index) && index == next_inner => {
                    next_inner = next_inner.checked_add(1).ok_or_else(|| {
                        SourceError("transaction inner instruction index overflowed".to_string())
                    })?;
                }
                _ => {
                    return Err(SourceError(
                        "transaction instruction order is not canonical".to_string(),
                    ));
                }
            }
        }
        if self
            .pre_tokens
            .iter()
            .chain(&self.post_tokens)
            .any(|balance| {
                balance.account_index as usize >= keys.len()
                    || balance.raw_amount.parse::<u64>().is_err()
                    || balance.decimals > u8::MAX.into()
                    || !valid_address(&balance.mint)
                    || balance
                        .owner
                        .as_ref()
                        .is_some_and(|value| !valid_address(value))
                    || balance
                        .program_id
                        .as_ref()
                        .is_some_and(|value| !valid_address(value))
            })
        {
            return Err(SourceError(
                "transaction token balance is invalid".to_string(),
            ));
        }
        for balances in [&self.pre_tokens, &self.post_tokens] {
            if balances
                .windows(2)
                .any(|pair| pair[0].account_index >= pair[1].account_index)
            {
                return Err(SourceError(
                    "transaction token balances are not canonically ordered".to_string(),
                ));
            }
        }
        if self
            .occurrence
            .block_id
            .as_ref()
            .is_some_and(|value| !valid_address(value))
        {
            return Err(SourceError(
                "transaction block identity is invalid".to_string(),
            ));
        }
        if self.error.as_ref().is_some_and(Vec::is_empty) {
            return Err(SourceError(
                "transaction execution error bytes are empty".to_string(),
            ));
        }
        if self.signed_tx.as_ref().is_some_and(Vec::is_empty) {
            return Err(SourceError(
                "signed transaction bytes are empty".to_string(),
            ));
        }
        Ok(())
    }
}

fn valid_address(value: &str) -> bool {
    bs58::decode(value)
        .into_vec()
        .is_ok_and(|decoded| decoded.len() == 32)
}

fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineReason {
    InvalidEnvelope,
    UnsupportedWire,
    RawMismatch,
    MissingField,
    InvalidIdentity,
    UnsupportedContract,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quarantine {
    pub provider: String,
    pub source_event_id: String,
    pub raw_hash: String,
    pub reason: QuarantineReason,
    pub detail: String,
}

impl Quarantine {
    pub fn from_raw(
        raw: &RawEnvelope,
        reason: QuarantineReason,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            provider: raw.provider.clone(),
            source_event_id: raw.source_event_id.clone(),
            raw_hash: raw.raw_hash.clone(),
            reason,
            detail: detail.into(),
        }
    }

    pub fn from_tx(tx: &FervorTx, reason: QuarantineReason, detail: impl Into<String>) -> Self {
        Self {
            provider: tx.observation.provider.clone(),
            source_event_id: tx.observation.source_event_id.clone(),
            raw_hash: tx.observation.raw_hash.clone(),
            reason,
            detail: detail.into(),
        }
    }
}

pub type AdaptResult = Result<FervorTx, Quarantine>;

pub trait SourceAdapter {
    type Native;

    fn caps(&self) -> SourceCaps;
    fn adapt(&self, raw: RawEnvelope, native: &Self::Native) -> AdaptResult;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_envelope_hashes_and_round_trips_exact_bytes() {
        let raw = RawEnvelope::new(
            "source-a".to_string(),
            "wire-a".to_string(),
            1,
            "event-a".to_string(),
            "a".repeat(64),
            Network::MainnetBeta,
            Commitment::Finalized,
            42,
            bs58::encode([7_u8; 64]).into_string(),
            vec!["filter-a".to_string()],
            "2024-11-19T00:00:00Z".to_string(),
            vec![0, 1, 2, 255],
        )
        .unwrap();
        assert_eq!(
            raw.raw_hash,
            "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56"
        );
        let encoded = serde_json::to_vec(&raw).unwrap();
        let mut decoded: RawEnvelope = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, raw);
        decoded.raw_hash = "0".repeat(64);
        assert!(decoded.validate().is_err());
    }

    #[test]
    fn capability_requirements_fail_closed() {
        let caps = SourceCaps {
            transactions: CapState::Supported,
            accounts: CapState::NotApplicable,
            slot_parent: CapState::NotObservable,
            processed: CapState::Supported,
            confirmed: CapState::Supported,
            finalized: CapState::Supported,
            retractions: CapState::NotObservable,
            resume: CapState::Supported,
            history: CapState::Unsupported,
            raw_payload: CapState::Supported,
            tx_index: CapState::Supported,
            block_time: CapState::NotObservable,
            block_id: CapState::NotObservable,
            signed_tx: CapState::NotObservable,
        };
        assert!(caps.require(&[SourceCap::RawPayload]).is_ok());
        let error = caps
            .require(&[SourceCap::BlockId, SourceCap::Accounts])
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "source lacks required capabilities: block_id (not observable), accounts (not applicable)"
        );
    }

    #[test]
    fn reads_the_shared_v1_contract_fixture() {
        let tx: FervorTx =
            serde_json::from_str(include_str!("../../tests/contracts/fervor-tx-v1.json")).unwrap();
        tx.validate().unwrap();
        assert_eq!(tx.version, FERVOR_TX_VERSION);
        assert_eq!(tx.occurrence.slot, 42);

        let mut reordered = tx;
        reordered.instructions[0].inner_index = Some(0);
        assert_eq!(
            reordered.validate().unwrap_err().to_string(),
            "transaction instruction order is not canonical"
        );
    }
}
