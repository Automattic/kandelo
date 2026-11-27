//! Optional positive lookup cache for a live mount. The committed sequence
//! invalidates entries after any transaction, including attribute changes.
use super::InodeRecord;
use crate::IoBuffer;

const SHORT_NAME: usize = 48;
const MAX_SLOTS: usize = 256;
const PAGE_FAVORING_SLOTS: usize = 32;

#[derive(Clone, Copy)]
struct Entry {
    sequence: u64,
    parent: u64,
    inode: u64,
    record: InodeRecord,
    name: [u8; SHORT_NAME],
    length: u8,
}

pub(super) struct LookupCache {
    entries: IoBuffer<Option<Entry>>,
    root: Option<(u64, InodeRecord)>,
}

impl LookupCache {
    pub(super) fn new() -> Self {
        Self { entries: IoBuffer::new(), root: None }
    }

    /// Reserve a small decoded lookup cache and return the unused share
    /// of the normal lookup allocation to the verified page cache.
    pub(super) fn enable(&mut self) -> usize {
        let entry_bytes = core::mem::size_of::<Option<Entry>>();
        let baseline = baseline_slots();
        let slots = baseline.min(PAGE_FAVORING_SLOTS);
        if slots != 0 && slots != self.entries.len() {
            if let Ok(entries) = IoBuffer::try_filled(slots, None) {
                self.entries = entries;
            }
        }
        (baseline - slots) * entry_bytes
    }

    pub(super) fn clear(&mut self) {
        self.entries.fill(None);
        self.root = None;
    }

    pub(super) fn root(&self, sequence: u64) -> Option<InodeRecord> {
        self.root.filter(|(saved, _)| *saved == sequence).map(|(_, record)| record)
    }

    pub(super) fn save_root(&mut self, sequence: u64, record: InodeRecord) {
        self.root = Some((sequence, record));
    }

    pub(super) fn slot(&self, parent: u64, name: &[u8]) -> Option<usize> {
        if self.entries.is_empty() || name.len() > SHORT_NAME { return None; }
        let mut hash = (parent as u32) ^ ((parent >> 32) as u32) ^ 2166136261;
        for &byte in name { hash = (hash ^ u32::from(byte)).wrapping_mul(16777619); }
        Some(hash as usize & (self.entries.len() - 1))
    }

    pub(super) fn get(&self, slot: usize, sequence: u64, parent: u64, name: &[u8]) -> Option<(u64, InodeRecord)> {
        let entry = self.entries[slot].as_ref()?;
        (entry.sequence == sequence && entry.parent == parent && &entry.name[..usize::from(entry.length)] == name)
            .then_some((entry.inode, entry.record))
    }

    pub(super) fn remember(&mut self, slot: usize, sequence: u64, parent: u64, name: &[u8], inode: u64, record: InodeRecord) {
        let mut bytes = [0; SHORT_NAME];
        bytes[..name.len()].copy_from_slice(name);
        self.entries[slot] = Some(Entry { sequence, parent, inode, record, name: bytes, length: name.len() as u8 });
    }
}

fn baseline_slots() -> usize {
    let budget = crate::io_buffer::IO_MEMORY.usage().1 / 64;
    let count = MAX_SLOTS.min(budget / core::mem::size_of::<Option<Entry>>());
    if count == 0 { 0 } else { 1usize << count.ilog2() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::{PageCache, metadata_cache_budget, record_cache_budget};

    #[test]
    fn verifies_more_pages_within_the_original_cache_budget() {
        let mut pages = PageCache::new();
        let mut lookup = LookupCache::new();
        let old_page_bytes = pages.capacity_bytes();
        let released = lookup.enable();
        pages.use_released_lookup_budget(released);
        let cap = pages.capacity_bytes();
        assert!(cap > old_page_bytes);
        let entry_bytes = core::mem::size_of::<Option<Entry>>();
        assert!(cap + lookup.entries.capacity() * entry_bytes + record_cache_budget()
            <= metadata_cache_budget() + baseline_slots() * entry_bytes);

        pages.use_released_lookup_budget(lookup.enable());
        assert_eq!(pages.capacity_bytes(), cap);
        let mut compacted = PageCache::new();
        compacted.inherit_budget(&pages);
        assert_eq!(compacted.capacity_bytes(), cap);
    }
}
