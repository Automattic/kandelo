//! Tests for Phase 4b: per-function structural wrap.
//!
//! The transform under test is a shell — it does not yet emit
//! state-machine logic. These tests verify three things:
//!
//! 1. **Structural**: fork-path functions have their bodies moved
//!    into a nested `block`, with `return` at the tail and an
//!    `unreachable` postamble. Non-fork-path functions are untouched.
//!
//! 2. **Validity**: the instrumented module parses under walrus and
//!    validates under an independent wasmparser validator. Mismatched
//!    block types or stack heights would be caught here.
//!
//! 3. **Scope**: the runtime's own control functions (injected by
//!    Phase 4a) are never wrapped; modules that do not import the
//!    fork entry are skipped entirely.

use std::collections::HashSet;

use fork_instrument::runtime::names as runtime_names;
use fork_instrument::{Options, instrument};
use walrus::{
    ExportItem, FunctionId, FunctionKind, LocalFunction, Module,
    ir::{Instr, InstrSeqId},
};

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    instrument(&bytes, &Options::default()).expect("instrument")
}

fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator.validate_all(bytes).expect("valid wasm");
}

/// Find a function by its (wat-source) name on the module — searches
/// funcs' own `name` field. Both imports and local functions are
/// visible here; pick a name unique within the fixture.
fn func_by_name(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function `{name}` not found"))
        .id()
}

fn local(module: &Module, id: FunctionId) -> &LocalFunction {
    match &module.funcs.get(id).kind {
        FunctionKind::Local(l) => l,
        _ => panic!("function is not local"),
    }
}

/// Entry-block instruction opcodes (no payloads) as a flat `Vec`,
/// useful for quick shape assertions.
fn entry_instr_kinds(module: &Module, id: FunctionId) -> Vec<InstrKind> {
    let f = local(module, id);
    f.block(f.entry_block())
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

/// Opcodes in an arbitrary `InstrSeqId` owned by `func_id`.
fn seq_kinds(module: &Module, func_id: FunctionId, seq_id: InstrSeqId) -> Vec<InstrKind> {
    local(module, func_id)
        .block(seq_id)
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

/// Find the single `Block(seq)` instruction in the entry block and
/// return the wrapped `InstrSeqId`.
fn entry_wrapper_seq(module: &Module, id: FunctionId) -> InstrSeqId {
    let f = local(module, id);
    let entry = f.block(f.entry_block());
    let blocks: Vec<InstrSeqId> = entry
        .instrs
        .iter()
        .filter_map(|(i, _)| match i {
            Instr::Block(b) => Some(b.seq),
            _ => None,
        })
        .collect();
    assert_eq!(
        blocks.len(),
        1,
        "expected exactly one wrapper Block in entry of func {id:?}",
    );
    blocks[0]
}

/// Discriminator-only classification of an instruction. Covers the
/// opcodes we assert on in shape-verification tests; everything else
/// collapses into `Other`.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum InstrKind {
    Block,
    Return,
    Unreachable,
    Call,
    CallIndirect,
    Const,
    Drop,
    GlobalGet,
    LocalGet,
    LocalSet,
    Binop,
    IfElse,
    BrIf,
    Other,
}

impl InstrKind {
    fn of(instr: &Instr) -> Self {
        match instr {
            Instr::Block(_) => InstrKind::Block,
            Instr::Return(_) => InstrKind::Return,
            Instr::Unreachable(_) => InstrKind::Unreachable,
            Instr::Call(_) => InstrKind::Call,
            Instr::CallIndirect(_) => InstrKind::CallIndirect,
            Instr::Const(_) => InstrKind::Const,
            Instr::Drop(_) => InstrKind::Drop,
            Instr::GlobalGet(_) => InstrKind::GlobalGet,
            Instr::LocalGet(_) => InstrKind::LocalGet,
            Instr::LocalSet(_) => InstrKind::LocalSet,
            Instr::Binop(_) => InstrKind::Binop,
            Instr::IfElse(_) => InstrKind::IfElse,
            Instr::BrIf(_) => InstrKind::BrIf,
            _ => InstrKind::Other,
        }
    }
}

// ----- Fixtures -----

/// A module with a direct fork caller plus an unrelated helper.
const FIXTURE_DIRECT_CALLER: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork)
      (func $non_caller (export "non_caller") (result i32)
        i32.const 42)
      (memory 1))
"#;

#[test]
fn instrumented_module_with_direct_caller_validates() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
}

#[test]
fn direct_caller_entry_has_preamble_block_and_postamble() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);

    // Entry should open with the REWINDING preamble check, contain
    // exactly one wrapper Block, and not end with the 4b-era
    // `Unreachable` placeholder (4d replaces that with real
    // frame-save + defaults).
    assert!(
        matches!(
            kinds.first(),
            Some(InstrKind::GlobalGet)
        ),
        "entry should start with GlobalGet (state) for REWINDING check: {kinds:?}",
    );
    assert_eq!(
        kinds.iter().filter(|k| **k == InstrKind::Block).count(),
        1,
        "entry should contain exactly one wrapper Block: {kinds:?}",
    );
    assert!(
        !matches!(kinds.last(), Some(InstrKind::Unreachable)),
        "entry must no longer end in the 4b Unreachable placeholder: {kinds:?}",
    );
}

#[test]
fn wrapper_replaces_call_with_state_gated_if() {
    // Original body was a single `call $fork`. After 4c+4d, that
    // call is replaced by a state-machine if-gate whose condition
    // is `(state == NORMAL) || (state == REWINDING && call_idx == N)`:
    //
    //   global.get state, const NORMAL, i32.eq,
    //   global.get state, const REWINDING, i32.eq,
    //   local.get call_idx, const N, i32.eq,
    //   i32.and, i32.or,
    //   if-else,
    //   return (appended by 4b)
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let wrapper_kinds = seq_kinds(&module, caller, wrapper_id);

    assert_eq!(
        wrapper_kinds,
        vec![
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::LocalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::Binop, // i32.and
            InstrKind::Binop, // i32.or
            InstrKind::IfElse,
            InstrKind::Return,
        ],
    );
}

