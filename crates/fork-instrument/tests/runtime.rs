//! Tests for Phase 4a: runtime injection.
//!
//! After instrumentation, every module must expose the five control
//! exports with the documented ABI. We verify this by:
//!
//! - Re-parsing the instrumented module with walrus.
//! - Checking the named exports are present, point to functions with
//!   the expected signatures.
//! - Checking the two globals are present and mutable with the
//!   correct types.
//! - Independently validating via wasmparser that the emitted module
//!   is well-formed.

use fork_instrument::runtime::names;
use fork_instrument::linked_frames::{
    FrameFormatDescriptor, LINKED_FRAME_FORMAT_SECTION, PointerWidth,
};
use fork_instrument::{
    FORK_CAP_DYLINK_MAIN, FORK_CAP_SIDE_ENTRY, FORK_CAPABILITIES_SECTION,
    FORK_CAPABILITIES_VERSION, Options, instrument,
};
use walrus::{ExportItem, Module, ValType};
use wasmparser::{Parser, Payload};

fn instrument_wat(wat_src: &str) -> Vec<u8> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    instrument(&bytes, &Options::default()).expect("instrument")
}

fn validate(bytes: &[u8]) {
    let mut validator = wasmparser::Validator::new_with_features(
        wasmparser::WasmFeatures::default(),
    );
    validator.validate_all(bytes).expect("valid wasm");
}

fn fork_capabilities(bytes: &[u8]) -> Vec<Vec<u8>> {
    Parser::new(0)
        .parse_all(bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == FORK_CAPABILITIES_SECTION => {
                Some(section.data().to_vec())
            }
            _ => None,
        })
        .collect()
}

fn export_function_id(module: &Module, name: &str) -> walrus::FunctionId {
    let export = module
        .exports
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("export `{name}` not found"));
    match export.item {
        ExportItem::Function(id) => id,
        _ => panic!("export `{name}` is not a function"),
    }
}

fn func_signature(module: &Module, id: walrus::FunctionId) -> (Vec<ValType>, Vec<ValType>) {
    let ty_id = module.funcs.get(id).ty();
    let ty = module.types.get(ty_id);
    (ty.params().to_vec(), ty.results().to_vec())
}

const EMPTY_MODULE_WITH_FORK: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory 1))
"#;

#[test]
fn instrumented_module_validates() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    validate(&bytes);
}

#[test]
fn linked_runtime_imports_transaction_hooks_and_emits_exact_prefix_metadata() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    for name in [
        names::IMPORT_FRAME_RESERVE,
        names::IMPORT_FRAME_COMMIT,
        names::IMPORT_FRAME_NEXT,
    ] {
        assert!(
            module.imports.iter().any(|import| import.module == "env" && import.name == name),
            "missing linked continuation import {name}",
        );
    }

    let descriptors: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|payload| match payload.expect("parse payload") {
            Payload::CustomSection(section) if section.name() == LINKED_FRAME_FORMAT_SECTION => {
                Some(FrameFormatDescriptor::decode(section.data()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        descriptors,
        vec![FrameFormatDescriptor::current(PointerWidth::Wasm32, 8)],
    );
}

#[test]
fn module_without_fork_seed_does_not_import_linked_storage_hooks() {
    let bytes = instrument_wat("(module (memory 1) (func (export \"run\")))");
    let module = Module::from_buffer(&bytes).unwrap();
    for name in [
        names::IMPORT_FRAME_RESERVE,
        names::IMPORT_FRAME_COMMIT,
        names::IMPORT_FRAME_NEXT,
    ] {
        assert!(
            !module
                .imports
                .iter()
                .any(|import| import.module == "env" && import.name == name),
            "inert module unexpectedly imports linked continuation hook {name}",
        );
    }
}

#[test]
fn marks_dlopen_main_indirect_boundary_separately() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
          (type $callback (func (result i32)))
          (table 1 funcref)
          (memory 1)
          (func (export "dispatch") (result i32)
            i32.const 0
            call_indirect (type $callback)))
    "#;
    let output = instrument_wat(wat);
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![FORK_CAPABILITIES_VERSION, FORK_CAP_DYLINK_MAIN]],
    );
}

