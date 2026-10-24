use fork_instrument::streaming::*;
use wasm_encoder::{
    EntityType, GlobalType, MemoryType, RefType, TableType, TagKind, TagType, ValType,
    reencode::Reencode,
};
use wasmparser::{Parser, Payload};

fn additions() -> Vec<PlannedImport> {
    [
        ("function", EntityType::Function(0)),
        (
            "table",
            EntityType::Table(TableType {
                element_type: RefType::FUNCREF,
                minimum: 1,
                maximum: None,
                table64: false,
                shared: false,
            }),
        ),
        (
            "memory",
            EntityType::Memory(MemoryType {
                minimum: 1,
                maximum: None,
                memory64: false,
                shared: false,
                page_size_log2: None,
            }),
        ),
        (
            "global",
            EntityType::Global(GlobalType {
                val_type: ValType::I32,
                mutable: false,
                shared: false,
            }),
        ),
        (
            "tag",
            EntityType::Tag(TagType {
                kind: TagKind::Exception,
                func_type_idx: 1,
            }),
        ),
    ]
    .into_iter()
    .map(|(name, ty)| PlannedImport {
        module: "new".into(),
        name: name.into(),
        ty,
    })
    .collect()
}

const SOURCE: &str = r#"(module
  (type $value (func (result i32))) (type $void (func))
  (import "old" "value" (func $value (type $value)))
  (import "old" "table" (table 1 funcref))
  (import "old" "memory" (memory 1))
  (import "old" "global" (global $old i32))
  (import "old" "tag" (tag $oldTag))
  (table $localTable 1 funcref) (memory $localMemory 1)
  (global $localGlobal (mut i32) (i32.const 7)) (tag $localTag)
  (elem (table $localTable) (i32.const 0) func $work)
  (data (memory $localMemory) (i32.const 0) "x")
  (func $work (result i32)
    block $caught
      try_table (catch $localTag $caught) throw $localTag end
    end
    call $value global.get $localGlobal i32.add
    memory.size $localMemory i32.add table.size $localTable i32.add)
  (func $start call $work drop) (start $start)
  (export "work" (func $work)) (export "oldValue" (func $value))
  (export "table" (table $localTable)) (export "oldTable" (table 0))
  (export "memory" (memory $localMemory)) (export "oldMemory" (memory 0))
  (export "global" (global $localGlobal)) (export "oldGlobal" (global $old))
  (export "tag" (tag $localTag)) (export "oldTag" (tag $oldTag)))"#;

