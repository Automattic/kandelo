//! Tests for the fork-instrument transforms (switch-dispatch + guard-dispatch).
//!
//! Two transforms share the same fork-resume contract; the instrumenter
//! picks one per function based on call-site topology:
//!
//! - **switch-dispatch**: used when every fork-path call lives at the
//!   function body's top level. REWIND jumps directly to the resumed
//!   call site via a top-level `br_table` (asyncify-style). Chunks
//!   between calls run only on the NORMAL fall-through.
//! - **guard-dispatch**: used when any fork-path call is nested inside
//!   a block/loop/if/try_table. Each call site carries an in-place
//!   if-else guard that fires on `(NORMAL) || (REWIND && call_idx ==
//!   N)`; Phase 4g gates state-mutating ops during REWIND replay.
//!
//! Both schemes share the same frame layout and the entry-block shape
//! `[preamble-ifelse, Block($unwind_save), postamble]`.

use std::collections::HashSet;

use fork_instrument::runtime::names as runtime_names;
use fork_instrument::{Options, instrument};
use walrus::{
    ExportItem, FunctionId, FunctionKind, LocalFunction, Module,
    ir::{self, Instr, InstrSeqId},
};

// --- Helpers ----------------------------------------------------------

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    instrument(&bytes, &Options::default()).expect("instrument")
}

fn validate(bytes: &[u8]) {
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator.validate_all(bytes).expect("valid wasm");
}

fn func_by_name(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function `{name}` not found"))
        .id()
}

fn local_func(module: &Module, id: FunctionId) -> &LocalFunction {
    match &module.funcs.get(id).kind {
        FunctionKind::Local(l) => l,
        _ => panic!("function is not local"),
    }
}

fn entry_instr_kinds(module: &Module, id: FunctionId) -> Vec<InstrKind> {
    let f = local_func(module, id);
    f.block(f.entry_block())
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

fn seq_kinds(module: &Module, func_id: FunctionId, seq_id: InstrSeqId) -> Vec<InstrKind> {
    local_func(module, func_id)
        .block(seq_id)
        .instrs
        .iter()
        .map(|(i, _)| InstrKind::of(i))
        .collect()
}

/// Return the single `Block(seq)` at the top level of the entry
/// block. Instrumented fork-path functions have exactly one top-level
/// block (`$unwind_save`).
fn entry_wrapper_seq(module: &Module, id: FunctionId) -> InstrSeqId {
    let f = local_func(module, id);
    let blocks: Vec<InstrSeqId> = f
        .block(f.entry_block())
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
    BrTable,
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
            Instr::BrTable(_) => InstrKind::BrTable,
            _ => InstrKind::Other,
        }
    }
}

fn nested_of(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(ir::Block { seq }) => vec![*seq],
        Instr::Loop(ir::Loop { seq }) => vec![*seq],
        Instr::IfElse(ir::IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
        _ => Vec::new(),
    }
}

/// Invoke `visit` for every instruction reachable from `seq`.
fn walk_all<F: FnMut(InstrSeqId, &Instr)>(
    f: &LocalFunction,
    seq: InstrSeqId,
    visit: &mut F,
) {
    for (instr, _) in &f.block(seq).instrs {
        visit(seq, instr);
        for child in nested_of(instr) {
            walk_all(f, child, visit);
        }
    }
}

fn count_br_tables(f: &LocalFunction) -> usize {
    let mut n = 0usize;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if matches!(instr, Instr::BrTable(_)) {
            n += 1;
        }
    });
    n
}

fn entry_preamble_and_postamble(
    module: &Module,
    func_id: FunctionId,
) -> (InstrSeqId, InstrSeqId, usize) {
    let f = local_func(module, func_id);
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

// --- Fixtures ---------------------------------------------------------

const FIXTURE_DIRECT_CALLER: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork)
      (func $non_caller (export "non_caller") (result i32)
        i32.const 42)
      (memory 1))
"#;

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

const FIXTURE_NO_FORK: &str = r#"
    (module
      (func $only (export "only") (result i32)
        i32.const 1)
      (memory 1))
