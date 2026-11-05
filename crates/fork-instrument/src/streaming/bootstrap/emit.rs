//! Parent, pthread and fork restore have distinct initialization ownership.
use super::*;
use wasm_encoder::{BlockType, Instruction};

struct Body {
    function: Function,
    limit: usize,
    work: usize,
}
impl Body {
    fn emit<'a>(&mut self, instructions: impl IntoIterator<Item = Instruction<'a>>) -> Result<()> {
        for instruction in instructions {
            step(&mut self.work)?;
            self.function.instruction(&instruction);
            ensure!(
                self.function.byte_len() <= self.limit,
                "bootstrap exceeds output budget"
            );
        }
        Ok(())
    }
}
pub(super) fn helper(plan: &FrozenModuleBootstrap, ordinal: u32, limit: usize) -> Result<Function> {
    ensure!(ordinal < 3, "unknown bootstrap helper");
    let mut body = Body {
        function: Function::new([]),
        limit,
        work: plan.limits.work,
    };
    body.emit([
        Instruction::GlobalGet(plan.done_global),
        Instruction::I32Eqz,
        Instruction::If(BlockType::Empty),
    ])?;
    // Elements precede data, which precedes start, matching native Wasm
    // instantiation. Fork restore replays only the local table baseline.
    for active in &plan.elements {
        body.emit([
            Instruction::GlobalGet(active.offset_global),
            Instruction::I32Const(0),
            Instruction::I32Const(active.len as i32),
            Instruction::TableInit {
                table: active.destination,
                elem_index: active.segment,
            },
        ])?;
        if ordinal != 2 {
            body.emit([Instruction::ElemDrop(active.segment)])?;
        }
    }
    if ordinal != 2 {
        for active in &plan.data {
            if ordinal == 0 {
                body.emit([
                    Instruction::GlobalGet(active.offset_global),
                    Instruction::I32Const(0),
                    Instruction::I32Const(active.len as i32),
                    Instruction::MemoryInit {
                        mem: active.destination,
                        data_index: active.segment,
                    },
                ])?;
            }
            body.emit([Instruction::DataDrop(active.segment)])?;
        }
    }
    body.emit([
        Instruction::I32Const(1),
        Instruction::GlobalSet(plan.done_global),
    ])?;
    if ordinal == 0 {
        if let Some(start) = plan.start {
            body.emit([Instruction::Call(start)])?;
        }
    }
    body.emit([Instruction::End, Instruction::End])?;
    Ok(body.function)
}
