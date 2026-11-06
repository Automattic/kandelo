use fork_instrument::streaming::*;
use wasm_encoder::{
    ExportKind, Function,
    reencode::{Error, Reencode},
};
#[path = "streaming_roots.rs"]
mod roots;

struct Module {
    runtime: NativeRuntime,
    roots: roots::Components,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}
macro_rules! remap {
    ($name:ident) => {
        fn $name(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            self.runtime.$name(source)
        }
    };
}
impl Reencode for Module {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(table_index);
    remap!(global_index);
    remap!(memory_index);
    remap!(tag_index);
}
impl FunctionTransform for Module {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn defer_module_initializers(&self) -> bool {
        true
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < 7 {
            self.runtime.emit_control(ordinal, limit)
        } else {
            self.roots.emit_helper(ordinal - 7, limit)
        }
    }
}
pub fn emit(input: &[u8], wide: bool) -> Vec<u8> {
    let scan = scan(input).unwrap();
    assert_eq!(scan.types.as_ref().memory_count(), 0);
    let mut inputs = RuntimeInputs::default();
    if wide {
        inputs.imports.push(PlannedImport {
            module: "env".into(),
            name: "memory".into(),
            ty: wasm_encoder::EntityType::Memory(wasm_encoder::MemoryType {
                minimum: 0,
                maximum: Some(65536),
                memory64: true,
                shared: true,
                page_size_log2: None,
            }),
        });
        inputs.staging_memory = Some(0);
    }
    let imports = RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    assert_eq!(
        runtime.pointer_type(),
        if wide {
            wasm_encoder::ValType::I64
        } else {
            wasm_encoder::ValType::I32
        }
    );
    let memory = runtime.process_memory().unwrap();
    let frozen = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&frozen),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    module.export("memory", ExportKind::Memory, memory).unwrap();
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let roots = roots::Components::plan(
        &scan,
        &mut runtime,
        &imports,
        &mut module,
        first_type,
        frozen.helper_function_base() + 7,
    );
    let declarations = FrozenDeclarations::concatenate(
        &[runtime.function_declarations(), &roots.declarations],
        1 << 20,
    )
    .unwrap();
    let mut transform = Module {
        runtime,
        roots,
        declarations,
        module: module.freeze(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}
