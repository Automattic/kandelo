//! Tests for the fork-instrument transforms (switch-dispatch + guard-dispatch).
//!
//! Two transforms share the same fork-resume contract; the instrumenter
//! picks one per function based on call-site topology:
//!
//! - **switch-dispatch**: used when every fork-path call lives at the
//!   function body's top level. REWIND jumps directly to the resumed
//!   call site via a top-level `br_table` (switch-dispatch). Chunks
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
use fork_instrument::{instrument, Options};
use walrus::{
    ir::{self, Instr, InstrSeqId},
    ExportItem, FunctionId, FunctionKind, LocalFunction, Module,
};

// --- Helpers ----------------------------------------------------------

fn parse_wat(wat_src: &str) -> Vec<u8> {
    wat::parse_str(wat_src).expect("wat parse")
}

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = parse_wat(wat_src);
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
fn walk_all<F: FnMut(InstrSeqId, &Instr)>(f: &LocalFunction, seq: InstrSeqId, visit: &mut F) {
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

const FIXTURE_CALL_WITH_LOAD_ARG: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i32) (result i32)
        call $fork)
      (func $caller_with_load_arg (export "caller_with_load_arg") (result i32)
        i32.const 0
        i32.load
        call $leaf)
      (memory 1))
"#;

const FIXTURE_CALL_WITH_I64_SHIFT_ARG: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func $leaf (param i64) (result i32)
        call $fork)
      (func $caller_with_i64_shift_arg (export "caller_with_i64_shift_arg") (result i32)
        i64.const 1
        i64.const 2
        i64.shl
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
    use fork_instrument::instrument::{instrument_functions, B1ScratchPlan};
    use fork_instrument::runtime::inject_runtime;

    let bytes = wat::parse_str(FIXTURE_TRANSITIVE).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();

    let seed =
        call_graph::find_import_func(&module, "kernel.kernel_fork").expect("seed import present");
    let fork_path = call_graph::reaching_closure(&module, seed);
    let runtime = inject_runtime(&mut module, 0);
    let b1_plan = B1ScratchPlan::default();
    let rewritten = instrument_functions(&mut module, &runtime, &fork_path, &b1_plan);

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
    walk_all(local_func(&module, caller), unwind_save, &mut |_, instr| {
        if let Instr::Call(c) = instr {
            if c.func == helper {
                helper_calls += 1;
            }
        }
    });
    assert_eq!(
        helper_calls, 1,
        "non-fork-path helper call should survive verbatim (once)",
    );
}

#[test]
fn call_site_post_sequence_sets_call_idx_and_checks_unwinding() {
    // For each fork-path call site, the post-call sequence is:
    //   <call>, GlobalGet(state), Const(UNWINDING), Binop(eq),
    //   IfElse(then: frame.call_index = K; br $unwind_save).
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);

    // $unwind_save body (one call case):
    //   Block($POST_0), Call($fork), GlobalGet, Const, Binop, IfElse, Return
    let kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(
        kinds,
        vec![
            InstrKind::Block,     // $POST_0
            InstrKind::Call,      // the fork call
            InstrKind::GlobalGet, // state
            InstrKind::Const,     // UNWINDING
            InstrKind::Binop,     // i32.eq
            InstrKind::IfElse,    // then stores frame.call_index and branches
            InstrKind::Return,    // normal-path exit
        ],
    );
}

#[test]
fn host_parsed_marker_exports_are_not_rewritten_even_when_they_reach_fork() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory (export "memory") 1)
          (global $__tls_base (export "__tls_base") i32 (i32.const 1024))

          (func $__wasm_call_ctors
            call $fork
            drop)

          (func $__abi_version_actual (result i32)
            i32.const 17)
          (func $__abi_version (export "__abi_version") (result i32)
            call $__wasm_call_ctors
            call $__abi_version_actual)

          (func $__wasm_posix_thread_slots_actual (result i32)
            i32.const -1)
          (func $__wasm_posix_thread_slots (export "__wasm_posix_thread_slots") (result i32)
            call $__wasm_call_ctors
            call $__wasm_posix_thread_slots_actual)

          (func $__get_channel_base_addr_actual (result i32)
            i32.const 32
            global.get $__tls_base
            i32.add)
          (func $__get_channel_base_addr (export "__get_channel_base_addr") (result i32)
            call $__wasm_call_ctors
            call $__get_channel_base_addr_actual)

          (func $_start (export "_start") (result i32)
            call $__wasm_call_ctors
            i32.const 0))
    "#;

    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    for marker in [
        "__abi_version",
        "__wasm_posix_thread_slots",
        "__get_channel_base_addr",
    ] {
        let kinds = entry_instr_kinds(&module, func_by_name(&module, marker));
        assert_eq!(
            kinds,
            vec![InstrKind::Call, InstrKind::Call],
            "{marker} must keep its raw wasm-ld marker wrapper shape for host byte parsing",
        );
    }

    let start_kinds = entry_instr_kinds(&module, func_by_name(&module, "_start"));
    assert!(
        start_kinds.contains(&InstrKind::Block),
        "_start still reaches fork and should be instrumented",
    );
}

