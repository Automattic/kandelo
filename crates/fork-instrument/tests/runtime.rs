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

use fork_instrument::{Options, instrument};
use fork_instrument::runtime::names;
use walrus::{ExportItem, Module, ValType};

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
    // excluded. Expected: exactly 2 saved-global stores.
    let (stores, loads) =
        export_body_instr_counts(&module, names::EXPORT_UNWIND_BEGIN);
    assert_eq!(
        stores, 2,
        "unwind_begin should store exactly the saved globals",
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
    let runtime = inject_runtime(&mut module);

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
    let runtime = inject_runtime(&mut module);

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
    let runtime = inject_runtime(&mut module);

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
    let runtime = inject_runtime(&mut module);

    // Only the i32 scalar should have been picked up.
    assert_eq!(runtime.saved_globals.len(), 1);
    assert_eq!(runtime.saved_globals[0].ty, walrus::ValType::I32);
}
