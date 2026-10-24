//! Generate one frozen activation helper at a time. The catalog holds only
//! compact recipes, so emitting helpers never retains source function bodies.
use super::{ActivationCallTarget, FrozenActivationSupport, Recipe, ResumeArgument, Transport};
use crate::streaming::FrozenDeclarations;
use crate::streaming::frame::{FRAME_CALL_OFFSET, FRAME_REFERENCE_OFFSET};
use crate::streaming::runtime::{load, ptr_const, store};
use anyhow::{Context, Result, ensure};
use wasm_encoder::{BlockType, Function, HeapType, Instruction, MemArg, ValType};

impl FrozenActivationSupport {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        let recipe = self
            .recipes
            .get(ordinal as usize)
            .context("unknown activation support helper")?;
        let output = match recipe {
            Recipe::Select => self.emit_frame_select(limit)?,
            Recipe::Transport {
                operation,
                resume_signature,
                helper_signature,
            } => self.transport(operation, *resume_signature, *helper_signature, limit)?,
            Recipe::Resume {
                function,
                arguments,
                frame_size,
                use_zero_arguments,
            } => self.resume(
                *function,
                arguments,
                *frame_size,
                *use_zero_arguments,
                limit,
            )?,
        };
        ensure!(
            output.byte_len() <= limit,
            "activation helper exceeds output budget"
        );
        Ok(output)
    }
    fn emit_frame_address(&self, output: &mut Function) {
        output.instruction(&Instruction::GlobalGet(self.runtime.buf_global));
        output.instruction(&load(
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
    fn emit_call_selector_store(&self, output: &mut Function) {
        self.emit_frame_address(output);
        output.instruction(&Instruction::LocalGet(0));
        output.instruction(&store(
            ValType::I32,
            MemArg {
                offset: FRAME_CALL_OFFSET,
                align: 2,
                memory_index: self.environment.memory.unwrap(),
            },
        ));
    }
    fn emit_frame_select(&self, limit: usize) -> Result<Function> {
        let pointer_type = self.environment.pointer;
        let memory = self.environment.memory.unwrap();
        let runtime = self.runtime;
        let pointer_field = MemArg {
            offset: 0,
            align: if pointer_type == ValType::I64 { 3 } else { 2 },
            memory_index: memory,
        };
        let mut output = Function::new([]);
        output.instruction(&Instruction::LocalGet(0));
        output.instruction(&Instruction::GlobalSet(runtime.call_index_global));
        output.instruction(&Instruction::GlobalGet(runtime.buf_global));
        output.instruction(&Instruction::LocalGet(1));
        output.instruction(&Instruction::Call(runtime.frame_reserve));
        output.instruction(&store(pointer_type, pointer_field));
        self.emit_frame_address(&mut output);
        output.instruction(&if pointer_type == ValType::I64 {
            Instruction::I64Eqz
        } else {
            Instruction::I32Eqz
        });
        output.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
        output.instruction(&Instruction::GlobalGet(runtime.buf_global));
        output.instruction(&Instruction::GlobalGet(runtime.buf_global));
        output.instruction(&ptr_const(pointer_type, i64::from(self.frames_start)));
        output.instruction(&if pointer_type == ValType::I64 {
            Instruction::I64Add
        } else {
            Instruction::I32Add
        });
        output.instruction(&store(pointer_type, pointer_field));
        self.emit_call_selector_store(&mut output);
        output.instruction(&Instruction::I32Const(0));
        output.instruction(&Instruction::Else);
        self.emit_call_selector_store(&mut output);
        output.instruction(&Instruction::I32Const(1));
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::End);
        ensure!(
            output.byte_len() <= limit,
            "activation helper exceeds output budget"
        );
        Ok(output)
    }
    fn transport(
        &self,
        operation: &Transport,
        resume_signature: u32,
        helper_signature: u32,
        limit: usize,
    ) -> Result<Function> {
        let extra = usize::from(!matches!(operation.target, ActivationCallTarget::Direct(_)));
        let count = operation.params.len() + extra;
        let resume_slot_local = u32::try_from(count)?;
        let runtime = self.runtime;
        let mut output = Function::new_with_locals_types([ValType::I32]);
        output.instruction(&Instruction::GlobalGet(runtime.state_global));
        output.instruction(&Instruction::I32Const(crate::runtime::STATE_REWINDING));
        output.instruction(&Instruction::I32GeU);
        output.instruction(&Instruction::If(BlockType::Empty));
        output.instruction(&Instruction::I32Const(helper_signature as i32));
        output.instruction(&Instruction::Call(runtime.resume_peek));
        output.instruction(&Instruction::LocalTee(resume_slot_local));
        output.instruction(&Instruction::If(BlockType::Empty));
        output.instruction(&Instruction::LocalGet(resume_slot_local));
        output.instruction(&Instruction::CallIndirect {
            type_index: resume_signature,
            table_index: runtime.resume_table,
        });
        output.instruction(&Instruction::Return);
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::End);
        for argument in 0..resume_slot_local {
            output.instruction(&Instruction::LocalGet(argument));
            ensure!(
                output.byte_len() <= limit,
                "activation helper exceeds output budget"
            );
        }
        match operation.target {
            ActivationCallTarget::Direct(function) => {
                output.instruction(&Instruction::Call(function));
            }
            ActivationCallTarget::Indirect {
                table, signature, ..
            } => {
                output.instruction(&Instruction::CallIndirect {
                    type_index: signature,
                    table_index: table,
                });
            }
            ActivationCallTarget::Reference { signature } => {
                output.instruction(&Instruction::RefCastNonNull(HeapType::Concrete(signature)));
                output.instruction(&Instruction::CallRef(signature));
            }
        }
        output.instruction(&Instruction::GlobalGet(runtime.state_global));
        output.instruction(&Instruction::I32Const(crate::runtime::STATE_UNWINDING));
        output.instruction(&Instruction::I32Eq);
        output.instruction(&Instruction::If(BlockType::Empty));
        output.instruction(&Instruction::Throw(runtime.unwind_tag));
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::End);
        ensure!(
            output.byte_len() <= limit,
            "activation helper exceeds output budget"
        );
        Ok(output)
    }
    fn resume(
        &self,
        function: u32,
        arguments: &[ResumeArgument],
        frame_size: u32,
        use_zero_arguments: bool,
        limit: usize,
    ) -> Result<Function> {
        let locals = if use_zero_arguments {
            vec![]
        } else {
            vec![self.environment.pointer]
        };
        let mut output = Function::new_with_locals_types(locals);
        if !use_zero_arguments {
            output.instruction(&ptr_const(self.environment.pointer, i64::from(frame_size)));
            output.instruction(&Instruction::Call(self.runtime.frame_peek));
            output.instruction(&Instruction::LocalSet(0));
        }
        for argument in arguments {
            match *argument {
                ResumeArgument::Scalar { ty, offset } => {
                    if use_zero_arguments {
                        output.instruction(&match ty {
                            ValType::I32 => Instruction::I32Const(0),
                            ValType::I64 => Instruction::I64Const(0),
                            ValType::F32 => Instruction::F32Const(0.0f32.into()),
                            ValType::F64 => Instruction::F64Const(0.0f64.into()),
                            ValType::V128 => Instruction::V128Const(0),
                            _ => unreachable!(),
                        });
                    } else {
                        output.instruction(&Instruction::LocalGet(0));
                        output.instruction(&load(ty, self.scalar_field(ty, offset)));
                    }
                }
                ResumeArgument::Reference {
                    ty,
                    class,
                    vector_position,
                } => {
                    output.instruction(&Instruction::LocalGet(0));
                    output.instruction(&load(
                        ValType::I32,
                        self.scalar_field(ValType::I32, FRAME_REFERENCE_OFFSET as u32),
                    ));
                    output.instruction(&Instruction::I32Const(vector_position as i32));
                    output.instruction(&Instruction::Call(self.runtime.reference_vector_get));
                    output.instruction(&Instruction::Call(class.decoder(self.runtime.codecs)));
                    class.emit_narrow(ty, &mut output);
                }
            }
            ensure!(
                output.byte_len() <= limit,
                "resume thunk exceeds output budget"
            );
        }
        output.instruction(&Instruction::Call(function));
        output.instruction(&Instruction::End);
        ensure!(
            output.byte_len() <= limit,
            "resume thunk exceeds output budget"
        );
        Ok(output)
    }
    fn scalar_field(&self, ty: ValType, offset: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align: match ty {
                ValType::I32 | ValType::F32 => 2,
                ValType::I64 | ValType::F64 => 3,
                ValType::V128 => 4,
                _ => unreachable!(),
            },
            memory_index: self.environment.memory.unwrap(),
        }
    }
}
