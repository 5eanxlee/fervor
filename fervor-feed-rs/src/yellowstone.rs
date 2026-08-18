use crate::fervor_tx::{
    AdaptResult, CapState, ChainOccurrence, FervorTx, Network, ProviderObservation, Quarantine,
    QuarantineReason, RawEnvelope, SignedTxId, SourceAdapter, SourceCaps, SourceError,
    TokenBalance, TxIx, FERVOR_TX_VERSION,
};
use prost::Message as ProstMessage;
use std::collections::HashSet;
use yellowstone_grpc_proto::prelude::{
    SubscribeUpdateTransaction, TokenBalance as YellowstoneBalance,
};

pub const WIRE_FORMAT: &str = "yellowstone-protobuf-v12";
pub const WIRE_VERSION: u16 = 12;

pub struct YellowstoneAdapter {
    provider: String,
    network: Network,
}

impl YellowstoneAdapter {
    pub fn new(provider: String, network: Network) -> Result<Self, SourceError> {
        if provider.is_empty()
            || provider.len() > 32
            || !provider.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
            })
        {
            return Err(SourceError("Yellowstone provider is invalid".to_string()));
        }
        Ok(Self { provider, network })
    }
}

impl SourceAdapter for YellowstoneAdapter {
    type Native = SubscribeUpdateTransaction;

    fn caps(&self) -> SourceCaps {
        SourceCaps {
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
        }
    }

    fn adapt(&self, raw: RawEnvelope, native: &Self::Native) -> AdaptResult {
        let result = self.map(&raw, native);
        result.map_err(|(reason, detail)| Quarantine::from_raw(&raw, reason, detail))
    }
}

type MapError = (QuarantineReason, String);

