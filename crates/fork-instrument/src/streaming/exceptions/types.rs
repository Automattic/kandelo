//! Bounded signature interning; many distinct tags must not trigger a scan of
//! every earlier helper type for each new capture block.
use super::*;
use std::collections::BTreeMap;

pub(super) struct TypeCatalog {
    base: u32,
    types: Vec<FuncType>,
    indices: BTreeMap<(Vec<ValType>, Vec<ValType>), u32>,
    remaining: usize,
}
impl TypeCatalog {
    pub fn new(base: u32, budget: usize) -> Self {
        Self {
            base,
            types: Vec::new(),
            indices: BTreeMap::new(),
            remaining: budget,
        }
    }
    pub fn intern(&mut self, params: &[ValType], results: &[ValType]) -> Result<u32> {
        let cost = params
            .len()
            .checked_add(results.len())
            .and_then(|n| n.checked_mul(64))
            .and_then(|n| n.checked_add(256))
            .context("exception type metadata overflow")?;
        ensure!(
            cost <= self.remaining,
            "exception types exceed metadata budget"
        );
        let key = (params.to_vec(), results.to_vec());
        if let Some(&index) = self.indices.get(&key) {
            return Ok(index);
        }
        self.remaining -= cost;
        let index = self
            .base
            .checked_add(u32::try_from(self.types.len())?)
            .context("exception type index overflow")?;
        self.types.push(FuncType::new(
            params.iter().copied(),
            results.iter().copied(),
        ));
        self.indices.insert(key, index);
        Ok(index)
    }
    pub fn finish(self) -> Vec<FuncType> {
        self.types
    }
}
