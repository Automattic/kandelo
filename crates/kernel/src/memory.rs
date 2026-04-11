extern crate alloc;
use alloc::vec::Vec;

/// Tracks a single mmap'd region.
#[derive(Debug, Clone)]
pub struct MappedRegion {
    pub addr: u32,    // start address in linear memory
    pub len: u32,     // length in bytes
    pub prot: u32,    // protection flags (tracked but not enforced)
    pub flags: u32,   // map flags
}

/// Kernel memory manager for mmap/munmap/brk.
pub struct MemoryManager {
    /// List of active mappings, kept sorted by address.
    mappings: Vec<MappedRegion>,
    /// Current program break (for brk).
    program_break: u32,
    /// Upper bound for mmap allocation (default 1GB = Wasm max-memory).
    max_addr: u32,
    /// RLIMIT_DATA soft limit (updated by setrlimit). u64::MAX = unlimited.
    data_limit: u64,
    /// Program break at process start, used to compute data segment growth.
    initial_brk: u32,
}

impl MemoryManager {
    /// Default mmap region starts at 64MB (0x04000000).
    /// This leaves room for stack and heap below (brk starts at 16MB).
    /// Programs like CPython need large contiguous mmap regions, so we
    /// keep MMAP_BASE low to maximize available space.
    const MMAP_BASE: u32 = 0x04000000;

    /// Default initial program break at 16MB.
    const INITIAL_BRK: u32 = 0x01000000;

    /// Default address space limit (1GB, matching --max-memory).
    const DEFAULT_MAX_ADDR: u32 = 0x40000000;

    pub fn new() -> Self {
        MemoryManager {
            mappings: Vec::new(),
            program_break: Self::INITIAL_BRK,
            max_addr: Self::DEFAULT_MAX_ADDR,
            data_limit: u64::MAX,
            initial_brk: Self::INITIAL_BRK,
        }
    }

    /// Read-only access to the mmap mappings (for fork serialization).
    pub fn mappings(&self) -> &[MappedRegion] {
        &self.mappings
    }

    /// Restore mmap mappings from fork (used by deserialize_fork_state).
    pub fn set_mappings(&mut self, mappings: Vec<MappedRegion>) {
        self.mappings = mappings;
    }

    /// Allocate an anonymous mapping. Returns the base address.
    /// If `hint` is non-zero and MAP_FIXED is set, maps at exactly that address
    /// (unmapping any overlapping regions first).
    pub fn mmap_anonymous(&mut self, hint: u32, len: u32, prot: u32, flags: u32) -> u32 {
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
            // Reject if the region extends past max_addr (protects thread TLS/channel pages)
            let end = hint.saturating_add(aligned_len);
            if end > self.max_addr {
                return wasm_posix_shared::mmap::MAP_FAILED;
            }
            self.mappings.retain(|m| {
                let m_end = m.addr.saturating_add(m.len);
                // Keep mappings that don't overlap [hint, end)
                m_end <= hint || m.addr >= end
            });
            hint
        } else {
            // Find first gap in [MMAP_BASE, max_addr) that fits aligned_len.
            // Mappings are kept sorted by address.
            match self.find_gap(aligned_len) {
                Some(a) => a,
                None => return wasm_posix_shared::mmap::MAP_FAILED,
            }
        };

        // Insert sorted by address
        let pos = self.mappings.partition_point(|m| m.addr < addr);
        self.mappings.insert(pos, MappedRegion {
            addr,
            len: aligned_len,
            prot,
            flags,
        });

