//! Guest-owned original global roots and segment lifetime records. Sparse
//! table snapshots compose separately, after every activation's baseline.
use super::{
    DropBit, FrozenDeclarations, FrozenImports, FrozenModuleBootstrap, ModuleDeclarationBuilder,
    NativeReferenceClass, NativeReferenceCodecs, NativeRuntime, RuntimeInputs, Scan, SourceTypes,
};
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{Function, Instruction, ValType, reencode::Reencode};
use wasm_posix_shared::abi;

mod catalog;
mod emit;
pub(super) mod imports;
#[cfg(test)]
mod tests;
use catalog::Global;
use imports::RecordHost;
pub use imports::RootStateImports;

#[derive(Clone, Copy, Debug)]
pub struct RootStateLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for RootStateLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
        }
    }
}
struct SegmentTracker {
    words: Vec<u32>,
    count: u32,
}
pub struct NativeRootState {
    source: [u8; 32],
    globals: Vec<Global>,
    imported_globals: Vec<u8>,
    elements: SegmentTracker,
    data: SegmentTracker,
    declarations: FrozenDeclarations,
    host: RecordHost,
    references: NativeReferenceCodecs,
    memory: u32,
    pointer: ValType,
    bootstrap_done: u32,
    baseline: u32,
    pub save: u32,
    pub restore: u32,
    pub finish_segments: u32,
    limits: RootStateLimits,
}
impl NativeRootState {
    /// Call before adding root-private globals. Source catalogs exclude all
    /// generated runtime controls, provider tables, typed seeds and imports.
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'_>,
        types: &SourceTypes,
        runtime: &mut NativeRuntime,
        imports: &RootStateImports,
        bootstrap: &FrozenModuleBootstrap,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
        limits: RootStateLimits,
    ) -> Result<Self> {
        first_function
            .checked_add(2)
            .context("root-state helper index overflow")?;
        bootstrap.validate_source(scan)?;
        let frozen = runtime.imports_plan();
        frozen.validate_source(scan)?;
        let source = frozen.source_identity();
        let host = imports.freeze(frozen)?;
        imports.validate_memory(runtime)?;
        let memory = runtime
            .process_memory()
            .context("root state needs process memory")?;
        let pointer = runtime.pointer_type();
        let references = runtime.indices().codecs;
        let (globals, imported_globals) = catalog::globals(scan, types, runtime, module, limits)?;
        let elements = tracker(bootstrap.initially_dropped_elements(), module, limits)?;
        let data = tracker(bootstrap.initially_dropped_data(), module, limits)?;
        Ok(Self {
            source,
            globals,
            imported_globals,
            elements,
            data,
            declarations: FrozenDeclarations::new(
                vec![wasm_encoder::FuncType::new([ValType::I32], [])],
                vec![first_type; 3],
                limits.metadata_bytes,
            )?,
            host,
            references,
            memory,
            pointer,
            bootstrap_done: bootstrap.done_global,
            baseline: bootstrap.restore_baseline,
            save: first_function,
            restore: first_function + 1,
            finish_segments: first_function + 2,
            limits,
        })
    }
    pub(super) fn source_identity(&self) -> [u8; 32] {
        self.source
    }
    pub(super) fn memory_binding(&self) -> (u32, ValType) {
        (self.memory, self.pointer)
    }
    pub(super) fn baseline_matches(&self, bootstrap: &FrozenModuleBootstrap) -> bool {
        self.source == bootstrap.source_identity()
            && self.baseline == bootstrap.restore_baseline
            && self.bootstrap_done == bootstrap.done_global
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn imported_globals_descriptor(&self) -> &[u8] {
        &self.imported_globals
    }
    pub fn data_drop_bits(&self) -> Result<BTreeMap<u32, DropBit>> {
        self.data.bits(self.limits.metadata_bytes)
    }
    pub fn element_drop_bits(&self) -> Result<BTreeMap<u32, DropBit>> {
        self.elements.bits(self.limits.metadata_bytes)
    }
    /// Compose with already-remapped branches, constructors and activation
    /// hooks. Mark a drop only after its original instruction succeeds.
    pub fn emit_source(
        &self,
        source: &wasmparser::Operator<'_>,
        instruction: Instruction<'_>,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        output.instruction(&instruction);
        let bit = match *source {
            wasmparser::Operator::DataDrop { data_index } => self.data.bit(data_index),
            wasmparser::Operator::ElemDrop { elem_index } => self.elements.bit(elem_index),
            _ => None,
        };
        if let Some(bit) = bit {
            output
                .instruction(&Instruction::GlobalGet(bit.global))
                .instruction(&Instruction::I32Const(bit.mask as i32))
                .instruction(&Instruction::I32Or)
                .instruction(&Instruction::GlobalSet(bit.global));
        }
        ensure!(
            output.byte_len() <= limit,
            "root source rewrite exceeds output budget"
        );
        Ok(())
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        emit::helper(self, ordinal, limit)
    }
}
impl SegmentTracker {
    fn bit(&self, segment: u32) -> Option<DropBit> {
        (segment < self.count).then(|| DropBit {
            global: self.words[(segment / 32) as usize],
            mask: 1 << (segment % 32),
        })
    }
    fn bits(&self, budget: usize) -> Result<BTreeMap<u32, DropBit>> {
        ensure!(
            self.count as usize <= budget / 128,
            "segment hook map exceeds metadata budget"
        );
        Ok((0..self.count)
            .map(|segment| (segment, self.bit(segment).unwrap()))
            .collect())
    }
}
fn tracker(
    initial: &[bool],
    module: &mut ModuleDeclarationBuilder<'_, '_>,
    limits: RootStateLimits,
) -> Result<SegmentTracker> {
    ensure!(
        initial.len() <= limits.metadata_bytes / 32,
        "segment trackers exceed metadata budget"
    );
    ensure!(
        initial.len() <= limits.work,
        "segment trackers exceed work budget"
    );
    let mut words = Vec::new();
    for chunk in initial.chunks(32) {
        let bits = chunk
            .iter()
            .enumerate()
            .fold(0u32, |word, (i, dropped)| word | (u32::from(*dropped) << i));
        words.push(module.global(
            wasm_encoder::GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            wasm_encoder::ConstExpr::i32_const(bits as i32),
        )?);
    }
    Ok(SegmentTracker {
        words,
        count: u32::try_from(initial.len())?,
    })
}
