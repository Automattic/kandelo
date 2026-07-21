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
pub mod linked_frames;
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
    let module = walrus::Module::from_buffer(input).context("failed to parse input wasm module")?;

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
    let mut module =
        walrus::Module::from_buffer(input).context("failed to parse input wasm module")?;

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
    // Only modules with the configured fork seed need linked-frame imports.
    // Runtime exports and metadata remain stable for no-seed modules, but
    // adding unused host imports would make an otherwise inert side module
    // impossible to instantiate through the dynamic linker.
    let runtime = if entry.is_some() {
        runtime::inject_linked_runtime(&mut module, b1_plan.total_bytes)
    } else {
        runtime::inject_runtime(&mut module, b1_plan.total_bytes)
    };

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

    loop {
        let existing = module
            .customs
            .iter()
            .find(|(_, section)| section.name() == linked_frames::LINKED_FRAME_FORMAT_SECTION)
            .map(|(id, _)| id);
        let Some(existing) = existing else { break };
        module.customs.delete(existing);
    }
    let pointer_width = match runtime.buf_type {
        walrus::ValType::I32 => linked_frames::PointerWidth::Wasm32,
        walrus::ValType::I64 => linked_frames::PointerWidth::Wasm64,
        other => unreachable!("unsupported fork buffer pointer type: {other:?}"),
    };
    module.customs.add(RawCustomSection {
        name: linked_frames::LINKED_FRAME_FORMAT_SECTION.into(),
        data: linked_frames::FrameFormatDescriptor::current(
            pointer_width,
            runtime.fixed_prefix_size,
        )
        .encode()
        .to_vec(),
    });

    // Historical phase list (Phase 4b/4c/4d/4e/4f/5/6) was an artefact
    // of guard-dispatch's body-rewriting approach. Post-commit-4 those
    // phases are folded into `instrument::instrument_functions` itself;
    // see `instrument_one_function_switch` / `instrument_one_function_nested_switch`
    // for the actual transform.

    let output = module.emit_wasm();
    restore_leading_dylink_section(input, output)
}

/// Walrus emits raw custom sections after the standard sections. That is
/// normally valid, but the WebAssembly dynamic-linking convention requires a
/// shared module's `dylink.0` custom section to be first. Preserve that input
/// contract after instrumentation so Kandelo's dynamic loader can still
/// recognize fork-capable side modules.
fn restore_leading_dylink_section(input: &[u8], output: Vec<u8>) -> Result<Vec<u8>> {
    let mut input_payloads = Parser::new(0).parse_all(input);
    let _version = input_payloads
        .next()
        .transpose()
        .context("parsing input wasm header")?;
    let input_starts_with_dylink = matches!(
        input_payloads.next().transpose()?,
        Some(Payload::CustomSection(section)) if section.name() == "dylink.0"
    );
    if !input_starts_with_dylink {
        return Ok(output);
    }

    let mut dylink_range = None;
    for payload in Parser::new(0).parse_all(&output) {
        if let Payload::CustomSection(section) = payload? {
            if section.name() != "dylink.0" {
                continue;
            }
            ensure!(
                dylink_range.is_none(),
                "instrumented module contains more than one dylink.0 section"
            );
            dylink_range = Some(section.range());
        }
    }

    let payload_range = dylink_range.context(
        "input shared module started with dylink.0, but the instrumented output lost it",
    )?;
    let payload_len = u32::try_from(payload_range.len())
        .context("dylink.0 section is too large for a wasm section")?;
    let section_header_len = 1 + u32_leb_len(payload_len);
    let section_start = payload_range
        .start
        .checked_sub(section_header_len)
        .context("dylink.0 section range does not include a valid header")?;
    ensure!(
        section_start >= 8 && output.get(section_start) == Some(&0),
        "dylink.0 section does not have a valid custom-section header"
    );
    if section_start == 8 {
        return Ok(output);
    }

    let mut reordered = Vec::with_capacity(output.len());
    reordered.extend_from_slice(&output[..8]);
    reordered.extend_from_slice(&output[section_start..payload_range.end]);
    reordered.extend_from_slice(&output[8..section_start]);
    reordered.extend_from_slice(&output[payload_range.end..]);
    Ok(reordered)
}

fn u32_leb_len(mut value: u32) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}
