//! Bounded cache of authenticated, immutable index pages. A sorted directory
//! finds a page without moving its bytes. Clock eviction shares the slots
//! across positions. Compaction and verification bypass the cache.
use super::{IoBuffer, PAGE_BYTES, PageRef};
use core::num::NonZeroU32;
use wasm_posix_shared::Errno;

struct Line {
    reference: PageRef,
    next_free: Option<NonZeroU32>,
    recent: bool,
    bytes: [u8; PAGE_BYTES],
}

pub(super) struct PageCache {
    pages: IoBuffer<Line>,
    order: IoBuffer<usize>,
    limit: usize,
    hand: usize,
    free_head: Option<NonZeroU32>,
}

impl PageCache {
    pub(super) fn new() -> Self {
        let budget = super::metadata_cache_budget() - super::record_cache_budget();
        Self {
            pages: IoBuffer::new(),
            order: IoBuffer::new(),
            limit: budget / (core::mem::size_of::<Line>() + core::mem::size_of::<usize>()),
            hand: 0,
            free_head: None,
        }
    }

    pub(super) fn use_released_lookup_budget(&mut self, bytes: usize) {
        let budget = super::metadata_cache_budget() - super::record_cache_budget() + bytes;
        self.limit = budget / (core::mem::size_of::<Line>() + core::mem::size_of::<usize>());
    }

    pub(super) fn inherit_budget(&mut self, previous: &Self) {
        self.limit = previous.limit;
    }

    #[cfg(test)]
    pub(super) fn capacity_bytes(&self) -> usize {
        self.limit * (core::mem::size_of::<Line>() + core::mem::size_of::<usize>())
    }

    fn find(&self, number: u64) -> Result<usize, usize> {
        self.order.binary_search_by_key(&number, |&slot| self.pages[slot].reference.number)
    }

    pub(super) fn locate(&mut self, reference: PageRef) -> Option<usize> {
        let slot = self.order[self.find(reference.number).ok()?];
        let line = &mut self.pages[slot];
        if line.reference != reference {
            return None;
        }
        line.recent = true;
        Some(slot)
    }

    pub(super) fn page(&self, slot: usize) -> &[u8; PAGE_BYTES] {
        &self.pages[slot].bytes
    }

    pub(super) fn copy(&mut self, reference: PageRef, target: &mut [u8]) -> bool {
        let Some(slot) = self.locate(reference) else {
            return false;
        };
        target.copy_from_slice(self.page(slot));
        true
    }

    /// Release an authenticated slot once a rewrite supersedes the page.
    /// Earlier roots can still read and authenticate that page from storage.
    pub(super) fn discard(&mut self, reference: PageRef) {
        let Ok(index) = self.find(reference.number) else {
            return;
        };
        let slot = self.order[index];
        if self.pages[slot].reference != reference {
            return;
        }
        let Some(next_head) = u32::try_from(slot + 1).ok().and_then(NonZeroU32::new) else {
            return;
        };
        self.order.remove(index);
        self.pages[slot].next_free = self.free_head.replace(next_head);
    }

