//! A modern exception branch replaces legacy delegate's implicit stack
//! search. Forward at the original target arm, inside activation cleanup.
use super::*;

impl<T: ContinuationHooks> Emitter<'_, '_, T>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    pub(super) fn enter_forwarding(&mut self, id: SequenceId) -> Result<bool> {
        let sequence = &self.plan.sequences[id.0];
        let Some(forward) = self
            .legacy
            .and_then(|legacy| legacy.forwards.get(&(sequence.region, sequence.arm)))
        else {
            return Ok(false);
        };
        self.instruction(Instruction::Block(forward.normal_type.unwrap()))?;
        self.labels.push(Label::DelegateNormal(id));
        self.instruction(Instruction::Block(forward.exception_type.unwrap()))?;
        self.labels.push(Label::DelegateForward(sequence.region));
        self.push(Task::ForwardEnd(id))?;
        self.push(Task::SequenceContent(id))?;
        Ok(true)
    }
    pub(super) fn end_forwarding(&mut self, id: SequenceId) -> Result<()> {
        self.instruction(Instruction::Br(self.depth(Label::DelegateNormal(id))?))?;
        ensure!(
            self.labels.pop() == Some(Label::DelegateForward(self.plan.sequences[id.0].region)),
            "unbalanced delegate forwarding label"
        );
        self.instruction(Instruction::End)?;
        self.instruction(Instruction::RefAsNonNull)?;
        self.instruction(Instruction::ThrowRef)?;
        ensure!(
            self.labels.pop() == Some(Label::DelegateNormal(id)),
            "unbalanced delegate result label"
        );
        self.instruction(Instruction::End)
    }
}
