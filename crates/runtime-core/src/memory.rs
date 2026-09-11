extern crate alloc;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

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

        let mut i = 0;
        while i < self.mappings.len() {
            let m_addr = self.mappings[i].addr;
            let m_len = self.mappings[i].len;
            let m_end = m_addr.saturating_add(m_len);

            if m_end <= addr {
                i += 1;
                continue;
            }
            if m_addr >= unmap_end {
                break;
            }

            found = true;

            let has_left = m_addr < addr;
            let has_right = m_end > unmap_end;

            match (has_left, has_right) {
                (false, false) => {
                    self.mappings.remove(i);
                }
                (true, false) => {
                    self.mappings[i].len = addr - m_addr;
                    i += 1;
                }
                (false, true) => {
                    self.mappings[i].addr = unmap_end;
                    self.mappings[i].len = m_end - unmap_end;
                    break;
                }
                (true, true) => {
                    let right = MappedRegion {
                        addr: unmap_end,
                        len: m_end - unmap_end,
                        prot: self.mappings[i].prot,
                        flags: self.mappings[i].flags,
                    };
                    self.mappings[i].len = addr - m_addr;
                    self.mappings.insert(i + 1, right);
                    break;
                }
            }
        }

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

    /// Release a reservation previously made by [`Self::reserve_host_region`]
    /// or [`Self::reserve_host_region_at`], returning the range to the free
    /// address space this manager hands out.
    ///
    /// `addr` and `len` must name the reservation exactly as it was made (the
    /// length is page-rounded the same way, so a caller may pass either the
    /// requested or the rounded length). Returns `false` when no such
    /// reservation exists, which is a caller error rather than a resource
    /// condition: releasing a range twice, or releasing one this manager never
    /// issued, would otherwise silently hand out address space that is still
    /// in use.
    ///
    /// Nothing is unmapped by this call. A reservation is address-space
    /// bookkeeping, not a mapping; the bytes stay exactly as the host left
    /// them, and the next reservation or `mmap` that lands here is responsible
    /// for its own initialization.
    pub fn release_host_region(&mut self, addr: usize, len: usize) -> bool {
        if len == 0 {
            return false;
        }
        let Some(aligned_len) = len.checked_add(0xFFFF).map(|v| v & !0xFFFF) else {
            return false;
        };
        let pos = self
            .reserved_regions
            .iter()
            .position(|r| r.addr == addr && r.len == aligned_len);
        match pos {
            Some(index) => {
                self.reserved_regions.remove(index);
                true
            }
            None => false,
        }
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
    /// The caller must ensure the space is free (via `can_grow_at`). Returns
    /// whether an exact mapping was found and updated.
    pub fn extend_mapping(&mut self, addr: usize, old_len: usize, new_len: usize) -> bool {
        for m in &mut self.mappings {
            if m.addr == addr && m.len == old_len {
                m.len = new_len;
                return true;
            }
        }
        false
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
    fn test_munmap_does_not_rebuild_mapping_vec_for_middle_removal() {
        let mut mm = MemoryManager::new();
        mm.mappings.reserve(16);
        let first = mm.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        let second = mm.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        let third = mm.mmap_anonymous(
            0,
            0x10000,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        let capacity_before = mm.mappings.capacity();

        assert!(mm.munmap(second, 0x10000));

        assert_eq!(mm.mappings.capacity(), capacity_before);
        assert_eq!(mm.mappings.len(), 2);
        assert_eq!(mm.mappings[0].addr, first);
        assert_eq!(mm.mappings[1].addr, third);
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
        assert!(mm.extend_mapping(addr, 0x10000, 0x20000));
        assert!(mm.is_mapped(addr + 0x10000)); // extended area is now mapped
    }

    #[test]
    fn test_extend_mapping_reports_mismatched_metadata() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;
        let addr = mm.mmap_anonymous(0, 0x10000, rw, anon);

        assert!(!mm.extend_mapping(addr, 0x20000, 0x30000));
        assert_eq!(mm.mappings()[0].len, 0x10000);
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

// ---------------------------------------------------------------------------
// Shared-mapping page cache and coherence protocol
// ---------------------------------------------------------------------------
//
// POSIX `MAP_SHARED` semantics for a platform where every process owns a
// *distinct* linear memory. A store performed by one pid is not visible in a
// peer's memory, so shared mappings are kept coherent by an explicit
// publish/refresh protocol run at syscall boundaries:
//
//   1. **publish** — diff the mapping's bytes in the process against the
//      per-mapping `snapshot` and merge only the changed byte *runs* into the
//      authoritative backing, bumping the backing `version`;
//   2. **refresh** — when the mapping has not seen the backing's current
//      version, read the authoritative range back, store it into the process,
//      and advance `snapshot`/`seen_version` together.
//
// Merging runs rather than whole ranges is what lets two processes write
// disjoint parts of the same shared object without clobbering each other.
//
// BOUNDARY (not closed by this module): coherence is boundary-synchronous, not
// immediate. A store in one pid becomes visible to a peer at the next
// synchronization point, not at the instant of the store. That is an
// architectural limit of one-linear-memory-per-process — a peer's shared buffer
// cannot be addressed and `futex` cannot target it — and moving ownership of
// this table into Rust does not address it. See `docs/future-improvements.md`.
//
// Reentrancy: the TypeScript implementation this replaces had to re-verify,
// after every host call, that the backing it staged bytes for was still the
// same object registered under the same key, because a host callback could
// re-enter the worker and mutate the table mid-operation. Rust's `&mut`
// borrows make that class of interleaving unrepresentable, so those checks are
// absent here by construction rather than by omission.

/// Page granularity of the file-backing cache.
pub const FILE_PAGE_SIZE: usize = 4096;

/// `st_mode` file-type mask and the regular-file type.
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

/// Cap on writeback-loss diagnostics: bounded so a pathological guest cannot
/// flood the log, never zero so the loss is never silent.
pub const WRITEBACK_LOSS_REPORT_LIMIT: u32 = 50;

/// The subset of `struct stat` the mapping layer needs, plus the concrete host
/// handle when the file is host-backed. `host_handle == None` marks a
/// kernel-owned file (in-kernel tmpfs / memfd): it has no persistent host
/// descriptor, so it cannot anchor a host byte-store backing and instead uses
/// the fd-writeback bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedMappingStat {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mode: u32,
    pub host_handle: Option<i64>,
}

impl SharedMappingStat {
    pub fn is_regular_file(&self) -> bool {
        (self.mode & S_IFMT) == S_IFREG
    }
}

/// Capabilities the mapping table needs from its environment.
///
/// Only five of these cross to the host, and all five are existing kernel
/// imports: `read_process`/`write_process` (`host_proc_read_bytes` /
/// `host_proc_write_bytes`), `pread`/`pwrite` (`host_pread`/`host_pwrite`) and
/// `fstat_handle` (`host_fstat`). The rest — guest-fd stat/pwrite/close, SysV
/// segment access, handle retain/release, diagnostics — are in-kernel
/// operations the kernel already owns; they appear here as trait methods only
/// so the protocol is unit-testable without a kernel instance.
pub trait SharedMappingIo {
    /// Copy `dst.len()` bytes out of process `pid`'s linear memory at `addr`.
    fn read_process(&mut self, pid: u32, addr: u64, dst: &mut [u8]) -> Result<(), Errno>;
    /// Copy `src` into process `pid`'s linear memory at `addr`.
    fn write_process(&mut self, pid: u32, addr: u64, src: &[u8]) -> Result<(), Errno>;
    /// Current size of process `pid`'s linear memory, or `None` if it is gone.
    fn process_memory_len(&mut self, pid: u32) -> Option<u64>;

    /// Positional read from a stable host handle. Returns bytes read; a return
    /// of 0 for a non-empty request is a short read and is an error to the
    /// caller, because zero-filling would manufacture data.
    fn pread(&mut self, handle: i64, offset: u64, dst: &mut [u8]) -> Result<usize, Errno>;
    /// Positional write to a stable host handle. Returns bytes written.
    fn pwrite(&mut self, handle: i64, offset: u64, src: &[u8]) -> Result<usize, Errno>;
    /// `fstat` a stable host handle.
    fn fstat_handle(&mut self, handle: i64) -> Result<SharedMappingStat, Errno>;
    /// Backend-qualified identity for a handle, derived from the live handle
    /// and never from a pathname. `None` means the backend cannot name the
    /// object stably, which makes it ineligible for a shared backing.
    fn handle_identity(&mut self, handle: i64, dev: u64, ino: u64) -> Option<String>;
    /// Keep a host handle alive for as long as a backing references it.
    fn retain_handle(&mut self, handle: i64) -> Result<(), Errno>;
    fn release_handle(&mut self, handle: i64);

    /// `fstat` a *guest* descriptor of process `pid` (fd-writeback bridge).
    fn fd_stat(&mut self, pid: u32, fd: i32) -> Result<SharedMappingStat, Errno>;
    /// Positional write through a *guest* descriptor of process `pid`.
    fn fd_pwrite(&mut self, pid: u32, fd: i32, offset: u64, src: &[u8]) -> Result<usize, Errno>;
    /// Close a writeback dup. Best-effort: a failure must not abort teardown.
    fn close_fd(&mut self, pid: u32, fd: i32);

    /// Read from a SysV shared-memory segment the kernel owns.
    fn shm_read(&mut self, seg_id: i32, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;
    /// Write into a SysV shared-memory segment the kernel owns.
    fn shm_write(&mut self, seg_id: i32, offset: u64, src: &[u8]) -> Result<(), Errno>;

    /// Report a refused or failed writeback so the loss is never silent.
    fn report_writeback_loss(&mut self, pid: u32, map_addr: u64, reason: &str);
}

/// The kernel's own SysV attachment accounting, as the inheritance
/// transaction needs to drive it.
///
/// This is deliberately not part of [`SharedMappingIo`]: none of it is I/O.
/// These are `IpcTable` and per-process records the kernel already owns, and
/// they appear as a trait only so
/// [`SharedMappingTable::inherit_sysv_attachments`] and its rollback can be
/// tested without a kernel instance.
pub trait SysvAttachmentOps {
    /// Attach `pid` to `seg_id`, returning the segment's size.
    fn attach(&mut self, pid: u32, seg_id: i32, read_only: bool) -> Result<usize, Errno>;
    /// Record a materialized attachment address for `pid`.
    fn record(&mut self, pid: u32, addr: u64, seg_id: i32, size: usize) -> Result<(), Errno>;
    /// Release an attachment that has no address record yet, by segment
    /// identity. Best-effort: it runs while a failure is already unwinding.
    fn detach_segment(&mut self, pid: u32, seg_id: i32);
    /// Release a recorded attachment at an exact address.
    fn detach_addr(&mut self, pid: u32, addr: u64) -> Result<(), Errno>;
}

/// Which authoritative store a mapping publishes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackingKind {
    /// Host-owned byte store for an anonymous `MAP_SHARED` region.
    Anonymous,
    /// Page-cached regular file behind a stable host handle.
    File,
}

/// Page cache for one shared regular-file object, keyed by backend identity.
///
/// `pages` holds whole `FILE_PAGE_SIZE` pages; `dirty_pages` records which of
/// them hold bytes not yet written back through `handle`. `version` is bumped
/// once per publication so observers can tell whether their `snapshot` is
/// current without re-reading the file.
#[derive(Debug)]
pub struct FileBacking {
    pub key: String,
    pub handle: i64,
    /// Whether `handle` is an `O_RDWR` description, i.e. whether writeback is
    /// possible at all. Derived from the fd's *lifetime capability*, not its
    /// initial protection, so a later `PROT_WRITE` upgrade is representable
    /// after the fd and pathname are gone.
    pub writable: bool,
    /// Authoritative file size from the stable handle's `fstat`.
    pub size: u64,
    pub size_valid: bool,
    pages: BTreeMap<u64, Vec<u8>>,
    dirty_pages: BTreeSet<u64>,
    pub ref_count: u32,
    pub version: u64,
}

/// Host-owned byte store for an anonymous `MAP_SHARED` region.
#[derive(Debug)]
pub struct AnonymousBacking {
    pub key: String,
    pub bytes: Vec<u8>,
    pub ref_count: u32,
    pub version: u64,
}

/// One tracked `MAP_SHARED` interval of one process.
#[derive(Debug, Clone)]
pub struct SharedMapping {
    pub fd: i32,
    /// Offset into the backing object (file offset, or offset into the
    /// anonymous byte store).
    pub file_offset: u64,
    pub len: usize,
    pub writable: bool,
    /// Whether the originating description permits a later `PROT_WRITE`
    /// upgrade.
    pub write_allowed: bool,
    pub backing_kind: Option<BackingKind>,
    pub backing_key: Option<String>,
    /// The bytes this process last observed. Diffing against it is what lets
    /// two mappings publish disjoint writes without clobbering each other.
    pub snapshot: Option<Vec<u8>>,
    pub seen_version: u64,

    // --- fd-writeback bridge (kernel-owned tmpfs/memfd files) ---
    /// Writable `MAP_SHARED` of a kernel-owned regular file: there is no host
    /// byte store, so writeback rides `writeback_fd`.
    pub fd_writeback: bool,
    /// Stable descriptor (an `F_DUPFD_CLOEXEC` dup taken at mmap time) used for
    /// writeback, so writeback survives a guest `close(fd)` as POSIX requires.
    /// Falls back to `fd` when the dup could not be taken.
    pub writeback_fd: Option<i32>,
    /// Last observed size of the kernel-owned file; writeback is clamped to the
    /// live size so a whole-page mapping never grows the file past EOF.
    pub file_size: u64,
    /// Identity the writeback descriptor must still refer to at flush time.
    /// Because `writeback_fd` is a guest-visible number, a `closefrom`/`dup2`
    /// can close or repoint it; verifying `(dev, ino)` stops this mapping's
    /// bytes from being written into an unrelated file.
    pub expected_dev: Option<u64>,
    pub expected_ino: Option<u64>,
}

impl SharedMapping {
    /// A tracked anonymous `MAP_SHARED` interval.
    pub fn anonymous(len: usize, writable: bool, key: String, snapshot: Vec<u8>) -> Self {
        Self {
            fd: -1,
            file_offset: 0,
            len,
            writable,
            write_allowed: false,
            backing_kind: Some(BackingKind::Anonymous),
            backing_key: Some(key),
            snapshot: Some(snapshot),
            seen_version: 0,
            fd_writeback: false,
            writeback_fd: None,
            file_size: 0,
            expected_dev: None,
            expected_ino: None,
        }
    }

    /// A tracked file `MAP_SHARED` interval over a host-backed page cache.
    pub fn file(
        fd: i32,
        file_offset: u64,
        len: usize,
        writable: bool,
        write_allowed: bool,
        key: String,
        snapshot: Vec<u8>,
        seen_version: u64,
    ) -> Self {
        Self {
            fd,
            file_offset,
            len,
            writable,
            write_allowed,
            backing_kind: Some(BackingKind::File),
            backing_key: Some(key),
            snapshot: Some(snapshot),
            seen_version,
            fd_writeback: false,
            writeback_fd: None,
            file_size: 0,
            expected_dev: None,
            expected_ino: None,
        }
    }

    /// A writable `MAP_SHARED` of a kernel-owned (tmpfs/memfd) regular file.
    /// It has no host byte store; writeback rides `writeback_fd`.
    pub fn fd_writeback(
        fd: i32,
        file_offset: u64,
        len: usize,
        writeback_fd: i32,
        file_size: u64,
        dev: u64,
        ino: u64,
        snapshot: Vec<u8>,
    ) -> Self {
        Self {
            fd,
            file_offset,
            len,
            writable: true,
            write_allowed: true,
            backing_kind: None,
            backing_key: None,
            snapshot: Some(snapshot),
            seen_version: 0,
            fd_writeback: true,
            writeback_fd: Some(writeback_fd),
            file_size,
            expected_dev: Some(dev),
            expected_ino: Some(ino),
        }
    }

    /// The writeback dup this mapping *owns* and must refcount. A guest-fd
    /// fallback (`writeback_fd == fd`) is not owned and is never closed.
    fn owned_writeback_fd(&self) -> Option<i32> {
        if !self.fd_writeback {
            return None;
        }
        match self.writeback_fd {
            Some(wf) if wf != self.fd => Some(wf),
            _ => None,
        }
    }
}

/// Byte-coherence mirror for one Rust-owned SysV shared-memory attachment.
///
/// The kernel owns segment identity, lifetime and bytes; this records what a
/// given attachment last observed so the same run-merge protocol applies.
#[derive(Debug, Clone)]
pub struct SysvShmMapping {
    pub seg_id: i32,
    pub size: usize,
    pub read_only: bool,
    pub snapshot: Vec<u8>,
    pub seen_version: u64,
}

/// Yield the `[start, end)` runs where `source` differs from `snapshot`.
/// A shorter `snapshot` makes every trailing byte a difference, which is the
/// conservative direction (publish more, never less).
fn changed_runs(source: &[u8], snapshot: &[u8]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let len = source.len();
    let mut i = 0usize;
    while i < len {
        while i < len && snapshot.get(i) == Some(&source[i]) {
            i += 1;
        }
        if i >= len {
            break;
        }
        let start = i;
        loop {
            i += 1;
            if i >= len || snapshot.get(i) == Some(&source[i]) {
                break;
            }
        }
        runs.push((start, i));
    }
    runs
}

/// Merge the changed runs of `source` (relative to `snapshot`) into
/// `destination` at `destination_offset`. Returns whether anything changed.
pub fn merge_changed_byte_runs(
    source: &[u8],
    snapshot: &[u8],
    destination: &mut [u8],
    destination_offset: usize,
) -> bool {
    let mut changed = false;
    for (start, end) in changed_runs(source, snapshot) {
        destination[destination_offset + start..destination_offset + end]
            .copy_from_slice(&source[start..end]);
        changed = true;
    }
    changed
}

/// Whether any byte of `source` differs from `snapshot`.
pub fn range_differs_from_snapshot(source: &[u8], snapshot: &[u8]) -> bool {
    source != snapshot
}

impl FileBacking {
    pub fn new(key: String, handle: i64, writable: bool, size: u64) -> Self {
        Self {
            key,
            handle,
            writable,
            size,
            size_valid: true,
            pages: BTreeMap::new(),
            dirty_pages: BTreeSet::new(),
            ref_count: 0,
            version: 0,
        }
    }

    pub fn dirty_page_count(&self) -> usize {
        self.dirty_pages.len()
    }

    pub fn cached_page_count(&self) -> usize {
        self.pages.len()
    }

    /// Re-derive size and identity from the live handle. Any inconsistency
    /// invalidates the cached size rather than letting a stale size clamp a
    /// later writeback.
    pub fn revalidate(&mut self, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let handle = self.handle;
        let stat = match io.fstat_handle(handle) {
            Ok(stat) => stat,
            Err(err) => {
                self.size_valid = false;
                return Err(err);
            }
        };
        if !stat.is_regular_file() {
            self.size_valid = false;
            return Err(Errno::EIO);
        }
        match io.handle_identity(handle, stat.dev, stat.ino) {
            Some(key) if key == self.key => {}
            Some(_) => {
                self.size_valid = false;
                return Err(Errno::EIO);
            }
            None => {
                self.size_valid = false;
                return Err(Errno::ENOTSUP);
            }
        }
        self.size = stat.size;
        self.size_valid = true;
        Ok(())
    }

    /// Read one whole page. Bytes past EOF stay zero; bytes the stat declared
    /// readable must actually be read, because a short read means the file
    /// raced this snapshot and zero-filling would manufacture data.
    fn read_page(&mut self, page: u64, io: &mut dyn SharedMappingIo) -> Result<Vec<u8>, Errno> {
        if !self.size_valid {
            return Err(Errno::EIO);
        }
        let page_offset = page.saturating_mul(FILE_PAGE_SIZE as u64);
        let readable = self
            .size
            .saturating_sub(page_offset)
            .min(FILE_PAGE_SIZE as u64) as usize;
        let mut bytes = vec![0u8; FILE_PAGE_SIZE];
        let mut total = 0usize;
        while total < readable {
            let read = io.pread(
                self.handle,
                page_offset + total as u64,
                &mut bytes[total..readable],
            )?;
            if read == 0 || read > readable - total {
                return Err(Errno::EIO);
            }
            total += read;
        }
        Ok(bytes)
    }

    /// Ensure one page is resident, revalidating a doubtful size first.
    pub fn ensure_page_loaded(
        &mut self,
        page: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if self.pages.contains_key(&page) {
            return Ok(());
        }
        if !self.size_valid {
            self.revalidate(io)?;
        }
        let loaded = self.read_page(page, io)?;
        self.pages.insert(page, loaded);
        Ok(())
    }

    pub fn ensure_range_loaded(
        &mut self,
        offset: u64,
        len: usize,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if len == 0 {
            return Ok(());
        }
        let first = offset / FILE_PAGE_SIZE as u64;
        let last = (offset + len as u64 - 1) / FILE_PAGE_SIZE as u64;
        for page in first..=last {
            self.ensure_page_loaded(page, io)?;
        }
        Ok(())
    }

    /// Assemble `len` bytes of the authoritative cache starting at `offset`.
    pub fn read_range(
        &mut self,
        offset: u64,
        len: usize,
        io: &mut dyn SharedMappingIo,
    ) -> Result<Vec<u8>, Errno> {
        let mut out = vec![0u8; len];
        let mut copied = 0usize;
        while copied < len {
            let absolute = offset + copied as u64;
            let page = absolute / FILE_PAGE_SIZE as u64;
            let page_offset = (absolute % FILE_PAGE_SIZE as u64) as usize;
            let count = (FILE_PAGE_SIZE - page_offset).min(len - copied);
            self.ensure_page_loaded(page, io)?;
            let src = &self.pages[&page][page_offset..page_offset + count];
            out[copied..copied + count].copy_from_slice(src);
            copied += count;
        }
        Ok(out)
    }

    /// Copy bytes into the cache at `offset`, marking touched pages dirty.
    ///
    /// (The TypeScript original also had an `else` branch clearing the dirty
    /// bit for pages that were not already dirty — always a no-op, since it
    /// removed a page known to be absent from the set. It is not reproduced.)
    pub fn write_range(
        &mut self,
        offset: u64,
        bytes: &[u8],
        mark_dirty: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let mut copied = 0usize;
        while copied < bytes.len() {
            let absolute = offset + copied as u64;
            let page = absolute / FILE_PAGE_SIZE as u64;
            let page_offset = (absolute % FILE_PAGE_SIZE as u64) as usize;
            let count = (FILE_PAGE_SIZE - page_offset).min(bytes.len() - copied);
            self.ensure_page_loaded(page, io)?;
            let dst = self.pages.get_mut(&page).expect("page just loaded");
            dst[page_offset..page_offset + count].copy_from_slice(&bytes[copied..copied + count]);
            if mark_dirty {
                self.dirty_pages.insert(page);
            }
            copied += count;
        }
        Ok(())
    }

    /// Merge the byte runs of `source` that differ from `snapshot` into the
    /// cache at `backing_offset`, marking them dirty. Merging runs (not the
    /// whole range) is what preserves a peer's disjoint writes.
    pub fn merge_changed_runs(
        &mut self,
        source: &[u8],
        snapshot: &[u8],
        backing_offset: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<bool, Errno> {
        let mut changed = false;
        for (start, end) in changed_runs(source, snapshot) {
            self.write_range(backing_offset + start as u64, &source[start..end], true, io)?;
            changed = true;
        }
        Ok(changed)
    }

    /// Write dirty pages overlapping `[offset, offset + len)` back through the
    /// stable handle, clamped to the file's size so a mapped file is never
    /// grown past EOF. Dirty bytes lying entirely past EOF are dropped when a
    /// flush covers their page, because they are unrepresentable.
    pub fn flush_range(&mut self, offset: u64, len: u64, io: &mut dyn SharedMappingIo) -> bool {
        if len == 0 || self.dirty_pages.is_empty() {
            return true;
        }
        if !self.size_valid {
            return false;
        }
        let requested_end = offset.saturating_add(len);
        let end = requested_end.min(self.size);
        let mut success = true;
        let pages: Vec<u64> = self.dirty_pages.iter().copied().collect();
        for page in pages {
            let page_start = page.saturating_mul(FILE_PAGE_SIZE as u64);
            let page_end = page_start.saturating_add(FILE_PAGE_SIZE as u64);
            if page_start >= self.size {
                if page_start < requested_end && page_end > offset {
                    self.dirty_pages.remove(&page);
                }
                continue;
            }
            if page_start >= end || page_end <= offset {
                continue;
            }
            let write_start = offset.max(page_start);
            let valid_page_end = page_end.min(self.size);
            let write_end = end.min(valid_page_end);
            if write_end <= write_start {
                continue;
            }
            if self.ensure_page_loaded(page, io).is_err() {
                success = false;
                continue;
            }
            let lo = (write_start - page_start) as usize;
            let hi = (write_end - page_start) as usize;
            let source: Vec<u8> = self.pages[&page][lo..hi].to_vec();
            if !self.write_all(&source, write_start, io) {
                success = false;
                continue;
            }
            if write_start == page_start && write_end == valid_page_end {
                self.dirty_pages.remove(&page);
            }
        }
        success
    }

    /// Flush every dirty page, with no range restriction.
    pub fn flush_all(&mut self, io: &mut dyn SharedMappingIo) -> bool {
        self.flush_range(0, u64::MAX, io)
    }

    fn write_all(&mut self, source: &[u8], offset: u64, io: &mut dyn SharedMappingIo) -> bool {
        let mut written = 0usize;
        while written < source.len() {
            match io.pwrite(self.handle, offset + written as u64, &source[written..]) {
                Ok(count) if count > 0 && count <= source.len() - written => written += count,
                _ => return false,
            }
        }
        true
    }

    /// Drop *clean* cached pages overlapping a range so the next read re-reads
    /// the file. Dirty pages are preserved: discarding them would silently lose
    /// acknowledged `MAP_SHARED` stores.
    pub fn invalidate_range(&mut self, offset: u64, len: u64) {
        if len == 0 {
            return;
        }
        let first = offset / FILE_PAGE_SIZE as u64;
        let last = (offset.saturating_add(len) - 1) / FILE_PAGE_SIZE as u64;
        let victims: Vec<u64> = self
            .pages
            .keys()
            .copied()
            .filter(|p| *p >= first && *p <= last && !self.dirty_pages.contains(p))
            .collect();
        for page in victims {
            self.pages.remove(&page);
        }
    }

    /// Drop every clean cached page.
    pub fn invalidate_clean_pages(&mut self) {
        let victims: Vec<u64> = self
            .pages
            .keys()
            .copied()
            .filter(|p| !self.dirty_pages.contains(p))
            .collect();
        for page in victims {
            self.pages.remove(&page);
        }
    }
}

/// Every process's `MAP_SHARED` intervals, the authoritative backings behind
/// them, and the coherence protocol that keeps the two in step.
///
/// This is the kernel-owned replacement for the state behind the eleven
/// `Map`/`Set` containers the TypeScript host used to model it — but **not yet
/// for every operation over that state**. See "What this does not replace".
///
/// # Cutover status
///
/// **This table is not yet wired into production.** `host/src/kernel-worker.ts`
/// remains the live implementation; change it for behavior until the wiring
/// below lands, and keep the two in step.
///
/// The subsystem is host-driven — the host calls into the kernel around mmap,
/// munmap, msync, mremap, mprotect, fork, exec and process teardown — so making
/// it live needs host-callable `kernel_*` entry points, and
/// `crates/kernel/src/wasm_api.rs` is the only place those can be declared. The
/// alternative, hooking the guest syscalls where they are already dispatched,
/// lands in `crates/runtime-core/src/syscalls.rs`.
///
/// A production [`SharedMappingIo`] now exists (`WasmSharedMappingIo` in
/// `crates/kernel/src/wasm_api.rs`) and the table has a machine-wide singleton
/// ([`global_shared_mapping_table`]), so the remaining work is entry points
/// plus the gap below — not environment plumbing.
///
/// # What this does not replace, and why the cutover is not one item
///
/// The TypeScript subsystem is ~3,600 lines. This table corresponds to roughly
/// two thirds of it. **A third has no counterpart here**, and because it reads
/// the *same* containers, those containers cannot be deleted until it does:
///
/// | TypeScript, ~1,200 lines | status here |
/// |---|---|
/// | `handleSharedMappingsAfterFileSyscall` and its per-syscall range policy | **absent** |
/// | `flushSharedMappingsBeforeFileSyscall`, `syscallTouchesFdStorageBeforeKernel` | **absent** |
/// | `findSharedMmapBackingForFd`, `sharedMmapFdCache` and its invalidation | **absent** |
/// | `resolveSharedMmapPath`, `findSharedMmapBackingForPath`, `flushSharedBackingForPath` | **absent** — and see below |
/// | `reloadSharedMmapBacking{,ForFd,ForPath,Range}` | **absent** |
/// | `prepareSharedMmapFromFile`, `registerPreparedSharedMmap`, `registerFdWritebackSharedMmap` | **absent** |
///
/// This is a **dispatch and policy** gap, not a primitive gap. Every primitive
/// those functions need already exists here — [`FileBacking::invalidate_range`],
/// [`FileBacking::flush_range`], [`FileBacking::revalidate`],
/// [`FileBacking::ensure_range_loaded`]. What is missing is the layer that
/// decides *which* backing and *which* byte range each file syscall touches:
/// that a `write` through one fd must invalidate the overlapping pages of a
/// mapping held through another, that `O_TRUNC` on open reloads from zero, that
/// `ftruncate` clamps. That is POSIX `MAP_SHARED` fd/mapping coherence, and it
/// is required, not optional — so it cannot be dropped to finish the cutover.
///
/// The path-keyed functions deserve a design note rather than a straight port.
/// This table keys backings on **handle identity, never a pathname**
/// (see [`SharedMappingIo::handle_identity`]), which already subsumes the
/// common case the TypeScript path lookups exist for: a second fd onto the same
/// object resolves to the same `dev`/`ino` key without consulting a name. A
/// port should re-derive that policy, not translate it line by line.
///
/// # Suggested sequencing
///
/// The **SysV half is separable and complete**: `sysv`, `sysv_versions`,
/// [`SharedMappingTable::track_sysv_mapping`],
/// [`SharedMappingTable::sync_sysv_from_process`],
/// [`SharedMappingTable::sync_sysv_segment_from_attached`] and
/// [`SharedMappingTable::release_all_sysv_for_process`] cover the TypeScript
/// `shmMappings` / `shmSegmentVersions` pair with no dependency on the gap
/// above, and it is the one part with a clear performance *gain* (the mirror
/// stops pulling whole segments through `kernel_ipc_shm_*_chunk`).
///
/// One trap to design for first: `synchronizeSharedMemoryForBoundary` early-outs
/// on `sharedMappings.size === 0 && shmMappings.size === 0`. Moving only the
/// SysV half leaves the host unable to see half that predicate, and answering it
/// with a per-syscall kernel call would put a new call on the hot path. Driving
/// the sync from inside the kernel's own dispatch avoids the extra call
/// entirely, but moves where the sync happens relative to the syscall — which
/// is load-bearing, since TypeScript syncs *before* dispatch.
///
/// # What the wiring needs
///
/// Five of `SharedMappingIo`'s operations cross to the host, and **all five are
/// existing imports** — no ABI change and no new `env.host_*`:
///
/// | trait method | host import |
/// |---|---|
/// | `read_process` | `host_proc_read_bytes` |
/// | `write_process` | `host_proc_write_bytes` |
/// | `pread` | `host_pread` |
/// | `pwrite` | `host_pwrite` |
/// | `fstat_handle` | `host_fstat` |
///
/// `process_memory_len` is a sixth host-sourced value, and it is **not** an
/// import: guest memory length belongs to a `WebAssembly.Memory` the kernel has
/// no handle to, and the host grows a process's memory *after* the kernel
/// returns from `mmap`. Entry points take it as an argument, which the host
/// already holds at every boundary that drives this table. Each entry point
/// must seed every pid it can reach — an unseeded pid reads as "process gone"
/// and is skipped.
///
/// `shm_read`/`shm_write` are `ipc::IpcTable`'s segment bytes
/// (`shm_read_chunk`/`shm_write_chunk`, without the channel-sized chunking the
/// host mirror needs today).
///
/// `retain_handle`/`release_handle` and `fd_stat`/`fd_pwrite`/`close_fd` are
/// **not yet implemented** and refuse with `ENOSYS`. Retaining a handle means
/// deferring the kernel's own `host_close` until the last mapping reference
/// drops; the TypeScript equivalent is the host-side refcount
/// `retainHostFileHandle`/`releaseHostFileHandle` with its
/// `descriptorClosePending` deferral, and moving it here is part of the
/// file-backing half. The refusal is deliberate: a silent success would hand a
/// caller a handle the kernel may close underneath it.
///
/// # TypeScript this replaces
///
/// | `kernel-worker.ts` | here |
/// |---|---|
/// | `trackAnonymousSharedMapping` | [`SharedMappingTable::track_anonymous_mapping`] |
/// | `synchronizeSharedMemoryForBoundary` | [`SharedMappingTable::synchronize_for_boundary`] |
/// | `syncAnonymousSharedMappingsFromProcess` | [`SharedMappingTable::sync_anonymous_from_process`] |
/// | `syncFileSharedMappingsFromProcess` | [`SharedMappingTable::sync_file_from_process`] |
/// | `publishSharedMmapBackingObservers` | [`SharedMappingTable::publish_file_backing_observers`] |
/// | `getOrCreateSharedMmapBacking`, `revalidateSharedMmapBacking` | [`SharedMappingTable::get_or_create_file_backing`], [`FileBacking::revalidate`] |
/// | `ensureSharedMmapBacking{Range,Page}Loaded`, `readSharedMmapBacking{Page,Range}` | [`FileBacking::ensure_range_loaded`], [`FileBacking::read_range`] |
/// | `copyRangeToSharedMmapBacking`, `mergeChangedFileMappingRuns` | [`FileBacking::write_range`], [`FileBacking::merge_changed_runs`] |
/// | `flushSharedMmapBackingRange`, `writeAllToSharedMmapBacking` | [`FileBacking::flush_range`] |
/// | `invalidateSharedMmapBacking{Range,Pages}` | [`FileBacking::invalidate_range`], [`FileBacking::invalidate_clean_pages`] |
/// | `mergeChangedByteRuns`, `rangeDiffersFromSnapshot` | [`merge_changed_byte_runs`], [`range_differs_from_snapshot`] |
/// | `retain/releaseFdWritebackFd`, `flushFdWritebackMapping` | [`SharedMappingTable::flush_fd_writeback_mapping`] and the private refcount helpers |
/// | `flushSharedMappings` | [`SharedMappingTable::flush_mappings`] |
/// | `cleanupSharedMappings` | [`SharedMappingTable::cleanup_mappings`] |
/// | `remapSharedMapping` | [`SharedMappingTable::remap_mapping`] |
/// | `prepareFileSharedMappingsForWrite`, `updateSharedMappingProtection` | [`SharedMappingTable::prepare_file_mappings_for_write`], [`SharedMappingTable::update_mapping_protection`] |
/// | `inheritProcessSharedMappings` and its prepare/validate/publish trio | [`SharedMappingTable::inherit_process_mappings`] |
/// | `releaseAllSharedMemoryForProcess` | [`SharedMappingTable::release_all_for_process`] |
/// | `syncSysvShmMappingsFromProcess`, `mergeAndRefreshSysvShmMapping`, `read/writeSysvShmRange` | [`SharedMappingTable::sync_sysv_from_process`] |
///
/// # Performance
///
/// This is the syscall hot path. The shape of the cost changes in both
/// directions and **neither direction has been measured**: the TypeScript
/// implementation diffs a zero-copy view of guest memory, so a Rust owner must
/// copy each mapping's range across `host_proc_read_bytes` (one call per
/// mapping per boundary, not one per page); against that, the SysV mirror stops
/// pulling whole segments through channel-sized chunked round trips because the
/// kernel reads its own segment bytes. `docs/agent-guidance/performance.md`
/// requires before/after benchmarks on Node **and** browser before the cutover,
/// and forbids calling the result neutral without them.
///
/// Two structural facts bound *where* the copy can be paid, and a benchmark
/// that does not reach them measures nothing about this change:
///
/// 1. [`SharedMappingTable::synchronize_for_boundary`] returns immediately when
///    a process owns no shared state — the overwhelming majority of processes.
/// 2. [`SharedMappingTable::sync_anonymous_from_process`] skips a mapping whose
///    backing has `ref_count <= 1` and is not stale, exactly as the TypeScript
///    does. A mapping with no live peer is never scanned, let alone copied.
///
/// So the regression risk is confined to a process holding a large writable
/// `MAP_SHARED` **with at least one live peer**, crossing boundaries often. A
/// general syscall benchmark will exercise fact 1 and report no change; that is
/// a true result about the early-out and says nothing about the copy. Measuring
/// this honestly needs a targeted case that holds a genuinely shared mapping.
///
/// If measurement shows the copy is real, the shape that fixes it without
/// special-casing this subsystem is a third member of the existing cross-memory
/// family — a pure `compare` over bytes returning a dirty bitmap, letting the
/// kernel transfer only changed pages. It stays generic because it answers
/// "which bytes differ" and never "what should happen": this table keeps the
/// dirty-set semantics, the publish/refresh protocol and the writeback policy.
///
/// # What this does not fix
///
/// Coherence stays boundary-synchronous. Moving ownership here does not make a
/// store in one process immediately visible in a peer, and does not make
/// `futex` able to target a peer's memory. See the module comment above.
#[derive(Debug, Default)]
pub struct SharedMappingTable {
    /// pid → (mapping start address → mapping).
    mappings: BTreeMap<u32, BTreeMap<u64, SharedMapping>>,
    /// Backend identity → page-cached file object.
    file_backings: BTreeMap<String, FileBacking>,
    /// Backing key → anonymous byte store.
    anon_backings: BTreeMap<String, AnonymousBacking>,
    next_anon_id: u64,
    /// pid → (writeback dup → reference count). A single mmap owns one dup; a
    /// middle-split creates a second sub-mapping that shares it, so the dup is
    /// closed only once every sub-mapping referencing it is released.
    writeback_refs: BTreeMap<u32, BTreeMap<i32, u32>>,
    /// Guards against nested cleanup releasing one address space twice.
    releasing_pids: BTreeSet<u32>,
    /// pid → (attach address → SysV attachment mirror).
    sysv: BTreeMap<u32, BTreeMap<u64, SysvShmMapping>>,
    /// Authoritative segment version, bumped after each merged publication.
    sysv_versions: BTreeMap<i32, u64>,
    writeback_loss_reports: u32,
}

impl SharedMappingTable {
    /// Build an empty table.
    ///
    /// `const` so the machine-wide singleton below needs no lazy
    /// initialization: the kernel is single-threaded Wasm and a `static`
    /// initializer that can run at compile time keeps the table out of any
    /// first-use branch on the syscall path.
    pub const fn new() -> Self {
        Self {
            mappings: BTreeMap::new(),
            file_backings: BTreeMap::new(),
            anon_backings: BTreeMap::new(),
            next_anon_id: 1,
            writeback_refs: BTreeMap::new(),
            releasing_pids: BTreeSet::new(),
            sysv: BTreeMap::new(),
            sysv_versions: BTreeMap::new(),
            writeback_loss_reports: 0,
        }
    }

    // -- inspection -------------------------------------------------------

    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty() && self.sysv.is_empty()
    }

    pub fn has_file_backings(&self) -> bool {
        !self.file_backings.is_empty()
    }

    pub fn mapping(&self, pid: u32, addr: u64) -> Option<&SharedMapping> {
        self.mappings.get(&pid)?.get(&addr)
    }

    pub fn mappings_for(&self, pid: u32) -> impl Iterator<Item = (&u64, &SharedMapping)> {
        self.mappings.get(&pid).into_iter().flat_map(|m| m.iter())
    }

    pub fn file_backing(&self, key: &str) -> Option<&FileBacking> {
        self.file_backings.get(key)
    }

    pub fn file_backing_mut(&mut self, key: &str) -> Option<&mut FileBacking> {
        self.file_backings.get_mut(key)
    }

    pub fn anon_backing(&self, key: &str) -> Option<&AnonymousBacking> {
        self.anon_backings.get(key)
    }

    pub fn sysv_mapping(&self, pid: u32, addr: u64) -> Option<&SysvShmMapping> {
        self.sysv.get(&pid)?.get(&addr)
    }

    pub fn sysv_segment_version(&self, seg_id: i32) -> u64 {
        self.sysv_versions.get(&seg_id).copied().unwrap_or(0)
    }

    fn insert_mapping(&mut self, pid: u32, addr: u64, mapping: SharedMapping) {
        self.mappings.entry(pid).or_default().insert(addr, mapping);
    }

    // -- anonymous MAP_SHARED --------------------------------------------

    /// Track a new anonymous `MAP_SHARED` interval, seeding its host-owned byte
    /// store from the region's current contents.
    pub fn track_anonymous_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        len: usize,
        writable: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if len == 0 {
            return Ok(());
        }
        let Some(mem_len) = io.process_memory_len(pid) else {
            return Ok(());
        };
        if map_addr.saturating_add(len as u64) > mem_len {
            return Ok(());
        }
        let mut initial = vec![0u8; len];
        io.read_process(pid, map_addr, &mut initial)?;

        let key = alloc::format!("anon:{}:{}:{}", pid, map_addr, self.next_anon_id);
        self.next_anon_id += 1;
        self.anon_backings.insert(
            key.clone(),
            AnonymousBacking {
                key: key.clone(),
                bytes: initial.clone(),
                ref_count: 1,
                version: 0,
            },
        );
        self.insert_mapping(
            pid,
            map_addr,
            SharedMapping::anonymous(len, writable, key, initial),
        );
        Ok(())
    }

    /// Merge this process's anonymous `MAP_SHARED` writes into the host-owned
    /// backings, then import the complete authoritative result.
    ///
    /// `seen_version` advances only after *both* steps, so a stale process that
    /// publishes a disjoint write cannot mark unseen peer bytes as observed.
    pub fn sync_anonymous_from_process(
        &mut self,
        pid: u32,
        force: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(mem_len) = io.process_memory_len(pid) else {
            return Ok(());
        };
        let Self {
            mappings,
            anon_backings,
            ..
        } = self;
        let Some(pid_map) = mappings.get_mut(&pid) else {
            return Ok(());
        };
        for (map_addr, mapping) in pid_map.iter_mut() {
            if mapping.backing_kind != Some(BackingKind::Anonymous) {
                continue;
            }
            let Some(key) = mapping.backing_key.as_deref() else {
                continue;
            };
            if mapping.snapshot.is_none() {
                continue;
            }
            let Some(backing) = anon_backings.get_mut(key) else {
                continue;
            };
            if map_addr.saturating_add(mapping.len as u64) > mem_len {
                continue;
            }
            let base = mapping.file_offset as usize;
            if base.saturating_add(mapping.len) > backing.bytes.len() {
                continue;
            }
            let was_stale = mapping.seen_version != backing.version;
            // A sole *current* observer can defer scanning its private memory,
            // but a sole *stale* observer must still import a publication made
            // by a child or peer before that other mapping detached.
            if !force && backing.ref_count <= 1 && !was_stale {
                continue;
            }

            let snapshot = mapping.snapshot.take().expect("checked above");
            let mut current = vec![0u8; mapping.len];
            if let Err(err) = io.read_process(pid, *map_addr, &mut current) {
                mapping.snapshot = Some(snapshot);
                return Err(err);
            }

            let mut changed = false;
            if mapping.writable {
                for offset in (0..mapping.len).step_by(FILE_PAGE_SIZE) {
                    let chunk = FILE_PAGE_SIZE.min(mapping.len - offset);
                    let src = &current[offset..offset + chunk];
                    let snap = &snapshot[offset..offset + chunk];
                    if !range_differs_from_snapshot(src, snap) {
                        continue;
                    }
                    if merge_changed_byte_runs(src, snap, &mut backing.bytes, base + offset) {
                        changed = true;
                    }
                }
            }
            if changed {
                backing.version += 1;
            }

            // A publisher may itself have been stale. Always reconcile after a
            // publication rather than assigning the new version to a partial
            // view.
            if changed || was_stale {
                let latest = backing.bytes[base..base + mapping.len].to_vec();
                io.write_process(pid, *map_addr, &latest)?;
                mapping.snapshot = Some(latest);
            } else {
                mapping.snapshot = Some(snapshot);
            }
            mapping.seen_version = backing.version;
        }
        Ok(())
    }

    fn release_anonymous_reference(&mut self, key: &str) {
        let Some(backing) = self.anon_backings.get_mut(key) else {
            return;
        };
        backing.ref_count = backing.ref_count.saturating_sub(1);
        if backing.ref_count == 0 {
            self.anon_backings.remove(key);
        }
    }

    // -- file MAP_SHARED --------------------------------------------------

    /// Register (or adopt) the page-cached backing for a shared file object.
    ///
    /// An open description's access mode cannot change, so a writable source
    /// for an existing read-only backing must be a *distinct* `O_RDWR` handle
    /// for the same file; the backing adopts it and releases the old one.
    pub fn get_or_create_file_backing(
        &mut self,
        key: &str,
        stat: &SharedMappingStat,
        source_writable: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<&mut FileBacking, Errno> {
        let Some(source_handle) = stat.host_handle else {
            return Err(Errno::ENOTSUP);
        };
        if self.file_backings.contains_key(key) {
            let existing = self.file_backings.get_mut(key).expect("checked above");
            if source_writable && !existing.writable {
                if source_handle == existing.handle {
                    return Err(Errno::EIO);
                }
                io.retain_handle(source_handle)?;
                let old_handle = existing.handle;
                existing.handle = source_handle;
                existing.writable = true;
                existing.size = stat.size;
                existing.size_valid = true;
                io.release_handle(old_handle);
            } else {
                existing.revalidate(io)?;
            }
            return Ok(self.file_backings.get_mut(key).expect("checked above"));
        }

        io.retain_handle(source_handle)?;
        self.file_backings.insert(
            String::from(key),
            FileBacking::new(String::from(key), source_handle, source_writable, stat.size),
        );
        Ok(self.file_backings.get_mut(key).expect("just inserted"))
    }

    /// Drop a backing nothing references. A zero-reference backing can remain
    /// after a failed final writeback; its dirty pages and stable handle are
    /// preserved for a later mapping of the same object rather than silently
    /// discarding acknowledged `MAP_SHARED` stores.
    pub fn discard_unreferenced_file_backing(&mut self, key: &str, io: &mut dyn SharedMappingIo) {
        let Some(backing) = self.file_backings.get(key) else {
            return;
        };
        if backing.ref_count != 0 || !backing.dirty_pages.is_empty() {
            return;
        }
        let handle = backing.handle;
        self.file_backings.remove(key);
        io.release_handle(handle);
    }

    /// Drop one reference; on the last one, flush and close. A failed final
    /// flush keeps the handle and dirty cache alive, because closing here would
    /// irreversibly lose acknowledged stores.
    pub fn release_file_backing_reference(&mut self, key: &str, io: &mut dyn SharedMappingIo) {
        let Some(backing) = self.file_backings.get_mut(key) else {
            return;
        };
        backing.ref_count = backing.ref_count.saturating_sub(1);
        if backing.ref_count > 0 {
            return;
        }
        if !backing.flush_all(io) {
            return;
        }
        let handle = backing.handle;
        self.file_backings.remove(key);
        io.release_handle(handle);
    }

    /// Publish, then refresh, every file mapping of one process.
    ///
    /// Both phases run over the whole candidate set before the other begins: a
    /// one-pass publish-and-refresh loop can leave an earlier alias stale when
    /// a later alias advances the same backing during this boundary, and every
    /// refreshed range is read before *any* process memory is written so a
    /// single unreadable backing cannot leave the process partially refreshed.
    pub fn sync_file_from_process(
        &mut self,
        pid: u32,
        force: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(mem_len) = io.process_memory_len(pid) else {
            return Ok(());
        };
        let mut candidates: Vec<(u64, String)> = Vec::new();
        {
            let Some(pid_map) = self.mappings.get(&pid) else {
                return Ok(());
            };
            for (map_addr, mapping) in pid_map.iter() {
                if mapping.backing_kind != Some(BackingKind::File) {
                    continue;
                }
                let Some(key) = mapping.backing_key.as_deref() else {
                    continue;
                };
                if mapping.snapshot.is_none() {
                    continue;
                }
                let Some(backing) = self.file_backings.get(key) else {
                    continue;
                };
                if map_addr.saturating_add(mapping.len as u64) > mem_len {
                    continue;
                }
                let was_stale = mapping.seen_version != backing.version;
                if !force && backing.ref_count <= 1 && !was_stale {
                    continue;
                }
                candidates.push((*map_addr, String::from(key)));
            }
        }
        if candidates.is_empty() {
            return Ok(());
        }

        // Phase 1 — publish every alias.
        for (map_addr, key) in &candidates {
            let Self {
                mappings,
                file_backings,
                ..
            } = self;
            let Some(mapping) = mappings.get_mut(&pid).and_then(|m| m.get_mut(map_addr)) else {
                continue;
            };
            let Some(backing) = file_backings.get_mut(key) else {
                continue;
            };
            if !mapping.writable {
                continue;
            }
            let Some(snapshot) = mapping.snapshot.take() else {
                continue;
            };
            let mut current = vec![0u8; mapping.len];
            if let Err(err) = io.read_process(pid, *map_addr, &mut current) {
                mapping.snapshot = Some(snapshot);
                return Err(err);
            }
            let mut changed = false;
            let mut failure = None;
            for offset in (0..mapping.len).step_by(FILE_PAGE_SIZE) {
                let chunk = FILE_PAGE_SIZE.min(mapping.len - offset);
                let src = &current[offset..offset + chunk];
                let snap = &snapshot[offset..offset + chunk];
                if !range_differs_from_snapshot(src, snap) {
                    continue;
                }
                match backing.merge_changed_runs(
                    src,
                    snap,
                    mapping.file_offset + offset as u64,
                    io,
                ) {
                    Ok(true) => changed = true,
                    Ok(false) => {}
                    Err(err) => {
                        failure = Some(err);
                        break;
                    }
                }
            }
            mapping.snapshot = Some(snapshot);
            if changed {
                backing.version += 1;
            }
            if let Some(err) = failure {
                return Err(err);
            }
        }

        // Phase 2a — read every final snapshot before mutating process memory.
        let mut refreshes: Vec<(u64, Vec<u8>, u64)> = Vec::new();
        for (map_addr, key) in &candidates {
            let Self {
                mappings,
                file_backings,
                ..
            } = self;
            let Some(mapping) = mappings.get(&pid).and_then(|m| m.get(map_addr)) else {
                continue;
            };
            let Some(backing) = file_backings.get_mut(key) else {
                continue;
            };
            if mapping.seen_version == backing.version {
                continue;
            }
            let latest = backing.read_range(mapping.file_offset, mapping.len, io)?;
            refreshes.push((*map_addr, latest, backing.version));
        }

        // Phase 2b — apply them.
        for (map_addr, latest, version) in refreshes {
            io.write_process(pid, map_addr, &latest)?;
            if let Some(mapping) = self.mappings.get_mut(&pid).and_then(|m| m.get_mut(&map_addr)) {
                mapping.snapshot = Some(latest);
                mapping.seen_version = version;
            }
        }
        Ok(())
    }

    /// Force every current observer of a backing to publish, before another
    /// mapping joins it or an ordinary file read observes it. Without this a
    /// sole observer's deferred writes would be invisible to the newcomer.
    pub fn publish_file_backing_observers(
        &mut self,
        key: &str,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(backing) = self.file_backings.get(key) else {
            return Ok(());
        };
        if backing.ref_count == 0 {
            return Ok(());
        }
        let observers: Vec<u32> = self
            .mappings
            .iter()
            .filter(|(_, m)| {
                m.values().any(|mapping| {
                    mapping.backing_kind == Some(BackingKind::File)
                        && mapping.backing_key.as_deref() == Some(key)
                })
            })
            .map(|(pid, _)| *pid)
            .collect();
        for pid in observers {
            self.sync_file_from_process(pid, true, io)?;
        }
        Ok(())
    }

    // -- fd-writeback bridge (kernel-owned tmpfs / memfd files) -----------

    /// Record one more reference to a mapping's owned writeback dup.
    fn retain_writeback_fd(&mut self, pid: u32, mapping: &SharedMapping) {
        let Some(wf) = mapping.owned_writeback_fd() else {
            return;
        };
        let per_pid = self.writeback_refs.entry(pid).or_default();
        *per_pid.entry(wf).or_insert(0) += 1;
    }

    /// Release one reference; close the owned dup when it reaches zero.
    fn release_writeback_fd(&mut self, pid: u32, mapping: &SharedMapping, io: &mut dyn SharedMappingIo) {
        let Some(wf) = mapping.owned_writeback_fd() else {
            return;
        };
        let Some(per_pid) = self.writeback_refs.get_mut(&pid) else {
            return;
        };
        let next = per_pid.get(&wf).copied().unwrap_or(0).saturating_sub(1);
        if next > 0 {
            per_pid.insert(wf, next);
            return;
        }
        per_pid.remove(&wf);
        if per_pid.is_empty() {
            self.writeback_refs.remove(&pid);
        }
        io.close_fd(pid, wf);
    }

    fn report_writeback_loss(
        &mut self,
        pid: u32,
        map_addr: u64,
        reason: &str,
        io: &mut dyn SharedMappingIo,
    ) {
        if self.writeback_loss_reports >= WRITEBACK_LOSS_REPORT_LIMIT {
            return;
        }
        self.writeback_loss_reports += 1;
        io.report_writeback_loss(pid, map_addr, reason);
    }

    /// Flush the dirty bytes of an fd-writeback mapping back to its
    /// kernel-owned file, clamped to the file's live size so a whole-page
    /// mapping never grows the file past EOF, and writing only the byte runs
    /// this mapping changed so concurrent mappings preserve each other's
    /// disjoint updates.
    ///
    /// Returns `false` when the write cannot be performed safely. The writeback
    /// dup is a guest-*visible* descriptor number, so a `closefrom`/`close_fds`
    /// can close it and a `dup2` can repoint it at another file. In both cases
    /// the flush is REFUSED rather than blindly written: writing to a closed
    /// number is pointless and writing to a repointed one would corrupt an
    /// unrelated file. The loss is reported, never silent.
    pub fn flush_fd_writeback_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        flush_start: u64,
        flush_len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        let Some(mapping) = self.mappings.get(&pid).and_then(|m| m.get(&map_addr)) else {
            return true;
        };
        let writeback_fd = mapping.writeback_fd.unwrap_or(mapping.fd);
        let file_offset = mapping.file_offset;

        // Consult the live descriptor for both the current size (so a
        // legitimate post-mmap ftruncate-larger is honored) AND its identity.
        let live = match io.fd_stat(pid, writeback_fd) {
            Ok(stat) => stat,
            Err(_) => {
                self.report_writeback_loss(pid, map_addr, "descriptor closed", io);
                return false;
            }
        };
        let dev_mismatch = mapping.expected_dev.is_some_and(|d| d != live.dev);
        let ino_mismatch = mapping.expected_ino.is_some_and(|i| i != live.ino);
        if dev_mismatch || ino_mismatch {
            self.report_writeback_loss(
                pid,
                map_addr,
                "descriptor repointed to a different file",
                io,
            );
            return false;
        }

        let live_size = live.size;
        let mapping_offset = flush_start.saturating_sub(map_addr);
        let file_offset_base = file_offset + mapping_offset;
        {
            let mapping = self
                .mappings
                .get_mut(&pid)
                .and_then(|m| m.get_mut(&map_addr))
                .expect("checked above");
            mapping.file_size = live_size;
        }
        if file_offset_base >= live_size {
            return true; // entirely past EOF; drop.
        }
        let writable_len = flush_len.min(live_size - file_offset_base) as usize;
        if writable_len == 0 {
            return true;
        }

        let mut current = vec![0u8; writable_len];
        if io.read_process(pid, flush_start, &mut current).is_err() {
            self.report_writeback_loss(pid, map_addr, "process memory unreadable", io);
            return false;
        }

        let snapshot: Option<Vec<u8>> = {
            let mapping = self
                .mappings
                .get(&pid)
                .and_then(|m| m.get(&map_addr))
                .expect("checked above");
            mapping.snapshot.as_ref().map(|s| {
                let lo = (mapping_offset as usize).min(s.len());
                let hi = (lo + writable_len).min(s.len());
                s[lo..hi].to_vec()
            })
        };
        // With no snapshot every byte is "changed", which is the conservative
        // direction: publish more, never less.
        let snapshot_ref: &[u8] = snapshot.as_deref().unwrap_or(&[]);

        let mut success = true;
        for (start, end) in changed_runs(&current, snapshot_ref) {
            match io.fd_pwrite(
                pid,
                writeback_fd,
                file_offset_base + start as u64,
                &current[start..end],
            ) {
                Ok(count) if count == end - start => {}
                _ => {
                    self.report_writeback_loss(pid, map_addr, "write failed", io);
                    success = false;
                    break;
                }
            }
        }

        // Advance the snapshot to the bytes just published, so a later flush
        // sends only new changes and cannot re-clobber a peer's writes.
        if success {
            if let Some(mapping) = self.mappings.get_mut(&pid).and_then(|m| m.get_mut(&map_addr)) {
                if let Some(snap) = mapping.snapshot.as_mut() {
                    let lo = (mapping_offset as usize).min(snap.len());
                    let hi = (lo + writable_len).min(snap.len());
                    snap[lo..hi].copy_from_slice(&current[..hi - lo]);
                }
            }
        }
        success
    }

    // -- SysV shared-memory byte-coherence mirror -------------------------

    /// Track a new SysV attachment. The kernel owns the segment's identity,
    /// lifetime and bytes; this records what the attachment last observed.
    pub fn track_sysv_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        seg_id: i32,
        size: usize,
        read_only: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let mut snapshot = vec![0u8; size];
        io.shm_read(seg_id, 0, &mut snapshot)?;
        io.write_process(pid, map_addr, &snapshot)?;
        let seen_version = self.sysv_segment_version(seg_id);
        self.sysv.entry(pid).or_default().insert(
            map_addr,
            SysvShmMapping {
                seg_id,
                size,
                read_only,
                snapshot,
                seen_version,
            },
        );
        Ok(())
    }

    /// Whether any *other* attachment observes the same segment. A sole
    /// observer that is already current can defer scanning its private memory
    /// every boundary; see [`SharedMappingTable::sync_sysv_from_process`] for
    /// why being current is a required half of that condition.
    fn has_peer_sysv_mapping(&self, pid: u32, map_addr: u64, seg_id: i32) -> bool {
        self.sysv.iter().any(|(other_pid, mappings)| {
            mappings.iter().any(|(other_addr, mapping)| {
                mapping.seg_id == seg_id && !(*other_pid == pid && *other_addr == map_addr)
            })
        })
    }

    /// Publish this attachment's changed runs into the kernel-owned segment,
    /// then import the authoritative result. Returns whether every write
    /// succeeded; the import happens either way so the process never keeps a
    /// view that is neither its own nor the segment's.
    fn merge_and_refresh_sysv_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        let Some(mapping) = self.sysv.get(&pid).and_then(|m| m.get(&map_addr)) else {
            return true;
        };
        let seg_id = mapping.seg_id;
        let size = mapping.size;
        let read_only = mapping.read_only;
        let seen_version = mapping.seen_version;
        let current_version = self.sysv_segment_version(seg_id);

        let mut current = vec![0u8; size];
        if io.read_process(pid, map_addr, &mut current).is_err() {
            return false;
        }
        let locally_changed = {
            let mapping = self.sysv.get(&pid).and_then(|m| m.get(&map_addr)).expect("checked");
            !read_only && range_differs_from_snapshot(&current, &mapping.snapshot)
        };
        if !locally_changed && seen_version == current_version {
            return true;
        }

        let mut authoritative = vec![0u8; size];
        if io.shm_read(seg_id, 0, &mut authoritative).is_err() {
            return false;
        }

        let mut published = false;
        let mut success = true;
        if locally_changed {
            let snapshot = self
                .sysv
                .get(&pid)
                .and_then(|m| m.get(&map_addr))
                .expect("checked")
                .snapshot
                .clone();
            'outer: for offset in (0..size).step_by(FILE_PAGE_SIZE) {
                let chunk = FILE_PAGE_SIZE.min(size - offset);
                let src = &current[offset..offset + chunk];
                let snap = &snapshot[offset..offset + chunk];
                if !range_differs_from_snapshot(src, snap) {
                    continue;
                }
                for (start, end) in changed_runs(src, snap) {
                    let bytes = &src[start..end];
                    if io
                        .shm_write(seg_id, (offset + start) as u64, bytes)
                        .is_err()
                    {
                        success = false;
                        break 'outer;
                    }
                    authoritative[offset + start..offset + end].copy_from_slice(bytes);
                    published = true;
                }
            }
        }

        if published {
            self.sysv_versions.insert(seg_id, current_version + 1);
        }
        if io.write_process(pid, map_addr, &authoritative).is_err() {
            return false;
        }
        let new_version = self.sysv_segment_version(seg_id);
        if let Some(mapping) = self.sysv.get_mut(&pid).and_then(|m| m.get_mut(&map_addr)) {
            mapping.snapshot = authoritative;
            mapping.seen_version = new_version;
        }
        success
    }

    /// Reconcile every SysV attachment of one process.
    ///
    /// An attachment is skipped only when it has no live peer **and** it has
    /// already observed the segment's current version. Both halves are
    /// required, and this mirrors
    /// [`SharedMappingTable::sync_anonymous_from_process`], which has always
    /// tested both.
    ///
    /// Peer-existence alone is not sufficient, and treating it as sufficient
    /// loses a peer's writes in an ordinary IPC shape: a child attaches, fills
    /// the segment, publishes and exits, and the parent -- now the sole
    /// observer -- would never import what the child wrote. `shmdt` and
    /// process teardown publish the departing attachment's bytes, but nothing
    /// re-reads them into the survivors, so the survivor keeps a private view
    /// of a segment it does not own. POSIX makes an attachment a view of the
    /// segment, not a copy taken at attach time.
    pub fn sync_sysv_from_process(
        &mut self,
        pid: u32,
        force: bool,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        let Some(pid_map) = self.sysv.get(&pid) else {
            return true;
        };
        let targets: Vec<(u64, i32, u64)> = pid_map
            .iter()
            .map(|(addr, mapping)| (*addr, mapping.seg_id, mapping.seen_version))
            .collect();
        let mut success = true;
        for (map_addr, seg_id, seen_version) in targets {
            if !force
                && !self.has_peer_sysv_mapping(pid, map_addr, seg_id)
                && seen_version == self.sysv_segment_version(seg_id)
            {
                continue;
            }
            if !self.merge_and_refresh_sysv_mapping(pid, map_addr, io) {
                success = false;
            }
        }
        success
    }

    /// Publish every current attachment of a segment before a new observer
    /// joins it, so the newcomer starts from the latest shared state.
    pub fn sync_sysv_segment_from_attached(&mut self, seg_id: i32, io: &mut dyn SharedMappingIo) {
        let targets: Vec<(u32, u64)> = self
            .sysv
            .iter()
            .flat_map(|(pid, mappings)| {
                mappings
                    .iter()
                    .filter(|(_, m)| m.seg_id == seg_id)
                    .map(move |(addr, _)| (*pid, *addr))
            })
            .collect();
        for (pid, map_addr) in targets {
            self.merge_and_refresh_sysv_mapping(pid, map_addr, io);
        }
    }

    /// Number of processes that own at least one SysV attachment.
    ///
    /// This exists to serve the host's syscall-boundary early-out. The host
    /// used to answer "does this machine own SysV shared state" by reading
    /// `shmMappings.size` on a container it owned; with the container here it
    /// caches this count instead and refreshes it from this authority at every
    /// site that can change it. It is therefore a cached predicate, never an
    /// independently maintained mirror.
    pub fn sysv_pid_count(&self) -> usize {
        self.sysv.len()
    }

    /// Number of SysV attachments owned by one process.
    pub fn sysv_mapping_count_for(&self, pid: u32) -> usize {
        self.sysv.get(&pid).map_or(0, |m| m.len())
    }

    /// Every attachment of one process as `(map_addr, seg_id, size, read_only)`.
    ///
    /// Ordered by address, because the caller replays it into kernel-side
    /// attachment records and a rollback walks it in reverse.
    pub fn sysv_attachments_for(&self, pid: u32) -> Vec<(u64, i32, usize, bool)> {
        self.sysv
            .get(&pid)
            .map(|m| {
                m.iter()
                    .map(|(addr, mapping)| {
                        (*addr, mapping.seg_id, mapping.size, mapping.read_only)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Give a forked child its parent's SysV attachments, atomically.
    ///
    /// Two authorities have to move together: the kernel's own attachment
    /// accounting (`nattch` and the per-process address records, reached
    /// through `ops`) and this byte mirror. Each is separately fallible, so
    /// this owns the whole transaction and its rollback rather than leaving a
    /// caller to interleave them.
    ///
    /// Failure unwinds in the order the steps committed: an `attach` that
    /// returned an unusable size, or a `record` that refused, is released by
    /// segment identity because it has no address record yet; everything
    /// already recorded is released by exact address, newest first. A child
    /// therefore never keeps a partial set of attachments.
    ///
    /// `ops` is a trait rather than a direct `IpcTable` reference so this
    /// transaction is unit-testable without a kernel instance. That matters:
    /// it is the rollback path, which is the part no ordinary run exercises.
    pub fn inherit_sysv_attachments(
        &mut self,
        parent_pid: u32,
        child_pid: u32,
        ops: &mut dyn SysvAttachmentOps,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if parent_pid == child_pid {
            return Err(Errno::EINVAL);
        }
        if !self.sysv_attachments_for(child_pid).is_empty() {
            return Err(Errno::EEXIST);
        }

        let mut recorded: Vec<u64> = Vec::new();
        let mut failure: Option<Errno> = None;
        for (map_addr, seg_id, size, read_only) in self.sysv_attachments_for(parent_pid) {
            match ops.attach(child_pid, seg_id, read_only) {
                // An attachment whose size does not match the parent's record
                // still incremented nattch, so it is released before unwinding.
                Ok(attached) if attached == size => {}
                Ok(_) => {
                    ops.detach_segment(child_pid, seg_id);
                    failure = Some(Errno::EIO);
                    break;
                }
                Err(err) => {
                    failure = Some(err);
                    break;
                }
            }
            if let Err(err) = ops.record(child_pid, map_addr, seg_id, size) {
                ops.detach_segment(child_pid, seg_id);
                failure = Some(err);
                break;
            }
            recorded.push(map_addr);
        }

        if failure.is_none() {
            if let Err(err) = self.inherit_process_mappings(parent_pid, child_pid, io) {
                failure = Some(err);
            }
        }

        if let Some(err) = failure {
            for map_addr in recorded.iter().rev() {
                let _ = ops.detach_addr(child_pid, *map_addr);
            }
            return Err(err);
        }
        Ok(())
    }

    /// Reconcile exactly one attachment. Returns whether every publication
    /// succeeded; see [`SharedMappingTable::sync_sysv_from_process`].
    pub fn sync_sysv_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        self.merge_and_refresh_sysv_mapping(pid, map_addr, io)
    }

    /// Forget one attachment's byte mirror. Returns whether it was present.
    ///
    /// The kernel's own attachment record is a separate authority
    /// (`Process::shm_mappings`); dropping the mirror never detaches.
    pub fn drop_sysv_mapping(&mut self, pid: u32, map_addr: u64) -> bool {
        let Some(pid_map) = self.sysv.get_mut(&pid) else {
            return false;
        };
        let removed = pid_map.remove(&map_addr).is_some();
        if pid_map.is_empty() {
            self.sysv.remove(&pid);
        }
        removed
    }

    /// Drop every SysV attachment of a process, optionally publishing first.
    pub fn release_all_sysv_for_process(
        &mut self,
        pid: u32,
        publish: bool,
        io: &mut dyn SharedMappingIo,
    ) {
        if publish {
            self.sync_sysv_from_process(pid, true, io);
        }
        self.sysv.remove(&pid);
    }

    // -- boundary synchronization ----------------------------------------

    /// Run the full publish/refresh protocol for one process at a syscall
    /// boundary. Cheap when the process owns no shared state.
    pub fn synchronize_for_boundary(
        &mut self,
        pid: u32,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if self.is_empty() {
            return Ok(());
        }
        self.sync_anonymous_from_process(pid, false, io)?;
        self.sync_file_from_process(pid, false, io)?;
        self.sync_sysv_from_process(pid, false, io);
        Ok(())
    }

    // -- explicit publication points (msync / munmap / MAP_FIXED) ---------

    /// Flush every mapping overlapping `[sync_addr, sync_addr + sync_len)`.
    ///
    /// `msync`, `munmap` and a `MAP_FIXED` replacement are explicit
    /// publication points for anonymous mappings too, including the
    /// single-observer-before-fork case, so both syncs run forced first.
    pub fn flush_mappings(
        &mut self,
        pid: u32,
        sync_addr: u64,
        sync_len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        if self.sync_anonymous_from_process(pid, true, io).is_err() {
            return false;
        }
        if self.sync_file_from_process(pid, true, io).is_err() {
            return false;
        }
        let Some(pid_map) = self.mappings.get(&pid) else {
            return true;
        };
        if pid_map.is_empty() {
            return true;
        }
        let sync_end = sync_addr.saturating_add(sync_len);
        let targets: Vec<(u64, usize, u64, Option<BackingKind>, Option<String>, bool, bool, i32)> =
            pid_map
                .iter()
                .map(|(addr, m)| {
                    (
                        *addr,
                        m.len,
                        m.file_offset,
                        m.backing_kind,
                        m.backing_key.clone(),
                        m.writable,
                        m.fd_writeback,
                        m.fd,
                    )
                })
                .collect();

        let mut success = true;
        for (map_addr, len, file_offset, kind, key, writable, fd_writeback, fd) in targets {
            let map_end = map_addr.saturating_add(len as u64);
            if map_addr >= sync_end || map_end <= sync_addr {
                continue;
            }
            let flush_start = sync_addr.max(map_addr);
            let flush_end = sync_end.min(map_end);
            if flush_end <= flush_start {
                continue;
            }
            let flush_len = flush_end - flush_start;
            let file_offset_base = file_offset + (flush_start - map_addr);

            if kind == Some(BackingKind::File) && key.is_some() {
                match key.as_deref().and_then(|k| self.file_backings.get_mut(k)) {
                    Some(backing) => {
                        if !backing.flush_range(file_offset_base, flush_len, io) {
                            success = false;
                        }
                    }
                    // A file mapping whose backing has vanished cannot publish
                    // its bytes; report the failure rather than dropping it.
                    None => success = false,
                }
                continue;
            }
            // Anonymous mappings publish through the forced sync above; their
            // authoritative store needs no separate flush.
            if !writable || key.is_some() {
                continue;
            }
            if fd_writeback {
                if !self.flush_fd_writeback_mapping(pid, map_addr, flush_start, flush_len, io) {
                    success = false;
                }
                continue;
            }
            // Pre-page-cache tracking: write straight through the guest fd.
            let mut bytes = vec![0u8; flush_len as usize];
            if io.read_process(pid, flush_start, &mut bytes).is_err() {
                success = false;
                continue;
            }
            let mut written = 0usize;
            while written < bytes.len() {
                match io.fd_pwrite(
                    pid,
                    fd,
                    file_offset_base + written as u64,
                    &bytes[written..],
                ) {
                    Ok(count) if count > 0 && count <= bytes.len() - written => written += count,
                    _ => {
                        success = false;
                        break;
                    }
                }
            }
        }
        success
    }

    // -- address-space lifecycle ------------------------------------------

    fn release_mapping(&mut self, mapping: &SharedMapping, io: &mut dyn SharedMappingIo) {
        match (mapping.backing_kind, mapping.backing_key.as_deref()) {
            (Some(BackingKind::File), Some(key)) => {
                self.release_file_backing_reference(key, io);
            }
            (Some(BackingKind::Anonymous), Some(key)) => {
                self.release_anonymous_reference(key);
            }
            _ => {}
        }
    }

    /// Drop or trim every mapping overlapping an unmapped interval, splitting a
    /// mapping whose middle is removed.
    ///
    /// A middle split produces a second sub-mapping that shares the original's
    /// backing reference and writeback dup, so both are refcounted up: the dup
    /// is closed only after both halves are released.
    pub fn cleanup_mappings(
        &mut self,
        pid: u32,
        addr: u64,
        len: u64,
        io: &mut dyn SharedMappingIo,
    ) {
        let Some(pid_map) = self.mappings.get(&pid) else {
            return;
        };
        let unmap_end = addr.saturating_add(len);
        let entries: Vec<u64> = pid_map.keys().copied().collect();

        for map_addr in entries {
            let Some(mapping) = self.mappings.get(&pid).and_then(|m| m.get(&map_addr)) else {
                continue;
            };
            let map_end = map_addr.saturating_add(mapping.len as u64);
            let overlap_start = addr.max(map_addr);
            let overlap_end = unmap_end.min(map_end);
            if overlap_start >= overlap_end {
                continue;
            }

            // Whole mapping removed.
            if overlap_start <= map_addr && overlap_end >= map_end {
                let mapping = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.remove(&map_addr))
                    .expect("checked above");
                self.release_mapping(&mapping, io);
                self.release_writeback_fd(pid, &mapping, io);
                continue;
            }

            // Head removed: the tail slides up.
            if overlap_start <= map_addr {
                let trim = (overlap_end - map_addr) as usize;
                let mut mapping = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.remove(&map_addr))
                    .expect("checked above");
                mapping.file_offset += trim as u64;
                mapping.len = (map_end - overlap_end) as usize;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    let trim = trim.min(snapshot.len());
                    snapshot.drain(..trim);
                }
                if mapping.len > 0 {
                    self.mappings.entry(pid).or_default().insert(overlap_end, mapping);
                } else {
                    self.release_mapping(&mapping, io);
                    self.release_writeback_fd(pid, &mapping, io);
                }
                continue;
            }

            // Tail removed: the head shrinks in place.
            if overlap_end >= map_end {
                let mapping = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.get_mut(&map_addr))
                    .expect("checked above");
                mapping.len = (overlap_start - map_addr) as usize;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    snapshot.truncate(mapping.len);
                }
                continue;
            }

            // Middle removed: split into two sub-mappings.
            let left_len = (overlap_start - map_addr) as usize;
            let right_skip = (overlap_end - map_addr) as usize;
            let mut right = {
                let mapping = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.get_mut(&map_addr))
                    .expect("checked above");
                let mut right = mapping.clone();
                right.file_offset = mapping.file_offset + right_skip as u64;
                right.len = (map_end - overlap_end) as usize;
                if let Some(snapshot) = right.snapshot.as_mut() {
                    let skip = right_skip.min(snapshot.len());
                    snapshot.drain(..skip);
                }
                mapping.len = left_len;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    snapshot.truncate(left_len);
                }
                right
            };
            match (right.backing_kind, right.backing_key.as_deref()) {
                (Some(BackingKind::File), Some(key)) => {
                    if let Some(backing) = self.file_backings.get_mut(key) {
                        backing.ref_count += 1;
                    }
                }
                (Some(BackingKind::Anonymous), Some(key)) => {
                    if let Some(backing) = self.anon_backings.get_mut(key) {
                        backing.ref_count += 1;
                    }
                }
                _ => {}
            }
            self.retain_writeback_fd(pid, &right);
            self.mappings.entry(pid).or_default().insert(overlap_end, right);
        }

        if self.mappings.get(&pid).is_some_and(|m| m.is_empty()) {
            self.mappings.remove(&pid);
        }
    }

    /// Move (and possibly grow) a mapping for `mremap`, re-seeding the moved
    /// interval from the authoritative store so the new address observes the
    /// same shared object rather than stale copied bytes.
    pub fn remap_mapping(
        &mut self,
        pid: u32,
        old_addr: u64,
        new_addr: u64,
        new_len: usize,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(mut mapping) = self.mappings.get_mut(&pid).and_then(|m| m.remove(&old_addr))
        else {
            return Ok(());
        };
        if mapping.backing_key.is_some() && mapping.snapshot.is_some() {
            let key = mapping.backing_key.clone().expect("checked");
            match mapping.backing_kind {
                Some(BackingKind::File) => {
                    if let Some(backing) = self.file_backings.get_mut(&key) {
                        backing.ensure_range_loaded(mapping.file_offset, new_len, io)?;
                        let latest = backing.read_range(mapping.file_offset, new_len, io)?;
                        let version = backing.version;
                        io.write_process(pid, new_addr, &latest)?;
                        mapping.snapshot = Some(latest);
                        mapping.seen_version = version;
                    }
                }
                Some(BackingKind::Anonymous) => {
                    if let Some(backing) = self.anon_backings.get_mut(&key) {
                        let required = mapping.file_offset as usize + new_len;
                        if required > backing.bytes.len() {
                            let old_len = backing.bytes.len();
                            backing.bytes.resize(required, 0);
                            // A grow-in-place mremap exposes bytes the guest may
                            // already have written; seed them from the process
                            // rather than publishing zeros over them.
                            if new_len > mapping.len {
                                let extra = new_len - mapping.len;
                                let mut tail = vec![0u8; extra];
                                if io
                                    .read_process(pid, new_addr + mapping.len as u64, &mut tail)
                                    .is_ok()
                                {
                                    let base = mapping.file_offset as usize + mapping.len;
                                    let end = (base + extra).min(backing.bytes.len());
                                    if base < end {
                                        backing.bytes[base..end]
                                            .copy_from_slice(&tail[..end - base]);
                                    }
                                }
                            }
                            let _ = old_len;
                            backing.version += 1;
                        }
                        let base = mapping.file_offset as usize;
                        let latest = backing.bytes[base..base + new_len].to_vec();
                        let version = backing.version;
                        io.write_process(pid, new_addr, &latest)?;
                        mapping.snapshot = Some(latest);
                        mapping.seen_version = version;
                    }
                }
                None => {}
            }
        } else if let Some(snapshot) = mapping.snapshot.as_mut() {
            snapshot.truncate(new_len);
        }
        mapping.len = new_len;
        self.mappings.entry(pid).or_default().insert(new_addr, mapping);
        Ok(())
    }

    /// Validate a `PROT_WRITE` upgrade before the kernel reports `mprotect`
    /// success. A read-only file mapping may be upgraded only when the original
    /// description was a writable regular-file description; mmap preflight
    /// retains that `O_RDWR` handle even for an initially read-only mapping, so
    /// this never has to recover capability by reopening a pathname.
    pub fn prepare_file_mappings_for_write(
        &self,
        pid: u32,
        addr: u64,
        len: u64,
    ) -> Result<(), Errno> {
        if len == 0 {
            return Ok(());
        }
        let Some(pid_map) = self.mappings.get(&pid) else {
            return Ok(());
        };
        let protect_end = addr.saturating_add(len);
        for (map_addr, mapping) in pid_map.iter() {
            if mapping.backing_kind != Some(BackingKind::File) {
                continue;
            }
            let map_end = map_addr.saturating_add(mapping.len as u64);
            if map_end <= addr || *map_addr >= protect_end {
                continue;
            }
            if !mapping.write_allowed {
                return Err(Errno::EACCES);
            }
            let Some(key) = mapping.backing_key.as_deref() else {
                return Err(Errno::EIO);
            };
            let Some(backing) = self.file_backings.get(key) else {
                return Err(Errno::EIO);
            };
            if !backing.writable {
                return Err(Errno::EIO);
            }
        }
        Ok(())
    }

    /// Keep writeback eligibility aligned with a successful `mprotect` range.
    ///
    /// Eligibility is monotonic: bytes dirtied while writable still need
    /// flushing after a later read-only downgrade, so only upgrades are
    /// recorded, at mapping granularity so `mremap` still moves one coherent
    /// interval.
    pub fn update_mapping_protection(&mut self, pid: u32, addr: u64, len: u64, writable: bool) {
        if len == 0 || !writable {
            return;
        }
        let Some(pid_map) = self.mappings.get_mut(&pid) else {
            return;
        };
        let protect_end = addr.saturating_add(len);
        for (map_addr, mapping) in pid_map.iter_mut() {
            let map_end = map_addr.saturating_add(mapping.len as u64);
            if map_end <= addr || *map_addr >= protect_end {
                continue;
            }
            mapping.writable = true;
        }
    }

    /// Publish and drop every shared mapping of a process that is going away.
    ///
    /// Teardown continues even when one backing is no longer readable or
    /// writable: a file backing retains its dirty pages on a failed final
    /// writeback, and anonymous/SysV cleanup must not be skipped because of
    /// that failure.
    pub fn release_all_for_process(
        &mut self,
        pid: u32,
        publish: bool,
        io: &mut dyn SharedMappingIo,
    ) {
        if self.releasing_pids.contains(&pid) {
            return;
        }
        self.releasing_pids.insert(pid);

        if publish && io.process_memory_len(pid).is_some() {
            let _ = self.sync_anonymous_from_process(pid, true, io);
            let _ = self.sync_file_from_process(pid, true, io);
            self.sync_sysv_from_process(pid, true, io);

            let targets: Vec<(u64, usize, u64, Option<BackingKind>, Option<String>, bool, bool, i32)> =
                self.mappings
                    .get(&pid)
                    .map(|m| {
                        m.iter()
                            .map(|(addr, mapping)| {
                                (
                                    *addr,
                                    mapping.len,
                                    mapping.file_offset,
                                    mapping.backing_kind,
                                    mapping.backing_key.clone(),
                                    mapping.writable,
                                    mapping.fd_writeback,
                                    mapping.fd,
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            for (addr, len, file_offset, kind, key, writable, fd_writeback, fd) in targets {
                if !writable {
                    continue;
                }
                if kind == Some(BackingKind::File) && key.is_some() {
                    if let Some(backing) = key.as_deref().and_then(|k| self.file_backings.get_mut(k))
                    {
                        backing.flush_range(file_offset, len as u64, io);
                    }
                    continue;
                }
                if key.is_some() {
                    continue;
                }
                if fd_writeback {
                    self.flush_fd_writeback_mapping(pid, addr, addr, len as u64, io);
                    continue;
                }
                let mut bytes = vec![0u8; len];
                if io.read_process(pid, addr, &mut bytes).is_err() {
                    continue;
                }
                let mut written = 0usize;
                while written < bytes.len() {
                    match io.fd_pwrite(pid, fd, file_offset + written as u64, &bytes[written..]) {
                        Ok(count) if count > 0 && count <= bytes.len() - written => written += count,
                        _ => break,
                    }
                }
            }
        }

        if let Some(mappings) = self.mappings.remove(&pid) {
            for mapping in mappings.values() {
                self.release_mapping(mapping, io);
            }
        }
        // The kernel destroys the whole fd table on teardown, so the writeback
        // dups vanish with it; drop their bookkeeping without issuing closes.
        self.writeback_refs.remove(&pid);
        self.release_all_sysv_for_process(pid, false, io);

        self.releasing_pids.remove(&pid);
    }

    // -- fork inheritance -------------------------------------------------

    /// Give a freshly forked child its parent's shared mappings.
    ///
    /// Everything that can fail is staged first: every authoritative range is
    /// read, and every address and length revalidated against the child's real
    /// memory size, before any child state is published. If the commit phase
    /// still fails, the child's memory and every backing refcount are rolled
    /// back, so a child never starts with a partially inherited address space.
    pub fn inherit_process_mappings(
        &mut self,
        parent_pid: u32,
        child_pid: u32,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if parent_pid == child_pid {
            return Err(Errno::EINVAL);
        }
        if self.mappings.contains_key(&child_pid) || self.sysv.contains_key(&child_pid) {
            return Err(Errno::EEXIST);
        }
        let child_bytes = io.process_memory_len(child_pid).ok_or(Errno::ESRCH)?;

        // --- stage -------------------------------------------------------
        let parent_entries: Vec<(u64, SharedMapping)> = self
            .mappings
            .get(&parent_pid)
            .map(|m| m.iter().map(|(a, v)| (*a, v.clone())).collect())
            .unwrap_or_default();

        // (map_addr, inherited mapping, backing version)
        let mut staged: Vec<(u64, SharedMapping, Vec<u8>)> = Vec::new();
        let mut staged_fd_writeback: Vec<(u64, SharedMapping)> = Vec::new();
        for (map_addr, mapping) in parent_entries {
            if map_addr.saturating_add(mapping.len as u64) > child_bytes {
                return Err(Errno::EINVAL);
            }
            // A bare fd-writeback mapping carries no backing: the child's
            // memory is already a full fork copy and its fd table inherits the
            // same stable writeback descriptor, so it needs only a registered
            // child entry to flush its own later writes.
            if mapping.backing_key.is_none() {
                if mapping.fd_writeback {
                    staged_fd_writeback.push((map_addr, mapping));
                }
                continue;
            }
            let key = mapping.backing_key.clone().expect("checked above");
            let (latest, version) = match mapping.backing_kind {
                Some(BackingKind::File) => {
                    let Some(backing) = self.file_backings.get_mut(&key) else {
                        return Err(Errno::EINVAL);
                    };
                    let version = backing.version;
                    (backing.read_range(mapping.file_offset, mapping.len, io)?, version)
                }
                _ => {
                    let Some(backing) = self.anon_backings.get(&key) else {
                        return Err(Errno::EINVAL);
                    };
                    let base = mapping.file_offset as usize;
                    if base.saturating_add(mapping.len) > backing.bytes.len() {
                        return Err(Errno::EINVAL);
                    }
                    (backing.bytes[base..base + mapping.len].to_vec(), backing.version)
                }
            };
            let mut inherited = mapping.clone();
            inherited.seen_version = version;
            staged.push((map_addr, inherited, latest));
        }

        let parent_sysv: Vec<(u64, SysvShmMapping)> = self
            .sysv
            .get(&parent_pid)
            .map(|m| m.iter().map(|(a, v)| (*a, v.clone())).collect())
            .unwrap_or_default();
        let mut staged_sysv: Vec<(u64, SysvShmMapping, Vec<u8>)> = Vec::new();
        for (map_addr, mapping) in parent_sysv {
            if mapping.size == 0
                || mapping.seg_id < 0
                || map_addr.saturating_add(mapping.size as u64) > child_bytes
            {
                return Err(Errno::EINVAL);
            }
            let mut latest = vec![0u8; mapping.size];
            io.shm_read(mapping.seg_id, 0, &mut latest)?;
            let mut inherited = mapping.clone();
            inherited.seen_version = self.sysv_segment_version(mapping.seg_id);
            staged_sysv.push((map_addr, inherited, latest));
        }

        // Snapshot the child bytes each publication overwrites, so a failed
        // commit can put the child's address space back as it was.
        let mut originals: Vec<(u64, Vec<u8>)> = Vec::new();
        for (map_addr, mapping, _) in &staged {
            let mut bytes = vec![0u8; mapping.len];
            io.read_process(child_pid, *map_addr, &mut bytes)?;
            originals.push((*map_addr, bytes));
        }
        for (map_addr, mapping, _) in &staged_sysv {
            let mut bytes = vec![0u8; mapping.size];
            io.read_process(child_pid, *map_addr, &mut bytes)?;
            originals.push((*map_addr, bytes));
        }
        // An fd-writeback child mapping's snapshot is the fork-time content, so
        // the child's later writes flush as dirty runs through its inherited
        // descriptor.
        for (map_addr, mapping) in staged_fd_writeback.iter_mut() {
            let mut bytes = vec![0u8; mapping.len];
            io.read_process(child_pid, *map_addr, &mut bytes)?;
            mapping.snapshot = Some(bytes);
        }

        // --- commit ------------------------------------------------------
        let mut published: Vec<(u64, usize)> = Vec::new();
        let mut failure: Option<Errno> = None;
        for (map_addr, _, latest) in &staged {
            if let Err(err) = io.write_process(child_pid, *map_addr, latest) {
                failure = Some(err);
                break;
            }
            published.push((*map_addr, latest.len()));
        }
        if failure.is_none() {
            for (map_addr, _, latest) in &staged_sysv {
                if let Err(err) = io.write_process(child_pid, *map_addr, latest) {
                    failure = Some(err);
                    break;
                }
                published.push((*map_addr, latest.len()));
            }
        }
        if let Some(err) = failure {
            let _ = published;
            for (map_addr, bytes) in originals {
                let _ = io.write_process(child_pid, map_addr, &bytes);
            }
            return Err(err);
        }

        for (map_addr, mut mapping, latest) in staged {
            match (mapping.backing_kind, mapping.backing_key.as_deref()) {
                (Some(BackingKind::File), Some(key)) => {
                    if let Some(backing) = self.file_backings.get_mut(key) {
                        backing.ref_count += 1;
                    }
                }
                (Some(BackingKind::Anonymous), Some(key)) => {
                    if let Some(backing) = self.anon_backings.get_mut(key) {
                        backing.ref_count += 1;
                    }
                }
                _ => {}
            }
            mapping.snapshot = Some(latest);
            self.mappings.entry(child_pid).or_default().insert(map_addr, mapping);
        }
        for (map_addr, mapping) in staged_fd_writeback {
            // The child's inherited writeback descriptors are independent fd
            // table entries; count them under the child pid so they are closed
            // on the child's own munmap and dropped on child teardown.
            self.retain_writeback_fd(child_pid, &mapping);
            self.mappings.entry(child_pid).or_default().insert(map_addr, mapping);
        }
        for (map_addr, mut mapping, latest) in staged_sysv {
            mapping.snapshot = latest;
            self.sysv.entry(child_pid).or_default().insert(map_addr, mapping);
        }
        Ok(())
    }
}

// ── Machine-wide singleton ──

struct SharedMappingTableCell(core::cell::UnsafeCell<SharedMappingTable>);
// SAFETY: the kernel Wasm module is single-threaded; every access is made from
// a serialized kernel dispatch under the global kernel lock.
unsafe impl Sync for SharedMappingTableCell {}

static SHARED_MAPPING_TABLE: SharedMappingTableCell =
    SharedMappingTableCell(core::cell::UnsafeCell::new(SharedMappingTable::new()));

/// Machine-wide authority for every process's `MAP_SHARED` interval, the
/// backings behind them, and the SysV attachment mirror.
///
/// This is a peer of [`crate::ipc::global_ipc_table`] rather than a
/// `ProcessTable` field on purpose: the `SharedMappingIo` bridge needs
/// `&mut Process` for the fd-writeback path, so owning the table outside the
/// process table keeps that borrow disjoint instead of aliasing it.
///
/// # Safety
/// Must only be called from a single-threaded context (Wasm is
/// single-threaded), and the returned reference must not be held across a
/// re-entry into the same table.
pub unsafe fn global_shared_mapping_table() -> &'static mut SharedMappingTable {
    unsafe { &mut *SHARED_MAPPING_TABLE.0.get() }
}

#[cfg(test)]
mod shared_mapping_tests {
    use super::*;
    use alloc::string::ToString;

    /// In-memory stand-in for every capability the mapping table needs.
    struct MockIo {
        procs: BTreeMap<u32, Vec<u8>>,
        /// Stable host handle -> file bytes.
        files: BTreeMap<i64, Vec<u8>>,
        /// Stable host handle -> (dev, ino, backend identity).
        idents: BTreeMap<i64, (u64, u64, String)>,
        retained: BTreeMap<i64, i32>,
        /// (pid, guest fd) -> stable host handle.
        fds: BTreeMap<(u32, i32), i64>,
        shm: BTreeMap<i32, Vec<u8>>,
        closed_fds: Vec<(u32, i32)>,
        losses: Vec<(u32, u64, String)>,
        fail_pwrite: bool,
        fail_write_process_at: Option<u64>,
    }

    impl MockIo {
        fn new() -> Self {
            Self {
                procs: BTreeMap::new(),
                files: BTreeMap::new(),
                idents: BTreeMap::new(),
                retained: BTreeMap::new(),
                fds: BTreeMap::new(),
                shm: BTreeMap::new(),
                closed_fds: Vec::new(),
                losses: Vec::new(),
                fail_pwrite: false,
                fail_write_process_at: None,
            }
        }

        fn with_process(mut self, pid: u32, len: usize) -> Self {
            self.procs.insert(pid, vec![0u8; len]);
            self
        }

        fn with_file(mut self, handle: i64, dev: u64, ino: u64, bytes: Vec<u8>) -> Self {
            self.idents
                .insert(handle, (dev, ino, alloc::format!("file:{dev}:{ino}")));
            self.files.insert(handle, bytes);
            self
        }

        fn with_fd(mut self, pid: u32, fd: i32, handle: i64) -> Self {
            self.fds.insert((pid, fd), handle);
            self
        }

        fn key_of(&self, handle: i64) -> String {
            self.idents[&handle].2.clone()
        }

        fn stat_of(&self, handle: i64) -> SharedMappingStat {
            let (dev, ino, _) = self.idents[&handle];
            SharedMappingStat {
                dev,
                ino,
                size: self.files[&handle].len() as u64,
                mode: S_IFREG | 0o644,
                host_handle: Some(handle),
            }
        }

        fn poke(&mut self, pid: u32, addr: u64, bytes: &[u8]) {
            let mem = self.procs.get_mut(&pid).expect("process");
            let at = addr as usize;
            mem[at..at + bytes.len()].copy_from_slice(bytes);
        }

        fn peek(&self, pid: u32, addr: u64, len: usize) -> Vec<u8> {
            let mem = &self.procs[&pid];
            mem[addr as usize..addr as usize + len].to_vec()
        }
    }

    impl SharedMappingIo for MockIo {
        fn read_process(&mut self, pid: u32, addr: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let mem = self.procs.get(&pid).ok_or(Errno::ESRCH)?;
            let at = addr as usize;
            if at + dst.len() > mem.len() {
                return Err(Errno::EFAULT);
            }
            dst.copy_from_slice(&mem[at..at + dst.len()]);
            Ok(())
        }

        fn write_process(&mut self, pid: u32, addr: u64, src: &[u8]) -> Result<(), Errno> {
            if self.fail_write_process_at == Some(addr) {
                return Err(Errno::EFAULT);
            }
            let mem = self.procs.get_mut(&pid).ok_or(Errno::ESRCH)?;
            let at = addr as usize;
            if at + src.len() > mem.len() {
                return Err(Errno::EFAULT);
            }
            mem[at..at + src.len()].copy_from_slice(src);
            Ok(())
        }

        fn process_memory_len(&mut self, pid: u32) -> Option<u64> {
            self.procs.get(&pid).map(|m| m.len() as u64)
        }

        fn pread(&mut self, handle: i64, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
            let file = self.files.get(&handle).ok_or(Errno::EBADF)?;
            let at = offset as usize;
            if at >= file.len() {
                return Ok(0);
            }
            let n = dst.len().min(file.len() - at);
            dst[..n].copy_from_slice(&file[at..at + n]);
            Ok(n)
        }

        fn pwrite(&mut self, handle: i64, offset: u64, src: &[u8]) -> Result<usize, Errno> {
            if self.fail_pwrite {
                return Err(Errno::EIO);
            }
            let file = self.files.get_mut(&handle).ok_or(Errno::EBADF)?;
            let at = offset as usize;
            if at + src.len() > file.len() {
                file.resize(at + src.len(), 0);
            }
            file[at..at + src.len()].copy_from_slice(src);
            Ok(src.len())
        }

        fn fstat_handle(&mut self, handle: i64) -> Result<SharedMappingStat, Errno> {
            if !self.files.contains_key(&handle) {
                return Err(Errno::EBADF);
            }
            Ok(self.stat_of(handle))
        }

        fn handle_identity(&mut self, handle: i64, _dev: u64, _ino: u64) -> Option<String> {
            self.idents.get(&handle).map(|(_, _, k)| k.clone())
        }

        fn retain_handle(&mut self, handle: i64) -> Result<(), Errno> {
            *self.retained.entry(handle).or_insert(0) += 1;
            Ok(())
        }

        fn release_handle(&mut self, handle: i64) {
            *self.retained.entry(handle).or_insert(0) -= 1;
        }

        fn fd_stat(&mut self, pid: u32, fd: i32) -> Result<SharedMappingStat, Errno> {
            let handle = *self.fds.get(&(pid, fd)).ok_or(Errno::EBADF)?;
            let (dev, ino, _) = self.idents[&handle];
            Ok(SharedMappingStat {
                dev,
                ino,
                size: self.files[&handle].len() as u64,
                mode: S_IFREG | 0o644,
                host_handle: None,
            })
        }

        fn fd_pwrite(&mut self, pid: u32, fd: i32, offset: u64, src: &[u8]) -> Result<usize, Errno> {
            let handle = *self.fds.get(&(pid, fd)).ok_or(Errno::EBADF)?;
            self.pwrite(handle, offset, src)
        }

        fn close_fd(&mut self, pid: u32, fd: i32) {
            self.closed_fds.push((pid, fd));
            self.fds.remove(&(pid, fd));
        }

        fn shm_read(&mut self, seg_id: i32, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let seg = self.shm.get(&seg_id).ok_or(Errno::EINVAL)?;
            let at = offset as usize;
            if at + dst.len() > seg.len() {
                return Err(Errno::EINVAL);
            }
            dst.copy_from_slice(&seg[at..at + dst.len()]);
            Ok(())
        }

        fn shm_write(&mut self, seg_id: i32, offset: u64, src: &[u8]) -> Result<(), Errno> {
            let seg = self.shm.get_mut(&seg_id).ok_or(Errno::EINVAL)?;
            let at = offset as usize;
            if at + src.len() > seg.len() {
                return Err(Errno::EINVAL);
            }
            seg[at..at + src.len()].copy_from_slice(src);
            Ok(())
        }

        fn report_writeback_loss(&mut self, pid: u32, map_addr: u64, reason: &str) {
            self.losses.push((pid, map_addr, reason.to_string()));
        }
    }

    // -- run-diff primitives ---------------------------------------------

    #[test]
    fn changed_runs_finds_only_differing_spans() {
        assert_eq!(changed_runs(b"abcdef", b"abcdef"), Vec::new());
        assert_eq!(changed_runs(b"aXcdYf", b"abcdef"), vec![(1, 2), (4, 5)]);
        assert_eq!(changed_runs(b"XXcdef", b"abcdef"), vec![(0, 2)]);
        assert_eq!(changed_runs(b"abcdXX", b"abcdef"), vec![(4, 6)]);
    }

    #[test]
    fn a_short_snapshot_treats_every_trailing_byte_as_changed() {
        // Publishing more than necessary is the safe direction; publishing less
        // would silently drop a MAP_SHARED store.
        assert_eq!(changed_runs(b"abcd", b"ab"), vec![(2, 4)]);
    }

    #[test]
    fn merging_runs_preserves_a_peers_disjoint_write() {
        // The whole point of run-merging: process A wrote the head, process B
        // the tail; neither may clobber the other.
        let mut backing = b"AAAABBBB".to_vec();
        let snapshot = b"........".to_vec();
        assert!(merge_changed_byte_runs(b"XXXX....", &snapshot, &mut backing, 0));
        assert_eq!(&backing, b"XXXXBBBB");
        assert!(merge_changed_byte_runs(b"....YYYY", &snapshot, &mut backing, 0));
        assert_eq!(&backing, b"XXXXYYYY");
    }

    // -- anonymous MAP_SHARED --------------------------------------------

    fn anon_table_with_two_observers(io: &mut MockIo) -> (SharedMappingTable, String) {
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, io).unwrap();
        let key = table
            .mapping(1, 0)
            .unwrap()
            .backing_key
            .clone()
            .expect("anon backing");
        // A second process observes the same store.
        let snapshot = table.mapping(1, 0).unwrap().snapshot.clone().unwrap();
        table.anon_backings.get_mut(&key).unwrap().ref_count += 1;
        table.insert_mapping(2, 0, SharedMapping::anonymous(8, true, key.clone(), snapshot));
        (table, key)
    }

    #[test]
    fn anonymous_peers_converge_on_disjoint_writes() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let (mut table, key) = anon_table_with_two_observers(&mut io);

        io.poke(1, 0, b"AAAA\0\0\0\0");
        io.poke(2, 0, b"\0\0\0\0BBBB");
        table.sync_anonymous_from_process(1, false, &mut io).unwrap();
        table.sync_anonymous_from_process(2, false, &mut io).unwrap();
        // Process 1 must now import process 2's half.
        table.sync_anonymous_from_process(1, false, &mut io).unwrap();

        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(table.anon_backing(&key).unwrap().bytes, b"AAAABBBB".to_vec());
    }

    #[test]
    fn a_sole_current_observer_defers_scanning_its_memory() {
        let mut io = MockIo::new().with_process(1, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();

        io.poke(1, 0, b"AAAAAAAA");
        table.sync_anonymous_from_process(1, false, &mut io).unwrap();
        let key = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();
        // Nothing published: with one observer and no staleness there is no
        // peer that could observe the write.
        assert_eq!(table.anon_backing(&key).unwrap().bytes, vec![0u8; 8]);

        // A forced sync (msync / munmap / fork) publishes it.
        table.sync_anonymous_from_process(1, true, &mut io).unwrap();
        assert_eq!(table.anon_backing(&key).unwrap().bytes, b"AAAAAAAA".to_vec());
    }

    #[test]
    fn a_sole_stale_observer_still_imports_a_departed_peers_publication() {
        // The generic case a package set is unlikely to reach: a peer published
        // and then detached, leaving one stale observer. Deferring here would
        // strand the publication forever.
        let mut io = MockIo::new().with_process(1, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let key = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();

        let backing = table.anon_backings.get_mut(&key).unwrap();
        backing.bytes = b"PEERPEER".to_vec();
        backing.version = 7;

        table.sync_anonymous_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"PEERPEER".to_vec());
        assert_eq!(table.mapping(1, 0).unwrap().seen_version, 7);
    }

    // -- file page cache --------------------------------------------------

    #[test]
    fn a_page_past_eof_is_zero_filled_but_writeback_never_grows_the_file() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 5);

        let page = backing.read_range(0, FILE_PAGE_SIZE, &mut io).unwrap();
        assert_eq!(&page[..5], b"hello");
        assert!(page[5..].iter().all(|b| *b == 0));

        // Dirty a byte inside the file and a byte past EOF.
        backing.write_range(4, b"O", true, &mut io).unwrap();
        backing.write_range(4096, b"Z", true, &mut io).unwrap();
        assert!(backing.flush_all(&mut io));

        assert_eq!(io.files[&10], b"hellO".to_vec());
    }

    #[test]
    fn dirty_bytes_entirely_past_eof_are_dropped_not_written() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 5);
        backing.write_range(8192, b"Z", true, &mut io).unwrap();
        assert_eq!(backing.dirty_page_count(), 1);
        assert!(backing.flush_all(&mut io));
        assert_eq!(backing.dirty_page_count(), 0);
        assert_eq!(io.files[&10], b"hello".to_vec());
    }

    #[test]
    fn invalidation_never_discards_dirty_pages() {
        // Dropping a dirty page would silently lose an acknowledged store.
        let mut io = MockIo::new().with_file(10, 1, 2, vec![b'x'; 8192]);
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 8192);
        backing.read_range(0, 8192, &mut io).unwrap();
        backing.write_range(0, b"D", true, &mut io).unwrap();
        assert_eq!(backing.cached_page_count(), 2);

        backing.invalidate_range(0, 8192);
        assert_eq!(backing.cached_page_count(), 1);
        assert_eq!(backing.dirty_page_count(), 1);
    }

    #[test]
    fn a_short_read_is_an_error_rather_than_a_zero_fill() {
        // fstat declared these bytes readable; zero-filling would manufacture
        // data the file never held.
        let mut io = MockIo::new().with_file(10, 1, 2, b"ab".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 64);
        assert_eq!(backing.read_range(0, 8, &mut io), Err(Errno::EIO));
    }

    #[test]
    fn revalidation_rejects_a_handle_whose_identity_changed() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let mut backing = FileBacking::new("file:9:9".to_string(), 10, true, 5);
        assert_eq!(backing.revalidate(&mut io), Err(Errno::EIO));
        assert!(!backing.size_valid);
    }

    #[test]
    fn a_failed_final_writeback_keeps_the_handle_and_the_dirty_pages() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        {
            let stat = io.stat_of(10);
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            backing.ref_count = 1;
        }
        table
            .file_backing_mut(&key)
            .unwrap()
            .write_range(0, b"H", true, &mut io)
            .unwrap();
        io.fail_pwrite = true;
        table.release_file_backing_reference(&key, &mut io);

        // Closing here would irreversibly lose an acknowledged store.
        assert!(table.file_backing(&key).is_some());
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);
        assert_eq!(io.retained[&10], 1);
    }

    // -- two-phase file coherence -----------------------------------------

    fn file_table_with_two_observers(io: &mut MockIo, key: &str) -> SharedMappingTable {
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table.get_or_create_file_backing(key, &stat, true, io).unwrap();
            backing.ref_count = 2;
        }
        let initial = table
            .file_backing_mut(key)
            .unwrap()
            .read_range(0, 8, io)
            .unwrap();
        for pid in [1u32, 2u32] {
            io.write_process(pid, 0, &initial).unwrap();
            table.insert_mapping(
                pid,
                0,
                SharedMapping::file(3, 0, 8, true, true, String::from(key), initial.clone(), 0),
            );
        }
        table
    }

    #[test]
    fn file_peers_converge_on_disjoint_writes_and_reach_the_file() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);

        io.poke(1, 0, b"AAAA....");
        io.poke(2, 0, b"....BBBB");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        table.sync_file_from_process(2, false, &mut io).unwrap();
        table.sync_file_from_process(1, false, &mut io).unwrap();

        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec());

        assert!(table.flush_mappings(1, 0, 8, &mut io));
        assert_eq!(io.files[&10], b"AAAABBBB".to_vec());
    }

    #[test]
    fn a_read_only_mapping_never_publishes() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        table.mappings.get_mut(&1).unwrap().get_mut(&0).unwrap().writable = false;

        io.poke(1, 0, b"AAAA....");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);
    }

    #[test]
    fn publishing_observers_forces_a_deferred_sole_writer_to_flush() {
        // Without this, a newcomer would map the file's persisted bytes and
        // never see the sole existing observer's deferred writes.
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            backing.ref_count = 1;
        }
        let initial = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        io.write_process(1, 0, &initial).unwrap();
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), initial, 0),
        );

        io.poke(1, 0, b"AAAA....");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);

        table.publish_file_backing_observers(&key, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);
    }

    // -- mprotect ---------------------------------------------------------

    #[test]
    fn a_prot_write_upgrade_needs_a_writable_description() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);

        assert_eq!(table.prepare_file_mappings_for_write(1, 0, 8), Ok(()));
        table
            .mappings
            .get_mut(&1)
            .unwrap()
            .get_mut(&0)
            .unwrap()
            .write_allowed = false;
        assert_eq!(
            table.prepare_file_mappings_for_write(1, 0, 8),
            Err(Errno::EACCES)
        );
    }

    #[test]
    fn writeback_eligibility_is_monotonic() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        table.update_mapping_protection(1, 0, 8, true);
        assert!(table.mapping(1, 0).unwrap().writable);
        // A read-only downgrade must not clear it: bytes dirtied while writable
        // still have to be flushed.
        table.update_mapping_protection(1, 0, 8, false);
        assert!(table.mapping(1, 0).unwrap().writable);
    }

    // -- fd-writeback bridge ----------------------------------------------

    fn fd_writeback_table(io: &mut MockIo) -> SharedMappingTable {
        let mut table = SharedMappingTable::new();
        let snapshot = vec![b'.'; 8];
        io.write_process(1, 0, &snapshot).unwrap();
        table.insert_mapping(
            1,
            0,
            SharedMapping::fd_writeback(3, 0, 8, 4, 8, 1, 2, snapshot),
        );
        let mapping = table.mapping(1, 0).unwrap().clone();
        table.retain_writeback_fd(1, &mapping);
        table
    }

    #[test]
    fn fd_writeback_publishes_only_the_runs_this_mapping_changed() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"..PEER..".to_vec())
            .with_fd(1, 4, 10);
        let mut table = fd_writeback_table(&mut io);

        io.poke(1, 0, b"AA......");
        assert!(table.flush_fd_writeback_mapping(1, 0, 0, 8, &mut io));
        // The peer's bytes at 2..6 survive because they never differed from
        // this mapping's snapshot.
        assert_eq!(io.files[&10], b"AAPEER..".to_vec());
    }

    #[test]
    fn fd_writeback_refuses_when_the_descriptor_was_repointed_by_dup2() {
        // The dup is a guest-*visible* fd number. Writing here would corrupt an
        // unrelated file, and today no shipped package exercises this path.
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec())
            .with_file(11, 9, 9, b"UNRELATED".to_vec())
            .with_fd(1, 4, 11);
        let mut table = fd_writeback_table(&mut io);

        io.poke(1, 0, b"AAAAAAAA");
        assert!(!table.flush_fd_writeback_mapping(1, 0, 0, 8, &mut io));
        assert_eq!(io.files[&11], b"UNRELATED".to_vec());
        assert_eq!(io.losses.len(), 1);
        assert!(io.losses[0].2.contains("repointed"));
    }

    #[test]
    fn fd_writeback_refuses_and_reports_when_the_descriptor_was_closed() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let mut table = fd_writeback_table(&mut io);
        io.poke(1, 0, b"AAAAAAAA");
        assert!(!table.flush_fd_writeback_mapping(1, 0, 0, 8, &mut io));
        assert_eq!(io.losses.len(), 1);
        assert!(io.losses[0].2.contains("closed"));
    }

    #[test]
    fn fd_writeback_is_clamped_to_the_live_file_size() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"....".to_vec())
            .with_fd(1, 4, 10);
        let mut table = fd_writeback_table(&mut io);
        io.poke(1, 0, b"AAAAAAAA");
        assert!(table.flush_fd_writeback_mapping(1, 0, 0, 8, &mut io));
        // The whole-page mapping must not grow the file past its real EOF.
        assert_eq!(io.files[&10], b"AAAA".to_vec());
    }

    #[test]
    fn writeback_loss_reports_are_bounded_but_never_silent() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let mut table = fd_writeback_table(&mut io);
        io.poke(1, 0, b"AAAAAAAA");
        for _ in 0..(WRITEBACK_LOSS_REPORT_LIMIT + 10) {
            table.flush_fd_writeback_mapping(1, 0, 0, 8, &mut io);
        }
        assert_eq!(io.losses.len() as u32, WRITEBACK_LOSS_REPORT_LIMIT);
    }

    // -- munmap split -----------------------------------------------------

    #[test]
    fn a_middle_split_keeps_the_shared_writeback_dup_alive_for_both_halves() {
        let mut io = MockIo::new()
            .with_process(1, 4096)
            .with_file(10, 1, 2, vec![b'.'; 8])
            .with_fd(1, 4, 10);
        let mut table = fd_writeback_table(&mut io);

        table.cleanup_mappings(1, 3, 2, &mut io);
        assert!(table.mapping(1, 0).is_some());
        assert!(table.mapping(1, 5).is_some());
        assert_eq!(table.mapping(1, 0).unwrap().len, 3);
        assert_eq!(table.mapping(1, 5).unwrap().len, 3);
        assert_eq!(table.mapping(1, 5).unwrap().file_offset, 5);
        // Neither half released yet: the dup must still be open.
        assert!(io.closed_fds.is_empty());

        table.cleanup_mappings(1, 0, 3, &mut io);
        assert!(io.closed_fds.is_empty());
        table.cleanup_mappings(1, 5, 3, &mut io);
        assert_eq!(io.closed_fds, vec![(1u32, 4i32)]);
    }

    #[test]
    fn a_head_unmap_slides_the_tail_and_its_snapshot() {
        let mut io = MockIo::new()
            .with_process(1, 4096)
            .with_file(10, 1, 2, vec![b'.'; 8])
            .with_fd(1, 4, 10);
        let mut table = fd_writeback_table(&mut io);
        io.poke(1, 0, b"01234567");
        table.mappings.get_mut(&1).unwrap().get_mut(&0).unwrap().snapshot =
            Some(b"01234567".to_vec());

        table.cleanup_mappings(1, 0, 3, &mut io);
        let mapping = table.mapping(1, 3).expect("tail survives");
        assert_eq!(mapping.len, 5);
        assert_eq!(mapping.file_offset, 3);
        assert_eq!(mapping.snapshot.as_deref(), Some(&b"34567"[..]));
    }

    #[test]
    fn a_split_refcounts_the_file_backing_so_neither_half_frees_it_early() {
        let mut io = MockIo::new()
            .with_process(1, 4096)
            .with_file(10, 1, 2, vec![b'.'; 8]);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            backing.ref_count = 1;
        }
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), vec![b'.'; 8], 0),
        );

        table.cleanup_mappings(1, 3, 2, &mut io);
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);
        table.cleanup_mappings(1, 0, 3, &mut io);
        assert!(table.file_backing(&key).is_some());
        table.cleanup_mappings(1, 5, 3, &mut io);
        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained[&10], 0);
    }

    // -- fork inheritance --------------------------------------------------

    #[test]
    fn a_child_inherits_the_latest_shared_bytes_and_a_backing_reference() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let key = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();
        table.anon_backings.get_mut(&key).unwrap().bytes = b"PARENTAL".to_vec();
        table.anon_backings.get_mut(&key).unwrap().version = 3;

        table.inherit_process_mappings(1, 2, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"PARENTAL".to_vec());
        assert_eq!(table.anon_backing(&key).unwrap().ref_count, 2);
        assert_eq!(table.mapping(2, 0).unwrap().seen_version, 3);
    }

    #[test]
    fn a_failed_inheritance_leaves_the_child_address_space_untouched() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let key = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();
        table.anon_backings.get_mut(&key).unwrap().bytes = b"PARENTAL".to_vec();
        io.poke(2, 0, b"ORIGINAL");

        io.fail_write_process_at = Some(0);
        assert_eq!(
            table.inherit_process_mappings(1, 2, &mut io),
            Err(Errno::EFAULT)
        );
        io.fail_write_process_at = None;
        assert_eq!(io.peek(2, 0, 8), b"ORIGINAL".to_vec());
        assert!(table.mapping(2, 0).is_none());
        assert_eq!(table.anon_backing(&key).unwrap().ref_count, 1);
    }

    #[test]
    fn inheriting_into_a_child_that_already_has_mappings_is_refused() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        table.track_anonymous_mapping(2, 0, 8, true, &mut io).unwrap();
        assert_eq!(
            table.inherit_process_mappings(1, 2, &mut io),
            Err(Errno::EEXIST)
        );
    }

    #[test]
    fn an_fd_writeback_child_snapshots_the_fork_time_content() {
        // No backing read is needed: the child's memory is already a full fork
        // copy. It needs a mapping entry so its own later writes flush.
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, vec![b'.'; 8])
            .with_fd(1, 4, 10)
            .with_fd(2, 4, 10);
        let mut table = fd_writeback_table(&mut io);
        io.poke(2, 0, b"FORKTIME");

        table.inherit_process_mappings(1, 2, &mut io).unwrap();
        let child = table.mapping(2, 0).expect("child mapping");
        assert!(child.fd_writeback);
        assert_eq!(child.snapshot.as_deref(), Some(&b"FORKTIME"[..]));

        io.poke(2, 0, b"CHILDWRT");
        assert!(table.flush_fd_writeback_mapping(2, 0, 0, 8, &mut io));
        assert_eq!(io.files[&10], b"CHILDWRT".to_vec());
    }

    // -- SysV shared-memory mirror ----------------------------------------

    fn sysv_table(io: &mut MockIo) -> SharedMappingTable {
        io.shm.insert(7, vec![b'.'; 8]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, io).unwrap();
        table.track_sysv_mapping(2, 0, 7, 8, false, io).unwrap();
        table
    }

    #[test]
    fn sysv_attachments_converge_on_disjoint_writes() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = sysv_table(&mut io);

        io.poke(1, 0, b"AAAA....");
        io.poke(2, 0, b"....BBBB");
        assert!(table.sync_sysv_from_process(1, false, &mut io));
        assert!(table.sync_sysv_from_process(2, false, &mut io));
        assert!(table.sync_sysv_from_process(1, false, &mut io));

        assert_eq!(io.shm[&7], b"AAAABBBB".to_vec());
        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec());
        assert!(table.sysv_segment_version(7) > 0);
    }

    #[test]
    fn a_read_only_sysv_attachment_never_publishes() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, vec![b'.'; 8]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, true, &mut io).unwrap();
        table.track_sysv_mapping(2, 0, 7, 8, false, &mut io).unwrap();

        io.poke(1, 0, b"AAAAAAAA");
        assert!(table.sync_sysv_from_process(1, false, &mut io));
        // Nothing reached the kernel-owned segment.
        assert_eq!(io.shm[&7], vec![b'.'; 8]);

        // And once a writer advances the segment, the read-only attachment is
        // refreshed back to the authoritative bytes, discarding the local
        // scribble rather than letting it linger as a private view.
        io.poke(2, 0, b"BBBBBBBB");
        assert!(table.sync_sysv_from_process(2, true, &mut io));
        assert!(table.sync_sysv_from_process(1, false, &mut io));
        assert_eq!(io.peek(1, 0, 8), b"BBBBBBBB".to_vec());
    }

    #[test]
    fn a_sole_sysv_attachment_defers_until_forced() {
        let mut io = MockIo::new().with_process(1, 64);
        io.shm.insert(7, vec![b'.'; 8]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();

        io.poke(1, 0, b"AAAAAAAA");
        assert!(table.sync_sysv_from_process(1, false, &mut io));
        assert_eq!(io.shm[&7], vec![b'.'; 8]);

        assert!(table.sync_sysv_from_process(1, true, &mut io));
        assert_eq!(io.shm[&7], b"AAAAAAAA".to_vec());
    }

    #[test]
    fn a_child_inherits_sysv_attachments_with_the_segments_current_bytes() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEGMENTS".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();

        table.inherit_process_mappings(1, 2, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"SEGMENTS".to_vec());
        assert_eq!(table.sysv_mapping(2, 0).unwrap().seg_id, 7);
    }

    #[test]
    fn a_stale_sole_sysv_attachment_still_imports_a_peers_publication() {
        // The sole-observer skip is keyed on having no live peer, not on
        // having published. A process whose only peer detached after
        // publishing must still see those bytes, or it would keep a private
        // view of a segment it does not own.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = sysv_table(&mut io);

        io.poke(2, 0, b"PEERWROT");
        assert!(table.sync_sysv_from_process(2, false, &mut io));
        table.release_all_sysv_for_process(2, false, &mut io);
        assert_eq!(table.sysv_pid_count(), 1);

        assert!(table.sync_sysv_from_process(1, false, &mut io));
        assert_eq!(io.peek(1, 0, 8), b"PEERWROT".to_vec());
    }

    #[test]
    fn a_segment_sync_publishes_every_attachment_before_a_newcomer_joins() {
        // shmat calls this so a previously sole observer, which had been
        // deferring, is current before the new attachment snapshots the
        // segment. Without it the newcomer would start from stale bytes.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, vec![b'.'; 8]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        io.poke(1, 0, b"SOLEWRIT");

        // Deferred: no peer yet.
        assert!(table.sync_sysv_from_process(1, false, &mut io));
        assert_eq!(io.shm[&7], vec![b'.'; 8]);

        table.sync_sysv_segment_from_attached(7, &mut io);
        assert_eq!(io.shm[&7], b"SOLEWRIT".to_vec());

        table.track_sysv_mapping(2, 0, 7, 8, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"SOLEWRIT".to_vec());
    }

    #[test]
    fn dropping_one_attachment_leaves_the_process_others_alone() {
        let mut io = MockIo::new().with_process(1, 64);
        io.shm.insert(7, vec![b'.'; 8]);
        io.shm.insert(9, vec![b'-'; 8]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(1, 16, 9, 8, false, &mut io).unwrap();
        assert_eq!(table.sysv_mapping_count_for(1), 2);
        assert_eq!(table.sysv_pid_count(), 1);

        assert!(table.drop_sysv_mapping(1, 0));
        assert!(table.sysv_mapping(1, 0).is_none());
        assert_eq!(table.sysv_mapping(1, 16).unwrap().seg_id, 9);
        assert_eq!(table.sysv_mapping_count_for(1), 1);

        // Dropping the last one retires the pid, so the host's cached
        // boundary predicate goes back to zero.
        assert!(table.drop_sysv_mapping(1, 16));
        assert!(!table.drop_sysv_mapping(1, 16));
        assert_eq!(table.sysv_pid_count(), 0);
        assert_eq!(table.sysv_mapping_count_for(1), 0);
    }

    #[test]
    fn attachments_are_listed_by_address_for_replay_and_rollback() {
        let mut io = MockIo::new().with_process(1, 64);
        io.shm.insert(7, vec![b'.'; 8]);
        io.shm.insert(9, vec![b'-'; 4]);
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 16, 9, 4, true, &mut io).unwrap();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();

        assert_eq!(
            table.sysv_attachments_for(1),
            vec![(0u64, 7i32, 8usize, false), (16u64, 9i32, 4usize, true)],
        );
        assert!(table.sysv_attachments_for(2).is_empty());
    }

    /// Recording stand-in for the kernel's own attachment accounting.
    struct MockAttachmentOps {
        /// seg_id -> size the attach reports, or `Err` to refuse.
        attach: BTreeMap<i32, Result<usize, Errno>>,
        /// seg_ids whose `record` refuses.
        refuse_record: BTreeSet<i32>,
        calls: Vec<String>,
    }

    impl MockAttachmentOps {
        fn new(sizes: &[(i32, usize)]) -> Self {
            Self {
                attach: sizes.iter().map(|(id, size)| (*id, Ok(*size))).collect(),
                refuse_record: BTreeSet::new(),
                calls: Vec::new(),
            }
        }
    }

    impl SysvAttachmentOps for MockAttachmentOps {
        fn attach(&mut self, pid: u32, seg_id: i32, _read_only: bool) -> Result<usize, Errno> {
            self.calls.push(alloc::format!("attach({pid},{seg_id})"));
            self.attach.get(&seg_id).copied().unwrap_or(Err(Errno::EINVAL))
        }

        fn record(&mut self, pid: u32, addr: u64, seg_id: i32, _size: usize) -> Result<(), Errno> {
            self.calls.push(alloc::format!("record({pid},{addr},{seg_id})"));
            if self.refuse_record.contains(&seg_id) {
                return Err(Errno::ESRCH);
            }
            Ok(())
        }

        fn detach_segment(&mut self, pid: u32, seg_id: i32) {
            self.calls.push(alloc::format!("detach_segment({pid},{seg_id})"));
        }

        fn detach_addr(&mut self, pid: u32, addr: u64) -> Result<(), Errno> {
            self.calls.push(alloc::format!("detach_addr({pid},{addr})"));
            Ok(())
        }
    }

    #[test]
    fn sysv_inheritance_attaches_records_and_mirrors_every_parent_segment() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEVENSEG".to_vec());
        io.shm.insert(9, b"NINE".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(1, 16, 9, 4, true, &mut io).unwrap();
        let mut ops = MockAttachmentOps::new(&[(7, 8), (9, 4)]);

        table.inherit_sysv_attachments(1, 2, &mut ops, &mut io).unwrap();

        assert_eq!(
            ops.calls,
            alloc::vec![
                "attach(2,7)".to_string(),
                "record(2,0,7)".to_string(),
                "attach(2,9)".to_string(),
                "record(2,16,9)".to_string(),
            ],
        );
        assert_eq!(table.sysv_mapping_count_for(2), 2);
        // The read-only flag rides along, so a child cannot publish through an
        // attachment its parent could only read.
        assert!(table.sysv_mapping(2, 16).unwrap().read_only);
        assert_eq!(io.peek(2, 0, 8), b"SEVENSEG".to_vec());
        assert_eq!(io.peek(2, 16, 4), b"NINE".to_vec());
    }

    #[test]
    fn a_refused_attach_unwinds_the_attachments_that_already_committed() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEVENSEG".to_vec());
        io.shm.insert(9, b"NINE".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(1, 16, 9, 4, false, &mut io).unwrap();
        let mut ops = MockAttachmentOps::new(&[(7, 8)]);
        ops.attach.insert(9, Err(Errno::ENOMEM));

        assert_eq!(
            table.inherit_sysv_attachments(1, 2, &mut ops, &mut io),
            Err(Errno::ENOMEM),
        );

        // The refused attach never incremented anything, so only the recorded
        // one is released -- by exact address, never by segment identity,
        // which would release an unrelated same-segment attachment.
        assert_eq!(
            ops.calls,
            alloc::vec![
                "attach(2,7)".to_string(),
                "record(2,0,7)".to_string(),
                "attach(2,9)".to_string(),
                "detach_addr(2,0)".to_string(),
            ],
        );
        assert_eq!(table.sysv_mapping_count_for(2), 0);
        assert_eq!(io.peek(2, 0, 8), vec![0u8; 8]);
    }

    #[test]
    fn an_attach_reporting_the_wrong_size_releases_its_own_attachment_first() {
        // A nonnegative attach already incremented nattch even when the size
        // disagrees with the parent's record, so it must be released by
        // segment identity: it has no address record to release it by.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEVENSEG".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        let mut ops = MockAttachmentOps::new(&[(7, 4)]);

        assert_eq!(
            table.inherit_sysv_attachments(1, 2, &mut ops, &mut io),
            Err(Errno::EIO),
        );
        assert_eq!(
            ops.calls,
            alloc::vec!["attach(2,7)".to_string(), "detach_segment(2,7)".to_string()],
        );
        assert_eq!(table.sysv_mapping_count_for(2), 0);
    }

    #[test]
    fn a_refused_record_releases_the_attachment_it_could_not_name() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEVENSEG".to_vec());
        io.shm.insert(9, b"NINE".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(1, 16, 9, 4, false, &mut io).unwrap();
        let mut ops = MockAttachmentOps::new(&[(7, 8), (9, 4)]);
        ops.refuse_record.insert(9);

        assert_eq!(
            table.inherit_sysv_attachments(1, 2, &mut ops, &mut io),
            Err(Errno::ESRCH),
        );
        assert_eq!(
            ops.calls,
            alloc::vec![
                "attach(2,7)".to_string(),
                "record(2,0,7)".to_string(),
                "attach(2,9)".to_string(),
                "record(2,16,9)".to_string(),
                "detach_segment(2,9)".to_string(),
                "detach_addr(2,0)".to_string(),
            ],
        );
        assert_eq!(table.sysv_mapping_count_for(2), 0);
    }

    #[test]
    fn a_child_that_cannot_hold_the_mirror_releases_every_attachment() {
        // The mirror is the last step. When it refuses -- here because the
        // child's memory is too small -- the attachments it was going to
        // describe must not survive it.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 4);
        io.shm.insert(7, b"SEVENSEG".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        let mut ops = MockAttachmentOps::new(&[(7, 8)]);

        assert_eq!(
            table.inherit_sysv_attachments(1, 2, &mut ops, &mut io),
            Err(Errno::EINVAL),
        );
        assert_eq!(
            ops.calls,
            alloc::vec![
                "attach(2,7)".to_string(),
                "record(2,0,7)".to_string(),
                "detach_addr(2,0)".to_string(),
            ],
        );
        assert_eq!(table.sysv_mapping_count_for(2), 0);
    }

    #[test]
    fn inheriting_from_a_parent_with_no_attachments_touches_nothing() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        let mut ops = MockAttachmentOps::new(&[]);

        table.inherit_sysv_attachments(1, 2, &mut ops, &mut io).unwrap();

        assert!(ops.calls.is_empty());
        assert_eq!(table.sysv_pid_count(), 0);
    }

    #[test]
    fn inheriting_into_a_child_that_already_owns_attachments_is_refused() {
        // The kernel entry point relies on this: a child whose mirror is
        // already populated would otherwise have its parent's attachments
        // merged over the top of its own.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        io.shm.insert(7, b"SEGMENTS".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(2, 0, 7, 8, false, &mut io).unwrap();

        assert_eq!(
            table.inherit_process_mappings(1, 2, &mut io),
            Err(Errno::EEXIST),
        );
    }

    #[test]
    fn inheritance_is_refused_when_the_child_memory_cannot_hold_the_attachment() {
        // The child's committed memory length is supplied by the caller. An
        // attachment that would not fit must fail before any child byte is
        // written, not be truncated.
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 4);
        io.shm.insert(7, b"SEGMENTS".to_vec());
        let mut table = SharedMappingTable::new();
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();

        assert_eq!(
            table.inherit_process_mappings(1, 2, &mut io),
            Err(Errno::EINVAL),
        );
        assert!(table.sysv_mapping(2, 0).is_none());
    }

    // -- teardown ----------------------------------------------------------

    #[test]
    fn teardown_publishes_then_drops_every_mapping() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec())
            .with_fd(1, 4, 10);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            backing.ref_count = 1;
        }
        let initial = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        io.write_process(1, 0, &initial).unwrap();
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), initial, 0),
        );

        io.poke(1, 0, b"FINALLLL");
        table.release_all_for_process(1, true, &mut io);

        assert_eq!(io.files[&10], b"FINALLLL".to_vec());
        assert!(table.mapping(1, 0).is_none());
        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained[&10], 0);
    }

    #[test]
    fn teardown_continues_past_a_backing_that_can_no_longer_be_written() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        io.shm.insert(7, vec![b'.'; 8]);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            backing.ref_count = 1;
        }
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), vec![b'.'; 8], 0),
        );
        table.track_sysv_mapping(1, 8, 7, 8, false, &mut io).unwrap();

        io.poke(1, 0, b"FILEDATA");
        io.fail_pwrite = true;
        table.release_all_for_process(1, true, &mut io);

        // The file backing keeps its dirty pages, but SysV cleanup still ran.
        assert!(table.sysv_mapping(1, 8).is_none());
        assert!(table.mapping(1, 0).is_none());
        assert!(table.file_backing(&key).is_some());
    }

    #[test]
    fn a_boundary_sync_is_a_no_op_for_a_process_with_no_shared_state() {
        let mut io = MockIo::new().with_process(1, 64);
        let mut table = SharedMappingTable::new();
        assert!(table.is_empty());
        table.synchronize_for_boundary(1, &mut io).unwrap();
    }

    // -- whole-lifecycle drives over a NON-EMPTY mixed table ---------------
    //
    // Every test above exercises one method over a table holding one kind of
    // backing. Production has never run any of them over a table holding
    // both: `inherit_process_mappings` is reached only over an empty map, and
    // `synchronize_for_boundary` is covered only by its `is_empty` early-out.
    // These drive the fork/sync/flush/remap/unmap/teardown sequence in order,
    // over one process holding an anonymous and a file mapping at once.

    /// pid 1 holding an anonymous `MAP_SHARED` at 0 and a file-backed one at
    /// 32, in a single table.
    fn mixed_table_for_one_process(io: &mut MockIo, key: &str) -> SharedMappingTable {
        let mut table = SharedMappingTable::new();
        // Seed the anonymous region before tracking so its snapshot is the
        // same filler the file backing carries. Publication is diff-against-
        // snapshot, so a byte differing from the snapshot *is* a write: with
        // a zero snapshot a `.` filler would itself read as a whole-range
        // write and each peer would clobber the other.
        io.poke(1, 0, b"........");
        table.track_anonymous_mapping(1, 0, 8, true, io).unwrap();

        let stat = io.stat_of(10);
        {
            let backing = table.get_or_create_file_backing(key, &stat, true, io).unwrap();
            // The backing is created with `ref_count: 0`; the mapping that
            // caused it takes its own reference. In the host this is
            // `prepareSharedMmapFromFile`'s `backing.refCount++`, and there is
            // no Rust counterpart for it yet — the mmap-from-file registration
            // path is part of the policy layer that has still to be written.
            // Doing it here is what the missing caller will do.
            backing.ref_count += 1;
        }
        let initial = table
            .file_backing_mut(key)
            .unwrap()
            .read_range(0, 8, io)
            .unwrap();
        io.write_process(1, 32, &initial).unwrap();
        table.insert_mapping(
            1,
            32,
            SharedMapping::file(3, 0, 8, true, true, String::from(key), initial, 0),
        );
        table
    }

    #[test]
    fn a_mixed_table_survives_the_whole_fork_lifecycle() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = mixed_table_for_one_process(&mut io, &key);

        // A boundary sync with the early-out no longer covering for it.
        assert!(!table.is_empty());
        table.synchronize_for_boundary(1, &mut io).unwrap();

        // fork(): one call inherits both kinds.
        table.inherit_process_mappings(1, 2, &mut io).unwrap();
        assert!(table.mapping(2, 0).is_some(), "anon mapping inherited");
        assert!(table.mapping(2, 32).is_some(), "file mapping inherited");

        // Disjoint writes in each process, through each kind.
        io.poke(1, 0, b"AAAA....");
        io.poke(2, 0, b"....BBBB");
        io.poke(1, 32, b"CCCC....");
        io.poke(2, 32, b"....DDDD");

        // Both peers must now be counted, or the sole-observer deferral
        // suppresses coherence between two live processes.
        assert_eq!(
            table.file_backing(&key).unwrap().ref_count,
            2,
            "fork left one reference per mapping"
        );

        table.synchronize_for_boundary(1, &mut io).unwrap();
        table.synchronize_for_boundary(2, &mut io).unwrap();
        table.synchronize_for_boundary(1, &mut io).unwrap();

        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec(), "anon, parent");
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec(), "anon, child");
        assert_eq!(io.peek(1, 32, 8), b"CCCCDDDD".to_vec(), "file, parent");
        assert_eq!(io.peek(2, 32, 8), b"CCCCDDDD".to_vec(), "file, child");

        // One flush spanning both mappings reaches the file.
        assert!(table.flush_mappings(1, 0, 64, &mut io));
        assert_eq!(io.files[&10], b"CCCCDDDD".to_vec());

        // Teardown, one process at a time.
        table.release_all_for_process(2, true, &mut io);
        assert!(table.mapping(2, 0).is_none());
        assert!(table.mapping(2, 32).is_none());
        table.release_all_for_process(1, true, &mut io);
        assert!(table.is_empty(), "the table drains once every process is gone");
    }

    #[test]
    fn a_file_backing_is_counted_per_mapping_across_fork_and_teardown() {
        // The accounting is split across three places: creation counts
        // nothing, `inherit_process_mappings` counts each inherited mapping,
        // and `release_mapping` discounts every mapping it drops. It balances
        // only if the registration path counts the mapping that created the
        // backing. If a future caller omits that, the count is one short for
        // the whole life of the mapping and the *first* process to exit takes
        // the backing to zero — flushing and closing the host handle while a
        // live peer still has the file mapped. Pin the invariant here so that
        // omission fails as a test rather than as a lost write.
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = mixed_table_for_one_process(&mut io, &key);

        assert_eq!(
            table.file_backing(&key).unwrap().ref_count,
            1,
            "the mapping that created the backing holds one reference"
        );

        table.inherit_process_mappings(1, 2, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);

        // The parent exits first. The backing must survive for the child.
        table.release_all_for_process(1, true, &mut io);
        let surviving = table
            .file_backing(&key)
            .expect("the child's mapping still holds the backing");
        assert_eq!(surviving.ref_count, 1);
        assert!(
            table.mapping(2, 32).is_some(),
            "the child's file mapping outlives its parent"
        );

        // Only the child's exit may close it.
        table.release_all_for_process(2, true, &mut io);
        assert!(table.file_backing(&key).is_none(), "last reference closed it");
    }

    #[test]
    fn an_address_reissued_after_unmap_gets_its_own_byte_store() {
        // `release_host_region` frees only bookkeeping, and the range it frees
        // is immediately reusable by the same `find_gap` allocator that
        // answers `mmap_anonymous`. A table keyed by address must not let a
        // departed tenant's backing answer for the new one.
        let mut io = MockIo::new().with_process(1, 64);
        let mut table = SharedMappingTable::new();

        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        io.poke(1, 0, b"OLDOLDOL");
        table.synchronize_for_boundary(1, &mut io).unwrap();
        let first = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();

        table.cleanup_mappings(1, 0, 8, &mut io);
        assert!(table.mapping(1, 0).is_none(), "unmap drops the entry");
        assert!(
            table.anon_backing(&first).is_none(),
            "the departed store is released, not orphaned"
        );

        // The allocator re-issues the same address.
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let second = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();
        assert_ne!(first, second, "the re-issued address gets its own store");
    }

    #[test]
    fn teardown_then_reuse_of_the_same_address_does_not_resurrect_a_mapping() {
        // The ordering hazard stated as a test: an address-space release
        // followed by a re-reservation at the same address, with the mapping
        // release in between.
        let mut io = MockIo::new().with_process(1, 64);
        let mut table = SharedMappingTable::new();

        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        table.release_all_for_process(1, true, &mut io);
        assert!(table.is_empty(), "teardown drained the process");

        // A pthread slot reserving the same address afterwards.
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        assert_eq!(
            table.mappings_for(1).count(),
            1,
            "exactly one live mapping at the re-issued address"
        );
    }

    #[test]
    fn a_remap_moves_a_file_mapping_without_disturbing_its_anon_neighbour() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = mixed_table_for_one_process(&mut io, &key);

        io.poke(1, 0, b"ANONANON");
        io.poke(1, 32, b"FILEFILE");
        table.flush_mappings(1, 0, 64, &mut io);

        // mremap the file mapping from 32 to 48.
        table.remap_mapping(1, 32, 48, 8, &mut io).unwrap();
        assert!(table.mapping(1, 32).is_none(), "old address released");
        assert!(table.mapping(1, 48).is_some(), "new address tracked");
        assert_eq!(io.peek(1, 48, 8), b"FILEFILE".to_vec(), "bytes moved");

        // The anonymous neighbour is untouched and still coherent.
        let anon = table.mapping(1, 0).expect("anon mapping still tracked");
        assert_eq!(anon.backing_kind, Some(BackingKind::Anonymous));
        assert_eq!(io.peek(1, 0, 8), b"ANONANON".to_vec());
    }

    #[test]
    fn a_partial_unmap_of_one_kind_leaves_the_other_kinds_mapping_intact() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = mixed_table_for_one_process(&mut io, &key);

        // Unmap the tail half of the anonymous mapping only.
        table.cleanup_mappings(1, 4, 4, &mut io);

        let anon = table
            .mapping(1, 0)
            .expect("head of the anon mapping survives");
        assert_eq!(anon.len, 4, "the surviving head is shortened");
        assert!(
            table.mapping(1, 32).is_some(),
            "the file mapping is not swept up by a neighbour's unmap"
        );
    }
}
