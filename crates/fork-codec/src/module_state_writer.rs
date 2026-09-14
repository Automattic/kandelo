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
    /// True when `root` came from [`adopt`] rather than from a reserve here.
    ///
    /// An adopted arena belongs to another process: a fork child inherits the
    /// parent's records and reads them, and the chunks behind them were mapped
    /// by the parent. Writing into one would append to a list this writer did
    /// not build and cannot free, so [`reserve`] refuses while this is set.
    ///
    /// [`adopt`]: ModuleStateWriter::adopt
    /// [`reserve`]: ModuleStateWriter::reserve
    adopted: bool,
}

impl ModuleStateWriter {
    pub fn new(format: ModuleStateFormat) -> Self {
        ModuleStateWriter { format, root: 0, tail: 0, pending: None, adopted: false }
    }

    /// Adopt an arena rooted at `root` that some other process built.
    ///
    /// Without this a fork child's writer keeps `root == 0`, because `root` is
    /// only ever assigned by `reserve` and a child never reserves -- so every
    /// lookup against the inherited arena misses and reads as "no such record".
    /// The parent's root IS known during replay, but only as an argument
    /// threaded through the entry points; nothing carried it to the writer.
    /// Census section 128 recorded that as a dormant asymmetry. This is the
    /// setter it said was missing.
    ///
    /// Refuses an arena this writer is already building or has already adopted:
    /// overwriting `root` would strand the chunks it has mapped and leave a
    /// decoder two roots for one list. Refuses `0` for the same reason the
    /// field starts there -- 0 means "no arena", not "the arena at zero".
    pub fn adopt(&mut self, root: u64) -> Result<(), Errno> {
        if root == 0 || self.root != 0 || self.pending.is_some() {
            return Err(Errno::EINVAL);
        }
        self.root = root;
        self.tail = root;
        self.adopted = true;
        Ok(())
    }

    /// Whether `root` was adopted from another process rather than built here.
    pub fn is_adopted(&self) -> bool {
        self.adopted
    }