"#;

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

const FIXTURE_TWO_CALLS: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $caller (export "caller") (result i32)
        call $fork
        drop
        call $fork)
      (memory 1))
"#;

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

// --- Structural / validation tests -----------------------------------

#[test]
fn instrumented_module_with_direct_caller_validates() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
}

#[test]
fn direct_caller_entry_shape_is_preamble_wrapper_postamble() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);

    // Entry opens with the preamble's `if state == REWINDING` check.
    assert!(
        matches!(kinds.first(), Some(InstrKind::GlobalGet)),
        "entry should start with GlobalGet (state) for REWINDING check: {kinds:?}",
    );
    // Exactly one wrapper Block ($unwind_save).
    assert_eq!(
        kinds.iter().filter(|k| **k == InstrKind::Block).count(),
        1,
        "entry should contain exactly one wrapper Block: {kinds:?}",
    );
    // Must not terminate with Unreachable (postamble pushes real
    // default return values).
    assert!(
        !matches!(kinds.last(), Some(InstrKind::Unreachable)),
        "entry must not end in an Unreachable placeholder: {kinds:?}",
    );
}

#[test]
fn fork_path_function_has_one_top_level_br_table() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    assert_eq!(
        count_br_tables(f),
        1,
        "each fork-path function should emit exactly one dispatch br_table",
    );
}

#[test]
fn non_fork_path_function_is_not_wrapped() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let non_caller = func_by_name(&module, "non_caller");
    assert_eq!(
        entry_instr_kinds(&module, non_caller),
        vec![InstrKind::Const],
        "non-fork-path function should be byte-for-byte unchanged",
    );
}

#[test]
fn runtime_control_functions_are_not_wrapped() {
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

        let f = local_func(&module, id);
        assert_eq!(
            count_br_tables(f),
            0,
            "runtime control function `{export}` should not contain a dispatch br_table",
        );
    }
}

#[test]
fn transitive_callers_are_all_wrapped() {
    let bytes = instrument_wat(FIXTURE_TRANSITIVE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    for name in ["caller_leaf", "caller_mid"] {
        let id = func_by_name(&module, name);
        assert_eq!(
            count_br_tables(local_func(&module, id)),
            1,
            "transitive caller `{name}` should have a dispatch br_table",
        );
    }

    let bystander = func_by_name(&module, "bystander");
    assert_eq!(
        entry_instr_kinds(&module, bystander),
        vec![InstrKind::Const],
        "bystander should not be wrapped",
    );
}

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

#[test]
fn multivalue_return_wraps_and_validates() {
    let bytes = instrument_wat(FIXTURE_MULTIVALUE);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let mv = func_by_name(&module, "mv");
    let kinds = entry_instr_kinds(&module, mv);
    assert!(
        kinds.iter().any(|k| *k == InstrKind::Block),
        "mv entry missing wrapper Block: {kinds:?}",
    );
    assert!(
        kinds.iter().any(|k| *k == InstrKind::IfElse),
        "mv entry missing preamble IfElse: {kinds:?}",
    );
}

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

// --- Dispatch-shape tests --------------------------------------------

/// Locate the `$dispatch_normal` block within the function. That's
/// the block whose body contains `global.get state; const REWINDING;
/// eq; if (then ... br_table ... end)` — no other block matches.
fn find_dispatch_normal(module: &Module, func_id: FunctionId) -> Option<InstrSeqId> {
    let f = local_func(module, func_id);
    let mut dispatch: Option<InstrSeqId> = None;
    walk_all(f, f.entry_block(), &mut |seq, instr| {
        if dispatch.is_some() {
            return;
        }
        if let Instr::IfElse(ie) = instr {
            // Check whether the if-then contains a BrTable.
            let then_seq = f.block(ie.consequent);
            if then_seq
                .instrs
                .iter()
                .any(|(i, _)| matches!(i, Instr::BrTable(_)))
            {
                dispatch = Some(seq);
            }
        }
    });
    dispatch
}

#[test]
fn dispatch_block_contains_rewind_guarded_br_table() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let dispatch = find_dispatch_normal(&module, caller).expect("dispatch block missing");
    // Shape: GlobalGet, Const, Binop, IfElse.
    assert_eq!(
        seq_kinds(&module, caller, dispatch),
        vec![
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
        ],
    );
}

