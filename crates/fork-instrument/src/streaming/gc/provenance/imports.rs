use super::*;
use crate::{
    module_gc_codec as abi,
    streaming::{
        PlannedImport,
        imports::{ImmutableGlobalImport, immutable_i32_import},
    },
};
use wasm_encoder::{EntityType, TableType};

pub(in crate::streaming::gc) struct ProvenanceImports {
    activation: ImmutableGlobalImport,
    transit: u32,
    begin: u32,
    reference: u32,
    end: u32,
}
#[derive(Clone, Copy)]
pub(in crate::streaming::gc) struct ProvenanceHost {
    pub activation: u32,
    pub transit: u32,
    pub begin: u32,
    pub reference: u32,
    pub end: u32,
}
impl ProvenanceImports {
    pub fn reserve(
        scan: &Scan<'_>,
        inputs: &mut RuntimeInputs,
        signatures: &mut signatures::Signatures,
        budget: usize,
    ) -> Result<Self> {
        ensure!(
            inputs
                .imports
                .len()
                .checked_add(5)
                .is_some_and(|count| count <= budget / 512),
            "GC provenance imports exceed metadata budget"
        );
        let activation = immutable_i32_import(
            scan,
            &mut inputs.imports,
            abi::HOST_IMPORT_MODULE,
            wasm_posix_program_abi::abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
        )?;
        let transit = if let Some((ordinal, import)) =
            inputs.imports.iter().enumerate().find(|(_, import)| {
                import.module == abi::HOST_IMPORT_MODULE && import.name == abi::IMPORT_TRANSIT_TABLE
            }) {
            ensure!(
                matches!(import.ty, EntityType::Table(table) if table.element_type == RefType::ANYREF && !table.table64 && !table.shared && table.minimum >= 1),
                "GC transit import has an incompatible type"
            );
            u32::try_from(ordinal)?
        } else {
            let ordinal = u32::try_from(inputs.imports.len())?;
            inputs.imports.push(PlannedImport {
                module: abi::HOST_IMPORT_MODULE.into(),
                name: abi::IMPORT_TRANSIT_TABLE.into(),
                ty: EntityType::Table(TableType {
                    element_type: RefType::ANYREF,
                    minimum: 1,
                    maximum: None,
                    table64: false,
                    shared: false,
                }),
            });
            ordinal
        };
        let i = ValType::I32;
        let mut indices = Vec::new();
        for (name, params, results) in [
            (
                abi::IMPORT_PROVENANCE_BEGIN,
                vec![i, i, i, i, ValType::I64, ValType::I64, i],
                vec![i],
            ),
            (abi::IMPORT_PROVENANCE_REF, vec![i, i, i], vec![]),
            (abi::IMPORT_PROVENANCE_END, vec![i], vec![]),
        ] {
            indices.push(signatures.import(
                inputs,
                abi::HOST_IMPORT_MODULE,
                name,
                params,
                results,
                budget,
            )?);
        }
        Ok(Self {
            activation,
            transit,
            begin: indices[0],
            reference: indices[1],
            end: indices[2],
        })
    }
    pub fn freeze(self, imports: &FrozenImports) -> Result<ProvenanceHost> {
        let index = |ordinal| {
            imports
                .index(ordinal)
                .context("GC provenance import was not frozen")
        };
        Ok(ProvenanceHost {
            activation: self.activation.resolve(imports)?,
            transit: index(self.transit)?,
            begin: index(self.begin)?,
            reference: index(self.reference)?,
            end: index(self.end)?,
        })
    }
}
