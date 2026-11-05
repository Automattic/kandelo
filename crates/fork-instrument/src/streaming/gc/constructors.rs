use super::*;
use wasmparser::Operator;

impl NativeGcPlan {
    pub(super) fn discover_constructors(
        &mut self,
        scan: &Scan<'_>,
        ir: IrLimits,
        budget: &mut Budget,
    ) -> Result<()> {
        if !self
            .layouts
            .iter()
            .any(|layout| layout.kind == NativeGcKind::Array && layout.requires_provenance)
        {
            return Ok(());
        }
        let mut provider = scan.body_provider(ir);
        for (function, summary) in scan.functions.iter().enumerate() {
            budget.step(1)?;
            let Some(summary) = &summary.body else {
                continue;
            };
            budget.step(
                usize::try_from(summary.operators).context("GC constructor work overflow")?,
            )?;
            let body = provider.load(u32::try_from(function)?)?;
            for source in body.instructions.iter().filter(|source| source.retained) {
                let (ty, constructor) = match source.operation {
                    Operator::ArrayNew { array_type_index } => {
                        (array_type_index, NativeGcConstructor::ArrayNew)
                    }
                    Operator::ArrayNewDefault { array_type_index } => {
                        (array_type_index, NativeGcConstructor::ArrayDefault)
                    }
                    Operator::ArrayNewFixed {
                        array_type_index,
                        array_size,
                    } => (
                        array_type_index,
                        NativeGcConstructor::ArrayFixed { len: array_size },
                    ),
                    Operator::ArrayNewData {
                        array_type_index,
                        array_data_index,
                    } => (
                        array_type_index,
                        NativeGcConstructor::ArrayData {
                            segment_ordinal: array_data_index,
                        },
                    ),
                    Operator::ArrayNewElem {
                        array_type_index,
                        array_elem_index,
                    } => (
                        array_type_index,
                        NativeGcConstructor::ArrayElement {
                            segment_ordinal: array_elem_index,
                        },
                    ),
                    _ => continue,
                };
                let base = self
                    .base_layout(ty)
                    .context("GC constructor has no source layout")?;
                if !base.requires_provenance
                    || self.constructors.contains_key(&(base.id, constructor))
                {
                    continue;
                }
                // Only array variants copy fields, and each array has exactly
                // one element field. Repeated sites retain no additional data.
                budget.charge(640)?;
                let mut layout = base.clone();
                layout.id = self.next_id()?;
                layout.constructor = constructor;
                let (scalars, references) = provenance(constructor, &layout.fields[0]);
                layout.provenance_scalar_len = scalars;
                layout.provenance_reference_count = references;
                self.constructors
                    .insert((base.id, constructor), self.layouts.len());
                self.layouts.push(layout);
            }
        }
        Ok(())
    }
}

fn provenance(constructor: NativeGcConstructor, field: &NativeGcField) -> (u32, u32) {
    match constructor {
        NativeGcConstructor::ArrayNew => match field.field.element_type {
            StorageType::Val(ValType::Ref(_)) if field.class == Some(NativeReferenceClass::Any) => {
                (0, 1)
            }
            StorageType::Val(ValType::Ref(_)) => (0, 0),
            scalar => (storage_size(scalar), 0),
        },
        NativeGcConstructor::ArrayFixed { len } if super::layouts::needs_seed(field) => (0, len),
        NativeGcConstructor::ArrayData { .. } | NativeGcConstructor::ArrayElement { .. } => (8, 0),
        _ => (0, 0),
    }
}