#[test]
fn br_table_default_points_to_unwind_save() {
    // For a function with N fork-path calls, the br_table has N
    // target entries + default. For FIXTURE_DIRECT_CALLER (one call),
    // br_table has one target (POST_0) and a default ($unwind_save).
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    let mut br_table_info: Option<(Vec<InstrSeqId>, InstrSeqId)> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if let Instr::BrTable(bt) = instr {
            br_table_info = Some((bt.blocks.to_vec(), bt.default));
        }
    });
    let (blocks, _default) = br_table_info.expect("br_table missing");
    assert_eq!(blocks.len(), 1, "one call → one br_table target");
}

#[test]
fn non_fork_call_remains_bare_in_chunk_0() {
    let bytes = instrument_wat(FIXTURE_MIXED_CALLEES);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);

    // Walk the whole $unwind_save body and count direct `Call`s to
    // `$helper`. There should be exactly one (chunk 0's helper call
    // is preserved verbatim).
    let helper = func_by_name(&module, "helper");
    let mut helper_calls = 0usize;
    walk_all(
        local_func(&module, caller),
        unwind_save,
        &mut |_, instr| {
            if let Instr::Call(c) = instr {
                if c.func == helper {
                    helper_calls += 1;
                }
            }
        },
    );
    assert_eq!(
        helper_calls, 1,
        "non-fork-path helper call should survive verbatim (once)",
    );
}

#[test]
fn call_site_post_sequence_sets_call_idx_and_checks_unwinding() {
    // For each fork-path call site, the post-call sequence is:
    //   <call>, Const(K), LocalSet($call_idx),
    //   GlobalGet(state), Const(UNWINDING), Binop(eq), BrIf($unwind_save).
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);

    // $unwind_save body (one call case):
    //   Block($POST_0),
    //   Call($fork), Const(0), LocalSet, GlobalGet, Const, Binop, BrIf,
    //   Return
    let kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(
        kinds,
        vec![
            InstrKind::Block,     // $POST_0
            InstrKind::Call,      // the fork call
            InstrKind::Const,     // call_idx = 0
            InstrKind::LocalSet,  // $call_idx_local
            InstrKind::GlobalGet, // state
            InstrKind::Const,     // UNWINDING
            InstrKind::Binop,     // i32.eq
            InstrKind::BrIf,      // $unwind_save
            InstrKind::Return,    // normal-path exit
        ],
    );
}

#[test]
fn call_with_args_spills_and_reloads_through_locals() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_ARGS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_args");
    let unwind_save = entry_wrapper_seq(&module, caller);

    // Structure after rewrite:
    //   $unwind_save:
    //     Block($POST_0),
    //     <reload i32 arg>, <reload f64 arg>, Call,
    //     Const(0), LocalSet($call_idx), GlobalGet, Const, Binop, BrIf,
    //     Return
    //   $POST_0:
    //     Block($dispatch_normal),
    //     <chunk 0: i32.const 7, f64.const 2.5>,
    //     <spill f64 arg>, <spill i32 arg>   ;; top-of-stack first
    //
    // Whether the chunk's spill count is >= 2 and the unwind_save
    // reloads are >= 2 LocalGets before the call is the shape check.
    let unwind_kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(unwind_kinds[0], InstrKind::Block);
    assert_eq!(unwind_kinds[1], InstrKind::LocalGet, "reload arg 0");
    assert_eq!(unwind_kinds[2], InstrKind::LocalGet, "reload arg 1");
    assert_eq!(unwind_kinds[3], InstrKind::Call);

    // Find $POST_0 — it's the inner Block of $unwind_save.
    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    // Should end with 2 LocalSets (spills).
    let last_two: Vec<_> = post_0_kinds.iter().rev().take(2).copied().collect();
    assert_eq!(
        last_two,
        vec![InstrKind::LocalSet, InstrKind::LocalSet],
        "chunk 0 tail must spill two args: {post_0_kinds:?}",
    );
}

