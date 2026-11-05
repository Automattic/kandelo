//! Frozen local runtime declarations; no bodies or mutable module arena.

use std::collections::BTreeSet;

use anyhow::{Context, Result, ensure};
use wasm_encoder::{
    ConstExpr, ElementSection, Elements, Encode, ExportKind, ExportSection, GlobalSection,
    GlobalType, MemorySection, MemoryType, RefType, TableSection, TableType, TagSection, TagType,
};

use super::{FrozenImports, Scan};

#[derive(Clone, Debug)]
pub enum ElementValues {
    Functions(Vec<u32>),
    Expressions(RefType, Vec<ConstExpr>),
}
impl ElementValues {
    fn borrowed(&self) -> Elements<'_> {
        match self {
            Self::Functions(f) => Elements::Functions(f.as_slice().into()),
            Self::Expressions(ty, e) => Elements::Expressions(*ty, e.as_slice().into()),
        }
    }
}

#[derive(Clone, Debug)]
pub enum ElementMode {
    Active { table: u32, offset: ConstExpr },
    Passive,
    Declared,
}

#[derive(Clone, Debug)]
struct ElementDeclaration {
    mode: ElementMode,
    values: ElementValues,
}
impl ElementDeclaration {
    fn append(&self, section: &mut ElementSection) {
        let values = self.values.borrowed();
        match &self.mode {
            ElementMode::Active { table, offset } => {
                section.active(Some(*table), offset, values);
            }
            ElementMode::Passive => {
                section.passive(values);
            }
            ElementMode::Declared => {
                section.declared(values);
            }
        }
    }
}

/// All type/entity references are final output indices. Definitions append
/// after source definitions; imports must already have been frozen. Data
/// payloads are deliberately excluded and continue through the writer spool.
#[derive(Clone, Debug, Default)]
pub struct FrozenModuleDeclarations {
    tables: Vec<(TableType, Option<ConstExpr>)>,
    memories: Vec<MemoryType>,
    tags: Vec<TagType>,
    globals: Vec<(GlobalType, ConstExpr)>,
    exports: Vec<(String, ExportKind, u32)>,
    elements: Vec<ElementDeclaration>,
    estimated_bytes: usize,
    source: [u8; 32],
    imports: Option<[u8; 32]>,
}

/// Bounded planning before emission. Returned indices include the imported
/// runtime entities and original definitions, so callers may immediately use
/// them in other frozen declarations and helper recipes.
pub struct ModuleDeclarationBuilder<'s, 'a> {
    scan: &'s Scan<'a>,
    output: FrozenModuleDeclarations,
    bases: [u32; 5],
    export_names: BTreeSet<String>,
    budget: usize,
}

