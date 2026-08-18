//! Strict, local-only decoder for bounded Old Faithful OF1 CAR extracts.
//!
//! The wire layout is pinned by [`crate::archive::SourcePin`]. This module keeps
//! the archive boundary small instead of depending on Jetstreamer's validator,
//! RPC, ledger, and RocksDB runtime graph.

use crate::fervor_tx::{
    AdaptResult, CapState, ChainOccurrence, Commitment, FervorTx, Network, ProviderObservation,
    Quarantine, QuarantineReason, RawEnvelope, SignedTxId, SourceAdapter, SourceCaps, SourceError,
    TokenBalance, TxIx, FERVOR_TX_VERSION,
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use cid::Cid;
use crc::{Crc, CRC_64_GO_ISO};
use fnv::FnvHasher;
use prost::Message;
use serde_cbor::Value;
use sha2::{Digest, Sha256};
use solana_transaction::versioned::VersionedTransaction;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    hash::Hasher,
    io::{self, BufReader, Cursor, Read},
    ops::Range,
    path::Path,
};

pub const WIRE_FORMAT: &str = "old-faithful-node-set-v1";
pub const WIRE_VERSION: u16 = 1;

const PROVIDER: &str = "old_faithful";
const DAG_CBOR_CODEC: u64 = 0x71;
const SHA2_256_CODE: u64 = 0x12;
const MAX_CAR_HEADER: u64 = 4 * 1024;
const MAX_CAR_SECTION: u64 = 32 * 1024 * 1024;
const MAX_FRAME_DATA: usize = 16 * 1024 * 1024;
const MAX_META_DATA: usize = 16 * 1024 * 1024;
const RECORD_MAGIC: &[u8] = b"fervor-old-faithful-node-set-v1\0";

pub struct OldFaithfulAdapter {
    corpus_hash: String,
    network: Network,
}

impl OldFaithfulAdapter {
    pub fn new(corpus_hash: String, network: Network) -> Result<Self, SourceError> {
        if !is_sha256(&corpus_hash) {
            return Err(SourceError("Old Faithful corpus hash is invalid".into()));
        }
        Ok(Self {
            corpus_hash,
            network,
        })
    }

    pub fn adapt_record(&self, record: &ArchiveRecord, mint: &str) -> AdaptResult {
        let raw = RawEnvelope::new(
            PROVIDER.into(),
            WIRE_FORMAT.into(),
            WIRE_VERSION,
            record.event_id(),
            self.corpus_hash.clone(),
            self.network,
            Commitment::Finalized,
            record.slot,
            record.signature.clone(),
            vec![format!("mint:{mint}")],
            record.observed_at.clone(),
            record.payload.clone(),
        )
        .map_err(|error| {
            quarantine_record(record, QuarantineReason::InvalidEnvelope, error.to_string())
        })?;
        self.adapt(raw, record)
    }
}

impl SourceAdapter for OldFaithfulAdapter {
    type Native = ArchiveRecord;

    fn caps(&self) -> SourceCaps {
        SourceCaps {
            transactions: CapState::Supported,
            accounts: CapState::NotObservable,
            slot_parent: CapState::Supported,
            processed: CapState::NotApplicable,
            confirmed: CapState::NotApplicable,
            finalized: CapState::Supported,
            retractions: CapState::NotApplicable,
            resume: CapState::Supported,
            history: CapState::Supported,
            raw_payload: CapState::Supported,
            tx_index: CapState::Supported,
            block_time: CapState::Supported,
            block_id: CapState::Supported,
            signed_tx: CapState::Supported,
        }
    }