#[test]
fn two_calls_assign_sequential_call_idx() {
    let bytes = instrument_wat(FIXTURE_TWO_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);
    let f = local_func(&module, caller);

    // Extract every `i32.const N` immediately before a `local.set`
    // that targets the call_idx local. The call_idx local is the
    // same one referenced by every site.
    //
    // Start by finding the br_table — its input LocalGet names the
    // call_idx local.
    let mut call_idx_local: Option<walrus::LocalId> = None;
    walk_all(f, f.entry_block(), &mut |seq, instr| {
        if call_idx_local.is_some() {
            return;
        }
        if matches!(instr, Instr::BrTable(_)) {
            // Previous instr in same seq is LocalGet(call_idx).
            let seq_instrs = &f.block(seq).instrs;
            for i in 0..seq_instrs.len() {
                if matches!(seq_instrs[i].0, Instr::BrTable(_)) && i > 0 {
                    if let Instr::LocalGet(lg) = &seq_instrs[i - 1].0 {
                        call_idx_local = Some(lg.local);
                    }
                }
            }
        }
    });
    let call_idx_local = call_idx_local.expect("call_idx local discoverable from br_table");

    // Now count Const values immediately preceding LocalSet(call_idx).
    fn walk_seqs<F: FnMut(InstrSeqId)>(
        f: &LocalFunction,
        seq: InstrSeqId,
        visit: &mut F,
    ) {
        visit(seq);
        for (instr, _) in &f.block(seq).instrs {
            for child in nested_of(instr) {
                walk_seqs(f, child, visit);
            }
        }
    }

    let mut idxs: Vec<i32> = Vec::new();
    walk_seqs(f, f.entry_block(), &mut |seq| {
        let instrs = &f.block(seq).instrs;
        for i in 1..instrs.len() {
            if let Instr::LocalSet(ls) = &instrs[i].0 {
                if ls.local == call_idx_local {
                    if let Instr::Const(c) = &instrs[i - 1].0 {
                        if let ir::Value::I32(v) = c.value {
                            idxs.push(v);
                        }
                    }
                }
            }
        }
    });

    // The structure yields the sites in reverse-nesting order: the
    // outermost $unwind_save body has call 1's post-sequence, the
    // inner $POST_1 body has call 0's post-sequence. Sort before
    // asserting the set of assigned indices.
    idxs.sort();
    assert_eq!(idxs, vec![0, 1], "call_idx should count up from 0 per site");
}

#[test]
fn call_indirect_spills_table_index_as_top_arg() {
    let bytes = instrument_wat(FIXTURE_INDIRECT);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);
    let f = local_func(&module, caller);

    // $unwind_save:
    //   Block($POST_0),
    //   <reload table index>, CallIndirect,
    //   Const(0), LocalSet, GlobalGet, Const, Binop, BrIf,
    //   Return
    let kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(
        kinds,
        vec![
            InstrKind::Block,
            InstrKind::LocalGet,     // reload i32 table index
            InstrKind::CallIndirect, // indirect call
            InstrKind::Const,        // call_idx = 0
            InstrKind::LocalSet,     // $call_idx_local
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::BrIf,
            InstrKind::Return,
        ],
    );

    // $POST_0 ends with a single LocalSet (spill the i32 index).
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        *post_0_kinds.last().unwrap(),
        InstrKind::LocalSet,
        "chunk 0 tail must spill the i32 table index: {post_0_kinds:?}",
    );
}

// --- Preamble / postamble tests --------------------------------------

#[test]
fn preamble_starts_with_rewinding_state_check() {
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

    let f = local_func(&module, caller);
    let entry = f.block(f.entry_block());
    let rewinding_const = match &entry.instrs[1].0 {
        Instr::Const(c) => c.value,
        other => panic!("expected Const at entry[1], got {other:?}"),
    };
    match rewinding_const {
        ir::Value::I32(2) => {}
        other => panic!("preamble must check REWINDING (i32 2): {other:?}"),
    }
}

