//! Frozen runtime imports and source index shifts, without instruction IR.

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use wasm_encoder::{
    Encode, EntityType, GlobalType, ImportSection, ValType,
    reencode::{Error, Reencode},
};
use wasmparser::{Parser, Payload, TypeRef};

use super::{FunctionTransform, Scan};
mod functions;
pub use functions::FunctionAdapter;

/// Types and heap identities here already use final output indices. Appended
/// imports precede all source definitions in their respective index spaces.
#[derive(Clone, Debug)]
pub struct PlannedImport {
    pub module: String,
    pub name: String,
    pub ty: EntityType,
}

/// Appending imports preserves existing imported-global indices. New bindings
/// resolve by their reserved ordinal after the complete import plan freezes.
#[derive(Clone, Copy)]
pub(super) enum ImmutableGlobalImport {
    Source(u32),
    Planned(u32),
}
impl ImmutableGlobalImport {
    pub fn resolve(self, imports: &FrozenImports) -> Result<u32> {
        match self {
            Self::Source(index) => Ok(index),
            Self::Planned(ordinal) => imports
                .index(ordinal)
                .context("reserved global import was not frozen"),
        }
    }
}

pub(super) fn immutable_i32_import(
    scan: &Scan<'_>,
    imports: &mut Vec<PlannedImport>,
    module: &str,
    name: &str,
) -> Result<ImmutableGlobalImport> {
    immutable_global_import(scan, imports, module, name, ValType::I32)
}

pub(super) fn immutable_global_import(
    scan: &Scan<'_>,
    imports: &mut Vec<PlannedImport>,
    module: &str,
    name: &str,
    ty: ValType,
) -> Result<ImmutableGlobalImport> {
    let source_type = match ty {
        ValType::I32 => wasmparser::ValType::I32,
        ValType::I64 => wasmparser::ValType::I64,
        _ => anyhow::bail!("reserved global must be i32 or i64"),
    };
    let type_name = if ty == ValType::I32 { "i32" } else { "i64" };
    let mut global_index = 0u32;
    for payload in Parser::new(0).parse_all(scan.input()) {
        if let Payload::ImportSection(section) = payload? {
            for import in section.into_imports() {
                let import = import?;
                if import.module == module && import.name == name {
                    ensure!(
                        matches!(import.ty, TypeRef::Global(global)
                        if global.content_type == source_type && !global.mutable && !global.shared),
                        "reserved import {module}.{name} must be an immutable {type_name} global"
                    );
                    return Ok(ImmutableGlobalImport::Source(global_index));
                }
                if matches!(import.ty, TypeRef::Global(_)) {
                    global_index += 1;
                }
            }
        }
    }
    if let Some((ordinal, import)) = imports
        .iter()
        .enumerate()
        .find(|(_, import)| import.module == module && import.name == name)
    {
        ensure!(
            matches!(import.ty, EntityType::Global(global) if global.val_type == ty && !global.mutable && !global.shared),
            "planned import {module}.{name} must be an immutable {type_name} global"
        );
        return Ok(ImmutableGlobalImport::Planned(u32::try_from(ordinal)?));
    }
    let ordinal = u32::try_from(imports.len())?;
    imports.push(PlannedImport {
        module: module.into(),
        name: name.into(),
        ty: EntityType::Global(GlobalType {
            val_type: ty,
            mutable: false,
            shared: false,
        }),
    });
    Ok(ImmutableGlobalImport::Planned(ordinal))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    functions: u32,
    tables: u32,
    memories: u32,
    globals: u32,
    tags: u32,
}

