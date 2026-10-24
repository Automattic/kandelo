//! Standalone staged-loader lowering. Fork activation composition is a
//! separate test; this factory exercises import removal and protocol bodies.
use fork_instrument::streaming::*;
use wasm_encoder::{
    Function,
    reencode::{Error, Reencode},
};

struct Loader {
    imports: FrozenImports,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
    loader: NativeLegacyLoader,
}
impl Reencode for Loader {
    type Error = ImportIndexError;
    fn function_index(&mut self, index: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.function_index(index)
    }
    fn table_index(&mut self, index: u32) -> Result<u32, Error<Self::Error>> {
        self.imports.table_index(index)
    }
}
impl FunctionTransform for Loader {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(&self.imports)
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn emit_helper(&mut self, ordinal: u32, limit: usize) -> anyhow::Result<Function> {
        self.loader.emit_helper(ordinal, limit)
    }
}
pub fn emit(input: &[u8]) -> Vec<u8> {
    let scan = scan(input).unwrap();
    let mut inputs = RuntimeInputs::default();
    let plan = LegacyLoaderPlan::reserve(&scan, &mut inputs, 0, Default::default()).unwrap();
    let imports = FrozenImports::with_function_adapters(
        &scan,
        inputs.imports,
        inputs.function_adapters,
        1 << 20,
    )
    .unwrap();
    let types = FrozenDeclarations::new(inputs.types, vec![], 1 << 20).unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, Some(&imports), 1 << 20).unwrap();
    let loader = plan.freeze(&scan, &imports, &mut module).unwrap();
    let declarations =
        FrozenDeclarations::concatenate(&[&types, loader.declarations()], 1 << 20).unwrap();
    let mut transform = Loader {
        imports,
        declarations,
        module: module.freeze(),
        loader,
    };
    let mut bytes = Vec::new();
    emit_remapped(&scan, &mut transform, &mut bytes, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&bytes)
        .unwrap();
    bytes
}