    fn adapt(&self, raw: RawEnvelope, record: &Self::Native) -> AdaptResult {
        let invalid = |reason, detail| Quarantine::from_raw(&raw, reason, detail);
        raw.validate()
            .map_err(|error| invalid(QuarantineReason::InvalidEnvelope, error.to_string()))?;
        if raw.provider != PROVIDER
            || raw.network != self.network
            || raw.subscription_id != self.corpus_hash
            || raw.wire_format != WIRE_FORMAT
            || raw.wire_version != WIRE_VERSION
        {
            return Err(invalid(
                QuarantineReason::InvalidEnvelope,
                "raw envelope source differs from the Old Faithful adapter".into(),
            ));
        }
        if raw.payload != record.payload {
            return Err(invalid(
                QuarantineReason::RawMismatch,
                "raw envelope bytes differ from the archive record".into(),
            ));
        }
        if raw.slot != record.slot || raw.signature != record.signature {
            return Err(invalid(
                QuarantineReason::InvalidIdentity,
                "raw envelope identity differs from the archive record".into(),
            ));
        }

        let tx = FervorTx {
            version: FERVOR_TX_VERSION,
            signed_id: SignedTxId {
                network: self.network,
                signature: record.signature.clone(),
            },
            occurrence: ChainOccurrence {
                network: self.network,
                slot: record.slot,
                block_id: Some(record.block_id.clone()),
                parent_slot: Some(record.parent_slot),
                tx_index: Some(record.tx_index),
            },
            observation: ProviderObservation {
                provider: raw.provider,
                source_event_id: raw.source_event_id,
                wire_format: raw.wire_format,
                wire_version: raw.wire_version,
                raw_hash: raw.raw_hash,
            },
            commitment: Commitment::Finalized,
            observed_at: record.observed_at.clone(),
            error: record.error.clone(),
            static_keys: record.static_keys.clone(),
            loaded_writable: record.loaded_writable.clone(),
            loaded_readonly: record.loaded_readonly.clone(),
            instructions: record.instructions.clone(),
            pre_balances: record.pre_balances.clone(),
            post_balances: record.post_balances.clone(),
            pre_tokens: record.pre_tokens.clone(),
            post_tokens: record.post_tokens.clone(),
            fee: record.fee,
            compute_units: record.compute_units,
            block_time: Some(record.block_time),
            signed_tx: Some(record.signed_tx.clone()),
        };
        tx.validate().map_err(|error| {
            Quarantine::from_tx(&tx, QuarantineReason::InvalidIdentity, error.to_string())
        })?;
        Ok(tx)
    }
}

#[derive(Clone, Debug)]
pub struct ArchiveRecord {
    slot: u64,
    parent_slot: u64,
    block_id: String,
    block_time: i64,
    tx_index: u64,
    signature: String,
    observed_at: String,
    payload: Vec<u8>,
    error: Option<Vec<u8>>,
    static_keys: Vec<String>,
    loaded_writable: Vec<String>,
    loaded_readonly: Vec<String>,
    instructions: Vec<TxIx>,
    pre_balances: Vec<u64>,
    post_balances: Vec<u64>,
    pre_tokens: Vec<TokenBalance>,
    post_tokens: Vec<TokenBalance>,
    fee: u64,
    compute_units: Option<u64>,
    signed_tx: Vec<u8>,
}

impl ArchiveRecord {
    pub const fn slot(&self) -> u64 {
        self.slot
    }

    pub const fn tx_index(&self) -> u64 {
        self.tx_index
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }

    pub fn references(&self, mint: &str) -> bool {
        self.static_keys
            .iter()
            .chain(&self.loaded_writable)
            .chain(&self.loaded_readonly)
            .any(|key| key == mint)
            || self
                .pre_tokens
                .iter()
                .chain(&self.post_tokens)
                .any(|balance| balance.mint == mint)
    }

    fn event_id(&self) -> String {
        format!("of1:{}:{}:{}", self.slot, self.tx_index, self.signature)
    }
}

fn quarantine_record(
    record: &ArchiveRecord,
    reason: QuarantineReason,
    detail: impl Into<String>,
) -> Quarantine {
    Quarantine {
        provider: PROVIDER.into(),
        source_event_id: record.event_id(),
        raw_hash: hex::encode(Sha256::digest(&record.payload)),
        reason,
        detail: detail.into(),
    }
}

pub struct ArchiveBlock {
    pub slot: u64,
    pub records: Vec<ArchiveRecord>,
}

pub struct ArchiveReader {
    reader: CarReader<BufReader<File>>,
    slots: Range<u64>,
    last_slot: Option<u64>,
}

impl ArchiveReader {
    pub fn open(path: &Path, slots: Range<u64>) -> Result<Self> {
        if slots.start >= slots.end {
            bail!("archive slot range is empty or reversed");
        }
        let file =
            File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
        Ok(Self {
            reader: CarReader::new(BufReader::new(file))?,
            slots,
            last_slot: None,
        })
    }

    pub fn next_block(&mut self) -> Result<Option<ArchiveBlock>> {
        let mut raw_nodes = Vec::new();
        loop {
            let Some(raw) = self.reader.next()? else {
                if raw_nodes.is_empty() {
                    return Ok(None);
                }
                bail!("Old Faithful CAR ended inside a block");
            };
            let is_block = matches!(raw.node, Node::Block(_));
            raw_nodes.push(raw);
            if is_block {
                let block = build_block(raw_nodes)?;
                if !self.slots.contains(&block.slot) {
                    bail!(
                        "CAR produced slot {} outside {}..{}",
                        block.slot,
                        self.slots.start,
                        self.slots.end
                    );
                }
                if self.last_slot.is_some_and(|slot| block.slot <= slot) {
                    bail!("CAR block slots are not strictly increasing");
                }
                self.last_slot = Some(block.slot);
                return Ok(Some(block));
            }
        }
    }
}

struct CarReader<R> {
    reader: R,
}

