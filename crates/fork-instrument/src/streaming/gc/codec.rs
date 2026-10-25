//! Typed module-local GC graph providers. Declarations precede runtime import
//! freezing; the final codec binds the reference providers and module exports.
use super::*;
use crate::streaming::{
    CodecPair, ElementMode, ElementValues, FrozenDeclarations, FrozenImports,
    ModuleDeclarationBuilder, NativeReferenceCodecs, NativeRuntimeIndices, RuntimeInputs,
};
use wasm_encoder::{Function, RefType};

mod emit;
mod imports;
mod seeds;
#[cfg(test)]
mod tests;
use imports::{GcHost, GcImports};
use seeds::Seeds;

#[derive(Clone, Copy, Debug)]
pub struct GcCodecLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for GcCodecLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NativeGcIndices {
    pub encode_anyref: u32,
    pub decode_anyref: u32,
    pub encode_externref: u32,
    pub decode_externref: u32,
    pub probe: u32,
    pub encode_slot: u32,
    pub allocate: u32,
    pub fill: u32,
    pub publish_externref: u32,
}
impl NativeGcIndices {
    fn at(first: u32) -> Result<Self> {
        first.checked_add(8).context("GC helper index overflow")?;
        Ok(Self {
            encode_anyref: first,
            decode_anyref: first + 1,
            encode_externref: first + 2,
            decode_externref: first + 3,
            probe: first + 4,
            encode_slot: first + 5,
            allocate: first + 6,
            fill: first + 7,
            publish_externref: first + 8,
        })
    }
}

pub struct GcCodecPlan {
    memory: crate::streaming::memory::ProcessMemory,
    declarations: FrozenDeclarations,
    imports: GcImports,
    seeds: Seeds,
    first_helper: u32,
    identity: [u8; 32],
    limits: GcCodecLimits,
}
pub struct NativeGcCodec {
    declarations: FrozenDeclarations,
    host: GcHost,
    seeds: Seeds,
    indices: NativeGcIndices,
    references: NativeReferenceCodecs,
    vectors: [u32; 4],
    memory: u32,
    pointer: ValType,
    identity: [u8; 32],
    limits: GcCodecLimits,
}
impl GcCodecPlan {
    /// Source constructor wrappers may precede this catalog. All helper
    /// ordinals, including typed seed functions, are reserved before emission.
    pub fn reserve(
        scan: &Scan<'_>,
        plan: &NativeGcPlan,
        inputs: &mut RuntimeInputs,
        first_helper: u32,
        limits: GcCodecLimits,
    ) -> Result<Self> {
        plan.validate_source(scan)?;
        let memory = inputs
            .process_memory_binding(scan)?
            .context("GC codec needs process memory")?;
        let mut budget = Budget {
            metadata: limits.metadata_bytes,
            work: limits.work,
        };
        budget.step(64)?;
        let mut signatures = provenance::signatures::Signatures::new(scan, inputs, &mut budget)?;
        let imports = GcImports::reserve(scan, inputs, &mut signatures, limits.metadata_bytes)?;
        let i = ValType::I32;
        let any = ValType::Ref(RefType::ANYREF);
        let external = ValType::Ref(RefType::EXTERNREF);
        let mut functions = Vec::new();
        for (params, results) in [
            (vec![any], vec![i]),
            (vec![i], vec![any]),
            (vec![external], vec![i]),
            (vec![i], vec![external]),
            (vec![i], vec![ValType::I64]),
            (vec![i], vec![i]),
            (vec![i], vec![]),
            (vec![i], vec![]),
            (vec![i, external], vec![]),
        ] {
            functions.push(signatures.intern(inputs, params, results)?);
        }
        let seeds = Seeds::reserve(plan, inputs, &mut signatures, &mut functions, &mut budget)?;
        first_helper
            .checked_add(u32::try_from(functions.len())?)
            .context("GC helper ordinal overflow")?;
        FrozenDeclarations::validate_parts(&inputs.types, &functions, limits.metadata_bytes)?;
        Ok(Self {
            memory,
            declarations: FrozenDeclarations::new(vec![], functions, limits.metadata_bytes)?,
            imports,
            seeds,
            first_helper,
            identity: plan.identity,
            limits,
        })
    }
    pub fn helper_count(&self) -> u32 {
        self.declarations.function_count()
    }
    pub fn anyref_codecs(&self) -> CodecPair {
        CodecPair {
            encode: self.first_helper,
            decode: self.first_helper + 1,
        }
    }
    pub fn externref_codecs(&self) -> CodecPair {
        CodecPair {
            encode: self.first_helper + 2,
            decode: self.first_helper + 3,
        }
    }
    pub fn freeze(
        self,
        scan: &Scan<'_>,
        plan: &NativeGcPlan,
        imports: &FrozenImports,
        runtime: NativeRuntimeIndices,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
    ) -> Result<NativeGcCodec> {
        plan.validate_source(scan)?;
        imports.validate_source(scan)?;
        ensure!(
            self.identity == plan.identity,
            "GC codec belongs to another mapped plan"
        );
        let first = imports
            .helper_function_base()
            .checked_add(self.first_helper)
            .context("GC helper index overflow")?;
        let indices = NativeGcIndices::at(first)?;
        ensure!(
            runtime.codecs.anyref.encode == indices.encode_anyref
                && runtime.codecs.anyref.decode == indices.decode_anyref
                && runtime.codecs.externref.encode == indices.encode_externref
                && runtime.codecs.externref.decode == indices.decode_externref,
            "GC runtime codecs disagree with reserved helpers"
        );
        let mut seeds = self.seeds;
        seeds.freeze(first, module)?;
        for (name, function) in [
            (crate::module_gc_codec::EXPORT_PROBE, indices.probe),
            (
                crate::module_gc_codec::EXPORT_ENCODE_SLOT,
                indices.encode_slot,
            ),
            (crate::module_gc_codec::EXPORT_ALLOCATE, indices.allocate),
            (crate::module_gc_codec::EXPORT_FILL, indices.fill),
            (
                crate::module_gc_codec::EXPORT_PUBLISH_EXTERNREF,
                indices.publish_externref,
            ),
        ] {
            module.export(name, wasm_encoder::ExportKind::Func, function)?;
        }
        let pointer = self.memory.pointer;
        let memory = self.memory.resolve(imports)?;
        Ok(NativeGcCodec {
            declarations: self.declarations,
            host: self.imports.freeze(imports)?,
            seeds,
            indices,
            references: runtime.codecs,
            memory,
            pointer,
            identity: self.identity,
            limits: self.limits,
            vectors: [
                runtime.reference_vector_begin,
                runtime.reference_vector_append,
                runtime.reference_vector_finish,
                runtime.reference_vector_get,
            ],
        })
    }
}
impl NativeGcCodec {
    pub fn indices(&self) -> NativeGcIndices {
        self.indices
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_helper(&self, ordinal: u32, plan: &NativeGcPlan, limit: usize) -> Result<Function> {
        ensure!(
            self.identity == plan.identity,
            "GC codec belongs to another mapped plan"
        );
        emit::helper(self, ordinal, plan, limit)
    }
}