#[test]
fn non_fork_path_function_is_not_wrapped() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let non_caller = func_by_name(&module, "non_caller");
    // Original body was a single `i32.const 42`. The instrumenter
    // must not touch it, so the entry block still contains a single
    // `Const` and nothing else.
    assert_eq!(
        entry_instr_kinds(&module, non_caller),
        vec![InstrKind::Const],
        "non-fork-path function should be byte-for-byte unchanged",
    );
}

#[test]
fn runtime_control_functions_are_not_wrapped() {
    // The runtime's five exported control functions are injected by
    // Phase 4a. They operate on state/buf globals only, so they
    // naturally fall outside the fork-path closure; we additionally
    // exclude them explicitly. Verify neither case leaked through.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    for export in [
        runtime_names::EXPORT_UNWIND_BEGIN,
        runtime_names::EXPORT_UNWIND_END,
        runtime_names::EXPORT_REWIND_BEGIN,
        runtime_names::EXPORT_REWIND_END,
        runtime_names::EXPORT_STATE,
    ] {
        let id = module
            .exports
            .iter()
            .find(|e| e.name == export)
            .map(|e| match e.item {
                ExportItem::Function(f) => f,
                _ => panic!("`{export}` is not a function export"),
            })
            .unwrap_or_else(|| panic!("`{export}` export missing"));

        // Instrumented functions' entry block starts with a `Block`
        // instruction. A plain, un-instrumented function's first
        // instruction is something else (global.get, i32.const, etc.).
        let kinds = entry_instr_kinds(&module, id);
        assert!(
            !matches!(kinds.first(), Some(InstrKind::Block)),
            "runtime control function `{export}` was wrapped, shouldn't have been \
             (entry kinds: {kinds:?})",
        );
    }
}

// --- Transitive closure fixture ---
//
// Verifies that indirect callers are also instrumented: `caller_mid`
// calls `caller_leaf`, which calls `fork`. Both should be wrapped.
const FIXTURE_TRANSITIVE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller_leaf (export "caller_leaf") (result i32)
        call $fork)
      (func $caller_mid (export "caller_mid") (result i32)
        call $caller_leaf)
      (func $bystander (export "bystander") (result i32)
        i32.const 7)
      (memory 1))
"#;

#[test]
fn transitive_callers_are_all_wrapped() {
    let bytes = instrument_wat(FIXTURE_TRANSITIVE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    for name in ["caller_leaf", "caller_mid"] {
        let id = func_by_name(&module, name);
        let kinds = entry_instr_kinds(&module, id);
        assert_eq!(
            kinds.iter().filter(|k| **k == InstrKind::Block).count(),
            1,
            "transitive caller `{name}` should have exactly one wrapper Block: {kinds:?}",
        );
    }

    let bystander = func_by_name(&module, "bystander");
    assert_eq!(
        entry_instr_kinds(&module, bystander),
        vec![InstrKind::Const],
        "bystander should not be wrapped",
    );
}

// --- No-fork-import fixture ---
//
// A module that doesn't use fork at all. Instrumentation still runs
// — the runtime scaffolding is injected — but no user function is
// wrapped.
const FIXTURE_NO_FORK: &str = r#"
    (module
      (func $only (export "only") (result i32)
        i32.const 1)
      (memory 1))
"#;

#[test]
fn module_without_fork_import_leaves_user_function_untouched() {
    let bytes = instrument_wat(FIXTURE_NO_FORK);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let only = func_by_name(&module, "only");
    assert_eq!(
        entry_instr_kinds(&module, only),
        vec![InstrKind::Const],
        "user function in a no-fork module should be untouched",
    );
}

// --- Br-to-function-level fixture ---
//
// Tests that an existing `br` that originally targeted the function
// level continues to target the function level after our wrap. Walrus
// tracks branch targets by `InstrSeqId`, not by numeric depth, so
// moving the instructions into a nested scope should update the
// encoded depth at emit time.
//
// We construct this via walrus directly (wat parsers vary in how
// `br 0` at top-level is represented). A helper module with an
// explicit block and a br that breaks out of it to the function end.
#[test]
fn non_call_ops_in_wrapper_are_preserved_verbatim() {
    // Verifies that 4c's rewrite doesn't disturb non-call
    // instructions in the wrapper, and that the module still
    // validates under 4d's preamble/postamble.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork
            drop
            i32.const 99)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    let wrapper_id = entry_wrapper_seq(&module, caller);
    let wrapper_kinds = seq_kinds(&module, caller, wrapper_id);

    // The wrapper should contain the full condition + if-else, plus
    // the surviving drop + const, plus the trailing return.
    let tail: Vec<_> = wrapper_kinds
        .iter()
        .copied()
        .rev()
        .take(3)
        .collect();
    assert_eq!(
        tail,
        vec![InstrKind::Return, InstrKind::Const, InstrKind::Drop],
        "drop+const from original body should survive between the \
         wrapped call and the 4b return: {wrapper_kinds:?}",
    );
}

// --- Multi-value return fixture ---
//
// A function whose declared result is multi-value. The wrap must
// still validate because the trailing `unreachable` makes the stack
// polymorphic at entry-block end. If we had used `return <defaults>`
// instead, we'd have needed to synthesize defaults for each value
// type — but we chose `unreachable` specifically so we don't have to.
const FIXTURE_MULTIVALUE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $mv (export "mv") (result i32 i64 f32 f64)
        call $fork
        i64.const 0
        f32.const 0
        f64.const 0)
      (memory 1))
"#;

