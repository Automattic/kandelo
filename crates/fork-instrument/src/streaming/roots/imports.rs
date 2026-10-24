//! Scalar record operations; their payload addresses name process memory.
use super::super::PlannedImport;
use super::*;
use sha2::{Digest, Sha256};
use wasm_encoder::{EntityType, FuncType, MemoryType};

pub struct RootStateImports {
    functions: [u32; 3],
    source: [u8; 32],
}
#[derive(Clone, Copy)]
pub(super) struct RecordHost {
    pub reserve: u32,
    pub commit: u32,
    pub find: u32,
}
impl RootStateImports {
    /// Reserve the standard process-memory view for a memoryless module.
    /// Existing source memories remain authoritative and are never replaced.
    pub fn append(scan: &Scan<'_>, inputs: &mut RuntimeInputs, budget: usize) -> Result<Self> {
        ensure!(
            inputs
                .imports
                .len()
                .checked_add(4)
                .is_some_and(|count| count <= budget / 256),
            "root state imports exceed metadata budget"
        );
        if scan.types.as_ref().memory_count() == 0 && inputs.staging_memory.is_none() {
            let ordinal = if let Some(index) = inputs
                .imports
                .iter()
                .position(|import| import.module == "env" && import.name == "memory")
            {
                u32::try_from(index)?
            } else {
                let ordinal = u32::try_from(inputs.imports.len())?;
                inputs.imports.push(PlannedImport {
                    module: "env".into(),
                    name: "memory".into(),
                    ty: EntityType::Memory(MemoryType {
                        minimum: 0,
                        maximum: Some(65536),
                        memory64: false,
                        shared: true,
                        page_size_log2: None,
                    }),
                });
                ordinal
            };
            inputs.staging_memory = Some(ordinal);
        }
        let pointer = inputs
            .process_memory_binding(scan)?
            .context("root state needs process memory")?
            .pointer;
        let i = ValType::I32;
        let base = scan.types.as_ref().core_type_count_in_module();
        let mut functions = [0; 3];
        for (ordinal, (name, params, results)) in [
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_RESERVE,
                vec![i, i, i, pointer],
                vec![pointer],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_COMMIT,
                vec![pointer],
                vec![],
            ),
            (
                abi::WPK_FORK_MODULE_STATE_IMPORT_RECORD_FIND,
                vec![i, i, i, i],
                vec![pointer],
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let index = if let Some(index) = inputs
                .types
                .iter()
                .position(|ty| ty.params() == params && ty.results() == results)
            {
                base.checked_add(u32::try_from(index)?)
                    .context("root import type index overflow")?
            } else {
                ensure!(
                    inputs.types.len() < budget / 128,
                    "root import types exceed metadata budget"
                );
                let index = base
                    .checked_add(u32::try_from(inputs.types.len())?)
                    .context("root import type index overflow")?;
                inputs.types.push(FuncType::new(params, results));
                index
            };
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
            source: Sha256::digest(scan.input()).into(),
        })
    }
    pub(super) fn freeze(&self, imports: &FrozenImports) -> Result<RecordHost> {
        ensure!(
            self.source == imports.source_identity(),
            "root imports belong to another source module"
        );
        let index = |ordinal| {
            imports
                .index(ordinal)
                .context("root record import was not frozen")
        };
        Ok(RecordHost {
            reserve: index(self.functions[0])?,
            commit: index(self.functions[1])?,
            find: index(self.functions[2])?,
        })
    }
}