impl Counts {
    fn for_scan(scan: &Scan<'_>) -> Self {
        let types = scan.types.as_ref();
        Self {
            functions: scan.functions.len() as u32,
            tables: types.table_count(),
            memories: types.memory_count(),
            globals: types.global_count(),
            tags: types.tag_count(),
        }
    }
    fn add(&mut self, ty: EntityType) -> Result<u32> {
        let count = match ty {
            EntityType::Function(_) | EntityType::FunctionExact(_) => &mut self.functions,
            EntityType::Table(_) => &mut self.tables,
            EntityType::Memory(_) => &mut self.memories,
            EntityType::Global(_) => &mut self.globals,
            EntityType::Tag(_) => &mut self.tags,
        };
        let index = *count;
        *count = count
            .checked_add(1)
            .context("frozen import index overflow")?;
        Ok(index)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ImportIndexError {
    space: &'static str,
    index: u32,
}
impl std::fmt::Display for ImportIndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "source {} index {} outside frozen import plan",
            self.space, self.index
        )
    }
}
impl std::error::Error for ImportIndexError {}

/// Immutable added imports and explicit function-to-local conversions.
/// Retained function imports compact after removals; other imported entities
/// keep their indices. Source definitions shift by the resulting import delta.
/// Reencode applies this to bodies, exports, segments, initializers, start and
/// names. Type/data/element indices do not shift when changing imports.
///
/// Adapter bodies, local state and fork behavior consume this mapping and
/// must be declared separately before emission.
#[derive(Clone, Debug)]
pub struct FrozenImports {
    imports: Vec<PlannedImport>,
    indices: Vec<u32>,
    imported: Counts,
    source: Counts,
    total: Counts,
    fingerprint: [u8; 32],
    estimated_bytes: usize,
    adapters: Vec<FunctionAdapter>,
}

impl FrozenImports {
    pub fn new(scan: &Scan<'_>, imports: Vec<PlannedImport>, budget: usize) -> Result<Self> {
        Self::with_function_adapters(scan, imports, Vec::new(), budget)
    }
    /// Removed source function imports resolve to already-reserved local
    /// helper ordinals. All other source identities shift consistently.
    pub fn with_function_adapters(
        scan: &Scan<'_>,
        imports: Vec<PlannedImport>,
        adapters: Vec<FunctionAdapter>,
        budget: usize,
    ) -> Result<Self> {
        let mut estimate = imports
            .len()
            .checked_mul(128)
            .context("frozen import size overflow")?;
        estimate = estimate
            .checked_add(
                adapters
                    .len()
                    .checked_mul(256)
                    .context("function adapter metadata overflow")?,
            )
            .context("function adapter metadata overflow")?;
        for import in &imports {
            estimate = estimate
                .checked_add(import.module.len())
                .and_then(|n| n.checked_add(import.name.len()))
                .context("frozen import name size overflow")?;
        }
        ensure!(estimate <= budget, "frozen imports exceed metadata budget");
        u32::try_from(imports.len()).context("too many frozen imports")?;
        let mut imported = Counts::default();
        for payload in Parser::new(0).parse_all(scan.input()) {
            if let Payload::ImportSection(section) = payload? {
                for import in section.into_imports() {
                    let count = match import?.ty {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => &mut imported.functions,
                        TypeRef::Table(_) => &mut imported.tables,
                        TypeRef::Memory(_) => &mut imported.memories,
                        TypeRef::Global(_) => &mut imported.globals,
                        TypeRef::Tag(_) => &mut imported.tags,
                    };
                    *count = count
                        .checked_add(1)
                        .context("source import index overflow")?;
                }
            }
        }
        let source = Counts::for_scan(scan);
        functions::validate(scan, &adapters, imported.functions)?;
        let removed = u32::try_from(adapters.len())?;
        let mut total = source;
        let mut inserted = imported;
        total.functions -= removed;
        inserted.functions -= removed;
        let mut indices = Vec::with_capacity(imports.len());
        for import in &imports {
            indices.push(inserted.add(import.ty)?);
            total.add(import.ty)?;
        }
        let output = Self {
            imports,
            indices,
            imported,
            source,
            total,
            fingerprint: Sha256::digest(scan.input()).into(),
            estimated_bytes: estimate,
            adapters,
        };
        output.check_budget(budget)?;
        Ok(output)
    }
    pub fn len(&self) -> u32 {
        self.imports.len() as u32
    }
    pub(super) fn source_identity(&self) -> [u8; 32] {
        self.fingerprint
    }
    pub(super) fn memory_import(&self, ordinal: u32) -> Result<(u32, wasm_encoder::MemoryType)> {
        let import = self
            .imports
            .get(ordinal as usize)
            .context("process memory import was not frozen")?;
        let EntityType::Memory(memory) = import.ty else {
            anyhow::bail!("reserved process import is not a memory")
        };
        Ok((self.indices[ordinal as usize], memory))
    }
    pub fn is_empty(&self) -> bool {
        self.imports.is_empty() && self.adapters.is_empty()
    }
    /// Final index in this import's own entity index space.
    pub fn index(&self, ordinal: u32) -> Option<u32> {
        self.indices.get(ordinal as usize).copied()
    }
    /// First generated local helper, after shifted source definitions.
    pub fn helper_function_base(&self) -> u32 {
        self.total.functions
    }
    pub fn table_definition_base(&self) -> u32 {
        self.total.tables
    }
    pub fn memory_definition_base(&self) -> u32 {
        self.total.memories
    }
    pub(super) fn mapped_memory_index(&self, index: u32) -> Result<u32, Error<ImportIndexError>> {
        self.shift(
            index,
            self.imported.memories,
            self.source.memories,
            self.total.memories,
            "memory",
        )
    }
    pub fn global_definition_base(&self) -> u32 {
        self.total.globals
    }
    pub fn tag_definition_base(&self) -> u32 {
        self.total.tags
    }

