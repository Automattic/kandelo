//! Claim/publish identity before traversing children so aliases and cycles
//! terminate. Each recursive activation owns its exchange-memory reservation.
use super::*;

pub(super) fn probe(body: &mut Body<'_>, plan: &NativeGcPlan) -> Result<()> {
    for id in plan.dispatch_layouts() {
        let layout = &plan.layouts[(*id - 1) as usize];
        let packed = (u64::from(layout.type_ordinal) << 32) | u64::from(layout.id);
        body.emit([
            Instruction::LocalGet(ARG),
            Instruction::TableGet(body.codec.host.transit),
            Instruction::RefTestNonNull(HeapType::Concrete(layout.type_index)),
            Instruction::If(BlockType::Empty),
            Instruction::I64Const(packed as i64),
            Instruction::Return,
            Instruction::End,
        ])?;
    }
    body.emit([Instruction::I64Const(0)])
}

pub(super) fn encode(body: &mut Body<'_>, plan: &NativeGcPlan) -> Result<()> {
    let host = body.codec.host;
    body.emit([
        Instruction::LocalGet(ARG),
        Instruction::RefIsNull,
        Instruction::If(BlockType::Empty),
        Instruction::I32Const(0),
        Instruction::Return,
        Instruction::End,
        Instruction::LocalGet(ARG),
        Instruction::RefTestNonNull(HeapType::I31),
        Instruction::If(BlockType::Empty),
        Instruction::LocalGet(ARG),
        Instruction::RefCastNonNull(HeapType::I31),
        Instruction::I31GetS,
        Instruction::Call(host.i31),
        Instruction::LocalSet(RECIPE),
        Instruction::LocalGet(RECIPE),
        Instruction::I32Const(1),
        Instruction::I32Add,
        Instruction::LocalGet(ARG),
        Instruction::TableSet(host.transit),
        Instruction::LocalGet(RECIPE),
        Instruction::Return,
        Instruction::End,
        Instruction::I32Const(0),
        Instruction::LocalGet(ARG),
        Instruction::TableSet(host.transit),
        Instruction::I32Const(0),
        Instruction::Call(host.lookup),
        Instruction::LocalTee(RECIPE),
        Instruction::If(BlockType::Empty),
    ])?;
    body.clear_transit()?;
    body.emit([
        Instruction::LocalGet(RECIPE),
        Instruction::Return,
        Instruction::End,
    ])?;
    for id in plan.dispatch_layouts() {
        let layout = &plan.layouts[(*id - 1) as usize];
        body.emit([
            Instruction::LocalGet(ARG),
            Instruction::RefTestNonNull(HeapType::Concrete(layout.type_index)),
            Instruction::If(BlockType::Empty),
            Instruction::I32Const(0),
            Instruction::Call(host.claim),
            Instruction::LocalSet(RECIPE),
            Instruction::LocalGet(RECIPE),
            Instruction::I32Const(1),
            Instruction::I32Add,
            Instruction::LocalGet(ARG),
            Instruction::TableSet(host.transit),
            Instruction::I32Const(0),
            Instruction::GlobalGet(host.activation),
            Instruction::I32Const(layout.id as i32),
            Instruction::Call(host.capture),
            Instruction::LocalSet(LAYOUT),
        ])?;
        body.clear_transit()?;
        match layout.kind {
            NativeGcKind::Struct => structure(body, layout)?,
            NativeGcKind::Array => array(body, layout)?,
        }
        body.emit([
            Instruction::LocalGet(RECIPE),
            Instruction::Return,
            Instruction::End,
        ])?;
    }
    // Broker routing also covers externalized opaque values. Publish their
    // original internal identity so anyref and externref aliases share an ID.
    body.emit([
        Instruction::I32Const(0),
        Instruction::Call(host.broker),
        Instruction::LocalSet(RECIPE),
        Instruction::LocalGet(RECIPE),
        Instruction::I32Const(1),
        Instruction::I32Add,
        Instruction::LocalGet(ARG),
        Instruction::TableSet(host.transit),
    ])?;
    body.clear_transit()?;
    body.emit([Instruction::LocalGet(RECIPE)])
}

