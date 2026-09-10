//! Address-space and table placement arithmetic.
//!
//! Ports the placement half of `instantiateSharedLibrarySteps`
//! (`host/src/dylink.ts:1481-1590`, `:1965-2065`): memory-base selection, table
//! base and growth, and the TLS-range validation.
//!
//! All arithmetic is checked. The TypeScript relied on `Number.isSafeInteger`
//! tests at roughly thirty call sites to notice an overflow after the fact;
//! here an overflow cannot be constructed.

use alloc::string::String;

use fork_codec::dylink_archive::DylinkAllocation;

use crate::error::{DylinkError, DylinkResult};

/// Align `value` up to `align`, which must be a power of two.
pub fn align_up(value: u64, align: u64) -> DylinkResult<u64> {
    if align == 0 || !align.is_power_of_two() {
        return Err(DylinkError::MalformedDylinkSection("alignment is not a power of two"));
    }
    value
        .checked_add(align - 1)
        .map(|sum| sum & !(align - 1))
        .ok_or(DylinkError::MalformedDylinkSection("alignment overflow"))
}

/// How a side module's data region is placed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoryPlacement {
    /// No data region at all.
    None,
    /// Ask the process allocator (a synchronous `SYS_MMAP` in a process
    /// worker). Every SDK-built guest that can call `dlopen` takes this path.
    Allocate { size: u64, align: u64 },
    /// Bump a host-held heap pointer and grow linear memory to match. Used only
    /// by standalone linker tests and non-POSIX embedders, which supply no
    /// allocator.
    BumpHeap { base: u64, end: u64, grow_pages: u64 },
    /// Reuse the fork parent's exact base. Data relocations baked into the
    /// copied data section already encode `(parent_base + offset)`, so any
    /// other base corrupts every pointer in the module.
    Replay { base: u64 },
}

/// Choose where a side module's data goes.
pub fn plan_memory(
    library: &str,
    memory_size: u64,
    memory_align: u64,
    replay_base: Option<u64>,
    has_allocator: bool,
    heap_pointer: Option<u64>,
    memory_bytes: u64,
) -> DylinkResult<MemoryPlacement> {
    if memory_size == 0 {
        return Ok(MemoryPlacement::None);
    }
    if let Some(base) = replay_base {
        return Ok(MemoryPlacement::Replay { base });
    }
    if has_allocator {
        return Ok(MemoryPlacement::Allocate { size: memory_size, align: memory_align });
    }
    let Some(heap) = heap_pointer else {
        return Err(DylinkError::AllocatorUnavailable { library: String::from(library) });
    };
    let base = align_up(heap, memory_align)?;
    let end = base
        .checked_add(memory_size)
        .ok_or(DylinkError::AllocationEscapesMemory { library: String::from(library) })?;
    const PAGE: u64 = 65_536;
    let needed_pages = end.div_ceil(PAGE);
    let current_pages = memory_bytes / PAGE;
    let grow_pages = needed_pages.saturating_sub(current_pages);
    Ok(MemoryPlacement::BumpHeap { base, end, grow_pages })
}

/// Verify an allocator result stays inside linear memory.
pub fn check_allocation(library: &str, base: u64, size: u64, memory_bytes: u64) -> DylinkResult<()> {
    let end = base
        .checked_add(size)
        .ok_or(DylinkError::AllocationEscapesMemory { library: String::from(library) })?;
    if end > memory_bytes {
        return Err(DylinkError::AllocationEscapesMemory { library: String::from(library) });
    }
    Ok(())
}

