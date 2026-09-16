//! Resumable walk over a KFLA archive whose bytes must be fetched one range at
//! a time.
//!
//! [`super::decode_dylink_archive`] wants random access to the whole image. The
//! standalone planner module cannot give it that: it imports nothing, so guest
//! linear memory — where every archive record lives — is unreachable from
//! inside it. What it *can* do is answer a question of the form "give me
//! `length` bytes at `address`" through whatever request/response channel its
//! host already speaks.
//!
//! [`ArchiveWalk`] turns the archive into exactly that sequence of questions.
//! It knows where a record starts because the previous record's `next` pointer
//! said so, and how far it extends because the record's own fixed header
//! declares its name, module-bytes, provider-blob, allocation, and run counts.
//! It therefore asks for a record's fixed header first, and only then for the
//! remainder, because the remainder's size is not knowable until the header has
//! been read.
//!
//! The walker decides *which* bytes to fetch and nothing else. The bytes it
//! collects are handed to the one existing decoder over a [`SparseArchive`]
//! view, so there is no second reader of the KFLA format to drift from the
//! first. Every size computation here is deliberately the same arithmetic
//! `read_module` / `read_transaction` / `read_table_patch` and the encoder's
//! `*_record_size` functions use, including the transaction record's
//! *unpadded* trailing module bytes.
//!
//! Hostile input is expected: the archive is written by the forking process
//! into its own memory, and the bytes arriving here have already crossed a
//! process boundary. A cyclic or truncated chain, a chain longer than the
//! header declared, a record count no memory of this size could hold, and a
//! caller answering a range with the wrong number of bytes are all
//! `Err(Errno::EINVAL)`; none of them panic and none of them loop forever.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use super::{
    align8, checked_end, checked_range, r_u32, r_u64, ArchiveBytes, DylinkArchive,
    ARCHIVE_HEADER_SIZE, MODULE_ALLOCATION_SIZE, MODULE_HEADER_SIZE, TABLE_PATCH_HEADER_SIZE,
    TABLE_PATCH_RUN_SIZE, TRANSACTION_HEADER_SIZE,
};

/// The fetched fragments of an archive, addressed as if they were the guest
/// linear memory they were copied out of.
///
/// Blocks are keyed by their absolute guest address, which is what lets the
/// decoder keep following absolute pointers unchanged. A read must lie WHOLLY
/// inside one inserted block: two adjacent blocks are two separate answers from
/// the host, and stitching them together here would silently paper over a
/// caller that skipped a range or supplied a stale one.
#[derive(Debug, Clone)]
pub struct SparseArchive {
    blocks: BTreeMap<u64, Vec<u8>>,
    memory_len: u64,
}

impl SparseArchive {
    /// `memory_len` is the declared size of the guest linear memory the records
    /// were copied out of, not the number of bytes fetched. The decoder derives
    /// its physical-plausibility bounds from it, so a sparse view must report
    /// the same geometry a flat view of that memory would.
    pub fn new(memory_len: u64) -> Self {
        SparseArchive {
            blocks: BTreeMap::new(),
            memory_len,
        }
    }

    /// Record the bytes fetched from `address`.
    pub fn insert(&mut self, address: u64, bytes: Vec<u8>) {
        self.blocks.insert(address, bytes);
    }
}

impl ArchiveBytes for SparseArchive {
    fn len(&self) -> u64 {
        self.memory_len
    }

    fn slice(&self, offset: u64, len: u64) -> Result<&[u8], Errno> {
        if len == 0 {
            // A zero-length read lands wherever the previous field ended, which
            // for an empty payload is exactly a block boundary (a module with
            // no bytes asks for precisely this). Answering it from the declared
            // geometry keeps such a read legal without letting a nonempty read
            // straddle blocks.
            return if offset <= self.memory_len {
                Ok(&[])
            } else {
                Err(Errno::EINVAL)
            };
        }
        let end = offset.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > self.memory_len {
            return Err(Errno::EINVAL);
        }
        let (start, block) = self
            .blocks
            .range(..=offset)
            .next_back()
            .ok_or(Errno::EINVAL)?;
        let block_end = start.checked_add(block.len() as u64).ok_or(Errno::EINVAL)?;
        if end > block_end {
            return Err(Errno::EINVAL);
        }
        let from = usize::try_from(offset - start).map_err(|_| Errno::EINVAL)?;
        let count = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
        let to = from.checked_add(count).ok_or(Errno::EINVAL)?;
        block.get(from..to).ok_or(Errno::EINVAL)
    }
}

/// Which of the archive's three `next`-linked record chains is being walked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chain {
    Modules,
    Transactions,
    TablePatches,
}

impl Chain {
    /// The fixed-size prefix that declares how long the whole record is.
    fn header_size(self) -> u64 {
        match self {
            Chain::Modules => MODULE_HEADER_SIZE,
            Chain::Transactions => TRANSACTION_HEADER_SIZE,
            Chain::TablePatches => TABLE_PATCH_HEADER_SIZE,
        }
    }
}

