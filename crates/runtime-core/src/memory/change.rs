//! Staged address-space metadata. No host page table, byte, device or kernel
//! process state is changed here. The syscall owner must retain the exact
//! process/image authority, stage backing/device effects and validate this plan
//! before publishing them. Ordinary syscalls do not use this path yet.
use super::{MappedRegion, MemoryManager, MmapRefusal};
use crate::IoBuffer;
use core::sync::atomic::{AtomicU64, Ordering};
use wasm_posix_shared::{mmap, Errno};

static LAST_CHANGE: AtomicU64 = AtomicU64::new(0);
const PAGE: usize = 65536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MemoryChange {
    Map { hint: usize, len: usize, prot: u32, flags: u32 },
    Unmap { addr: usize, len: usize },
    Protect { addr: usize, len: usize, prot: u32 },
    Remap { addr: usize, old_len: usize, new_len: usize, flags: u32 },
    Break { addr: usize },
}

/// Host work still required before metadata can be committed. These are guest
/// addresses; they never authorize dereferencing kernel or group storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryChangeEffect {
    Map { addr: usize, len: usize, prot: u32, flags: u32 },
    Unmap { addr: usize, len: usize },
    Protect { addr: usize, len: usize, prot: u32 },
    Remap { old_addr: usize, old_len: usize, new_addr: usize, new_len: usize, prot: u32 },
    Break { old: usize, new: usize },
}

/// One-shot Rust custody. The two snapshots have admitted I/O metadata credit;
/// neither publishing nor cancellation needs another allocation. A failed
/// validation returns this owner so its actual manager can still cancel it.
pub(crate) struct PreparedMemoryChange {
    serial: u64,
    baseline: MemoryManager,
    proposed: MemoryManager,
    effect: MemoryChangeEffect,
}
impl core::fmt::Debug for PreparedMemoryChange {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PreparedMemoryChange").field("serial", &self.serial)
            .field("effect", &self.effect).finish_non_exhaustive()
    }
}
impl PreparedMemoryChange {
    pub(crate) fn effect(&self) -> MemoryChangeEffect { self.effect }
    pub(crate) fn serial(&self) -> u64 { self.serial }
}

fn next_change(sequence: &AtomicU64) -> Result<u64, Errno> {
    sequence.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| old.checked_add(1))
        .map(|old| old + 1).map_err(|_| Errno::EOVERFLOW)
}
fn aligned_len(len: usize) -> Result<usize, Errno> {
    if len == 0 { return Err(Errno::EINVAL); }
    len.checked_add(PAGE - 1).map(|n| n & !(PAGE - 1)).ok_or(Errno::EINVAL)
}
fn interval(addr: usize, len: usize) -> Result<usize, Errno> {
    if addr % PAGE != 0 { return Err(Errno::EINVAL); }
    addr.checked_add(len).ok_or(Errno::EINVAL)
}

impl MemoryManager {
    pub(crate) fn has_pending_memory_change(&self) -> bool { self.pending_change.is_some() }
    pub(crate) fn owns_memory_change(&self, plan: &PreparedMemoryChange) -> bool {
        self.pending_change == Some(plan.serial)
    }

    pub(crate) fn prepare_memory_change(&mut self, change: MemoryChange) -> Result<PreparedMemoryChange, Errno> {
        if self.pending_change.is_some() { return Err(Errno::EBUSY); }
        let baseline = self.copy_for_change()?;
        let mut proposed = self.copy_for_change()?;
        let effect = proposed.apply_change(change)?;
        let serial = next_change(&LAST_CHANGE)?;
        // No fallible step follows acquiring live transaction custody.
        self.pending_change = Some(serial);
        Ok(PreparedMemoryChange { serial, baseline, proposed, effect })
    }

    pub(crate) fn validate_memory_change(&self, plan: &PreparedMemoryChange) -> Result<(), Errno> {
        if self.pending_change != Some(plan.serial) { return Err(Errno::ESRCH); }
        if !self.same_metadata(&plan.baseline) { return Err(Errno::EAGAIN); }
        Ok(())
    }

    pub(crate) fn commit_memory_change(&mut self, plan: PreparedMemoryChange)
        -> Result<MemoryChangeEffect, (Errno, PreparedMemoryChange)> {
        if let Err(error) = self.validate_memory_change(&plan) { return Err((error, plan)); }
        let effect = plan.effect;
        *self = plan.proposed;
        Ok(effect)
    }

