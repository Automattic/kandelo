//! Scalar-only host dependencies reserved before runtime import freezing.
use super::*;
use crate::streaming::imports::{ImmutableGlobalImport, immutable_i32_import};

pub struct NativeExceptionImports {
    memory: Option<crate::streaming::memory::ProcessMemory>,
    activation: ImmutableGlobalImport,
    functions: [u32; 11],
}
#[derive(Clone, Copy)]
pub(super) struct ExceptionHost {
    pub activation: u32,
    pub lookup: u32,
    pub claim: u32,
    pub define: u32,
    pub load: u32,
    pub route: u32,
    pub cache_index: u32,
    pub broker_encode: u32,
    pub broker_throw: u32,
    pub ingress_throw: u32,
    pub reserve: u32,
    pub release: u32,
}
impl NativeExceptionImports {
    pub fn append(scan: &Scan<'_>, inputs: &mut RuntimeInputs, budget: usize) -> Result<Self> {
        ensure!(
            inputs
                .imports
                .len()
                .checked_add(12)
                .is_some_and(|count| count <= budget / 256),
            "exception imports exceed metadata budget"
        );
        let memory = inputs.process_memory_binding(scan)?;
        let pointer = memory.map_or(ValType::I32, |memory| memory.pointer);
        let activation = immutable_i32_import(
            scan,
            &mut inputs.imports,
            abi::HOST_IMPORT_MODULE,
            abi::IMPORT_ACTIVATION,
        )?;
        let mut functions = [0; 11];
        let i = ValType::I32;
        let transfer = vec![i, i, i, i, pointer, i, pointer, i];
        for (ordinal, (name, params, results)) in [
            (abi::IMPORT_LOOKUP, vec![i], vec![i]),
            (abi::IMPORT_CLAIM, vec![i], vec![i]),
            (abi::IMPORT_DEFINE, transfer.clone(), vec![]),
            (abi::IMPORT_LOAD, transfer, vec![i]),
            (abi::IMPORT_ROUTE, vec![i, i], vec![i]),
            (abi::IMPORT_CACHE_INDEX, vec![i], vec![i]),
            (abi::IMPORT_BROKER_ENCODE, vec![i], vec![i]),
            (abi::IMPORT_BROKER_THROW_RECIPE, vec![i], vec![]),
            (abi::IMPORT_INGRESS_THROW, vec![i], vec![]),
            (abi::IMPORT_SCRATCH_RESERVE, vec![pointer], vec![pointer]),
            (abi::IMPORT_SCRATCH_RELEASE, vec![pointer, pointer], vec![]),
        ]
        .into_iter()
        .enumerate()
        {
            ensure!(
                inputs.imports.len() < budget / 256,
                "exception imports exceed metadata budget"
            );
            let ty = type_index(
                &mut inputs.types,
                scan.types.as_ref().core_type_count_in_module(),
                &params,
                &results,
                budget,
            )?;
            functions[ordinal] = u32::try_from(inputs.imports.len())?;
            inputs.imports.push(PlannedImport {
                module: abi::HOST_IMPORT_MODULE.into(),
                name: name.into(),
                ty: EntityType::Function(ty),
            });
        }
        Ok(Self {
            memory,
            activation,
            functions,
        })
    }
    pub(super) fn resolve(&self, imports: &FrozenImports) -> Result<ExceptionHost> {
        let index = |ordinal| {
            imports
                .index(ordinal)
                .context("exception import was not frozen")
        };
        Ok(ExceptionHost {
            activation: self.activation.resolve(imports)?,
            lookup: index(self.functions[0])?,
            claim: index(self.functions[1])?,
            define: index(self.functions[2])?,
            load: index(self.functions[3])?,
            route: index(self.functions[4])?,
            cache_index: index(self.functions[5])?,
            broker_encode: index(self.functions[6])?,
            broker_throw: index(self.functions[7])?,
            ingress_throw: index(self.functions[8])?,
            reserve: index(self.functions[9])?,
            release: index(self.functions[10])?,
        })
    }
    pub(super) fn process_memory(&self, imports: &FrozenImports) -> Result<(u32, ValType)> {
        let memory = self
            .memory
            .context("exception codec needs process memory")?;
        Ok((memory.resolve(imports)?, memory.pointer))
    }
}
