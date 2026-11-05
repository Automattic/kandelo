//! Exercise composed native catalogs and original-body state rewrites.
use fork_instrument::streaming::*;
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{
    ConstExpr, EntityType, ExportKind, FuncType, Function, GlobalType, ValType,
    reencode::{Error, Reencode},
};

struct Composed {
    runtime: NativeRuntime,
    state: FrozenStateRewrites,
    functions: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}
impl Reencode for Composed {
    type Error = ImportIndexError;
    fn function_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.function_index(i)
    }
    fn table_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.table_index(i)
    }
    fn memory_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.memory_index(i)
    }
    fn global_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.global_index(i)
    }
    fn tag_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.tag_index(i)
    }
}
impl FunctionTransform for Composed {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.functions)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, body: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        self.state.emit_function(body, &mut self.runtime, limit)
    }
    fn emit_helper(&mut self, helper: u32, limit: usize) -> anyhow::Result<Function> {
        if helper < 7 {
            self.runtime.emit_control(helper, limit)
        } else {
            self.state.emit_helper(helper - 7, limit)
        }
    }
}

fn emit(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let base = scan.types.as_ref().core_type_count_in_module();
    let prefix = RuntimeInputs {
        types: vec![
            FuncType::new([], []),
            FuncType::new([ValType::I64, ValType::I64], []),
        ],
        imports: [
            ("begin", base),
            ("mark", base + 1),
            ("grow", base + 1),
            ("guard", base),
        ]
        .into_iter()
        .map(|(name, ty)| PlannedImport {
            module: "h".into(),
            name: name.into(),
            ty: EntityType::Function(ty),
        })
        .collect(),
        ..Default::default()
    };
    let mut runtime = NativeRuntime::plan(&scan, prefix, 1 << 20).unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(runtime.imports_plan()),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let bits = module
        .global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            ConstExpr::i32_const(0),
        )
        .unwrap();
    module.export("bits", ExportKind::Global, bits).unwrap();
    let hook = |i| runtime.imports_plan().index(i).unwrap();
    let hooks = StateHooks {
        mutation_begin: hook(0),
        reconcile: hook(3),
        tables: BTreeMap::from([(
            0,
            TableMarkers {
                mark: hook(1),
                grow: hook(2),
            },
        )]),
        data: BTreeMap::from([(
            0,
            DropBit {
                global: bits,
                mask: 1,
            },
        )]),
        elements: BTreeMap::from([(
            0,
            DropBit {
                global: bits,
                mask: 2,
            },
        )]),
    };
    let first_type = base + runtime.function_declarations().type_count();
    let first_function = runtime.imports_plan().helper_function_base() + 7;
    let state = StateRewrites::discover(&scan, BTreeSet::from([0]), None, 1024)
        .unwrap()
        .freeze(
            &scan,
            &mut runtime,
            first_type,
            first_function,
            hooks,
            1 << 20,
        )
        .unwrap();
    let functions = FrozenDeclarations::concatenate(
        &[runtime.function_declarations(), state.declarations()],
        1 << 20,
    )
    .unwrap();
    let mut output = Vec::new();
    emit_remapped(
        &scan,
        &mut Composed {
            runtime,
            state,
            functions,
            module: module.freeze(),
        },
        &mut output,
        Default::default(),
    )
    .unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn native_runtime_and_state_helpers_execute_together_outside_the_fork_closure() {
    let input = wat::parse_str(
        r#"(module
      (memory 1) (table 1 funcref) (elem $e func $f) (data $d "a")
      (func $f (result i32) i32.const 9)
      (func (export "work") i32.const 0 ref.func $f table.set 0 data.drop $d elem.drop $e)
      (func (export "read") (result i32) i32.const 0 call_indirect (type 0)))"#,
    )
    .unwrap();
    let bytes = emit(&input);
    assert_eq!(emit(&input), bytes);
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), bytes).unwrap();
    let result=std::process::Command::new("node").arg("-e").arg(r#"
      const fs=require('fs'),assert=require('node:assert/strict'),events=[];
      const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
      const imports={h:{begin:()=>events.push(['begin']),mark:(a,b)=>events.push(['mark',Number(a),Number(b)]),grow:()=>{},guard:()=>events.push(['guard'])}};
      for(const x of WebAssembly.Module.imports(m)){
        const s=imports[x.module]??={};if(x.name in s)continue;
        s[x.name]=x.kind==='function'?()=>0:x.kind==='table'?new WebAssembly.Table({element:'anyfunc',initial:1}):x.kind==='tag'?new WebAssembly.Tag({parameters:[]}):null;
      }
      const e=new WebAssembly.Instance(m,imports).exports;
      e.work();assert.equal(e.bits.value,3);assert.equal(e.read(),9);assert.deepEqual(events,[['begin'],['mark',0,1],['guard']]);assert.equal(e.wpk_fork_state(),0);
    "#).arg(file.path()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
