use super::{FrameLayout, LocalKey, scalar_size};
use crate::streaming::runtime::{load, ptr_const, store};
use anyhow::{Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{Function, Instruction, MemArg, ValType};

#[derive(Debug)]
pub struct ScratchStorage {
    pub stack_pointer: u32,
    pub base: LocalKey,
    pub size: u32,
    pub node_spill_start: u32,
    pub spill_bytes: u32,
    pub offsets: BTreeMap<LocalKey, (ValType, u32)>,
    pub temporaries: BTreeMap<ValType, LocalKey>,
}

/// Final output identities, not source indices. Buffer follows the linked
/// runtime's active-frame pointer word at offset zero of its root prefix.
#[derive(Clone, Copy, Debug)]
pub enum FrameAddress {
    Local(LocalKey),
    Global(u32),
    Buffer(u32),
}

fn bounded(body: &Function, limit: usize) -> Result<()> {
    ensure!(body.byte_len() <= limit, "frame I/O exceeds output budget");
    Ok(())
}
impl FrameLayout {
    pub fn emit_get(&self, key: LocalKey, body: &mut Function, limit: usize) -> Result<()> {
        let ty = self.local(key)?.ty;
        if let Some(scratch) = &self.scratch
            && let Some(&(ty, offset)) = scratch.offsets.get(&key)
        {
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            body.instruction(&load(
                ty,
                MemArg {
                    offset: u64::from(offset),
                    align: scalar_size(ty).trailing_zeros(),
                    memory_index: self.environment.memory.unwrap(),
                },
            ));
        } else {
            body.instruction(&Instruction::LocalGet(self.local_index(key)?));
            if matches!(ty,ValType::Ref(reference) if !reference.nullable) {
                body.instruction(&Instruction::RefAsNonNull);
            }
        }
        bounded(body, limit)
    }
    pub fn emit_set(&self, key: LocalKey, body: &mut Function, limit: usize) -> Result<()> {
        self.local(key)?;
        if let Some(scratch) = &self.scratch
            && let Some(&(ty, offset)) = scratch.offsets.get(&key)
        {
            let temporary = self.local_index(scratch.temporaries[&ty])?;
            body.instruction(&Instruction::LocalSet(temporary));
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            body.instruction(&Instruction::LocalGet(temporary));
            body.instruction(&store(
                ty,
                MemArg {
                    offset: u64::from(offset),
                    align: scalar_size(ty).trailing_zeros(),
                    memory_index: self.environment.memory.unwrap(),
                },
            ));
        } else {
            body.instruction(&Instruction::LocalSet(self.local_index(key)?));
        }
        bounded(body, limit)
    }
    pub fn emit_tee(&self, key: LocalKey, body: &mut Function, limit: usize) -> Result<()> {
        let ty = self.local(key)?.ty;
        if let Some(scratch) = &self.scratch
            && scratch.offsets.contains_key(&key)
        {
            self.emit_set(key, body, limit)?;
            body.instruction(&Instruction::LocalGet(
                self.local_index(scratch.temporaries[&ty])?,
            ));
        } else {
            body.instruction(&Instruction::LocalTee(self.local_index(key)?));
            if matches!(ty,ValType::Ref(reference) if !reference.nullable) {
                body.instruction(&Instruction::RefAsNonNull);
            }
        }
        bounded(body, limit)
    }
    pub fn emit_scratch_reserve(&self, body: &mut Function, limit: usize) -> Result<()> {
        if let Some(scratch) = &self.scratch {
            body.instruction(&Instruction::GlobalGet(scratch.stack_pointer));
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.size),
            ));
            body.instruction(&if self.environment.pointer == ValType::I64 {
                Instruction::I64Sub
            } else {
                Instruction::I32Sub
            });
            body.instruction(&Instruction::LocalTee(self.local_index(scratch.base)?));
            body.instruction(&Instruction::GlobalSet(scratch.stack_pointer));
        }
        bounded(body, limit)
    }
    pub fn emit_scratch_release(&self, body: &mut Function, limit: usize) -> Result<()> {
        if let Some(scratch) = &self.scratch {
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.size),
            ));
            body.instruction(&if self.environment.pointer == ValType::I64 {
                Instruction::I64Add
            } else {
                Instruction::I32Add
            });
            body.instruction(&Instruction::GlobalSet(scratch.stack_pointer));
        }
        bounded(body, limit)
    }
    pub fn emit_scratch_reseed(&self, body: &mut Function, limit: usize) -> Result<()> {
        if let Some(scratch) = &self.scratch {
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            body.instruction(&Instruction::GlobalSet(scratch.stack_pointer));
        }
        bounded(body, limit)
    }
    pub(super) fn emit_address(
        &self,
        address: FrameAddress,
        body: &mut Function,
        limit: usize,
    ) -> Result<()> {
        match address {
            FrameAddress::Local(key) => {
                ensure!(
                    self.local(key)?.ty == self.environment.pointer,
                    "frame address local has the wrong pointer type"
                );
                self.emit_get(key, body, limit)?;
            }
            FrameAddress::Global(global) => {
                body.instruction(&Instruction::GlobalGet(global));
            }
            FrameAddress::Buffer(global) => {
                body.instruction(&Instruction::GlobalGet(global));
                body.instruction(&load(
                    self.environment.pointer,
                    MemArg {
                        offset: 0,
                        align: if self.environment.pointer == ValType::I64 {
                            3
                        } else {
                            2
                        },
                        memory_index: self.environment.memory.unwrap(),
                    },
                ));
            }
        }
        bounded(body, limit)
    }
    pub fn emit_scratch_save(
        &self,
        address: FrameAddress,
        body: &mut Function,
        limit: usize,
    ) -> Result<()> {
        if let Some(scratch) = &self.scratch {
            self.emit_address(address, body, limit)?;
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.node_spill_start),
            ));
            body.instruction(&if self.environment.pointer == ValType::I64 {
                Instruction::I64Add
            } else {
                Instruction::I32Add
            });
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.spill_bytes),
            ));
            let memory = self.environment.memory.unwrap();
            body.instruction(&Instruction::MemoryCopy {
                src_mem: memory,
                dst_mem: memory,
            });
        }
        bounded(body, limit)
    }
    pub fn emit_scratch_restore(
        &self,
        address: FrameAddress,
        body: &mut Function,
        limit: usize,
    ) -> Result<()> {
        if let Some(scratch) = &self.scratch {
            body.instruction(&Instruction::LocalGet(self.local_index(scratch.base)?));
            self.emit_address(address, body, limit)?;
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.node_spill_start),
            ));
            body.instruction(&if self.environment.pointer == ValType::I64 {
                Instruction::I64Add
            } else {
                Instruction::I32Add
            });
            body.instruction(&ptr_const(
                self.environment.pointer,
                i64::from(scratch.spill_bytes),
            ));
            let memory = self.environment.memory.unwrap();
            body.instruction(&Instruction::MemoryCopy {
                src_mem: memory,
                dst_mem: memory,
            });
        }
        bounded(body, limit)
    }
}
