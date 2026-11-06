//! Recreate array constructors with their original arity and operand types.
use super::*;

pub(super) fn loop_start(body: &mut Body<'_>) -> Result<()> {
    body.emit([
        Instruction::I32Const(0),
        Instruction::LocalSet(INDEX),
        Instruction::Block(BlockType::Empty),
        Instruction::Loop(BlockType::Empty),
        Instruction::LocalGet(INDEX),
        Instruction::LocalGet(LENGTH),
        Instruction::I32GeU,
        Instruction::BrIf(1),
    ])
}
pub(super) fn loop_end(body: &mut Body<'_>) -> Result<()> {
    body.emit([
        Instruction::LocalGet(INDEX),
        Instruction::I32Const(1),
        Instruction::I32Add,
        Instruction::LocalSet(INDEX),
        Instruction::Br(0),
        Instruction::End,
        Instruction::End,
    ])
}
pub(super) fn allocate(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    let storage = layout.fields[0].field.element_type;
    match layout.constructor {
        NativeGcConstructor::ArrayGeneric if layout.defaultable_shell => {
            length(body, layout)?;
            body.emit([Instruction::ArrayNewDefault(layout.type_index)])?;
        }
        NativeGcConstructor::ArrayNew => {
            if let StorageType::Val(ValType::Ref(reference)) = storage {
                initializer(body, layout, reference)?;
            } else {
                body.load(storage, 0)?;
            }
            length(body, layout)?;
            body.emit([Instruction::ArrayNew(layout.type_index)])?;
        }
        NativeGcConstructor::ArrayDefault => {
            length(body, layout)?;
            body.emit([Instruction::ArrayNewDefault(layout.type_index)])?;
        }
        NativeGcConstructor::ArrayFixed { len } => {
            for index in 0..len {
                fixed_element(body, layout, index)?;
            }
            body.emit([Instruction::ArrayNewFixed {
                array_type_index: layout.type_index,
                array_size: len,
            }])?;
        }
        NativeGcConstructor::ArrayData { segment_ordinal } => {
            body.load(StorageType::Val(ValType::I32), 0)?;
            body.load(StorageType::Val(ValType::I32), 4)?;
            body.emit([Instruction::ArrayNewData {
                array_type_index: layout.type_index,
                array_data_index: segment_ordinal,
            }])?;
        }
        NativeGcConstructor::ArrayElement { segment_ordinal } => {
            body.load(StorageType::Val(ValType::I32), 0)?;
            body.load(StorageType::Val(ValType::I32), 4)?;
            body.emit([Instruction::ArrayNewElem {
                array_type_index: layout.type_index,
                array_elem_index: segment_ordinal,
            }])?;
        }
        NativeGcConstructor::ArrayGeneric | NativeGcConstructor::Struct => {
            body.emit([Instruction::Unreachable])?
        }
    }
    Ok(())
}
pub(super) fn length(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    body.load(
        StorageType::Val(ValType::I32),
        u64::from(layout.provenance_scalar_len),
    )
}
fn initializer(body: &mut Body<'_>, layout: &NativeGcLayout, reference: RefType) -> Result<()> {
    let field = &layout.fields[0];
    if field.class == Some(NativeReferenceClass::Any) {
        return body.vector_reference(field, 0);
    }
    if field.field.mutable {
        return body.seed(reference);
    }
    // Nonempty immutable arrays expose their original seed in the snapshot.
    // Empty arrays still require a typed operand, synthesized inside Wasm.
    length(body, layout)?;
    body.emit([Instruction::If(BlockType::Result(ValType::Ref(reference)))])?;
    body.snapshot_reference(layout, field, 0)?;
    body.emit([Instruction::Else])?;
    if reference.nullable {
        body.emit([Instruction::RefNull(reference.heap_type)])?;
    } else {
        body.seed(reference)?;
    }
    body.emit([Instruction::End])
}
fn fixed_element(body: &mut Body<'_>, layout: &NativeGcLayout, index: u32) -> Result<()> {
    let field = &layout.fields[0];
    match field.field.element_type {
        StorageType::Val(ValType::Ref(reference)) => {
            if !field.field.mutable {
                body.snapshot_reference(layout, field, index)
            } else if field.class == Some(NativeReferenceClass::Any) {
                body.vector_reference(field, index)
            } else {
                body.seed(reference)
            }
        }
        storage => {
            let offset = index
                .checked_mul(layout.scalar_len_or_stride)
                .and_then(|n| n.checked_add(4))
                .and_then(|n| n.checked_add(layout.provenance_scalar_len))
                .context("GC fixed-array snapshot offset overflow")?;
            body.load(storage, u64::from(offset))
        }
    }
}