impl YellowstoneAdapter {
    fn map(
        &self,
        raw: &RawEnvelope,
        native: &SubscribeUpdateTransaction,
    ) -> Result<FervorTx, MapError> {
        raw.validate()
            .map_err(|error| (QuarantineReason::InvalidEnvelope, error.to_string()))?;
        if raw.provider != self.provider || raw.network != self.network {
            return Err((
                QuarantineReason::InvalidEnvelope,
                "raw envelope source differs from the adapter".to_string(),
            ));
        }
        if raw.wire_format != WIRE_FORMAT || raw.wire_version != WIRE_VERSION {
            return Err((
                QuarantineReason::UnsupportedWire,
                format!("unsupported wire {} v{}", raw.wire_format, raw.wire_version),
            ));
        }
        if raw.payload != native.encode_to_vec() {
            return Err((
                QuarantineReason::RawMismatch,
                "raw envelope bytes differ from the native transaction".to_string(),
            ));
        }
        if raw.slot != native.slot {
            return Err((
                QuarantineReason::InvalidIdentity,
                "raw envelope slot differs from the native transaction".to_string(),
            ));
        }

        let info = native.transaction.as_ref().ok_or_else(|| {
            (
                QuarantineReason::MissingField,
                "Yellowstone transaction info is missing".to_string(),
            )
        })?;
        if info.signature.len() != 64 {
            return Err((
                QuarantineReason::InvalidIdentity,
                "Yellowstone signature must contain 64 bytes".to_string(),
            ));
        }
        let signature = bs58::encode(&info.signature).into_string();
        if signature != raw.signature {
            return Err((
                QuarantineReason::InvalidIdentity,
                "raw envelope signature differs from the native transaction".to_string(),
            ));
        }
        let transaction = info.transaction.as_ref().ok_or_else(|| {
            (
                QuarantineReason::MissingField,
                "Yellowstone transaction body is missing".to_string(),
            )
        })?;
        let message = transaction.message.as_ref().ok_or_else(|| {
            (
                QuarantineReason::MissingField,
                "Yellowstone transaction message is missing".to_string(),
            )
        })?;
        let meta = info.meta.as_ref().ok_or_else(|| {
            (
                QuarantineReason::MissingField,
                "Yellowstone transaction metadata is missing".to_string(),
            )
        })?;
        let header = message.header.as_ref().ok_or_else(|| {
            (
                QuarantineReason::MissingField,
                "Yellowstone transaction header is missing".to_string(),
            )
        })?;
        if transaction.signatures.is_empty()
            || transaction.signatures.iter().any(|value| value.len() != 64)
            || transaction.signatures.first() != Some(&info.signature)
            || transaction.signatures.len() != header.num_required_signatures as usize
        {
            return Err((
                QuarantineReason::InvalidIdentity,
                "Yellowstone transaction signatures are inconsistent".to_string(),
            ));
        }
        let required = header.num_required_signatures as usize;
        if required > message.account_keys.len()
            || header.num_readonly_signed_accounts as usize > required
            || header.num_readonly_unsigned_accounts as usize
                > message.account_keys.len().saturating_sub(required)
            || message.recent_blockhash.len() != 32
            || (!message.versioned && !message.address_table_lookups.is_empty())
            || message
                .address_table_lookups
                .iter()
                .any(|lookup| lookup.account_key.len() != 32)
        {
            return Err((
                QuarantineReason::InvalidIdentity,
                "Yellowstone transaction message is invalid".to_string(),
            ));
        }
        let writable = message
            .address_table_lookups
            .iter()
            .map(|lookup| lookup.writable_indexes.len())
            .sum::<usize>();
        let readonly = message
            .address_table_lookups
            .iter()
            .map(|lookup| lookup.readonly_indexes.len())
            .sum::<usize>();
        if writable != meta.loaded_writable_addresses.len()
            || readonly != meta.loaded_readonly_addresses.len()
        {
            return Err((
                QuarantineReason::InvalidIdentity,
                "Yellowstone loaded addresses differ from message lookups".to_string(),
            ));
        }
        let mut inner_groups = HashSet::new();
        if meta.inner_instructions.iter().any(|value| {
            value.index as usize >= message.instructions.len() || !inner_groups.insert(value.index)
        }) {
            return Err((
                QuarantineReason::InvalidIdentity,
                "Yellowstone inner instruction groups are invalid".to_string(),
            ));
        }

        let mut instructions = Vec::with_capacity(
            message.instructions.len()
                + meta
                    .inner_instructions
                    .iter()
                    .map(|value| value.instructions.len())
                    .sum::<usize>(),
        );
        for (outer, instruction) in message.instructions.iter().enumerate() {
            instructions.push(TxIx {
                outer_index: outer as u32,
                inner_index: None,
                stack_height: None,
                program_index: instruction.program_id_index,
                accounts: instruction
                    .accounts
                    .iter()
                    .map(|value| u32::from(*value))
                    .collect(),
                data: instruction.data.clone(),
            });
            if let Some(inner) = meta
                .inner_instructions
                .iter()
                .find(|value| value.index as usize == outer)
            {
                instructions.extend(inner.instructions.iter().enumerate().map(
                    |(index, instruction)| {
                        TxIx {
                            outer_index: outer as u32,
                            inner_index: Some(index as u32),
                            stack_height: instruction.stack_height,
                            program_index: instruction.program_id_index,
                            accounts: instruction
                                .accounts
                                .iter()
                                .map(|value| u32::from(*value))
                                .collect(),
                            data: instruction.data.clone(),
                        }
                    },
                ));
            }
        }

        let tx = FervorTx {
            version: FERVOR_TX_VERSION,
            signed_id: SignedTxId {
                network: self.network,
                signature,
            },
            occurrence: ChainOccurrence {
                network: self.network,
                slot: native.slot,
                block_id: None,
                parent_slot: None,
                tx_index: Some(info.index),
            },
            observation: ProviderObservation {
                provider: raw.provider.clone(),
                source_event_id: raw.source_event_id.clone(),
                wire_format: raw.wire_format.clone(),
                wire_version: raw.wire_version,
                raw_hash: raw.raw_hash.clone(),
            },
            commitment: raw.commitment,
            observed_at: raw.observed_at.clone(),
            error: meta.err.as_ref().map(|error| error.err.clone()),
            static_keys: map_keys(&message.account_keys)?,
            loaded_writable: map_keys(&meta.loaded_writable_addresses)?,
            loaded_readonly: map_keys(&meta.loaded_readonly_addresses)?,
            instructions,
            pre_balances: meta.pre_balances.clone(),
            post_balances: meta.post_balances.clone(),
            pre_tokens: map_balances(&meta.pre_token_balances)?,
            post_tokens: map_balances(&meta.post_token_balances)?,
            fee: meta.fee,
            compute_units: meta.compute_units_consumed,
            block_time: None,
            signed_tx: None,
        };
        tx.validate()
            .map_err(|error| (QuarantineReason::InvalidIdentity, error.to_string()))?;
        Ok(tx)
    }
}

fn map_keys(keys: &[Vec<u8>]) -> Result<Vec<String>, MapError> {
    keys.iter()
        .map(|key| {
            if key.len() != 32 {
                return Err((
                    QuarantineReason::InvalidIdentity,
                    "Yellowstone account key must contain 32 bytes".to_string(),
                ));
            }
            Ok(bs58::encode(key).into_string())
        })
        .collect()
}

