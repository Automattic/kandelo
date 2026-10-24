//! The fixed-size generated driver has its own validation/coordinate domain.
//! Only its bodies are emitted; these placeholder imports never reach output.
use super::*;
use wasm_encoder::{
    CodeSection, FunctionSection, ImportSection, Module, TypeSection, reencode::Error,
};

pub(super) const DRIVER: u32 = 3;
pub(super) fn input(loader: &NativeLegacyLoader, limit: usize) -> Result<Vec<u8>> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I32]);
    types.ty().function([], []);
    module.section(&types);
    let mut imports = ImportSection::new();
    for (name, ty) in [("next", 0), ("commit", 0), ("checkpoint", 1)] {
        imports.import("generated", name, EntityType::Function(ty));
    }
    imports.import(
        "generated",
        "table",
        EntityType::Table(TableType {
            element_type: RefType::FUNCREF,
            minimum: 0,
            maximum: None,
            table64: loader.table64,
            shared: false,
        }),
    );
    module.section(&imports);
    let mut functions = FunctionSection::new();
    functions.function(0);
    module.section(&functions);
    let mut code = CodeSection::new();
    code.function(&loader.emit_driver_indices(
        DriverIndices {
            next: 0,
            commit: 1,
            checkpoint: loader.checkpoint.map(|_| 2),
            table: 0,
            initializer_type: 1,
        },
        limit,
    )?);
    module.section(&code);
    let bytes = module.finish();
    ensure!(
        bytes.len() <= limit,
        "generated loader source exceeds output budget"
    );
    Ok(bytes)
}
#[derive(Clone, Copy, Debug)]
pub struct LoaderIndexError;
impl std::fmt::Display for LoaderIndexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("unknown generated loader index")
    }
}
impl std::error::Error for LoaderIndexError {}
pub(super) struct Mapping<'a>(pub &'a NativeLegacyLoader);
impl Reencode for Mapping<'_> {
    type Error = LoaderIndexError;
    fn function_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        match index {
            0 => Some(self.0.next),
            1 => Some(self.0.commit),
            2 => self.0.checkpoint,
            DRIVER => self.0.driver,
            _ => None,
        }
        .ok_or(Error::UserError(LoaderIndexError))
    }
    fn type_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        match index {
            0 => self.0.declarations.function_type(0),
            1 => Some(self.0.initializer_type),
            _ => None,
        }
        .ok_or(Error::UserError(LoaderIndexError))
    }
    fn table_index(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
        if index == 0 {
            Ok(self.0.table)
        } else {
            Err(Error::UserError(LoaderIndexError))
        }
    }
}
