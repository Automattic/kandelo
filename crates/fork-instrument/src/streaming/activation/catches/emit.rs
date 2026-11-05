//! Typed capture wrappers around original modern try regions. Original branch
//! labels remain tracked by the continuation emitter; these helpers own only
//! the declared synthetic wrappers and their capture tails.
use super::{NativeCatchArm, NativeCatchPlan};
use crate::streaming::{FrameLayout, LocalKey, NativeRuntimeIndices, RegionId};
use anyhow::{Context, Result, ensure};
use std::borrow::Cow;
use wasm_encoder::{BlockType, Catch, Function, Instruction, RefType, ValType};

impl NativeCatchPlan {
    pub(crate) fn validate_emission(&self) -> Result<()> {
        ensure!(self.allocated, "catch storage is not allocated");
        for region in self.regions.values() {
            ensure!(
                region.outer_type.is_some()
                    && region.private_type.is_some()
                    && region.arms.iter().all(|arm| arm.capture_type.is_some()),
                "catch wrapper types were not frozen before emission"
            );
        }
        Ok(())
    }

    pub(crate) fn prefix_blocks(&self, region: RegionId) -> usize {
        self.regions
            .get(&region)
            .map_or(0, |region| region.arms.len() + 2)
    }

    /// Open wrappers outside the source try and return its retargeted clauses.
    /// The caller emits the returned try before emitting the replay guard.
    pub(crate) fn emit_prefix(
        &self,
        region: RegionId,
        original_type: BlockType,
        unwind_tag: u32,
        output: &mut Function,
        limit: usize,
    ) -> Result<Instruction<'static>> {
        let region = self.regions.get(&region).context("unknown catch region")?;
        ensure!(
            region.arms.len() <= limit / 4,
            "catch clauses exceed output budget"
        );
        output.instruction(&Instruction::Block(
            region.outer_type.context("missing catch outer type")?,
        ));
        output.instruction(&Instruction::Block(
            region.private_type.context("missing private shield type")?,
        ));
        for arm in &region.arms {
            output.instruction(&Instruction::Block(
                arm.capture_type.context("missing catch capture type")?,
            ));
            check(output, limit)?;
        }
        let mut catches = Vec::with_capacity(region.arms.len() + 1);
        // The private tag must leave this user try without entering any user
        // catch-all or publishing a user catch selector.
        catches.push(Catch::One {
            tag: unwind_tag,
            label: u32::try_from(region.arms.len())?,
        });
        for (index, arm) in region.arms.iter().enumerate() {
            let label = u32::try_from(region.arms.len() - index - 1)?;
            catches.push(match (arm.tag, arm.is_ref() || arm.uses_exception_recipe) {
                (Some(tag), false) => Catch::One { tag, label },
                (Some(tag), true) => Catch::OneRef { tag, label },
                (None, _) => Catch::AllRef { label },
            });
        }
        Ok(Instruction::TryTable(original_type, Cow::Owned(catches)))
    }

    pub(crate) fn emit_replay_guard(
        &self,
        region: RegionId,
        layout: &FrameLayout,
        runtime: NativeRuntimeIndices,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        let region = self.regions.get(&region).context("unknown catch region")?;
        let selector = self.selector.context("catch plan has no selector")?;
        output.instruction(&Instruction::GlobalGet(runtime.state_global));
        output.instruction(&Instruction::I32Const(crate::runtime::STATE_REWINDING));
        output.instruction(&Instruction::I32GeU);
        layout.emit_get(selector, output, limit)?;
        output.instruction(&Instruction::I32Const(region.selectors.start as i32));
        output.instruction(&Instruction::I32Sub);
        output.instruction(&Instruction::I32Const(region.selectors.len() as i32));
        output.instruction(&Instruction::I32LtU);
        output.instruction(&Instruction::I32And);
        output.instruction(&Instruction::If(BlockType::Empty));
        for arm in &region.arms {
            layout.emit_get(selector, output, limit)?;
            output.instruction(&Instruction::I32Const(arm.selector as i32));
            output.instruction(&Instruction::I32Eq);
            output.instruction(&Instruction::If(BlockType::Empty));
            if arm.uses_exception_recipe {
                layout.emit_get(
                    self.retained_exception
                        .context("recipe catch has no retained exception")?,
                    output,
                    limit,
                )?;
                output.instruction(&Instruction::RefAsNonNull);
                output.instruction(&Instruction::ThrowRef);
            } else {
                for (&local, &ty) in arm.operands.iter().zip(&arm.payload) {
                    typed_get(layout, local, ty, output, limit)?;
                }
                output.instruction(&Instruction::Throw(
                    arm.tag.context("scalar catch has no tag")?,
                ));
            }
            output.instruction(&Instruction::End);
            check(output, limit)?;
        }
        output.instruction(&Instruction::Unreachable);
        output.instruction(&Instruction::End);
        check(output, limit)
    }

    /// Called after the original try's End, while all prefix labels remain
    /// tracked. Normal results bypass every capture tail; exception branches
    /// land immediately after their selected capture block closes.
    pub(crate) fn emit_suffix(
        &self,
        region: RegionId,
        handler_depths: &[u32],
        layout: &FrameLayout,
        unwind_tag: u32,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        let region = self.regions.get(&region).context("unknown catch region")?;
        ensure!(
            handler_depths.len() == region.arms.len(),
            "catch handler depth count changed"
        );
        output.instruction(&Instruction::Br(u32::try_from(region.arms.len() + 1)?));
        for (closed, (arm, &depth)) in region.arms.iter().zip(handler_depths).rev().enumerate() {
            output.instruction(&Instruction::End);
            layout.emit_scratch_reseed(output, limit)?;
            self.emit_capture_tail(arm, layout, output, limit)?;
            let depth = depth
                .checked_sub(u32::try_from(closed + 1)?)
                .context("catch handler points inside capture wrappers")?;
            output.instruction(&Instruction::Br(depth));
            check(output, limit)?;
        }
        output.instruction(&Instruction::End); // private shield landing
        output.instruction(&Instruction::Throw(unwind_tag));
        output.instruction(&Instruction::End); // normal result exit
        check(output, limit)
    }

    fn emit_capture_tail(
        &self,
        arm: &NativeCatchArm,
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        let exception = if arm.uses_exception_recipe {
            self.retained_exception
        } else if arm.is_ref() {
            self.forwarding_exception
        } else {
            None
        };
        if let Some(exception) = exception {
            layout.emit_set(exception, output, limit)?;
        }
        for &local in arm.operands.iter().rev() {
            layout.emit_set(local, output, limit)?;
        }
        output.instruction(&Instruction::I32Const(arm.selector as i32));
        layout.emit_set(
            self.selector.context("catch plan has no selector")?,
            output,
            limit,
        )?;
        if !arm.uses_exception_recipe {
            if let Some(exception) = self.retained_exception {
                clear_reference(layout, exception, RefType::EXNREF, output, limit)?;
            }
        }
        for (&local, &ty) in arm.operands.iter().zip(&arm.payload) {
            typed_get(layout, local, ty, output, limit)?;
        }
        // Payload references already live on the operand stack. The pooled
        // capture-only locals must not keep additional, stale roots alive.
        for (&local, &ty) in arm.operands.iter().zip(&arm.payload) {
            if let ValType::Ref(reference) = ty {
                clear_reference(layout, local, reference, output, limit)?;
            }
        }
        if arm.is_ref() {
            layout.emit_get(
                exception.context("reference catch has no forwarding exception")?,
                output,
                limit,
            )?;
            output.instruction(&Instruction::RefAsNonNull);
        }
        if !arm.uses_exception_recipe {
            if let Some(exception) = exception {
                clear_reference(layout, exception, RefType::EXNREF, output, limit)?;
            }
        }
        check(output, limit)
    }
}

fn typed_get(
    layout: &FrameLayout,
    local: LocalKey,
    ty: ValType,
    output: &mut Function,
    limit: usize,
) -> Result<()> {
    layout.emit_get(local, output, limit)?;
    if matches!(ty, ValType::Ref(reference) if !reference.nullable) {
        output.instruction(&Instruction::RefAsNonNull);
    }
    check(output, limit)
}

fn clear_reference(
    layout: &FrameLayout,
    local: LocalKey,
    ty: RefType,
    output: &mut Function,
    limit: usize,
) -> Result<()> {
    output.instruction(&Instruction::RefNull(ty.heap_type));
    layout.emit_set(local, output, limit)
}

fn check(output: &Function, limit: usize) -> Result<()> {
    ensure!(
        output.byte_len() <= limit,
        "catch emission exceeds output budget"
    );
    Ok(())
}
