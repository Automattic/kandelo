//! Allocation installs every mutable shell before filling graph edges.
//! Immutable and non-defaultable constructors use already allocated inputs.
use super::*;

fn route(body: &mut Body<'_>) -> Result<()> {
    body.emit([
        Instruction::LocalGet(ARG),
        Instruction::GlobalGet(body.codec.host.activation),
        Instruction::Call(body.codec.host.route),
        Instruction::LocalSet(LAYOUT),
    ])
}
pub(super) fn allocate(body: &mut Body<'_>, plan: &NativeGcPlan) -> Result<()> {
    route(body)?;
    body.emit([
        Instruction::LocalGet(LAYOUT),
        Instruction::I32Eqz,
        Instruction::If(BlockType::Empty),
    ])?;
    body.load_payload(None)?;
    body.emit([
        Instruction::LocalGet(ARG),
        Instruction::I32Const(1),
        Instruction::I32Add,
    ])?;
    body.load(StorageType::Val(ValType::I32), 0)?;
    body.emit([
        Instruction::RefI31,
        Instruction::TableSet(body.codec.host.transit),
    ])?;
    body.release()?;
    body.emit([Instruction::Return, Instruction::End])?;
    for layout in &plan.layouts {
        body.emit([
            Instruction::LocalGet(LAYOUT),
            Instruction::I32Const(layout.id as i32),
            Instruction::I32Eq,
            Instruction::If(BlockType::Empty),
        ])?;
        body.load_payload(Some(layout))?;
        body.emit([
            Instruction::LocalGet(ARG),
            Instruction::I32Const(1),
            Instruction::I32Add,
        ])?;
        match layout.kind {
            NativeGcKind::Struct => allocate_struct(body, layout)?,
            NativeGcKind::Array => arrays::allocate(body, layout)?,
        }
        body.emit([Instruction::TableSet(body.codec.host.transit)])?;
        if layout.requires_provenance {
            body.replay_provenance(layout)?;
        }
        body.release()?;
        body.emit([Instruction::Return, Instruction::End])?;
    }
    body.emit([Instruction::Unreachable])
}
fn allocate_struct(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    if layout.defaultable_shell {
        return body.emit([Instruction::StructNewDefault(layout.type_index)]);
    }
    let mut provenance_reference = 0;
    for field in &layout.fields {
        match field.field.element_type {
            StorageType::Val(ValType::Ref(_)) if !field.field.mutable => {
                body.snapshot_reference(
                    layout,
                    field,
                    field
                        .reference_ordinal
                        .context("GC reference ordinal missing")?,
                )?;
            }
            StorageType::Val(ValType::Ref(reference)) if !reference.nullable => {
                if field.class == Some(NativeReferenceClass::Any) {
                    body.vector_reference(field, provenance_reference)?;
                    provenance_reference += 1;
                } else {
                    body.seed(reference)?;
                }
            }
            StorageType::Val(ValType::Ref(reference)) => {
                body.emit([Instruction::RefNull(reference.heap_type)])?
            }
            _ if !field.field.mutable => body.snapshot_scalar(layout, field)?,
            storage => body.default_scalar(storage)?,
        }
    }
    body.emit([Instruction::StructNew(layout.type_index)])
}

pub(super) fn fill(body: &mut Body<'_>, plan: &NativeGcPlan) -> Result<()> {
    route(body)?;
    for layout in &plan.layouts {
        body.emit([
            Instruction::LocalGet(LAYOUT),
            Instruction::I32Const(layout.id as i32),
            Instruction::I32Eq,
            Instruction::If(BlockType::Empty),
        ])?;
        if layout.fields.iter().any(|field| field.field.mutable) {
            body.load_payload(Some(layout))?;
            match layout.kind {
                NativeGcKind::Struct => fill_struct(body, layout)?,
                NativeGcKind::Array => fill_array(body, layout)?,
            }
            body.release()?;
        }
        body.emit([Instruction::Return, Instruction::End])?;
    }
    body.emit([Instruction::Unreachable])
}
fn fill_struct(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    for (index, field) in layout.fields.iter().enumerate() {
        if !field.field.mutable {
            continue;
        }
        body.object(layout, true)?;
        if let Some(ordinal) = field.reference_ordinal {
            body.snapshot_reference(layout, field, ordinal)?;
        } else {
            body.snapshot_scalar(layout, field)?;
        }
        body.emit([Instruction::StructSet {
            struct_type_index: layout.type_index,
            field_index: index as u32,
        }])?;
    }
    Ok(())
}
fn fill_array(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    let field = &layout.fields[0];
    arrays::length(body, layout)?;
    body.emit([Instruction::LocalSet(LENGTH)])?;
    arrays::loop_start(body)?;
    body.object(layout, true)?;
    body.emit([Instruction::LocalGet(INDEX)])?;
    if field.class.is_some() {
        body.emit([
            Instruction::LocalGet(VECTOR),
            Instruction::LocalGet(INDEX),
            Instruction::I32Const(layout.provenance_reference_count as i32),
            Instruction::I32Add,
            Instruction::Call(body.codec.vectors[3]),
        ])?;
        body.decode_reference(field)?;
    } else {
        body.array_address(layout, true)?;
        body.emit([body.scalar_load(field.field.element_type, 0)?])?;
    }
    body.emit([Instruction::ArraySet(layout.type_index)])?;
    arrays::loop_end(body)
}