#[test]
fn multivalue_return_wraps_and_validates() {
    let bytes = instrument_wat(FIXTURE_MULTIVALUE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let mv = func_by_name(&module, "mv");
    let kinds = entry_instr_kinds(&module, mv);
    // Verify preamble + wrapper Block exist. Postamble defaults are
    // tested separately.
    assert!(
        kinds.iter().any(|k| *k == InstrKind::Block),
        "mv entry missing wrapper Block: {kinds:?}",
    );
    assert!(
        kinds.iter().any(|k| *k == InstrKind::IfElse),
        "mv entry missing preamble IfElse: {kinds:?}",
    );
}

// --- Sanity: instrumented IDs set matches what we'd expect ---
//
// This test reaches through the lib API to confirm that
// `instrument_functions` reports the right set back. We re-implement
// a tiny version of the pipeline to get at the intermediate.
#[test]
fn instrument_functions_returns_rewritten_set() {
    use fork_instrument::call_graph;
    use fork_instrument::instrument::instrument_functions;
    use fork_instrument::runtime::inject_runtime;

    let bytes = wat::parse_str(FIXTURE_TRANSITIVE).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();

    let seed = call_graph::find_import_func(&module, "kernel.kernel_fork")
        .expect("seed import present");
    let fork_path = call_graph::reaching_closure(&module, seed);
    let runtime = inject_runtime(&mut module);
    let rewritten = instrument_functions(&mut module, &runtime, &fork_path);

    // Expect the two callers to be rewritten, and the import itself
    // to be excluded (it's not a local function).
    let names: HashSet<String> = rewritten
        .iter()
        .map(|id| module.funcs.get(*id).name.clone().unwrap_or_default())
        .collect();

    assert!(names.contains("caller_leaf"), "got: {names:?}");
    assert!(names.contains("caller_mid"), "got: {names:?}");
    assert!(
        !names.contains("fork"),
        "import must never be instrumented: {names:?}",
    );
    assert!(
        !names.contains("bystander"),
        "non-fork-path must never be instrumented: {names:?}",
    );
    assert_eq!(rewritten.len(), 2, "unexpected rewritten set: {names:?}");
}

// ======================================================================
// Phase 4c tests — call-site state-machine wrap
// ======================================================================

/// Drill into a wrapped call's if-gate and return `(then_id, else_id)`.
/// Panics if the sequence doesn't contain exactly one if-else.
fn wrapped_if_branches(
    module: &Module,
    func_id: FunctionId,
    seq_id: InstrSeqId,
) -> (InstrSeqId, InstrSeqId) {
    let seq = local(module, func_id).block(seq_id);
    let ifs: Vec<(InstrSeqId, InstrSeqId)> = seq
        .instrs
        .iter()
        .filter_map(|(i, _)| match i {
            Instr::IfElse(ie) => Some((ie.consequent, ie.alternative)),
            _ => None,
        })
        .collect();
    assert_eq!(ifs.len(), 1, "expected exactly one IfElse in seq {seq_id:?}");
    ifs[0]
}

#[test]
fn wrapped_then_contains_call_and_bridge_to_unwind_save() {
    // For a no-arg fork call, the then-branch is:
    //   call $fork          ;; the original target
    //   i32.const <idx>     ;; call_idx tag
    //   local.set $call_idx
    //   global.get $state
    //   i32.const UNWINDING
    //   i32.eq
    //   br_if $unwind_save
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let (then_id, _else_id) = wrapped_if_branches(&module, caller, wrapper_id);

    assert_eq!(
        seq_kinds(&module, caller, then_id),
        vec![
            InstrKind::Call,
            InstrKind::Const,
            InstrKind::LocalSet,
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::BrIf,
        ],
    );
}

#[test]
fn wrapped_else_supplies_default_call_results() {
    // Phase 4d: the else branch is taken during REWINDING at a
    // non-matching call_idx. It must supply default values matching
    // the call's result types so subsequent code (guarded by the
    // state checks that 4g will add) sees type-consistent stacks.
    // For a fork call returning `i32`, that's a single `i32.const 0`.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let (_then_id, else_id) = wrapped_if_branches(&module, caller, wrapper_id);

    assert_eq!(
        seq_kinds(&module, caller, else_id),
        vec![InstrKind::Const],
        "else branch must push a default i32 for fork's result",
    );
}

/// A fork caller that also calls a non-fork helper. Only the fork
/// call should be wrapped; the helper call must survive untouched.
const FIXTURE_MIXED_CALLEES: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $helper (result i32) i32.const 5)
      (func $caller (export "caller") (result i32)
        call $helper
        drop
        call $fork)
      (memory 1))
"#;

#[test]
fn non_fork_call_is_not_wrapped() {
    let bytes = instrument_wat(FIXTURE_MIXED_CALLEES);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let wrapper_kinds = seq_kinds(&module, caller, wrapper_id);

    // Helper call survives as a raw `Call`; the fork call is wrapped
    // into an if-gate structure (identified by the IfElse kind here).
    assert!(
        wrapper_kinds.iter().filter(|k| **k == InstrKind::Call).count() == 1,
        "helper call should remain as a bare Call: {wrapper_kinds:?}",
    );
    assert!(
        wrapper_kinds
            .iter()
            .any(|k| *k == InstrKind::IfElse),
        "fork call should be wrapped in an if-gate: {wrapper_kinds:?}",
    );
}

/// A function that spills args via a wrapped call: `caller_with_args`
/// takes `(i32, f64)` and passes them to a fork-path helper.
const FIXTURE_CALL_WITH_ARGS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i32 f64) (result i32)
        call $fork)
      (func $caller_with_args (export "caller_with_args") (result i32)
        i32.const 7
        f64.const 2.5
        call $leaf)
      (memory 1))
"#;

#[test]
fn call_with_args_spills_args_to_locals_before_gate() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_ARGS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_args");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let kinds = seq_kinds(&module, caller, wrapper_id);

    // Prefix shape: original pushes, then two LocalSets (spill args
    // top-of-stack first), then the 4d condition, then the IfElse
    // and the trailing 4b Return.
    assert_eq!(
        &kinds[..4],
        &[
            InstrKind::Const,   // i32.const 7 (original)
            InstrKind::Const,   // f64.const 2.5 (original)
            InstrKind::LocalSet, // spill f64 arg (top of stack first)
            InstrKind::LocalSet, // spill i32 arg
        ],
    );
    assert_eq!(kinds[kinds.len() - 2], InstrKind::IfElse);
    assert_eq!(kinds[kinds.len() - 1], InstrKind::Return);

    let (then_id, _) = wrapped_if_branches(&module, caller, wrapper_id);
    assert_eq!(
        seq_kinds(&module, caller, then_id),
        vec![
            InstrKind::LocalGet,  // reload i32 arg
            InstrKind::LocalGet,  // reload f64 arg
            InstrKind::Call,
            InstrKind::Const,     // call_idx tag
            InstrKind::LocalSet,  // local.set $call_idx
            InstrKind::GlobalGet, // state
            InstrKind::Const,     // UNWINDING
            InstrKind::Binop,
            InstrKind::BrIf,
        ],
    );
}