fn transformed(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let mut plan = FrozenImports::new(&scan, additions(), 4096).unwrap();
    assert_eq!(plan.len(), 5);
    assert_eq!(plan.index(0), Some(scan.imported_functions));
    assert_eq!(plan.helper_function_base(), scan.functions.len() as u32 + 1);
    let mut output = Vec::new();
    emit_remapped(&scan, &mut plan, &mut output, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn frozen_imports_preserve_import_prefixes_and_shift_every_defined_space() {
    let input = wat::parse_str(SOURCE).unwrap();
    let output = transformed(&input);
    assert_eq!(output, transformed(&input));
    let scan = scan(&output).unwrap();
    for (name, kind, index) in &scan.exports {
        let expected = if name.starts_with("old") { 0 } else { 2 };
        assert_eq!(*index, expected, "{name}: {kind:?}");
    }
    assert_eq!(scan.start, Some(3));
    assert_eq!(scan.functions[2].name.as_deref(), Some("work"));
    assert_eq!(scan.elements[0].items, [ValueProof::Function(2)]);
    assert_eq!(scan.elements[0].active, Some((2, Some(0))));
    let body = scan.body_provider(Default::default()).load(2).unwrap();
    use wasmparser::Operator;
    assert!(
        body.instructions
            .iter()
            .any(|i| matches!(i.operation, Operator::Call { function_index: 0 }))
    );
    assert!(
        body.instructions
            .iter()
            .any(|i| matches!(i.operation, Operator::GlobalGet { global_index: 2 }))
    );
    assert!(
        body.instructions
            .iter()
            .any(|i| matches!(i.operation, Operator::MemorySize { mem: 2 }))
    );
    assert!(
        body.instructions
            .iter()
            .any(|i| matches!(i.operation, Operator::TableSize { table: 2 }))
    );
    assert!(
        body.instructions
            .iter()
            .any(|i| matches!(i.operation, Operator::Throw { tag_index: 2 }))
    );
    assert_eq!(body.regions[2].handlers[0].tag, Some(2));
    let mut active_memory = None;
    for payload in Parser::new(0).parse_all(&output) {
        if let Payload::DataSection(section) = payload.unwrap() {
            for segment in section {
                if let wasmparser::DataKind::Active { memory_index, .. } = segment.unwrap().kind {
                    active_memory = Some(memory_index);
                }
            }
        }
    }
    assert_eq!(active_memory, Some(2));
}

#[test]
fn frozen_imports_insert_absent_sections_after_leading_custom_metadata() {
    let original = wat::parse_str("(module (memory 1))").unwrap();
    use wasm_encoder::Encode;
    let mut input = original[..8].to_vec();
    input.push(0);
    wasm_encoder::CustomSection {
        name: "dylink.0".into(),
        data: (&[][..]).into(),
    }
    .encode(&mut input);
    input.extend_from_slice(&original[8..]);
    let scan = scan(&input).unwrap();
    let mut imports = FrozenImports::new(&scan, vec![additions().remove(2)], 1024).unwrap();
    let mut output = Vec::new();
    emit_remapped(&scan, &mut imports, &mut output, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let mut sections = Vec::new();
    for payload in Parser::new(0).parse_all(&output) {
        match payload.unwrap() {
            Payload::CustomSection(_) => sections.push(0),
            Payload::ImportSection(_) => sections.push(2),
            Payload::MemorySection(_) => sections.push(5),
            _ => {}
        }
    }
    assert_eq!(sections, [0, 2, 5]);
}

#[test]
fn frozen_imports_reject_wrong_original_input_and_invalid_indices() {
    let input = wat::parse_str(SOURCE).unwrap();
    let scan = scan(&input).unwrap();
    assert!(FrozenImports::new(&scan, additions(), 1).is_err());
    let mut imports = FrozenImports::new(&scan, additions(), 4096).unwrap();
    assert!(imports.function_index(999).is_err());
    assert!(imports.table_index(999).is_err());
    assert!(imports.memory_index(999).is_err());
    assert!(imports.global_index(999).is_err());
    assert!(imports.tag_index(999).is_err());
    let other = wat::parse_str(SOURCE.replace("i32.const 7", "i32.const 8")).unwrap();
    let other_scan = fork_instrument::streaming::scan(&other).unwrap();
    let mut output = Vec::new();
    let error =
        emit_remapped(&other_scan, &mut imports, &mut output, Default::default()).unwrap_err();
    assert!(error.to_string().contains("different original module"));
    assert!(output.is_empty());
}

#[test]
fn frozen_function_imports_execute_with_the_original_export_and_start_indices() {
    let input = wat::parse_str(
        r#"(module
      (type $t (func (result i32))) (type (func))
      (import "old" "value" (func $old (type $t)))
      (global $state (mut i32) (i32.const 0))
      (func $work (export "work") (result i32) call $old global.get $state i32.add)
      (func $start i32.const 7 global.set $state) (start $start))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut plan = FrozenImports::new(&scan, vec![additions().remove(0)], 1024).unwrap();
    let mut bytes = Vec::new();
    emit_remapped(&scan, &mut plan, &mut bytes, Default::default()).unwrap();
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), bytes).unwrap();
    let result=std::process::Command::new("node").arg("-e").arg(
      "const fs=require('fs'); const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));const i=new WebAssembly.Instance(m,{old:{value:()=>35},new:{function:()=>1000}});if(i.exports.work()!==42)process.exit(1);"
    ).arg(file.path()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn frozen_imports_and_helpers_insert_all_missing_sections_in_canonical_order() {
    struct Runtime {
        imports: FrozenImports,
        declarations: FrozenDeclarations,
    }
    impl Reencode for Runtime {
        type Error = std::convert::Infallible;
    }
    impl FunctionTransform for Runtime {
        fn imports(&self) -> Option<&FrozenImports> {
            Some(&self.imports)
        }
        fn declarations(&self) -> Option<&FrozenDeclarations> {
            Some(&self.declarations)
        }
        fn emit_helper(&mut self, _: u32, _: usize) -> anyhow::Result<wasm_encoder::Function> {
            let mut body = wasm_encoder::Function::new([]);
            body.instruction(&wasm_encoder::Instruction::Call(
                self.imports.index(0).unwrap(),
            ));
            body.instruction(&wasm_encoder::Instruction::End);
            Ok(body)
        }
    }
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let imports = FrozenImports::new(&scan, vec![additions().remove(0)], 1024).unwrap();
    assert_eq!(imports.helper_function_base(), 1);
    let declarations = FrozenDeclarations::new(
        vec![wasm_encoder::FuncType::new([], [ValType::I32])],
        vec![0],
        1024,
    )
    .unwrap();
    let mut bytes = Vec::new();
    let report = emit_remapped(
        &scan,
        &mut Runtime {
            imports,
            declarations,
        },
        &mut bytes,
        Default::default(),
    )
    .unwrap();
    assert_eq!(report.functions, 0);
    assert_eq!(report.helper_functions, 1);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&bytes)
        .unwrap();
    let sections: Vec<_> = Parser::new(0)
        .parse_all(&bytes)
        .filter_map(|p| match p.unwrap() {
            Payload::TypeSection(_) => Some(1),
            Payload::ImportSection(_) => Some(2),
            Payload::FunctionSection(_) => Some(3),
            Payload::CodeSectionStart { .. } => Some(10),
            _ => None,
        })
        .collect();
    assert_eq!(sections, [1, 2, 3, 10]);
}