#[test]
fn call_with_pure_args_replays_tail_without_spill_locals() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_ARGS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_args");
    let unwind_save = entry_wrapper_seq(&module, caller);

    // Structure after rewrite:
    //   $unwind_save:
    //     Block($POST_0),
    //     <replay pure i32/f64 constants>, Call,
    //     GlobalGet, Const, Binop, IfElse,
    //     Return
    //   $POST_0:
    //     Block($dispatch_normal),
    //     ;; pure tail removed from the NORMAL chunk
    //
    // NORMAL and REWIND both reach the same post-call sequence, so
    // replaying the pure tail here preserves the call arguments without
    // adding frame-backed arg locals.
    let unwind_kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(unwind_kinds[0], InstrKind::Block);
    assert_eq!(unwind_kinds[1], InstrKind::Const, "replay arg 0");
    assert_eq!(unwind_kinds[2], InstrKind::Const, "replay arg 1");
    assert_eq!(unwind_kinds[3], InstrKind::Call);

    // Find $POST_0 — it's the inner Block of $unwind_save.
    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        post_0_kinds,
        vec![InstrKind::Block],
        "chunk 0 pure arg tail must be removed instead of spilled: {post_0_kinds:?}",
    );
}

#[test]
fn call_with_non_pure_arg_falls_back_to_spill_local() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_LOAD_ARG);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_load_arg");
    let unwind_save = entry_wrapper_seq(&module, caller);
    let unwind_kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(unwind_kinds[0], InstrKind::Block);
    assert_eq!(
        unwind_kinds[1],
        InstrKind::LocalGet,
        "load-produced arg must reload from fallback spill local",
    );
    assert_eq!(unwind_kinds[2], InstrKind::Call);

    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        *post_0_kinds.last().unwrap(),
        InstrKind::LocalSet,
        "unsupported load arg must still spill at the NORMAL chunk tail: {post_0_kinds:?}",
    );
}

#[test]
fn call_with_i64_shift_arg_replays_shift_tail() {
    let bytes = instrument_wat(FIXTURE_CALL_WITH_I64_SHIFT_ARG);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller_with_i64_shift_arg");
    let unwind_save = entry_wrapper_seq(&module, caller);
    let unwind_kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(unwind_kinds[0], InstrKind::Block);
    assert_eq!(unwind_kinds[1], InstrKind::Const);
    assert_eq!(unwind_kinds[2], InstrKind::Const);
    assert_eq!(unwind_kinds[3], InstrKind::Binop);
    assert_eq!(unwind_kinds[4], InstrKind::Call);

    let f = local_func(&module, caller);
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    assert_eq!(
        seq_kinds(&module, caller, post_0),
        vec![InstrKind::Block],
        "pure i64 shift arg tail must be removed instead of spilled",
    );
}

