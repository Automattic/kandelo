//! Regression gates for shapes the original mega-PR plan
//! (`docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md`)
//! reserved for the **runtime-dispatcher trampoline**.
//!
//! # Empirical history
//!
//! The original plan held that switch-dispatch's cascading `POST_K`
//! blocks (typed `Simple(None)`) couldn't reach the post-call resume
//! point for three classes of fork-path call site, and that those
//! classes had to use a separate scheme — extract the post-call code
//! into its own wasm function and `call_indirect` into a per-function
//! funcref table. The scaffolding for that scheme
//! (`extract_chunk_to_function`, `rewrite_chunk_locals_to_frame`,
//! `emit_per_function_post_table`, `instrument_one_function_trampoline_dispatch`)
//! landed across sub-commits 2.1-2.4b but remained unwired.
//!
//! Sub-commits 2.4c, 2.5a-c, and 2.6a-c (2026-05-14) took a different
//! approach: extend nested switch-dispatch in place via
//! `Vec<Option<ValType>>` stack tracking + per-call carryover spilling
//! + body-input-param prespill. Each "reserved for the trampoline"
//! class was absorbed into switch-dispatch:
//!
//! - **Top-level operand-stack carryover** — sub-commit 2.4c. Per-call
//!   spill locals + Option B (spill args + carryovers at the call
//!   site).
//! - **Nested direct-call carryover** — sub-commit 2.5c. Same
//!   mechanism, keyed by `call_idx` and threaded through
//!   `instrument_one_function_nested_switch`.
//! - **Multi-value-params SubRegion bodies** — sub-commit 2.6c. Body's
//!   declared type-params are pre-spilled at body entry and reloaded
//!   inside `POST_0`'s body via prepended `LocalGet`s, bridging the
//!   `Simple(None)` POST_K typing.
//! - **Nested call_indirect** — sub-commit 2.1 empirical finding: the
//!   simple case was already handled by nested switch-dispatch;
//!   `has_nested_fork_calls` treats every nested `call_indirect` as
//!   fork-bearing and the type-matched indirect-reverse closure in
//!   `call_graph::reaching_closure` covers it.
//! - **Legacy `try` body** — 2026-05-17 CI showed that shipping C
//!   ports can still contain legacy `try` in fork-path functions even
//!   with explicit modern-EH flags. Forks in the try body are absorbed
//!   by nested switch-dispatch; legacy catch-handler forks still panic.
//!
//! Net result: the trampoline scaffolding is preserved in
//! `crates/fork-instrument/src/instrument.rs` but currently has no
//! callers. The tests below verify that each "reserved for the
//! trampoline" fixture now routes to switch-dispatch (not the
//! trampoline) and that the legacy-Try-body case also routes through
//! nested switch-dispatch.
//!
//! | Fixture                              | Routes to (post-commit-4) | Notes                          |
//! |--------------------------------------|---------------------------|--------------------------------|
//! | `top_level_carryover.wat`            | switch-dispatch (2.4c)    | per-call carryover spilling    |
//! | `nested_carryover_in_loop.wat`       | nested switch (2.5c)      | direct-call carryover spills   |
//! | `nested_multivalue_params.wat`       | nested switch (2.6c)      | body-param prespill + reload   |
//! | `legacy_try_fork.wat`                | nested switch             | fork in try body only          |
//! | `nested_call_indirect.wat`           | nested switch (2.1)       | already handled empirically    |

use fork_instrument::{Options, instrument};
use walrus::{
    LocalFunction, Module,
    ir::{Block, IfElse, Instr, InstrSeqId, Loop, Try, TryTable},
};

/// Validate emitted bytes via wasmparser (independent from walrus).
fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator
        .validate_all(bytes)
        .unwrap_or_else(|e| panic!("wasmparser validation failed: {e}"));
}

/// Try to parse a WAT fixture; return None if the wat crate version
/// can't handle the fixture's instructions (notably legacy try/catch).
fn try_parse(wat_src: &str) -> Option<Vec<u8>> {
    wat::parse_str(wat_src).ok()
}

