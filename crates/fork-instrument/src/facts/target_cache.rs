//! Small shared target lists, independent of callers and function IR lifetimes.
use std::collections::BTreeMap;

pub(super) struct TargetCache {
    groups: BTreeMap<(i64, bool), Vec<u32>>,
    bytes: usize,
    limit: usize,
}

impl TargetCache {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            groups: BTreeMap::new(),
            bytes: 0,
            limit,
        }
    }

    pub(super) fn enabled(&self) -> bool {
        self.limit != 0
    }

    pub(super) fn clear(&mut self) {
        self.groups.clear();
        self.bytes = 0;
    }

    pub(super) fn get(&self, key: (i64, bool)) -> Option<Vec<u32>> {
        self.groups.get(&key).cloned()
    }

    pub(super) fn insert(&mut self, key: (i64, bool), targets: &[u32]) {
        let charge = targets.len().saturating_mul(4).saturating_add(96);
        // A cache allowance never rejects a valid target group. Oversized
        // groups keep using disk lookups, and clearing evicts only memoized data.
        if charge > self.limit || self.groups.contains_key(&key) {
            return;
        }
        if charge > self.limit - self.bytes {
            self.clear();
        }
        self.groups.insert(key, targets.to_vec());
        self.bytes += charge;
    }
}