/// Two calls in one function should receive sequential call_idx
/// values. We verify by inspecting the i32.const immediately before
/// the `local.set $call_idx` in each then-branch.
const FIXTURE_TWO_CALLS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork
        drop
        call $fork)
      (memory 1))
"#;

#[test]
fn call_idx_is_sequential_within_function() {
    let bytes = instrument_wat(FIXTURE_TWO_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let wrapper_seq = local(&module, caller).block(wrapper_id);

    // Gather every IfElse in the wrapper (expected: 2).
    let if_ids: Vec<InstrSeqId> = wrapper_seq
        .instrs
        .iter()
        .filter_map(|(i, _)| match i {
            Instr::IfElse(ie) => Some(ie.consequent),
            _ => None,
        })
        .collect();
    assert_eq!(if_ids.len(), 2, "expected two wrapped calls");

    // In each then-branch, the i32.const right before the LocalSet
    // that tags call_idx. The then-branch shape is:
    //   Call, Const(call_idx), LocalSet($call_idx), GlobalGet, Const, Binop, BrIf
    let mut idxs = Vec::new();
    for then_id in &if_ids {
        let instrs = &local(&module, caller).block(*then_id).instrs;
        // Expect Const at index 1.
        let call_idx_val = match &instrs[1].0 {
            Instr::Const(c) => match c.value {
                walrus::ir::Value::I32(v) => v,
                _ => panic!("call_idx const should be i32"),
            },
            other => panic!("expected Const at index 1, got {other:?}"),
        };
        idxs.push(call_idx_val);
    }

    assert_eq!(idxs, vec![0, 1], "call_idx should count up from 0");
}

/// call_indirect within a fork-path function is wrapped the same way
/// as a direct call, with one extra i32 arg (the table index) on top.
const FIXTURE_INDIRECT: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (type $sig (func (result i32)))
      (func $cb (type $sig) call $fork)
      (table 1 1 funcref)
      (elem (i32.const 0) $cb)
      (func $caller (export "caller") (result i32)
        i32.const 0
        call_indirect (type $sig))
      (memory 1))
"#;

#[test]
fn call_indirect_is_wrapped_with_index_as_top_arg() {
    let bytes = instrument_wat(FIXTURE_INDIRECT);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);
    let kinds = seq_kinds(&module, caller, wrapper_id);

    // Prefix: original i32.const (table index), then LocalSet to
    // spill it. Suffix: IfElse then Return. The middle is 4d's
    // condition, which we test in detail elsewhere.
    assert_eq!(&kinds[..2], &[InstrKind::Const, InstrKind::LocalSet]);
    assert_eq!(kinds[kinds.len() - 2], InstrKind::IfElse);
    assert_eq!(kinds[kinds.len() - 1], InstrKind::Return);

    let (then_id, _) = wrapped_if_branches(&module, caller, wrapper_id);
    // then reloads the index, does call_indirect, tags idx, checks.
    assert_eq!(
        seq_kinds(&module, caller, then_id),
        vec![
            InstrKind::LocalGet,
            InstrKind::CallIndirect,
            InstrKind::Const,
            InstrKind::LocalSet,
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::BrIf,
        ],
    );
}

/// A call that's nested inside a block should still be wrapped.
/// Walrus's instruction-visitor traversal is responsible for
/// recursing into nested sequences; if we missed `Block` in
/// `nested_seqs`, this test would fail.
const FIXTURE_CALL_IN_BLOCK: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        (block (result i32)
          call $fork))
      (memory 1))
"#;

// ======================================================================
// Phase 4d tests — frame I/O: preamble + postamble
// ======================================================================

/// Structure of a wrapped function's entry block at 4d:
///   [preamble_cond..., IfElse(preamble_then, preamble_else),
///    Block(wrapper),
///    postamble...]
///
/// Returns (preamble_then_id, wrapper_id, postamble_start_idx).
fn entry_preamble_and_postamble(
    module: &Module,
    func_id: FunctionId,
) -> (InstrSeqId, InstrSeqId, usize) {
    let f = local(module, func_id);
    let entry = f.block(f.entry_block());

    let mut preamble_then: Option<InstrSeqId> = None;
    let mut wrapper: Option<InstrSeqId> = None;
    let mut postamble_start = 0usize;

    for (idx, (instr, _)) in entry.instrs.iter().enumerate() {
        match instr {
            Instr::IfElse(ie) if preamble_then.is_none() => {
                preamble_then = Some(ie.consequent);
            }
            Instr::Block(b) if wrapper.is_none() => {
                wrapper = Some(b.seq);
                postamble_start = idx + 1;
            }
            _ => {}
        }
    }

    (
        preamble_then.expect("preamble IfElse missing"),
        wrapper.expect("wrapper Block missing"),
        postamble_start,
    )
}

#[test]
fn preamble_starts_with_rewinding_state_check() {
    // Expected preamble prefix in the entry block:
    //   global.get state
    //   i32.const REWINDING (= 2)
    //   i32.eq
    //   if ... else ... end
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);

    assert_eq!(
        &kinds[..4],
        &[
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
        ],
    );

    // Verify the constant in the preamble check is REWINDING (= 2).
    let f = local(&module, caller);
    let entry = f.block(f.entry_block());
    let rewinding_const = match &entry.instrs[1].0 {
        Instr::Const(c) => c.value,
        other => panic!("expected Const at entry[1], got {other:?}"),
    };
    match rewinding_const {
        walrus::ir::Value::I32(2) => {}
        other => panic!("preamble must check REWINDING (i32 2): {other:?}"),
    }
}

