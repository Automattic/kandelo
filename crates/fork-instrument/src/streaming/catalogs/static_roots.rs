//! Harvest already-instantiated roots without re-evaluating allocations or
//! retaining them in permanent helper globals. Hosts clear the buffer at once.
use super::*;
use std::collections::BTreeMap;
use wasm_encoder::{FuncType, Function, HeapType, Instruction};
use wasm_posix_shared::abi;
mod discover;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub struct StaticRootLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for StaticRootLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
        }
    }
}
#[derive(Clone, Copy)]
enum Root {
    Global(u32),
    Table { index: u32, wide: bool },
    Element { segment: u32, item: u32 },
}
pub struct StaticRootPlan {
    source: [u8; 32],
    roots: Vec<Root>,
    limits: StaticRootLimits,
}
pub struct NativeStaticRoots {
    roots: Vec<Root>,
    declarations: FrozenDeclarations,
    pub table: u32,
    pub harvest: u32,
    work: usize,
}
impl StaticRootPlan {
    pub fn discover(scan: &Scan<'_>, limits: StaticRootLimits) -> Result<Self> {
        discover::plan(scan, limits)
    }
    pub fn root_count(&self) -> usize {
        self.roots.len()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn freeze<T: Reencode>(
        self,
        scan: &Scan<'_>,
        imports: Option<&FrozenImports>,
        map: &mut T,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Result<NativeStaticRoots>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        ensure!(
            self.source == scan.source_fingerprint(),
            "static roots belong to another source module"
        );
        if let Some(imports) = imports {
            imports.validate_source(scan)?;
        }
        first_type
            .checked_add(1)
            .context("static-root type index overflow")?;
        first_function
            .checked_add(1)
            .context("static-root function index overflow")?;
        let mut roots = Vec::with_capacity(self.roots.len());
        for root in self.roots {
            roots.push(match root {
                Root::Global(index) => Root::Global(map.global_index(index)?),
                Root::Table { index, wide } => Root::Table {
                    index: map.table_index(index)?,
                    wide,
                },
                Root::Element { segment, item } => Root::Element {
                    segment: map.element_index(segment)?,
                    item,
                },
            });
        }
        let table = module.table(fixed_table(RefType::ANYREF, roots.len() as u64), None)?;
        module.export(
            abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
            ExportKind::Table,
            table,
        )?;
        module.export(
            abi::WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
            ExportKind::Func,
            first_function,
        )?;
        Ok(NativeStaticRoots {
            roots,
            table,
            harvest: first_function,
            work: self.limits.work,
            declarations: FrozenDeclarations::new(
                vec![FuncType::new([], [])],
                vec![first_type],
                self.limits.metadata_bytes,
            )?,
        })
    }
}
impl NativeStaticRoots {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn descriptor(&self) -> Vec<u8> {
        let mut bytes =
            Vec::with_capacity(usize::from(abi::WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE));
        bytes.extend_from_slice(&abi::WPK_FORK_STATIC_ROOT_CATALOG_MAGIC);
        bytes.extend_from_slice(&abi::WPK_FORK_STATIC_ROOT_CATALOG_VERSION.to_le_bytes());
        bytes.extend_from_slice(&abi::WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE.to_le_bytes());
        bytes.extend_from_slice(&(self.roots.len() as u32).to_le_bytes());
        bytes
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        ensure!(ordinal == 0, "unknown static-root helper");
        let mut output = Function::new([]);
        let mut work = self.work;
        let mut emit = |instructions: &[Instruction<'_>]| -> Result<()> {
            for instruction in instructions {
                work = work
                    .checked_sub(1)
                    .context("static-root harvest exceeds work budget")?;
                output.instruction(instruction);
                ensure!(
                    output.byte_len() <= limit,
                    "static-root harvest exceeds output budget"
                );
            }
            Ok(())
        };
        if !self.roots.is_empty() {
            emit(&[
                Instruction::I32Const(0),
                Instruction::RefNull(HeapType::ANY),
                Instruction::I32Const(self.roots.len() as i32),
                Instruction::TableFill(self.table),
            ])?;
        }
        for (ordinal, root) in self.roots.iter().enumerate() {
            emit(&[Instruction::I32Const(ordinal as i32)])?;
            match *root {
                Root::Global(index) => emit(&[
                    Instruction::GlobalGet(index),
                    Instruction::TableSet(self.table),
                ])?,
                Root::Table { index, wide } => emit(&[
                    if wide {
                        Instruction::I64Const(0)
                    } else {
                        Instruction::I32Const(0)
                    },
                    Instruction::TableGet(index),
                    Instruction::TableSet(self.table),
                ])?,
                Root::Element { segment, item } => emit(&[
                    Instruction::I32Const(item as i32),
                    Instruction::I32Const(1),
                    Instruction::TableInit {
                        elem_index: segment,
                        table: self.table,
                    },
                ])?,
            }
        }
        emit(&[Instruction::End])?;
        Ok(output)
    }
}
