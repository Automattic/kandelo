//! Exact-tag exception recipes emitted inside the owning module. The host
//! sees scalar IDs and exchange-memory ranges; exception references stay in
//! Wasm tables and typed helper calls.
use super::{
    FrozenDeclarations, FrozenImports, FrozenReferenceKinds, ModuleDeclarationBuilder,
    NativeReferenceCodecs, PlannedImport, RuntimeInputs, Scan, SourceTypes,
};
use crate::module_exception_codec as abi;
use anyhow::{Context, Result, ensure};
use wasm_encoder::{
    BlockType, EntityType, ExportKind, FuncType, RefType, TableType, ValType, reencode::Reencode,
};

mod emit;
mod imports;
#[cfg(test)]
mod tests;
mod types;
use imports::ExceptionHost;
pub use imports::NativeExceptionImports;

#[derive(Clone, Copy, Debug)]
pub struct ExceptionCodecLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for ExceptionCodecLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
        }
    }
}

struct PayloadLayout {
    ty: ValType,
    class: Option<super::NativeReferenceClass>,
    scalar_offset: Option<u32>,
    reference_offset: Option<u32>,
}
struct TagLayout {
    tag: u32,
    ordinal: u32,
    scalar_len: u32,
    references_ptr: u32,
    reference_count: u32,
    staging_len: u32,
    payloads: Vec<PayloadLayout>,
    capture_type: BlockType,
}

#[derive(Clone, Copy, Debug)]
pub struct NativeExceptionIndices {
    pub encode: u32,
    pub decode: u32,
    pub throw_slot: u32,
    pub throw_recipe: u32,
    pub encode_ingress: u32,
    pub materialize: u32,
    pub clear: u32,
    pub abort: u32,
}

pub struct NativeExceptionCodec {
    layouts: Vec<TagLayout>,
    host: ExceptionHost,
    references: NativeReferenceCodecs,
    indices: NativeExceptionIndices,
    declarations: FrozenDeclarations,
    memory: u32,
    pointer: ValType,
    scratch: u32,
    replay: u32,
    limits: ExceptionCodecLimits,
}

