//! Full native GC and exception providers, composed with frozen runtime
//! controls and source constructor rewriting. No JavaScript reference codec.
use fork_instrument::{module_exception_codec, module_gc_codec, streaming::*};
use wasm_encoder::{
    Function,
    reencode::{Error, Reencode, RoundtripReencoder},
};
#[path = "streaming_roots.rs"]
mod roots;

struct Provider {
    runtime: NativeRuntime,
    plan: NativeGcPlan,
    constructors: FrozenGcConstructors,
    gc: NativeGcCodec,
    exception: NativeExceptionCodec,
    first_gc: u32,
    first_exception: u32,
    roots: Option<roots::Components>,
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
impl Reencode for Provider {
    type Error = ImportIndexError;
    remap!(function_index);
    remap!(table_index);
    remap!(memory_index);
    remap!(global_index);
    remap!(tag_index);
}
impl FunctionTransform for Provider {
    fn defer_module_initializers(&self) -> bool {
        self.roots.is_some()
    }
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn function_ir_limits(&self) -> Option<IrLimits> {
        Some(Default::default())
    }
    fn transform_ir(&mut self, source: &FunctionIr<'_>, limit: usize) -> anyhow::Result<Function> {
        if let Some(roots) = &self.roots {
            let mut output = self
                .runtime
                .new_function_with_parsed_locals(&source.source)?;
            for instruction in &source.instructions {
                let operation = if let Some(helper) = self
                    .constructors
                    .replacement(&self.plan, &instruction.operation)?
                {
                    wasm_encoder::Instruction::Call(helper)
                } else {
                    self.runtime.instruction(instruction.operation.clone())?
                };
                roots
                    .roots
                    .emit_source(&instruction.operation, operation, &mut output, limit)?;
            }
            return Ok(output);
        }
        self.constructors
            .emit_function(&self.plan, source, &mut self.runtime, limit)
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        match ordinal {
            0..7 => self.runtime.emit_control(ordinal, limit),
            n if n < self.first_gc => self.constructors.emit_helper(n - 7, &self.plan, limit),
            n if n < self.first_exception => {
                self.gc.emit_helper(n - self.first_gc, &self.plan, limit)
            }
            n if n < self.first_exception + self.exception.declarations().function_count() => {
                self.exception.emit_helper(n - self.first_exception, limit)
            }
            n => self.roots.as_ref().expect("root catalog").emit_helper(
                n - self.first_exception - self.exception.declarations().function_count(),
                limit,
            ),
        }
    }
}
#[allow(dead_code)] // Root-state targets use emit_roots instead.
pub fn emit(input: &[u8]) -> Vec<u8> {
    emit_mode(input, false, false)
}
#[allow(dead_code)] // The plain provider target does not use root-state mode.
pub fn emit_roots(input: &[u8]) -> Vec<u8> {
    emit_mode(input, true, false)
}
#[allow(dead_code)]
pub fn emit_staged_roots(input: &[u8], wide: bool) -> Vec<u8> {
    emit_mode(input, true, wide)
}
fn emit_mode(input: &[u8], with_roots: bool, staging_wide: bool) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let source_types = SourceTypes::new(&scan);
    let plan = NativeGcPlan::discover(
        &scan,
        &source_types,
        &mut RoundtripReencoder,
        Default::default(),
    )
    .unwrap();
    let mut inputs = RuntimeInputs::default();
    if staging_wide {
        assert_eq!(scan.types.as_ref().memory_count(), 0);
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
    let root_imports =
        with_roots.then(|| RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap());
    let constructors =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 7, Default::default()).unwrap();
    let exception_imports = NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let first_gc = 7 + constructors.helper_count();
    let gc = GcCodecPlan::reserve(&scan, &plan, &mut inputs, first_gc, Default::default()).unwrap();
    inputs.helper_codecs.anyref = Some(gc.anyref_codecs());
    inputs.helper_codecs.externref = Some(gc.externref_codecs());
    let first_exception = first_gc + gc.helper_count();
    inputs.helper_codecs.exnref = Some(CodecPair {
        encode: first_exception,
        decode: first_exception + 1,
    });
    inputs.helper_codecs.cleanup = Some(first_exception + 6);
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    let imports = runtime.imports_plan().clone();
    let constructors = constructors.freeze(&imports).unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let gc = gc
        .freeze(&scan, &plan, &imports, runtime.indices(), &mut module)
        .unwrap();
    let references = runtime.indices().codecs;
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let exception = NativeExceptionCodec::plan(
        &scan,
        &source_types,
        &mut runtime,
        &exception_imports,
        &imports,
        references,
        &mut module,
        first_type,
        imports.helper_function_base() + first_exception,
        Default::default(),
    )
    .unwrap();
    module
        .export(
            "__test_encode_externref",
            wasm_encoder::ExportKind::Func,
            gc.indices().encode_externref,
        )
        .unwrap();
    module
        .export(
            "__test_decode_externref",
            wasm_encoder::ExportKind::Func,
            gc.indices().decode_externref,
        )
        .unwrap();
    let roots = root_imports.as_ref().map(|host| {
        roots::Components::plan(
            &scan,
            &mut runtime,
            host,
            &mut module,
            first_type + exception.declarations().type_count(),
            imports.helper_function_base()
                + first_exception
                + exception.declarations().function_count(),
        )
    });
    let mut parts = vec![
        runtime.function_declarations(),
        constructors.declarations(),
        gc.declarations(),
        exception.declarations(),
    ];
    if let Some(roots) = &roots {
        parts.push(&roots.declarations);
    }
    let declarations = FrozenDeclarations::concatenate(&parts, 1 << 20).unwrap();
    let mut descriptors = vec![
        (module_gc_codec::FORMAT_SECTION, plan.descriptor().unwrap()),
        (
            module_exception_codec::FORMAT_SECTION,
            exception.descriptor().unwrap(),
        ),
    ];
    if let Some(roots) = &roots {
        descriptors.push((
            wasm_posix_shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
            roots.roots.imported_globals_descriptor().to_vec(),
        ));
    }
    let mut transform = Provider {
        runtime,
        plan,
        constructors,
        gc,
        exception,
        first_gc,
        first_exception,
        roots,
        declarations,
        module: module.freeze(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    let mut metadata = wasm_encoder::Module::new();
    for (name, data) in descriptors {
        metadata.section(&wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        });
    }
    output.extend_from_slice(&metadata.finish()[8..]);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}
