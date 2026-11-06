//! Bounded reuse of hot specialization bodies from one immutable source scan.

use crate::streaming::{BodyProvider, FunctionIr, IrLimits, Scan};
use anyhow::Result;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

struct Entry<'a> {
    body: Arc<FunctionIr<'a>>,
    charge: usize,
}

pub(super) struct CachedBodies<'s, 'a> {
    provider: BodyProvider<'s, 'a>,
    entries: BTreeMap<u32, Entry<'a>>,
    order: VecDeque<u32>,
    bytes: usize,
    limit: usize,
}

impl<'s, 'a> CachedBodies<'s, 'a> {
    pub(super) fn new(scan: &'s Scan<'a>, ir: IrLimits, limit: usize) -> Self {
        Self {
            provider: scan.body_provider(ir),
            entries: BTreeMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            limit,
        }
    }

    pub(super) fn load(&mut self, function: u32) -> Result<Arc<FunctionIr<'a>>> {
        if let Some(entry) = self.entries.get(&function) {
            return Ok(Arc::clone(&entry.body));
        }
        let body = Arc::new(self.provider.load(function)?);
        // Include Arc, tree/deque entries and conservative node overhead.
        // Oversized bodies remain transient; an allowance never rejects input.
        let charge = body.retained_bytes().saturating_add(512);
        if charge <= self.limit {
            while self.bytes > self.limit - charge {
                let oldest = self.order.pop_front().unwrap();
                self.bytes -= self.entries.remove(&oldest).unwrap().charge;
            }
            self.bytes += charge;
            self.order.push_back(function);
            self.entries.insert(
                function,
                Entry {
                    body: Arc::clone(&body),
                    charge,
                },
            );
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_eviction_and_oversized_bodies_preserve_live_borrowers() {
        let input = wat::parse_str(format!(
            "(module (func nop) (func nop) (func (local {})))",
            "i64 ".repeat(64)
        ))
        .unwrap();
        let scan = crate::streaming::scan(&input).unwrap();
        let mut probe = CachedBodies::new(&scan, Default::default(), 0);
        let first = probe.load(0).unwrap();
        assert!(!Arc::ptr_eq(&first, &probe.load(0).unwrap()));
        let limit = first.retained_bytes() + 512;
        let mut cache = CachedBodies::new(&scan, Default::default(), limit);
        let first = cache.load(0).unwrap();
        assert!(Arc::ptr_eq(&first, &cache.load(0).unwrap()));
        let second = cache.load(1).unwrap();
        assert!(cache.bytes <= limit);
        assert!(!cache.entries.contains_key(&0));
        assert_eq!(
            first.function, 0,
            "eviction cannot invalidate a live interpreter body"
        );
        assert_eq!(second.function, 1);
        let large = cache.load(2).unwrap();
        assert!(large.retained_bytes() + 512 > limit);
        assert!(Arc::ptr_eq(&second, &cache.load(1).unwrap()));
        assert!(cache.bytes <= limit);
    }
}