/// What the bytes the walker is currently waiting on will be used for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Header,
    RecordHeader { chain: Chain, address: u64 },
    RecordRest { chain: Chain, address: u64 },
    Complete,
    Failed,
}

/// A KFLA archive walk driven one fetched byte range at a time.
#[derive(Debug, Clone)]
pub struct ArchiveWalk {
    head: u64,
    pointer_width: u8,
    memory_len: u64,
    storage: SparseArchive,
    stage: Stage,
    pending: Option<(u64, u64)>,
    /// Each chain as `(kind, first record, declared count)`, in the order the
    /// walk visits them.
    chains: Vec<(Chain, u64, u32)>,
    chain_index: usize,
    cursor: u64,
    remaining: u32,
    /// Every record address already visited, shared across all three chains
    /// exactly as the decoder's own `seen_addresses` is: one record cannot
    /// appear twice, in the same chain or in two.
    seen: BTreeSet<u64>,
}

impl ArchiveWalk {
    /// Start a walk of the archive rooted at `head`.
    ///
    /// A `head` of zero means the process never published an archive. That is
    /// not an error and not a walk: [`next_range`](Self::next_range) reports
    /// nothing to fetch and [`finish`](Self::finish) yields `Ok(None)`.
    pub fn new(head: u64, pointer_width: u8, memory_len: u64) -> Self {
        let mut walk = ArchiveWalk {
            head,
            pointer_width,
            memory_len,
            storage: SparseArchive::new(memory_len),
            stage: Stage::Header,
            pending: None,
            chains: Vec::new(),
            chain_index: 0,
            cursor: 0,
            remaining: 0,
            seen: BTreeSet::new(),
        };
        if head == 0 {
            walk.stage = Stage::Complete;
            return walk;
        }
        // Refusing an out-of-range head here rather than asking for it keeps the
        // walker from ever handing its host a range the guest memory could not
        // contain.
        match checked_range(head, ARCHIVE_HEADER_SIZE, memory_len) {
            Ok(()) => walk.pending = Some((head, ARCHIVE_HEADER_SIZE)),
            Err(_) => walk.stage = Stage::Failed,
        }
        walk
    }

    /// The next byte range the caller must fetch, or `None` when the image is
    /// complete. Returns `(address, length)`.
    ///
    /// A walk that has already failed also reports `None`; the failure is
    /// reported by [`finish`](Self::finish), and was reported by the
    /// [`supply`](Self::supply) that caused it.
    pub fn next_range(&self) -> Option<(u64, u64)> {
        self.pending
    }

    /// Supply the bytes for the range [`next_range`](Self::next_range) just
    /// reported.
    ///
    /// A length that does not match the requested range is `Err(Errno::EINVAL)`
    /// and leaves the request standing, so a caller that miscounted can answer
    /// the same question again rather than silently decoding a short record.
    pub fn supply(&mut self, bytes: Vec<u8>) -> Result<(), Errno> {
        let (address, length) = self.pending.ok_or(Errno::EINVAL)?;
        if bytes.len() as u64 != length {
            return Err(Errno::EINVAL);
        }
        self.storage.insert(address, bytes);
        self.pending = None;
        match self.advance() {
            Ok(()) => Ok(()),
            Err(err) => {
                self.stage = Stage::Failed;
                self.pending = None;
                Err(err)
            }
        }
    }

    /// Decode what was fetched. Errors if the walk is not complete.
    ///
    /// An unpublished archive (`head == 0`) yields `Ok(None)`: a process that
    /// has never loaded a shared object has nothing to decode, which is a
    /// normal state rather than a malformed image.
    pub fn finish(self) -> Result<Option<DylinkArchive>, Errno> {
        if self.head == 0 {
            return Ok(None);
        }
        if self.stage != Stage::Complete {
            return Err(Errno::EINVAL);
        }
        super::decode_dylink_archive(&self.storage, self.head, self.pointer_width).map(Some)
    }

    fn advance(&mut self) -> Result<(), Errno> {
        match self.stage {
            Stage::Header => self.after_header(),
            Stage::RecordHeader { chain, address } => self.after_record_header(chain, address),
            Stage::RecordRest { chain, address } => self.after_record(chain, address),
            Stage::Complete | Stage::Failed => Err(Errno::EINVAL),
        }
    }

    /// Read the three chain cursors out of the archive header and start the
    /// first chain.
    fn after_header(&mut self) -> Result<(), Errno> {
        let head = self.head;
        let module_count = r_u32(&self.storage, head + 24)?;
        let module_first = r_u64(&self.storage, head + 32)?;
        let patch_first = r_u64(&self.storage, head + 56)?;
        let patch_count = r_u32(&self.storage, head + 72)?;
        let transaction_count = r_u32(&self.storage, head + 88)?;
        let transaction_first = r_u64(&self.storage, head + 96)?;

        // The same physical-plausibility bound the decoder applies: a declared
        // count that no memory of this size could hold would otherwise make the
        // walker ask its host billions of questions before the decoder ever got
        // to reject the image.
        let capacity = self.memory_len.saturating_sub(ARCHIVE_HEADER_SIZE);
        if module_count as u64 > capacity / MODULE_HEADER_SIZE
            || transaction_count as u64 > capacity / TRANSACTION_HEADER_SIZE
            || patch_count as u64 > capacity / TABLE_PATCH_HEADER_SIZE
        {
            return Err(Errno::EINVAL);
        }

        self.chains = alloc::vec![
            (Chain::Modules, module_first, module_count),
            (Chain::Transactions, transaction_first, transaction_count),
            (Chain::TablePatches, patch_first, patch_count),
        ];
        self.chain_index = 0;
        let (_, first, count) = self.chains[0];
        self.cursor = first;
        self.remaining = count;
        self.schedule_record()
    }

