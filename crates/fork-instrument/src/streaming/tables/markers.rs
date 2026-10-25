//! Dirty-page cache and exact applied-generation fence; no references cross JS.
use super::emit::{Body, SHIFT};
use super::*;
use wasm_encoder::{BlockType, Instruction as I, MemArg};

pub(super) fn helper(plan: &NativeTableState, ordinal: u32, limit: usize) -> Result<Function> {
    let locals = if ordinal >= 4 && ordinal % 2 == 0 {
        vec![ValType::I64; 2]
    } else {
        vec![]
    };
    let mut body = Body {
        plan,
        function: Function::new_with_locals_types(locals),
        work: plan.limits.work,
        limit,
    };
    match ordinal {
        2 => {
            body.emit([I::GlobalGet(plan.host.generation)])?;
            if plan.pointer == ValType::I32 {
                body.emit([I::I32WrapI64])?;
            }
            let arg = MemArg {
                offset: 0,
                align: 3,
                memory_index: plan.memory,
            };
            body.emit([
                if plan.shared {
                    I::I64AtomicLoad(arg)
                } else {
                    I::I64Load(arg)
                },
                I::GlobalGet(plan.last_generation),
                I::I64Ne,
                I::If(BlockType::Empty),
                I::Call(plan.host.reconcile),
                I::GlobalSet(plan.last_generation),
                I::End,
            ])?;
        }
        3 => body.emit([I::Call(plan.host.begin), I::GlobalSet(plan.last_generation)])?,
        n => {
            let table = &plan.tables[((n - 4) / 2) as usize];
            if n % 2 == 0 {
                mark(&mut body, table)?;
            } else {
                grow(&mut body, table, plan.first_marker + (n - 5))?;
            }
        }
    }
    body.emit([I::End])?;
    Ok(body.function)
}
fn mark(body: &mut Body<'_>, table: &Table) -> Result<()> {
    // Parameters: start0/count1; reusable first-page2/last-page3 locals.
    body.emit([
        I::LocalGet(1),
        I::I64Const(0),
        I::I64Ne,
        I::If(BlockType::Empty),
        I::LocalGet(0),
        I::I64Const(SHIFT),
        I::I64ShrU,
        I::LocalSet(2),
        I::LocalGet(0),
        I::LocalGet(1),
        I::I64Add,
        I::I64Const(1),
        I::I64Sub,
        I::I64Const(SHIFT),
        I::I64ShrU,
        I::LocalSet(3),
        I::LocalGet(2),
        I::LocalGet(3),
        I::I64Eq,
        I::GlobalGet(table.last_page),
        I::LocalGet(3),
        I::I64Eq,
        I::I32And,
        I::I32Eqz,
        I::If(BlockType::Empty),
        I::I32Const(table.owner as i32),
        I::LocalGet(2),
        I::LocalGet(3),
        I::LocalGet(2),
        I::I64Sub,
        I::I64Const(1),
        I::I64Add,
        I::Call(body.plan.host.dirty_mark),
        I::LocalGet(3),
        I::GlobalSet(table.last_page),
        I::End,
        I::I32Const(table.owner as i32),
        I::LocalGet(0),
        I::LocalGet(1),
        I::Call(body.plan.host.commit),
        I::Else,
        I::Call(body.plan.host.abort),
        I::End,
    ])
}
fn grow(body: &mut Body<'_>, table: &Table, mark: u32) -> Result<()> {
    body.emit([
        I::LocalGet(0),
        I::I64Const(if table.wide { -1 } else { i64::from(u32::MAX) }),
        I::I64Ne,
        I::If(BlockType::Empty),
        I::LocalGet(0),
        I::LocalGet(1),
        I::Call(mark),
        I::Else,
        I::Call(body.plan.host.abort),
        I::End,
    ])
}
