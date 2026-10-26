//! CLI frontend for `fork-instrument`.
//!
//! Usage:
//!
//! ```text
//! wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
//!                      [--post-optimize Os|O1|O2|O3|Oz|none] [--keep-names]
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
use fork_instrument::artifact_io::MappedArtifact;
#[path = "cli/options.rs"]
mod options;
#[path = "cli/transform.rs"]
mod transform;
use options::Cli;

use fork_instrument::{
    Options, analyze,
    contract_inventory::{
        artifact_identity, fork_capability_section_hex, fork_contract_inventory,
        legacy_asyncify_exports, linked_frame_descriptor_section_hex, reserved_env_imports,
    },
    sink_report,
};

fn main() -> Result<()> {
    let cli = Cli::parse();

    let (snapshot, permissions) = MappedArtifact::read(&cli.input, cli.max_input_bytes)?;
    let input = snapshot.bytes();

    if cli.streaming_scan {
        let scan = fork_instrument::streaming::scan(&input)
            .with_context(|| format!("scanning original module: {}", cli.input.display()))?;
        println!("input-bytes\t{}", input.len());
        println!("functions\t{}", scan.functions.len());
        println!("operators\t{}", scan.operators);
        println!(
            "max-body-bytes\t{}",
            scan.functions
                .iter()
                .filter_map(|f| f.body.as_ref())
                .map(|b| b.range.len())
                .max()
                .unwrap_or(0)
        );
        if !cli.no_facts
            && scan
                .custom_data(fork_instrument::facts::SECTION)
                .next()
                .is_some()
        {
            match scan.bind_fact_definitions() {
                Ok(bindings) => println!(
                    "facts-definitions-bound\t{}",
                    bindings.iter().filter(|(_, b)| !b.is_empty()).count()
                ),
                Err(error) => println!("facts-definitions-error\t{error:#}"),
            }
        }
        return Ok(());
    }

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
    if cli.legacy_asyncify_exports {
        let names = legacy_asyncify_exports(&input)
            .with_context(|| format!("inventorying exports: {}", cli.input.display()))?;
        for name in names {
            println!("{name}");
        }
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
        facts: !cli.no_facts,
        effective_types: !cli.no_effective_types,
        side_modules: if cli.side_modules == "assume-all-entries-fork-returning" {
            fork_instrument::SideModules::AssumeAllEntriesForkReturning
        } else {
            fork_instrument::SideModules::TracedEntries
        },
    };

    if cli.sink_report {
        let report = sink_report(input, &opts)
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
            analyze(input, &opts).with_context(|| format!("analyzing {}", cli.input.display()))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output_path = cli.output.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "--output is required unless an analysis or contract-inspection mode is set"
        )
    })?;
    transform::run(
        input,
        &opts,
        output_path,
        permissions,
        transform::Settings {
            optimize: &cli.post_optimize,
            keep_names: cli.keep_names,
            output_bytes: cli.max_output_bytes,
        },
    )
    .with_context(|| format!("instrumenting {}", cli.input.display()))
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