fn map_balances(values: &[YellowstoneBalance]) -> Result<Vec<TokenBalance>, MapError> {
    let mut balances = values
        .iter()
        .map(|value| {
            let amount = value.ui_token_amount.as_ref().ok_or_else(|| {
                (
                    QuarantineReason::MissingField,
                    "Yellowstone token amount is missing".to_string(),
                )
            })?;
            amount.amount.parse::<u64>().map_err(|_| {
                (
                    QuarantineReason::InvalidIdentity,
                    "Yellowstone token amount is outside the u64 domain".to_string(),
                )
            })?;
            Ok(TokenBalance {
                account_index: value.account_index,
                mint: value.mint.clone(),
                owner: (!value.owner.is_empty()).then(|| value.owner.clone()),
                program_id: (!value.program_id.is_empty()).then(|| value.program_id.clone()),
                raw_amount: amount.amount.clone(),
                decimals: amount.decimals,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    balances.sort_unstable_by_key(|value| value.account_index);
    Ok(balances)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::Commitment;
    use yellowstone_grpc_proto::prelude::{
        CompiledInstruction, Message, MessageHeader, SubscribeUpdateTransactionInfo, Transaction,
        TransactionStatusMeta, UiTokenAmount,
    };

    fn native() -> SubscribeUpdateTransaction {
        let trader = vec![1; 32];
        let owner = bs58::encode(&trader).into_string();
        let mint = bs58::encode([8_u8; 32]).into_string();
        SubscribeUpdateTransaction {
            slot: 42,
            transaction: Some(SubscribeUpdateTransactionInfo {
                signature: vec![9; 64],
                transaction: Some(Transaction {
                    signatures: vec![vec![9; 64]],
                    message: Some(Message {
                        header: Some(MessageHeader {
                            num_required_signatures: 1,
                            ..Default::default()
                        }),
                        account_keys: vec![trader, vec![2; 32]],
                        recent_blockhash: vec![4; 32],
                        instructions: vec![CompiledInstruction {
                            program_id_index: 1,
                            accounts: vec![0],
                            data: vec![3],
                        }],
                        ..Default::default()
                    }),
                }),
                meta: Some(TransactionStatusMeta {
                    pre_balances: vec![10, 0],
                    post_balances: vec![9, 0],
                    pre_token_balances: vec![YellowstoneBalance {
                        account_index: 0,
                        mint: mint.clone(),
                        owner: owner.clone(),
                        program_id: bs58::encode([7_u8; 32]).into_string(),
                        ui_token_amount: Some(UiTokenAmount {
                            amount: "1".to_string(),
                            decimals: 0,
                            ..Default::default()
                        }),
                    }],
                    post_token_balances: vec![YellowstoneBalance {
                        account_index: 0,
                        mint,
                        owner,
                        program_id: bs58::encode([7_u8; 32]).into_string(),
                        ui_token_amount: Some(UiTokenAmount {
                            amount: "2".to_string(),
                            decimals: 0,
                            ..Default::default()
                        }),
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            }),
        }
    }

    fn raw(native: &SubscribeUpdateTransaction) -> RawEnvelope {
        let signature = bs58::encode(&native.transaction.as_ref().unwrap().signature).into_string();
        RawEnvelope::new(
            "helius_laserstream".to_string(),
            WIRE_FORMAT.to_string(),
            WIRE_VERSION,
            format!("event:{signature}"),
            "a".repeat(64),
            Network::MainnetBeta,
            Commitment::Confirmed,
            native.slot,
            signature,
            vec!["swaps".to_string()],
            "2024-11-19T00:00:00Z".to_string(),
            native.encode_to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn maps_native_bytes_without_loss() {
        let native = native();
        let raw = raw(&native);
        let expected = raw.payload.clone();
        let adapter =
            YellowstoneAdapter::new("helius_laserstream".to_string(), Network::MainnetBeta)
                .unwrap();
        let tx = adapter.adapt(raw, &native).unwrap();
        assert_eq!(native.encode_to_vec(), expected);
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/contracts/fervor-tx-v1.json")).unwrap();
        assert_eq!(serde_json::to_value(&tx).unwrap(), golden);
        assert_eq!(tx.version, FERVOR_TX_VERSION);
        assert_eq!(tx.occurrence.tx_index, Some(0));
        assert_eq!(tx.occurrence.block_id, None);
        assert_eq!(tx.pre_tokens[0].raw_amount, "1");
    }

    #[test]
    fn rejects_unknown_wire_and_raw_mismatch() {
        let update = native();
        let adapter =
            YellowstoneAdapter::new("helius_laserstream".to_string(), Network::MainnetBeta)
                .unwrap();
        let mut unknown = raw(&update);
        unknown.wire_version += 1;
        assert_eq!(
            adapter.adapt(unknown, &update).unwrap_err().reason,
            QuarantineReason::UnsupportedWire
        );

        let changed = raw(&update);
        let mut changed_native = update.clone();
        changed_native.slot += 1;
        assert_eq!(
            adapter.adapt(changed, &changed_native).unwrap_err().reason,
            QuarantineReason::RawMismatch
        );

        let mut inconsistent = native();
        inconsistent
            .transaction
            .as_mut()
            .unwrap()
            .transaction
            .as_mut()
            .unwrap()
            .signatures[0] = vec![8; 64];
        let matching_raw = raw(&inconsistent);
        assert_eq!(
            adapter
                .adapt(matching_raw, &inconsistent)
                .unwrap_err()
                .reason,
            QuarantineReason::InvalidIdentity
        );
    }
}
