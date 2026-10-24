//! Catch delegated exceptions as values, clear exited handler ownership and
//! forward to the original target. Private unwind bypasses this cleanup.
use super::*;

impl<T: ContinuationHooks> Emitter<'_, '_, T>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    pub(super) fn enter_delegate(&mut self, region: RegionId) -> Result<()> {
        ensure!(
            self.hooks.source_prefix_blocks(
                &self.body.instructions[self.body.regions[region.0].opener.unwrap()]
            ) == 0,
            "legacy controls cannot overlap another source wrapper policy"
        );
        let control = &self.legacy.unwrap().delegates[&region];
        self.instruction(Instruction::Block(control.body_type.unwrap()))?;
        self.labels.push(Label::Source(region));
        self.instruction(Instruction::Block(control.private_type.unwrap()))?;
        self.labels.push(Label::DelegatePrivate(region));
        self.instruction(Instruction::Block(control.exception_type.unwrap()))?;
        self.labels.push(Label::DelegateCapture(region));
        let catches = vec![
            Catch::One {
                tag: self.legacy_unwind_tag()?,
                label: 1,
            },
            Catch::AllRef { label: 0 },
        ];
        self.instruction(Instruction::TryTable(
            control.body_type.unwrap(),
            Cow::Owned(catches),
        ))?;
        self.labels.push(Label::DelegateBody(region));
        self.push(Task::DelegateEnd(region))?;
        self.push(Task::Sequence(self.sequence_by_region[region.0][0]))
    }
    pub(super) fn end_delegate(&mut self, region: RegionId) -> Result<()> {
        self.legacy_close(Label::DelegateBody(region))?;
        self.instruction(Instruction::Br(self.depth(Label::Source(region))?))?;
        self.legacy_close(Label::DelegateCapture(region))?;
        let target = self.body.regions[region.0].delegate.unwrap();
        let instruction = self.body.regions[region.0].opener.unwrap();
        self.clear_delegated_handlers(instruction, target)?;
        self.instruction(Instruction::Br(self.depth(Label::DelegateForward(target))?))?;
        self.legacy_close(Label::DelegatePrivate(region))?;
        self.instruction(Instruction::Throw(self.legacy_unwind_tag()?))?;
        self.legacy_close(Label::Source(region))
    }
    fn clear_delegated_handlers(&mut self, instruction: usize, target: RegionId) -> Result<()> {
        let legacy = self.legacy.unwrap();
        self.step(self.sequence_by_region[target.0].len())?;
        let arms = &self.sequence_by_region[target.0];
        let arm = arms
            .iter()
            .find(|id| self.plan.sequences[id.0].source.contains(&instruction))
            .context("delegate target has no enclosing arm")?;
        let keep = legacy.owner_at(self.plan.sequences[arm.0].source.start, &mut self.work)?;
        let mut owner = legacy.owner_at(instruction, &mut self.work)?;
        while owner != keep {
            self.step(1)?;
            let id = owner.context("delegate enters a legacy handler")?;
            self.legacy_clear(id)?;
            owner = legacy.ownership.handlers()[id.0].parent;
        }
        Ok(())
    }
}
