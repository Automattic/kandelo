//! CLI frontend for `fork-instrument`.
//!
//! Usage:
//!
//! ```text
//! wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
//! ```
//!
//! Exits non-zero with a human-readable error on any failure (parse,
//! validation, or instrumentation). Errors include the input file path
//! and the operation that failed.

use anyhow::{Context, Result};
use clap::Parser;
use std::fs;
use std::path::PathBuf;

use fork_instrument::{Options, instrument};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
)]
struct Cli {
    /// Input wasm file to instrument.
    input: PathBuf,

    /// Output path for the instrumented wasm file.
    #[arg(short, long)]
    output: PathBuf,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    #[arg(long, default_value = "kernel.kernel_fork")]
    entry: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let input = fs::read(&cli.input)
        .with_context(|| format!("reading input: {}", cli.input.display()))?;

    let opts = Options {
        entry_import: cli.entry,
    };

    let output = instrument(&input, &opts)
        .with_context(|| format!("instrumenting {}", cli.input.display()))?;

    fs::write(&cli.output, &output)
        .with_context(|| format!("writing output: {}", cli.output.display()))?;

    Ok(())
}
