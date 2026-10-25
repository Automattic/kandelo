//! Serial helper emission. Tag-specific encode/decode tails share typed local
//! scratch; only one tail can execute in one helper activation.
use super::*;
use std::{borrow::Cow, collections::BTreeMap};
use wasm_encoder::{Catch, Function, Instruction, MemArg};

mod decode;
mod encode;

const EXCEPTION: u32 = 0;
const RECIPE: u32 = 1;
const STAGING: u32 = 2;

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
                "exception helper exceeds output budget"
            );
        }
        Ok(())
    }
    fn address(&mut self, codec: &NativeExceptionCodec, offset: u32) -> Result<()> {
        self.emit([Instruction::LocalGet(STAGING)])?;
        if offset != 0 {
            self.emit([
                super::super::runtime::ptr_const(codec.pointer, i64::from(offset)),
                if codec.pointer == ValType::I64 {
                    Instruction::I64Add
                } else {
                    Instruction::I32Add
                },
            ])?;
        }
        Ok(())
    }
    fn clear_scratch(&mut self, codec: &NativeExceptionCodec) -> Result<()> {
        self.emit([
            Instruction::I32Const(0),
            Instruction::RefNull(RefType::EXNREF.heap_type),
            Instruction::TableSet(codec.scratch),
        ])
    }
    fn release(&mut self, codec: &NativeExceptionCodec, layout: &TagLayout) -> Result<()> {
        self.emit([
            Instruction::LocalGet(STAGING),
            super::super::runtime::ptr_const(codec.pointer, i64::from(layout.staging_len)),
            Instruction::Call(codec.host.release),
        ])
    }
    fn transfer(
        &mut self,
        codec: &NativeExceptionCodec,
        layout: &TagLayout,
        function: u32,
    ) -> Result<()> {
        self.emit([
            Instruction::LocalGet(RECIPE),
            Instruction::GlobalGet(codec.host.activation),
            Instruction::I32Const(layout.ordinal as i32),
            Instruction::I32Const(layout.ordinal as i32),
        ])?;
        self.address(codec, 0)?;
        self.emit([Instruction::I32Const(layout.scalar_len as i32)])?;
        self.address(codec, layout.references_ptr)?;
        self.emit([
            Instruction::I32Const(layout.reference_count as i32),
            Instruction::Call(function),
        ])
    }
    fn capture_throw(
        &mut self,
        instructions: impl IntoIterator<Item = Instruction<'static>>,
    ) -> Result<()> {
        self.emit([
            Instruction::Block(BlockType::Result(ValType::Ref(non_null_exception()))),
            Instruction::TryTable(
                BlockType::Empty,
                Cow::Borrowed(&[Catch::AllRef { label: 0 }]),
            ),
        ])?;
        self.emit(instructions)?;
        self.emit([
            Instruction::Unreachable,
            Instruction::End,
            Instruction::Unreachable,
            Instruction::End,
        ])
    }
}

#[derive(Clone, Copy)]
struct PayloadLocal {
    value: u32,
    recipe: Option<u32>,
}
struct HelperLocals {
    types: Vec<ValType>,
    payloads: Vec<Vec<PayloadLocal>>,
}
impl HelperLocals {
    fn plan(codec: &NativeExceptionCodec, base: &[ValType]) -> Result<Self> {
        let mut output = Self {
            types: base.to_vec(),
            payloads: Vec::new(),
        };
        let mut pools = BTreeMap::<ValType, Vec<u32>>::new();
        let mut remaining = codec.limits.metadata_bytes;
        for layout in &codec.layouts {
            remaining = remaining
                .checked_sub(layout.payloads.len().saturating_mul(64).saturating_add(64))
                .context("exception local metadata exceeds budget")?;
            let mut uses = BTreeMap::<ValType, usize>::new();
            let mut allocate = |ty| -> Result<u32> {
                let ordinal = uses.entry(ty).or_default();
                let pool = pools.entry(ty).or_default();
                if *ordinal == pool.len() {
                    ensure!(
                        output.types.len() < 1_000_000,
                        "exception helper exceeds local budget"
                    );
                    pool.push(u32::try_from(output.types.len())? + 1);
                    output.types.push(ty);
                }
                let local = pool[*ordinal];
                *ordinal += 1;
                Ok(local)
            };
            let mut payloads = Vec::with_capacity(layout.payloads.len());
            for payload in &layout.payloads {
                let storage = match payload.ty {
                    ValType::Ref(mut ty) => {
                        ty.nullable = true;
                        ValType::Ref(ty)
                    }
                    scalar => scalar,
                };
                payloads.push(PayloadLocal {
                    value: allocate(storage)?,
                    recipe: if payload.class.is_some() {
                        Some(allocate(ValType::I32)?)
                    } else {
                        None
                    },
                });
            }
            output.payloads.push(payloads);
        }
        Ok(output)
    }
}

impl NativeExceptionCodec {
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(ordinal < 8, "unknown exception helper");
        let total_payloads = self
            .layouts
            .iter()
            .try_fold(self.layouts.len(), |n, layout| {
                n.checked_add(layout.payloads.len())
            })
            .context("exception emission work overflow")?;
        ensure!(
            total_payloads <= self.limits.work / 64,
            "exception emission exceeds work budget"
        );
        let base = match ordinal {
            0 => vec![ValType::I32, self.pointer],
            1 => vec![
                ValType::I32,
                self.pointer,
                ValType::I32,
                ValType::I32,
                ValType::Ref(RefType::EXNREF),
            ],
            _ => vec![],
        };
        let locals = if ordinal < 2 {
            HelperLocals::plan(self, &base)?
        } else {
            HelperLocals {
                types: base,
                payloads: vec![],
            }
        };
        let mut body = Body {
            function: Function::new_with_locals_types(locals.types),
            limit,
        };
        match ordinal {
            0 => self.emit_encode(&mut body, &locals.payloads)?,
            1 => self.emit_decode(&mut body, &locals.payloads)?,
            2 => body.emit([
                Instruction::LocalGet(0),
                Instruction::TableGet(self.scratch),
                Instruction::RefAsNonNull,
                Instruction::ThrowRef,
            ])?,
            3 => body.emit([
                Instruction::LocalGet(0),
                Instruction::Call(self.indices.decode),
                Instruction::RefAsNonNull,
                Instruction::ThrowRef,
            ])?,
            4 => {
                body.capture_throw([
                    Instruction::LocalGet(0),
                    Instruction::Call(self.host.ingress_throw),
                ])?;
                body.emit([Instruction::Call(self.indices.encode)])?;
            }
            // JavaScript cannot receive exnref results; materialize and cache
            // inside Wasm, then cross the boundary with a void result.
            5 => body.emit([
                Instruction::LocalGet(0),
                Instruction::Call(self.indices.decode),
                Instruction::Drop,
            ])?,
            6 | 7 => {
                body.clear_scratch(self)?;
                body.emit([
                    Instruction::I32Const(0),
                    Instruction::RefNull(RefType::EXNREF.heap_type),
                    Instruction::TableSize(self.replay),
                    Instruction::TableFill(self.replay),
                ])?;
            }
            _ => unreachable!(),
        }
        body.emit([Instruction::End])?;
        Ok(body.function)
    }
    fn memory_arg(&self, offset: u32, align: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align,
            memory_index: self.memory,
        }
    }
}
