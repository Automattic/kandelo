//! Function-local ownership planning for legacy exception normalization.
//!
//! Handler IDs represent the nullable exception locals that lowering must
//! introduce. Cleanup ranges follow shared parent links instead of retaining
//! a copy of every enclosing handler for each branch or rethrow. This plan
//! neither changes original program points nor enables legacy replay by itself.

use super::{FunctionIr, ProgramPoint, RegionId, RegionKind, TransferKind};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, ops::Range};
use wasmparser::Operator;

mod discover;
#[cfg(test)]
mod oracle_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug)]
pub struct LegacyHandlerLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for LegacyHandlerLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct LegacyHandlerId(pub usize);

#[derive(Debug)]
pub struct LegacyHandler {
    pub region: RegionId,
    pub ordinal: usize,
    /// Original instruction indices, excluding catch and end markers.
    pub source: Range<usize>,
    pub parent: Option<LegacyHandlerId>,
}

/// Clear `first` and its parents, stopping before `keep`. The stop is always
/// an ancestor, checked within the discovery work budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyCleanup {
    pub first: LegacyHandlerId,
    pub keep: Option<LegacyHandlerId>,
}

#[derive(Debug)]
pub struct LegacyRethrow {
    pub instruction: usize,
    pub point: ProgramPoint,
    pub exception: LegacyHandlerId,
    pub cleanup: LegacyCleanup,
}

/// A normalization input, not an emitted continuation. One exit entry can be
/// shared by every branch to the same source label from the same handler.
/// Its target's original signature supplies the typed cleanup shim signature.
#[derive(Debug, Default)]
pub struct LegacyHandlerPlan {
    handlers: Vec<LegacyHandler>,
    exits: BTreeMap<(LegacyHandlerId, RegionId), LegacyCleanup>,
    rethrows: Vec<LegacyRethrow>,
}
impl LegacyHandlerPlan {
    pub fn discover(body: &FunctionIr<'_>, limits: LegacyHandlerLimits) -> Result<Self> {
        discover::discover(body, limits)
    }
    pub fn handlers(&self) -> &[LegacyHandler] {
        &self.handlers
    }
    pub fn rethrows(&self) -> &[LegacyRethrow] {
        &self.rethrows
    }
    pub fn exits(&self) -> impl Iterator<Item = ((LegacyHandlerId, RegionId), LegacyCleanup)> + '_ {
        self.exits.iter().map(|(&key, &cleanup)| (key, cleanup))
    }
    pub fn cleanup_handlers(
        &self,
        cleanup: LegacyCleanup,
    ) -> impl Iterator<Item = LegacyHandlerId> + '_ {
        std::iter::successors(Some(cleanup.first), |id| self.handlers[id.0].parent)
            .take_while(move |id| Some(*id) != cleanup.keep)
    }
}

struct Budget {
    metadata: usize,
    work: usize,
}
impl Budget {
    fn metadata(&mut self, count: usize) -> Result<()> {
        // Includes collection growth and tree-node overhead, before insertion.
        self.metadata = self
            .metadata
            .checked_sub(count.checked_mul(128).context("legacy metadata overflow")?)
            .context("legacy handler plan exceeds metadata budget")?;
        Ok(())
    }
    fn work(&mut self, count: usize) -> Result<()> {
        self.work = self
            .work
            .checked_sub(count)
            .context("legacy handler plan exceeds work budget")?;
        Ok(())
    }
}
