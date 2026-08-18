use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use fervor_feed_rs::archive::{
    read_plan, verify_extract, write_plan, ArchiveClient, ArchiveSource, InspectReq, DEFAULT_BASE,
};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "fervor-corpus")]
#[command(about = "Build bounded, checksummed Fervor replay extracts")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Inspect {
        #[arg(long)]
        epoch: u64,
        #[arg(long)]
        start_slot: u64,
        #[arg(long)]
        end_slot: u64,
        #[arg(long)]
        mint: String,
        #[arg(long, default_value = "10GiB", value_parser = parse_bytes)]
        max_download: u64,
        #[arg(long, default_value = "40GiB", value_parser = parse_bytes)]
        max_workspace: u64,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        #[arg(long)]
        plan: Option<PathBuf>,
        #[command(flatten)]
        source: SourceArgs,
    },
    Extract {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[command(flatten)]
        source: SourceArgs,
    },
    Verify {
        #[arg(long)]
        dir: PathBuf,
    },
}

#[derive(Clone, Debug, clap::Args)]
struct SourceArgs {
    #[arg(long, default_value = DEFAULT_BASE)]
    base_url: String,
    #[arg(long = "allow-host")]
    allow_hosts: Vec<String>,
    #[arg(long, default_value_t = 3)]
    retries: usize,
}

impl SourceArgs {
    fn build(self) -> Result<ArchiveSource> {
        let mut hosts = self.allow_hosts;
        if self.base_url == DEFAULT_BASE
            && !hosts.iter().any(|host| host == "files.old-faithful.net")
        {
            hosts.push("files.old-faithful.net".into());
        }
        ArchiveSource::new(&self.base_url, hosts, false)
            .map(|source| source.with_retries(self.retries))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Inspect {
            epoch,
            start_slot,
            end_slot,
            mint,
            max_download,
            max_workspace,
            workspace,
            plan,
            source,
        } => {
            let client = ArchiveClient::new(source.build()?)?;
            let result = client
                .inspect(&InspectReq {
                    epoch,
                    start_slot,
                    end_slot,
                    mint,
                    max_download,
                    max_workspace,
                    workspace,
                })
                .await?;
            if let Some(path) = plan {
                write_plan(&path, &result)?;
            }
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Extract { plan, out, source } => {
            let plan = read_plan(&plan)?;
            let client = ArchiveClient::new(source.build()?)?;
            let extract = client.extract(&plan, &out);
            tokio::pin!(extract);
            let manifest = tokio::select! {
                result = &mut extract => result?,
                signal = tokio::signal::ctrl_c() => {
                    signal?;
                    bail!("extract cancelled; no final artifact was published");
                }
            };
            println!("{}", serde_json::to_string_pretty(&manifest)?);
        }
        Command::Verify { dir } => {
            println!("{}", serde_json::to_string_pretty(&verify_extract(&dir)?)?);
        }
    }
    Ok(())
}

fn parse_bytes(value: &str) -> Result<u64, String> {
    let value = value.trim();
    let digit_end = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    if digit_end == 0 {
        return Err("byte value must start with an integer".into());
    }
    let amount = value[..digit_end]
        .parse::<u64>()
        .map_err(|_| "byte value is too large".to_string())?;
    let unit = value[digit_end..].trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "" | "b" => 1,
        "kb" => 1_000,
        "kib" => 1 << 10,
        "mb" => 1_000_000,
        "mib" => 1 << 20,
        "gb" => 1_000_000_000,
        "gib" => 1 << 30,
        "tb" => 1_000_000_000_000,
        "tib" => 1 << 40,
        _ => return Err(format!("unsupported byte unit: {unit}")),
    };
    amount
        .checked_mul(multiplier)
        .ok_or_else(|| "byte value is too large".into())
}

#[cfg(test)]
mod tests {
    use super::parse_bytes;

    #[test]
    fn parses_binary_and_decimal_sizes() {
        assert_eq!(parse_bytes("10GiB").unwrap(), 10 * (1 << 30));
        assert_eq!(parse_bytes("5 GB").unwrap(), 5_000_000_000);
        assert_eq!(parse_bytes("4096").unwrap(), 4096);
        assert!(parse_bytes("1.5GiB").is_err());
    }
}
