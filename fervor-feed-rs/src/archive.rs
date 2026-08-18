use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{
    header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE},
    Client, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, time::sleep};

pub const DEFAULT_BASE: &str = "https://files.old-faithful.net/";
pub const PLAN_SCHEMA: &str = "fervor-extract-plan-v1";
pub const EXTRACT_SCHEMA: &str = "fervor-raw-extract-v1";

const SLOTS_PER_EPOCH: u64 = 432_000;
const SLOT_RECORD_BYTES: usize = 12;
const INDEX_BYTES: u64 = SLOTS_PER_EPOCH * SLOT_RECORD_BYTES as u64;
const MAX_HEADER_BYTES: u64 = 4 * 1024;
const META_BYTES: u64 = 4 * 1024;
const MANIFEST_RESERVE: u64 = 1024 * 1024;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePin {
    pub jetstreamer_version: String,
    pub jetstreamer_revision: String,
    pub faithful_version: String,
    pub faithful_revision: String,
    pub reviewed_at: String,
    pub access_review: String,
}

impl Default for SourcePin {
    fn default() -> Self {
        Self {
            jetstreamer_version: "0.7.0".into(),
            jetstreamer_revision: "cffaf3d891b3cbe45a46dd963d6d3571b2aa1a24".into(),
            faithful_version: "v0.7.25".into(),
            faithful_revision: "a69a0d2e189006608e3b73b7659a957b00b3567e".into(),
            reviewed_at: "2026-08-18".into(),
            access_review: "Official OF1 documentation offers archive downloads; no standalone service-terms page was found in the documentation index. Keep extracts internal until redistribution is separately approved.".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPlan {
    pub schema: String,
    pub created_at: String,
    pub network: String,
    pub mint: String,
    pub epoch: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub first_slot: u64,
    pub last_slot: u64,
    pub present_slots: u64,
    pub skipped_slots: u64,
    pub base_url: String,
    pub index_url: String,
    pub car_url: String,
    pub car_sha_url: String,
    pub car_cid_url: String,
    pub index_sha256: String,
    pub car_sha256: String,
    pub car_cid: String,
    pub index_bytes: u64,
    pub car_bytes: u64,
    pub header_bytes: u64,
    pub source_start: u64,
    pub source_end: u64,
    pub range_bytes: u64,
    pub raw_bytes: u64,
    pub download_bytes: u64,
    pub workspace_bytes: u64,
    pub max_download: u64,
    pub max_workspace: u64,
    pub source: SourcePin,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractManifest {
    pub schema: String,
    pub complete: bool,
    pub retrieved_at: String,
    pub raw_file: String,
    pub raw_sha256: String,
    pub raw_bytes: u64,
    pub index_file: String,
    pub index_sha256: String,
    pub plan: ExtractPlan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub schema: String,
    pub mint: String,
    pub start_slot: u64,
    pub end_slot: u64,
    pub raw_sha256: String,
    pub raw_bytes: u64,
    pub index_sha256: String,
    pub present_slots: u64,
    pub skipped_slots: u64,
}

#[derive(Clone, Debug)]
pub struct InspectReq {
    pub epoch: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub mint: String,
    pub max_download: u64,
    pub max_workspace: u64,
    pub workspace: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ArchiveSource {
    base: Url,
    allowed_hosts: BTreeSet<String>,
    allow_loopback_http: bool,
    retries: usize,
}

impl ArchiveSource {
    pub fn official() -> Result<Self> {
        Self::new(DEFAULT_BASE, ["files.old-faithful.net"], false)
    }

    pub fn new<I, S>(base: &str, allowed_hosts: I, allow_loopback_http: bool) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let base = Url::parse(base).context("archive base URL is invalid")?;
        let allowed_hosts = allowed_hosts
            .into_iter()
            .map(Into::into)
            .map(|host: String| host.to_ascii_lowercase())
            .collect::<BTreeSet<_>>();
        validate_base(&base, &allowed_hosts, allow_loopback_http)?;
        Ok(Self {
            base,
            allowed_hosts,
            allow_loopback_http,
            retries: 3,
        })
    }

    pub fn with_retries(mut self, retries: usize) -> Self {
        self.retries = retries;
        self
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    fn url(&self, path: &str) -> Result<Url> {
        let url = self
            .base
            .join(path)
            .with_context(|| format!("invalid archive path: {path}"))?;
        validate_url(&url, &self.allowed_hosts, self.allow_loopback_http)?;
        Ok(url)
    }
}

#[derive(Clone)]
pub struct ArchiveClient {
    client: Client,
    source: ArchiveSource,
}

impl ArchiveClient {
    pub fn new(source: ArchiveSource) -> Result<Self> {
        let client = Client::builder()
            .user_agent(concat!("fervor-corpus/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .context("failed to build archive HTTP client")?;
        Ok(Self { client, source })
    }

    pub fn source(&self) -> &ArchiveSource {
        &self.source
    }

    pub async fn inspect(&self, req: &InspectReq) -> Result<ExtractPlan> {
        validate_mint(&req.mint)?;
        validate_slots(req.epoch, req.start_slot, req.end_slot)?;
        ensure_workspace(&req.workspace)?;

        let index_url = self
            .source
            .url(&format!("{0}/epoch-{0}-slot-ranges.raw", req.epoch))?;
        let car_url = self.source.url(&format!("{0}/epoch-{0}.car", req.epoch))?;
        let car_sha_url = self
            .source
            .url(&format!("{0}/epoch-{0}.sha256", req.epoch))?;
        let car_cid_url = self.source.url(&format!("{0}/epoch-{0}.cid", req.epoch))?;

        let index_len = self.head_len(&index_url).await?;
        if index_len != INDEX_BYTES {
            bail!("slot index is {index_len} bytes; expected exactly {INDEX_BYTES} bytes");
        }
        if index_len > req.max_download {
            bail!(
                "slot index alone exceeds download ceiling: {index_len} > {}",
                req.max_download
            );
        }

        let inspect_limit = INDEX_BYTES
            .checked_add(2 * META_BYTES)
            .ok_or_else(|| anyhow!("inspect byte count overflow"))?;
        let mut inspect_meter = ByteMeter::new(inspect_limit);
        let index = self
            .fetch_small(&index_url, INDEX_BYTES, &mut inspect_meter)
            .await?;
        let index_sha256 = sha256(&index);
        let range = RangeInfo::parse(&index, req.epoch, req.start_slot, req.end_slot)?;
        let car_bytes = self.head_len(&car_url).await?;
        if range.source_end > car_bytes {
            bail!(
                "slot index range ends at {}, beyond CAR size {car_bytes}",
                range.source_end
            );
        }

        let sha_text = self
            .fetch_text(&car_sha_url, META_BYTES, &mut inspect_meter)
            .await?;
        let cid_text = self
            .fetch_text(&car_cid_url, META_BYTES, &mut inspect_meter)
            .await?;
        let car_sha256 = parse_sha256(&sha_text)?;
        let car_cid = parse_cid(&cid_text)?;

        let raw_bytes = range
            .header_bytes
            .checked_add(range.range_bytes)
            .ok_or_else(|| anyhow!("raw extract byte count overflow"))?;
        let download_bytes = INDEX_BYTES
            .checked_add(raw_bytes)
            .ok_or_else(|| anyhow!("download byte count overflow"))?;
        let workspace_bytes = download_bytes
            .checked_add(MANIFEST_RESERVE)
            .ok_or_else(|| anyhow!("workspace byte count overflow"))?;
        if download_bytes > req.max_download {
            bail!(
                "extract exceeds download ceiling: {download_bytes} > {}",
                req.max_download
            );
        }
        if workspace_bytes > req.max_workspace {
            bail!(
                "extract exceeds workspace ceiling: {workspace_bytes} > {}",
                req.max_workspace
            );
        }
        let free = fs2::available_space(&req.workspace).with_context(|| {
            format!(
                "failed to inspect free space at {}",
                req.workspace.display()
            )
        })?;
        if workspace_bytes > free {
            bail!(
                "extract requires {workspace_bytes} workspace bytes, but only {free} are available"
            );
        }

        Ok(ExtractPlan {
            schema: PLAN_SCHEMA.into(),
            created_at: Utc::now().to_rfc3339(),
            network: "mainnet-beta".into(),
            mint: req.mint.clone(),
            epoch: req.epoch,
            start_slot: req.start_slot,
            end_slot: req.end_slot,
            first_slot: range.first_slot,
            last_slot: range.last_slot,
            present_slots: range.present_slots,
            skipped_slots: range.skipped_slots,
            base_url: self.source.base.as_str().into(),
            index_url: index_url.into(),
            car_url: car_url.into(),
            car_sha_url: car_sha_url.into(),
            car_cid_url: car_cid_url.into(),
            index_sha256,
            car_sha256,
            car_cid,
            index_bytes: INDEX_BYTES,
            car_bytes,
            header_bytes: range.header_bytes,
            source_start: range.source_start,
            source_end: range.source_end,
            range_bytes: range.range_bytes,
            raw_bytes,
            download_bytes,
            workspace_bytes,
            max_download: req.max_download,
            max_workspace: req.max_workspace,
            source: SourcePin::default(),
        })
    }

    pub async fn extract(&self, plan: &ExtractPlan, out: &Path) -> Result<ExtractManifest> {
        validate_plan(plan, &self.source)?;
        let parent = out
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        ensure_workspace(parent)?;
        if out.exists() {
            bail!("extract destination already exists: {}", out.display());
        }
        let free = fs2::available_space(parent)
            .with_context(|| format!("failed to inspect free space at {}", parent.display()))?;
        if plan.workspace_bytes > free {
            bail!(
                "extract requires {} workspace bytes, but only {free} are available",
                plan.workspace_bytes
            );
        }

        let index_url = Url::parse(&plan.index_url).context("plan index URL is invalid")?;
        let car_url = Url::parse(&plan.car_url).context("plan CAR URL is invalid")?;
        let mut meter = ByteMeter::new(plan.max_download);
        let index = self
            .fetch_small(&index_url, plan.index_bytes, &mut meter)
            .await?;
        if sha256(&index) != plan.index_sha256 {
            bail!("slot index hash changed since inspect");
        }
        let range = RangeInfo::parse(&index, plan.epoch, plan.start_slot, plan.end_slot)?;
        range.matches_plan(plan)?;

        let mut stage = StageDir::new(parent, out.file_name().and_then(|name| name.to_str()))?;
        let mut workspace = ByteMeter::new(plan.max_workspace);
        workspace.take(index.len() as u64)?;
        let index_path = stage.path().join("index.raw");
        write_file(&index_path, &index)?;

        let raw_path = stage.path().join("raw.car");
        let mut raw = tokio::fs::File::create(&raw_path)
            .await
            .with_context(|| format!("failed to create {}", raw_path.display()))?;
        let mut raw_hash = Sha256::new();
        self.download_range(
            &car_url,
            0,
            plan.header_bytes,
            plan.car_bytes,
            &mut raw,
            &mut raw_hash,
            &mut meter,
        )
        .await?;
        self.download_range(
            &car_url,
            plan.source_start,
            plan.source_end,
            plan.car_bytes,
            &mut raw,
            &mut raw_hash,
            &mut meter,
        )
        .await?;
        raw.flush().await.context("failed to flush raw extract")?;
        raw.sync_all().await.context("failed to sync raw extract")?;
        drop(raw);

        let raw_len = fs::metadata(&raw_path)?.len();
        if raw_len != plan.raw_bytes {
            bail!(
                "raw extract is {raw_len} bytes; expected {}",
                plan.raw_bytes
            );
        }
        workspace.take(raw_len)?;
        let manifest = ExtractManifest {
            schema: EXTRACT_SCHEMA.into(),
            complete: true,
            retrieved_at: Utc::now().to_rfc3339(),
            raw_file: "raw.car".into(),
            raw_sha256: hex::encode(raw_hash.finalize()),
            raw_bytes: raw_len,
            index_file: "index.raw".into(),
            index_sha256: plan.index_sha256.clone(),
            plan: plan.clone(),
        };
        let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
        manifest_bytes.push(b'\n');
        workspace.take(manifest_bytes.len() as u64)?;
        write_file(&stage.path().join("manifest.json"), &manifest_bytes)?;
        sync_dir(stage.path())?;

        if meter.used() < plan.download_bytes {
            bail!(
                "downloaded only {} bytes; plan requires at least {}",
                meter.used(),
                plan.download_bytes
            );
        }
        fs::rename(stage.path(), out).with_context(|| {
            format!(
                "failed to publish extract {} to {}",
                stage.path().display(),
                out.display()
            )
        })?;
        stage.disarm();
        sync_dir(parent)?;
        Ok(manifest)
    }

    async fn head_len(&self, url: &Url) -> Result<u64> {
        for attempt in 0..=self.source.retries {
            let response = self.client.head(url.clone()).send().await;
            match response {
                Ok(response) if response.status().is_success() => {
                    return response
                        .headers()
                        .get(CONTENT_LENGTH)
                        .ok_or_else(|| anyhow!("HEAD {url} omitted Content-Length"))?
                        .to_str()
                        .context("Content-Length is not ASCII")?
                        .parse::<u64>()
                        .context("Content-Length is not a u64");
                }
                Ok(response) if retryable(response.status()) && attempt < self.source.retries => {
                    retry_delay(attempt).await;
                }
                Ok(response) => bail!("HEAD {url} returned HTTP {}", response.status()),
                Err(error) if attempt < self.source.retries => {
                    let _ = error;
                    retry_delay(attempt).await;
                }
                Err(error) => return Err(error).with_context(|| format!("HEAD {url} failed")),
            }
        }
        unreachable!("retry loop returns")
    }

    async fn fetch_text(&self, url: &Url, limit: u64, meter: &mut ByteMeter) -> Result<String> {
        let bytes = self.fetch_small(url, limit, meter).await?;
        String::from_utf8(bytes).with_context(|| format!("{url} is not UTF-8"))
    }

    async fn fetch_small(&self, url: &Url, limit: u64, meter: &mut ByteMeter) -> Result<Vec<u8>> {
        let mut last_error = None;
        for attempt in 0..=self.source.retries {
            let response = match self.client.get(url.clone()).send().await {
                Ok(response) if response.status() == StatusCode::OK => response,
                Ok(response) if retryable(response.status()) && attempt < self.source.retries => {
                    retry_delay(attempt).await;
                    continue;
                }
                Ok(response) => bail!("GET {url} returned HTTP {}", response.status()),
                Err(error) if attempt < self.source.retries => {
                    last_error = Some(error);
                    retry_delay(attempt).await;
                    continue;
                }
                Err(error) => return Err(error).with_context(|| format!("GET {url} failed")),
            };
            if response.content_length().is_some_and(|len| len > limit) {
                bail!("GET {url} exceeds {limit}-byte metadata limit");
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            let mut failed = false;
            loop {
                let next = match tokio::time::timeout(CHUNK_TIMEOUT, stream.next()).await {
                    Ok(next) => next,
                    Err(_) => {
                        failed = true;
                        break;
                    }
                };
                let Some(next) = next else {
                    break;
                };
                match next {
                    Ok(chunk) => {
                        let next_len = bytes.len() as u64 + chunk.len() as u64;
                        if next_len > limit {
                            bail!("GET {url} exceeds {limit}-byte metadata limit");
                        }
                        meter.take(chunk.len() as u64)?;
                        bytes.extend_from_slice(&chunk);
                    }
                    Err(error) => {
                        last_error = Some(error);
                        failed = true;
                        break;
                    }
                }
            }
            if !failed {
                return Ok(bytes);
            }
            if attempt < self.source.retries {
                retry_delay(attempt).await;
            }
        }
        Err(last_error
            .map(anyhow::Error::from)
            .unwrap_or_else(|| anyhow!("GET {url} failed")))
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_range(
        &self,
        url: &Url,
        start: u64,
        end: u64,
        total: u64,
        file: &mut tokio::fs::File,
        hash: &mut Sha256,
        meter: &mut ByteMeter,
    ) -> Result<()> {
        if end <= start {
            bail!("empty or reversed byte range {start}..{end}");
        }
        let mut cursor = start;
        let mut failures = 0usize;
        while cursor < end {
            let last = end - 1;
            let response = match self
                .client
                .get(url.clone())
                .header(RANGE, format!("bytes={cursor}-{last}"))
                .send()
                .await
            {
                Ok(response) if retryable(response.status()) => {
                    if failures >= self.source.retries {
                        bail!(
                            "range GET {url} exhausted retries with HTTP {}",
                            response.status()
                        );
                    }
                    retry_delay(failures).await;
                    failures += 1;
                    continue;
                }
                Ok(response) => response,
                Err(error) => {
                    if failures >= self.source.retries {
                        return Err(error)
                            .with_context(|| format!("range GET {url} exhausted retries"));
                    }
                    retry_delay(failures).await;
                    failures += 1;
                    continue;
                }
            };
            if response.status() != StatusCode::PARTIAL_CONTENT {
                bail!(
                    "range GET {url} returned HTTP {}; refusing a non-206 body",
                    response.status()
                );
            }
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .ok_or_else(|| anyhow!("range GET {url} omitted Content-Range"))?
                .to_str()
                .context("Content-Range is not ASCII")?;
            let parsed = ContentRange::parse(content_range)?;
            if parsed.start != cursor || parsed.end != last || parsed.total != total {
                bail!(
                    "range GET {url} returned {content_range}; expected bytes {cursor}-{last}/{total}"
                );
            }
            let expected = end - cursor;
            if response.content_length().is_some_and(|len| len != expected) {
                bail!("range GET {url} declared the wrong body length for {cursor}..{end}");
            }

            let mut stream = response.bytes_stream();
            let mut stream_failed = false;
            loop {
                let next = match tokio::time::timeout(CHUNK_TIMEOUT, stream.next()).await {
                    Ok(next) => next,
                    Err(_) => {
                        stream_failed = true;
                        break;
                    }
                };
                let Some(next) = next else {
                    break;
                };
                match next {
                    Ok(chunk) => {
                        let remaining = end - cursor;
                        if chunk.len() as u64 > remaining {
                            bail!("range GET {url} exceeded its declared byte range");
                        }
                        meter.take(chunk.len() as u64)?;
                        file.write_all(&chunk).await?;
                        hash.update(&chunk);
                        cursor += chunk.len() as u64;
                    }
                    Err(_) => {
                        stream_failed = true;
                        break;
                    }
                }
            }
            if cursor == end {
                return Ok(());
            }
            if !stream_failed {
                stream_failed = true;
            }
            if stream_failed {
                if failures >= self.source.retries {
                    bail!("range GET {url} ended early at byte {cursor}");
                }
                retry_delay(failures).await;
                failures += 1;
            }
        }
        Ok(())
    }
}

pub fn write_plan(path: &Path, plan: &ExtractPlan) -> Result<()> {
    if path.exists() {
        bail!("plan destination already exists: {}", path.display());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ensure_workspace(parent)?;
    let mut bytes = serde_json::to_vec_pretty(plan)?;
    bytes.push(b'\n');
    let partial = partial_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .with_context(|| format!("failed to create {}", partial.display()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        if path.exists() {
            bail!("plan destination already exists: {}", path.display());
        }
        fs::rename(&partial, path)?;
        sync_dir(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

pub fn read_plan(path: &Path) -> Result<ExtractPlan> {
    let bytes = read_limited(path, MANIFEST_RESERVE)?;
    serde_json::from_slice(&bytes).with_context(|| format!("invalid plan: {}", path.display()))
}

pub fn verify_extract(dir: &Path) -> Result<VerifyReport> {
    let manifest_path = dir.join("manifest.json");
    let manifest: ExtractManifest =
        serde_json::from_slice(&read_limited(&manifest_path, MANIFEST_RESERVE)?)
            .with_context(|| format!("invalid manifest: {}", manifest_path.display()))?;
    if manifest.schema != EXTRACT_SCHEMA || !manifest.complete {
        bail!("extract manifest is not a complete {EXTRACT_SCHEMA} artifact");
    }
    validate_plan_shape(&manifest.plan)?;
    if manifest.index_sha256 != manifest.plan.index_sha256 {
        bail!("manifest index hash does not match its plan");
    }

    let expected = BTreeSet::from([
        "index.raw".to_string(),
        "manifest.json".to_string(),
        "raw.car".to_string(),
    ]);
    let actual = fs::read_dir(dir)
        .with_context(|| format!("failed to read extract directory: {}", dir.display()))?
        .map(|entry| {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                bail!(
                    "extract contains a non-file entry: {}",
                    entry.path().display()
                );
            }
            entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("extract contains a non-UTF-8 filename"))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    if actual != expected {
        bail!("extract directory contains unexpected or missing files");
    }

    let index_path = dir.join(&manifest.index_file);
    let index_meta = fs::metadata(&index_path)?;
    if index_meta.len() != manifest.plan.index_bytes {
        bail!("stored slot index length does not match the plan");
    }
    let index_hash = sha256_file(&index_path)?;
    if index_hash != manifest.index_sha256 {
        bail!("stored slot index hash mismatch");
    }
    let index = read_limited(&index_path, INDEX_BYTES)?;
    let range = RangeInfo::parse(
        &index,
        manifest.plan.epoch,
        manifest.plan.start_slot,
        manifest.plan.end_slot,
    )?;
    range.matches_plan(&manifest.plan)?;

    let raw_path = dir.join(&manifest.raw_file);
    let raw_meta = fs::metadata(&raw_path)?;
    if raw_meta.len() != manifest.raw_bytes || raw_meta.len() != manifest.plan.raw_bytes {
        bail!("stored raw extract length mismatch");
    }
    validate_car_header(&raw_path, manifest.plan.header_bytes)?;
    let raw_hash = sha256_file(&raw_path)?;
    if raw_hash != manifest.raw_sha256 {
        bail!("stored raw extract hash mismatch");
    }

    Ok(VerifyReport {
        schema: manifest.schema,
        mint: manifest.plan.mint,
        start_slot: manifest.plan.start_slot,
        end_slot: manifest.plan.end_slot,
        raw_sha256: raw_hash,
        raw_bytes: raw_meta.len(),
        index_sha256: index_hash,
        present_slots: manifest.plan.present_slots,
        skipped_slots: manifest.plan.skipped_slots,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RangeInfo {
    first_slot: u64,
    last_slot: u64,
    present_slots: u64,
    skipped_slots: u64,
    header_bytes: u64,
    source_start: u64,
    source_end: u64,
    range_bytes: u64,
}

impl RangeInfo {
    fn parse(bytes: &[u8], epoch: u64, start_slot: u64, end_slot: u64) -> Result<Self> {
        validate_slots(epoch, start_slot, end_slot)?;
        if bytes.len() as u64 != INDEX_BYTES {
            bail!(
                "slot index is {} bytes; expected exactly {INDEX_BYTES} bytes",
                bytes.len()
            );
        }
        let epoch_start = epoch
            .checked_mul(SLOTS_PER_EPOCH)
            .ok_or_else(|| anyhow!("epoch slot range overflow"))?;
        let mut first_offset = None;
        let mut previous_end = None;
        let mut selected_first = None;
        let mut selected_last = None;
        let mut selected_end = None;
        let mut present_slots = 0u64;
        let mut skipped_slots = 0u64;
        let mut selected_sum = 0u64;

        for index in 0..SLOTS_PER_EPOCH as usize {
            let record = &bytes[index * SLOT_RECORD_BYTES..(index + 1) * SLOT_RECORD_BYTES];
            let offset = u64::from_le_bytes(record[..8].try_into().expect("eight-byte offset"));
            let length = u32::from_le_bytes(record[8..].try_into().expect("four-byte length"));
            if length == 0 {
                if offset != 0 {
                    bail!("slot index has a zero-length record with nonzero offset");
                }
                let slot = epoch_start + index as u64;
                if (start_slot..end_slot).contains(&slot) {
                    skipped_slots += 1;
                }
                continue;
            }
            let end = offset
                .checked_add(length as u64)
                .ok_or_else(|| anyhow!("slot byte range overflow"))?;
            if let Some(previous_end) = previous_end {
                if offset < previous_end {
                    bail!(
                        "slot index byte ranges overlap or regress: previous end {previous_end}, next offset {offset}"
                    );
                }
            }
            first_offset.get_or_insert(offset);
            previous_end = Some(end);

            let slot = epoch_start + index as u64;
            if (start_slot..end_slot).contains(&slot) {
                if let Some(previous_end) = selected_end {
                    if offset != previous_end {
                        bail!(
                            "selected slot index is non-contiguous: expected offset {previous_end}, got {offset}"
                        );
                    }
                }
                present_slots += 1;
                selected_sum = selected_sum
                    .checked_add(length as u64)
                    .ok_or_else(|| anyhow!("selected byte count overflow"))?;
                selected_first.get_or_insert((slot, offset));
                selected_last = Some((slot, end));
                selected_end = Some(end);
            }
        }

        let header_bytes =
            first_offset.ok_or_else(|| anyhow!("slot index has no present slots"))?;
        if header_bytes == 0 || header_bytes > MAX_HEADER_BYTES {
            bail!("CAR header length {header_bytes} is outside the accepted range");
        }
        let (first_slot, source_start) =
            selected_first.ok_or_else(|| anyhow!("selected slot range has no blocks"))?;
        let (last_slot, source_end) = selected_last.expect("selected first implies selected last");
        let range_bytes = source_end
            .checked_sub(source_start)
            .ok_or_else(|| anyhow!("selected source range is reversed"))?;
        if range_bytes != selected_sum {
            bail!("selected slot ranges contain an unexplained byte gap");
        }
        Ok(Self {
            first_slot,
            last_slot,
            present_slots,
            skipped_slots,
            header_bytes,
            source_start,
            source_end,
            range_bytes,
        })
    }

    fn matches_plan(&self, plan: &ExtractPlan) -> Result<()> {
        let expected = (
            plan.first_slot,
            plan.last_slot,
            plan.present_slots,
            plan.skipped_slots,
            plan.header_bytes,
            plan.source_start,
            plan.source_end,
            plan.range_bytes,
        );
        let actual = (
            self.first_slot,
            self.last_slot,
            self.present_slots,
            self.skipped_slots,
            self.header_bytes,
            self.source_start,
            self.source_end,
            self.range_bytes,
        );
        if actual != expected {
            bail!("slot index no longer matches the extract plan");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

impl ContentRange {
    fn parse(value: &str) -> Result<Self> {
        let value = value
            .strip_prefix("bytes ")
            .ok_or_else(|| anyhow!("invalid Content-Range unit"))?;
        let (range, total) = value
            .split_once('/')
            .ok_or_else(|| anyhow!("invalid Content-Range"))?;
        let (start, end) = range
            .split_once('-')
            .ok_or_else(|| anyhow!("invalid Content-Range bounds"))?;
        let parsed = Self {
            start: start.parse().context("invalid Content-Range start")?,
            end: end.parse().context("invalid Content-Range end")?,
            total: total.parse().context("invalid Content-Range total")?,
        };
        if parsed.end < parsed.start || parsed.end >= parsed.total {
            bail!("invalid Content-Range ordering");
        }
        Ok(parsed)
    }
}

#[derive(Debug)]
struct ByteMeter {
    used: u64,
    max: u64,
}

impl ByteMeter {
    const fn new(max: u64) -> Self {
        Self { used: 0, max }
    }

    fn take(&mut self, bytes: u64) -> Result<()> {
        let next = self
            .used
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("byte meter overflow"))?;
        if next > self.max {
            bail!("resource ceiling exceeded: {next} > {} bytes", self.max);
        }
        self.used = next;
        Ok(())
    }

    const fn used(&self) -> u64 {
        self.used
    }
}

struct StageDir {
    path: PathBuf,
    armed: bool,
}

impl StageDir {
    fn new(parent: &Path, label: Option<&str>) -> Result<Self> {
        let label = label.unwrap_or("extract");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock precedes Unix epoch")?
            .as_nanos();
        let path = parent.join(format!(
            ".fervor-stage-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path)
            .with_context(|| format!("failed to create staging directory: {}", path.display()))?;
        Ok(Self { path, armed: true })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StageDir {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn validate_base(
    base: &Url,
    allowed_hosts: &BTreeSet<String>,
    allow_loopback_http: bool,
) -> Result<()> {
    validate_url(base, allowed_hosts, allow_loopback_http)?;
    if !base.path().ends_with('/') {
        bail!("archive base URL path must end with '/'");
    }
    Ok(())
}

fn validate_url(
    url: &Url,
    allowed_hosts: &BTreeSet<String>,
    allow_loopback_http: bool,
) -> Result<()> {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("archive URLs cannot contain credentials, query, or fragment");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("archive URL must have a host"))?;
    if !allowed_hosts.contains(host) {
        bail!("archive host is not allowlisted: {host}");
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if allow_loopback_http && is_loopback(host) => Ok(()),
        _ => bail!("archive URL must use HTTPS"),
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn validate_mint(mint: &str) -> Result<()> {
    let bytes = bs58::decode(mint)
        .into_vec()
        .context("target mint is not valid base58")?;
    if bytes.len() != 32 {
        bail!("target mint must decode to 32 bytes");
    }
    Ok(())
}

fn validate_slots(epoch: u64, start_slot: u64, end_slot: u64) -> Result<()> {
    if start_slot >= end_slot {
        bail!("slot range must be non-empty and half-open [start, end)");
    }
    let epoch_start = epoch
        .checked_mul(SLOTS_PER_EPOCH)
        .ok_or_else(|| anyhow!("epoch slot range overflow"))?;
    let epoch_end = epoch_start
        .checked_add(SLOTS_PER_EPOCH)
        .ok_or_else(|| anyhow!("epoch slot range overflow"))?;
    if start_slot < epoch_start || end_slot > epoch_end {
        bail!("slot range must stay within epoch {epoch}: [{epoch_start}, {epoch_end})");
    }
    Ok(())
}

fn validate_plan(plan: &ExtractPlan, source: &ArchiveSource) -> Result<()> {
    validate_plan_shape(plan)?;
    if plan.source != SourcePin::default() {
        bail!("extract plan source revisions do not match this binary");
    }
    if plan.base_url != source.base.as_str() {
        bail!("plan archive base does not match the configured source");
    }
    for value in [
        &plan.index_url,
        &plan.car_url,
        &plan.car_sha_url,
        &plan.car_cid_url,
    ] {
        let url = Url::parse(value).context("plan contains an invalid source URL")?;
        validate_url(&url, &source.allowed_hosts, source.allow_loopback_http)?;
        if !url.as_str().starts_with(source.base.as_str()) {
            bail!("plan source URL escapes the configured archive base");
        }
    }
    Ok(())
}

fn validate_plan_shape(plan: &ExtractPlan) -> Result<()> {
    if plan.schema != PLAN_SCHEMA {
        bail!("unsupported extract plan schema: {}", plan.schema);
    }
    validate_mint(&plan.mint)?;
    validate_slots(plan.epoch, plan.start_slot, plan.end_slot)?;
    if plan.network != "mainnet-beta" {
        bail!("archive pilot only supports mainnet-beta");
    }
    if plan.index_bytes != INDEX_BYTES {
        bail!("plan contains an unsupported slot index size");
    }
    let range_bytes = plan.source_end.checked_sub(plan.source_start);
    let raw_bytes = plan.header_bytes.checked_add(plan.range_bytes);
    let download_bytes = plan.index_bytes.checked_add(plan.raw_bytes);
    if plan.source_end <= plan.source_start
        || plan.source_end > plan.car_bytes
        || range_bytes != Some(plan.range_bytes)
        || raw_bytes != Some(plan.raw_bytes)
        || download_bytes != Some(plan.download_bytes)
        || plan.workspace_bytes < plan.download_bytes
        || plan.download_bytes > plan.max_download
        || plan.workspace_bytes > plan.max_workspace
    {
        bail!("extract plan byte accounting is inconsistent");
    }
    if !is_sha256(&plan.index_sha256) || !is_sha256(&plan.car_sha256) {
        bail!("extract plan contains an invalid SHA-256 value");
    }
    if plan.source.jetstreamer_version.is_empty()
        || !is_revision(&plan.source.jetstreamer_revision)
        || plan.source.faithful_version.is_empty()
        || !is_revision(&plan.source.faithful_revision)
        || plan.source.reviewed_at.is_empty()
        || plan.source.access_review.is_empty()
    {
        bail!("extract plan source provenance is malformed");
    }
    Ok(())
}

fn parse_sha256(value: &str) -> Result<String> {
    let hash = value
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow!("CAR SHA-256 metadata is empty"))?
        .to_ascii_lowercase();
    if !is_sha256(&hash) {
        bail!("CAR SHA-256 metadata is malformed");
    }
    Ok(hash)
}

fn parse_cid(value: &str) -> Result<String> {
    let cid = value.trim();
    if cid.len() < 20
        || cid.len() > 128
        || !cid
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        bail!("CAR CID metadata is malformed");
    }
    Ok(cid.into())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > limit {
        bail!(
            "{} is not a regular file within the byte limit",
            path.display()
        );
    }
    fs::read(path).with_context(|| format!("failed to read {}", path.display()))
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn validate_car_header(path: &Path, header_bytes: u64) -> Result<()> {
    let mut file = File::open(path)?;
    let mut prefix = [0u8; 10];
    let read = file.read(&mut prefix)?;
    let (header_len, prefix_len) = decode_varint(&prefix[..read])?;
    if header_len
        .checked_add(prefix_len as u64)
        .is_none_or(|total| total != header_bytes)
    {
        bail!("raw extract CAR header length does not match the plan");
    }
    Ok(())
}

fn decode_varint(bytes: &[u8]) -> Result<(u64, usize)> {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().copied().enumerate().take(10) {
        if index == 9 && byte > 1 {
            bail!("CAR header varint overflow");
        }
        value |= ((byte & 0x7f) as u64) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
    }
    bail!("CAR header varint is incomplete")
}

fn ensure_workspace(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("workspace does not exist: {}", path.display()))?;
    if !metadata.is_dir() {
        bail!("workspace is not a directory: {}", path.display());
    }
    Ok(())
}

fn partial_path(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("output path needs a UTF-8 filename"))?;
    Ok(path.with_file_name(format!(".{name}.partial-{}", std::process::id())))
}

fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

async fn retry_delay(attempt: usize) {
    let millis = 250u64.saturating_mul(1u64 << attempt.min(4));
    sleep(Duration::from_millis(millis)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
    };

    const EPOCH: u64 = 1;
    const EPOCH_START: u64 = SLOTS_PER_EPOCH;
    const START_SLOT: u64 = EPOCH_START + 10;
    const END_SLOT: u64 = EPOCH_START + 14;
    const MINT: &str = "11111111111111111111111111111111";

    #[derive(Clone, Copy, Debug)]
    enum RangeMode {
        Good,
        Ignore,
        TruncateOnce,
    }

    struct FakeArchive {
        base: String,
        car_gets: Arc<AtomicUsize>,
        task: JoinHandle<()>,
    }

    impl FakeArchive {
        async fn start(mode: RangeMode) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let index = Arc::new(test_index());
            let car = Arc::new(test_car());
            let car_gets = Arc::new(AtomicUsize::new(0));
            let task_gets = Arc::clone(&car_gets);
            let task = tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let index = Arc::clone(&index);
                    let car = Arc::clone(&car);
                    let car_gets = Arc::clone(&task_gets);
                    tokio::spawn(async move {
                        let _ = serve(socket, mode, index, car, car_gets).await;
                    });
                }
            });
            Self {
                base: format!("http://{address}/"),
                car_gets,
                task,
            }
        }

        fn client(&self, retries: usize) -> ArchiveClient {
            let source = ArchiveSource::new(&self.base, ["127.0.0.1"], true)
                .unwrap()
                .with_retries(retries);
            ArchiveClient::new(source).unwrap()
        }

        fn car_gets(&self) -> usize {
            self.car_gets.load(Ordering::Relaxed)
        }
    }

    impl Drop for FakeArchive {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[test]
    fn parses_exact_contiguous_range() {
        let range = RangeInfo::parse(&test_index(), EPOCH, START_SLOT, END_SLOT).unwrap();
        assert_eq!(range.header_bytes, 5);
        assert_eq!(range.source_start, 5);
        assert_eq!(range.source_end, 14);
        assert_eq!(range.range_bytes, 9);
        assert_eq!(range.present_slots, 3);
        assert_eq!(range.skipped_slots, 1);
    }

    #[test]
    fn rejects_non_contiguous_index() {
        let mut index = test_index();
        set_record(&mut index, 13, 11, 4);
        let error = RangeInfo::parse(&index, EPOCH, START_SLOT, END_SLOT).unwrap_err();
        assert!(error.to_string().contains("non-contiguous"));
    }

    #[test]
    fn rejects_nonzero_skipped_offset() {
        let mut index = test_index();
        set_record(&mut index, 12, 9, 0);
        let error = RangeInfo::parse(&index, EPOCH, START_SLOT, END_SLOT).unwrap_err();
        assert!(error.to_string().contains("zero-length"));
    }

    #[tokio::test]
    async fn inspect_extract_verify_round_trip() {
        let server = FakeArchive::start(RangeMode::Good).await;
        let temp = tempfile::tempdir().unwrap();
        let client = server.client(1);
        let plan = inspect(&client, temp.path(), 10 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(plan.range_bytes, 9);
        assert_eq!(plan.raw_bytes, 14);
        assert_eq!(server.car_gets(), 0);

        let out = temp.path().join("extract");
        let manifest = client.extract(&plan, &out).await.unwrap();
        assert_eq!(manifest.raw_bytes, 14);
        assert_eq!(fs::read(out.join("raw.car")).unwrap(), test_car());
        let report = verify_extract(&out).unwrap();
        assert_eq!(report.raw_sha256, manifest.raw_sha256);
        assert_eq!(report.present_slots, 3);
        assert_eq!(server.car_gets(), 2);
    }

    #[tokio::test]
    async fn ignored_range_never_publishes() {
        let server = FakeArchive::start(RangeMode::Ignore).await;
        let temp = tempfile::tempdir().unwrap();
        let client = server.client(0);
        let plan = inspect(&client, temp.path(), 10 * 1024 * 1024)
            .await
            .unwrap();
        let out = temp.path().join("extract");
        let error = client.extract(&plan, &out).await.unwrap_err();
        assert!(error.to_string().contains("non-206"));
        assert!(!out.exists());
        assert_no_stage(temp.path());
    }

    #[tokio::test]
    async fn truncated_range_resumes_without_duplicate_bytes() {
        let server = FakeArchive::start(RangeMode::TruncateOnce).await;
        let temp = tempfile::tempdir().unwrap();
        let client = server.client(2);
        let plan = inspect(&client, temp.path(), 10 * 1024 * 1024)
            .await
            .unwrap();
        let out = temp.path().join("extract");
        client.extract(&plan, &out).await.unwrap();
        assert_eq!(fs::read(out.join("raw.car")).unwrap(), test_car());
        assert!(server.car_gets() >= 3);
        verify_extract(&out).unwrap();
    }

    #[tokio::test]
    async fn ceiling_fails_before_bulk_car_get() {
        let server = FakeArchive::start(RangeMode::Good).await;
        let temp = tempfile::tempdir().unwrap();
        let client = server.client(0);
        let error = inspect(&client, temp.path(), INDEX_BYTES + 13)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("download ceiling"));
        assert_eq!(server.car_gets(), 0);
    }

    #[tokio::test]
    async fn corrupted_extract_fails_verification() {
        let server = FakeArchive::start(RangeMode::Good).await;
        let temp = tempfile::tempdir().unwrap();
        let client = server.client(0);
        let plan = inspect(&client, temp.path(), 10 * 1024 * 1024)
            .await
            .unwrap();
        let out = temp.path().join("extract");
        client.extract(&plan, &out).await.unwrap();
        let raw = out.join("raw.car");
        let mut bytes = fs::read(&raw).unwrap();
        bytes[10] ^= 0xff;
        fs::write(&raw, bytes).unwrap();
        assert!(verify_extract(&out)
            .unwrap_err()
            .to_string()
            .contains("hash mismatch"));
    }

    async fn inspect(
        client: &ArchiveClient,
        workspace: &Path,
        max_download: u64,
    ) -> Result<ExtractPlan> {
        client
            .inspect(&InspectReq {
                epoch: EPOCH,
                start_slot: START_SLOT,
                end_slot: END_SLOT,
                mint: MINT.into(),
                max_download,
                max_workspace: 20 * 1024 * 1024,
                workspace: workspace.into(),
            })
            .await
    }

    fn test_index() -> Vec<u8> {
        let mut index = vec![0u8; INDEX_BYTES as usize];
        set_record(&mut index, 10, 5, 3);
        set_record(&mut index, 11, 8, 2);
        set_record(&mut index, 13, 10, 4);
        index
    }

    fn set_record(index: &mut [u8], relative_slot: usize, offset: u64, length: u32) {
        let start = relative_slot * SLOT_RECORD_BYTES;
        index[start..start + 8].copy_from_slice(&offset.to_le_bytes());
        index[start + 8..start + 12].copy_from_slice(&length.to_le_bytes());
    }

    fn test_car() -> Vec<u8> {
        vec![
            4, 1, 2, 3, 4, b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h', b'i',
        ]
    }

    fn assert_no_stage(parent: &Path) {
        let has_stage = fs::read_dir(parent).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".fervor-stage-")
        });
        assert!(!has_stage);
    }

    async fn serve(
        mut socket: TcpStream,
        mode: RangeMode,
        index: Arc<Vec<u8>>,
        car: Arc<Vec<u8>>,
        car_gets: Arc<AtomicUsize>,
    ) -> Result<()> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await?;
            if read == 0 {
                return Ok(());
            }
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
            if request.len() > 16 * 1024 {
                bail!("oversized test request");
            }
        }
        let request = String::from_utf8(request)?;
        let mut lines = request.lines();
        let first = lines
            .next()
            .ok_or_else(|| anyhow!("missing request line"))?;
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or_default();
        let range = lines.find_map(|line| {
            line.strip_prefix("range: ")
                .or_else(|| line.strip_prefix("Range: "))
        });

        let index_path = format!("/{EPOCH}/epoch-{EPOCH}-slot-ranges.raw");
        let car_path = format!("/{EPOCH}/epoch-{EPOCH}.car");
        let sha_path = format!("/{EPOCH}/epoch-{EPOCH}.sha256");
        let cid_path = format!("/{EPOCH}/epoch-{EPOCH}.cid");
        if method == "HEAD" && path == index_path {
            return respond(&mut socket, "200 OK", index.len(), &[], None).await;
        }
        if method == "GET" && path == index_path {
            return respond(&mut socket, "200 OK", index.len(), &index, None).await;
        }
        if method == "HEAD" && path == car_path {
            return respond(&mut socket, "200 OK", car.len(), &[], None).await;
        }
        if method == "GET" && path == sha_path {
            let body = format!("{}  epoch-{EPOCH}.car\n", sha256(&car));
            return respond(&mut socket, "200 OK", body.len(), body.as_bytes(), None).await;
        }
        if method == "GET" && path == cid_path {
            let body = b"bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
            return respond(&mut socket, "200 OK", body.len(), body, None).await;
        }
        if method == "GET" && path == car_path {
            let hit = car_gets.fetch_add(1, Ordering::Relaxed);
            if matches!(mode, RangeMode::Ignore) {
                return respond(&mut socket, "200 OK", car.len(), &car, None).await;
            }
            let (start, end) = parse_range(range.ok_or_else(|| anyhow!("missing Range"))?)?;
            let body = &car[start..=end];
            let content_range = format!("bytes {start}-{end}/{}", car.len());
            if matches!(mode, RangeMode::TruncateOnce) && hit == 0 {
                let truncated = body.len() / 2;
                return respond(
                    &mut socket,
                    "206 Partial Content",
                    body.len(),
                    &body[..truncated],
                    Some(&content_range),
                )
                .await;
            }
            return respond(
                &mut socket,
                "206 Partial Content",
                body.len(),
                body,
                Some(&content_range),
            )
            .await;
        }
        respond(&mut socket, "404 Not Found", 0, &[], None).await
    }

    async fn respond(
        socket: &mut TcpStream,
        status: &str,
        declared_len: usize,
        body: &[u8],
        content_range: Option<&str>,
    ) -> Result<()> {
        let range_header = content_range
            .map(|value| format!("Content-Range: {value}\r\n"))
            .unwrap_or_default();
        let headers = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {declared_len}\r\n{range_header}Connection: close\r\n\r\n"
        );
        socket.write_all(headers.as_bytes()).await?;
        socket.write_all(body).await?;
        socket.shutdown().await?;
        Ok(())
    }

    fn parse_range(value: &str) -> Result<(usize, usize)> {
        let bounds = value
            .strip_prefix("bytes=")
            .ok_or_else(|| anyhow!("invalid test range"))?;
        let (start, end) = bounds
            .split_once('-')
            .ok_or_else(|| anyhow!("invalid test range"))?;
        Ok((start.parse()?, end.parse()?))
    }
}
