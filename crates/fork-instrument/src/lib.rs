//! `fork-instrument` — compile-time instrumentation of wasm binaries
//! to support POSIX `fork()` semantics via stack serialization.
//!
//! See `docs/plans/2026-04-20-fork-instrumentation-design.md` for the
//! full design.
//!
//! Phase 1 (current): skeleton only. Parses a wasm binary, validates
//! it, and emits it unchanged. Subsequent phases add:
//!
//! - Phase 2: direct-call graph discovery
//! - Phase 3: indirect-call graph discovery
//! - Phase 4: core instrumentation (state machine, frame save/restore)
//! - Phase 5: reference-typed local spilling
//! - Phase 6: catch-handler region support
//! - Phase 7: production rollout

use anyhow::{Context, Result, bail, ensure};
use walrus::RawCustomSection;
use wasmparser::{Parser, Payload};

pub mod call_graph;
pub mod instrument;
pub mod runtime;

/// Versioned artifact claim emitted by `wasm-fork-instrument` and consumed by
/// the host before it enables cross-module fork coordination.
pub const FORK_CAPABILITIES_SECTION: &str = "kandelo.wpk_fork.capabilities";
pub const FORK_CAPABILITIES_VERSION: u8 = 1;
pub const FORK_CAP_SIDE_ENTRY: u8 = 1 << 0;
pub const FORK_CAP_DYLINK_MAIN: u8 = 1 << 1;

/// Options controlling instrumentation. Fields will grow as phases
/// land; a `Default` implementation keeps call sites stable.
#[derive(Debug, Clone)]
pub struct Options {
    /// The fully-qualified name of the import whose callers should be
    /// instrumented. Format: `module.field` (e.g.
    /// `kernel.kernel_fork`). Future phases read this to seed the
    /// call-graph discovery; Phase 1 ignores it.
    pub entry_import: String,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            entry_import: "kernel.kernel_fork".into(),
        }
    }
}

/// Result of analyzing an input module without rewriting it.
#[derive(Debug)]
pub struct Analysis {
    /// Function entries that must be instrumented for fork support.
    /// Sorted by display name; stable across runs.
    pub fork_path: Vec<call_graph::FuncEntry>,
}

/// Analyze `input` to compute the set of functions that need
/// instrumentation, without mutating or re-emitting the module.
///
/// Phase 2 scope: direct-call closure only. Phase 3 extends to
/// indirect calls.
pub fn analyze(input: &[u8], opts: &Options) -> Result<Analysis> {
    let module = walrus::Module::from_buffer(input)
        .context("failed to parse input wasm module")?;

    let Some(entry) = call_graph::find_import_func(&module, &opts.entry_import) else {
        bail!(
            "entry import `{}` not found (or not a function) in the module. \
             If this module does not use fork, there is nothing to instrument.",
            opts.entry_import
        );
    };

    let reaching = call_graph::reaching_closure(&module, entry);
    let fork_path = call_graph::summarize(&module, &reaching);
    Ok(Analysis { fork_path })
}

/// Instruments `input` (a complete wasm binary) according to `opts`
/// and returns the transformed binary.
///
/// Current scope: Phase 4a (runtime scaffolding) + Phase 4b
/// (per-function structural wrap). Future phases 4c–6 extend the
/// per-function transform with call-site state-machine wrapping,
/// frame save/restore, mutable-global save/restore, ref-typed local
/// spilling, and catch-handler resume.
///
/// Modules that do not import the configured entry (default
/// `kernel.kernel_fork`) are returned unchanged — there is nothing
/// to instrument. We do **not** treat this as an error because the
/// tool is invoked by build scripts across programs that may or may
/// not use `fork()`.
pub fn instrument(input: &[u8], opts: &Options) -> Result<Vec<u8>> {
    let mut module = walrus::Module::from_buffer(input)
        .context("failed to parse input wasm module")?;

    // Discover the fork-path closure *before* we mutate the module so
    // the runtime's own injected functions are not mistaken for
    // fork-path callers. (They can't reach the seed anyway, but the
    // earlier-is-simpler ordering keeps the invariant trivially.)
    let entry = call_graph::find_import_func(&module, &opts.entry_import);
    let fork_path = match entry {
        Some(seed) => call_graph::reaching_closure(&module, seed),
        None => Default::default(),
    };

    // The five wpk_fork_* exports prove only that some instrumentation runtime
    // was injected. They do not prove which import seeded the transformed call
    // graph or whether a dlopen-capable main used the conservative dynamic
    // call_indirect boundary. Emit a separate, versioned claim for exactly the
    // transformations performed in this invocation so the host can reject
    // stale or generically instrumented artifacts instead of mis-resuming.
    let mut fork_capabilities = 0;
    if entry.is_some() && opts.entry_import == "env.fork" {
        fork_capabilities |= FORK_CAP_SIDE_ENTRY;
    }
    if entry.is_some()
        && opts.entry_import == "kernel.kernel_fork"
        && call_graph::has_dynamic_linker_imports(&module)
    {
        fork_capabilities |= FORK_CAP_DYLINK_MAIN;
    }

    // Phase 4a: runtime scaffolding. Always injected so the module's
    // exported ABI is stable regardless of whether any caller was
    // actually rewritten.
    //
    // Stage 1 (B1): reserve plain-catch scratch space in the save
    // buffer. `total_bytes` is 0 when no fork-path function has a
    // plain catch — preserves byte-identical behavior to pre-B1
    // for all currently-shipping ports. The plan must be computed
    // *before* `inject_runtime` because the resulting size shifts
    // `frames_start_offset`, which gets baked into the unwind_begin
    // body as a constant. Filter to local functions and sort to
    // match the determinism of `instrument_functions`'s target walk
    // — Stage 2 reads `B1ScratchPlan.per_function[fid]` and the
    // per-function scratch_offset values must be stable across runs
    // for byte-reproducible builds. We do NOT also filter
    // `runtime_funcs` here because they don't exist yet at this
    // point in the pipeline (they're added by `inject_runtime` on
    // the next line).
    let mut fork_path_targets: Vec<walrus::FunctionId> = fork_path
        .iter()
        .copied()
        .filter(|id| matches!(module.funcs.get(*id).kind, walrus::FunctionKind::Local(_)))
        .collect();
    fork_path_targets.sort();
    let b1_plan = instrument::plan_b1_scratch(&module, &fork_path_targets);
    let runtime = runtime::inject_runtime(&mut module, b1_plan.total_bytes);

    // Phase 4b: structural wrap of each fork-path function's body.
    // No-op when `fork_path` is empty (module doesn't use fork).
    instrument::instrument_functions(&mut module, &runtime, &fork_path, &b1_plan);

    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == FORK_CAPABILITIES_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    module.customs.add(RawCustomSection {
        name: FORK_CAPABILITIES_SECTION.into(),
        data: vec![FORK_CAPABILITIES_VERSION, fork_capabilities],
    });

    // Historical phase list (Phase 4b/4c/4d/4e/4f/5/6) was an artefact
    // of guard-dispatch's body-rewriting approach. Post-commit-4 those
    // phases are folded into `instrument::instrument_functions` itself;
    // see `instrument_one_function_switch` / `instrument_one_function_nested_switch`
    // for the actual transform.

    let output = module.emit_wasm();
    Ok(output)
}
