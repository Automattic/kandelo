//! Library-owned assembly of native providers and serial source rewriting.
//! Analysis supplies an original-index closure. Artifact admission, capability
//! certification and production command-line selection remain separate gates.
use super::*;
use anyhow::{Result, ensure};
use std::{collections::BTreeSet, io::Write};
use wasm_encoder::ExportKind;

mod abi_marker;
mod catalogs;
mod emit;
mod entries;
mod input;
mod limits;
mod planning;
mod schedule;
mod sinks;
mod state;
use abi_marker::AbiMarker;
use catalogs::Catalogs;
use entries::EntryBoundaries;
pub use limits::PipelineLimits;
use schedule::Cursor;
use sinks::SinkEntry;
use state::ModuleState;

/// All function and table keys refer to the exact original scan.
#[derive(Default)]
pub struct PipelineOptions {
    pub shared_codecs: bool,
    pub boundaries: BTreeSet<u32>,
    /// Check an existing constant ABI export or add the current one.
    pub side_module: bool,
    /// An explicit process-memory import for a memoryless source. Source
    /// memory zero remains authoritative when the source already has memory.
    pub staging_memory: Option<wasm_encoder::MemoryType>,
}

/// A frozen native rewrite over borrowed, immutable source bytes. This API
/// does not advertise a complete fork artifact to the production host yet.
pub struct NativePipeline<'a> {
    scan: Scan<'a>,
    components: Components<'a>,
    limits: PipelineLimits,
}

struct Components<'a> {
    runtime: NativeRuntime,
    loader: NativeLegacyLoader,
    loader_activation: Option<NativeLoaderActivation>,
    entries: EntryBoundaries,
    abi_marker: AbiMarker,
    sinks: SinkEntry,
    gc_plan: NativeGcPlan,
    constructors: FrozenGcConstructors,
    gc: NativeGcCodec,
    exception: NativeExceptionCodec,
    state: ModuleState,
    activations: NativeActivations<'a>,
    catalogs: Catalogs,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}

impl<'a> NativePipeline<'a> {
    /// Freeze every import, helper, source mapping and module definition before
    /// writing output. The closure must include any legacy loader imports;
    /// generated driver capture is planned in its own small source domain.
    pub fn plan(
        scan: Scan<'a>,
        reaching: ReachingPlan,
        options: PipelineOptions,
        limits: PipelineLimits,
    ) -> Result<Self> {
        let components = planning::plan(&scan, reaching, options, limits)?;
        Ok(Self {
            scan,
            components,
            limits,
        })
    }

    pub fn scan(&self) -> &Scan<'a> {
        &self.scan
    }
    pub fn runtime(&self) -> &NativeRuntime {
        &self.components.runtime
    }
    pub fn activations(&self) -> &NativeActivations<'a> {
        &self.components.activations
    }

    /// Add an explicitly requested export without changing frozen indices.
    /// Useful for embedding tools and diagnostic replay entry points.
    pub fn export(&mut self, name: &str, kind: ExportKind, index: u32) -> Result<()> {
        let mut module = ModuleDeclarationBuilder::from_frozen(
            &self.scan,
            Some(self.components.runtime.imports_plan()),
            self.components.module.clone(),
            self.limits.metadata_bytes,
        )?;
        module.export(name, kind, index)?;
        self.components.module = module.freeze();
        Ok(())
    }

    /// Write serially through the existing private code/data spools. A writer
    /// failure may leave partial bytes; publication belongs to an atomic file
    /// wrapper. Repeated emission from this frozen plan is deterministic.
    pub fn emit<W: Write>(&mut self, output: &mut W) -> Result<EmitReport> {
        let descriptors = self.components.descriptors()?;
        let bytes = descriptors.iter().try_fold(0usize, |total, (name, data)| {
            total.checked_add(name.len())?.checked_add(data.len())
        });
        ensure!(
            bytes.is_some_and(|bytes| bytes <= self.limits.metadata_bytes),
            "native pipeline descriptors exceed metadata budget"
        );
        for (name, data) in &descriptors {
            // Include the section/name length prefixes before any bytes escape.
            ensure!(
                name.len()
                    .checked_add(data.len())
                    .and_then(|n| n.checked_add(16))
                    .is_some_and(|bytes| bytes <= self.limits.emission.max_metadata_section_bytes),
                "native pipeline descriptor exceeds emission budget"
            );
        }
        let report = emit_remapped(
            &self.scan,
            &mut emit::Emitter {
                scan: &self.scan,
                components: &mut self.components,
                ir: self.limits.activations.ir,
            },
            output,
            self.limits.emission,
        )?;
        for (name, data) in descriptors {
            let mut section = wasm_encoder::Module::new();
            section.section(&wasm_encoder::CustomSection {
                name: name.into(),
                data: data.into(),
            });
            output.write_all(&section.finish()[8..])?;
        }
        Ok(report)
    }
}

impl Components<'_> {
    fn descriptors(&self) -> Result<Vec<(&'static str, Vec<u8>)>> {
        let mut descriptors = vec![
            (
                crate::module_gc_codec::FORMAT_SECTION,
                self.gc_plan.descriptor()?,
            ),
            (
                crate::module_exception_codec::FORMAT_SECTION,
                self.exception.descriptor()?,
            ),
            (
                wasm_posix_program_abi::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
                self.state.roots.imported_globals_descriptor().to_vec(),
            ),
            (
                wasm_posix_program_abi::abi::WPK_FORK_IMPORTED_TABLES_SECTION,
                self.state.tables.imported_tables_descriptor().to_vec(),
            ),
            (
                crate::static_reference_catalog::FORMAT_SECTION,
                self.catalogs.roots.descriptor(),
            ),
            (
                crate::instrument::RESUME_CATALOG_SECTION,
                self.catalogs.resume.descriptor().to_vec(),
            ),
        ];
        if let Some(data) = self.sinks.descriptor() {
            descriptors.push((crate::instrument::BOUNDARIES_SECTION, data.to_vec()));
        }
        Ok(descriptors)
    }
}