    /// Request the fixed header of the next record, moving on to the next chain
    /// (or finishing) when the current one is exhausted.
    fn schedule_record(&mut self) -> Result<(), Errno> {
        loop {
            if self.remaining == 0 {
                // The last record of a chain must terminate it. A nonzero
                // cursor here means the image holds more records than the
                // header declared, which is the decoder's own "more records
                // than declared" rejection.
                if self.cursor != 0 {
                    return Err(Errno::EINVAL);
                }
                self.chain_index += 1;
                match self.chains.get(self.chain_index) {
                    Some(&(_, first, count)) => {
                        self.cursor = first;
                        self.remaining = count;
                    }
                    None => {
                        self.stage = Stage::Complete;
                        self.pending = None;
                        return Ok(());
                    }
                }
                continue;
            }
            if self.cursor == 0 {
                return Err(Errno::EINVAL); // chain ended before its count
            }
            if !self.seen.insert(self.cursor) {
                return Err(Errno::EINVAL); // cycle
            }
            let chain = self.chains[self.chain_index].0;
            let header_size = chain.header_size();
            checked_range(self.cursor, header_size, self.memory_len)?;
            self.pending = Some((self.cursor, header_size));
            self.stage = Stage::RecordHeader {
                chain,
                address: self.cursor,
            };
            return Ok(());
        }
    }

    /// The record's fixed header is in hand, so its full extent is now known.
    fn after_record_header(&mut self, chain: Chain, address: u64) -> Result<(), Errno> {
        let total = self.record_size(chain, address)?;
        checked_range(address, total, self.memory_len)?;
        let header_size = chain.header_size();
        if total > header_size {
            self.pending = Some((checked_end(address, header_size)?, total - header_size));
            self.stage = Stage::RecordRest { chain, address };
            Ok(())
        } else {
            // A record with no payload at all; nothing further to fetch.
            self.after_record(chain, address)
        }
    }

    /// The whole record is in hand: follow its `next` pointer.
    fn after_record(&mut self, _chain: Chain, address: u64) -> Result<(), Errno> {
        let next = r_u64(&self.storage, checked_end(address, 8)?)?;
        self.remaining = self.remaining.saturating_sub(1);
        self.cursor = next;
        self.schedule_record()
    }

    /// Total record size, from the counts the record's own header declares.
    ///
    /// This mirrors `read_module` / `read_transaction` / `read_table_patch`
    /// rather than trusting the size the record stores at `+16`: the decoder
    /// derives the payload offsets it reads from these same counts and only
    /// then checks the stored size against them, so fetching what the counts
    /// imply is what guarantees every byte the decoder reads is present.
    fn record_size(&self, chain: Chain, address: u64) -> Result<u64, Errno> {
        match chain {
            Chain::Modules => {
                let name_len = r_u32(&self.storage, address + 60)? as u64;
                let bytes_len = r_u32(&self.storage, address + 64)? as u64;
                let provider_len = r_u32(&self.storage, address + 120)? as u64;
                let allocation_count = r_u32(&self.storage, address + 132)? as u64;
                let allocation_len = allocation_count
                    .checked_mul(MODULE_ALLOCATION_SIZE)
                    .ok_or(Errno::EINVAL)?;
                let mut size = MODULE_HEADER_SIZE;
                size = checked_end(size, align8(name_len)?)?;
                size = checked_end(size, align8(bytes_len)?)?;
                size = checked_end(size, align8(provider_len)?)?;
                checked_end(size, allocation_len)
            }
            Chain::Transactions => {
                let name_len = r_u32(&self.storage, address + 28)? as u64;
                let bytes_len = r_u32(&self.storage, address + 32)? as u64;
                // The module bytes trail the record UNPADDED; padding here
                // would over-fetch and disagree with the size the record
                // declares, which the decoder checks exactly.
                let size = checked_end(TRANSACTION_HEADER_SIZE, align8(name_len)?)?;
                checked_end(size, bytes_len)
            }
            Chain::TablePatches => {
                let run_count = r_u32(&self.storage, address + 56)? as u64;
                let payload = run_count
                    .checked_mul(TABLE_PATCH_RUN_SIZE)
                    .ok_or(Errno::EINVAL)?;
                checked_end(TABLE_PATCH_HEADER_SIZE, payload)
            }
        }
    }
}
