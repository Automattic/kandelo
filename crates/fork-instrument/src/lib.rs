//! Function-local WebAssembly instrumentation for POSIX fork continuations.

use anyhow::Result;

use wasm_posix_shared::abi::{
    WPK_FORK_MODULE_STATE_ARENA_VERSION, WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
    WPK_FORK_MODULE_STATE_FORMAT_MAGIC, WPK_FORK_MODULE_STATE_FORMAT_VERSION,
    WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT, WPK_FORK_MODULE_STATE_RECORD_VERSION,
    WPK_FORK_MODULE_STATE_REQUIRED_FLAGS, WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
    WPK_FORK_UNWIND_TRANSPORT_SECTION, WPK_FORK_UNWIND_TRANSPORT_VERSION,
};

pub mod artifact_io;
pub mod call_graph;
pub mod contract_inventory;
pub mod facts;
pub mod instrument;
mod limits;
pub mod linked_frames;
pub mod module_exception_codec;
pub mod module_gc_codec;
pub mod native;
mod progress;
pub mod runtime;
pub mod sink;
pub mod static_reference_catalog;
pub mod streaming;
pub mod target_features;

/// Fresh instances rebuild this fixed catalog from the module's static element
/// segment, so a funcref recipe needs only a module activation and ordinal.
pub const FUNCTION_CATALOG_EXPORT: &str = "__wpk_fork_function_catalog";

/// Declares that unwind completion is transported by the private
/// `env.__wpk_fork_unwind` zero-payload tag rather than synthesized function
/// results.
pub const UNWIND_TRANSPORT_SECTION: &str = WPK_FORK_UNWIND_TRANSPORT_SECTION;

pub const UNWIND_TRANSPORT_VERSION: u8 = WPK_FORK_UNWIND_TRANSPORT_VERSION;

/// Options controlling instrumentation. Fields will grow as phases
/// land; a `Default` implementation keeps call sites stable.
#[derive(Debug, Clone)]
pub struct Options {
    /// The fully-qualified name of the import whose callers should be
    /// instrumented. Format: `module.field` (e.g.
    /// `kernel.kernel_fork`). This import seeds call-graph discovery in a
    /// main module. `env.fork` selects complete side-module boundary coverage:
    /// every function import and unresolved reference dispatch becomes a
    /// possible cross-instance fork boundary.
    pub entry_import: String,
    /// Stop the unwind at fork boundaries (sinks) and leave the frames above
    /// them uninstrumented; see [`sink`]. `--no-sinks` restores the full
    /// closure (for comparison and diagnosis).
    pub sinks: bool,
    /// Use the compiler facts in the module's [`facts::SECTION`] for the
    /// sink analysis when present. `false` (`--no-facts`) ignores them, for
    /// diagnosis; the section is removed from the output either way.
    pub facts: bool,
    /// With facts: apply C's effective-type rule in units compiled with
    /// strict aliasing. `false` (`--no-effective-types`) applies it nowhere.
    pub effective_types: bool,
    /// For a program that can dlopen (with facts): which side-module entries
    /// the instrumented main program is prepared for. See [`SideModules`].
    pub side_modules: SideModules,
}

/// `--side-modules`: what the instrumented main program assumes about the
/// side modules it may load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SideModules {
    /// Analyze as if no side-module code returns through a fork child into
    /// main-program frames, and record that contract in
    /// `kandelo.wpk_fork.dlopen_contract` so the host refuses side modules
    /// that could break it (host/src/fork-side-module-contract.ts).
    #[default]
    TracedEntries,
    /// Instrument for every side-module entry: any side module may fork along
    /// any path, and the host loads any library.
    AssumeAllEntriesForkReturning,
}

impl SideModules {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TracedEntries => "traced-entries",
            Self::AssumeAllEntriesForkReturning => "assume-all-entries-fork-returning",
        }
    }
}

/// Custom section recording the dlopen contract (format in
/// host/src/fork-side-module-contract.ts).
pub const DLOPEN_CONTRACT_SECTION: &str = "kandelo.wpk_fork.dlopen_contract";

