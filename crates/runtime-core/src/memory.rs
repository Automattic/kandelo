extern crate alloc;
use alloc::collections::BTreeMap;
#[cfg(test)]
use alloc::collections::BTreeSet;
use alloc::rc::Rc;
use alloc::string::String;
#[cfg(test)]
use alloc::vec;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use crate::IoBuffer;
use crate::prepared_map::{MapMemory, PreparedEntry, PreparedMap, PreparedMapSlot};

/// The object a file-backed mapping maps, as `/proc/<pid>/maps` reports it.
///
/// WHY recorded at `mmap` time: POSIX keeps a mapping valid after the
/// descriptor that created it is closed, so the descriptor cannot be
/// consulted later. Linux keeps the mapping's `struct file`; Kandelo keeps
/// the identity `fstat` reported for that descriptor and the name its
/// `/proc/<pid>/fd` link showed, so the maps line and a program's own
/// `fstat` agree. Shared by every fragment of one mapping (`munmap` and
/// `MAP_FIXED` splits), so splitting never copies the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappingFile {
    /// `st_dev` of the mapped object, encoded as the libc `makedev` does.
    pub dev: u64,
    /// `st_ino` of the mapped object.
    pub ino: u64,
    /// Pathname column, already in Linux's spelling for unlinked objects
    /// (for example `/memfd:name (deleted)`).
    pub name: Vec<u8>,
}

/// Rust-owned identity and resource authority for one opt-in device mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExactMappingIdentity {
    pub id: u64,
    pub source_file: u64,
    pub source_bo: Option<u32>,
}

/// Tracks a single mmap'd region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedRegion {
    pub addr: usize, // start address in linear memory
    pub len: usize,  // length in bytes
    pub prot: u32,   // protection flags requested at mmap (not enforced)
    pub flags: u32,  // map flags
    /// Byte offset into `file` that `addr` maps. Zero for anonymous memory.
    pub file_offset: u64,
    /// The mapped object for a file-backed mapping; `None` for anonymous
    /// memory.
    pub file: Option<Rc<MappingFile>>,
    /// Opt-in driver cleanup authority, independent of address and BO reuse.
    /// Ordinary mmap and the fork wire format carry no such authority.
    pub(crate) exact_mapping: Option<ExactMappingIdentity>,
}

impl MappedRegion {
    /// An anonymous region (no backing object).
    pub fn anonymous(addr: usize, len: usize, prot: u32, flags: u32) -> Self {
        MappedRegion {
            addr,
            len,
            prot,
            flags,
            file_offset: 0,
            file: None,
            exact_mapping: None,
        }
    }