        addr
    }

    /// Find the first gap in [MMAP_BASE, max_addr) that can fit `needed` bytes.
    fn find_gap(&self, needed: u32) -> Option<u32> {
        let mut cursor = Self::MMAP_BASE;
        for m in &self.mappings {
            if m.addr < Self::MMAP_BASE {
                continue;
            }
            if m.addr >= cursor {
                let gap = m.addr - cursor;
                if gap >= needed {
                    return Some(cursor);
                }
            }
            let end = m.addr.saturating_add(m.len);
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

    /// Unmap a region [addr, addr+len). Supports partial unmapping:
    /// - Exact match: removes the mapping entirely
    /// - Front trim: unmapping the beginning of a mapping shrinks it
    /// - Back trim: unmapping the end of a mapping shrinks it
    /// - Split: unmapping the middle of a mapping splits it into two
    /// Returns true if any overlap was found and handled.
    pub fn munmap(&mut self, addr: u32, len: u32) -> bool {
        if len == 0 {
            return false;
        }
        let unmap_end = addr.saturating_add(len);
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
    pub fn get_brk(&self) -> u32 {
        self.program_break
    }

    /// Set the program break. Returns the new break on success, or the
    /// current break unchanged on failure (limit exceeded).
    pub fn set_brk(&mut self, new_brk: u32) -> u32 {
        if new_brk == 0 {
            // Query current break
            return self.program_break;
        }
        // brk can't grow past mmap base (shared address space)
        if new_brk > Self::MMAP_BASE {
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
    pub fn is_mapped(&self, addr: u32) -> bool {
        self.mappings.iter().any(|m| addr >= m.addr && addr < m.addr + m.len)
    }

    /// Check if `len` bytes starting at `addr` are free (no overlap with existing mappings
    /// and within address space bounds).
    pub fn can_grow_at(&self, addr: u32, len: u32) -> bool {
        let end = match addr.checked_add(len) {
            Some(e) => e,
            None => return false,
        };
        if end > self.max_addr {
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

    /// Lower the upper bound for mmap allocation.
    /// Used by the host to cap allocations below the channel/TLS region.
    /// Only lowers the ceiling — never raises it — so that pre-computed safe
    /// values (accounting for all future thread allocations) are preserved.
    pub fn set_max_addr(&mut self, addr: u32) {
        if addr < self.max_addr {
            self.max_addr = addr;
        }
    }

    /// Extend an existing mapping at `addr` from `old_len` to `new_len`.
    /// The caller must ensure the space is free (via `can_grow_at`).
    pub fn extend_mapping(&mut self, addr: u32, old_len: u32, new_len: u32) {
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
        let addr = mm.mmap_anonymous(0, 0x30000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
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
        let addr = mm.mmap_anonymous(0, 0x30000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
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
        let addr = mm.mmap_anonymous(0, 0x30000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
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
        let addr = mm.mmap_anonymous(0, 0x40000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // Unmap 2 middle pages
        mm.munmap(addr + 0x10000, 0x20000);
        // New 2-page mmap should fill the gap
        let addr2 = mm.mmap_anonymous(0, 0x20000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_eq!(addr2, addr + 0x10000);
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
    fn test_brk_query() {
        let mm = MemoryManager::new();
        let brk = mm.get_brk();
        assert_eq!(brk, MemoryManager::INITIAL_BRK);
    }

    #[test]
    fn test_multiple_mmaps_non_overlapping() {
        let mut mm = MemoryManager::new();
        let addr1 = mm.mmap_anonymous(0, 0x20000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        let addr2 = mm.mmap_anonymous(0, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert!(addr2 >= addr1 + 0x20000); // Non-overlapping
        assert!(mm.is_mapped(addr1));
        assert!(mm.is_mapped(addr2));
    }

    #[test]
    fn test_mmap_fixed_at_address() {
        let mut mm = MemoryManager::new();
        let target = 0x20000000;
        let addr = mm.mmap_anonymous(target, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED);
        assert_eq!(addr, target);
        assert!(mm.is_mapped(target));
    }

    #[test]
    fn test_mmap_fixed_replaces_existing() {
        let mut mm = MemoryManager::new();
        let target = 0x20000000;
        // First mapping
        let addr1 = mm.mmap_anonymous(target, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED);
        assert_eq!(addr1, target);
        // Second mapping at same address replaces it
        let addr2 = mm.mmap_anonymous(target, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED);
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
                    a.addr, a_end, b.addr, b_end
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
        mm.munmap(b + 0x10000, 0x1f0000);  // front trim
        mm.munmap(b + 0x400000, 0xf000);   // back trim
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
        assert_ne!(problematic, b,
            "mmap returned MMAP_BASE which overlaps with existing mapping!");
        assert_no_overlaps(&mm);

        // Verify the original mapping at MMAP_BASE is still there
        assert!(mm.is_mapped(b),
            "mapping at MMAP_BASE should still exist");
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
}
