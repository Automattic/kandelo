//! Map validator-canonical heap identities back to source module type indices
//! before applying the frozen output mapping. Canonical IDs are not Wasm
//! binary indices, particularly when duplicate recursive types are interned.

use super::Scan;
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use wasm_encoder::reencode::Reencode;
use wasmparser::{HeapType, RefType, UnpackedIndex, ValType, types::CoreTypeId};

pub struct SourceTypes {
    canonical: BTreeMap<CoreTypeId, u32>,
}

impl SourceTypes {
    pub fn new(scan: &Scan<'_>) -> Self {
        let types = scan.types.as_ref();
        let mut canonical = BTreeMap::new();
        for index in 0..types.core_type_count_in_module() {
            canonical
                .entry(types.core_type_at_in_module(index))
                .or_insert(index);
        }
        Self { canonical }
    }

    pub fn source_index(&self, index: UnpackedIndex) -> Result<u32> {
        match index {
            UnpackedIndex::Module(index) => Ok(index),
            UnpackedIndex::Id(id) => self
                .canonical
                .get(&id)
                .copied()
                .context("canonical heap type has no source declaration"),
            UnpackedIndex::RecGroup(_) => {
                anyhow::bail!("a function value type cannot use a recursion-group-relative index")
            }
        }
    }

    pub fn value_type<T: Reencode + ?Sized>(
        &self,
        map: &mut T,
        ty: ValType,
    ) -> Result<wasm_encoder::ValType>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let ty = if let ValType::Ref(reference) = ty {
            let heap = match reference.heap_type() {
                HeapType::Concrete(i) => {
                    HeapType::Concrete(UnpackedIndex::Module(self.source_index(i)?))
                }
                HeapType::Exact(i) => HeapType::Exact(UnpackedIndex::Module(self.source_index(i)?)),
                heap => heap,
            };
            ValType::Ref(
                RefType::new(reference.is_nullable(), heap)
                    .context("source heap index exceeds reference encoding")?,
            )
        } else {
            ty
        };
        Ok(map.val_type(ty)?)
    }
}