#[test]
fn preamble_then_loads_frame_header_and_call_idx() {
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
            InstrKind::LocalSet,  // $frame_ptr
            InstrKind::GlobalGet, // buf
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Store new current_pos
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load call_idx from frame+4
            InstrKind::LocalSet,  // $call_idx_local
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load catch_region_id from frame+8
            InstrKind::LocalSet,  // $catch_region_id_local
            InstrKind::LocalGet,  // frame_ptr
            InstrKind::Other,     // Load exnref_slot from frame+12
            InstrKind::LocalSet,  // $exnref_slot_local
        ],
    );
}

#[test]
fn postamble_writes_frame_header_and_bumps_current_pos() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (_, _, postamble_start) = entry_preamble_and_postamble(&module, caller);

    let kinds = entry_instr_kinds(&module, caller);
    let postamble: Vec<InstrKind> = kinds[postamble_start..].to_vec();

    let expected = vec![
        InstrKind::GlobalGet, // buf
        InstrKind::Other,     // Load current_pos
        InstrKind::LocalSet,  // $frame_ptr
        InstrKind::LocalGet,
        InstrKind::Const,
        InstrKind::Other, // Store func_index
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other, // Store call_index
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other, // Store catch_region_id
        InstrKind::LocalGet,
        InstrKind::LocalGet,
        InstrKind::Other, // Store exnref_slot
        InstrKind::GlobalGet,
        InstrKind::LocalGet,
        InstrKind::Const,
        InstrKind::Binop,
        InstrKind::Other, // Store new current_pos
        InstrKind::Const, // default return value
    ];
    assert_eq!(postamble, expected);
}

#[test]
fn user_scalar_locals_are_saved_and_restored_in_frame() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    // With one i32 user local, preamble-then should end with a
    // LocalGet(frame_ptr) / Load / LocalSet(user local) trio.
    let kinds = seq_kinds(&module, caller, preamble_then);
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

    let kinds = entry_instr_kinds(&module, caller);
    let postamble = &kinds[postamble_start..];

    // Postamble with one user local:
    //   1 Load (current_pos) + 6 Stores (func_index, call_index,
    //   catch_region_id, exnref_slot, user_x, new current_pos) = 7 Others.
    let other_count = postamble
        .iter()
        .filter(|k| matches!(k, InstrKind::Other))
        .count();
    assert_eq!(
        other_count, 7,
        "postamble should have 1 Load + 6 Stores (header 4 + user 1 + bump 1): {postamble:?}",
    );
}

#[test]
fn postamble_emits_defaults_for_each_result_type() {
    let bytes = instrument_wat(FIXTURE_COMPLEX_RETURN);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);
    let trailing_consts = kinds.iter().rev().take_while(|k| **k == InstrKind::Const).count();
    assert_eq!(
        trailing_consts, 2,
        "postamble should emit one Const per result type: {kinds:?}",
    );
}

// --- Aux-table (Phase 4f) tests --------------------------------------

#[test]
fn funcref_local_triggers_aux_table_injection() {
    let bytes = instrument_wat(FIXTURE_FUNCREF_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let stash_count = module
        .tables
        .iter()
        .filter(|t| t.name.as_deref() == Some("_wpk_fork_funcref_stash"))
        .count();
    assert_eq!(stash_count, 1, "expected exactly one funcref stash table");

    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_funcref_stash"))
        .unwrap();
    assert_eq!(stash.initial, 1);
}

#[test]
fn funcref_local_is_spilled_to_table_and_reloaded() {
    let bytes = instrument_wat(FIXTURE_FUNCREF_LOCAL);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Count TableSet and TableGet anywhere in the function.
    let mut table_sets = 0usize;
    let mut table_gets = 0usize;
    walk_all(f, f.entry_block(), &mut |_, instr| match instr {
        Instr::TableSet(_) => table_sets += 1,
        Instr::TableGet(_) => table_gets += 1,
        _ => {}
    });

    assert_eq!(table_sets, 1, "postamble must spill the one funcref local");
    assert_eq!(
        table_gets, 1,
        "preamble-then must reload the one funcref local",
    );
}

#[test]
fn functions_without_ref_locals_inject_no_aux_tables() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();

    let stash_names = [
        "_wpk_fork_funcref_stash",
        "_wpk_fork_externref_stash",
        "_wpk_fork_exnref_stash",
    ];
    for name in stash_names {
        assert!(
            !module
                .tables
                .iter()
                .any(|t| t.name.as_deref() == Some(name)),
            "module without ref locals should not have `{name}`",
        );
    }
}

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

