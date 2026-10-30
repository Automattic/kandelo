extern crate alloc;

use crate::io_buffer::IoBuffer;
use wasm_posix_shared::Errno;

/// Reference to an open file description (index into the OFD table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFileDescRef(pub usize);

/// Per-fd entry in the file descriptor table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FdEntry {
    pub ofd_ref: OpenFileDescRef,
    pub fd_flags: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FdSlot {
    Free,
    Reserved,
    Open(FdEntry),
}

/// Per-process file descriptor table.
///
/// Maps integer file descriptors to open file description references.
/// Guarantees lowest-available-fd allocation (POSIX requirement).
pub struct FdTable {
    inline: [FdSlot; 3],
    slots: IoBuffer<FdSlot>,
    occupied_slots: usize,
    max_fds: usize,
}

impl FdTable {
    /// Default maximum of 1024 file descriptors.
    const DEFAULT_MAX: usize = 1024;

    pub fn new() -> Self {
        Self::with_max(Self::DEFAULT_MAX)
    }

    pub fn with_max(max_fds: usize) -> Self {
        FdTable {
            inline: [FdSlot::Free; 3],
            slots: IoBuffer::new(),
            occupied_slots: 0,
            max_fds,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_budget(max_fds: usize, budget: &'static crate::metadata_budget::MetadataBudget) -> Self {
        let mut result = Self::with_max(max_fds);
        result.slots = IoBuffer::new_in(budget);
        result
    }

    fn slot_count(&self) -> usize {
        self.inline.len() + self.slots.len()
    }

    fn slot(&self, index: usize) -> Option<&FdSlot> {
        if index < self.inline.len() {
            self.inline.get(index)
        } else {
            self.slots.get(index - self.inline.len())
        }
    }

    fn slot_mut(&mut self, index: usize) -> Option<&mut FdSlot> {
        if index < self.inline.len() {
            self.inline.get_mut(index)
        } else {
            self.slots.get_mut(index - self.inline.len())
        }
    }

    fn ensure_slot(&mut self, index: usize, limit: usize) -> Result<(), Errno> {
        self.ensure_slot_with(index, limit, |slots, capacity| {
            slots.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
        })
    }

    fn ensure_slot_with(
        &mut self,
        index: usize,
        limit: usize,
        allocate: impl FnOnce(&mut alloc::vec::Vec<FdSlot>, usize) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if index < self.slot_count() {
            return Ok(());
        }
        let length = index.checked_add(1).ok_or(Errno::ENOMEM)? - self.inline.len();
        if length <= self.slots.capacity() {
            self.slots.resize(length, FdSlot::Free);
            return Ok(());
        }
        let capacity = length.max(self.slots.capacity().saturating_mul(2))
            .min(limit.saturating_sub(self.inline.len()));
        self.slots.reserve_with(capacity, |slots| {
            allocate(slots, capacity)
        })?;
        self.slots.resize(length, FdSlot::Free);
        Ok(())
    }

    fn replace_slot(&mut self, index: usize, value: FdSlot) {
        let previous = core::mem::replace(self.slot_mut(index).unwrap(), value);
        if index >= self.inline.len() {
            match (previous == FdSlot::Free, value == FdSlot::Free) {
                (true, false) => self.occupied_slots += 1,
                (false, true) => self.occupied_slots -= 1,
                _ => {}
            }
        }
    }

    fn reclaim_empty_slots(&mut self) {
        if self.occupied_slots == 0 {
            self.slots = IoBuffer::new_in(self.slots.budget());
        }
    }

    /// Pre-open stdin (0), stdout (1), stderr (2) pointing to OFD refs 0, 1, 2.
    pub fn preopen_stdio(&mut self) {
        for i in 0..3 {
            let _ = self.alloc(OpenFileDescRef(i), 0);
        }
    }

    /// Allocate the lowest available fd for the given OFD reference.
    pub fn alloc(&mut self, ofd_ref: OpenFileDescRef, fd_flags: u32) -> Result<i32, Errno> {
        self.alloc_at_min(ofd_ref, fd_flags, 0)
    }

    /// Allocate the lowest available fd >= `min_fd`.
    pub fn alloc_at_min(
        &mut self,
        ofd_ref: OpenFileDescRef,
        fd_flags: u32,
        min_fd: i32,
    ) -> Result<i32, Errno> {
        let min = min_fd.max(0) as usize;

        for index in min..self.slot_count() {
            if self.slot(index) == Some(&FdSlot::Free) {
                if index >= self.max_fds || index > i32::MAX as usize {
                    return Err(Errno::EMFILE);
                }
                self.replace_slot(index, FdSlot::Open(FdEntry { ofd_ref, fd_flags }));
                return Ok(index as i32);
            }
        }

        let next = self.slot_count().max(min);
        if next >= self.max_fds || next > i32::MAX as usize {
            return Err(Errno::EMFILE);
        }

        self.ensure_slot(next, self.max_fds)?;
        self.replace_slot(next, FdSlot::Open(FdEntry { ofd_ref, fd_flags }));
        Ok(next as i32)
    }

    /// Reserve the lowest available descriptor number without exposing an fd.
    pub fn reserve(&mut self) -> Result<i32, Errno> {
        for index in 0..self.slot_count() {
            if self.slot(index) == Some(&FdSlot::Free) {
                if index >= self.max_fds || index > i32::MAX as usize {
                    return Err(Errno::EMFILE);
                }
                self.replace_slot(index, FdSlot::Reserved);
                return Ok(index as i32);
            }
        }

        let next = self.slot_count();
        if next >= self.max_fds || next > i32::MAX as usize {
            return Err(Errno::EMFILE);
        }
        self.ensure_slot(next, self.max_fds)?;
        self.replace_slot(next, FdSlot::Reserved);
        Ok(next as i32)
    }

    pub fn reserve_pair(&mut self) -> Result<(i32, i32), Errno> {
        let first = self.reserve()?;
        match self.reserve() {
            Ok(second) => Ok((first, second)),
            Err(error) => {
                self.release_reserved(first);
                Err(error)
            }
        }
    }

    /// Publish an entry into a slot previously claimed by [`Self::reserve`].
    pub fn install_reserved(
        &mut self,
        fd: i32,
        ofd_ref: OpenFileDescRef,
        fd_flags: u32,
    ) -> Result<(), Errno> {
        let idx = usize::try_from(fd).map_err(|_| Errno::EBADF)?;
        if self.slot(idx) != Some(&FdSlot::Reserved) {
            return Err(Errno::EBADF);
        }
        self.replace_slot(idx, FdSlot::Open(FdEntry { ofd_ref, fd_flags }));
        Ok(())
    }

    /// Release an in-progress descriptor allocation.
    pub fn release_reserved(&mut self, fd: i32) -> bool {
        let Ok(index) = usize::try_from(fd) else { return false; };
        if self.slot(index) != Some(&FdSlot::Reserved) {
            return false;
        }
        self.replace_slot(index, FdSlot::Free);
        self.reclaim_empty_slots();
        true
    }

    /// Close a file descriptor, returning the OFD reference it pointed to.
    pub fn free(&mut self, fd: i32) -> Result<OpenFileDescRef, Errno> {
        let index = usize::try_from(fd).map_err(|_| Errno::EBADF)?;
        let Some(FdSlot::Open(entry)) = self.slot(index).copied() else {
            return Err(Errno::EBADF);
        };
        self.replace_slot(index, FdSlot::Free);
        self.reclaim_empty_slots();
        Ok(entry.ofd_ref)
    }

    /// Look up an fd entry by reference.
    pub fn get(&self, fd: i32) -> Result<&FdEntry, Errno> {
        let index = usize::try_from(fd).map_err(|_| Errno::EBADF)?;
        match self.slot(index) {
            Some(FdSlot::Open(entry)) => Ok(entry),
            _ => Err(Errno::EBADF),
        }
    }

    /// Look up an fd entry by mutable reference.
    pub fn get_mut(&mut self, fd: i32) -> Result<&mut FdEntry, Errno> {
        let index = usize::try_from(fd).map_err(|_| Errno::EBADF)?;
        match self.slot_mut(index) {
            Some(FdSlot::Open(entry)) => Ok(entry),
            _ => Err(Errno::EBADF),
        }
    }

    /// Iterate over all open file descriptors.
    pub fn iter(&self) -> impl Iterator<Item = (i32, &FdEntry)> + '_ {
        self.inline.iter().chain(self.slots.iter())
            .enumerate()
            .filter_map(|(index, slot)| match slot {
                FdSlot::Open(entry) => Some((index as i32, entry)),
                _ => None,
            })
    }

    pub(crate) fn restore_entry(&mut self, fd: usize, entry: FdEntry) -> Result<(), Errno> {
        i32::try_from(fd).map_err(|_| Errno::EINVAL)?;
        self.ensure_slot(fd, i32::MAX as usize + 1)?;
        self.replace_slot(fd, FdSlot::Open(entry));
        Ok(())
    }

    pub fn try_clone(&self) -> Result<Self, Errno> {
        let mut result = Self::with_max(self.max_fds);
        result.slots = IoBuffer::new_in(self.slots.budget());
        for (fd, entry) in self.iter() {
            result.restore_entry(fd as usize, *entry)?;
        }
        Ok(result)
    }

    /// Returns the max_fds limit.
    pub fn max_fds(&self) -> usize {
        self.max_fds
    }

    /// Update the max_fds limit (e.g. when RLIMIT_NOFILE changes).
    pub fn set_max_fds(&mut self, max: usize) {
        self.max_fds = max;
    }

    /// Place an entry at a specific fd (dup2 semantics).
    ///
    /// If the slot was occupied, returns `Some(old_ofd_ref)`.
    /// If the slot was empty, returns `None`.
    /// Returns `EBADF` if `fd` is negative or exceeds the max limit.
    pub fn set_at(
        &mut self,
        fd: i32,
        ofd_ref: OpenFileDescRef,
        fd_flags: u32,
    ) -> Result<Option<OpenFileDescRef>, Errno> {
        let idx = fd as usize;
        if fd < 0 || idx >= self.max_fds {
            return Err(Errno::EBADF);
        }

        if self.slot(idx) == Some(&FdSlot::Reserved) {
            return Err(Errno::EBUSY);
        }

        self.ensure_slot(idx, self.max_fds)?;
        let old = match self.slot(idx) {
            Some(FdSlot::Open(entry)) => Some(entry.ofd_ref),
            _ => None,
        };
        self.replace_slot(idx, FdSlot::Open(FdEntry { ofd_ref, fd_flags }));
        Ok(old)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use alloc::boxed::Box;
    use crate::metadata_budget::MetadataBudget;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    fn table_with_budget(limit: usize) -> (FdTable, &'static MetadataBudget) {
        let budget = Box::leak(Box::new(MetadataBudget::new(limit)));
        let table = FdTable::with_budget(1024, budget);
        (table, budget)
    }

    fn slot_charge() -> usize {
        2 * core::mem::size_of::<FdSlot>()
    }

    #[test]
    fn inline_stdio_and_reservations_need_no_heap_credit() {
        let (mut table, budget) = table_with_budget(0);
        table.preopen_stdio();
        let inherited = table.try_clone().unwrap();
        assert_eq!(inherited.iter().count(), 3);
        table.free(1).unwrap();
        assert_eq!(table.reserve(), Ok(1));
        assert_eq!(table.free(1), Err(Errno::EBADF));
        assert!(table.release_reserved(1));
        assert_eq!(table.alloc(OpenFileDescRef(20), 0), Ok(1));
        assert_eq!(budget.usage(), (0, 0));
    }

    #[test]
    fn descriptor_growth_refusal_leaves_no_reserved_or_open_slot() {
        let (mut table, budget) = table_with_budget(0);
        table.preopen_stdio();
        assert_eq!(table.reserve(), Err(Errno::ENOMEM));
        assert_eq!(table.alloc(OpenFileDescRef(10), 0), Err(Errno::ENOMEM));
        assert_eq!(table.set_at(50, OpenFileDescRef(10), 0), Err(Errno::ENOMEM));
        assert_eq!(table.iter().count(), 3);
        assert_eq!(table.slot_count(), 3);
        assert_eq!(budget.usage().0, 0);
        budget.set_limit(slot_charge()).unwrap();
        assert_eq!(table.reserve(), Ok(3));
        assert!(table.release_reserved(3));
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn descriptor_growth_admits_old_and_new_allocations_before_publication() {
        let (mut table, budget) = table_with_budget(slot_charge());
        table.preopen_stdio();
        assert_eq!(table.reserve(), Ok(3));
        assert_eq!(table.reserve(), Err(Errno::ENOMEM));
        assert_eq!(table.get(3), Err(Errno::EBADF));
        assert_eq!(table.slot_count(), 4);
        assert_eq!(budget.usage().0, slot_charge());
        table.install_reserved(3, OpenFileDescRef(40), FD_CLOEXEC).unwrap();
        assert!(!table.release_reserved(3));
        budget.set_limit(3 * slot_charge()).unwrap();
        assert_eq!(table.reserve(), Ok(4));
        assert_eq!(budget.usage().0, 2 * slot_charge());
        assert!(table.release_reserved(4));
        assert_eq!(budget.usage().0, 2 * slot_charge());
        assert_eq!(table.get(3).unwrap().ofd_ref, OpenFileDescRef(40));
        assert_eq!(table.free(3), Ok(OpenFileDescRef(40)));
        assert_eq!(budget.usage().0, 0);
        assert_eq!(table.slot_count(), 3);
    }

    #[test]
    fn descriptor_allocator_failure_releases_staging_credit_and_preserves_wait() {
        let (mut table, budget) = table_with_budget(3 * slot_charge());
        table.preopen_stdio();
        assert_eq!(table.reserve(), Ok(3));
        let result = table.ensure_slot_with(4, 1024, |_, _| Err(Errno::ENOMEM));
        assert_eq!(result, Err(Errno::ENOMEM));
        assert_eq!(budget.usage().0, slot_charge());
        assert_eq!(table.slot_count(), 4);
        assert!(table.release_reserved(3));
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn spare_descriptor_capacity_remains_usable_at_an_exhausted_budget() {
        let (mut table, budget) = table_with_budget(6 * slot_charge());
        table.preopen_stdio();
        for expected in 3..6 {
            assert_eq!(table.alloc(OpenFileDescRef(expected as usize), 0), Ok(expected));
        }
        assert_eq!(table.slots.capacity(), 4);
        budget.set_limit(budget.usage().0).unwrap();
        assert_eq!(table.reserve(), Ok(6));
        table.install_reserved(6, OpenFileDescRef(6), 0).unwrap();
        assert_eq!(table.reserve(), Err(Errno::ENOMEM));
        assert_eq!(table.slots.capacity(), 4);
        assert_eq!(table.slots.len(), 4);
        drop(table);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn consecutive_restoration_and_cloning_keep_geometric_capacity() {
        let (mut table, budget) = table_with_budget(192 * slot_charge());
        table.preopen_stdio();
        for fd in 3..67 {
            table.restore_entry(fd, FdEntry { ofd_ref: OpenFileDescRef(fd), fd_flags: 0 }).unwrap();
        }
        assert_eq!(table.slots.capacity(), 64);
        assert_eq!(budget.usage().0, 64 * slot_charge());
        let inherited = table.try_clone().unwrap();
        assert_eq!(inherited.iter().count(), 67);
        assert_eq!(inherited.slots.capacity(), 64);
        assert_eq!(budget.usage().0, 128 * slot_charge());
        drop(inherited);
        drop(table);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn descriptor_allocator_rounding_refusal_keeps_live_storage() {
        let (mut table, budget) = table_with_budget(3 * slot_charge());
        table.preopen_stdio();
        assert_eq!(table.alloc(OpenFileDescRef(10), 0), Ok(3));
        let result = table.ensure_slot_with(4, 1024, |slots, capacity| {
            slots.try_reserve_exact(capacity + 2).map_err(|_| Errno::ENOMEM)
        });
        assert_eq!(result, Err(Errno::ENOMEM));
        assert_eq!(budget.usage().0, slot_charge());
        assert_eq!(table.get(3).unwrap().ofd_ref, OpenFileDescRef(10));
        assert_eq!(table.slot_count(), 4);
        drop(table);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn descriptor_clone_refusal_preserves_parent_and_releases_partial_child() {
        let (mut table, budget) = table_with_budget(3 * slot_charge());
        table.preopen_stdio();
        table.alloc(OpenFileDescRef(10), 0).unwrap();
        table.alloc(OpenFileDescRef(11), FD_CLOEXEC).unwrap();
        budget.set_limit(3 * slot_charge()).unwrap();
        assert_eq!(table.try_clone().err(), Some(Errno::ENOMEM));
        assert_eq!(table.iter().count(), 5);
        assert_eq!(budget.usage().0, 2 * slot_charge());
        budget.set_limit(5 * slot_charge()).unwrap();
        let inherited = table.try_clone().unwrap();
        assert_eq!(inherited.get(4).unwrap().fd_flags, FD_CLOEXEC);
        assert_eq!(budget.usage().0, 4 * slot_charge());
        drop(inherited);
        assert_eq!(budget.usage().0, 2 * slot_charge());
        drop(table);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn reserved_only_heap_slots_are_not_copied_to_child() {
        let (mut table, budget) = table_with_budget(slot_charge());
        table.preopen_stdio();
        assert_eq!(table.reserve(), Ok(3));
        let inherited = table.try_clone().unwrap();
        assert_eq!(inherited.slot_count(), 3);
        assert_eq!(budget.usage().0, slot_charge());
        assert!(table.release_reserved(3));
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn restoration_preserves_existing_fds_above_a_reduced_limit() {
        let (mut table, budget) = table_with_budget(64 * slot_charge());
        table.set_max_fds(2);
        table.restore_entry(20, FdEntry { ofd_ref: OpenFileDescRef(9), fd_flags: FD_CLOEXEC }).unwrap();
        assert_eq!(table.get(20).unwrap().ofd_ref, OpenFileDescRef(9));
        let inherited = table.try_clone().unwrap();
        assert_eq!(inherited.max_fds(), 2);
        assert_eq!(inherited.get(20).unwrap().fd_flags, FD_CLOEXEC);
        assert_eq!(table.set_at(20, OpenFileDescRef(10), 0), Err(Errno::EBADF));
        assert_eq!(table.alloc(OpenFileDescRef(10), 0), Ok(0));
        drop(inherited);
        table.free(20).unwrap();
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn oversized_restored_descriptor_is_rejected_before_allocation() {
        let (mut table, budget) = table_with_budget(0);
        let entry = FdEntry { ofd_ref: OpenFileDescRef(1), fd_flags: 0 };
        assert_eq!(table.restore_entry(u32::MAX as usize, entry), Err(Errno::EINVAL));
        assert_eq!(table.restore_entry(i32::MAX as usize, entry), Err(Errno::ENOMEM));
        assert_eq!(table.slot_count(), 3);
        assert_eq!(budget.usage().0, 0);
    }

    #[test]
    fn test_alloc_returns_lowest_available() {
        let mut table = FdTable::new();
        table.preopen_stdio(); // occupies 0, 1, 2
        let fd = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd, 3);
    }

    #[test]
    fn test_alloc_fills_gaps() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // Alloc fds 3 and 4
        let fd3 = table.alloc(OpenFileDescRef(10), 0).unwrap();
        let fd4 = table.alloc(OpenFileDescRef(11), 0).unwrap();
        assert_eq!(fd3, 3);
        assert_eq!(fd4, 4);
        // Free fd 3, creating a gap
        table.free(3).unwrap();
        // Next alloc should reuse fd 3, not allocate fd 5
        let fd_reused = table.alloc(OpenFileDescRef(12), 0).unwrap();
        assert_eq!(fd_reused, 3);
    }

    #[test]
    fn test_alloc_at_minimum() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc_at_min(OpenFileDescRef(10), 0, 10).unwrap();
        assert_eq!(fd, 10);
    }

    #[test]
    fn test_close_invalid_fd() {
        let mut table = FdTable::new();
        let result = table.free(99);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_get_fd_flags() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(10), FD_CLOEXEC).unwrap();
        let entry = table.get(fd).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOEXEC);
        assert_eq!(entry.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_emfile_when_full() {
        let mut table = FdTable::with_max(4);
        table.preopen_stdio(); // occupies 0, 1, 2
        // One more should succeed (fd 3)
        table.alloc(OpenFileDescRef(10), 0).unwrap();
        // Table is now full (4 of 4)
        let result = table.alloc(OpenFileDescRef(11), 0);
        assert_eq!(result, Err(Errno::EMFILE));
    }

    #[test]
    fn reserved_slot_is_invisible_and_excluded_from_allocation() {
        let mut table = FdTable::with_max(5);
        table.preopen_stdio();
        let reserved = table.reserve().unwrap();
        assert_eq!(reserved, 3);
        assert_eq!(table.get(reserved), Err(Errno::EBADF));
        assert_eq!(
            table.set_at(reserved, OpenFileDescRef(99), 0),
            Err(Errno::EBUSY),
        );

        let visible = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(visible, 4);
        assert_eq!(table.reserve(), Err(Errno::EMFILE));

        table
            .install_reserved(reserved, OpenFileDescRef(11), FD_CLOEXEC)
            .unwrap();
        assert_eq!(table.get(reserved).unwrap().ofd_ref, OpenFileDescRef(11));
    }

    #[test]
    fn reservations_can_be_released_and_are_not_cloned() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let reserved = table.reserve().unwrap();

        let mut inherited = table.try_clone().unwrap();
        assert_eq!(inherited.alloc(OpenFileDescRef(20), 0).unwrap(), reserved);

        assert!(table.release_reserved(reserved));
        assert!(!table.release_reserved(reserved));
        assert_eq!(table.alloc(OpenFileDescRef(21), 0).unwrap(), reserved);
    }

    #[test]
    fn test_set_at_displaces_existing() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd, 3);
        // set_at on occupied fd 3 should return the old OFD ref
        let old = table.set_at(3, OpenFileDescRef(20), 0).unwrap();
        assert_eq!(old, Some(OpenFileDescRef(10)));
        // Verify the new entry is in place
        let entry = table.get(3).unwrap();
        assert_eq!(entry.ofd_ref, OpenFileDescRef(20));
    }

    #[test]
    fn test_set_at_empty_slot() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // set_at on unused fd 5 should return None
        let old = table.set_at(5, OpenFileDescRef(10), 0).unwrap();
        assert_eq!(old, None);
        // Verify the entry exists now
        let entry = table.get(5).unwrap();
        assert_eq!(entry.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_get_invalid_fd_returns_ebadf() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        // fd 5 is not allocated
        let result = table.get(5);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_iter_returns_open_fds() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let fd3 = table.alloc(OpenFileDescRef(10), 0).unwrap();
        assert_eq!(fd3, 3);

        let fds: Vec<(i32, &FdEntry)> = table.iter().collect();
        assert_eq!(fds.len(), 4); // 0,1,2,3
        assert_eq!(fds[0].0, 0);
        assert_eq!(fds[3].0, 3);
        assert_eq!(fds[3].1.ofd_ref, OpenFileDescRef(10));
    }

    #[test]
    fn test_iter_skips_closed_fds() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        table.free(1).unwrap(); // close fd 1

        let fds: Vec<(i32, &FdEntry)> = table.iter().collect();
        assert_eq!(fds.len(), 2); // 0, 2
        assert_eq!(fds[0].0, 0);
        assert_eq!(fds[1].0, 2);
    }

    #[test]
    fn test_from_raw_roundtrip() {
        let mut table = FdTable::new();
        table.preopen_stdio();
        let max = table.max_fds();

        let entries: Vec<Option<FdEntry>> = table.iter().fold(Vec::new(), |mut v, (fd, entry)| {
            while v.len() <= fd as usize {
                v.push(None);
            }
            v[fd as usize] = Some(entry.clone());
            v
        });
        let mut rebuilt = FdTable::with_max(max);
        for (index, entry) in entries.into_iter().enumerate() {
            if let Some(entry) = entry {
                rebuilt.restore_entry(index, entry).unwrap();
            }
        }
        assert_eq!(rebuilt.get(0).unwrap().ofd_ref, OpenFileDescRef(0));
        assert_eq!(rebuilt.get(1).unwrap().ofd_ref, OpenFileDescRef(1));
        assert_eq!(rebuilt.get(2).unwrap().ofd_ref, OpenFileDescRef(2));
        assert!(rebuilt.get(3).is_err());
    }
}
