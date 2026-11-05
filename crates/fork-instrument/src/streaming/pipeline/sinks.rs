//! A sink child starts at its outermost captured frame. Unexpected return goes
//! back to the host's invariant check, preserving real guest trap signals.
use super::*;
use anyhow::Context;
use std::collections::BTreeMap;
use wasm_encoder::{BlockType, FuncType, Function, Instruction, ValType};

pub(super) struct SinkEntry {
    declarations: FrozenDeclarations,
    signatures: Vec<u32>,
    descriptor: Option<Vec<u8>>,
    runtime: NativeRuntimeIndices,
}
impl SinkEntry {
    pub fn plan(
        scan: &Scan<'_>,
        runtime: &mut NativeRuntime,
        boundaries: &BTreeSet<u32>,
        activations: &NativeActivations<'_>,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        cursor: &mut Cursor,
        budget: usize,
    ) -> Result<Self> {
        ensure!(
            boundaries.len() <= budget.saturating_sub(12) / 128,
            "sink entry exceeds metadata budget"
        );
        let source_types = SourceTypes::new(scan);
        let mut signatures = Vec::new();
        let mut types = Vec::new();
        let mut by_results = BTreeMap::new();
        let mut entries = Vec::new();
        let mut remaining = budget;
        for &function in boundaries {
            remaining = remaining
                .checked_sub(128)
                .context("sink entries exceed metadata budget")?;
            let entry = activations
                .entry(function)
                .context("sink boundary lacks an activation")?;
            let ty = scan
                .types
                .as_ref()
                .core_type_at_in_module(scan.functions[function as usize].ty);
            let results = scan
                .types
                .as_ref()
                .get(ty)
                .unwrap()
                .composite_type
                .unwrap_func()
                .results();
            ensure!(
                results.len() <= budget / 128,
                "sink result signature exceeds metadata budget"
            );
            let results = results
                .iter()
                .map(|&ty| source_types.value_type(runtime, ty))
                .collect::<Result<Vec<_>>>()?;
            let signature = if let Some(&signature) = by_results.get(&results) {
                signature
            } else {
                let charge = results
                    .len()
                    .checked_mul(256)
                    .and_then(|bytes| bytes.checked_add(512))
                    .context("sink signature size overflow")?;
                remaining = remaining
                    .checked_sub(charge)
                    .context("sink signatures exceed metadata budget")?;
                let signature = u32::try_from(types.len())?;
                let ty = cursor
                    .ty
                    .checked_add(signature)
                    .context("sink type index overflow")?;
                types.push(FuncType::new([], results.iter().copied()));
                signatures.push(ty);
                by_results.insert(results, signature);
                signature
            };
            entries.push((entry.ordinal, signature));
        }
        let mut functions = Vec::new();
        let descriptor = if entries.is_empty() {
            None
        } else {
            let ty = cursor
                .ty
                .checked_add(u32::try_from(types.len())?)
                .context("sink entry type overflow")?;
            types.push(FuncType::new([ValType::I32], []));
            functions.push(ty);
            module.export(
                crate::instrument::RESUME_SINK_EXPORT,
                ExportKind::Func,
                cursor.function,
            )?;
            let mut data = b"KFSB\x01\0\0\0".to_vec();
            data.extend_from_slice(&u32::try_from(entries.len())?.to_le_bytes());
            for (ordinal, signature) in entries {
                data.extend_from_slice(&ordinal.to_le_bytes());
                data.extend_from_slice(&signature.to_le_bytes());
            }
            Some(data)
        };
        let declarations = FrozenDeclarations::new(types, functions, budget)?;
        cursor.advance(&declarations)?;
        Ok(Self {
            declarations,
            signatures,
            descriptor,
            runtime: runtime.indices(),
        })
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn descriptor(&self) -> Option<&[u8]> {
        self.descriptor.as_deref()
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(
            ordinal == 0 && self.descriptor.is_some(),
            "unknown sink entry helper"
        );
        let mut body = Function::new([]);
        ensure!(
            self.signatures.len() <= limit / 6,
            "sink entry exceeds output budget"
        );
        for _ in &self.signatures {
            body.instruction(&Instruction::Block(BlockType::Empty));
        }
        body.instruction(&Instruction::LocalGet(0));
        body.instruction(&Instruction::BrTable(
            (0..u32::try_from(self.signatures.len())?)
                .collect::<Vec<_>>()
                .into(),
            u32::try_from(self.signatures.len() - 1)?,
        ));
        for &signature in &self.signatures {
            body.instruction(&Instruction::End);
            body.instruction(&Instruction::I32Const(0));
            body.instruction(&Instruction::Call(self.runtime.resume_peek));
            body.instruction(&Instruction::CallIndirect {
                type_index: signature,
                table_index: self.runtime.resume_table,
            });
            // WHY: a synthetic trap here would look like a guest SIGILL. A
            // normal return lets the host diagnose a violated sink proof.
            body.instruction(&Instruction::Return);
            ensure!(body.byte_len() <= limit, "sink entry exceeds output budget");
        }
        body.instruction(&Instruction::End);
        ensure!(body.byte_len() <= limit, "sink entry exceeds output budget");
        Ok(body)
    }
}