impl<'s, 'a> ModuleDeclarationBuilder<'s, 'a> {
    /// Continue planning another pass after an earlier catalog, preserving all
    /// reserved identities. The final combined catalog is frozen once again
    /// before the writer starts; emitters never append declarations.
    pub fn from_frozen(
        scan: &'s Scan<'a>,
        imports: Option<&FrozenImports>,
        declarations: FrozenModuleDeclarations,
        budget: usize,
    ) -> Result<Self> {
        declarations.validate(scan, imports, budget)?;
        let mut builder = Self::new(scan, imports, budget)?;
        builder
            .export_names
            .extend(declarations.exports.iter().map(|(name, _, _)| name.clone()));
        builder.output = declarations;
        Ok(builder)
    }
    pub fn new(scan: &'s Scan<'a>, imports: Option<&FrozenImports>, budget: usize) -> Result<Self> {
        if let Some(imports) = imports {
            imports.validate_source(scan)?;
        }
        let types = scan.types.as_ref();
        let bases = if let Some(imports) = imports {
            [
                imports.table_definition_base(),
                imports.memory_definition_base(),
                imports.tag_definition_base(),
                imports.global_definition_base(),
                scan.elements.len().try_into()?,
            ]
        } else {
            [
                types.table_count(),
                types.memory_count(),
                types.tag_count(),
                types.global_count(),
                scan.elements.len().try_into()?,
            ]
        };
        Ok(Self {
            scan,
            output: FrozenModuleDeclarations {
                source: scan.source_fingerprint(),
                imports: imports.and_then(FrozenImports::layout_identity),
                ..Default::default()
            },
            bases,
            export_names: BTreeSet::new(),
            budget,
        })
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        let total = self
            .output
            .estimated_bytes
            .checked_add(bytes)
            .context("module declaration size overflow")?;
        ensure!(
            total <= self.budget,
            "module declarations exceed metadata budget"
        );
        self.output.estimated_bytes = total;
        Ok(())
    }
    fn index(&self, base: usize, len: usize) -> Result<u32> {
        self.bases[base]
            .checked_add(u32::try_from(len)?)
            .filter(|i| *i != u32::MAX)
            .context("module declaration index overflow")
    }
    pub fn table(&mut self, ty: TableType, initializer: Option<ConstExpr>) -> Result<u32> {
        let index = self.index(0, self.output.tables.len())?;
        let mut bytes = Vec::new();
        ty.encode(&mut bytes);
        if let Some(expr) = &initializer {
            expr.encode(&mut bytes);
        }
        self.charge(
            bytes
                .len()
                .checked_add(128)
                .context("table declaration size overflow")?,
        )?;
        self.output.tables.push((ty, initializer));
        Ok(index)
    }
    pub fn memory(&mut self, ty: MemoryType) -> Result<u32> {
        let index = self.index(1, self.output.memories.len())?;
        self.charge(128)?;
        self.output.memories.push(ty);
        Ok(index)
    }
    pub fn tag(&mut self, ty: TagType) -> Result<u32> {
        let index = self.index(2, self.output.tags.len())?;
        self.charge(64)?;
        self.output.tags.push(ty);
        Ok(index)
    }
    pub fn global(&mut self, ty: GlobalType, initializer: ConstExpr) -> Result<u32> {
        let index = self.index(3, self.output.globals.len())?;
        let mut bytes = Vec::new();
        ty.encode(&mut bytes);
        initializer.encode(&mut bytes);
        self.charge(
            bytes
                .len()
                .checked_add(128)
                .context("global declaration size overflow")?,
        )?;
        self.output.globals.push((ty, initializer));
        Ok(index)
    }
    pub fn export(&mut self, name: &str, kind: ExportKind, index: u32) -> Result<()> {
        ensure!(
            !self.scan.exports.iter().any(|(n, _, _)| n == name)
                && !self.export_names.contains(name),
            "duplicate module export {name}"
        );
        self.charge(
            name.len()
                .checked_mul(2)
                .and_then(|n| n.checked_add(192))
                .context("export declaration size overflow")?,
        )?;
        self.output.exports.push((name.into(), kind, index));
        self.export_names.insert(name.into());
        Ok(())
    }
    pub fn element(&mut self, mode: ElementMode, values: ElementValues) -> Result<u32> {
        let index = self.index(4, self.output.elements.len())?;
        let count = match &values {
            ElementValues::Functions(f) => f.len(),
            ElementValues::Expressions(_, e) => e.len(),
        };
        let minimum = count
            .checked_mul(32)
            .and_then(|n| n.checked_add(128))
            .context("element declaration size overflow")?;
        ensure!(
            minimum <= self.budget.saturating_sub(self.output.estimated_bytes),
            "module declarations exceed metadata budget"
        );
        let element = ElementDeclaration { mode, values };
        let mut section = ElementSection::new();
        element.append(&mut section);
        let mut bytes = Vec::new();
        section.encode(&mut bytes);
        self.charge(
            minimum
                .checked_add(bytes.len())
                .context("element declaration size overflow")?,
        )?;
        self.output.elements.push(element);
        Ok(index)
    }
    pub fn freeze(self) -> FrozenModuleDeclarations {
        self.output
    }
}

impl FrozenModuleDeclarations {
    pub fn table_count(&self) -> u32 {
        self.tables.len() as u32
    }
    pub fn memory_count(&self) -> u32 {
        self.memories.len() as u32
    }
    pub fn tag_count(&self) -> u32 {
        self.tags.len() as u32
    }
    pub fn global_count(&self) -> u32 {
        self.globals.len() as u32
    }
    pub fn export_count(&self) -> u32 {
        self.exports.len() as u32
    }
    pub fn element_count(&self) -> u32 {
        self.elements.len() as u32
    }
    pub(super) fn validate(
        &self,
        scan: &Scan<'_>,
        imports: Option<&FrozenImports>,
        budget: usize,
    ) -> Result<()> {
        ensure!(
            self.source == scan.source_fingerprint(),
            "module declarations belong to a different original module"
        );
        ensure!(
            self.imports == imports.and_then(FrozenImports::layout_identity),
            "module declarations use a different frozen import layout"
        );
        ensure!(
            self.estimated_bytes <= budget,
            "module declarations exceed metadata budget"
        );
        Ok(())
    }
    pub(super) fn append_tables(&self, section: &mut TableSection) {
        for (ty, init) in &self.tables {
            if let Some(init) = init {
                section.table_with_init(*ty, init);
            } else {
                section.table(*ty);
            }
        }
    }
    pub(super) fn append_memories(&self, section: &mut MemorySection) {
        for &ty in &self.memories {
            section.memory(ty);
        }
    }
    pub(super) fn append_tags(&self, section: &mut TagSection) {
        for &ty in &self.tags {
            section.tag(ty);
        }
    }
    pub(super) fn append_globals(&self, section: &mut GlobalSection) {
        for (ty, init) in &self.globals {
            section.global(*ty, init);
        }
    }
    pub(super) fn append_exports(&self, section: &mut ExportSection) {
        for (name, kind, index) in &self.exports {
            section.export(name, *kind, *index);
        }
    }
    pub(super) fn append_elements(&self, section: &mut ElementSection) {
        for element in &self.elements {
            element.append(section);
        }
    }
}
