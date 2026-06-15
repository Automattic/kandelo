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
pub mod instrument;
pub mod runtime;

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
    let leading_dylink_section = leading_dylink_section(input);
    let mut module = walrus::Module::from_buffer(input)
        .context("failed to parse input wasm module")?;

    // Discover the fork-path closure *before* we mutate the module so
    // the runtime's own injected functions are not mistaken for
    // fork-path callers. (They can't reach the seed anyway, but the
    // earlier-is-simpler ordering keeps the invariant trivially.)
    let fork_path = match call_graph::find_import_func(&module, &opts.entry_import) {
        Some(seed) => call_graph::reaching_closure(&module, seed),
        None => Default::default(),
    };

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

    // Historical phase list (Phase 4b/4c/4d/4e/4f/5/6) was an artefact
    // of guard-dispatch's body-rewriting approach. Post-commit-4 those
    // phases are folded into `instrument::instrument_functions` itself;
    // see `instrument_one_function_switch` / `instrument_one_function_nested_switch`
    // for the actual transform.

    let mut output = module.emit_wasm();
    if let Some(section) = leading_dylink_section {
        // Walrus does not preserve arbitrary custom sections on re-emit.
        // For side modules, dylink.0 must stay first so the dynamic linker can
        // allocate memory/table requirements before instantiation.
        output.splice(8..8, section.iter().copied());
    }
    Ok(output)
}

fn leading_dylink_section(input: &[u8]) -> Option<Vec<u8>> {
    if input.len() < 8 || &input[0..4] != b"\0asm" {
        return None;
    }
    let mut offset = 8usize;
    let section_start = offset;
    let section_id = *input.get(offset)?;
    offset += 1;
    if section_id != 0 {
        return None;
    }
    let size = read_var_u32(input, &mut offset)? as usize;
    let payload_start = offset;
    let payload_end = payload_start.checked_add(size)?;
    if payload_end > input.len() {
        return None;
    }
    let name_len = read_var_u32(input, &mut offset)? as usize;
    let name_end = offset.checked_add(name_len)?;
    if name_end > payload_end {
        return None;
    }
    if &input[offset..name_end] != b"dylink.0" {
        return None;
    }
    Some(input[section_start..payload_end].to_vec())
}

fn read_var_u32(input: &[u8], offset: &mut usize) -> Option<u32> {
    let mut result = 0u32;
    let mut shift = 0u32;
    loop {
        let byte = *input.get(*offset)?;
        *offset += 1;
        result |= u32::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 35 {
            return None;
        }
    }
}
