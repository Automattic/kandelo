use super::{
    CatchLimits, FrozenReferenceKinds, NativeCatchPlan, NativeReferenceIo, TailTransferPlan,
    tails::is_tail_transfer,
};
use crate::streaming::runtime::{load, ptr_const, store};
use crate::streaming::{
    CallContinuation, CatchFrameIo, ContinuationHooks, ContinuationLimits, ContinuationPlan,
    DispatchEnvironment, DispatchLimits, FrameAddress, FrameCodecPair, FrameEnvironment,
    FrameLayout, FunctionIr, LegacyHandlerLimits, LocalKey, NativeLegacyPlan, NativeRuntimeIndices,
    RegionId, RegionKind, Scan, SourceInstruction, SourceTypes, emit_dispatch,
    plan_continuations_with,
};
use anyhow::{Context, Result, ensure};
use std::{borrow::Cow, collections::BTreeSet};
use wasm_encoder::{
    BlockType, Catch, Function, Instruction, MemArg, ValType,
    reencode::{Error, Reencode},
};

pub struct NativeActivationPlan {
    pub continuation: ContinuationPlan,
    pub call_selector: Option<LocalKey>,
    pub results: Vec<ValType>,
    pub environment: FrameEnvironment,
    pub reference_io: Option<NativeReferenceIo>,
    pub tail_transfers: Option<TailTransferPlan>,
    pub catches: NativeCatchPlan,
    pub legacy: NativeLegacyPlan,
}
impl NativeActivationPlan {
    #[allow(clippy::too_many_arguments)]
    pub fn plan<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        environment: FrameEnvironment,
        targets: &BTreeSet<u32>,
        limits: ContinuationLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let types = scan.types.as_ref();
        let signature = types
            .get(types.core_type_at_in_module(body.type_index))
            .context("unknown activation signature")?
            .composite_type
            .unwrap_func();
        let results = signature
            .results()
            .iter()
            .map(|&t| source_types.value_type(map, t))
            .collect::<Result<Vec<_>>>()?;
        let mut catches = NativeCatchPlan::discover(
            scan,
            body,
            source_types,
            map,
            CatchLimits {
                metadata_bytes: limits.metadata_bytes,
                work: limits.work,
            },
        )?;
        let mut legacy = NativeLegacyPlan::discover(
            scan,
            body,
            source_types,
            map,
            LegacyHandlerLimits {
                metadata_bytes: limits.metadata_bytes,
                work: limits.work,
            },
        )?;
        let (continuation, call_selector) = plan_continuations_with(
            scan,
            body,
            source_types,
            map,
            environment,
            targets,
            limits,
            |frame, calls, _, references| {
                catches.allocate(frame, references)?;
                legacy.allocate(frame, calls, references)?;
                if calls.len() > 1 {
                    Ok(Some(frame.temporary(ValType::I32)?))
                } else {
                    Ok(None)
                }
            },
        )?;
        ensure!(
            !continuation.calls.is_empty(),
            "activation has no ordinary call landings"
        );
        Ok(Self {
            continuation,
            call_selector,
            results,
            environment,
            reference_io: None,
            tail_transfers: None,
            catches,
            legacy,
        })
    }
    pub fn bind_tail_transfers(&mut self, tails: TailTransferPlan) -> Result<()> {
        ensure!(
            tails.function() == self.continuation.function,
            "tail plan names another activation"
        );
        self.tail_transfers = Some(tails);
        Ok(())
    }
    pub fn bind_reference_io(&mut self, kinds: &FrozenReferenceKinds, budget: usize) -> Result<()> {
        self.reference_io = Some(NativeReferenceIo::plan(
            &self.continuation.references,
            kinds,
            budget,
        )?);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ActivationEmission {
    pub runtime: NativeRuntimeIndices,
    pub frame_select: u32,
    pub function_ordinal: u32,
    pub result_block: BlockType,
    pub scalar_codecs: Option<FrameCodecPair>,
    /// A frozen sink boundary import, if this activation owns a capture root.
    pub boundary: Option<u32>,
}

/// Linked-frame wrapper, including explicit catch ownership and live restart.
/// Modern/legacy control types and tail routes must be bound before emission.
/// Legacy arms lower around their existing source continuation sequences.
///
/// The dispatcher sits inside seven labels, outside-to-inside:
/// `normal_exit -> escaping_exception -> outer_try -> restart_loop ->
/// postamble -> private_catch -> private_try`. Source returns cross all seven
/// to the typed normal exit, where scratch storage is released. The private
/// catch instead selects a frame, then either saves it or restarts the live
/// activation after allocation failure. Keep these depths and the cleanup
/// paths together when changing the wrapper.
pub fn emit_native_activation<T: ContinuationHooks>(
    body: &FunctionIr<'_>,
    plan: &NativeActivationPlan,
    emission: ActivationEmission,
    hooks: &mut T,
    limits: DispatchLimits,
) -> Result<Function>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    let continuation = &plan.continuation;
    let layout = &continuation.frame;
    let runtime = emission.runtime;
    ensure!(
        plan.environment.memory.is_some(),
        "activation requires linear memory"
    );
    ensure!(
        body.regions
            .iter()
            .enumerate()
            .all(|(index, region)| region.kind != RegionKind::LegacyTry
                || !body.instructions[region.opener.unwrap()].retained
                || plan.legacy.delegates.contains_key(&RegionId(index))
                || plan.legacy.regions.contains_key(&RegionId(index))),
        "native activation is missing its legacy control plan"
    );
    ensure!(
        plan.tail_transfers.is_some()
            || body
                .instructions
                .iter()
                .all(|source| !source.retained || !is_tail_transfer(&source.operation)),
        "native activation tail-transfer plan is not installed"
    );
    ensure!(
        plan.reference_io.is_some()
            || (continuation.references.slots.is_empty()
                && continuation
                    .references
                    .null_locals_by_call
                    .iter()
                    .all(Vec::is_empty)),
        "native activation reference-frame I/O is not installed"
    );
    plan.catches.validate_emission()?;
    plan.legacy.validate_emission()?;
    let shape = layout.codec_shape(plan.catches.selector.is_some(), &continuation.references);
    ensure!(
        emission.scalar_codecs.is_none() || shape.is_some(),
        "scalar codec is unavailable for this activation shape"
    );
    let mut output = layout.new_function();
    layout.emit_scratch_reserve(&mut output, limits.output_bytes)?;
    output.instruction(&Instruction::GlobalGet(runtime.state_global));
    output.instruction(&Instruction::I32Const(crate::runtime::STATE_REWINDING));
    output.instruction(&Instruction::I32GeU);
    output.instruction(&Instruction::If(BlockType::Empty));
    restore_scalars(plan, emission, &mut output, limits.output_bytes)?;
    if let Some(io) = &plan.reference_io {
        io.emit_restore(
            &continuation.references,
            layout,
            plan.environment,
            runtime,
            &mut output,
            limits.output_bytes,
        )?;
    }
    output.instruction(&Instruction::End);
    output.instruction(&Instruction::Block(emission.result_block)); // common normal exit
    output.instruction(&Instruction::Block(BlockType::Result(ValType::EXNREF))); // escaping exception
    output.instruction(&Instruction::TryTable(
        BlockType::Empty,
        Cow::Owned(vec![Catch::AllRef { label: 0 }]),
    ));
    output.instruction(&Instruction::Loop(BlockType::Empty)); // live abort/boundary restart
    layout.emit_scratch_reseed(&mut output, limits.output_bytes)?;
    output.instruction(&Instruction::Block(BlockType::Empty)); // selected postamble
    output.instruction(&Instruction::Block(BlockType::Empty)); // private catch landing
    output.instruction(&Instruction::TryTable(
        BlockType::Empty,
        Cow::Owned(vec![Catch::One {
            tag: runtime.unwind_tag,
            label: 0,
        }]),
    ));
    let mut adapter = CaptureHooks {
        hooks,
        selector: plan.call_selector,
        tails: plan.tail_transfers.as_ref(),
        catches: &plan.catches,
        runtime,
    };
    emit_dispatch(
        body,
        continuation,
        Some((&plan.legacy, runtime.unwind_tag)),
        &mut adapter,
        &mut output,
        DispatchEnvironment {
            state_global: runtime.state_global,
            call_index_global: runtime.call_index_global,
            enclosing_blocks: 7,
            function_exit_block: Some(0),
        },
        limits,
    )?;
    output.instruction(&Instruction::Br(6)); // source fallthrough returns through cleanup
    output.instruction(&Instruction::End);
    output.instruction(&Instruction::Unreachable);
    output.instruction(&Instruction::End);
    layout.emit_scratch_reseed(&mut output, limits.output_bytes)?;
    if let Some(selector) = plan.call_selector {
        layout.emit_get(selector, &mut output, limits.output_bytes)?;
    } else {
        output.instruction(&Instruction::I32Const(0));
    }
    output.instruction(&ptr_const(plan.environment.pointer, i64::from(layout.size)));
    output.instruction(&Instruction::Call(emission.frame_select));
    output.instruction(&Instruction::BrIf(0));
    output.instruction(&Instruction::Br(1));
    output.instruction(&Instruction::End);
    save_frame(plan, emission, &mut output, limits.output_bytes)?;
    if let Some(boundary) = emission.boundary {
        output.instruction(&Instruction::Call(boundary));
        output.instruction(&ptr_const(plan.environment.pointer, i64::from(layout.size)));
        output.instruction(&Instruction::Call(runtime.frame_next));
        output.instruction(&Instruction::Drop);
        output.instruction(&Instruction::Br(0));
    } else {
        output.instruction(&Instruction::Throw(runtime.unwind_tag));
    }
    output.instruction(&Instruction::End);
    output.instruction(&Instruction::Unreachable);
    output.instruction(&Instruction::End);
    output.instruction(&Instruction::Unreachable);
    output.instruction(&Instruction::End);
    layout.emit_scratch_release(&mut output, limits.output_bytes)?;
    output.instruction(&Instruction::ThrowRef);
    output.instruction(&Instruction::End);
    layout.emit_scratch_release(&mut output, limits.output_bytes)?;
    output.instruction(&Instruction::End);
    ensure!(
        output.byte_len() <= limits.output_bytes,
        "native activation exceeds output budget"
    );
    Ok(output)
}

