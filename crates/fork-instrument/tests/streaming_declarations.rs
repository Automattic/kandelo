use fork_instrument::streaming::*;
use wasm_encoder::{
    BlockType, Catch, ConstExpr, EntityType, ExportKind, FuncType, Function, GlobalType,
    Instruction, MemoryType, RefType, TableType, TagKind, TagType, ValType,
    reencode::{Error, Reencode},
};

struct Runtime {
    imports: FrozenImports,
    functions: FrozenDeclarations,
    module: FrozenModuleDeclarations,
    global: u32,
    table: u32,
    memory: u32,
    tag: u32,
}
impl Reencode for Runtime {
    type Error = ImportIndexError;
    fn function_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.function_index(i)
    }
    fn table_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.table_index(i)
    }
    fn memory_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.memory_index(i)
    }
    fn global_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.global_index(i)
    }
    fn tag_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.tag_index(i)
    }
}
impl FunctionTransform for Runtime {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.functions)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn emit_helper(&mut self, _: u32, _: usize) -> anyhow::Result<Function> {
        let mut f = Function::new([]);
        f.instruction(&Instruction::Block(BlockType::Empty));
        f.instruction(&Instruction::TryTable(
            BlockType::Empty,
            vec![Catch::One {
                tag: self.tag,
                label: 0,
            }]
            .into(),
        ));
        f.instruction(&Instruction::Throw(self.tag));
        f.instruction(&Instruction::End);
        f.instruction(&Instruction::End);
        f.instruction(&Instruction::Call(self.imports.index(0).unwrap()));
        f.instruction(&Instruction::GlobalGet(self.global));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::MemorySize(self.memory));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::TableSize(self.table));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::End);
        Ok(f)
    }
}

fn plan(scan: &Scan<'_>) -> Runtime {
    let ty = scan.types.as_ref().core_type_count_in_module();
    let imports = FrozenImports::new(
        scan,
        vec![PlannedImport {
            module: "h".into(),
            name: "value".into(),
            ty: EntityType::Function(ty),
        }],
        8192,
    )
    .unwrap();
    let helper = imports.helper_function_base();
    let functions = FrozenDeclarations::new(
        vec![FuncType::new([], [ValType::I32]), FuncType::new([], [])],
        vec![ty],
        8192,
    )
    .unwrap();
    let mut builder = ModuleDeclarationBuilder::new(scan, Some(&imports), 8192).unwrap();
    let global = builder
        .global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            ConstExpr::i32_const(42),
        )
        .unwrap();
    let table = builder
        .table(
            TableType {
                element_type: RefType::FUNCREF,
                minimum: 1,
                maximum: None,
                table64: false,
                shared: false,
            },
            None,
        )
        .unwrap();
    let memory = builder
        .memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        })
        .unwrap();
    let tag = builder
        .tag(TagType {
            kind: TagKind::Exception,
            func_type_idx: ty + 1,
        })
        .unwrap();
    builder
        .element(
            ElementMode::Active {
                table,
                offset: ConstExpr::i32_const(0),
            },
            ElementValues::Functions(vec![helper]),
        )
        .unwrap();
    builder
        .element(
            ElementMode::Passive,
            ElementValues::Expressions(RefType::FUNCREF, vec![ConstExpr::ref_func(helper)]),
        )
        .unwrap();
    builder
        .element(
            ElementMode::Declared,
            ElementValues::Functions(vec![helper]),
        )
        .unwrap();
    builder.export("runtime", ExportKind::Func, helper).unwrap();
    builder
        .export("runtime_global", ExportKind::Global, global)
        .unwrap();
    builder
        .export("runtime_table", ExportKind::Table, table)
        .unwrap();
    builder
        .export("runtime_memory", ExportKind::Memory, memory)
        .unwrap();
    builder.export("runtime_tag", ExportKind::Tag, tag).unwrap();
    Runtime {
        imports,
        functions,
        module: builder.freeze(),
        global,
        table,
        memory,
        tag,
    }
}

fn emit(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let mut runtime = plan(&scan);
    let mut output = Vec::new();
    let report = emit_remapped(&scan, &mut runtime, &mut output, Default::default()).unwrap();
    assert_eq!(report.helper_functions, 1);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn runtime_declarations_insert_missing_sections_and_append_existing_ones() {
    for text in [
        "(module)",
        r#"(module
      (memory 1) (table 1 funcref) (global $g (mut i32) (i32.const 9)) (tag)
      (func $old (export "old") (result i32) global.get $g)
      (func $start) (start $start)
      (elem (i32.const 0) $old) (data (i32.const 0) "x"))"#,
    ] {
        let input = wat::parse_str(text).unwrap();
        let output = emit(&input);
        assert_eq!(emit(&input), output);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), output).unwrap();
        let result=std::process::Command::new("node").arg("-e").arg(
          "const fs=require('fs'); const m=new WebAssembly.Module(fs.readFileSync(process.argv[1])); const i=new WebAssembly.Instance(m,{h:{value:()=>13}}); if(i.exports.runtime()!==57 || i.exports.runtime_table.get(0)!==i.exports.runtime || i.exports.runtime_global.value!==42)process.exit(1);if(i.exports.old&&i.exports.old()!==9)process.exit(2);"
        ).arg(file.path()).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn declarations_follow_imports_and_reject_different_layouts_before_writing() {
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let mut runtime = plan(&scan);
    let mut replacement = vec![PlannedImport {
        module: "h".into(),
        name: "value".into(),
        ty: EntityType::Function(0),
    }];
    replacement.push(PlannedImport {
        module: "h".into(),
        name: "global".into(),
        ty: EntityType::Global(GlobalType {
            val_type: ValType::I32,
            mutable: false,
            shared: false,
        }),
    });
    runtime.imports = FrozenImports::new(&scan, replacement, 8192).unwrap();
    let mut bytes = Vec::new();
    assert!(
        emit_remapped(&scan, &mut runtime, &mut bytes, Default::default())
            .unwrap_err()
            .to_string()
            .contains("different frozen import layout")
    );
    assert!(bytes.is_empty());
    let mut builder = ModuleDeclarationBuilder::new(&scan, Some(&runtime.imports), 8192).unwrap();
    assert_eq!(
        builder
            .global(
                GlobalType {
                    val_type: ValType::I32,
                    mutable: true,
                    shared: false
                },
                ConstExpr::i32_const(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn declaration_budgets_and_duplicate_exports_fail_without_consuming_indices() {
    let input = wat::parse_str(r#"(module (global (export "taken") i32 (i32.const 0)))"#).unwrap();
    let scan = scan(&input).unwrap();
    let mut builder = ModuleDeclarationBuilder::new(&scan, None, 512).unwrap();
    assert!(builder.export("taken", ExportKind::Global, 0).is_err());
    builder.export("fresh", ExportKind::Global, 0).unwrap();
    assert!(builder.export("fresh", ExportKind::Global, 0).is_err());
    assert!(
        builder
            .element(
                ElementMode::Declared,
                ElementValues::Functions(vec![0; 100])
            )
            .is_err()
    );
    assert_eq!(
        builder
            .global(
                GlobalType {
                    val_type: ValType::I32,
                    mutable: false,
                    shared: false
                },
                ConstExpr::i32_const(1)
            )
            .unwrap(),
        1
    );
    assert_eq!(builder.freeze().global_count(), 1);
}
