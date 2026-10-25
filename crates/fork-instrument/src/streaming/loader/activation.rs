//! Capture the generated driver separately from original source functions.
//! Its validated scalar-only source is rebuilt and released during emission.
use super::*;
use crate::streaming::*;
use std::collections::BTreeSet;
use wasm_encoder::Instruction;

mod calls;
mod source;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub struct LoaderActivationOptions {
    pub function_ordinal: u32,
    pub first_type: u32,
    pub first_function: u32,
    pub table_guard: Option<u32>,
    pub shared_codecs: bool,
}
pub struct NativeLoaderActivation {
    pub entry: NativeActivationEntry,
    support: FrozenActivationSupport,
    codecs: FrozenFrameCodecs,
    declarations: FrozenDeclarations,
    runtime: NativeRuntimeIndices,
    environment: FrameEnvironment,
    options: LoaderActivationOptions,
    limits: ContinuationLimits,
    source: [u8; 32],
    imports: Option<[u8; 32]>,
    driver_indices: DriverIndices,
}
impl NativeLegacyLoader {
    pub fn plan_activation(
        &self,
        runtime: &NativeRuntime,
        environment: FrameEnvironment,
        options: LoaderActivationOptions,
        limits: ContinuationLimits,
    ) -> Result<Option<NativeLoaderActivation>> {
        let Some(driver) = self.driver else {
            return Ok(None);
        };
        ensure!(
            runtime.imports_plan().source_identity() == self.source
                && runtime.imports_plan().layout_identity() == self.imports,
            "loader activation requires its frozen runtime imports"
        );
        let input = source::input(self, limits.metadata_bytes)?;
        let scan = scan(&input)?;
        let body = scan
            .body_provider(Default::default())
            .load(source::DRIVER)?;
        let mut mapping = source::Mapping(self);
        let types = SourceTypes::new(&scan);
        let plan = NativeActivationPlan::plan(
            &scan,
            &body,
            &types,
            &mut mapping,
            environment,
            &BTreeSet::from([2]),
            limits,
        )?;
        ensure!(
            plan.continuation.references.slots.is_empty(),
            "generated loader driver unexpectedly owns references"
        );
        let mut support = ActivationSupportCatalog::new(
            environment,
            runtime.indices(),
            runtime.frames_start_offset(),
            options.first_type,
            options.first_function,
            limits.metadata_bytes,
        )?;
        if let Some(guard) = options.table_guard {
            support.reconcile_table(self.table, guard)?;
        }
        for call in &plan.continuation.calls {
            support.transport(calls::target(&mut mapping, call.kind)?, &[], &[])?;
        }
        support.result_block(&[ValType::I32])?;
        let resume = support.resume_thunk(
            driver,
            &[ValType::I32],
            &[ValType::I32],
            &plan.continuation.frame,
        )?;
        let support = support.freeze()?;
        let mut codecs = FrameCodecCatalog::new(
            environment,
            runtime.indices(),
            options
                .first_type
                .checked_add(support.declarations().type_count())
                .context("loader codec type overflow")?,
            options
                .first_function
                .checked_add(support.declarations().function_count())
                .context("loader codec function overflow")?,
            limits.metadata_bytes,
        )?;
        if options.shared_codecs {
            let shape = plan
                .continuation
                .frame
                .codec_shape(false, &plan.continuation.references)
                .context("loader scalar frame has no codec shape")?;
            codecs.request(&shape)?;
        }
        let codecs = codecs.freeze()?;
        let declarations = FrozenDeclarations::concatenate(
            &[support.declarations(), codecs.declarations()],
            limits.metadata_bytes,
        )?;
        Ok(Some(NativeLoaderActivation {
            entry: NativeActivationEntry {
                ordinal: options.function_ordinal,
                resume,
            },
            support,
            codecs,
            declarations,
            runtime: runtime.indices(),
            environment,
            options,
            limits,
            source: self.source,
            imports: self.imports,
            driver_indices: DriverIndices {
                next: self.next,
                commit: self.commit,
                checkpoint: self.checkpoint,
                table: self.table,
                initializer_type: self.initializer_type,
            },
        }))
    }
}
impl NativeLoaderActivation {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_driver(&self, loader: &NativeLegacyLoader, limit: usize) -> Result<Function> {
        ensure!(
            loader.source == self.source
                && loader.imports == self.imports
                && self.driver_indices
                    == DriverIndices {
                        next: loader.next,
                        commit: loader.commit,
                        checkpoint: loader.checkpoint,
                        table: loader.table,
                        initializer_type: loader.initializer_type
                    },
            "loader activation bindings changed after freezing"
        );
        let input = source::input(loader, self.limits.metadata_bytes)?;
        let scan = scan(&input)?;
        let body = scan
            .body_provider(Default::default())
            .load(source::DRIVER)?;
        let mut mapping = source::Mapping(loader);
        let mut plan = NativeActivationPlan::plan(
            &scan,
            &body,
            &SourceTypes::new(&scan),
            &mut mapping,
            self.environment,
            &BTreeSet::from([2]),
            self.limits,
        )?;
        plan.catches.bind_frozen_types(&self.support)?;
        plan.legacy.bind_frozen_types(&self.support)?;
        let scalar_codecs = if self.options.shared_codecs {
            Some(
                self.codecs.lookup(
                    &plan
                        .continuation
                        .frame
                        .codec_shape(false, &plan.continuation.references)
                        .context("loader scalar frame has no codec shape")?,
                )?,
            )
        } else {
            None
        };
        emit_native_activation(
            &body,
            &plan,
            ActivationEmission {
                runtime: self.runtime,
                frame_select: self.support.frame_select(),
                function_ordinal: self.entry.ordinal,
                result_block: self.support.lookup_block_type(&[], &[ValType::I32])?,
                scalar_codecs,
                boundary: None,
            },
            &mut calls::Calls {
                mapping,
                support: &self.support,
            },
            DispatchLimits {
                output_bytes: limit,
                metadata_bytes: self.limits.metadata_bytes,
                work: self.limits.work,
            },
        )
    }
    pub fn emit_helper(&self, ordinal: u32, limit: usize) -> Result<Function> {
        if ordinal < self.support.declarations().function_count() {
            self.support.emit_helper(ordinal, limit)
        } else {
            self.codecs.emit_helper(
                ordinal - self.support.declarations().function_count(),
                limit,
            )
        }
    }
}
