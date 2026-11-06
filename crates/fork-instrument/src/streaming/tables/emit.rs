//! A fixed scalar-local tuple reused across every table and both index widths.
use super::*;
use wasm_encoder::{BlockType, Instruction as I, MemArg};

mod restore;
mod save;
const ACTIVATION: u32 = 0;
const PAYLOAD: u32 = 1;
const LEN: u32 = 2;
const CURRENT: u32 = 3;
const START: u32 = 4;
const COUNT: u32 = 5;
const INDEX: u32 = 6;
const PAGE: u32 = 7;
const PAGES: u32 = 8;
const ORDINAL: u32 = 9;
pub(super) const SHIFT: i64 = abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT as i64;
const PAGE_SIZE: i64 = 1 << SHIFT;
const RECIPES: u64 = (abi::WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE
    + abi::WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE) as u64;
pub(super) struct Body<'a> {
    pub(super) plan: &'a NativeTableState,
    pub(super) function: Function,
    pub(super) work: usize,
    pub(super) limit: usize,
}
impl Body<'_> {
    pub(super) fn emit<'a>(&mut self, instructions: impl IntoIterator<Item = I<'a>>) -> Result<()> {
        for instruction in instructions {
            self.work = self
                .work
                .checked_sub(1)
                .context("table helper exceeds work budget")?;
            self.function.instruction(&instruction);
            ensure!(
                self.function.byte_len() <= self.limit,
                "table helper exceeds output budget"
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
    fn ptr(&mut self, value: i64) -> Result<()> {
        self.emit([super::super::runtime::ptr_const(self.plan.pointer, value)])
    }
    fn wide_to_ptr(&mut self) -> Result<()> {
        if self.plan.pointer == ValType::I32 {
            self.emit([I::I32WrapI64])?;
        }
        Ok(())
    }
    fn to_index(&mut self, table: &Table) -> Result<()> {
        if !table.wide {
            self.emit([I::I32WrapI64])?;
        }
        Ok(())
    }
    fn from_index(&mut self, table: &Table) -> Result<()> {
        if !table.wide {
            self.emit([I::I64ExtendI32U])?;
        }
        Ok(())
    }
    fn trap_if(&mut self) -> Result<()> {
        self.emit([I::If(BlockType::Empty), I::Unreachable, I::End])
    }
    fn find(&mut self, kind: u16, owner: u32, ordinal: I<'_>) -> Result<()> {
        self.emit([
            I::I32Const(i32::from(kind)),
            I::LocalGet(ACTIVATION),
            I::I32Const(owner as i32),
            ordinal,
            I::Call(self.plan.records.find),
            I::LocalSet(PAYLOAD),
        ])
    }
    fn count(&mut self) -> Result<()> {
        // min(page_size, length - page_start), independent of table index width.
        self.emit([
            I::I64Const(PAGE_SIZE),
            I::LocalGet(LEN),
            I::LocalGet(START),
            I::I64Sub,
            I::LocalGet(LEN),
            I::LocalGet(START),
            I::I64Sub,
            I::I64Const(PAGE_SIZE),
            I::I64GtU,
            I::Select,
            I::LocalSet(COUNT),
        ])
    }
    fn page_start(&mut self, table: &Table) -> Result<()> {
        self.emit([
            I::LocalGet(PAGE),
            I::I64Const((u64::MAX >> SHIFT) as i64),
            I::I64GtU,
        ])?;
        self.trap_if()?;
        self.emit([
            I::LocalGet(PAGE),
            I::I64Const(SHIFT),
            I::I64Shl,
            I::LocalSet(START),
        ])?;
        if !table.wide {
            self.emit([
                I::LocalGet(START),
                I::I64Const(i64::from(u32::MAX)),
                I::I64GtU,
            ])?;
            self.trap_if()?;
        }
        self.emit([I::LocalGet(START), I::LocalGet(LEN), I::I64GeU])?;
        self.trap_if()?;
        self.count()
    }
    fn recipe_address(&mut self) -> Result<()> {
        self.emit([
            I::LocalGet(PAYLOAD),
            I::LocalGet(INDEX),
            I::I64Const(4),
            I::I64Mul,
        ])?;
        self.wide_to_ptr()?;
        self.ptr(RECIPES as i64)?;
        self.emit([
            if self.plan.pointer == ValType::I64 {
                I::I64Add
            } else {
                I::I32Add
            },
            if self.plan.pointer == ValType::I64 {
                I::I64Add
            } else {
                I::I32Add
            },
        ])
    }
    fn decode(&mut self, table: &Table) -> Result<()> {
        self.emit([
            I::I32Load(self.arg(0)),
            I::Call(table.class.decoder(self.plan.codecs)),
        ])?;
        if table.ty.heap_type != table.class.broad_type().heap_type {
            self.emit([if table.ty.nullable {
                I::RefCastNullable(table.ty.heap_type)
            } else {
                I::RefCastNonNull(table.ty.heap_type)
            }])?;
        } else if !table.ty.nullable {
            self.emit([I::RefAsNonNull])?;
        }
        Ok(())
    }
}
pub(super) fn snapshot(plan: &NativeTableState, restore: bool, limit: usize) -> Result<Function> {
    let mut body = Body {
        plan,
        work: plan.limits.work,
        limit,
        function: Function::new_with_locals_types([
            plan.pointer,
            ValType::I64,
            ValType::I64,
            ValType::I64,
            ValType::I64,
            ValType::I64,
            ValType::I64,
            ValType::I32,
            ValType::I32,
        ]),
    };
    for table in &plan.tables {
        body.emit([
            I::I32Const(table.owner as i32),
            I::Call(plan.host.owned),
            I::If(BlockType::Empty),
        ])?;
        if restore {
            restore::table(&mut body, table)?;
        } else {
            save::table(&mut body, table)?;
        }
        body.emit([I::End])?;
    }
    body.emit([I::End])?;
    Ok(body.function)
}
