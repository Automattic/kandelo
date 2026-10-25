//! Memoized call selection for one frozen policy, never return/throw effects.

use std::collections::BTreeMap;

use super::{Invocation, PolicyTargets, Value};
use crate::streaming::ProgramPoint;

pub(super) type Key = (ProgramPoint, Invocation, Value, bool);

#[derive(Default)]
pub(super) struct ResolvedTargetCache {
    values: BTreeMap<Key, PolicyTargets>,
    bytes: usize,
}

impl ResolvedTargetCache {
    pub(super) fn get(&self, key: &Key) -> Option<PolicyTargets> {
        self.values.get(key).cloned()
    }

    pub(super) fn insert(&mut self, key: Key, targets: &PolicyTargets, limit: usize) {
        // Include the key, Vec header and conservative B-tree node overhead.
        // Oversized groups use the original query path; caching cannot reject
        // a valid call or retain an unbounded caller-by-target matrix.
        let charge = targets
            .functions
            .len()
            .saturating_mul(4)
            .saturating_add(192);
        if charge > limit || self.values.contains_key(&key) {
            return;
        }
        if charge > limit.saturating_sub(self.bytes) {
            self.values.clear();
            self.bytes = 0;
        }
        self.values.insert(key, targets.clone());
        self.bytes += charge;
    }
}
