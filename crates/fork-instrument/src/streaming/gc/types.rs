//! One layout per actual Wasm GC type. Recursive-group membership is part of
//! canonical type identity: shallow structural interning can both merge
//! distinct runtime types and keep equivalent recursive types separate.
use super::*;
use wasmparser::{CompositeInnerType, UnpackedIndex};

pub(super) struct OriginalGcType {
    pub source: u32,
    pub parent: Option<u32>,
    pub definition: wasmparser::SubType,
}
pub(super) struct OriginalGcTypes {
    pub identities: Vec<u32>,
    pub types: Vec<OriginalGcType>,
}
impl OriginalGcTypes {
    pub fn read(
        scan: &Scan<'_>,
        source_types: &SourceTypes,
        limits: GcPlanLimits,
        budget: &mut Budget,
    ) -> Result<Self> {
        let types = scan.types.as_ref();
        let count = types.core_type_count_in_module();
        budget.step(count as usize)?;
        let has_gc = (0..count).any(|index| {
            matches!(
                types
                    .get(types.core_type_at_in_module(index))
                    .unwrap()
                    .composite_type
                    .inner,
                CompositeInnerType::Struct(_) | CompositeInnerType::Array(_)
            )
        });
        if !has_gc {
            return Ok(Self {
                identities: Vec::new(),
                types: Vec::new(),
            });
        }
        let mut temporary = Budget::new(limits);
        temporary.charge(
            (count as usize)
                .checked_mul(8)
                .context("GC identity metadata overflow")?,
        )?;
        let mut output = Self {
            identities: Vec::with_capacity(count as usize),
            types: Vec::new(),
        };
        for index in 0..count {
            let id = types.core_type_at_in_module(index);
            let ty = types.get(id).unwrap();
            let fields = match &ty.composite_type.inner {
                CompositeInnerType::Struct(structure) => structure.fields.len(),
                CompositeInnerType::Array(_) => 1,
                _ => {
                    output.identities.push(u32::MAX);
                    continue;
                }
            };
            let identity = source_types.source_index(UnpackedIndex::Id(id))?;
            output.identities.push(identity);
            if identity != index {
                continue;
            }
            // The validator already owns the type graph. Copy only the unique
            // GC declarations, after charging their field vectors; never
            // decode another raw module-wide type arena or recursive group.
            temporary.charge(
                fields
                    .checked_mul(128)
                    .and_then(|n| n.checked_add(512))
                    .context("GC source type size overflow")?,
            )?;
            budget.step(fields)?;
            let parent = ty
                .supertype_idx
                .map(|index| source_types.source_index(index.unpack()))
                .transpose()?;
            output.types.push(OriginalGcType {
                source: index,
                parent,
                definition: ty.clone(),
            });
        }
        Ok(output)
    }
}