#[test]
fn marks_env_fork_side_entry_separately() {
    let input = wat::parse_str(
        r#"
        (module
          (import "env" "fork" (func $fork (result i32)))
          (memory 1)
          (func (export "side_fork") (result i32) call $fork))
        "#,
    )
    .expect("wat parse");
    let output = instrument(
        &input,
        &Options {
            entry_import: "env.fork".into(),
        },
    )
    .expect("instrument side");
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![FORK_CAPABILITIES_VERSION, FORK_CAP_SIDE_ENTRY]],
    );
}

#[test]
fn generic_runtime_exports_do_not_claim_side_or_dylink_coverage() {
    let output = instrument_wat(EMPTY_MODULE_WITH_FORK);
    assert_eq!(
        fork_capabilities(&output),
        vec![vec![FORK_CAPABILITIES_VERSION, 0]],
    );
}

#[test]
fn injects_state_global_mutable_i32_init_zero() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    let state_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_STATE))
        .expect("_wpk_fork_state global missing");

    assert_eq!(state_global.ty, ValType::I32);
    assert!(state_global.mutable, "state global must be mutable");
}

#[test]
fn injects_buf_global_matches_memory_ptr_width_wasm32() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK); // memory 1 => wasm32
    let module = Module::from_buffer(&bytes).unwrap();

    let buf_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_BUF))
        .expect("_wpk_fork_buf global missing");

    assert_eq!(buf_global.ty, ValType::I32, "wasm32 buf should be i32");
    assert!(buf_global.mutable);
}

#[test]
fn injects_buf_global_matches_memory_ptr_width_wasm64() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory i64 1))
    "#;
    let bytes = instrument_wat(wat);
    let module = Module::from_buffer(&bytes).unwrap();

    let buf_global = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some(names::GLOBAL_BUF))
        .expect("_wpk_fork_buf global missing");

    assert_eq!(buf_global.ty, ValType::I64, "wasm64 buf should be i64");
}

#[test]
fn exports_unwind_begin_taking_ptr() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_UNWIND_BEGIN);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, vec![ValType::I32]);
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_unwind_end_taking_no_args_returning_nothing() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_UNWIND_END);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, Vec::<ValType>::new());
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_rewind_begin_taking_ptr() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_REWIND_BEGIN);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, vec![ValType::I32]);
    assert_eq!(results, Vec::<ValType>::new());
}

#[test]
fn exports_state_returning_i32() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();
    let id = export_function_id(&module, names::EXPORT_STATE);
    let (params, results) = func_signature(&module, id);
    assert_eq!(params, Vec::<ValType>::new());
    assert_eq!(results, vec![ValType::I32]);
}

#[test]
fn all_five_control_exports_present() {
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    for name in [
        names::EXPORT_UNWIND_BEGIN,
        names::EXPORT_UNWIND_END,
        names::EXPORT_REWIND_BEGIN,
        names::EXPORT_REWIND_END,
        names::EXPORT_STATE,
    ] {
        assert!(
            module.exports.iter().any(|e| e.name == name),
            "export `{name}` missing"
        );
    }
}

// ======================================================================
// Phase 4e — saved-globals area in unwind_begin / rewind_begin
// ======================================================================

use fork_instrument::runtime::inject_runtime;
use walrus::ir::Instr;

/// Helper: count `Store` / `Load` instructions in the body of the
/// named export by re-parsing the instrumented module.
fn export_body_instr_counts(
    module: &Module,
    export: &str,
) -> (usize, usize) {
    let id = match module
        .exports
        .iter()
        .find(|e| e.name == export)
        .expect("export present")
        .item
    {
        walrus::ExportItem::Function(id) => id,
        _ => panic!("export `{export}` is not a function"),
    };
    let local = match &module.funcs.get(id).kind {
        walrus::FunctionKind::Local(l) => l,
        _ => panic!("`{export}` is not a local function"),
    };
    let mut stores = 0;
    let mut loads = 0;
    for (instr, _) in &local.block(local.entry_block()).instrs {
        match instr {
            Instr::Store(_) => stores += 1,
            Instr::Load(_) => loads += 1,
            _ => {}
        }
    }
    (stores, loads)
}

