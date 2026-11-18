//! Mapped Wasm image/capacity intervals, separate from POSIX mmap reservations.
//! Only the exact grouped image owner may install or report logical growth.
//! Physical group extent is never an input to this metadata.
use super::{MemoryManager, ReservedRegion};
use crate::{IoBox, IoBuffer};
use wasm_posix_shared::Errno;

pub(crate) const PAGE: usize = 65536;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LinearRegion { pub start: usize, pub end: usize, pub prot: u32 }

pub(crate) struct GroupLinearMemory {
    pub extent_pages: u32,
    pub maximum_pages: u32,
    pub regions: IoBuffer<LinearRegion>,
}
impl GroupLinearMemory {
    pub fn copy(&self) -> Result<IoBox<Self>, Errno> {
        let mut regions = IoBuffer::try_with_capacity(self.regions.len())?;
        for region in &self.regions { regions.push(*region); }
        IoBox::try_new(Self { extent_pages: self.extent_pages, maximum_pages: self.maximum_pages, regions })
    }
    pub fn same(&self, other: &Self) -> bool {
        self.extent_pages == other.extent_pages && self.maximum_pages == other.maximum_pages
            && self.regions[..] == other.regions[..]
    }
    fn append(regions: &mut IoBuffer<LinearRegion>, region: LinearRegion) {
        if region.start == region.end { return; }
        if let Some(last) = regions.last_mut() {
            if last.end == region.start && last.prot == region.prot { last.end = region.end; return; }
        }
        regions.push(region);
    }
    /// Replace only this state's intersections. Missing ranges remain holes.
    pub fn replace(&mut self, start: usize, end: usize, prot: Option<u32>) -> Result<(), Errno> {
        if start == end { return Ok(()); }
        let capacity = self.regions.len().checked_add(2).ok_or(Errno::ENOMEM)?;
        let mut regions = IoBuffer::try_with_capacity(capacity)?;
        for region in &self.regions {
            if region.end <= start || region.start >= end { Self::append(&mut regions, *region); continue; }
            Self::append(&mut regions, LinearRegion { end: start.max(region.start), ..*region });
            if let Some(prot) = prot {
                Self::append(&mut regions, LinearRegion { start: start.max(region.start), end: end.min(region.end), prot });
            }
            Self::append(&mut regions, LinearRegion { start: end.min(region.end), ..*region });
        }
        self.regions = regions; Ok(())
    }
    /// brk and observed memory.grow add only missing pages; existing rights
    /// and bytes are preserved, including a protected partial heap page.
    pub fn map_missing(&mut self, start: usize, end: usize) -> Result<(), Errno> {
        if start == end { return Ok(()); }
        let capacity = self.regions.len().checked_mul(2).and_then(|n| n.checked_add(1)).ok_or(Errno::ENOMEM)?;
        let mut regions = IoBuffer::try_with_capacity(capacity)?;
        let mut cursor = start;
        for region in &self.regions {
            if region.end <= start { Self::append(&mut regions, *region); continue; }
            if region.start >= end {
                if cursor < end { Self::append(&mut regions, LinearRegion { start: cursor, end, prot: 3 }); cursor = end; }
            } else {
                if cursor < region.start { Self::append(&mut regions, LinearRegion { start: cursor, end: region.start, prot: 3 }); }
                cursor = cursor.max(region.end);
            }
            Self::append(&mut regions, *region);
        }
        if cursor < end { Self::append(&mut regions, LinearRegion { start: cursor, end, prot: 3 }); }
        self.regions = regions; Ok(())
    }
}

