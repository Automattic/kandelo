use super::*;
use wasm_encoder::FuncType;

pub(in crate::streaming::gc) struct Signatures {
    indices: BTreeMap<(Vec<ValType>, Vec<ValType>), u32>,
    base: u32,
}
impl Signatures {
    pub fn new(scan: &Scan<'_>, inputs: &RuntimeInputs, budget: &mut Budget) -> Result<Self> {
        let mut output = Self {
            indices: BTreeMap::new(),
            base: scan.types.as_ref().core_type_count_in_module(),
        };
        for (ordinal, ty) in inputs.types.iter().enumerate() {
            let values = ty
                .params()
                .len()
                .checked_add(ty.results().len())
                .context("GC prefix type size overflow")?;
            budget.charge(
                values
                    .checked_mul(64)
                    .and_then(|n| n.checked_add(256))
                    .context("GC prefix metadata overflow")?,
            )?;
            budget.step(values.saturating_add(1))?;
            output.indices.insert(
                (ty.params().to_vec(), ty.results().to_vec()),
                output
                    .base
                    .checked_add(u32::try_from(ordinal)?)
                    .context("GC prototype type index overflow")?,
            );
        }
        Ok(output)
    }
    pub fn intern(
        &mut self,
        inputs: &mut RuntimeInputs,
        params: Vec<ValType>,
        results: Vec<ValType>,
    ) -> Result<u32> {
        let key = (params, results);
        if let Some(&index) = self.indices.get(&key) {
            return Ok(index);
        }
        let index = self
            .base
            .checked_add(u32::try_from(inputs.types.len())?)
            .context("GC prototype type index overflow")?;
        inputs
            .types
            .push(FuncType::new(key.0.iter().copied(), key.1.iter().copied()));
        self.indices.insert(key, index);
        Ok(index)
    }
    /// Reuse scalar host bindings reserved by another provider catalog.
    pub fn import(
        &mut self,
        inputs: &mut RuntimeInputs,
        module: &str,
        name: &str,
        params: Vec<ValType>,
        results: Vec<ValType>,
        budget: usize,
    ) -> Result<u32> {
        let ty = self.intern(inputs, params, results)?;
        if let Some((ordinal, existing)) = inputs
            .imports
            .iter()
            .enumerate()
            .find(|(_, import)| import.module == module && import.name == name)
        {
            let compatible = match existing.ty {
                wasm_encoder::EntityType::Function(previous) => {
                    previous == ty || {
                        let signature = |index: u32| {
                            index
                                .checked_sub(self.base)
                                .and_then(|index| inputs.types.get(index as usize))
                        };
                        signature(previous).is_some_and(|previous| Some(previous) == signature(ty))
                    }
                }
                _ => false,
            };
            ensure!(
                compatible,
                "GC host import {module}.{name} has an incompatible type"
            );
            return Ok(u32::try_from(ordinal)?);
        }
        ensure!(
            inputs.imports.len() < budget / 512,
            "GC imports exceed metadata budget"
        );
        let ordinal = u32::try_from(inputs.imports.len())?;
        inputs.imports.push(crate::streaming::PlannedImport {
            module: module.into(),
            name: name.into(),
            ty: wasm_encoder::EntityType::Function(ty),
        });
        Ok(ordinal)
    }
}
pub(super) fn parameter_count(layout: &NativeGcLayout) -> Result<usize> {
    Ok(match layout.constructor {
        NativeGcConstructor::Struct => layout.fields.len(),
        NativeGcConstructor::ArrayNew
        | NativeGcConstructor::ArrayData { .. }
        | NativeGcConstructor::ArrayElement { .. } => 2,
        NativeGcConstructor::ArrayDefault => 1,
        NativeGcConstructor::ArrayFixed { len } => usize::try_from(len)?,
        NativeGcConstructor::ArrayGeneric => {
            anyhow::bail!("generic arrays have no constructor wrapper")
        }
    })
}
pub(super) fn parameters(layout: &NativeGcLayout, count: usize) -> Vec<ValType> {
    let unpack = |storage| match storage {
        StorageType::I8 | StorageType::I16 => ValType::I32,
        StorageType::Val(value) => value,
    };
    match layout.constructor {
        NativeGcConstructor::Struct => layout
            .fields
            .iter()
            .map(|field| unpack(field.field.element_type))
            .collect(),
        NativeGcConstructor::ArrayNew => {
            vec![unpack(layout.fields[0].field.element_type), ValType::I32]
        }
        NativeGcConstructor::ArrayDefault => vec![ValType::I32],
        NativeGcConstructor::ArrayData { .. } | NativeGcConstructor::ArrayElement { .. } => {
            vec![ValType::I32, ValType::I32]
        }
        NativeGcConstructor::ArrayFixed { .. } => {
            vec![unpack(layout.fields[0].field.element_type); count]
        }
        NativeGcConstructor::ArrayGeneric => unreachable!(),
    }
}