#[test]
fn module_without_try_tables_skips_exnref_stash() {
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

// --- Non-fork-path try_tables ----------------------------------------

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
    // unchanged — including no rewind-throw stub.
    let helper = func_by_name(&module, "helper");
    let f = local_func(&module, helper);
    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 1, "helper still has its try_table");
    let body_kinds = seq_kinds(&module, helper, bodies[0]);
    assert_eq!(
        body_kinds,
        vec![InstrKind::Other],
        "non-fork-path try_table body must not be instrumented: {body_kinds:?}",
    );

    assert!(
        !module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "non-fork-path try_tables should not force exnref stash injection",
    );
}

fn collect_try_table_bodies(f: &LocalFunction, seq: InstrSeqId, out: &mut Vec<InstrSeqId>) {
    for (instr, _) in &f.block(seq).instrs {
        if let Instr::TryTable(tt) = instr {
            out.push(tt.seq);
            collect_try_table_bodies(f, tt.seq, out);
        }
        for child in nested_of(instr) {
            if !matches!(instr, Instr::TryTable(_)) {
                collect_try_table_bodies(f, child, out);
            }
        }
    }
}

// --- Nested per-block switch-dispatch (Path A) -----------------------
//
// Fork-path calls nested inside `block` bodies (any depth) use the
// nested per-block switch-dispatch transform: each fork-bearing seq
// gets its own br_table + cascading POST blocks. The function-level
// dispatch maps `call_idx` to either a direct POST_K (top-level) or a
// POST_J_ENTER (immediately before the enclosing block). This avoids
// guard-dispatch's REWIND body-replay, which had a divergence bug that
// caused popen-class callers to silently skip the kernel_fork wrap.
// See memory/fork-instrument-O2-bug-investigation.md.
//
// Functions with fork-path calls inside `IfElse`/`Loop`/`TryTable` (or
// with stack carryovers, etc.) still fall back to guard-dispatch
// today.

#[test]
fn call_in_nested_block_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (block (result i32)
              call $fork))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Nested per-block switch-dispatch: at least one br_table is
    // emitted (function-level dispatch + per-block dispatch inside
    // the `block`).
    assert!(
        count_br_tables(f) >= 1,
        "nested-call functions must use per-block switch-dispatch \
         (br_table emitted), not guard-dispatch's body-replay",
    );
}

#[test]
fn fork_inside_try_body_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h (result (ref null exn))
              (try_table (result (ref null exn)) (catch_ref $exn $h)
                call $fork
                drop
                ref.null exn))
            drop
            i32.const 0)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Per-block switch-dispatch handles fork-path calls inside
    // try_table bodies — at least one br_table is emitted (function-
    // level dispatch + per-block dispatch inside the try_table body).
    assert!(
        count_br_tables(f) >= 1,
        "fork-in-try-body must use per-block switch-dispatch \
         (br_table emitted), not guard-dispatch's body-replay",
    );

    // The exnref stash and Phase 6a/6c/6d plumbing are still injected
    // for try_tables — the per-block dispatch overlays on top of the
    // existing catch-handler scaffolding (used by fork-from-catch in
    // the B1 follow-up).
    assert!(
        module
            .tables
            .iter()
            .any(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash")),
        "Phase 6a must inject exnref stash for a fork-path try_table",
    );
}

