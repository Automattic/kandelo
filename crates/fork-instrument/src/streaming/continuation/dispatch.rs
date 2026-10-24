//! Iterative nested/bucketed continuation dispatch. Hooks provide the frozen
//! call transport and function-wide capture policy; this emits no declarations.
use super::{CallContinuation, ContinuationLandingKind, ContinuationPlan, SequenceId};
use crate::streaming::{
    FrameLayout, FunctionIr, LegacyHandlerId, LocalKey, NativeLegacyPlan, RegionId, RegionKind,
    SourceInstruction,
};
use anyhow::{Context, Result, ensure};
use std::{borrow::Cow, ops::Range};
use wasm_encoder::{BlockType, Catch, Function, HeapType, Instruction, reencode::Reencode};

const BUCKET: usize = 32;
mod delegates;
mod forwarding;
mod legacy;
use legacy::LegacyTask;

#[derive(Clone, Copy, Debug)]
pub struct DispatchEnvironment {
    pub state_global: u32,
    pub call_index_global: u32,
    /// Blocks installed by the function-wide capture wrapper, inside the
    /// original implicit function label, which source branches must cross.
    pub enclosing_blocks: usize,
    /// Optional wrapper block, numbered outside-to-inside, which receives
    /// source returns and branches to the original function label. A typed
    /// common exit lets scratch cleanup run after every such normal exit.
    pub function_exit_block: Option<usize>,
}
#[derive(Clone, Copy, Debug)]
pub struct DispatchLimits {
    pub output_bytes: usize,
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for DispatchLimits {
    fn default() -> Self {
        Self {
            output_bytes: 32 * 1024 * 1024,
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
        }
    }
}

/// Ordinary call/source hooks balance temporary control blocks. A source
/// region can additionally declare prefix wrappers, which remain tracked until
/// its matching region-end hook closes them.
pub trait ContinuationHooks: Reencode {
    /// Number of wrapper labels emitted immediately before a source opener.
    /// They are included in source branch/catch remapping and must all close
    /// in `emit_continuation_region_end`, after the original End is emitted.
    fn source_prefix_blocks(&self, _source: &SourceInstruction<'_>) -> usize {
        0
    }

    /// Handler depths are measured after the source End, while all declared
    /// wrapper labels are still open. Synthetic capture tails can adjust them
    /// as they close their wrappers and then branch to the original handlers.
    fn emit_continuation_region_end(
        &mut self,
        _region: RegionId,
        _handler_depths: &[u32],
        _layout: &FrameLayout,
        _output: &mut Function,
        _limit: usize,
    ) -> Result<()> {
        Ok(())
    }

