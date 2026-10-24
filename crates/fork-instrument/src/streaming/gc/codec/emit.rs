//! One helper body at a time. Scalar locals are shared across dispatch arms;
//! concrete references are narrowed at use rather than cached per source type.
use super::*;
use crate::streaming::runtime::ptr_const;
use std::borrow::Cow;
use wasm_encoder::{BlockType, Catch, HeapType, Instruction, MemArg};

mod arrays;
mod capture;
mod payload;
mod replay;

const ARG: u32 = 0;
const RECIPE: u32 = 1;
const LAYOUT: u32 = 2;
const STAGING: u32 = 3;
const SCALAR_LEN: u32 = 4;
const VECTOR: u32 = 5;
const LENGTH: u32 = 6;
const INDEX: u32 = 7;
const RESERVATION: u32 = 8;
const TOKEN: u32 = 9;

struct Body<'a> {
    codec: &'a NativeGcCodec,
    function: Function,
    limit: usize,
    work: usize,
}
impl Body<'_> {
    fn emit<'a>(&mut self, instructions: impl IntoIterator<Item = Instruction<'a>>) -> Result<()> {
        for instruction in instructions {
            self.work = self
                .work
                .checked_sub(1)
                .context("GC helper exceeds work budget")?;
            self.function.instruction(&instruction);
            ensure!(
                self.function.byte_len() <= self.limit,
                "GC helper exceeds output budget"
            );
        }
        Ok(())
    }
    fn pointer(&mut self) -> Result<()> {
        if self.codec.pointer == ValType::I64 {
            self.emit([Instruction::I64ExtendI32U])?;
        }
        Ok(())
    }
    fn add(&self) -> Instruction<'static> {
        if self.codec.pointer == ValType::I64 {
            Instruction::I64Add
        } else {
            Instruction::I32Add
        }
    }
    fn clear_transit(&mut self) -> Result<()> {
        self.emit([
            Instruction::I32Const(0),
            Instruction::RefNull(HeapType::ANY),
            Instruction::TableSet(self.codec.host.transit),
        ])
    }
    fn object(&mut self, layout: &NativeGcLayout, replay: bool) -> Result<()> {
        self.emit([Instruction::LocalGet(ARG)])?;
        if replay {
            self.emit([
                Instruction::I32Const(1),
                Instruction::I32Add,
                Instruction::TableGet(self.codec.host.transit),
            ])?;
        }
        self.emit([Instruction::RefCastNullable(HeapType::Concrete(
            layout.type_index,
        ))])
    }
    fn decode_reference(&mut self, field: &NativeGcField) -> Result<()> {
        let StorageType::Val(ValType::Ref(expected)) = field.field.element_type else {
            anyhow::bail!("GC scalar field has no reference decoder");
        };
        let class = field.class.context("GC field has no reference class")?;
        self.emit([Instruction::Call(class.decoder(self.codec.references))])?;
        if expected.heap_type != class.broad_type().heap_type {
            self.emit([if expected.nullable {
                Instruction::RefCastNullable(expected.heap_type)
            } else {
                Instruction::RefCastNonNull(expected.heap_type)
            }])?;
        } else if !expected.nullable {
            self.emit([Instruction::RefAsNonNull])?;
        }
        Ok(())
    }
    fn vector_reference(&mut self, field: &NativeGcField, index: u32) -> Result<()> {
        self.emit([
            Instruction::LocalGet(VECTOR),
            Instruction::I32Const(index as i32),
            Instruction::Call(self.codec.vectors[3]),
        ])?;
        self.decode_reference(field)
    }
    fn seed(&mut self, reference: RefType) -> Result<()> {
        match self.codec.seeds.get(reference)? {
            seeds::Seed::Function(function) => self.emit([Instruction::RefFunc(function)]),
            seeds::Seed::Exception(function) => self.emit([Instruction::Call(function)]),
            seeds::Seed::External => self.emit([
                Instruction::I32Const(0),
                Instruction::RefI31,
                Instruction::ExternConvertAny,
            ]),
            seeds::Seed::Uninhabited => self.emit([Instruction::Unreachable]),
        }
    }
    fn default_scalar(&mut self, storage: StorageType) -> Result<()> {
        self.emit([match storage {
            StorageType::I8 | StorageType::I16 | StorageType::Val(ValType::I32) => {
                Instruction::I32Const(0)
            }
            StorageType::Val(ValType::I64) => Instruction::I64Const(0),
            StorageType::Val(ValType::F32) => Instruction::F32Const(0.0.into()),
            StorageType::Val(ValType::F64) => Instruction::F64Const(0.0.into()),
            StorageType::Val(ValType::V128) => Instruction::V128Const(0),
            StorageType::Val(ValType::Ref(_)) => anyhow::bail!("GC reference needs a typed seed"),
        }])
    }
    fn seed_exception(&mut self) -> Result<()> {
        self.emit([
            Instruction::Block(BlockType::Result(ValType::Ref(RefType {
                nullable: false,
                heap_type: RefType::EXNREF.heap_type,
            }))),
            Instruction::TryTable(
                BlockType::Empty,
                Cow::Borrowed(&[Catch::AllRef { label: 0 }]),
            ),
            Instruction::Throw(self.codec.seeds.tag.context("GC seed tag was not frozen")?),
            Instruction::Unreachable,
            Instruction::End,
            Instruction::Unreachable,
            Instruction::End,
        ])
    }
}

