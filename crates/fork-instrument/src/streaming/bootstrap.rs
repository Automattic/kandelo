//! Move original instantiation work into explicit parent/thread/restore phases.
//! Segment indices and bytes stay original; only active segment modes change.
use super::{FrozenDeclarations, FrozenImports, ModuleDeclarationBuilder, Scan};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use wasm_encoder::{
    ConstExpr, ExportKind, FuncType, Function, GlobalType, ValType, reencode::Reencode,
};
use wasmparser::{DataKind, ElementItems, ElementKind, Parser, Payload};

mod emit;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub struct BootstrapLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for BootstrapLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
        }
    }
}
struct ActiveSegment<'a> {
    segment: u32,
    destination: u32,
    offset: wasmparser::ConstExpr<'a>,
    len: u32,
}
struct Initializer {
    segment: u32,
    destination: u32,
    offset_global: u32,
    len: u32,
}

pub struct ModuleBootstrapPlan<'a> {
    elements: Vec<ActiveSegment<'a>>,
    data: Vec<ActiveSegment<'a>>,
    element_dropped: Vec<bool>,
    data_dropped: Vec<bool>,
    start: Option<u32>,
    source: [u8; 32],
    limits: BootstrapLimits,
}
pub struct FrozenModuleBootstrap {
    source: [u8; 32],
    elements: Vec<Initializer>,
    data: Vec<Initializer>,
    element_dropped: Vec<bool>,
    data_dropped: Vec<bool>,
    start: Option<u32>,
    declarations: FrozenDeclarations,
    /// Module-state restore sets this after restoring globals/table baselines.
    pub done_global: u32,
    pub parent: u32,
    pub thread: u32,
    pub restore_baseline: u32,
    limits: BootstrapLimits,
}