    /// Arguments and carryovers are already on the operand stack. The complete
    /// transform must install frozen transport/resume routing and record this
    /// ordinal. This default preserves only the source lexical invocation.
    fn emit_continuation_call(
        &mut self,
        ordinal: u32,
        call: &CallContinuation,
        source: &SourceInstruction<'_>,
        _layout: &FrameLayout,
        output: &mut Function,
        _limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        let _ = ordinal;
        if matches!(call.kind, crate::streaming::ReferenceCallKind::Ref { .. }) {
            output.instruction(&Instruction::RefCastNonNull(HeapType::Concrete(
                call.signature,
            )));
        }
        output.instruction(&self.instruction(source.operation.clone())?);
        Ok(())
    }
    /// Source branch depths are already translated. Table/state/exit rewriting
    /// can build on this without losing the exact original program point.
    fn emit_continuation_source(
        &mut self,
        _source: &SourceInstruction<'_>,
        instruction: Instruction<'_>,
        _layout: &FrameLayout,
        output: &mut Function,
        _limit: usize,
    ) -> Result<()>
    where
        Self::Error: std::error::Error + Send + Sync + 'static,
    {
        output.instruction(&instruction);
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Label {
    Source(RegionId),
    SourceWrapper(RegionId),
    Synthetic(usize),
    External,
    LegacyBody(RegionId),
    DelegateForward(RegionId),
    DelegateNormal(SequenceId),
    DelegateBody(RegionId),
    DelegatePrivate(RegionId),
    DelegateCapture(RegionId),
    LegacyPrivate(RegionId),
    LegacyCapture(LegacyHandlerId),
    LegacyHandlerBody(LegacyHandlerId),
    LegacyHandlerPrivate(LegacyHandlerId),
    LegacyHandlerException(LegacyHandlerId),
    LegacyExit(LegacyHandlerId, RegionId),
}
enum Task {
    Sequence(SequenceId),
    SequenceContent(SequenceId),
    ForwardEnd(SequenceId),
    DelegateEnd(RegionId),
    Node {
        sequence: SequenceId,
        landings: Range<usize>,
    },
    Gate(Vec<(Range<u32>, usize)>),
    Source(Range<usize>),
    Landing(SequenceId, usize),
    Chunk(SequenceId, usize),
    Capture(SequenceId, usize),
    Close(usize),
    RegionEnd(RegionId),
    Legacy(LegacyTask),
}
impl Task {
    fn metadata_bytes(&self) -> Result<usize> {
        match self {
            Self::Gate(targets) => targets
                .len()
                .checked_mul(64)
                .and_then(|n| n.checked_add(128))
                .context("dispatch task metadata overflow"),
            _ => Ok(128),
        }
    }
}

struct Emitter<'a, 'b, T> {
    body: &'a FunctionIr<'b>,
    plan: &'a ContinuationPlan,
    hooks: &'a mut T,
    output: &'a mut Function,
    environment: DispatchEnvironment,
    limits: DispatchLimits,
    labels: Vec<Label>,
    tasks: Vec<Task>,
    next_label: usize,
    sequence_by_region: Vec<Vec<SequenceId>>,
    source_wrappers: Vec<usize>,
    work: usize,
    queued_bytes: usize,
    legacy: Option<&'a NativeLegacyPlan>,
    legacy_unwind: Option<u32>,
}

/// Emit the original function's content, excluding its final End, inside an
/// already-declared body. Frame restore/capture and scratch lifetime belong to
/// the function-wide wrapper. Every helper/index must be frozen beforehand.
pub fn emit_continuation_dispatch<T: ContinuationHooks>(
    body: &FunctionIr<'_>,
    plan: &ContinuationPlan,
    hooks: &mut T,
    output: &mut Function,
    environment: DispatchEnvironment,
    limits: DispatchLimits,
) -> Result<()>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    emit_dispatch(body, plan, None, hooks, output, environment, limits)
}

pub(crate) fn emit_dispatch<T: ContinuationHooks>(
    body: &FunctionIr<'_>,
    plan: &ContinuationPlan,
    legacy: Option<(&NativeLegacyPlan, u32)>,
    hooks: &mut T,
    output: &mut Function,
    environment: DispatchEnvironment,
    limits: DispatchLimits,
) -> Result<()>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    ensure!(
        plan.function == body.function,
        "continuation plan names another function"
    );
    ensure!(
        environment.enclosing_blocks < limits.metadata_bytes / 64,
        "dispatch wrapper labels exceed metadata budget"
    );
    ensure!(
        plan.sequences.len() <= limits.metadata_bytes / 128
            && body.regions.len() <= limits.metadata_bytes / 128,
        "dispatch sequences exceed metadata budget"
    );
    let mut sequence_by_region = vec![Vec::new(); body.regions.len()];
    for (index, sequence) in plan.sequences.iter().enumerate() {
        sequence_by_region[sequence.region.0].push(SequenceId(index));
    }
    ensure!(
        environment
            .function_exit_block
            .is_none_or(|b| b < environment.enclosing_blocks),
        "function exit block is outside dispatch wrapper"
    );
    let mut labels = vec![if environment.function_exit_block.is_none() {
        Label::Source(RegionId(0))
    } else {
        Label::External
    }];
    labels.extend((0..environment.enclosing_blocks).map(|b| {
        if environment.function_exit_block == Some(b) {
            Label::Source(RegionId(0))
        } else {
            Label::External
        }
    }));
    let mut emitter = Emitter {
        body,
        plan,
        hooks,
        output,
        environment,
        limits,
        labels,
        tasks: vec![Task::Sequence(SequenceId(0))],
        next_label: 0,
        sequence_by_region,
        source_wrappers: vec![0; body.regions.len()],
        work: limits.work,
        queued_bytes: 128,
        legacy: legacy.map(|(plan, _)| plan),
        legacy_unwind: legacy.map(|(_, tag)| tag),
    };
    emitter.run()?;
    ensure!(
        emitter.labels.len() == environment.enclosing_blocks + 1,
        "unbalanced dispatch labels"
    );
    Ok(())
}

impl<T: ContinuationHooks> Emitter<'_, '_, T>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    fn step(&mut self, count: usize) -> Result<()> {
        self.work = self
            .work
            .checked_sub(count)
            .context("dispatch emission exceeds work budget")?;
        Ok(())
    }
    fn check(&self) -> Result<()> {
        ensure!(
            self.output.byte_len() <= self.limits.output_bytes,
            "continuation dispatch exceeds output budget"
        );
        let records = self
            .labels
            .len()
            .checked_add(self.plan.sequences.len())
            .and_then(|n| n.checked_add(self.sequence_by_region.len()))
            .context("dispatch metadata overflow")?;
        let metadata = records
            .checked_mul(128)
            .and_then(|n| n.checked_add(self.queued_bytes))
            .context("dispatch metadata overflow")?;
        ensure!(
            metadata <= self.limits.metadata_bytes,
            "dispatch emission exceeds metadata budget"
        );
        Ok(())
    }
    fn push(&mut self, task: Task) -> Result<()> {
        self.queued_bytes = self
            .queued_bytes
            .checked_add(task.metadata_bytes()?)
            .context("dispatch task metadata overflow")?;
        self.tasks.push(task);
        self.check()
    }
    fn instruction(&mut self, instruction: Instruction<'_>) -> Result<()> {
        self.output.instruction(&instruction);
        self.check()
    }
    fn depth(&self, label: Label) -> Result<u32> {
        self.labels
            .iter()
            .rev()
            .position(|&l| l == label)
            .context("source branch target is not in emitted scope")
            .and_then(|d| Ok(u32::try_from(d)?))
    }
    fn run(&mut self) -> Result<()> {
        while let Some(task) = self.tasks.pop() {
            self.queued_bytes -= task.metadata_bytes()?;
            self.step(1)?;
            match task {
                Task::Sequence(id) => {
                    if self.enter_forwarding(id)? {
                        continue;
                    }
                    self.push(Task::SequenceContent(id))?;
                }
                Task::ForwardEnd(id) => self.end_forwarding(id)?,
                Task::DelegateEnd(id) => self.end_delegate(id)?,
                Task::SequenceContent(id) => {
                    let sequence = &self.plan.sequences[id.0];
                    if sequence.calls.is_none() {
                        self.push(Task::Source(sequence.source.clone()))?;
                        continue;
                    }
                    for &key in sequence.input_parameters.iter().rev() {
                        self.plan
                            .frame
                            .emit_set(key, self.output, self.limits.output_bytes)?;
                    }
                    self.push(Task::Node {
                        sequence: id,
                        landings: 0..sequence.landings.len(),
                    })?;
                }
                Task::Node { sequence, landings } => self.node(sequence, landings)?,
                Task::Gate(targets) => self.gate(targets)?,
                Task::Source(span) => self.source_span(span)?,
                Task::Landing(sequence, index) => self.landing(sequence, index)?,
                Task::Chunk(sequence, index) => self.chunk(sequence, index)?,
                Task::Capture(sequence, index) => self.capture(sequence, index)?,
                Task::Close(label) => {
                    ensure!(
                        self.labels.pop() == Some(Label::Synthetic(label)),
                        "unbalanced synthetic dispatch label"
                    );
                    self.instruction(Instruction::End)?;
                }
                Task::RegionEnd(region) => {
                    self.source_instruction(self.body.regions[region.0].end)?
                }
                Task::Legacy(task) => self.legacy_task(task)?,
            }
            self.check()?;
        }
        Ok(())
    }
    fn node(&mut self, sequence: SequenceId, landings: Range<usize>) -> Result<()> {
        let count = landings.len();
        ensure!(count != 0, "empty fork-bearing dispatch node");
        let mut span = 1usize;
        while count.div_ceil(span) > BUCKET {
            span = span
                .checked_mul(BUCKET)
                .context("dispatch bucket span overflow")?;
        }
        let mut children = Vec::new();
        for start in (landings.start..landings.end).step_by(span) {
            self.step(1)?;
            let range = start..landings.end.min(start + span);
            let label = self.next_label;
            self.next_label = self
                .next_label
                .checked_add(1)
                .context("dispatch label overflow")?;
            children.push((range, label));
        }
        // Each label ends immediately BEFORE its child body. Consequently the
        // last child can yield the source region's results outside all buckets.
        for (_, label) in children.iter().rev() {
            self.instruction(Instruction::Block(BlockType::Empty))?;
            self.labels.push(Label::Synthetic(*label));
        }
        for (range, label) in children.iter().rev() {
            if span == 1 {
                self.push(Task::Chunk(sequence, range.start + 1))?;
                self.push(Task::Landing(sequence, range.start))?;
            } else {
                self.push(Task::Node {
                    sequence,
                    landings: range.clone(),
                })?;
            }
            self.push(Task::Close(*label))?;
        }
        if span == 1 && landings.start == 0 {
            self.push(Task::Chunk(sequence, 0))?;
        }
        let original = &self.plan.sequences[sequence.0].landings;
        let targets = children
            .into_iter()
            .map(|(range, label)| {
                (
                    original[range.start].calls.start..original[range.end - 1].calls.end,
                    label,
                )
            })
            .collect();
        self.push(Task::Gate(targets))
    }
    fn gate(&mut self, targets: Vec<(Range<u32>, usize)>) -> Result<()> {
        let normal = self.next_label;
        self.next_label += 1;
        self.instruction(Instruction::Block(BlockType::Empty))?;
        self.labels.push(Label::Synthetic(normal));
        self.instruction(Instruction::GlobalGet(self.environment.state_global))?;
        self.instruction(Instruction::I32Const(crate::runtime::STATE_REWINDING))?;
        self.instruction(Instruction::I32LtU)?;
        self.instruction(Instruction::BrIf(0))?;
        let first = targets.first().context("empty dispatch gate")?.0.start;
        let end = targets.last().unwrap().0.end;
        // Invalid replay coordinates must trap, not select a normal chunk.
        self.index_relative(first)?;
        self.instruction(Instruction::I32Const((end - first) as i32))?;
        self.instruction(Instruction::I32GeU)?;
        self.instruction(Instruction::If(BlockType::Empty))?;
        self.instruction(Instruction::Unreachable)?;
        self.instruction(Instruction::End)?;
        if targets.len() == 1 {
            self.instruction(Instruction::Br(self.depth(Label::Synthetic(targets[0].1))?))?;
        } else {
            let count = (end - first) as usize;
            self.step(count)?;
            ensure!(
                count <= self.limits.metadata_bytes / 16
                    && count
                        < self
                            .limits
                            .output_bytes
                            .saturating_sub(self.output.byte_len()),
                "dispatch table exceeds output or metadata budget"
            );
            let mut table = Vec::with_capacity(count);
            for (range, label) in targets {
                let depth = self.depth(Label::Synthetic(label))?;
                table.extend(std::iter::repeat_n(depth, range.len()));
            }
            ensure!(table.len() == count, "noncontiguous dispatch call ranges");
            self.index_relative(first)?;
            let default = table[0];
            self.instruction(Instruction::BrTable(Cow::Owned(table), default))?;
        }
        ensure!(
            self.labels.pop() == Some(Label::Synthetic(normal)),
            "unbalanced replay gate"
        );
        self.instruction(Instruction::End)
    }
    fn index_relative(&mut self, first: u32) -> Result<()> {
        self.instruction(Instruction::GlobalGet(self.environment.call_index_global))?;
        if first != 0 {
            self.instruction(Instruction::I32Const(first as i32))?;
            self.instruction(Instruction::I32Sub)?;
        }
        Ok(())
    }
    fn chunk(&mut self, sequence: SequenceId, index: usize) -> Result<()> {
        let plan = &self.plan.sequences[sequence.0];
        if index == 0 {
            for &key in &plan.input_parameters {
                self.plan
                    .frame
                    .emit_get(key, self.output, self.limits.output_bytes)?;
            }
        }
        let span = plan.chunks[index].clone();
        // Capture must follow the complete chunk, including nested non-fork
        // regions. Source may queue further work when it enters a child.
        self.push(Task::Capture(sequence, index))?;
        self.push(Task::Source(span))?;
        Ok(())
    }
    fn landing(&mut self, sequence: SequenceId, index: usize) -> Result<()> {
        let landing = &self.plan.sequences[sequence.0].landings[index];
        match &landing.kind {
            ContinuationLandingKind::Call(ordinal) => {
                let call = &self.plan.calls[*ordinal as usize];
                for &key in &call.carryovers {
                    self.plan
                        .frame
                        .emit_get(key, self.output, self.limits.output_bytes)?;
                }
                call.arguments.emit_restore(
                    self.body,
                    &self.plan.frame,
                    self.hooks,
                    self.output,
                    self.limits.output_bytes,
                )?;
                self.hooks.emit_continuation_call(
                    *ordinal,
                    call,
                    &self.body.instructions[call.instruction],
                    &self.plan.frame,
                    self.output,
                    self.limits.output_bytes,
                )?;
            }
            ContinuationLandingKind::Region {
                region,
                arms,
                inputs,
            } => {
                inputs.emit_restore(
                    self.body,
                    &self.plan.frame,
                    self.hooks,
                    self.output,
                    self.limits.output_bytes,
                )?;
                if self.body.regions[region.0].kind == RegionKind::If {
                    let local = self
                        .plan
                        .condition
                        .context("if replay requires condition temporary")?;
                    self.plan
                        .frame
                        .emit_set(local, self.output, self.limits.output_bytes)?;
                    if let Some(range) = &self.plan.sequences[arms[0].0].calls {
                        self.index_relative(range.start)?;
                        self.instruction(Instruction::I32Const(range.len() as i32))?;
                        self.instruction(Instruction::I32LtU)?;
                    } else {
                        self.instruction(Instruction::I32Const(0))?;
                    }
                    self.plan
                        .frame
                        .emit_get(local, self.output, self.limits.output_bytes)?;
                    self.instruction(Instruction::GlobalGet(self.environment.state_global))?;
                    self.instruction(Instruction::I32Const(crate::runtime::STATE_REWINDING))?;
                    self.instruction(Instruction::I32GeU)?;
                    self.instruction(Instruction::Select)?;
                }
                self.enter_region(*region)?;
            }
        }
        Ok(())
    }
    fn capture(&mut self, sequence: SequenceId, index: usize) -> Result<()> {
        let Some(landing) = self.plan.sequences[sequence.0].landings.get(index) else {
            return Ok(());
        };
        match &landing.kind {
            ContinuationLandingKind::Call(ordinal) => {
                let call = &self.plan.calls[*ordinal as usize];
                call.arguments.emit_capture(
                    &self.plan.frame,
                    self.output,
                    self.limits.output_bytes,
                )?;
                for &key in call.carryovers.iter().rev() {
                    self.plan
                        .frame
                        .emit_set(key, self.output, self.limits.output_bytes)?;
                }
            }
            ContinuationLandingKind::Region { inputs, .. } => {
                inputs.emit_capture(&self.plan.frame, self.output, self.limits.output_bytes)?
            }
        }
        Ok(())
    }
    fn enter_region(&mut self, region: RegionId) -> Result<()> {
        if self
            .legacy
            .is_some_and(|plan| plan.delegates.contains_key(&region))
        {
            return self.enter_delegate(region);
        }
        if self
            .legacy
            .is_some_and(|plan| plan.regions.contains_key(&region))
        {
            return self.enter_legacy_region(region);
        }
        self.source_instruction(self.body.regions[region.0].opener.unwrap())?;
        self.push(Task::RegionEnd(region))?;
        let arms = self.sequence_by_region[region.0].clone();
        for (index, &arm) in arms.iter().enumerate().rev() {
            self.push(Task::Sequence(arm))?;
            if index != 0 {
                self.push(Task::Source(
                    self.plan.sequences[arm.0].source.start - 1
                        ..self.plan.sequences[arm.0].source.start,
                ))?;
            }
        }
        Ok(())
    }
    fn source_span(&mut self, span: Range<usize>) -> Result<()> {
        let mut index = span.start;
        while index < span.end {
            self.step(1)?;
            let source = &self.body.instructions[index];
            if let Some(region) = source.opens {
                let end = self.body.regions[region.0].end + 1;
                if !source.retained {
                    index = end;
                    continue;
                }
                self.push(Task::Source(end..span.end))?;
                self.enter_region(region)?;
                return Ok(());
            }
            self.source_instruction(index)?;
            index += 1;
        }
        Ok(())
    }
    fn source_instruction(&mut self, index: usize) -> Result<()> {
        use wasmparser::Operator;
        let source = &self.body.instructions[index];
        let closing = matches!(source.operation, Operator::End | Operator::Delegate { .. });
        if !source.retained
            && !closing
            && !matches!(
                source.operation,
                Operator::Else | Operator::Catch { .. } | Operator::CatchAll
            )
        {
            return Ok(());
        }
        if closing {
            ensure!(
                self.labels.pop() == Some(Label::Source(source.region)),
                "unbalanced original source label"
            );
        }
        if self.emit_legacy_rethrow(index)? {
            return Ok(());
        }
        match source.operation {
            Operator::LocalGet { local_index } => {
                return self.plan.frame.emit_get(
                    LocalKey(local_index),
                    self.output,
                    self.limits.output_bytes,
                );
            }
            Operator::LocalSet { local_index } => {
                return self.plan.frame.emit_set(
                    LocalKey(local_index),
                    self.output,
                    self.limits.output_bytes,
                );
            }
            Operator::LocalTee { local_index } => {
                return self.plan.frame.emit_tee(
                    LocalKey(local_index),
                    self.output,
                    self.limits.output_bytes,
                );
            }
            _ => {}
        }
        if let Some(transfer) = self
            .body
            .transfers
            .binary_search_by_key(&index, |t| t.instruction)
            .ok()
            .map(|i| &self.body.transfers[i])
        {
            ensure!(
                transfer.targets.len() <= self.limits.metadata_bytes / 64,
                "source branch table exceeds metadata budget"
            );
        }
        if let Some(region) = source.opens {
            let count = self.hooks.source_prefix_blocks(source);
            ensure!(
                count <= self.limits.metadata_bytes / 128,
                "source wrappers exceed metadata budget"
            );
            self.step(count)?;
            self.source_wrappers[region.0] = count;
            self.labels
                .extend(std::iter::repeat_n(Label::SourceWrapper(region), count));
            self.check()?;
        }
        let mut encoded = self.hooks.instruction(source.operation.clone())?;
        if matches!(encoded, Instruction::Return) && self.environment.function_exit_block.is_some()
        {
            encoded = Instruction::Br(self.depth(Label::Source(RegionId(0)))?);
        }
        if let Some(transfer) = self
            .body
            .transfers
            .binary_search_by_key(&index, |t| t.instruction)
            .ok()
            .map(|i| &self.body.transfers[i])
        {
            match &mut encoded {
                Instruction::Br(depth)
                | Instruction::BrIf(depth)
                | Instruction::BrOnNull(depth)
                | Instruction::BrOnNonNull(depth)
                | Instruction::Rethrow(depth)
                | Instruction::BrOnCast {
                    relative_depth: depth,
                    ..
                }
                | Instruction::BrOnCastFail {
                    relative_depth: depth,
                    ..
                } => {
                    *depth = self.source_depth(index, transfer.targets[0])?;
                }
                Instruction::BrTable(table, default) => {
                    self.step(transfer.targets.len())?;
                    let mapped = transfer
                        .targets
                        .iter()
                        .map(|&r| self.source_depth(index, r))
                        .collect::<Result<Vec<_>>>()?;
                    *default = *mapped.last().unwrap();
                    *table = Cow::Owned(mapped[..mapped.len() - 1].to_vec());
                }
                _ => {}
            }
        }
        if let Instruction::TryTable(_, catches) = &mut encoded {
            let region = source.opens.unwrap();
            for (catch, handler) in catches
                .to_mut()
                .iter_mut()
                .zip(&self.body.regions[region.0].handlers)
            {
                let depth = self.source_depth(index, handler.target.unwrap())?;
                match catch {
                    Catch::One { label, .. }
                    | Catch::OneRef { label, .. }
                    | Catch::All { label }
                    | Catch::AllRef { label } => *label = depth,
                }
            }
        }
        if let Instruction::Delegate(depth) = &mut encoded {
            ensure!(
                self.legacy.is_none(),
                "unlowered legacy delegate reached native dispatch"
            );
            let target = self.body.regions[source.region.0].delegate.unwrap();
            *depth = self.depth(Label::Source(target))?;
        }
        self.hooks.emit_continuation_source(
            source,
            encoded,
            &self.plan.frame,
            self.output,
            self.limits.output_bytes,
        )?;
        if let Some(region) = source.opens {
            self.labels.push(Label::Source(region));
        }
        if closing {
            let count = self.source_wrappers[source.region.0];
            if count != 0 {
                let handlers = &self.body.regions[source.region.0].handlers;
                ensure!(
                    handlers.len() <= self.limits.metadata_bytes / 128,
                    "handler depths exceed metadata budget"
                );
                self.step(handlers.len())?;
                let depths = handlers
                    .iter()
                    .map(|handler| {
                        self.source_depth(
                            self.body.regions[source.region.0].opener.unwrap(),
                            handler
                                .target
                                .context("wrapped handler has no source target")?,
                        )
                    })
                    .collect::<Result<Vec<_>>>()?;
                self.hooks.emit_continuation_region_end(
                    source.region,
                    &depths,
                    &self.plan.frame,
                    self.output,
                    self.limits.output_bytes,
                )?;
                for _ in 0..count {
                    ensure!(
                        self.labels.pop() == Some(Label::SourceWrapper(source.region)),
                        "unbalanced source wrapper label"
                    );
                }
            }
        }
        self.check()
    }
}