    pub(crate) fn cancel_memory_change(&mut self, plan: PreparedMemoryChange)
        -> Result<(), (Errno, PreparedMemoryChange)> {
        if self.pending_change != Some(plan.serial) { return Err((Errno::ESRCH, plan)); }
        // Cancellation never restores an old snapshot over intervening writes.
        self.pending_change = None;
        Ok(())
    }

    fn copy_for_change(&self) -> Result<Self, Errno> {
        let mut mappings = IoBuffer::try_with_capacity(self.mappings.len())?;
        for mapping in &self.mappings { mappings.push(mapping.clone()); }
        let mut reserved_regions = IoBuffer::try_with_capacity(self.reserved_regions.len())?;
        for region in &self.reserved_regions { reserved_regions.push(*region); }
        Ok(Self { mappings, reserved_regions, pending_change: None,
            last_exact_mapping_id: self.last_exact_mapping_id,
            program_break: self.program_break, max_addr: self.max_addr,
            mmap_base: self.mmap_base, reserved_until: self.reserved_until,
            brk_limit: self.brk_limit, data_limit: self.data_limit, initial_brk: self.initial_brk })
    }

    fn same_metadata(&self, baseline: &Self) -> bool {
        self.last_exact_mapping_id == baseline.last_exact_mapping_id
            && self.program_break == baseline.program_break && self.max_addr == baseline.max_addr
            && self.mmap_base == baseline.mmap_base && self.reserved_until == baseline.reserved_until
            && self.brk_limit == baseline.brk_limit && self.data_limit == baseline.data_limit
            && self.initial_brk == baseline.initial_brk
            && self.reserved_regions[..] == baseline.reserved_regions[..]
            && self.mappings.len() == baseline.mappings.len()
            && self.mappings.iter().zip(baseline.mappings.iter()).all(|(a, b)| {
                a == b && match (&a.file, &b.file) {
                    (Some(a), Some(b)) => alloc::rc::Rc::ptr_eq(a, b),
                    (None, None) => true,
                    _ => false,
                }
            })
    }

    fn apply_change(&mut self, change: MemoryChange) -> Result<MemoryChangeEffect, Errno> {
        match change {
            MemoryChange::Map { hint, len, prot, flags } => {
                let len = aligned_len(len)?;
                if prot & !7 != 0 || (flags & mmap::MAP_FIXED != 0 && hint % PAGE != 0) { return Err(Errno::EINVAL); }
                let addr = self.try_mmap_anonymous(hint, len, prot, flags).map_err(|error| match error {
                    MmapRefusal::Invalid => Errno::EINVAL,
                    MmapRefusal::AddressSpaceExhausted | MmapRefusal::KernelMemoryExhausted => Errno::ENOMEM,
                })?;
                Ok(MemoryChangeEffect::Map { addr, len, prot, flags })
            }
            MemoryChange::Unmap { addr, len } => {
                let len = aligned_len(len)?;
                interval(addr, len)?;
                if self.overlaps_host_reserved_region(addr, len) { return Err(Errno::EINVAL); }
                self.munmap(addr, len)?;
                Ok(MemoryChangeEffect::Unmap { addr, len })
            }
            MemoryChange::Protect { addr, len, prot } => {
                if prot & !7 != 0 { return Err(Errno::EINVAL); }
                let len = if len == 0 { 0 } else { aligned_len(len)? };
                let end = interval(addr, len)?;
                if self.overlaps_host_reserved_region(addr, len) { return Err(Errno::EINVAL); }
                self.protect_mapped_range(addr, end, prot)?;
                Ok(MemoryChangeEffect::Protect { addr, len, prot })
            }
            MemoryChange::Break { addr } => {
                let old = self.get_brk();
                let new = self.set_brk(addr);
                Ok(MemoryChangeEffect::Break { old, new })
            }
            MemoryChange::Remap { addr, old_len, new_len, flags } => {
                if flags & !1 != 0 { return Err(Errno::EINVAL); }
                let old_len = aligned_len(old_len)?;
                let new_len = aligned_len(new_len)?;
                let end = interval(addr, old_len)?;
                if self.overlaps_host_reserved_region(addr, old_len) { return Err(Errno::EINVAL); }
                let original = self.mappings.iter().find(|m| m.addr <= addr && m.addr.checked_add(m.len).is_some_and(|e| e >= end))
                    .cloned().ok_or(Errno::EFAULT)?;
                let new_addr = if new_len <= old_len {
                    if new_len < old_len { self.munmap(addr + new_len, old_len - new_len)?; }
                    addr
                } else if self.can_grow_at(end, new_len - old_len) {
                    if !self.extend_mapping(addr, old_len, new_len) { return Err(Errno::EFAULT); }
                    addr
                } else if flags & 1 != 0 {
                    self.reserve_mapping_slots(2)?;
                    let target = self.try_mmap_anonymous(0, new_len, original.prot, original.flags & !mmap::MAP_FIXED)
                        .map_err(|_| Errno::ENOMEM)?;
                    if let Some(file) = original.file.clone() {
                        self.set_mapping_file(target, original.offset_after(addr - original.addr), file);
                    }
                    self.munmap(addr, old_len)?;
                    target
                } else { return Err(Errno::ENOMEM); };
                Ok(MemoryChangeEffect::Remap { old_addr: addr, old_len, new_addr, new_len, prot: original.prot })
            }
        }
    }

