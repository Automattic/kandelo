//! Immutable helper declarations shared by planning and serial emission.

use anyhow::{Context, Result, ensure};
use wasm_encoder::{Encode, FuncType, FunctionSection, TypeSection};

/// All indices in these declarations are final output indices. Additional
/// function types follow the reencoded source types; helpers follow the
/// reencoded source functions. Function bodies are generated one at a time.
/// There is no API for declaring another helper during emission.
#[derive(Clone, Debug)]
pub struct FrozenDeclarations {
    types: Vec<FuncType>,
    functions: Vec<u32>,
    estimated_bytes: usize,
}

impl FrozenDeclarations {
    pub fn new(types: Vec<FuncType>, functions: Vec<u32>, metadata_budget: usize) -> Result<Self> {
        let estimated_bytes = Self::validate_parts(&types, &functions, metadata_budget)?;
        Ok(Self {
            types,
            functions,
            estimated_bytes,
        })
    }
    pub(super) fn validate_parts(
        types: &[FuncType],
        functions: &[u32],
        metadata_budget: usize,
    ) -> Result<usize> {
        // Check before encoding/cloning. A reference type uses at most a
        // prefix plus a signed 33-bit heap index in the binary encoding.
        let values = types
            .iter()
            .try_fold(0usize, |n, ty| {
                n.checked_add(ty.params().len())?
                    .checked_add(ty.results().len())
            })
            .context("helper type size overflow")?;
        let estimate = values
            .checked_mul(8)
            .and_then(|n| n.checked_add(types.len().checked_mul(16)?))
            .and_then(|n| n.checked_add(functions.len().checked_mul(5)?))
            .context("helper declaration size overflow")?;
        ensure!(
            estimate <= metadata_budget,
            "helper declarations exceed metadata budget"
        );
        u32::try_from(types.len()).context("too many helper types")?;
        u32::try_from(functions.len()).context("too many helper functions")?;
        Ok(estimate)
    }

    pub fn function_count(&self) -> u32 {
        self.functions.len() as u32
    }
    /// Concatenate catalogs planned in this order with already-final type and
    /// function identities. No indices are assigned or remapped at emission.
    pub fn concatenate(parts: &[&Self], metadata_budget: usize) -> Result<Self> {
        let mut estimate = 0usize;
        let mut ntypes = 0usize;
        let mut nfunctions = 0usize;
        for part in parts {
            estimate = estimate
                .checked_add(part.estimated_bytes)
                .context("combined helper metadata overflow")?;
            ntypes = ntypes
                .checked_add(part.types.len())
                .context("combined helper type count overflow")?;
            nfunctions = nfunctions
                .checked_add(part.functions.len())
                .context("combined helper count overflow")?;
        }
        ensure!(
            estimate <= metadata_budget,
            "combined helper declarations exceed metadata budget"
        );
        u32::try_from(ntypes)?;
        u32::try_from(nfunctions)?;
        let mut types = Vec::with_capacity(ntypes);
        let mut functions = Vec::with_capacity(nfunctions);
        for part in parts {
            types.extend(part.types.iter().cloned());
            functions.extend_from_slice(&part.functions);
        }
        Self::new(types, functions, metadata_budget)
    }
    pub fn type_count(&self) -> u32 {
        self.types.len() as u32
    }
    pub fn function_type(&self, helper: u32) -> Option<u32> {
        self.functions.get(helper as usize).copied()
    }

    pub(super) fn append_types(&self, section: &mut TypeSection) {
        for ty in &self.types {
            section
                .ty()
                .function(ty.params().iter().copied(), ty.results().iter().copied());
        }
    }

    pub(super) fn append_functions(&self, section: &mut FunctionSection) {
        for &ty in &self.functions {
            section.function(ty);
        }
    }

    pub(super) fn check_budget(&self, budget: usize) -> Result<()> {
        ensure!(
            self.estimated_bytes <= budget,
            "helper declarations exceed metadata budget"
        );
        let mut types = TypeSection::new();
        self.append_types(&mut types);
        let mut functions = FunctionSection::new();
        self.append_functions(&mut functions);
        let mut bytes = Vec::new();
        types.encode(&mut bytes);
        functions.encode(&mut bytes);
        ensure!(
            bytes.len() <= budget,
            "helper declarations exceed metadata budget"
        );
        Ok(())
    }
}
