extern crate alloc;
use alloc::vec::Vec;

/// Tracks a single mmap'd region.
#[derive(Debug, Clone)]
pub struct MappedRegion {
    pub addr: usize, // start address in linear memory
    pub len: usize,  // length in bytes
    pub prot: u32,   // protection flags (tracked but not enforced)
    pub flags: u32,  // map flags
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservedRegion {
    pub addr: usize,
    pub len: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct MemoryLayoutMetadata {
    pub initial_brk: usize,
    pub max_addr: usize,
    pub brk_limit: usize,
    pub mmap_base: usize,
    pub reserved_until: usize,
}

/// Kernel memory manager for mmap/munmap/brk.
pub struct MemoryManager {
    /// List of active mappings, kept sorted by address.
    mappings: Vec<MappedRegion>,
    /// Host-owned dynamic control ranges. These occupy process address space
    /// but are not guest mmap mappings and cannot be released by munmap.
    reserved_regions: Vec<ReservedRegion>,
    /// Current program break (for brk).
    program_break: usize,
    /// Upper bound for mmap allocation (default 1GB = Wasm max-memory).
    max_addr: usize,
    /// Lower bound for automatic mmap allocation.
    mmap_base: usize,
    /// Optional reserved prefix for compact process memories. When non-zero,
    /// MAP_FIXED/mremap cannot enter addresses below this point.
    reserved_until: usize,
    /// Upper bound for brk allocation. Defaults to the process max address and
    /// can be lowered by legacy hosts to reserve in-memory syscall/thread
    /// control pages between brk and mmap.
    brk_limit: usize,
    /// RLIMIT_DATA soft limit (updated by setrlimit). u64::MAX = unlimited.
    data_limit: u64,
    /// Program break at process start, used to compute data segment growth.
    initial_brk: usize,
}

impl MemoryManager {
    /// Default mmap region starts at 64MB (0x04000000).
    /// This leaves room for stack and heap below (brk starts at 16MB).
    /// Programs like CPython need large contiguous mmap regions, so we
    /// keep MMAP_BASE low to maximize available space.
    const MMAP_BASE: usize = 0x04000000;

    /// Fallback initial program break at 16MB, used only when the host
    /// has not called [`Self::set_brk_base`] with the program's
    /// `__heap_base` export. For programs built with our SDK this is
    /// always overridden before `_start` runs; the constant is a safety
    /// net for non-standard binaries that lack `__heap_base`.
    const INITIAL_BRK: usize = 0x01000000;

    /// Default address space limit (1GB, matching --max-memory).
    const DEFAULT_MAX_ADDR: usize = 0x40000000;

    pub fn new() -> Self {
        MemoryManager {
            mappings: Vec::new(),
            reserved_regions: Vec::new(),
            program_break: Self::INITIAL_BRK,
            max_addr: Self::DEFAULT_MAX_ADDR,
            mmap_base: Self::MMAP_BASE,
            reserved_until: 0,
            brk_limit: Self::DEFAULT_MAX_ADDR,
            data_limit: u64::MAX,
            initial_brk: Self::INITIAL_BRK,
        }
    }

    /// Read-only access to the mmap mappings (for fork serialization).
    pub fn mappings(&self) -> &[MappedRegion] {
        &self.mappings
    }

    pub fn reserved_regions(&self) -> &[ReservedRegion] {
        &self.reserved_regions
    }

    /// Restore mmap mappings from fork (used by deserialize_fork_state).
    pub fn set_mappings(&mut self, mut mappings: Vec<MappedRegion>) {
        // Ordinary mmap/munmap mutations preserve address order. Restore that
        // invariant explicitly at the fork-state boundary so later first-fit
        // scans do not depend on serialized input order.
        mappings.sort_by_key(|mapping| mapping.addr);
        self.mappings = mappings;
    }

    /// Allocate an anonymous mapping. Returns the base address.
    /// If `hint` is non-zero and MAP_FIXED is set, maps at exactly that address
    /// (unmapping any overlapping regions first).
    pub fn mmap_anonymous(&mut self, hint: usize, len: usize, prot: u32, flags: u32) -> usize {
        use wasm_posix_shared::mmap::MAP_FIXED;

        if len == 0 {
            return wasm_posix_shared::mmap::MAP_FAILED;
        }

        // Align to page boundary (Wasm page = 64KB).
        // Use saturating add to prevent overflow for very large sizes.
        let aligned_len = match len.checked_add(0xFFFF) {
            Some(v) => v & !0xFFFF,
            None => return wasm_posix_shared::mmap::MAP_FAILED, // overflow → too large
        };

        let addr = if hint != 0 && (flags & MAP_FIXED) != 0 {
            // MAP_FIXED: use the exact address, removing any overlapping mappings
            // Reject if the region extends past max_addr or overlaps
            // host-reserved control pages.
            let end = hint.saturating_add(aligned_len);
            if end > self.max_addr
                || self.overlaps_reserved_prefix(hint, aligned_len)
                || self.overlaps_reserved_regions(hint, aligned_len)
                || self.overlaps_host_control(hint, aligned_len)
                || (self.reserved_until != 0 && self.overlaps_brk_heap(hint, aligned_len))
            {
                return wasm_posix_shared::mmap::MAP_FAILED;
            }
            self.mappings.retain(|m| {
                let m_end = m.addr.saturating_add(m.len);
                // Keep mappings that don't overlap [hint, end)
                m_end <= hint || m.addr >= end
            });
            hint
        } else {
            // A non-null address without MAP_FIXED is a placement hint. Wasm
            // mappings use 64 KiB pages, so mirror mmap's page-boundary
            // behavior by rounding the hint down and using it only when the
            // complete range is available. An unusable hint falls back to
            // the ordinary first-fit search without replacing anything.
            let rounded_hint = hint & !0xFFFF;
            let hinted_addr = if rounded_hint >= self.mmap_base.max(self.program_break)
                && self.can_grow_at(rounded_hint, aligned_len)
            {
                Some(rounded_hint)
            } else {
                None
            };

            // Find the first gap in [mmap_base, max_addr) when the hint is
            // absent or unusable. Mappings are kept sorted by address.
            match hinted_addr.or_else(|| self.find_gap(aligned_len)) {
                Some(a) => a,
                None => return wasm_posix_shared::mmap::MAP_FAILED,
            }
        };

        // Insert sorted by address
        let pos = self.mappings.partition_point(|m| m.addr < addr);
        self.mappings.insert(
            pos,
            MappedRegion {
                addr,
                len: aligned_len,
                prot,
                flags,
            },
        );

        addr
    }

    /// Find the first gap in [mmap_base, max_addr) that can fit `needed` bytes.
    fn find_gap(&self, needed: usize) -> Option<usize> {
        let mut cursor = self.mmap_base.max(self.program_break);

        // Both collections are maintained in address order. Merge them as two
        // sorted streams so the first-fit decision is identical to scanning a
        // combined sorted list without materializing that temporary list.
        let mut mapping_idx = 0;
        let mut reserved_idx = 0;
        loop {
            let next_mapping = self
                .mappings
                .get(mapping_idx)
                .map(|mapping| (mapping.addr, mapping.len, true));
            let next_reserved = self
                .reserved_regions
                .get(reserved_idx)
                .map(|reserved| (reserved.addr, reserved.len, false));
            let Some((addr, len, is_mapping)) = (match (next_mapping, next_reserved) {
                (Some(mapping), Some(reserved)) => {
                    // The old stable address sort saw mappings before reserved
                    // regions at an equal start address.
                    if mapping.0 <= reserved.0 {
                        Some(mapping)
                    } else {
                        Some(reserved)
                    }
                }
                (Some(mapping), None) => Some(mapping),
                (None, Some(reserved)) => Some(reserved),
                (None, None) => None,
            }) else {
                break;
            };

            if is_mapping {
                mapping_idx += 1;
            } else {
                reserved_idx += 1;
            }
            if addr < cursor {
                let end = addr.saturating_add(len);
                if end > cursor {
                    cursor = end;
                }
                continue;
            }
            if addr >= cursor {
                let gap = addr - cursor;
                if gap >= needed {
                    return Some(cursor);
                }
            }
            let end = addr.saturating_add(len);
            if end > cursor {
                cursor = end;
            }
        }
        // Check gap after last mapping
        if cursor.saturating_add(needed) <= self.max_addr {
            Some(cursor)
        } else {
            None
        }
    }

    fn overlaps_host_control(&self, addr: usize, len: usize) -> bool {
        if self.brk_limit >= self.mmap_base {
            return false;
        }
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return true,
        };
        addr < self.mmap_base && end > self.brk_limit
    }

    fn overlaps_reserved_prefix(&self, addr: usize, len: usize) -> bool {
        if self.reserved_until == 0 {
            return false;
        }
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return true,
        };
        addr < self.reserved_until && end > addr
    }