    pub(super) fn layout_identity(&self) -> Option<[u8; 32]> {
        if self.is_empty() {
            return None;
        }
        let mut section = ImportSection::new();
        self.append(&mut section);
        let mut bytes = Vec::new();
        section.encode(&mut bytes);
        let mut hash = Sha256::new();
        hash.update(self.fingerprint);
        hash.update(bytes);
        for adapter in &self.adapters {
            hash.update(adapter.source_function.to_le_bytes());
            hash.update(adapter.helper_ordinal.to_le_bytes());
        }
        Some(hash.finalize().into())
    }

    pub(super) fn validate_source(&self, scan: &Scan<'_>) -> Result<()> {
        ensure!(
            self.source == Counts::for_scan(scan)
                && self.fingerprint == <[u8; 32]>::from(Sha256::digest(scan.input())),
            "frozen imports belong to a different original module"
        );
        Ok(())
    }
    pub(super) fn append(&self, section: &mut ImportSection) {
        for import in &self.imports {
            section.import(&import.module, &import.name, import.ty);
        }
    }
    pub(super) fn check_budget(&self, budget: usize) -> Result<()> {
        ensure!(
            self.estimated_bytes <= budget,
            "frozen imports exceed metadata budget"
        );
        let mut section = ImportSection::new();
        self.append(&mut section);
        let mut bytes = Vec::new();
        section.encode(&mut bytes);
        ensure!(
            bytes.len() <= budget,
            "encoded frozen imports exceed metadata budget"
        );
        Ok(())
    }
    fn shift(
        &self,
        index: u32,
        imported: u32,
        source: u32,
        total: u32,
        space: &'static str,
    ) -> Result<u32, Error<ImportIndexError>> {
        if index >= source {
            return Err(Error::UserError(ImportIndexError { space, index }));
        }
        Ok(if index < imported {
            index
        } else {
            index + (total - source)
        })
    }
}

impl Reencode for FrozenImports {
    type Error = ImportIndexError;
    fn function_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.mapped_function(i)
    }
    fn table_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.shift(
            i,
            self.imported.tables,
            self.source.tables,
            self.total.tables,
            "table",
        )
    }
    fn memory_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.mapped_memory_index(i)
    }
    fn global_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.shift(
            i,
            self.imported.globals,
            self.source.globals,
            self.total.globals,
            "global",
        )
    }
    fn tag_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.shift(
            i,
            self.imported.tags,
            self.source.tags,
            self.total.tags,
            "tag",
        )
    }
}

impl FunctionTransform for FrozenImports {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self)
    }
}
