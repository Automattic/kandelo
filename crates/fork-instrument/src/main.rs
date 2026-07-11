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
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use fork_instrument::{Options, analyze, instrument};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
)]
struct Cli {
    /// Input wasm file to instrument.
    input: PathBuf,

    /// Output path for the instrumented wasm file. Required unless
    /// `--discover-only` is set (analysis-only mode).
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    #[arg(long, default_value = "kernel.kernel_fork")]
    entry: String,

    /// Analyze the module and print the discovered fork-path function
    /// set as JSON to stdout. Skips instrumentation and output emission.
    /// Useful for validating call-graph discovery against
    /// hand-maintained onlylists.
    #[arg(long)]
    discover_only: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let input = fs::read(&cli.input)
        .with_context(|| format!("reading input: {}", cli.input.display()))?;

    let opts = Options {
        entry_import: cli.entry,
    };

    if cli.discover_only {
        let analysis = analyze(&input, &opts)
            .with_context(|| format!("analyzing {}", cli.input.display()))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output_path = cli.output.as_ref().ok_or_else(|| {
        anyhow::anyhow!("--output is required unless --discover-only is set")
    })?;
    // Capture this before writing: `--output` is allowed to name the input
    // file, and output creation/truncation must not become the source of truth
    // for the executable mode we are preserving.
    let input_mode = input_mode(&cli.input)?;

    let output = instrument(&input, &opts)
        .with_context(|| format!("instrumenting {}", cli.input.display()))?;

    fs::write(output_path, &output)
        .with_context(|| format!("writing output: {}", output_path.display()))?;
    preserve_input_mode(input_mode, output_path)?;

    Ok(())
}

#[cfg(unix)]
fn input_mode(input_path: &Path) -> Result<u32> {
    let mode = fs::metadata(input_path)
        .with_context(|| format!("stat input for permissions: {}", input_path.display()))?
        .permissions()
        .mode();
    Ok(mode)
}

#[cfg(not(unix))]
fn input_mode(_input_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn preserve_input_mode(input_mode: u32, output_path: &Path) -> Result<()> {
    let permissions = fs::Permissions::from_mode(input_mode);
    fs::set_permissions(output_path, permissions)
        .with_context(|| format!("setting output permissions: {}", output_path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn preserve_input_mode(_input_mode: (), _output_path: &Path) -> Result<()> {
    Ok(())
}

fn print_analysis_json(analysis: &fork_instrument::Analysis) {
    // Hand-rolled JSON to avoid a serde dependency for a tiny output.
    // Format is one-entry-per-line array of `{name, is_import}` objects.
    println!("{{");
    println!("  \"fork_path\": [");
    for (i, entry) in analysis.fork_path.iter().enumerate() {
        let comma = if i + 1 == analysis.fork_path.len() { "" } else { "," };
        println!(
            "    {{ \"name\": {}, \"is_import\": {} }}{}",
            json_string(&entry.name),
            entry.is_import,
            comma,
        );
    }
    println!("  ],");
    println!("  \"count\": {}", analysis.fork_path.len());
    println!("}}");
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
