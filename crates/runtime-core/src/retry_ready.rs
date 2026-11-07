//! Pre-admitted producer-side dirty-source storage for kernel-owned retries.
//! Publication never allocates; callers admit room while the park can fail.
extern crate alloc;
use alloc::collections::TryReserveError;
use alloc::vec::Vec;

pub(crate) struct ReadySources<Source> { sources: Vec<Source> }
impl<Source: Copy + PartialEq> ReadySources<Source> {
    pub(crate) const fn new() -> Self { Self { sources: Vec::new() } }
    /// Admit at most one distinct source for each live retry, in addition to
    /// old dirties whose owners may already have completed. Failure is before
    /// park/channel publication, never after a committed producer mutation.
    pub(crate) fn prepare(&mut self, live_retries: usize) -> Result<(), TryReserveError> {
        self.sources.try_reserve(live_retries)
    }
    pub(crate) fn record(&mut self, source: Source) {
        if self.sources.contains(&source) { return; }
        assert!(self.sources.len() < self.sources.capacity(), "retry readiness lacks pre-admitted capacity");
        self.sources.push(source);
    }
    pub(crate) fn contains(&self, source: &Source) -> bool { self.sources.contains(source) }
    pub(crate) fn is_empty(&self) -> bool { self.sources.is_empty() }
    pub(crate) fn clear(&mut self) { self.sources.clear(); }
}