/// All values describe one virtual image; none is a physical Memory offset.
#[derive(Clone, Copy)]
pub(crate) struct InitialLayout {
    pub initial_pages: u32,
    pub maximum_pages: u32,
    pub brk_base: usize,
    pub mmap_base: usize,
    pub brk_limit: usize,
    pub control_start: usize,
    pub control_end: usize,
}
impl MemoryManager {
    pub(crate) fn install_group_linear_layout(&mut self, layout: InitialLayout) -> Result<(), Errno> {
        if self.pending_change.is_some() || self.grouped_linear.is_some() { return Err(Errno::EBUSY); }
        let extent = (layout.initial_pages as usize).checked_mul(PAGE).ok_or(Errno::EINVAL)?;
        let maximum = (layout.maximum_pages as usize).checked_mul(PAGE).ok_or(Errno::EINVAL)?;
        if layout.initial_pages == 0 || layout.initial_pages > layout.maximum_pages
            || maximum > self.max_addr || !self.mappings.is_empty() || !self.reserved_regions.is_empty()
            || layout.control_start % PAGE != 0 || layout.control_end % PAGE != 0
            || layout.control_start >= layout.control_end || layout.control_end != layout.brk_base
            || layout.brk_base > extent || layout.brk_base > layout.brk_limit || layout.brk_limit > maximum
            || layout.mmap_base < layout.brk_base || layout.mmap_base > maximum || layout.mmap_base % PAGE != 0 {
            return Err(Errno::EINVAL);
        }
        let mut regions = IoBuffer::try_with_capacity(1)?;
        regions.push(LinearRegion { start: 0, end: extent, prot: 3 });
        let linear = IoBox::try_new(GroupLinearMemory { extent_pages: layout.initial_pages, maximum_pages: layout.maximum_pages, regions })?;
        let mut reserved = IoBuffer::try_with_capacity(1)?;
        reserved.push(ReservedRegion { addr: layout.control_start, len: layout.control_end - layout.control_start });
        // All metadata and budget admission precede the first live mutation.
        self.grouped_linear = Some(linear); self.reserved_regions = reserved;
        self.initial_brk = layout.brk_base; self.program_break = layout.brk_base;
        self.max_addr = maximum; self.brk_limit = layout.brk_limit;
        self.mmap_base = layout.mmap_base; self.reserved_until = layout.brk_base;
        Ok(())
    }
    pub(crate) fn group_virtual_extent(&self) -> Option<u32> { self.grouped_linear.as_deref().map(|state| state.extent_pages) }
    pub(crate) fn group_virtual_maximum(&self) -> Option<u32> { self.grouped_linear.as_deref().map(|state| state.maximum_pages) }
    pub(crate) fn observe_group_virtual_growth(&mut self, pages: u32) -> Result<(), Errno> {
        if self.pending_change.is_some() { return Err(Errno::EBUSY); }
        let linear = self.grouped_linear.as_deref_mut().ok_or(Errno::EOPNOTSUPP)?;
        if pages < linear.extent_pages || pages > linear.maximum_pages { return Err(Errno::EINVAL); }
        if pages == linear.extent_pages { return Ok(()); }
        linear.map_missing(linear.extent_pages as usize * PAGE, pages as usize * PAGE)?;
        linear.extent_pages = pages; Ok(())
    }
    pub(crate) fn inherit_group_linear_memory(&mut self, parent: &Self) -> Result<(), Errno> {
        // Grouped forks inherit the live kernel model, including holes and
        // reserved controls. The ordinary fork wire is not authority for it.
        if parent.grouped_linear.is_some() { *self = parent.copy_for_change()?; }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::change::{MemoryChange, MemoryChangeEffect};
    use wasm_posix_shared::mmap;
    fn layout() -> InitialLayout { InitialLayout { initial_pages: 6, maximum_pages: 64,
        brk_base: 5 * PAGE, mmap_base: 8 * PAGE, brk_limit: 64 * PAGE,
        control_start: 3 * PAGE, control_end: 5 * PAGE } }
    fn configured() -> MemoryManager {
        let mut mm = MemoryManager::new(); mm.install_group_linear_layout(layout()).unwrap(); mm
    }
    fn apply(mm: &mut MemoryManager, change: MemoryChange) -> MemoryChangeEffect {
        let plan = mm.prepare_memory_change(change).unwrap(); mm.commit_memory_change(plan).unwrap()
    }
    fn rights(mm: &MemoryManager, at: usize) -> Option<u32> {
        mm.grouped_linear.as_ref().unwrap().regions.iter().find(|r| r.start <= at && r.end > at).map(|r| r.prot)
    }
    #[test]
    fn real_initial_pages_can_be_protected_and_holes_stay_unmapped() {
        let mut mm = configured();
        apply(&mut mm, MemoryChange::Protect { addr: 0, len: PAGE, prot: 0 });
        assert_eq!(rights(&mm, 0), Some(0)); assert_eq!(rights(&mm, PAGE), Some(3));
        apply(&mut mm, MemoryChange::Unmap { addr: PAGE, len: PAGE });
        assert_eq!(rights(&mm, PAGE), None);
        let before = mm.grouped_linear.as_ref().unwrap().regions.to_vec();
        assert_eq!(mm.prepare_memory_change(MemoryChange::Protect { addr: 0, len: 2 * PAGE, prot: 3 }).unwrap_err(), Errno::ENOMEM);
        assert_eq!(&mm.grouped_linear.as_ref().unwrap().regions[..], &before);
        assert!(!mm.has_pending_memory_change());
    }
    #[test]
    fn host_controls_and_reserved_prefix_cannot_be_replaced_or_protected() {
        let mut mm = configured();
        for change in [MemoryChange::Protect { addr: 3 * PAGE, len: PAGE, prot: 0 },
            MemoryChange::Unmap { addr: 4 * PAGE, len: PAGE },
            MemoryChange::Map { hint: 0, len: PAGE, prot: 3, flags: mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS | mmap::MAP_FIXED }] {
            assert_eq!(mm.prepare_memory_change(change).unwrap_err(), Errno::EINVAL);
            assert!(!mm.has_pending_memory_change());
        }
        assert_eq!(rights(&mm, 3 * PAGE), Some(3));
    }
    #[test]
    fn protection_crosses_linear_and_mmap_intervals_but_cannot_cross_a_hole() {
        let mut requested = layout(); requested.initial_pages = 8;
        let mut mm = MemoryManager::new(); mm.install_group_linear_layout(requested).unwrap();
        apply(&mut mm, MemoryChange::Map { hint: 6 * PAGE, len: PAGE, prot: 3,
            flags: mmap::MAP_PRIVATE | mmap::MAP_ANONYMOUS | mmap::MAP_FIXED });
        assert_eq!(rights(&mm, 6 * PAGE), None);
        apply(&mut mm, MemoryChange::Protect { addr: 5 * PAGE, len: 3 * PAGE, prot: 1 });
        assert_eq!(rights(&mm, 5 * PAGE), Some(1)); assert_eq!(mm.mappings()[0].prot, 1);
        assert_eq!(rights(&mm, 7 * PAGE), Some(1));
        apply(&mut mm, MemoryChange::Unmap { addr: 7 * PAGE, len: PAGE });
        assert_eq!(mm.prepare_memory_change(MemoryChange::Protect { addr: 5 * PAGE, len: 3 * PAGE, prot: 3 }).unwrap_err(), Errno::ENOMEM);
    }
    #[test]
    fn break_query_growth_shrink_and_regrowth_preserve_existing_rights_and_extent() {
        let mut mm = configured();
        assert_eq!(apply(&mut mm, MemoryChange::Break { addr: 0 }), MemoryChangeEffect::Break { old: 5 * PAGE, new: 5 * PAGE });
        apply(&mut mm, MemoryChange::Protect { addr: 5 * PAGE, len: PAGE, prot: 0 });
        let new = 7 * PAGE + 17;
        assert_eq!(apply(&mut mm, MemoryChange::Break { addr: new }), MemoryChangeEffect::Break { old: 5 * PAGE, new });
        assert_eq!(mm.group_virtual_extent(), Some(8)); assert_eq!(rights(&mm, 5 * PAGE), Some(0));
        assert_eq!(rights(&mm, 6 * PAGE), Some(3));
        apply(&mut mm, MemoryChange::Break { addr: 5 * PAGE + 9 });
        assert_eq!(mm.group_virtual_extent(), Some(8)); assert_eq!(rights(&mm, 6 * PAGE), None);
        mm.observe_group_virtual_growth(8).unwrap(); assert_eq!(rights(&mm, 6 * PAGE), None);
        apply(&mut mm, MemoryChange::Break { addr: 7 * PAGE + 1 });
        assert_eq!(rights(&mm, 5 * PAGE), Some(0)); assert_eq!(rights(&mm, 6 * PAGE), Some(3));
        assert_eq!(mm.group_virtual_extent(), Some(8));
    }
    #[test]
    fn break_refusal_does_not_create_pages_or_change_the_old_break() {
        let mut mm = configured(); mm.set_data_limit(PAGE as u64);
        let before = mm.grouped_linear.as_ref().unwrap().regions.to_vec();
        assert_eq!(apply(&mut mm, MemoryChange::Break { addr: 8 * PAGE }), MemoryChangeEffect::Break { old: 5 * PAGE, new: 5 * PAGE });
        assert_eq!(mm.get_brk(), 5 * PAGE); assert_eq!(&mm.grouped_linear.as_ref().unwrap().regions[..], &before);
    }
    #[test]
    fn observed_virtual_growth_preserves_old_holes_and_protection() {
        let mut mm = configured(); apply(&mut mm, MemoryChange::Unmap { addr: 0, len: PAGE });
        apply(&mut mm, MemoryChange::Protect { addr: PAGE, len: PAGE, prot: 1 });
        mm.observe_group_virtual_growth(10).unwrap();
        assert_eq!(rights(&mm, 0), None); assert_eq!(rights(&mm, PAGE), Some(1)); assert_eq!(rights(&mm, 9 * PAGE), Some(3));
        assert_eq!(mm.observe_group_virtual_growth(9), Err(Errno::EINVAL));
        assert_eq!(mm.observe_group_virtual_growth(65), Err(Errno::EINVAL));
        let pending = mm.prepare_memory_change(MemoryChange::Break { addr: 0 }).unwrap();
        assert_eq!(mm.observe_group_virtual_growth(11), Err(Errno::EBUSY)); mm.cancel_memory_change(pending).unwrap();
        assert_eq!(mm.group_virtual_extent(), Some(10));
    }
    #[test]
    fn layout_and_growth_budget_refusal_leave_the_live_model_unchanged() {
        let mut mm = MemoryManager::new(); let old = mm.get_brk(); let held = crate::io_buffer::IO_MEMORY.usage().0;
        { let _limit = crate::io_buffer::test_budget(held);
          assert_eq!(mm.install_group_linear_layout(layout()), Err(Errno::ENOMEM)); }
        assert!(mm.grouped_linear.is_none()); assert!(mm.reserved_regions.is_empty()); assert_eq!(mm.get_brk(), old);
        mm.install_group_linear_layout(layout()).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        { let _limit = crate::io_buffer::test_budget(held);
          assert_eq!(mm.observe_group_virtual_growth(10), Err(Errno::ENOMEM)); }
        assert_eq!(mm.group_virtual_extent(), Some(6)); assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
    }
    #[test]
    fn cancellation_discards_staged_linear_state_and_releases_credit() {
        let mut mm = configured(); let held = crate::io_buffer::IO_MEMORY.usage().0;
        let pending = mm.prepare_memory_change(MemoryChange::Break { addr: 10 * PAGE }).unwrap();
        assert_eq!(mm.get_brk(), 5 * PAGE); assert_eq!(mm.group_virtual_extent(), Some(6));
        mm.cancel_memory_change(pending).unwrap(); assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        assert_eq!(rights(&mm, 8 * PAGE), None);
    }
    #[test]
    fn real_grouped_fork_inherits_kernel_owned_intervals_without_a_new_wire_field() {
        use crate::{process_table::ProcessTable, memory_group::MemoryGroupLimits};
        let mut table = ProcessTable::new(); table.memory_groups().configure(128, 1).unwrap();
        let group = table.memory_groups().create(MemoryGroupLimits { maximum_pages: 64, maximum_processes: 4, maximum_tasks: 4 }).unwrap();
        let pid = table.create_process().unwrap(); let admission = table.prepare_process_memory_group(group, pid).unwrap();
        let parent = &mut table.get_mut(pid).unwrap().memory; parent.install_group_linear_layout(layout()).unwrap();
        apply(parent, MemoryChange::Protect { addr: 0, len: PAGE, prot: 1 });
        apply(parent, MemoryChange::Unmap { addr: PAGE, len: PAGE });
        table.memory_groups().start(admission).unwrap();
        let child = table.fork_process_for_caller(pid, pid).unwrap();
        assert_eq!(rights(&table.get(child).unwrap().memory, 0), Some(1)); assert_eq!(rights(&table.get(child).unwrap().memory, PAGE), None);
        assert_eq!(table.get(child).unwrap().memory.reserved_regions(), table.get(pid).unwrap().memory.reserved_regions());
        apply(&mut table.get_mut(child).unwrap().memory, MemoryChange::Protect { addr: 0, len: PAGE, prot: 0 });
        assert_eq!(rights(&table.get(pid).unwrap().memory, 0), Some(1));
    }
}
