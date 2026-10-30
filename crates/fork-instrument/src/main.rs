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
#[path = "cli/io.rs"]
mod io;
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

    let io::Inputs { artifact: mut snapshot, permissions, name: input_name, output } = io::Inputs::open(&cli)?;
    if cli.original_reference {
        match fork_instrument::original_artifact::original_reference(snapshot.bytes())? {
            Some(reference) => {
                let digest: String = reference.sha256.iter().map(|byte| format!("{byte:02x}")).collect();
                println!("{}\t{digest}", reference.length);
            }
            None => println!("none"),
        }
        return Ok(());
    }
    if let Some(original_path) = &cli.verify_original {
        let reference = fork_instrument::original_artifact::original_reference(snapshot.bytes())?
            .ok_or_else(|| anyhow::anyhow!("input has no retained original-program reference"))?;
        anyhow::ensure!(reference.length <= cli.max_input_bytes,
            "original program exceeds artifact byte budget");
        fork_instrument::original_artifact::load_original_file(
            original_path, &reference, cli.max_input_bytes)?;
        return Ok(());
    }
    if cli.reprepare_from_original {
        let reference = fork_instrument::original_artifact::original_reference(snapshot.bytes())?
            .ok_or_else(|| anyhow::anyhow!("input has no retained original-program reference"))?;
        snapshot = fork_instrument::original_artifact::load_original(
            cli.original_store.as_ref().expect("clap requires an original store"), &reference, cli.max_input_bytes)?;
    }
    let input = snapshot.bytes();

    if cli.streaming_scan {
        let scan = fork_instrument::streaming::scan(&input)
            .with_context(|| format!("scanning original module: {input_name}"))?;
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
            .with_context(|| format!("inventorying {input_name}"))?;
        println!("{inventory}");
        return Ok(());
    }
    if cli.artifact_identity {
        let identity = artifact_identity(&input)
            .with_context(|| format!("inspecting artifact identity: {input_name}"))?;
        println!("{identity}");
        return Ok(());
    }
    if cli.fork_capability_hex {
        let hex = fork_capability_section_hex(&input)
            .with_context(|| format!("reading fork capability: {input_name}"))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.linked_frame_descriptor_hex {
        let hex = linked_frame_descriptor_section_hex(&input)
            .with_context(|| format!("reading linked-frame descriptor: {input_name}"))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.legacy_asyncify_exports {
        let names = legacy_asyncify_exports(&input)
            .with_context(|| format!("inventorying exports: {input_name}"))?;
        for name in names {
            println!("{name}");
        }
        return Ok(());
    }
    if cli.reserved_env_imports {
        let imports = reserved_env_imports(&input)
            .with_context(|| format!("inventorying reserved imports: {input_name}"))?;
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
            .with_context(|| format!("analyzing {input_name}"))?;
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
            analyze(input, &opts).with_context(|| format!("analyzing {input_name}"))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output = output.ok_or_else(|| {
        anyhow::anyhow!(
            "--output or --output-fd is required unless an analysis or contract-inspection mode is set"
        )
    })?;
    let original_store = if cli.bind_original { None } else {
        cli.original_store.or_else(||
            std::env::var_os("WASM_POSIX_BUILD_ORIGINAL_STORE").map(std::path::PathBuf::from))
    };
    let original = if cli.bind_original {
        Some(fork_instrument::original_artifact::reference_for_original(snapshot.bytes())?)
    } else {
        original_store.as_ref().map(|store|
            fork_instrument::original_artifact::retain_original(&snapshot, store, permissions.clone())).transpose()?
    };
    if let (Some(store), Some(original), Some(output_path)) = (&original_store, &original, output.path()) {
        let original_directory = std::fs::canonicalize(original.path(store).parent().unwrap())?;
        let output_directory = output_path.parent().filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        anyhow::ensure!(!std::fs::canonicalize(output_directory)?.starts_with(&original_directory),
            "output must be outside the immutable original-program store");
    }
    if cli.retain_uninstrumented {
        let retained = fork_instrument::original_artifact::attach_original_reference(
            &snapshot, original.as_ref().expect("clap requires an original store"), cli.max_output_bytes)?;
        return output.publish(&retained, permissions);
    }
    let artifact = transform::run(
        input,
        &opts,
        transform::Settings {
            optimize: &cli.post_optimize,
            keep_names: cli.keep_names,
            output_bytes: cli.max_output_bytes,
            original: original.as_ref(),
        },
    )
    .with_context(|| format!("instrumenting {input_name}"))?;
    output.publish(&artifact, permissions)
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
