use fork_instrument::streaming::*;
use wasm_encoder::{
    Function, Instruction,
    reencode::{Error, Reencode},
};

struct Adapters {
    imports: FrozenImports,
    declarations: FrozenDeclarations,
}
impl Reencode for Adapters {
    type Error = ImportIndexError;
    fn function_index(&mut self, index: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.function_index(index)
    }
}
impl FunctionTransform for Adapters {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn emit_helper(&mut self, ordinal: u32, _: usize) -> anyhow::Result<Function> {
        let mut function = Function::new([]);
        function.instruction(&Instruction::I32Const(if ordinal == 0 { 7 } else { 35 }));
        if ordinal == 0 {
            function.instruction(&Instruction::GlobalSet(0));
        }
        function.instruction(&Instruction::End);
        Ok(function)
    }
}
const INPUT: &str = r#"(module
  (type $void (func)) (type $value (func (result i32)))
  (import "old" "boot" (func $boot (type $void)))
  (import "old" "keep" (func $keep (type $value)))
  (import "old" "value" (func $value (type $value)))
  (global $state (export "state") (mut i32) (i32.const 0))
  (table (export "table") 3 funcref)
  (elem (i32.const 0) func $boot $keep $value)
  (global (export "boot_ref") funcref (ref.func $boot))
  (global (export "value_ref") funcref (ref.func $value))
  (func (export "work") (result i32) call $value call $keep i32.add global.get $state i32.add)
  (start $boot)
  (export "boot" (func $boot)) (export "keep" (func $keep)) (export "value" (func $value)))"#;
fn redirects() -> Vec<FunctionAdapter> {
    vec![
        FunctionAdapter {
            source_function: 0,
            helper_ordinal: 0,
        },
        FunctionAdapter {
            source_function: 2,
            helper_ordinal: 1,
        },
    ]
}

#[test]
fn removed_imports_preserve_start_exports_elements_and_constant_function_references() {
    let input = wat::parse_str(INPUT).unwrap();
    let scan = scan(&input).unwrap();
    for count in 0..5 {
        let additions = (0..count)
            .map(|index| PlannedImport {
                module: "new".into(),
                name: format!("extra{index}"),
                ty: wasm_encoder::EntityType::Function(1),
            })
            .collect();
        let mut imports =
            FrozenImports::with_function_adapters(&scan, additions, redirects(), 1 << 20).unwrap();
        assert_eq!(imports.helper_function_base(), 2 + count);
        for (source, expected) in [(0, 2 + count), (1, 0), (2, 3 + count), (3, 1 + count)] {
            assert_eq!(imports.function_index(source).unwrap(), expected);
        }
        for ordinal in 0..count {
            assert_eq!(imports.index(ordinal), Some(ordinal + 1));
        }
        let mut transform = Adapters {
            imports,
            declarations: FrozenDeclarations::new(vec![], vec![0, 1], 1 << 20).unwrap(),
        };
        let mut first = Vec::new();
        emit_remapped(&scan, &mut transform, &mut first, Default::default()).unwrap();
        let mut second = Vec::new();
        emit_remapped(&scan, &mut transform, &mut second, Default::default()).unwrap();
        assert_eq!(first, second);
        wasmparser::Validator::new_with_features(features())
            .validate_all(&first)
            .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), first).unwrap();
        let result = std::process::Command::new("node").arg("-e").arg(r#"
          const assert = require('node:assert/strict');
          const module = new WebAssembly.Module(require('fs').readFileSync(process.argv[1]));
          const instance = new WebAssembly.Instance(module, {old: {keep: () => 0}, new: Object.fromEntries(Array.from({length:4}, (_,i)=>['extra'+i,()=>1000]))});
          const x = instance.exports;
          assert.equal(x.state.value, 7); assert.equal(x.work(), 42);
          assert.equal(x.table.get(0), x.boot); assert.equal(x.table.get(1), x.keep); assert.equal(x.table.get(2), x.value);
          assert.equal(x.boot_ref.value, x.boot); assert.equal(x.value_ref.value, x.value);
          assert(!WebAssembly.Module.imports(module).some(imported => ['boot','value'].includes(imported.name)));
        "#).arg(file.path()).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn adapter_validation_rejects_missing_helpers_wrong_types_order_and_limits_before_writing() {
    let input = wat::parse_str(INPUT).unwrap();
    let scan = scan(&input).unwrap();
    for adapters in [
        vec![FunctionAdapter {
            source_function: 3,
            helper_ordinal: 0,
        }],
        vec![redirects()[1], redirects()[0]],
        vec![redirects()[0], redirects()[0]],
    ] {
        assert!(FrozenImports::with_function_adapters(&scan, vec![], adapters, 1 << 20).is_err());
    }
    assert!(FrozenImports::with_function_adapters(&scan, vec![], redirects(), 0).is_err());
    for functions in [vec![], vec![1, 1], vec![0]] {
        let imports =
            FrozenImports::with_function_adapters(&scan, vec![], redirects(), 1 << 20).unwrap();
        let mut transform = Adapters {
            imports,
            declarations: FrozenDeclarations::new(vec![], functions, 1 << 20).unwrap(),
        };
        let mut bytes = Vec::new();
        assert!(emit_remapped(&scan, &mut transform, &mut bytes, Default::default()).is_err());
        assert!(bytes.is_empty());
    }
    let mut imports = FrozenImports::with_function_adapters(
        &scan,
        vec![],
        vec![FunctionAdapter {
            source_function: 0,
            helper_ordinal: u32::MAX,
        }],
        1 << 20,
    )
    .unwrap();
    assert!(imports.function_index(0).is_err());
}
