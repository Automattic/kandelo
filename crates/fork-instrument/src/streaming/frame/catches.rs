//! Selector-guarded I/O for mutually exclusive catch payloads. Every arm uses
//! the same byte range; inactive arms must never overwrite the selected one.
use super::{FrameAddress, FrameLayout, LocalKey, scalar_size};
use crate::streaming::runtime::{load, store};
use anyhow::{Context, Result, ensure};
use wasm_encoder::{BlockType, Function, Instruction, MemArg, ValType};

#[derive(Clone, Copy, Debug)]
pub enum CatchFrameIo {
    Save,
    Restore,
}

impl FrameLayout {
    pub fn emit_catch_scalars(
        &self,
        address: FrameAddress,
        selector: LocalKey,
        io: CatchFrameIo,
        output: &mut Function,
        output_limit: usize,
    ) -> Result<()> {
        ensure!(
            self.local(selector)?.ty == ValType::I32,
            "catch selector must be i32"
        );
        // Each matching arm branches out of the common block. This keeps
        // emitted nesting constant even for thousands of static catch arms.
        output.instruction(&Instruction::Block(BlockType::Empty));
        self.emit_get(selector, output, output_limit)?;
        output.instruction(&Instruction::I32Eqz);
        output.instruction(&Instruction::BrIf(0));
        for arm in &self.catch {
            self.emit_get(selector, output, output_limit)?;
            output.instruction(&Instruction::I32Const(arm.selector as i32));
            output.instruction(&Instruction::I32Eq);
            output.instruction(&Instruction::If(BlockType::Empty));
            for field in &arm.fields {
                self.emit_address(address, output, output_limit)?;
                let memory = MemArg {
                    offset: u64::from(field.offset),
                    align: scalar_size(field.ty).trailing_zeros(),
                    memory_index: self
                        .environment
                        .memory
                        .context("catch frame requires linear memory")?,
                };
                match io {
                    CatchFrameIo::Save => {
                        self.emit_get(field.local, output, output_limit)?;
                        output.instruction(&store(field.ty, memory));
                    }
                    CatchFrameIo::Restore => {
                        output.instruction(&load(field.ty, memory));
                        self.emit_set(field.local, output, output_limit)?;
                    }
                }
            }
            output.instruction(&Instruction::Br(1));
            output.instruction(&Instruction::End);
            ensure!(
                output.byte_len() <= output_limit,
                "catch frame I/O exceeds output budget"
            );
        }
        output.instruction(&Instruction::Unreachable);
        output.instruction(&Instruction::End);
        ensure!(
            output.byte_len() <= output_limit,
            "catch frame I/O exceeds output budget"
        );
        Ok(())
    }
}