impl NativeExceptionCodec {
    /// Types follow earlier catalogs; functions follow the runtime controls
    /// and any earlier helpers. All dependencies already name final indices.
    /// The source scan excludes the runtime's private tag and generated tables.
    #[allow(clippy::too_many_arguments)]
    pub fn plan<T: Reencode>(
        scan: &Scan<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        imports: &NativeExceptionImports,
        frozen_imports: &FrozenImports,
        references: NativeReferenceCodecs,
        module: &mut ModuleDeclarationBuilder<'_, '_>,
        first_type: u32,
        first_function: u32,
        limits: ExceptionCodecLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let source = scan.types.as_ref();
        ensure!(
            source.tag_count() as usize <= limits.metadata_bytes / 512,
            "exception tags exceed metadata budget"
        );
        let (memory, pointer) = imports.process_memory(frozen_imports)?;
        let kinds = FrozenReferenceKinds::new(scan, map, limits.metadata_bytes)?;
        let mut types = types::TypeCatalog::new(first_type, limits.metadata_bytes);
        let mut function_types = Vec::new();
        let exn = ValType::Ref(RefType::EXNREF);
        for (params, results) in [
            (vec![exn], vec![ValType::I32]),
            (vec![ValType::I32], vec![exn]),
            (vec![ValType::I32], vec![]),
            (vec![ValType::I32], vec![]),
            (vec![ValType::I32], vec![ValType::I32]),
            (vec![ValType::I32], vec![]),
            (vec![], vec![]),
            (vec![], vec![]),
        ] {
            function_types.push(types.intern(&params, &results)?);
        }
        let mut remaining = limits.metadata_bytes;
        let mut work = limits.work;
        let mut layouts = Vec::new();
        for ordinal in 0..source.tag_count() {
            let signature = source
                .get(source.tag_at(ordinal))
                .unwrap()
                .composite_type
                .unwrap_func();
            ensure!(
                signature.results().is_empty(),
                "exception tag unexpectedly has results"
            );
            let cost = signature
                .params()
                .len()
                .checked_mul(256)
                .and_then(|n| n.checked_add(512))
                .context("exception layout metadata overflow")?;
            remaining = remaining
                .checked_sub(cost)
                .context("exception payloads exceed metadata budget")?;
            work = work
                .checked_sub(signature.params().len().saturating_add(1))
                .context("exception layout exceeds work budget")?;
            let mut scalar_len = 0u32;
            let mut reference_count = 0u32;
            let mut payloads = Vec::with_capacity(signature.params().len());
            let mut results = Vec::with_capacity(signature.params().len() + 1);
            for &ty in signature.params() {
                let ty = source_types.value_type(map, ty)?;
                results.push(ty);
                let (class, scalar_offset, reference_offset) = if let ValType::Ref(reference) = ty {
                    let offset = reference_count;
                    reference_count = reference_count
                        .checked_add(1)
                        .context("exception references overflow")?;
                    (Some(kinds.class(reference)?), None, Some(offset))
                } else {
                    let offset = scalar_len;
                    scalar_len = scalar_len
                        .checked_add(super::frame::scalar_size(ty))
                        .context("exception scalar layout overflow")?;
                    (None, Some(offset), None)
                };
                payloads.push(PayloadLayout {
                    ty,
                    class,
                    scalar_offset,
                    reference_offset,
                });
            }
            results.push(ValType::Ref(non_null_exception()));
            let capture_type = BlockType::FunctionType(types.intern(&[], &results)?);
            let references_ptr = scalar_len
                .checked_add(3)
                .context("exception staging layout overflow")?
                & !3;
            let staging_len = reference_count
                .checked_mul(4)
                .and_then(|n| references_ptr.checked_add(n))
                .context("exception staging layout overflow")?
                .max(1);
            layouts.push(TagLayout {
                tag: map.tag_index(ordinal)?,
                ordinal,
                scalar_len,
                references_ptr,
                reference_count,
                staging_len,
                payloads,
                capture_type,
            });
        }
        let table = |maximum| TableType {
            element_type: RefType::EXNREF,
            minimum: 1,
            maximum,
            table64: false,
            shared: false,
        };
        let scratch = module.table(table(Some(1)), None)?;
        let replay = module.table(table(None), None)?;
        let index = |ordinal| {
            first_function
                .checked_add(ordinal)
                .context("exception helper index overflow")
        };
        let indices = NativeExceptionIndices {
            encode: index(0)?,
            decode: index(1)?,
            throw_slot: index(2)?,
            throw_recipe: index(3)?,
            encode_ingress: index(4)?,
            materialize: index(5)?,
            clear: index(6)?,
            abort: index(7)?,
        };
        for (name, function) in [
            (abi::EXPORT_ENCODE, indices.encode),
            (abi::EXPORT_DECODE, indices.decode),
            (abi::EXPORT_THROW_SLOT, indices.throw_slot),
            (abi::EXPORT_THROW_RECIPE, indices.throw_recipe),
            (abi::EXPORT_ENCODE_INGRESS, indices.encode_ingress),
            (abi::EXPORT_MATERIALIZE, indices.materialize),
            (abi::EXPORT_CLEAR, indices.clear),
            (abi::EXPORT_ABORT, indices.abort),
        ] {
            module.export(name, ExportKind::Func, function)?;
        }
        Ok(Self {
            layouts,
            host: imports.resolve(frozen_imports)?,
            references,
            indices,
            declarations: FrozenDeclarations::new(
                types.finish(),
                function_types,
                limits.metadata_bytes,
            )?,
            memory,
            pointer,
            scratch,
            replay,
            limits,
        })
    }
    pub fn indices(&self) -> NativeExceptionIndices {
        self.indices
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    /// Existing descriptor ABI; the caller publishes this bounded custom
    /// section with the completed module, never as a fork capability marker.
    pub fn descriptor(&self) -> Result<Vec<u8>> {
        let length = self
            .layouts
            .len()
            .checked_mul(abi::FORMAT_TAG_RECORD_SIZE)
            .and_then(|n| n.checked_add(abi::FORMAT_HEADER_SIZE))
            .context("exception descriptor overflow")?;
        ensure!(
            length <= self.limits.metadata_bytes,
            "exception descriptor exceeds metadata budget"
        );
        let mut bytes = Vec::with_capacity(length);
        bytes.extend_from_slice(&[abi::FORMAT_VERSION, 0, 0, 0]);
        bytes.extend_from_slice(&(self.layouts.len() as u32).to_le_bytes());
        for layout in &self.layouts {
            for value in [
                layout.ordinal,
                layout.ordinal,
                layout.scalar_len,
                layout.reference_count,
            ] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        Ok(bytes)
    }
}

fn non_null_exception() -> RefType {
    RefType {
        nullable: false,
        ..RefType::EXNREF
    }
}

fn type_index(
    types: &mut Vec<FuncType>,
    base: u32,
    params: &[ValType],
    results: &[ValType],
    budget: usize,
) -> Result<u32> {
    let ordinal = if let Some(index) = types
        .iter()
        .position(|ty| ty.params() == params && ty.results() == results)
    {
        index
    } else {
        // Charge the signature before copying its value vectors.
        FrozenDeclarations::validate_parts(types, &[], budget)?;
        ensure!(
            params.len().saturating_add(results.len()) <= budget / 16,
            "exception type exceeds metadata budget"
        );
        types.push(FuncType::new(
            params.iter().copied(),
            results.iter().copied(),
        ));
        FrozenDeclarations::validate_parts(types, &[], budget)?;
        types.len() - 1
    };
    base.checked_add(u32::try_from(ordinal)?)
        .context("exception type index overflow")
}
