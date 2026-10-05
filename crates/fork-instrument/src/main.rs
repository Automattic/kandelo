//! CLI frontend for `fork-instrument`.
//!
//! Usage:
//!
//! ```text
//! wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
//!                      [--post-optimize O2|O1|O3|Os|Oz|none]
//! ```
//!
//! After instrumenting, the CLI runs Binaryen's `wasm-opt` over the result
//! (`$WASM_OPT`, else `wasm-opt` on PATH). Inputs are expected to be
//! optimized already, so the full pipeline is wasm-opt -> instrument ->
//! wasm-opt: the first pass shrinks the call graph the instrumenter has to
//! cover, and this second pass cleans up the code the instrumenter adds.
//!
//! Exits non-zero with a human-readable error on any failure (parse,
//! validation, or instrumentation). Errors include the input file path
//! and the operation that failed.

use anyhow::{Context, Result};
use clap::Parser;
use std::fs;
use std::process::Command;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use fork_instrument::{
    Options, analyze, sink_report,
    contract_inventory::{
        artifact_identity, fork_capability_section_hex, fork_contract_inventory,
        linked_frame_descriptor_section_hex, reserved_env_imports,
    },
    instrument,
};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
)]
struct Cli {
    /// Input wasm file to instrument.
    input: PathBuf,

    /// Output path for the instrumented wasm file. Required unless an
    /// analysis or contract-inspection mode is set.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    /// `env.fork` selects complete dynamically linked side-module boundary
    /// coverage, including downstream fork in another side module.
    #[arg(long, default_value = "kernel.kernel_fork")]
    entry: String,

    /// Instrument the full fork closure instead of stopping the unwind at
    /// fork boundaries (sinks). For comparison and diagnosis.
    #[arg(long)]
    no_sinks: bool,

    /// Research only: instrument the set and boundaries listed in this plan
    /// file (see `Options::sink_plan`) instead of the built-in sink analysis.
    #[arg(long, hide = true)]
    sink_plan: Option<std::path::PathBuf>,

    /// Ignore the compiler facts (`kandelo.calltypes` section) and use the
    /// sink analysis without them. For diagnosis. The section is removed
    /// from the output either way.
    #[arg(long)]
    no_facts: bool,

    /// With compiler facts: do not apply C's effective-type rule anywhere.
    /// By default it applies in each unit compiled with strict aliasing (the
    /// C default) and nowhere else.
    #[arg(long)]
    no_effective_types: bool,

    /// For a program that can dlopen: `traced-entries` (default) instruments
    /// the main program as if no side module returns through a fork child
    /// into its frames and records that contract so the host refuses side
    /// modules that could; `assume-all-entries-fork-returning` instruments for
    /// every side-module entry and loads any library.
    #[arg(long, default_value = "traced-entries", value_parser = ["traced-entries", "assume-all-entries-fork-returning"])]
    side_modules: String,

    /// Diagnosis: print which analysis decided the instrumented set
    /// (`source\t<closure|builtin|facts|plan>`), then the set and its
    /// boundaries as `A\t<name>` and `B\t<name>` rows (a valid
    /// `--sink-plan` file). Emits no output file.
    #[arg(long, hide = true, conflicts_with = "output")]
    sink_report: bool,

    /// wasm-opt level to run over an instrumented output, or `none`.
    ///
    /// Runs only when instrumentation changed the module; a module outside
    /// any fork transaction is written back byte-for-byte. Names and DWARF
    /// are kept (`wasm-opt -g`) when the input carried them. `none` exists
    /// for inspecting the instrumenter's raw output, not for shipping.
    #[arg(long, default_value = "O2", value_parser = ["O1", "O2", "O3", "Os", "Oz", "none"])]
    post_optimize: String,

    /// Analyze the module and print the discovered fork-path function
    /// set as JSON to stdout. Skips instrumentation and output emission.
    /// Useful for validating call-graph discovery against
    /// hand-maintained onlylists.
    #[arg(long)]
    discover_only: bool,