impl<R: Read> CarReader<R> {
    fn new(mut reader: R) -> Result<Self> {
        let header_len =
            read_uvarint(&mut reader)?.ok_or_else(|| anyhow!("Old Faithful CAR is empty"))?;
        if header_len == 0 || header_len > MAX_CAR_HEADER {
            bail!("CAR header length {header_len} is invalid");
        }
        let mut header = vec![0; usize::try_from(header_len)?];
        reader
            .read_exact(&mut header)
            .context("failed to read CAR header")?;
        validate_car_header(&header)?;
        Ok(Self { reader })
    }

    fn next(&mut self) -> Result<Option<RawNode>> {
        let Some(section_len) = read_uvarint(&mut self.reader)? else {
            return Ok(None);
        };
        if section_len == 0 || section_len > MAX_CAR_SECTION {
            bail!("CAR section length {section_len} is invalid");
        }
        let mut section = vec![0; usize::try_from(section_len)?];
        self.reader
            .read_exact(&mut section)
            .context("CAR ended inside a section")?;
        let mut cursor = Cursor::new(section.as_slice());
        let cid = Cid::read_bytes(&mut cursor).context("CAR section CID is invalid")?;
        let data_at = usize::try_from(cursor.position())?;
        if data_at >= section.len() {
            bail!("CAR section has no DAG-CBOR payload");
        }
        let data = section[data_at..].to_vec();
        validate_cid(&cid, &data)?;
        let node = parse_node(&data)?;
        Ok(Some(RawNode { cid, data, node }))
    }
}

#[derive(Clone, Debug)]
struct RawNode {
    cid: Cid,
    data: Vec<u8>,
    node: Node,
}

#[derive(Clone, Debug)]
enum Node {
    Transaction(ArchiveTx),
    Entry(Entry),
    Block(Block),
    DataFrame(Frame),
    Other(u64),
}

#[derive(Clone, Debug)]
struct ArchiveTx {
    data: Frame,
    metadata: Frame,
    slot: u64,
    index: Option<u64>,
}

#[derive(Clone, Debug)]
struct Entry {
    hash: Vec<u8>,
    transactions: Vec<Cid>,
}

#[derive(Clone, Debug)]
struct Block {
    slot: u64,
    entries: Vec<Cid>,
    parent_slot: u64,
    block_time: u64,
}

#[derive(Clone, Debug)]
struct Frame {
    hash: Option<u64>,
    index: Option<u64>,
    total: Option<u64>,
    data: Vec<u8>,
    next: Vec<Cid>,
}

