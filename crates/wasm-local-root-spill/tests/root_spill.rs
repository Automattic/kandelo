use walrus::{
    ExportItem, FunctionId, FunctionKind, GlobalId, LocalFunction, Module,
    ir::{self, Instr, InstrSeqId},
};
use wasm_local_root_spill::{Options, SpillSet, spill};

fn parse_wat(wat_src: &str) -> Vec<u8> {
    wat::parse_str(wat_src).expect("wat parse")
}

fn spill_wat(wat_src: &str) -> Vec<u8> {
    spill(&parse_wat(wat_src), &Options::default()).expect("spill")
}

fn spill_wat_with(wat_src: &str, spill_set: SpillSet) -> Vec<u8> {
    spill(
        &parse_wat(wat_src),
        &Options {
            spill_set,
            ..Options::default()
        },
    )
    .expect("spill")
}

fn validate(bytes: &[u8]) {
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(bytes)
        .expect("valid wasm");
}

fn module(bytes: &[u8]) -> Module {
    Module::from_buffer(bytes).expect("walrus parse")
}

fn func_by_name(module: &Module, name: &str) -> FunctionId {
    module
        .funcs
        .iter()
        .find(|func| func.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function `{name}` not found"))
        .id()
}

fn local_func(module: &Module, id: FunctionId) -> &LocalFunction {
    match &module.funcs.get(id).kind {
        FunctionKind::Local(local) => local,
        _ => panic!("not a local function"),
    }
}

fn stack_pointer(module: &Module) -> GlobalId {
    module
        .exports
        .iter()
        .find_map(|export| match export.item {
            ExportItem::Global(id) if export.name == "__stack_pointer" => Some(id),
            _ => None,
        })
        .expect("__stack_pointer export")
}

fn walk_all<F: FnMut(&Instr)>(func: &LocalFunction, seq: InstrSeqId, visit: &mut F) {
    for (instr, _) in &func.block(seq).instrs {
        visit(instr);
        for child in nested(instr) {
            walk_all(func, child, visit);
        }
    }
}

fn nested(instr: &Instr) -> Vec<InstrSeqId> {
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

fn count_i32_store_offsets(module: &Module, func_name: &str, offset: u64) -> usize {
    let id = func_by_name(module, func_name);
    let func = local_func(module, id);
    let mut count = 0;
    walk_all(func, func.entry_block(), &mut |instr| {
        if let Instr::Store(store) = instr {
            if matches!(store.kind, walrus::ir::StoreKind::I32 { atomic: false })
                && store.arg.offset == offset
            {
                count += 1;
            }
        }
    });
    count
}

fn count_stack_pointer_sets(module: &Module, func_name: &str) -> usize {
    let sp = stack_pointer(module);
    let id = func_by_name(module, func_name);
    let func = local_func(module, id);
    let mut count = 0;
    walk_all(func, func.entry_block(), &mut |instr| {
        if let Instr::GlobalSet(set) = instr {
            if set.global == sp {
                count += 1;
            }
        }
    });
    count
}

const BASE: &str = r#"
    (module
      (memory (export "memory") 1)
      (global $__stack_pointer (export "__stack_pointer") (mut i32) (i32.const 65536))
      FUNC)
"#;

fn fixture(func: &str) -> String {
    BASE.replace("FUNC", func)
}

#[test]
fn seeds_param_and_mirrors_set_and_tee() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32) (result i32)
          (local $x i32)
          call $alloc
          local.get $p
          local.set $x
          local.get $x
          i32.const 1
          i32.add
          local.tee $x
          return)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 0), 1);
    assert_eq!(count_i32_store_offsets(&module, "main", 4), 3);
    assert_eq!(count_stack_pointer_sets(&module, "main"), 2);
}

#[test]
fn fallthrough_result_validates_with_stack_pointer_restore() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32) (result i32)
          call $alloc
          local.get $p)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let printed = wasmprinter::print_bytes(&bytes).expect("print");
    assert!(printed.contains("global.set"));
}

#[test]
fn multi_value_return_validates() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32) (result i32 i64)
          call $alloc
          local.get $p
          i64.const 7
          return)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
}

#[test]
fn non_i32_locals_are_not_spilled() {
    let wat = fixture(
        r#"
        (func $main (export "main") (param $p i64) (result i64)
          (local $x f64)
          local.get $p)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);
    assert_eq!(count_stack_pointer_sets(&module, "main"), 0);
}

#[test]
fn leaf_functions_are_not_spilled() {
    let wat = fixture(
        r#"
        (func $main (export "main") (param $p i32) (result i32)
          (local $x i32)
          local.get $p
          local.set $x
          local.get $x)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);
    assert_eq!(count_stack_pointer_sets(&module, "main"), 0);
}

#[test]
fn rejects_missing_stack_pointer() {
    let wat = r#"
        (module
          (memory (export "memory") 1)
          (func $main (export "main") (param i32)))
    "#;
    let err = spill(&parse_wat(wat), &Options::default()).expect_err("missing sp rejected");
    assert!(format!("{err:#}").contains("__stack_pointer"));
}

#[test]
fn spills_operand_stack_i32_carryover_across_call() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32)
          local.get $p
          call $alloc
          drop)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 0), 1);
    assert_eq!(count_i32_store_offsets(&module, "main", 4), 2);
}

#[test]
fn spills_call_operand_i32_carryover_without_corrupting_call_args() {
    let wat = fixture(
        r#"
        (func $alloc (param i32) (result i32)
          local.get 0)
        (func $main (export "main") (param $p i32)
          local.get $p
          i32.const 7
          call $alloc
          drop
          drop)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 4), 2);
}

#[test]
fn spills_outer_i32_carryover_before_call_bearing_block() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32)
          local.get $p
          block
            call $alloc
          end
          drop)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 4), 2);
}

#[test]
fn diagnostic_params_only_excludes_non_arg_locals() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32) (result i32)
          (local $x i32)
          call $alloc
          local.get $p
          local.set $x
          local.get $x)
        "#,
    );
    let bytes = spill_wat_with(&wat, SpillSet::ParamsOnly);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 0), 1);
    assert_eq!(count_i32_store_offsets(&module, "main", 4), 0);
}

#[test]
fn diagnostic_params_and_operands_excludes_ordinary_locals() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32)
          (local $x i32)
          local.get $p
          local.set $x
          local.get $p
          call $alloc
          drop)
        "#,
    );
    let bytes = spill_wat_with(&wat, SpillSet::ParamsAndOperands);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_i32_store_offsets(&module, "main", 0), 1);
    assert_eq!(count_i32_store_offsets(&module, "main", 4), 2);
    assert_eq!(count_i32_store_offsets(&module, "main", 8), 0);
}

#[test]
fn restores_stack_pointer_before_branch_return() {
    let wat = fixture(
        r#"
        (func $alloc)
        (func $main (export "main") (param $p i32) (result i32)
          call $alloc
          block
            local.get $p
            br 1
          end
          i32.const 0)
        "#,
    );
    let bytes = spill_wat(&wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_stack_pointer_sets(&module, "main"), 3);
}

#[test]
fn restores_stack_pointer_before_uncaught_throw() {
    let wat = r#"
        (module
          (memory (export "memory") 1)
          (global $__stack_pointer (export "__stack_pointer") (mut i32) (i32.const 65536))
          (tag $e (param i32))
          (func $alloc)
          (func $main (export "main") (param $p i32)
            call $alloc
            local.get $p
            throw $e))
    "#;
    let bytes = spill_wat(wat);
    validate(&bytes);
    let module = module(&bytes);

    assert_eq!(count_stack_pointer_sets(&module, "main"), 2);
}
