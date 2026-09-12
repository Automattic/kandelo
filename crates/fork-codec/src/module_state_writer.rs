//! Writer for the fork module-state (KFMS) chunk list — the inverse of
//! [`crate::module_state`]'s decoder.
//!
//! # Why this exists as a sibling rather than as host code
//!
//! Every other fork wire format has its encoder beside its decoder:
//! `linked_frames` / `linked_frames_writer`, `reference_segments` /
//! `reference_segments_writer`, `dylink_archive` / `dylink_archive_encode`.
//! KFMS had only a decoder, and the write half lived in the host. One format
//! implemented in two languages is how the two drift, so this closes the gap
//! the same way the others are closed: one format, two directions, one crate.
//!
//! The decoder validates the structural envelope and treats payloads as opaque;
//! so does this. Callers supply payload bytes and a record kind.
//!
//! # Not an arena
//!
//! The structure is a doubly-linked run of page-rounded chunks, each obtained
//! from a [`ChunkAllocator`] — in production a `SYS_MMAP` through the guest
//! syscall channel, placed by the kernel. There is no fixed region and no cap.
//! The `ARENA_VERSION` constant keeps its ABI spelling; the prose does not.
//!
//! # The contract, restated from the decoder so the two cannot drift silently
//!
//! * chunk headers are written SEALED from the start (the decoder requires
//!   `CHUNK_FLAG_SEALED` on every chunk, and `CHUNK_FLAG_ROOT` on the first);
//! * every chunk records the same `root` and its own `previous`, so the chain
//!   is verifiable from either end;
//! * a NON-root chunk must carry at least one record — the decoder rejects
//!   `used == header || record_count == 0` — so a chunk is only allocated when
//!   a record is ready to go in it, never speculatively;
//! * `total_size` is `align_up(header + payload, RECORD_ALIGNMENT)` and the
//!   padding after the payload must be ZERO, as must the chunk-header trailer.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use crate::linked_frames_writer::ChunkAllocator;
use crate::module_state::ModuleStateFormat;

const PAGE_SIZE: u64 = 65_536;
const RECORD_ALIGNMENT: u64 = abi::WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT as u64;
const RECORD_HEADER_SIZE: u64 = abi::WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE as u64;
const CHUNK_MAGIC: u32 = 0x434d_464b; // "KFMC"
const RECORD_MAGIC: u32 = 0x524d_464b; // "KFMR"

fn align_up(value: u64, align: u64) -> Result<u64, Errno> {
    let bump = value.checked_add(align - 1).ok_or(Errno::EINVAL)?;
    Ok(bump & !(align - 1))
}

fn checked_end(addr: u64, size: u64) -> Result<u64, Errno> {
    addr.checked_add(size).ok_or(Errno::EINVAL)
}

fn slot(mem: &mut [u8], off: u64, len: u64) -> Result<&mut [u8], Errno> {
    let start = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = usize::try_from(checked_end(off, len)?).map_err(|_| Errno::EINVAL)?;
    mem.get_mut(start..end).ok_or(Errno::EINVAL)
}

