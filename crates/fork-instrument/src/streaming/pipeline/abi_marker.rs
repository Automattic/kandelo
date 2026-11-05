//! Side modules need a strict constant ABI identity, independent of frames.
use super::*;
use crate::contract_inventory::{ArtifactAbiVersion, artifact_identity};
use anyhow::{Context, bail};
use wasm_encoder::{FuncType, Function, Instruction, ValType};

pub(super) struct AbiMarker {
    declarations: FrozenDeclarations,
}
impl AbiMarker {
    pub fn plan(
        scan: &Scan<'_>,
        side_module: bool,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        cursor: &mut Cursor,
        budget: usize,
    ) -> Result<Self> {
        let needed = if side_module {
            match artifact_identity(scan.input())?.abi_version {
                ArtifactAbiVersion::Missing => true,
                ArtifactAbiVersion::Present(version)
                    if version == wasm_posix_program_abi::ABI_VERSION =>
                {
                    false
                }
                ArtifactAbiVersion::Present(version) => bail!(
                    "side module declares stale __abi_version {version}; expected current ABI {}",
                    wasm_posix_program_abi::ABI_VERSION
                ),
                ArtifactAbiVersion::Invalid => bail!(
                    "side module has an invalid __abi_version export; expected a constant current ABI marker"
                ),
            }
        } else {
            false
        };
        let declarations = if needed {
            cursor.ty.checked_add(1).context("side ABI type overflow")?;
            module.export("__abi_version", ExportKind::Func, cursor.function)?;
            FrozenDeclarations::new(
                vec![FuncType::new([], [ValType::I32])],
                vec![cursor.ty],
                budget,
            )?
        } else {
            FrozenDeclarations::new(Vec::new(), Vec::new(), budget)?
        };
        cursor.advance(&declarations)?;
        Ok(Self { declarations })
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(
            ordinal < self.declarations.function_count(),
            "unknown side ABI helper"
        );
        let mut body = Function::new([]);
        body.instruction(&Instruction::I32Const(
            wasm_posix_program_abi::ABI_VERSION as i32,
        ));
        body.instruction(&Instruction::End);
        ensure!(
            body.byte_len() <= limit,
            "side ABI helper exceeds output budget"
        );
        Ok(body)
    }
}
