//! Compose real native exception providers with the linked runtime controls.
use fork_instrument::streaming::*;
use wasm_encoder::{
    Function,
    reencode::{Error, Reencode},
};

struct Provider {
    runtime: NativeRuntime,
    codec: NativeExceptionCodec,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}
macro_rules! remap {
    ($name:ident) => {
        fn $name(&mut self, index: u32) -> Result<u32, Error<Self::Error>> {
            self.runtime.$name(index)
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
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        if ordinal < 7 {
            self.runtime.emit_control(ordinal, limit)
        } else {
            self.codec.emit_helper(ordinal - 7, limit)
        }
    }
}

pub fn emit(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let types = SourceTypes::new(&scan);
    let mut inputs = RuntimeInputs::default();
    let host = NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    inputs.helper_codecs.exnref = Some(CodecPair {
        encode: 7,
        decode: 8,
    });
    inputs.helper_codecs.cleanup = Some(13);
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    let frozen_imports = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&frozen_imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let first_function = frozen_imports.helper_function_base() + 7;
    let references = runtime.indices().codecs;
    let codec = NativeExceptionCodec::plan(
        &scan,
        &types,
        &mut runtime,
        &host,
        &frozen_imports,
        references,
        &mut module,
        first_type,
        first_function,
        Default::default(),
    )
    .unwrap();
    assert_eq!(references.exnref.encode, codec.indices().encode);
    assert_eq!(references.exnref.decode, codec.indices().decode);
    let declarations = FrozenDeclarations::concatenate(
        &[runtime.function_declarations(), codec.declarations()],
        1 << 20,
    )
    .unwrap();
    let descriptor = codec.descriptor().unwrap();
    let mut provider = Provider {
        runtime,
        codec,
        declarations,
        module: module.freeze(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut provider, &mut output, Default::default()).unwrap();
    let mut metadata = wasm_encoder::Module::new();
    metadata.section(&wasm_encoder::CustomSection {
        name: fork_instrument::module_exception_codec::FORMAT_SECTION.into(),
        data: descriptor.into(),
    });
    output.extend_from_slice(&metadata.finish()[8..]);
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}
