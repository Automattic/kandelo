use fork_instrument::streaming::*;
use wasm_encoder::{
    EntityType, ExportKind, GlobalType, MemoryType, RefType, TableType, ValType,
    reencode::{Error, Reencode},
};

struct Bootstrap {
    imports: FrozenImports,
    plan: FrozenModuleBootstrap,
    module: FrozenModuleDeclarations,
}
macro_rules! remap {
    ($name:ident) => {
        fn $name(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            self.imports.$name(source)
        }
    };
}
impl Reencode for Bootstrap {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(memory_index);
    remap!(table_index);
    remap!(global_index);
    remap!(tag_index);
}
impl FunctionTransform for Bootstrap {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(self.plan.declarations())
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn defer_module_initializers(&self) -> bool {
        true
    }
    fn emit_helper(
        &mut self,
        ordinal: u32,
        limit: usize,
    ) -> anyhow::Result<wasm_encoder::Function> {
        self.plan.emit_helper(ordinal, limit)
    }
}
fn emit(input: &[u8]) -> Vec<u8> {
    emit_with_limits(input, Default::default())
}
fn emit_with_limits(input: &[u8], limits: EmitLimits) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let plan = ModuleBootstrapPlan::discover(&scan, Default::default()).unwrap();
    let extra_imports = vec![
        // Shift every local entity index space exercised by the fixture.
        PlannedImport {
            module: "private".into(),
            name: "function".into(),
            ty: EntityType::Function(scan.types.as_ref().core_type_count_in_module()),
        },
        PlannedImport {
            module: "private".into(),
            name: "global".into(),
            ty: EntityType::Global(GlobalType {
                val_type: ValType::I32,
                mutable: false,
                shared: false,
            }),
        },
        PlannedImport {
            module: "private".into(),
            name: "table".into(),
            ty: EntityType::Table(TableType {
                element_type: RefType::FUNCREF,
                minimum: 1,
                maximum: None,
                table64: false,
                shared: false,
            }),
        },
        PlannedImport {
            module: "private".into(),
            name: "memory".into(),
            ty: EntityType::Memory(MemoryType {
                minimum: 1,
                maximum: None,
                memory64: false,
                shared: false,
                page_size_log2: None,
            }),
        },
    ];
    let mut imports = FrozenImports::new(&scan, extra_imports, 1 << 20).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, Some(&imports), 1 << 20).unwrap();
    let first = imports.helper_function_base();
    let plan = plan
        .freeze(
            &scan,
            Some(&imports.clone()),
            &mut imports,
            &mut module,
            scan.types.as_ref().core_type_count_in_module(),
            first,
        )
        .unwrap();
    assert_eq!(
        plan.initially_dropped_data().len(),
        scan.data_segments as usize
    );
    assert_eq!(plan.initially_dropped_elements().len(), scan.elements.len());
    module
        .export("restore_baseline", ExportKind::Func, plan.restore_baseline)
        .unwrap();
    let mut transform = Bootstrap {
        imports,
        plan,
        module: module.freeze(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, limits).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn parent_thread_and_fork_bootstrap_preserve_initialization_ownership() {
    for wide in [false, true] {
        let source = include_str!("fixtures/streaming_bootstrap.wat")
            .replace("@WIDTH@", if wide { "i64" } else { "" })
            .replace("@INDEX@", if wide { "i64" } else { "i32" });
        let input = wat::parse_str(source).unwrap();
        let output = emit(&input);
        assert_eq!(emit(&input), output);
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("original.wasm"), &input).unwrap();
        std::fs::write(directory.path().join("native.wasm"), output).unwrap();
        std::fs::write(directory.path().join("oracle.wasm"), oracle(&input)).unwrap();
        let script = directory.path().join("test.cjs");
        std::fs::write(&script, include_str!("fixtures/streaming_bootstrap.cjs")).unwrap();
        let result = std::process::Command::new("node")
            .arg(script)
            .arg(if wide { "1" } else { "0" })
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "memory64/table64={wide}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

fn oracle(input: &[u8]) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
    let plan = fork_instrument::module_state::plan(&mut module);
    let runtime = fork_instrument::runtime::inject_linked_runtime(&mut module);
    fork_instrument::module_state::inject(&mut module, &runtime, plan).unwrap();
    module.emit_wasm()
}

#[test]
fn deferred_data_count_is_inserted_before_original_or_helper_only_code() {
    for with_function in [false, true] {
        let input = wat::parse_str(format!(
            "(module (memory (export \"memory\") 1)
            (data (i32.const 0) \"x\") {})",
            if with_function { "(func nop)" } else { "" }
        ))
        .unwrap();
        assert!(
            !wasmparser::Parser::new(0)
                .parse_all(&input)
                .any(|payload| matches!(
                    payload.unwrap(),
                    wasmparser::Payload::DataCountSection { .. }
                ))
        );
        let output = emit(&input);
        let counts: Vec<_> = wasmparser::Parser::new(0)
            .parse_all(&output)
            .filter_map(|payload| {
                if let wasmparser::Payload::DataCountSection { count, .. } = payload.unwrap() {
                    Some(count)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(counts, [1]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), output).unwrap();
        let result = std::process::Command::new("node")
            .args([
                "-e",
                r#"
          const fs = require('fs'), assert = require('assert/strict');
          const module = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
          const e = new WebAssembly.Instance(module, { private: { function() {}, global: 0,
            table: new WebAssembly.Table({ element: 'anyfunc', initial: 1 }),
            memory: new WebAssembly.Memory({ initial: 1 }) } }).exports;
          assert.equal(new Uint8Array(e.memory.buffer)[0], 0);
          e.wpk_fork_module_bootstrap();
          assert.equal(new Uint8Array(e.memory.buffer)[0], 120);
        "#,
            ])
            .arg(file.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn converting_active_data_does_not_apply_the_metadata_limit_to_payload_bytes() {
    let input = wat::parse_str(format!(
        "(module (memory 1) (data (i32.const 0) \"{}\"))",
        "x".repeat(8192)
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    ModuleBootstrapPlan::discover(
        &scan,
        BootstrapLimits {
            metadata_bytes: 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let output = emit_with_limits(
        &input,
        EmitLimits {
            max_function_bytes: 1024,
            max_metadata_section_bytes: 4096,
        },
    );
    let mut segments = 0;
    for payload in wasmparser::Parser::new(0).parse_all(&output) {
        if let wasmparser::Payload::DataSection(section) = payload.unwrap() {
            for data in section {
                let data = data.unwrap();
                assert!(matches!(data.kind, wasmparser::DataKind::Passive));
                assert_eq!(data.data, vec![b'x'; 8192]);
                segments += 1;
            }
        }
    }
    assert_eq!(segments, 1);
}