pub(super) fn helper(
    codec: &NativeGcCodec,
    ordinal: u32,
    plan: &NativeGcPlan,
    limit: usize,
) -> Result<Function> {
    ensure!(
        ordinal < codec.declarations.function_count(),
        "unknown GC helper"
    );
    let complex = matches!(ordinal, 0 | 6 | 7);
    let locals = if complex {
        vec![
            ValType::I32,
            ValType::I32,
            codec.pointer,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
        ]
    } else {
        vec![]
    };
    let mut body = Body {
        codec,
        function: Function::new_with_locals_types(locals),
        limit,
        work: codec.limits.work,
    };
    let indices = codec.indices;
    match ordinal {
        0 => capture::encode(&mut body, plan)?,
        1 => body.emit([
            Instruction::LocalGet(ARG),
            Instruction::I32Eqz,
            Instruction::If(BlockType::Empty),
            Instruction::RefNull(HeapType::ANY),
            Instruction::Return,
            Instruction::End,
            Instruction::LocalGet(ARG),
            Instruction::I32Const(1),
            Instruction::I32Add,
            Instruction::TableGet(codec.host.transit),
        ])?,
        2 => body.emit([
            Instruction::LocalGet(ARG),
            Instruction::AnyConvertExtern,
            Instruction::Call(indices.encode_anyref),
        ])?,
        3 => body.emit([
            Instruction::LocalGet(ARG),
            Instruction::Call(indices.decode_anyref),
            Instruction::ExternConvertAny,
        ])?,
        4 => capture::probe(&mut body, plan)?,
        5 => body.emit([
            Instruction::LocalGet(ARG),
            Instruction::TableGet(codec.host.transit),
            Instruction::Call(indices.encode_anyref),
        ])?,
        6 => replay::allocate(&mut body, plan)?,
        7 => replay::fill(&mut body, plan)?,
        8 => body.emit([
            Instruction::LocalGet(ARG),
            Instruction::I32Const(1),
            Instruction::I32Add,
            Instruction::LocalGet(1),
            Instruction::AnyConvertExtern,
            Instruction::TableSet(codec.host.transit),
        ])?,
        _ if codec.seeds.is_exception(ordinal) => body.seed_exception()?,
        _ => body.emit([Instruction::Unreachable])?,
    }
    body.emit([Instruction::End])?;
    Ok(body.function)
}
