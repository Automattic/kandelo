//! Existing wire descriptor, independent of helper indices and arena IDs.
use super::*;
use crate::module_gc_codec as abi;

impl NativeGcConstructor {
    fn wire(self) -> u8 {
        match self {
            Self::Struct => abi::CONSTRUCTOR_STRUCT,
            Self::ArrayGeneric => abi::CONSTRUCTOR_ARRAY_GENERIC,
            Self::ArrayNew => abi::CONSTRUCTOR_ARRAY_NEW,
            Self::ArrayDefault => abi::CONSTRUCTOR_ARRAY_DEFAULT,
            Self::ArrayFixed { .. } => abi::CONSTRUCTOR_ARRAY_FIXED,
            Self::ArrayData { .. } => abi::CONSTRUCTOR_ARRAY_DATA,
            Self::ArrayElement { .. } => abi::CONSTRUCTOR_ARRAY_ELEMENT,
        }
    }
}
impl NativeGcPlan {
    pub fn descriptor(&self) -> Result<Vec<u8>> {
        let count = self
            .layouts
            .iter()
            .try_fold(0usize, |count, layout| {
                count.checked_add(layout.fields.len())
            })
            .context("GC descriptor field count overflow")?;
        let length = self
            .layouts
            .len()
            .checked_mul(usize::from(abi::FORMAT_LAYOUT_RECORD_SIZE))
            .and_then(|n| {
                n.checked_add(count.checked_mul(usize::from(abi::FORMAT_FIELD_RECORD_SIZE))?)
            })
            .and_then(|n| n.checked_add(usize::from(abi::FORMAT_HEADER_SIZE)))
            .context("GC descriptor size overflow")?;
        ensure!(
            length <= self.metadata_budget,
            "GC descriptor exceeds metadata budget"
        );
        let mut bytes = Vec::with_capacity(length);
        bytes.extend_from_slice(&abi::FORMAT_MAGIC);
        bytes.extend_from_slice(&abi::FORMAT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&abi::FORMAT_HEADER_SIZE.to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(self.layouts.len())?.to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(count)?.to_le_bytes());
        let mut start = 0u32;
        for layout in &self.layouts {
            let flags = if layout.requires_provenance {
                abi::LAYOUT_FLAG_REQUIRES_PROVENANCE
            } else {
                0
            } | if layout.defaultable_shell {
                abi::LAYOUT_FLAG_DEFAULTABLE_SHELL
            } else {
                0
            };
            word(&mut bytes, layout.id);
            word(&mut bytes, layout.type_ordinal);
            bytes.push(match layout.kind {
                NativeGcKind::Struct => abi::KIND_STRUCT,
                NativeGcKind::Array => abi::KIND_ARRAY,
            });
            bytes.push(layout.constructor.wire());
            bytes.extend_from_slice(&flags.to_le_bytes());
            for value in [
                layout.scalar_len_or_stride,
                start,
                u32::try_from(layout.fields.len())?,
                layout.super_type_ordinal.unwrap_or(u32::MAX),
                layout.base_layout_id,
                layout.constructor.auxiliary(),
                layout.provenance_scalar_len,
                layout.provenance_reference_count,
            ] {
                word(&mut bytes, value);
            }
            start = start
                .checked_add(u32::try_from(layout.fields.len())?)
                .context("GC descriptor field count overflow")?;
        }
        for layout in &self.layouts {
            for field in &layout.fields {
                let reference =
                    matches!(field.field.element_type, StorageType::Val(ValType::Ref(_)));
                let nullable = matches!(field.field.element_type, StorageType::Val(ValType::Ref(reference)) if reference.nullable);
                let flags = if field.field.mutable {
                    abi::FIELD_FLAG_MUTABLE
                } else {
                    0
                } | if reference {
                    abi::FIELD_FLAG_REFERENCE
                } else {
                    0
                } | if nullable {
                    abi::FIELD_FLAG_NULLABLE
                } else {
                    0
                } | if field.allocation_dependency {
                    abi::FIELD_FLAG_ALLOCATION_DEPENDENCY
                } else {
                    0
                };
                bytes.push(storage_code(field.field.element_type));
                bytes.push(flags);
                bytes.extend_from_slice(&0u16.to_le_bytes());
                word(&mut bytes, field.scalar_offset.unwrap_or(u32::MAX));
                word(&mut bytes, field.reference_ordinal.unwrap_or(u32::MAX));
            }
        }
        Ok(bytes)
    }
}
fn word(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn storage_code(storage: StorageType) -> u8 {
    match storage {
        StorageType::I8 => abi::STORAGE_I8,
        StorageType::I16 => abi::STORAGE_I16,
        StorageType::Val(ValType::I32) => abi::STORAGE_I32,
        StorageType::Val(ValType::I64) => abi::STORAGE_I64,
        StorageType::Val(ValType::F32) => abi::STORAGE_F32,
        StorageType::Val(ValType::F64) => abi::STORAGE_F64,
        StorageType::Val(ValType::V128) => abi::STORAGE_V128,
        StorageType::Val(ValType::Ref(_)) => abi::STORAGE_REFERENCE,
    }
}