impl<'a> ModuleBootstrapPlan<'a> {
    pub fn discover(scan: &Scan<'a>, limits: BootstrapLimits) -> Result<Self> {
        let mut output = Self {
            elements: Vec::new(),
            data: Vec::new(),
            element_dropped: Vec::new(),
            data_dropped: Vec::new(),
            start: scan.start,
            source: Sha256::digest(scan.input()).into(),
            limits,
        };
        let mut metadata = limits.metadata_bytes;
        let mut work = limits.work;
        for payload in Parser::new(0).parse_all(scan.input()) {
            match payload? {
                Payload::ElementSection(section) => {
                    charge(
                        &mut metadata,
                        (section.count() as usize)
                            .checked_mul(16)
                            .context("bootstrap segment metadata overflow")?,
                    )?;
                    for (index, element) in section.into_iter().enumerate() {
                        step(&mut work)?;
                        let element = element?;
                        output
                            .element_dropped
                            .push(!matches!(element.kind, ElementKind::Passive));
                        if let ElementKind::Active {
                            table_index,
                            offset_expr,
                        } = element.kind
                        {
                            charge_offset(&mut metadata, &mut work, &offset_expr)?;
                            let len = match element.items {
                                ElementItems::Functions(items) => items.count(),
                                ElementItems::Expressions(_, items) => items.count(),
                            };
                            output.elements.push(ActiveSegment {
                                segment: u32::try_from(index)?,
                                destination: table_index.unwrap_or(0),
                                offset: offset_expr,
                                len,
                            });
                        }
                    }
                }
                Payload::DataSection(section) => {
                    charge(
                        &mut metadata,
                        (section.count() as usize)
                            .checked_mul(16)
                            .context("bootstrap segment metadata overflow")?,
                    )?;
                    for (index, data) in section.into_iter().enumerate() {
                        step(&mut work)?;
                        let data = data?;
                        output
                            .data_dropped
                            .push(!matches!(data.kind, DataKind::Passive));
                        if let DataKind::Active {
                            memory_index,
                            offset_expr,
                        } = data.kind
                        {
                            charge_offset(&mut metadata, &mut work, &offset_expr)?;
                            output.data.push(ActiveSegment {
                                segment: u32::try_from(index)?,
                                destination: memory_index,
                                offset: offset_expr,
                                len: u32::try_from(data.data.len())?,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(output)
    }
    /// All indices are final. Offset expressions become immutable globals so
    /// the VM evaluates extended-const expressions exactly once per instance.
    #[allow(clippy::too_many_arguments)]
    pub fn freeze<T: Reencode>(
        self,
        scan: &Scan<'_>,
        imports: Option<&FrozenImports>,
        map: &mut T,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
    ) -> Result<FrozenModuleBootstrap>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        ensure!(
            self.source == <[u8; 32]>::from(Sha256::digest(scan.input())),
            "bootstrap plan belongs to another source module"
        );
        if let Some(imports) = imports {
            imports.validate_source(scan)?;
        }
        first_function
            .checked_add(2)
            .context("bootstrap function index overflow")?;
        let mut elements = Vec::with_capacity(self.elements.len());
        for active in self.elements {
            let pointer = if scan.types.as_ref().table_at(active.destination).table64 {
                ValType::I64
            } else {
                ValType::I32
            };
            elements.push(Initializer {
                segment: map.element_index(active.segment)?,
                destination: map.table_index(active.destination)?,
                offset_global: module.global(
                    GlobalType {
                        val_type: pointer,
                        mutable: false,
                        shared: false,
                    },
                    map.const_expr(active.offset)?,
                )?,
                len: active.len,
            });
        }
        let mut data = Vec::with_capacity(self.data.len());
        for active in self.data {
            let pointer = if scan.types.as_ref().memory_at(active.destination).memory64 {
                ValType::I64
            } else {
                ValType::I32
            };
            data.push(Initializer {
                segment: map.data_index(active.segment)?,
                destination: map.memory_index(active.destination)?,
                offset_global: module.global(
                    GlobalType {
                        val_type: pointer,
                        mutable: false,
                        shared: false,
                    },
                    map.const_expr(active.offset)?,
                )?,
                len: active.len,
            });
        }
        let done_global = module.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            ConstExpr::i32_const(0),
        )?;
        for (name, index) in [
            (
                wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
                first_function,
            ),
            (
                wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP,
                first_function + 1,
            ),
        ] {
            module.export(name, ExportKind::Func, index)?;
        }
        Ok(FrozenModuleBootstrap {
            source: self.source,
            elements,
            data,
            element_dropped: self.element_dropped,
            data_dropped: self.data_dropped,
            start: self
                .start
                .map(|start| map.function_index(start))
                .transpose()?,
            declarations: FrozenDeclarations::new(
                vec![FuncType::new([], [])],
                vec![first_type; 3],
                self.limits.metadata_bytes,
            )?,
            done_global,
            parent: first_function,
            thread: first_function + 1,
            restore_baseline: first_function + 2,
            limits: self.limits,
        })
    }
}
impl FrozenModuleBootstrap {
    pub(super) fn source_identity(&self) -> [u8; 32] {
        self.source
    }
    pub(super) fn validate_source(&self, scan: &Scan<'_>) -> Result<()> {
        ensure!(
            self.source == <[u8; 32]>::from(Sha256::digest(scan.input())),
            "frozen bootstrap belongs to another source module"
        );
        Ok(())
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn initially_dropped_elements(&self) -> &[bool] {
        &self.element_dropped
    }
    pub fn initially_dropped_data(&self) -> &[bool] {
        &self.data_dropped
    }
    /// 0: parent initialization; 1: pthread initialization; 2: fork baseline.
    /// The fork baseline keeps converted segments physically live for codecs.
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        emit::helper(self, ordinal, limit)
    }
}
fn charge(metadata: &mut usize, bytes: usize) -> Result<()> {
    *metadata = metadata
        .checked_sub(bytes)
        .context("bootstrap exceeds metadata budget")?;
    Ok(())
}
fn charge_offset(
    metadata: &mut usize,
    work: &mut usize,
    expr: &wasmparser::ConstExpr<'_>,
) -> Result<()> {
    let bytes = expr.get_binary_reader().bytes_remaining();
    *work = work
        .checked_sub(bytes)
        .context("bootstrap offset exceeds work budget")?;
    let size = bytes
        .checked_add(128)
        .context("bootstrap offset metadata overflow")?;
    charge(metadata, size)
}
fn step(work: &mut usize) -> Result<()> {
    *work = work
        .checked_sub(1)
        .context("bootstrap exceeds work budget")?;
    Ok(())
}