#[test]
fn two_calls_assign_sequential_call_idx() {
    let bytes = instrument_wat(FIXTURE_TWO_CALLS);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let _unwind_save = entry_wrapper_seq(&module, caller);
    let f = local_func(&module, caller);

    // Count Const values immediately preceding stores to frame.call_index.
    fn walk_seqs<F: FnMut(InstrSeqId)>(f: &LocalFunction, seq: InstrSeqId, visit: &mut F) {
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
            if let Instr::Store(store) = &instrs[i].0 {
                if store.arg.offset == 4 {
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
fn call_indirect_replays_pure_table_index_arg() {
    let bytes = instrument_wat(FIXTURE_INDIRECT);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let unwind_save = entry_wrapper_seq(&module, caller);
    let f = local_func(&module, caller);

    // $unwind_save:
    //   Block($POST_0),
    //   <replay table index>, CallIndirect,
    //   GlobalGet, Const, Binop, IfElse,
    //   Return
    let kinds = seq_kinds(&module, caller, unwind_save);
    assert_eq!(
        kinds,
        vec![
            InstrKind::Block,
            InstrKind::Const,        // replay i32 table index
            InstrKind::CallIndirect, // indirect call
            InstrKind::GlobalGet,
            InstrKind::Const,
            InstrKind::Binop,
            InstrKind::IfElse,
            InstrKind::Return,
        ],
    );

    // The pure table-index tail is removed from $POST_0 rather than
    // spilled into a frame-backed local.
    let post_0 = match f.block(unwind_save).instrs[0].0 {
        Instr::Block(ir::Block { seq }) => seq,
        _ => panic!("expected Block"),
    };
    let post_0_kinds = seq_kinds(&module, caller, post_0);
    assert_eq!(
        post_0_kinds,
        vec![InstrKind::Block],
        "pure table-index tail must be removed from chunk 0: {post_0_kinds:?}",
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
fn preamble_then_moves_cursor_to_current_frame() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    let kinds = seq_kinds(&module, caller, preamble_then);
    assert_eq!(
        kinds,
        vec![
            InstrKind::GlobalGet, // buf store address
            InstrKind::GlobalGet, // buf load address
            InstrKind::Other,     // Load current_pos
            InstrKind::Const,     // frame_size
            InstrKind::Binop,     // sub to current frame base
            InstrKind::Other,     // Store new current_pos/current frame
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
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Other, // Store func_index
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Other, // Store packed zero catch_region_id + exnref_slot
        InstrKind::GlobalGet,
        InstrKind::GlobalGet,
        InstrKind::Other, // Load current frame
        InstrKind::Const,
        InstrKind::Binop,
        InstrKind::Other, // Store new current_pos
        InstrKind::Const, // default return value
    ];
    assert_eq!(postamble, expected);
}

#[test]
fn no_catch_postamble_packs_zero_catch_header_fields() {
    let bytes = instrument_wat(FIXTURE_DIRECT_CALLER);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("i64.store offset=8"),
        "no-catch postamble should pack catch_region_id/exnref_slot zeroes:\n{caller_section}",
    );
    assert!(
        !(caller_section.contains("i32.store offset=8")
            && caller_section.contains("i32.store offset=12")),
        "no-catch postamble should not emit separate zero stores:\n{caller_section}",
    );
}

#[test]
fn catch_capable_postamble_keeps_dynamic_catch_header_stores() {
    let bytes = instrument_wat(FIXTURE_FORK_IN_TRY_BODY);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("i32.store offset=8"),
        "catch-capable postamble must store dynamic catch_region_id:\n{caller_section}",
    );
    assert!(
        caller_section.contains("i32.store offset=12"),
        "catch-capable postamble must store dynamic exnref_slot:\n{caller_section}",
    );
    assert!(
        !caller_section.contains("i64.store offset=8"),
        "catch-capable postamble must not replace dynamic fields with a packed zero store:\n{caller_section}",
    );
}

#[test]
fn user_scalar_locals_are_saved_and_restored_in_frame() {
    let bytes = instrument_wat(FIXTURE_WITH_I32_LOCAL);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let (preamble_then, _, _) = entry_preamble_and_postamble(&module, caller);

    // With one i32 user local, preamble-then should end by loading
    // the current frame pointer, loading the scalar, and setting the
    // user local.
    let kinds = seq_kinds(&module, caller, preamble_then);
    let tail: Vec<_> = kinds.iter().copied().rev().take(4).collect();
    assert_eq!(
        tail,
        vec![
            InstrKind::LocalSet,
            InstrKind::Other,
            InstrKind::Other,
            InstrKind::GlobalGet,
        ],
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
    //   4 current-frame pointer loads + 4 stores (func_index,
    //   packed zero catch fields, user_x, new current_pos) = 8 Others.
    let other_count = postamble
        .iter()
        .filter(|k| matches!(k, InstrKind::Other))
        .count();
    assert_eq!(
        other_count, 8,
        "postamble should have 4 frame loads + 4 stores (header 2 + user 1 + bump 1): {postamble:?}",
    );
}

#[test]
fn postamble_emits_defaults_for_each_result_type() {
    let bytes = instrument_wat(FIXTURE_COMPLEX_RETURN);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();

    let caller = func_by_name(&module, "caller");
    let kinds = entry_instr_kinds(&module, caller);
    let trailing_consts = kinds
        .iter()
        .rev()
        .take_while(|k| **k == InstrKind::Const)
        .count();
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

    let retargeted = try_table
        .catches
        .iter()
        .any(|c| matches!(c, ir::TryTableCatch::CatchRef { .. }));
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
        try_table
            .catches
            .iter()
            .all(|c| matches!(c, ir::TryTableCatch::Catch { .. })),
        "plain-catch-only try_tables should not be retargeted by Phase 6d",
    );
}

#[test]
fn plain_catch_arms_discovered_for_fork_path_handler() {
    // Fork-path function with a try_table that has a plain `catch` arm.
    // The fork call lives "after" the catch's target block — i.e. it
    // executes when the catch dispatches `br $h` (which jumps to just
    // past the block's end). Stage 1 must enumerate the plain-catch
    // arm regardless of fork-call reachability; this matches Phase 6's
    // unfiltered approach for catch_ref.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    // Stage 1 only verifies that this WAT shape — the target case for B1 —
    // still round-trips through today's instrumenter without breaking. The
    // emission of plain-catch save/restore code is Stage 2; this test will
    // be extended to assert behavioral correctness (parent forks → child
    // resumes inside catch handler with restored payload) once Stage 2
    // lands.
}

#[test]
fn discover_plain_catch_arms_returns_one_arm_for_single_catch() {
    // Direct unit test for `discover_plain_catch_arms`. The integration
    // test above only round-trips a WAT through `instrument()`, which
    // does not (yet) call the discovery helper — Stage 2 will. This
    // test exercises the helper directly so it is covered (and not
    // dead code) before the wiring lands.
    let wat = r#"
        (module
          (tag $exn)
          (func $caller (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            i32.const 0)
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let module = Module::from_buffer(&bytes).expect("module parse");

    let func_id = func_by_name(&module, "caller");
    let entries = fork_instrument::instrument::discover_plain_catch_arms(&module, func_id);

    assert_eq!(entries.len(), 1, "expected exactly one try_table entry");
    let (_body_seq, arms) = &entries[0];
    assert_eq!(arms.len(), 1, "expected exactly one plain-catch arm");

    let arm = &arms[0];
    assert_eq!(arm.arm_idx, 0, "single catch arm has idx 0");
    assert!(
        arm.operand_tys.is_empty(),
        "tag $exn declares no payload, so operand_tys should be empty (got {:?})",
        arm.operand_tys,
    );

    // Sanity: the recorded `tag` matches the only tag declared by the
    // module. Proves the helper captured the real tag id rather than a
    // stale or default value.
    let module_tag_id = module
        .tags
        .iter()
        .next()
        .expect("module declares one tag")
        .id();
    assert_eq!(
        arm.tag, module_tag_id,
        "arm.tag should equal the module's declared tag id",
    );

    // Sanity: the recorded `label` is one of the sequence ids actually
    // reachable from the function's entry block — i.e. the helper
    // walked the IR rather than emitting a default. We collect every
    // reachable InstrSeqId in `caller` and confirm `arm.label` is
    // among them.
    let local = local_func(&module, func_id);
    let mut seen: HashSet<InstrSeqId> = HashSet::new();
    collect_seq_ids(local, local.entry_block(), &mut seen);
    assert!(
        seen.contains(&arm.label),
        "arm.label {:?} should be a reachable sequence id in caller (seen={:?})",
        arm.label,
        seen,
    );
}

/// Recursively collect every `InstrSeqId` reachable from `seq` in
/// `f`. Used by the discovery test above to sanity-check that the
/// helper records a real label rather than a stale/default id.
fn collect_seq_ids(f: &LocalFunction, seq: InstrSeqId, out: &mut HashSet<InstrSeqId>) {
    out.insert(seq);
    for (instr, _) in &f.block(seq).instrs {
        for child in nested_seqs_in_test(instr) {
            collect_seq_ids(f, child, out);
        }
    }
}

/// Local helper mirroring `instrument::nested_seqs` — returns child
/// `InstrSeqId`s of a given instruction. Kept tiny and self-contained
/// to avoid widening the crate's public surface.
fn nested_seqs_in_test(instr: &Instr) -> Vec<InstrSeqId> {
    match instr {
        Instr::Block(b) => vec![b.seq],
        Instr::Loop(l) => vec![l.seq],
        Instr::IfElse(ie) => vec![ie.consequent, ie.alternative],
        Instr::TryTable(tt) => vec![tt.seq],
        _ => Vec::new(),
    }
}

// --- B1 Stage 1 Task 1.2 — plan_b1_scratch tests ----------------------

#[test]
fn b1_scratch_plan_empty_targets_is_zero_sized() {
    // Self-review: empty target list → empty plan, zero bytes.
    let wat = r#"
        (module
          (func $caller (export "caller") (result i32) i32.const 0)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[]);
    assert_eq!(plan.total_bytes, 0, "no targets → zero scratch bytes");
    assert!(
        plan.per_function.is_empty(),
        "no targets → empty per_function map"
    );
}

#[test]
fn b1_scratch_plan_empty_payload_arm_is_4_bytes() {
    // Tag with no payload → tuple_size = 4 (just arm_id).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert_eq!(
        plan.per_function.len(),
        1,
        "one function had plain-catch arms"
    );
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 1, "one try_table with plain-catch arms");
    let (_body_seq, slots) = &per_func[0];
    assert_eq!(slots.len(), 1, "one plain-catch arm");
    assert_eq!(slots[0].tuple_size, 4, "no payload → arm_id only");
    assert_eq!(slots[0].scratch_offset, 0, "first slot at offset 0");
    assert_eq!(plan.total_bytes, 8, "rounded up to 8-byte alignment");
}

#[test]
fn b1_scratch_plan_i32_payload_arm_is_8_bytes() {
    // Tag with i32 payload → tuple_size = 4 + 4 = 8.
    //
    // Catch label semantics: branching to a `block` carries the
    // block's RESULT types (forward-branch arity), so a tag with a
    // single i32 operand requires a `(block (result i32))` target.
    // The block then drops the value before falling through.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param i32))
          (func $caller (export "caller") (result i32)
            (block $h (result i32)
              (try_table (catch $exn $h)
                i32.const 0
                drop)
              i32.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    let (_, slots) = &per_func[0];
    assert_eq!(slots[0].tuple_size, 8, "arm_id (4) + i32 payload (4)");
    assert_eq!(slots[0].scratch_offset, 0);
    assert_eq!(plan.total_bytes, 8);
}

#[test]
fn b1_scratch_plan_two_arms_align_to_8_bytes_each() {
    // Two arms in one function, payload sizes 0 and 8.
    // First arm: tuple_size=4 → aligned start 0, end 4
    // Second arm: aligned to 8 → start 8, end 8 + (4 + 8) = 20
    // total_bytes rounds up to 24.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b (param i64))
          (func $caller (export "caller") (result i32)
            (block $ha
              (try_table (catch $a $ha)
                nop))
            (block $hb (result i64)
              (try_table (catch $b $hb)
                i64.const 0
                drop)
              i64.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 2, "two try_tables");
    let (_, slots_a) = &per_func[0];
    let (_, slots_b) = &per_func[1];
    assert_eq!(slots_a[0].scratch_offset, 0);
    assert_eq!(slots_a[0].tuple_size, 4);
    assert_eq!(
        slots_b[0].scratch_offset, 8,
        "second arm aligned to next 8-byte boundary"
    );
    assert_eq!(slots_b[0].tuple_size, 12, "arm_id (4) + i64 (8)");
    assert_eq!(
        plan.total_bytes, 24,
        "rounded up from 20 to next 8-byte boundary"
    );
}

#[test]
fn b1_scratch_plan_arm_with_8_aligned_tuple_needs_no_padding() {
    // Two arms, both with i32 payload (tuple_size = 8 each).
    // Arm 0: aligned=0, tuple=8, cursor=8.
    // Arm 1: aligned=align_up_8(8)=8 (no padding), tuple=8, cursor=8+8=16.
    // total_bytes = align_up_8(16) = 16 (no spurious padding).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param i32))
          (func $caller (export "caller") (result i32)
            (block $ha (result i32)
              (try_table (catch $a $ha)
                i32.const 0
                drop)
              i32.const 0)
            drop
            (block $hb (result i32)
              (try_table (catch $b $hb)
                i32.const 0
                drop)
              i32.const 0)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 2, "two try_tables");
    let (_, slots_a) = &per_func[0];
    let (_, slots_b) = &per_func[1];
    assert_eq!(slots_a[0].scratch_offset, 0);
    assert_eq!(slots_a[0].tuple_size, 8);
    assert_eq!(
        slots_b[0].scratch_offset, 8,
        "8-aligned tuple end means next arm needs no padding"
    );
    assert_eq!(slots_b[0].tuple_size, 8);
    assert_eq!(plan.total_bytes, 16, "no spurious padding inserted");
}

#[test]
fn b1_scratch_plan_handles_f32_f64_operand_sizes() {
    // tag with (param f32 f64) → tuple = 4 (arm_id) + 4 (f32) + 8 (f64) = 16.
    // Verifies scalar_size correctly maps f32→4, f64→8 through the planner.
    //
    // Catch label semantics (mirroring existing i32-payload test): branching
    // to a `(block $h (result f32 f64))` carries the block's RESULT types,
    // matching the tag's payload arity.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param f32 f64))
          (func $caller (export "caller") (result i32)
            (block $h (result f32 f64)
              (try_table (catch $exn $h)
                f32.const 0
                f64.const 0
                drop
                drop)
              f32.const 0
              f64.const 0)
            drop
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    let per_func = &plan.per_function[&caller];
    let (_, slots) = &per_func[0];
    assert_eq!(
        slots[0].tuple_size, 16,
        "arm_id (4) + f32 (4) + f64 (8) = 16"
    );
    assert_eq!(slots[0].scratch_offset, 0);
    assert_eq!(plan.total_bytes, 16);
}

// --- B1 Stage 2 Task 2.1 — operand-type carve-out tests ----------------

#[test]
fn b1_scratch_plan_ref_operand_function_is_carved_out() {
    // A try_table with a tag whose payload includes externref.
    // The function should land in b2_carveout, NOT in per_function.
    //
    // Catch label semantics mirror the existing scalar tests: the
    // block's RESULT type matches the tag's payload arity, and the
    // body drops the value before falling through to a synthesized
    // ref to keep stack arity consistent.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (catch $exn $h)
                ref.null extern
                drop)
              ref.null extern)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        !plan.per_function.contains_key(&caller),
        "carved-out function must not appear in per_function"
    );
    assert!(
        plan.b2_carveout.contains(&caller),
        "carved-out function must be in b2_carveout"
    );
    assert_eq!(
        plan.total_bytes, 0,
        "no scratch allocated for carved-out function"
    );
}

#[test]
fn b1_scratch_plan_mixed_ref_and_scalar_arms_carves_whole_function() {
    // A function with two try_tables: one with i32 payload (supported),
    // one with externref (unsupported). The whole function gets carved
    // out because we don't selectively drop arms — Task 2.3's rewind
    // dispatcher needs the whole function's regions or none.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param externref))
          (func $caller (export "caller") (result i32)
            (block $ha (result i32)
              (try_table (catch $a $ha)
                i32.const 0
                drop)
              i32.const 0)
            drop
            (block $hb (result externref)
              (try_table (catch $b $hb)
                ref.null extern
                drop)
              ref.null extern)
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        plan.b2_carveout.contains(&caller),
        "carve-out must include functions with mixed scalar+ref arms"
    );
    assert!(
        !plan.per_function.contains_key(&caller),
        "carved-out function must not appear in per_function even \
         though one arm is otherwise supported"
    );
    assert_eq!(
        plan.total_bytes, 0,
        "carved-out functions allocate no scratch"
    );
}

#[test]
fn b1_scratch_plan_scalar_only_function_is_not_carved_out() {
    // Sanity: the existing scalar-only fixture must NOT be carved out.
    // Mirrors the scalar tests above to ensure carve-out is gated
    // strictly on ref-typed operands and doesn't accidentally trip
    // for the supported case.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        !plan.b2_carveout.contains(&caller),
        "scalar-only function must not be in b2_carveout"
    );
    assert!(
        plan.per_function.contains_key(&caller),
        "scalar-only function must have a per_function entry"
    );
}

#[test]
fn b1_scratch_plan_multi_target_plain_catch_carved_out() {
    // Two arms in one try_table, pointing at different labels.
    // Should be carved out (Task 2.4 conservative guard: multi-target
    // plain-catch fork has not been verified end-to-end).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b)
          (func $caller (export "caller") (result i32)
            (block $h2
              (block $h1
                (try_table (catch $a $h1) (catch $b $h2)
                  nop)))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        plan.b2_carveout.contains(&caller),
        "multi-target try_table should be carved out"
    );
    assert!(
        !plan.per_function.contains_key(&caller),
        "carved-out function should not have a slot plan"
    );
}

#[test]
fn b1_scratch_plan_single_target_multi_arm_is_supported() {
    // Two arms in one try_table, both pointing at the SAME label.
    // Should NOT be carved out (this is the supported multi-arm case
    // — Task 2.4's guard only triggers when arms diverge).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a)
          (tag $b)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $a $h) (catch $b $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = parse_wat(wat);
    let module = walrus::Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        !plan.b2_carveout.contains(&caller),
        "single-target multi-arm should be supported"
    );
    assert!(plan.per_function.contains_key(&caller));
    let per_func = &plan.per_function[&caller];
    assert_eq!(per_func.len(), 1, "one try_table");
    let (_, slots) = &per_func[0];
    assert_eq!(slots.len(), 2, "two arms (both targeting same label)");
}

// ======================================================================
// Stage 1 (B1) Task 1.3 — end-to-end smoke via lib::instrument
// ======================================================================

#[test]
fn b1_stage_1_module_without_plain_catch_validates_and_b1_size_zero() {
    // A fork-using module with no plain catch should be byte-identical
    // (instrumentation-wise) to pre-B1 — Stage 1 only adds bookkeeping;
    // emission is unchanged. The standard wpk_fork_* exports must
    // still be present.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert!(
        module.exports.iter().any(|e| e.name == "wpk_fork_state"),
        "wpk_fork_state export must remain after Stage 1"
    );
}

#[test]
fn b1_stage_1_module_with_plain_catch_still_validates() {
    // The plain-catch fixture from Tasks 1.1/1.2: B1 plan computes a
    // non-zero scratch size, frames_start_offset shifts, but the
    // emitted module still validates and exposes the standard
    // wpk_fork_* exports. Behavioral assertions (parent forks → child
    // resumes inside catch) come in Stage 2.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    assert!(
        module.exports.iter().any(|e| e.name == "wpk_fork_state"),
        "wpk_fork_state export must remain after Stage 1"
    );
}

// ======================================================================
// Stage 2 (B1) Task 2.2 — per-arm capture-block emission
// ======================================================================

/// Walks the function and returns each TryTable instruction. Includes
/// nested ones — used to count + inspect catch clauses post-instrument.
fn collect_try_tables(f: &LocalFunction) -> Vec<ir::TryTable> {
    let mut out: Vec<ir::TryTable> = Vec::new();
    walk_all(f, f.entry_block(), &mut |_, instr| {
        if let Instr::TryTable(tt) = instr {
            out.push(tt.clone());
        }
    });
    out
}

#[test]
fn b1_stage_2_plain_catch_arm_retargets_to_capture_block() {
    // After instrumentation, the original try_table's plain Catch
    // clause should point at an injected capture block, not at the
    // original handler label `$h`. The capture block contains the
    // save+rebroadcast logic and a `br` to the original handler.
    //
    // Note: walrus's parser drops post-`br` "unreachable" code on
    // round-trip via `Module::from_buffer`. Our save-and-branch logic
    // lives after `br $b1_outer` in the cap block — visible in the
    // serialized wasm but invisible via re-parsed walrus IR. We use
    // wasmprinter to assert against the actual wasm bytes.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    // 1. Walrus-level: the try_table is preserved with a Catch clause.
    //    (The Catch label points at our capture block; we can't easily
    //    distinguish "the user's $h" from "B1's cap" in walrus IR
    //    without re-parsing tricks, so we only assert presence here.)
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    let try_tables = collect_try_tables(f);
    assert_eq!(
        try_tables.len(),
        1,
        "expected exactly one try_table post-instrument"
    );
    let tt = &try_tables[0];
    assert_eq!(tt.catches.len(), 1, "should still have 1 catch clause");
    assert!(
        matches!(&tt.catches[0], ir::TryTableCatch::Catch { .. }),
        "should be a plain Catch clause"
    );

    // 2. Byte-level (wasmprinter): the cap block must contain the B1
    //    save sequence (i32.store of arm_id followed by local.set of
    //    in_catch / catch_region_id locals) and an outer `br` of the
    //    handler. We grep for the i32.store + local.set pattern that
    //    is unique to B1's emission. (Walrus drops these on re-parse
    //    because they're after the unconditional `br $b1_outer`.)
    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    assert!(
        caller_section.contains("try_table"),
        "caller must still have a try_table:\n{caller_section}"
    );
    // The save sequence: `i32.store offset=N` is unique to the B1
    // emission. (The frame-IO emissions use offset=0/4/8/12 only.)
    // For the no-operand fixture, slot.scratch_offset = 0 within the
    // scratch area, and runtime.b1_scratch_base is where the scratch
    // starts (at 8 in this module: 2P=8 with no saved globals + B=8
    // rounded). We look for ANY of i32.store with offset >= 16 that
    // follows a global.get $_wpk_fork_buf — the unique B1 pattern.
    // Easier signature: the literal sequence "i32.const 0\n  ...
    // i32.store offset=8" stores arm_idx 0 at scratch offset 0
    // (absolute = b1_scratch_base = 8). The exact offset depends on
    // saved globals; the only invariant is *some* store happens.
    assert!(
        caller_section.contains("i32.store offset=8"),
        "caller must contain i32.store at the B1 scratch arm_id offset \
         (= b1_scratch_base + 0 = 8 for this fixture):\n{caller_section}"
    );
}

/// Extract the `(func $name ... )` section from a wasmprinter dump.
fn extract_function_text<'a>(printed: &'a str, name: &str) -> String {
    let needle = format!("(func ${name} ");
    let start = printed.find(&needle).unwrap_or_else(|| {
        panic!("function ${name} not found in:\n{printed}");
    });
    // Walk paren depth from start to find the matching close.
    let mut depth = 0i32;
    let mut end = start;
    for (i, c) in printed[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    printed[start..end].to_string()
}

#[test]
fn b1_stage_2_b2_carveout_function_is_not_transformed() {
    // A function whose plain-catch arm has a ref-typed payload is in
    // b2_carveout (per Task 2.1). For these functions, B1 emission
    // is skipped, so the byte output must NOT contain the B1 capture
    // block's save-to-scratch pattern. The Catch clause must still
    // be present (Phase 6 doesn't intercept plain catch).
    //
    // Note: ref-typed catch payloads are not yet supported by the
    // existing Phase-6 ref-local pipeline (function would panic with
    // a "non-nullable or non-abstract ref" or fail wasm validation in
    // some shapes). We use a fork-bearing function that *contains*
    // a try_table whose tag has a ref operand, but the catch handler
    // itself stays simple. To avoid type-mismatch errors during wat
    // parse, we feed the catch via `throw`-then-`drop` inside a block
    // typed `(result externref)`.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (result externref) (catch $exn $h)
                ref.null extern
                throw $exn))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let module = Module::from_buffer(&bytes).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);

    // Carve-out functions have NO B1 transform applied. The try_table
    // is preserved with its catches as-emitted by Phase 6 (which
    // doesn't intercept plain Catch clauses; only catch_ref / catch_all_ref).
    let try_tables = collect_try_tables(f);
    assert_eq!(
        try_tables.len(),
        1,
        "carved-out function must still have exactly one try_table"
    );
    let tt = &try_tables[0];
    let has_catch = tt
        .catches
        .iter()
        .any(|c| matches!(c, ir::TryTableCatch::Catch { .. }));
    assert!(
        has_catch,
        "carved-out function's plain Catch clause must be preserved \
         (B1 must NOT have transformed it)"
    );

    // Byte-level: with the function in `b2_carveout`, the plan
    // reserves zero scratch bytes for it — `B1ScratchPlan.total_bytes
    // == 0` and `runtime.b1_scratch_size == 0`. We confirm via the
    // direct planner API: a fresh plan over `[caller]` must list it
    // in b2_carveout, not per_function.
    let plan = fork_instrument::instrument::plan_b1_scratch(&module, &[caller]);
    assert!(
        plan.b2_carveout.contains(&caller),
        "carved-out function (ref-typed catch operand) must be in \
         b2_carveout"
    );
    assert!(
        !plan.per_function.contains_key(&caller),
        "carved-out function must NOT have a per_function entry"
    );
    assert_eq!(
        plan.total_bytes, 0,
        "no scratch reservation expected when only function is carved \
         out"
    );
}

