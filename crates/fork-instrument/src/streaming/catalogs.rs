//! Immutable function/resume identities and a transient static-GC harvest.
use super::*;
use anyhow::{Context, Result, ensure};
use wasm_encoder::{ConstExpr, ExportKind, RefType, TableType, reencode::Reencode};

mod static_roots;
pub use static_roots::*;

/// Freeze original function ordinals plus the explicit bootstrap entry.
/// Provider/runtime helpers have no source-level function identity.
pub fn declare_function_catalog<T: Reencode>(
    scan: &Scan<'_>,
    map: &mut T,
    module: &mut ModuleDeclarationBuilder<'_, '_>,
    bootstrap: u32,
    budget: usize,
) -> Result<u32>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let count = scan
        .functions
        .len()
        .checked_add(1)
        .context("function catalog size overflow")?;
    ensure!(
        count <= budget / 64,
        "function catalog exceeds metadata budget"
    );
    u32::try_from(count).context("function catalog count overflow")?;
    let mut functions = Vec::with_capacity(count);
    for source in 0..u32::try_from(scan.functions.len())? {
        functions.push(map.function_index(source)?);
    }
    functions.push(bootstrap);
    function_table(module, crate::FUNCTION_CATALOG_EXPORT, functions)
}

pub struct NativeResumeCatalog {
    pub table: u32,
    descriptor: Vec<u8>,
}
impl NativeResumeCatalog {
    /// Entries may be a strict ascending subset of the module's dense frame
    /// ordinals. The host chooses catalog slots; frames retain their ordinals.
    pub fn declare(
        entries: impl IntoIterator<Item = (u32, u32)>,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        budget: usize,
    ) -> Result<Self> {
        ensure!(budget >= 128, "resume catalog exceeds metadata budget");
        let mut descriptor = Vec::new();
        descriptor.extend_from_slice(b"KFRC");
        descriptor.extend_from_slice(&1u16.to_le_bytes());
        descriptor.extend_from_slice(&12u16.to_le_bytes());
        descriptor.extend_from_slice(&0u32.to_le_bytes());
        let mut functions = Vec::new();
        let mut previous = None;
        for (ordinal, function) in entries {
            ensure!(
                functions.len() < budget / 128,
                "resume catalog exceeds metadata budget"
            );
            ensure!(
                previous.is_none_or(|previous| ordinal > previous),
                "resume ordinals must be strictly ascending"
            );
            previous = Some(ordinal);
            descriptor.extend_from_slice(&ordinal.to_le_bytes());
            descriptor.extend_from_slice(&u32::try_from(functions.len())?.to_le_bytes());
            functions.push(function);
        }
        descriptor[8..12].copy_from_slice(&u32::try_from(functions.len())?.to_le_bytes());
        let table = function_table(module, crate::instrument::RESUME_CATALOG_EXPORT, functions)?;
        Ok(Self { table, descriptor })
    }
    pub fn descriptor(&self) -> &[u8] {
        &self.descriptor
    }
}
fn function_table(
    module: &mut ModuleDeclarationBuilder<'_, '_>,
    name: &str,
    functions: Vec<u32>,
) -> Result<u32> {
    let count = u64::try_from(functions.len())?;
    let table = module.table(fixed_table(RefType::FUNCREF, count), None)?;
    module.export(name, ExportKind::Table, table)?;
    if !functions.is_empty() {
        module.element(
            ElementMode::Active {
                table,
                offset: ConstExpr::i32_const(0),
            },
            ElementValues::Functions(functions),
        )?;
    }
    Ok(table)
}
fn fixed_table(element_type: RefType, count: u64) -> TableType {
    TableType {
        element_type,
        table64: false,
        minimum: count,
        maximum: Some(count),
        shared: false,
    }
}