impl Default for Options {
    fn default() -> Self {
        Self {
            entry_import: "kernel.kernel_fork".into(),
            sinks: true,
            facts: true,
            effective_types: true,
            side_modules: SideModules::default(),
        }
    }
}

/// Which analysis chose the instrumented set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanSource {
    /// The conservative fork closure (no sink analysis applied).
    Closure,
    /// The built-in sink analysis, without compiler facts.
    Builtin,
    /// The sink analysis with compiler facts.
    Facts,
}

impl PlanSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanSource::Closure => "closure",
            PlanSource::Builtin => "builtin",
            PlanSource::Facts => "facts",
        }
    }
}

/// Result of analyzing an input module without rewriting it.
#[derive(Debug)]
pub struct Analysis {
    /// Original function entries that must be instrumented for fork support.
    /// Sorted by display name; stable across runs. Generated helpers are omitted.
    pub fork_path: Vec<call_graph::FuncEntry>,
}

/// Analyze `input` to compute the set of functions that need
/// instrumentation, without mutating or re-emitting the module.
///
/// Uses original function identities and follows direct, indirect and reference
/// calls. Generated helper functions are not included in this diagnostic view.
pub fn analyze(input: &[u8], opts: &Options) -> Result<Analysis> {
    native::reports::discover(input, opts)
}

/// Instruments `input` (a complete wasm binary) according to `opts`
/// and returns the transformed binary.
///
/// The complete transform includes runtime scaffolding, per-function
/// switch-dispatch, linked-frame save/restore, mutable scalar-global
/// save/restore, and activation-owned tagged-catch replay.
///
/// Executable modules that have no configured fork entry, dynamic-loader
/// boundary, or side-module role are returned byte-for-byte unchanged. Such a
/// module cannot participate in a fork transaction, and injecting reference
/// codecs would needlessly require those Wasm features on every host.
///
/// Dynamic-loader-capable mains and side modules still receive the uniform
/// activation-state helpers even when they do not import fork directly. They
/// can remain live beside a fork-capable activation, so their mutable globals,
/// tables, and segment lifetimes remain part of the child process image.
///
/// Uses the native backend. This convenience API copies the final artifact
/// into a Vec; use `native::instrument` or the CLI for file-backed output.
pub fn instrument(input: &[u8], opts: &Options) -> Result<Vec<u8>> {
    let artifact = native::instrument(input, opts, Default::default())?;
    Ok(artifact.bytes.bytes().to_vec())
}

/// What [`instrument`] would instrument, without rewriting the module.
#[derive(Debug, Clone)]
pub struct SinkReport {
    pub source: PlanSource,
    /// Local functions that would be instrumented, by name (sorted).
    pub instrumented: Vec<String>,
    /// Boundary functions, by name (sorted).
    pub boundaries: Vec<String>,
    /// Coverage of the compiler facts, when the facts analysis ran.
    pub facts: Option<facts::FactsReport>,
    /// Why compiler facts in the module were not used.
    pub facts_error: Option<String>,
}

/// Decide the instrumented set as [`instrument`] does and report it. A
/// module outside any fork transaction reports an empty set.
pub fn sink_report(input: &[u8], opts: &Options) -> Result<SinkReport> {
    native::reports::sinks(input, opts)
}

fn module_state_descriptor(pointer_width: linked_frames::PointerWidth) -> Vec<u8> {
    let pointer_width = match pointer_width {
        linked_frames::PointerWidth::Wasm32 => u8::try_from(u32::BITS / u8::BITS).unwrap(),
        linked_frames::PointerWidth::Wasm64 => u8::try_from(u64::BITS / u8::BITS).unwrap(),
    };
    let mut data = Vec::with_capacity(usize::from(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE));
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_FORMAT_MAGIC);
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_FORMAT_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE.to_le_bytes());
    data.push(pointer_width);
    data.push(WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT);
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_REQUIRED_FLAGS.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_ARENA_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_RECORD_VERSION.to_le_bytes());
    data.extend_from_slice(&WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET.to_le_bytes());
    data.extend_from_slice(&u32::default().to_le_bytes());
    debug_assert_eq!(
        data.len(),
        usize::from(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE)
    );
    data
}
