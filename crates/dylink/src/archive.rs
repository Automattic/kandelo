//! Publishing and reading the process's fork archive, as planned work.
//!
//! # Why this is a planner and not a writer
//!
//! The archive's records live in GUEST linear memory, obtained from the process
//! allocator. Neither this crate nor the standalone wasm planner module can
//! address that memory: the module imports nothing at all. So the archive is
//! published the same way everything else is — the session decides, and emits
//! [`HostRequest`]s naming exactly one mechanical operation each:
//!
//! | request | what the driver does |
//! |---|---|
//! | [`HostRequest::AllocateArchive`] | one `SYS_MMAP`-backed block |
//! | [`HostRequest::WriteArchive`] | one `Uint8Array.set` |
//! | [`HostRequest::PublishGeneration`] | one aligned 8-byte store |
//! | [`HostRequest::ReleaseArchive`] | one release of a block |
//! | [`HostRequest::ReadArchive`] | one byte-range read |
//!
//! Layout, padding, digests, `next` pointers, header cursors, which records may
//! keep their addresses and which must be replaced — all of that stays here,
//! beside `fork_codec`'s encoder and decoder, which is the only arrangement in
//! which the three cannot drift.
//!
//! # The two rules a pthread peer depends on
//!
//! A process's other Workers read this archive while it is being written, under
//! a reader lock that does not stop a writer. Two ordering rules make that safe,
//! and both are enforced here rather than left to a driver:
//!
//! 1. **A reachable record is never resized.** When a record's byte length would
//!    change — a constructor-time `dlsym` adding a provider edge is the case
//!    that happens — a complete REPLACEMENT record is allocated, the chain is
//!    repointed at it, and only then is the old one released. Rewriting a
//!    record in place is allowed only when every byte outside its mutable
//!    fields is identical, which [`Session::archive_sync_begin`] verifies rather
//!    than assumes.
//! 2. **The generation is published last, and alone.** It is the fence other
//!    Workers consume, so the header's cursors and counts are written first, in
//!    separate steps, and the generation lands afterwards as a single aligned
//!    store. Writing the whole 104-byte header in one copy would let a reader
//!    observe a new generation beside stale cursors, because a byte copy has no
//!    defined order.

use alloc::collections::VecDeque;
use alloc::string::String;
use alloc::vec::Vec;

use fork_codec::dylink_archive::encode::{encode_dylink_archive, plan_dylink_archive};
use fork_codec::dylink_archive::{DylinkArchive, DylinkModule, DylinkTablePatch, DylinkTransaction};

use crate::error::{DylinkError, DylinkResult};
use crate::plan::{HostRequest, PlanStep};

/// The KFLA header's byte length, and the offset of its generation field.
///
/// Restated here because the split write above needs both, and because a
/// mismatch with `fork_codec`'s constants would be caught by
/// [`super::Session::archive_sync_begin`]'s size check on the header record
/// rather than silently producing a torn header.
pub(crate) const ARCHIVE_HEADER_BYTES: u64 = 104;
pub(crate) const ARCHIVE_GENERATION_OFFSET: u64 = 40;

/// `Number.MAX_SAFE_INTEGER`. The host reads generations through a `Number`, so
/// a larger one could not round-trip, and the format never emits one.
const MAX_EXACT_GENERATION: u64 = 9_007_199_254_740_991;

/// The KFLA format's bounds on the funcref patch journal.
///
/// A journal past either limit must be compacted into a full table checkpoint.
/// Restated here so the session can answer "will this fit" BEFORE a caller
/// commits to a patch, rather than having the encoder refuse a record the
/// caller has already treated as published.
pub(crate) const MAX_TABLE_PATCH_RECORDS: usize = 256;
pub(crate) const MAX_TABLE_PATCH_BYTES: usize = 1024 * 1024;
pub(crate) const TABLE_PATCH_HEADER_BYTES: usize = 64;
pub(crate) const TABLE_PATCH_RUN_BYTES: usize = 24;

/// One record as it currently exists in guest memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedRecord {
    pub address: u64,
    pub size: u64,
}