#[test]
fn preamble_then_loads_frame_header_and_call_idx() {
    // The preamble-then must:
    //   - global.get buf, load offset=0   (get current_pos)
    //   - i32.const frame_size, i32.sub   (= new frame_ptr)
    //   - local.set $frame_ptr
    //   - global.get buf, local.get $frame_ptr, store offset=0
    //   - local.get $frame_ptr, load offset=4 (call_idx from frame)
    //   - local.set $call_idx_local
    //   - local.get $frame_ptr, load offset=8 (catch_region_id) [Phase 6b]
    //   - local.set $catch_region_id_local                      [Phase 6b]
    //   - local.get $frame_ptr, load offset=12 (exnref_slot)    [Phase 6b]
    //   - local.set $exnref_slot_local                          [Phase 6b]
    // For a function with no user locals, this is the full preamble.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    let kinds = seq_kinds(&module, caller, preamble_then);
    assert_eq!(
        kinds,
        vec![
            InstrKind::GlobalGet, // buf
            InstrKind::Other,     // Load current_pos
            InstrKind::Const,     // frame_size
            InstrKind::Binop,     // sub
            InstrKind::LocalSet,  // set $frame_ptr
            InstrKind::GlobalGet, // buf
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Store new current_pos
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load call_idx from frame+4
            InstrKind::LocalSet,  // set $call_idx
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load catch_region_id from frame+8
            InstrKind::LocalSet,  // set $catch_region_id
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load exnref_slot from frame+12
            InstrKind::LocalSet,  // set $exnref_slot
        ],
    );
}

#[test]
fn postamble_writes_frame_header_and_bumps_current_pos() {
    // For a function with no user locals, the postamble body is:
    //   global.get buf, load offset=0, local.set $frame_ptr
    //   local.get $frame_ptr, i32.const func_ordinal, store offset=0
    //   local.get $frame_ptr, local.get $call_idx, store offset=4
    //   local.get $frame_ptr, local.get $catch_region_id, store offset=8   [Phase 6b]
    //   local.get $frame_ptr, local.get $exnref_slot, store offset=12      [Phase 6b]
    //   global.get buf, local.get $frame_ptr, i32.const frame_size, i32.add, store
    //   <defaults for result types: i32.const 0>
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);

    let kinds = entry_instr_kinds(&module, caller);
    let postamble: Vec<InstrKind> = kinds[postamble_start..].to_vec();

    // Expected postamble (see above):
    let expected = vec![
        // Load current_pos into $frame_ptr
        InstrKind::GlobalGet, // buf
        InstrKind::Other,     // Load
        InstrKind::LocalSet,  // set $frame_ptr
        // Write func_index at offset 0
        InstrKind::LocalGet,
        InstrKind::Const,
        InstrKind::Other, // Store
        // Write call_index at offset 4
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other, // Store
        // Write catch_region_id at offset 8 (Phase 6b: from $catch_region_id local)
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other,
        // Write exnref_slot at offset 12 (Phase 6b: from $exnref_slot local)
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other,
        // Bump current_pos: buf, frame_ptr, frame_size, add, store
        InstrKind::GlobalGet,
        InstrKind::LocalGet,
        InstrKind::Const,
        InstrKind::Binop,
        InstrKind::Other,
        // Default return value: i32.const 0
        InstrKind::Const,
    ];
    assert_eq!(postamble, expected);
}

/// A fork-path function with an i32 local. The 4d frame should
/// grow by 4 bytes to hold that local.
const FIXTURE_WITH_I32_LOCAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        (local $x i32)
        i32.const 7
        local.set $x
        call $fork
        local.get $x
        i32.add)
      (memory 1))
"#;

#[test]
fn user_scalar_locals_are_saved_and_restored_in_frame() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    // With one i32 user local, preamble-then should include an extra
    // local.get $frame_ptr / Load / local.set sequence at the tail
    // (after call_idx restore).
    let kinds = seq_kinds(&module, caller, preamble_then);
    // Last three: LocalGet(frame_ptr), Load(i32), LocalSet(user local x)
    let tail: Vec<_> = kinds.iter().copied().rev().take(3).collect();
    assert_eq!(
        tail,
        vec![InstrKind::LocalSet, InstrKind::Other, InstrKind::LocalGet],
        "preamble-then must restore the i32 user local: {kinds:?}",
    );
}

#[test]
fn postamble_serializes_user_scalar_locals() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);

    // Postamble with one user local should include an extra
    // LocalGet(frame_ptr), LocalGet(user), Store sequence between
    // the exnref_slot store and the current_pos bump.
    let kinds = entry_instr_kinds(&module, caller);
    let postamble = &kinds[postamble_start..];

    // Count stores: header has 4 (func_index, call_index, catch_region_id, exnref_slot),
    // user locals add 1 (our i32 x), and current_pos bump adds 1. Total 6.
    let store_count = postamble
        .iter()
        .filter(|k| matches!(k, InstrKind::Other))
        .count();
    // "Other" includes Load and Store; there's one Load (for current_pos)
    // and six Stores = 7 Others expected.
    assert_eq!(
        store_count, 7,
        "postamble should have 1 Load + 6 Stores (header 4 + user 1 + bump 1): {postamble:?}",
    );
}

/// Function with a non-trivial signature — multi-param, multi-result.
/// Tests the default-value fallbacks in both the else branch of
/// wrapped calls and the postamble's default-return push.
const FIXTURE_COMPLEX_RETURN: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (param i32 f64) (result i32 f64)
        call $fork
        drop
        local.get 0
        local.get 1)
      (memory 1))
"#;

#[test]
fn postamble_emits_defaults_for_each_result_type() {
    let bytes = instrument_wat(FIXTURE_COMPLEX_RETURN);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);

    // The last two Const instructions in the entry block are the
    // default return values: i32.const 0 and f64.const 0.0.
    let trailing_consts = kinds.iter().rev().take_while(|k| **k == InstrKind::Const).count();
    assert_eq!(
        trailing_consts, 2,
        "postamble should emit one Const per result type: {kinds:?}",
    );
}

