use super::*;
use crate::streaming::{NativeReferenceClass, runtime::load};

const ROUTE: u32 = 3;
const CACHE_INDEX: u32 = 4;
const CACHED: u32 = 5;

impl NativeExceptionCodec {
    pub(super) fn emit_decode(&self, body: &mut Body, locals: &[Vec<PayloadLocal>]) -> Result<()> {
        body.emit([
            Instruction::LocalGet(0),
            Instruction::LocalSet(RECIPE),
            Instruction::LocalGet(RECIPE),
            Instruction::I32Eqz,
            Instruction::If(BlockType::Empty),
            Instruction::RefNull(RefType::EXNREF.heap_type),
            Instruction::Return,
            Instruction::End,
            Instruction::LocalGet(RECIPE),
            Instruction::I32Const(0x7fff_fffe),
            Instruction::I32GtU,
            Instruction::If(BlockType::Empty),
            Instruction::Unreachable,
            Instruction::End,
            Instruction::LocalGet(RECIPE),
            Instruction::Call(self.host.cache_index),
            Instruction::LocalTee(CACHE_INDEX),
            Instruction::I32Eqz,
            Instruction::If(BlockType::Empty),
            Instruction::Unreachable,
            Instruction::End,
            Instruction::LocalGet(CACHE_INDEX),
            Instruction::TableSize(self.replay),
            Instruction::I32GeU,
            Instruction::If(BlockType::Empty),
            Instruction::RefNull(RefType::EXNREF.heap_type),
            Instruction::LocalGet(CACHE_INDEX),
            Instruction::I32Const(1),
            Instruction::I32Add,
            Instruction::TableSize(self.replay),
            Instruction::I32Sub,
            Instruction::TableGrow(self.replay),
            Instruction::I32Const(-1),
            Instruction::I32Eq,
            Instruction::If(BlockType::Empty),
            Instruction::Unreachable,
            Instruction::End,
            Instruction::End,
            Instruction::LocalGet(CACHE_INDEX),
            Instruction::TableGet(self.replay),
            Instruction::LocalTee(CACHED),
            Instruction::RefIsNull,
            Instruction::I32Eqz,
            Instruction::If(BlockType::Empty),
            Instruction::LocalGet(CACHED),
            Instruction::Return,
            Instruction::End,
            Instruction::LocalGet(RECIPE),
            Instruction::GlobalGet(self.host.activation),
            Instruction::Call(self.host.route),
            Instruction::LocalTee(ROUTE),
            Instruction::I32Const(-1),
            Instruction::I32Eq,
            Instruction::If(BlockType::Empty),
        ])?;
        body.capture_throw([
            Instruction::LocalGet(RECIPE),
            Instruction::Call(self.host.broker_throw),
        ])?;
        body.emit([Instruction::LocalSet(CACHED)])?;
        self.cache_and_return(body)?;
        body.emit([Instruction::End])?;
        // Each successful route returns. Keep selection nesting constant
        // instead of building one nested if/else for every original tag.
        for (layout, locals) in self.layouts.iter().zip(locals) {
            body.emit([
                Instruction::LocalGet(ROUTE),
                Instruction::I32Const(layout.ordinal as i32),
                Instruction::I32Eq,
                Instruction::If(BlockType::Empty),
            ])?;
            self.decode_tag(body, layout, locals)?;
            body.emit([Instruction::End])?;
        }
        body.emit([Instruction::Unreachable])
    }

    fn decode_tag(
        &self,
        body: &mut Body,
        layout: &TagLayout,
        locals: &[PayloadLocal],
    ) -> Result<()> {
        body.emit([
            super::super::super::runtime::ptr_const(self.pointer, i64::from(layout.staging_len)),
            Instruction::Call(self.host.reserve),
            Instruction::LocalSet(STAGING),
        ])?;
        body.transfer(self, layout, self.host.load)?;
        body.emit([
            Instruction::I32Eqz,
            Instruction::If(BlockType::Empty),
            Instruction::Unreachable,
            Instruction::End,
        ])?;
        for (payload, local) in layout.payloads.iter().zip(locals) {
            body.address(self, 0)?;
            if let Some(offset) = payload.scalar_offset {
                body.emit([
                    load(payload.ty, self.memory_arg(offset, 0)),
                    Instruction::LocalSet(local.value),
                ])?;
            } else {
                let offset = layout.references_ptr
                    + payload
                        .reference_offset
                        .context("missing payload reference index")?
                        * 4;
                body.emit([
                    load(ValType::I32, self.memory_arg(offset, 2)),
                    Instruction::LocalSet(local.recipe.context("missing payload recipe local")?),
                ])?;
            }
        }
        // Snapshot every scalar and child ID before releasing exchange memory.
        // Recursive decoders can now reuse it without changing this payload.
        body.release(self, layout)?;
        for (payload, local) in layout.payloads.iter().zip(locals) {
            if let (Some(class), ValType::Ref(expected)) = (payload.class, payload.ty) {
                let decoder = if class == NativeReferenceClass::Exn {
                    self.indices.decode
                } else {
                    class.decoder(self.references)
                };
                body.emit([
                    Instruction::LocalGet(local.recipe.context("missing payload recipe local")?),
                    Instruction::Call(decoder),
                ])?;
                // Check the source constraint before decoding another child.
                // Nullable physical storage also accepts this checked value.
                class.emit_narrow(expected, &mut body.function);
                body.emit([Instruction::LocalSet(local.value)])?;
            }
        }
        body.emit([
            Instruction::Block(BlockType::Result(ValType::Ref(non_null_exception()))),
            Instruction::TryTable(
                BlockType::Empty,
                Cow::Borrowed(&[Catch::AllRef { label: 0 }]),
            ),
        ])?;
        for (payload, local) in layout.payloads.iter().zip(locals) {
            body.emit([Instruction::LocalGet(local.value)])?;
            if matches!(payload.ty, ValType::Ref(reference) if !reference.nullable) {
                body.emit([Instruction::RefAsNonNull])?;
            }
        }
        body.emit([
            Instruction::Throw(layout.tag),
            Instruction::End,
            Instruction::Unreachable,
            Instruction::End,
            Instruction::LocalSet(CACHED),
        ])?;
        self.cache_and_return(body)
    }
    fn cache_and_return(&self, body: &mut Body) -> Result<()> {
        body.emit([
            Instruction::LocalGet(CACHE_INDEX),
            Instruction::LocalGet(CACHED),
            Instruction::TableSet(self.replay),
            Instruction::LocalGet(CACHED),
            Instruction::Return,
        ])
    }
}
