//! Allocate with the original opcode first, then publish constructor-only
//! inputs through the shared transit slot. No user operand is re-evaluated.
use super::*;
use wasm_encoder::HeapType;

struct Body {
    function: Function,
    limit: usize,
}
impl Body {
    fn emit<'a>(&mut self, instructions: impl IntoIterator<Item = Instruction<'a>>) -> Result<()> {
        for instruction in instructions {
            self.function.instruction(&instruction);
            ensure!(
                self.function.byte_len() <= self.limit,
                "GC constructor helper exceeds output budget"
            );
        }
        Ok(())
    }
    fn clear_transit(&mut self, host: ProvenanceHost) -> Result<()> {
        self.emit([
            Instruction::I32Const(0),
            Instruction::RefNull(HeapType::ANY),
            Instruction::TableSet(host.transit),
        ])
    }
}

pub(super) fn constructor(
    layout: &NativeGcLayout,
    parameters: u32,
    host: ProvenanceHost,
    limit: usize,
) -> Result<Function> {
    let result = parameters;
    let token = parameters
        .checked_add(1)
        .context("GC constructor local index overflow")?;
    let nullable = RefType {
        nullable: true,
        heap_type: HeapType::Concrete(layout.type_index),
    };
    let mut body = Body {
        function: Function::new_with_locals_types([ValType::Ref(nullable), ValType::I32]),
        limit,
    };
    for argument in 0..parameters {
        body.emit([Instruction::LocalGet(argument)])?;
    }
    let original = match layout.constructor {
        NativeGcConstructor::Struct => Instruction::StructNew(layout.type_index),
        NativeGcConstructor::ArrayNew => Instruction::ArrayNew(layout.type_index),
        NativeGcConstructor::ArrayDefault => Instruction::ArrayNewDefault(layout.type_index),
        NativeGcConstructor::ArrayFixed { len } => Instruction::ArrayNewFixed {
            array_type_index: layout.type_index,
            array_size: len,
        },
        NativeGcConstructor::ArrayData { segment_ordinal } => Instruction::ArrayNewData {
            array_type_index: layout.type_index,
            array_data_index: segment_ordinal,
        },
        NativeGcConstructor::ArrayElement { segment_ordinal } => Instruction::ArrayNewElem {
            array_type_index: layout.type_index,
            array_elem_index: segment_ordinal,
        },
        NativeGcConstructor::ArrayGeneric => {
            anyhow::bail!("generic arrays have no constructor helper")
        }
    };
    body.emit([
        original,
        Instruction::LocalSet(result),
        Instruction::I32Const(0),
        Instruction::LocalGet(result),
        Instruction::TableSet(host.transit),
        Instruction::I32Const(0),
        Instruction::GlobalGet(host.activation),
        Instruction::I32Const(layout.base_layout_id as i32),
        Instruction::I32Const(layout.id as i32),
    ])?;
    provenance_scalars(&mut body, layout)?;
    body.emit([
        Instruction::I32Const(layout.provenance_reference_count as i32),
        Instruction::Call(host.begin),
        Instruction::LocalSet(token),
    ])?;
    body.clear_transit(host)?;
    let mut ordinal = 0u32;
    for argument in 0..parameters {
        let retained = match layout.constructor {
            NativeGcConstructor::Struct => {
                super::super::layouts::needs_seed(&layout.fields[argument as usize])
            }
            NativeGcConstructor::ArrayNew => {
                argument == 0 && layout.fields[0].class == Some(NativeReferenceClass::Any)
            }
            NativeGcConstructor::ArrayFixed { .. } => {
                super::super::layouts::needs_seed(&layout.fields[0])
            }
            _ => false,
        };
        if !retained {
            continue;
        }
        body.emit([
            Instruction::I32Const(0),
            Instruction::LocalGet(argument),
            Instruction::TableSet(host.transit),
            Instruction::LocalGet(token),
            Instruction::I32Const(ordinal as i32),
            Instruction::I32Const(0),
            Instruction::Call(host.reference),
        ])?;
        body.clear_transit(host)?;
        ordinal += 1;
    }
    ensure!(
        ordinal == layout.provenance_reference_count,
        "GC constructor seed count changed"
    );
    body.emit([
        Instruction::LocalGet(token),
        Instruction::Call(host.end),
        Instruction::LocalGet(result),
        Instruction::RefAsNonNull,
        Instruction::End,
    ])?;
    Ok(body.function)
}

fn provenance_scalars(body: &mut Body, layout: &NativeGcLayout) -> Result<()> {
    match layout.constructor {
        NativeGcConstructor::ArrayNew => scalar_pair(body, layout.fields[0].field.element_type),
        NativeGcConstructor::ArrayData { .. } | NativeGcConstructor::ArrayElement { .. } => {
            // Both u32 operands fit in the declared eight-byte prefix. Putting
            // length in scalarHi would lose it when the host keeps eight bytes.
            body.emit([
                Instruction::LocalGet(0),
                Instruction::I64ExtendI32U,
                Instruction::LocalGet(1),
                Instruction::I64ExtendI32U,
                Instruction::I64Const(32),
                Instruction::I64Shl,
                Instruction::I64Or,
                Instruction::I64Const(0),
            ])
        }
        _ => body.emit([Instruction::I64Const(0), Instruction::I64Const(0)]),
    }
}
fn scalar_pair(body: &mut Body, storage: StorageType) -> Result<()> {
    if matches!(storage, StorageType::Val(ValType::Ref(_))) {
        return body.emit([Instruction::I64Const(0), Instruction::I64Const(0)]);
    }
    body.emit([Instruction::LocalGet(0)])?;
    match storage {
        StorageType::I8 | StorageType::I16 | StorageType::Val(ValType::I32) => {
            body.emit([Instruction::I64ExtendI32U])?
        }
        StorageType::Val(ValType::F32) => {
            body.emit([Instruction::I32ReinterpretF32, Instruction::I64ExtendI32U])?
        }
        StorageType::Val(ValType::F64) => body.emit([Instruction::I64ReinterpretF64])?,
        StorageType::Val(ValType::V128) => {
            return body.emit([
                Instruction::I64x2ExtractLane(0),
                Instruction::LocalGet(0),
                Instruction::I64x2ExtractLane(1),
            ]);
        }
        StorageType::Val(ValType::I64) => {}
        StorageType::Val(ValType::Ref(_)) => unreachable!(),
    }
    body.emit([Instruction::I64Const(0)])
}