    /// This metadata stage supports mmap intervals. Initial linear image and
    /// brk permissions require explicit image-layout ownership in the adapter;
    /// a hole must not acquire a mapping merely because protection was asked.
    fn protect_mapped_range(&mut self, addr: usize, end: usize, prot: u32) -> Result<(), Errno> {
        if addr == end { return Ok(()); }
        let mut cursor = addr;
        for mapping in &self.mappings {
            let map_end = mapping.addr.checked_add(mapping.len).ok_or(Errno::EINVAL)?;
            if map_end <= cursor { continue; }
            if mapping.addr > cursor { break; }
            cursor = map_end.min(end);
            if cursor == end { break; }
        }
        if cursor != end { return Err(Errno::ENOMEM); }
        let capacity = self.mappings.len().checked_add(2).ok_or(Errno::ENOMEM)?;
        let mut replacement = IoBuffer::try_with_capacity(capacity)?;
        for mapping in &self.mappings {
            let map_end = mapping.addr + mapping.len;
            let start = addr.max(mapping.addr);
            let finish = end.min(map_end);
            if start >= finish { replacement.push(mapping.clone()); continue; }
            for (base, limit, rights) in [(mapping.addr, start, mapping.prot), (start, finish, prot), (finish, map_end, mapping.prot)] {
                if base >= limit { continue; }
                let mut fragment: MappedRegion = mapping.clone();
                fragment.addr = base; fragment.len = limit - base; fragment.prot = rights;
                fragment.file_offset = mapping.offset_after(base - mapping.addr);
                replacement.push(fragment);
            }
        }
        self.mappings = replacement;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::MappingFile;
    use alloc::{rc::Rc, vec};
    const ANON: u32 = mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS;
    fn manager() -> MemoryManager {
        let mut mm = MemoryManager::new();
        mm.set_brk_base(PAGE);
        mm.set_mmap_base(4 * PAGE);
        mm.set_max_addr(32 * PAGE);
        mm
    }
    fn map(len: usize) -> MemoryChange { MemoryChange::Map { hint: 0, len, prot: 3, flags: ANON } }

    #[test]
    fn preparation_and_cancellation_do_not_publish_or_restore_live_mappings() {
        let mut mm = manager();
        let old = mm.mmap_anonymous(0, PAGE, 3, ANON);
        let before = mm.mappings().to_vec();
        let plan = mm.prepare_memory_change(MemoryChange::Map { hint: old, len: PAGE, prot: 1, flags: ANON | mmap::MAP_FIXED }).unwrap();
        assert_eq!(plan.effect(), MemoryChangeEffect::Map { addr: old, len: PAGE, prot: 1, flags: ANON | mmap::MAP_FIXED });
        assert_eq!(mm.mappings(), before);
        assert_eq!(mm.prepare_memory_change(map(PAGE)).unwrap_err(), Errno::EBUSY);
        let other = mm.mmap_anonymous(0, PAGE, 3, ANON);
        assert_eq!(mm.validate_memory_change(&plan), Err(Errno::EAGAIN));
        mm.cancel_memory_change(plan).unwrap();
        assert!(mm.is_mapped(other));
        assert_eq!(mm.mappings()[0].prot, 3);
        assert!(!mm.has_pending_memory_change());
    }

    #[test]
    fn exact_owner_and_consumption_survive_rejected_foreign_commit() {
        let mut a = manager();
        let mut b = manager();
        let left = a.prepare_memory_change(map(PAGE)).unwrap();
        let right = b.prepare_memory_change(map(2 * PAGE)).unwrap();
        let (error, left) = b.commit_memory_change(left).unwrap_err();
        assert_eq!(error, Errno::ESRCH);
        assert!(a.has_pending_memory_change() && b.has_pending_memory_change());
        a.commit_memory_change(left).unwrap();
        b.cancel_memory_change(right).unwrap();
        assert_eq!(a.mappings().len(), 1);
        assert!(b.mappings().is_empty());
        assert!(!a.has_pending_memory_change());
        let next = a.prepare_memory_change(map(PAGE)).unwrap();
        a.cancel_memory_change(next).unwrap();
    }

    #[test]
    fn publication_needs_no_new_metadata_allocation() {
        let mut mm = manager();
        mm.mmap_anonymous(0, 3 * PAGE, 3, ANON);
        let plan = mm.prepare_memory_change(MemoryChange::Protect { addr: 5 * PAGE, len: PAGE, prot: 1 }).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(held);
        mm.commit_memory_change(plan).unwrap();
        assert_eq!(mm.mappings().iter().map(|m| (m.addr, m.len, m.prot)).collect::<alloc::vec::Vec<_>>(),
            vec![(4 * PAGE, PAGE, 3), (5 * PAGE, PAGE, 1), (6 * PAGE, PAGE, 3)]);
    }

    #[test]
    fn split_protection_keeps_exact_file_identity_and_byte_offsets() {
        let mut mm = manager();
        let base = mm.mmap_anonymous(0, 3 * PAGE, 3, ANON);
        let file = Rc::new(MappingFile { dev: 7, ino: 9, name: vec![b'x'] });
        mm.set_mapping_file(base, 4096, file.clone());
        let plan = mm.prepare_memory_change(MemoryChange::Protect { addr: base + PAGE, len: PAGE, prot: 0 }).unwrap();
        assert_eq!(mm.mappings().len(), 1);
        mm.commit_memory_change(plan).unwrap();
        assert_eq!(mm.mappings().len(), 3);
        for (i, m) in mm.mappings().iter().enumerate() {
            assert!(Rc::ptr_eq(m.file.as_ref().unwrap(), &file));
            assert_eq!(m.file_offset, 4096 + (i * PAGE) as u64);
        }
    }

    #[test]
    fn protection_of_a_hole_fails_without_mapping_it_or_taking_custody() {
        let mut mm = manager();
        let base = mm.mmap_anonymous(0, 3 * PAGE, 3, ANON);
        mm.munmap(base + PAGE, PAGE).unwrap();
        let before = mm.mappings().to_vec();
        assert_eq!(mm.prepare_memory_change(MemoryChange::Protect { addr: base, len: 3 * PAGE, prot: 1 }).unwrap_err(), Errno::ENOMEM);
        assert_eq!(mm.mappings(), before);
        assert!(!mm.has_pending_memory_change());
    }

    #[test]
    fn allocation_refusal_releases_staging_and_leaves_fixed_target_intact() {
        let mut mm = manager();
        let base = mm.mmap_anonymous(0, 3 * PAGE, 3, ANON);
        let before = mm.mappings().to_vec();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(mm.prepare_memory_change(MemoryChange::Map { hint: base + PAGE, len: PAGE, prot: 0, flags: ANON | mmap::MAP_FIXED }).unwrap_err(), Errno::ENOMEM);
        }
        assert_eq!(mm.mappings(), before);
        assert!(!mm.has_pending_memory_change());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
    }