    /// The file offset mapped at `addr + delta`, for a fragment that starts
    /// `delta` bytes into this region. Anonymous memory stays at zero, as
    /// Linux reports it.
    fn offset_after(&self, delta: usize) -> u64 {
        if self.file.is_some() {
            self.file_offset.saturating_add(delta as u64)
        } else {
            0
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    mappings: IoBuffer<MappedRegion>,
    last_exact_mapping_id: u64,
    /// Host-owned dynamic control ranges. These occupy process address space
    /// but are not guest mmap mappings and cannot be released by munmap.
    reserved_regions: IoBuffer<ReservedRegion>,
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
            mappings: IoBuffer::new(),
            reserved_regions: IoBuffer::new(),
            last_exact_mapping_id: 0,
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
    /// Whether any live mapping is `MAP_SHARED`. Such a process needs the
    /// host's shared-memory coherence step at every syscall boundary, so a
    /// result the kernel would publish directly must take the host's path.
    pub fn has_shared_mapping(&self) -> bool {
        self.mappings
            .iter()
            .any(|m| m.flags & wasm_posix_shared::mmap::MAP_SHARED != 0)
    }

    pub fn mappings(&self) -> &[MappedRegion] {
        &self.mappings
    }

    pub(crate) fn reserve_exact_mapping_id(&mut self) -> Result<u64, Errno> {
        let id = self.last_exact_mapping_id.checked_add(1).ok_or(Errno::ENOMEM)?;
        // Reservation is irreversible, including constructor rollback. No
        // tombstone is needed and a failed mapping can never lend its ID again.
        self.last_exact_mapping_id = id;
        Ok(id)
    }

    pub(crate) fn publish_exact_mapping(&mut self, addr: usize, identity: ExactMappingIdentity) {
        self.mappings.iter_mut().find(|mapping| mapping.addr == addr)
            .expect("admitted device mapping lost its VMA").exact_mapping = Some(identity);
    }

    pub(crate) fn exact_mapping_ranges(
        &self,
        id: u64,
        source_file: u64,
        source_bo: Option<u32>,
    ) -> Result<Vec<(usize, usize)>, Errno> {
        if id == 0 { return Err(Errno::EINVAL); }
        let mut ranges = Vec::new();
        ranges.try_reserve_exact(self.mappings.iter()
            .filter(|mapping| mapping.exact_mapping.is_some_and(|identity| identity.id == id))
            .count()).map_err(|_| Errno::ENOMEM)?;
        for mapping in &self.mappings {
            let Some(identity) = mapping.exact_mapping.filter(|identity| identity.id == id) else { continue; };
            if identity.source_file != source_file
                || source_bo.is_some_and(|bo| identity.source_bo != Some(bo)) {
                return Err(Errno::EACCES);
            }
            ranges.push((mapping.addr, mapping.addr.checked_add(mapping.len).ok_or(Errno::EINVAL)?));
        }
        Ok(ranges)
    }

    pub(crate) fn retire_exact_mapping_regions(&mut self, id: u64) {
        // All allocations and backing retirement were prepared before this
        // infallible publication. Address-matching replacements are untouched.
        self.mappings.retain(|mapping| !mapping.exact_mapping.is_some_and(|identity| identity.id == id));
    }

    pub(crate) fn inherit_exact_mapping_ids(&mut self, parent: &Self) {
        self.last_exact_mapping_id = parent.last_exact_mapping_id;
        for mapping in &mut self.mappings {
            mapping.exact_mapping = parent.mappings.iter()
                .find(|source| source.addr == mapping.addr && source.len == mapping.len)
                .and_then(|source| source.exact_mapping);
        }
    }

    pub fn reserved_regions(&self) -> &[ReservedRegion] {
        &self.reserved_regions
    }

    /// Restore mmap mappings from fork (used by deserialize_fork_state).
    pub fn set_mappings(&mut self, mut mappings: IoBuffer<MappedRegion>) {
        // Ordinary mmap/munmap mutations preserve address order. Restore that
        // invariant explicitly at the fork-state boundary so later first-fit
        // scans do not depend on serialized input order.
        mappings.sort_unstable_by_key(|mapping| mapping.addr);
        self.mappings = mappings;
    }

    /// Reserve metadata before an operation can replace live regions.
    pub(crate) fn reserve_mapping_slots(&mut self, additional: usize) -> Result<(), Errno> {
        self.mappings
            .try_reserve(additional)
            .map_err(|_| Errno::ENOMEM)
    }

    pub(crate) fn reserve_unmap_split(&mut self, addr: usize, len: usize) -> Result<(), Errno> {
        let end = addr.checked_add(len).ok_or(Errno::EINVAL)?;
        if self
            .mappings
            .iter()
            .any(|mapping| mapping.addr < addr && mapping.addr.saturating_add(mapping.len) > end)
        {
            self.reserve_mapping_slots(1)?;
        }
        Ok(())
    }

    /// Restore an owned, already sorted snapshot after rejected device admission.
    /// Sorting or allocating during rollback could itself lose the old mapping.
    pub(crate) fn restore_mapping_snapshot(&mut self, mappings: IoBuffer<MappedRegion>) {
        debug_assert!(mappings.windows(2).all(|pair| pair[0].addr <= pair[1].addr));
        self.mappings = mappings;
    }

    fn mapping_count_after_unmap(&self, addr: usize, len: usize) -> Result<usize, Errno> {
        let end = addr.saturating_add(len);
        let mut remaining = self.mappings.len();
        if len != 0 {
            for mapping in &self.mappings {
                let mapping_end = mapping.addr.saturating_add(mapping.len);
                if mapping_end <= addr { continue; }
                if mapping.addr >= end { break; }
                if mapping.addr >= addr && mapping_end <= end {
                    remaining -= 1;
                } else if mapping.addr < addr && mapping_end > end {
                    remaining = remaining.checked_add(1).ok_or(Errno::ENOMEM)?;
                }
            }
        }
        Ok(remaining)
    }

    fn prepare_mapping_change(&mut self, addr: usize, len: usize, additional: usize) -> Result<(), Errno> {
        let capacity = self.mapping_count_after_unmap(addr, len)?
            .max(self.mappings.len()).checked_add(additional).ok_or(Errno::ENOMEM)?;
        self.mappings.try_reserve(capacity - self.mappings.len())
    }

    pub(crate) fn prepare_munmap(&mut self, addr: usize, len: usize) -> Result<(), Errno> {
        self.prepare_mapping_change(addr, len, 0)
    }

    pub(crate) fn prepare_mremap_move(&mut self, addr: usize, len: usize) -> Result<(), Errno> {
        self.prepare_mapping_change(addr, len, 1)
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

        let fixed = hint != 0 && (flags & MAP_FIXED) != 0;
        let addr = if fixed {
            // MAP_FIXED: use the exact address, carving the range out of any
            // overlapping mappings. A fixed map over part of a mapping splits
            // it and keeps the remainder mapped, as munmap does — dropping the
            // whole mapping would let a later first-fit hand out addresses the
            // program still uses.
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
            let required = match self.mapping_count_after_unmap(hint, aligned_len)
                .and_then(|count| count.checked_add(1).ok_or(Errno::ENOMEM)) {
                Ok(required) => required.max(self.mappings.len()),
                Err(_) => return wasm_posix_shared::mmap::MAP_FAILED,
            };
            if self.mappings.try_reserve(required - self.mappings.len()).is_err() {
                return wasm_posix_shared::mmap::MAP_FAILED;
            }
            self.munmap_prepared(hint, aligned_len);
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
            let addr = match hinted_addr.or_else(|| self.find_gap(aligned_len)) {
                Some(a) => a,
                None => return wasm_posix_shared::mmap::MAP_FAILED,
            };
            if self.mappings.try_reserve(1).is_err() {
                return wasm_posix_shared::mmap::MAP_FAILED;
            }
            addr
        };

        // Both branches already admitted the complete final mapping count;
        // MAP_FIXED also carved the old range after that admission. Reserving
        // or unmapping again here could fail after losing the original VMA.
        // Insert sorted by address
        let pos = self.mappings.partition_point(|m| m.addr < addr);
        self.mappings.insert(pos, MappedRegion::anonymous(addr, aligned_len, prot, flags));

        addr
    }

    /// Record the object a fresh mapping at exactly `addr` maps, and the file
    /// offset at `addr`. Returns whether a mapping starts at `addr`.
    pub fn set_mapping_file(&mut self, addr: usize, file_offset: u64, file: Rc<MappingFile>) -> bool {
        match self.mappings.iter_mut().find(|m| m.addr == addr) {
            Some(mapping) => {
                mapping.file_offset = file_offset;
                mapping.file = Some(file);
                true
            }
            None => false,
        }
    }

    /// Copy each mapping's backing object from the live parent at `fork`.
    ///
    /// WHY not serialized: fork state carries the address layout, and the
    /// child's mappings are exactly the parent's. The backing object is a
    /// shared reference, as Linux's child VMAs share the parent's `struct
    /// file`, so it is taken from the parent rather than re-encoded.
    pub fn inherit_mapping_files(&mut self, parent: &[MappedRegion]) {
        for mapping in &mut self.mappings {
            if let Some(source) = parent
                .iter()
                .find(|p| p.addr == mapping.addr && p.len == mapping.len)
            {
                mapping.file_offset = source.file_offset;
                mapping.file = source.file.clone();
            }
        }
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
    pub fn munmap(&mut self, addr: usize, len: usize) -> Result<bool, Errno> {
        if len == 0 {
            return Ok(false);
        }
        let aligned_len = match len.checked_add(0xFFFF) {
            Some(value) => value & !0xFFFF,
            None => return Ok(false),
        };
        self.prepare_munmap(addr, aligned_len)?;
        Ok(self.munmap_prepared(addr, aligned_len))
    }

    fn munmap_prepared(&mut self, addr: usize, aligned_len: usize) -> bool {
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
                    // The surviving tail still maps the same file bytes it
                    // did, so its offset advances with its start address.
                    let offset = self.mappings[i].offset_after(unmap_end - m_addr);
                    self.mappings[i].addr = unmap_end;
                    self.mappings[i].len = m_end - unmap_end;
                    self.mappings[i].file_offset = offset;
                    break;
                }
                (true, true) => {
                    let right = MappedRegion {
                        addr: unmap_end,
                        len: m_end - unmap_end,
                        prot: self.mappings[i].prot,
                        flags: self.mappings[i].flags,
                        file_offset: self.mappings[i].offset_after(unmap_end - m_addr),
                        file: self.mappings[i].file.clone(),
                        exact_mapping: self.mappings[i].exact_mapping,
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
        if self.reserved_regions.try_reserve(1).is_err() {
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

        if self.reserved_regions.try_reserve(1).is_err() {
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
        MappedRegion::anonymous(addr, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS)
    }

    #[test]
    fn exact_mapping_counter_exhaustion_never_wraps_or_reuses_a_failed_reservation() {
        let mut parent = MemoryManager::new();
        assert_eq!(parent.reserve_exact_mapping_id(), Ok(1));
        let mut child = MemoryManager::new();
        child.inherit_exact_mapping_ids(&parent);
        assert_eq!(child.reserve_exact_mapping_id(), Ok(2));
        parent.last_exact_mapping_id = u64::MAX;
        assert_eq!(parent.reserve_exact_mapping_id(), Err(Errno::ENOMEM));
        child.inherit_exact_mapping_ids(&parent);
        assert_eq!(child.reserve_exact_mapping_id(), Err(Errno::ENOMEM));
    }

    #[test]
    fn mapping_refusal_precedes_fixed_replacement_or_split() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let page = 0x10000;
        let base = MemoryManager::MMAP_BASE;
        let mut manager = MemoryManager::new();
        manager.set_mappings(IoBuffer::try_adopt(vec![mapped_region(base, 4 * page)]).unwrap());
        let original = manager.mappings[0].clone();
        {
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(manager.mmap_anonymous(0, page, 3, MAP_PRIVATE | MAP_ANONYMOUS), MAP_FAILED);
            assert_eq!(manager.mmap_anonymous(base + page, page, 1, MAP_FIXED | MAP_ANONYMOUS), MAP_FAILED);
            assert_eq!(manager.munmap(base + page, page), Err(Errno::ENOMEM));
            assert_eq!(manager.mappings(), &[original]);
            assert_eq!(manager.reserve_host_region(page), MAP_FAILED);
            assert_eq!(manager.reserve_host_region_at(base + 8 * page, page), MAP_FAILED);
            assert!(manager.reserved_regions().is_empty());
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            assert_eq!(manager.mmap_anonymous(base, 4 * page, 1, MAP_FIXED | MAP_ANONYMOUS), base);
            assert_eq!(manager.mappings.len(), 1);
            assert_eq!(manager.mappings[0].prot, 1);
            assert!(manager.munmap(base, page).unwrap());
            assert!(manager.munmap(base + 3 * page, page).unwrap());
            assert!(manager.munmap(base + page, 2 * page).unwrap());
            assert!(manager.mappings().is_empty());
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        }
        drop(manager);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn mapping_split_admits_exact_growth_when_geometric_headroom_is_unavailable() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let page = 0x10000;
        let base = MemoryManager::MMAP_BASE;
        let record_bytes = core::mem::size_of::<MappedRegion>();
        for fixed in [false, true] {
            let mut manager = MemoryManager::new();
            manager.set_mappings(IoBuffer::try_adopt(vec![mapped_region(base, 4 * page)]).unwrap());
            let required = if fixed { 3 } else { 2 };
            {
                let _limit = crate::io_buffer::test_budget(baseline + 2 * record_bytes * (1 + required));
                if fixed {
                    assert_eq!(manager.mmap_anonymous(base + page, page, 1, MAP_FIXED | MAP_ANONYMOUS), base + page);
                } else {
                    assert!(manager.munmap(base + page, page).unwrap());
                }
                assert_eq!(manager.mappings.capacity(), required);
                assert_eq!(manager.mappings.len(), required);
                assert_eq!(manager.mappings[0].addr, base);
                assert_eq!(manager.mappings[0].len, page);
                assert_eq!(manager.mappings[required - 1].addr, base + 2 * page);
                assert_eq!(manager.mappings[required - 1].len, 2 * page);
                assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline + 2 * record_bytes * required);
            }
            drop(manager);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn fixed_replacement_reuses_full_mapping_arena_without_admission() {
        let page = 0x10000;
        let base = MemoryManager::MMAP_BASE;
        let mut manager = MemoryManager::new();
        manager.set_mappings(IoBuffer::try_adopt(vec![
            mapped_region(base, page),
            mapped_region(base + page, page),
            mapped_region(base + 2 * page, page),
            mapped_region(base + 3 * page, page),
        ]).unwrap());
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(held);
        assert_eq!(manager.mmap_anonymous(base, 4 * page, 1, MAP_FIXED | MAP_ANONYMOUS), base);
        assert_eq!(manager.mappings.len(), 1);
        assert_eq!(manager.mappings[0].len, 4 * page);
        assert_eq!(manager.mappings.capacity(), 4);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
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
        assert!(mm.munmap(addr, 0x10000).unwrap());
        assert!(!mm.is_mapped(addr));
    }

    #[test]
    fn test_munmap_nonexistent() {
        let mut mm = MemoryManager::new();
        assert!(!mm.munmap(0xDEAD0000, 4096).unwrap());
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
        assert!(mm.munmap(addr, 0x10000).unwrap());
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
        assert!(mm.munmap(addr + 0x20000, 0x10000).unwrap());
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
        assert!(mm.munmap(addr + 0x10000, 0x10000).unwrap());
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
        mm.munmap(addr + 0x10000, 0x20000).unwrap();
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
            mm.set_mappings(IoBuffer::try_adopt(mappings).unwrap());
            mm.reserved_regions = IoBuffer::try_adopt(reserved_regions).unwrap();
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
                        mm.set_mappings(IoBuffer::try_adopt(vec![mapped_region(
                            base - page + mapping_slot * page,
                            mapping_pages * page,
                        )]).unwrap());
                        mm.reserved_regions = IoBuffer::try_adopt(vec![ReservedRegion {
                            addr: base - page + reserved_slot * page,
                            len: reserved_pages * page,
                        }]).unwrap();

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

        mm.set_mappings(IoBuffer::try_adopt(vec![
            mapped_region(base + 2 * page, page),
            mapped_region(base, page),
        ]).unwrap());

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

        assert!(mm.munmap(addr, 0x10001).unwrap());
        assert!(!mm.is_mapped(addr));
        assert!(!mm.is_mapped(addr + 0x10000));
        assert_eq!(mm.mmap_anonymous(0, 0x20000, rw, anon), addr);
    }

    #[test]
    fn test_munmap_does_not_rebuild_mapping_vec_for_middle_removal() {
        let mut mm = MemoryManager::new();
        mm.mappings.try_reserve(16).unwrap();
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

        assert!(mm.munmap(second, 0x10000).unwrap());

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
        mm.munmap(b + 0x10000, 0x200000).unwrap();
        assert_no_overlaps(&mm);

        // 4MB alloc then partial unmaps (musl pattern)
        let a = mm.mmap_anonymous(0, 0x3ff000, rw, anon);
        assert_eq!(a, b + 0x10000);
        mm.munmap(b + 0x10000, 0x1f0000).unwrap(); // front trim
        mm.munmap(b + 0x400000, 0xf000).unwrap(); // back trim
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
        mm.munmap(b + 0x170000, 0x10000).unwrap();
        let a = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert_eq!(a, b + 0x170000);
        mm.munmap(b + 0x170000, 0x10000).unwrap();
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
        mm.munmap(b + 0x150000, 0x10000).unwrap();
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
        mm.munmap(a, 0x200000).unwrap();
        let a2 = mm.mmap_anonymous(0, 0x3f0000, rw, anon);
        mm.munmap(a2, 0x1f0000).unwrap();
        let _a3 = mm.mmap_anonymous(0, 0x200000, rw, anon);
        assert_no_overlaps(&mm);

        // WPS:133
        let _a4 = mm.mmap_anonymous(0, 0x40000, rw, anon);
        let _a5 = mm.mmap_anonymous(0, 0x40000, rw, anon);
        assert_no_overlaps(&mm);

        // After SHORTINIT — another musl pattern
        let a6 = mm.mmap_anonymous(0, 0x200000, rw, anon);
        mm.munmap(a6, 0x200000).unwrap();
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
    fn test_map_fixed_inside_mapping_splits_it() {
        let mut mm = MemoryManager::new();
        let rw = PROT_READ | PROT_WRITE;
        let anon = MAP_PRIVATE | MAP_ANONYMOUS;

        let base = mm.mmap_anonymous(0, 0x40000, rw, anon);
        assert_ne!(base, MAP_FAILED);

        let fixed = mm.mmap_anonymous(base + 0x10000, 0x10000, PROT_NONE, MAP_FIXED | anon);
        assert_eq!(fixed, base + 0x10000);

        assert!(mm.is_mapped(base));
        assert!(mm.is_mapped(base + 0x20000));
        assert!(mm.is_mapped(base + 0x30000));

        let other = mm.mmap_anonymous(0, 0x10000, rw, anon);
        assert!(other >= base + 0x40000);
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
//   1. **publish** (a *pull* when done for another process) — diff the
//      mapping's bytes in the process against the per-mapping `snapshot` and
//      merge only the changed byte *runs* into the authoritative backing,
//      bumping the backing `version`;
//   2. **refresh** — when the mapping has not seen the backing's current
//      version, read the authoritative range back, write the runs that
//      differ into the process, and advance `snapshot`/`seen_version`
//      together.
//
// For files the kernel owns, step 1 runs when a mapping can be observed --
// a peer's syscall completion, descriptor I/O on the file, a new mapper, and
// the forced points -- not at every boundary of its own process, and is
// skipped when the host proves the process has not run since its last pull
// (`SharedMappingTable::sync_file_at_completion`, `CleanStamp`).
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
// Reentrancy: the host's TypeScript implementation of the host-owned halves
// re-verifies, after every host call, that the backing it staged bytes for is
// still the same object registered under the same key, because a host
// callback can re-enter the worker and mutate its tables mid-operation. Rust's
// `&mut` borrows make that class of interleaving unrepresentable here, so
// those checks are absent by construction rather than by omission.

/// Page granularity of the file-backing cache.
pub const FILE_PAGE_SIZE: usize = 4096;

/// `st_mode` file-type mask and the regular-file type.
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;

/// The subset of `struct stat` the mapping layer needs, plus the stable handle
/// a backing reads and writes through. `host_handle == None` marks an object
/// with no stable handle at all, which cannot anchor a backing.
///
/// The field keeps its name from the host-file half of this protocol, but in
/// the kernel it also carries a *kernel mapping handle*
/// (`crate::kernel_file_mapping`): the stable name of a file the kernel owns
/// itself (rootfs, tmpfs, memfd), which the kernel reads and writes directly.
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
/// Process read/write operations cross to the host through byte-copy imports;
/// the Wasm backend can also compare a process range with its Rust-owned
/// snapshot before allocating a copy. Each process owns a separate linear
/// memory the kernel cannot address. Everything else —
/// positional file access and identity on a kernel mapping handle, SysV
/// segment access, handle retention, diagnostics — is an in-kernel operation
/// the kernel already owns; it appears here as a trait only so the protocol is
/// unit-testable without a kernel instance.
pub trait SharedMappingIo {
    /// Copy `dst.len()` bytes out of process `pid`'s linear memory at `addr`.
    fn read_process(&mut self, pid: u32, addr: u64, dst: &mut [u8]) -> Result<(), Errno>;
    /// Return an independent, fully initialized snapshot of `len` process bytes.
    /// The default preserves safe initialized-slice implementations. A trusted
    /// synchronous full-write backend may override this without first zeroing
    /// the allocation; an error must never publish partial bytes.
    fn read_process_owned(&mut self, pid: u32, addr: u64, len: usize) -> Result<IoBuffer<u8>, Errno> {
        if len == 0 {
            return Ok(IoBuffer::new());
        }
        let mut bytes = IoBuffer::try_filled(len, 0)?;
        self.read_process(pid, addr, &mut bytes)?;
        Ok(bytes)
    }
    /// Read one complete process range only when it differs from `snapshot`.
    /// `None` means this observation found no local publication; it must not
    /// suppress authoritative backing refresh. Only a quiescence proof may
    /// carry it forward ([`CleanStamp`]).
    /// The default performs the same full read before comparing. A backend
    /// may compare in place, but must validate the entire source and snapshot
    /// ranges, return errors rather than partial bytes, and retain no views.
    fn read_process_if_changed(
        &mut self,
        pid: u32,
        addr: u64,
        len: usize,
        snapshot: &[u8],
    ) -> Result<Option<IoBuffer<u8>>, Errno> {
        if len == 0 {
            return Ok(None);
        }
        let current = self.read_process_owned(pid, addr, len)?;
        if snapshot.len() == len && !range_differs_from_snapshot(&current, snapshot) {
            Ok(None)
        } else {
            Ok(Some(current))
        }
    }
    /// Compare without allocating a replacement snapshot. None means the
    /// backend has no comparator; callers must use their bounded read path.
    /// A comparison is only this observation, never a future quiescence proof.
    fn process_differs_from_snapshot(
        &mut self, _pid: u32, _addr: u64, _len: usize, _snapshot: &[u8],
    ) -> Result<Option<bool>, Errno> { Ok(None) }
    /// Copy `src` into process `pid`'s linear memory at `addr`.
    fn write_process(&mut self, pid: u32, addr: u64, src: &[u8]) -> Result<(), Errno>;
    /// Current size of process `pid`'s linear memory, or `None` if it is gone.
    fn process_memory_len(&mut self, pid: u32) -> Option<u64>;

    fn process_memory_len_with_extent(&mut self, pid: u32, _mapped_extent: u64) -> Option<u64> {
        self.process_memory_len(pid)
    }

    /// Positional read from a stable handle. Returns bytes read; a return of 0
    /// for a non-empty request is a short read and is an error to the caller,
    /// because zero-filling would manufacture data.
    fn pread(&mut self, handle: i64, offset: u64, dst: &mut [u8]) -> Result<usize, Errno>;
    /// Positional write to a stable handle. Returns bytes written.
    fn pwrite(&mut self, handle: i64, offset: u64, src: &[u8]) -> Result<usize, Errno>;
    /// `fstat` a stable handle.
    fn fstat_handle(&mut self, handle: i64) -> Result<SharedMappingStat, Errno>;
    /// A counter that changes whenever the object's bytes or size change by
    /// any path, or `None` when the environment cannot observe every writer.
    ///
    /// The kernel can answer this for a file it owns, because every write,
    /// truncation and `O_TRUNC` open of such a file runs in the kernel. A
    /// backing that has a generation reconciles with descriptor I/O by
    /// comparing it at each publication point, instead of needing a hook in
    /// every file syscall. A host file has writers outside the kernel, so it
    /// answers `None`.
    fn content_generation(&mut self, _handle: i64) -> Option<u64> {
        None
    }
    /// Backend-qualified identity for a handle, derived from the live handle
    /// and never from a pathname. `None` means the backend cannot name the
    /// object stably, which makes it ineligible for a shared backing.
    fn handle_identity(&mut self, handle: i64, dev: u64, ino: u64) -> Option<String>;
    /// Keep the object behind a handle alive for as long as a backing
    /// references it. POSIX: `mmap` adds a reference to the file that a later
    /// `close` of the descriptor does not remove, and an unlinked file stays
    /// readable through its mappings.
    fn retain_handle(&mut self, handle: i64) -> Result<(), Errno>;
    fn release_handle(&mut self, handle: i64);

    /// Read from a SysV shared-memory segment the kernel owns.
    fn shm_read(&mut self, seg_id: i32, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;
    /// Write into a SysV shared-memory segment the kernel owns.
    fn shm_write(&mut self, seg_id: i32, offset: u64, src: &[u8]) -> Result<(), Errno>;

    /// Report a refused or failed writeback of the file whose backing key is
    /// `file_key`, so the loss is never silent: record it, and make every
    /// open file description of that file report `EIO` once from its next
    /// `fsync`, `fdatasync` or `close` (Linux errseq semantics; see
    /// `crate::writeback_loss::note_file_writeback_error`).
    fn report_writeback_loss(&mut self, pid: u32, map_addr: u64, file_key: &str, reason: &str);

    /// The process's *mutation epoch* if it is provably quiescent now, or
    /// `None`. See [`CleanStamp`] for the contract.
    ///
    /// `Some(e)` promises: no guest code of `pid` (any thread, or a vfork
    /// child borrowing its memory) is running, and `e` changes before any
    /// of it can run again and whenever the host writes the process's
    /// memory. The default never proves quiescence, so every pull compares.
    fn quiescent_epoch(&mut self, _pid: u32) -> Option<u64> {
        None
    }

    /// [`KernelProcessWriteLog::position`] of the kernel's own writes into
    /// process memory, for [`CleanStamp::log_position`].
    fn kernel_write_position(&mut self) -> u64 {
        0
    }

    /// [`KernelProcessWriteLog::wrote_since`]: whether the kernel wrote any
    /// byte of `[addr, addr + len)` of `pid` since `since`, `None` when
    /// unknown.
    fn kernel_wrote_since(&mut self, _pid: u32, _since: u64, _addr: u64, _len: u64) -> Option<bool> {
        None
    }
}

/// The backing key for a file object, or `None` when it has no stable
/// identity.
///
/// This is the **one** place a backing key is formatted. Every producer and
/// every consumer must come through here, because a key computed two ways is
/// the worst failure this subsystem has available: a lookup that formats a key
/// no backing holds answers "nothing maps that file", which is the common case
/// and therefore indistinguishable from correct behaviour. The whole coherence
/// layer would run and do nothing, with every test green.
///
/// # `st_ino == 0` is a backend declaration, not a quirk
///
/// A backend that cannot promise stable object identity reports `st_ino = 0`.
/// That is the contract, written on the `PlatformIO` backend interface in
/// `host/src/types.ts`, and this is the kernel side that consumes it. It is
/// load-bearing across the host/kernel boundary rather than an incidental
/// sanity check, which is why it is stated as a rule in both places instead of
/// being left as two predicates that happen to agree.
///
/// The refusal used to require `dev == 0 && ino == 0` here while the host
/// refused whenever `ino` was not positive. A backend reporting a real device
/// and no inode — `dev=7, ino=0` — was therefore refused by the host and
/// accepted here, which answered `"dev:7:ino:0"` and collapsed every file in
/// that mount onto one shared backing. The host turns a refused identity into
/// `ENOTSUP`, so the `mmap` fails; this side turned the same input into silent
/// cross-file aliasing.
///
/// The host also refuses a negative `dev`. That has no counterpart here and
/// must not grow one: `dev` is `u64`, so the branch could never be taken.
///
/// # `dev` must already be qualified
///
/// The host's key carries a backend qualifier (`vfs:{backendId}:{dev}:{ino}`)
/// and this one does not. That is safe only because `VirtualFileSystem`'s
/// `qualifyStat` keys its device map on the backend *object* and hands out
/// globally unique device ids, so alias mounts agree and distinct backend
/// instances cannot collide. Every `dev` reaching this function must be such a
/// qualified device number. A backend-local `dev` read straight from a mount
/// would let two files in two different directories alias onto one backing.
pub fn file_identity_key(dev: u64, ino: u64) -> Option<String> {
    if ino == 0 {
        return None;
    }
    Some(alloc::format!("dev:{dev}:ino:{ino}"))
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
    pages: PreparedMap<u64, IoBuffer<u8>>,
    dirty_pages: PreparedMap<u64, DirtyFilePage>,
    pub ref_count: u32,
    pub version: u64,
    /// The object's [`SharedMappingIo::content_generation`] as of the last
    /// time this cache was known to agree with it, or `None` for an object
    /// with no generation. A different live value means descriptor I/O
    /// changed the file, so cached pages and mapped snapshots are stale.
    source_generation: Option<u64>,
}

#[derive(Debug)]
struct DirtyFilePage {
    bytes: [u64; FILE_PAGE_SIZE / 64],
    stale: bool,
}

impl MapMemory for DirtyFilePage {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl DirtyFilePage {
    fn new() -> Self { Self { bytes: [0; FILE_PAGE_SIZE / 64], stale: false } }

    fn contains(&self, offset: usize) -> bool {
        self.bytes[offset / 64] & (1u64 << (offset % 64)) != 0
    }

    fn set(&mut self, start: usize, end: usize, dirty: bool) {
        for offset in start..end {
            let bit = 1u64 << (offset % 64);
            if dirty { self.bytes[offset / 64] |= bit; }
            else { self.bytes[offset / 64] &= !bit; }
        }
    }

    fn is_empty(&self) -> bool { self.bytes.iter().all(|word| *word == 0) }
}

/// Host-owned byte store for an anonymous `MAP_SHARED` region.
#[derive(Debug)]
pub struct AnonymousBacking {
    pub key: String,
    pub bytes: IoBuffer<u8>,
    pub ref_count: u32,
    pub version: u64,
}

/// When a mapping's process bytes were last seen equal to its snapshot
/// while the process was provably quiescent.
///
/// # Why a pull may skip a comparison
///
/// Process bytes under a kernel-owned mapping can change in three ways:
///
/// 1. guest code of the process runs: one of its threads, a signal handler
///    (which runs after a syscall completes), or a vfork child borrowing its
///    memory;
/// 2. the host writes them: a syscall's output bytes, or anything a
///    host-handled syscall stores directly into guest buffers, all of which
///    land before the completion is materialized; or a write the kernel asks
///    for through `host_proc_write_bytes`. The host's other writes into
///    guest memory -- the syscall channel, refreshes of host-owned shared
///    mappings, DRI buffer bindings -- target those regions' own address
///    ranges, and an address range belongs to one mapping at a time;
/// 3. the kernel writes them through `HostIO::proc_write_bytes`, which
///    [`KernelProcessWriteLog`] records.
///
/// The host keeps a *mutation epoch* per process memory and changes it at
/// every event of kinds 1 and 2: a published syscall completion (the only
/// way a parked thread resumes), a materialized completion (whose effects
/// land even while a stopped process's completion stays parked),
/// a registered process or attached thread, a kernel-published wait
/// completion, and every `host_proc_write_bytes`. It reports the epoch
/// ([`SharedMappingIo::quiescent_epoch`]) only while every thread channel of
/// the process sits at `CH_PENDING` (each thread is parked in a syscall; a
/// thread that has not made its first syscall has an idle channel) and no
/// other registration shares the memory. A parked thread runs only the
/// syscall glue's wait loop, which stores nothing inside any mapping.
///
/// So if a pull read the mapping while the process was quiescent at epoch
/// `e`, found it equal to the snapshot (or adopted what it read as the
/// snapshot), and the process is again quiescent at the same `e` with no
/// kernel write into the range since, the bytes still equal the snapshot.
/// Comparing them again cannot find a change, and skipping is exactly the
/// comparison's result.
///
/// The channel status is read with a sequentially consistent load before
/// the comparison reads memory, and the guest's `CH_PENDING` store is
/// sequentially consistent and follows every store it made, so a pull that
/// sees the process parked also sees every byte it stored before parking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanStamp {
    /// The process's mutation epoch at that observation.
    pub epoch: u64,
    /// [`KernelProcessWriteLog::position`] at that observation.
    pub log_position: u64,
}

/// Whether a pull whose comparison a [`CleanStamp`] proves redundant may
/// skip it.
///
/// A kernel built with the `shared-mapping-proof-verify` feature only
/// *checks* the proof (shadow mode): the comparison runs anyway, and a
/// proved-unchanged mapping found changed is a fatal kernel fault, because it
/// means an epoch event was missed and skipping would have lost a store.
/// That build runs over every mapping test and a desktop session as the
/// evidence for skipping.
const SKIP_PROVED_PULLS: bool = !cfg!(feature = "shared-mapping-proof-verify");

#[cfg(feature = "shared-mapping-proof-verify")]
static PROOFS_VERIFIED: core::sync::atomic::AtomicU64 = core::sync::atomic::AtomicU64::new(0);

/// How many pulls a quiescence proof covered and a comparison confirmed, in a
/// kernel built with the `shared-mapping-proof-verify` feature (a
/// diagnostic, never part of a shipped kernel).
#[cfg(feature = "shared-mapping-proof-verify")]
pub fn proofs_verified() -> u64 {
    PROOFS_VERIFIED.load(core::sync::atomic::Ordering::Relaxed)
}

impl MapMemory for AnonymousBacking {
    fn heap_bytes(&self) -> Result<usize, Errno> { self.key.heap_bytes() }
}

impl MapMemory for FileBacking {
    fn heap_bytes(&self) -> Result<usize, Errno> { self.key.heap_bytes() }
}

fn copy_mapping_key(key: &str) -> Result<String, Errno> {
    let mut result = String::new();
    result.try_reserve_exact(key.len()).map_err(|_| Errno::ENOMEM)?;
    result.push_str(key);
    Ok(result)
}

#[derive(Debug)]
struct ProcessMappings<Mapping> {
    entries: PreparedMap<u64, Mapping>,
    releasing: bool,
}

impl<Mapping> ProcessMappings<Mapping> {
    const fn new(entries: PreparedMap<u64, Mapping>) -> Self { Self { entries, releasing: false } }
}

impl<Mapping> MapMemory for ProcessMappings<Mapping> {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl<Mapping> core::ops::Deref for ProcessMappings<Mapping> {
    type Target = PreparedMap<u64, Mapping>;
    fn deref(&self) -> &Self::Target { &self.entries }
}

impl<Mapping> core::ops::DerefMut for ProcessMappings<Mapping> {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.entries }
}

impl<'a, Mapping> IntoIterator for &'a ProcessMappings<Mapping> {
    type Item = (&'a u64, &'a Mapping);
    type IntoIter = crate::prepared_map::MapIter<'a, u64, Mapping>;
    fn into_iter(self) -> Self::IntoIter { self.entries.iter() }
}

/// One tracked `MAP_SHARED` interval of one process.
#[derive(Debug)]
#[cfg_attr(test, derive(Clone))]
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
    pub snapshot: Option<IoBuffer<u8>>,
    pub seen_version: u64,
    /// A writeback of this mapping's file failed since this mapping last
    /// reported one; its next `msync` fails with `EIO` (Linux reports a
    /// writeback error to `msync` through the mapping's file).
    pub writeback_error: bool,
    /// The last time a pull saw this mapping's bytes equal to `snapshot`
    /// while its process was quiescent; see [`CleanStamp`]. Only a pull or
    /// a refresh sets it. Every other change to the bytes or the snapshot
    /// clears it, and a forked child starts without one.
    pub clean: Option<CleanStamp>,
}

impl SharedMapping {
    /// A tracked anonymous `MAP_SHARED` interval.
    pub fn anonymous(len: usize, writable: bool, key: String, snapshot: IoBuffer<u8>) -> Self {
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
            writeback_error: false,
            clean: None,
        }
    }

    /// A tracked file `MAP_SHARED` interval over a page-cached backing.
    pub fn file(
        fd: i32,
        file_offset: u64,
        len: usize,
        writable: bool,
        write_allowed: bool,
        key: String,
        snapshot: IoBuffer<u8>,
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
            writeback_error: false,
            clean: None,
        }
    }

    fn try_copy_range(&self, offset: usize, len: usize) -> Result<Self, Errno> {
        let snapshot = self.snapshot.as_ref().map(|bytes| {
            let end = offset.checked_add(len).ok_or(Errno::EINVAL)?;
            IoBuffer::copy_from(bytes.get(offset..end).ok_or(Errno::EINVAL)?)
        }).transpose()?;
        let backing_key = self.backing_key.as_deref().map(copy_mapping_key).transpose()?;
        Ok(Self {
            fd: self.fd,
            file_offset: self.file_offset.checked_add(offset as u64).ok_or(Errno::EINVAL)?,
            len,
            writable: self.writable,
            write_allowed: self.write_allowed,
            backing_kind: self.backing_kind,
            backing_key,
            snapshot,
            seen_version: self.seen_version,
            writeback_error: self.writeback_error,
            clean: None,
        })
    }

    fn has_unpublished_changes(&self, pid: u32, addr: u64, io: &mut dyn SharedMappingIo) -> Result<bool, Errno> {
        let Some(snapshot) = self.snapshot.as_ref() else { return Ok(false); };
        let mut current = [0u8; FILE_PAGE_SIZE];
        for offset in (0..self.len).step_by(FILE_PAGE_SIZE) {
            let count = (self.len - offset).min(FILE_PAGE_SIZE);
            io.read_process(pid, addr + offset as u64, &mut current[..count])?;
            if current[..count] != snapshot[offset..offset + count] { return Ok(true); }
        }
        Ok(false)
    }
}

impl MapMemory for SharedMapping {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        self.backing_key.heap_bytes()
    }
}

#[derive(Debug)]
pub(crate) struct MappingCleanup {
    pid: u32,
    addr: u64,
    len: u64,
    splits: PreparedMap<u64, SharedMapping>,
}

#[derive(Debug)]
struct MappingRemap {
    pid: u32,
    old_addr: u64,
    len: usize,
    snapshot: Option<IoBuffer<u8>>,
    version: u64,
    anonymous_growth: Option<IoBuffer<u8>>,
}

struct MappingPublication {
    process: Option<PreparedEntry<u32, ProcessMappings<SharedMapping>>>,
    mapping: PreparedEntry<u64, SharedMapping>,
}

struct FileMappingPreparation {
    pid: u32,
    addr: Option<u64>,
    handle: i64,
    mapping: MappingPublication,
}

impl core::fmt::Debug for FileMappingPreparation {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("FileMappingPreparation").field("pid", &self.pid).finish()
    }
}

/// Byte-coherence mirror for one Rust-owned SysV shared-memory attachment.
///
/// The kernel owns segment identity, lifetime and bytes; this records what a
/// given attachment last observed so the same run-merge protocol applies.
#[derive(Debug)]
#[cfg_attr(test, derive(Clone))]
pub struct SysvShmMapping {
    pub seg_id: i32,
    pub size: usize,
    pub read_only: bool,
    pub snapshot: IoBuffer<u8>,
    pub seen_version: u64,
}

impl MapMemory for SysvShmMapping {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

/// Yield the `[start, end)` runs where `source` differs from `snapshot`.
/// A shorter `snapshot` makes every trailing byte a difference, which is the
/// conservative direction (publish more, never less).
fn next_changed_run(source: &[u8], snapshot: &[u8], cursor: &mut usize) -> Option<(usize, usize)> {
    while *cursor < source.len() && snapshot.get(*cursor) == Some(&source[*cursor]) {
        *cursor += 1;
    }
    if *cursor == source.len() { return None; }
    let start = *cursor;
    *cursor += 1;
    while *cursor < source.len() && snapshot.get(*cursor) != Some(&source[*cursor]) {
        *cursor += 1;
    }
    Some((start, *cursor))
}

fn changed_runs<'a>(source: &'a [u8], snapshot: &'a [u8]) -> impl Iterator<Item = (usize, usize)> + 'a {
    let mut cursor = 0;
    core::iter::from_fn(move || next_changed_run(source, snapshot, &mut cursor))
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

/// Equal bytes between two changed runs that a refresh writes anyway, to keep
/// one host call per cluster of changes rather than one per changed byte.
/// Pixels whose alpha byte did not change would otherwise split every pixel
/// into its own run. A sibling thread's store into such a gap between our read
/// and write would be lost, but those bytes border bytes a peer is changing
/// at the same moment, which is a data race on that region anyway.
const REFRESH_RUN_JOIN_GAP: usize = 32;

/// The `[start, end)` runs a refresh must write so that process bytes equal
/// to `snapshot` become `latest`: where the two differ, with runs separated
/// by fewer than [`REFRESH_RUN_JOIN_GAP`] equal bytes joined. A length
/// mismatch refreshes the whole range.
fn refresh_runs(latest: &[u8], snapshot: &[u8]) -> Vec<(usize, usize)> {
    if latest.len() != snapshot.len() {
        return alloc::vec![(0, latest.len())];
    }
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for offset in (0..latest.len()).step_by(FILE_PAGE_SIZE) {
        let end = (offset + FILE_PAGE_SIZE).min(latest.len());
        let (src, snap) = (&latest[offset..end], &snapshot[offset..end]);
        if !range_differs_from_snapshot(src, snap) {
            continue;
        }
        for (start, stop) in changed_runs(src, snap) {
            let (start, stop) = (offset + start, offset + stop);
            match runs.last_mut() {
                Some(last) if start - last.1 < REFRESH_RUN_JOIN_GAP => last.1 = stop,
                _ => runs.push((start, stop)),
            }
        }
    }
    runs
}

/// Whether any byte of `source` differs from `snapshot`.
pub fn range_differs_from_snapshot(source: &[u8], snapshot: &[u8]) -> bool {
    // Keep native and short-range comparisons on their existing slice path.
    // Large wasm32 mappings use scalar words without alignment assumptions,
    // target SIMD features, or reading beyond either slice.
    #[cfg(target_arch = "wasm32")]
    if source.len() >= 256 && source.len() == snapshot.len() {
        return snapshot_words_differ(source, snapshot);
    }
    source != snapshot
}

#[cfg(any(target_arch = "wasm32", test))]
fn snapshot_words_differ(source: &[u8], snapshot: &[u8]) -> bool {
    if source.len() != snapshot.len() {
        return true;
    }
    let mut source_words = source.chunks_exact(8);
    let mut snapshot_words = snapshot.chunks_exact(8);
    for (source_word, snapshot_word) in source_words.by_ref().zip(snapshot_words.by_ref()) {
        if u64::from_ne_bytes(source_word.try_into().unwrap())
            != u64::from_ne_bytes(snapshot_word.try_into().unwrap())
        {
            return true;
        }
    }
    source_words.remainder() != snapshot_words.remainder()
}

impl FileBacking {
    pub fn new(key: String, handle: i64, writable: bool, size: u64) -> Self {
        Self {
            key,
            handle,
            writable,
            size,
            size_valid: true,
            pages: PreparedMap::new(),
            dirty_pages: PreparedMap::new(),
            ref_count: 0,
            version: 0,
            source_generation: None,
        }
    }

    /// Whether the object reports a content generation: a file the kernel
    /// owns, every writer of which runs in the kernel.
    ///
    /// Such a backing writes through. A publication is persisted into the file
    /// in the same step (see [`SharedMappingTable::sync_file_from_process`]),
    /// so a descriptor `read` observes what the mappings published, and the
    /// cache holds no page between operations ([`Self::settle`]): the file is
    /// already in kernel memory, so keeping a second copy would only double
    /// the kernel's footprint for a mapped file.
    pub fn writes_through(&self) -> bool {
        self.source_generation.is_some()
    }

    /// Adopt the object's generation when the backing is first created.
    fn observe_source_generation(&mut self, io: &mut dyn SharedMappingIo) {
        self.source_generation = io.content_generation(self.handle);
    }

    /// Reconcile with writes that reached the object through a descriptor —
    /// `write`, `pwrite`, `ftruncate`, an `O_TRUNC` open — since this cache
    /// last agreed with it.
    ///
    /// The size is re-derived, clean pages are dropped, and the version is
    /// advanced so every mapped snapshot imports the new bytes at its next
    /// publication point. Dirty pages are kept: they hold acknowledged
    /// `MAP_SHARED` stores the file does not have yet, and discarding them
    /// would lose those stores silently.
    pub fn reconcile_source(&mut self, io: &mut dyn SharedMappingIo) {
        let Some(seen) = self.source_generation else {
            return;
        };
        let Some(live) = io.content_generation(self.handle) else {
            return;
        };
        if live == seen {
            return;
        }
        let _ = self.revalidate(io);
        self.invalidate_all_stale();
        self.source_generation = Some(live);
    }

    /// Record that the object matches this cache after the backing's own
    /// writeback. Only valid straight after [`Self::reconcile_source`] and a
    /// writeback with nothing in between, which the single-threaded kernel
    /// guarantees for every caller here.
    fn adopt_source_generation(&mut self, io: &mut dyn SharedMappingIo) {
        if self.source_generation.is_some() {
            if let Some(live) = io.content_generation(self.handle) {
                self.source_generation = Some(live);
            }
        }
    }

    /// Drop the clean pages of a write-through backing once an operation is
    /// done with them. See [`Self::writes_through`].
    pub fn settle(&mut self) {
        if self.writes_through() {
            self.invalidate_clean_pages();
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
    fn read_page(&self, page: u64, io: &mut dyn SharedMappingIo) -> Result<IoBuffer<u8>, Errno> {
        let mut bytes = IoBuffer::try_filled(FILE_PAGE_SIZE, 0)?;
        self.read_page_into(page, &mut bytes, io)?;
        Ok(bytes)
    }

    fn read_page_into(&self, page: u64, bytes: &mut [u8], io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        if !self.size_valid {
            return Err(Errno::EIO);
        }
        let page_offset = page.saturating_mul(FILE_PAGE_SIZE as u64);
        let readable = self
            .size
            .saturating_sub(page_offset)
            .min(FILE_PAGE_SIZE as u64) as usize;
        bytes.fill(0);
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
        Ok(())
    }

    /// Ensure one page is resident, revalidating a doubtful size first.
    pub fn ensure_page_loaded(
        &mut self,
        page: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if self.pages.contains_key(&page) {
            if self.dirty_pages.get(&page).is_some_and(|dirty| dirty.stale) {
                let mut latest = [0u8; FILE_PAGE_SIZE];
                self.read_page_into(page, &mut latest, io)?;
                let dirty = self.dirty_pages.get_mut(&page).expect("dirty page present");
                let cached = self.pages.get_mut(&page).expect("cached page present");
                for offset in 0..FILE_PAGE_SIZE {
                    if !dirty.contains(offset) { cached[offset] = latest[offset]; }
                }
                dirty.stale = false;
            }
            return Ok(());
        }
        if !self.size_valid {
            self.revalidate(io)?;
        }
        match self.load_uncached_page(page, io) {
            Err(Errno::ENOMEM) => {
                let resident = self.pages.len();
                self.invalidate_clean_pages();
                if self.pages.len() == resident { return Err(Errno::ENOMEM); }
                self.load_uncached_page(page, io)
            }
            result => result,
        }
    }

    fn load_uncached_page(&mut self, page: u64, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let bytes = IoBuffer::try_filled(FILE_PAGE_SIZE, 0)?;
        let mut prepared = self.pages.prepare_io(page, bytes)?;
        self.read_page_into(page, prepared.value_mut(), io)?;
        self.pages.publish_io(prepared);
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
    ) -> Result<IoBuffer<u8>, Errno> {
        offset.checked_add(len as u64).ok_or(Errno::EINVAL)?;
        let mut out = IoBuffer::try_filled(len, 0)?;
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

    /// Refresh bytes are provisional replacements, not another retained copy.
    /// Keep their credits temporary until their exact snapshot guard admits
    /// promotion; ordinary owned reads retain their existing live policy.
    fn read_range_staged(
        &mut self, offset: u64, len: usize, io: &mut dyn SharedMappingIo,
    ) -> Result<crate::io_buffer::StagedIoBuffer<u8>, Errno> {
        offset.checked_add(len as u64).ok_or(Errno::EINVAL)?;
        let mut out = crate::io_buffer::StagedIoBuffer::try_filled(len, 0)?;
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
            if mark_dirty && !self.dirty_pages.contains_key(&page) {
                self.dirty_pages.try_insert_io(page, DirtyFilePage::new())?;
            }
            if let Some(dirty) = self.dirty_pages.get_mut(&page) {
                dirty.set(page_offset, page_offset + count, mark_dirty);
                if dirty.is_empty() { self.dirty_pages.remove(&page); }
            }
            let dst = self.pages.get_mut(&page).expect("page just loaded");
            dst[page_offset..page_offset + count].copy_from_slice(&bytes[copied..copied + count]);
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
        snapshot: &mut [u8],
        backing_offset: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<bool, Errno> {
        let mut changed = false;
        let mut run_cursor = 0;
        while let Some((start, end)) = next_changed_run(source, snapshot, &mut run_cursor) {
            let mut cursor = start;
            while cursor < end {
                let absolute = backing_offset + cursor as u64;
                let page_offset = (absolute % FILE_PAGE_SIZE as u64) as usize;
                let next = end.min(cursor + FILE_PAGE_SIZE - page_offset);
                self.write_range(absolute, &source[cursor..next], true, io)?;
                if let Some(observed) = snapshot.get_mut(cursor..next) {
                    observed.copy_from_slice(&source[cursor..next]);
                }
                if !changed { self.version += 1; changed = true; }
                cursor = next;
            }
        }
        Ok(changed)
    }

    /// Write dirty pages overlapping `[offset, offset + len)` back through the
    /// stable handle, clamped to the file's size so a mapped file is never
    /// grown past EOF. Dirty bytes lying entirely past EOF are dropped when a
    /// flush covers their page, because they are unrepresentable.
    pub fn flush_range(
        &mut self,
        offset: u64,
        len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if len == 0 || self.dirty_pages.is_empty() {
            return Ok(());
        }
        // A descriptor write may have moved the size this flush clamps to.
        self.reconcile_source(io);
        if !self.size_valid {
            return Err(Errno::EIO);
        }
        let success = self.flush_dirty_range(offset, len, io);
        self.adopt_source_generation(io);
        success
    }

    fn flush_dirty_range(
        &mut self,
        offset: u64,
        len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let requested_end = offset.saturating_add(len);
        let end = requested_end.min(self.size);
        let mut failure = None;
        let mut next_page = self.dirty_pages.keys().next().copied();
        while let Some(page) = next_page {
            next_page = self.dirty_pages.next_after(&page).map(|(key, _)| *key);
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
            if let Err(error) = self.ensure_page_loaded(page, io) {
                failure.get_or_insert(error);
                continue;
            }
            let lo = (write_start - page_start) as usize;
            let hi = (write_end - page_start) as usize;
            let mut cursor = lo;
            while cursor < hi {
                let dirty = self.dirty_pages.get(&page).expect("dirty page present");
                if !dirty.contains(cursor) { cursor += 1; continue; }
                let start = cursor;
                while cursor < hi && dirty.contains(cursor) { cursor += 1; }
                let mut source = [0u8; FILE_PAGE_SIZE];
                source[..cursor - start].copy_from_slice(&self.pages[&page][start..cursor]);
                let mut written = start;
                while written < cursor {
                    match io.pwrite(self.handle, page_start + written as u64,
                        &source[written - start..cursor - start]) {
                        Ok(count) if count > 0 && count <= cursor - written => {
                            self.dirty_pages.get_mut(&page).expect("dirty page present")
                                .set(written, written + count, false);
                            written += count;
                        }
                        result => {
                            failure.get_or_insert(result.err().unwrap_or(Errno::EIO));
                            break;
                        }
                    }
                }
                if written != cursor { break; }
            }
            let dirty = self.dirty_pages.get_mut(&page).expect("dirty page present");
            dirty.set((valid_page_end - page_start) as usize, FILE_PAGE_SIZE, false);
            if dirty.is_empty() {
                self.dirty_pages.remove(&page);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Flush every dirty page, with no range restriction.
    pub fn flush_all(&mut self, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        self.flush_range(0, u64::MAX, io)
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
        let dirty_pages = &self.dirty_pages;
        self.pages.retain(|page, _| *page < first || *page > last || dirty_pages.contains_key(page));
    }

    /// Drop every clean cached page.
    pub fn invalidate_clean_pages(&mut self) {
        let dirty_pages = &self.dirty_pages;
        self.pages.retain(|page, _| dirty_pages.contains_key(page));
    }

    // -- external-write reconciliation -----------------------------------
    //
    // A write that reaches the file through the descriptor rather than
    // through a mapping — `write`, `pwrite`, `ftruncate`, `sendfile`,
    // `copy_file_range` — leaves this cache holding bytes the file no longer
    // has. These reconcile it. Every one of them advances `version`, because
    // a mapped snapshot is stale from this point even when no page was
    // resident: it is the version bump, not the page eviction, that makes
    // peers re-import.

    fn invalidate_range_stale(&mut self, first: u64, last: u64) {
        self.dirty_pages.retain(|page, dirty| {
            if *page >= first && *page <= last { dirty.stale = true; }
            true
        });
        let dirty_pages = &self.dirty_pages;
        self.pages.retain(|page, _| *page < first || *page > last || dirty_pages.contains_key(page));
        self.version += 1;
    }

    fn stage_refreshed_pages(
        &self,
        first: u64,
        last: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<PreparedMap<u64, IoBuffer<u8>>, Errno> {
        let mut replacements = PreparedMap::new();
        for (page, _) in self.pages.iter().filter(|(page, _)| **page >= first && **page <= last) {
            replacements.try_insert_io(*page, self.read_page(*page, io)?)?;
        }
        Ok(replacements)
    }

    fn publish_refreshed_pages(&mut self, replacements: PreparedMap<u64, IoBuffer<u8>>) {
        for (page, bytes) in replacements.into_pairs() {
            *self.pages.get_mut(&page).expect("staged resident page remains present") = bytes;
            self.dirty_pages.remove(&page);
        }
    }

    /// Drop every clean page and mark every mapped snapshot stale.
    pub fn invalidate_all_stale(&mut self) {
        let size = self.size;
        let size_valid = self.size_valid;
        self.dirty_pages.retain(|page, dirty| {
            dirty.stale = true;
            if size_valid {
                let valid = size.saturating_sub(page.saturating_mul(FILE_PAGE_SIZE as u64))
                    .min(FILE_PAGE_SIZE as u64) as usize;
                dirty.set(valid, FILE_PAGE_SIZE, false);
            }
            !dirty.is_empty()
        });
        self.pages.retain(|page, _| self.dirty_pages.contains_key(page));
        self.version += 1;
    }

    /// Re-read every resident page from the file.
    ///
    /// `exact_size` is the length a syscall set authoritatively (`ftruncate`,
    /// `truncate`, an `O_TRUNC` open); without one the size is re-derived from
    /// the handle. A failure to re-read leaves no half-updated page behind:
    /// the whole resident set is invalidated instead, so the next read goes to
    /// the file.
    pub fn reload(&mut self, exact_size: Option<u64>, io: &mut dyn SharedMappingIo) -> bool {
        if let Some(size) = exact_size {
            self.size = size;
            self.size_valid = true;
        } else if self.revalidate(io).is_err() {
            self.invalidate_all_stale();
            return false;
        }
        if self.pages.is_empty() {
            self.version += 1;
            return true;
        }
        let replacements = match self.stage_refreshed_pages(0, u64::MAX, io) {
            Ok(replacements) => replacements,
            Err(_) => {
                self.invalidate_all_stale();
                return false;
            }
        };
        self.publish_refreshed_pages(replacements);
        self.version += 1;
        true
    }

    /// Re-read only the resident pages overlapping `[offset, offset + len)`.
    ///
    /// Used where the syscall named the range it wrote, so pages outside it
    /// are still good and need not be dropped.
    pub fn reload_range(
        &mut self,
        offset: u64,
        len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        if len == 0 {
            return true;
        }
        let first = offset / FILE_PAGE_SIZE as u64;
        let last = offset.saturating_add(len - 1) / FILE_PAGE_SIZE as u64;
        let replacements = match self.stage_refreshed_pages(first, last, io) {
            Ok(replacements) => replacements,
            Err(_) => {
                self.invalidate_range_stale(first, last);
                return false;
            }
        };
        let refreshed = !replacements.is_empty();
        self.publish_refreshed_pages(replacements);
        if refreshed {
            self.version += 1;
        }
        true
    }
}

/// Process-memory writes the kernel made through its syscall paths
/// (`HostIO::proc_write_bytes`), kept so a boundary sync can tell whether one
/// of them landed inside a mapping it would otherwise not compare.
///
/// The mapping table's own refresh writes do not come through here: they
/// replace a mapping's bytes and its snapshot together. This records the
/// writes that change process bytes *without* telling the table: a syscall
/// output the kernel stores straight to a guest pointer, which may point into
/// a `MAP_SHARED` mapping (`read`'s buffer, an `ioctl` argument, a `wait4`
/// status word).
///
/// It is a fixed ring rather than a per-process list because most processes
/// never hold a kernel-owned mapping and are never asked about: an unbounded
/// per-pid record would grow for every one of them. A boundary asks for the
/// writes since its previous boundary; when more writes than the ring holds
/// happened in between, the answer is "unknown" and the boundary compares.
pub struct KernelProcessWriteLog {
    entries: [(u32, u64, u64); KERNEL_PROCESS_WRITE_LOG_LEN],
    /// Total writes ever recorded. Entry `n` lives at `n % LEN`.
    position: u64,
}

const KERNEL_PROCESS_WRITE_LOG_LEN: usize = 64;

impl KernelProcessWriteLog {
    pub const fn new() -> Self {
        Self {
            entries: [(0, 0, 0); KERNEL_PROCESS_WRITE_LOG_LEN],
            position: 0,
        }
    }

    /// Record that the kernel wrote `[addr, addr + len)` of process `pid`.
    pub fn record(&mut self, pid: u32, addr: u64, len: u64) {
        if len == 0 {
            return;
        }
        let slot = (self.position % KERNEL_PROCESS_WRITE_LOG_LEN as u64) as usize;
        self.entries[slot] = (pid, addr, addr.saturating_add(len));
        self.position += 1;
    }

    /// The position a later [`Self::wrote_since`] measures from.
    pub fn position(&self) -> u64 {
        self.position
    }

    /// Whether the kernel wrote any byte of `[addr, addr + len)` of `pid`
    /// since `since`. `None` means the ring no longer holds every write made
    /// since then, so the answer is unknown.
    pub fn wrote_since(&self, pid: u32, since: u64, addr: u64, len: u64) -> Option<bool> {
        if since > self.position
            || self.position - since > KERNEL_PROCESS_WRITE_LOG_LEN as u64
        {
            return None;
        }
        let end = addr.saturating_add(len);
        Some((since..self.position).any(|n| {
            let (write_pid, start, stop) =
                self.entries[(n % KERNEL_PROCESS_WRITE_LOG_LEN as u64) as usize];
            write_pid == pid && start < end && addr < stop
        }))
    }
}

impl Default for KernelProcessWriteLog {
    fn default() -> Self {
        Self::new()
    }
}

/// `force` values of `kernel_shared_mapping_sync_process`, the host's call
/// at a syscall boundary of a process holding a kernel-owned mapping. Kept
/// beside the host's copies (`KERNEL_SHARED_MAPPING_SYNC_*` in
/// `host/src/kernel-worker.ts`).
pub mod sync_force {
    /// The completion of a syscall: pull the mappings that share a backing
    /// with the process, then refresh its stale mappings
    /// ([`super::SharedMappingTable::sync_file_at_completion`]).
    pub const COMPLETION: i32 = 0;
    /// A forced publication: fork, the exec preflight, teardown. The
    /// process's own mappings are published and persisted.
    pub const FORCED: i32 = 1;
    /// Retired: a completion the host attested unchanged since its entry.
    /// Completions no longer need the claim; treated as [`COMPLETION`].
    pub const LEGACY_UNCHANGED: i32 = 2;
    /// The entry of a syscall: no kernel-file work (the descriptor fence
    /// covers file content; completions cover peers). SysV attachments
    /// still synchronize. A kernel from before this value reads it as
    /// [`FORCED`], which is correct and only slower.
    pub const ENTRY: i32 = 3;
}

/// What a syscall must fence before the kernel touches file content: the
/// descriptor-fence half of [`SharedMappingTable::fence_handle`].
///
/// This is the one list of syscalls that read or write the *content* of a
/// file through a descriptor or a pathname. A kernel-owned file can be mapped
/// `MAP_SHARED` by processes whose stores the kernel has not yet published
/// (each process owns a separate linear memory), so before any of these
/// reaches the file, every mapping of it is pulled. Keep it in step with the
/// host's `syscallTouchesFdStorageBeforeKernel` and its `sendfile`,
/// `splice` and `copy_file_range` cases (`host/src/kernel-worker.ts`), which
/// do the same for host-mounted files; `host/test/descriptor-fence-contract`
/// checks the two lists name the same syscalls.
///
/// Not fenced, deliberately: `stat`/`fstat` (a store never changes the size,
/// and POSIX lets the timestamps lag), `close`, locks and `lseek` (no
/// content), and file-change notifications. `mmap` of a private copy
/// populates through `pread`, which is fenced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptorFence {
    /// The syscall touches no file content.
    None,
    /// The content behind these descriptors of the calling process.
    Fds([Option<i32>; 2]),
    /// A file named by path (`O_TRUNC` open). The kernel does not resolve
    /// the path before dispatch, so every mapped file is fenced; such opens
    /// are rare next to descriptor I/O.
    AllMappedFiles,
    /// The kernel export the syscall dispatches to fences itself, because the
    /// host also calls that export directly (`fsync`, `fdatasync`,
    /// `truncate`).
    InExport,
}

/// Classify one channel syscall for the descriptor fence. See
/// [`DescriptorFence`].
pub fn descriptor_fence_for(nr: u32, args: &[i64; 6]) -> DescriptorFence {
    use wasm_posix_shared::Syscall as S;
    use wasm_posix_shared::abi::extended_syscalls::{
        SYS_COPY_FILE_RANGE, SYS_FALLOCATE, SYS_PREADV, SYS_PREADV2, SYS_PWRITEV, SYS_PWRITEV2,
        SYS_SENDFILE, SYS_SPLICE,
    };
    // Named as the host names them, so the parity check can compare lists.
    const SYS_READ: u32 = S::Read as u32;
    const SYS_WRITE: u32 = S::Write as u32;
    const SYS_PREAD: u32 = S::Pread as u32;
    const SYS_PWRITE: u32 = S::Pwrite as u32;
    const SYS_READV: u32 = S::Readv as u32;
    const SYS_WRITEV: u32 = S::Writev as u32;
    const SYS_FTRUNCATE: u32 = S::Ftruncate as u32;
    const SYS_FSYNC: u32 = S::Fsync as u32;
    const SYS_FDATASYNC: u32 = S::Fdatasync as u32;
    const SYS_TRUNCATE: u32 = S::Truncate as u32;
    const SYS_OPEN: u32 = S::Open as u32;
    const SYS_OPENAT: u32 = S::Openat as u32;
    let fd = |index: usize| Some(args[index] as i32);
    match nr {
        SYS_READ | SYS_WRITE | SYS_PREAD | SYS_PWRITE | SYS_READV | SYS_WRITEV
        | SYS_FTRUNCATE | SYS_PREADV | SYS_PWRITEV | SYS_PREADV2 | SYS_PWRITEV2
        | SYS_FALLOCATE => DescriptorFence::Fds([fd(0), None]),
        // sendfile(out_fd, in_fd, ...): both sides.
        SYS_SENDFILE => DescriptorFence::Fds([fd(0), fd(1)]),
        // splice / copy_file_range (fd_in, off_in, fd_out, off_out, ...).
        SYS_SPLICE | SYS_COPY_FILE_RANGE => DescriptorFence::Fds([fd(0), fd(2)]),
        SYS_FSYNC | SYS_FDATASYNC | SYS_TRUNCATE => DescriptorFence::InExport,
        SYS_OPEN if (args[1] as u32) & wasm_posix_shared::flags::O_TRUNC != 0 => {
            DescriptorFence::AllMappedFiles
        }
        SYS_OPENAT if (args[2] as u32) & wasm_posix_shared::flags::O_TRUNC != 0 => {
            DescriptorFence::AllMappedFiles
        }
        _ => DescriptorFence::None,
    }
}

/// What one publish-only pull ([`SharedMappingTable::pull_backing`]) did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PullOutcome {
    /// The process's bytes equal its snapshot (or there was nothing to pull).
    Unchanged,
    /// Changed bytes were merged into the backing and reached the file.
    Published,
    /// Changed bytes were merged but the file refused them; the loss was
    /// reported and the pages stay dirty.
    WritebackFailed(Errno),
}

/// Fixed-size numerical evidence, not resource custody. Keep the earliest
/// failures: later completion errors are often cascades of the first refusal.
#[derive(Debug, Clone, Copy)]
struct SharedMappingFailure {
    phase: &'static str,
    pid: u32,
    addr: u64,
    len: usize,
    file_offset: u64,
    handle: i64,
    offset: usize,
    attempted_bytes: usize,
    status: i32,
    io_live: usize,
    io_limit: usize,
}

#[derive(Debug, Default)]
struct SharedMappingFailures {
    records: [Option<SharedMappingFailure>; 8],
    total: u64,
}

impl SharedMappingFailures {
    const fn new() -> Self { Self { records: [None; 8], total: 0 } }

    fn record(&mut self, phase: &'static str, pid: u32, addr: u64, len: usize,
        file_offset: u64, handle: i64, offset: usize, attempted_bytes: usize, error: Errno,
    ) {
        // WHY: logging must still work when allocation was just refused.
        // Copy only numbers into fixed storage, retaining no backing/FD owner
        // and introducing no allocation, host call, or altered error outcome.
        let index = self.total;
        self.total = self.total.saturating_add(1);
        if index >= self.records.len() as u64 { return; }
        let (io_live, io_limit) = crate::io_buffer::IO_MEMORY.usage();
        self.records[index as usize] = Some(SharedMappingFailure {
            phase, pid, addr, len, file_offset, handle, offset, attempted_bytes,
            status: -(error as i32), io_live, io_limit,
        });
    }

    fn render(&self) -> Result<IoBuffer<u8>, Errno> {
        let mut out = IoBuffer::new();
        let recorded = self.records.iter().flatten().count();
        out.try_write_fmt(format_args!("version 1\ntotal {}\nrecorded {}\ndropped {}\n",
            self.total, recorded, self.total.saturating_sub(recorded as u64)))?;
        for record in self.records.iter().flatten() {
            out.try_write_fmt(format_args!(
                "failure phase={} pid={} addr={:#x} len={} file_offset={} handle={} offset={} attempted_bytes={} status={} io_live={} io_limit={}\n",
                record.phase, record.pid, record.addr, record.len, record.file_offset,
                record.handle, record.offset, record.attempted_bytes, record.status,
                record.io_live, record.io_limit))?;
        }
        Ok(out)
    }
}

/// Every process's kernel-owned shared mappings, the authoritative backings
/// behind them, and the coherence protocol that keeps the two in step.
///
/// # What lives here, and what does not
///
/// `MAP_SHARED` coherence has four halves, split by who owns the bytes:
///
/// | object | bytes owned by | coherence lives in |
/// |---|---|---|
/// | SysV segment | the kernel (`crate::ipc::IpcTable`) | this table (`sysv`) |
/// | regular file the kernel owns: rootfs, tmpfs (including `/dev/shm`), memfd | the kernel | this table (`mappings`, `file_backings`) |
/// | regular file on a host-mounted directory | the host | `host/src/kernel-worker.ts` |
/// | anonymous `MAP_SHARED` region | the host | `host/src/kernel-worker.ts` |
///
/// The host drives the kernel halves through `kernel_shared_mapping_*` entry
/// points in `crates/kernel/src/wasm_api.rs`, at the same points it drives its
/// own: after `mmap`, at `msync`, `munmap`, `mremap` and `mprotect`, at every
/// syscall boundary of a process that holds such a mapping, across `fork`, and
/// at `exec` and teardown. The anonymous-region code below
/// ([`SharedMappingTable::track_anonymous_mapping`] and its peers) is the
/// same protocol for the host-owned half and is exercised only by the unit
/// tests here; the host keeps that half, and host-file mappings, in
/// TypeScript.
///
/// # How a kernel-owned file stays coherent with descriptor I/O
///
/// POSIX makes a mapping of a file and ordinary I/O on it two views of one
/// object. A host-file backing needs a per-syscall policy for that (the host's
/// `handleSharedMappingsAfterFileSyscall`). A kernel-owned file does not: every
/// writer of it runs in the kernel, so its storage layer advances a content
/// generation on every write, truncation and `O_TRUNC` open
/// ([`SharedMappingIo::content_generation`]), and each backing compares it at
/// every publication point ([`FileBacking::reconcile_source`]). Such a backing
/// also writes through: a publication is persisted into the file in the same
/// step, so a descriptor `read` sees it, and the cache keeps no page between
/// operations ([`FileBacking::writes_through`]).
///
/// The file itself is kept alive by the backing, not by a guest descriptor
/// ([`SharedMappingIo::retain_handle`]): POSIX keeps a mapping valid after the
/// descriptor that created it is closed and after the file is unlinked, and a
/// guest-visible descriptor could be closed or repointed under the mapping.
///
/// # Performance
///
/// This is on the syscall path. Structural facts bound where its cost is
/// paid:
///
/// 1. The host enters the kernel for a boundary sync only for a process that
///    holds a kernel-owned shared mapping, and caches that per-pid predicate
///    instead of asking (see `kernelSharedMappingPids` in
///    `host/src/kernel-worker.ts`).
/// 2. File mappings are pulled lazily: a process's own copy is not compared
///    at its own boundaries, only when something can observe it -- the
///    completion of another mapper's syscall, a descriptor operation on the
///    file, a new mapper joining, and the forced points (`msync`, `munmap`,
///    `mremap`, `MAP_FIXED`, fork, exec, teardown). See
///    [`SharedMappingTable::sync_file_at_completion`].
/// 3. A pull of a process that has stayed parked since its last pull is
///    proved unchanged and skipped ([`CleanStamp`]).
///
/// So a busy compositor costs an idle client nothing, and a client's copy is
/// compared at most once per time it ran guest code, however many syscalls
/// the compositor makes meanwhile.
///
/// # What this does not fix
///
/// Coherence stays syscall-synchronous. A store in one process becomes
/// visible to a peer at the completion of the peer's next syscall (and to
/// descriptor I/O at once), not on the store itself, and `futex` cannot
/// target a peer's memory. See the module comment above.
#[derive(Debug, Default)]
pub struct SharedMappingTable {
    failures: SharedMappingFailures,
    /// pid → (mapping start address → mapping).
    mappings: PreparedMap<u32, ProcessMappings<SharedMapping>>,
    pending_cleanup: Option<MappingCleanup>,
    pending_remap: Option<MappingRemap>,
    pending_file_mapping: Option<FileMappingPreparation>,
    /// Backend identity → page-cached file object.
    file_backings: PreparedMap<String, FileBacking>,
    /// Backing key → anonymous byte store.
    anon_backings: PreparedMap<String, AnonymousBacking>,
    next_anon_id: u64,
    /// pid → (attach address → SysV attachment mirror).
    sysv: PreparedMap<u32, ProcessMappings<SysvShmMapping>>,
    /// Authoritative segment version, bumped after each merged publication.
    sysv_versions: PreparedMap<i32, u64>,
    /// Stable handle lookup for the exact retained backing, not an fd.
    fence_handles: PreparedMap<i64, String>,
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
            mappings: PreparedMap::new(),
            failures: SharedMappingFailures::new(),
            pending_cleanup: None,
            pending_remap: None,
            pending_file_mapping: None,
            file_backings: PreparedMap::new(),
            anon_backings: PreparedMap::new(),
            next_anon_id: 1,
            sysv: PreparedMap::new(),
            sysv_versions: PreparedMap::new(),
            fence_handles: PreparedMap::new(),
        }
    }

    // -- inspection -------------------------------------------------------

    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty() && self.sysv.is_empty()
    }

    pub(crate) fn render_failures(&self) -> Result<IoBuffer<u8>, Errno> {
        self.failures.render()
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

    pub fn notify_file_truncated(&mut self, handle: i64, size: u64) {
        self.file_backings.for_each_mut(|backing| {
            if backing.handle == handle {
                backing.size = size;
                backing.size_valid = true;
                backing.invalidate_all_stale();
            }
        });
    }

    pub fn anon_backing(&self, key: &str) -> Option<&AnonymousBacking> {
        self.anon_backings.get(key)
    }

    /// For every process holding a mapping or an attachment here, the end of
    /// its highest one.
    ///
    /// A process's linear memory never shrinks and was grown to cover each of
    /// these when it was mapped, so this is memory the process certainly
    /// still has -- even after the kernel's own address-space record dropped
    /// the region, which is the state an `munmap` publication runs in.
    pub fn mapped_extent(&self, pid: u32) -> u64 {
        let files = self.mappings.get(&pid).into_iter().flat_map(|mappings| mappings.iter())
            .map(|(addr, mapping)| addr.saturating_add(mapping.len as u64));
        let attachments = self.sysv.get(&pid).into_iter().flat_map(|mappings| mappings.iter())
            .map(|(addr, mapping)| addr.saturating_add(mapping.size as u64));
        files.chain(attachments).max().unwrap_or(0)
    }

    fn process_memory_len(&self, pid: u32, io: &mut dyn SharedMappingIo) -> Option<u64> {
        io.process_memory_len_with_extent(pid, self.mapped_extent(pid))
    }

    pub fn sysv_mapping(&self, pid: u32, addr: u64) -> Option<&SysvShmMapping> {
        self.sysv.get(&pid)?.get(&addr)
    }

    pub fn sysv_segment_version(&self, seg_id: i32) -> u64 {
        self.sysv_versions.get(&seg_id).copied().unwrap_or(0)
    }

    #[cfg(test)]
    fn prepare_mapping(&self, pid: u32, addr: u64, mapping: SharedMapping) -> Result<MappingPublication, Errno> {
        if self.mapping(pid, addr).is_some() { return Err(Errno::EEXIST); }
        self.prepare_mapping_slot(pid, addr, mapping)
    }

    #[cfg(test)]
    fn prepare_mapping_slot(&self, pid: u32, addr: u64, mapping: SharedMapping) -> Result<MappingPublication, Errno> {
        let mapping = PreparedMap::new().prepare_io(addr, mapping)?;
        self.prepare_mapping_entry(pid, mapping)
    }

    fn prepare_mapping_entry(&self, pid: u32, mapping: PreparedEntry<u64, SharedMapping>) -> Result<MappingPublication, Errno> {
        let process = Some(PreparedMap::new().prepare_io(pid, ProcessMappings::new(PreparedMap::new()))?);
        Ok(MappingPublication { process, mapping })
    }

    fn publish_mapping(&mut self, pid: u32, prepared: MappingPublication) {
        if let Some(process) = prepared.process {
            if !self.mappings.contains_key(&pid) { self.mappings.publish_io(process); }
        }
        self.mappings.get_mut(&pid).expect("prepared process missing").publish_io(prepared.mapping);
    }

    #[cfg(test)]
    fn insert_mapping(&mut self, pid: u32, addr: u64, mapping: SharedMapping) {
        let prepared = self.prepare_mapping(pid, addr, mapping).unwrap();
        self.publish_mapping(pid, prepared);
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
        if self.mapping(pid, map_addr).is_some() { return Err(Errno::EEXIST); }
        let Some(mem_len) = self.process_memory_len(pid, io) else {
            return Ok(());
        };
        if map_addr.saturating_add(len as u64) > mem_len {
            return Ok(());
        }
        let initial = io.read_process_owned(pid, map_addr, len)?;
        let bytes = IoBuffer::copy_from(&initial)?;

        let backing_slot = PreparedMapSlot::<String, AnonymousBacking>::new_in(&crate::io_buffer::IO_MEMORY, 160)?;
        let mapping_slot = PreparedMapSlot::<u64, SharedMapping>::new_in(&crate::io_buffer::IO_MEMORY, 80)?;
        let mut key = String::new();
        key.try_reserve_exact(80).map_err(|_| Errno::ENOMEM)?;
        core::fmt::write(&mut key, format_args!("anon:{}:{}:{}", pid, map_addr, self.next_anon_id)).map_err(|_| Errno::ENOMEM)?;
        let backing = backing_slot.finish(copy_mapping_key(&key)?, AnonymousBacking {
            key: copy_mapping_key(&key)?, bytes, ref_count: 1, version: 0,
        })?;
        let mapping = mapping_slot.finish(map_addr, SharedMapping::anonymous(len, writable, key, initial))?;
        let prepared = self.prepare_mapping_entry(pid, mapping)?;
        self.next_anon_id += 1;
        self.anon_backings.publish_io(backing);
        self.publish_mapping(pid, prepared);
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
        let Some(mem_len) = self.process_memory_len(pid, io) else {
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
        let mut cursor = None;
        while let Some(map_addr) = match cursor {
            None => pid_map.keys().next().copied(),
            Some(address) => pid_map.next_after(&address).map(|(address, _)| *address),
        } {
            cursor = Some(map_addr);
            let mapping = pid_map.get_mut(&map_addr).expect("mapping cursor missing");
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

            let snapshot = mapping.snapshot.as_mut().expect("checked above");
            let mut current = [0u8; FILE_PAGE_SIZE];
            let mut changed = false;
            if mapping.writable {
                for offset in (0..mapping.len).step_by(FILE_PAGE_SIZE) {
                    let chunk = FILE_PAGE_SIZE.min(mapping.len - offset);
                    io.read_process(pid, map_addr + offset as u64, &mut current[..chunk])?;
                    let src = &current[..chunk];
                    let snap = &mut snapshot[offset..offset + chunk];
                    if !range_differs_from_snapshot(src, snap) {
                        continue;
                    }
                    if merge_changed_byte_runs(src, snap, &mut backing.bytes, base + offset) {
                        changed = true;
                        backing.version += 1;
                    }
                    snap.copy_from_slice(src);
                }
            }

            // A publisher may itself have been stale. Always reconcile after a
            // publication rather than assigning the new version to a partial
            // view.
            if changed || was_stale {
                let latest = &backing.bytes[base..base + mapping.len];
                io.write_process(pid, map_addr, latest)?;
                snapshot.copy_from_slice(latest);
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
    ///
    /// **The caller owes the reference for the mapping that caused this.** A
    /// new backing is returned at `ref_count == 0` and an existing one is
    /// returned uncounted, while `inherit_process_mappings` counts every
    /// inherited mapping and `release_mapping` discounts every mapping it
    /// drops. A caller that skips the increment leaves the count one short for
    /// the life of the mapping: the first process to exit takes the backing to
    /// zero and releases the file while a live peer still has it mapped, and —
    /// more quietly — two real peers both sit in the sole-observer deferral
    /// and never see each other's writes.
    /// [`SharedMappingTable::track_kernel_file_mapping`] is the path that does
    /// this correctly and is what production calls; a second direct caller
    /// must take the reference too.
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
                let fence = self.fence_handles.prepare_io(source_handle, copy_mapping_key(key)?)?;
                io.retain_handle(source_handle)?;
                let old_handle = existing.handle;
                existing.handle = source_handle;
                existing.writable = true;
                existing.size = stat.size;
                existing.size_valid = true;
                io.release_handle(old_handle);
                self.fence_handles.remove(&old_handle);
                self.fence_handles.publish_io(fence);
            } else {
                existing.revalidate(io)?;
            }
            existing.reconcile_source(io);
            return Ok(self.file_backings.get_mut(key).expect("checked above"));
        }

        let slot = PreparedMapSlot::<String, FileBacking>::new_in(&crate::io_buffer::IO_MEMORY,
            key.len().checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let mut backing =
            FileBacking::new(copy_mapping_key(key)?, source_handle, source_writable, stat.size);
        backing.observe_source_generation(io);
        let fence = self.fence_handles.prepare_io(source_handle, copy_mapping_key(key)?)?;
        let prepared = slot.finish(copy_mapping_key(key)?, backing)?;
        io.retain_handle(source_handle)?;
        self.file_backings.publish_io(prepared);
        self.fence_handles.publish_io(fence);
        Ok(self.file_backings.get_mut(key).expect("just inserted"))
    }

    /// Track a new `MAP_SHARED` mapping of the file behind `handle`, a stable
    /// handle the environment can read and write on its own (in the kernel, a
    /// kernel mapping handle: `crate::kernel_file_mapping`), and populate the
    /// process's `[map_addr, map_addr + len)` from the latest shared state.
    ///
    /// Every existing observer of the file publishes first, so the newcomer
    /// starts from bytes no peer is still holding back. The observers are
    /// pulled ([`Self::pull_backing`]), not refreshed: a refresh would write
    /// into processes that may be running guest code. `writable` is the
    /// mapping's `PROT_WRITE`; `write_allowed` is whether the descriptor that
    /// created it was `O_RDWR`, which decides a later `mprotect` upgrade after
    /// the descriptor is gone. The backing itself is always writable: the
    /// handle reaches the file directly, and every mapping enforces its own
    /// access, so a read-only description mapping a file first must not stop a
    /// later read-write one from publishing.
    #[allow(clippy::too_many_arguments)]
    pub fn track_kernel_file_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        fd: i32,
        key: &str,
        handle: i64,
        file_offset: u64,
        len: usize,
        writable: bool,
        write_allowed: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let matches = self.pending_file_mapping.as_ref().is_some_and(|pending| {
            let mapping = pending.mapping.mapping.value();
            pending.pid == pid && pending.handle == handle && mapping.fd == fd && mapping.file_offset == file_offset
                && mapping.len == len && mapping.writable == writable && mapping.write_allowed == write_allowed
                && mapping.backing_key.as_deref() == Some(key)
        });
        if self.pending_file_mapping.is_some() && !matches { return Err(Errno::EINVAL); }
        if self.pending_file_mapping.is_none() {
            self.prepare_kernel_file_mapping(pid, fd, key, handle, file_offset, len, writable, write_allowed, io)?;
        }
        self.bind_kernel_file_mapping(pid, map_addr)?;
        self.commit_kernel_file_mapping(pid, map_addr, io)
    }

    pub fn bind_kernel_file_mapping(&mut self, pid: u32, addr: u64) -> Result<(), Errno> {
        if let Some(pending) = self.pending_file_mapping.as_mut() {
            if pending.pid != pid || pending.addr.is_some_and(|bound| bound != addr) { return Err(Errno::EINVAL); }
            pending.addr = Some(addr);
        }
        Ok(())
    }

    pub fn prepared_kernel_file_mapping(&self, pid: u32, addr: u64) -> Option<(&SharedMapping, i64)> {
        self.pending_file_mapping.as_ref().filter(|pending| pending.pid == pid && pending.addr == Some(addr))
            .map(|pending| (pending.mapping.mapping.value(), pending.handle))
    }

    pub fn commit_kernel_file_mapping(&mut self, pid: u32, map_addr: u64, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let (mapping, _) = self.prepared_kernel_file_mapping(pid, map_addr).ok_or(Errno::EINVAL)?;
        if mapping.backing_key.is_none() { return Err(Errno::EIO); }
        if self.mapping(pid, map_addr).is_some() {
            self.cancel_kernel_file_mapping(io);
            return Err(Errno::EEXIST);
        }
        let written = io.write_process(pid, map_addr, mapping.snapshot.as_deref().unwrap_or(&[]));
        if let Err(error) = written {
            self.cancel_kernel_file_mapping(io);
            return Err(error);
        }
        let mut pending = self.pending_file_mapping.take().expect("file mapping preparation missing");
        pending.mapping.mapping.replace_key(map_addr);
        self.publish_mapping(pid, pending.mapping);
        Ok(())
    }

    pub fn cancel_kernel_file_mapping(&mut self, io: &mut dyn SharedMappingIo) {
        if let Some(pending) = self.pending_file_mapping.take() {
            if let Some(key) = pending.mapping.mapping.value().backing_key.as_deref() {
                self.release_file_backing_reference(key, io);
            }
        }
    }

    pub fn cancel_kernel_file_mapping_in_range(&mut self, pid: u32, addr: u64, len: u64, io: &mut dyn SharedMappingIo) {
        let end = addr.saturating_add(len);
        if self.pending_file_mapping.as_ref().is_some_and(|pending| {
            pending.pid == pid && pending.addr.is_some_and(|start| {
                addr <= start && start.saturating_add(pending.mapping.mapping.value().len as u64) <= end
            })
        }) {
            self.cancel_kernel_file_mapping(io);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_kernel_file_mapping(
        &mut self,
        pid: u32,
        fd: i32,
        key: &str,
        handle: i64,
        file_offset: u64,
        len: usize,
        writable: bool,
        write_allowed: bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        self.cancel_kernel_file_mapping(io);
        if len == 0 || (writable && !write_allowed) {
            return Err(Errno::EINVAL);
        }
        let mapping_slot = PreparedMapSlot::<u64, SharedMapping>::new_in(&crate::io_buffer::IO_MEMORY, key.len())?;
        let mapping_key = copy_mapping_key(key)?;
        let stat = io.fstat_handle(handle)?;
        if !stat.is_regular_file() {
            return Err(Errno::ENOTSUP);
        }
        self.get_or_create_file_backing(key, &stat, true, io)?;
        let populated = self
            .pull_backing(key, None, io)
            .and_then(|_| {
                let backing = self.file_backings.get_mut(key).ok_or(Errno::EIO)?;
                let version = backing.version;
                let bytes = backing.read_range(file_offset, len, io);
                backing.settle();
                Ok((bytes?, version))
            });
        let (initial, version) = match populated {
            Ok(populated) => populated,
            Err(err) => {
                self.discard_unreferenced_file_backing(key, io);
                return Err(err);
            }
        };
        let prepared = match mapping_slot.finish(0, SharedMapping::file(
                fd,
                file_offset,
                len,
                writable,
                write_allowed,
                mapping_key,
                initial,
                version,
            )).and_then(|mapping| self.prepare_mapping_entry(pid, mapping)) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.discard_unreferenced_file_backing(key, io);
                return Err(error);
            }
        };
        if let Some(backing) = self.file_backings.get_mut(key) { backing.ref_count += 1; }
        self.pending_file_mapping = Some(FileMappingPreparation { pid, addr: None, handle, mapping: prepared });
        Ok(())
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
        self.fence_handles.remove(&handle);
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
        if backing.flush_all(io).is_err() {
            return;
        }
        let handle = backing.handle;
        self.file_backings.remove(key);
        self.fence_handles.remove(&handle);
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
        self.sync_file_inner(pid, force, io)
    }

    /// Bring `pid`'s file mappings at `addrs` that are behind their backing
    /// up to date. Every range is read before any process memory is written,
    /// so one unreadable backing cannot leave the process half refreshed, and
    /// only the runs that differ from the snapshot are written. Callers pull
    /// the mappings first, so the snapshot is the process's own bytes.
    fn refresh_mappings(
        &mut self,
        pid: u32,
        addrs: &[u64],
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        // A current mapping needs no replacement or table walk. This is the
        // ordinary no-work completion path, so it must not acquire I/O credit.
        if addrs.is_empty() { return Ok(()); }
        debug_assert!(addrs.windows(2).all(|pair| pair[0] <= pair[1]));
        struct Refresh<'a> {
            addr: u64,
            replacement: crate::io_buffer::PreparedIoBufferReplacement<'a, u8>,
            seen_version: &'a mut u64,
            clean: &'a mut Option<CleanStamp>,
            version: u64,
        }
        // All reads AND replacement admissions precede every process write.
        // Temporary metadata owns the guards, so any later failure rolls back
        // earlier credits and snapshots without another allocation.
        let mut refreshes = crate::io_buffer::StagedIoBuffer::try_with_capacity(addrs.len())?;
        let Self { mappings, file_backings, failures, .. } = self;
        let Some(pid_mappings) = mappings.get_mut(&pid) else { return Ok(()); };
        // Both internal callers enumerate the sorted mapping table. Retain
        // that order while borrowing disjoint snapshot/version/epoch fields;
        // no second lookup or alias into a mutably borrowed table is needed.
        pid_mappings.try_for_each_mut_entry(|map_addr, mapping| {
            if addrs.binary_search(map_addr).is_err() { return Ok(()); }
            let Some(backing) = mapping.backing_key.as_deref()
                .and_then(|key| file_backings.get_mut(key)) else { return Ok(()); };
            if mapping.seen_version == backing.version { return Ok(()); }
            let latest = match backing.read_range_staged(mapping.file_offset, mapping.len, io) {
                Ok(latest) => latest,
                Err(error) => {
                    failures.record("refresh_read", pid, *map_addr, mapping.len,
                        mapping.file_offset, backing.handle, 0, mapping.len, error);
                    return Err(error);
                }
            };
            let replacement = match latest.prepare_replacing(&mut mapping.snapshot) {
                Ok(replacement) => replacement,
                Err(error) => {
                    failures.record("refresh_promote", pid, *map_addr, mapping.len,
                        mapping.file_offset, backing.handle, 0, mapping.len, error);
                    return Err(error);
                }
            };
            refreshes.push(Refresh { addr: *map_addr, replacement,
                seen_version: &mut mapping.seen_version, clean: &mut mapping.clean,
                version: backing.version });
            Ok(())
        })?;

        // Preserve changed-run publication: unrelated sibling stores outside
        // the peer's changed runs must survive the refresh.
        for refresh in refreshes {
            let runs = match refresh.replacement.original() {
                Some(snapshot) => refresh_runs(refresh.replacement.latest(), snapshot),
                None => alloc::vec![(0, refresh.replacement.latest().len())],
            };
            for (start, end) in runs {
                io.write_process(pid, refresh.addr + start as u64,
                    &refresh.replacement.latest()[start..end])?;
            }
            let observed = io.quiescent_epoch(pid)
                .map(|epoch| CleanStamp { epoch, log_position: io.kernel_write_position() });
            refresh.replacement.commit();
            *refresh.seen_version = refresh.version;
            *refresh.clean = observed;
        }
        Ok(())
    }

    /// The kernel-file half of a syscall *completion* of `pid`: make every
    /// store another mapper of the same files has made visible to `pid`
    /// before it resumes.
    ///
    /// # Why the completion is enough
    ///
    /// A process learns that a peer stored into a shared file only through
    /// the kernel: a pipe or socket byte, a signal, an exit status, a lock, a
    /// file write. Each such chain starts with a syscall the writer made
    /// after its store -- and that syscall's `CH_PENDING` store is
    /// sequentially consistent, so anything that reads the writer's memory
    /// after seeing it parked sees the store -- and ends at a syscall of the
    /// reader that consumes the event. Pulling every other mapper of the
    /// reader's files when that syscall completes therefore finds the store,
    /// and the refresh below delivers it before the reader runs again.
    /// Nothing is needed at the entry: the reader has not learned anything
    /// yet. A writer that makes no syscall at all after its store is still
    /// pulled by the reader's next completion, sooner than before, when it
    /// published only at its own next syscall.
    ///
    /// The process's own copy is pulled here only when it holds another
    /// mapping of the same file (an alias it may read through), or when the
    /// mapping is about to be refreshed, so that its own pending stores win
    /// their bytes. Otherwise its stores wait for an observer: a peer's
    /// completion, a descriptor operation on the file (the fence), a new
    /// mapper, `msync`, `munmap`, `mremap`, `MAP_FIXED`, fork, exec or exit.
    /// Pulls of processes that have stayed parked since their last pull are
    /// proved unchanged and skipped ([`CleanStamp`]).
    pub fn sync_file_at_completion(
        &mut self,
        pid: u32,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(mem_len) = self.process_memory_len(pid, io) else {
            return Ok(());
        };
        // backing key -> how many mappings of it `pid` holds
        let mut keys: BTreeMap<String, usize> = BTreeMap::new();
        for mapping in self.mappings.get(&pid).into_iter().flat_map(|m| m.values()) {
            if mapping.backing_kind != Some(BackingKind::File) {
                continue;
            }
            if let Some(key) = mapping.backing_key.as_ref() {
                *keys.entry(key.clone()).or_insert(0) += 1;
            }
        }
        if keys.is_empty() {
            return Ok(());
        }
        // 1. Publish what the other mappers stored. A refused write-through
        //    is reported to the peer's mappings and the file's descriptions;
        //    it does not fail this process's syscall.
        for (key, count) in &keys {
            let except = if *count > 1 { None } else { Some(pid) };
            self.pull_backing(key, except, io)?;
        }
        // 2. Refresh what that (or a descriptor write) left behind, after
        //    publishing the process's own stores to those mappings.
        let stale: Vec<(u64, bool)> = self
            .mappings
            .get(&pid)
            .into_iter()
            .flat_map(|m| m.iter())
            .filter(|(addr, mapping)| {
                mapping.backing_kind == Some(BackingKind::File)
                    && mapping.snapshot.is_some()
                    && addr.saturating_add(mapping.len as u64) <= mem_len
                    && mapping
                        .backing_key
                        .as_deref()
                        .and_then(|key| self.file_backings.get(key))
                        .is_some_and(|backing| backing.version != mapping.seen_version)
            })
            .map(|(addr, mapping)| {
                // An alias was pulled with its peers in step 1 already.
                let pulled = mapping.backing_key.as_ref().is_some_and(|key| keys[key] > 1);
                (*addr, pulled)
            })
            .collect();
        let mut result = Ok(());
        for (addr, _) in stale.iter().filter(|(_, pulled)| !pulled) {
            match self.pull_mapping(pid, *addr, io) {
                Ok(PullOutcome::WritebackFailed(error)) => {
                    result = Err(error);
                    break;
                }
                Ok(_) => {}
                Err(err) => {
                    result = Err(err);
                    break;
                }
            }
        }
        if result.is_ok() {
            let addrs: Vec<u64> = stale.iter().map(|(addr, _)| *addr).collect();
            result = self.refresh_mappings(pid, &addrs, io);
        }
        for key in keys.keys() {
            if let Some(backing) = self.file_backings.get_mut(key) {
                backing.settle();
            }
        }
        result
    }

    fn sync_file_inner(&mut self, pid: u32, force: bool, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        self.sync_file_from_process_matching(pid, force, &|_| true, io)
    }

    fn sync_file_from_process_matching(
        &mut self, pid: u32, force: bool, matches_handle: &dyn Fn(i64) -> bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let Some(mem_len) = self.process_memory_len(pid, io) else {
            return Ok(());
        };
        // Fold descriptor writes into each backing first, so a mapping whose
        // file changed underneath it is a candidate for refresh below even
        // when it is the backing's sole observer.
        let Some(pid_map) = self.mappings.get(&pid) else { return Ok(()); };
        for mapping in pid_map.values() {
            if mapping.backing_kind == Some(BackingKind::File) {
                if let Some(backing) = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get_mut(key)) {
                    if matches_handle(backing.handle) { backing.reconcile_source(io); }
                }
            }
        }
        let mut candidates = IoBuffer::new();
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
                if !matches_handle(backing.handle) {
                    continue;
                }
                if map_addr.saturating_add(mapping.len as u64) > mem_len {
                    continue;
                }
                let was_stale = mapping.seen_version != backing.version;
                if !force && backing.ref_count <= 1 && !was_stale {
                    continue;
                }
                candidates.try_push(*map_addr)?;
            }
        }
        if candidates.is_empty() {
            return Ok(());
        }

        // Publish all aliases before refreshing any; refresh only changed
        // runs so a concurrent guest store outside those runs is preserved.
        for map_addr in &candidates {
            if let PullOutcome::WritebackFailed(error) = self.pull_mapping(pid, *map_addr, io)? {
                return Err(error);
            }
        }
        self.refresh_mappings(pid, &candidates, io)?;
        self.file_backings.for_each_mut(|backing| {
            if matches_handle(backing.handle) { backing.settle(); }
        });
        Ok(())
    }

    pub fn flush_file_backings_matching(
        &mut self,
        matches_handle: &dyn Fn(i64) -> bool,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        let mut next = self.mappings.keys().next().copied();
        while let Some(pid) = next {
            next = self.mappings.next_after(&pid).map(|(pid, _)| *pid);
            self.sync_file_from_process_matching(pid, true, matches_handle, io)?;
        }
        let mut failure = None;
        self.file_backings.for_each_mut(|backing| {
            if failure.is_none() && matches_handle(backing.handle) {
                match backing.flush_all(io) {
                    Ok(()) => backing.settle(),
                    Err(error) => failure = Some(error),
                }
            }
        });
        if let Some(error) = failure { return Err(error); }
        self.file_backings.retain(|_, backing| {
            if matches_handle(backing.handle) && backing.ref_count == 0 && backing.dirty_pages.is_empty() {
                io.release_handle(backing.handle);
                false
            } else { true }
        });
        Ok(())
    }

    // -- keyed reconciliation, for the file-syscall policy ----------------
    //
    // The host reaches these through an fd or a pathname and keeps a cache to
    // map either onto a backing. The kernel owns the descriptor table and the
    // file identity behind it, so it resolves the key itself and these take
    // the key directly. That is what lets `sharedMmapFdCache`, its four
    // invalidation hooks, and the path-keyed lookups go away rather than be
    // ported.

    /// Publish every observer of a backing, persist it, and drop it if that
    /// left it unreferenced. Mirrors the host's `flushSharedBackingForFd`
    /// once the descriptor has been resolved to a key.
    pub fn flush_backing(&mut self, key: &str, io: &mut dyn SharedMappingIo) -> Result<bool, Errno> {
        let (published, error) = self.pull_backing_outcome(key, None, io)?;
        if let Some(error) = error { return Err(error); }
        if let Some(backing) = self.file_backings.get_mut(key) { backing.flush_all(io)?; }
        self.discard_unreferenced_file_backing(key, io);
        Ok(published)
    }

    /// Reconcile a backing with a file that was written through a descriptor.
    /// A backing that is not tracked is not an error: nothing maps the file.
    pub fn reload_backing(
        &mut self,
        key: &str,
        exact_size: Option<u64>,
        io: &mut dyn SharedMappingIo,
    ) -> bool {
        let Some(backing) = self.file_backings.get_mut(key) else {
            return true;
        };
        backing.reload(exact_size, io)
    }

    /// Apply the bytes a positioned write just put in the file, without
    /// re-reading it. Mirrors `updateSharedMmapBackingFromProcessBuffer`.
    ///
    /// The written bytes are authoritative and are *not* marked dirty: the
    /// file already has them, so marking them dirty would write them back a
    /// second time and could overwrite a peer's later store.
    pub fn apply_written_bytes(
        &mut self,
        key: &str,
        offset: u64,
        bytes: &[u8],
        io: &mut dyn SharedMappingIo,
    ) {
        if bytes.is_empty() || !self.file_backings.contains_key(key) {
            return;
        }
        {
            let backing = self.file_backings.get_mut(key).expect("checked above");
            if backing.revalidate(io).is_err() {
                backing.invalidate_all_stale();
                return;
            }
        }
        let backing = self.file_backings.get_mut(key).expect("checked above");
        if backing.write_range(offset, bytes, false, io).is_err() {
            // The cache could not take the bytes; fall back to treating the
            // range as unknown rather than leaving it holding pre-write bytes.
            let len = bytes.len() as u64;
            let first = offset / FILE_PAGE_SIZE as u64;
            let last = offset.saturating_add(len - 1) / FILE_PAGE_SIZE as u64;
            backing.invalidate_range_stale(first, last);
            return;
        }
        backing.version += 1;
    }

    // -- publish-only pulls and the descriptor fence ----------------------
    //
    // A *pull* compares one mapping's process bytes with its snapshot and
    // merges what changed into the backing. It never writes the process's
    // memory. That is what makes it safe to run on a process other than the
    // one whose syscall is being handled: the pulled process may be running
    // guest code on another thread, and a whole-range refresh of its memory
    // could overwrite a store it made between the read and the write.

    /// Publish one file mapping's stores into its backing, without touching
    /// the process's memory.
    ///
    /// The snapshot becomes the bytes just read, so a later pull finds only
    /// stores made after this one; keeping the old snapshot would merge the
    /// same runs again over a peer's newer bytes. The mapping's
    /// `seen_version` advances only when it was current before its own merge,
    /// because only then does the backing range equal those bytes afterwards.
    fn pull_mapping(
        &mut self,
        pid: u32,
        map_addr: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<PullOutcome, Errno> {
        let Some(mem_len) = self.process_memory_len(pid, io) else {
            // The process is gone; its mappings are published at teardown.
            return Ok(PullOutcome::Unchanged);
        };
        let Self {
            mappings,
            file_backings,
            failures,
            ..
        } = self;
        let Some(mapping) = mappings.get_mut(&pid).and_then(|m| m.get_mut(&map_addr)) else {
            return Ok(PullOutcome::Unchanged);
        };
        if mapping.backing_kind != Some(BackingKind::File) || !mapping.writable {
            return Ok(PullOutcome::Unchanged);
        }
        let Some(key) = mapping.backing_key.clone() else {
            return Ok(PullOutcome::Unchanged);
        };
        let Some(backing) = file_backings.get_mut(&key) else {
            return Ok(PullOutcome::Unchanged);
        };
        if map_addr.saturating_add(mapping.len as u64) > mem_len {
            return Ok(PullOutcome::Unchanged);
        }
        let Some(mut snapshot) = mapping.snapshot.take() else {
            return Ok(PullOutcome::Unchanged);
        };
        // Read the epoch before the comparison: whatever the comparison sees,
        // a later change to the bytes changes the epoch first.
        let epoch = io.quiescent_epoch(pid);
        let log_position = io.kernel_write_position();
        let proved = match (epoch, mapping.clean) {
            (Some(epoch), Some(clean)) => {
                clean.epoch == epoch
                    && snapshot.len() == mapping.len
                    && io.kernel_wrote_since(pid, clean.log_position, map_addr, mapping.len as u64)
                        == Some(false)
            }
            _ => false,
        };
        if proved && SKIP_PROVED_PULLS {
            mapping.snapshot = Some(snapshot);
            return Ok(PullOutcome::Unchanged);
        }
        let observed = epoch.map(|epoch| CleanStamp { epoch, log_position });
        let comparison = match io.process_differs_from_snapshot(pid, map_addr, mapping.len, &snapshot) {
            Ok(comparison) => comparison,
            Err(err) => {
                failures.record("pull_compare", pid, map_addr, mapping.len,
                    mapping.file_offset, backing.handle, 0, mapping.len, err);
                mapping.snapshot = Some(snapshot);
                mapping.clean = None;
                return Err(err);
            }
        };
        if comparison == Some(false) {
            mapping.snapshot = Some(snapshot);
            mapping.clean = observed;
            #[cfg(feature = "shared-mapping-proof-verify")]
            if proved { PROOFS_VERIFIED.fetch_add(1, core::sync::atomic::Ordering::Relaxed); }
            return Ok(PullOutcome::Unchanged);
        }
        let was_current = mapping.seen_version == backing.version;
        let mut changed = false;
        let mut failure = None;
        // Publication is fixed-page scratch, as on the normal descriptor
        // fence path. A full current copy would need another live mapping's
        // credit while its original snapshot must remain owned for retry.
        let mut current = [0u8; FILE_PAGE_SIZE];
        for offset in (0..mapping.len).step_by(FILE_PAGE_SIZE) {
            let chunk = FILE_PAGE_SIZE.min(mapping.len - offset);
            if let Err(err) = io.read_process(pid, map_addr + offset as u64, &mut current[..chunk]) {
                failures.record("pull_page_read", pid, map_addr, mapping.len,
                    mapping.file_offset, backing.handle, offset, chunk, err);
                failure = Some(err);
                break;
            }
            let src = &current[..chunk];
            let snap = snapshot.get_mut(offset..offset + chunk).unwrap_or(&mut []);
            if !range_differs_from_snapshot(src, snap) { continue; }
            if proved {
                crate::writeback_loss::shared_mapping_fault(format_args!(
                    "quiescence proof for pid {pid} mapping {map_addr:#x}+{} at epoch {:?} missed a change",
                    mapping.len, epoch));
            }
            match backing.merge_changed_runs(src, snap, mapping.file_offset + offset as u64, io) {
                Ok(true) => changed = true,
                Ok(false) => {}
                Err(err) => {
                    failures.record("pull_merge", pid, map_addr, mapping.len,
                        mapping.file_offset, backing.handle, offset, chunk, err);
                    failure = Some(err); break;
                }
            }
        }
        // Only completed run merges advance the baseline. Storing a whole
        // freshly read range here would hide unmerged bytes after a refusal.
        mapping.snapshot = Some(snapshot);
        mapping.clean = if failure.is_none() { observed } else { None };
        if let Some(err) = failure { return Err(err); }
        #[cfg(feature = "shared-mapping-proof-verify")]
        if proved { PROOFS_VERIFIED.fetch_add(1, core::sync::atomic::Ordering::Relaxed); }
        if !changed { return Ok(PullOutcome::Unchanged); }
        if was_current {
            mapping.seen_version = backing.version;
        }
        // A write-through backing persists the publication now, so a
        // descriptor `read` sees it.
        if backing.writes_through() {
            if let Err(error) = backing.flush_all(io) {
                self.report_writeback_loss(pid, map_addr, &key, "write failed", io);
                return Ok(PullOutcome::WritebackFailed(error));
            }
        }
        Ok(PullOutcome::Published)
    }

    /// Publish every writable mapping of one backing, in every process
    /// except `except`, into the backing. Publish-only: no process memory is
    /// written (see [`Self::pull_mapping`]).
    ///
    /// Descriptor writes are reconciled first, so a pull merges a mapping's
    /// stores over the file's current bytes rather than over a cache the file
    /// has moved past. A process that is gone is skipped. A refused
    /// write-through is reported through the writeback-loss path (the
    /// mapping's next `msync`, and every open description of the file) and
    /// leaves the pages dirty; the return value says whether every
    /// publication reached the file.
    pub fn pull_backing(&mut self, key: &str, except: Option<u32>, io: &mut dyn SharedMappingIo) -> Result<bool, Errno> {
        // Peer observation reports a failed writeback historically without
        // failing an unrelated observer's syscall; direct fences retain errno.
        self.pull_backing_outcome(key, except, io).map(|(persisted, _)| persisted)
    }

    fn pull_backing_outcome(
        &mut self,
        key: &str,
        except: Option<u32>,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(bool, Option<Errno>), Errno> {
        let Some(backing) = self.file_backings.get_mut(key) else {
            return Ok((true, None));
        };
        backing.reconcile_source(io);
        let targets: Vec<(u32, u64)> = self
            .mappings
            .iter()
            .filter(|(pid, _)| Some(**pid) != except)
            .flat_map(|(pid, m)| {
                m.iter()
                    .filter(|(_, mapping)| {
                        mapping.writable
                            && mapping.backing_kind == Some(BackingKind::File)
                            && mapping.backing_key.as_deref() == Some(key)
                    })
                    .map(move |(addr, _)| (*pid, *addr))
            })
            .collect();
        let mut persisted = true;
        let mut first_writeback_error = None;
        let mut result = Ok(());
        for (pid, addr) in targets {
            match self.pull_mapping(pid, addr, io) {
                Ok(PullOutcome::WritebackFailed(error)) => { persisted = false; first_writeback_error.get_or_insert(error); },
                Ok(_) => {}
                Err(err) => {
                    result = Err(err);
                    break;
                }
            }
        }
        if let Some(backing) = self.file_backings.get_mut(key) {
            backing.settle();
        }
        result.map(|()| (persisted, first_writeback_error))
    }

    /// Make the file behind a stable handle current before the kernel reads
    /// or writes its content through a descriptor: publish every writable
    /// mapping of it, and persist anything still dirty.
    ///
    /// POSIX makes a `MAP_SHARED` mapping and descriptor I/O two views of one
    /// object, so a `read` must observe a store already made through a
    /// mapping, and a `write`, truncation or `O_TRUNC` open must land after
    /// it rather than be overwritten by it at a later publication. This is
    /// the kernel's equivalent of the host's `flushSharedBackingForFd`.
    ///
    /// `Err(EIO)` means a publication or a dirty page could not reach the
    /// file; the descriptor operation fails with it, as the host's does. A
    /// handle no backing holds is not mapped and costs one map lookup.
    pub fn fence_handle(&mut self, handle: i64, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let Some(key) = self.fence_handles.get(&handle).map(|key| copy_mapping_key(key)).transpose()? else {
            return Ok(());
        };
        self.fence_key(&key, io)
    }

    /// Whether a backing holds `handle`, i.e. whether [`Self::fence_handle`]
    /// has any work to do for it.
    pub fn is_fenced_handle(&self, handle: i64) -> bool {
        self.fence_handles.contains_key(&handle)
    }

    /// [`Self::fence_handle`] for every mapped file, for an operation that
    /// names its file by path (`truncate`, an `O_TRUNC` open, `exec`, a host
    /// export) and is not worth resolving before dispatch.
    pub fn fence_all(&mut self, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let keys: Vec<String> = self.file_backings.keys().cloned().collect();
        let mut result = Ok(());
        for key in keys {
            if let Err(err) = self.fence_key(&key, io) {
                result = Err(err);
            }
        }
        result
    }

    fn fence_key(&mut self, key: &str, io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        let (persisted, publication_error) = self.pull_backing_outcome(key, None, io)?;
        let Some(backing) = self.file_backings.get_mut(key) else {
            return publication_error.map_or(Ok(()), Err);
        };
        let flushed = if backing.dirty_page_count() == 0 { Ok(()) } else { backing.flush_all(io) };
        backing.settle();
        if let Some(error) = publication_error { return Err(error); }
        flushed?;
        if persisted { Ok(()) } else { Err(Errno::EIO) }
    }

    // -- writeback-loss reporting ----------------------------------------

    /// Report a writeback loss to the sink. EVERY loss is reported: the sink
    /// is the kernel's writeback-loss record
    /// (`crate::writeback_loss`), which is bounded in storage but exact in
    /// count, so it can publish how many losses it could not store. This layer
    /// used to cap forwarding at a fixed number instead, back when the sink was
    /// a host console write and the only concern was flooding it. That cap is
    /// gone because it would now make the kernel's own running total saturate —
    /// reporting fifty losses after ten thousand is a false statement about
    /// system state, and data corruption is the last thing to be quiet about.
    ///
    /// Every current mapping of the file is told too, so its next `msync`
    /// fails with `EIO` (see [`Self::take_writeback_error`]).
    fn report_writeback_loss(
        &mut self,
        pid: u32,
        map_addr: u64,
        key: &str,
        reason: &str,
        io: &mut dyn SharedMappingIo,
    ) {
        self.mappings.for_each_mut(|pid_map| {
            pid_map.for_each_mut(|mapping| {
                if mapping.backing_kind == Some(BackingKind::File) && mapping.backing_key.as_deref() == Some(key) {
                    mapping.writeback_error = true;
                }
            });
        });
        io.report_writeback_loss(pid, map_addr, key, reason);
    }

    /// Consume the writeback errors pending on `pid`'s file mappings that
    /// overlap `[addr, addr + len)`. True means `msync` must fail with `EIO`.
    pub fn take_writeback_error(&mut self, pid: u32, addr: u64, len: u64) -> bool {
        let end = addr.saturating_add(len);
        let mut pending = false;
        if let Some(pid_map) = self.mappings.get_mut(&pid) {
            let mut next = pid_map.keys().next().copied();
            while let Some(map_addr) = next {
                next = pid_map.next_after(&map_addr).map(|(addr, _)| *addr);
                let mapping = pid_map.get_mut(&map_addr).expect("mapping key just observed");
                let map_end = map_addr.saturating_add(mapping.len as u64);
                if map_addr < end && addr < map_end && mapping.writeback_error {
                    mapping.writeback_error = false;
                    pending = true;
                }
            }
        }
        pending
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
        if self.sysv_mapping(pid, map_addr).is_some() { return Err(Errno::EEXIST); }
        let version = if self.sysv_versions.contains_key(&seg_id) { None } else {
            Some(self.sysv_versions.prepare_io(seg_id, 0)?)
        };
        let mut snapshot = IoBuffer::try_filled(size, 0)?;
        io.shm_read(seg_id, 0, &mut snapshot)?;
        let seen_version = self.sysv_segment_version(seg_id);
        let process = if self.sysv.contains_key(&pid) { None } else {
            Some(self.sysv.prepare_io(pid, ProcessMappings::new(PreparedMap::new()))?)
        };
        let prepared = PreparedMap::new().prepare_io(
            map_addr,
            SysvShmMapping {
                seg_id,
                size,
                read_only,
                snapshot,
                seen_version,
            },
        )?;
        io.write_process(pid, map_addr, &prepared.value().snapshot)?;
        if let Some(version) = version { self.sysv_versions.publish_io(version); }
        if let Some(process) = process { self.sysv.publish_io(process); }
        self.sysv.get_mut(&pid).expect("prepared process missing").publish_io(prepared);
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

        let current = match io.read_process_owned(pid, map_addr, size) {
            Ok(current) => current,
            Err(_) => return false,
        };
        let locally_changed = {
            let mapping = self.sysv.get(&pid).and_then(|m| m.get(&map_addr)).expect("checked");
            !read_only && range_differs_from_snapshot(&current, &mapping.snapshot)
        };
        if !locally_changed && seen_version == current_version {
            return true;
        }

        let Ok(mut authoritative) = IoBuffer::try_filled(size, 0) else {
            return false;
        };
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
                .as_slice();
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
            *self.sysv_versions.get_mut(&seg_id).expect("tracked segment version missing") = current_version + 1;
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
        let mut next = pid_map.keys().next().copied();
        let mut success = true;
        while let Some(map_addr) = next {
            let entries = self.sysv.get(&pid).expect("attachment process missing");
            next = entries.next_after(&map_addr).map(|(addr, _)| *addr);
            let mapping = entries.get(&map_addr).expect("attachment missing");
            let seg_id = mapping.seg_id;
            let seen_version = mapping.seen_version;
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
        let mut next_pid = self.sysv.keys().next().copied();
        while let Some(pid) = next_pid {
            next_pid = self.sysv.next_after(&pid).map(|(pid, _)| *pid);
            let mut next_addr = self.sysv.get(&pid).and_then(|entries| entries.keys().next().copied());
            while let Some(addr) = next_addr {
                let entries = self.sysv.get(&pid).expect("attachment process missing");
                next_addr = entries.next_after(&addr).map(|(addr, _)| *addr);
                if entries.get(&addr).is_some_and(|mapping| mapping.seg_id == seg_id) {
                    self.merge_and_refresh_sysv_mapping(pid, addr, io);
                }
            }
        }
    }

    /// Number of processes that own at least one SysV attachment.
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
    pub fn sysv_attachments_for(&self, pid: u32) -> impl Iterator<Item = (u64, i32, usize, bool)> + '_ {
        self.sysv.get(&pid).into_iter().flat_map(|mappings| mappings.iter())
            .map(|(addr, mapping)| (*addr, mapping.seg_id, mapping.size, mapping.read_only))
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
        if self.sysv_mapping_count_for(child_pid) != 0 {
            return Err(Errno::EEXIST);
        }

        let attachment_count = self.sysv_mapping_count_for(parent_pid);
        let mut recorded = IoBuffer::try_with_capacity(attachment_count).inspect_err(|&error|
            self.failures.record("fork_sysv_prepare", child_pid, 0, 0, 0, -1, 0,
                attachment_count.saturating_mul(core::mem::size_of::<u64>()), error))?;
        let mut failure: Option<Errno> = None;
        for (map_addr, mapping) in self.sysv.get(&parent_pid).into_iter().flat_map(|entries| entries.iter()) {
            let (map_addr, seg_id, size, read_only) = (*map_addr, mapping.seg_id, mapping.size, mapping.read_only);
            match ops.attach(child_pid, seg_id, read_only) {
                // An attachment whose size does not match the parent's record
                // still incremented nattch, so it is released before unwinding.
                Ok(attached) if attached == size => {}
                Ok(_) => {
                    self.failures.record("fork_sysv_attach_size", child_pid, map_addr,
                        size, 0, -1, 0, size, Errno::EIO);
                    ops.detach_segment(child_pid, seg_id);
                    failure = Some(Errno::EIO);
                    break;
                }
                Err(err) => {
                    self.failures.record("fork_sysv_attach", child_pid, map_addr,
                        size, 0, -1, 0, size, err);
                    failure = Some(err);
                    break;
                }
            }
            if let Err(err) = ops.record(child_pid, map_addr, seg_id, size) {
                self.failures.record("fork_sysv_record", child_pid, map_addr,
                    size, 0, -1, 0, size, err);
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
        let removed = pid_map.remove(&map_addr);
        if pid_map.is_empty() {
            self.sysv.remove(&pid);
        }
        if let Some(mapping) = removed {
            self.reclaim_sysv_version(mapping.seg_id);
            true
        } else { false }
    }

    fn reclaim_sysv_version(&mut self, seg_id: i32) {
        if !self.sysv.values().any(|entries| entries.values().any(|mapping| mapping.seg_id == seg_id)) {
            self.sysv_versions.remove(&seg_id);
        }
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
        if let Some(removed) = self.sysv.remove(&pid) {
            for mapping in removed.values() { self.reclaim_sysv_version(mapping.seg_id); }
        }
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
    pub fn flush_mappings(&mut self, pid: u32, sync_addr: u64, sync_len: u64,
        io: &mut dyn SharedMappingIo) -> Result<(), Errno> {
        self.sync_anonymous_from_process(pid, true, io)?;
        if let Err(error) = self.sync_file_from_process(pid, true, io) {
            self.take_writeback_error(pid, sync_addr, sync_len);
            return Err(error);
        }
        let Some(mappings) = self.mappings.get(&pid) else { return Ok(()); };
        let mut targets = IoBuffer::try_with_capacity(mappings.len())?;
        let end = sync_addr.saturating_add(sync_len);
        for (addr, mapping) in mappings.iter() {
            if mapping.backing_kind != Some(BackingKind::File) { continue; }
            let from = sync_addr.max(*addr);
            let to = end.min(addr.saturating_add(mapping.len as u64));
            if from >= to { continue; }
            let key = mapping.backing_key.as_deref().map(copy_mapping_key).transpose()?;
            targets.push((*addr, mapping.file_offset + from - addr, to - from, key));
        }
        let mut failure = None;
        for (addr, offset, len, key) in targets {
            let result = key.as_deref().and_then(|key| self.file_backings.get_mut(key))
                .map(|backing| { let result = backing.flush_range(offset, len, io); backing.settle(); result })
                .unwrap_or(Err(Errno::EIO));
            if let Err(error) = result {
                self.report_writeback_loss(pid, addr, key.as_deref().unwrap_or(""), "write failed", io);
                failure.get_or_insert(error);
            }
        }
        // Reporting this caller's error consumes only its own pending flag;
        // other mappings must still observe the failed writeback at msync.
        if self.take_writeback_error(pid, sync_addr, sync_len) { failure.get_or_insert(Errno::EIO); }
        failure.map_or(Ok(()), Err)
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
    /// backing, so the backing's reference count goes up: it is released only
    /// after both halves are.
    pub(crate) fn stage_cleanup_mappings(&self, pid: u32, addr: u64, len: u64) -> Result<MappingCleanup, Errno> {
        let mut splits = PreparedMap::new();
        if let Some(mappings) = self.mappings.get(&pid) {
            let end = addr.saturating_add(len);
            for (start, mapping) in mappings {
                let map_end = start.saturating_add(mapping.len as u64);
                if *start < addr && end < map_end && addr < end {
                    let offset = (end - start) as usize;
                    let right = mapping.try_copy_range(offset, (map_end - end) as usize)?;
                    splits.try_insert_io(*start, right)?;
                }
            }
        }
        Ok(MappingCleanup { pid, addr, len, splits })
    }

    pub(crate) fn publish_cleanup_preparation(&mut self, plan: MappingCleanup) {
        self.pending_cleanup = Some(plan);
    }

    pub fn prepare_cleanup_mappings(&mut self, pid: u32, addr: u64, len: u64) -> Result<(), Errno> {
        self.pending_cleanup = None;
        let plan = self.stage_cleanup_mappings(pid, addr, len)?;
        self.publish_cleanup_preparation(plan);
        Ok(())
    }

    pub fn cancel_cleanup_mappings(&mut self) { self.pending_cleanup = None; }

    pub fn cleanup_mappings(
        &mut self,
        pid: u32,
        addr: u64,
        len: u64,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if !self.pending_cleanup.as_ref().is_some_and(|plan| plan.pid == pid && plan.addr == addr && plan.len == len) {
            self.prepare_cleanup_mappings(pid, addr, len)?;
        }
        let mut plan = self.pending_cleanup.take().expect("cleanup plan missing");
        let Some(pid_map) = self.mappings.get(&pid) else {
            return Ok(());
        };
        let unmap_end = addr.saturating_add(len);
        let mut next = pid_map.keys().next().copied();

        while let Some(map_addr) = next {
            next = self.mappings.get(&pid).and_then(|m| m.next_after(&map_addr)).map(|(addr, _)| *addr);
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
                continue;
            }

            // Head removed: the tail slides up.
            if overlap_start <= map_addr {
                let trim = (overlap_end - map_addr) as usize;
                let mut entry = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.remove_entry(&map_addr))
                    .expect("checked above");
                let mapping = entry.value_mut();
                mapping.file_offset += trim as u64;
                mapping.len = (map_end - overlap_end) as usize;
                mapping.clean = None;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    let trim = trim.min(snapshot.len());
                    snapshot.copy_within(trim.., 0);
                    snapshot.truncate(snapshot.len() - trim);
                }
                entry.replace_key(overlap_end);
                self.mappings.get_mut(&pid).expect("process missing").publish_io(entry);
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
                mapping.clean = None;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    snapshot.truncate(mapping.len);
                }
                continue;
            }

            // Middle removed: split into two sub-mappings.
            let left_len = (overlap_start - map_addr) as usize;
            let mut right = plan.splits.remove_entry(&map_addr).expect("prepared split missing");
            {
                let mapping = self
                    .mappings
                    .get_mut(&pid)
                    .and_then(|m| m.get_mut(&map_addr))
                    .expect("checked above");
                if let (Some(source), Some(target)) = (mapping.snapshot.as_ref(), right.value_mut().snapshot.as_mut()) {
                    let skip = (overlap_end - map_addr) as usize;
                    target.copy_from_slice(&source[skip..]);
                }
                right.value_mut().seen_version = mapping.seen_version;
                mapping.len = left_len;
                mapping.clean = None;
                right.value_mut().clean = None;
                if let Some(snapshot) = mapping.snapshot.as_mut() {
                    snapshot.truncate(left_len);
                }
            }
            match (right.value().backing_kind, right.value().backing_key.as_deref()) {
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
            right.replace_key(overlap_end);
            self.mappings.get_mut(&pid).expect("process missing").publish_io(right);
        }

        if self.mappings.get(&pid).is_some_and(|m| m.is_empty()) {
            self.mappings.remove(&pid);
        }
        Ok(())
    }

    /// Move (and possibly grow) a mapping for `mremap`, re-seeding the moved
    /// interval from the authoritative store so the new address observes the
    /// same shared object rather than stale copied bytes.
    pub fn prepare_remap_mapping(
        &mut self,
        pid: u32,
        old_addr: u64,
        new_len: usize,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        self.pending_remap = None;
        self.sync_anonymous_from_process(pid, true, io)?;
        self.sync_file_from_process(pid, true, io)?;
        let Some(mapping) = self.mappings.get(&pid).and_then(|entries| entries.get(&old_addr)) else {
            return Ok(());
        };
        let mut plan = MappingRemap {
            pid, old_addr, len: new_len, snapshot: None,
            version: mapping.seen_version, anonymous_growth: None,
        };
        let file_offset = mapping.file_offset;
        if let Some(key) = mapping.backing_key.as_deref().filter(|_| mapping.snapshot.is_some()) {
            match mapping.backing_kind {
                Some(BackingKind::File) => {
                    let backing = self.file_backings.get_mut(key).ok_or(Errno::EIO)?;
                    backing.reconcile_source(io);
                    let latest = backing.read_range(file_offset, new_len, io);
                    backing.settle();
                    plan.snapshot = Some(latest?);
                    plan.version = backing.version;
                }
                Some(BackingKind::Anonymous) => {
                    let backing = self.anon_backings.get(key).ok_or(Errno::EIO)?;
                    let base = usize::try_from(file_offset).map_err(|_| Errno::EINVAL)?;
                    let required = base.checked_add(new_len).ok_or(Errno::EINVAL)?;
                    let mut latest = IoBuffer::try_filled(new_len, 0)?;
                    let count = backing.bytes.len().saturating_sub(base).min(new_len);
                    if count != 0 { latest[..count].copy_from_slice(&backing.bytes[base..base + count]); }
                    plan.snapshot = Some(latest);
                    plan.version = backing.version;
                    if required > backing.bytes.len() {
                        let mut replacement = IoBuffer::try_filled(required, 0)?;
                        replacement[..backing.bytes.len()].copy_from_slice(&backing.bytes);
                        plan.anonymous_growth = Some(replacement);
                    }
                }
                None => {}
            }
        } else if let Some(snapshot) = mapping.snapshot.as_ref() {
            plan.snapshot = Some(IoBuffer::copy_from(&snapshot[..snapshot.len().min(new_len)])?);
        }
        self.pending_remap = Some(plan);
        Ok(())
    }

    pub fn cancel_remap_mapping(&mut self) { self.pending_remap = None; }

    pub fn remap_mapping(
        &mut self,
        pid: u32,
        old_addr: u64,
        new_addr: u64,
        new_len: usize,
        io: &mut dyn SharedMappingIo,
    ) -> Result<(), Errno> {
        if self.mapping(pid, old_addr).is_none() { return Ok(()); }
        if old_addr != new_addr && self.mapping(pid, new_addr).is_some() { return Err(Errno::EEXIST); }
        if !self.pending_remap.as_ref().is_some_and(|plan| plan.pid == pid && plan.old_addr == old_addr && plan.len == new_len) {
            self.prepare_remap_mapping(pid, old_addr, new_len, io)?;
        }
        let mut plan = self.pending_remap.take().expect("remap plan missing");
        let mapping = self.mappings.get(&pid).and_then(|entries| entries.get(&old_addr)).expect("mapping missing");
        if let Some(growth) = plan.anonymous_growth.as_mut() {
            let base = mapping.file_offset as usize;
            if new_len > mapping.len {
                io.read_process(pid, new_addr + mapping.len as u64, &mut growth[base + mapping.len..base + new_len])?;
            }
            if let Some(snapshot) = plan.snapshot.as_mut() { snapshot.copy_from_slice(&growth[base..base + new_len]); }
        }
        if let Some(snapshot) = plan.snapshot.as_ref() { io.write_process(pid, new_addr, snapshot)?; }
        if let Some(growth) = plan.anonymous_growth {
            let key = mapping.backing_key.as_deref().ok_or(Errno::EIO)?;
            let backing = self.anon_backings.get_mut(key).ok_or(Errno::EIO)?;
            backing.bytes = growth;
            backing.version += 1;
            plan.version = backing.version;
        }
        let entries = self.mappings.get_mut(&pid).expect("process missing");
        let mut entry = entries.remove_entry(&old_addr).expect("mapping missing");
        let mapping = entry.value_mut();
        mapping.len = new_len;
        mapping.clean = None;
        mapping.snapshot = plan.snapshot;
        mapping.seen_version = plan.version;
        entry.replace_key(new_addr);
        entries.publish_io(entry);
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
        pid_map.retain(|map_addr, mapping| {
            let map_end = map_addr.saturating_add(mapping.len as u64);
            if map_end <= addr || *map_addr >= protect_end {
                return true;
            }
            mapping.writable = true;
            true
        });
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
        if self.pending_file_mapping.as_ref().is_some_and(|pending| pending.pid == pid) {
            self.cancel_kernel_file_mapping(io);
        }
        if self.pending_cleanup.as_ref().is_some_and(|pending| pending.pid == pid) { self.cancel_cleanup_mappings(); }
        if self.pending_remap.as_ref().is_some_and(|pending| pending.pid == pid) { self.cancel_remap_mapping(); }
        if self.mappings.get(&pid).is_some_and(|mappings| mappings.releasing)
            || self.sysv.get(&pid).is_some_and(|mappings| mappings.releasing) {
            return;
        }
        if let Some(mappings) = self.mappings.get_mut(&pid) { mappings.releasing = true; }
        if let Some(mappings) = self.sysv.get_mut(&pid) { mappings.releasing = true; }

        if publish && self.process_memory_len(pid, io).is_some() {
            let anonymous_failed = self.sync_anonymous_from_process(pid, true, io).is_err();
            let file_failed = self.sync_file_from_process(pid, true, io).is_err();
            self.sync_sysv_from_process(pid, true, io);

            for (addr, mapping) in self.mappings.get(&pid).into_iter().flat_map(|mappings| mappings.iter()) {
                if !mapping.writable { continue; }
                let failed = match mapping.backing_kind {
                    Some(BackingKind::File) => file_failed,
                    Some(BackingKind::Anonymous) => anonymous_failed,
                    None => false,
                };
                let key = mapping.backing_key.as_deref().unwrap_or("");
                if failed {
                    match mapping.has_unpublished_changes(pid, *addr, io) {
                        Ok(true) => io.report_writeback_loss(pid, *addr, key, "publication failed"),
                        Err(_) => io.report_writeback_loss(pid, *addr, key, "process read failed"),
                        Ok(false) => {}
                    }
                }
                if mapping.backing_kind != Some(BackingKind::File) { continue; }
                if let Some(backing) = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get_mut(key)) {
                    // A failed final writeback keeps the dirty pages on the
                    // backing (see `release_file_backing_reference`), but this
                    // process's stores are no longer guaranteed to reach the
                    // file, so the loss is recorded rather than left silent.
                    if backing.flush_range(mapping.file_offset, mapping.len as u64, io).is_err() {
                        io.report_writeback_loss(pid, *addr, key, "write failed");
                    }
                }
            }
        }

        if let Some(mappings) = self.mappings.remove(&pid) {
            for mapping in mappings.values() {
                self.release_mapping(mapping, io);
            }
        }
        self.release_all_sysv_for_process(pid, false, io);

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
        let child_bytes = self.process_memory_len(child_pid, io).ok_or(Errno::ESRCH)?;

        // WHY: a fork can refuse either retained child state or temporary
        // rollback storage. Distinguish those owners before considering any
        // change in admission policy; fixed records never retain resources.
        let failures = &mut self.failures;
        // --- stage -------------------------------------------------------
        let mut staged = PreparedMap::new();
        for (map_addr, mapping) in self.mappings.get(&parent_pid).into_iter().flat_map(|entries| entries.iter()) {
            if map_addr.saturating_add(mapping.len as u64) > child_bytes {
                return Err(Errno::EINVAL);
            }
            let Some(key) = mapping.backing_key.as_deref() else {
                continue;
            };
            let (latest, version) = match mapping.backing_kind {
                Some(BackingKind::File) => {
                    let Some(backing) = self.file_backings.get_mut(key) else {
                        return Err(Errno::EINVAL);
                    };
                    backing.reconcile_source(io);
                    let version = backing.version;
                    let latest = backing.read_range(mapping.file_offset, mapping.len, io)
                        .inspect_err(|&error| failures.record("fork_stage_read", child_pid,
                            *map_addr, mapping.len, mapping.file_offset, backing.handle,
                            0, mapping.len, error));
                    backing.settle();
                    (latest?, version)
                }
                _ => {
                    let Some(backing) = self.anon_backings.get(key) else {
                        return Err(Errno::EINVAL);
                    };
                    let base = mapping.file_offset as usize;
                    if base.saturating_add(mapping.len) > backing.bytes.len() {
                        return Err(Errno::EINVAL);
                    }
                    (IoBuffer::copy_from(&backing.bytes[base..base + mapping.len])
                        .inspect_err(|&error| failures.record("fork_anon_stage", child_pid,
                            *map_addr, mapping.len, mapping.file_offset, -1,
                            0, mapping.len, error))?, backing.version)
                }
            };
            let mut inherited = mapping.try_copy_range(0, 0).inspect_err(|&error| {
                let handle = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get(key))
                    .map_or(-1, |backing| backing.handle);
                failures.record("fork_stage_copy", child_pid, *map_addr, mapping.len,
                    mapping.file_offset, handle, 0, core::mem::size_of::<SharedMapping>(), error);
            })?;
            inherited.len = mapping.len;
            inherited.snapshot = Some(latest);
            inherited.seen_version = version;
            inherited.clean = None;
            staged.try_insert_io(*map_addr, inherited).inspect_err(|&error| {
                let handle = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get(key))
                    .map_or(-1, |backing| backing.handle);
                failures.record("fork_stage_metadata", child_pid, *map_addr, mapping.len,
                    mapping.file_offset, handle, 0, core::mem::size_of::<SharedMapping>(), error);
            })?;
        }

        let mut staged_sysv = PreparedMap::new();
        for (map_addr, mapping) in self.sysv.get(&parent_pid).into_iter().flat_map(|entries| entries.iter()) {
            if mapping.size == 0
                || mapping.seg_id < 0
                || map_addr.saturating_add(mapping.size as u64) > child_bytes
            {
                return Err(Errno::EINVAL);
            }
            let mut latest = IoBuffer::try_filled(mapping.size, 0).inspect_err(|&error|
                failures.record("fork_sysv_alloc", child_pid, *map_addr, mapping.size,
                    0, -1, 0, mapping.size, error))?;
            io.shm_read(mapping.seg_id, 0, &mut latest).inspect_err(|&error|
                failures.record("fork_sysv_read", child_pid, *map_addr, mapping.size,
                    0, -1, 0, mapping.size, error))?;
            staged_sysv.try_insert_io(*map_addr, SysvShmMapping {
                seg_id: mapping.seg_id,
                size: mapping.size,
                read_only: mapping.read_only,
                snapshot: latest,
                seen_version: self.sysv_versions.get(&mapping.seg_id).copied().unwrap_or(0),
            }).inspect_err(|&error| failures.record("fork_sysv_metadata", child_pid,
                *map_addr, mapping.size, 0, -1, 0, core::mem::size_of::<SysvShmMapping>(), error))?;
        }

        // Snapshot the child bytes each publication overwrites, so a failed
        // commit can put the child's address space back as it was.
        let original_count = staged.len().checked_add(staged_sysv.len()).ok_or(Errno::ENOMEM)
            .inspect_err(|&error| failures.record("fork_rollback_metadata", child_pid,
                0, 0, 0, -1, 0, usize::MAX, error))?;
        let mut originals = IoBuffer::try_with_capacity(original_count).inspect_err(|&error|
            failures.record("fork_rollback_metadata", child_pid, 0, 0, 0, -1, 0,
                original_count.saturating_mul(core::mem::size_of::<(u64, IoBuffer<u8>)>()), error))?;
        for (map_addr, mapping) in &staged {
            let mut bytes = IoBuffer::try_filled(mapping.len, 0).inspect_err(|&error| {
                let handle = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get(key))
                    .map_or(-1, |backing| backing.handle);
                failures.record("fork_rollback_alloc", child_pid, *map_addr, mapping.len,
                    mapping.file_offset, handle, 0, mapping.len, error);
            })?;
            io.read_process(child_pid, *map_addr, &mut bytes).inspect_err(|&error| {
                let handle = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get(key))
                    .map_or(-1, |backing| backing.handle);
                failures.record("fork_rollback_read", child_pid, *map_addr, mapping.len,
                    mapping.file_offset, handle, 0, mapping.len, error);
            })?;
            originals.push((*map_addr, bytes));
        }
        for (map_addr, mapping) in &staged_sysv {
            let mut bytes = IoBuffer::try_filled(mapping.size, 0).inspect_err(|&error|
                failures.record("fork_sysv_rollback_alloc", child_pid, *map_addr, mapping.size,
                    0, -1, 0, mapping.size, error))?;
            io.read_process(child_pid, *map_addr, &mut bytes).inspect_err(|&error|
                failures.record("fork_sysv_rollback_read", child_pid, *map_addr, mapping.size,
                    0, -1, 0, mapping.size, error))?;
            originals.push((*map_addr, bytes));
        }

        let staged = if staged.is_empty() { None } else {
            Some(self.mappings.prepare_io(child_pid, ProcessMappings::new(staged))
                .inspect_err(|&error| failures.record("fork_map_admit", child_pid,
                    0, 0, 0, -1, 0, core::mem::size_of::<ProcessMappings<SharedMapping>>(), error))?)
        };
        let staged_sysv = if staged_sysv.is_empty() { None } else {
            Some(self.sysv.prepare_io(child_pid, ProcessMappings::new(staged_sysv))
                .inspect_err(|&error| failures.record("fork_sysv_admit", child_pid,
                    0, 0, 0, -1, 0, core::mem::size_of::<ProcessMappings<SysvShmMapping>>(), error))?)
        };

        // --- commit ------------------------------------------------------
        let mut failure: Option<Errno> = None;
        for (map_addr, mapping) in staged.as_ref().into_iter().flat_map(|entry| entry.value().iter()) {
            if let Err(err) = io.write_process(child_pid, *map_addr, mapping.snapshot.as_deref().unwrap_or(&[])) {
                let handle = mapping.backing_key.as_deref().and_then(|key| self.file_backings.get(key))
                    .map_or(-1, |backing| backing.handle);
                failures.record("fork_commit_write", child_pid, *map_addr, mapping.len,
                    mapping.file_offset, handle, 0, mapping.len, err);
                failure = Some(err);
                break;
            }
        }
        if failure.is_none() {
            for (map_addr, mapping) in staged_sysv.as_ref().into_iter().flat_map(|entry| entry.value().iter()) {
                if let Err(err) = io.write_process(child_pid, *map_addr, &mapping.snapshot) {
                    failures.record("fork_sysv_commit_write", child_pid, *map_addr, mapping.size,
                        0, -1, 0, mapping.size, err);
                    failure = Some(err);
                    break;
                }
            }
        }
        if let Some(err) = failure {
            for (map_addr, bytes) in originals {
                if let Err(error) = io.write_process(child_pid, map_addr, &bytes) {
                    let mapping = staged.as_ref().and_then(|entry| entry.value().get(&map_addr));
                    let handle = mapping.and_then(|mapping| mapping.backing_key.as_deref())
                        .and_then(|key| self.file_backings.get(key)).map_or(-1, |backing| backing.handle);
                    failures.record("fork_rollback_write", child_pid, map_addr, bytes.len(),
                        mapping.map_or(0, |mapping| mapping.file_offset), handle, 0, bytes.len(), error);
                }
            }
            return Err(err);
        }

        for mapping in staged.as_ref().into_iter().flat_map(|entry| entry.value().values()) {
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
        }
        if let Some(staged) = staged { self.mappings.publish_io(staged); }
        if let Some(staged_sysv) = staged_sysv { self.sysv.publish_io(staged_sysv); }
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

/// Machine-wide authority for every kernel-owned shared mapping, the backings
/// behind them, and the SysV attachment mirror.
///
/// This is a peer of [`crate::ipc::global_ipc_table`] rather than a
/// `ProcessTable` field on purpose: the kernel's `SharedMappingIo` borrows the
/// process table (for a peer's committed memory floor), so owning the table
/// outside it keeps that borrow disjoint instead of aliasing it.
///
/// # Safety
/// Must only be called from a single-threaded context (Wasm is
/// single-threaded), and the returned reference must not be held across a
/// re-entry into the same table.
pub unsafe fn global_shared_mapping_table() -> &'static mut SharedMappingTable {
    unsafe { &mut *SHARED_MAPPING_TABLE.0.get() }
}

struct KernelProcessWriteLogCell(core::cell::UnsafeCell<KernelProcessWriteLog>);
// SAFETY: as for `SharedMappingTableCell`: single-threaded kernel Wasm, every
// access serialized under the global kernel lock.
unsafe impl Sync for KernelProcessWriteLogCell {}

/// Kept apart from [`SHARED_MAPPING_TABLE`] so a syscall path can record a
/// write without borrowing the table, which a caller up the stack may hold.
static KERNEL_PROCESS_WRITES: KernelProcessWriteLogCell =
    KernelProcessWriteLogCell(core::cell::UnsafeCell::new(KernelProcessWriteLog::new()));

/// Record a process-memory write the kernel made through a syscall path; see
/// [`KernelProcessWriteLog`].
pub fn note_kernel_process_write(pid: u32, addr: u64, len: u64) {
    // SAFETY: single-threaded kernel; the borrow ends within this call and no
    // reference to the log escapes any function in this module.
    unsafe { (*KERNEL_PROCESS_WRITES.0.get()).record(pid, addr, len) }
}

/// Run `f` with the machine-wide kernel write log.
pub fn with_kernel_process_write_log<R>(f: impl FnOnce(&KernelProcessWriteLog) -> R) -> R {
    // SAFETY: single-threaded kernel. `f` receives a shared borrow only, and
    // the table code it runs never records a write (its own refresh writes
    // bypass the log), so no mutable borrow can overlap it.
    f(unsafe { &*KERNEL_PROCESS_WRITES.0.get() })
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
        /// Handles whose retain the environment refuses, standing in for an
        /// object that is already gone.
        refuse_retain: BTreeSet<i64>,
        /// Handle -> content generation, for files modelled as kernel-owned:
        /// every write to them, through the mapping layer or not, is visible.
        generations: BTreeMap<i64, u64>,
        shm: BTreeMap<i32, Vec<u8>>,
        losses: Vec<(u32, u64, String)>,
        fail_pwrite: bool,
        pwrite_error: Option<Errno>,
        write_budget: Option<usize>,
        fail_read_process_address: Option<u64>,
        fail_write_process_at: Option<u64>,
        fail_read_process_at: Option<(u32, u64)>,
        /// pid -> process reads, i.e. snapshot comparisons and copies.
        process_reads: BTreeMap<u32, usize>,
        /// A store another thread of `pid` makes right after the next read
        /// of its memory, standing in for a sibling running concurrently.
        store_after_read: Option<(u32, u64, Vec<u8>)>,
        /// The host's mutation epoch per process (see `CleanStamp`).
        epochs: BTreeMap<u32, u64>,
        /// Processes every thread of which is parked in a syscall.
        parked: BTreeSet<u32>,
        /// The kernel's own writes into process memory.
        kernel_log: KernelProcessWriteLog,
    }

    impl MockIo {
        fn new() -> Self {
            Self {
                procs: BTreeMap::new(),
                files: BTreeMap::new(),
                idents: BTreeMap::new(),
                retained: BTreeMap::new(),
                refuse_retain: BTreeSet::new(),
                generations: BTreeMap::new(),
                shm: BTreeMap::new(),
                losses: Vec::new(),
                fail_pwrite: false,
                pwrite_error: None,
                write_budget: None,
                fail_read_process_address: None,
                fail_write_process_at: None,
                fail_read_process_at: None,
                process_reads: BTreeMap::new(),
                store_after_read: None,
                epochs: BTreeMap::new(),
                parked: BTreeSet::new(),
                kernel_log: KernelProcessWriteLog::new(),
            }
        }

        /// Every thread of `pid` parks in a syscall.
        fn park(&mut self, pid: u32) {
            self.parked.insert(pid);
        }

        /// A completion is published: guest code of `pid` may run.
        fn resume(&mut self, pid: u32) {
            self.parked.remove(&pid);
            *self.epochs.entry(pid).or_insert(0) += 1;
        }

        /// A completion is materialized while the process is still parked
        /// (its output bytes land): an epoch event, without resuming it.
        fn materialize(&mut self, pid: u32) {
            *self.epochs.entry(pid).or_insert(0) += 1;
        }

        /// A syscall output the kernel stores into process memory, as
        /// `HostIO::proc_write_bytes` does: logged, and an epoch event.
        fn kernel_store(&mut self, pid: u32, addr: u64, bytes: &[u8]) {
            self.kernel_log.record(pid, addr, bytes.len() as u64);
            *self.epochs.entry(pid).or_insert(0) += 1;
            self.poke(pid, addr, bytes);
        }

        fn reads_of(&self, pid: u32) -> usize {
            self.process_reads.get(&pid).copied().unwrap_or(0)
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

        /// A file the environment owns itself, as the kernel owns rootfs,
        /// tmpfs and memfd files: it reports a content generation.
        fn with_kernel_file(mut self, handle: i64, dev: u64, ino: u64, bytes: Vec<u8>) -> Self {
            self = self.with_file(handle, dev, ino, bytes);
            self.generations.insert(handle, 1);
            self
        }

        /// A write that reaches a kernel-owned file through a descriptor,
        /// bypassing every mapping.
        fn descriptor_write(&mut self, handle: i64, offset: usize, bytes: &[u8]) {
            let file = self.files.get_mut(&handle).expect("file");
            if offset + bytes.len() > file.len() {
                file.resize(offset + bytes.len(), 0);
            }
            file[offset..offset + bytes.len()].copy_from_slice(bytes);
            *self.generations.get_mut(&handle).expect("kernel file") += 1;
        }

        fn retained_count(&self, handle: i64) -> i32 {
            self.retained.get(&handle).copied().unwrap_or(0)
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
            *self.process_reads.entry(pid).or_insert(0) += 1;
            if self.fail_read_process_address == Some(addr) { return Err(Errno::EFAULT); }
            let mem = self.procs.get(&pid).ok_or(Errno::ESRCH)?;
            let at = addr as usize;
            if at + dst.len() > mem.len() {
                return Err(Errno::EFAULT);
            }
            if self.fail_read_process_at == Some((pid, addr)) {
                // A failed full read may have initialized only a prefix. The
                // owned-read API must not return or publish that partial data.
                if let Some(first) = dst.first_mut() {
                    *first = 0xd7;
                }
                return Err(Errno::EFAULT);
            }
            dst.copy_from_slice(&mem[at..at + dst.len()]);
            if self.store_after_read.as_ref().is_some_and(|(p, _, _)| *p == pid) {
                let (_, addr, bytes) = self.store_after_read.take().unwrap();
                self.poke(pid, addr, &bytes);
            }
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
            // `host_proc_write_bytes` is an epoch event.
            *self.epochs.entry(pid).or_insert(0) += 1;
            Ok(())
        }

        fn quiescent_epoch(&mut self, pid: u32) -> Option<u64> {
            self.parked
                .contains(&pid)
                .then(|| self.epochs.get(&pid).copied().unwrap_or(0))
        }

        fn kernel_write_position(&mut self) -> u64 {
            self.kernel_log.position()
        }

        fn kernel_wrote_since(&mut self, pid: u32, since: u64, addr: u64, len: u64) -> Option<bool> {
            self.kernel_log.wrote_since(pid, since, addr, len)
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
            if let Some(error) = self.pwrite_error {
                return Err(error);
            }
            if self.fail_pwrite {
                return Err(Errno::EIO);
            }
            let count = self.write_budget.map_or(src.len(), |budget| budget.min(src.len()));
            if count == 0 && !src.is_empty() {
                return Err(Errno::ENOSPC);
            }
            let file = self.files.get_mut(&handle).ok_or(Errno::EBADF)?;
            let at = offset as usize;
            if at + count > file.len() {
                file.resize(at + count, 0);
            }
            file[at..at + count].copy_from_slice(&src[..count]);
            if let Some(budget) = &mut self.write_budget {
                *budget -= count;
            }
            if let Some(generation) = self.generations.get_mut(&handle) {
                *generation += 1;
            }
            Ok(count)
        }

        fn content_generation(&mut self, handle: i64) -> Option<u64> {
            self.generations.get(&handle).copied()
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
            if self.refuse_retain.contains(&handle) {
                return Err(Errno::EBADF);
            }
            *self.retained.entry(handle).or_insert(0) += 1;
            Ok(())
        }

        fn release_handle(&mut self, handle: i64) {
            // A release the table never retained would strand the object's
            // lifetime in production, so a test must not pass through it.
            let count = self.retained.entry(handle).or_insert(0);
            assert!(*count > 0, "released handle {handle}, which no backing held");
            *count -= 1;
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

        fn report_writeback_loss(&mut self, pid: u32, map_addr: u64, _file_key: &str, reason: &str) {
            self.losses.push((pid, map_addr, reason.to_string()));
        }
    }

    // -- run-diff primitives ---------------------------------------------

    #[test]
    fn snapshot_comparison_preserves_empty_and_unequal_lengths() {
        for len in 0..=136 {
            let bytes = vec![7u8; len];
            assert!(!range_differs_from_snapshot(&bytes, &bytes));
            assert!(!snapshot_words_differ(&bytes, &bytes));
            for other_len in [len + 1, len + 7] {
                let other = vec![7u8; other_len];
                assert!(range_differs_from_snapshot(&bytes, &other));
                assert!(range_differs_from_snapshot(&other, &bytes));
                assert!(snapshot_words_differ(&bytes, &other));
                assert!(snapshot_words_differ(&other, &bytes));
            }
        }
    }

    #[test]
    fn snapshot_word_comparison_checks_every_unaligned_byte_and_tail() {
        for len in 0..=136 {
            for source_offset in 0..8 {
                let source: Vec<u8> = (0..len + source_offset)
                    .map(|i| (i * 73 + 11) as u8)
                    .collect();
                let source = &source[source_offset..];
                for snapshot_offset in 0..8 {
                    let mut backing = vec![0u8; len + snapshot_offset];
                    let snapshot = &mut backing[snapshot_offset..];
                    snapshot.copy_from_slice(source);
                    assert!(!snapshot_words_differ(source, snapshot));
                    for at in 0..len {
                        snapshot[at] ^= 1;
                        assert!(
                            snapshot_words_differ(source, snapshot),
                            "missed byte {at} of length {len} at offsets {source_offset}/{snapshot_offset}"
                        );
                        snapshot[at] ^= 1;
                    }
                }
            }
        }
    }

    #[test]
    fn snapshot_word_comparison_checks_page_sized_and_partial_page_ranges() {
        for len in [255, 256, 257, 511, 512, 4095, 4096, 4097, 16384] {
            let source: Vec<u8> = (0..len).map(|i| (i * 73 + 11) as u8).collect();
            let mut snapshot = source.clone();
            assert!(!snapshot_words_differ(&source, &snapshot));
            for at in [0, 7, 8, 63, 64, len / 2, len - 1] {
                snapshot[at] ^= 1;
                assert!(snapshot_words_differ(&source, &snapshot));
                snapshot[at] ^= 1;
            }
            assert_eq!(snapshot, source);
        }
    }

    #[test]
    fn changed_runs_finds_only_differing_spans() {
        assert_eq!(changed_runs(b"abcdef", b"abcdef").collect::<Vec<_>>(), Vec::new());
        assert_eq!(changed_runs(b"aXcdYf", b"abcdef").collect::<Vec<_>>(), vec![(1, 2), (4, 5)]);
        assert_eq!(changed_runs(b"XXcdef", b"abcdef").collect::<Vec<_>>(), vec![(0, 2)]);
        assert_eq!(changed_runs(b"abcdXX", b"abcdef").collect::<Vec<_>>(), vec![(4, 6)]);
    }

    #[test]
    fn a_short_snapshot_treats_every_trailing_byte_as_changed() {
        // Publishing more than necessary is the safe direction; publishing less
        // would silently drop a MAP_SHARED store.
        assert_eq!(changed_runs(b"abcd", b"ab").collect::<Vec<_>>(), vec![(2, 4)]);
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

    #[test]
    fn owned_process_snapshot_default_preserves_full_read_and_error_contract() {
        let mut io = MockIo::new().with_process(1, 8);
        io.poke(1, 0, b"ABCDEFGH");
        assert_eq!(io.read_process_owned(1, 2, 4).unwrap(), b"CDEF".to_vec());
        assert_eq!(io.read_process_owned(99, u64::MAX, 0).unwrap(), Vec::<u8>::new());
        assert_eq!(io.read_process_owned(99, 0, 1), Err(Errno::ESRCH));
        assert_eq!(io.read_process_owned(1, 7, 2), Err(Errno::EFAULT));
        io.fail_read_process_at = Some((1, 2));
        assert_eq!(io.read_process_owned(1, 2, 4), Err(Errno::EFAULT));
        assert_eq!(io.peek(1, 0, 8), b"ABCDEFGH".to_vec());
        io.fail_read_process_at = None;
        assert_eq!(io.read_process_owned(1, 2, 4).unwrap(), b"CDEF".to_vec());
    }

    #[test]
    fn conditional_process_snapshot_default_checks_bytes_lengths_and_faults() {
        let mut io = MockIo::new().with_process(1, 8);
        io.poke(1, 0, b"ABCDEFGH");
        let baseline = b"CDEF".to_vec();
        assert_eq!(io.read_process_if_changed(1, 2, 4, &baseline), Ok(None));
        assert_eq!(io.read_process_if_changed(1, 2, 4, b"CD").unwrap().as_deref(), Some(&b"CDEF"[..]));
        assert_eq!(io.read_process_if_changed(1, 2, 4, b"CDEFX").unwrap().as_deref(), Some(&b"CDEF"[..]));
        assert_eq!(io.read_process_if_changed(99, u64::MAX, 0, &[]), Ok(None));
        assert_eq!(io.read_process_if_changed(99, 0, 1, b"A"), Err(Errno::ESRCH));
        assert_eq!(io.read_process_if_changed(1, 7, 2, b"H?"), Err(Errno::EFAULT));
        io.poke(1, 3, b"Z");
        assert_eq!(io.read_process_if_changed(1, 2, 4, &baseline).unwrap().as_deref(), Some(&b"CZEF"[..]));
        io.fail_read_process_at = Some((1, 2));
        assert_eq!(io.read_process_if_changed(1, 2, 4, &baseline), Err(Errno::EFAULT));
        assert_eq!(baseline, b"CDEF".to_vec(), "failed partial read cannot change the baseline");
        assert_eq!(io.peek(1, 0, 8), b"ABCZEFGH".to_vec());
    }

    #[test]
    fn conditional_file_alias_failure_restores_snapshots_after_an_unchanged_alias() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        let baseline = b"........".to_vec();
        io.poke(1, 16, &baseline);
        table.file_backing_mut(&key).unwrap().ref_count += 1;
        table.insert_mapping(1, 16, SharedMapping::file(
            3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(&baseline).unwrap(), 0,
        ));
        // Alias zero is unchanged; the later alias fails after a partial read.
        io.poke(1, 16, b"....BBBB");
        io.fail_read_process_at = Some((1, 16));
        let version = table.file_backing(&key).unwrap().version;
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EFAULT));
        for addr in [0, 16] {
            assert_eq!(table.mapping(1, addr).unwrap().snapshot.as_deref(), Some(baseline.as_slice()));
        }
        assert_eq!(table.file_backing(&key).unwrap().version, version);
        assert_eq!(io.files[&10], baseline);
        assert_eq!(io.peek(2, 0, 8), b"........".to_vec());
        io.fail_read_process_at = None;
        table.sync_file_from_process(1, false, &mut io).unwrap();
        table.sync_file_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"....BBBB".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"....BBBB".to_vec());
    }

    #[test]
    fn conditional_unchanged_file_reader_still_imports_a_peer_publication() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.poke(1, 0, b"AAAA....");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        let baseline = table.mapping(2, 0).unwrap().snapshot.clone().unwrap();
        assert_eq!(io.read_process_if_changed(2, 0, 8, &baseline), Ok(None));
        assert_eq!(io.peek(2, 0, 8), b"........".to_vec());
        table.sync_file_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"AAAA....".to_vec());
        let mapping = table.mapping(2, 0).unwrap();
        assert_eq!(mapping.snapshot.as_deref(), Some(&b"AAAA...."[..]));
        assert_eq!(mapping.seen_version, table.file_backing(&key).unwrap().version);
        // A later store still publishes after the earlier no-change result.
        io.poke(2, 4, b"BBBB");
        table.sync_file_from_process(2, false, &mut io).unwrap();
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
    }

    #[test]
    fn conditional_unchanged_earlier_alias_imports_later_alias_publication() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.poke(1, 16, b"........");
        table.file_backing_mut(&key).unwrap().ref_count += 1;
        table.insert_mapping(1, 16, SharedMapping::file(
            3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(b"........").unwrap(), 0,
        ));
        io.poke(1, 16, b"....BBBB");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        for addr in [0, 16] {
            assert_eq!(io.peek(1, addr, 8), b"....BBBB".to_vec());
            assert_eq!(table.mapping(1, addr).unwrap().snapshot.as_deref(), Some(&b"....BBBB"[..]));
        }
    }

    #[test]
    fn conditional_unchanged_file_reader_still_imports_descriptor_writes() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.descriptor_write(10, 2, b"ZZ");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"..ZZ....".to_vec());
        assert_eq!(io.files[&10], b"..ZZ....".to_vec());
        assert_eq!(table.mapping(1, 0).unwrap().snapshot.as_deref(), Some(&b"..ZZ...."[..]));
    }