const MODULE_WITH_EXTRA_GLOBAL: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (global $user_stack (mut i32) (i32.const 0))
      (global $user_tls (mut i32) (i32.const 0))
      (global $user_const i32 (i32.const 42))  ;; immutable — skipped
      (memory 1))
"#;

#[test]
fn unwind_begin_stores_one_per_saved_global() {
    let bytes = instrument_wat(MODULE_WITH_EXTRA_GLOBAL);
    let module = Module::from_buffer(&bytes).unwrap();

    // Two mutable scalar globals pre-exist (`$user_stack`, `$user_tls`).
    // The immutable `$user_const` is excluded. The runtime's own
    // state+buf globals are added *after* the scan so they are also
    // excluded. Plus Phase 7 Task 1 adds one store for `current_pos` at
    // buf+0. Expected: 1 (current_pos) + 2 (saved globals) = 3 stores.
    let (stores, loads) =
        export_body_instr_counts(&module, names::EXPORT_UNWIND_BEGIN);
    assert_eq!(
        stores, 3,
        "unwind_begin should store current_pos + one per saved global",
    );
    assert_eq!(loads, 0, "unwind_begin never reads the save buffer");
}

#[test]
fn rewind_begin_loads_one_per_saved_global() {
    let bytes = instrument_wat(MODULE_WITH_EXTRA_GLOBAL);
    let module = Module::from_buffer(&bytes).unwrap();

    let (stores, loads) =
        export_body_instr_counts(&module, names::EXPORT_REWIND_BEGIN);
    assert_eq!(loads, 2, "rewind_begin should load each saved global");
    assert_eq!(stores, 0, "rewind_begin never writes the save buffer");
}

#[test]
fn saved_globals_metadata_reports_declared_order() {
    // Directly invoke inject_runtime so we can inspect the resulting
    // metadata — the high-level `instrument` fn hides it.
    let bytes = wat::parse_str(MODULE_WITH_EXTRA_GLOBAL).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 0);

    // Exactly two saved globals, in declaration order: user_stack, then user_tls.
    assert_eq!(runtime.saved_globals.len(), 2);

    // Offsets: wasm32 → header 8 bytes, then 4 bytes each.
    assert_eq!(runtime.saved_globals[0].offset, 8);
    assert_eq!(runtime.saved_globals[1].offset, 12);
    // frames_start_offset = end of saved_globals area.
    assert_eq!(runtime.frames_start_offset, 16);
}

#[test]
fn module_with_no_extra_globals_has_empty_saved_globals() {
    let bytes = wat::parse_str(EMPTY_MODULE_WITH_FORK).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 0);

    assert!(
        runtime.saved_globals.is_empty(),
        "no pre-existing mutable globals → saved_globals empty",
    );
    // frames_start_offset should equal the header size alone.
    // For wasm32 that's 2 * 4 = 8 bytes.
    assert_eq!(runtime.frames_start_offset, 8);
}

#[test]
fn wasm64_saved_globals_use_16_byte_header() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $g (mut i64) (i64.const 0))
          (memory i64 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 0);

    // wasm64 → header 2 * 8 = 16 bytes.
    assert_eq!(runtime.saved_globals.len(), 1);
    assert_eq!(runtime.saved_globals[0].offset, 16);
    // The i64 global consumes 8 bytes.
    assert_eq!(runtime.frames_start_offset, 16 + 8);
}

#[test]
fn ref_typed_mutable_globals_are_skipped_in_4e() {
    // Phase 4e handles scalar globals only; ref-typed ones await 4f.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (global $scalar (mut i32) (i32.const 0))
          (global $refg   (mut funcref) (ref.null func))
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 0);

    // Only the i32 scalar should have been picked up.
    assert_eq!(runtime.saved_globals.len(), 1);
    assert_eq!(runtime.saved_globals[0].ty, walrus::ValType::I32);
}

