//! Full module-state entry points over frozen root and sparse-table providers.
//! The process restores every activation baseline before calling finish; only
//! canonical physical owners apply overlays, and segment drops always run last.
use super::*;
use anyhow::{Result, ensure};
use wasm_encoder::{BlockType, ExportKind, FuncType, Function, Instruction, ValType};
use wasm_posix_program_abi::abi;

pub struct NativeModuleState {
    declarations: FrozenDeclarations,
    save: [u32; 2],
    restore: u32,
    finish: [u32; 2],
    bootstrap_done: u32,
}
impl NativeModuleState {
    pub fn compose(
        roots: &NativeRootState,
        tables: &NativeTableState,
        bootstrap: &FrozenModuleBootstrap,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Result<Self> {
        ensure!(
            roots.source_identity() == tables.source_identity(),
            "module-state providers belong to different sources"
        );
        ensure!(
            roots.baseline_matches(bootstrap),
            "module-state bootstrap differs from root baseline"
        );
        ensure!(
            tables.uses_memory(roots.memory_binding()),
            "module-state providers use different process memories"
        );
        let finish = first_function
            .checked_add(2)
            .ok_or_else(|| anyhow::anyhow!("module-state function index overflow"))?;
        for (name, index) in [
            (abi::WPK_FORK_EXPORT_MODULE_STATE_SAVE, first_function),
            (
                abi::WPK_FORK_EXPORT_MODULE_STATE_RESTORE,
                first_function + 1,
            ),
            (abi::WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE, finish),
            (abi::WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE, tables.save),
            (
                abi::WPK_FORK_EXPORT_MODULE_TABLE_STATE_RESTORE,
                tables.restore,
            ),
        ] {
            module.export(name, ExportKind::Func, index)?;
        }
        Ok(Self {
            declarations: FrozenDeclarations::new(
                vec![FuncType::new([ValType::I32], [])],
                vec![first_type; 3],
                1024,
            )?,
            save: [roots.save, tables.save],
            restore: roots.restore,
            finish: [tables.restore, roots.finish_segments],
            bootstrap_done: bootstrap.done_global,
        })
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(ordinal < 3, "unknown module-state helper");
        let mut body = Function::new([]);
        if ordinal == 2 {
            body.instruction(&Instruction::GlobalGet(self.bootstrap_done))
                .instruction(&Instruction::I32Eqz)
                .instruction(&Instruction::If(BlockType::Empty))
                .instruction(&Instruction::Unreachable)
                .instruction(&Instruction::End);
        }
        let calls: &[u32] = match ordinal {
            0 => &self.save,
            1 => std::slice::from_ref(&self.restore),
            _ => &self.finish,
        };
        for &function in calls {
            body.instruction(&Instruction::LocalGet(0))
                .instruction(&Instruction::Call(function));
        }
        body.instruction(&Instruction::End);
        ensure!(
            body.byte_len() <= limit,
            "module-state helper exceeds output budget"
        );
        Ok(body)
    }
}
