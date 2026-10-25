use super::*;
use wasm_encoder::{BlockType, Instruction};

impl NativeLegacyLoader {
    pub(super) fn emit_driver(&self, limit: usize) -> Result<Function> {
        self.emit_driver_indices(
            DriverIndices {
                next: self.next,
                commit: self.commit,
                checkpoint: self.checkpoint,
                table: self.table,
                initializer_type: self.initializer_type,
            },
            limit,
        )
    }
    pub(super) fn emit_driver_indices(
        &self,
        indices: DriverIndices,
        limit: usize,
    ) -> Result<Function> {
        let mut output = Function::new([(1, ValType::I32)]);
        output.instruction(&Instruction::Loop(BlockType::Empty));
        checkpoint(indices.checkpoint, &mut output);
        output.instruction(&Instruction::LocalGet(0));
        output.instruction(&Instruction::Call(indices.next));
        output.instruction(&Instruction::LocalSet(1));
        checkpoint(indices.checkpoint, &mut output);
        output.instruction(&Instruction::LocalGet(1));
        output.instruction(&Instruction::I32Const(0));
        output.instruction(&Instruction::I32LtS);
        output.instruction(&Instruction::If(BlockType::Empty));
        output.instruction(&Instruction::I32Const(0));
        output.instruction(&Instruction::Return);
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::LocalGet(1));
        output.instruction(&Instruction::I32Eqz);
        output.instruction(&Instruction::If(BlockType::Empty));
        output.instruction(&Instruction::LocalGet(0));
        output.instruction(&Instruction::Call(indices.commit));
        output.instruction(&Instruction::LocalSet(1));
        checkpoint(indices.checkpoint, &mut output);
        output.instruction(&Instruction::LocalGet(1));
        output.instruction(&Instruction::Return);
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::LocalGet(1));
        if self.table64 {
            output.instruction(&Instruction::I64ExtendI32U);
        }
        output.instruction(&Instruction::CallIndirect {
            type_index: indices.initializer_type,
            table_index: indices.table,
        });
        output.instruction(&Instruction::Br(0));
        output.instruction(&Instruction::End);
        output.instruction(&Instruction::Unreachable);
        output.instruction(&Instruction::End);
        check(output, limit)
    }
    pub(super) fn emit_adapter(&self, adapter: &FrozenAdapter, limit: usize) -> Result<Function> {
        let mut output = Function::new([]);
        let parameters = &adapter.parameters;
        if parameters.len() >= 4 {
            for index in [1, 3] {
                output.instruction(&Instruction::LocalGet(index));
                output.instruction(&if parameters[index as usize] == ValType::I64 {
                    Instruction::I64Eqz
                } else {
                    Instruction::I32Eqz
                });
            }
            output.instruction(&Instruction::I32And);
            output.instruction(&Instruction::If(BlockType::Empty));
            output.instruction(&Instruction::Call(self.main));
            output.instruction(&Instruction::Return);
            output.instruction(&Instruction::End);
        }
        output.instruction(&Instruction::LocalGet(0));
        output.instruction(&Instruction::LocalGet(1));
        if parameters.len() == 2 {
            for &ty in parameters {
                output.instruction(&if ty == ValType::I64 {
                    Instruction::I64Const(0)
                } else {
                    Instruction::I32Const(0)
                });
            }
        } else {
            output.instruction(&Instruction::LocalGet(2));
            output.instruction(&Instruction::LocalGet(3));
        }
        output.instruction(&if parameters.len() == 5 {
            Instruction::LocalGet(4)
        } else {
            Instruction::I32Const(0x100)
        });
        output.instruction(&Instruction::Call(adapter.prepare));
        // Remove dead pointer parameters before any initializer or deferred
        // signal callback can fork. Only the driver's scalar token survives.
        output.instruction(&Instruction::ReturnCall(self.driver.unwrap()));
        output.instruction(&Instruction::End);
        check(output, limit)
    }
}
fn checkpoint(index: Option<u32>, output: &mut Function) {
    if let Some(checkpoint) = index {
        output.instruction(&Instruction::Call(checkpoint));
    }
}
fn check(output: Function, limit: usize) -> Result<Function> {
    ensure!(
        output.byte_len() <= limit,
        "loader helper exceeds output budget"
    );
    Ok(output)
}