/// Validate the mapping ownership a fork child adopts from its parent.
///
/// The child's linear memory and kernel mmap map were copied, but its worker
/// has fresh host-side bookkeeping. These recipes reconnect the two without
/// issuing a second `mmap` or guessing the allocator's alignment padding.
pub fn check_archived_allocations(
    library: &str,
    allocations: &[DylinkAllocation],
    memory_base: u64,
    memory_size: u64,
    memory_bytes: u64,
    allocator_adopts: bool,
) -> DylinkResult<()> {
    if !allocations.is_empty()
        && (allocations.len() != 1
            || allocations[0].address != memory_base
            || allocations[0].size != memory_size)
    {
        return Err(DylinkError::ArchivedAllocationMismatch { library: String::from(library) });
    }
    if allocator_adopts && allocations.is_empty() {
        return Err(DylinkError::MissingMappingOwnership { library: String::from(library) });
    }
    for allocation in allocations {
        let end = allocation
            .mapping_address
            .checked_add(allocation.mapping_size)
            .ok_or(DylinkError::ArchivedMappingEscapesMemory { library: String::from(library) })?;
        if end > memory_bytes {
            return Err(DylinkError::ArchivedMappingEscapesMemory {
                library: String::from(library),
            });
        }
        let logical_end = allocation
            .address
            .checked_add(allocation.size)
            .ok_or(DylinkError::ArchivedMappingEscapesMemory { library: String::from(library) })?;
        if allocation.address < allocation.mapping_address || logical_end > end {
            return Err(DylinkError::ArchivedMappingEscapesMemory {
                library: String::from(library),
            });
        }
    }
    Ok(())
}

/// How a side module's table slots are placed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TablePlacement {
    pub base: u64,
    /// Slots to grow before the module's own reservation, to reproduce a
    /// parent's exact base including gaps left by a failed `dlopen`.
    pub pad: u64,
    /// The module's own `dylink.0` table reservation.
    pub reserve: u64,
}

/// Choose the table base and growth.
///
/// A `WebAssembly.Table` cannot shrink, so a fork parent's successful archive
/// entries carry the next library's exact base and the child pads up to it. A
/// child whose table already grew past the parent's base cannot be reconciled
/// and says so.
pub fn plan_table(
    library: &str,
    current_length: u64,
    table_size: u64,
    replay_base: Option<u64>,
) -> DylinkResult<TablePlacement> {
    let (base, pad) = match replay_base {
        None => (current_length, 0),
        Some(parent) => {
            if parent > u64::from(u32::MAX) {
                return Err(DylinkError::InvalidReplayTableBase {
                    library: String::from(library),
                });
            }
            if current_length > parent {
                return Err(DylinkError::ReplayTablePastBase {
                    library: String::from(library),
                    current: current_length,
                    parent,
                });
            }
            (parent, parent - current_length)
        }
    };
    Ok(TablePlacement { base, pad, reserve: table_size })
}

/// A validated thread-local-storage region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TlsRegion {
    pub base: u64,
    pub size: u64,
    pub align: u64,
}

/// Validate a side module's TLS region against its own memory reservation.
///
/// Address zero is reserved as the archive's explicit "no TLS" sentinel: a real
/// allocation cannot live there because the process allocator always returns a
/// positive address and the null page must stay invalid.
pub fn check_tls(
    library: &str,
    base: u64,
    size: u64,
    align: u64,
    memory_base: u64,
    memory_size: u64,
    memory_bytes: u64,
) -> DylinkResult<TlsRegion> {
    if align == 0 || !align.is_power_of_two() {
        return Err(DylinkError::InvalidTlsAlign { library: String::from(library) });
    }
    if base == 0 {
        return Err(DylinkError::InvalidTlsBase { library: String::from(library) });
    }
    if base % align != 0 {
        return Err(DylinkError::MisalignedTlsBase { library: String::from(library) });
    }
    let end = base
        .checked_add(size)
        .ok_or(DylinkError::TlsEscapesReservation { library: String::from(library) })?;
    let module_end = memory_base
        .checked_add(memory_size)
        .ok_or(DylinkError::TlsEscapesReservation { library: String::from(library) })?;
    if base < memory_base || end > module_end || end > memory_bytes {
        return Err(DylinkError::TlsEscapesReservation { library: String::from(library) });
    }
    Ok(TlsRegion { base, size, align })
}
