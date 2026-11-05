use super::*;
use crate::streaming::runtime::store;

impl NativeExceptionCodec {
    pub(super) fn emit_encode(&self, body: &mut Body, locals: &[Vec<PayloadLocal>]) -> Result<()> {
        body.emit([
            Instruction::LocalGet(EXCEPTION),
            Instruction::RefIsNull,
            Instruction::If(BlockType::Empty),
            Instruction::I32Const(0),
            Instruction::Return,
            Instruction::End,
            Instruction::I32Const(0),
            Instruction::LocalGet(EXCEPTION),
            Instruction::TableSet(self.scratch),
            Instruction::I32Const(0),
            Instruction::Call(self.host.lookup),
            Instruction::LocalTee(RECIPE),
            Instruction::If(BlockType::Empty),
        ])?;
        body.clear_scratch(self)?;
        body.emit([
            Instruction::LocalGet(RECIPE),
            Instruction::Return,
            Instruction::End,
            Instruction::Block(BlockType::Result(ValType::I32)),
        ])?;
        for layout in &self.layouts {
            body.emit([Instruction::Block(layout.capture_type)])?;
        }
        body.emit([Instruction::Block(BlockType::Result(ValType::Ref(
            non_null_exception(),
        )))])?;
        let mut catches = Vec::with_capacity(self.layouts.len() + 1);
        for (index, layout) in self.layouts.iter().enumerate() {
            catches.push(Catch::OneRef {
                tag: layout.tag,
                label: u32::try_from(self.layouts.len() - index)?,
            });
        }
        catches.push(Catch::AllRef { label: 0 });
        body.emit([
            Instruction::TryTable(BlockType::Empty, Cow::Owned(catches)),
            Instruction::LocalGet(EXCEPTION),
            Instruction::RefAsNonNull,
            Instruction::ThrowRef,
            Instruction::End,
            Instruction::Unreachable,
            Instruction::End,
            Instruction::Drop,
            Instruction::I32Const(0),
            Instruction::Call(self.host.broker_encode),
            Instruction::LocalSet(RECIPE),
        ])?;
        body.clear_scratch(self)?;
        body.emit([Instruction::LocalGet(RECIPE), Instruction::Return])?;
        for (layout, locals) in self.layouts.iter().zip(locals).rev() {
            body.emit([Instruction::End, Instruction::Drop])?;
            for local in locals.iter().rev() {
                body.emit([Instruction::LocalSet(local.value)])?;
            }
            // Claim the exception identity before recursively encoding any
            // payload. Shared/nested exceptions must reuse the same recipe.
            body.emit([
                Instruction::I32Const(0),
                Instruction::Call(self.host.claim),
                Instruction::LocalSet(RECIPE),
            ])?;
            body.clear_scratch(self)?;
            body.emit([
                super::super::super::runtime::ptr_const(
                    self.pointer,
                    i64::from(layout.staging_len),
                ),
                Instruction::Call(self.host.reserve),
                Instruction::LocalSet(STAGING),
            ])?;
            for (payload, local) in layout.payloads.iter().zip(locals) {
                if let Some(class) = payload.class {
                    let encoder = if class == super::super::super::NativeReferenceClass::Exn {
                        self.indices.encode
                    } else {
                        class.encoder(self.references)
                    };
                    body.emit([
                        Instruction::LocalGet(local.value),
                        Instruction::Call(encoder),
                        Instruction::LocalSet(
                            local.recipe.context("missing payload recipe local")?,
                        ),
                    ])?;
                }
            }
            for (payload, local) in layout.payloads.iter().zip(locals) {
                body.address(self, 0)?;
                if let Some(offset) = payload.scalar_offset {
                    body.emit([
                        Instruction::LocalGet(local.value),
                        store(payload.ty, self.memory_arg(offset, 0)),
                    ])?;
                } else {
                    let offset = layout.references_ptr
                        + payload
                            .reference_offset
                            .context("missing payload reference index")?
                            * 4;
                    body.emit([
                        Instruction::LocalGet(
                            local.recipe.context("missing payload recipe local")?,
                        ),
                        store(ValType::I32, self.memory_arg(offset, 2)),
                    ])?;
                }
            }
            body.transfer(self, layout, self.host.define)?;
            body.release(self, layout)?;
            body.emit([Instruction::LocalGet(RECIPE), Instruction::Return])?;
        }
        body.emit([Instruction::End])
    }
}