#[test]
fn fork_inside_loop_uses_per_block_switch_dispatch() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            (local $i i32)
            (loop $l
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $l (i32.eqz (call $fork))))
            (local.get $i))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    assert!(
        count_br_tables(f) >= 1,
        "fork-in-loop must use per-block switch-dispatch (br_table emitted)",
    );
}

#[test]
fn fork_in_both_top_level_and_nested_uses_per_block_switch_dispatch() {
    // Mixed top-level + nested fork calls now use per-block
    // switch-dispatch. The function-level dispatch's br_table maps
    // each call_idx to either a direct POST_K (top-level call) or a
    // POST_J_ENTER (just before the enclosing block); inside the
    // enclosing block, the per-block dispatch routes to its own
    // POST_K.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork
            drop
            (block (result i32)
              call $fork))
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    assert!(
        count_br_tables(f) >= 1,
        "mixed top+nested fork calls must use per-block switch-dispatch \
         (br_table emitted)",
    );
    let mut ifelse_count = 0usize;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if matches!(instr, Instr::IfElse(_)) {
            ifelse_count += 1;
        }
    });
    // preamble + 2 per-call gates = at least 3 IfElse instructions.
    assert!(
        ifelse_count >= 3,
        "guard-dispatch emits one IfElse per call + preamble (>=3): {ifelse_count}",
    );
}

// --- Phase 6 (guard-dispatch only) tests -------------------------------------
//
// These pin down the Phase 6 plumbing that guard-dispatch uses for
// `try_table` catch-handler reconstruction. The fixtures all have
// nested fork-path calls and therefore exercise guard-dispatch.

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
    let f = local_func(&module, caller);

    let mut bodies = Vec::new();
    collect_try_table_bodies(f, f.entry_block(), &mut bodies);
    assert_eq!(bodies.len(), 2, "fixture has two try_tables");

    // After per-block switch-dispatch lands on a try_table body's
    // seq, the body is rebuilt as [Block(POST_{n-1}), post-call,
    // chunks[n], ...]. Phase 6c stubs (which run before the rebuild)
    // are folded into the cascade — they live somewhere in the
    // chunks but are no longer at fixed positions. Just verify the
    // exnref stash is injected with one slot per try_table.
    let stash = module
        .tables
        .iter()
        .find(|t| t.name.as_deref() == Some("_wpk_fork_exnref_stash"))
        .expect("stash must be injected");
    assert_eq!(
        stash.initial, 2,
        "two try_tables → two exnref stash slots (one region_id each)",
    );
}

#[test]
fn catch_ref_clause_is_rewritten_with_capture_block() {
    let bytes = instrument_wat(FIXTURE_FORK_IN_TRY_BODY);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // The try_table's catch_ref clause should now target the injected
    // $capture block (not the original $handler).
    let mut try_table: Option<ir::TryTable> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if try_table.is_none() {
            if let Instr::TryTable(tt) = instr {
                try_table = Some(tt.clone());
            }
        }
    });
    let try_table = try_table.expect("try_table should still exist after 6d");

    let retargeted = try_table.catches.iter().any(|c| matches!(
        c,
        ir::TryTableCatch::CatchRef { .. }
    ));
    assert!(
        retargeted,
        "try_table should still have a CatchRef clause: {:?}",
        try_table.catches,
    );
}

#[test]
fn plain_catch_only_try_table_is_not_6d_rewritten() {
    // Plain `catch` clauses (no exnref) are not redirected by Phase
    // 6d — fork-from-catch-without-exnref is unsupported. The
    // try_table still receives a 6c rewind-throw stub at its body,
    // but its catch clause remains pointing at the original handler.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                call $fork
                drop))
            i32.const 0)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    let mut try_table: Option<ir::TryTable> = None;
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if try_table.is_none() {
            if let Instr::TryTable(tt) = instr {
                try_table = Some(tt.clone());
            }
        }
    });
    let try_table = try_table.expect("try_table should still exist");

    assert!(
        try_table.catches.iter().all(|c| matches!(c, ir::TryTableCatch::Catch { .. })),
        "plain-catch-only try_tables should not be retargeted by Phase 6d",
    );
}
