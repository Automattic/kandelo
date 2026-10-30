//! Command-line options share the existing defaults and diagnostic modes.
use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
    group(clap::ArgGroup::new("input_source").args(["input", "input_fd"]).required(true)),
    group(clap::ArgGroup::new("output_target").args(["output", "output_fd"])),
)]
pub(super) struct Cli {
    /// Input wasm file to instrument.
    pub(super) input: Option<PathBuf>,

    #[arg(long, value_name = "FD", value_parser = clap::value_parser!(i32).range(3..), help = "Snapshot a readonly regular descriptor from offset zero without changing its offset")]
    pub(super) input_fd: Option<i32>,

    /// Output path for the instrumented wasm file. Required unless an
    /// analysis or contract-inspection mode is set.
    #[arg(short, long)]
    pub(super) output: Option<PathBuf>,

    #[arg(long, value_name = "FD", value_parser = clap::value_parser!(i32).range(3..), help = "Write validated output to an empty, unlinked, writable regular descriptor; the caller owns publication")]
    pub(super) output_fd: Option<i32>,

    #[arg(long, requires = "output_target", conflicts_with_all = [
        "original_store", "reprepare_from_original", "retain_uninstrumented", "original_reference",
        "verify_original", "discover_only", "sink_report", "contract_inventory", "artifact_identity",
        "fork_capability_hex", "linked_frame_descriptor_hex", "reserved_env_imports", "streaming_scan",
        "legacy_asyncify_exports",
    ], help = "Bind the raw input's content identity without storing it; ignore the ambient original store")]
    pub(super) bind_original: bool,

    /// Retain the exact uninstrumented input in STORE/originals and bind its
    /// content identity into the output for explicit future re-preparation.
    #[arg(long, value_name = "STORE", requires = "output_target", conflicts_with_all = [
        "discover_only", "sink_report", "contract_inventory", "artifact_identity",
        "fork_capability_hex", "linked_frame_descriptor_hex", "reserved_env_imports", "streaming_scan",
        "legacy_asyncify_exports",
    ])]
    pub(super) original_store: Option<PathBuf>,

    /// Resolve INPUT's content-bound original from --original-store and
    /// prepare it again with this tool and the selected options.
    #[arg(long, requires = "original_store")]
    pub(super) reprepare_from_original: bool,

    #[arg(long, help = "Print the retained original's byte length and SHA-256, or none, without writes", conflicts_with_all = [
        "output_target", "original_store", "reprepare_from_original", "discover_only",
        "sink_report", "contract_inventory", "artifact_identity", "fork_capability_hex",
        "linked_frame_descriptor_hex", "reserved_env_imports", "streaming_scan", "legacy_asyncify_exports",
    ])]
    pub(super) original_reference: bool,

    #[arg(long, value_name = "ORIGINAL", help = "Verify INPUT's retained original bytes and immutable file mode without writes", conflicts_with_all = [
        "output_target", "original_store", "reprepare_from_original", "original_reference", "retain_uninstrumented",
        "discover_only", "sink_report", "contract_inventory", "artifact_identity", "fork_capability_hex",
        "linked_frame_descriptor_hex", "reserved_env_imports", "streaming_scan", "legacy_asyncify_exports",
    ])]
    pub(super) verify_original: Option<PathBuf>,

    #[arg(long, help = "Retain and bind a raw module without instrumenting it", requires_all = ["output_target", "original_store"], conflicts_with_all = [
        "reprepare_from_original", "original_reference", "verify_original", "discover_only", "sink_report",
        "contract_inventory", "artifact_identity", "fork_capability_hex", "linked_frame_descriptor_hex",
        "reserved_env_imports", "streaming_scan", "legacy_asyncify_exports",
    ])]
    pub(super) retain_uninstrumented: bool,

    /// Maximum bytes in the private immutable input snapshot.
    #[arg(long, default_value_t = 8_u64 * 1024 * 1024 * 1024)]
    pub(super) max_input_bytes: u64,

    /// Maximum bytes in an instrumenter output or validated optimizer result.
    #[arg(long, default_value_t = 8_u64 * 1024 * 1024 * 1024)]
    pub(super) max_output_bytes: u64,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    /// `env.fork` selects complete dynamically linked side-module boundary
    /// coverage, including downstream fork in another side module.
    #[arg(long, default_value = "kernel.kernel_fork")]
    pub(super) entry: String,

    /// Instrument the full fork closure instead of stopping the unwind at
    /// fork boundaries (sinks). For comparison and diagnosis.
    #[arg(long)]
    pub(super) no_sinks: bool,

    /// Ignore the compiler facts (`kandelo.calltypes` section) and use the
    /// sink analysis without them. For diagnosis. The section is removed
    /// from the output either way.
    #[arg(long)]
    pub(super) no_facts: bool,

    /// With compiler facts: do not apply C's effective-type rule anywhere.
    /// By default it applies in each unit compiled with strict aliasing (the
    /// C default) and nowhere else.
    #[arg(long)]
    pub(super) no_effective_types: bool,

    /// For a program that can dlopen: `traced-entries` (default) instruments
    /// the main program as if no side module returns through a fork child
    /// into its frames and records that contract so the host refuses side
    /// modules that could; `assume-all-entries-fork-returning` instruments for
    /// every side-module entry and loads any library.
    #[arg(long, default_value = "traced-entries", value_parser = ["traced-entries", "assume-all-entries-fork-returning"])]
    pub(super) side_modules: String,

    /// Diagnosis: print which analysis decided the instrumented set
    /// (`source\t<closure|builtin|facts>`), then the set and its
    /// boundaries as `A\t<name>` and `B\t<name>` rows. Emits no output
    /// file.
    #[arg(long, hide = true, conflicts_with = "output_target")]
    pub(super) sink_report: bool,

    /// wasm-opt level to run over an instrumented output, or `none`.
    ///
    /// Runs only when instrumentation changed the module; a module outside
    /// any fork transaction is written back byte-for-byte. The name section
    /// is dropped unless `--keep-names` is given. `none` exists for
    /// inspecting the instrumenter's raw output, not for shipping.
    #[arg(long, default_value = "Os", value_parser = ["O1", "O2", "O3", "Os", "Oz", "none"])]
    pub(super) post_optimize: String,

    /// Debugging: keep the name section through the post-optimize pass
    /// (`wasm-opt -g`), so traps and profiles show function names.
    #[arg(long)]
    pub(super) keep_names: bool,

    /// Analyze the module and print the discovered fork-path function
    /// set as JSON to stdout. Skips instrumentation and output emission.
    /// Useful for validating call-graph discovery against
    /// hand-maintained onlylists.
    #[arg(long, conflicts_with = "output_target")]
    pub(super) discover_only: bool,

    /// Diagnose the bounded original-binary scanner without producing an
    /// instrumented artifact. Reports compact
    /// summary counts and definition binding, not a complete sink/fork plan.
    #[arg(long, conflicts_with_all = [
        "output_target", "discover_only", "sink_report", "contract_inventory",
        "artifact_identity", "fork_capability_hex", "linked_frame_descriptor_hex",
        "reserved_env_imports",
    ])]
    pub(super) streaming_scan: bool,

    /// Print the fork-artifact structural inventory as one TSV row.
    /// This mode performs no instrumentation and emits no output file.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "artifact_identity",
            "reserved_env_imports",
            "output_target"
        ]
    )]
    pub(super) contract_inventory: bool,

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
            "output_target"
        ]
    )]
    pub(super) artifact_identity: bool,

    /// Print the unique fork-capability custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output_target"
        ]
    )]
    pub(super) fork_capability_hex: bool,

    /// Print the unique linked-frame descriptor custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "reserved_env_imports",
            "output_target"
        ]
    )]
    pub(super) linked_frame_descriptor_hex: bool,

    /// Print reserved env imports as `<kind>\t<module>.<name>` rows.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "output_target"
        ]
    )]
    pub(super) reserved_env_imports: bool,

    /// Print exported `asyncify_*` names, one per line: the mark of the
    /// retired Asyncify transform. Prints nothing for a module without them.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output_target"
        ]
    )]
    pub(super) legacy_asyncify_exports: bool,
}
