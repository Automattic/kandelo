use anyhow::{Context, Result};
use clap::Parser;
use std::fs;
use std::path::PathBuf;

use memory_instrument::{Options, Role, instrument, mark_for_exec};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-memory-instrument",
    about = "Route every wasm32 linear-memory access through a software page table",
    long_about = "Rewrite a wasm32 program so every load, store, atomic and bulk-memory instruction translates its address through a per-process page table that lives in linear memory. The table starts as all zeros, which is the identity mapping, so the rewritten program behaves like the original until a runtime installs other mappings."
)]
struct Cli {
    /// Input wasm file to rewrite.
    input: PathBuf,

    /// Output path for the rewritten wasm file.
    #[arg(short, long)]
    output: PathBuf,

    /// Page-crossing checks: `strict` checks every multi-byte access,
    /// `aligned` trusts natural alignment hints.
    #[arg(long, default_value = "strict")]
    crossing: String,

    /// Keep the code of the input and mark it, so the host rewrites the
    /// program in `aligned` mode when a process starts it.
    #[arg(long, conflicts_with = "crossing")]
    at_exec: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let input =
        fs::read(&cli.input).with_context(|| format!("reading input: {}", cli.input.display()))?;

    let output = if cli.at_exec {
        mark_for_exec(&input)
    } else {
        let options = Options {
            crossing: cli.crossing.parse()?,
            role: Role::Program,
        };
        instrument(&input, &options)
    }
    .with_context(|| format!("rewriting {}", cli.input.display()))?;

    fs::write(&cli.output, output)
        .with_context(|| format!("writing output: {}", cli.output.display()))?;

    Ok(())
}
