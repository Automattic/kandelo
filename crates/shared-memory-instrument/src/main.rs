use anyhow::{Context, Result, ensure};
use clap::Parser;
use std::{fs, io::Write, path::PathBuf};
#[derive(Parser)]
#[command(
    about = "Prepare a trusted memory-group executable; ordinary hosts reject its required extension"
)]
struct Cli {
    input: PathBuf,
    #[arg(long)]
    helpers: PathBuf,
    #[arg(long)]
    abi_digest: String,
    #[arg(short, long)]
    output: PathBuf,
}
fn main() -> Result<()> {
    let cli = Cli::parse();
    ensure!(
        cli.input.canonicalize()? != cli.output.canonicalize().unwrap_or(cli.output.clone()),
        "retain the ordinary input; output must be distinct"
    );
    #[cfg(unix)]
    if let Ok(existing) = fs::metadata(&cli.output) {
        use std::os::unix::fs::MetadataExt;
        let input = fs::metadata(&cli.input)?;
        ensure!(
            input.dev() != existing.dev() || input.ino() != existing.ino(),
            "output must not alias the ordinary input"
        );
    }
    let (output, report) = shared_memory_instrument::translate(
        &fs::read(&cli.input).context("reading input")?,
        &fs::read(&cli.helpers).context("reading helpers")?,
        &cli.abi_digest,
    )?;
    let parent = cli
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(&output).context("writing staged output")?;
    staged
        .as_file()
        .set_permissions(fs::metadata(&cli.input)?.permissions())?;
    staged
        .persist(&cli.output)
        .context("publishing grouped output")?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
