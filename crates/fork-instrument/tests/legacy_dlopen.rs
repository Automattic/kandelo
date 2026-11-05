use fork_instrument::{Options, instrument};

use walrus::{FunctionId, ImportKind, Module};

fn imported(module: &Module, name: &str) -> Vec<FunctionId> {
    module
        .imports
        .iter()
        .filter_map(|import| {
            if import.module != "env" || import.name != name {
                return None;
            }
            match import.kind {
                ImportKind::Function(function) => Some(function),
                _ => None,
            }
        })
        .collect()
}

#[test]
fn original_two_argument_loader_uses_the_staged_protocol() {
    let input = wat::parse_str(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlopen"
            (func $legacy (param i32 i32) (result i32)))
          (memory 1)
          (table (export "__indirect_function_table") 2 funcref)
          (func $initializer
            call $fork
            drop)
          (elem (i32.const 1) func $initializer)
          (func (export "open") (param i32 i32) (result i32)
            local.get 0
            local.get 1
            call $legacy))
        "#,
    )
    .expect("parse original loader ABI fixture");

    let output = instrument(&input, &Options::default()).expect("instrument");
    let module = Module::from_buffer(&output).expect("parse instrumented module");
    assert!(imported(&module, "__wasm_dlopen").is_empty());
    let prepare = imported(&module, "__wasm_dlopen_prepare");
    assert_eq!(prepare.len(), 1);
    let prepare_ty = module.types.get(module.funcs.get(prepare[0]).ty());
    assert_eq!(
        prepare_ty.params(),
        [
            walrus::ValType::I32,
            walrus::ValType::I32,
            walrus::ValType::I32,
            walrus::ValType::I32,
            walrus::ValType::I32,
        ],
        "the two-argument form must supply an empty name range and default flags",
    );
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented original loader adapter validates");
}

#[test]
fn complete_transform_has_no_reentrant_loader_import() {
    let input = wat::parse_str(
        r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlopen"
            (func $legacy (param i64 i32 i64 i32 i32) (result i32)))
          (memory i64 1)
          (table (export "__indirect_function_table") 2 funcref)
          (func $initializer
            call $fork
            drop)
          (elem (i32.const 1) func $initializer)
          (func (export "open") (param i64 i32 i64 i32 i32) (result i32)
            local.get 0
            local.get 1
            local.get 2
            local.get 3
            local.get 4
            call $legacy))
        "#,
    )
    .expect("parse memory64 fixture");

    let output = instrument(&input, &Options::default()).expect("instrument");
    let module = Module::from_buffer(&output).expect("parse instrumented module");
    assert!(imported(&module, "__wasm_dlopen").is_empty());
    assert!(!imported(&module, "__wasm_dlopen_prepare").is_empty());
    assert!(!imported(&module, "__wasm_dlopen_next").is_empty());
    assert!(!imported(&module, "__wasm_dlopen_commit").is_empty());
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented staged adapter validates");
}

#[test]
fn malformed_reserved_signature_fails_before_runtime() {
    let input = wat::parse_str(
        r#"
        (module
          (import "env" "__wasm_dlopen"
            (func (param externref) (result externref))))
        "#,
    )
    .expect("parse malformed reserved import");
    let error = instrument(&input, &Options::default())
        .expect_err("reserved loader ABI mismatch must not retain reentrant import");
    assert!(
        error
            .to_string()
            .contains("reserved env.__wasm_dlopen must have"),
        "unexpected diagnostic: {error:#}",
    );
}