    fn reserve_slot(&mut self) -> Result<bool, Errno> {
        let len = self.pages.len();
        if len == self.limit {
            return Ok(false);
        }
        if len < self.pages.capacity().min(self.order.capacity()) {
            return Ok(true);
        }
        let target = (len * 2).max(4).min(self.limit);
        match self.order.try_reserve_exact(target - len)
            .and_then(|()| self.pages.try_reserve_exact(target - len))
        {
            Ok(()) => Ok(true),
            Err(Errno::ENOMEM) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(super) fn remember(&mut self, reference: PageRef, source: &[u8]) -> Result<(), Errno> {
        let bytes: &[u8; PAGE_BYTES] = source.try_into().map_err(|_| Errno::EIO)?;
        let slot = match self.find(reference.number) {
            Ok(index) => self.order[index],
            Err(index) if self.free_head.is_some() => {
                let slot = self.free_head.unwrap().get() as usize - 1;
                self.free_head = self.pages[slot].next_free.take();
                self.order.insert(index, slot);
                slot
            }
            Err(index) if self.reserve_slot()? => {
                let slot = self.pages.len();
                self.pages.push(Line { reference, next_free: None, recent: true, bytes: *bytes });
                self.order.insert(index, slot);
                return Ok(());
            }
            Err(_) if self.pages.is_empty() => return Ok(()),
            Err(_) => {
                let len = self.pages.len();
                loop {
                    let slot = self.hand;
                    self.hand = (slot + 1) % len;
                    if !core::mem::replace(&mut self.pages[slot].recent, false) {
                        let old = self.find(self.pages[slot].reference.number).map_err(|_| Errno::EIO)?;
                        self.order.remove(old);
                        let new = self.find(reference.number).err().ok_or(Errno::EIO)?;
                        self.order.insert(new, slot);
                        break slot;
                    }
                }
            }
        };
        let line = &mut self.pages[slot];
        line.bytes.copy_from_slice(bytes);
        line.reference = reference;
        line.recent = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_slots_hold_the_working_set_and_check_page_identity() {
        let mut cache = PageCache::new();
        assert!(cache.limit > 88);
        let reference = |number| PageRef { number, digest: [number as u8; 32] };
        for number in (1..=cache.limit as u64).rev() {
            cache.remember(reference(number), &[number as u8; PAGE_BYTES]).unwrap();
        }
        for number in 1..=cache.limit as u64 {
            let slot = cache.locate(reference(number)).unwrap();
            assert_eq!(cache.page(slot), &[number as u8; PAGE_BYTES]);
        }
        let next = reference(cache.limit as u64 + 1);
        cache.remember(next, &[42; PAGE_BYTES]).unwrap();
        assert_eq!(cache.pages.len(), cache.limit);
        assert_eq!(cache.order.len(), cache.limit);
        assert_eq!(cache.locate(reference(cache.limit as u64)), None);
        assert!(cache.pages.capacity() * core::mem::size_of::<Line>()
            + cache.order.capacity() * core::mem::size_of::<usize>()
            + super::super::record_cache_budget() <= super::super::metadata_cache_budget());

        let replacement = PageRef { digest: [23; 32], ..next };
        assert_eq!(cache.locate(replacement), None);
        cache.remember(replacement, &[21; PAGE_BYTES]).unwrap();
        assert_eq!(cache.locate(next), None);
        let slot = cache.locate(replacement).unwrap();
        assert_eq!(cache.page(slot), &[21; PAGE_BYTES]);
    }

    #[test]
    fn superseded_slots_are_reused_before_evicting_other_pages() {
        let reference = |number| PageRef { number, digest: [number as u8; 32] };
        let mut cache = PageCache::new();
        cache.limit = 3;
        for number in 1..=3 {
            cache.remember(reference(number), &[number as u8; PAGE_BYTES]).unwrap();
        }
        let two = cache.locate(reference(2)).unwrap();
        let three = cache.locate(reference(3)).unwrap();
        cache.discard(PageRef { digest: [99; 32], ..reference(1) });
        cache.discard(reference(2));
        cache.discard(reference(3));
        cache.discard(reference(2));
        assert_eq!(cache.locate(reference(2)), None);
        assert_eq!(cache.locate(reference(3)), None);

        cache.remember(reference(4), &[4; PAGE_BYTES]).unwrap();
        cache.remember(reference(5), &[5; PAGE_BYTES]).unwrap();
        assert_eq!(cache.locate(reference(4)), Some(three));
        assert_eq!(cache.locate(reference(5)), Some(two));
        assert_eq!(cache.page(three), &[4; PAGE_BYTES]);
        assert_eq!(cache.page(two), &[5; PAGE_BYTES]);
        assert!(cache.locate(reference(1)).is_some());
        assert!(cache.free_head.is_none());

        cache.remember(reference(6), &[6; PAGE_BYTES]).unwrap();
        assert_eq!((cache.pages.len(), cache.order.len()), (3, 3));
        assert!(cache.locate(reference(6)).is_some());
    }

}