fn build_block(raw_nodes: Vec<RawNode>) -> Result<ArchiveBlock> {
    let block_node = raw_nodes
        .last()
        .ok_or_else(|| anyhow!("archive block contains no nodes"))?;
    let Node::Block(block) = &block_node.node else {
        bail!("archive group does not end in a block node");
    };
    if raw_nodes[..raw_nodes.len() - 1]
        .iter()
        .any(|raw| matches!(raw.node, Node::Block(_)))
    {
        bail!("archive group contains multiple block nodes");
    }
    if raw_nodes
        .iter()
        .any(|raw| matches!(raw.node, Node::Other(kind) if kind != 5))
    {
        bail!("archive slot contains an epoch-level node");
    }
    if block.parent_slot >= block.slot {
        bail!("block parent slot does not precede its slot");
    }

    let mut positions = HashMap::with_capacity(raw_nodes.len());
    let mut nodes = HashMap::with_capacity(raw_nodes.len());
    for (index, raw) in raw_nodes.iter().enumerate() {
        if positions.insert(raw.cid, index).is_some() {
            bail!("archive block contains duplicate CID {}", raw.cid);
        }
        nodes.insert(raw.cid, &raw.node);
    }

    let block_id = block_hash(block, &nodes)?;
    let block_time = i64::try_from(block.block_time).context("block time exceeds i64")?;
    let observed_at = DateTime::<Utc>::from_timestamp(block_time, 0)
        .ok_or_else(|| anyhow!("block time is outside the supported range"))?
        .to_rfc3339_opts(SecondsFormat::Secs, true);

    let mut records = Vec::new();
    let mut entries = HashSet::new();
    let mut transactions = HashSet::new();
    let mut next_index = 0_u64;
    for entry_cid in &block.entries {
        if !entries.insert(*entry_cid) {
            bail!("entry CID {entry_cid} appears more than once in block");
        }
        let entry = match nodes.get(entry_cid) {
            Some(Node::Entry(entry)) => entry,
            Some(_) => bail!("block entry CID {entry_cid} is not an entry"),
            None => bail!("block references missing entry {entry_cid}"),
        };
        for tx_cid in &entry.transactions {
            if !transactions.insert(*tx_cid) {
                bail!("transaction CID {tx_cid} appears more than once in block");
            }
            let tx = match nodes.get(tx_cid) {
                Some(Node::Transaction(tx)) => tx,
                Some(_) => bail!("entry transaction CID {tx_cid} is not a transaction"),
                None => bail!("entry references missing transaction {tx_cid}"),
            };
            if tx.slot != block.slot || tx.index != Some(next_index) {
                bail!(
                    "transaction ordering mismatch at slot {} index {}",
                    block.slot,
                    next_index
                );
            }
            records.push(build_record(
                tx,
                *tx_cid,
                *entry_cid,
                block_node.cid,
                block,
                &block_id,
                block_time,
                &observed_at,
                &nodes,
                &raw_nodes,
                &positions,
            )?);
            next_index = next_index
                .checked_add(1)
                .ok_or_else(|| anyhow!("transaction index overflow"))?;
        }
    }

    let entry_nodes = raw_nodes
        .iter()
        .filter(|raw| matches!(raw.node, Node::Entry(_)))
        .count();
    if entry_nodes != entries.len() {
        bail!("block contains unreferenced entry nodes");
    }
    let tx_nodes = raw_nodes
        .iter()
        .filter(|raw| matches!(raw.node, Node::Transaction(_)))
        .count();
    if tx_nodes != records.len() {
        bail!("block contains unreferenced transaction nodes");
    }

    Ok(ArchiveBlock {
        slot: block.slot,
        records,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_record(
    tx: &ArchiveTx,
    tx_cid: Cid,
    entry_cid: Cid,
    block_cid: Cid,
    block: &Block,
    block_id: &str,
    block_time: i64,
    observed_at: &str,
    nodes: &HashMap<Cid, &Node>,
    raw_nodes: &[RawNode],
    positions: &HashMap<Cid, usize>,
) -> Result<ArchiveRecord> {
    let signed = assemble_frame(&tx.data, nodes).context("invalid signed transaction frame")?;
    let metadata = assemble_frame(&tx.metadata, nodes).context("invalid metadata frame")?;
    let versioned: VersionedTransaction =
        bincode::deserialize(&signed.data).context("invalid signed transaction bytes")?;
    if bincode::serialize(&versioned).context("failed to canonicalize signed transaction")?
        != signed.data
    {
        bail!("signed transaction bytes are not canonical");
    }
    let status = decode_status(&metadata.data)?;
    let payload = record_payload(
        [block_cid, entry_cid, tx_cid]
            .into_iter()
            .chain(signed.cids)
            .chain(metadata.cids),
        raw_nodes,
        positions,
    )?;
    map_record(
        tx,
        &versioned,
        &status,
        block.parent_slot,
        block_id,
        block_time,
        observed_at,
        payload,
        signed.data,
    )
}

#[allow(clippy::too_many_arguments)]
fn map_record(
    tx: &ArchiveTx,
    versioned: &VersionedTransaction,
    status: &StatusMeta,
    parent_slot: u64,
    block_id: &str,
    block_time: i64,
    observed_at: &str,
    payload: Vec<u8>,
    signed_tx: Vec<u8>,
) -> Result<ArchiveRecord> {
    let signature = versioned
        .signatures
        .first()
        .ok_or_else(|| anyhow!("archive transaction has no signature"))?
        .to_string();
    let static_keys = versioned
        .message
        .static_account_keys()
        .iter()
        .map(ToString::to_string)
        .collect();
    let loaded_writable = map_addresses(&status.loaded_writable_addresses)?;
    let loaded_readonly = map_addresses(&status.loaded_readonly_addresses)?;
    let instructions = map_instructions(versioned, status)?;
    let error = status
        .err
        .as_ref()
        .map(|error| {
            if error.err.is_empty() {
                bail!("transaction error payload is empty");
            }
            Ok(error.err.clone())
        })
        .transpose()?;

    Ok(ArchiveRecord {
        slot: tx.slot,
        parent_slot,
        block_id: block_id.into(),
        block_time,
        tx_index: tx
            .index
            .ok_or_else(|| anyhow!("transaction index is missing"))?,
        signature,
        observed_at: observed_at.into(),
        payload,
        error,
        static_keys,
        loaded_writable,
        loaded_readonly,
        instructions,
        pre_balances: status.pre_balances.clone(),
        post_balances: status.post_balances.clone(),
        pre_tokens: map_tokens(&status.pre_token_balances)?,
        post_tokens: map_tokens(&status.post_token_balances)?,
        fee: status.fee,
        compute_units: status.compute_units_consumed,
        signed_tx,
    })
}

fn map_instructions(tx: &VersionedTransaction, status: &StatusMeta) -> Result<Vec<TxIx>> {
    let outer = tx.message.instructions();
    let mut inner = HashMap::new();
    for group in &status.inner_instructions {
        if usize::try_from(group.index)? >= outer.len()
            || inner.insert(group.index, group).is_some()
        {
            bail!("transaction inner instruction groups are invalid");
        }
    }

    let inner_count = inner
        .values()
        .map(|group| group.instructions.len())
        .sum::<usize>();
    let mut mapped = Vec::with_capacity(outer.len() + inner_count);
    for (outer_index, instruction) in outer.iter().enumerate() {
        let outer_index = u32::try_from(outer_index)?;
        mapped.push(TxIx {
            outer_index,
            inner_index: None,
            stack_height: None,
            program_index: u32::from(instruction.program_id_index),
            accounts: instruction
                .accounts
                .iter()
                .map(|index| u32::from(*index))
                .collect(),
            data: instruction.data.clone(),
        });
        if let Some(group) = inner.get(&outer_index) {
            for (inner_index, instruction) in group.instructions.iter().enumerate() {
                mapped.push(TxIx {
                    outer_index,
                    inner_index: Some(u32::try_from(inner_index)?),
                    stack_height: instruction.stack_height,
                    program_index: instruction.program_id_index,
                    accounts: instruction
                        .accounts
                        .iter()
                        .map(|index| u32::from(*index))
                        .collect(),
                    data: instruction.data.clone(),
                });
            }
        }
    }
    Ok(mapped)
}

fn map_addresses(values: &[Vec<u8>]) -> Result<Vec<String>> {
    values
        .iter()
        .map(|value| {
            if value.len() != 32 {
                bail!("loaded address is not 32 bytes");
            }
            Ok(bs58::encode(value).into_string())
        })
        .collect()
}

fn map_tokens(values: &[ProtoToken]) -> Result<Vec<TokenBalance>> {
    let mut mapped = values
        .iter()
        .map(|value| {
            let amount = value
                .ui_token_amount
                .as_ref()
                .ok_or_else(|| anyhow!("token balance has no amount"))?;
            Ok(TokenBalance {
                account_index: value.account_index,
                mint: value.mint.clone(),
                owner: (!value.owner.is_empty()).then(|| value.owner.clone()),
                program_id: (!value.program_id.is_empty()).then(|| value.program_id.clone()),
                raw_amount: amount.amount.clone(),
                decimals: amount.decimals,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    mapped.sort_unstable_by_key(|value| value.account_index);
    Ok(mapped)
}

#[derive(Debug)]
struct AssembledFrame {
    data: Vec<u8>,
    cids: Vec<Cid>,
}

fn assemble_frame(root: &Frame, nodes: &HashMap<Cid, &Node>) -> Result<AssembledFrame> {
    validate_frame(root)?;
    let mut data = root.data.clone();
    let mut cids = Vec::new();
    let mut seen = HashSet::new();
    let mut next = root.next.clone();
    let mut expected_index = root.index;

    while !next.is_empty() {
        let mut following = Vec::new();
        let next_len = next.len();
        for (position, cid) in next.into_iter().enumerate() {
            if !seen.insert(cid) {
                bail!("dataframe continuation cycle at {cid}");
            }
            let frame = match nodes.get(&cid) {
                Some(Node::DataFrame(frame)) => frame,
                Some(_) => bail!("continuation CID {cid} is not a dataframe"),
                None => bail!("missing dataframe continuation {cid}"),
            };
            validate_frame(frame)?;
            if frame.total != root.total || frame.hash != root.hash {
                bail!("dataframe continuation metadata differs from its root");
            }
            if let Some(index) = expected_index {
                let expected = index
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("dataframe index overflow"))?;
                if frame.index != Some(expected) {
                    bail!("dataframe continuation index is not consecutive");
                }
                expected_index = Some(expected);
            } else if frame.index.is_some() {
                bail!("dataframe continuation unexpectedly has an index");
            }
            append_limited(&mut data, &frame.data, MAX_FRAME_DATA)?;
            cids.push(cid);
            if !frame.next.is_empty() {
                if position + 1 != next_len {
                    bail!("dataframe continuation graph is ambiguous");
                }
                following.clone_from(&frame.next);
            }
        }
        next = following;
    }

    if let (Some(index), Some(total)) = (expected_index, root.total) {
        if index.checked_add(1) != Some(total) {
            bail!("dataframe continuation chain is incomplete");
        }
    }
    if let Some(wanted) = root.hash {
        let crc = Crc::<u64>::new(&CRC_64_GO_ISO).checksum(&data);
        let mut fnv = FnvHasher::default();
        fnv.write(&data);
        if wanted != crc && wanted != fnv.finish() {
            bail!("dataframe checksum mismatch");
        }
    }
    Ok(AssembledFrame { data, cids })
}

fn validate_frame(frame: &Frame) -> Result<()> {
    match (frame.index, frame.total) {
        (Some(index), Some(total)) if total > 0 && index < total => Ok(()),
        (None, None) => Ok(()),
        _ => bail!("dataframe index and total are invalid"),
    }
}

fn append_limited(target: &mut Vec<u8>, value: &[u8], max: usize) -> Result<()> {
    let len = target
        .len()
        .checked_add(value.len())
        .ok_or_else(|| anyhow!("dataframe length overflow"))?;
    if len > max {
        bail!("dataframe exceeds {max} bytes");
    }
    target.extend_from_slice(value);
    Ok(())
}

fn decode_status(bytes: &[u8]) -> Result<StatusMeta> {
    if bytes.is_empty() {
        bail!("transaction metadata is empty");
    }
    let decoder = zstd::stream::read::Decoder::new(bytes)
        .context("transaction metadata is not a Zstandard stream")?;
    let mut decoded = Vec::new();
    decoder
        .take((MAX_META_DATA + 1) as u64)
        .read_to_end(&mut decoded)
        .context("failed to decompress transaction metadata")?;
    if decoded.len() > MAX_META_DATA {
        bail!("transaction metadata exceeds {MAX_META_DATA} bytes");
    }
    StatusMeta::decode(decoded.as_slice()).context("invalid transaction metadata protobuf")
}

fn record_payload(
    cids: impl IntoIterator<Item = Cid>,
    raw_nodes: &[RawNode],
    positions: &HashMap<Cid, usize>,
) -> Result<Vec<u8>> {
    let mut indexes = cids
        .into_iter()
        .map(|cid| {
            positions
                .get(&cid)
                .copied()
                .ok_or_else(|| anyhow!("record contribution {cid} is missing"))
        })
        .collect::<Result<Vec<_>>>()?;
    indexes.sort_unstable();
    indexes.dedup();
    let count = u32::try_from(indexes.len()).context("too many record contributions")?;
    let mut payload = Vec::new();
    payload.extend_from_slice(RECORD_MAGIC);
    payload.extend_from_slice(&count.to_le_bytes());
    for index in indexes {
        let raw = &raw_nodes[index];
        let cid = raw.cid.to_bytes();
        let cid_len = u16::try_from(cid.len()).context("CID is too long")?;
        let data_len = u32::try_from(raw.data.len()).context("CAR node is too large")?;
        payload.extend_from_slice(&cid_len.to_le_bytes());
        payload.extend_from_slice(&data_len.to_le_bytes());
        payload.extend_from_slice(&cid);
        payload.extend_from_slice(&raw.data);
    }
    Ok(payload)
}

fn block_hash(block: &Block, nodes: &HashMap<Cid, &Node>) -> Result<String> {
    let entry_cid = block
        .entries
        .last()
        .ok_or_else(|| anyhow!("block has no entries"))?;
    let entry = match nodes.get(entry_cid) {
        Some(Node::Entry(entry)) => entry,
        _ => bail!("last block entry is missing"),
    };
    if entry.hash.len() != 32 {
        bail!("last entry hash is not 32 bytes");
    }
    Ok(bs58::encode(&entry.hash).into_string())
}

fn read_uvarint(reader: &mut impl Read) -> io::Result<Option<u64>> {
    let mut value = 0_u64;
    for index in 0..10 {
        let mut byte = [0_u8; 1];
        match reader.read_exact(&mut byte) {
            Ok(()) => {}
            Err(error) if index == 0 && error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        }
        let byte = byte[0];
        if index == 9 && byte > 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "varint overflow",
            ));
        }
        value |= u64::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok(Some(value));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "varint overflow",
    ))
}

fn validate_car_header(bytes: &[u8]) -> Result<()> {
    let Value::Map(header) = serde_cbor::from_slice(bytes).context("CAR header is invalid CBOR")?
    else {
        bail!("CAR header is not a map");
    };
    let version = header
        .get(&Value::Text("version".into()))
        .ok_or_else(|| anyhow!("CAR header has no version"))?;
    if value_u64(version, "CAR version")? != 1 {
        bail!("CAR version is not 1");
    }
    let roots = match header.get(&Value::Text("roots".into())) {
        Some(Value::Array(roots)) if !roots.is_empty() => roots,
        _ => bail!("CAR header has no roots"),
    };
    for root in roots {
        parse_link(root).context("CAR root is invalid")?;
    }
    Ok(())
}

fn validate_cid(cid: &Cid, data: &[u8]) -> Result<()> {
    if cid.codec() != DAG_CBOR_CODEC
        || cid.hash().code() != SHA2_256_CODE
        || cid.hash().size() != 32
    {
        bail!("unsupported CAR CID {cid}");
    }
    if cid.hash().digest() != Sha256::digest(data).as_slice() {
        bail!("CAR node content does not match CID {cid}");
    }
    Ok(())
}

fn parse_node(bytes: &[u8]) -> Result<Node> {
    let value: Value = serde_cbor::from_slice(bytes).context("invalid DAG-CBOR node")?;
    let array = value_array(&value, "node")?;
    let kind = value_u64(
        array.first().ok_or_else(|| anyhow!("node has no kind"))?,
        "node kind",
    )?;
    match kind {
        0 => parse_transaction(array).map(Node::Transaction),
        1 => parse_entry(array).map(Node::Entry),
        2 => parse_block(array).map(Node::Block),
        3..=5 => Ok(Node::Other(kind)),
        6 => parse_frame(array).map(Node::DataFrame),
        _ => bail!("unsupported Old Faithful node kind {kind}"),
    }
}

fn parse_transaction(array: &[Value]) -> Result<ArchiveTx> {
    if !(4..=5).contains(&array.len()) {
        bail!("transaction node shape is invalid");
    }
    Ok(ArchiveTx {
        data: parse_frame(value_array(&array[1], "transaction data")?)?,
        metadata: parse_frame(value_array(&array[2], "transaction metadata")?)?,
        slot: value_u64(&array[3], "transaction slot")?,
        index: array
            .get(4)
            .map(|value| value_opt_u64(value, "transaction index"))
            .transpose()?
            .flatten(),
    })
}

fn parse_entry(array: &[Value]) -> Result<Entry> {
    if array.len() != 4 {
        bail!("entry node shape is invalid");
    }
    let hash = value_bytes(&array[2], "entry hash")?.to_vec();
    if hash.len() != 32 {
        bail!("entry hash is not 32 bytes");
    }
    Ok(Entry {
        hash,
        transactions: parse_links(&array[3], "entry transactions")?,
    })
}

fn parse_block(array: &[Value]) -> Result<Block> {
    if array.len() != 6 {
        bail!("block node shape is invalid");
    }
    value_array(&array[2], "block shredding")?;
    parse_link(&array[5]).context("block rewards link is invalid")?;
    let meta = value_array(&array[4], "block metadata")?;
    if !(2..=3).contains(&meta.len()) {
        bail!("block metadata shape is invalid");
    }
    Ok(Block {
        slot: value_u64(&array[1], "block slot")?,
        entries: parse_links(&array[3], "block entries")?,
        parent_slot: value_u64(&meta[0], "block parent slot")?,
        block_time: value_u64(&meta[1], "block time")?,
    })
}

fn parse_frame(array: &[Value]) -> Result<Frame> {
    if !(5..=6).contains(&array.len()) || value_u64(&array[0], "dataframe kind")? != 6 {
        bail!("dataframe shape is invalid");
    }
    let frame = Frame {
        hash: value_opt_u64(&array[1], "dataframe hash")?,
        index: value_opt_u64(&array[2], "dataframe index")?,
        total: value_opt_u64(&array[3], "dataframe total")?,
        data: value_bytes(&array[4], "dataframe data")?.to_vec(),
        next: array
            .get(5)
            .map(|value| parse_links(value, "dataframe continuations"))
            .transpose()?
            .unwrap_or_default(),
    };
    validate_frame(&frame)?;
    Ok(frame)
}

fn parse_links(value: &Value, name: &str) -> Result<Vec<Cid>> {
    value_array(value, name)?
        .iter()
        .map(|value| parse_link(value).with_context(|| format!("{name} contains an invalid link")))
        .collect()
}

fn parse_link(value: &Value) -> Result<Cid> {
    let bytes = match value {
        Value::Tag(42, value) => value_bytes(value, "DAG-CBOR link")?,
        Value::Bytes(bytes) => bytes,
        _ => bail!("DAG-CBOR link is not bytes"),
    };
    let Some((&0, cid)) = bytes.split_first() else {
        bail!("DAG-CBOR link has no identity prefix");
    };
    Cid::try_from(cid).context("DAG-CBOR link CID is invalid")
}

fn value_array<'a>(value: &'a Value, name: &str) -> Result<&'a [Value]> {
    match value {
        Value::Array(value) => Ok(value),
        _ => bail!("{name} is not an array"),
    }
}

