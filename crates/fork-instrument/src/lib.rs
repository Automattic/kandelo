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

use anyhow::{Context, Result, bail};

pub mod call_graph;

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
/// In Phase 1, this is a validating round-trip: parse, (eventually)
/// transform, emit. The transform step is currently a no-op.
pub fn instrument(input: &[u8], _opts: &Options) -> Result<Vec<u8>> {
    let mut module = walrus::Module::from_buffer(input)
        .context("failed to parse input wasm module")?;

    // --- Future phases will mutate `module` here. ---
    // Phase 3: extend call-graph closure with indirect calls.
    // Phase 4: inject state-machine globals, exports, and per-function
    //          state-machine wrappers for every function in the set.
    // Phase 5: inject auxiliary tables for reference-typed spilling.
    // Phase 6: instrument try_table catch regions for resume-in-catch.

    let output = module.emit_wasm();
    Ok(output)
}
