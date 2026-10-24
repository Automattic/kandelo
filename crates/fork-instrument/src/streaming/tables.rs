//! Original table ownership, sparse snapshots and cross-worker publication.
//! Restore all activation baselines before applying canonical physical overlays.
use super::*;
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{ConstExpr, FuncType, Function, GlobalType, RefType, ValType};
use wasm_posix_shared::abi;

mod catalog;
mod emit;
mod imports;
mod markers;
#[cfg(test)]
mod tests;
use imports::TableHost;
pub use imports::TableStateImports;
use roots::imports::RecordHost;

#[derive(Clone, Copy, Debug)]
pub struct TableStateLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for TableStateLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
        }
    }
}
struct Table {
    source: u32,
    index: u32,
    owner: u32,
    wide: bool,
    ty: RefType,
    class: NativeReferenceClass,
    baseline_len: u64,
    fingerprint: [u8; 32],
    last_page: u32,
}
pub struct NativeTableState {
    source: [u8; 32],
    tables: Vec<Table>,
    imported_tables: Vec<u8>,
    declarations: FrozenDeclarations,
    records: RecordHost,
    host: TableHost,
    codecs: NativeReferenceCodecs,
    memory: u32,
    pointer: ValType,
    shared: bool,
    last_generation: u32,
    limits: TableStateLimits,
    pub save: u32,
    pub restore: u32,
    pub reconcile: u32,
    pub mutation_begin: u32,
    first_marker: u32,
}
impl NativeTableState {
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        records: &RootStateImports,
        imports: &TableStateImports,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
        limits: TableStateLimits,
    ) -> Result<Self> {
        let frozen = runtime.imports_plan();
        frozen.validate_source(scan)?;
        let source = frozen.source_identity();
        records.validate_memory(runtime)?;
        let records = records.freeze(frozen)?;
        let host = imports.freeze(frozen)?;
        let memory = runtime
            .process_memory()
            .context("table state needs process memory")?;
        ensure!(
            imports.memory.resolve(frozen)? == memory
                && imports.memory.pointer == runtime.pointer_type(),
            "table process-memory binding changed after reservation"
        );
        let shared = imports.shared;
        let (tables, imported_tables) = catalog::discover(scan, runtime, module, limits)?;
        let count = u32::try_from(tables.len())?
            .checked_mul(2)
            .and_then(|n| n.checked_add(4))
            .context("table helper count overflow")?;
        first_function
            .checked_add(count)
            .context("table helper index overflow")?;
        let marker_type = first_type
            .checked_add(2)
            .context("table helper type overflow")?;
        let mut functions = vec![first_type; 2];
        functions.extend([first_type + 1; 2]);
        functions.extend(std::iter::repeat_n(marker_type, tables.len() * 2));
        let declarations = FrozenDeclarations::new(
            vec![
                FuncType::new([ValType::I32], []),
                FuncType::new([], []),
                FuncType::new([ValType::I64, ValType::I64], []),
            ],
            functions,
            limits.metadata_bytes,
        )?;
        let last_generation = module.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            ConstExpr::i64_const(0),
        )?;
        Ok(Self {
            source,
            tables,
            imported_tables,
            declarations,
            records,
            host,
            codecs: runtime.indices().codecs,
            memory,
            pointer: runtime.pointer_type(),
            shared,
            last_generation,
            limits,
            save: first_function,
            restore: first_function + 1,
            reconcile: first_function + 2,
            mutation_begin: first_function + 3,
            first_marker: first_function + 4,
        })
    }
    pub(super) fn source_identity(&self) -> [u8; 32] {
        self.source
    }
    pub(super) fn uses_memory(&self, binding: (u32, ValType)) -> bool {
        binding == (self.memory, self.pointer)
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn imported_tables_descriptor(&self) -> &[u8] {
        &self.imported_tables
    }
    pub fn synchronized_tables(&self) -> BTreeSet<u32> {
        self.tables.iter().map(|table| table.source).collect()
    }
    pub fn markers(&self) -> BTreeMap<u32, TableMarkers> {
        self.tables
            .iter()
            .enumerate()
            .map(|(ordinal, table)| {
                let mark = self.first_marker + ordinal as u32 * 2;
                (
                    table.source,
                    TableMarkers {
                        mark,
                        grow: mark + 1,
                    },
                )
            })
            .collect()
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(
            ordinal < self.declarations.function_count(),
            "unknown table helper"
        );
        if ordinal < 2 {
            emit::snapshot(self, ordinal == 1, limit)
        } else {
            markers::helper(self, ordinal, limit)
        }
    }
}