/// What this process has published, and where.
#[derive(Clone, Debug, Default)]
pub struct ArchiveState {
    /// The header record's address, or zero before the first publication.
    pub head: u64,
    pub generation: u64,
    pub table_state_root: u64,
    pub table_checkpoint_generation: u64,
    /// Address and size per record, index-aligned with the archive's own order.
    pub modules: Vec<(PublishedRecord, DylinkModule)>,
    pub transactions: Vec<(PublishedRecord, DylinkTransaction)>,
    pub table_patches: Vec<(PublishedRecord, DylinkTablePatch)>,
}

impl ArchiveState {
    pub fn module(&self, name: &str) -> Option<&(PublishedRecord, DylinkModule)> {
        self.modules.iter().find(|(_, module)| module.name == name)
    }

    pub fn transaction(&self, token: u32) -> Option<&(PublishedRecord, DylinkTransaction)> {
        self.transactions
            .iter()
            .find(|(_, transaction)| transaction.token == token)
    }
}

/// Where a sync has got to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncPhase {
    Allocate,
    Emit,
    Draining,
}

/// One archive publication in flight.
pub(crate) struct SyncFlow {
    /// The image being published, header first in `sizes`/`addresses`.
    desired: DylinkArchive,
    sizes: Vec<u64>,
    addresses: Vec<Option<u64>>,
    /// The record whose allocation is in flight.
    cursor: usize,
    /// Blocks the publication makes unreachable, released only after the new
    /// generation is visible.
    stale: Vec<PublishedRecord>,
    queue: VecDeque<PlanStep>,
    phase: SyncPhase,
    pub finished: bool,
}

impl SyncFlow {
    /// Decide the whole publication up front: which records keep their
    /// addresses, which need new ones, and which become unreachable.
    ///
    /// `desired` already carries the generation this publication will fence on.
    pub fn plan(state: &ArchiveState, desired: DylinkArchive) -> DylinkResult<Self> {
        let layout = plan_dylink_archive(&desired).map_err(|_| {
            DylinkError::MalformedModule("the loader state does not fit an archive image")
        })?;
        if layout.sizes.first().copied() != Some(ARCHIVE_HEADER_BYTES) {
            // The split header write below depends on this exact length. A
            // format change that moved it must fail here rather than publish a
            // header whose generation lands at the wrong offset.
            return Err(DylinkError::MalformedModule(
                "archive header size disagrees with the generation fence offset",
            ));
        }
        let mut addresses: Vec<Option<u64>> = Vec::with_capacity(layout.sizes.len());
        let mut stale: Vec<PublishedRecord> = Vec::new();

        // The header keeps its address for the life of the process: other
        // Workers hold it, and moving it would strand every reader mid-walk.
        addresses.push((state.head != 0).then_some(state.head));

        let mut index = 1;
        for module in &desired.modules {
            let size = layout.sizes[index];
            index += 1;
            match state.module(&module.name) {
                Some((record, published)) => {
                    require_immutable_match(published, module)?;
                    if record.size == size {
                        addresses.push(Some(record.address));
                    } else {
                        // A provider edge appeared, so the record grew. Publish
                        // a replacement rather than resizing one a peer may be
                        // walking.
                        addresses.push(None);
                        stale.push(record.clone());
                    }
                }
                None => addresses.push(None),
            }
        }
        for transaction in &desired.transactions {
            let size = layout.sizes[index];
            index += 1;
            match state.transaction(transaction.token) {
                Some((record, published)) => {
                    if published.name != transaction.name
                        || published.global_visibility != transaction.global_visibility
                        || published.module_bytes != transaction.module_bytes
                    {
                        return Err(DylinkError::MalformedModule(
                            "a staged loader transaction changed identity",
                        ));
                    }
                    if record.size == size {
                        addresses.push(Some(record.address));
                    } else {
                        addresses.push(None);
                        stale.push(record.clone());
                    }
                }
                None => addresses.push(None),
            }
        }
        for (offset, _) in desired.table_patches.iter().enumerate() {
            let size = layout.sizes[index];
            index += 1;
            match state.table_patches.get(offset) {
                // Patches are append-only within a checkpoint, so a record at
                // the same offset with the same length is the same record.
                Some((record, _)) if record.size == size => addresses.push(Some(record.address)),
                Some((record, _)) => {
                    addresses.push(None);
                    stale.push(record.clone());
                }
                None => addresses.push(None),
            }
        }

        // Records this process published and the new image no longer names.
        for (record, module) in &state.modules {
            if !desired.modules.iter().any(|next| next.name == module.name)
                && !stale.contains(record)
            {
                stale.push(record.clone());
            }
        }
        for (record, transaction) in &state.transactions {
            if !desired
                .transactions
                .iter()
                .any(|next| next.token == transaction.token)
                && !stale.contains(record)
            {
                stale.push(record.clone());
            }
        }
        for (offset, (record, _)) in state.table_patches.iter().enumerate() {
            if offset >= desired.table_patches.len() && !stale.contains(record) {
                stale.push(record.clone());
            }
        }

        Ok(SyncFlow {
            desired,
            sizes: layout.sizes,
            addresses,
            cursor: 0,
            stale,
            queue: VecDeque::new(),
            phase: SyncPhase::Allocate,
            finished: false,
        })
    }

