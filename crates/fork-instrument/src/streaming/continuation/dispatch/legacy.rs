//! Legacy arms lower directly around existing continuation sequences. Every
//! emitted label participates in the same symbolic source-depth mapping.
use super::*;
use wasm_encoder::RefType;

#[derive(Clone, Copy)]
pub(super) enum LegacyTask {
    BodyEnd(RegionId),
    Capture(LegacyHandlerId),
    Handler(LegacyHandlerId),
    NormalEnd(LegacyHandlerId),
    ShimEnd(LegacyHandlerId, RegionId),
    PrivateEnd(LegacyHandlerId),
    ExceptionEnd(LegacyHandlerId),
    RegionEnd(RegionId),
}
impl<T: ContinuationHooks> Emitter<'_, '_, T>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    pub(super) fn enter_legacy_region(&mut self, region: RegionId) -> Result<()> {
        ensure!(
            self.hooks.source_prefix_blocks(
                &self.body.instructions[self.body.regions[region.0].opener.unwrap()]
            ) == 0,
            "legacy controls cannot overlap another source wrapper policy"
        );
        let legacy = self.legacy.context("missing legacy plan")?;
        let control = &legacy.regions[&region];
        self.instruction(Instruction::Block(control.body_type.unwrap()))?;
        self.labels.push(Label::Source(region));
        self.instruction(Instruction::Block(control.private_type.unwrap()))?;
        self.labels.push(Label::LegacyPrivate(region));
        self.push(Task::Legacy(LegacyTask::RegionEnd(region)))?;
        for &id in &control.handlers {
            self.step(1)?;
            self.instruction(Instruction::Block(
                legacy.handlers[id.0].capture_type.unwrap(),
            ))?;
            self.labels.push(Label::LegacyCapture(id));
            self.push(Task::Legacy(LegacyTask::Handler(id)))?;
            self.push(Task::Legacy(LegacyTask::Capture(id)))?;
        }
        let unwind = self.legacy_unwind_tag()?;
        let mut catches = vec![Catch::One {
            tag: unwind,
            label: self.depth(Label::LegacyPrivate(region))?,
        }];
        for &id in &control.handlers {
            let label = self.depth(Label::LegacyCapture(id))?;
            catches.push(match legacy.handlers[id.0].tag {
                Some(tag) => Catch::OneRef { tag, label },
                None => Catch::AllRef { label },
            });
        }
        self.instruction(Instruction::TryTable(
            control.body_type.unwrap(),
            Cow::Owned(catches),
        ))?;
        self.labels.push(Label::LegacyBody(region));
        self.legacy_replay_guard(region)?;
        self.push(Task::Legacy(LegacyTask::BodyEnd(region)))?;
        self.push(Task::Sequence(self.sequence_by_region[region.0][0]))
    }
    pub(super) fn legacy_task(&mut self, task: LegacyTask) -> Result<()> {
        let legacy = self.legacy.context("missing legacy plan")?;
        match task {
            LegacyTask::BodyEnd(region) => {
                self.legacy_close(Label::LegacyBody(region))?;
                self.instruction(Instruction::Br(self.depth(Label::Source(region))?))?;
            }
            LegacyTask::Capture(id) => {
                self.legacy_close(Label::LegacyCapture(id))?;
                self.plan
                    .frame
                    .emit_scratch_reseed(self.output, self.limits.output_bytes)?;
                self.plan.frame.emit_set(
                    legacy.handlers[id.0].exception.unwrap(),
                    self.output,
                    self.limits.output_bytes,
                )?;
            }
            LegacyTask::Handler(id) => self.enter_legacy_handler(id)?,
            LegacyTask::NormalEnd(id) => {
                self.legacy_clear(id)?;
                let region = legacy.ownership.handlers()[id.0].region;
                self.instruction(Instruction::Br(self.depth(Label::Source(region))?))?;
            }
            LegacyTask::ShimEnd(id, target) => {
                self.legacy_close(Label::LegacyExit(id, target))?;
                let cleanup = legacy.ownership.exit_cleanup(id, target).unwrap();
                for owner in legacy.ownership.cleanup_handlers(cleanup) {
                    self.step(1)?;
                    self.legacy_clear(owner)?;
                }
                self.instruction(Instruction::Br(self.depth(Label::Source(target))?))?;
            }
            LegacyTask::PrivateEnd(id) => {
                self.legacy_close(Label::LegacyHandlerBody(id))?;
                self.legacy_close(Label::LegacyHandlerPrivate(id))?;
                self.instruction(Instruction::Throw(self.legacy_unwind_tag()?))?;
            }
            LegacyTask::ExceptionEnd(id) => {
                self.legacy_close(Label::LegacyHandlerException(id))?;
                self.legacy_clear(id)?;
                self.instruction(Instruction::RefAsNonNull)?;
                self.instruction(Instruction::ThrowRef)?;
            }
            LegacyTask::RegionEnd(region) => {
                self.legacy_close(Label::LegacyPrivate(region))?;
                self.instruction(Instruction::Throw(self.legacy_unwind_tag()?))?;
                self.legacy_close(Label::Source(region))?;
            }
        }
        Ok(())
    }
    fn enter_legacy_handler(&mut self, id: LegacyHandlerId) -> Result<()> {
        let legacy = self.legacy.unwrap();
        let handler = &legacy.handlers[id.0];
        self.instruction(Instruction::Block(handler.exception_type.unwrap()))?;
        self.labels.push(Label::LegacyHandlerException(id));
        self.instruction(Instruction::Block(handler.private_type.unwrap()))?;
        self.labels.push(Label::LegacyHandlerPrivate(id));
        let catches = vec![
            Catch::One {
                tag: self.legacy_unwind_tag()?,
                label: 0,
            },
            Catch::AllRef { label: 1 },
        ];
        self.instruction(Instruction::TryTable(
            handler.private_type.unwrap(),
            Cow::Owned(catches),
        ))?;
        self.labels.push(Label::LegacyHandlerBody(id));
        self.push(Task::Legacy(LegacyTask::ExceptionEnd(id)))?;
        self.push(Task::Legacy(LegacyTask::PrivateEnd(id)))?;
        for (&(owner, target), exit) in legacy
            .exits
            .range((id, RegionId(0))..=(id, RegionId(usize::MAX)))
        {
            self.step(1)?;
            self.instruction(Instruction::Block(exit.block_type.unwrap()))?;
            self.labels.push(Label::LegacyExit(owner, target));
            self.push(Task::Legacy(LegacyTask::ShimEnd(id, target)))?;
        }
        self.push(Task::Legacy(LegacyTask::NormalEnd(id)))?;
        let source = &legacy.ownership.handlers()[id.0];
        self.push(Task::Sequence(
            self.sequence_by_region[source.region.0][source.ordinal + 1],
        ))
    }
    fn legacy_replay_guard(&mut self, region: RegionId) -> Result<()> {
        let legacy = self.legacy.unwrap();
        for &id in &legacy.regions[&region].handlers {
            self.step(1)?;
            let source = &legacy.ownership.handlers()[id.0];
            let sequence = self.sequence_by_region[region.0][source.ordinal + 1];
            let Some(calls) = &self.plan.sequences[sequence.0].calls else {
                continue;
            };
            self.instruction(Instruction::GlobalGet(self.environment.state_global))?;
            self.instruction(Instruction::I32Const(crate::runtime::STATE_REWINDING))?;
            self.instruction(Instruction::I32GeU)?;
            self.index_relative(calls.start)?;
            self.instruction(Instruction::I32Const(calls.len() as i32))?;
            self.instruction(Instruction::I32LtU)?;
            self.instruction(Instruction::I32And)?;
            self.instruction(Instruction::If(BlockType::Empty))?;
            self.plan.frame.emit_get(
                legacy.handlers[id.0].exception.unwrap(),
                self.output,
                self.limits.output_bytes,
            )?;
            self.instruction(Instruction::RefAsNonNull)?;
            self.instruction(Instruction::ThrowRef)?;
            self.instruction(Instruction::End)?;
        }
        Ok(())
    }
    pub(super) fn emit_legacy_rethrow(&mut self, instruction: usize) -> Result<bool> {
        if !matches!(
            self.body.instructions[instruction].operation,
            wasmparser::Operator::Rethrow { .. }
        ) {
            return Ok(false);
        }
        let Some(legacy) = self.legacy else {
            return Ok(false);
        };
        self.step((usize::BITS - legacy.ownership.rethrows().len().leading_zeros()) as usize + 1)?;
        let Ok(index) = legacy
            .ownership
            .rethrows()
            .binary_search_by_key(&instruction, |r| r.instruction)
        else {
            return Ok(false);
        };
        let rethrow = &legacy.ownership.rethrows()[index];
        self.plan.frame.emit_get(
            legacy.handlers[rethrow.exception.0].exception.unwrap(),
            self.output,
            self.limits.output_bytes,
        )?;
        self.instruction(Instruction::RefAsNonNull)?;
        // An inner catch may intercept a rethrow while this handler remains
        // active. The exit shields clear owned roots only when it escapes.
        self.instruction(Instruction::ThrowRef)?;
        Ok(true)
    }
    pub(super) fn source_depth(&mut self, instruction: usize, target: RegionId) -> Result<u32> {
        if let Some(legacy) = self.legacy
            && let Some(owner) = legacy.owner_at(instruction, &mut self.work)?
            && legacy.exits.contains_key(&(owner, target))
        {
            return self.depth(Label::LegacyExit(owner, target));
        }
        self.depth(Label::Source(target))
    }
    pub(super) fn legacy_clear(&mut self, id: LegacyHandlerId) -> Result<()> {
        self.instruction(Instruction::RefNull(RefType::EXNREF.heap_type))?;
        self.plan.frame.emit_set(
            self.legacy.unwrap().handlers[id.0].exception.unwrap(),
            self.output,
            self.limits.output_bytes,
        )
    }
    pub(super) fn legacy_close(&mut self, label: Label) -> Result<()> {
        ensure!(
            self.labels.pop() == Some(label),
            "unbalanced legacy lowering label"
        );
        self.instruction(Instruction::End)
    }
    pub(super) fn legacy_unwind_tag(&self) -> Result<u32> {
        self.legacy_unwind
            .context("legacy lowering has no private unwind tag")
    }
}