    /// Create the arena's root chunk NOW instead of on the first record.
    ///
    /// `reserve` already makes a root lazily, so nothing about the wire format
    /// needs this. What needs it is the ORDER of a capture: the arena root has
    /// to be published into each activation's module-buffer prefix before any
    /// guest starts unwinding, and that happens before any record exists. The
    /// host used to allocate that first chunk itself and hand the address in,
    /// which is the half of the arena ownership split census section 133 found
    /// -- host maps chunk one, module maps the rest, host frees them all by
    /// walking the list back out of guest memory. Moving the allocation here is
    /// what lets the module own the whole list and free exactly what it mapped.
    ///
    /// Refuses an arena that already exists, adopted or built: a second root
    /// abandons the first with no handle left to free it.
    pub fn begin<A: ChunkAllocator>(
        &mut self,
        alloc: &mut A,
        mem: &mut [u8],
    ) -> Result<u64, Errno> {
        if self.root != 0 {
            return Err(Errno::EINVAL);
        }
        let pw = self.format.pointer_width as u64;
        let header = self.format.chunk_header_size as u64;
        // `total = 0` asks for a chunk with no record in it; the capacity still
        // rounds up to a whole page, matching what the host allocator did.
        self.chunk_with_room(alloc, mem, 0, header, pw)
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
        if self.adopted {
            // The arena belongs to the process that built it. Appending here
            // would write into chunks this writer did not map, cannot free, and
            // may not even still own -- the parent is parked, not gone.
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

    // -- adopt: the child half of the arena (census sections 128 and 133) ----

    #[test]
    fn begin_creates_a_root_the_decoder_accepts_while_empty() {
        // The capture publishes the arena root before any record exists, so an
        // empty arena has to be a valid one -- not merely a chunk that becomes
        // valid once something is written into it.
        let (mut mem, mut alloc, mut w) = fixture();
        let root = w.begin(&mut alloc, &mut mem).unwrap();
        assert_ne!(root, 0);
        assert_eq!(w.root(), root);
        assert!(!w.is_adopted());
        let state = decode_module_state(&mem, root, &format()).unwrap();
        assert_eq!(state.records.len(), 0);
    }

    #[test]
    fn a_record_written_after_begin_lands_in_the_root_chunk() {
        // begin must not leave the writer in a state where the first reserve
        // starts a SECOND chunk -- that would be two chunks for what the host
        // allocated as one, and the seal-time identity check the host arena
        // does would reject the difference.
        let (mut mem, mut alloc, mut w) = fixture();
        let root = w.begin(&mut alloc, &mut mem).unwrap();
        let payload = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 2, 5, 4).unwrap();
        w.commit(&mut mem, payload).unwrap();
        assert_eq!(w.root(), root, "the record did not move the root");
        let state = decode_module_state(&mem, root, &format()).unwrap();
        assert_eq!(state.records.len(), 1);
        assert_eq!(state.records[0].owner_id, 5);
    }

    #[test]
    fn begin_refuses_an_arena_that_already_exists() {
        // Either way it exists -- built here or adopted -- a second root
        // abandons the first, and the only handle on the first chunk's mapping
        // is the root that just got overwritten.
        let (mut mem, mut alloc, mut w) = fixture();
        let root = w.begin(&mut alloc, &mut mem).unwrap();
        assert_eq!(w.begin(&mut alloc, &mut mem), Err(Errno::EINVAL));
        assert_eq!(w.root(), root);

        let mut adopted = ModuleStateWriter::new(format());
        adopted.adopt(0x4000).unwrap();
        assert_eq!(adopted.begin(&mut alloc, &mut mem), Err(Errno::EINVAL));
        assert_eq!(adopted.root(), 0x4000);
    }

    #[test]
    fn an_adopted_root_is_what_lookups_answer_from() {
        // The gap this closes: a child never reserves, so without `adopt` its
        // writer keeps root == 0 and every lookup against the arena it
        // INHERITED misses -- reading as "no such record" rather than as an
        // error, which is the failure mode that stayed dormant for so long.
        let (mut mem, mut alloc, mut parent) = fixture();
        let payload = parent
            .reserve(&mut alloc, &mut mem, KIND_GLOBAL, 3, 4, 8)
            .unwrap();
        mem[payload as usize..payload as usize + 8].copy_from_slice(b"inherits");
        parent.commit(&mut mem, payload).unwrap();

        let mut child = ModuleStateWriter::new(format());
        assert_eq!(child.root(), 0, "a fresh writer has no arena");
        child.adopt(parent.root()).unwrap();
        assert_eq!(child.root(), parent.root());
        assert!(child.is_adopted());

        // And the records really are readable through the child's root.
        let state = decode_module_state(&mem, child.root(), &format()).unwrap();
        assert_eq!(state.records.len(), 1);
        assert_eq!(&mem[state.records[0].payload_offset as usize..][..8], b"inherits");
    }

    #[test]
    fn an_adopted_arena_refuses_to_be_written() {
        // The arena belongs to the process that built it, and for a vfork child
        // that process is PARKED, not gone -- its chunks are live in shared
        // memory. Appending here would write into chunks this writer did not
        // map and cannot free.
        let (mut mem, mut alloc, mut parent) = fixture();
        let payload = parent
            .reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 4)
            .unwrap();
        parent.commit(&mut mem, payload).unwrap();

        let mut child = ModuleStateWriter::new(format());
        child.adopt(parent.root()).unwrap();
        assert_eq!(
            child.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 2, 4),
            Err(Errno::EINVAL),
        );
        // The refusal must leave the adoption intact: a writer that dropped its
        // root here would send the child back to the silent-miss behaviour the
        // first test exists to prevent.
        assert_eq!(child.root(), parent.root());
    }

    #[test]
    fn adopt_refuses_to_strand_an_arena_this_writer_is_building() {
        // Overwriting a live root abandons every chunk already mapped under it
        // -- unfreeable, because the only handle on them is the list the root
        // starts. Nothing downstream can detect that; it just leaks.
        let (mut mem, mut alloc, mut w) = fixture();
        let payload = w.reserve(&mut alloc, &mut mem, KIND_GLOBAL, 1, 1, 4).unwrap();
        w.commit(&mut mem, payload).unwrap();
        let own = w.root();
        assert_eq!(w.adopt(0x9000), Err(Errno::EINVAL));
        assert_eq!(w.root(), own, "the refusal kept the writer's own arena");
        assert!(!w.is_adopted());
    }

    #[test]
    fn adopt_refuses_zero_and_a_second_adoption() {
        let mut w = ModuleStateWriter::new(format());
        // 0 is the "no arena" sentinel `root()` starts at, not an address.
        assert_eq!(w.adopt(0), Err(Errno::EINVAL));
        assert_eq!(w.root(), 0);
        w.adopt(0x4000).unwrap();
        // A second adoption is the same stranding problem from the other side:
        // two roots for one writer, and the first one silently forgotten.
        assert_eq!(w.adopt(0x8000), Err(Errno::EINVAL));
        assert_eq!(w.root(), 0x4000);
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
