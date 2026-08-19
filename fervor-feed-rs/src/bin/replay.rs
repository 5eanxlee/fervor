use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use fervor_feed_rs::{
    archive::{verify_extract, ExtractManifest},
    fervor_tx::{Network, Quarantine},
    market_decoder::decode_swap,
    old_faithful::{ArchiveReader, OldFaithfulAdapter},
    pump::{
        decode_pump_events, pump_supply, PumpEvent, PumpState, SupplyEvidence, PUMP_LAYOUT,
        SUPPLY_CONTRACT,
    },
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

const SCHEMA: &str = "fervor-replay-v3";
const TX_FILE: &str = "transactions.ndjson";
const SWAP_FILE: &str = "swaps.ndjson";
const PUMP_FILE: &str = "pump-events.ndjson";
const STATE_FILE: &str = "pump-state.json";
const SUPPLY_FILE: &str = "supply.json";

#[derive(Debug, Parser)]
#[command(name = "fervor-replay")]
#[command(about = "Replay a verified Old Faithful extract without network access")]
struct Args {
    #[arg(long)]
    corpus: PathBuf,
    #[arg(long)]
    out: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayManifest {
    schema: &'static str,
    network: String,
    mint: String,
    start_slot: u64,
    end_slot: u64,
    first_slot: u64,
    last_slot: u64,
    source_raw_sha256: String,
    source_index_sha256: String,
    source_bytes: u64,
    present_slots: u64,
    skipped_slots: u64,
    blocks: u64,
    transactions: u64,
    matched_transactions: u64,
    swaps: u64,
    transaction_file: &'static str,
    transaction_sha256: String,
    swap_file: &'static str,
    swap_sha256: String,
    pump_layout: &'static str,
    pump_events: u64,
    pump_event_file: &'static str,
    pump_event_sha256: String,
    pump_state_file: &'static str,
    pump_state_sha256: String,
    supply_contract: &'static str,
    supply_file: &'static str,
    supply_sha256: String,
    replay_sha256: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = verify_extract(&args.corpus)?;
    let manifest = read_manifest(&args.corpus)?;
    if report.raw_sha256 != manifest.raw_sha256
        || report.index_sha256 != manifest.index_sha256
        || report.mint != manifest.plan.mint
    {
        bail!("verified extract differs from its manifest");
    }
    if manifest.plan.network != "mainnet-beta" {
        bail!("replay only supports mainnet-beta OF1 extracts");
    }

    let parent = args.out.parent().unwrap_or_else(|| Path::new("."));
    let out_name = args
        .out
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("output directory name is invalid"))?;
    if args.out.exists() {
        bail!("replay output already exists: {}", args.out.display());
    }
    let stage = parent.join(format!(".{out_name}.{}.stage", std::process::id()));
    fs::create_dir(&stage)
        .with_context(|| format!("failed to create replay stage {}", stage.display()))?;
    let result = replay(&args.corpus, &stage, &manifest);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    fs::rename(&stage, &args.out).with_context(|| {
        format!(
            "failed to publish replay {} to {}",
            stage.display(),
            args.out.display()
        )
    })?;
    File::open(parent)?.sync_all()?;
    println!(
        "{}",
        fs::read_to_string(args.out.join("manifest.json"))?.trim_end()
    );
    Ok(())
}

fn replay(corpus: &Path, out: &Path, source: &ExtractManifest) -> Result<()> {
    let mint = &source.plan.mint;
    let adapter = OldFaithfulAdapter::new(source.raw_sha256.clone(), Network::MainnetBeta)?;
    let mut archive = ArchiveReader::open(
        &corpus.join(&source.raw_file),
        source.plan.start_slot..source.plan.end_slot,
    )?;
    let mut tx_out = Output::new(&out.join(TX_FILE))?;
    let mut swap_out = Output::new(&out.join(SWAP_FILE))?;
    let mut pump_out = Output::new(&out.join(PUMP_FILE))?;
    let mut blocks = 0_u64;
    let mut transactions = 0_u64;
    let mut matched = 0_u64;
    let mut swaps = 0_u64;
    let mut pump_count = 0_u64;
    let mut pump_events = Vec::<PumpEvent>::new();
    let mut supply = None::<SupplyEvidence>;
    let mut first_slot = None;
    let mut last_slot = None;

    while let Some(block) = archive.next_block()? {
        first_slot.get_or_insert(block.slot);
        last_slot = Some(block.slot);
        blocks = checked_count(blocks, "block")?;
        for record in block.records {
            transactions = checked_count(transactions, "transaction")?;
            // Old Faithful cannot filter remotely; off-mint records are archive scan noise.
            if !record.references(mint) {
                continue;
            }
            let tx = adapter
                .adapt_record(&record, mint)
                .map_err(|error| quarantine_error("archive transaction", error))?;
            matched = checked_count(matched, "matched transaction")?;
            tx_out.write_json(&tx)?;
            let events =
                decode_pump_events(&tx).map_err(|error| quarantine_error("Pump event", error))?;
            if let Some(value) = pump_supply(
                &events,
                mint,
                &tx.observation.provider,
                &tx.observed_at,
                tx.commitment,
            ) {
                if supply.replace(value).is_some() {
                    bail!("replay found more than one qualified supply event for {mint}");
                }
            }
            for event in events.into_iter().filter(|event| event.mint() == mint) {
                pump_count = checked_count(pump_count, "Pump event")?;
                pump_out.write_json(&event)?;
                pump_events.push(event);
            }
            if let Some(swap) =
                decode_swap(&tx).map_err(|error| quarantine_error("matched transaction", error))?
            {
                if swap.token_mint == *mint || swap.quote_mint == *mint {
                    swaps = checked_count(swaps, "swap")?;
                    swap_out.write_json(&swap)?;
                }
            }
        }
    }

    let first_slot = first_slot.ok_or_else(|| anyhow!("replay contained no blocks"))?;
    let last_slot = last_slot.expect("first slot implies last slot");
    if blocks != source.plan.present_slots
        || first_slot != source.plan.first_slot
        || last_slot != source.plan.last_slot
    {
        bail!("replay block coverage differs from the extract plan");
    }
    if matched == 0 {
        bail!("replay found no transactions for mint {mint}");
    }
    if pump_count == 0 {
        bail!("replay found no Pump lifecycle events for mint {mint}");
    }

    let pump_state = PumpState::reconstruct(mint, &pump_events)?;
    let supply =
        supply.ok_or_else(|| anyhow!("replay found no qualified supply event for {mint}"))?;
    if supply.token_mint != pump_state.mint
        || supply.raw_amount != pump_state.supply_raw.to_string()
        || supply.decimals != pump_state.decimals
        || supply.fixed != pump_state.supply_fixed
    {
        bail!("supply contract differs from reconstructed Pump state");
    }
    let transaction_sha256 = tx_out.finish()?;
    let swap_sha256 = swap_out.finish()?;
    let pump_event_sha256 = pump_out.finish()?;
    let pump_state_sha256 = write_json(&out.join(STATE_FILE), &pump_state)?;
    let supply_sha256 = write_json(&out.join(SUPPLY_FILE), &supply)?;
    let replay_sha256 = replay_hash(&[
        &transaction_sha256,
        &swap_sha256,
        &pump_event_sha256,
        &pump_state_sha256,
        &supply_sha256,
    ]);
    let manifest = ReplayManifest {
        schema: SCHEMA,
        network: source.plan.network.clone(),
        mint: mint.clone(),
        start_slot: source.plan.start_slot,
        end_slot: source.plan.end_slot,
        first_slot,
        last_slot,
        source_raw_sha256: source.raw_sha256.clone(),
        source_index_sha256: source.index_sha256.clone(),
        source_bytes: source.raw_bytes,
        present_slots: source.plan.present_slots,
        skipped_slots: source.plan.skipped_slots,
        blocks,
        transactions,
        matched_transactions: matched,
        swaps,
        transaction_file: TX_FILE,
        transaction_sha256,
        swap_file: SWAP_FILE,
        swap_sha256,
        pump_layout: PUMP_LAYOUT,
        pump_events: pump_count,
        pump_event_file: PUMP_FILE,
        pump_event_sha256,
        pump_state_file: STATE_FILE,
        pump_state_sha256,
        supply_contract: SUPPLY_CONTRACT,
        supply_file: SUPPLY_FILE,
        supply_sha256,
        replay_sha256,
    };
    let mut bytes = serde_json::to_vec_pretty(&manifest)?;
    bytes.push(b'\n');
    write_file(&out.join("manifest.json"), &bytes)?;
    File::open(out)?.sync_all()?;
    Ok(())
}

fn quarantine_error(context: &str, error: Quarantine) -> anyhow::Error {
    let detail = serde_json::to_string(&error).unwrap_or(error.detail);
    anyhow!("{context} was quarantined: {detail}")
}

fn read_manifest(corpus: &Path) -> Result<ExtractManifest> {
    let path = corpus.join("manifest.json");
    let bytes = fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
    if bytes.len() > 1024 * 1024 {
        bail!("extract manifest exceeds 1 MiB");
    }
    serde_json::from_slice(&bytes).with_context(|| format!("invalid {}", path.display()))
}

fn checked_count(value: u64, name: &str) -> Result<u64> {
    value
        .checked_add(1)
        .ok_or_else(|| anyhow!("{name} count overflow"))
}

fn replay_hash(hashes: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(SCHEMA.as_bytes());
    for hash in hashes {
        digest.update([0]);
        digest.update(hash.as_bytes());
    }
    hex::encode(digest.finalize())
}

struct Output {
    writer: BufWriter<File>,
    digest: Sha256,
}

impl Output {
    fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            writer: BufWriter::new(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .with_context(|| format!("failed to create {}", path.display()))?,
            ),
            digest: Sha256::new(),
        })
    }

    fn write_json(&mut self, value: &impl Serialize) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.writer.write_all(&bytes)?;
        self.digest.update(&bytes);
        Ok(())
    }

    fn finish(mut self) -> Result<String> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        Ok(hex::encode(self.digest.finalize()))
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<String> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_file(path, &bytes)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_digest_is_domain_separated_and_stable() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let hash = replay_hash(&[&a, &b, &c]);
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, replay_hash(&[&a, &b, &c]));
        assert_ne!(hash, replay_hash(&[&b, &a, &c]));
        assert_ne!(hash, replay_hash(&[&a, &b]));
    }
}