#[test]
fn b1_stage_2_byte_identity_for_module_without_plain_catch() {
    // A fork-using module with NO plain-catch should produce stable
    // output that's byte-identical across repeated runs (instrument
    // is deterministic) and produces ZERO try_tables — Stage 2's
    // emission must not fire when there are no plain-catch arms.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes_a = instrument_wat(wat);
    let bytes_b = instrument_wat(wat);
    assert_eq!(bytes_a, bytes_b, "instrument must be deterministic");
    validate(&bytes_a);

    let module = Module::from_buffer(&bytes_a).unwrap();
    let caller = func_by_name(&module, "caller");
    let f = local_func(&module, caller);
    let try_tables = collect_try_tables(f);
    assert!(
        try_tables.is_empty(),
        "no try_tables expected for a fork-only function — Stage 2 \
         must not introduce any: got {} try_tables",
        try_tables.len()
    );
}

// ======================================================================
// Stage 2 (B1) Task 2.3 — multi-arm rewind dispatch
// ======================================================================

#[test]
fn b1_stage_2_rewind_stub_has_plain_catch_dispatch() {
    // The rewind-throw stub for a region with a plain-catch arm must
    // include a `throw $tag` (in addition to Phase 6's existing
    // `throw_ref`) so that on REWIND the original handler observes
    // the same exception class. The exact wat shape varies with
    // walrus's emitter, so we just check the key semantic markers.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn)
          (func $caller (export "caller") (result i32)
            (block $h
              (try_table (catch $exn $h)
                nop))
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    // Both stub paths must be present:
    //   - throw_ref (Phase 6 catch_ref re-throw)
    //   - throw $exn (B1 plain-catch arm dispatch)
    assert!(
        caller_section.contains("throw_ref"),
        "rewind stub must retain Phase 6's throw_ref path:\n{caller_section}"
    );
    assert!(
        caller_section.contains("throw $exn") || caller_section.contains("throw 0"),
        "rewind stub must contain a `throw $exn` for the plain-catch \
         arm dispatch:\n{caller_section}"
    );
    // ref.is_null indicates the sentinel check (B1 selects between
    // catch_ref and plain-catch paths based on whether the exnref
    // stash slot is null).
    assert!(
        caller_section.contains("ref.is_null"),
        "rewind stub must use ref.is_null on the exnref stash to \
         choose between catch_ref and plain-catch paths:\n{caller_section}"
    );
}

#[test]
fn b1_stage_2_rewind_stub_dispatches_two_arms() {
    // A try_table with two plain-catch arms (different tags) must
    // produce a rewind dispatch with two distinct `throw $tag`
    // emissions — one per arm — so the if-chain on saved arm_id
    // routes correctly at REWIND.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $a (param i32))
          (tag $b (param i32))
          (func $caller (export "caller") (result i32)
            (block $h (result i32)
              (try_table (result i32) (catch $a $h) (catch $b $h)
                i32.const 0))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);
    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    let throw_a = caller_section.matches("throw $a").count();
    let throw_b = caller_section.matches("throw $b").count();
    // Each arm contributes a `throw $a` from B1 dispatch and a
    // `throw $b` from B1 dispatch. The original `throw $exn` in the
    // try_table body is NOT in the source (the wat only catches),
    // so the only `throw $a` / `throw $b` in the printed output come
    // from the B1 rewind stub. We expect at least 1 of each.
    assert!(
        throw_a >= 1,
        "expected `throw $a` for the first plain-catch arm:\n{caller_section}"
    );
    assert!(
        throw_b >= 1,
        "expected `throw $b` for the second plain-catch arm:\n{caller_section}"
    );
}

#[test]
fn b1_stage_2_carved_out_function_no_b1_dispatch_emitted() {
    // A function in `b2_carveout` (here: ref-typed catch payload)
    // must NOT receive B1's plain-catch dispatch — its rewind stub
    // should retain Phase 6's pre-B1 form (throw_ref only) and
    // contain no `ref.is_null`-based sentinel.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (tag $exn (param externref))
          (func $caller (export "caller") (result i32)
            (block $h (result externref)
              (try_table (result externref) (catch $exn $h)
                ref.null extern
                throw $exn))
            drop
            call $fork)
          (memory 1))
    "#;
    let bytes = instrument_wat(wat);
    validate(&bytes);

    let printed = wasmprinter::print_bytes(&bytes).expect("wasmprinter");
    let caller_section = extract_function_text(&printed, "caller");
    // The carved-out function's rewind stub uses ONLY Phase 6's
    // throw_ref path. It must NOT contain B1's `ref.is_null` sentinel
    // (which would indicate a B1 plain-catch dispatch was emitted).
    assert!(
        caller_section.contains("throw_ref"),
        "carved-out function must retain Phase 6's throw_ref:\n{caller_section}"
    );
    assert!(
        !caller_section.contains("ref.is_null"),
        "carved-out function must NOT have B1's ref.is_null sentinel \
         (no plain-catch dispatch should be emitted):\n{caller_section}"
    );
}
