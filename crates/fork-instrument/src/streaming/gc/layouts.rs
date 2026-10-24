use super::*;
use wasm_encoder::{AbstractHeapType, HeapType};

pub(super) fn base_layout<T: Reencode>(
    source: u32,
    definition: wasmparser::SubType,
    id: u32,
    types: &SourceTypes,
    map: &mut T,
    kinds: &FrozenReferenceKinds,
    budget: &mut Budget,
) -> Result<NativeGcLayout>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let (kind, raw_fields) = match definition.composite_type.inner {
        wasmparser::CompositeInnerType::Struct(structure) => {
            (NativeGcKind::Struct, structure.fields.into_vec())
        }
        wasmparser::CompositeInnerType::Array(array) => (NativeGcKind::Array, vec![array.0]),
        _ => anyhow::bail!("expected original GC type"),
    };
    budget.charge(
        raw_fields
            .len()
            .checked_mul(128)
            .and_then(|n| n.checked_add(512))
            .context("GC field metadata overflow")?,
    )?;
    let mut scalar_len = 0u32;
    let mut reference_count = 0u32;
    let mut fields = Vec::with_capacity(raw_fields.len());
    for field in raw_fields {
        budget.step(1)?;
        let storage = match field.element_type {
            wasmparser::StorageType::I8 => StorageType::I8,
            wasmparser::StorageType::I16 => StorageType::I16,
            wasmparser::StorageType::Val(ty) => StorageType::Val(types.value_type(map, ty)?),
        };
        let (class, scalar_offset, reference_ordinal, allocation_dependency) =
            if let StorageType::Val(ValType::Ref(reference)) = storage {
                let ordinal = reference_count;
                reference_count = reference_count
                    .checked_add(1)
                    .context("GC reference layout overflow")?;
                (
                    Some(kinds.class(reference)?),
                    None,
                    Some(ordinal),
                    !field.mutable
                        && !matches!(
                            reference.heap_type,
                            HeapType::Abstract {
                                ty: AbstractHeapType::None,
                                ..
                            }
                        ),
                )
            } else {
                let size = storage_size(storage);
                let aligned = scalar_len
                    .checked_add(size - 1)
                    .context("GC scalar alignment overflow")?
                    & !(size - 1);
                scalar_len = aligned
                    .checked_add(size)
                    .context("GC scalar layout overflow")?;
                (None, Some(aligned), None, false)
            };
        fields.push(NativeGcField {
            field: FieldType {
                element_type: storage,
                mutable: field.mutable,
            },
            class,
            scalar_offset,
            reference_ordinal,
            allocation_dependency,
        });
    }
    let defaultable_shell = fields
        .iter()
        .all(|field| field.field.mutable && defaultable(field));
    let provenance_reference_count = if kind == NativeGcKind::Struct {
        u32::try_from(fields.iter().filter(|field| needs_seed(field)).count())?
    } else {
        0
    };
    let requires_provenance = match kind {
        NativeGcKind::Struct => provenance_reference_count != 0,
        NativeGcKind::Array => !fields[0].field.mutable || !defaultable(&fields[0]),
    };
    Ok(NativeGcLayout {
        id,
        source_type: source,
        type_index: map.type_index(source)?,
        type_ordinal: id - 1,
        base_layout_id: id,
        kind,
        constructor: if kind == NativeGcKind::Struct {
            NativeGcConstructor::Struct
        } else {
            NativeGcConstructor::ArrayGeneric
        },
        scalar_len_or_stride: scalar_len,
        fields,
        super_type_ordinal: None,
        subtype_depth: 0,
        defaultable_shell,
        requires_provenance,
        provenance_scalar_len: 0,
        provenance_reference_count,
    })
}
fn defaultable(field: &NativeGcField) -> bool {
    !matches!(field.field.element_type, StorageType::Val(ValType::Ref(reference)) if !reference.nullable)
}
pub(super) fn needs_seed(field: &NativeGcField) -> bool {
    field.field.mutable
        && field.class == Some(NativeReferenceClass::Any)
        && matches!(field.field.element_type, StorageType::Val(ValType::Ref(reference)) if !reference.nullable)
}
impl NativeGcPlan {
    pub(super) fn resolve_inheritance(
        &mut self,
        source_parents: &[Option<u32>],
        budget: &mut Budget,
    ) -> Result<()> {
        let count = self.layouts.len();
        budget.charge(
            count
                .checked_mul(32)
                .context("GC inheritance metadata overflow")?,
        )?;
        let parents = source_parents
            .iter()
            .map(|parent| {
                parent
                    .map(|source| {
                        self.bases
                            .get(&source)
                            .copied()
                            .context("GC parent has no source layout")
                    })
                    .transpose()
            })
            .collect::<Result<Vec<_>>>()?;
        let mut depths = vec![None::<u32>; count];
        let mut trail = Vec::new();
        for first in 0..count {
            if depths[first].is_some() {
                continue;
            }
            let mut current = first;
            loop {
                budget.step(1)?;
                if depths[current].is_some() {
                    break;
                }
                ensure!(trail.len() < count, "cyclic GC supertype chain");
                trail.push(current);
                let Some(parent) = parents[current] else {
                    break;
                };
                current = parent;
            }
            while let Some(index) = trail.pop() {
                budget.step(1)?;
                depths[index] = Some(if let Some(parent) = parents[index] {
                    depths[parent]
                        .context("unresolved GC supertype")?
                        .checked_add(1)
                        .context("GC subtype depth overflow")?
                } else {
                    0
                });
            }
        }
        for (index, layout) in self.layouts.iter_mut().enumerate() {
            layout.subtype_depth = depths[index].unwrap();
            layout.super_type_ordinal = parents[index].map(|parent| parent as u32);
        }
        Ok(())
    }
}