fn structure(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    let reference_count =
        u32::try_from(layout.fields.iter().filter(|f| f.class.is_some()).count())?;
    body.emit([
        Instruction::I32Const(layout.scalar_len_or_stride as i32),
        Instruction::LocalSet(SCALAR_LEN),
    ])?;
    body.reserve()?;
    body.emit([Instruction::I32Const(reference_count as i32)])?;
    if reference_count != 0 {
        body.emit([Instruction::Call(body.codec.vectors[0])])?;
    }
    body.emit([Instruction::LocalSet(VECTOR)])?;
    for (index, field) in layout.fields.iter().enumerate() {
        if let Some(offset) = field.scalar_offset {
            body.emit([Instruction::LocalGet(STAGING)])?;
            body.object(layout, false)?;
            structure_get(body, layout, index as u32, field)?;
            body.emit([body.scalar_store(field.field.element_type, u64::from(offset))?])?;
        } else {
            body.emit([Instruction::LocalGet(VECTOR)])?;
            body.object(layout, false)?;
            structure_get(body, layout, index as u32, field)?;
            body.emit([
                Instruction::Call(
                    field
                        .class
                        .context("GC reference class missing")?
                        .encoder(body.codec.references),
                ),
                Instruction::Call(body.codec.vectors[1]),
            ])?;
        }
    }
    if reference_count != 0 {
        finish_vector(body)?;
    }
    define(body, layout)?;
    body.release()
}
fn structure_get(
    body: &mut Body<'_>,
    layout: &NativeGcLayout,
    index: u32,
    field: &NativeGcField,
) -> Result<()> {
    body.emit([match field.field.element_type {
        StorageType::I8 | StorageType::I16 => Instruction::StructGetU {
            struct_type_index: layout.type_index,
            field_index: index,
        },
        _ => Instruction::StructGet {
            struct_type_index: layout.type_index,
            field_index: index,
        },
    }])
}
fn array(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    let field = &layout.fields[0];
    body.object(layout, false)?;
    body.emit([Instruction::ArrayLen, Instruction::LocalSet(LENGTH)])?;
    if field.class.is_some() {
        body.emit([Instruction::I32Const(4)])?;
    } else {
        let stride = layout.scalar_len_or_stride;
        body.emit([
            Instruction::LocalGet(LENGTH),
            Instruction::I32Const(((u32::MAX - 4) / stride) as i32),
            Instruction::I32GtU,
            Instruction::If(BlockType::Empty),
            Instruction::Unreachable,
            Instruction::End,
            Instruction::LocalGet(LENGTH),
            Instruction::I32Const(stride as i32),
            Instruction::I32Mul,
            Instruction::I32Const(4),
            Instruction::I32Add,
        ])?;
    }
    body.emit([Instruction::LocalSet(SCALAR_LEN)])?;
    body.reserve()?;
    body.emit([
        Instruction::LocalGet(STAGING),
        Instruction::LocalGet(LENGTH),
        Instruction::I32Store(body.arg(0)),
    ])?;
    if field.class.is_some() {
        body.emit([
            Instruction::LocalGet(LENGTH),
            Instruction::If(BlockType::Result(ValType::I32)),
            Instruction::LocalGet(LENGTH),
            Instruction::Call(body.codec.vectors[0]),
            Instruction::Else,
            Instruction::I32Const(0),
            Instruction::End,
        ])?;
    } else {
        body.emit([Instruction::I32Const(0)])?;
    }
    body.emit([Instruction::LocalSet(VECTOR)])?;
    arrays::loop_start(body)?;
    if let Some(class) = field.class {
        body.emit([Instruction::LocalGet(VECTOR)])?;
        array_get(body, layout)?;
        body.emit([
            Instruction::Call(class.encoder(body.codec.references)),
            Instruction::Call(body.codec.vectors[1]),
        ])?;
    } else {
        body.array_address(layout, false)?;
        array_get(body, layout)?;
        body.emit([body.scalar_store(field.field.element_type, 0)?])?;
    }
    arrays::loop_end(body)?;
    if field.class.is_some() {
        body.emit([
            Instruction::LocalGet(LENGTH),
            Instruction::If(BlockType::Empty),
        ])?;
        finish_vector(body)?;
        body.emit([Instruction::End])?;
    }
    define(body, layout)?;
    body.release()
}
fn array_get(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    body.object(layout, false)?;
    body.emit([
        Instruction::LocalGet(INDEX),
        match layout.fields[0].field.element_type {
            StorageType::I8 | StorageType::I16 => Instruction::ArrayGetU(layout.type_index),
            _ => Instruction::ArrayGet(layout.type_index),
        },
    ])
}
fn finish_vector(body: &mut Body<'_>) -> Result<()> {
    body.emit([
        Instruction::LocalGet(VECTOR),
        Instruction::Call(body.codec.vectors[2]),
        Instruction::LocalSet(VECTOR),
    ])
}
fn define(body: &mut Body<'_>, layout: &NativeGcLayout) -> Result<()> {
    body.emit([
        Instruction::LocalGet(RECIPE),
        Instruction::GlobalGet(body.codec.host.activation),
        Instruction::I32Const(layout.type_ordinal as i32),
        Instruction::LocalGet(LAYOUT),
        Instruction::I32Const(if layout.kind == NativeGcKind::Struct {
            1
        } else {
            2
        }),
        Instruction::LocalGet(STAGING),
        Instruction::LocalGet(SCALAR_LEN),
        Instruction::LocalGet(VECTOR),
        Instruction::Call(body.codec.host.define),
    ])
}
