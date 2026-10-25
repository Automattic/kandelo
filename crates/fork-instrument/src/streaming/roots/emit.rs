//! Typed root records and exact-length segment bitmaps. Record validation and
//! durable ownership belong to the process owner; references stay inside Wasm.
use super::*;
use wasm_encoder::{BlockType, MemArg};

mod segments;
const ACTIVATION: u32 = 0;
const PAYLOAD: u32 = 1;
struct Body<'a> {
    plan: &'a NativeRootState,
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
                .context("root state exceeds work budget")?;
            self.function.instruction(&instruction);
            ensure!(
                self.function.byte_len() <= self.limit,
                "root state exceeds output budget"
            );
        }
        Ok(())
    }
    fn arg(&self, offset: u64) -> MemArg {
        MemArg {
            offset,
            align: 0,
            memory_index: self.plan.memory,
        }
    }
    fn reserve(&mut self, kind: u16, owner: u32, size: u32) -> Result<()> {
        self.emit([
            Instruction::I32Const(i32::from(kind)),
            Instruction::LocalGet(ACTIVATION),
            Instruction::I32Const(owner as i32),
            super::super::runtime::ptr_const(self.plan.pointer, i64::from(size)),
            Instruction::Call(self.plan.host.reserve),
            Instruction::LocalSet(PAYLOAD),
        ])
    }
    fn find(&mut self, kind: u16, owner: u32) -> Result<()> {
        self.emit([
            Instruction::I32Const(i32::from(kind)),
            Instruction::LocalGet(ACTIVATION),
            Instruction::I32Const(owner as i32),
            Instruction::I32Const(0),
            Instruction::Call(self.plan.host.find),
            Instruction::LocalSet(PAYLOAD),
        ])
    }
}
pub(super) fn helper(plan: &NativeRootState, ordinal: u32, limit: usize) -> Result<Function> {
    ensure!(ordinal < 3, "unknown root state helper");
    let mut body = Body {
        plan,
        function: Function::new_with_locals_types([plan.pointer]),
        limit,
        work: plan.limits.work,
    };
    match ordinal {
        0 => {
            for global in &plan.globals {
                save(&mut body, global)?;
            }
            segments::save(
                &mut body,
                &plan.elements,
                abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
            )?;
            segments::save(
                &mut body,
                &plan.data,
                abi::WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
            )?;
        }
        1 => {
            for global in &plan.globals {
                if global.restore {
                    restore(&mut body, global)?;
                }
            }
            body.emit([Instruction::Call(plan.baseline)])?;
        }
        _ => {
            body.emit([
                Instruction::GlobalGet(plan.bootstrap_done),
                Instruction::I32Eqz,
                Instruction::If(BlockType::Empty),
                Instruction::Unreachable,
                Instruction::End,
            ])?;
            segments::restore(
                &mut body,
                &plan.elements,
                abi::WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
                true,
            )?;
            segments::restore(
                &mut body,
                &plan.data,
                abi::WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
                false,
            )?;
        }
    }
    body.emit([Instruction::End])?;
    Ok(body.function)
}
fn save(body: &mut Body<'_>, global: &Global) -> Result<()> {
    let header = u32::from(abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE);
    let size = global.value_size();
    body.reserve(
        abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
        global.owner,
        header + size,
    )?;
    body.emit([
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(i32::from(global.code()?)),
        Instruction::I32Store8(body.arg(0)),
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(size as i32),
        Instruction::I32Store8(body.arg(1)),
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(0),
        Instruction::I32Store16(body.arg(2)),
        Instruction::LocalGet(PAYLOAD),
        Instruction::I32Const(0),
        Instruction::I32Store(body.arg(4)),
        Instruction::LocalGet(PAYLOAD),
        Instruction::GlobalGet(global.index),
    ])?;
    let ty = if let Some(class) = global.class {
        body.emit([Instruction::Call(class.encoder(body.plan.references))])?;
        ValType::I32
    } else {
        global.ty
    };
    body.emit([
        super::super::runtime::store(ty, body.arg(u64::from(header))),
        Instruction::LocalGet(PAYLOAD),
        Instruction::Call(body.plan.host.commit),
    ])
}
fn restore(body: &mut Body<'_>, global: &Global) -> Result<()> {
    body.find(
        abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
        global.owner,
    )?;
    let header = u64::from(abi::WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE);
    body.emit([
        Instruction::LocalGet(PAYLOAD),
        super::super::runtime::load(
            if global.class.is_some() {
                ValType::I32
            } else {
                global.ty
            },
            body.arg(header),
        ),
    ])?;
    if let Some(class) = global.class {
        body.emit([Instruction::Call(class.decoder(body.plan.references))])?;
        let ValType::Ref(expected) = global.ty else {
            anyhow::bail!("reference root has scalar type")
        };
        if expected.heap_type != class.broad_type().heap_type {
            body.emit([if expected.nullable {
                Instruction::RefCastNullable(expected.heap_type)
            } else {
                Instruction::RefCastNonNull(expected.heap_type)
            }])?;
        } else if !expected.nullable {
            body.emit([Instruction::RefAsNonNull])?;
        }
    }
    body.emit([Instruction::GlobalSet(global.index)])
}