    /// Print the fork-artifact structural inventory as one TSV row.
    /// This mode performs no instrumentation and emits no output file.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "artifact_identity",
            "reserved_env_imports",
            "output"
        ]
    )]
    contract_inventory: bool,

    /// Print relocatable, memory, and strict ABI-export identity as one TSV row.
    /// This mode performs no instrumentation and emits no output file.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    artifact_identity: bool,

    /// Print the unique fork-capability custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    fork_capability_hex: bool,

    /// Print the unique linked-frame descriptor custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    linked_frame_descriptor_hex: bool,

    /// Print reserved env imports as `<kind>\t<module>.<name>` rows.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "output"
        ]
    )]
    reserved_env_imports: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let input =
        fs::read(&cli.input).with_context(|| format!("reading input: {}", cli.input.display()))?;

    if cli.contract_inventory {
        let inventory = fork_contract_inventory(&input)
            .with_context(|| format!("inventorying {}", cli.input.display()))?;
        println!("{inventory}");
        return Ok(());
    }
    if cli.artifact_identity {
        let identity = artifact_identity(&input)
            .with_context(|| format!("inspecting artifact identity: {}", cli.input.display()))?;
        println!("{identity}");
        return Ok(());
    }
    if cli.fork_capability_hex {
        let hex = fork_capability_section_hex(&input)
            .with_context(|| format!("reading fork capability: {}", cli.input.display()))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.linked_frame_descriptor_hex {
        let hex = linked_frame_descriptor_section_hex(&input)
            .with_context(|| format!("reading linked-frame descriptor: {}", cli.input.display()))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.reserved_env_imports {
        let imports = reserved_env_imports(&input)
            .with_context(|| format!("inventorying reserved imports: {}", cli.input.display()))?;
        for import in imports {
            println!("{}\t{}", import.kind, import.identity);
        }
        return Ok(());
    }

    let opts = Options {
        entry_import: cli.entry,
        sinks: !cli.no_sinks,
        sink_plan: cli.sink_plan.clone(),
        facts: !cli.no_facts,
        effective_types: !cli.no_effective_types,
        side_modules: if cli.side_modules == "assume-all-entries-fork-returning" {
            fork_instrument::SideModules::AssumeAllEntriesForkReturning
        } else {
            fork_instrument::SideModules::TracedEntries
        },
    };

    if cli.sink_report {
        let report = sink_report(&input, &opts)
            .with_context(|| format!("analyzing {}", cli.input.display()))?;
        println!("source\t{}", report.source.as_str());
        if let Some(f) = &report.facts {
            println!(
                "facts\tchunks {} definitions {} defined {} bound {} union {} signature-mismatch {}",
                f.chunks, f.definitions, f.defined, f.bound, f.bound_to_union, f.signature_mismatch
            );
        }
        if let Some(e) = &report.facts_error {
            println!("facts-error\t{e}");
        }
        for name in &report.instrumented {
            println!("A\t{name}");
        }
        for name in &report.boundaries {
            println!("B\t{name}");
        }
        return Ok(());
    }

    if cli.discover_only {
        let analysis =
            analyze(&input, &opts).with_context(|| format!("analyzing {}", cli.input.display()))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output_path = cli.output.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "--output is required unless an analysis or contract-inspection mode is set"
        )
    })?;
    // Capture this before writing: `--output` is allowed to name the input
    // file, and output creation/truncation must not become the source of truth
    // for the executable mode we are preserving.
    let input_mode = input_mode(&cli.input)?;

    let output = instrument(&input, &opts)
        .with_context(|| format!("instrumenting {}", cli.input.display()))?;

    fs::write(output_path, &output)
        .with_context(|| format!("writing output: {}", output_path.display()))?;
    // A module outside any fork transaction comes back as the input without
    // its compiler facts; it was not transformed, so it is not optimized.
    let untransformed = output == input
        || fork_instrument::facts::strip_section(&input)?.is_some_and(|stripped| stripped == output);
    if cli.post_optimize != "none" && !untransformed {
        post_optimize(output_path, &cli.post_optimize, has_debug_info(&input)?)?;
    }
    preserve_input_mode(input_mode, output_path)?;

    Ok(())
}

/// Whether the module carries a name section or DWARF the caller chose to
/// keep. wasm-opt drops both unless run with `-g`.
fn has_debug_info(bytes: &[u8]) -> Result<bool> {
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        if let wasmparser::Payload::CustomSection(section) = payload? {
            if section.name() == "name" || section.name().starts_with(".debug_") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Optimize the instrumented module in place.
///
/// WHY here and not in each build script: this is the one step every fork
/// artifact passes through, and only it knows whether instrumentation changed
/// the module. The instrumenter's metadata is position-independent (ABI 46),
/// so wasm-opt may remove unused imports and renumber functions, globals and
/// tables. A missing wasm-opt is an error, not a skipped step: the artifact
/// would differ from what every other build of the same sources produces.
fn post_optimize(path: &Path, level: &str, keep_debug_info: bool) -> Result<()> {
    let wasm_opt = std::env::var_os("WASM_OPT").unwrap_or_else(|| "wasm-opt".into());
    let mut command = Command::new(&wasm_opt);
    command.arg(path).arg(format!("-{level}"));
    if keep_debug_info {
        command.arg("-g");
    }
    command.arg("-o").arg(path);
    let status = command.status().with_context(|| {
        format!(
            "running {} after fork instrumentation (Binaryen is required; \
             run inside scripts/dev-shell.sh or set WASM_OPT)",
            Path::new(&wasm_opt).display()
        )
    })?;
    anyhow::ensure!(
        status.success(),
        "{} -{level} failed on instrumented output {} ({status})",
        Path::new(&wasm_opt).display(),
        path.display()
    );
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
        let comma = if i + 1 == analysis.fork_path.len() {
            ""
        } else {
            ","
        };
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