    #[test]
    fn cancellation_returns_all_staging_credit() {
        let mut mm = manager();
        mm.mmap_anonymous(0, PAGE, 3, ANON);
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let plan = mm.prepare_memory_change(map(PAGE)).unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > held);
        mm.cancel_memory_change(plan).unwrap();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
    }

    #[test]
    fn stale_commit_returns_its_owner_and_preserves_new_limit_and_mapping() {
        let mut mm = manager();
        let plan = mm.prepare_memory_change(map(PAGE)).unwrap();
        mm.set_data_limit(77);
        let address = mm.mmap_anonymous(0, 2 * PAGE, 1, ANON);
        let (error, plan) = mm.commit_memory_change(plan).unwrap_err();
        assert_eq!(error, Errno::EAGAIN);
        mm.cancel_memory_change(plan).unwrap();
        assert_eq!(mm.data_limit, 77);
        assert_eq!(mm.mappings()[0].addr, address);
        assert_eq!(mm.mappings()[0].len, 2 * PAGE);
    }

    #[test]
    fn equal_file_labels_and_consumed_mapping_ids_do_not_forge_baseline_identity() {
        let mut mm = manager();
        let base = mm.mmap_anonymous(0, PAGE, 3, ANON);
        let file = Rc::new(MappingFile { dev: 7, ino: 9, name: vec![b'x'] });
        mm.set_mapping_file(base, 0, file);
        let plan = mm.prepare_memory_change(map(PAGE)).unwrap();
        mm.set_mapping_file(base, 0, Rc::new(MappingFile { dev: 7, ino: 9, name: vec![b'x'] }));
        assert_eq!(mm.validate_memory_change(&plan), Err(Errno::EAGAIN));
        mm.cancel_memory_change(plan).unwrap();
        let plan = mm.prepare_memory_change(map(PAGE)).unwrap();
        mm.reserve_exact_mapping_id().unwrap();
        assert_eq!(mm.validate_memory_change(&plan), Err(Errno::EAGAIN));
        mm.cancel_memory_change(plan).unwrap();
    }

    #[test]
    fn staged_break_and_unmap_only_change_the_live_manager_on_commit() {
        let mut mm = manager();
        let plan = mm.prepare_memory_change(MemoryChange::Break { addr: 2 * PAGE }).unwrap();
        assert_eq!(plan.effect(), MemoryChangeEffect::Break { old: PAGE, new: 2 * PAGE });
        assert_eq!(mm.get_brk(), PAGE);
        mm.commit_memory_change(plan).unwrap();
        assert_eq!(mm.get_brk(), 2 * PAGE);
        let base = mm.mmap_anonymous(0, 3 * PAGE, 3, ANON);
        let plan = mm.prepare_memory_change(MemoryChange::Unmap { addr: base + PAGE, len: 1 }).unwrap();
        assert_eq!(plan.effect(), MemoryChangeEffect::Unmap { addr: base + PAGE, len: PAGE });
        assert_eq!(mm.mappings().len(), 1);
        mm.commit_memory_change(plan).unwrap();
        assert_eq!(mm.mappings().len(), 2);
    }

    #[test]
    fn moving_and_shrinking_remap_plans_keep_backing_offsets() {
        let mut mm = manager();
        let base = mm.mmap_anonymous(0, 3 * PAGE, 1, ANON);
        let file = Rc::new(MappingFile { dev: 3, ino: 5, name: vec![] });
        mm.set_mapping_file(base, 4096, file.clone());
        mm.mmap_anonymous(base + 3 * PAGE, PAGE, 3, ANON | mmap::MAP_FIXED);
        let plan = mm.prepare_memory_change(MemoryChange::Remap { addr: base, old_len: 3 * PAGE, new_len: 4 * PAGE, flags: 1 }).unwrap();
        let MemoryChangeEffect::Remap { new_addr, .. } = plan.effect() else { panic!("not remap") };
        assert_ne!(new_addr, base);
        assert!(mm.is_mapped(base));
        mm.commit_memory_change(plan).unwrap();
        assert!(!mm.is_mapped(base));
        let moved = mm.mappings().iter().find(|m| m.addr == new_addr).unwrap();
        assert_eq!(moved.file_offset, 4096);
        assert!(Rc::ptr_eq(moved.file.as_ref().unwrap(), &file));
        let plan = mm.prepare_memory_change(MemoryChange::Remap { addr: new_addr, old_len: 4 * PAGE, new_len: PAGE, flags: 0 }).unwrap();
        mm.commit_memory_change(plan).unwrap();
        assert_eq!(mm.mappings().iter().find(|m| m.addr == new_addr).unwrap().len, PAGE);
    }

    #[test]
    fn invalid_or_wrapped_operations_cannot_consume_a_plan_slot() {
        let mut mm = manager();
        for change in [map(0), MemoryChange::Unmap { addr: 1, len: PAGE },
            MemoryChange::Protect { addr: 0, len: PAGE, prot: 8 },
            MemoryChange::Remap { addr: 0, old_len: usize::MAX, new_len: PAGE, flags: 0 },
            MemoryChange::Remap { addr: 0, old_len: PAGE, new_len: PAGE, flags: 2 }] {
            assert!(mm.prepare_memory_change(change).is_err());
            assert!(!mm.has_pending_memory_change());
        }
    }

    #[test]
    fn transaction_serial_exhaustion_is_terminal_and_never_wraps() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(next_change(&counter), Ok(u64::MAX));
        assert_eq!(next_change(&counter), Err(Errno::EOVERFLOW));
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
    }
}