    /// The next thing the driver must do, or `None` when the publication is
    /// complete.
    pub fn step(&mut self) -> DylinkResult<Option<(PlanStep, bool)>> {
        loop {
            if let Some(step) = self.queue.pop_front() {
                return Ok(Some((step, false)));
            }
            match self.phase {
                SyncPhase::Allocate => {
                    while self.cursor < self.addresses.len() {
                        if self.addresses[self.cursor].is_some() {
                            self.cursor += 1;
                            continue;
                        }
                        let size = self.sizes[self.cursor];
                        return Ok(Some((
                            PlanStep::Host(HostRequest::AllocateArchive { size }),
                            true,
                        )));
                    }
                    self.phase = SyncPhase::Emit;
                }
                SyncPhase::Emit => {
                    self.emit_writes()?;
                    self.phase = SyncPhase::Draining;
                }
                SyncPhase::Draining => {
                    self.finished = true;
                    return Ok(None);
                }
            }
        }
    }

    /// Record an address the driver just allocated.
    pub fn accept_allocation(&mut self, address: u64) -> DylinkResult<()> {
        if self.cursor >= self.addresses.len() || self.addresses[self.cursor].is_some() {
            return Err(DylinkError::UnexpectedActSequence);
        }
        self.addresses[self.cursor] = Some(address);
        self.cursor += 1;
        Ok(())
    }

    /// The head and generation the driver must publish once the loop drains.
    pub fn published(&self) -> DylinkResult<(u64, u64)> {
        if !self.finished {
            return Err(DylinkError::UnexpectedActSequence);
        }
        let head = self
            .addresses
            .first()
            .copied()
            .flatten()
            .ok_or(DylinkError::UnexpectedActSequence)?;
        Ok((head, self.desired.generation))
    }

    /// The state this publication leaves behind, for the next one to diff
    /// against.
    pub fn committed(&self) -> DylinkResult<ArchiveState> {
        let (head, generation) = self.published()?;
        let mut index = 1;
        let mut modules = Vec::with_capacity(self.desired.modules.len());
        for module in &self.desired.modules {
            modules.push((self.record(index)?, module.clone()));
            index += 1;
        }
        let mut transactions = Vec::with_capacity(self.desired.transactions.len());
        for transaction in &self.desired.transactions {
            transactions.push((self.record(index)?, transaction.clone()));
            index += 1;
        }
        let mut table_patches = Vec::with_capacity(self.desired.table_patches.len());
        for patch in &self.desired.table_patches {
            table_patches.push((self.record(index)?, patch.clone()));
            index += 1;
        }
        Ok(ArchiveState {
            head,
            generation,
            table_state_root: self.desired.table_state_root,
            table_checkpoint_generation: self.desired.table_checkpoint_generation,
            modules,
            transactions,
            table_patches,
        })
    }