fn frame_field(plan: &NativeActivationPlan, ty: ValType, offset: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align: match ty {
            ValType::I32 | ValType::F32 => 2,
            ValType::I64 | ValType::F64 => 3,
            ValType::V128 => 4,
            _ => unreachable!(),
        },
        memory_index: plan.environment.memory.unwrap(),
    }
}
fn emit_frame_address(
    plan: &NativeActivationPlan,
    runtime: NativeRuntimeIndices,
    output: &mut Function,
) {
    output.instruction(&Instruction::GlobalGet(runtime.buf_global));
    output.instruction(&load(
        plan.environment.pointer,
        frame_field(plan, plan.environment.pointer, 0),
    ));
}
fn is_stored_in_wasm_local(layout: &FrameLayout, key: LocalKey) -> bool {
    !layout
        .scratch
        .as_ref()
        .is_some_and(|s| s.offsets.contains_key(&key))
}
fn restore_scalars(
    plan: &NativeActivationPlan,
    emission: ActivationEmission,
    output: &mut Function,
    limit: usize,
) -> Result<()> {
    let runtime = emission.runtime;
    let layout = &plan.continuation.frame;
    let pointer_type = plan.environment.pointer;
    let mut helper_scalar_available =
        emission.scalar_codecs.is_some() && plan.catches.selector.is_none();
    if let Some(codecs) = emission.scalar_codecs {
        output.instruction(&ptr_const(pointer_type, i64::from(layout.size)));
        output.instruction(&Instruction::Call(codecs.restore));
        if let Some(selector) = plan.catches.selector {
            layout.emit_set(selector, output, limit)?;
        }
    } else {
        output.instruction(&Instruction::GlobalGet(runtime.buf_global));
        output.instruction(&ptr_const(pointer_type, i64::from(layout.size)));
        output.instruction(&Instruction::Call(runtime.frame_next));
        output.instruction(&store(pointer_type, frame_field(plan, pointer_type, 0)));
        emit_frame_address(plan, runtime, output);
        output.instruction(&Instruction::GlobalSet(runtime.frame_global));
        output.instruction(&Instruction::GlobalGet(runtime.frame_global));
        output.instruction(&load(ValType::I32, frame_field(plan, ValType::I32, 4)));
        output.instruction(&Instruction::GlobalSet(runtime.call_index_global));
        if let Some(selector) = plan.catches.selector {
            output.instruction(&Instruction::GlobalGet(runtime.frame_global));
            output.instruction(&load(ValType::I32, frame_field(plan, ValType::I32, 8)));
            layout.emit_set(selector, output, limit)?;
        }
    }
    for field in &layout.fields {
        if !is_stored_in_wasm_local(layout, field.local) {
            continue;
        }
        // Shared restore returns at most one value: the catch selector when
        // present, otherwise the first scalar. Load all remaining fields here.
        if !helper_scalar_available {
            output.instruction(&Instruction::GlobalGet(runtime.frame_global));
            output.instruction(&load(field.ty, frame_field(plan, field.ty, field.offset)));
        }
        layout.emit_set(field.local, output, limit)?;
        helper_scalar_available = false;
    }
    layout.emit_scratch_restore(FrameAddress::Global(runtime.frame_global), output, limit)?;
    if let Some(selector) = plan.catches.selector {
        layout.emit_catch_scalars(
            FrameAddress::Global(runtime.frame_global),
            selector,
            CatchFrameIo::Restore,
            output,
            limit,
        )?;
    }
    Ok(())
}
fn save_frame(
    plan: &NativeActivationPlan,
    emission: ActivationEmission,
    output: &mut Function,
    limit: usize,
) -> Result<()> {
    let runtime = emission.runtime;
    let layout = &plan.continuation.frame;
    if let Some(codecs) = emission.scalar_codecs {
        output.instruction(&Instruction::I32Const(emission.function_ordinal as i32));
        if let Some(selector) = plan.catches.selector {
            layout.emit_get(selector, output, limit)?;
        }
        for field in &layout.fields {
            if is_stored_in_wasm_local(layout, field.local) {
                layout.emit_get(field.local, output, limit)?;
            }
        }
        output.instruction(&Instruction::Call(codecs.save));
    } else {
        for (offset, value) in [(0, emission.function_ordinal), (8, 0), (12, 0)] {
            emit_frame_address(plan, runtime, output);
            if offset == 8 && plan.catches.selector.is_some() {
                layout.emit_get(plan.catches.selector.unwrap(), output, limit)?;
            } else {
                output.instruction(&Instruction::I32Const(value as i32));
            }
            output.instruction(&store(
                ValType::I32,
                frame_field(plan, ValType::I32, offset),
            ));
        }
        for field in &layout.fields {
            if is_stored_in_wasm_local(layout, field.local) {
                emit_frame_address(plan, runtime, output);
                layout.emit_get(field.local, output, limit)?;
                output.instruction(&store(field.ty, frame_field(plan, field.ty, field.offset)));
            }
        }
    }
    layout.emit_scratch_save(FrameAddress::Buffer(runtime.buf_global), output, limit)?;
    if let Some(selector) = plan.catches.selector {
        layout.emit_catch_scalars(
            FrameAddress::Buffer(runtime.buf_global),
            selector,
            CatchFrameIo::Save,
            output,
            limit,
        )?;
    }
    if let Some(io) = &plan.reference_io {
        io.emit_save(
            &plan.continuation.references,
            layout,
            plan.environment,
            runtime,
            output,
            limit,
        )?;
    }
    if emission.scalar_codecs.is_none()
        || !layout
            .codec_shape(
                plan.catches.selector.is_some(),
                &plan.continuation.references,
            )
            .unwrap()
            .commits
    {
        emit_frame_address(plan, runtime, output);
        output.instruction(&Instruction::Call(runtime.frame_commit));
    }
    ensure!(
        output.byte_len() <= limit,
        "activation frame save exceeds output budget"
    );
    Ok(())
}

