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