    fn record(&self, index: usize) -> DylinkResult<PublishedRecord> {
        let address = self
            .addresses
            .get(index)
            .copied()
            .flatten()
            .ok_or(DylinkError::UnexpectedActSequence)?;
        let size = *self
            .sizes
            .get(index)
            .ok_or(DylinkError::UnexpectedActSequence)?;
        Ok(PublishedRecord { address, size })
    }

    /// Encode every record at its resolved address and queue the writes in
    /// publication order: records first, then the header without its
    /// generation, then the generation alone, then the releases.
    fn emit_writes(&mut self) -> DylinkResult<()> {
        let addresses: Vec<u64> = self
            .addresses
            .iter()
            .map(|address| address.ok_or(DylinkError::UnexpectedActSequence))
            .collect::<DylinkResult<_>>()?;
        let records = encode_dylink_archive(&self.desired, &addresses).map_err(|_| {
            DylinkError::MalformedModule("the loader state does not encode to an archive image")
        })?;
        let mut header: Option<&fork_codec::dylink_archive::encode::DylinkArchiveRecord> = None;
        for record in &records {
            if record.address == addresses[0] {
                header = Some(record);
                continue;
            }
            self.queue.push_back(PlanStep::Host(HostRequest::WriteArchive {
                address: record.address,
                bytes: record.bytes.clone(),
            }));
        }
        let header = header.ok_or(DylinkError::UnexpectedActSequence)?;
        let split = ARCHIVE_GENERATION_OFFSET as usize;
        let generation_end = split + 8;
        if header.bytes.len() < generation_end {
            return Err(DylinkError::MalformedModule("archive header record is short"));
        }
        // Everything the fence must already be true when it lands.
        self.queue.push_back(PlanStep::Host(HostRequest::WriteArchive {
            address: header.address,
            bytes: header.bytes[..split].to_vec(),
        }));
        self.queue.push_back(PlanStep::Host(HostRequest::WriteArchive {
            address: header.address + generation_end as u64,
            bytes: header.bytes[generation_end..].to_vec(),
        }));
        self.queue
            .push_back(PlanStep::Host(HostRequest::PublishGeneration {
                address: header.address + ARCHIVE_GENERATION_OFFSET,
                generation: self.desired.generation,
            }));
        // Only now is the old image unreachable.
        for record in &self.stale {
            self.queue
                .push_back(PlanStep::Host(HostRequest::ReleaseArchive {
                    address: record.address,
                    size: record.size,
                }));
        }
        Ok(())
    }
}

/// The next generation, refusing to wrap.
///
/// A wrapped generation would make a stale archive look newer than a fresh one
/// to a peer comparing fences, which is worse than refusing to publish.
pub(crate) fn next_generation(current: u64) -> DylinkResult<u64> {
    if current >= MAX_EXACT_GENERATION {
        return Err(DylinkError::MalformedModule("archive generation is exhausted"));
    }
    Ok(current + 1)
}

/// A live module may change its mutable fields between publications and nothing
/// else.
///
/// Ports `requireImmutableMatch` (`dylink-fork-archive.ts:1903-1934`), including
/// its one exception: `tls_base` may appear on an object whose initialization is
/// still in flight, because the TLS region is reserved partway through the load.
fn require_immutable_match(current: &DylinkModule, next: &DylinkModule) -> DylinkResult<()> {
    let allocations_match = current.allocations.len() == next.allocations.len()
        && current
            .allocations
            .iter()
            .zip(&next.allocations)
            .all(|(left, right)| left == right);
    let tls_match = current.tls_base == next.tls_base || current.initialization.is_some();
    if current.memory_base == next.memory_base
        && current.table_base == next.table_base
        && current.activation_id == next.activation_id
        && allocations_match
        && tls_match
        && current.module_bytes == next.module_bytes
    {
        return Ok(());
    }
    Err(DylinkError::ArchivedAllocationMismatch { library: String::from(&next.name) })
}