fn value_bytes<'a>(value: &'a Value, name: &str) -> Result<&'a [u8]> {
    match value {
        Value::Bytes(value) => Ok(value),
        _ => bail!("{name} is not bytes"),
    }
}

fn value_u64(value: &Value, name: &str) -> Result<u64> {
    match value {
        Value::Integer(value) => {
            u64::try_from(*value).with_context(|| format!("{name} is outside u64"))
        }
        _ => bail!("{name} is not an integer"),
    }
}

fn value_opt_u64(value: &Value, name: &str) -> Result<Option<u64>> {
    match value {
        Value::Null => Ok(None),
        _ => value_u64(value, name).map(Some),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, PartialEq, Message)]
struct StatusMeta {
    #[prost(message, optional, tag = "1")]
    err: Option<ProtoError>,
    #[prost(uint64, tag = "2")]
    fee: u64,
    #[prost(uint64, repeated, tag = "3")]
    pre_balances: Vec<u64>,
    #[prost(uint64, repeated, tag = "4")]
    post_balances: Vec<u64>,
    #[prost(message, repeated, tag = "5")]
    inner_instructions: Vec<ProtoInner>,
    #[prost(message, repeated, tag = "7")]
    pre_token_balances: Vec<ProtoToken>,
    #[prost(message, repeated, tag = "8")]
    post_token_balances: Vec<ProtoToken>,
    #[prost(bytes = "vec", repeated, tag = "12")]
    loaded_writable_addresses: Vec<Vec<u8>>,
    #[prost(bytes = "vec", repeated, tag = "13")]
    loaded_readonly_addresses: Vec<Vec<u8>>,
    #[prost(uint64, optional, tag = "16")]
    compute_units_consumed: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoError {
    #[prost(bytes = "vec", tag = "1")]
    err: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoInner {
    #[prost(uint32, tag = "1")]
    index: u32,
    #[prost(message, repeated, tag = "2")]
    instructions: Vec<ProtoIx>,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoIx {
    #[prost(uint32, tag = "1")]
    program_id_index: u32,
    #[prost(bytes = "vec", tag = "2")]
    accounts: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    data: Vec<u8>,
    #[prost(uint32, optional, tag = "4")]
    stack_height: Option<u32>,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoToken {
    #[prost(uint32, tag = "1")]
    account_index: u32,
    #[prost(string, tag = "2")]
    mint: String,
    #[prost(message, optional, tag = "3")]
    ui_token_amount: Option<ProtoAmount>,
    #[prost(string, tag = "4")]
    owner: String,
    #[prost(string, tag = "5")]
    program_id: String,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoAmount {
    #[prost(uint32, tag = "2")]
    decimals: u32,
    #[prost(string, tag = "3")]
    amount: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fervor_tx::{SourceAdapter, SourceCap};

    fn cid(byte: u8) -> Cid {
        let digest = Sha256::digest([byte]);
        let hash = cid::multihash::Multihash::wrap(SHA2_256_CODE, &digest).unwrap();
        Cid::new_v1(DAG_CBOR_CODEC, hash)
    }

    #[test]
    fn capabilities_are_honest_about_finalized_history() {
        let adapter = OldFaithfulAdapter::new("a".repeat(64), Network::MainnetBeta).unwrap();
        let caps = adapter.caps();
        caps.require(&[
            SourceCap::Transactions,
            SourceCap::Finalized,
            SourceCap::History,
            SourceCap::TxIndex,
            SourceCap::BlockTime,
            SourceCap::BlockId,
            SourceCap::SignedTx,
        ])
        .unwrap();
        assert_eq!(caps.accounts, CapState::NotObservable);
        assert_eq!(caps.processed, CapState::NotApplicable);
        assert_eq!(caps.retractions, CapState::NotApplicable);
    }

    #[test]
    fn node_set_payload_is_ordered_by_car_position() {
        let cid_a = cid(1);
        let cid_b = cid(2);
        let raw_nodes = vec![
            RawNode {
                cid: cid_a,
                data: vec![1, 2],
                node: Node::Other(5),
            },
            RawNode {
                cid: cid_b,
                data: vec![3, 4],
                node: Node::Other(5),
            },
        ];
        let positions = HashMap::from([(cid_a, 0), (cid_b, 1)]);
        let forward = record_payload([cid_a, cid_b], &raw_nodes, &positions).unwrap();
        let reverse = record_payload([cid_b, cid_a], &raw_nodes, &positions).unwrap();
        assert_eq!(forward, reverse);
        assert_eq!(hex::encode(Sha256::digest(forward)).len(), 64);
    }

    #[test]
    fn dataframe_cycle_fails_closed() {
        let cid_a = cid(1);
        let root = Frame {
            hash: None,
            index: Some(0),
            total: Some(2),
            data: vec![1],
            next: vec![cid_a],
        };
        let continuation = Frame {
            hash: None,
            index: Some(1),
            total: Some(2),
            data: vec![2],
            next: vec![cid_a],
        };
        let node = Node::DataFrame(continuation);
        let nodes = HashMap::from([(cid_a, &node)]);
        assert!(assemble_frame(&root, &nodes)
            .unwrap_err()
            .to_string()
            .contains("cycle"));
    }

    #[test]
    fn rejects_noncanonical_cid_content() {
        assert!(validate_cid(&cid(1), &[2]).is_err());
    }
}
