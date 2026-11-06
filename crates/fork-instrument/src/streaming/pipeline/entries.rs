//! Public host entry points select a private continuation before consulting
//! stale source arguments. Thread indices retain the host's i32 ABI on table64.
use super::*;
use anyhow::Context;
use wasm_encoder::{FuncType, Function, Instruction, ValType, reencode::Reencode};
use wasmparser::ExternalKind;

pub(super) struct EntryBoundaries {
    support: Option<FrozenActivationSupport>,
    thread: Option<Thread>,
    declarations: FrozenDeclarations,
}
struct Thread {
    transport: u32,
    table64: bool,
}
impl EntryBoundaries {
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        cursor: &mut Cursor,
        table_guard: u32,
        budget: usize,
    ) -> Result<Self> {
        let start = exported(scan, "_start", ExternalKind::Func).filter(|&function| {
            let ty = scan
                .types
                .as_ref()
                .core_type_at_in_module(scan.functions[function as usize].ty);
            let ty = scan
                .types
                .as_ref()
                .get(ty)
                .unwrap()
                .composite_type
                .unwrap_func();
            ty.params().is_empty() && ty.results().is_empty()
        });
        let table = exported(scan, "__indirect_function_table", ExternalKind::Table);
        if start.is_none() && table.is_none() {
            return Ok(Self {
                support: None,
                thread: None,
                declarations: FrozenDeclarations::new(Vec::new(), Vec::new(), budget)?,
            });
        }
        let pointer = runtime.pointer_type();
        let extra_types = if table.is_some() {
            vec![
                FuncType::new([pointer], [pointer]),
                FuncType::new([ValType::I32, pointer], [pointer]),
            ]
        } else {
            Vec::new()
        };
        let thread_type = cursor.ty;
        let wrapper_type = thread_type
            .checked_add(1)
            .context("entry wrapper type overflow")?;
        let prefix = FrozenDeclarations::new(extra_types, Vec::new(), budget)?;
        cursor.advance(&prefix)?;
        let environment = runtime.frame_environment(scan, budget)?;
        let mut support = ActivationSupportCatalog::new(
            environment,
            runtime.indices(),
            runtime.frames_start_offset(),
            cursor.ty,
            cursor.function,
            budget,
        )?;
        if let Some(start) = start {
            let transport = support.transport(
                ActivationCallTarget::Direct(runtime.function_index(start)?),
                &[],
                &[],
            )?;
            module.export(
                crate::instrument::RESUME_START_EXPORT,
                ExportKind::Func,
                transport,
            )?;
        }
        let thread = table
            .map(|source| -> Result<Thread> {
                let table64 = scan.types.as_ref().table_at(source).table64;
                let table = runtime.table_index(source)?;
                support.reconcile_table(table, table_guard)?;
                let transport = support.transport(
                    ActivationCallTarget::Indirect {
                        table,
                        signature: thread_type,
                        table64,
                    },
                    &[pointer],
                    &[pointer],
                )?;
                Ok(Thread { transport, table64 })
            })
            .transpose()?;
        let support = support.freeze()?;
        cursor.advance(support.declarations())?;
        let wrappers = if thread.is_some() {
            module.export(
                crate::instrument::RESUME_THREAD_EXPORT,
                ExportKind::Func,
                cursor.function,
            )?;
            vec![wrapper_type]
        } else {
            Vec::new()
        };
        let wrappers = FrozenDeclarations::new(Vec::new(), wrappers, budget)?;
        cursor.advance(&wrappers)?;
        let declarations =
            FrozenDeclarations::concatenate(&[&prefix, support.declarations(), &wrappers], budget)?;
        Ok(Self {
            support: Some(support),
            thread,
            declarations,
        })
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        let support = self
            .support
            .as_ref()
            .context("unknown entry boundary helper")?;
        if ordinal < support.declarations().function_count() {
            return support.emit_helper(ordinal, limit);
        }
        ensure!(
            ordinal == support.declarations().function_count(),
            "unknown entry boundary helper"
        );
        let thread = self
            .thread
            .as_ref()
            .context("unknown thread boundary helper")?;
        let mut body = Function::new([]);
        body.instruction(&Instruction::LocalGet(1));
        body.instruction(&Instruction::LocalGet(0));
        if thread.table64 {
            body.instruction(&Instruction::I64ExtendI32U);
        }
        body.instruction(&Instruction::Call(thread.transport));
        body.instruction(&Instruction::End);
        ensure!(
            body.byte_len() <= limit,
            "entry boundary exceeds output budget"
        );
        Ok(body)
    }
}
fn exported(scan: &Scan<'_>, name: &str, kind: ExternalKind) -> Option<u32> {
    scan.exports
        .iter()
        .find_map(|(label, actual, index)| (label == name && *actual == kind).then_some(*index))
}