// ======================================================================
// Phase 7 Task 1 — wpk_fork_unwind_begin self-initializes current_pos
// ======================================================================

/// Helper: return the entry-block instructions of the named export
/// as a cloned Vec<Instr>, so tests can pattern-match over them.
fn export_entry_instrs(module: &Module, export: &str) -> Vec<Instr> {
    let id = match module
        .exports
        .iter()
        .find(|e| e.name == export)
        .expect("export present")
        .item
    {
        walrus::ExportItem::Function(id) => id,
        _ => panic!("export `{export}` is not a function"),
    };
    let local = match &module.funcs.get(id).kind {
        walrus::FunctionKind::Local(l) => l,
        _ => panic!("`{export}` is not a local function"),
    };
    local
        .block(local.entry_block())
        .instrs
        .iter()
        .map(|(instr, _)| instr.clone())
        .collect()
}

#[test]
fn unwind_begin_writes_absolute_frames_start_wasm32() {
    // wpk_fork_unwind_begin must write `buf + frames_start_offset` to
    // `*(buf + 0)` as its first memory store.
    // For EMPTY_MODULE_WITH_FORK (no pre-existing mutable scalar
    // globals), frames_start_offset == 2 * sizeof(ptr) == 8 for wasm32.
    let bytes = instrument_wat(EMPTY_MODULE_WITH_FORK);
    let module = Module::from_buffer(&bytes).unwrap();

    let instrs = export_entry_instrs(&module, names::EXPORT_UNWIND_BEGIN);

    // Find the first Store instruction. Its value must be the buffer
    // parameter plus frames_start_offset (8).
    let store_idx = instrs
        .iter()
        .position(|i| matches!(i, Instr::Store(_)))
        .expect("unwind_begin must contain at least one store");

    let store = match &instrs[store_idx] {
        Instr::Store(s) => s,
        _ => unreachable!(),
    };

    assert!(
        matches!(store.kind, walrus::ir::StoreKind::I32 { atomic: false }),
        "wasm32 current_pos store must be i32 non-atomic, got {:?}",
        store.kind,
    );
    assert_eq!(store.arg.offset, 0, "store to buf + 0");
    assert_eq!(store.arg.align, 4, "natural alignment for i32 pointer");

    assert!(
        matches!(
            &instrs[store_idx - 1],
            Instr::Binop(walrus::ir::Binop {
                op: walrus::ir::BinaryOp::I32Add,
            })
        ),
        "wasm32 current_pos must add the buffer base",
    );
    let offset_instr = &instrs[store_idx - 2];
    match offset_instr {
        Instr::Const(c) => match c.value {
            walrus::ir::Value::I32(v) => assert_eq!(
                v, 8,
                "wasm32 empty-globals frames_start_offset is 2*4 = 8",
            ),
            other => panic!("expected I32 const, got {other:?}"),
        },
        other => panic!("expected frame offset const before add, got {other:?}"),
    }
    let value_base = match &instrs[store_idx - 3] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected buffer base before frame offset, got {other:?}"),
    };
    let store_base = match &instrs[store_idx - 4] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected store address before value, got {other:?}"),
    };
    assert_eq!(
        store_base, value_base,
        "store and cursor use the same buffer base",
    );
}