    fn overlaps_mappings(&self, addr: usize, len: usize) -> bool {
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return true,
        };
        for m in &self.mappings {
            let m_end = m.addr.saturating_add(m.len);
            if addr < m_end && end > m.addr {
                return true;
            }
        }
        false
    }

    fn overlaps_reserved_regions(&self, addr: usize, len: usize) -> bool {
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return true,
        };
        for r in &self.reserved_regions {
            let r_end = r.addr.saturating_add(r.len);
            if addr < r_end && end > r.addr {
                return true;
            }
        }
        false
    }

    pub fn overlaps_host_reserved_region(&self, addr: usize, len: usize) -> bool {
        self.overlaps_reserved_regions(addr, len)
    }

    fn overlaps_brk_heap(&self, addr: usize, len: usize) -> bool {
        if self.program_break <= self.initial_brk {
            return false;
        }
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return true,
        };
        addr < self.program_break && end > self.initial_brk
    }

    /// Unmap a region [addr, addr+len). Supports partial unmapping:
    /// - Exact match: removes the mapping entirely
    /// - Front trim: unmapping the beginning of a mapping shrinks it
    /// - Back trim: unmapping the end of a mapping shrinks it
    /// - Split: unmapping the middle of a mapping splits it into two
    /// Returns true if any overlap was found and handled.
    pub fn munmap(&mut self, addr: usize, len: usize) -> bool {
        if len == 0 {
            return false;
        }
        let aligned_len = match len.checked_add(0xFFFF) {
            Some(value) => value & !0xFFFF,
            None => return false,
        };
        let unmap_end = addr.saturating_add(aligned_len);
        let mut found = false;
        let mut new_mappings: Vec<MappedRegion> = Vec::new();

        for m in self.mappings.drain(..) {
            let m_end = m.addr.saturating_add(m.len);

            // No overlap — keep as is
            if m_end <= addr || m.addr >= unmap_end {
                new_mappings.push(m);
                continue;
            }

            found = true;

            // Left remnant: mapping starts before unmap region
            if m.addr < addr {
                new_mappings.push(MappedRegion {
                    addr: m.addr,
                    len: addr - m.addr,
                    prot: m.prot,
                    flags: m.flags,
                });
            }

            // Right remnant: mapping extends past unmap region
            if m_end > unmap_end {
                new_mappings.push(MappedRegion {
                    addr: unmap_end,
                    len: m_end - unmap_end,
                    prot: m.prot,
                    flags: m.flags,
                });
            }
        }

        self.mappings = new_mappings;
        found
    }

    /// Get the current program break.
    pub fn get_brk(&self) -> usize {
        self.program_break
    }

    /// Set the program's initial break to a value derived from the wasm
    /// binary's `__heap_base` export. Updates both the current break and
    /// the `initial_brk` baseline used for `RLIMIT_DATA` accounting.
    ///
    /// Called by the host once per process, between `kernel_create_process`
    /// (or post-exec re-init) and the moment the new program's `_start`
    /// can issue its first `brk` syscall. Without this, [`Self::INITIAL_BRK`]
    /// is a fallback that may sit inside the stack region of programs
    /// with a large data section (e.g. mariadbd's `__heap_base ≈ 16.32MB`),
    /// causing the heap and shadow stack to overlap.
    pub fn set_brk_base(&mut self, addr: usize) {
        self.initial_brk = addr;
        self.program_break = addr;
        if self.mmap_base < addr {
            self.mmap_base = Self::align_page_up(addr);
        }
    }

    /// Set the program break. Returns the new break on success, or the
    /// current break unchanged on failure (limit exceeded).
    pub fn set_brk(&mut self, new_brk: usize) -> usize {
        if new_brk == 0 {
            // Query current break
            return self.program_break;
        }
        if new_brk < self.initial_brk {
            return self.program_break;
        }
        // brk can't grow out of the process address space, past its
        // configured compatibility ceiling, or through an mmap allocation.
        if new_brk > self.max_addr {
            return self.program_break;
        }
        if new_brk > self.brk_limit {
            return self.program_break;
        }
        if new_brk > self.program_break
            && self.overlaps_mappings(self.program_break, new_brk - self.program_break)
        {
            return self.program_break;
        }
        if new_brk > self.program_break
            && self.overlaps_reserved_regions(self.program_break, new_brk - self.program_break)
        {
            return self.program_break;
        }
        // Enforce RLIMIT_DATA: data segment growth from initial_brk
        if new_brk > self.initial_brk {
            let growth = (new_brk - self.initial_brk) as u64;
            if growth > self.data_limit {
                return self.program_break; // fail: return current break unchanged
            }
        }
        self.program_break = new_brk;
        new_brk
    }

    /// Update the RLIMIT_DATA soft limit (called from sys_setrlimit).
    pub fn set_data_limit(&mut self, limit: u64) {
        self.data_limit = limit;
    }

    /// Check if an address is in a mapped region.
    pub fn is_mapped(&self, addr: usize) -> bool {
        self.mappings
            .iter()
            .any(|m| addr >= m.addr && addr < m.addr + m.len)
    }

    /// Check if `len` bytes starting at `addr` are free (no overlap with existing mappings
    /// and within address space bounds).
    pub fn can_grow_at(&self, addr: usize, len: usize) -> bool {
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return false,
        };
        if end > self.max_addr {
            return false;
        }
        if self.overlaps_host_control(addr, len) {
            return false;
        }
        if self.overlaps_reserved_prefix(addr, len) {
            return false;
        }
        if self.overlaps_reserved_regions(addr, len) {
            return false;
        }
        if self.reserved_until != 0 && self.overlaps_brk_heap(addr, len) {
            return false;
        }
        for m in &self.mappings {
            let m_end = m.addr.saturating_add(m.len);
            // Check overlap: [addr, end) vs [m.addr, m_end)
            if addr < m_end && end > m.addr {
                return false;
            }
        }
        true
    }

    pub fn reserve_host_region(&mut self, len: usize) -> usize {
        if len == 0 {
            return wasm_posix_shared::mmap::MAP_FAILED;
        }
        let aligned_len = match len.checked_add(0xFFFF) {
            Some(v) => v & !0xFFFF,
            None => return wasm_posix_shared::mmap::MAP_FAILED,
        };
        let Some(addr) = self.find_gap(aligned_len) else {
            return wasm_posix_shared::mmap::MAP_FAILED;
        };
        let pos = self.reserved_regions.partition_point(|r| r.addr < addr);
        self.reserved_regions.insert(
            pos,
            ReservedRegion {
                addr,
                len: aligned_len,
            },
        );
        addr
    }

    pub fn reserve_host_region_at(&mut self, addr: usize, len: usize) -> usize {
        if len == 0 || addr & 0xFFFF != 0 {
            return wasm_posix_shared::mmap::MAP_FAILED;
        }
        let aligned_len = match len.checked_add(0xFFFF) {
            Some(v) => v & !0xFFFF,
            None => return wasm_posix_shared::mmap::MAP_FAILED,
        };
        let end = match addr.checked_add(aligned_len) {
            Some(v) => v,
            None => return wasm_posix_shared::mmap::MAP_FAILED,
        };
        if end > self.max_addr
            || self.overlaps_reserved_prefix(addr, aligned_len)
            || self.overlaps_host_control(addr, aligned_len)
            || self.overlaps_mappings(addr, aligned_len)
            || self.overlaps_reserved_regions(addr, aligned_len)
            || (self.reserved_until != 0 && self.overlaps_brk_heap(addr, aligned_len))
        {
            return wasm_posix_shared::mmap::MAP_FAILED;
        }

        let pos = self.reserved_regions.partition_point(|r| r.addr < addr);
        self.reserved_regions.insert(
            pos,
            ReservedRegion {
                addr,
                len: aligned_len,
            },
        );
        addr
    }

    /// Lower the upper bound for mmap allocation.
    /// Used by the host to cap allocations below the channel/TLS region.
    /// Only lowers the ceiling — never raises it — so that pre-computed safe
    /// values (accounting for all future thread allocations) are preserved.
    pub fn set_max_addr(&mut self, addr: usize) {
        if addr < self.max_addr {
            self.max_addr = addr;
        }
    }

    /// Set the lower bound for automatic mmap allocation.
    ///
    /// Compact process memories place host control pages immediately after the
    /// linker-owned data and start both brk and mmap after that prefix. Calling
    /// this opts the process into protecting the prefix below `initial_brk`.
    pub fn set_mmap_base(&mut self, addr: usize) {
        self.mmap_base = Self::align_page_up(addr).max(self.initial_brk);
        self.reserved_until = self.reserved_until.max(self.initial_brk);
    }

    /// Lower the upper bound for brk allocation.
    pub fn set_brk_limit(&mut self, addr: usize) {
        if addr < self.brk_limit {
            self.brk_limit = addr;
        }
    }

    pub fn layout_metadata(&self) -> MemoryLayoutMetadata {
        MemoryLayoutMetadata {
            initial_brk: self.initial_brk,
            max_addr: self.max_addr,
            brk_limit: self.brk_limit,
            mmap_base: self.mmap_base,
            reserved_until: self.reserved_until,
        }
    }

    pub fn set_layout_metadata(&mut self, metadata: MemoryLayoutMetadata) {
        self.initial_brk = metadata.initial_brk;
        self.max_addr = metadata.max_addr;
        self.brk_limit = metadata.brk_limit;
        self.mmap_base = metadata.mmap_base;
        self.reserved_until = metadata.reserved_until;
    }

    fn align_page_up(addr: usize) -> usize {
        addr.saturating_add(0xFFFF) & !0xFFFF
    }

    /// Extend an existing mapping at `addr` from `old_len` to `new_len`.
    /// The caller must ensure the space is free (via `can_grow_at`).
    pub fn extend_mapping(&mut self, addr: usize, old_len: usize, new_len: usize) {
        for m in &mut self.mappings {
            if m.addr == addr && m.len == old_len {
                m.len = new_len;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::mmap::*;

    fn mapped_region(addr: usize, len: usize) -> MappedRegion {
        MappedRegion {
            addr,
            len,
            prot: PROT_READ | PROT_WRITE,
            flags: MAP_PRIVATE | MAP_ANONYMOUS,
        }
    }

    /// Reference the former combined-list implementation so the stream merge
    /// is checked against the exact first-fit policy it replaces.
    fn reference_find_gap(mm: &MemoryManager, needed: usize) -> Option<usize> {
        let mut cursor = mm.mmap_base.max(mm.program_break);
        let mut occupied = Vec::with_capacity(mm.mappings.len() + mm.reserved_regions.len());
        occupied.extend(mm.mappings.iter().map(|mapping| (mapping.addr, mapping.len)));
        occupied.extend(
            mm.reserved_regions
                .iter()
                .map(|reserved| (reserved.addr, reserved.len)),
        );
        occupied.sort_by_key(|(addr, _)| *addr);

        for (addr, len) in occupied {
            if addr < cursor {
                cursor = cursor.max(addr.saturating_add(len));
                continue;
            }
            if addr - cursor >= needed {
                return Some(cursor);
            }
            cursor = cursor.max(addr.saturating_add(len));
        }

        (cursor.saturating_add(needed) <= mm.max_addr).then_some(cursor)
    }

    #[test]
    fn test_mmap_anonymous() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_ne!(addr, MAP_FAILED);
        assert!(mm.is_mapped(addr));
    }

    #[test]
    fn test_mmap_zero_length_fails() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(0, 0, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_eq!(addr, MAP_FAILED);
    }

    #[test]
    fn test_mmap_aligns_to_page() {
        let mut mm = MemoryManager::new();
        let addr1 = mm.mmap_anonymous(0, 1, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        let addr2 = mm.mmap_anonymous(0, 1, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // Each allocation should be at least 64KB apart (Wasm page size)
        assert_eq!(addr2 - addr1, 0x10000);
    }

    #[test]
    fn test_munmap() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert!(mm.is_mapped(addr));
        // munmap with the aligned length
        assert!(mm.munmap(addr, 0x10000));
        assert!(!mm.is_mapped(addr));
    }

    #[test]
    fn test_munmap_nonexistent() {
        let mut mm = MemoryManager::new();
        assert!(!mm.munmap(0xDEAD0000, 4096));
    }

    #[test]
    fn test_munmap_front_trim() {
        let mut mm = MemoryManager::new();
        // Create a 3-page mapping
        let addr = mm.mmap_anonymous(
            0,
            0x30000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_ne!(addr, MAP_FAILED);
        // Unmap the first page
        assert!(mm.munmap(addr, 0x10000));
        // First page should no longer be mapped
        assert!(!mm.is_mapped(addr));
        // Remaining two pages should still be mapped
        assert!(mm.is_mapped(addr + 0x10000));
        assert!(mm.is_mapped(addr + 0x20000));
    }

    #[test]
    fn test_munmap_back_trim() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(
            0,
            0x30000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_ne!(addr, MAP_FAILED);
        // Unmap the last page
        assert!(mm.munmap(addr + 0x20000, 0x10000));
        assert!(mm.is_mapped(addr));
        assert!(mm.is_mapped(addr + 0x10000));
        assert!(!mm.is_mapped(addr + 0x20000));
    }

    #[test]
    fn test_munmap_middle_split() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(
            0,
            0x30000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_ne!(addr, MAP_FAILED);
        // Unmap the middle page — splits into two
        assert!(mm.munmap(addr + 0x10000, 0x10000));
        assert!(mm.is_mapped(addr));
        assert!(!mm.is_mapped(addr + 0x10000));
        assert!(mm.is_mapped(addr + 0x20000));
    }

    #[test]
    fn test_munmap_partial_then_mmap_reuses_gap() {
        let mut mm = MemoryManager::new();
        // Create a 4-page mapping
        let addr = mm.mmap_anonymous(
            0,
            0x40000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        // Unmap 2 middle pages
        mm.munmap(addr + 0x10000, 0x20000);
        // New 2-page mmap should fill the gap
        let addr2 = mm.mmap_anonymous(
            0,
            0x20000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(addr2, addr + 0x10000);
    }

    #[test]
    fn test_mmap_gap_stream_merge_matches_combined_reference() {
        let page = 0x10000;
        let base = MemoryManager::MMAP_BASE;
        let layouts = [
            // Empty address space.
            (vec![], vec![], base + 8 * page),
            // Guest and host ranges interleave with exact and undersized gaps.
            (
                vec![mapped_region(base, page), mapped_region(base + 4 * page, page)],
                vec![ReservedRegion {
                    addr: base + 2 * page,
                    len: page,
                }],
                base + 8 * page,
            ),
            // Equal starts retain the former stable-sort order, while the
            // longer overlapping reservation still advances the cursor.
            (
                vec![mapped_region(base, page)],
                vec![ReservedRegion {
                    addr: base,
                    len: 3 * page,
                }],
                base + 8 * page,
            ),
            // Occupancy beginning before mmap_base can overlap and extend
            // through later entries from the other stream.
            (
                vec![mapped_region(base - page, 3 * page)],
                vec![ReservedRegion {
                    addr: base + page,
                    len: 3 * page,
                }],
                base + 8 * page,
            ),
            // No trailing range is large enough.
            (
                vec![mapped_region(base, 2 * page)],
                vec![ReservedRegion {
                    addr: base + 2 * page,
                    len: 2 * page,
                }],
                base + 4 * page,
            ),
        ];

        for (case, (mappings, reserved_regions, max_addr)) in layouts.into_iter().enumerate() {
            let mut mm = MemoryManager::new();
            mm.max_addr = max_addr;
            mm.set_mappings(mappings);
            mm.reserved_regions = reserved_regions;
            mm.reserved_regions
                .sort_unstable_by_key(|reserved| reserved.addr);

            for needed in [page, 2 * page, 3 * page] {
                assert_eq!(
                    mm.find_gap(needed),
                    reference_find_gap(&mm, needed),
                    "layout {case}, needed {needed:#x}",
                );
            }
        }

        // Exhaust the relative ordering and overlap combinations for one
        // range from each stream, including starts below mmap_base and equal
        // starts. The table above covers multiple entries within one stream.
        for mapping_slot in 0..=5 {
            for mapping_pages in 1..=3 {
                for reserved_slot in 0..=5 {
                    for reserved_pages in 1..=3 {
                        let mut mm = MemoryManager::new();
                        mm.max_addr = base + 8 * page;
                        mm.set_mappings(vec![mapped_region(
                            base - page + mapping_slot * page,
                            mapping_pages * page,
                        )]);
                        mm.reserved_regions = vec![ReservedRegion {
                            addr: base - page + reserved_slot * page,
                            len: reserved_pages * page,
                        }];

                        for needed in [page, 2 * page, 3 * page] {
                            assert_eq!(mm.find_gap(needed), reference_find_gap(&mm, needed));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn test_set_mappings_restores_address_order() {
        let page = 0x10000;
        let base = MemoryManager::MMAP_BASE;
        let mut mm = MemoryManager::new();

        mm.set_mappings(vec![
            mapped_region(base + 2 * page, page),
            mapped_region(base, page),
        ]);

        assert_eq!(
            mm.mappings()
                .iter()
                .map(|mapping| mapping.addr)
                .collect::<Vec<_>>(),
            vec![base, base + 2 * page],
        );
        assert_eq!(mm.find_gap(page), Some(base + page));
    }

    #[test]
    fn test_mmap_non_fixed_prefers_free_address_hint() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let base = MemoryManager::MMAP_BASE;

        assert_eq!(mm.mmap_anonymous(base, 0x10000, rw, anon | MAP_FIXED), base);
        assert_eq!(
            mm.mmap_anonymous(base + 0x20000, 0x10000, rw, anon | MAP_FIXED),
            base + 0x20000
        );

        // Prefer a usable hint even though an earlier first-fit gap exists,
        // and round an unaligned hint down to the Wasm page boundary.
        assert_eq!(
            mm.mmap_anonymous(base + 0x30042, 0x10000, rw, anon),
            base + 0x30000
        );

        // An occupied hint must not replace the existing mapping.
        assert_eq!(
            mm.mmap_anonymous(base + 0x20000, 0x10000, rw, anon),
            base + 0x10000
        );
        assert!(mm.is_mapped(base + 0x20000));
    }

    #[test]
    fn test_munmap_rounds_length_up_to_wasm_page() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let addr = mm.mmap_anonymous(0, 0x20000, rw, anon);

        assert!(mm.munmap(addr, 0x10001));
        assert!(!mm.is_mapped(addr));
        assert!(!mm.is_mapped(addr + 0x10000));
        assert_eq!(mm.mmap_anonymous(0, 0x20000, rw, anon), addr);
    }

    #[test]
    fn test_brk() {
        let mut mm = MemoryManager::new();
        let initial = mm.get_brk();
        assert_eq!(initial, MemoryManager::INITIAL_BRK);

        let new_brk = mm.set_brk(initial + 4096);
        assert_eq!(new_brk, initial + 4096);
        assert_eq!(mm.get_brk(), initial + 4096);
    }

    #[test]
    fn test_brk_respects_host_control_limit() {
        let mut mm = MemoryManager::new();
        let initial = mm.get_brk();
        let limit = initial + 0x20000;
        mm.set_brk_limit(limit);

        assert_eq!(mm.set_brk(limit), limit);
        assert_eq!(mm.set_brk(limit + 1), limit);
        assert_eq!(mm.get_brk(), limit);
    }

    #[test]
    fn test_brk_cannot_shrink_below_initial_break() {
        let mut mm = MemoryManager::new();
        let initial = mm.get_brk();

        assert_eq!(mm.set_brk(initial - 1), initial);
        assert_eq!(mm.get_brk(), initial);
    }

    #[test]
    fn test_mmap_fixed_respects_host_control_limit() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        let initial = mm.get_brk();
        let limit = initial + 0x20000;
        mm.set_brk_limit(limit);

        let below_control = mm.mmap_anonymous(limit - 0x10000, 0x10000, rw, fixed_anon);
        assert_eq!(below_control, limit - 0x10000);

        let in_control = mm.mmap_anonymous(limit + 0x10000, 0x10000, rw, fixed_anon);
        assert_eq!(in_control, wasm_posix_shared::mmap::MAP_FAILED);

        let mmap_region = mm.mmap_anonymous(MemoryManager::MMAP_BASE, 0x10000, rw, fixed_anon);
        assert_eq!(mmap_region, MemoryManager::MMAP_BASE);
    }

    #[test]
    fn test_mmap_base_can_start_after_heap() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);

        let mapped = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(mapped, brk_base);
    }

    #[test]
    fn test_brk_growth_rejects_mmap_collision() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);

        let mapped = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(mapped, brk_base);
        assert_eq!(mm.set_brk(brk_base + 0x10000), brk_base);
        assert_eq!(mm.get_brk(), brk_base);
    }

    #[test]
    fn test_compact_layout_rejects_fixed_mapping_in_reserved_prefix() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);

        let protected = mm.mmap_anonymous(brk_base - 0x10000, 0x10000, rw, fixed_anon);
        assert_eq!(protected, MAP_FAILED);

        let first_guest_page = mm.mmap_anonymous(brk_base, 0x10000, rw, fixed_anon);
        assert_eq!(first_guest_page, brk_base);
    }

    #[test]
    fn test_compact_layout_rejects_fixed_mapping_in_brk_heap() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);

        assert_eq!(mm.set_brk(brk_base + 0x20000), brk_base + 0x20000);
        let mapped = mm.mmap_anonymous(brk_base + 0x10000, 0x10000, rw, fixed_anon);
        assert_eq!(mapped, MAP_FAILED);
    }

    #[test]
    fn test_brk_query() {
        let mm = MemoryManager::new();
        let brk = mm.get_brk();
        assert_eq!(brk, MemoryManager::INITIAL_BRK);
    }

    #[test]
    fn test_multiple_mmaps_non_overlapping() {
        let mut mm = MemoryManager::new();
        let addr1 = mm.mmap_anonymous(
            0,
            0x20000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        let addr2 = mm.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert!(addr2 >= addr1 + 0x20000); // Non-overlapping
        assert!(mm.is_mapped(addr1));
        assert!(mm.is_mapped(addr2));
    }

    #[test]
    fn test_mmap_fixed_at_address() {
        let mut mm = MemoryManager::new();
        let target = 0x20000000;
        let addr = mm.mmap_anonymous(
            target,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(addr, target);
        assert!(mm.is_mapped(target));
    }

    #[test]
    fn test_mmap_fixed_replaces_existing() {
        let mut mm = MemoryManager::new();
        let target = 0x20000000;
        // First mapping
        let addr1 = mm.mmap_anonymous(
            target,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(addr1, target);
        // Second mapping at same address replaces it
        let addr2 = mm.mmap_anonymous(
            target,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(addr2, target);
        assert!(mm.is_mapped(target));
    }

    #[test]
    fn test_mmap_fails_at_address_space_limit() {
        let mut mm = MemoryManager::new();
        // Set a small max so we can fill it quickly
        mm.max_addr = MemoryManager::MMAP_BASE + 0x30000; // 3 pages
        let addr1 = mm.mmap_anonymous(0, 0x10000, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_ne!(addr1, MAP_FAILED);
        let addr2 = mm.mmap_anonymous(0, 0x10000, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_ne!(addr2, MAP_FAILED);
        let addr3 = mm.mmap_anonymous(0, 0x10000, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_ne!(addr3, MAP_FAILED);
        // Fourth page should fail — no space left
        let addr4 = mm.mmap_anonymous(0, 0x10000, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_eq!(addr4, MAP_FAILED);
    }

    #[test]
    fn test_brk_respects_data_limit() {
        let mut mm = MemoryManager::new();
        let initial = mm.get_brk();
        // Set data limit to 4096 bytes
        mm.set_data_limit(4096);
        // Growing within limit should succeed
        let new_brk = mm.set_brk(initial + 4096);
        assert_eq!(new_brk, initial + 4096);
        // Growing beyond limit should fail (return current break)
        let failed = mm.set_brk(initial + 4097);
        assert_eq!(failed, initial + 4096); // unchanged
    }

    #[test]
    fn test_brk_zero_data_limit() {
        let mut mm = MemoryManager::new();
        let initial = mm.get_brk();
        mm.set_data_limit(0);
        // Any growth beyond initial_brk should fail
        let result = mm.set_brk(initial + 1);
        assert_eq!(result, initial); // unchanged
    }

    /// Helper to check that no mappings overlap.
    fn assert_no_overlaps(mm: &MemoryManager) {
        for i in 0..mm.mappings.len() {
            let a = &mm.mappings[i];
            let a_end = a.addr + a.len;
            for j in (i + 1)..mm.mappings.len() {
                let b = &mm.mappings[j];
                let b_end = b.addr + b.len;
                assert!(
                    a_end <= b.addr || b_end <= a.addr,
                    "OVERLAP: [{:#x}, {:#x}) and [{:#x}, {:#x})",
                    a.addr,
                    a_end,
                    b.addr,
                    b_end
                );
            }
        }
    }

    #[test]
    fn test_wordpress_mmap_sequence() {
        // Reproduce the exact mmap/munmap sequence from WordPress boot log.
        // All addresses are relative to MMAP_BASE (B).
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        let b = MemoryManager::MMAP_BASE;

        // brk operations
        mm.set_brk(0x1020000);

        // Guard page (MAP_FIXED at brk region — below MMAP_BASE)
        let a = mm.mmap_anonymous(0x1000000, 0x10000, 0, fixed_anon);
        assert_eq!(a, 0x1000000);

        // First anonymous mmap
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b, "first mmap at MMAP_BASE");
        assert_no_overlaps(&mm);

        // 2MB alloc then free
        let a = mm.mmap_anonymous(0, 0x200000, rw, anon);
        assert_eq!(a, b + 0x10000);
        mm.munmap(b + 0x10000, 0x200000);
        assert_no_overlaps(&mm);

        // 4MB alloc then partial unmaps (musl pattern)
        let a = mm.mmap_anonymous(0, 0x3ff000, rw, anon);
        assert_eq!(a, b + 0x10000);
        mm.munmap(b + 0x10000, 0x1f0000); // front trim
        mm.munmap(b + 0x400000, 0xf000); // back trim
        assert_no_overlaps(&mm);

        // Fill in gap allocations
        let a = mm.mmap_anonymous(0, 0x30000, rw, anon);
        assert_eq!(a, b + 0x10000);
        let a = mm.mmap_anonymous(0, 0x20000, rw, anon);
        assert_eq!(a, b + 0x40000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x60000);
        assert_no_overlaps(&mm);

        // More allocations
        let a = mm.mmap_anonymous(0, 0x60000, rw, anon);
        assert_eq!(a, b + 0x70000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0xd0000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0xe0000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0xf0000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x100000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x110000);
        assert_no_overlaps(&mm);

        // Large unaligned alloc (0x20014 → aligns to 0x30000)
        let a = mm.mmap_anonymous(0, 0x20014, rw, anon);
        assert_eq!(a, b + 0x120000);

        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x150000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x160000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x170000);
        assert_no_overlaps(&mm);

        // munmap/mmap cycle
        mm.munmap(b + 0x170000, 0x10000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x170000);
        mm.munmap(b + 0x170000, 0x10000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x170000);
        assert_no_overlaps(&mm);

        // More allocations
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x180000);
        let a = mm.mmap_anonymous(0, 0x20000, rw, anon);
        assert_eq!(a, b + 0x190000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x1b0000);

        // munmap then reallocate
        mm.munmap(b + 0x150000, 0x10000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x150000);
        assert_no_overlaps(&mm);

        let a = mm.mmap_anonymous(0, 0x20000, rw, anon);
        assert_eq!(a, b + 0x1c0000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x1e0000);
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x1f0000);
        assert_no_overlaps(&mm);

        // WPS:110 — another musl mmap pattern
        let a = mm.mmap_anonymous(0, 0x200000, rw, anon);
        mm.munmap(a, 0x200000);
        let a2 = mm.mmap_anonymous(0, 0x3f0000, rw, anon);
        mm.munmap(a2, 0x1f0000);
        let _a3 = mm.mmap_anonymous(0, 0x200000, rw, anon);
        assert_no_overlaps(&mm);

        // WPS:133
        let _a4 = mm.mmap_anonymous(0, 0x40000, rw, anon);
        let _a5 = mm.mmap_anonymous(0, 0x40000, rw, anon);
        assert_no_overlaps(&mm);

        // After SHORTINIT — another musl pattern
        let a6 = mm.mmap_anonymous(0, 0x200000, rw, anon);
        mm.munmap(a6, 0x200000);
        assert_no_overlaps(&mm);

        // THE PROBLEMATIC MMAP — should NOT return MMAP_BASE
        let problematic = mm.mmap_anonymous(0, 0x200000, rw, anon);
        assert_ne!(
            problematic, b,
            "mmap returned MMAP_BASE which overlaps with existing mapping!"
        );
        assert_no_overlaps(&mm);

        // Verify the original mapping at MMAP_BASE is still there
        assert!(mm.is_mapped(b), "mapping at MMAP_BASE should still exist");
    }

    #[test]
    fn test_can_grow_at() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let addr = mm.mmap_anonymous(0, 0x10000, rw, anon);
        // Right after the mapping should be free
        assert!(mm.can_grow_at(addr + 0x10000, 0x10000));
        // Allocate next page — gap is gone
        let addr2 = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(addr2, addr + 0x10000);
        assert!(!mm.can_grow_at(addr + 0x10000, 0x10000));
    }

    #[test]
    fn test_extend_mapping() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let addr = mm.mmap_anonymous(0, 0x10000, rw, anon);
        mm.extend_mapping(addr, 0x10000, 0x20000);
        assert!(mm.is_mapped(addr + 0x10000)); // extended area is now mapped
    }

    #[test]
    fn test_host_reserved_region_blocks_mmap_and_reuses_next_gap() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let fixed_anon = MAP_FIXED | anon;

        let reserved = mm.reserve_host_region(0x10000);
        assert_ne!(reserved, MAP_FAILED);
        assert!(mm.overlaps_host_reserved_region(reserved, 0x10000));

        let fixed = mm.mmap_anonymous(reserved, 0x10000, rw, fixed_anon);
        assert_eq!(fixed, MAP_FAILED);

        let mapped = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(mapped, reserved + 0x10000);
    }

    #[test]
    fn test_host_reserved_region_at_keeps_exact_fork_caller_slot() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let fixed_anon = MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED;
        let slot_addr = MemoryManager::MMAP_BASE;

        let reserved = mm.reserve_host_region_at(slot_addr, 0x40000);
        assert_eq!(reserved, slot_addr);
        assert_eq!(
            mm.reserved_regions(),
            &[ReservedRegion {
                addr: slot_addr,
                len: 0x40000,
            }]
        );

        let fixed = mm.mmap_anonymous(slot_addr, 0x10000, rw, fixed_anon);
        assert_eq!(fixed, MAP_FAILED);

        let next = mm.reserve_host_region(0x40000);
        assert_eq!(next, slot_addr + 0x40000);
    }

    #[test]
    fn test_host_reserved_region_at_rejects_guest_owned_ranges() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);
        assert_eq!(mm.set_brk(brk_base + 0x20000), brk_base + 0x20000);

        assert_eq!(
            mm.reserve_host_region_at(brk_base + 0x10000, 0x10000),
            MAP_FAILED,
        );

        let mapped = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_ne!(mapped, MAP_FAILED);
        assert_eq!(mm.reserve_host_region_at(mapped, 0x10000), MAP_FAILED);
        assert_eq!(mm.reserve_host_region_at(mapped + 1, 0x10000), MAP_FAILED);
    }

    #[test]
    fn test_host_reserved_region_blocks_brk_growth() {
        let mut mm = MemoryManager::new();
        let brk_base = 0x00200000;
        mm.set_brk_base(brk_base);
        mm.set_mmap_base(brk_base);

        let reserved = mm.reserve_host_region(0x10000);
        assert_eq!(reserved, brk_base);

        let result = mm.set_brk(brk_base + 0x10000);
        assert_eq!(result, brk_base);
        assert_eq!(mm.get_brk(), brk_base);
    }

    #[test]
    fn test_host_reserved_region_blocks_mapping_growth() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;

        let mapped = mm.mmap_anonymous(0, 0x10000, rw, anon);
        let reserved = mm.reserve_host_region(0x10000);
        assert_eq!(reserved, mapped + 0x10000);

        assert!(!mm.can_grow_at(mapped + 0x10000, 0x10000));
    }
}
