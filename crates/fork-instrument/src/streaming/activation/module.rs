//! Module-wide activation declarations with one ephemeral local plan per pass.
//! Frozen catalogs retain helper recipes and compact entries, never body IR.
use crate::streaming::*;
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{Function, Instruction, reencode::Reencode};
mod hooks;
mod planning;
#[cfg(test)]
mod tests;
pub use hooks::NativeSourceHooks;

#[derive(Clone, Copy, Debug)]
pub struct ActivationModuleLimits {
    pub metadata_bytes: usize,
    pub work: usize,
    pub ir: IrLimits,
    pub continuation: ContinuationLimits,
    pub tails: TailLimits,
}
impl Default for ActivationModuleLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: crate::limits::MODULE_METADATA_BYTES,
            work: crate::limits::TOTAL_WORK,
            ir: IrLimits::default(),
            continuation: ContinuationLimits::default(),
            tails: TailLimits::default(),
        }
    }
}
#[derive(Default)]
pub struct ActivationModuleOptions {
    pub shared_codecs: bool,
    /// Original table index -> final reconciliation helper.
    pub table_guards: BTreeMap<u32, u32>,
    /// Original function index -> final sink-boundary callback.
    pub boundaries: BTreeMap<u32, u32>,
}
#[derive(Clone, Copy, Debug)]
pub struct NativeActivationEntry {
    pub ordinal: u32,
    pub resume: u32,
}
pub struct NativeActivations<'a> {
    source: &'a [u8],
    runtime: NativeRuntimeIndices,
    types: SourceTypes,
    kinds: FrozenReferenceKinds,
    reaching: ReachingPlan,
    environment: FrameEnvironment,
    entries: BTreeMap<u32, NativeActivationEntry>,
    support: FrozenActivationSupport,
    codecs: FrozenFrameCodecs,
    declarations: FrozenDeclarations,
    options: ActivationModuleOptions,
    limits: ActivationModuleLimits,
}
impl<'a> NativeActivations<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn plan(
        scan: &Scan<'a>,
        runtime: &mut NativeRuntime,
        reaching: ReachingPlan,
        first_type: u32,
        first_function: u32,
        options: ActivationModuleOptions,
        limits: ActivationModuleLimits,
    ) -> Result<Self> {
        planning::plan(
            scan,
            runtime,
            reaching,
            first_type,
            first_function,
            options,
            limits,
        )
    }
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn entry(&self, source_function: u32) -> Option<NativeActivationEntry> {
        self.entries.get(&source_function).copied()
    }
    pub fn entries(&self) -> impl Iterator<Item = (u32, NativeActivationEntry)> + '_ {
        self.entries
            .iter()
            .map(|(&function, &entry)| (function, entry))
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
    /// Rebuild, emit and release one local plan. Source hooks also run for
    /// transparent tail functions and functions outside the capture closure.
    pub fn emit_function<T: NativeSourceHooks>(
        &self,
        scan: &Scan<'a>,
        body: &FunctionIr<'_>,
        hooks: &mut T,
        limit: usize,
    ) -> Result<Function>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        ensure!(
            std::ptr::eq(self.source, scan.input()),
            "activation catalog requires its original source bytes"
        );
        let summary = scan
            .functions
            .get(body.function as usize)
            .and_then(|function| function.body.as_ref())
            .context("activation emission requires a source body")?;
        ensure!(
            summary.range == body.source.range()
                && std::ptr::eq(&scan.input()[summary.range.clone()], body.source.as_bytes()),
            "activation emission requires the original body"
        );
        let tails = TailTransferPlan::from_frozen(
            scan,
            body,
            &self.types,
            hooks,
            &self.reaching.tail_sites,
            &self.support,
            self.limits.tails,
        )?;
        let Some(entry) = self.entries.get(&body.function) else {
            let mut output = hooks.new_function_with_parsed_locals(&body.source)?;
            for source in &body.instructions {
                let mapped = hooks.instruction(source.operation.clone())?;
                let instruction = tails.rewrite(source.point, mapped)?;
                hooks.emit_native_source(source, instruction, &mut output, limit)?;
                ensure!(
                    output.byte_len() <= limit,
                    "activation source exceeds output budget"
                );
            }
            return Ok(output);
        };
        let mut plan = NativeActivationPlan::plan(
            scan,
            body,
            &self.types,
            hooks,
            self.environment,
            &self.reaching.control_reachable,
            self.limits.continuation,
        )?;
        plan.bind_tail_transfers(tails)?;
        plan.bind_reference_io(&self.kinds, self.limits.metadata_bytes)?;
        plan.catches.bind_frozen_types(&self.support)?;
        plan.legacy.bind_frozen_types(&self.support)?;
        let scalar_codecs = if self.options.shared_codecs {
            plan.continuation
                .frame
                .codec_shape(
                    plan.catches.selector.is_some(),
                    &plan.continuation.references,
                )
                .map(|shape| self.codecs.lookup(&shape))
                .transpose()?
        } else {
            None
        };
        let emission = ActivationEmission {
            runtime: self.runtime,
            frame_select: self.support.frame_select(),
            function_ordinal: entry.ordinal,
            result_block: self.support.lookup_block_type(&[], &plan.results)?,
            scalar_codecs,
            boundary: self.options.boundaries.get(&body.function).copied(),
        };
        emit_native_activation(
            body,
            &plan,
            emission,
            &mut hooks::Calls {
                catalog: self,
                scan,
                hooks,
            },
            DispatchLimits {
                output_bytes: limit,
                metadata_bytes: self.limits.continuation.metadata_bytes,
                work: self.limits.continuation.work,
            },
        )
    }
}