struct CaptureHooks<'a, T> {
    hooks: &'a mut T,
    selector: Option<LocalKey>,
    tails: Option<&'a TailTransferPlan>,
    catches: &'a NativeCatchPlan,
    runtime: NativeRuntimeIndices,
}
macro_rules! index {
    ($name:ident) => {
        fn $name(&mut self, index: u32) -> std::result::Result<u32, Error<Self::Error>> {
            self.hooks.$name(index)
        }
    };
}
impl<T: Reencode> Reencode for CaptureHooks<'_, T> {
    type Error = T::Error;
    index!(function_index);
    index!(table_index);
    index!(memory_index);
    index!(global_index);
    index!(tag_index);
    index!(type_index);
    index!(data_index);
    index!(element_index);
    fn instruction<'b>(
        &mut self,
        instruction: wasmparser::Operator<'b>,
    ) -> std::result::Result<Instruction<'b>, Error<Self::Error>> {
        self.hooks.instruction(instruction)
    }
}
impl<T: ContinuationHooks> ContinuationHooks for CaptureHooks<'_, T> {
    fn source_prefix_blocks(&self, source: &SourceInstruction<'_>) -> usize {
        source
            .opens
            .map_or(0, |region| self.catches.prefix_blocks(region))
            .saturating_add(self.hooks.source_prefix_blocks(source))
    }
    fn emit_continuation_region_end(
        &mut self,
        region: RegionId,
        handler_depths: &[u32],
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        if self.catches.prefix_blocks(region) != 0 {
            self.catches.emit_suffix(
                region,
                handler_depths,
                layout,
                self.runtime.unwind_tag,
                output,
                limit,
            )?;
        }
        self.hooks
            .emit_continuation_region_end(region, handler_depths, layout, output, limit)
    }
    fn emit_continuation_call(
        &mut self,
        ordinal: u32,
        call: &CallContinuation,
        source: &SourceInstruction<'_>,
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        if let Some(selector) = self.selector {
            output.instruction(&Instruction::I32Const(ordinal as i32));
            layout.emit_set(selector, output, limit)?;
        }
        self.hooks
            .emit_continuation_call(ordinal, call, source, layout, output, limit)
    }
    fn emit_continuation_source(
        &mut self,
        source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        if let (Some(region), Instruction::TryTable(kind, _)) = (source.opens, &instruction) {
            if self.catches.prefix_blocks(region) != 0 {
                ensure!(
                    self.hooks.source_prefix_blocks(source) == 0,
                    "catch wrappers cannot overlap another source wrapper policy"
                );
                let instruction = self.catches.emit_prefix(
                    region,
                    *kind,
                    self.runtime.unwind_tag,
                    output,
                    limit,
                )?;
                self.hooks
                    .emit_continuation_source(source, instruction, layout, output, limit)?;
                return self
                    .catches
                    .emit_replay_guard(region, layout, self.runtime, output, limit);
            }
        }
        let instruction = if is_tail_transfer(&source.operation) {
            let tails = self
                .tails
                .context("native activation tail-transfer plan is not installed")?;
            let instruction = tails.rewrite(source.point, instruction)?;
            // A tail transfer eliminates this activation and its catches. Its
            // arguments are already on the stack; release scratch without
            // storing them in extra locals or converting the tail to a call.
            layout.emit_scratch_release(output, limit)?;
            instruction
        } else {
            instruction
        };
        self.hooks
            .emit_continuation_source(source, instruction, layout, output, limit)
    }
}