/// Walk every instruction sequence reachable from `seq` (including
/// nested ones), invoking `visit(seq, depth, instr)` for each instr.
/// Mirrored from tests/switch_dispatch.rs's `walk_all` so the two
/// test files don't need a shared module yet.
fn walk_all<F: FnMut(InstrSeqId, u32, &Instr)>(
    f: &LocalFunction,
    seq: InstrSeqId,
    depth: u32,
    visit: &mut F,
) {
    for (instr, _) in &f.block(seq).instrs {
        visit(seq, depth, instr);
        for child in nested_of(instr) {
            walk_all(f, child, depth + 1, visit);
        }
    }
}

fn nested_of(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(Block { seq }) => vec![*seq],
        Instr::Loop(Loop { seq }) => vec![*seq],
        Instr::IfElse(IfElse { consequent, alternative }) => vec![*consequent, *alternative],
        Instr::TryTable(TryTable { seq, .. }) => vec![*seq],
        Instr::Try(Try { seq, .. }) => vec![*seq],
        _ => vec![],
    }
}

/// Returns true iff the named exported function contains a `br_table`
/// anywhere in its body. Today this is the marker that switch-dispatch
/// was applied; absence indicates guard-dispatch (which uses if/else
/// rather than br_table).
fn has_br_table_in(module: &Module, export_name: &str) -> bool {
    let func_id = module
        .exports
        .iter()
        .find_map(|e| match e.item {
            walrus::ExportItem::Function(id) if e.name == export_name => Some(id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("export `{export_name}` not found"));
    let func = match &module.funcs.get(func_id).kind {
        walrus::FunctionKind::Local(f) => f,
        _ => panic!("export `{export_name}` is not a local function"),
    };
    let mut found = false;
    walk_all(func, func.entry_block(), 0, &mut |_, _, instr| {
        if matches!(instr, Instr::BrTable(_)) {
            found = true;
        }
    });
    found
}

/// Returns true iff the module declares a table whose name (in the
/// `name` section) starts with the given prefix. The trampoline emits
/// `<fn>_post_table` per fork-path function.
#[allow(dead_code)] // used by the ignored trampoline_* tests in 2.3
fn has_table_with_prefix(module: &Module, prefix: &str) -> bool {
    module
        .tables
        .iter()
        .any(|t| t.name.as_deref().map(|n| n.starts_with(prefix)).unwrap_or(false))
}

// ---------------------------------------------------------------------
// (b) Top-level operand-stack carryover
// ---------------------------------------------------------------------
//
// Sub-commit 2.4c (revised 2026-05-14): top-level carryover is
// absorbed by switch-dispatch via in-place spill at the call site,
// not by the trampoline. The trampoline scaffolding stays reserved
// for the genuinely-impossible nested-control-flow cases (2.6).

#[test]
fn top_level_carryover_uses_switch_dispatch_with_carryover_spills() {
    let wat = include_str!("fixtures/trampoline/top_level_carryover.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Post-2.4c: switch-dispatch absorbs the carryover; br_table
    // present.
    assert!(
        has_br_table_in(&module, "_start"),
        "post-2.4c: top-level carryover routes to switch-dispatch (br_table emitted)"
    );
    // Post-2.4c: no per-function post-table emitted (the trampoline
    // is reserved for nested cases in sub-commit 2.6).
    assert!(
        !has_table_with_prefix(&module, "_start_post_table"),
        "post-2.4c: switch-dispatch absorbs the carryover; no trampoline table needed"
    );
}

// ---------------------------------------------------------------------
// Nested carryover inside a loop body
// ---------------------------------------------------------------------
//
// Sub-commit 2.5c (2026-05-14): direct-call carryovers inside nested
// seqs are absorbed by nested switch-dispatch via the per-call
// carryover-spilling extension (wired in 2.5b). Trampoline NOT needed
// — switch-dispatch's per-region dispatch (function-level br_table +
// nested per-block dispatch inside the loop body) covers this case.

#[test]
fn nested_carryover_in_loop_uses_nested_switch_dispatch() {
    let wat = include_str!("fixtures/trampoline/nested_carryover_in_loop.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Post-2.5c: nested switch-dispatch handles direct-call carryover
    // inside the loop body. Function-level br_table dispatches to the
    // SubRegion landing covering the loop; inside the loop body, a
    // per-region br_table dispatches to the right POST_K. The per-call
    // carryover spill locals round-trip the `local.get $sp` carryover
    // across REWIND.
    assert!(
        has_br_table_in(&module, "_start"),
        "post-2.5c: nested carryover-in-loop routes to nested switch-dispatch \
         (br_table emitted), not guard-dispatch"
    );
    // Per-function trampoline post-table is NOT emitted — the
    // trampoline is reserved for genuinely-impossible nested-control-
    // flow cases (multi-value-params + legacy-try, addressed in 2.6).
    assert!(
        !has_table_with_prefix(&module, "_start_post_table"),
        "post-2.5c: nested switch-dispatch absorbs the carryover; no trampoline table needed"
    );
}

// ---------------------------------------------------------------------
// Nested in multi-value-params block
// ---------------------------------------------------------------------
//
// Sub-commit 2.6c (2026-05-14): multi-value-params Block/Loop/TryTable
// bodies containing fork-path calls are absorbed by nested switch-
// dispatch via the typed `CarryoverPlan::spill_locals` machinery
// (2.6a/2.6b) plus the body-param prespilling extension in
// `transform_region_seq`. The outer parent's spill mechanism saves
// the Block's input params on the parent stack; the body's
// transform pre-spills them again at body entry and reloads them
// onto POST_0's local stack via prepended LocalGets — bridging the
// gap between the body's input requirements and the cascading
// POST_K blocks' `Simple(None)` typing.

#[test]
fn nested_multivalue_params_uses_nested_switch_dispatch() {
    let wat = include_str!("fixtures/trampoline/nested_multivalue_params.wat");
    let input = match try_parse(wat) {
        Some(bytes) => bytes,
        None => {
            eprintln!("skip: wat crate did not parse multivalue_params fixture");
            return;
        }
    };
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Post-2.6c: nested switch-dispatch handles multi-value-params
    // Block bodies. Function-level br_table at `_start` dispatches
    // to the SubRegion landing covering the outer Block; inside the
    // body, a per-region br_table dispatches to the right POST_K.
    assert!(
        has_br_table_in(&module, "_start"),
        "post-2.6c: nested multi-value-params block must route to nested \
         switch-dispatch (br_table emitted), not guard-dispatch"
    );
    // Trampoline post-table is NOT emitted — switch-dispatch absorbs
    // this case. The trampoline scaffolding stays reserved for
    // unimplemented cases such as fork-from-legacy-catch.
    assert!(
        !has_table_with_prefix(&module, "_start_post_table"),
        "post-2.6c: nested switch-dispatch absorbs multi-value-params; \
         no trampoline table needed"
    );
}

// ---------------------------------------------------------------------
// Legacy try/catch fork-path call in try body
// ---------------------------------------------------------------------
//
// 2026-05-17 CI disproved the "modern flags remove every legacy Try"
// invariant for C ports such as bash, spidermonkey, and vim. A fork in the
// legacy try body can use the same per-region nested-switch route as
// Block/Loop/TryTable bodies. Legacy catch handlers still need their
// exception path reconstructed and remain unsupported.
//
// Note: the wat crate may not parse legacy try/catch on the host's
// version (it's gated behind the legacy-EH feature). Skip cleanly
// in that case.

#[test]
fn legacy_try_body_fork_uses_nested_switch_dispatch() {
    let wat = include_str!("fixtures/trampoline/legacy_try_fork.wat");
    let Some(input) = try_parse(wat) else {
        eprintln!("skip: wat crate did not parse legacy try/catch fixture");
        return;
    };
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_br_table_in(&module, "_start"),
        "legacy try-body fork must route to nested switch-dispatch (br_table emitted)"
    );
}

// ---------------------------------------------------------------------
// (c) Nested call_indirect — empirically NOT a trampoline case
// ---------------------------------------------------------------------
//
// Empirical finding (sub-commit 2.1): the simple nested call_indirect
// case is already handled by nested switch-dispatch today. See the
// fixture's header comment for the explanation. The real class (c)
// trampoline gap is `call_indirect + another unsupported pattern`
// (e.g. carryover); a fixture for that lands in 2.5 once we audit
// which LLVM emission shapes actually trigger it.
//
// This test is a regression gate that nested call_indirect stays on
// the switch-dispatch path.

#[test]
fn today_nested_call_indirect_uses_nested_switch_dispatch() {
    let wat = include_str!("fixtures/trampoline/nested_call_indirect.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        has_br_table_in(&module, "_start"),
        "today: simple nested call_indirect routes to nested switch-dispatch (br_table emitted)"
    );
}