#[test]
fn call_idx_local_exists_per_function() {
    // Cross-check: the $call_idx local set in the wrapped call's
    // then-branch and read in the preamble's restore should be the
    // same LocalId (i.e., the function has exactly one call_idx
    // local, not one per call site).
    let bytes = instrument_wat(FIXTURE_TWO_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);

    // Both wrapped calls' then-branches should set the same local.
    let wrapper_seq = local(&module, caller).block(wrapper_id);
    let then_ids: Vec<InstrSeqId> = wrapper_seq
        .instrs
        .iter()
        .filter_map(|(i, _)| match i {
            Instr::IfElse(ie) => Some(ie.consequent),
            _ => None,
        })
        .collect();

    let mut set_locals = Vec::new();
    for tid in &then_ids {
        let tseq = local(&module, caller).block(*tid);
        // Expected pattern: [..., Const(call_idx_N), LocalSet(call_idx_local), ...]
        for (instr, _) in &tseq.instrs {
            if let Instr::LocalSet(ls) = instr {
                set_locals.push(ls.local);
                break; // first LocalSet is the call_idx tag
            }
        }
    }
    assert_eq!(set_locals.len(), 2, "each then-branch should have a LocalSet");
    assert_eq!(
        set_locals[0], set_locals[1],
        "both call sites should tag the same $call_idx local",
    );
}

// ======================================================================
// Phase 4f tests — ref-typed locals via aux tables
// ======================================================================

/// A fork-path function with one funcref local. After 4f, an aux
/// funcref table should be injected and the local saved/restored
/// through it.
const FIXTURE_FUNCREF_LOCAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        (local $f funcref)
        ref.null func
        local.set $f
        call $fork
        local.get $f
        drop)
      (memory 1))
"#;

#[test]
fn funcref_local_triggers_aux_table_injection() {
    let bytes = instrument_wat(FIXTURE_FUNCREF_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    // Find a table whose name is the funcref stash. The module
    // already had no tables, so this is injected by 4f.
    let stash_count = module
        .tables
        .iter()
        .filter(|t| {
            t.name
                .as_deref()
                .map_or(false, |n| n == "_wpk_fork_funcref_stash")
        })
        .count();
    assert_eq!(stash_count, 1, "expected exactly one funcref stash table");

    // Table's initial size should match the slot count (1 funcref local).
    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_funcref_stash"))
        .unwrap();
    assert_eq!(stash.initial, 1);
}

#[test]
fn funcref_local_is_spilled_to_table_in_postamble() {
    let bytes = instrument_wat(FIXTURE_FUNCREF_LOCAL);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    // The postamble should contain at least one TableSet (spilling
    // the funcref user local) and the preamble-then should contain
    // at least one TableGet (reloading it).
    let f = local(&module, caller);
    let mut table_sets = 0usize;
    let mut table_gets = 0usize;
    for (instr, _) in &f.block(f.entry_block()).instrs {
        match instr {
            Instr::TableSet(_) => table_sets += 1,
            Instr::TableGet(_) => table_gets += 1,
            _ => {}
        }
    }
    // Recurse into the preamble's then branch: it's an InstrSeq
    // inside an IfElse in the entry block.
    let entry = f.block(f.entry_block());
    for (instr, _) in &entry.instrs {
        if let Instr::IfElse(ie) = instr {
            let then_seq = f.block(ie.consequent);
            for (i, _) in &then_seq.instrs {
                match i {
                    Instr::TableSet(_) => table_sets += 1,
                    Instr::TableGet(_) => table_gets += 1,
                    _ => {}
                }
            }
            break;
        }
    }

    assert_eq!(table_sets, 1, "postamble must spill the one funcref local");
    assert_eq!(
        table_gets, 1,
        "preamble-then must reload the one funcref local",
    );
}

#[test]
fn functions_without_ref_locals_inject_no_aux_tables() {
    // FIXTURE_DIRECT_CALLER has only scalar (or no) locals. No aux
    // tables should be injected.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let stash_names = ["_wpk_fork_funcref_stash", "_wpk_fork_externref_stash", "_wpk_fork_exnref_stash"];
    for name in stash_names {
        assert!(
            !module.tables.iter().any(|t| t.name.as_deref() == Some(name)),
            "module without ref locals should not have `{name}`",
        );
    }
}

/// Ref locals from multiple functions should share a single aux
/// table of each class, with disjoint slot assignments.
const FIXTURE_TWO_FUNCREF_CALLERS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $one (result i32)
        (local $f funcref)
        ref.null func
        local.set $f
        call $fork
        local.get $f
        drop)
      (func $two (export "two") (result i32)
        (local $g funcref)
        ref.null func
        local.set $g
        call $one
        local.get $g
        drop)
      (memory 1))
"#;

#[test]
fn slot_counts_aggregate_across_functions() {
    let bytes = instrument_wat(FIXTURE_TWO_FUNCREF_CALLERS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_funcref_stash"))
        .expect("funcref stash should be injected");
    // Two functions, one funcref each → initial size 2.
    assert_eq!(stash.initial, 2);
}

#[test]
fn externref_local_routes_through_externref_stash() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (local $x externref)
            ref.null extern
            local.set $x
            call $fork
            local.get $x
            drop)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    assert!(
        module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_externref_stash")),
        "externref local should trigger externref stash injection",
    );
    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_funcref_stash")),
        "externref-only module should not inject funcref stash",
    );
}

#[test]
#[should_panic(expected = "fork-instrument 4f")]
fn unsupported_ref_type_panics_with_diagnostic() {
    // A non-nullable concrete ref type isn't supported by 4f; we
    // expect a loud panic rather than silent mis-instrumentation.
    //
    // Use `(ref null any)` — wasm-GC abstract type. Our
    // `classify_ref` deliberately rejects GC abstract types. The
    // local must be *used* in the body so that walrus's parser
    // records it (walrus drops declared-but-unused locals).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (result i32)
            (local $r (ref null any))
            ref.null any
            local.set $r
            call $fork
            local.get $r
            drop)
          (memory 1))
    "#;
    let _ = instrument_wat(wat);
}

// ======================================================================
// Phase 4g tests — non-call side-effect gating
// ======================================================================

/// Fixture: a function that does an `i32.store` between two
/// fork-triggering calls. After 4g the store should be guarded.
const FIXTURE_STORE_BETWEEN_CALLS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork
        i32.const 0
        i32.store
        call $fork)
      (memory 1))
"#;

