use super::super::provenance::{
    imports::{ProvenanceHost, ProvenanceImports},
    signatures::Signatures,
};
use super::*;
use crate::{module_exception_codec as exception, module_gc_codec as abi};

pub(super) struct GcImports {
    provenance: ProvenanceImports,
    functions: [u32; 11],
}
#[derive(Clone, Copy)]
pub(super) struct GcHost {
    pub activation: u32,
    pub transit: u32,
    pub lookup: u32,
    pub claim: u32,
    pub i31: u32,
    pub define: u32,
    pub route: u32,
    pub payload_len: u32,
    pub load: u32,
    pub broker: u32,
    pub capture: u32,
    pub reserve: u32,
    pub release: u32,
    pub provenance: ProvenanceHost,
}
impl GcImports {
    pub fn reserve(
        scan: &Scan<'_>,
        inputs: &mut RuntimeInputs,
        signatures: &mut Signatures,
        budget: usize,
    ) -> Result<Self> {
        let provenance = ProvenanceImports::reserve(scan, inputs, signatures, budget)?;
        let pointer = if scan.types.as_ref().memory_at(0).memory64 {
            ValType::I64
        } else {
            ValType::I32
        };
        let i = ValType::I32;
        let mut functions = [0; 11];
        for (ordinal, (name, params, results)) in [
            (abi::IMPORT_LOOKUP, vec![i], vec![i]),
            (abi::IMPORT_CLAIM, vec![i], vec![i]),
            (abi::IMPORT_I31, vec![i], vec![i]),
            (
                abi::IMPORT_DEFINE,
                vec![i, i, i, i, i, pointer, i, i],
                vec![],
            ),
            (abi::IMPORT_ROUTE, vec![i, i], vec![i]),
            (abi::IMPORT_PAYLOAD_LEN, vec![i, i, i], vec![i]),
            (abi::IMPORT_LOAD, vec![i, i, i, i, i, pointer, i], vec![i]),
            (abi::IMPORT_BROKER_ENCODE, vec![i], vec![i]),
            (abi::IMPORT_CAPTURE_LAYOUT, vec![i, i, i], vec![i]),
            (
                exception::IMPORT_SCRATCH_RESERVE,
                vec![pointer],
                vec![pointer],
            ),
            (
                exception::IMPORT_SCRATCH_RELEASE,
                vec![pointer, pointer],
                vec![],
            ),
        ]
        .into_iter()
        .enumerate()
        {
            functions[ordinal] = signatures.import(
                inputs,
                abi::HOST_IMPORT_MODULE,
                name,
                params,
                results,
                budget,
            )?;
        }
        Ok(Self {
            provenance,
            functions,
        })
    }
    pub fn freeze(self, imports: &FrozenImports) -> Result<GcHost> {
        let mut functions = [0; 11];
        for (output, ordinal) in functions.iter_mut().zip(self.functions) {
            *output = imports
                .index(ordinal)
                .context("GC host import was not frozen")?;
        }
        let provenance = self.provenance.freeze(imports)?;
        Ok(GcHost {
            activation: provenance.activation,
            transit: provenance.transit,
            lookup: functions[0],
            claim: functions[1],
            i31: functions[2],
            define: functions[3],
            route: functions[4],
            payload_len: functions[5],
            load: functions[6],
            broker: functions[7],
            capture: functions[8],
            reserve: functions[9],
            release: functions[10],
            provenance,
        })
    }
}