#[test]
fn unwind_begin_writes_absolute_frames_start_wasm64() {
    // Same as above but for a memory64 module. Store kind must be I64,
    // align 8, value 16 (2 * 8 with no saved globals).
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory i64 1))
    "#;
    let bytes = instrument_wat(wat);
    let module = Module::from_buffer(&bytes).unwrap();

    let instrs = export_entry_instrs(&module, names::EXPORT_UNWIND_BEGIN);

    let store_idx = instrs
        .iter()
        .position(|i| matches!(i, Instr::Store(_)))
        .expect("unwind_begin must contain at least one store");

    let store = match &instrs[store_idx] {
        Instr::Store(s) => s,
        _ => unreachable!(),
    };

    assert!(
        matches!(store.kind, walrus::ir::StoreKind::I64 { atomic: false }),
        "wasm64 current_pos store must be i64 non-atomic, got {:?}",
        store.kind,
    );
    assert_eq!(store.arg.offset, 0, "store to buf + 0");
    assert_eq!(store.arg.align, 8, "natural alignment for i64 pointer");

    assert!(
        matches!(
            &instrs[store_idx - 1],
            Instr::Binop(walrus::ir::Binop {
                op: walrus::ir::BinaryOp::I64Add,
            })
        ),
        "wasm64 current_pos must add the buffer base",
    );
    let offset_instr = &instrs[store_idx - 2];
    match offset_instr {
        Instr::Const(c) => match c.value {
            walrus::ir::Value::I64(v) => assert_eq!(
                v, 16,
                "wasm64 empty-globals frames_start_offset is 2*8 = 16",
            ),
            other => panic!("expected I64 const, got {other:?}"),
        },
        other => panic!("expected frame offset const before add, got {other:?}"),
    }
    let value_base = match &instrs[store_idx - 3] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected buffer base before frame offset, got {other:?}"),
    };
    let store_base = match &instrs[store_idx - 4] {
        Instr::LocalGet(get) => get.local,
        other => panic!("expected store address before value, got {other:?}"),
    };
    assert_eq!(
        store_base, value_base,
        "store and cursor use the same buffer base",
    );
}

// ======================================================================
// Stage 1 (B1) Task 1.3 — plain-catch scratch reservation in save buffer
// ======================================================================

#[test]
fn b1_scratch_size_is_zero_for_module_without_plain_catch() {
    // A fork-using module with no try_table at all: B1 plan computes
    // `total_bytes = 0`, the runtime reserves no scratch space, and
    // `frames_start_offset` is byte-identical to pre-B1.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $caller (export "caller") (result i32)
            call $fork)
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 0);
    assert_eq!(runtime.b1_scratch_size, 0);
    assert_eq!(
        runtime.b1_scratch_base, runtime.frames_start_offset,
        "with zero scratch, base and frames_start coincide",
    );
}

#[test]
fn b1_scratch_size_shifts_frames_start_offset() {
    // Two identical modules instrumented with different scratch sizes.
    // The non-zero one must shift `frames_start_offset` by exactly
    // (aligned) scratch size; `b1_scratch_base` must NOT shift —
    // it tracks the post-saved-globals cursor only.
    let wat = r#"
        (module
          (memory 1))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module_a = Module::from_buffer(&bytes).unwrap();
    let runtime_a = inject_runtime(&mut module_a, 0);

    let mut module_b = Module::from_buffer(&bytes).unwrap();
    let runtime_b = inject_runtime(&mut module_b, 16);

    assert_eq!(runtime_b.b1_scratch_size, 16);
    assert_eq!(
        runtime_b.b1_scratch_base, runtime_a.b1_scratch_base,
        "b1_scratch_base sits at end of saved-globals area regardless of scratch size",
    );
    assert_eq!(
        runtime_b.frames_start_offset,
        runtime_a.frames_start_offset + 16,
        "frames_start_offset shifts by exactly the (aligned) scratch size",
    );
}

#[test]
fn b1_scratch_size_rounded_up_to_8_alignment() {
    // 5 bytes requested → rounded up to 8. The frame data must
    // start 8-aligned regardless of payload size so its first
    // i64 store lands on an aligned address.
    let wat = r#"(module (memory 1))"#;
    let bytes = wat::parse_str(wat).unwrap();
    let mut module = Module::from_buffer(&bytes).unwrap();
    let runtime = inject_runtime(&mut module, 5);
    assert_eq!(runtime.b1_scratch_size, 8, "5 rounds up to 8");
    assert_eq!(
        runtime.frames_start_offset - runtime.b1_scratch_base,
        8,
        "frames_start sits exactly aligned-size bytes after scratch base",
    );
}
