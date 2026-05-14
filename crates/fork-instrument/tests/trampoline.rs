//! Spec for the runtime-dispatcher trampoline.
//!
//! Sub-commit 2.1 of the mega-PR
//! (`docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md`).
//!
//! # The trampoline scheme
//!
//! Today switch-dispatch handles fork-path call sites by emitting a
//! `br_table` inside the function entry block that branches to labeled
//! `(block $POST_K ...)` blocks within the same function. This works
//! when the post-call resume point is reachable via wasm structured
//! control flow (`br N` only branches *out of* blocks, never *into*
//! deeper nesting from outside).
//!
//! Three classes of fork-path call site can NOT be reached this way and
//! today route to guard-dispatch instead:
//!
//! - **(a) Nested in unsupported pattern.** Fork-path call lives inside
//!   a `loop`/`if`/`try_table` body that `classify_nested_pattern`
//!   rejects (`UnsupportedLegacyTry`, `UnsupportedMultiValueParams`,
//!   `UnsupportedCarryover`). The post-`POST_K` block is buried too
//!   deep for the entry-point `br_table` to reach it.
//! - **(b) Top-level operand-stack carryover.** The call's result is
//!   left on the operand stack across REWIND boundaries; switch-
//!   dispatch's POST_K blocks are typed `[] → []` and would fail
//!   validation if the carryover sticks.
//! - **(c) Nested `call_indirect` reaching a fork-path callee.**
//!   `has_nested_fork_calls` treats every nested `call_indirect` as
//!   fork-bearing; today it falls through to guard-dispatch.
//!
//! Under the trampoline scheme each case extracts the post-call resume
//! code into its own wasm function and reaches it via `call_indirect`
//! into a per-function funcref table.
//!
//! # Per-function table layout (open Q #3, resolved 2026-05-13)
//!
//! Each instrumented fork-path function emits its own funcref table
//! and `(elem)` segment populated with the extracted post-call
//! functions for that function:
//!
//! ```wat
//! ;; alongside `caller`, which has 3 fork-path call sites:
//! (table $caller_post_table 3 funcref)
//! (elem (table $caller_post_table) (i32.const 0) func
//!   $caller_post_0 $caller_post_1 $caller_post_2)
//!
//! (func $caller (param ...)
//!   (if (i32.eq (call $wpk_fork_state) (i32.const $REWINDING))
//!     (then
//!       (call_indirect $caller_post_table (type $resume_sig)
//!         (local.get $call_idx))))
//!   ...normal body...)
//!
//! (func $caller_post_0 (param $frame ...) ...)
//! (func $caller_post_1 (param $frame ...) ...)
//! (func $caller_post_2 (param $frame ...) ...)
//! ```
//!
//! Site IDs stay function-local and dense (already true today —
//! switch-dispatch's `partition_body` walks left-to-right and assigns
//! `call_idx ∈ 0..n-1`). `call_idx` indexes the table directly.
//!
//! # Sub-commit phasing
//!
//! - **2.1 (this commit):** Land WAT fixtures + this spec module.
//!   Active tests assert the fixtures parse + validate AND that today's
//!   pre-trampoline behavior is "routes to guard-dispatch" (no
//!   `br_table` in the instrumented output). Ignored tests reserve the
//!   slots for the post-2.3 assertions ("instrumented output contains
//!   the per-function table + elem + entry-point `call_indirect`").
//! - **2.2:** `mod trampoline` skeleton (file refactor; behavior
//!   invisible).
//! - **2.3:** Per-function table emission. Ignored tests below flip to
//!   active and assert the new shape.
//! - **2.4-2.6:** Wire each class through (carryover, call_indirect,
//!   nested-Loop/IfElse/TryTable). The "today: guard-dispatch"
//!   assertions in `today_*` tests below get inverted as each class
//!   migrates.
//!
//! Each fixture has a paired test:
//!
//! | Fixture                              | Routes to (post-2.6c)   | Notes                          |
//! |--------------------------------------|-------------------------|--------------------------------|
//! | `top_level_carryover.wat`            | switch-dispatch (2.4c)  | switch-dispatch absorbs        |
//! | `nested_carryover_in_loop.wat`       | nested switch (2.5c)    | absorbed via carryover spills  |
//! | `nested_multivalue_params.wat`       | nested switch (2.6c)    | body-param prespill + reload   |
//! | `legacy_try_fork.wat`                | guard-dispatch today    | obsoleted by commit 9 modern-EH|
//! | `nested_call_indirect.wat`           | nested switch today (*) | n/a — already handled          |
//!
//! (*) The simple nested call_indirect case is empirically already
//! handled by nested switch-dispatch (sub-commit 2.1 finding). The
//! real class (c) trampoline gap is `call_indirect + another
//! unsupported pattern` (e.g. carryover); a fixture for that lands
//! in 2.5 once we audit LLVM emission shapes.

use fork_instrument::{Options, instrument};
use walrus::{
    LocalFunction, Module,
    ir::{Block, IfElse, Instr, InstrSeqId, Loop, TryTable},
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
    // genuinely-impossible cases (currently UnsupportedLegacyTry,
    // which commit 9's modern-EH SDK flip largely obsoletes).
    assert!(
        !has_table_with_prefix(&module, "_start_post_table"),
        "post-2.6c: nested switch-dispatch absorbs multi-value-params; \
         no trampoline table needed"
    );
}

// ---------------------------------------------------------------------
// (a) Nested in unsupported pattern: legacy try/catch
// ---------------------------------------------------------------------
//
// Legacy `try`/`catch` may not parse on the host's wat crate version
// (it's gated behind the legacy-EH feature). Skip cleanly if so.

#[test]
fn today_legacy_try_fork_routes_to_guard_dispatch() {
    let wat = include_str!("fixtures/trampoline/legacy_try_fork.wat");
    let input = match try_parse(wat) {
        Some(bytes) => bytes,
        None => {
            eprintln!("skip: wat crate did not parse legacy try/catch fixture");
            return;
        }
    };
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(
        !has_br_table_in(&module, "_start"),
        "today: legacy try/catch with fork must route to guard-dispatch"
    );
}

#[test]
#[ignore = "enabled in sub-commit 2.6 — wire nested-Loop/IfElse/TryTable to trampoline"]
fn trampoline_legacy_try_fork_emits_post_table() {
    let wat = include_str!("fixtures/trampoline/legacy_try_fork.wat");
    let input = match try_parse(wat) {
        Some(bytes) => bytes,
        None => {
            // Legacy try/catch may have been removed by the C5 SDK
            // flip (commit 9 of the mega-PR) before this test fires.
            // Skip rather than fail in that case.
            eprintln!("skip: legacy try/catch no longer parses (likely post-C5)");
            return;
        }
    };
    let output = instrument(&input, &Options::default()).expect("instrument");
    validate(&output);
    let module = Module::from_buffer(&output).expect("walrus parse");

    assert!(has_table_with_prefix(&module, "_start_post_table"));
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
