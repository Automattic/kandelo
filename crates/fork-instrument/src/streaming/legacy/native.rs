//! Typed control and frame storage for lowering legacy arms during dispatch.
use super::*;
use crate::streaming::{
    ActivationSupportCatalog, CallContinuation, FrameBuilder, FrozenActivationSupport, LocalKey,
    Scan, SourceTypes,
};
use wasm_encoder::{BlockType, ValType, reencode::Reencode};

mod forwarding;
mod planning;
#[cfg(test)]
mod tests;

pub struct NativeLegacyRegion {
    pub(crate) parameters: Vec<ValType>,
    pub(crate) results: Vec<ValType>,
    pub(crate) handlers: Vec<LegacyHandlerId>,
    pub(crate) body_type: Option<BlockType>,
    pub(crate) private_type: Option<BlockType>,
}
pub struct NativeLegacyHandler {
    pub(crate) payload: Vec<ValType>,
    pub(crate) tag: Option<u32>,
    pub(crate) exception: Option<LocalKey>,
    pub(crate) capture_type: Option<BlockType>,
    pub(crate) private_type: Option<BlockType>,
    pub(crate) exception_type: Option<BlockType>,
}
pub struct NativeLegacyExit {
    pub(crate) values: Vec<ValType>,
    pub(crate) block_type: Option<BlockType>,
}
pub struct NativeLegacyForward {
    pub(crate) parameters: Vec<ValType>,
    pub(crate) results: Vec<ValType>,
    pub(crate) normal_type: Option<BlockType>,
    pub(crate) exception_type: Option<BlockType>,
}
pub struct NativeLegacyDelegate {
    pub(crate) parameters: Vec<ValType>,
    pub(crate) results: Vec<ValType>,
    pub(crate) body_type: Option<BlockType>,
    pub(crate) private_type: Option<BlockType>,
    pub(crate) exception_type: Option<BlockType>,
}
pub struct NativeLegacyPlan {
    pub(crate) ownership: LegacyHandlerPlan,
    pub(crate) regions: BTreeMap<RegionId, NativeLegacyRegion>,
    pub(crate) handlers: Vec<NativeLegacyHandler>,
    pub(crate) exits: BTreeMap<(LegacyHandlerId, RegionId), NativeLegacyExit>,
    pub(crate) forwards: BTreeMap<(RegionId, usize), NativeLegacyForward>,
    pub(crate) delegates: BTreeMap<RegionId, NativeLegacyDelegate>,
    limits: LegacyHandlerLimits,
    allocated: bool,
}
impl NativeLegacyPlan {
    pub fn discover<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        types: &SourceTypes,
        map: &mut T,
        limits: LegacyHandlerLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        planning::discover(scan, body, types, map, limits)
    }

    pub(crate) fn allocate(
        &mut self,
        frame: &mut FrameBuilder,
        calls: &[CallContinuation],
        references: &mut [Vec<LocalKey>],
    ) -> Result<()> {
        ensure!(!self.allocated, "legacy storage was already allocated");
        ensure!(
            calls.len() == references.len(),
            "legacy landing count changed"
        );
        let mut budget = Budget {
            metadata: self.limits.metadata_bytes,
            work: self.limits.work,
        };
        for (id, handler) in self.handlers.iter_mut().enumerate() {
            budget.work(1)?;
            let exception = frame.temporary(ValType::EXNREF)?;
            handler.exception = Some(exception);
            let source = &self.ownership.handlers[id].source;
            budget.work((usize::BITS - calls.len().leading_zeros()) as usize + 1)?;
            let first = calls.partition_point(|call| call.instruction < source.start);
            for (call, landing) in calls[first..].iter().zip(&mut references[first..]) {
                budget.work(1)?;
                if call.instruction >= source.end {
                    break;
                }
                // Replay throws this exact owned exception to re-enter the
                // selected arm; it is needed even without a source rethrow.
                budget.metadata(1)?;
                landing.push(exception);
            }
        }
        self.allocated = true;
        Ok(())
    }

    pub fn bind_types(&mut self, support: &mut ActivationSupportCatalog) -> Result<()> {
        self.resolve_types(|parameters, results| support.block_type(parameters, results))
    }
    pub fn bind_frozen_types(&mut self, support: &FrozenActivationSupport) -> Result<()> {
        self.resolve_types(|parameters, results| support.lookup_block_type(parameters, results))
    }
    fn resolve_types(
        &mut self,
        mut resolve: impl FnMut(&[ValType], &[ValType]) -> Result<BlockType>,
    ) -> Result<()> {
        ensure!(self.allocated, "legacy storage was not allocated");
        let mut budget = Budget {
            metadata: self.limits.metadata_bytes,
            work: self.limits.work,
        };
        for region in self.regions.values_mut() {
            budget.work(
                region
                    .parameters
                    .len()
                    .saturating_mul(2)
                    .saturating_add(region.results.len()),
            )?;
            region.body_type = Some(resolve(&region.parameters, &region.results)?);
            region.private_type = Some(resolve(&region.parameters, &[])?);
            for &id in &region.handlers {
                let handler = &mut self.handlers[id.0];
                budget.work(
                    handler
                        .payload
                        .len()
                        .saturating_mul(6)
                        .saturating_add(region.parameters.len())
                        .saturating_add(4),
                )?;
                budget.metadata(handler.payload.len().saturating_add(1))?;
                let mut captured = handler.payload.clone();
                captured.push(ValType::Ref(wasm_encoder::RefType {
                    nullable: false,
                    heap_type: wasm_encoder::RefType::EXNREF.heap_type,
                }));
                handler.capture_type = Some(resolve(&region.parameters, &captured)?);
                // All normal handler results branch to the source try's
                // typed outer label before the cleanup shield closes.
                handler.private_type = Some(resolve(&handler.payload, &[])?);
                handler.exception_type = Some(resolve(&handler.payload, &[ValType::EXNREF])?);
            }
        }
        for (&(id, _), exit) in &mut self.exits {
            budget.work(
                self.handlers[id.0]
                    .payload
                    .len()
                    .saturating_add(exit.values.len())
                    .saturating_add(1),
            )?;
            exit.block_type = Some(resolve(&self.handlers[id.0].payload, &exit.values)?);
        }
        for forward in self.forwards.values_mut() {
            budget.work(
                forward
                    .parameters
                    .len()
                    .saturating_mul(2)
                    .saturating_add(forward.results.len())
                    .saturating_add(1),
            )?;
            forward.normal_type = Some(resolve(&forward.parameters, &forward.results)?);
            forward.exception_type = Some(resolve(&forward.parameters, &[ValType::EXNREF])?);
        }
        for delegate in self.delegates.values_mut() {
            budget.work(
                delegate
                    .parameters
                    .len()
                    .saturating_mul(3)
                    .saturating_add(delegate.results.len())
                    .saturating_add(1),
            )?;
            delegate.body_type = Some(resolve(&delegate.parameters, &delegate.results)?);
            delegate.private_type = Some(resolve(&delegate.parameters, &[])?);
            delegate.exception_type = Some(resolve(&delegate.parameters, &[ValType::EXNREF])?);
        }
        Ok(())
    }
    pub(crate) fn validate_emission(&self) -> Result<()> {
        ensure!(self.allocated, "legacy storage was not allocated");
        ensure!(
            self.regions
                .values()
                .all(|r| r.body_type.is_some() && r.private_type.is_some())
                && self.handlers.iter().all(|h| h.exception.is_some()
                    && h.capture_type.is_some()
                    && h.private_type.is_some()
                    && h.exception_type.is_some())
                && self.exits.values().all(|e| e.block_type.is_some())
                && self
                    .forwards
                    .values()
                    .all(|f| f.normal_type.is_some() && f.exception_type.is_some())
                && self.delegates.values().all(|d| d.body_type.is_some()
                    && d.private_type.is_some()
                    && d.exception_type.is_some()),
            "legacy control types were not frozen"
        );
        Ok(())
    }
    pub(crate) fn owner_at(
        &self,
        instruction: usize,
        work: &mut usize,
    ) -> Result<Option<LegacyHandlerId>> {
        *work = work
            .checked_sub((usize::BITS - self.ownership.handlers.len().leading_zeros()) as usize + 1)
            .context("legacy owner lookup exceeds work budget")?;
        let end = self
            .ownership
            .handlers
            .partition_point(|handler| handler.source.start <= instruction);
        let mut owner = end.checked_sub(1).map(LegacyHandlerId);
        while let Some(id) = owner {
            *work = work
                .checked_sub(1)
                .context("legacy owner lookup exceeds work budget")?;
            let handler = &self.ownership.handlers[id.0];
            if handler.source.contains(&instruction) {
                return Ok(owner);
            }
            owner = handler.parent;
        }
        Ok(None)
    }
}
