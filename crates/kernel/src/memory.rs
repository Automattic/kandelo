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
    /// List of active mappings.
    mappings: Vec<MappedRegion>,
    /// Next available address for mmap allocations.
    /// Starts high in the address space to avoid conflicts with stack/heap.
    next_mmap_addr: u32,
    /// Current program break (for brk).
    program_break: u32,
}

impl MemoryManager {
    /// Default mmap region starts at 256MB (0x10000000).
    /// This leaves plenty of room for stack and heap below.
    const MMAP_BASE: u32 = 0x10000000;

    /// Default initial program break at 16MB.
    const INITIAL_BRK: u32 = 0x01000000;

    pub fn new() -> Self {
        MemoryManager {
            mappings: Vec::new(),
            next_mmap_addr: Self::MMAP_BASE,
            program_break: Self::INITIAL_BRK,
        }
    }

    /// Allocate an anonymous mapping. Returns the base address.
    pub fn mmap_anonymous(&mut self, len: u32, prot: u32, flags: u32) -> u32 {
        if len == 0 {
            return wasm_posix_shared::mmap::MAP_FAILED;
        }

        // Align to page boundary (Wasm page = 64KB)
        let aligned_len = (len + 0xFFFF) & !0xFFFF;

        let addr = self.next_mmap_addr;
        self.next_mmap_addr += aligned_len;

        self.mappings.push(MappedRegion {
            addr,
            len: aligned_len,
            prot,
            flags,
        });

        addr
    }

    /// Unmap a region. Returns true if the region was found and removed.
    pub fn munmap(&mut self, addr: u32, len: u32) -> bool {
        let before = self.mappings.len();
        self.mappings.retain(|m| !(m.addr == addr && m.len >= len));
        self.mappings.len() < before
    }

    /// Get the current program break.
    pub fn get_brk(&self) -> u32 {
        self.program_break
    }

    /// Set the program break. Returns the new break on success, or 0 on failure.
    pub fn set_brk(&mut self, new_brk: u32) -> u32 {
        if new_brk == 0 {
            // Query current break
            return self.program_break;
        }
        // In Wasm, we can't actually enforce memory boundaries, but we track it
        self.program_break = new_brk;
        new_brk
    }

    /// Check if an address is in a mapped region.
    pub fn is_mapped(&self, addr: u32) -> bool {
        self.mappings.iter().any(|m| addr >= m.addr && addr < m.addr + m.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::mmap::*;

    #[test]
    fn test_mmap_anonymous() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_ne!(addr, MAP_FAILED);
        assert!(mm.is_mapped(addr));
    }

    #[test]
    fn test_mmap_zero_length_fails() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(0, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_eq!(addr, MAP_FAILED);
    }

    #[test]
    fn test_mmap_aligns_to_page() {
        let mut mm = MemoryManager::new();
        let addr1 = mm.mmap_anonymous(1, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        let addr2 = mm.mmap_anonymous(1, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // Each allocation should be at least 64KB apart (Wasm page size)
        assert_eq!(addr2 - addr1, 0x10000);
    }

    #[test]
    fn test_munmap() {
        let mut mm = MemoryManager::new();
        let addr = mm.mmap_anonymous(4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
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
        let addr1 = mm.mmap_anonymous(0x20000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        let addr2 = mm.mmap_anonymous(0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert!(addr2 >= addr1 + 0x20000); // Non-overlapping
        assert!(mm.is_mapped(addr1));
        assert!(mm.is_mapped(addr2));
    }
}
