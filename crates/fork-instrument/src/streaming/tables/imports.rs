//! Host calls contain only scalar table owners, page ranges and generations.
use super::*;
use crate::streaming::imports::{ImmutableGlobalImport, immutable_global_import};
use wasm_encoder::EntityType;

pub struct TableStateImports {
    functions: [u32; 8],
    pub(super) memory: crate::streaming::memory::ProcessMemory,
    generation: ImmutableGlobalImport,
    source: [u8; 32],
    pub(super) shared: bool,
}
#[derive(Clone, Copy)]
pub(super) struct TableHost {
    pub dirty_count: u32,
    pub dirty_mark: u32,
    pub dirty_page: u32,
    pub owned: u32,
    pub begin: u32,
    pub commit: u32,
    pub abort: u32,
    pub reconcile: u32,
    pub generation: u32,
}
impl TableStateImports {
    /// Reserve root/process-memory imports before this table-only suffix.
    pub fn append(scan: &Scan<'_>, inputs: &mut RuntimeInputs, budget: usize) -> Result<Self> {
        ensure!(
            inputs
                .imports
                .len()
                .checked_add(9)
                .is_some_and(|n| n <= budget / 256),
            "table imports exceed metadata budget"
        );
        let memory = inputs
            .process_memory_binding(scan)?
            .context("table imports need process memory")?;
        let shared = if let Some(ordinal) = inputs.staging_memory {
            let EntityType::Memory(memory) = inputs.imports[ordinal as usize].ty else {
                unreachable!()
            };
            memory.shared
        } else {
            scan.types.as_ref().memory_at(0).shared
        };
        let generation = immutable_global_import(
            scan,
            &mut inputs.imports,
            abi::WPK_FORK_MODULE_STATE_IMPORT_MODULE,
            abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_GENERATION_ADDR,
            ValType::I64,
        )?;
        let i = ValType::I32;
        let w = ValType::I64;
        let mut functions = [0; 8];
        for (ordinal, (name, params, results)) in [
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_COUNT,
                vec![i],
                vec![i],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_MARK,
                vec![i, w, w],
                vec![],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_DIRTY_PAGE,
                vec![i, i],
                vec![w],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_STATE_OWNED,
                vec![i],
                vec![i],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_BEGIN,
                vec![],
                vec![w],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_COMMIT,
                vec![i, w, w],
                vec![],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_MUTATION_ABORT,
                vec![],
                vec![],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_TABLE_RECONCILE,
                vec![],
                vec![w],
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let index = if let Some(index) = inputs
                .types
                .iter()
                .position(|t| t.params() == params && t.results() == results)
            {
                index
            } else {
                ensure!(
                    inputs.types.len() < budget / 128,
                    "table import types exceed metadata budget"
                );
                inputs.types.push(FuncType::new(params, results));
                inputs.types.len() - 1
            };
            let index = scan
                .types
                .as_ref()
                .core_type_count_in_module()
                .checked_add(u32::try_from(index)?)
                .context("table import type overflow")?;
            functions[ordinal] = u32::try_from(inputs.imports.len())?;
            inputs.imports.push(PlannedImport {
                module: abi::WPK_FORK_MODULE_STATE_IMPORT_MODULE.into(),
                name: name.into(),
                ty: EntityType::Function(index),
            });
        }
        FrozenDeclarations::validate_parts(&inputs.types, &[], budget)?;
        Ok(Self {
            functions,
            memory,
            generation,
            source: scan.source_fingerprint(),
            shared,
        })
    }
    pub(super) fn freeze(&self, frozen: &FrozenImports) -> Result<TableHost> {
        ensure!(
            self.source == frozen.source_identity(),
            "table imports belong to another source module"
        );
        self.memory.resolve(frozen)?;
        let indices = self
            .functions
            .map(|ordinal| frozen.index(ordinal).context("table import was not frozen"));
        let [
            dirty_count,
            dirty_mark,
            dirty_page,
            owned,
            begin,
            commit,
            abort,
            reconcile,
        ] = indices;
        Ok(TableHost {
            dirty_count: dirty_count?,
            dirty_mark: dirty_mark?,
            dirty_page: dirty_page?,
            owned: owned?,
            begin: begin?,
            commit: commit?,
            abort: abort?,
            reconcile: reconcile?,
            generation: self.generation.resolve(frozen)?,
        })
    }
}