/// Count IfElse nodes in the wrapper recursively (i.e., including
/// nested blocks). Each wrapped call contributes one IfElse at the
/// top level of the wrapper, and each gated side-effect op
/// contributes another.
fn total_ifelse_in_wrapper(module: &Module, func_id: FunctionId) -> usize {
    let f = local(module, func_id);
    let entry = f.entry_block();
    let wrapper = match f
        .block(entry)
        .instrs
        .iter()
        .find_map(|(i, _)| match i {
            Instr::Block(b) => Some(b.seq),
            _ => None,
        }) {
        Some(id) => id,
        None => return 0,
    };
    count_ifelse_recursive(f, wrapper)
}

fn count_ifelse_recursive(f: &walrus::LocalFunction, seq: InstrSeqId) -> usize {
    let mut count = 0;
    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::IfElse(ie) => {
                count += 1;
                count += count_ifelse_recursive(f, ie.consequent);
                count += count_ifelse_recursive(f, ie.alternative);
            }
            Instr::Block(b) => count += count_ifelse_recursive(f, b.seq),
            Instr::Loop(l) => count += count_ifelse_recursive(f, l.seq),
            _ => {}
        }
    }
    count
}

#[test]
fn store_between_calls_is_gated() {
    let bytes = instrument_wat(FIXTURE_STORE_BETWEEN_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    // Two wrapped calls → 2 IfElses (state-gate per call).
    // One gated store → 1 IfElse. Total expected: 3.
    let total = total_ifelse_in_wrapper(&module, caller);
    assert_eq!(
        total, 3,
        "expected 2 call-wrap + 1 store-wrap IfElses, got {total}",
    );
}

#[test]
fn local_set_is_gated_during_rewind() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (local $x i32)
            call $fork
            local.set $x
            local.get $x)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    // 1 call wrap + 1 local.set wrap = 2 IfElses.
    // (local.get is pure, not gated.)
    let total = total_ifelse_in_wrapper(&module, caller);
    assert_eq!(total, 2);
}

#[test]
fn global_set_is_gated() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $counter (mut i32) (i32.const 0))
          (func $caller (export "caller") (result i32)
            call $fork
            drop
            global.get $counter
            i32.const 1
            i32.add
            global.set $counter
            global.get $counter)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    // 1 call + 1 global.set = 2 IfElses.
    let total = total_ifelse_in_wrapper(&module, caller);
    assert_eq!(total, 2);
}

#[test]
fn pure_ops_are_not_gated() {
    // A function containing only pure ops (const, arith, local.get)
    // plus a call should have exactly one IfElse (the call wrap).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            i32.const 5
            i32.const 10
            i32.add
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    let total = total_ifelse_in_wrapper(&module, caller);
    assert_eq!(
        total, 1,
        "pure code around a single call should yield exactly 1 IfElse, got {total}",
    );
}

#[test]
fn memory_grow_is_gated_and_produces_default_in_else() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork
            drop
            i32.const 1
            memory.grow
            drop
            i32.const 0)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");

    // Call wrap + memory.grow wrap = 2 IfElses.
    let total = total_ifelse_in_wrapper(&module, caller);
    assert_eq!(total, 2);
}

#[test]
fn calls_inside_nested_blocks_are_wrapped() {
    let bytes = instrument_wat(FIXTURE_CALL_IN_BLOCK);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let wrapper_id = entry_wrapper_seq(&module, caller);

    // Locate the nested block inside the wrapper.
    let wrapper_seq = local(&module, caller).block(wrapper_id);
    let inner_block_id = wrapper_seq
        .instrs
        .iter()
        .find_map(|(i, _)| match i {
            Instr::Block(b) => Some(b.seq),
            _ => None,
        })
        .expect("nested block expected inside wrapper");

    // Within the nested block, the call to $fork should have been
    // rewritten into an if-gate. We detect this by the absence of a
    // bare Call and the presence of an IfElse.
    let kinds = seq_kinds(&module, caller, inner_block_id);
    assert!(
        kinds.iter().any(|k| *k == InstrKind::IfElse),
        "nested call should be wrapped in an if-gate: {kinds:?}",
    );
    assert!(
        !kinds.iter().any(|k| *k == InstrKind::Call),
        "nested call should no longer appear as a bare Call: {kinds:?}",
    );
}


// ======================================================================
// Phase 6 tests — catch-handler region tracking + exnref spill + rewind-throw
// ======================================================================
//
// Invariants the tests below pin down:
//
//  - Every try_table on a fork-path function gets a unique per-function
//    `catch_region_id`, starting at 1. The id = 0 reserved for
//    "not-in-handler".
//  - At each try_table body start, a rewind-throw stub is prepended:
//
//        global.get $_wpk_fork_state
//        i32.const REWINDING
//        i32.eq
//        local.get $_wpk_catch_region_id
//        i32.const <K>
//        i32.eq
//        i32.and
//        if
//          i32.const <slot>                    (Phase 6d: runtime local instead)
//          table.get $_wpk_fork_exnref_stash
//          ref.as_non_null
//          throw_ref
//        end
//
//    where `<K>` is the try_table's id and `<slot>` is its stash slot.
//
//  - Each `catch_ref` / `catch_all_ref` clause in a fork-path try_table
//    has its destination rewritten to a new block we inject that
//    captures the exnref into a per-try_table `captured_exnref_K` local,
//    sets `$_in_catch_K = 1`, and `br`s to the original label.
//
//  - The postamble writes to frame+8 / frame+12 use runtime values
//    derived from the in-catch flags rather than hardcoded 0.

/// A fork-path function with one try_table on the fork path. The
/// try_table has a `catch_ref` clause so Phase 6 considers it
/// catch-handler-reachable and allocates a rewind-throw stub + an
/// exnref stash slot for it.
const FIXTURE_FORK_IN_TRY_BODY: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $exn)
      (func $caller (export "caller") (result i32)
        (block $handler (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $handler)
            call $fork
            drop
            ref.null exn))
        drop
        i32.const 0)
      (memory 1))
"#;

/// Collect the `InstrSeqId` of every `TryTable` nested anywhere within
/// `seq`. Recurses into all nested sequences.
fn collect_try_table_bodies(
    f: &LocalFunction,
    seq: InstrSeqId,
    out: &mut Vec<InstrSeqId>,
) {
    for (instr, _) in &f.block(seq).instrs {
        match instr {
            Instr::TryTable(tt) => {
                out.push(tt.seq);
                collect_try_table_bodies(f, tt.seq, out);
            }
            Instr::Block(b) => collect_try_table_bodies(f, b.seq, out),
            Instr::Loop(l) => collect_try_table_bodies(f, l.seq, out),
            Instr::IfElse(ie) => {
                collect_try_table_bodies(f, ie.consequent, out);
                collect_try_table_bodies(f, ie.alternative, out);
            }
            _ => {}
        }
    }
}