fn w_u16(mem: &mut [u8], off: u64, value: u16) -> Result<(), Errno> {
    slot(mem, off, 2)?.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn w_u32(mem: &mut [u8], off: u64, value: u32) -> Result<(), Errno> {
    slot(mem, off, 4)?.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn w_ptr(mem: &mut [u8], off: u64, value: u64, width: u8) -> Result<(), Errno> {
    match width {
        4 => {
            let narrow = u32::try_from(value).map_err(|_| Errno::EINVAL)?;
            w_u32(mem, off, narrow)
        }
        8 => {
            slot(mem, off, 8)?.copy_from_slice(&value.to_le_bytes());
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

fn r_ptr(mem: &[u8], off: u64, width: u8) -> Result<u64, Errno> {
    let start = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    match width {
        4 => {
            let raw = mem.get(start..start + 4).ok_or(Errno::EINVAL)?;
            Ok(u32::from_le_bytes(raw.try_into().map_err(|_| Errno::EINVAL)?) as u64)
        }
        8 => {
            let raw = mem.get(start..start + 8).ok_or(Errno::EINVAL)?;
            Ok(u64::from_le_bytes(raw.try_into().map_err(|_| Errno::EINVAL)?))
        }
        _ => Err(Errno::EINVAL),
    }
}

fn r_u32(mem: &[u8], off: u64) -> Result<u32, Errno> {
    let start = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let raw = mem.get(start..start + 4).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes(raw.try_into().map_err(|_| Errno::EINVAL)?))
}

/// Field `index` of the pointer-sized run that starts at chunk offset 8.
fn chunk_field(index: u64, pw: u64) -> u64 {
    8 + index * pw
}

/// Writes KFMS records into a linked chunk list.
pub struct ModuleStateWriter {
    format: ModuleStateFormat,
    root: u64,
    tail: u64,
    /// Payload address and total size of a reserved-but-uncommitted record.
    /// At most one is open: the guest reserves, fills, then commits.
    pending: Option<(u64, u64)>,
}

impl ModuleStateWriter {
    pub fn new(format: ModuleStateFormat) -> Self {
        ModuleStateWriter { format, root: 0, tail: 0, pending: None }
    }

    /// The root chunk address, or 0 before the first record is reserved. This
    /// is the value a child decodes from.
    pub fn root(&self) -> u64 {
        self.root
    }

    /// Reserve `payload_size` bytes for a record and return the PAYLOAD
    /// address. The record is not visible to a decoder until [`commit`].
    ///
    /// [`commit`]: ModuleStateWriter::commit
    pub fn reserve<A: ChunkAllocator>(
        &mut self,
        alloc: &mut A,
        mem: &mut [u8],
        kind: u16,
        activation_id: u32,
        owner_id: u32,
        payload_size: u64,
    ) -> Result<u64, Errno> {
        if self.pending.is_some() {
            // One record at a time: a second reserve would hand out a range
            // overlapping a live one, which a decoder cannot detect.
            return Err(Errno::EINVAL);
        }
        let pw = self.format.pointer_width as u64;
        let header = self.format.chunk_header_size as u64;
        let total = align_up(checked_end(RECORD_HEADER_SIZE, payload_size)?, RECORD_ALIGNMENT)?;

        let chunk = self.chunk_with_room(alloc, mem, total, header, pw)?;
        let used = r_ptr(mem, chunk + chunk_field(4, pw), self.format.pointer_width)?;
        let addr = checked_end(chunk, used)?;

        w_u32(mem, addr, RECORD_MAGIC)?;
        w_u16(mem, addr + 4, abi::WPK_FORK_MODULE_STATE_RECORD_VERSION)?;
        w_u16(mem, addr + 6, kind)?;
        w_u32(mem, addr + 8, u32::try_from(total).map_err(|_| Errno::EINVAL)?)?;
        w_u32(mem, addr + 12, u32::try_from(payload_size).map_err(|_| Errno::EINVAL)?)?;
        w_u32(mem, addr + 16, activation_id)?;
        w_u32(mem, addr + 20, owner_id)?;

        // The decoder rejects a non-zero alignment tail, so clear it now rather
        // than trusting whatever the mapping happened to contain.
        let payload = checked_end(addr, RECORD_HEADER_SIZE)?;
        let pad_start = checked_end(payload, payload_size)?;
        let pad_len = checked_end(addr, total)? - pad_start;
        if pad_len > 0 {
            slot(mem, pad_start, pad_len)?.fill(0);
        }

        self.pending = Some((payload, total));
        Ok(payload)
    }

    /// Publish the reserved record: advance the chunk's `used` and record count
    /// so a decoder walking the chain now sees it.
    pub fn commit(&mut self, mem: &mut [u8], payload: u64) -> Result<(), Errno> {
        let (expected, total) = self.pending.ok_or(Errno::EINVAL)?;
        if payload != expected {
            return Err(Errno::EINVAL);
        }
        let p = self.format.pointer_width;
        let pw = p as u64;
        let chunk = self.tail;
        let used = r_ptr(mem, chunk + chunk_field(4, pw), p)?;
        let count = r_u32(mem, chunk + 8 + 5 * pw)?;
        w_ptr(mem, chunk + chunk_field(4, pw), checked_end(used, total)?, p)?;
        w_u32(mem, chunk + 8 + 5 * pw, count.checked_add(1).ok_or(Errno::EINVAL)?)?;
        self.pending = None;
        Ok(())
    }

    /// The tail chunk if `total` fits in it, otherwise a freshly allocated one
    /// linked onto the chain.
    fn chunk_with_room<A: ChunkAllocator>(
        &mut self,
        alloc: &mut A,
        mem: &mut [u8],
        total: u64,
        header: u64,
        pw: u64,
    ) -> Result<u64, Errno> {
        let p = self.format.pointer_width;
        if self.tail != 0 {
            let capacity = r_ptr(mem, self.tail + chunk_field(3, pw), p)?;
            let used = r_ptr(mem, self.tail + chunk_field(4, pw), p)?;
            if checked_end(used, total)? <= capacity {
                return Ok(self.tail);
            }
        }
        let capacity = align_up(checked_end(header, total)?, PAGE_SIZE)?;
        let addr = alloc.allocate(capacity)?;
        if addr == 0 || !addr.is_multiple_of(PAGE_SIZE) {
            return Err(Errno::EINVAL);
        }
        let is_root = self.root == 0;
        let root = if is_root { addr } else { self.root };
        let previous = self.tail;

        let flags = abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED
            | if is_root { abi::WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT } else { 0 };
        // Zero the whole header first: the decoder requires the trailer between
        // the reserved word and `chunk_header_size` to be zero, and a fresh
        // mapping is not guaranteed to be.
        slot(mem, addr, header)?.fill(0);
        w_u32(mem, addr, CHUNK_MAGIC)?;
        w_u16(mem, addr + 4, abi::WPK_FORK_MODULE_STATE_ARENA_VERSION)?;
        w_u16(mem, addr + 6, flags)?;
        w_ptr(mem, addr + chunk_field(0, pw), root, p)?;
        w_ptr(mem, addr + chunk_field(1, pw), previous, p)?;
        w_ptr(mem, addr + chunk_field(2, pw), 0, p)?;
        w_ptr(mem, addr + chunk_field(3, pw), capacity, p)?;
        w_ptr(mem, addr + chunk_field(4, pw), header, p)?;
        w_u32(mem, addr + 8 + 5 * pw, 0)?;

        if previous != 0 {
            w_ptr(mem, previous + chunk_field(2, pw), addr, p)?;
        }
        if is_root {
            self.root = addr;
        }
        self.tail = addr;
        Ok(addr)
    }
}

#[cfg(test)]
mod tests {
    //! The writer is only correct if the DECODER accepts what it produces, so
    //! every test here round-trips: write records, then `decode_module_state`
    //! the same bytes and assert on what comes back. Asserting on the writer's
    //! own view would only prove it agrees with itself.

    use super::*;
    use crate::module_state::decode_module_state;
    use alloc::vec;
    use alloc::vec::Vec;

    const KIND_GLOBAL: u16 = abi::WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL;
    const KIND_TABLE: u16 = abi::WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE;

    /// Hands out page-aligned addresses from a fixed test memory, mimicking the
    /// production channel allocator's page-rounded placement without a kernel.
    struct TestChunks {
        next: u64,
        limit: u64,
    }

    impl ChunkAllocator for TestChunks {
        fn allocate(&mut self, capacity: u64) -> Result<u64, Errno> {
            let addr = self.next;
            let end = addr.checked_add(capacity).ok_or(Errno::ENOMEM)?;
            if end > self.limit {
                return Err(Errno::ENOMEM);
            }
            self.next = end;
            Ok(addr)
        }
    }

    fn fixture() -> (Vec<u8>, TestChunks, ModuleStateWriter) {
        let format = ModuleStateFormat { pointer_width: 4, chunk_header_size: 40 };
        let mem = vec![0u8; (PAGE_SIZE * 8) as usize];
        // Start at page 1: address 0 is never a valid chunk.
        let alloc = TestChunks { next: PAGE_SIZE, limit: PAGE_SIZE * 8 };
        (mem, alloc, ModuleStateWriter::new(format))
    }

    fn format() -> ModuleStateFormat {
        ModuleStateFormat { pointer_width: 4, chunk_header_size: 40 }
    }

    #[test]
    fn one_record_round_trips_through_the_decoder() {
        let (mut mem, mut alloc, mut w) = fixture();
        let payload = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 7, 9, 12).unwrap();
        mem[payload as usize..payload as usize + 12].copy_from_slice(b"twelve bytes");
        w.commit(&mut mem, payload).unwrap();

        let state = decode_module_state(&mem, w.root(), &format()).unwrap();
        assert_eq!(state.records.len(), 1);
        let r = state.records[0];
        assert_eq!(r.kind, KIND_GLOBAL);
        assert_eq!(r.activation_id, 7);
        assert_eq!(r.owner_id, 9);
        assert_eq!(r.payload_size, 12);
        assert_eq!(&mem[r.payload_offset as usize..][..12], b"twelve bytes");
    }

    #[test]
    fn an_uncommitted_record_is_invisible() {
        let (mut mem, mut alloc, mut w) = fixture();
        let a = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 8).unwrap();
        w.commit(&mut mem, a).unwrap();
        // Reserve a second and DO NOT commit it.
        w.reserve(&mut alloc, &mut mem, KIND_TABLE, 2, 2, 8).unwrap();

        let state = decode_module_state(&mem, w.root(), &format()).unwrap();
        assert_eq!(
            state.records.len(),
            1,
            "a reserved-but-uncommitted record must not be visible to a decoder",
        );
    }

    #[test]
    fn records_spill_into_a_linked_chunk_and_the_chain_decodes() {
        let (mut mem, mut alloc, mut w) = fixture();
        // Each payload is a quarter page, so the fifth cannot fit beside the
        // first four in a one-page chunk and must start a new one.
        let big = PAGE_SIZE / 4;
        for i in 0..5u32 {
            let p = w
                .reserve(&mut alloc, &mut mem, KIND_TABLE, i, i, big)
                .unwrap();
            w.commit(&mut mem, p).unwrap();
        }
        let state = decode_module_state(&mem, w.root(), &format()).unwrap();
        assert_eq!(state.records.len(), 5, "every record survives the spill");
        assert!(state.chunks.len() >= 2, "the list actually grew a chunk");
        assert_eq!(state.chunks[0].previous, 0, "the root has no previous");
        assert_eq!(
            state.chunks[1].previous, state.chunks[0].addr,
            "each chunk links back to the one before it",
        );
        for (i, r) in state.records.iter().enumerate() {
            assert_eq!(r.activation_id, i as u32, "records keep their order");
        }
    }

    #[test]
    fn a_payload_needing_more_than_a_page_gets_a_chunk_sized_to_fit() {
        let (mut mem, mut alloc, mut w) = fixture();
        let huge = PAGE_SIZE + 1024;
        let p = w.reserve(&mut alloc, &mut mem, KIND_TABLE, 3, 4, huge).unwrap();
        w.commit(&mut mem, p).unwrap();
        let state = decode_module_state(&mem, w.root(), &format()).unwrap();
        assert_eq!(state.records[0].payload_size, huge);
        assert!(
            state.chunks[0].capacity >= huge + 40,
            "the chunk is sized to the record, not to one page",
        );
    }

    #[test]
    fn two_open_reservations_are_refused() {
        let (mut mem, mut alloc, mut w) = fixture();
        w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 8).unwrap();
        assert_eq!(
            w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 2, 8),
            Err(Errno::EINVAL),
            "a second open reservation would overlap a live one",
        );
    }

    #[test]
    fn committing_the_wrong_address_is_refused() {
        let (mut mem, mut alloc, mut w) = fixture();
        let p = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 8).unwrap();
        assert_eq!(w.commit(&mut mem, p + 8), Err(Errno::EINVAL));
        assert_eq!(w.commit(&mut mem, p), Ok(()), "the right address still works");
    }

    #[test]
    fn an_unaligned_payload_leaves_zero_padding() {
        // The decoder rejects a non-zero alignment tail. A fresh mapping is not
        // guaranteed to be zero, so poison the memory first and prove the
        // writer clears what it must.
        let format = format();
        let mut mem = vec![0xABu8; (PAGE_SIZE * 4) as usize];
        let mut alloc = TestChunks { next: PAGE_SIZE, limit: PAGE_SIZE * 4 };
        let mut w = ModuleStateWriter::new(format);
        let p = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 5).unwrap();
        mem[p as usize..p as usize + 5].copy_from_slice(b"five!");
        w.commit(&mut mem, p).unwrap();
        let state = decode_module_state(&mem, w.root(), &format).unwrap();
        assert_eq!(state.records[0].payload_size, 5);
    }
}
