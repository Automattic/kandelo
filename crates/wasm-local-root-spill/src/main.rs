use anyhow::{Context, Result};
use clap::Parser;
use std::fs;
use std::path::PathBuf;

use wasm_local_root_spill::{Options, spill};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-local-root-spill",
    about = "Spill wasm locals into linear memory for conservative GC root visibility",
    long_about = "Rewrite a supported wasm32 runtime binary so conservative stack-scanning GCs can see selected scalar roots that would otherwise live only in Wasm locals or operand-stack carryovers. The first production profile is `ruby`; unsupported profiles and root widths fail loudly."
)]
struct Cli {
    /// Input wasm file to rewrite.
    input: PathBuf,

    /// Output path for the rewritten wasm file.
    #[arg(short, long)]
    output: PathBuf,

    /// Instrumentation profile. Stage 1 supports only `ruby`.
    #[arg(long, default_value = "ruby")]
    profile: String,

    /// Guest value width in bits. Stage 1 supports only 32.
    #[arg(long, default_value_t = 32)]
    value_width: u32,

    /// Diagnostic spill set. Default preserves production behavior.
    #[arg(long, default_value = "all-i32")]
    spill_set: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let input =
        fs::read(&cli.input).with_context(|| format!("reading input: {}", cli.input.display()))?;

    let opts = Options {
        profile: cli.profile,
        value_width: cli.value_width,
        spill_set: cli.spill_set.parse()?,
    };
    let output =
        spill(&input, &opts).with_context(|| format!("rewriting {}", cli.input.display()))?;

    fs::write(&cli.output, output)
        .with_context(|| format!("writing output: {}", cli.output.display()))?;

    Ok(())
}