#[test]
fn fork_path_try_table_gets_rewind_throw_stub() {
    let bytes = instrument_wat(FIXTURE_FORK_IN_TRY_BODY);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local(&module, caller);

    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 1, "fixture has exactly one try_table");

    // The try_table body should START with the rewind-throw stub.
    // Opcode shape of the stub's prefix:
    //   GlobalGet, Const, Binop,      ;; state == REWINDING
    //   LocalGet,  Const, Binop,      ;; catch_region_id == K
    //   Binop,                         ;; i32.and
    //   IfElse                         ;; stub then-branch does the throw
    let body_kinds = seq_kinds(&module, caller, bodies[0]);
    assert!(
        body_kinds.len() >= 8,
        "try_table body too short to hold Phase 6 stub: {body_kinds:?}",
    );
    assert_eq!(
        &body_kinds[..8],
        &[
            InstrKind::GlobalGet, // state
            InstrKind::Const,     // REWINDING
            InstrKind::Binop,     // ==
            InstrKind::LocalGet,  // catch_region_id_local
            InstrKind::Const,     // K
            InstrKind::Binop,     // ==
            InstrKind::Binop,     // i32.and
            InstrKind::IfElse,    // rewind-throw guard
        ],
        "try_table body must start with Phase 6 rewind-throw guard: {body_kinds:?}",
    );

    // The stub's then-branch should contain the throw_ref sequence:
    //   i32.const <slot>, table.get, ref.as_non_null, throw_ref
    // We only assert opcode *kinds* here to keep the test robust; the
    // specific slot and table are verified end-to-end in other tests.
    let (then_id, _) = {
        let seq = f.block(bodies[0]);
        let ifs: Vec<(InstrSeqId, InstrSeqId)> = seq
            .instrs
            .iter()
            .filter_map(|(i, _)| match i {
                Instr::IfElse(ie) => Some((ie.consequent, ie.alternative)),
                _ => None,
            })
            .collect();
        ifs[0]
    };
    let then_kinds = seq_kinds(&module, caller, then_id);
    assert_eq!(
        then_kinds,
        vec![
            InstrKind::Const,  // exnref_slot
            InstrKind::Other,  // table.get
            InstrKind::Other,  // ref.as_non_null
            InstrKind::Other,  // throw_ref
        ],
        "rewind-throw then-branch shape: {then_kinds:?}",
    );

    // An exnref stash table must have been injected with initial size
    // >= 1 to hold this try_table's captured exnref.
    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash"))
        .expect("Phase 6 must inject exnref stash when a fork-path try_table exists");
    assert!(
        stash.initial >= 1,
        "exnref stash initial size must cover at least the one try_table slot",
    );
}

/// Two sibling try_tables in the same fork-path function get distinct
/// catch_region_ids (1, 2) and distinct exnref-stash slots.
const FIXTURE_TWO_TRY_TABLES: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (tag $exn)
      (func $caller (export "caller") (result i32)
        (block $h1 (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $h1)
            call $fork
            drop
            ref.null exn))
        drop
        (block $h2 (result (ref null exn))
          (try_table (result (ref null exn)) (catch_ref $exn $h2)
            call $fork
            drop
            ref.null exn))
        drop
        i32.const 0)
      (memory 1))
"#;

#[test]
fn distinct_try_tables_get_sequential_region_ids() {
    let bytes = instrument_wat(FIXTURE_TWO_TRY_TABLES);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local(&module, caller);

    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 2, "fixture has two try_tables");

    // The `i32.const K` in each stub's condition (5th instr of each
    // body) should carry the assigned catch_region_id.
    let mut region_ids = Vec::new();
    for body in &bodies {
        let seq = f.block(*body);
        let const_instr = &seq.instrs[4].0;
        let v = match const_instr {
            Instr::Const(c) => match c.value {
                walrus::ir::Value::I32(v) => v,
                _ => panic!("expected i32 const, got {:?}", c.value),
            },
            other => panic!("expected Const, got {other:?}"),
        };
        region_ids.push(v);
    }
    assert_eq!(
        region_ids,
        vec![1, 2],
        "sibling try_tables must get region_ids 1, 2 in lexical order",
    );

    // The exnref stash table must be sized for two entries.
    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash"))
        .expect("stash must be injected");
    assert_eq!(
        stash.initial, 2,
        "two try_tables → exnref stash initial size = 2",
    );
}

#[test]
fn module_without_try_tables_skips_exnref_stash() {
    // FIXTURE_DIRECT_CALLER has no try_tables. No exnref stash should
    // be injected — a no-try_table module pays zero Phase-6 cost.
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "module with no try_tables should not inject the exnref stash",
    );
}

#[test]
fn try_table_on_non_fork_path_is_not_instrumented() {
    // `helper` contains a try_table but doesn't reach fork. The
    // fork-path function `caller` does not contain a try_table.
    // Neither should get a rewind-throw stub.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $helper (export "helper") (result i32)
            (block $h (result (ref null exn))
              (try_table (result (ref null exn)) (catch_ref $exn $h)
                ref.null exn))
            drop
            i32.const 0)
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    // `helper` is not on the fork path, so it should be byte-for-byte
    // unchanged — including no rewind-throw stub in its try_table.
    let helper = func_by_name(&module, "helper");
    let f = local(&module, helper);
    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 1, "helper still has its try_table");
    let body_kinds = seq_kinds(&module, helper, bodies[0]);
    // Untouched body: just `ref.null exn` (an `Other` in our InstrKind).
    assert_eq!(
        body_kinds,
        vec![InstrKind::Other],
        "non-fork-path try_table body must not be instrumented: {body_kinds:?}",
    );

    // No exnref stash should be injected because no fork-path function
    // needs a slot.
    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "non-fork-path try_tables should not force exnref stash injection",
    );
}