    #[test]
    fn owned_snapshot_error_restores_anonymous_snapshot_without_publication() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let (mut table, key) = anon_table_with_two_observers(&mut io);
        let snapshot = table.mapping(1, 0).unwrap().snapshot.clone();
        let version = table.anon_backing(&key).unwrap().version;
        io.poke(1, 0, b"AAAA\0\0\0\0");
        io.fail_read_process_at = Some((1, 0));
        assert_eq!(table.sync_anonymous_from_process(1, false, &mut io), Err(Errno::EFAULT));
        assert_eq!(table.mapping(1, 0).unwrap().snapshot, snapshot);
        assert_eq!(table.anon_backing(&key).unwrap().version, version);
        assert_eq!(table.anon_backing(&key).unwrap().bytes, vec![0u8; 8]);
        assert_eq!(io.peek(2, 0, 8), vec![0u8; 8]);
        io.fail_read_process_at = None;
        table.sync_anonymous_from_process(1, false, &mut io).unwrap();
        table.sync_anonymous_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"AAAA\0\0\0\0".to_vec());
    }

    fn refresh_replacement_pair(io: &mut MockIo) -> (SharedMappingTable, [String; 2]) {
        let mut table = SharedMappingTable::new();
        let keys = [io.key_of(10), io.key_of(11)];
        for (index, handle) in [10, 11].into_iter().enumerate() {
            let key = &keys[index];
            let stat = io.stat_of(handle);
            let backing = table.get_or_create_file_backing(key, &stat, true, io).unwrap();
            backing.ref_count = 1;
            let initial = backing.read_range(0, 8, io).unwrap();
            let addr = (16 * index) as u64;
            io.write_process(1, addr, &initial).unwrap();
            table.insert_mapping(1, addr, SharedMapping::file(
                3 + index as i32, 0, 8, true, true, key.clone(), initial, 0));
        }
        for (key, bytes) in keys.iter().zip([b"AAAA....", b"....BBBB"]) {
            let backing = table.file_backing_mut(key).unwrap();
            backing.write_range(0, bytes, false, io).unwrap();
            backing.version += 1;
        }
        (table, keys)
    }

    fn refresh_replacement_io() -> MockIo {
        MockIo::new().with_process(1, 64)
            .with_file(10, 1, 2, b"........".to_vec())
            .with_file(11, 1, 3, b"........".to_vec())
    }

    #[test]
    fn refresh_replacements_need_temporary_not_duplicate_live_snapshot_credit() {
        let mut io = refresh_replacement_io();
        let (mut table, keys) = refresh_replacement_pair(&mut io);
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let temporary = crate::io_buffer::IO_MEMORY.temporary_usage();
        {
            // All retained mappings/cache pages fit. Their equally sized
            // replacements and staging metadata need no additional LIVE room.
            let _limit = crate::io_buffer::test_budget(held);
            table.refresh_mappings(1, &[0, 16], &mut io).unwrap();
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            assert_eq!(crate::io_buffer::IO_MEMORY.temporary_usage(), temporary);
        }
        for (addr, key, bytes) in [(0, &keys[0], b"AAAA...."), (16, &keys[1], b"....BBBB")] {
            assert_eq!(io.peek(1, addr, 8).as_slice(), bytes);
            let mapping = table.mapping(1, addr).unwrap();
            assert_eq!(mapping.snapshot.as_deref(), Some(&bytes[..]));
            assert_eq!(mapping.seen_version, table.file_backing(key).unwrap().version);
        }
    }

    #[test]
    fn late_refresh_read_failure_restores_all_guards_before_any_guest_write() {
        let mut io = refresh_replacement_io();
        let (mut table, keys) = refresh_replacement_pair(&mut io);
        table.file_backing_mut(&keys[1]).unwrap().invalidate_clean_pages();
        io.files.remove(&11); // Actual later backing read returns EBADF.
        let usage = crate::io_buffer::IO_MEMORY.usage().0;
        let temporary = crate::io_buffer::IO_MEMORY.temporary_usage();
        let epoch = io.epochs[&1];
        assert_eq!(table.refresh_mappings(1, &[0, 16], &mut io), Err(Errno::EBADF));
        assert_eq!(io.epochs[&1], epoch);
        for addr in [0, 16] {
            assert_eq!(io.peek(1, addr, 8).as_slice(), b"........");
            let mapping = table.mapping(1, addr).unwrap();
            assert_eq!(mapping.snapshot.as_deref(), Some(&b"........"[..]));
            assert_eq!(mapping.seen_version, 0);
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, usage);
        assert_eq!(crate::io_buffer::IO_MEMORY.temporary_usage(), temporary);
    }

    #[test]
    fn later_refresh_promotion_refusal_preserves_all_guest_bytes_and_snapshots() {
        let mut io = refresh_replacement_io();
        let (mut table, _) = refresh_replacement_pair(&mut io);
        // The pre-existing no-baseline refresh path needs an entire new live
        // snapshot. It must not spend an earlier guard's rollback capacity.
        table.mappings.get_mut(&1).unwrap().get_mut(&16).unwrap().snapshot = None;
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let temporary = crate::io_buffer::IO_MEMORY.temporary_usage();
        let epoch = io.epochs[&1];
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(table.refresh_mappings(1, &[0, 16], &mut io), Err(Errno::ENOMEM));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            assert_eq!(crate::io_buffer::IO_MEMORY.temporary_usage(), temporary);
        }
        assert_eq!(io.epochs[&1], epoch);
        assert_eq!(io.peek(1, 0, 8).as_slice(), b"........");
        assert_eq!(io.peek(1, 16, 8).as_slice(), b"........");
        assert_eq!(table.mapping(1, 0).unwrap().snapshot.as_deref(), Some(&b"........"[..]));
        assert!(table.mapping(1, 16).unwrap().snapshot.is_none());
        assert_eq!(table.mapping(1, 0).unwrap().seen_version, 0);
        assert_eq!(table.mapping(1, 16).unwrap().seen_version, 0);
    }

    #[test]
    fn refresh_write_failure_restores_only_uncommitted_replacement_and_credits() {
        let mut io = refresh_replacement_io();
        let (mut table, keys) = refresh_replacement_pair(&mut io);
        io.parked.insert(1);
        // The second alias starts at16, but its unchanged four-byte prefix
        // is deliberately not written. Inject at the actual changed run.
        io.fail_write_process_at = Some(20);
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        let temporary = crate::io_buffer::IO_MEMORY.temporary_usage();
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(table.refresh_mappings(1, &[0, 16], &mut io), Err(Errno::EFAULT));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
            assert_eq!(crate::io_buffer::IO_MEMORY.temporary_usage(), temporary);
        }
        assert_eq!(io.peek(1, 0, 8).as_slice(), b"AAAA....");
        assert_eq!(io.peek(1, 16, 8).as_slice(), b"........");
        let first = table.mapping(1, 0).unwrap();
        assert_eq!(first.snapshot.as_deref(), Some(&b"AAAA...."[..]));
        assert_eq!(first.seen_version, table.file_backing(&keys[0]).unwrap().version);
        assert_eq!(first.clean.unwrap().epoch, io.epochs[&1]);
        let second = table.mapping(1, 16).unwrap();
        assert_eq!(second.snapshot.as_deref(), Some(&b"........"[..]));
        assert_eq!(second.seen_version, 0);
        assert!(second.clean.is_none());
    }

    #[test]
    fn failed_publication_keeps_original_state_and_bounded_numerical_evidence() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        let snapshot = table.mapping(1, 0).unwrap().snapshot.clone();
        let version = table.file_backing(&key).unwrap().version;
        io.poke(1, 0, b"AAAA....");
        io.fail_read_process_at = Some((1, 0));
        let usage = crate::io_buffer::IO_MEMORY.usage();
        {
            let _limit = crate::io_buffer::test_budget(usage.0);
            assert_eq!(table.pull_mapping(1, 0, &mut io), Err(Errno::EFAULT));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, usage.0);
        }
        assert_eq!(table.mapping(1, 0).unwrap().snapshot, snapshot);
        assert_eq!(table.file_backing(&key).unwrap().version, version);
        assert_eq!(io.files[&10].as_slice(), b"........");
        let report = table.render_failures().unwrap();
        let report = core::str::from_utf8(&report).unwrap();
        assert!(report.starts_with("version 1\ntotal 1\nrecorded 1\ndropped 0\n"));
        assert!(report.contains("phase=pull_page_read pid=1 addr=0x0 len=8 file_offset=0 handle=10 offset=0 attempted_bytes=8 status=-14"));
        assert!(report.contains(&alloc::format!("io_live={} io_limit={}", usage.0, usage.0)));
        // Repeated refusals retain the first eight without growing storage;
        // their total/dropped counts still make every missing record explicit.
        for _ in 0..9 { assert_eq!(table.pull_mapping(1, 0, &mut io), Err(Errno::EFAULT)); }
        let report = table.render_failures().unwrap();
        let report = core::str::from_utf8(&report).unwrap();
        assert!(report.starts_with("version 1\ntotal 10\nrecorded 8\ndropped 2\n"));
    }

    /// Retained mappings and an already-owned dirty page fit the limit;
    /// publishing them must not require another mapping-sized live snapshot.
    #[test]
    fn bounded_publication_does_not_require_full_snapshot_copy_credit() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        let retained = io.retained_count(10);
        {
            // This page and its dirty-byte owner are admitted before pressure,
            // so failure cannot be attributed to new cache/dirty metadata.
            let backing = table.file_backing_mut(&key).unwrap();
            backing.write_range(4, b"Q", true, &mut io).unwrap();
            backing.version += 1;
        }
        io.poke(1, 0, b"AA......");
        let live = crate::io_buffer::IO_MEMORY.usage().0;
        let result = {
            // IoBuffer charges two credits per payload byte. Eight current
            // bytes need16 extra; fixed-page publication needs none here.
            let _limit = crate::io_buffer::test_budget(live + 15);
            table.pull_mapping(1, 0, &mut io)
        };
        assert_eq!(result, Ok(PullOutcome::Published),
            "valid retained mapping must publish without a second full snapshot");
        assert_eq!(&table.mapping(1, 0).unwrap().snapshot.as_ref().unwrap()[..], b"AA......");
        assert_eq!(io.files[&10], b"AA..Q...".to_vec());
        assert_eq!(io.retained_count(10), retained);
        assert_eq!(table.mapping(1, 0).unwrap().backing_key.as_deref(), Some(key.as_str()));
        assert_eq!(table.file_backing(&key).unwrap().handle, 10);
    }

    #[test]
    fn owned_snapshot_error_restores_file_alias_before_any_writeback() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
            .with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        let snapshot = table.mapping(1, 0).unwrap().snapshot.clone();
        let version = table.file_backing(&key).unwrap().version;
        io.poke(1, 0, b"AAAA....");
        io.fail_read_process_at = Some((1, 0));
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EFAULT));
        assert_eq!(table.mapping(1, 0).unwrap().snapshot, snapshot);
        assert_eq!(table.file_backing(&key).unwrap().version, version);
        assert_eq!(io.files[&10], b"........".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"........".to_vec());
        io.fail_read_process_at = None;
        table.sync_file_from_process(1, false, &mut io).unwrap();
        table.sync_file_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"AAAA....".to_vec());
    }

    #[test]
    fn owned_child_snapshot_error_does_not_commit_inherited_aliases() {
        for sysv in [false, true] {
            let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
            let mut table = SharedMappingTable::new();
            if sysv {
                io.shm.insert(7, b"PARENTAL".to_vec());
                table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
            } else {
                io.poke(1, 0, b"PARENTAL");
                table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
            }
            io.poke(2, 0, b"ORIGINAL");
            io.fail_read_process_at = Some((2, 0));
            assert_eq!(table.inherit_process_mappings(1, 2, &mut io), Err(Errno::EFAULT));
            assert_eq!(io.peek(2, 0, 8), b"ORIGINAL".to_vec());
            assert!(table.mapping(2, 0).is_none());
            assert!(table.sysv_mapping(2, 0).is_none());
            if !sysv {
                let key = table.mapping(1, 0).unwrap().backing_key.as_ref().unwrap();
                assert_eq!(table.anon_backing(key).unwrap().ref_count, 1);
            }
            io.fail_read_process_at = None;
            table.inherit_process_mappings(1, 2, &mut io).unwrap();
            assert_eq!(io.peek(2, 0, 8), b"PARENTAL".to_vec());
        }
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
        backing.bytes = IoBuffer::copy_from(b"PEERPEER").unwrap();
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
        backing.flush_all(&mut io).unwrap();

        assert_eq!(io.files[&10], b"hellO".to_vec());
    }

    #[test]
    fn dirty_bytes_entirely_past_eof_are_dropped_not_written() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 5);
        backing.write_range(8192, b"Z", true, &mut io).unwrap();
        assert_eq!(backing.dirty_page_count(), 1);
        backing.flush_all(&mut io).unwrap();
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

    // -- the writable upgrade ---------------------------------------------
    //
    // An open description's access mode is fixed, so a writable source for an
    // existing read-only backing is necessarily a *distinct* `O_RDWR` handle
    // onto the same file. The backing adopts it and drops the old one. Every
    // assertion below is about host-handle ownership across that swap: the
    // path performs a `retain` of the new handle and a `release` of the old
    // against the machine-wide mapping-held table, and it is the only place in
    // the subsystem where a backing's handle changes under live mappings.

    /// Two handles onto one file object: `10` opened read-only, `11` opened
    /// `O_RDWR`. Identity is derived from `(dev, ino)`, so both resolve to the
    /// same backing key.
    fn io_with_two_handles_onto_one_file() -> MockIo {
        MockIo::new()
            .with_file(10, 1, 2, b"hello".to_vec())
            .with_file(11, 1, 2, b"hello".to_vec())
    }

    #[test]
    fn a_writable_upgrade_adopts_the_new_handle_and_drops_the_old() {
        let mut io = io_with_two_handles_onto_one_file();
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();

        let read_only = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &read_only, false, &mut io)
            .unwrap();
        assert_eq!(io.retained_count(10), 1);

        let writable = io.stat_of(11);
        table
            .get_or_create_file_backing(&key, &writable, true, &mut io)
            .unwrap();

        let backing = table.file_backing(&key).unwrap();
        assert_eq!(backing.handle, 11, "the backing must adopt the O_RDWR handle");
        assert!(backing.writable);
        assert_eq!(
            io.retained_count(11),
            1,
            "the adopted handle must be held for as long as the backing lives",
        );
        assert_eq!(
            io.retained_count(10),
            0,
            "the replaced handle must stop being held the moment it is dropped",
        );
    }

    /// The upgrade is the one place a backing's handle changes, so it is the
    /// one place where a missing `retain` is invisible until teardown: the
    /// `release` of the old handle balances the *creation* retain, and the
    /// shortfall only surfaces when the backing releases the handle it now
    /// holds. Release the backing and require that final release to be a real
    /// one rather than a loss.
    #[test]
    fn a_backing_that_upgraded_still_owns_the_handle_it_releases() {
        let mut io = io_with_two_handles_onto_one_file();
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();

        let read_only = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &read_only, false, &mut io)
            .unwrap();
        let writable = io.stat_of(11);
        table
            .get_or_create_file_backing(&key, &writable, true, &mut io)
            .unwrap();
        table.file_backing_mut(&key).unwrap().ref_count = 1;

        // `MockIo::release_handle` asserts the release was one the table
        // actually held; an unbalanced upgrade fails here rather than silently
        // stranding the handle's deferred close.
        table.release_file_backing_reference(&key, &mut io);

        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained_count(11), 0);
    }

    /// POSIX does not let an open description change access mode, so a
    /// "writable upgrade" presenting the *same* handle is a caller error, not
    /// a promotion. Answering it would mark the backing writable while its
    /// handle still cannot write.
    #[test]
    fn an_upgrade_that_presents_the_same_handle_is_refused() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"hello".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();

        let stat = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &stat, false, &mut io)
            .unwrap();

        assert_eq!(
            table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .err(),
            Some(Errno::EIO),
        );
        assert!(!table.file_backing(&key).unwrap().writable);
        assert_eq!(io.retained_count(10), 1);
    }

    /// The retain can fail when the object behind the new handle can no
    /// longer be held. The upgrade must then leave the backing exactly as it
    /// found it — still read-only, still on the handle it already holds —
    /// rather than half-swapped onto a handle it does not own.
    #[test]
    fn a_refused_retain_leaves_the_backing_on_the_handle_it_owns() {
        let mut io = io_with_two_handles_onto_one_file();
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();

        let read_only = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &read_only, false, &mut io)
            .unwrap();

        // The object behind handle 11 can no longer be held.
        io.refuse_retain.insert(11);

        let writable = io.stat_of(11);
        assert_eq!(
            table
                .get_or_create_file_backing(&key, &writable, true, &mut io)
                .err(),
            Some(Errno::EBADF),
        );

        let backing = table.file_backing(&key).unwrap();
        assert_eq!(backing.handle, 10, "a refused upgrade must not swap the handle");
        assert!(!backing.writable, "a refused upgrade must not mark the backing writable");
        assert_eq!(io.retained_count(10), 1);
    }

    // -- the identity key --------------------------------------------------

    /// The case that was live: a backend reporting a real device and no
    /// inode. The host refuses it (`ino <= 0n`) and turns the refusal into
    /// `ENOTSUP`, so the `mmap` fails. The kernel used to require *both* to be
    /// zero, so it accepted this and answered a stable-looking key —
    /// collapsing every file in that mount onto one shared backing, which
    /// makes one file's stores appear in another.
    #[test]
    fn a_real_device_with_no_inode_has_no_identity() {
        assert_eq!(file_identity_key(7, 0), None);
    }

    #[test]
    fn an_object_with_neither_device_nor_inode_has_no_identity() {
        assert_eq!(file_identity_key(0, 0), None);
    }

    /// `dev == 0` is a legitimate device number; only the inode carries the
    /// backend's declaration. Refusing on `dev` would deny identity to files
    /// a backend can perfectly well promise.
    #[test]
    fn a_zero_device_with_a_real_inode_still_has_identity() {
        assert_eq!(
            file_identity_key(0, 5).as_deref(),
            Some("dev:0:ino:5"),
        );
    }

    /// Distinct objects must never share a key, including when one's device
    /// equals the other's inode — the shape a naive concatenation collides on.
    #[test]
    fn distinct_objects_never_share_a_key() {
        assert_ne!(file_identity_key(1, 23), file_identity_key(12, 3));
        assert_ne!(file_identity_key(1, 2), file_identity_key(2, 1));
    }

    /// Two descriptors onto one object — a second `open`, a hard link, a
    /// rename — must reach the same backing. Identity is the object's, not
    /// the descriptor's or the pathname's.
    #[test]
    fn one_object_reached_twice_has_one_key() {
        assert_eq!(file_identity_key(3, 9), file_identity_key(3, 9));
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

        table.flush_mappings(1, 0, 8, &mut io).unwrap();
        assert_eq!(io.files[&10], b"AAAABBBB".to_vec());
    }

    // -- kernel-owned files: write-through and descriptor coherence --------

    /// Two processes mapping one file the kernel owns (a `/dev/shm` object
    /// opened twice, say) converge at their syscall boundaries, and each
    /// publication reaches the file in the same step, so a descriptor read
    /// sees it without waiting for `msync`. The backing keeps no page between
    /// operations: the file is already in kernel memory.
    #[test]
    fn kernel_file_peers_converge_and_write_through() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        table.file_backing_mut(&key).unwrap().settle();

        io.poke(1, 0, b"AAAA....");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.files[&10], b"AAAA....".to_vec(), "published bytes reach the file");

        io.poke(2, 0, b"....BBBB");
        table.sync_file_from_process(2, false, &mut io).unwrap();
        table.sync_file_from_process(1, false, &mut io).unwrap();

        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.files[&10], b"AAAABBBB".to_vec());
        let backing = table.file_backing(&key).unwrap();
        assert_eq!(backing.dirty_page_count(), 0);
        assert_eq!(backing.cached_page_count(), 0, "a write-through backing caches nothing at rest");
    }

    // -- lazy completions: who is compared, and when ----------------------

    /// Two processes mapping one kernel-owned file, as a compositor and a
    /// client map a `wl_shm` pool.
    fn kernel_file_pair(io: &mut MockIo) -> (SharedMappingTable, String) {
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(io, &key);
        table.file_backing_mut(&key).unwrap().settle();
        (table, key)
    }

    fn kernel_file_io() -> MockIo {
        MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec())
    }

    /// A completion of `pid` with every other process parked, as when a
    /// compositor's syscall completes while its clients sit in `poll`.
    fn completion(table: &mut SharedMappingTable, io: &mut MockIo, pid: u32) {
        table.sync_file_at_completion(pid, io).unwrap();
    }

    #[test]
    fn a_completion_pulls_peers_and_imports_their_stores() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        // Process 2 stores and makes no further syscall.
        io.poke(2, 0, b"....BBBB");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 0, 8), b"....BBBB".to_vec(), "imported before 1 resumes");
        assert_eq!(io.files[&10], b"....BBBB".to_vec(), "and written through");
    }

    /// The process's own copy waits for an observer: its own completion
    /// does not compare it when it holds no alias and nothing is stale.
    #[test]
    fn a_completion_does_not_compare_the_completing_process() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.poke(1, 0, b"AAAA");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.reads_of(1), 0);
        assert_eq!(io.files[&10], b"........".to_vec(), "not yet published");
        // The peer's completion observes it.
        completion(&mut table, &mut io, 2);
        assert_eq!(io.files[&10], b"AAAA....".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"AAAA....".to_vec());
    }

    /// A busy compositor (process 1) and a client parked in a syscall
    /// (process 2): the client's pool is compared once after it last ran,
    /// then proved unchanged at every further compositor completion.
    #[test]
    fn a_parked_peer_is_compared_once_per_resume() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.park(2);
        for _ in 0..5 {
            completion(&mut table, &mut io, 1);
        }
        let expected = if SKIP_PROVED_PULLS { 1 } else { 5 };
        assert_eq!(io.reads_of(2), expected);
        // The client resumes, stores, and parks again: one more comparison,
        // which publishes the store.
        io.resume(2);
        io.poke(2, 0, b"CC");
        io.park(2);
        for _ in 0..5 {
            completion(&mut table, &mut io, 1);
        }
        assert_eq!(io.reads_of(2), expected * 2);
        assert_eq!(io.peek(1, 0, 8), b"CC......".to_vec());
    }

    /// A store made after the writer's last syscall, by a writer that never
    /// makes another one, reaches the reader at the reader's next completion.
    #[test]
    fn a_spinning_writer_is_observed_without_a_syscall_of_its_own() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.park(2);
        completion(&mut table, &mut io, 1);
        io.resume(2); // never parks again: it spins
        io.poke(2, 6, b"SS");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 0, 8), b"......SS".to_vec());
        io.poke(2, 0, b"T");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 0, 8), b"T.....SS".to_vec(), "a running writer is always compared");
    }

    /// Two mappings of one file in one process converge at its own
    /// completion: each alias observes the other.
    #[test]
    fn aliases_in_one_process_converge_at_its_completion() {
        let mut io = MockIo::new()
            .with_process(1, 256)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        for addr in [64u64, 128] {
            table
                .track_kernel_file_mapping(1, addr, 3, &key, 10, 0, 8, true, true, &mut io)
                .unwrap();
        }
        io.poke(1, 64, b"AA");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 128, 8), b"AA......".to_vec());
    }

    /// A stale mapping's own stores are published before the refresh, so
    /// they keep their bytes and the refresh writes only the peer's.
    #[test]
    fn a_stale_completion_publishes_its_own_stores_first() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.poke(2, 4, b"BBBB");
        io.poke(1, 0, b"AAAA");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 0, 8), b"AAAABBBB".to_vec());
        assert_eq!(io.files[&10], b"AAAABBBB".to_vec());
        completion(&mut table, &mut io, 2);
        assert_eq!(io.peek(2, 0, 8), b"AAAABBBB".to_vec());
    }

    /// A descriptor write shows through a mapping at its next completion,
    /// even with no peer mapping.
    #[test]
    fn a_descriptor_write_shows_through_at_the_next_completion() {
        let mut io = kernel_file_io();
        let mut table = sole_kernel_mapping(&mut io);
        io.descriptor_write(10, 2, b"WW");
        completion(&mut table, &mut io, 1);
        assert_eq!(io.peek(1, 0, 8), b"..WW....".to_vec());
    }

    /// A backend that answers every comparison with a full copy (no
    /// in-place comparator) still stamps an equal observation.
    #[test]
    fn an_equal_full_copy_still_stamps_the_observation() {
        struct CopyingIo(MockIo);
        impl SharedMappingIo for CopyingIo {
            fn read_process(&mut self, pid: u32, addr: u64, dst: &mut [u8]) -> Result<(), Errno> {
                self.0.read_process(pid, addr, dst)
            }
            fn read_process_if_changed(
                &mut self,
                pid: u32,
                addr: u64,
                len: usize,
                _snapshot: &[u8],
            ) -> Result<Option<IoBuffer<u8>>, Errno> {
                self.read_process_owned(pid, addr, len).map(Some)
            }
            fn write_process(&mut self, pid: u32, addr: u64, src: &[u8]) -> Result<(), Errno> {
                self.0.write_process(pid, addr, src)
            }
            fn process_memory_len(&mut self, pid: u32) -> Option<u64> {
                self.0.process_memory_len(pid)
            }
            fn pread(&mut self, handle: i64, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
                self.0.pread(handle, offset, dst)
            }
            fn pwrite(&mut self, handle: i64, offset: u64, src: &[u8]) -> Result<usize, Errno> {
                self.0.pwrite(handle, offset, src)
            }
            fn fstat_handle(&mut self, handle: i64) -> Result<SharedMappingStat, Errno> {
                self.0.fstat_handle(handle)
            }
            fn content_generation(&mut self, handle: i64) -> Option<u64> {
                self.0.content_generation(handle)
            }
            fn handle_identity(&mut self, handle: i64, dev: u64, ino: u64) -> Option<String> {
                self.0.handle_identity(handle, dev, ino)
            }
            fn retain_handle(&mut self, handle: i64) -> Result<(), Errno> {
                self.0.retain_handle(handle)
            }
            fn release_handle(&mut self, handle: i64) {
                self.0.release_handle(handle)
            }
            fn shm_read(&mut self, seg_id: i32, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                self.0.shm_read(seg_id, offset, dst)
            }
            fn shm_write(&mut self, seg_id: i32, offset: u64, src: &[u8]) -> Result<(), Errno> {
                self.0.shm_write(seg_id, offset, src)
            }
            fn report_writeback_loss(&mut self, pid: u32, map_addr: u64, file_key: &str, reason: &str) {
                self.0.report_writeback_loss(pid, map_addr, file_key, reason)
            }
            fn quiescent_epoch(&mut self, pid: u32) -> Option<u64> {
                self.0.quiescent_epoch(pid)
            }
            fn kernel_write_position(&mut self) -> u64 {
                self.0.kernel_write_position()
            }
            fn kernel_wrote_since(&mut self, pid: u32, since: u64, addr: u64, len: u64) -> Option<bool> {
                self.0.kernel_wrote_since(pid, since, addr, len)
            }
        }
        let mut inner = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut inner);
        let mut io = CopyingIo(inner);
        io.0.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert!(table.mapping(2, 0).unwrap().clean.is_some());
        let reads = io.0.reads_of(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        let expected = if SKIP_PROVED_PULLS { reads } else { reads + 1 };
        assert_eq!(io.0.reads_of(2), expected);
        // A real change through the same backend is still published.
        io.0.resume(2);
        io.0.poke(2, 0, b"ZZZZ....");
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.0.files[&10], b"ZZZZ....".to_vec());
    }

    // -- randomized model against a single-memory reference ----------------

    /// Deterministic xorshift64*, so a failing seed reproduces exactly.
    struct ModelRng(u64);
    impl ModelRng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Random interleavings of mapped stores, syscalls, blocking waits,
    /// cross-process wake-ups, descriptor reads and writes, checked against
    /// what one shared memory would guarantee:
    ///
    /// - happens-before visibility (H): when a process consumes a wake-up,
    ///   its mappings show every store that happened before the wake-up was
    ///   sent (vector clocks), or a later store to the same byte;
    /// - descriptor coherence: a fenced read of the file shows the same;
    /// - no clobber: a process's own latest store to a byte is never
    ///   replaced by an older value, whatever runs elsewhere;
    /// - no loss: after a final `msync` by every process, the file holds
    ///   every byte's latest store.
    ///
    /// Each byte has one writing process (racing writers to one byte have no
    /// defined winner on any system), process 1 holds a second, read-only
    /// alias of its mapping, and process 4 never maps the file and reads it
    /// only through the descriptor. With the `shared-mapping-proof-verify`
    /// feature every skipped comparison is also checked.
    #[test]
    fn randomized_lazy_coherence_matches_a_single_memory_reference() {
        const LEN: usize = 24;
        const MAPPERS: u32 = 3;
        const READER: u32 = 4;
        const ALIAS: u64 = 64;
        let owner = |byte: usize| 1 + (byte as u32 % MAPPERS);
        for seed in 1..=200u64 {
            let mut rng = ModelRng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
            let mut io = MockIo::new().with_kernel_file(10, 1, 2, vec![0; LEN]);
            for pid in 1..=READER {
                io = io.with_process(pid, 128);
            }
            let key = io.key_of(10);
            let mut table = SharedMappingTable::new();
            for (pid, addr) in [(1u32, 0u64), (1, ALIAS), (2, 0), (3, 0)] {
                table
                    .track_kernel_file_mapping(pid, addr, 3, &key, 10, 0, LEN, true, true, &mut io)
                    .unwrap();
            }
            // history[byte] = (writer's clock, value) of every store, in order.
            let mut history: Vec<Vec<(u64, u8)>> = vec![Vec::new(); LEN];
            // clock[p][w]: the latest store of w that p knows happened before.
            let mut clock = [[0u64; 5]; 5];
            let mut blocked = [false; 5];
            blocked[READER as usize] = true;
            let mut next_value = 0u8;
            let mut value = || {
                next_value = next_value.wrapping_add(1).max(1);
                next_value
            };

            let latest = |history: &Vec<Vec<(u64, u8)>>, byte: usize| {
                history[byte].last().map(|(_, v)| *v).unwrap_or(0)
            };
            // Whether `seen` is the writer's last store to `byte` at or before
            // its clock `known` (or the file's initial zero, if there is
            // none), or a later store to the same byte.
            let acceptable = |history: &Vec<Vec<(u64, u8)>>, byte: usize, known: u64, seen: u8| {
                let stores = &history[byte];
                match stores.iter().rposition(|(ts, _)| *ts <= known) {
                    Some(at) => stores[at..].iter().any(|(_, v)| *v == seen),
                    None => seen == 0 || stores.iter().any(|(_, v)| *v == seen),
                }
            };
            let check_view = |io: &MockIo, history: &Vec<Vec<(u64, u8)>>, clock: &[u64; 5], view: &[u8], who: &str| {
                for byte in 0..LEN {
                    let w = owner(byte) as usize;
                    assert!(
                        acceptable(history, byte, clock[w], view[byte]),
                        "seed {seed}: {who} byte {byte} = {} misses store {} of writer {w}",
                        view[byte], clock[w]
                    );
                }
                let _ = io;
            };
            // One syscall of `pid`: it parks, the completion materializes,
            // the kernel synchronizes, and the completion is published.
            let syscall = |table: &mut SharedMappingTable, io: &mut MockIo, pid: u32| {
                io.park(pid);
                io.materialize(pid);
                table.sync_file_at_completion(pid, io).unwrap();
                io.resume(pid);
            };

            for _ in 0..300 {
                let running: Vec<u32> = (1..=MAPPERS).filter(|p| !blocked[*p as usize]).collect();
                let op = rng.below(7);
                match op {
                    // A mapped store by a running process to a byte it owns.
                    0 | 1 if !running.is_empty() => {
                        let pid = running[rng.below(running.len() as u64) as usize];
                        let candidates: Vec<usize> = (0..LEN).filter(|b| owner(*b) == pid).collect();
                        let byte = candidates[rng.below(candidates.len() as u64) as usize];
                        let v = value();
                        io.poke(pid, byte as u64, &[v]);
                        clock[pid as usize][pid as usize] += 1;
                        history[byte].push((clock[pid as usize][pid as usize], v));
                    }
                    // A syscall that changes nothing shared.
                    2 if !running.is_empty() => {
                        let pid = running[rng.below(running.len() as u64) as usize];
                        syscall(&mut table, &mut io, pid);
                    }
                    // A process blocks in a syscall (poll, read on an empty pipe).
                    3 if running.len() > 1 => {
                        let pid = running[rng.below(running.len() as u64) as usize];
                        io.park(pid);
                        blocked[pid as usize] = true;
                    }
                    // A running process wakes a blocked one through the kernel.
                    4 if !running.is_empty() => {
                        let sleepers: Vec<u32> = (1..=READER).filter(|p| blocked[*p as usize]).collect();
                        if sleepers.is_empty() {
                            continue;
                        }
                        let from = running[rng.below(running.len() as u64) as usize];
                        let to = sleepers[rng.below(sleepers.len() as u64) as usize];
                        syscall(&mut table, &mut io, from);
                        let sent = clock[from as usize];
                        for w in 0..5 {
                            clock[to as usize][w] = clock[to as usize][w].max(sent[w]);
                        }
                        if to == READER {
                            // Never mapped: it observes through a fenced read.
                            table.fence_handle(10, &mut io).unwrap();
                            let file = io.files[&10].clone();
                            check_view(&io, &history, &clock[READER as usize], &file, "descriptor reader");
                            continue;
                        }
                        io.materialize(to);
                        table.sync_file_at_completion(to, &mut io).unwrap();
                        io.resume(to);
                        blocked[to as usize] = false;
                        let view = io.peek(to, 0, LEN);
                        check_view(&io, &history, &clock[to as usize], &view, "woken mapper");
                        if to == 1 {
                            let alias = io.peek(1, ALIAS, LEN);
                            check_view(&io, &history, &clock[1], &alias, "woken alias");
                        }
                    }
                    // A running mapper reads the file through its descriptor.
                    5 if !running.is_empty() => {
                        let pid = running[rng.below(running.len() as u64) as usize];
                        io.park(pid);
                        table.fence_handle(10, &mut io).unwrap();
                        let file = io.files[&10].clone();
                        check_view(&io, &history, &clock[pid as usize], &file, "fenced read");
                        io.materialize(pid);
                        table.sync_file_at_completion(pid, &mut io).unwrap();
                        io.resume(pid);
                    }
                    // A running mapper pwrites a byte it owns.
                    6 if !running.is_empty() => {
                        let pid = running[rng.below(running.len() as u64) as usize];
                        let candidates: Vec<usize> = (0..LEN).filter(|b| owner(*b) == pid).collect();
                        let byte = candidates[rng.below(candidates.len() as u64) as usize];
                        io.park(pid);
                        table.fence_handle(10, &mut io).unwrap();
                        let v = value();
                        io.descriptor_write(10, byte, &[v]);
                        clock[pid as usize][pid as usize] += 1;
                        history[byte].push((clock[pid as usize][pid as usize], v));
                        io.materialize(pid);
                        table.sync_file_at_completion(pid, &mut io).unwrap();
                        io.resume(pid);
                    }
                    _ => {}
                }
                // No clobber: each mapper's primary view of its own bytes is
                // exactly its latest store, whatever else ran.
                for pid in 1..=MAPPERS {
                    let view = io.peek(pid, 0, LEN);
                    for byte in (0..LEN).filter(|b| owner(*b) == pid) {
                        assert_eq!(
                            view[byte],
                            latest(&history, byte),
                            "seed {seed}: process {pid} lost its own store to byte {byte}"
                        );
                    }
                }
            }
            // No loss: every process publishes; the file has every latest store.
            for pid in 1..=MAPPERS {
                io.resume(pid);
                assert!(table.flush_mappings(pid, 0, u64::MAX, &mut io).is_ok());
            }
            for byte in 0..LEN {
                assert_eq!(io.files[&10][byte], latest(&history, byte), "seed {seed}: byte {byte} lost");
            }
        }
    }

    #[test]
    fn the_kernel_write_log_answers_overlap_and_unknown_history() {
        let mut log = KernelProcessWriteLog::new();
        let start = log.position();
        log.record(7, 100, 10);
        assert_eq!(log.wrote_since(7, start, 105, 1), Some(true));
        assert_eq!(log.wrote_since(7, start, 110, 4), Some(false), "end is exclusive");
        assert_eq!(log.wrote_since(7, start, 96, 4), Some(false));
        assert_eq!(log.wrote_since(8, start, 100, 10), Some(false), "other process");
        assert_eq!(log.wrote_since(7, log.position(), 100, 10), Some(false), "nothing since");
        log.record(7, 0, 0);
        assert_eq!(log.position(), start + 1, "an empty write is not recorded");
        for _ in 0..KERNEL_PROCESS_WRITE_LOG_LEN {
            log.record(9, 0, 1);
        }
        assert_eq!(log.wrote_since(7, start, 100, 10), None, "the write fell out of the ring");
        assert_eq!(log.wrote_since(7, log.position() + 1, 100, 10), None, "a future position");
    }

    #[test]
    fn flushing_selected_kernel_file_backings_does_not_publish_other_files() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec())
            .with_kernel_file(11, 1, 3, b"........".to_vec());
        let mut table = SharedMappingTable::new();
        for (handle, address) in [(10, 0), (11, 32)] {
            let key = io.key_of(handle);
            let stat = io.stat_of(handle);
            table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap()
                .ref_count = 1;
            let initial = table
                .file_backing_mut(&key)
                .unwrap()
                .read_range(0, 8, &mut io)
                .unwrap();
            io.write_process(1, address, &initial).unwrap();
            table.insert_mapping(
                1,
                address,
                SharedMapping::file(3, 0, 8, true, true, key, initial, 0),
            );
        }
        io.poke(1, 0, b"ROOT....");
        io.poke(1, 32, b"TEMP....");

        table
            .flush_file_backings_matching(&|handle| handle == 10, &mut io)
            .unwrap();
        assert_eq!(io.files[&10], b"ROOT....".to_vec());
        assert_eq!(io.files[&11], b"........".to_vec());
        assert_eq!(io.peek(1, 32, 8), b"TEMP....".to_vec());

        table
            .flush_file_backings_matching(&|handle| handle == 11, &mut io)
            .unwrap();
        assert_eq!(io.files[&11], b"TEMP....".to_vec());
    }

    #[test]
    fn flushing_selected_kernel_file_backings_publishes_every_process() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.poke(1, 0, b"LEFT....");
        io.poke(2, 0, b"....RITE");

        table
            .flush_file_backings_matching(&|handle| handle == 10, &mut io)
            .unwrap();

        assert_eq!(io.files[&10], b"LEFTRITE".to_vec());
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"LEFTRITE".to_vec());
        assert_eq!(io.peek(2, 0, 8), b"LEFTRITE".to_vec());
    }

    #[test]
    fn selected_mapping_flush_preserves_storage_errors_and_dirty_pages() {
        for error in [Errno::ENOSPC, Errno::ENOMEM, Errno::EROFS, Errno::EIO] {
            let mut io = MockIo::new()
                .with_process(1, 64)
                .with_kernel_file(10, 1, 2, b"........".to_vec());
            let key = io.key_of(10);
            let mut table = SharedMappingTable::new();
            let stat = io.stat_of(10);
            table.get_or_create_file_backing(&key, &stat, true, &mut io).unwrap().ref_count = 1;
            table.insert_mapping(1, 0,
                SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(b"........").unwrap(), 0));
            io.poke(1, 0, b"RETRY...");
            io.pwrite_error = Some(error);
            assert_eq!(table.flush_file_backings_matching(&|handle| handle == 10, &mut io), Err(error));
            assert_eq!(io.files[&10], b"........".to_vec());
            assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);
            io.pwrite_error = None;
            table.flush_file_backings_matching(&|handle| handle == 10, &mut io).unwrap();
            assert_eq!(io.files[&10], b"RETRY...".to_vec());
            assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);
        }
    }

    #[test]
    fn short_mapping_writeback_retains_the_unacknowledged_suffix_for_retry() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        table.get_or_create_file_backing(&key, &stat, true, &mut io).unwrap().ref_count = 1;
        table.insert_mapping(1, 0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(b"........").unwrap(), 0));
        io.poke(1, 0, b"COMPLETE");
        io.write_budget = Some(3);
        assert_eq!(table.flush_file_backings_matching(&|handle| handle == 10, &mut io), Err(Errno::ENOSPC));
        assert_eq!(io.files[&10], b"COM.....".to_vec());
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);
        io.write_budget = None;
        table.flush_file_backings_matching(&|handle| handle == 10, &mut io).unwrap();
        assert_eq!(io.files[&10], b"COMPLETE".to_vec());
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);
    }

    #[test]
    fn failed_selected_flush_retains_mapped_stores_for_retry() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &stat, true, &mut io)
            .unwrap()
            .ref_count = 1;
        io.write_process(1, 0, b"........").unwrap();
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(b"........").unwrap(), 0),
        );
        io.poke(1, 0, b"RETRY...");
        io.fail_pwrite = true;

        assert_eq!(
            table.flush_file_backings_matching(&|handle| handle == 10, &mut io),
            Err(Errno::EIO)
        );
        assert_eq!(io.files[&10], b"........".to_vec());
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);

        io.fail_pwrite = false;
        table
            .flush_file_backings_matching(&|handle| handle == 10, &mut io)
            .unwrap();
        assert_eq!(io.files[&10], b"RETRY...".to_vec());
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);
    }

    /// A `write` through a descriptor reaches the file without passing
    /// through the mapping layer. Even a sole, read-only observer must import
    /// it at its next boundary, which only the content generation reveals.
    #[test]
    fn a_descriptor_write_refreshes_a_sole_read_only_observer() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &stat, false, &mut io)
            .unwrap()
            .ref_count = 1;
        let initial = table.file_backing_mut(&key).unwrap().read_range(0, 8, &mut io).unwrap();
        io.write_process(1, 0, &initial).unwrap();
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, false, false, key.clone(), initial, 0),
        );

        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"........".to_vec());

        io.descriptor_write(10, 2, b"WW");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"..WW....".to_vec());
    }

    /// A descriptor write that grows the file moves the size writeback is
    /// clamped to; a store into the newly valid range must then reach it.
    #[test]
    fn a_descriptor_grow_moves_the_writeback_clamp() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"....".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);

        io.descriptor_write(10, 4, b"____");
        io.poke(1, 0, b"AAAAAAAA");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.files[&10], b"AAAAAAAA".to_vec());
    }

    /// Reconciling with a descriptor write keeps bytes awaiting writeback,
    /// including when that descriptor write touches another cached page.
    #[test]
    fn dirty_byte_admission_precedes_store_and_flush_needs_no_new_credit() {
        let mut io = MockIo::new().with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 8);
        backing.ensure_page_loaded(0, &mut io).unwrap();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(backing.write_range(0, b"A", true, &mut io), Err(Errno::ENOMEM));
            assert_eq!(backing.read_range(0, 8, &mut io), Err(Errno::ENOMEM));
            assert_eq!(&backing.pages[&0][..8], b"........");
            assert_eq!(backing.dirty_page_count(), 0);
        }
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(backing.write_range(0, b"A", true, &mut io), Err(Errno::ENOMEM));
        assert_eq!(backing.read_range(0, 8, &mut io).unwrap(), b"........");
        backing.write_range(0, b"A", true, &mut io).unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > baseline);
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            backing.flush_all(&mut io).unwrap();
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        assert_eq!(io.files[&10], b"A.......");
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn partial_mapping_publication_records_progress_before_a_later_page_refuses() {
        let mut io = MockIo::new().with_kernel_file(10, 1, 2, vec![b'.'; 2 * FILE_PAGE_SIZE]);
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, (2 * FILE_PAGE_SIZE) as u64);
        backing.observe_source_generation(&mut io);
        let mut snapshot = vec![b'.'; 2 * FILE_PAGE_SIZE];
        backing.ensure_range_loaded(0, 2 * FILE_PAGE_SIZE, &mut io).unwrap();
        let mut source = snapshot.clone();
        source[0] = b'A';
        source[FILE_PAGE_SIZE] = b'B';
        crate::prepared_map::fail_after_allocations(1);
        assert_eq!(backing.merge_changed_runs(&source, &mut snapshot, 0, &mut io), Err(Errno::ENOMEM));
        assert_eq!(snapshot[0], b'A');
        assert_eq!(snapshot[FILE_PAGE_SIZE], b'.');
        assert_eq!(backing.version, 1);
        backing.flush_range(0, 1, &mut io).unwrap();
        io.descriptor_write(10, 0, b"D");
        backing.reconcile_source(&mut io);
        backing.merge_changed_runs(&source, &mut snapshot, 0, &mut io).unwrap();
        backing.flush_all(&mut io).unwrap();
        assert_eq!(io.files[&10][0], b'D');
        assert_eq!(io.files[&10][FILE_PAGE_SIZE], b'B');
    }

    #[test]
    fn cache_page_payload_and_node_refusal_leave_no_published_page_or_credit() {
        let mut io = MockIo::new().with_file(10, 1, 2, vec![b'.'; FILE_PAGE_SIZE]);
        let mut backing = FileBacking::new(io.key_of(10), 10, true, FILE_PAGE_SIZE as u64);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(backing.ensure_page_loaded(0, &mut io), Err(Errno::ENOMEM));
        }
        assert_eq!(backing.cached_page_count(), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(backing.ensure_page_loaded(0, &mut io), Err(Errno::ENOMEM));
        assert_eq!(backing.cached_page_count(), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        backing.ensure_page_loaded(0, &mut io).unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 >= baseline + 2 * FILE_PAGE_SIZE);
        backing.invalidate_clean_pages();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn cache_pressure_reclaims_clean_pages_but_preserves_dirty_owners() {
        let mut io = MockIo::new().with_file(10, 1, 2, vec![b'.'; 3 * FILE_PAGE_SIZE]);
        let mut backing = FileBacking::new(io.key_of(10), 10, true, (3 * FILE_PAGE_SIZE) as u64);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        backing.ensure_page_loaded(0, &mut io).unwrap();
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            backing.ensure_page_loaded(1, &mut io).unwrap();
            assert!(!backing.pages.contains_key(&0));
            assert!(backing.pages.contains_key(&1));
            assert_eq!(backing.cached_page_count(), 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        }
        backing.write_range(FILE_PAGE_SIZE as u64, b"DIRTY", true, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert_eq!(backing.ensure_page_loaded(2, &mut io), Err(Errno::ENOMEM));
            assert_eq!(backing.cached_page_count(), 1);
            assert_eq!(&backing.pages[&1][..5], b"DIRTY");
            assert_eq!(backing.dirty_page_count(), 1);
        }
        backing.flush_all(&mut io).unwrap();
        assert_eq!(&io.files[&10][FILE_PAGE_SIZE..FILE_PAGE_SIZE + 5], b"DIRTY");
        backing.invalidate_clean_pages();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn reload_refusal_retains_dirty_bytes_and_invalidates_clean_pages_without_staging() {
        let mut io = MockIo::new().with_file(10, 1, 2, vec![b'.'; 2 * FILE_PAGE_SIZE]);
        let mut backing = FileBacking::new(io.key_of(10), 10, true, (2 * FILE_PAGE_SIZE) as u64);
        backing.write_range(0, b"DIRTY", true, &mut io).unwrap();
        backing.ensure_page_loaded(1, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            assert!(!backing.reload_range(0, 1u64 << 32, &mut io));
            crate::prepared_map::fail_after_allocations(usize::MAX);
            assert_eq!(backing.cached_page_count(), 1);
            assert_eq!(&backing.pages[&0][..5], b"DIRTY");
            assert_eq!(backing.dirty_page_count(), 1);
        }
        backing.flush_all(&mut io).unwrap();
        assert_eq!(&io.files[&10][..5], b"DIRTY");
        io.files.get_mut(&10).unwrap()[0] = b'N';
        assert!(backing.reload_range(0, 1u64 << 32, &mut io));
        assert_eq!(&backing.pages[&0][..5], b"NIRTY");
    }

    #[test]
    fn later_process_read_failure_preserves_page_publication_progress_for_retry() {
        let mut io = MockIo::new().with_process(1, 2 * FILE_PAGE_SIZE)
            .with_kernel_file(10, 1, 2, vec![b'.'; 2 * FILE_PAGE_SIZE]);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0,
            2 * FILE_PAGE_SIZE, true, true, &mut io).unwrap();
        io.poke(1, 0, b"A");
        io.poke(1, FILE_PAGE_SIZE as u64, b"B");
        io.fail_read_process_address = Some(FILE_PAGE_SIZE as u64);
        assert_eq!(table.sync_file_from_process(1, true, &mut io), Err(Errno::EFAULT));
        let snapshot = table.mapping(1, 0).unwrap().snapshot.as_ref().unwrap();
        assert_eq!(snapshot[0], b'A');
        assert_eq!(snapshot[FILE_PAGE_SIZE], b'.');
        table.file_backing_mut(&key).unwrap().flush_range(0, 1, &mut io).unwrap();
        io.descriptor_write(10, 0, b"D");
        io.fail_read_process_address = None;
        table.sync_file_from_process(1, true, &mut io).unwrap();
        assert_eq!(io.files[&10][0], b'D');
        assert_eq!(io.files[&10][FILE_PAGE_SIZE], b'B');
        assert_eq!(io.peek(1, 0, 1), b"D");
    }

    #[test]
    fn retained_mapping_snapshot_refuses_even_when_all_pages_are_already_cached() {
        let mut io = MockIo::new().with_file(10, 1, 2, vec![b'.'; 8192]);
        let mut backing = FileBacking::new(io.key_of(10), 10, true, 8192);
        backing.ensure_range_loaded(0, 8192, &mut io).unwrap();
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(backing.read_range(0, 8192, &mut io), Err(Errno::ENOMEM));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        }
        let snapshot = backing.read_range(0, 8192, &mut io).unwrap();
        backing.invalidate_clean_pages();
        let owned = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(owned >= 2 * snapshot.len());
        drop(snapshot);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 < owned);
    }

    #[test]
    fn failed_mapping_preparation_does_not_pin_or_overwrite_process_memory() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        let before = io.peek(1, 0, 8);
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(table.prepare_kernel_file_mapping(1, 3, &key, 10, 0, 8, true, true, &mut io), Err(Errno::ENOMEM));
        }
        assert_eq!(io.peek(1, 0, 8), before);
        assert!(table.mapping(1, 0).is_none());
        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained.get(&10).copied().unwrap_or(0), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"filedata");
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);
    }

    #[test]
    fn prepared_mapping_publication_and_cancellation_need_no_new_credit() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        table.prepare_kernel_file_mapping(1, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        table.release_all_for_process(1, false, &mut io);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        table.prepare_kernel_file_mapping(1, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        table.cancel_kernel_file_mapping(&mut io);
        assert_eq!(io.retained[&10], 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn split_preparation_refuses_before_changes_and_commit_uses_current_snapshot_without_allocation() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"01234567".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert_eq!(table.prepare_cleanup_mappings(1, 3, 2), Err(Errno::ENOMEM));
        }
        assert_eq!(table.mapping(1, 0).unwrap().len, 8);
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);
        table.prepare_cleanup_mappings(1, 3, 2).unwrap();
        table.mappings.get_mut(&1).unwrap().get_mut(&0).unwrap().snapshot.as_mut().unwrap()[5] = b'X';
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            table.cleanup_mappings(1, 3, 2, &mut io).unwrap();
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        assert_eq!(table.mapping(1, 5).unwrap().snapshot.as_deref(), Some(&b"X67"[..]));
        assert_eq!(table.mapping(1, 0).unwrap().len, 3);
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);
    }

    #[test]
    fn remap_preparation_refusal_and_process_write_failure_preserve_the_old_tracker() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"0123456789ABCDEF".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert_eq!(table.prepare_remap_mapping(1, 0, 16, &mut io), Err(Errno::ENOMEM));
        }
        assert_eq!(table.mapping(1, 0).unwrap().len, 8);
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);
        table.prepare_remap_mapping(1, 0, 16, &mut io).unwrap();
        assert_eq!(table.remap_mapping(1, 0, 4096, 16, &mut io), Err(Errno::EFAULT));
        assert_eq!(table.mapping(1, 0).unwrap().len, 8);
        table.prepare_remap_mapping(1, 0, 16, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            table.remap_mapping(1, 0, 32, 16, &mut io).unwrap();
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        assert!(table.mapping(1, 0).is_none());
        assert_eq!(table.mapping(1, 32).unwrap().len, 16);
        assert_eq!(io.peek(1, 32, 16), b"0123456789ABCDEF");
    }

    #[test]
    fn inheritance_admits_snapshots_rollback_bytes_and_nodes_before_child_publication() {
        for cut in 0..3 {
            let mut io = MockIo::new().with_process(1, 4096).with_process(2, 4096)
                .with_kernel_file(10, 1, 2, b"filedata".to_vec());
            let mut table = SharedMappingTable::new();
            let key = io.key_of(10);
            table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
            io.poke(2, 0, b"original");
            let retained = crate::io_buffer::IO_MEMORY.usage().0;
            crate::prepared_map::fail_after_allocations(cut);
            assert_eq!(table.inherit_process_mappings(1, 2, &mut io), Err(Errno::ENOMEM));
            crate::prepared_map::fail_after_allocations(usize::MAX);
            assert_eq!(io.peek(2, 0, 8), b"original");
            assert!(table.mapping(2, 0).is_none());
            assert_eq!(table.file_backing(&key).unwrap().ref_count, 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
            {
                let _limit = crate::io_buffer::test_budget(retained);
                assert_eq!(table.inherit_process_mappings(1, 2, &mut io), Err(Errno::ENOMEM));
            }
            table.inherit_process_mappings(1, 2, &mut io).unwrap();
            assert_eq!(io.peek(2, 0, 8), b"filedata");
            assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);
        }
    }

    #[test]
    fn teardown_records_unpublished_stores_when_full_credit_refuses_publication() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        io.poke(1, 0, b"X");
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            table.release_all_for_process(1, true, &mut io);
        }
        assert_eq!(io.files[&10], b"filedata");
        assert_eq!(io.losses, vec![(1, 0, String::from("publication failed"))]);
        assert_eq!(io.retained[&10], 0);
        assert!(table.mapping(1, 0).is_none());
    }

    #[test]
    fn teardown_does_not_report_clean_mappings_as_lost_when_admission_refuses() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            table.release_all_for_process(1, true, &mut io);
        }
        assert!(io.losses.is_empty());
        assert_eq!(io.retained[&10], 0);
    }

    #[test]
    fn teardown_does_not_call_a_successful_publication_lost_when_only_import_fails() {
        let mut io = MockIo::new().with_process(1, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        table.track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        io.poke(1, 0, b"X");
        io.fail_write_process_at = Some(0);
        table.release_all_for_process(1, true, &mut io);
        assert_eq!(io.files[&10], b"Xiledata");
        assert!(io.losses.is_empty());
        assert_eq!(io.retained[&10], 0);
    }

    #[test]
    fn backing_registry_node_refusal_precedes_handle_retention_and_retries_without_credit_leaks() {
        let mut io = MockIo::new().with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        let stat = io.stat_of(10);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        crate::prepared_map::fail_after_allocations(0);
        assert!(matches!(table.get_or_create_file_backing(&key, &stat, true, &mut io), Err(Errno::ENOMEM)));
        crate::prepared_map::fail_after_allocations(usize::MAX);
        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained.get(&10).copied().unwrap_or(0), 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        table.get_or_create_file_backing(&key, &stat, true, &mut io).unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > baseline);
        assert_eq!(io.retained[&10], 1);
        table.discard_unreferenced_file_backing(&key, &mut io);
        assert_eq!(io.retained[&10], 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn anonymous_registry_refusal_keeps_the_table_empty_and_teardown_needs_no_new_node() {
        for cut in 0..3 {
            let mut io = MockIo::new().with_process(1, 4096);
            let mut table = SharedMappingTable::new();
            let baseline = crate::io_buffer::IO_MEMORY.usage().0;
            crate::prepared_map::fail_after_allocations(cut);
            assert_eq!(table.track_anonymous_mapping(1, 0, 8, true, &mut io), Err(Errno::ENOMEM));
            crate::prepared_map::fail_after_allocations(usize::MAX);
            assert!(table.anon_backings.is_empty());
            assert!(table.mappings.is_empty());
            assert_eq!(table.next_anon_id, 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
            table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
            {
                let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
                crate::prepared_map::fail_after_allocations(0);
                table.release_all_for_process(1, true, &mut io);
                crate::prepared_map::fail_after_allocations(usize::MAX);
            }
            assert!(table.is_empty());
            assert!(table.anon_backings.is_empty());
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn prepared_file_mapping_is_bound_to_its_process_address_and_source_handle() {
        let mut io = MockIo::new().with_process(1, 4096).with_process(2, 4096)
            .with_kernel_file(10, 1, 2, b"filedata".to_vec());
        let mut table = SharedMappingTable::new();
        let key = io.key_of(10);
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        table.prepare_kernel_file_mapping(1, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        assert_eq!(table.commit_kernel_file_mapping(1, 32, &mut io), Err(Errno::EINVAL));
        assert_eq!(table.bind_kernel_file_mapping(2, 32), Err(Errno::EINVAL));
        table.bind_kernel_file_mapping(1, 32).unwrap();
        assert_eq!(table.bind_kernel_file_mapping(1, 64), Err(Errno::EINVAL));
        assert_eq!(table.commit_kernel_file_mapping(2, 32, &mut io), Err(Errno::EINVAL));
        assert_eq!(table.track_kernel_file_mapping(1, 32, 3, &key, 11, 0, 8, true, true, &mut io), Err(Errno::EINVAL));
        assert_eq!(io.peek(1, 32, 8), [0; 8]);
        assert_eq!(io.retained[&10], 1);
        table.cancel_kernel_file_mapping_in_range(2, 32, 8, &mut io);
        table.cancel_kernel_file_mapping_in_range(1, 32, 7, &mut io);
        assert!(table.prepared_kernel_file_mapping(1, 32).is_some());
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            table.cancel_kernel_file_mapping_in_range(1, 0, 4096, &mut io);
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        assert_eq!(io.retained[&10], 0);
        assert!(table.pending_file_mapping.is_none());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        table.track_kernel_file_mapping(1, 32, 3, &key, 10, 0, 8, true, true, &mut io).unwrap();
        assert_eq!(io.peek(1, 32, 8), b"filedata");
    }

    #[test]
    fn segment_version_owner_survives_peers_and_releases_after_the_last_attachment() {
        let mut io = MockIo::new().with_process(1, 4096).with_process(2, 4096);
        io.shm.insert(7, vec![b'.'; 8]);
        let mut table = SharedMappingTable::new();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        table.track_sysv_mapping(2, 0, 7, 8, false, &mut io).unwrap();
        io.poke(1, 0, b"X");
        assert!(table.sync_sysv_from_process(1, true, &mut io));
        let version = table.sysv_segment_version(7);
        assert!(version > 0);
        table.drop_sysv_mapping(1, 0);
        assert_eq!(table.sysv_segment_version(7), version);
        table.release_all_sysv_for_process(2, false, &mut io);
        assert!(table.sysv_versions.is_empty());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        table.track_sysv_mapping(1, 0, 7, 8, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"X.......");
    }

    #[test]
    fn shrinking_a_file_discards_dirty_bytes_past_the_new_end() {
        let mut io = MockIo::new().with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut backing = FileBacking::new(key, 10, true, 8);
        backing.observe_source_generation(&mut io);
        backing.write_range(0, b"A", true, &mut io).unwrap();
        backing.write_range(6, b"Z", true, &mut io).unwrap();
        io.files.get_mut(&10).unwrap().truncate(2);
        *io.generations.get_mut(&10).unwrap() += 1;
        backing.reconcile_source(&mut io);
        io.descriptor_write(10, 7, b"B");
        backing.flush_all(&mut io).unwrap();
        assert_eq!(io.files[&10], b"A.\0\0\0\0\0B");
        assert_eq!(backing.dirty_page_count(), 0);
    }

    #[test]
    fn truncation_notification_preserves_a_shrink_before_regrowth() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.fail_pwrite = true;
        io.poke(1, 0, b"A.....Z.");
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EIO));
        io.fail_pwrite = false;
        io.files.get_mut(&10).unwrap().truncate(2);
        *io.generations.get_mut(&10).unwrap() += 1;
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            crate::prepared_map::fail_after_allocations(0);
            table.notify_file_truncated(10, 2);
            crate::prepared_map::fail_after_allocations(usize::MAX);
        }
        io.descriptor_write(10, 7, b"B");
        // Background publication already recorded the loss. Persistence may
        // recover now, but this mapping's first explicit sync reports that
        // historical error once; it must not silently turn into success.
        assert_eq!(table.flush_mappings(1, 0, 8, &mut io), Err(Errno::EIO));
        assert_eq!(io.files[&10], b"A.\0\0\0\0\0B");
        assert_eq!(io.peek(1, 0, 8), b"A.\0\0\0\0\0B");
        table.flush_mappings(1, 0, 8, &mut io).unwrap();
        assert!(!table.take_writeback_error(1, 0, 8), "the historical error is consumed exactly once");
    }

    #[test]
    fn kernel_file_truncation_owners_retire_dirty_bytes_before_regrowth() {
        use wasm_posix_shared::flags::{O_CREAT, O_RDWR, O_TRUNC};
        crate::rootfs::reset();
        for scratch in [false, true] {
            let path = if scratch { b"/tmp/mapping-truncate-notification".as_slice() }
                else { b"/mapping-truncate-notification".as_slice() };
            let handle = if scratch {
                crate::tmpfs::open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap()
            } else {
                crate::rootfs::open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap()
            };
            for open_truncate in [false, true] {
                if scratch { crate::tmpfs::write(handle, 0, b"........").unwrap(); }
                else { crate::rootfs::write(handle, 0, b"........", |_, _| Err(Errno::EIO)).unwrap(); }
                let mut io = MockIo::new().with_kernel_file(handle, 95, 9123, b"........".to_vec());
                let key = io.key_of(handle);
                let mut backing = FileBacking::new(key.clone(), handle, true, 8);
                backing.write_range(6, b"Z", true, &mut io).unwrap();
                unsafe { global_shared_mapping_table() }.file_backings.insert(key.clone(), backing);
                if open_truncate {
                    let extra = if scratch { crate::tmpfs::open(path, O_TRUNC | O_RDWR, 0o600, 0, 0).unwrap() }
                        else { crate::rootfs::open(path, O_TRUNC | O_RDWR, 0o600, 0, 0).unwrap() };
                    if scratch { crate::tmpfs::release_handle(extra); }
                    else { crate::rootfs::release_handle(extra); }
                } else if scratch {
                    crate::tmpfs::truncate_handle(handle, 2).unwrap();
                } else {
                    crate::rootfs::truncate_handle(handle, 2, |_, _| Err(Errno::EIO)).unwrap();
                }
                if scratch { crate::tmpfs::truncate_handle(handle, 8).unwrap(); }
                else { crate::rootfs::truncate_handle(handle, 8, |_, _| Err(Errno::EIO)).unwrap(); }
                let table = unsafe { global_shared_mapping_table() };
                let backing = table.file_backing(&key).unwrap();
                assert_eq!(backing.dirty_page_count(), 0);
                assert_eq!(backing.size, 8);
                assert!(backing.version >= 2);
                table.file_backings.remove(&key);
            }
            if scratch {
                crate::tmpfs::release_handle(handle);
                crate::tmpfs::unlink(path).unwrap();
            } else {
                crate::rootfs::release_handle(handle);
                crate::rootfs::unlink(path).unwrap();
            }
        }
    }

    #[test]
    fn failed_mapped_writeback_preserves_a_same_page_descriptor_write() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.fail_pwrite = true;
        io.poke(1, 0, b"A.......");
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EIO));
        io.fail_pwrite = false;
        io.descriptor_write(10, 1, b"B");
        // Background publication already recorded the loss. Persistence may
        // recover now, but this mapping's first explicit sync reports that
        // historical error once; it must not silently turn into success.
        assert_eq!(table.flush_mappings(1, 0, 8, &mut io), Err(Errno::EIO));
        assert_eq!(io.files[&10], b"AB......");
        table.sync_file_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"AB......");
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 0);
        table.flush_mappings(1, 0, 8, &mut io).unwrap();
        assert!(!table.take_writeback_error(1, 0, 8), "the historical error is consumed exactly once");
    }

    #[test]
    fn partial_mapped_writeback_does_not_replay_a_successful_prefix() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.write_budget = Some(1);
        io.poke(1, 0, b"AAAA....");
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::ENOSPC));
        assert_eq!(io.files[&10], b"A.......");
        io.write_budget = None;
        io.descriptor_write(10, 0, b"B");
        // Background publication already recorded the loss. Persistence may
        // recover now, but this mapping's first explicit sync reports that
        // historical error once; it must not silently turn into success.
        assert_eq!(table.flush_mappings(1, 0, 8, &mut io), Err(Errno::EIO));
        assert_eq!(io.files[&10], b"BAAA....");
        assert_eq!(io.peek(1, 0, 8), b"BAAA....");
        table.flush_mappings(1, 0, 8, &mut io).unwrap();
        assert!(!table.take_writeback_error(1, 0, 8), "the historical error is consumed exactly once");
    }

    #[test]
    fn reconciling_a_descriptor_write_keeps_dirty_pages() {
        let page = FILE_PAGE_SIZE;
        let mut io = MockIo::new().with_kernel_file(10, 1, 2, vec![b'.'; 2 * page]);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        let backing = table.get_or_create_file_backing(&key, &stat, true, &mut io).unwrap();
        backing.write_range(0, b"DD", true, &mut io).unwrap();
        io.descriptor_write(10, page, b"ee");

        let backing = table.file_backing_mut(&key).unwrap();
        let version = backing.version;
        backing.reconcile_source(&mut io);
        assert!(backing.version > version, "observers are told the file changed");
        assert_eq!(backing.dirty_page_count(), 1);
        backing.flush_all(&mut io).unwrap();
        assert_eq!(&io.files[&10][..2], b"DD");
        assert_eq!(&io.files[&10][page..page + 2], b"ee");
    }

    /// A write-through that the file refuses is reported and leaves the
    /// published bytes dirty for a later attempt, never silently dropped.
    #[test]
    fn a_refused_write_through_is_reported_and_kept() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);

        io.fail_pwrite = true;
        io.poke(1, 0, b"AAAA....");
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EIO));
        assert_eq!(io.losses.len(), 1);
        assert_eq!(table.file_backing(&key).unwrap().dirty_page_count(), 1);

        io.fail_pwrite = false;
        // Background publication already recorded the loss. Persistence may
        // recover now, but this mapping's first explicit sync reports that
        // historical error once; it must not silently turn into success.
        assert_eq!(table.flush_mappings(1, 0, 8, &mut io), Err(Errno::EIO));
        assert_eq!(io.files[&10], b"AAAA....".to_vec());
        table.flush_mappings(1, 0, 8, &mut io).unwrap();
        assert!(!table.take_writeback_error(1, 0, 8), "the historical error is consumed exactly once");
    }

    /// A refused writeback is reported to every mapping of the file, once:
    /// each observer's next msync over it answers EIO (Linux reports a
    /// writeback error through the mapping's file), and only that once.
    #[test]
    fn a_refused_write_through_is_reported_once_to_every_mapping_of_the_file() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);

        io.fail_pwrite = true;
        io.poke(1, 0, b"AAAA....");
        assert_eq!(table.sync_file_from_process(1, false, &mut io), Err(Errno::EIO));
        io.fail_pwrite = false;
        assert!(table.take_writeback_error(1, 0, 8), "the writer's mapping is told");
        assert!(table.take_writeback_error(2, 0, 8), "a reader's mapping is told");
        assert!(!table.take_writeback_error(1, 0, 8), "each mapping is told once");
        assert!(!table.take_writeback_error(2, 0, 8));
        // A later successful flush reports nothing new.
        assert!(table.flush_mappings(1, 0, 8, &mut io).is_ok());
        assert!(!table.take_writeback_error(2, 0, 8));
    }

    /// msync itself reports the failure it hit, so the caller's mapping has
    /// seen it; a peer mapping of the same file still reports it once.
    #[test]
    fn a_failed_msync_reports_its_own_failure_and_leaves_peers_told() {
        let mut io = MockIo::new()
            .with_process(1, 64)
            .with_process(2, 64)
            .with_kernel_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = file_table_with_two_observers(&mut io, &key);
        io.fail_pwrite = true;
        io.poke(1, 0, b"BBBB....");
        assert!(table.flush_mappings(1, 0, 8, &mut io).is_err());
        assert!(!table.take_writeback_error(1, 0, 8));
        assert!(table.take_writeback_error(2, 0, 8));
        assert!(!io.losses.is_empty(), "the loss is recorded");
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

    // -- the descriptor fence and publish-only pulls ----------------------

    fn sole_kernel_mapping(io: &mut MockIo) -> SharedMappingTable {
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        table
            .track_kernel_file_mapping(1, 0, 3, &key, 10, 0, 8, true, true, io)
            .unwrap();
        table
    }

    /// The sole mapper of a file defers publication at its own boundaries,
    /// but a descriptor operation on the file publishes it first.
    #[test]
    fn a_fence_publishes_a_sole_writers_store_before_descriptor_io() {
        let mut io = kernel_file_io();
        let mut table = sole_kernel_mapping(&mut io);
        io.poke(1, 0, b"AAAA");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.files[&10], b"........".to_vec(), "a sole observer defers");
        assert!(table.is_fenced_handle(10));
        table.fence_handle(10, &mut io).unwrap();
        assert_eq!(io.files[&10], b"AAAA....".to_vec(), "the fence published it");
        assert_eq!(table.file_backing(&io.key_of(10)).unwrap().cached_page_count(), 0);
    }

    #[test]
    fn a_pull_publishes_without_writing_the_pulled_process() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.poke(2, 0, b"....BBBB");
        // Process 1 is running and stores at bytes no peer touched; a pull of
        // process 2 must leave process 1's memory exactly as it is.
        io.poke(1, 0, b"AA");
        assert!(table.pull_backing(&key, Some(1), &mut io).unwrap());
        assert_eq!(io.files[&10], b"....BBBB".to_vec());
        assert_eq!(io.peek(1, 0, 8), b"AA......".to_vec(), "process 1 untouched");
        assert_eq!(io.peek(2, 0, 8), b"....BBBB".to_vec(), "process 2 untouched");
        // Process 1's own store is still unpublished and is found later.
        assert!(table.pull_backing(&key, None, &mut io).unwrap());
        assert_eq!(io.files[&10], b"AA..BBBB".to_vec());
    }

    /// A pull adopts the bytes it read as the snapshot. Keeping the old one
    /// would merge the same store again over a peer's newer bytes.
    #[test]
    fn a_repeated_pull_does_not_republish_over_a_newer_peer_store() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.poke(1, 0, b"XXXX");
        table.pull_backing(&key, None, &mut io).unwrap();
        assert_eq!(io.files[&10], b"XXXX....".to_vec());
        io.poke(2, 0, b"YYYY");
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.files[&10], b"YYYY....".to_vec());
        let version = table.file_backing(&key).unwrap().version;
        table.pull_backing(&key, None, &mut io).unwrap();
        assert_eq!(io.files[&10], b"YYYY....".to_vec(), "the older store stays superseded");
        assert_eq!(table.file_backing(&key).unwrap().version, version, "nothing new to publish");
    }

    #[test]
    fn a_handle_nothing_maps_needs_no_fence() {
        let mut io = kernel_file_io();
        let mut table = sole_kernel_mapping(&mut io);
        let reads = io.reads_of(1);
        assert!(!table.is_fenced_handle(99));
        table.fence_handle(99, &mut io).unwrap();
        assert_eq!(io.reads_of(1), reads);
    }

    #[test]
    fn a_refused_fence_publication_fails_the_descriptor_operation() {
        let mut io = kernel_file_io();
        let mut table = sole_kernel_mapping(&mut io);
        io.poke(1, 0, b"AAAA");
        io.fail_pwrite = true;
        assert_eq!(table.fence_handle(10, &mut io), Err(Errno::EIO));
        assert_eq!(io.losses.len(), 1, "the loss is reported");
        assert!(table.take_writeback_error(1, 0, 8), "and the mapping's msync is told");
        let key = io.key_of(10);
        assert!(table.file_backing(&key).unwrap().dirty_page_count() > 0, "the store is kept");
        io.fail_pwrite = false;
        table.fence_handle(10, &mut io).unwrap();
        assert_eq!(io.files[&10], b"AAAA....".to_vec(), "and reaches the file later");
    }

    #[test]
    fn fence_all_publishes_every_mapped_file() {
        let mut io = kernel_file_io().with_kernel_file(11, 1, 3, b"________".to_vec());
        let mut table = sole_kernel_mapping(&mut io);
        let other = io.key_of(11);
        table
            .track_kernel_file_mapping(2, 0, 4, &other, 11, 0, 8, true, true, &mut io)
            .unwrap();
        io.poke(1, 0, b"A");
        io.poke(2, 0, b"B");
        table.fence_all(&mut io).unwrap();
        assert_eq!(io.files[&10], b"A.......".to_vec());
        assert_eq!(io.files[&11], b"B_______".to_vec());
    }

    #[test]
    fn the_descriptor_fence_names_the_files_each_syscall_touches() {
        use wasm_posix_shared::abi::extended_syscalls as x;
        use wasm_posix_shared::Syscall as S;
        let args = |a: i64, b: i64, c: i64| [a, b, c, 0, 0, 0];
        let one = |fd| DescriptorFence::Fds([Some(fd), None]);
        for nr in [
            S::Read as u32,
            S::Write as u32,
            S::Pread as u32,
            S::Pwrite as u32,
            S::Readv as u32,
            S::Writev as u32,
            S::Ftruncate as u32,
            x::SYS_PREADV,
            x::SYS_PWRITEV,
            x::SYS_PREADV2,
            x::SYS_PWRITEV2,
            x::SYS_FALLOCATE,
        ] {
            assert_eq!(descriptor_fence_for(nr, &args(7, 0, 0)), one(7), "syscall {nr}");
        }
        assert_eq!(
            descriptor_fence_for(x::SYS_SENDFILE, &args(4, 5, 0)),
            DescriptorFence::Fds([Some(4), Some(5)])
        );
        for nr in [x::SYS_SPLICE, x::SYS_COPY_FILE_RANGE] {
            assert_eq!(
                descriptor_fence_for(nr, &args(4, 0, 6)),
                DescriptorFence::Fds([Some(4), Some(6)])
            );
        }
        for nr in [S::Fsync as u32, S::Fdatasync as u32, S::Truncate as u32] {
            assert_eq!(descriptor_fence_for(nr, &args(3, 0, 0)), DescriptorFence::InExport);
        }
        let trunc = wasm_posix_shared::flags::O_TRUNC as i64;
        let rdwr = wasm_posix_shared::flags::O_RDWR as i64;
        assert_eq!(descriptor_fence_for(S::Open as u32, &args(0, trunc | rdwr, 0)), DescriptorFence::AllMappedFiles);
        assert_eq!(descriptor_fence_for(S::Open as u32, &args(0, rdwr, 0)), DescriptorFence::None);
        assert_eq!(descriptor_fence_for(S::Openat as u32, &args(-100, 0, trunc)), DescriptorFence::AllMappedFiles);
        assert_eq!(descriptor_fence_for(S::Openat as u32, &args(-100, 0, rdwr)), DescriptorFence::None);
        for nr in [S::Fstat as u32, S::Close as u32, S::Seek as u32, S::Mmap as u32] {
            assert_eq!(descriptor_fence_for(nr, &args(3, 0, 0)), DescriptorFence::None);
        }
    }

    /// Hazard 1: a newcomer's join used to refresh every existing observer
    /// in place, writing the whole mapping back into a process that may be
    /// running. A store it made between that read and write was lost.
    #[test]
    fn a_join_never_writes_into_an_existing_observer() {
        let mut io = kernel_file_io().with_process(3, 64);
        let (mut table, key) = kernel_file_pair(&mut io);
        io.poke(1, 0, b"AAAA");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        // Process 2 is now stale. A thread of it stores at a byte no peer
        // touched, right after the join reads its memory.
        io.store_after_read = Some((2, 7, b"Z".to_vec()));
        table
            .track_kernel_file_mapping(3, 0, 3, &key, 10, 0, 8, true, true, &mut io)
            .unwrap();
        assert_eq!(io.peek(2, 0, 8), b".......Z".to_vec(), "process 2's store survives");
        assert_eq!(io.peek(3, 0, 8), b"AAAA....".to_vec(), "the newcomer starts current");
        // Process 2 imports process 1's bytes at its own boundary, and its
        // late store publishes there too.
        table.sync_file_from_process(2, false, &mut io).unwrap();
        assert_eq!(io.peek(2, 0, 8), b"AAAA...Z".to_vec());
        assert_eq!(io.files[&10], b"AAAA...Z".to_vec());
    }

    /// Hazard 2: a refresh at a process's own boundary used to rewrite the
    /// whole mapping, overwriting a sibling thread's store to bytes no peer
    /// had changed. It now writes only the runs peers changed.
    #[test]
    fn a_refresh_writes_only_what_peers_changed() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.poke(2, 0, b"....BBBB");
        table.sync_file_from_process(2, false, &mut io).unwrap();
        io.store_after_read = Some((1, 0, b"Z".to_vec()));
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"Z...BBBB".to_vec(), "the sibling's store survives");
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.files[&10], b"Z...BBBB".to_vec(), "and publishes at the next boundary");
    }

    #[test]
    fn refresh_runs_join_close_changes_and_split_distant_ones() {
        let snapshot = vec![0u8; 3 * FILE_PAGE_SIZE];
        let mut latest = snapshot.clone();
        // Pixels whose alpha byte is unchanged: one run per page cluster.
        for i in (0..64).step_by(4) {
            latest[i..i + 3].copy_from_slice(&[1, 2, 3]);
        }
        latest[FILE_PAGE_SIZE - 1] = 9; // far from the cluster: its own run
        latest[2 * FILE_PAGE_SIZE + 5] = 7;
        assert_eq!(
            refresh_runs(&latest, &snapshot),
            alloc::vec![(0, 63), (FILE_PAGE_SIZE - 1, FILE_PAGE_SIZE), (2 * FILE_PAGE_SIZE + 5, 2 * FILE_PAGE_SIZE + 6)]
        );
        // Runs on either side of a page boundary closer than the gap join.
        let mut across = snapshot.clone();
        across[FILE_PAGE_SIZE - 2] = 1;
        across[FILE_PAGE_SIZE + 3] = 1;
        assert_eq!(refresh_runs(&across, &snapshot), alloc::vec![(FILE_PAGE_SIZE - 2, FILE_PAGE_SIZE + 4)]);
        assert!(refresh_runs(&snapshot, &snapshot).is_empty());
        assert_eq!(refresh_runs(&latest, &snapshot[..10]), alloc::vec![(0, latest.len())]);
    }

    // -- quiescence proofs (`CleanStamp`) --------------------------------

    /// A parked process pulled twice with nothing in between is covered by
    /// the first pull's stamp; in shadow mode the comparison still runs and
    /// confirms it.
    #[test]
    fn a_parked_process_pulled_twice_is_proved_unchanged() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        let stamp = table.mapping(2, 0).unwrap().clean;
        assert!(stamp.is_some(), "a quiescent observation is stamped");
        let reads = io.reads_of(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        let expected = if SKIP_PROVED_PULLS { reads } else { reads + 1 };
        assert_eq!(io.reads_of(2), expected);
        assert_eq!(table.mapping(2, 0).unwrap().clean, stamp);
    }

    #[test]
    fn a_running_process_is_never_stamped() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert!(table.mapping(2, 0).unwrap().clean.is_none());
    }

    /// A store made after the process resumed is published: the resume
    /// changed the epoch.
    #[test]
    fn a_resume_voids_the_proof() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        io.resume(2);
        io.poke(2, 0, b"BB");
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.files[&10], b"BB......".to_vec());
    }

    /// A syscall output the kernel stores into the mapping is published.
    #[test]
    fn a_kernel_write_voids_the_proof() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        io.kernel_store(2, 2, b"KK");
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.files[&10], b"..KK....".to_vec());
    }

    /// The kernel's write log alone also voids the proof, for a write the
    /// host's epoch did not see (a defense the two layers give each other).
    #[test]
    fn a_logged_kernel_write_voids_the_proof_without_an_epoch_change() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        io.kernel_log.record(2, 4, 2);
        io.poke(2, 4, b"LL");
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.files[&10], b"....LL..".to_vec());
    }

    /// A host that changed process bytes without an epoch event breaks the
    /// proof's premise. Shadow mode turns that into a fatal fault rather than
    /// a store a skipped comparison would have lost.
    #[cfg(feature = "shared-mapping-proof-verify")]
    #[test]
    #[should_panic(expected = "missed a change")]
    fn a_missed_epoch_event_is_a_fatal_fault() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        io.poke(2, 0, b"?");
        let _ = table.pull_backing(&key, Some(1), &mut io);
    }

    /// Without the shadow check, the skip trusts the host's epoch: a change
    /// the host never announced is not compared. This is why every host
    /// write and every resume must change the epoch, and why the verify
    /// build is run over the mapping tests and a desktop session.
    #[cfg(not(feature = "shared-mapping-proof-verify"))]
    #[test]
    fn a_proved_pull_trusts_the_hosts_epoch() {
        let mut io = kernel_file_io();
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(2);
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        let reads = io.reads_of(2);
        io.poke(2, 0, b"?");
        table.pull_backing(&key, Some(1), &mut io).unwrap();
        assert_eq!(io.reads_of(2), reads, "skipped");
        assert_eq!(io.files[&10], b"........".to_vec());
    }

    /// A refresh writes the process (an epoch event) and stamps what it left.
    #[test]
    fn a_refresh_stamps_the_bytes_it_wrote() {
        let mut io = kernel_file_io();
        let (mut table, _) = kernel_file_pair(&mut io);
        io.poke(2, 0, b"....BBBB");
        table.sync_file_from_process(2, false, &mut io).unwrap();
        io.park(1);
        table.sync_file_from_process(1, false, &mut io).unwrap();
        assert_eq!(io.peek(1, 0, 8), b"....BBBB".to_vec());
        let clean = table.mapping(1, 0).unwrap().clean.expect("stamped");
        assert_eq!(Some(clean.epoch), io.quiescent_epoch(1), "from the epoch after the write");
    }

    #[test]
    fn a_forked_child_starts_without_a_stamp() {
        let mut io = kernel_file_io().with_process(3, 64);
        let (mut table, key) = kernel_file_pair(&mut io);
        io.park(1);
        table.pull_backing(&key, None, &mut io).unwrap();
        assert!(table.mapping(1, 0).unwrap().clean.is_some());
        table.inherit_process_mappings(1, 3, &mut io).unwrap();
        assert!(table.mapping(3, 0).unwrap().clean.is_none());
    }

    #[test]
    fn pulling_a_backing_publishes_a_deferred_sole_writer() {
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

        table.pull_backing(&key, None, &mut io).unwrap();
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

    // -- munmap split -----------------------------------------------------

    #[test]
    fn a_head_unmap_slides_the_tail_and_its_snapshot() {
        let mut io = MockIo::new()
            .with_process(1, 4096)
            .with_file(10, 1, 2, vec![b'.'; 8]);
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        table
            .get_or_create_file_backing(&key, &stat, true, &mut io)
            .unwrap()
            .ref_count = 1;
        io.poke(1, 0, b"01234567");
        table.insert_mapping(
            1,
            0,
            SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::copy_from(b"01234567").unwrap(), 0),
        );

        table.cleanup_mappings(1, 0, 3, &mut io).unwrap();
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
            SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::try_filled(8, b'.').unwrap(), 0),
        );

        table.cleanup_mappings(1, 3, 2, &mut io).unwrap();
        assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);
        table.cleanup_mappings(1, 0, 3, &mut io).unwrap();
        assert!(table.file_backing(&key).is_some());
        table.cleanup_mappings(1, 5, 3, &mut io).unwrap();
        assert!(table.file_backing(&key).is_none());
        assert_eq!(io.retained[&10], 0);
    }

    // -- fork inheritance --------------------------------------------------

    #[test]
    fn fork_failures_identify_snapshot_read_rollback_read_metadata_and_write_without_mutation() {
        for scenario in 0..4 {
            let mut io = MockIo::new().with_process(1, 64).with_process(2, 64)
                .with_process(3, 64).with_kernel_file(10, 1, 2, b"........".to_vec());
            let key = io.key_of(10);
            let mut table = file_table_with_two_observers(&mut io, &key);
            io.poke(3, 0, b"ORIGINAL");
            let retained = io.retained_count(10);
            let version = table.file_backing(&key).unwrap().version;
            // Inheritance settles write-through cache pages even on refusal.
            // Measure exact retained custody cold, then warm the cache so the
            // injected map-node refusal cannot hit an earlier page admission.
            table.file_backing_mut(&key).unwrap().settle();
            let retained_usage = crate::io_buffer::IO_MEMORY.usage().0;
            drop(table.file_backing_mut(&key).unwrap().read_range(0, 8, &mut io).unwrap());
            let held = crate::io_buffer::IO_MEMORY.usage().0;
            let (error, phase) = match scenario {
                0 => {
                    let _limit = crate::io_buffer::test_budget(held);
                    let result = table.inherit_process_mappings(1, 3, &mut io);
                    assert_eq!(result, Err(Errno::ENOMEM));
                    (Errno::ENOMEM, "fork_stage_read")
                }
                1 => {
                    io.fail_read_process_at = Some((3, 0));
                    assert_eq!(table.inherit_process_mappings(1, 3, &mut io), Err(Errno::EFAULT));
                    (Errno::EFAULT, "fork_rollback_read")
                }
                2 => {
                    io.fail_write_process_at = Some(0);
                    assert_eq!(table.inherit_process_mappings(1, 3, &mut io), Err(Errno::EFAULT));
                    (Errno::EFAULT, "fork_commit_write")
                }
                _ => {
                    crate::prepared_map::fail_after_allocations(0);
                    let result = table.inherit_process_mappings(1, 3, &mut io);
                    crate::prepared_map::fail_after_allocations(usize::MAX);
                    assert_eq!(result, Err(Errno::ENOMEM));
                    (Errno::ENOMEM, "fork_stage_metadata")
                }
            };
            assert!(table.mapping(3, 0).is_none());
            assert_eq!(io.peek(3, 0, 8).as_slice(), b"ORIGINAL");
            assert_eq!(table.mapping(1, 0).unwrap().snapshot.as_deref(), Some(&b"........"[..]));
            assert_eq!(table.file_backing(&key).unwrap().version, version);
            assert_eq!(table.file_backing(&key).unwrap().ref_count, 2);
            assert_eq!(io.retained_count(10), retained);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained_usage);
            let record = table.failures.records[0].unwrap();
            assert_eq!(record.phase, phase);
            assert_eq!(record.pid, 3);
            assert_eq!((record.addr, record.len, record.handle), (0, 8, 10));
            assert_eq!(record.status, -(error as i32));
            let report = table.render_failures().unwrap();
            let report = core::str::from_utf8(&report).unwrap();
            assert!(report.contains(&alloc::format!("phase={phase} pid=3 addr=0x0 len=8 file_offset=0 handle=10")));
            if scenario == 0 {
                assert!(report.contains(&alloc::format!("io_live={held} io_limit={held}")));
            }
            if scenario == 2 {
                // Diagnostic observation must not turn the original rollback
                // attempt into another write or replace its original errno.
                assert_eq!(table.failures.total, 2);
                assert_eq!(table.failures.records[1].unwrap().phase, "fork_rollback_write");
            }
        }
    }

    #[test]
    fn anonymous_fork_stage_refusal_records_no_fabricated_file_authority() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let held = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(held);
            assert_eq!(table.inherit_process_mappings(1, 2, &mut io), Err(Errno::ENOMEM));
        }
        assert!(table.mapping(2, 0).is_none());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, held);
        let record = table.failures.records[0].unwrap();
        assert_eq!(record.phase, "fork_anon_stage");
        assert_eq!((record.pid, record.addr, record.len, record.handle), (2, 0, 8, -1));
        assert_eq!(record.status, -(Errno::ENOMEM as i32));
    }

    #[test]
    fn a_child_inherits_the_latest_shared_bytes_and_a_backing_reference() {
        let mut io = MockIo::new().with_process(1, 64).with_process(2, 64);
        let mut table = SharedMappingTable::new();
        table.track_anonymous_mapping(1, 0, 8, true, &mut io).unwrap();
        let key = table.mapping(1, 0).unwrap().backing_key.clone().unwrap();
        table.anon_backings.get_mut(&key).unwrap().bytes = IoBuffer::copy_from(b"PARENTAL").unwrap();
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
        table.anon_backings.get_mut(&key).unwrap().bytes = IoBuffer::copy_from(b"PARENTAL").unwrap();
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
            table.sysv_attachments_for(1).collect::<Vec<_>>(),
            vec![(0u64, 7i32, 8usize, false), (16u64, 9i32, 4usize, true)],
        );
        assert!(table.sysv_attachments_for(2).next().is_none());
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
            SharedMapping::file(3, 0, 8, true, true, key.clone(), IoBuffer::try_filled(8, b'.').unwrap(), 0),
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

    // -- reconciling a file written through its descriptor -----------------

    fn single_file_backing(io: &mut MockIo, key: &str) -> SharedMappingTable {
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        let backing = table.get_or_create_file_backing(key, &stat, true, io).unwrap();
        backing.ref_count += 1;
        table
    }

    #[test]
    fn a_reload_re_reads_resident_pages_after_a_write_through_the_descriptor() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"BEFORE..".to_vec());
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"BEFORE..".to_vec());
        let before = table.file_backing(&key).unwrap().version;

        // Something writes the file through its descriptor.
        io.files.insert(10, b"AFTER...".to_vec());
        assert!(table.reload_backing(&key, None, &mut io));

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"AFTER...".to_vec(), "the cache followed the file");
        assert!(
            table.file_backing(&key).unwrap().version > before,
            "mapped snapshots are stale and must re-import"
        );
    }

    #[test]
    fn a_reload_with_an_exact_size_trusts_the_length_the_syscall_set() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"ABCDEFGH".to_vec());
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();

        // ftruncate(fd, 4): the tail is gone and must now read as zero.
        io.files.insert(10, b"ABCD".to_vec());
        assert!(table.reload_backing(&key, Some(4), &mut io));

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"ABCD\0\0\0\0".to_vec(), "past EOF reads as zero");
        assert_eq!(table.file_backing(&key).unwrap().size, 4);
    }

    #[test]
    fn a_reload_marks_snapshots_stale_even_with_no_page_resident() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"ABCDEFGH".to_vec());
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);
        assert_eq!(table.file_backing(&key).unwrap().cached_page_count(), 0);
        let before = table.file_backing(&key).unwrap().version;

        assert!(table.reload_backing(&key, None, &mut io));
        assert!(
            table.file_backing(&key).unwrap().version > before,
            "it is the version bump, not the eviction, that forces a re-import"
        );
    }

    #[test]
    fn applying_a_positioned_write_does_not_mark_the_page_for_writeback() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();

        // pwrite(fd, "WXYZ", 4, 2) has already reached the file.
        io.files.insert(10, b"..WXYZ..".to_vec());
        table.apply_written_bytes(&key, 2, b"WXYZ", &mut io);

        let seen = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(seen, b"..WXYZ..".to_vec(), "the cache took the written bytes");
        assert_eq!(
            table.file_backing(&key).unwrap().dirty_page_count(),
            0,
            "the file already has them; a second writeback could clobber a peer"
        );
    }

    #[test]
    fn a_reload_that_cannot_read_the_file_drops_the_stale_pages() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"ABCDEFGH".to_vec());
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(0, 8, &mut io)
            .unwrap();
        assert_eq!(table.file_backing(&key).unwrap().cached_page_count(), 1);

        io.files.remove(&10);
        assert!(
            !table.reload_backing(&key, None, &mut io),
            "a failed reload is reported, not swallowed"
        );
        assert_eq!(
            table.file_backing(&key).unwrap().cached_page_count(),
            0,
            "no page keeps bytes the file may no longer have"
        );
    }

    #[test]
    fn flushing_an_unreferenced_backing_persists_it_and_then_drops_it() {
        let mut io = MockIo::new().with_file(10, 1, 2, b"........".to_vec());
        let key = io.key_of(10);
        let mut table = SharedMappingTable::new();
        let stat = io.stat_of(10);
        {
            let backing = table
                .get_or_create_file_backing(&key, &stat, true, &mut io)
                .unwrap();
            assert_eq!(backing.ref_count, 0, "no mapping ever took a reference");
        }
        table
            .file_backing_mut(&key)
            .unwrap()
            .write_range(0, b"DIRTY", true, &mut io)
            .unwrap();

        assert!(table.flush_backing(&key, &mut io).unwrap());
        assert_eq!(io.files[&10], b"DIRTY...".to_vec(), "dirty bytes reached the file");
        assert!(table.file_backing(&key).is_none(), "and the backing was dropped");
    }

    #[test]
    fn a_ranged_reload_leaves_pages_outside_the_written_range_alone() {
        let big = alloc::vec![b'A'; FILE_PAGE_SIZE * 2];
        let mut io = MockIo::new().with_file(10, 1, 2, big);
        let key = io.key_of(10);
        let mut table = single_file_backing(&mut io, &key);
        table
            .file_backing_mut(&key)
            .unwrap()
            .ensure_range_loaded(0, FILE_PAGE_SIZE * 2, &mut io)
            .unwrap();
        assert_eq!(table.file_backing(&key).unwrap().cached_page_count(), 2);

        // A write lands entirely in page 1.
        let mut updated = alloc::vec![b'A'; FILE_PAGE_SIZE * 2];
        updated[FILE_PAGE_SIZE] = b'Z';
        io.files.insert(10, updated);
        assert!(table
            .file_backing_mut(&key)
            .unwrap()
            .reload_range(FILE_PAGE_SIZE as u64, 1, &mut io));

        let page1 = table
            .file_backing_mut(&key)
            .unwrap()
            .read_range(FILE_PAGE_SIZE as u64, 1, &mut io)
            .unwrap();
        assert_eq!(page1, alloc::vec![b'Z'], "the named page was re-read");
        assert_eq!(
            table.file_backing(&key).unwrap().cached_page_count(),
            2,
            "page 0 stayed resident rather than being swept out"
        );
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
        table.flush_mappings(1, 0, 64, &mut io).unwrap();
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

        table.cleanup_mappings(1, 0, 8, &mut io).unwrap();
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
        table.flush_mappings(1, 0, 64, &mut io).unwrap();

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
        table.cleanup_mappings(1, 4, 4, &mut io).unwrap();

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
