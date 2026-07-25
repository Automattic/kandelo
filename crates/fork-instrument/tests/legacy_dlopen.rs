//! The ABI 43 transform must not leave the historical monolithic loader
//! callback beneath a forkable side-module initializer.

use fork_instrument::{Options, instrument, legacy_dlopen};
use walrus::{
    ElementItems, ExportItem, FunctionId, FunctionKind, ImportKind, LocalFunction, Module,
    ir::{self, Instr, InstrSeqId},
};

fn parse(wat: &str) -> Module {
    let bytes = wat::parse_str(wat).expect("parse legacy dlopen fixture");
    Module::from_buffer(&bytes).expect("parse fixture with walrus")
}

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

fn exported_function(module: &Module, name: &str) -> FunctionId {
    match module
        .exports
        .iter()
        .find(|export| export.name == name)
        .unwrap_or_else(|| panic!("missing export {name}"))
        .item
    {
        ExportItem::Function(function) => function,
        other => panic!("{name} is not a function: {other:?}"),
    }
}

fn local(module: &Module, function: FunctionId) -> &LocalFunction {
    match &module.funcs.get(function).kind {
        FunctionKind::Local(local) => local,
        other => panic!("expected local function, got {other:?}"),
    }
}

fn children(instruction: &Instr) -> Vec<InstrSeqId> {
    match instruction {
        Instr::Block(ir::Block { seq }) | Instr::Loop(ir::Loop { seq }) => vec![*seq],
        Instr::IfElse(ir::IfElse {
            consequent,
            alternative,
        }) => vec![*consequent, *alternative],
        Instr::TryTable(ir::TryTable { seq, .. }) => vec![*seq],
        Instr::Try(try_) => {
            let mut result = vec![try_.seq];
            for catch in &try_.catches {
                match catch {
                    ir::LegacyCatch::Catch { handler, .. }
                    | ir::LegacyCatch::CatchAll { handler } => result.push(*handler),
                    ir::LegacyCatch::Delegate { .. } => {}
                }
            }
            result
        }
        _ => Vec::new(),
    }
}

fn walk(local: &LocalFunction, seq: InstrSeqId, visit: &mut impl FnMut(&Instr)) {
    for (instruction, _) in &local.block(seq).instrs {
        visit(instruction);
        for child in children(instruction) {
            walk(local, child, visit);
        }
    }
}

#[test]
fn legacy_import_identity_becomes_a_staged_local_adapter() {
    let mut module = parse(
        r#"
        (module
          (type $legacy (func (param i32 i32 i32 i32) (result i32)))
          (import "env" "__wasm_dlopen" (func $legacy (type $legacy)))
          (memory 1)
          (table (export "__indirect_function_table") 2 funcref)
          (elem (i32.const 1) func $legacy)
          (func $checkpoint (export "__wasm_posix_signal_checkpoint"))
          (export "legacy_alias" (func $legacy)))
        "#,
    );
    let legacy = exported_function(&module, "legacy_alias");

    assert_eq!(legacy_dlopen::lower(&mut module).expect("lower"), 1);
    assert!(imported(&module, "__wasm_dlopen").is_empty());
    assert_eq!(exported_function(&module, "legacy_alias"), legacy);
    assert!(matches!(
        module.funcs.get(legacy).kind,
        FunctionKind::Local(_)
    ));
    assert!(imported(&module, "__wasm_dlopen_main").len() == 1);
    assert!(imported(&module, "__wasm_dlopen_prepare").len() == 1);
    assert!(imported(&module, "__wasm_dlopen_next").len() == 1);
    assert!(imported(&module, "__wasm_dlopen_commit").len() == 1);

    let element_kept_identity = module.elements.iter().any(|element| {
        matches!(
            &element.items,
            ElementItems::Functions(functions) if functions.contains(&legacy)
        )
    });
    assert!(
        element_kept_identity,
        "table aliases must name the local adapter without a partial rewrite",
    );

    let adapter = local(&module, legacy);
    let mut tail_driver = None;
    walk(adapter, adapter.entry_block(), &mut |instruction| {
        if let Instr::ReturnCall(call) = instruction {
            tail_driver = Some(call.func);
        }
    });
    let driver = tail_driver.expect("adapter tail-calls staged driver");
    assert_eq!(
        local(&module, driver).args.len(),
        1,
        "only the transaction token is a driver parameter",
    );
    let checkpoint = exported_function(&module, "__wasm_posix_signal_checkpoint");
    let mut checkpoints = 0;
    walk(local(&module, driver), local(&module, driver).entry_block(), &mut |instruction| {
        if matches!(instruction, Instr::Call(call) if call.func == checkpoint) {
            checkpoints += 1;
        }
    });
    assert_eq!(
        checkpoints, 3,
        "prepare, next, and commit each hand deferred signals back to libc",
    );

    let bytes = module.emit_wasm();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&bytes)
        .expect("lowered module validates");
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
            .contains("reserved env.__wasm_dlopen import has signature"),
        "unexpected diagnostic: {error:#}",
    );
}
