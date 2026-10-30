//! Experimental append-only journal for a writable overlay on one immutable image.
//!
//! The base image is identified by its SHA-256 digest. A transaction contains
//! inode, file-size, file-block, or directory-entry replacements and one trailing commit
//! marker. Recovery publishes only complete, checksummed transactions. The
//! kernel's POSIX namespace remains the authority. The fixed-size overwrite
//! mode mounts only file-block changes; resizable mounts replay namespace and
//! inode metadata records.
//! Storage implementations must provide exclusive single-writer access,
//! exact positioned I/O, and a flush that makes prior writes durable.

use crate::persistent_overlay_index::{
    BlockCheckpoint, BlockCheckpointEntry, MetadataCheckpointEntry,
};
use crate::metadata_budget::{MetadataReservation, ROOTFS_METADATA};
use crate::io_buffer::{IoBuffer, reserve_payload};
use crate::prepared_map::{MapMemory, PreparedEntry, PreparedMap};
use alloc::boxed::Box;
use alloc::vec::Vec;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

const MAGIC: &[u8; 4] = b"KOVL";
const TRANSACTION_MAGIC: &[u8; 4] = b"KTXN";
const COMMIT_MAGIC: &[u8; 4] = b"DONE";
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 72;
const TRANSACTION_HEADER_BYTES: usize = 24;
const TRANSACTION_TRAILER_BYTES: usize = 36;
const MAX_TRANSACTION_BYTES: usize = 1024 * 1024;
pub(crate) const FILE_BLOCK_BYTES: usize = 4096;
pub(crate) const CACHE_BLOCKS: usize = 64;
const METADATA_CACHE_ENTRIES: usize = 64;
const ACTIVE_TAIL_LIMIT_BYTES: u64 = 63 * 1024 * 1024;
const LEGACY_SORT_RECORD_BYTES: u64 = 96;
const LEGACY_SORT_RUN_RECORDS: usize = 4 * 1024;
const LEGACY_SORT_IO_RECORDS: usize = 1024;
const LEGACY_MUTATION_RECORD_BYTES: usize = 384;

#[cfg(test)]
static FAIL_CACHE_AFTER: core::sync::atomic::AtomicUsize = core::sync::atomic::AtomicUsize::new(usize::MAX);

#[cfg(test)]
pub(crate) struct CacheAllocationFailure;

#[cfg(test)]
pub(crate) fn fail_cache_after(successes: usize) -> CacheAllocationFailure {
    FAIL_CACHE_AFTER.store(successes, core::sync::atomic::Ordering::SeqCst);
    CacheAllocationFailure
}

#[cfg(test)]
impl Drop for CacheAllocationFailure {
    fn drop(&mut self) { FAIL_CACHE_AFTER.store(usize::MAX, core::sync::atomic::Ordering::SeqCst); }
}

fn reserve_cache<CacheEntry>(bytes: &mut Vec<CacheEntry>, length: usize) -> Result<(), Errno> {
    if length <= bytes.capacity() { return Ok(()); }
    #[cfg(test)]
    {
        let remaining = FAIL_CACHE_AFTER.load(core::sync::atomic::Ordering::SeqCst);
        if remaining != usize::MAX {
            FAIL_CACHE_AFTER.store(remaining.wrapping_sub(1), core::sync::atomic::Ordering::SeqCst);
            if remaining == 0 { return Err(Errno::ENOMEM); }
        }
    }
    bytes.try_reserve_exact(length.saturating_sub(bytes.len())).map_err(|_| Errno::ENOMEM)
}

fn cache_vector<CacheEntry>(length: usize) -> Result<IoBuffer<CacheEntry>, Errno> {
    cache_vector_in(length, false)
}

fn cache_vector_in<CacheEntry>(length: usize, writeback: bool) -> Result<IoBuffer<CacheEntry>, Errno> {
    IoBuffer::allocate(length, writeback, |bytes| reserve_cache(bytes, length))
}

fn copy_cache_bytes(source: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut bytes = Vec::new();
    reserve_cache(&mut bytes, source.len())?;
    bytes.extend_from_slice(source);
    Ok(bytes)
}

fn zeroed_cache_block() -> Result<IoBuffer<u8>, Errno> {
    let mut bytes = cache_vector(FILE_BLOCK_BYTES)?;
    bytes.resize(FILE_BLOCK_BYTES, 0);
    Ok(bytes)
}

fn push_cache<CacheEntry>(cache: &mut IoBuffer<CacheEntry>, value: CacheEntry, limit: usize) {
    assert!(cache.len() < limit && cache.len() < cache.capacity(), "cache publication lacks reserved slot");
    cache.push(value);
}

fn copy_stored_metadata(value: &Option<Vec<u8>>) -> Result<Option<IoBuffer<u8>>, Errno> {
    value.as_ref().map(|bytes| {
        let mut output = cache_vector(bytes.len())?;
        output.extend_from_slice(bytes);
        Ok(output)
    }).transpose()
}

fn copy_cached_metadata(value: &Option<Option<Vec<u8>>>) -> Result<Option<Option<IoBuffer<u8>>>, Errno> {
    value.as_ref().map(copy_stored_metadata).transpose()
}

fn scratch_vector<Value>(capacity: usize) -> Result<IoBuffer<Value>, Errno> {
    IoBuffer::allocate(capacity, false, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))
}

pub(crate) struct MutationBatch {
    mutations: IoBuffer<Mutation>,
    payload: MetadataReservation<'static>,
    limit: usize,
}

impl MutationBatch {
    pub(crate) fn new(capacity: usize) -> Result<Self, Errno> {
        Self::new_in(capacity, false)
    }

    pub(crate) fn new_writeback(capacity: usize) -> Result<Self, Errno> { Self::new_in(capacity, true) }

    fn new_in(capacity: usize, writeback: bool) -> Result<Self, Errno> {
        let mutations = IoBuffer::allocate(capacity, writeback, |values| values.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))?;
        Ok(Self { mutations, payload: reserve_payload(0, writeback)?, limit: capacity })
    }

    pub(crate) fn len(&self) -> usize { self.mutations.len() }
    pub(crate) fn as_slice(&self) -> &[Mutation] { &self.mutations }

    pub(crate) fn push_with(&mut self, bytes: usize, create: impl FnOnce() -> Result<Mutation, Errno>) -> Result<(), Errno> {
        if self.mutations.len() == self.limit { return Err(Errno::EFBIG); }
        let mut credit = self.payload.budget().reserve(bytes.checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        let mutation = create()?;
        resize_mutation_payload_credit(&mut credit, core::slice::from_ref(&mutation))?;
        self.mutations.push(mutation);
        self.payload.merge(credit);
        Ok(())
    }

    fn flush<S: OverlayStorage>(&mut self, target: &mut OverlayJournal<S>) -> Result<(), Errno> {
        target.commit_transaction(&self.mutations)?;
        self.mutations.clear();
        self.payload.resize(0)
    }

    fn flush_if_full<S: OverlayStorage>(&mut self, target: &mut OverlayJournal<S>) -> Result<(), Errno> {
        if self.mutations.len() == self.limit { self.flush(target)?; }
        Ok(())
    }
}

struct DirtyFileSizes { entries: IoBuffer<(u64, u64)> }

impl DirtyFileSizes {
    fn new() -> Result<Self, Errno> { Ok(Self { entries: cache_vector(CACHE_BLOCKS)? }) }
    fn len(&self) -> usize { self.entries.len() }
    fn is_empty(&self) -> bool { self.entries.is_empty() }
    fn clear(&mut self) { self.entries.clear(); }
    fn contains_key(&self, inode: &u64) -> bool { self.get(inode).is_some() }
    fn get(&self, inode: &u64) -> Option<&u64> {
        self.entries.binary_search_by_key(inode, |&(inode, _)| inode).ok().map(|position| &self.entries[position].1)
    }
    fn iter(&self) -> impl Iterator<Item = (&u64, &u64)> {
        self.entries.iter().map(|(inode, size)| (inode, size))
    }
    fn insert(&mut self, inode: u64, size: u64) {
        match self.entries.binary_search_by_key(&inode, |&(inode, _)| inode) {
            Ok(position) => self.entries[position].1 = size,
            Err(position) => {
                assert!(self.entries.len() < CACHE_BLOCKS && self.entries.len() < self.entries.capacity(), "dirty-size publication lacks reserved slot");
                self.entries.insert(position, (inode, size));
            }
        }
    }
    fn retain(&mut self, mut keep: impl FnMut(&u64, &mut u64) -> bool) {
        self.entries.retain_mut(|(inode, size)| keep(inode, size));
    }
}

pub trait OverlayStorage {
    fn len(&mut self) -> Result<u64, Errno>;
    fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;
    fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno>;
    fn flush(&mut self) -> Result<(), Errno>;
    fn truncate(&mut self, len: u64) -> Result<(), Errno>;
}

impl<T: OverlayStorage + ?Sized> OverlayStorage for Box<T> {
    fn len(&mut self) -> Result<u64, Errno> {
        (**self).len()
    }

    fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        (**self).read_exact_at(offset, dst)
    }

    fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
        (**self).write_all_at(offset, src)
    }

    fn flush(&mut self) -> Result<(), Errno> {
        (**self).flush()
    }

    fn truncate(&mut self, len: u64) -> Result<(), Errno> {
        (**self).truncate(len)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum OverlayKey {
    Inode(u64),
    FileSize(u64),
    FileZeroFrom(u64),
    FileBlock { inode: u64, block: u64 },
    Dirent { parent: u64, name: Vec<u8> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Mutation {
    Put { key: OverlayKey, value: Vec<u8> },
    Delete { key: OverlayKey },
}

#[derive(Default)]
pub struct OverlayState {
    entries: PreparedMap<OverlayKey, Option<Vec<u8>>>,
    blocks: PreparedMap<(u64, u64), Option<BlockLocation>>,
    invalid_checkpoint_from: PreparedMap<u64, u64>,
}

enum PreparedOverlayMutation {
    Metadata(PreparedEntry<OverlayKey, Option<Vec<u8>>>),
    Block(PreparedEntry<(u64, u64), Option<BlockLocation>>),
    Zero {
        inode: u64,
        block: u64,
        entry: PreparedEntry<OverlayKey, Option<Vec<u8>>>,
        invalid: Option<PreparedEntry<u64, u64>>,
    },
}

impl MapMemory for OverlayKey {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(match self { Self::Dirent { name, .. } => name.capacity(), _ => 0 })
    }
}

#[derive(Clone, Copy)]
struct BlockLocation {
    offset: u64,
    digest: [u8; 32],
}

impl MapMemory for BlockLocation {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl OverlayState {
    pub fn lookup(&self, key: &OverlayKey) -> Option<Option<&[u8]>> {
        self.entries.get(key).map(|value| value.as_deref())
    }

    pub fn metadata_entries(&self) -> impl Iterator<Item = (&OverlayKey, Option<&[u8]>)> {
        self.entries.iter().map(|(key, value)| (key, value.as_deref()))
    }

    pub fn file_size(&self, inode: u64, base_size: u64) -> Result<u64, Errno> {
        if inode == 0 {
            return Err(Errno::EINVAL);
        }
        match self.lookup(&OverlayKey::FileSize(inode)) {
            Some(Some(value)) => Ok(u64::from_le_bytes(
                value.try_into().map_err(|_| Errno::EIO)?,
            )),
            Some(None) | None => Ok(base_size),
        }
    }

    fn zero_from(&self, inode: u64) -> Result<Option<u64>, Errno> {
        match self.lookup(&OverlayKey::FileZeroFrom(inode)) {
            Some(Some(value)) => Ok(Some(u64::from_le_bytes(
                value.try_into().map_err(|_| Errno::EIO)?,
            ))),
            Some(None) => Err(Errno::EIO),
            None => Ok(None),
        }
    }

    pub fn validate_fixed_image_blocks<F>(&self, mut base_size: F) -> Result<(), Errno>
    where
        F: FnMut(u64) -> Option<u64>,
    {
        if !self.entries.is_empty() {
            return Err(Errno::EIO);
        }
        for ((inode, block), location) in &self.blocks {
            if location.is_none() {
                return Err(Errno::EIO);
            }
            let offset = block
                .checked_mul(FILE_BLOCK_BYTES as u64)
                .ok_or(Errno::EIO)?;
            if offset >= base_size(*inode).ok_or(Errno::EIO)? {
                return Err(Errno::EIO);
            }
        }
        Ok(())
    }

    fn prepare_record(record: DecodedMutation<'_>, value_offset: Option<u64>, has_checkpoint: bool, writeback: bool) -> Result<PreparedOverlayMutation, Errno> {
        if record.is_block() {
            let location = record.value.and_then(|value| value_offset.map(|offset| BlockLocation {
                offset,
                digest: Sha256::digest(value).into(),
            }));
            let entry = if writeback { PreparedEntry::new_writeback((record.inode, record.block), location)? }
                else { PreparedEntry::new((record.inode, record.block), location)? };
            return Ok(PreparedOverlayMutation::Block(entry));
        }
        let heap = record.name.len().checked_add(record.value.map_or(0, <[u8]>::len)).ok_or(Errno::ENOMEM)?;
        let reservation = if writeback { PreparedEntry::<OverlayKey, Option<Vec<u8>>>::reserve_writeback(heap)? }
            else { PreparedEntry::<OverlayKey, Option<Vec<u8>>>::reserve(heap)? };
        let mutation = record.to_owned()?;
        match mutation {
            Mutation::Put { key, value } => {
                if let OverlayKey::FileZeroFrom(inode) = key {
                    let block = u64::from_le_bytes(value.as_slice().try_into().map_err(|_| Errno::EIO)?);
                    let entry = PreparedEntry::new_reserved(key, Some(value), reservation)?;
                    let invalid = if has_checkpoint { Some(PreparedEntry::new(inode, block)?) } else { None };
                    Ok(PreparedOverlayMutation::Zero { inode, block, entry, invalid })
                } else {
                    Ok(PreparedOverlayMutation::Metadata(PreparedEntry::new_reserved(key, Some(value), reservation)?))
                }
            }
            Mutation::Delete { key } => Ok(PreparedOverlayMutation::Metadata(PreparedEntry::new_reserved(key, None, reservation)?)),
        }
    }

    fn publish(&mut self, prepared: PreparedOverlayMutation) {
        match prepared {
            PreparedOverlayMutation::Metadata(entry) => { self.entries.insert_prepared(entry); }
            PreparedOverlayMutation::Block(entry) => { self.blocks.insert_prepared(entry); }
            PreparedOverlayMutation::Zero { inode, block, mut entry, mut invalid } => {
                self.blocks.retain(|(owner, index), _| *owner != inode || *index < block);
                if let Some(invalid) = &mut invalid {
                    if let Some(previous) = self.invalid_checkpoint_from.get(&inode) {
                        *invalid.value_mut() = (*previous).min(block);
                    }
                }
                if let Some(invalid) = invalid { self.invalid_checkpoint_from.insert_prepared(invalid); }
                let previous = self.zero_from(inode).expect("prepared zero record invalid").unwrap_or(u64::MAX);
                entry.value_mut().as_mut().expect("prepared zero value missing")
                    .copy_from_slice(&previous.min(block).to_le_bytes());
                self.entries.insert_prepared(entry);
            }
        }
    }

    fn apply(&mut self, record: DecodedMutation<'_>, value_offset: Option<u64>, has_checkpoint: bool) -> Result<(), Errno> {
        self.publish(Self::prepare_record(record, value_offset, has_checkpoint, false)?);
        Ok(())
    }
}

struct CachedMetadata {
    key: OverlayKey,
    value: Option<Option<Vec<u8>>>,
    _reservation: MetadataReservation<'static>,
}

pub struct OverlayJournal<S: OverlayStorage> {
    storage: S,
    base_digest: [u8; 32],
    state: OverlayState,
    checkpoint: Option<BlockCheckpoint<Box<dyn OverlayStorage + Send>>>,
    next_sequence: u64,
    end: u64,
    needs_tail_repair: bool,
    failure: Option<Errno>,
    block_cache: IoBuffer<((u64, u64), IoBuffer<u8>)>,
    dirty_blocks: IoBuffer<((u64, u64), IoBuffer<u8>)>,
    dirty_sizes: DirtyFileSizes,
    metadata_cache: IoBuffer<CachedMetadata>,
    tail_limit_bytes: Option<u64>,
    track_committed_state: bool,
    retain_compacted_metadata: bool,
    metadata_prefix_resident: bool,
}

pub(crate) struct MetadataCursor {
    revision: (u64, u64),
    indexed_position: u64,
    indexed: Option<MetadataCheckpointEntry>,
    last_key: Option<OverlayKey>,
    bytes: Vec<u8>,
    value_limit: usize,
    reservation: MetadataReservation<'static>,
}

impl MetadataCursor {
    fn fixed_bytes() -> usize { 3 * 2 * 255 + 2 * core::mem::size_of::<Self>() }

    fn prepare_bytes(&mut self, length: usize) -> Result<(), Errno> {
        if length > self.value_limit { return Err(Errno::EIO); }
        if length > self.bytes.capacity() {
            let previous = self.reservation.bytes();
            self.reservation.resize(previous.checked_add(length.checked_mul(2).ok_or(Errno::ENOMEM)?)
                .ok_or(Errno::ENOMEM)?)?;
            let result = self.bytes.try_reserve_exact(length.saturating_sub(self.bytes.len()));
            self.reservation.resize(Self::fixed_bytes().checked_add(self.bytes.capacity().checked_mul(2)
                .ok_or(Errno::ENOMEM)?).ok_or(Errno::ENOMEM)?)?;
            result.map_err(|_| Errno::ENOMEM)?;
        }
        self.bytes.resize(length, 0);
        Ok(())
    }
}

fn copy_metadata_key(key: &OverlayKey) -> Result<OverlayKey, Errno> {
    let OverlayKey::Dirent { parent, name } = key else { return Ok(key.clone()) };
    if name.len() > 255 { return Err(Errno::EIO); }
    let mut owned = Vec::new();
    owned.try_reserve_exact(name.len()).map_err(|_| Errno::ENOMEM)?;
    owned.extend_from_slice(name);
    Ok(OverlayKey::Dirent { parent: *parent, name: owned })
}

pub fn journal_header_base_digest(header: &[u8]) -> Result<[u8; 32], Errno> {
    if header.len() != HEADER_BYTES || &header[..4] != MAGIC
        || u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) != VERSION
        || header[40..] != Sha256::digest(&header[..40])[..]
    {
        return Err(Errno::EIO);
    }
    header[8..40].try_into().map_err(|_| Errno::EIO)
}

pub fn read_overlay_base_digest<S: OverlayStorage>(storage: &mut S) -> Result<[u8; 32], Errno> {
    let mut header = [0u8; HEADER_BYTES];
    storage.read_exact_at(0, &mut header)?;
    journal_header_base_digest(&header)
}

pub(crate) fn journal_header_codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let digest;
    let length = (HEADER_BYTES as u32).to_le_bytes();
    let result = match operation {
        11 if input == [0] => length.as_slice(),
        12 => {
            digest = journal_header_base_digest(input)?;
            digest.as_slice()
        },
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < result.len() { return Err(Errno::EINVAL); }
    output[..result.len()].copy_from_slice(result);
    Ok(result.len())
}

fn read_overlay_header<S: OverlayStorage>(
    storage: &mut S,
    base_digest: [u8; 32],
) -> Result<[u8; HEADER_BYTES], Errno> {
    let mut header = [0u8; HEADER_BYTES];
    storage.read_exact_at(0, &mut header)?;
    if journal_header_base_digest(&header)? != base_digest {
        return Err(Errno::EIO);
    }
    Ok(header)
}

fn read_indexed_metadata<S: OverlayStorage>(
    storage: &mut S,
    entry: &MetadataCheckpointEntry,
    bytes: &mut Vec<u8>,
) -> Result<bool, Errno> {
    let Some((_, length)) = entry.value else {
        return Ok(false);
    };
    if length > 4096 { return Err(Errno::EIO); }
    reserve_cache(bytes, length as usize)?;
    bytes.resize(length as usize, 0);
    read_indexed_metadata_bytes(storage, entry, bytes)?;
    Ok(true)
}

fn allocate_after_read_cache_reclaim<Value>(
    mut allocate: impl FnMut() -> Result<Value, Errno>,
    mut reclaim: impl FnMut() -> bool,
) -> Result<Value, Errno> {
    match allocate() {
        Err(Errno::ENOMEM) if reclaim() => allocate(),
        result => result,
    }
}

fn read_indexed_metadata_admitted<S: OverlayStorage>(
    storage: &mut S,
    entry: &MetadataCheckpointEntry,
    bytes: &mut IoBuffer<u8>,
    reclaim: impl FnMut() -> bool,
) -> Result<bool, Errno> {
    let Some((_, length)) = entry.value else { return Ok(false); };
    if length > 4096 { return Err(Errno::EIO); }
    allocate_after_read_cache_reclaim(
        || bytes.reserve_with(length as usize, |values| reserve_cache(values, length as usize)),
        reclaim,
    )?;
    bytes.resize(length as usize, 0);
    read_indexed_metadata_bytes(storage, entry, bytes)?;
    Ok(true)
}

fn read_indexed_metadata_bytes<S: OverlayStorage>(
    storage: &mut S,
    entry: &MetadataCheckpointEntry,
    bytes: &mut [u8],
) -> Result<(), Errno> {
    let (offset, length) = entry.value.ok_or(Errno::EIO)?;
    if length as usize != bytes.len() || length > 4096 { return Err(Errno::EIO); }
    storage.read_exact_at(offset, bytes)?;
    if entry.value_digest.is_some_and(|digest| Sha256::digest(&*bytes)[..] != digest) {
        return Err(Errno::EIO);
    }
    Ok(())
}

impl<S: OverlayStorage> OverlayJournal<S> {
    pub fn open(storage: S, base_digest: [u8; 32]) -> Result<Self, Errno> {
        Self::open_internal(storage, base_digest, None, OverlayState::default())
    }

    pub fn open_with_checkpoint<T: OverlayStorage + Send + 'static>(
        storage: S,
        checkpoint_storage: T,
        base_digest: [u8; 32],
        checkpoint_end: u64,
    ) -> Result<Self, Errno> {
        Self::open_with_checkpoint_internal(
            storage,
            checkpoint_storage,
            base_digest,
            checkpoint_end,
            false,
        )
    }

    pub fn open_with_checkpoint_metadata<T: OverlayStorage + Send + 'static>(
        storage: S,
        checkpoint_storage: T,
        base_digest: [u8; 32],
        checkpoint_end: u64,
    ) -> Result<Self, Errno> {
        Self::open_with_checkpoint_internal(
            storage,
            checkpoint_storage,
            base_digest,
            checkpoint_end,
            true,
        )
    }

    fn open_with_checkpoint_internal<T: OverlayStorage + Send + 'static>(
        mut storage: S,
        mut checkpoint_storage: T,
        base_digest: [u8; 32],
        checkpoint_end: u64,
        replay_metadata: bool,
    ) -> Result<Self, Errno> {
        if checkpoint_end < HEADER_BYTES as u64 || storage.len()? < checkpoint_end {
            return Err(Errno::EIO);
        }
        let header = read_overlay_header(&mut storage, base_digest)?;
        let mut digest = Sha256::new();
        digest.update(header);
        let mut state = OverlayState::default();
        if let Some(index_digest) =
            BlockCheckpoint::indexed_journal_digest(&mut checkpoint_storage)?
        {
            let checkpoint_storage: Box<dyn OverlayStorage + Send> = Box::new(checkpoint_storage);
            let mut checkpoint = BlockCheckpoint::open(
                checkpoint_storage,
                base_digest,
                index_digest,
                checkpoint_end,
            )?;
            let verify_metadata = checkpoint.has_metadata_index();
            if verify_metadata != replay_metadata {
                return Err(Errno::EIO);
            }
            let verify_blocks = checkpoint.has_canonical_block_stream();
            let mut metadata_position = 0u64;
            let mut block_position = 0u64;
            let mut verify_record = |mutation: &DecodedMutation<'_>, value_offset: Option<u64>| {
                if mutation.is_block() {
                    if verify_blocks {
                        let (offset, digest) = match mutation.value {
                            Some(value) => (
                                value_offset.ok_or(Errno::EIO)?,
                                Sha256::digest(value).into(),
                            ),
                            None => (0, [0; 32]),
                        };
                        let record = BlockCheckpointEntry {
                            inode: mutation.inode,
                            block: mutation.block,
                            offset,
                            digest,
                        };
                        if checkpoint.entry_at(block_position)? != Some(record) {
                            return Err(Errno::EIO);
                        }
                        block_position = block_position.checked_add(1).ok_or(Errno::EIO)?;
                    }
                    return Ok(());
                }
                if !verify_metadata {
                    return Err(Errno::EIO);
                }
                let value = match mutation.value {
                    Some(value) => Some((
                        value_offset.ok_or(Errno::EIO)?,
                        u32::try_from(value.len()).map_err(|_| Errno::EIO)?,
                    )),
                    None => None,
                };
                let record = MetadataCheckpointEntry {
                    key: mutation.owned_key()?,
                    value,
                    value_digest: match mutation.value {
                        Some(value) if checkpoint.has_metadata_value_digests() => {
                            Some(Sha256::digest(value).into())
                        }
                        _ => None,
                    },
                };
                if checkpoint.metadata_entry_at(metadata_position)? != Some(record) {
                    return Err(Errno::EIO);
                }
                metadata_position = metadata_position.checked_add(1).ok_or(Errno::EIO)?;
                Ok(())
            };
            let (replayed_end, next_sequence) = replay_transactions(
                &mut storage,
                HEADER_BYTES as u64,
                checkpoint_end,
                1,
                &mut state,
                ReplayFilter::VerifyOnly,
                false,
                false,
                Some(&mut digest),
                Some(&mut verify_record),
            )?;
            if replayed_end != checkpoint_end
                || next_sequence != checkpoint.next_sequence()
                || metadata_position != checkpoint.metadata_count()
                || (verify_blocks && block_position != checkpoint.count())
                || digest.finalize()[..] != index_digest
            {
                return Err(Errno::EIO);
            }
            return Self::open_internal(storage, base_digest, Some(checkpoint), state);
        }
        let filter = if replay_metadata {
            ReplayFilter::MetadataOnly
        } else {
            ReplayFilter::RejectMetadata
        };
        let (replayed_end, next_sequence) = replay_transactions(
            &mut storage,
            HEADER_BYTES as u64,
            checkpoint_end,
            1,
            &mut state,
            filter,
            false,
            false,
            Some(&mut digest),
            None,
        )?;
        let checkpoint_storage: Box<dyn OverlayStorage + Send> = Box::new(checkpoint_storage);
        let checkpoint = BlockCheckpoint::open(
            checkpoint_storage,
            base_digest,
            digest.finalize().into(),
            checkpoint_end,
        )?;
        if replayed_end != checkpoint_end || next_sequence != checkpoint.next_sequence() {
            return Err(Errno::EIO);
        }
        Self::open_internal(storage, base_digest, Some(checkpoint), state)
    }

    fn open_internal(
        mut storage: S,
        base_digest: [u8; 32],
        mut checkpoint: Option<BlockCheckpoint<Box<dyn OverlayStorage + Send>>>,
        mut state: OverlayState,
    ) -> Result<Self, Errno> {
        if let Some(checkpoint) = checkpoint.as_mut() { checkpoint.discard_read_caches(); }
        let block_cache = cache_vector(CACHE_BLOCKS)?;
        let dirty_blocks = cache_vector(CACHE_BLOCKS)?;
        let dirty_sizes = DirtyFileSizes::new()?;
        let metadata_cache = cache_vector(METADATA_CACHE_ENTRIES)?;
        let size = storage.len()?;
        if size == 0 {
            if checkpoint.is_some() {
                return Err(Errno::EIO);
            }
            let mut header = [0u8; HEADER_BYTES];
            header[..4].copy_from_slice(MAGIC);
            header[4..8].copy_from_slice(&VERSION.to_le_bytes());
            header[8..40].copy_from_slice(&base_digest);
            let digest = Sha256::digest(&header[..40]);
            header[40..].copy_from_slice(&digest);
            storage.write_all_at(0, &header)?;
            storage.flush()?;
        } else {
            if size < HEADER_BYTES as u64 {
                return Err(Errno::EIO);
            }
            read_overlay_header(&mut storage, base_digest)?;
        }

        let next_sequence = checkpoint
            .as_ref()
            .map_or(1, BlockCheckpoint::next_sequence);
        let start = checkpoint
            .as_ref()
            .map_or(HEADER_BYTES as u64, BlockCheckpoint::journal_end);
        let size = storage.len()?;
        let (end, next_sequence) = replay_transactions(
            &mut storage,
            start,
            size,
            next_sequence,
            &mut state,
            ReplayFilter::All,
            true,
            checkpoint.is_some(),
            None,
            None,
        )?;
        Ok(Self {
            storage,
            base_digest,
            state,
            checkpoint,
            next_sequence,
            end,
            needs_tail_repair: end < size,
            failure: None,
            block_cache,
            dirty_blocks,
            dirty_sizes,
            metadata_cache,
            tail_limit_bytes: None,
            track_committed_state: true,
            retain_compacted_metadata: true,
            metadata_prefix_resident: false,
        })
    }

    pub fn limit_active_tail(&mut self) {
        self.tail_limit_bytes = Some(ACTIVE_TAIL_LIMIT_BYTES);
    }

    pub fn state(&self) -> &OverlayState {
        &self.state
    }

    pub(crate) fn discard_read_caches(&mut self) {
        self.block_cache.clear();
        self.metadata_cache.clear();
        if let Some(checkpoint) = self.checkpoint.as_mut() { checkpoint.discard_read_caches(); }
    }

    pub fn metadata_value(&mut self, key: &OverlayKey) -> Result<Option<Option<IoBuffer<u8>>>, Errno> {
        if matches!(key, OverlayKey::FileBlock { .. }) {
            return Err(Errno::EINVAL);
        }
        let current = self.state.entries.get(key).map(copy_stored_metadata).transpose()?;
        if !matches!(key, OverlayKey::FileZeroFrom(_)) && current.is_some() {
            return Ok(current);
        }
        let indexed_value = self.indexed_metadata_value(key)?;
        match (key, current, indexed_value) {
            (OverlayKey::FileZeroFrom(_), Some(Some(mut current)), Some(Some(indexed))) => {
                let tail =
                    u64::from_le_bytes(current.as_ref().try_into().map_err(|_| Errno::EIO)?);
                let prefix =
                    u64::from_le_bytes(indexed.as_ref().try_into().map_err(|_| Errno::EIO)?);
                current.copy_from_slice(&tail.min(prefix).to_le_bytes());
                Ok(Some(Some(current)))
            }
            (_, Some(value), _) => Ok(Some(value)),
            (_, None, value) => Ok(value),
        }
    }

    fn indexed_metadata_value(
        &mut self,
        key: &OverlayKey,
    ) -> Result<Option<Option<IoBuffer<u8>>>, Errno> {
        let Some(checkpoint) = self
            .checkpoint
            .as_mut()
            .filter(|checkpoint| checkpoint.has_metadata_index())
        else {
            return Ok(None);
        };
        if let Some(position) = self
            .metadata_cache
            .iter()
            .position(|cached| &cached.key == key)
        {
            let result = allocate_after_read_cache_reclaim(
                || copy_cached_metadata(&self.metadata_cache[position].value),
                || checkpoint.reclaim_supplemental_read_cache(),
            )?;
            let cached = self.metadata_cache.remove(position);
            push_cache(&mut self.metadata_cache, cached, METADATA_CACHE_ENTRIES);
            return Ok(result);
        }
        let indexed = checkpoint.lookup_metadata(key)?;
        let result = match indexed {
            Some(entry) => {
                let mut bytes = IoBuffer::new();
                Some(read_indexed_metadata_admitted(&mut self.storage, &entry, &mut bytes,
                    || checkpoint.reclaim_supplemental_read_cache())?.then_some(bytes))
            }
            None => None,
        };
        let name_bytes = match key { OverlayKey::Dirent { name, .. } => name.len(), _ => 0 };
        let value_bytes = result.as_ref().and_then(Option::as_ref).map_or(0, |bytes| bytes.len());
        let mut reservation = loop {
            match reserve_payload(name_bytes + value_bytes, false) {
                Ok(reservation) => break reservation,
                Err(Errno::ENOMEM) if !self.metadata_cache.is_empty() => { self.metadata_cache.remove(0); }
                Err(Errno::ENOMEM) => return Ok(result),
                Err(error) => return Err(error),
            }
        };
        let cached_value = result.as_ref().map(|value| {
            value.as_ref().map(|bytes| copy_cache_bytes(bytes)).transpose()
        }).transpose()?;
        let cached_key = match key {
            OverlayKey::Dirent { parent, name } => {
                if name.len() > 255 { return Err(Errno::EINVAL); }
                OverlayKey::Dirent { parent: *parent, name: copy_cache_bytes(name)? }
            }
            _ => key.clone(),
        };
        if self.metadata_cache.len() == METADATA_CACHE_ENTRIES {
            self.metadata_cache.remove(0);
        }
        let name_capacity = match &cached_key { OverlayKey::Dirent { name, .. } => name.capacity(), _ => 0 };
        let value_capacity = cached_value.as_ref().and_then(Option::as_ref).map_or(0, Vec::capacity);
        reservation.resize((name_capacity + value_capacity).checked_mul(2).ok_or(Errno::ENOMEM)?)?;
        push_cache(&mut self.metadata_cache, CachedMetadata { key: cached_key, value: cached_value, _reservation: reservation }, METADATA_CACHE_ENTRIES);
        Ok(result)
    }

    pub fn for_each_metadata<F>(&mut self, mut visit: F) -> Result<(), Errno>
    where
        F: FnMut(&OverlayKey, Option<&[u8]>) -> Result<(), Errno>,
    {
        let mut indexed_position = 0u64;
        let mut checkpoint = self
            .checkpoint
            .as_mut()
            .filter(|checkpoint| checkpoint.has_metadata_index());
        if let Some(checkpoint) = checkpoint.as_mut() { checkpoint.reclaim_supplemental_read_cache(); }
        let mut indexed = match checkpoint.as_mut() {
            Some(ref mut checkpoint) => checkpoint.metadata_entry_at(0)?,
            None => None,
        };
        let mut tail = self.state.entries.iter().peekable();
        let mut indexed_bytes = IoBuffer::new();
        while indexed.is_some() || tail.peek().is_some() {
            let ordering = match (indexed.as_ref(), tail.peek()) {
                (Some(indexed), Some((key, _))) => indexed.key.cmp(key),
                (Some(_), None) => core::cmp::Ordering::Less,
                (None, Some(_)) => core::cmp::Ordering::Greater,
                (None, None) => break,
            };
            match ordering {
                core::cmp::Ordering::Less => {
                    let entry = indexed.as_ref().ok_or(Errno::EIO)?;
                    let value =
                        read_indexed_metadata_admitted(&mut self.storage, entry, &mut indexed_bytes,
                            || checkpoint.as_mut().is_some_and(|checkpoint| checkpoint.reclaim_supplemental_read_cache()))?
                            .then_some(indexed_bytes.as_slice());
                    visit(&entry.key, value)?;
                }
                core::cmp::Ordering::Equal => {
                    let entry = indexed.as_ref().ok_or(Errno::EIO)?;
                    let (key, value) = tail.next().ok_or(Errno::EIO)?;
                    if matches!(key, OverlayKey::FileZeroFrom(_)) {
                        if let Some(current) = value {
                            if read_indexed_metadata_admitted(&mut self.storage, entry, &mut indexed_bytes,
                                || checkpoint.as_mut().is_some_and(|checkpoint| checkpoint.reclaim_supplemental_read_cache()))?
                            {
                                let current = u64::from_le_bytes(
                                    current.as_slice().try_into().map_err(|_| Errno::EIO)?,
                                );
                                let previous = u64::from_le_bytes(
                                    indexed_bytes
                                        .as_slice()
                                        .try_into()
                                        .map_err(|_| Errno::EIO)?,
                                );
                                let merged = current.min(previous).to_le_bytes();
                                visit(key, Some(&merged))?;
                            } else {
                                return Err(Errno::EIO);
                            }
                        } else {
                            return Err(Errno::EIO);
                        }
                    } else {
                        visit(key, value.as_deref())?;
                    }
                }
                core::cmp::Ordering::Greater => {
                    let (key, value) = tail.next().ok_or(Errno::EIO)?;
                    visit(key, value.as_deref())?;
                }
            }
            if ordering != core::cmp::Ordering::Greater {
                indexed_position = indexed_position.checked_add(1).ok_or(Errno::EIO)?;
                indexed = match checkpoint.as_mut() {
                    Some(ref mut checkpoint) => checkpoint.metadata_entry_at(indexed_position)?,
                    None => None,
                };
            }
        }
        Ok(())
    }

    pub(crate) fn metadata_cursor(&mut self, value_limit: usize) -> Result<MetadataCursor, Errno> {
        let reservation = ROOTFS_METADATA.reserve_temporary(MetadataCursor::fixed_bytes())?;
        let indexed = match self.checkpoint.as_mut().filter(|checkpoint| checkpoint.has_metadata_index()) {
            Some(checkpoint) => checkpoint.metadata_entry_at(0)?,
            None => None,
        };
        Ok(MetadataCursor { revision: self.compaction_revision(), indexed_position: 0, indexed,
            last_key: None, bytes: Vec::new(), value_limit, reservation })
    }

    pub(crate) fn next_metadata<'cursor>(
        &mut self,
        cursor: &'cursor mut MetadataCursor,
    ) -> Result<Option<(&'cursor OverlayKey, Option<&'cursor [u8]>)>, Errno> {
        use core::cmp::Ordering;
        if cursor.revision != self.compaction_revision() { return Err(Errno::EBUSY); }
        let tail = match cursor.last_key.as_ref() {
            Some(key) => self.state.entries.next_after(key),
            None => self.state.entries.iter().next(),
        };
        let ordering = match (cursor.indexed.as_ref(), tail.as_ref()) {
            (Some(indexed), Some((key, _))) => indexed.key.cmp(key),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => return Ok(None),
        };
        let (key, present) = if ordering == Ordering::Less {
            let entry = cursor.indexed.as_ref().ok_or(Errno::EIO)?;
            let entry = MetadataCheckpointEntry { key: copy_metadata_key(&entry.key)?,
                value: entry.value, value_digest: entry.value_digest };
            cursor.prepare_bytes(entry.value.map_or(0, |(_, length)| length as usize))?;
            let present = read_indexed_metadata(&mut self.storage, &entry, &mut cursor.bytes)?;
            (entry.key, present)
        } else {
            let (key, value) = tail.ok_or(Errno::EIO)?;
            let key = copy_metadata_key(key)?;
            cursor.prepare_bytes(value.as_ref().map_or(0, Vec::len))?;
            if let Some(value) = value { cursor.bytes.copy_from_slice(value); }
            if ordering == Ordering::Equal && matches!(key, OverlayKey::FileZeroFrom(_)) {
                let current = u64::from_le_bytes(cursor.bytes.as_slice().try_into().map_err(|_| Errno::EIO)?);
                let entry = cursor.indexed.as_ref().ok_or(Errno::EIO)?;
                if entry.value.map(|(_, length)| length) != Some(8)
                    || !read_indexed_metadata(&mut self.storage, entry, &mut cursor.bytes)?
                { return Err(Errno::EIO); }
                let previous = u64::from_le_bytes(cursor.bytes.as_slice().try_into().map_err(|_| Errno::EIO)?);
                cursor.bytes.copy_from_slice(&current.min(previous).to_le_bytes());
            }
            (key, value.is_some())
        };
        if cursor.last_key.as_ref().is_some_and(|previous| previous >= &key) { return Err(Errno::EIO); }
        cursor.last_key = Some(key);
        if ordering != Ordering::Greater {
            cursor.indexed_position = cursor.indexed_position.checked_add(1).ok_or(Errno::EIO)?;
            cursor.indexed = None;
            cursor.indexed = match self.checkpoint.as_mut().filter(|checkpoint| checkpoint.has_metadata_index()) {
                Some(checkpoint) => checkpoint.metadata_entry_at(cursor.indexed_position)?,
                None => None,
            };
        }
        Ok(Some((cursor.last_key.as_ref().ok_or(Errno::EIO)?, present.then_some(cursor.bytes.as_slice()))))
    }

    pub fn release_checkpoint_metadata(&mut self) -> Result<(), Errno> {
        if !self.metadata_prefix_resident {
            return Ok(());
        }
        if self.checkpoint.as_ref().map(BlockCheckpoint::journal_end) != Some(self.end) {
            return Err(Errno::EBUSY);
        }
        self.state.entries.clear();
        self.metadata_prefix_resident = false;
        Ok(())
    }

    pub fn compaction_revision(&self) -> (u64, u64) {
        (self.end, self.next_sequence)
    }

    pub fn can_activate_compaction(&self, revision: (u64, u64)) -> bool {
        self.failure.is_none()
            && self.dirty_blocks.is_empty()
            && self.dirty_sizes.is_empty()
            && self.compaction_revision() == revision
    }

    pub fn validate_fixed_image_blocks<F>(&mut self, mut base_size: F) -> Result<(), Errno>
    where
        F: FnMut(u64) -> Option<u64>,
    {
        if self
            .checkpoint
            .as_ref()
            .is_some_and(BlockCheckpoint::has_metadata_index)
        {
            return Err(Errno::EIO);
        }
        self.state.validate_fixed_image_blocks(&mut base_size)?;
        if let Some(checkpoint) = self.checkpoint.as_mut() {
            for index in 0..checkpoint.count() {
                let entry = checkpoint.entry_at(index)?.ok_or(Errno::EIO)?;
                if entry.is_tombstone() {
                    return Err(Errno::EIO);
                }
                let offset = entry
                    .block
                    .checked_mul(FILE_BLOCK_BYTES as u64)
                    .ok_or(Errno::EIO)?;
                if offset >= base_size(entry.inode).ok_or(Errno::EIO)? {
                    return Err(Errno::EIO);
                }
            }
        }
        Ok(())
    }

    pub fn validate_resizable_image_blocks<F>(&mut self, mut base_size: F) -> Result<(), Errno>
    where
        F: FnMut(u64, &mut Self) -> Result<Option<u64>, Errno>,
    {
        let max_zero_block = i64::MAX as u64 / FILE_BLOCK_BYTES as u64 + 1;
        let mut cursor = self.metadata_cursor(4096)?;
        while let Some((key, value)) = self.next_metadata(&mut cursor)? {
            if matches!(key, OverlayKey::Dirent { .. } | OverlayKey::Inode(_)) {
                continue;
            }
            let value = value
                .and_then(|bytes| <[u8; 8]>::try_from(bytes).ok())
                .map(u64::from_le_bytes)
                .ok_or(Errno::EIO)?;
            let inode = match key {
                OverlayKey::FileSize(inode) if value <= i64::MAX as u64 => *inode,
                OverlayKey::FileZeroFrom(inode) if value <= max_zero_block => *inode,
                _ => return Err(Errno::EIO),
            };
            base_size(inode, self)?.ok_or(Errno::EIO)?;
        }
        drop(cursor);
        let revision = self.compaction_revision();
        let mut previous = None;
        let mut validated = None;
        loop {
            let next = match previous {
                Some(key) => self.state.blocks.next_after(&key),
                None => self.state.blocks.iter().next(),
            }.map(|(&key, _)| key);
            let Some((inode, block)) = next else { break };
            if block > i64::MAX as u64 / FILE_BLOCK_BYTES as u64 {
                return Err(Errno::EIO);
            }
            if validated != Some(inode) {
                base_size(inode, self)?.ok_or(Errno::EIO)?;
                validated = Some(inode);
            }
            if self.compaction_revision() != revision { return Err(Errno::EBUSY); }
            previous = Some((inode, block));
        }
        let count = self.checkpoint.as_ref().map_or(0, |checkpoint| checkpoint.count());
        validated = None;
        for index in 0..count {
            let entry = self.checkpoint.as_mut().ok_or(Errno::EIO)?.entry_at(index)?.ok_or(Errno::EIO)?;
            if entry.block > i64::MAX as u64 / FILE_BLOCK_BYTES as u64 {
                return Err(Errno::EIO);
            }
            if validated != Some(entry.inode) {
                base_size(entry.inode, self)?.ok_or(Errno::EIO)?;
                validated = Some(entry.inode);
            }
            if self.compaction_revision() != revision { return Err(Errno::EBUSY); }
        }
        Ok(())
    }

    pub fn checkpoint_fixed_blocks_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<BlockCheckpoint<T>, Errno> {
        self.checkpoint_blocks_into_internal(target, false)
    }

    pub fn checkpoint_blocks_with_metadata_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<BlockCheckpoint<T>, Errno> {
        self.checkpoint_blocks_into_internal(target, true)
    }

    fn checkpoint_blocks_into_internal<T: OverlayStorage>(
        &mut self,
        target: T,
        allow_metadata: bool,
    ) -> Result<BlockCheckpoint<T>, Errno> {
        self.sync()?;
        if self.checkpoint.is_some() {
            return Err(Errno::EOPNOTSUPP);
        }
        if !allow_metadata
            && (!self.state.entries.is_empty() || self.state.blocks.values().any(Option::is_none))
        {
            return Err(Errno::EINVAL);
        }
        let mut digest = Sha256::new();
        let mut bytes = [0; 64 * 1024];
        let mut offset = 0;
        while offset < self.end {
            let length = (self.end - offset).min(bytes.len() as u64) as usize;
            self.storage.read_exact_at(offset, &mut bytes[..length])?;
            digest.update(&bytes[..length]);
            offset += length as u64;
        }
        let mut block_bytes = [0; FILE_BLOCK_BYTES];
        for location in self.state.blocks.values().flatten() {
            self.storage
                .read_exact_at(location.offset, &mut block_bytes)?;
            if Sha256::digest(&block_bytes)[..] != location.digest {
                return Err(Errno::EIO);
            }
        }
        let journal_digest = digest.finalize().into();
        let mut checkpoint = if self.track_committed_state {
            let records = self
                .state
                .blocks
                .iter()
                .map(|(&(inode, block), location)| {
                    let (offset, digest) = location.map_or((0, [0; 32]), |location| {
                        (location.offset, location.digest)
                    });
                    BlockCheckpointEntry {
                        inode,
                        block,
                        offset,
                        digest,
                    }
                });
            BlockCheckpoint::create(
                target,
                self.base_digest,
                journal_digest,
                self.end,
                self.next_sequence,
                records,
            )
        } else {
            BlockCheckpoint::create_compacted_checked(
                target,
                self.base_digest,
                journal_digest,
                self.end,
                self.next_sequence,
                CompactedBlockEntries::new(
                    &mut self.storage,
                    self.end,
                    self.next_sequence,
                    allow_metadata,
                ),
            )
        }?;
        if allow_metadata && !self.track_committed_state {
            checkpoint.append_metadata_checked(CompactedMetadataEntries::new(
                &mut self.storage,
                self.end,
                self.next_sequence,
            ))?;
        }
        Ok(checkpoint)
    }

    pub fn install_fixed_block_checkpoint(
        &mut self,
        storage: Box<dyn OverlayStorage + Send>,
    ) -> Result<(), Errno> {
        let checkpoint = self.checkpoint_fixed_blocks_into(storage)?;
        self.checkpoint = Some(checkpoint);
        self.state.blocks.clear();
        self.track_committed_state = true;
        Ok(())
    }

    pub fn install_metadata_block_checkpoint(
        &mut self,
        storage: Box<dyn OverlayStorage + Send>,
    ) -> Result<(), Errno> {
        let checkpoint = self.checkpoint_blocks_with_metadata_into(storage)?;
        self.metadata_prefix_resident = checkpoint.has_metadata_index();
        self.checkpoint = Some(checkpoint);
        self.state.blocks.clear();
        self.track_committed_state = true;
        Ok(())
    }

    pub fn compact_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, true, true, true, |_, _| true)
    }

    pub fn compact_fixed_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        if !self.state.entries.is_empty()
            || self.state.blocks.values().any(Option::is_none)
            || self
                .checkpoint
                .as_ref()
                .is_some_and(BlockCheckpoint::has_metadata_index)
        {
            return Err(Errno::EIO);
        }
        self.compact_into_internal(target, false, false, false, |_, _| true)
    }

    pub fn compact_metadata_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, false, true, true, |_, _| true)
    }

    pub(crate) fn compact_metadata_reachable_into<
        T: OverlayStorage,
        F: FnMut(&OverlayKey, Option<&[u8]>) -> bool,
    >(
        &mut self,
        target: T,
        retain: F,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, false, true, false, retain)
    }

    fn compact_into_internal<T: OverlayStorage, F: FnMut(&OverlayKey, Option<&[u8]>) -> bool>(
        &mut self,
        mut target: T,
        track_committed_state: bool,
        allow_tombstones: bool,
        retain_metadata: bool,
        mut retain: F,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.sync()?;
        self.discard_read_caches();
        if target.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        let mut compacted = OverlayJournal::open(target, self.base_digest)?;
        compacted.track_committed_state = track_committed_state;
        compacted.retain_compacted_metadata = retain_metadata;
        let mut batch = MutationBatch::new(128)?;
        self.for_each_metadata(|key, value| {
            if retain(key, value) {
                let name = match key { OverlayKey::Dirent { name, .. } => name.len(), _ => 0 };
                let bytes = name.checked_add(value.map_or(0, <[u8]>::len)).ok_or(Errno::ENOMEM)?;
                batch.push_with(bytes, || Ok(match value {
                    Some(bytes) => Mutation::Put {
                        key: copy_metadata_key(key)?,
                        value: copy_transaction_bytes(bytes)?,
                    },
                    None => Mutation::Delete { key: copy_metadata_key(key)? },
                }))?;
                batch.flush_if_full(&mut compacted)?;
            }
            Ok(())
        })?;
        let mut checkpoint_position = 0;
        let mut checkpoint_entry = match self.checkpoint.as_mut() {
            Some(checkpoint) => checkpoint.entry_at(checkpoint_position)?,
            None => None,
        };
        let mut tail_entries = self.state.blocks.iter();
        let mut tail_entry = tail_entries.next();
        while checkpoint_entry.is_some() || tail_entry.is_some() {
            let take_checkpoint = match (checkpoint_entry.as_ref(), tail_entry) {
                (Some(indexed), Some((key, _))) => (indexed.inode, indexed.block) < *key,
                (Some(_), None) => true,
                _ => false,
            };
            let ((inode, block), location) = if take_checkpoint {
                let indexed = checkpoint_entry.take().ok_or(Errno::EIO)?;
                checkpoint_position += 1;
                checkpoint_entry = self
                    .checkpoint
                    .as_mut()
                    .ok_or(Errno::EIO)?
                    .entry_at(checkpoint_position)?;
                (
                    (indexed.inode, indexed.block),
                    (!indexed.is_tombstone()).then_some(BlockLocation {
                        offset: indexed.offset,
                        digest: indexed.digest,
                    }),
                )
            } else {
                let (key, location) = tail_entry.ok_or(Errno::EIO)?;
                if checkpoint_entry
                    .as_ref()
                    .is_some_and(|indexed| (indexed.inode, indexed.block) == *key)
                {
                    checkpoint_position += 1;
                    checkpoint_entry = self
                        .checkpoint
                        .as_mut()
                        .ok_or(Errno::EIO)?
                        .entry_at(checkpoint_position)?;
                }
                tail_entry = tail_entries.next();
                (*key, *location)
            };
            if take_checkpoint
                && self
                    .state
                    .invalid_checkpoint_from
                    .get(&inode)
                    .is_some_and(|from| block >= *from)
            {
                continue;
            }
            let key = OverlayKey::FileBlock { inode, block };
            if !retain(&key, None) {
                continue;
            }
            batch.push_with(if location.is_some() { FILE_BLOCK_BYTES } else { 0 }, || Ok(match location {
                Some(location) => {
                    let mut bytes = Vec::new();
                    reserve_transaction_bytes(&mut bytes, FILE_BLOCK_BYTES)?;
                    bytes.resize(FILE_BLOCK_BYTES, 0);
                    self.storage.read_exact_at(location.offset, &mut bytes)?;
                    if Sha256::digest(&bytes)[..] != location.digest {
                        return Err(Errno::EIO);
                    }
                    Mutation::Put { key, value: bytes }
                }
                None if allow_tombstones => Mutation::Delete { key },
                None => return Err(Errno::EIO),
            }))?;
            batch.flush_if_full(&mut compacted)?;
        }
        batch.flush(&mut compacted)?;
        Ok(compacted)
    }

    pub fn sync(&mut self) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.dirty_blocks.is_empty() && self.dirty_sizes.is_empty() {
            self.storage.flush()
        } else {
            self.flush_dirty()
        }
    }

    pub fn commit(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if mutations.is_empty() {
            return self.flush_dirty();
        }
        self.check_active_tail_limit()?;
        self.flush_dirty()?;
        self.check_active_tail_limit()?;
        self.commit_transaction(mutations)
    }

    pub(crate) fn commit_writeback_metadata(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        if mutations.len() > 64 || mutations.iter().any(|mutation| !matches!(mutation,
            Mutation::Put { key: OverlayKey::Inode(_), value } if value.len() <= 128)) {
            return Err(Errno::EINVAL);
        }
        self.flush_dirty()?;
        self.commit_transaction_internal(mutations, true)
    }

    fn flush_dirty(&mut self) -> Result<(), Errno> {
        if self.dirty_blocks.is_empty() && self.dirty_sizes.is_empty() {
            return Ok(());
        }
        let payload_bytes = self.dirty_blocks.iter().map(|(_, bytes)| bytes.len()).sum::<usize>()
            + self.dirty_sizes.len() * 8;
        let mut payload_credit = reserve_payload(payload_bytes, true)?;
        let mut mutations = cache_vector_in(self.dirty_blocks.len() + self.dirty_sizes.len(), true)?;
        for ((inode, block), bytes) in &self.dirty_blocks {
            mutations.push(Mutation::Put {
                key: OverlayKey::FileBlock {
                    inode: *inode,
                    block: *block,
                },
                value: copy_cache_bytes(bytes)?,
            });
        }
        for (&inode, &size) in self.dirty_sizes.iter() {
            mutations.push(Mutation::Put {
                key: OverlayKey::FileSize(inode),
                value: copy_cache_bytes(&size.to_le_bytes())?,
            });
        }
        resize_mutation_payload_credit(&mut payload_credit, &mutations)?;
        self.commit_transaction_internal(&mutations, true)?;
        self.dirty_blocks.clear();
        self.dirty_sizes.clear();
        Ok(())
    }

    pub fn visible_file_size(&mut self, inode: u64, base_size: u64) -> Result<u64, Errno> {
        if inode == 0 {
            return Err(Errno::EINVAL);
        }
        if let Some(size) = self.dirty_sizes.get(&inode) {
            return Ok(*size);
        }
        match self.metadata_value(&OverlayKey::FileSize(inode))? {
            Some(Some(bytes)) => Ok(u64::from_le_bytes(
                bytes.as_ref().try_into().map_err(|_| Errno::EIO)?,
            )),
            Some(None) | None => Ok(base_size),
        }
    }

    fn visible_zero_from(&mut self, inode: u64) -> Result<Option<u64>, Errno> {
        match self.metadata_value(&OverlayKey::FileZeroFrom(inode))? {
            Some(Some(bytes)) => Ok(Some(u64::from_le_bytes(
                bytes.as_ref().try_into().map_err(|_| Errno::EIO)?,
            ))),
            Some(None) => Err(Errno::EIO),
            None => Ok(None),
        }
    }

    fn commit_transaction(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        self.commit_transaction_internal(mutations, false)
    }

    fn commit_transaction_internal(&mut self, mutations: &[Mutation], writeback: bool) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if mutations.is_empty() {
            return Ok(());
        }
        let following_sequence = self.next_sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let transaction = encode_transaction_in(self.next_sequence, mutations, writeback)?;
        let following_end = self
            .end
            .checked_add(transaction.len() as u64)
            .ok_or(Errno::EOVERFLOW)?;
        let mut prepared = IoBuffer::new();
        if self.track_committed_state || self.retain_compacted_metadata {
            let records = decode_mutations(&transaction
                [TRANSACTION_HEADER_BYTES..transaction.len() - TRANSACTION_TRAILER_BYTES])?;
            prepared = IoBuffer::allocate(records.len(), writeback, |entries| {
                entries.try_reserve_exact(records.len()).map_err(|_| Errno::ENOMEM)
            })?;
            for record in records {
                if !self.track_committed_state && record.is_block() {
                    continue;
                }
                let value_offset = record.value_offset.map(|offset| self.end + TRANSACTION_HEADER_BYTES as u64 + offset);
                prepared.push(OverlayState::prepare_record(record, value_offset, self.checkpoint.is_some(), writeback)?);
            }
        }
        if self.needs_tail_repair {
            if let Err(error) = self.storage.truncate(self.end).and_then(|()| self.storage.flush()) {
                self.failure = Some(error);
                return Err(error);
            }
            self.needs_tail_repair = false;
        }
        if let Err(error) = self
            .storage
            .write_all_at(self.end, &transaction)
            .and_then(|()| self.storage.flush())
        {
            self.failure = Some(error);
            return Err(error);
        }
        for mutation in prepared {
            match &mutation {
                PreparedOverlayMutation::Block(entry) => {
                    self.block_cache.retain(|(cached, _)| cached != entry.key());
                }
                PreparedOverlayMutation::Zero { inode, block, .. } => {
                    self.block_cache.retain(|((owner, cached), _)| owner != inode || cached < block);
                }
                _ => {}
            }
            self.state.publish(mutation);
        }
        self.end = following_end;
        self.next_sequence = following_sequence;
        Ok(())
    }

    pub fn write_fixed_file_at_buffered<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        read_base: F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        self.write_buffered_file_at(inode, base_size, offset, src, read_base, true)
    }

    pub fn write_file_at_buffered<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        read_base: F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        self.write_buffered_file_at(inode, base_size, offset, src, read_base, false)
    }

    fn write_buffered_file_at<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        mut read_base: F,
        fixed_size: bool,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if src.is_empty() {
            return Ok(0);
        }
        self.check_active_tail_limit()?;
        let end = offset.checked_add(src.len() as u64).ok_or(Errno::EFBIG)?;
        if fixed_size && end > base_size {
            return Err(Errno::EFBIG);
        }
        let block_count =
            (end - 1) / FILE_BLOCK_BYTES as u64 - offset / FILE_BLOCK_BYTES as u64 + 1;
        if block_count > CACHE_BLOCKS as u64 {
            let mut done = 0;
            while done < src.len() {
                if let Err(error) = self.check_active_tail_limit() {
                    return if done > 0 { Ok(done) } else { Err(error) };
                }
                let position = offset + done as u64;
                let within_block = position as usize % FILE_BLOCK_BYTES;
                let chunk = (src.len() - done).min(CACHE_BLOCKS * FILE_BLOCK_BYTES - within_block);
                match self.write_buffered_file_chunk(
                    inode,
                    base_size,
                    position,
                    &src[done..done + chunk],
                    &mut read_base,
                    fixed_size,
                ) {
                    Ok(written) => done += written,
                    Err(_) if done > 0 => return Ok(done),
                    Err(error) => return Err(error),
                }
            }
            return Ok(done);
        }
        self.write_buffered_file_chunk(inode, base_size, offset, src, &mut read_base, fixed_size)
    }

    fn write_buffered_file_chunk<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        read_base: &mut F,
        fixed_size: bool,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        if crate::prepared_map::writeback_reserve_in_use() { return Err(Errno::ENOMEM); }
        self.check_active_tail_limit()?;
        let end = offset + src.len() as u64;
        let grows = !fixed_size && end > self.visible_file_size(inode, base_size)?;
        if grows && !self.dirty_sizes.contains_key(&inode) && self.dirty_sizes.len() == CACHE_BLOCKS
        {
            self.flush_dirty()?;
        }
        let block_count =
            (end - 1) / FILE_BLOCK_BYTES as u64 - offset / FILE_BLOCK_BYTES as u64 + 1;
        let mut prepared = cache_vector(block_count as usize)?;
        let mut done = 0usize;
        while done < src.len() {
            let position = offset + done as u64;
            let block = position / FILE_BLOCK_BYTES as u64;
            let block_start = block * FILE_BLOCK_BYTES as u64;
            let within_block = position as usize % FILE_BLOCK_BYTES;
            let chunk = (src.len() - done).min(FILE_BLOCK_BYTES - within_block);
            let mut bytes = zeroed_cache_block()?;
            if within_block != 0 || chunk != FILE_BLOCK_BYTES {
                self.read_file_at(inode, base_size, block_start, &mut bytes, &mut *read_base)?;
            }
            bytes[within_block..within_block + chunk].copy_from_slice(&src[done..done + chunk]);
            prepared.push(((inode, block), bytes));
            done += chunk;
        }
        let new_blocks = prepared
            .iter()
            .filter(|(key, _)| !self.dirty_blocks.iter().any(|(cached, _)| cached == key))
            .count();
        if self.dirty_blocks.len() + new_blocks > CACHE_BLOCKS {
            let required = self.dirty_blocks.len() + new_blocks - CACHE_BLOCKS;
            let count = required.max(CACHE_BLOCKS / 4);
            let mut victims = cache_vector(count)?;
            for (key, _) in self.dirty_blocks
                .iter()
                .filter(|(key, _)| !prepared.iter().any(|(prepared_key, _)| prepared_key == key))
                .take(count)
            { victims.push(*key); }
            if victims.len() < required {
                return Err(Errno::EIO);
            }
            let payload_bytes = victims.len() * FILE_BLOCK_BYTES + self.dirty_sizes.len() * 8;
            let mut payload_credit = reserve_payload(payload_bytes, true)?;
            let mut mutations = cache_vector_in(victims.len() + self.dirty_sizes.len(), true)?;
            for (key, bytes) in &self.dirty_blocks {
                if !victims.contains(key) { continue; }
                mutations.push(Mutation::Put {
                    key: OverlayKey::FileBlock {
                        inode: key.0,
                        block: key.1,
                    },
                    value: copy_cache_bytes(bytes)?,
                });
            }
            for (&owner, &size) in self.dirty_sizes.iter() {
                if victims.iter().any(|key| key.0 == owner) {
                    mutations.push(Mutation::Put {
                        key: OverlayKey::FileSize(owner),
                        value: copy_cache_bytes(&size.to_le_bytes())?,
                    });
                }
            }
            resize_mutation_payload_credit(&mut payload_credit, &mutations)?;
            self.commit_transaction_internal(&mutations, true)?;
            self.dirty_blocks
                .retain(|(key, _)| !victims.contains(key));
            self.dirty_sizes
                .retain(|owner, _| !victims.iter().any(|key| key.0 == *owner));
        }
        if crate::prepared_map::writeback_reserve_in_use() { return Err(Errno::ENOMEM); }
        for (key, bytes) in prepared {
            self.block_cache.retain(|(cached, _)| *cached != key);
            if let Some(index) = self
                .dirty_blocks
                .iter()
                .position(|(cached, _)| *cached == key)
            {
                self.dirty_blocks.remove(index);
            }
            push_cache(&mut self.dirty_blocks, (key, bytes), CACHE_BLOCKS);
        }
        if grows {
            self.dirty_sizes.insert(inode, end);
        }
        Ok(src.len())
    }

    fn check_active_tail_limit(&self) -> Result<(), Errno> {
        let Some(limit) = self.tail_limit_bytes else {
            return Ok(());
        };
        let prefix_end = self
            .checkpoint
            .as_ref()
            .map_or(HEADER_BYTES as u64, BlockCheckpoint::journal_end);
        if self.end.saturating_sub(prefix_end) >= limit {
            Err(Errno::ENOSPC)
        } else {
            Ok(())
        }
    }

    pub fn write_file_at<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        mut read_base: F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let size = self.visible_file_size(inode, base_size)?;
        if src.is_empty() {
            return Ok(0);
        }
        let end = offset.checked_add(src.len() as u64).ok_or(Errno::EFBIG)?;
        let block_count =
            (end - 1) / FILE_BLOCK_BYTES as u64 - offset / FILE_BLOCK_BYTES as u64 + 1;
        let size_record_bytes = if end > size { 31 } else { 0 };
        let available = MAX_TRANSACTION_BYTES
            - TRANSACTION_HEADER_BYTES
            - TRANSACTION_TRAILER_BYTES
            - size_record_bytes;
        if block_count > (available / (FILE_BLOCK_BYTES + 23)) as u64 {
            return Err(Errno::EFBIG);
        }
        let mut batch = MutationBatch::new(block_count as usize + usize::from(end > size))?;
        let mut done = 0usize;
        while done < src.len() {
            let position = offset.checked_add(done as u64).ok_or(Errno::EFBIG)?;
            let block = position / FILE_BLOCK_BYTES as u64;
            let block_start = block
                .checked_mul(FILE_BLOCK_BYTES as u64)
                .ok_or(Errno::EFBIG)?;
            let within_block = position as usize % FILE_BLOCK_BYTES;
            let chunk = (src.len() - done).min(FILE_BLOCK_BYTES - within_block);
            batch.push_with(FILE_BLOCK_BYTES, || {
                let mut bytes = Vec::new();
                reserve_transaction_bytes(&mut bytes, FILE_BLOCK_BYTES)?;
                bytes.resize(FILE_BLOCK_BYTES, 0);
                if within_block != 0 || chunk != FILE_BLOCK_BYTES {
                    self.read_file_at(inode, base_size, block_start, &mut bytes, &mut read_base)?;
                }
                bytes[within_block..within_block + chunk].copy_from_slice(&src[done..done + chunk]);
                Ok(Mutation::Put { key: OverlayKey::FileBlock { inode, block }, value: bytes })
            })?;
            done += chunk;
        }
        if end > size {
            batch.push_with(8, || Ok(Mutation::Put {
                key: OverlayKey::FileSize(inode),
                value: copy_transaction_bytes(&end.to_le_bytes())?,
            }))?;
        }
        self.commit(&batch.mutations)?;
        Ok(src.len())
    }

    pub fn truncate_file_at<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        new_size: u64,
        read_base: F,
    ) -> Result<(), Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        self.truncate_file_at_with_base_tail(inode, base_size, new_size, true, read_base)
    }

    pub(crate) fn truncate_file_at_with_base_tail<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        new_size: u64,
        base_tail_allocated: bool,
        mut read_base: F,
    ) -> Result<(), Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let old_size = self.visible_file_size(inode, base_size)?;
        if new_size == old_size {
            return Ok(());
        }
        let mut batch = MutationBatch::new(3)?;
        if new_size < old_size {
            let block = new_size / FILE_BLOCK_BYTES as u64;
            let remainder = (new_size % FILE_BLOCK_BYTES as u64) as usize;
            let clear_from = block + u64::from(remainder != 0);
            batch.push_with(8, || Ok(Mutation::Put {
                key: OverlayKey::FileZeroFrom(inode),
                value: copy_transaction_bytes(&clear_from.to_le_bytes())?,
            }))?;
            if remainder != 0 && self.first_composed_file_block(
                inode, base_size, old_size,
                if base_tail_allocated { None } else { Some(&[]) },
                block..block + 1,
            )?.is_some() {
                batch.push_with(FILE_BLOCK_BYTES, || {
                    let mut bytes = Vec::new();
                    reserve_transaction_bytes(&mut bytes, FILE_BLOCK_BYTES)?;
                    bytes.resize(FILE_BLOCK_BYTES, 0);
                    self.read_file_at(inode, base_size, block * FILE_BLOCK_BYTES as u64,
                        &mut bytes, &mut read_base)?;
                    bytes[remainder..].fill(0);
                    Ok(Mutation::Put { key: OverlayKey::FileBlock { inode, block }, value: bytes })
                })?;
            }
        }
        batch.push_with(8, || Ok(Mutation::Put {
            key: OverlayKey::FileSize(inode),
            value: copy_transaction_bytes(&new_size.to_le_bytes())?,
        }))?;
        self.commit(&batch.mutations)
    }

    pub fn read_file_at<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        dst: &mut [u8],
        mut read_base: F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        let size = self.visible_file_size(inode, base_size)?;
        if offset >= size {
            return Ok(0);
        }
        let available = usize::try_from(size - offset).unwrap_or(usize::MAX);
        let limit = dst.len().min(available);
        let mut done = 0usize;
        while done < limit {
            let position = offset.checked_add(done as u64).ok_or(Errno::EOVERFLOW)?;
            let block = position / FILE_BLOCK_BYTES as u64;
            let within_block = position as usize % FILE_BLOCK_BYTES;
            let chunk = (limit - done).min(FILE_BLOCK_BYTES - within_block);
            let target = &mut dst[done..done + chunk];
            if let Some(index) = self
                .dirty_blocks
                .iter()
                .position(|(cached, _)| *cached == (inode, block))
            {
                let cached = self.dirty_blocks.remove(index);
                target.copy_from_slice(&cached.1[within_block..within_block + chunk]);
                push_cache(&mut self.dirty_blocks, cached, CACHE_BLOCKS);
                done += chunk;
                continue;
            }
            match self.block_location(inode, block)? {
                Some(Some(location)) => {
                    self.read_cached_block((inode, block), location, within_block, target)?;
                }
                Some(None) => target.fill(0),
                None => {
                    let base_visible = self
                        .visible_zero_from(inode)?
                        .is_none_or(|from| block < from);
                    let from_base = if base_visible && position < base_size {
                        usize::try_from(base_size - position)
                            .unwrap_or(usize::MAX)
                            .min(chunk)
                    } else {
                        0
                    };
                    let mut read = 0usize;
                    while read < from_base {
                        let at = position.checked_add(read as u64).ok_or(Errno::EOVERFLOW)?;
                        let count = read_base(at, &mut target[read..from_base])?;
                        if count == 0 || count > from_base - read {
                            return Err(Errno::EIO);
                        }
                        read += count;
                    }
                    target[from_base..].fill(0);
                }
            }
            done += chunk;
        }
        Ok(done)
    }

    pub fn allocated_file_blocks(&mut self, inode: u64, size: u64) -> Result<Vec<u32>, Errno> {
        let mut blocks = Vec::new();
        self.for_each_composed_file_block(inode, 0, size, Some(&[]), |block| {
            blocks.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            blocks.push(block);
            Ok(())
        })?;
        Ok(blocks)
    }

    pub fn composed_file_blocks(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: &[u32],
    ) -> Result<Vec<u32>, Errno> {
        self.collect_composed_file_blocks(inode, base_size, size, Some(base_blocks))
    }

    pub fn composed_dense_file_blocks(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
    ) -> Result<Vec<u32>, Errno> {
        self.collect_composed_file_blocks(inode, base_size, size, None)
    }

    fn collect_composed_file_blocks(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: Option<&[u32]>,
    ) -> Result<Vec<u32>, Errno> {
        let mut blocks = Vec::new();
        self.for_each_composed_file_block(inode, base_size, size, base_blocks, |block| {
            blocks.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            blocks.push(block);
            Ok(())
        })?;
        Ok(blocks)
    }

    pub fn for_each_composed_file_block(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: Option<&[u32]>,
        mut visit: impl FnMut(u32) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if base_blocks.is_some_and(|blocks| blocks.windows(2).any(|pair| pair[0] >= pair[1])) {
            return Err(Errno::EINVAL);
        }
        self.visit_composed_file_blocks(inode, base_size, size, base_blocks,
            0..size.div_ceil(FILE_BLOCK_BYTES as u64), |block| { visit(block)?; Ok(true) })
    }

    pub(crate) fn first_composed_file_block(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: Option<&[u32]>,
        range: core::ops::Range<u64>,
    ) -> Result<Option<u32>, Errno> {
        let mut first = None;
        self.visit_composed_file_blocks(inode, base_size, size, base_blocks, range, |block| {
            first = Some(block);
            Ok(false)
        })?;
        Ok(first)
    }

    pub(crate) fn recorded_error(&self) -> Option<Errno> {
        self.failure
    }

    pub(crate) fn has_pending_writeback(&self) -> bool {
        !self.dirty_blocks.is_empty() || !self.dirty_sizes.is_empty()
    }

    fn visit_composed_file_blocks(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: Option<&[u32]>,
        range: core::ops::Range<u64>,
        visit: impl FnMut(u32) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        let mut base_index = base_blocks.map_or(range.start,
            |blocks| blocks.partition_point(|block| u64::from(*block) < range.start) as u64);
        self.visit_composed_file_blocks_from(inode, base_size, size, range, || {
            let block = match base_blocks {
                Some(blocks) => blocks.get(base_index as usize).copied(),
                None => Some(u32::try_from(base_index).map_err(|_| Errno::EFBIG)?),
            };
            base_index += 1;
            Ok(block)
        }, visit)
    }

    pub(crate) fn visit_composed_file_blocks_from(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        range: core::ops::Range<u64>,
        mut next_base: impl FnMut() -> Result<Option<u32>, Errno>,
        mut visit: impl FnMut(u32) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if inode == 0 || range.start > range.end {
            return Err(Errno::EINVAL);
        }
        let limit = range.end.min(size.div_ceil(FILE_BLOCK_BYTES as u64));
        if range.start >= limit {
            return Ok(());
        }
        let zero_from = if base_size == 0 { None } else { self.visible_zero_from(inode)? };
        let invalid_from = self.state.invalid_checkpoint_from.get(&inode).copied();
        let base_limit = base_size.min(size).div_ceil(FILE_BLOCK_BYTES as u64)
            .min(limit)
            .min(zero_from.unwrap_or(u64::MAX))
            .min(invalid_from.unwrap_or(u64::MAX));
        let mut previous_base = None;
        let mut advance_base = || -> Result<Option<u64>, Errno> {
            if base_limit <= range.start { return Ok(None); }
            let Some(block) = next_base()? else { return Ok(None) };
            let block = u64::from(block);
            if block < range.start || previous_base.is_some_and(|previous| block <= previous) {
                return Err(Errno::EINVAL);
            }
            previous_base = Some(block);
            Ok((block < base_limit).then_some(block))
        };
        let mut base_block = advance_base()?;
        let mut dirty = [0u64; CACHE_BLOCKS];
        let mut dirty_count = 0;
        for &((owner, block), _) in &self.dirty_blocks {
            if owner == inode && block >= range.start && block < limit {
                *dirty.get_mut(dirty_count).ok_or(Errno::EIO)? = block;
                dirty_count += 1;
            }
        }
        dirty[..dirty_count].sort_unstable();
        let mut dirty_index = 0;
        let mut tail = self.state.blocks.range((inode, range.start)..(inode, limit)).peekable();
        let mut checkpoint = self.checkpoint.as_mut();
        let mut checkpoint_index = if let Some(checkpoint) = checkpoint.as_mut() {
            let mut low = 0;
            let mut high = checkpoint.count();
            while low < high {
                let middle = low + (high - low) / 2;
                let entry = checkpoint.entry_at(middle)?.ok_or(Errno::EIO)?;
                if (entry.inode, entry.block) < (inode, range.start) {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            low
        } else {
            0
        };
        let mut next_checkpoint = || -> Result<Option<BlockCheckpointEntry>, Errno> {
            let Some(checkpoint) = checkpoint.as_mut() else { return Ok(None) };
            if checkpoint_index >= checkpoint.count() {
                return Ok(None);
            }
            let entry = checkpoint.entry_at(checkpoint_index)?.ok_or(Errno::EIO)?;
            checkpoint_index += 1;
            Ok((entry.inode == inode && entry.block < limit).then_some(entry))
        };
        let mut indexed = next_checkpoint()?;
        loop {
            let tail_block = tail.peek().map(|entry| entry.0.1);
            let dirty_block = (dirty_index < dirty_count).then(|| dirty[dirty_index]);
            let indexed_block = indexed.as_ref().map(|entry| entry.block);
            let Some(block) = [tail_block, dirty_block, indexed_block, base_block]
                .into_iter().flatten().min() else { break };
            let dirty_matches = dirty_block == Some(block);
            while dirty_index < dirty_count && dirty[dirty_index] == block {
                dirty_index += 1;
            }
            let tail_value = if tail_block == Some(block) {
                Some(tail.next().ok_or(Errno::EIO)?.1.is_some())
            } else {
                None
            };
            let indexed_value = if indexed_block == Some(block) {
                let entry = indexed.take().ok_or(Errno::EIO)?;
                indexed = next_checkpoint()?;
                Some(!entry.is_tombstone() && invalid_from.is_none_or(|from| block < from))
            } else {
                None
            };
            let base_matches = base_block == Some(block);
            if dirty_matches || tail_value.or(indexed_value).unwrap_or(base_matches) {
                if !visit(u32::try_from(block).map_err(|_| Errno::EFBIG)?)? {
                    break;
                }
            }
            if base_matches {
                base_block = advance_base()?;
            }
        }
        Ok(())
    }

    pub fn dense_base_needs_sparse_export(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
    ) -> Result<bool, Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if inode == 0 {
            return Err(Errno::EINVAL);
        }
        if size > base_size || self.visible_zero_from(inode)?.is_some() {
            return Ok(true);
        }
        let limit = size.div_ceil(FILE_BLOCK_BYTES as u64);
        if self
            .state
            .blocks
            .range((inode, 0)..(inode, limit))
            .any(|(_, location)| location.is_none())
        {
            return Ok(true);
        }
        if let Some(checkpoint) = self.checkpoint.as_mut() {
            let mut low = 0;
            let mut high = checkpoint.count();
            while low < high {
                let middle = low + (high - low) / 2;
                let entry = checkpoint.entry_at(middle)?.ok_or(Errno::EIO)?;
                if entry.inode < inode {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            for index in low..checkpoint.count() {
                let entry = checkpoint.entry_at(index)?.ok_or(Errno::EIO)?;
                if entry.inode != inode || entry.block >= limit {
                    break;
                }
                if entry.is_tombstone()
                    && !self.state.blocks.contains_key(&(inode, entry.block))
                    && self
                        .state
                        .invalid_checkpoint_from
                        .get(&inode)
                        .is_none_or(|from| entry.block < *from)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn block_location(
        &mut self,
        inode: u64,
        block: u64,
    ) -> Result<Option<Option<BlockLocation>>, Errno> {
        if let Some(location) = self.state.blocks.get(&(inode, block)) {
            return Ok(Some(*location));
        }
        if self
            .state
            .invalid_checkpoint_from
            .get(&inode)
            .is_some_and(|from| block >= *from)
        {
            return Ok(Some(None));
        }
        match self.checkpoint.as_mut() {
            Some(checkpoint) => Ok(checkpoint.lookup(inode, block)?.map(|entry| {
                (!entry.is_tombstone()).then_some(BlockLocation {
                    offset: entry.offset,
                    digest: entry.digest,
                })
            })),
            None => Ok(None),
        }
    }

    fn read_cached_block(
        &mut self,
        key: (u64, u64),
        location: BlockLocation,
        within_block: usize,
        target: &mut [u8],
    ) -> Result<(), Errno> {
        if let Some(index) = self
            .block_cache
            .iter()
            .position(|(cached, _)| *cached == key)
        {
            let cached = self.block_cache.remove(index);
            target.copy_from_slice(&cached.1[within_block..within_block + target.len()]);
            push_cache(&mut self.block_cache, cached, CACHE_BLOCKS);
            return Ok(());
        }
        let mut block = loop {
            match zeroed_cache_block() {
                Ok(block) => break block,
                Err(Errno::ENOMEM) if self.checkpoint.as_mut().is_some_and(|checkpoint| checkpoint.reclaim_supplemental_read_cache()) => {}
                Err(Errno::ENOMEM) if !self.block_cache.is_empty() => { self.block_cache.remove(0); }
                Err(error) => return Err(error),
            }
        };
        self.storage.read_exact_at(location.offset, &mut block)?;
        if Sha256::digest(&block)[..] != location.digest {
            return Err(Errno::EIO);
        }
        target.copy_from_slice(&block[within_block..within_block + target.len()]);
        if self.block_cache.len() == CACHE_BLOCKS {
            self.block_cache.remove(0);
        }
        push_cache(&mut self.block_cache, (key, block), CACHE_BLOCKS);
        Ok(())
    }

    pub fn into_storage(self) -> S {
        self.storage
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
struct LegacyBlockReference {
    inode: u64,
    block: u64,
    order: u64,
    offset: u64,
    digest: [u8; 32],
}

impl LegacyBlockReference {
    fn encode(self) -> [u8; LEGACY_SORT_RECORD_BYTES as usize] {
        let mut bytes = [0; LEGACY_SORT_RECORD_BYTES as usize];
        bytes[0..8].copy_from_slice(&self.inode.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.block.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.order.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.offset.to_le_bytes());
        bytes[32..64].copy_from_slice(&self.digest);
        let checksum = Sha256::digest(&bytes[..64]);
        bytes[64..96].copy_from_slice(&checksum);
        bytes
    }

    fn decode(bytes: [u8; LEGACY_SORT_RECORD_BYTES as usize]) -> Result<Self, Errno> {
        if bytes[64..96] != Sha256::digest(&bytes[..64])[..] {
            return Err(Errno::EIO);
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[32..64]);
        Ok(Self {
            inode: u64::from_le_bytes(bytes[0..8].try_into().map_err(|_| Errno::EIO)?),
            block: u64::from_le_bytes(bytes[8..16].try_into().map_err(|_| Errno::EIO)?),
            order: u64::from_le_bytes(bytes[16..24].try_into().map_err(|_| Errno::EIO)?),
            offset: u64::from_le_bytes(bytes[24..32].try_into().map_err(|_| Errno::EIO)?),
            digest,
        })
    }
}

#[cfg(test)]
fn legacy_record_at<S: OverlayStorage>(
    storage: &mut S,
    position: u64,
) -> Result<LegacyBlockReference, Errno> {
    let offset = position
        .checked_mul(LEGACY_SORT_RECORD_BYTES)
        .ok_or(Errno::EOVERFLOW)?;
    let mut bytes = [0; LEGACY_SORT_RECORD_BYTES as usize];
    storage.read_exact_at(offset, &mut bytes)?;
    LegacyBlockReference::decode(bytes)
}

struct LegacyReadCursor {
    position: u64,
    end: u64,
    buffered_from: u64,
    buffered_count: u64,
    buffer: IoBuffer<u8>,
}

impl LegacyReadCursor {
    fn new() -> Result<Self, Errno> {
        let buffer = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)?;
        Ok(Self {
            position: 0,
            end: 0,
            buffered_from: 0,
            buffered_count: 0,
            buffer,
        })
    }

    fn reset(&mut self, start: u64, end: u64) {
        self.position = start;
        self.end = end;
        self.buffered_count = 0;
    }

    fn next<S: OverlayStorage>(
        &mut self,
        storage: &mut S,
    ) -> Result<Option<LegacyBlockReference>, Errno> {
        if self.position == self.end {
            return Ok(None);
        }
        if self.buffered_count == 0 || self.position >= self.buffered_from + self.buffered_count {
            self.buffered_from = self.position;
            self.buffered_count = (self.end - self.position).min(LEGACY_SORT_IO_RECORDS as u64);
            let length = self.buffered_count as usize * LEGACY_SORT_RECORD_BYTES as usize;
            self.buffer.resize(length, 0);
            storage.read_exact_at(
                self.position.checked_mul(LEGACY_SORT_RECORD_BYTES).ok_or(Errno::EOVERFLOW)?,
                &mut self.buffer,
            )?;
        }
        let start =
            (self.position - self.buffered_from) as usize * LEGACY_SORT_RECORD_BYTES as usize;
        let mut bytes = [0; LEGACY_SORT_RECORD_BYTES as usize];
        bytes.copy_from_slice(&self.buffer[start..start + LEGACY_SORT_RECORD_BYTES as usize]);
        self.position += 1;
        LegacyBlockReference::decode(bytes).map(Some)
    }
}

fn merge_legacy_runs<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut T,
    count: u64,
    width: u64,
) -> Result<(), Errno> {
    target.truncate(0)?;
    let mut left_cursor = LegacyReadCursor::new()?;
    let mut right_cursor = LegacyReadCursor::new()?;
    let mut output = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)?;
    let mut output_offset = 0u64;
    let mut start = 0u64;
    while start < count {
        let middle = start.saturating_add(width).min(count);
        let end = middle.saturating_add(width).min(count);
        left_cursor.reset(start, middle);
        right_cursor.reset(middle, end);
        let mut left = left_cursor.next(source)?;
        let mut right = right_cursor.next(source)?;
        for _ in start..end {
            let take_left = match (left, right) {
                (Some(left), Some(right)) => left <= right,
                (Some(_), None) => true,
                _ => false,
            };
            let selected = if take_left {
                let selected = left.ok_or(Errno::EIO)?;
                left = left_cursor.next(source)?;
                selected
            } else {
                let selected = right.ok_or(Errno::EIO)?;
                right = right_cursor.next(source)?;
                selected
            };
            output.extend_from_slice(&selected.encode());
            if output.len() == LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize {
                target.write_all_at(output_offset, &output)?;
                output_offset = output_offset.checked_add(output.len() as u64).ok_or(Errno::EOVERFLOW)?;
                output.clear();
            }
        }
        start = end;
    }
    if !output.is_empty() {
        target.write_all_at(output_offset, &output)?;
    }
    target.flush()
}

fn sort_legacy_block_references<S: OverlayStorage, T: OverlayStorage>(
    scratch: &mut S,
    target: &mut T,
    count: u64,
) -> Result<(), Errno> {
    let mut run = scratch_vector(LEGACY_SORT_RUN_RECORDS)?;
    let mut reader = LegacyReadCursor::new()?;
    let mut bytes = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)?;
    bytes.resize(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize, 0);
    let mut start = 0u64;
    while start < count {
        let length = (count - start).min(LEGACY_SORT_RUN_RECORDS as u64) as usize;
        run.clear();
        reader.reset(start, start + length as u64);
        while let Some(record) = reader.next(scratch)? {
            run.push(record);
        }
        run.sort_unstable();
        for (index, records) in run.chunks(LEGACY_SORT_IO_RECORDS).enumerate() {
            for (position, record) in records.iter().enumerate() {
                let start = position * LEGACY_SORT_RECORD_BYTES as usize;
                bytes[start..start + LEGACY_SORT_RECORD_BYTES as usize].copy_from_slice(&record.encode());
            }
            scratch.write_all_at(
                (start + index as u64 * LEGACY_SORT_IO_RECORDS as u64)
                    .checked_mul(LEGACY_SORT_RECORD_BYTES).ok_or(Errno::EOVERFLOW)?,
                &bytes[..records.len() * LEGACY_SORT_RECORD_BYTES as usize],
            )?;
        }
        start += length as u64;
    }
    scratch.flush()?;
    drop(bytes);
    drop(reader);
    drop(run);
    let mut width = LEGACY_SORT_RUN_RECORDS as u64;
    let mut sorted_in_scratch = true;
    while width < count {
        if sorted_in_scratch {
            merge_legacy_runs(scratch, target, count, width)?;
        } else {
            merge_legacy_runs(target, scratch, count, width)?;
        }
        sorted_in_scratch = !sorted_in_scratch;
        width = width.saturating_mul(2);
    }
    if !sorted_in_scratch {
        let mut buffer = scratch_vector(64 * 1024)?;
        buffer.resize(64 * 1024, 0);
        let total_bytes = count.checked_mul(LEGACY_SORT_RECORD_BYTES).ok_or(Errno::EOVERFLOW)?;
        let mut offset = 0;
        while offset < total_bytes {
            let length = (total_bytes - offset).min(buffer.len() as u64) as usize;
            target.read_exact_at(offset, &mut buffer[..length])?;
            scratch.write_all_at(offset, &buffer[..length])?;
            offset += length as u64;
        }
        scratch.flush()?;
    }
    target.truncate(0)?;
    target.flush()
}

fn emit_legacy_block<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut OverlayJournal<T>,
    batch: &mut MutationBatch,
    reference: LegacyBlockReference,
) -> Result<(), Errno> {
    batch.push_with(FILE_BLOCK_BYTES, || {
        let mut value = Vec::new();
        reserve_transaction_bytes(&mut value, FILE_BLOCK_BYTES)?;
        value.resize(FILE_BLOCK_BYTES, 0);
        source.read_exact_at(reference.offset, &mut value)?;
        if Sha256::digest(&value)[..] != reference.digest { return Err(Errno::EIO); }
        Ok(Mutation::Put {
            key: OverlayKey::FileBlock { inode: reference.inode, block: reference.block }, value,
        })
    })?;
    batch.flush_if_full(target)
}

pub fn convert_unindexed_fixed_journal<S: OverlayStorage, T: OverlayStorage, I: OverlayStorage>(
    source: &mut S,
    mut target: T,
    mut scratch: I,
    base_digest: [u8; 32],
) -> Result<(T, I), Errno> {
    let source_length = source.len()?;
    if source_length < HEADER_BYTES as u64 || target.len()? != 0 || scratch.len()? != 0 {
        return Err(Errno::EINVAL);
    }
    read_overlay_header(source, base_digest)?;
    let mut count = 0u64;
    let mut record_buffer = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)?;
    let mut record_write_offset = 0u64;
    let mut record = |mutation: &DecodedMutation<'_>, value_offset: Option<u64>| {
        if !mutation.is_block() { return Err(Errno::EIO); }
        let value = mutation.value.ok_or(Errno::EIO)?;
        let reference = LegacyBlockReference {
            inode: mutation.inode,
            block: mutation.block,
            order: count,
            offset: value_offset.ok_or(Errno::EIO)?,
            digest: Sha256::digest(value).into(),
        };
        record_buffer.extend_from_slice(&reference.encode());
        if record_buffer.len() == LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize {
            scratch.write_all_at(record_write_offset, &record_buffer)?;
            record_write_offset = record_write_offset.checked_add(record_buffer.len() as u64).ok_or(Errno::EOVERFLOW)?;
            record_buffer.clear();
        }
        count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    };
    replay_transactions(
        source,
        HEADER_BYTES as u64,
        source_length,
        1,
        &mut OverlayState::default(),
        ReplayFilter::VerifyOnly,
        true,
        false,
        None,
        Some(&mut record),
    )?;
    if !record_buffer.is_empty() {
        scratch.write_all_at(record_write_offset, &record_buffer)?;
    }
    scratch.flush()?;
    drop(record_buffer);
    sort_legacy_block_references(&mut scratch, &mut target, count)?;
    let mut compacted = OverlayJournal::open(target, base_digest)?;
    compacted.track_committed_state = false;
    compacted.retain_compacted_metadata = false;
    let mut batch = MutationBatch::new(128)?;
    let mut pending: Option<LegacyBlockReference> = None;
    let mut reader = LegacyReadCursor::new()?;
    reader.reset(0, count);
    while let Some(reference) = reader.next(&mut scratch)? {
        if let Some(previous) = pending {
            if (previous.inode, previous.block) != (reference.inode, reference.block) {
                emit_legacy_block(source, &mut compacted, &mut batch, previous)?;
            }
        }
        pending = Some(reference);
    }
    if let Some(reference) = pending {
        emit_legacy_block(source, &mut compacted, &mut batch, reference)?;
    }
    batch.flush(&mut compacted)?;
    drop(batch);
    drop(reader);
    scratch.truncate(0)?;
    scratch.flush()?;
    let checkpoint = compacted.checkpoint_fixed_blocks_into(scratch)?;
    Ok((compacted.into_storage(), checkpoint.into_storage()))
}

#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
struct LegacyMutationReference {
    kind: u8,
    inode: u64,
    block: u64,
    marker: u8,
    name: [u8; 255],
    name_length: u8,
    order: u64,
    offset: u64,
    value_length: u32,
    digest: [u8; 32],
    deleted: bool,
}

impl LegacyMutationReference {
    fn encode(self) -> [u8; LEGACY_MUTATION_RECORD_BYTES] {
        let mut bytes = [0; LEGACY_MUTATION_RECORD_BYTES];
        bytes[0] = self.kind;
        bytes[1] = self.marker;
        bytes[2] = self.name_length;
        bytes[3] = u8::from(self.deleted);
        bytes[4..12].copy_from_slice(&self.inode.to_le_bytes());
        bytes[12..20].copy_from_slice(&self.block.to_le_bytes());
        bytes[20..28].copy_from_slice(&self.order.to_le_bytes());
        bytes[28..36].copy_from_slice(&self.offset.to_le_bytes());
        bytes[36..40].copy_from_slice(&self.value_length.to_le_bytes());
        bytes[40..72].copy_from_slice(&self.digest);
        bytes[72..327].copy_from_slice(&self.name);
        let checksum = Sha256::digest(&bytes[..352]);
        bytes[352..].copy_from_slice(&checksum);
        bytes
    }

    fn decode(bytes: [u8; LEGACY_MUTATION_RECORD_BYTES]) -> Result<Self, Errno> {
        if bytes[352..] != Sha256::digest(&bytes[..352])[..]
            || bytes[327..352].iter().any(|byte| *byte != 0)
            || bytes[0] > 4
            || bytes[1] > 1
            || bytes[3] > 1
        {
            return Err(Errno::EIO);
        }
        let name_length = bytes[2];
        let mut name = [0; 255];
        name.copy_from_slice(&bytes[72..327]);
        if name[name_length as usize..].iter().any(|byte| *byte != 0)
            || (bytes[0] == 4) != (name_length != 0)
            || (bytes[0] == 3 && bytes[1] == 0 && bytes[3] != 0)
            || (bytes[0] != 3 && bytes[1] != 0)
        {
            return Err(Errno::EIO);
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[40..72]);
        Ok(Self {
            kind: bytes[0],
            inode: u64::from_le_bytes(bytes[4..12].try_into().map_err(|_| Errno::EIO)?),
            block: u64::from_le_bytes(bytes[12..20].try_into().map_err(|_| Errno::EIO)?),
            marker: bytes[1],
            name,
            name_length,
            order: u64::from_le_bytes(bytes[20..28].try_into().map_err(|_| Errno::EIO)?),
            offset: u64::from_le_bytes(bytes[28..36].try_into().map_err(|_| Errno::EIO)?),
            value_length: u32::from_le_bytes(bytes[36..40].try_into().map_err(|_| Errno::EIO)?),
            digest,
            deleted: bytes[3] != 0,
        })
    }

    fn key(self) -> Result<OverlayKey, Errno> {
        let key = match self.kind {
            0 => OverlayKey::Inode(self.inode),
            1 => OverlayKey::FileSize(self.inode),
            2 => OverlayKey::FileZeroFrom(self.inode),
            3 if self.marker == 1 => OverlayKey::FileBlock { inode: self.inode, block: self.block },
            4 => OverlayKey::Dirent { parent: self.inode, name: copy_transaction_bytes(&self.name[..self.name_length as usize])? },
            _ => return Err(Errno::EIO),
        };
        validate_key(&key).map_err(|_| Errno::EIO)?;
        Ok(key)
    }

    fn same_key(self, other: Self) -> bool {
        self.kind == other.kind
            && self.inode == other.inode
            && self.block == other.block
            && self.marker == other.marker
            && self.name == other.name
            && self.name_length == other.name_length
    }
}

struct LegacyMutationCursor {
    position: u64,
    end: u64,
    buffered_from: u64,
    buffered_count: u64,
    buffer: IoBuffer<u8>,
}

impl LegacyMutationCursor {
    fn new() -> Result<Self, Errno> {
        let buffer = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)?;
        Ok(Self { position: 0, end: 0, buffered_from: 0, buffered_count: 0, buffer })
    }

    fn reset(&mut self, start: u64, end: u64) {
        self.position = start;
        self.end = end;
        self.buffered_count = 0;
    }

    fn next<S: OverlayStorage>(&mut self, storage: &mut S) -> Result<Option<LegacyMutationReference>, Errno> {
        if self.position == self.end {
            return Ok(None);
        }
        if self.buffered_count == 0 || self.position >= self.buffered_from + self.buffered_count {
            self.buffered_from = self.position;
            self.buffered_count = (self.end - self.position).min(LEGACY_SORT_IO_RECORDS as u64);
            self.buffer.resize(self.buffered_count as usize * LEGACY_MUTATION_RECORD_BYTES, 0);
            storage.read_exact_at(
                self.position.checked_mul(LEGACY_MUTATION_RECORD_BYTES as u64).ok_or(Errno::EOVERFLOW)?,
                &mut self.buffer,
            )?;
        }
        let start = (self.position - self.buffered_from) as usize * LEGACY_MUTATION_RECORD_BYTES;
        let mut bytes = [0; LEGACY_MUTATION_RECORD_BYTES];
        bytes.copy_from_slice(&self.buffer[start..start + LEGACY_MUTATION_RECORD_BYTES]);
        self.position += 1;
        LegacyMutationReference::decode(bytes).map(Some)
    }
}

fn merge_legacy_mutation_runs<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut T,
    count: u64,
    width: u64,
) -> Result<(), Errno> {
    target.truncate(0)?;
    let mut left_cursor = LegacyMutationCursor::new()?;
    let mut right_cursor = LegacyMutationCursor::new()?;
    let mut output = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)?;
    let mut output_offset = 0u64;
    let mut start = 0u64;
    while start < count {
        let middle = start.saturating_add(width).min(count);
        let end = middle.saturating_add(width).min(count);
        left_cursor.reset(start, middle);
        right_cursor.reset(middle, end);
        let mut left = left_cursor.next(source)?;
        let mut right = right_cursor.next(source)?;
        for _ in start..end {
            let take_left = match (left, right) {
                (Some(left), Some(right)) => left <= right,
                (Some(_), None) => true,
                _ => false,
            };
            let selected = if take_left {
                let selected = left.ok_or(Errno::EIO)?;
                left = left_cursor.next(source)?;
                selected
            } else {
                let selected = right.ok_or(Errno::EIO)?;
                right = right_cursor.next(source)?;
                selected
            };
            output.extend_from_slice(&selected.encode());
            if output.len() == LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES {
                target.write_all_at(output_offset, &output)?;
                output_offset = output_offset.checked_add(output.len() as u64).ok_or(Errno::EOVERFLOW)?;
                output.clear();
            }
        }
        start = end;
    }
    if !output.is_empty() {
        target.write_all_at(output_offset, &output)?;
    }
    target.flush()
}

fn sort_legacy_mutations<S: OverlayStorage, T: OverlayStorage>(
    scratch: &mut S,
    target: &mut T,
    count: u64,
) -> Result<(), Errno> {
    let mut run = scratch_vector(LEGACY_SORT_RUN_RECORDS)?;
    let mut reader = LegacyMutationCursor::new()?;
    let mut bytes = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)?;
    bytes.resize(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES, 0);
    let mut start = 0u64;
    while start < count {
        let length = (count - start).min(LEGACY_SORT_RUN_RECORDS as u64) as usize;
        run.clear();
        reader.reset(start, start + length as u64);
        while let Some(record) = reader.next(scratch)? {
            run.push(record);
        }
        run.sort_unstable();
        for (index, records) in run.chunks(LEGACY_SORT_IO_RECORDS).enumerate() {
            for (position, record) in records.iter().enumerate() {
                let start = position * LEGACY_MUTATION_RECORD_BYTES;
                bytes[start..start + LEGACY_MUTATION_RECORD_BYTES].copy_from_slice(&record.encode());
            }
            scratch.write_all_at(
                (start + index as u64 * LEGACY_SORT_IO_RECORDS as u64)
                    .checked_mul(LEGACY_MUTATION_RECORD_BYTES as u64).ok_or(Errno::EOVERFLOW)?,
                &bytes[..records.len() * LEGACY_MUTATION_RECORD_BYTES],
            )?;
        }
        start += length as u64;
    }
    scratch.flush()?;
    drop(bytes);
    drop(reader);
    drop(run);
    let mut width = LEGACY_SORT_RUN_RECORDS as u64;
    let mut sorted_in_scratch = true;
    while width < count {
        if sorted_in_scratch {
            merge_legacy_mutation_runs(scratch, target, count, width)?;
        } else {
            merge_legacy_mutation_runs(target, scratch, count, width)?;
        }
        sorted_in_scratch = !sorted_in_scratch;
        width = width.saturating_mul(2);
    }
    if !sorted_in_scratch {
        let mut buffer = scratch_vector(64 * 1024)?;
        buffer.resize(64 * 1024, 0);
        let total_bytes = count.checked_mul(LEGACY_MUTATION_RECORD_BYTES as u64).ok_or(Errno::EOVERFLOW)?;
        let mut offset = 0;
        while offset < total_bytes {
            let length = (total_bytes - offset).min(buffer.len() as u64) as usize;
            target.read_exact_at(offset, &mut buffer[..length])?;
            scratch.write_all_at(offset, &buffer[..length])?;
            offset += length as u64;
        }
        scratch.flush()?;
    }
    target.truncate(0)?;
    target.flush()
}

fn read_legacy_mutation_value<S: OverlayStorage>(
    source: &mut S,
    reference: LegacyMutationReference,
) -> Result<Option<Vec<u8>>, Errno> {
    if reference.deleted {
        if reference.offset != 0 || reference.value_length != 0 || reference.digest != [0; 32] {
            return Err(Errno::EIO);
        }
        return Ok(None);
    }
    let length = reference.value_length as usize;
    if length > FILE_BLOCK_BYTES || reference.offset < HEADER_BYTES as u64 {
        return Err(Errno::EIO);
    }
    let mut value = Vec::new();
    value.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
    value.resize(length, 0);
    read_legacy_mutation_bytes(source, reference, &mut value)?;
    Ok(Some(value))
}

fn read_legacy_mutation_bytes<S: OverlayStorage>(
    source: &mut S,
    reference: LegacyMutationReference,
    value: &mut [u8],
) -> Result<(), Errno> {
    if reference.deleted || reference.offset < HEADER_BYTES as u64
        || reference.value_length as usize != value.len() || value.len() > FILE_BLOCK_BYTES
    { return Err(Errno::EIO); }
    source.read_exact_at(reference.offset, value)?;
    if Sha256::digest(value)[..] != reference.digest { return Err(Errno::EIO); }
    Ok(())
}

fn emit_legacy_mutation<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut OverlayJournal<T>,
    batch: &mut MutationBatch,
    reference: LegacyMutationReference,
) -> Result<(), Errno> {
    if reference.value_length as usize > FILE_BLOCK_BYTES { return Err(Errno::EIO); }
    let bytes = reference.name_length as usize + reference.value_length as usize;
    batch.push_with(bytes, || {
        let key = reference.key()?;
        let mutation = match read_legacy_mutation_value(source, reference)? {
            Some(value) => Mutation::Put { key, value },
            None => Mutation::Delete { key },
        };
        validate_mutation(&mutation).map_err(|_| Errno::EIO)?;
        Ok(mutation)
    })?;
    batch.flush_if_full(target)
}

fn emit_legacy_zero<T: OverlayStorage>(
    target: &mut OverlayJournal<T>,
    batch: &mut MutationBatch,
    zero: (u64, u64),
) -> Result<(), Errno> {
    batch.push_with(8, || Ok(Mutation::Put {
        key: OverlayKey::FileZeroFrom(zero.0),
        value: copy_transaction_bytes(&zero.1.to_le_bytes())?,
    }))?;
    batch.flush_if_full(target)
}

fn emit_legacy_pending<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut OverlayJournal<T>,
    batch: &mut MutationBatch,
    pending: &mut Option<LegacyMutationReference>,
    latest_zero_order: Option<u64>,
) -> Result<(), Errno> {
    if let Some(reference) = pending.take() {
        if reference.kind != 3 || latest_zero_order.is_none_or(|order| reference.order > order) {
            emit_legacy_mutation(source, target, batch, reference)?;
        }
    }
    Ok(())
}

pub fn convert_unindexed_resizable_journal<S: OverlayStorage, T: OverlayStorage, I: OverlayStorage>(
    source: &mut S,
    mut target: T,
    mut scratch: I,
    base_digest: [u8; 32],
) -> Result<(T, I), Errno> {
    let source_length = source.len()?;
    if source_length < HEADER_BYTES as u64 || target.len()? != 0 || scratch.len()? != 0 {
        return Err(Errno::EINVAL);
    }
    read_overlay_header(source, base_digest)?;
    let mut count = 0u64;
    let mut order = 0u64;
    let mut record_buffer = scratch_vector(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)?;
    let mut record_write_offset = 0u64;
    let mut push_reference = |reference: LegacyMutationReference| -> Result<(), Errno> {
        record_buffer.extend_from_slice(&reference.encode());
        if record_buffer.len() == LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES {
            scratch.write_all_at(record_write_offset, &record_buffer)?;
            record_write_offset = record_write_offset.checked_add(record_buffer.len() as u64).ok_or(Errno::EOVERFLOW)?;
            record_buffer.clear();
        }
        count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    };
    let mut record = |mutation: &DecodedMutation<'_>, value_offset: Option<u64>| -> Result<(), Errno> {
        let kind = match mutation.kind {
            1 => 0,
            4 => 1,
            5 => 2,
            2 => 3,
            3 => 4,
            _ => return Err(Errno::EIO),
        };
        let (inode, block, name) = (mutation.inode, mutation.block, mutation.name);
        let (offset, value_length, digest, deleted) = match mutation.value {
            Some(value) => (
                value_offset.ok_or(Errno::EIO)?,
                u32::try_from(value.len()).map_err(|_| Errno::EIO)?,
                Sha256::digest(value).into(),
                false,
            ),
            None => (0, 0, [0; 32], true),
        };
        let mut name_bytes = [0; 255];
        name_bytes[..name.len()].copy_from_slice(name);
        let reference = LegacyMutationReference {
            kind, inode, block, marker: u8::from(kind == 3), name: name_bytes,
            name_length: name.len() as u8, order, offset, value_length, digest, deleted,
        };
        push_reference(reference)?;
        if let Some(value) = mutation.value {
            if kind == 2 {
                let from = u64::from_le_bytes(value.try_into().map_err(|_| Errno::EIO)?);
                push_reference(LegacyMutationReference {
                    kind: 3, block: from, marker: 0, ..reference
                })?;
            }
        }
        order = order.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    };
    replay_transactions(
        source,
        HEADER_BYTES as u64,
        source_length,
        1,
        &mut OverlayState::default(),
        ReplayFilter::VerifyOnly,
        true,
        false,
        None,
        Some(&mut record),
    )?;
    if !record_buffer.is_empty() {
        scratch.write_all_at(record_write_offset, &record_buffer)?;
    }
    scratch.flush()?;
    drop(record_buffer);
    sort_legacy_mutations(&mut scratch, &mut target, count)?;
    let mut compacted = OverlayJournal::open(target, base_digest)?;
    compacted.track_committed_state = false;
    compacted.retain_compacted_metadata = false;
    let mut batch = MutationBatch::new(128)?;
    let mut reader = LegacyMutationCursor::new()?;
    reader.reset(0, count);
    let mut previous_kind = None;
    let mut pending = None;
    let mut zero_min: Option<(u64, u64)> = None;
    let mut block_inode = None;
    let mut latest_zero_order = None;
    while let Some(reference) = reader.next(&mut scratch)? {
        if previous_kind != Some(reference.kind) {
            if let Some(zero) = zero_min.take() {
                emit_legacy_zero(&mut compacted, &mut batch, zero)?;
            }
            emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, latest_zero_order)?;
            previous_kind = Some(reference.kind);
            block_inode = None;
            latest_zero_order = None;
        }
        match reference.kind {
            0 | 1 | 4 => {
                if pending.is_some_and(|previous: LegacyMutationReference| !previous.same_key(reference)) {
                    emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, None)?;
                }
                pending = Some(reference);
            }
            2 => {
                if let Some((inode, minimum)) = zero_min {
                    if inode != reference.inode {
                        emit_legacy_zero(&mut compacted, &mut batch, (inode, minimum))?;
                        zero_min = None;
                    }
                }
                let mut value = [0; 8];
                read_legacy_mutation_bytes(source, reference, &mut value)?;
                let from = u64::from_le_bytes(value.as_slice().try_into().map_err(|_| Errno::EIO)?);
                zero_min = Some((reference.inode, zero_min.map_or(from, |(_, minimum)| minimum.min(from))));
            }
            3 => {
                if block_inode != Some(reference.inode) {
                    emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, latest_zero_order)?;
                    block_inode = Some(reference.inode);
                    latest_zero_order = None;
                }
                if reference.marker == 0 {
                    emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, latest_zero_order)?;
                    latest_zero_order = Some(latest_zero_order.map_or(reference.order, |order: u64| order.max(reference.order)));
                } else {
                    if pending.is_some_and(|previous: LegacyMutationReference| !previous.same_key(reference)) {
                        emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, latest_zero_order)?;
                    }
                    pending = Some(reference);
                }
            }
            _ => return Err(Errno::EIO),
        }
    }
    if let Some(zero) = zero_min {
        emit_legacy_zero(&mut compacted, &mut batch, zero)?;
    }
    emit_legacy_pending(source, &mut compacted, &mut batch, &mut pending, latest_zero_order)?;
    batch.flush(&mut compacted)?;
    drop(batch);
    drop(reader);
    scratch.truncate(0)?;
    scratch.flush()?;
    let checkpoint = compacted.checkpoint_blocks_with_metadata_into(scratch)?;
    Ok((compacted.into_storage(), checkpoint.into_storage()))
}

struct CompactedBlockEntries<'a, S: OverlayStorage> {
    transactions: CompactedTransactions<'a, S>,
}

impl<'a, S: OverlayStorage> CompactedBlockEntries<'a, S> {
    fn new(storage: &'a mut S, end: u64, expected_sequence: u64, allow_metadata: bool) -> Self {
        Self { transactions: CompactedTransactions::new(storage, end, expected_sequence, allow_metadata) }
    }
}

impl<S: OverlayStorage> Iterator for CompactedBlockEntries<'_, S> {
    type Item = Result<BlockCheckpointEntry, Errno>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let (record, start) = match self.transactions.next_record() {
                Ok(Some(record)) => record,
                Ok(None) => return None,
                Err(error) => return Some(Err(error)),
            };
            if !record.is_block() { continue; }
            return Some(Ok(BlockCheckpointEntry {
                inode: record.inode,
                block: record.block,
                offset: record.value_offset.map_or(0, |offset| start + TRANSACTION_HEADER_BYTES as u64 + offset),
                digest: record.value.map_or([0; 32], |value| Sha256::digest(value).into()),
            }));
        }
    }
}

struct CompactedMetadataEntries<'a, S: OverlayStorage> {
    transactions: CompactedTransactions<'a, S>,
}

impl<'a, S: OverlayStorage> CompactedMetadataEntries<'a, S> {
    fn new(storage: &'a mut S, end: u64, expected_sequence: u64) -> Self {
        Self { transactions: CompactedTransactions::new(storage, end, expected_sequence, true) }
    }
}

impl<S: OverlayStorage> Iterator for CompactedMetadataEntries<'_, S> {
    type Item = Result<MetadataCheckpointEntry, Errno>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let (record, start) = match self.transactions.next_record() {
                Ok(Some(record)) => record,
                Ok(None) => return None,
                Err(error) => return Some(Err(error)),
            };
            if record.is_block() { continue; }
            let key = match record.owned_key() {
                Ok(key) => key,
                Err(error) => {
                    self.transactions.finished = true;
                    return Some(Err(error));
                }
            };
            return Some(Ok(MetadataCheckpointEntry {
                key,
                value: record.value.map(|value| (start + TRANSACTION_HEADER_BYTES as u64
                    + record.value_offset.expect("validated put offset missing"), value.len() as u32)),
                value_digest: record.value.map(|value| Sha256::digest(value).into()),
            }));
        }
    }
}

struct CompactedTransactions<'a, S: OverlayStorage> {
    storage: &'a mut S,
    end: u64,
    position: u64,
    sequence: u64,
    expected_sequence: u64,
    allow_metadata: bool,
    finished: bool,
    bytes: IoBuffer<u8>,
    consumed: usize,
    body_end: usize,
    transaction_start: u64,
}

impl<'a, S: OverlayStorage> CompactedTransactions<'a, S> {
    fn new(storage: &'a mut S, end: u64, expected_sequence: u64, allow_metadata: bool) -> Self {
        Self {
            storage,
            end,
            position: HEADER_BYTES as u64,
            sequence: 1,
            expected_sequence,
            allow_metadata,
            finished: false,
            bytes: IoBuffer::new(),
            consumed: 0,
            body_end: 0,
            transaction_start: HEADER_BYTES as u64,
        }
    }

    fn read_transaction(&mut self) -> Result<(), Errno> {
        let remaining = self.end.checked_sub(self.position).ok_or(Errno::EIO)?;
        if remaining < (TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES) as u64 {
            return Err(Errno::EIO);
        }
        let mut header = [0; TRANSACTION_HEADER_BYTES];
        self.storage.read_exact_at(self.position, &mut header)?;
        let length = u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) as usize;
        if &header[..4] != TRANSACTION_MAGIC
            || !(TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES..=MAX_TRANSACTION_BYTES)
                .contains(&length)
            || length as u64 > remaining
            || u32::from_le_bytes(header[20..24].try_into().map_err(|_| Errno::EIO)?)
                != !(length as u32)
        {
            return Err(Errno::EIO);
        }
        self.bytes.reserve_with(length, |bytes| reserve_transaction_bytes(bytes, length))?;
        self.bytes.resize(length, 0);
        self.storage.read_exact_at(self.position, &mut self.bytes)?;
        let bytes = &self.bytes;
        let digest_start = length - TRANSACTION_TRAILER_BYTES;
        if u64::from_le_bytes(bytes[8..16].try_into().map_err(|_| Errno::EIO)?) != self.sequence
            || &bytes[length - 4..] != COMMIT_MAGIC
            || bytes[digest_start..length - 4] != Sha256::digest(&bytes[..digest_start])[..]
        {
            return Err(Errno::EIO);
        }
        let mutations = decode_mutations(&bytes[TRANSACTION_HEADER_BYTES..digest_start])?;
        if mutations.len()
            != u32::from_le_bytes(bytes[16..20].try_into().map_err(|_| Errno::EIO)?) as usize
        {
            return Err(Errno::EIO);
        }
        if !self.allow_metadata && mutations.into_iter().any(|record| !record.is_block() || record.value.is_none()) {
            return Err(Errno::EIO);
        }
        self.transaction_start = self.position;
        self.consumed = 0;
        self.body_end = digest_start - TRANSACTION_HEADER_BYTES;
        self.position = self
            .position
            .checked_add(length as u64)
            .ok_or(Errno::EOVERFLOW)?;
        self.sequence = self.sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }

    fn next_record(&mut self) -> Result<Option<(DecodedMutation<'_>, u64)>, Errno> {
        if self.finished { return Ok(None); }
        while self.consumed == self.body_end {
            if self.position == self.end {
                self.finished = true;
                return if self.sequence == self.expected_sequence { Ok(None) } else { Err(Errno::EIO) };
            }
            if let Err(error) = self.read_transaction() {
                self.finished = true;
                return Err(error);
            }
        }
        let (record, next) = decode_mutation(
            &self.bytes[TRANSACTION_HEADER_BYTES + self.consumed..TRANSACTION_HEADER_BYTES + self.body_end], self.consumed)
            .expect("validated compacted record changed");
        self.consumed = next;
        Ok(Some((record, self.transaction_start)))
    }
}

pub(crate) fn validate_dirent_name(parent: u64, name: &[u8]) -> Result<(), Errno> {
    if parent != 0 && !name.is_empty() && name.len() <= 255
        && name != b"." && name != b".."
        && !name.iter().any(|byte| *byte == 0 || *byte == b'/')
    {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

fn validate_key(key: &OverlayKey) -> Result<(), Errno> {
    match key {
        OverlayKey::Inode(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileSize(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileZeroFrom(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileBlock { inode, .. } if *inode != 0 => Ok(()),
        OverlayKey::Dirent { parent, name } => validate_dirent_name(*parent, name),
        _ => Err(Errno::EINVAL),
    }
}

fn validate_mutation(mutation: &Mutation) -> Result<(), Errno> {
    match mutation {
        Mutation::Put { key, value } => {
            validate_key(key)?;
            match key {
                OverlayKey::Inode(_) if !value.is_empty() && value.len() <= 4096 => Ok(()),
                OverlayKey::FileSize(_) if value.len() == 8 => Ok(()),
                OverlayKey::FileZeroFrom(_) if value.len() == 8 => Ok(()),
                OverlayKey::FileBlock { .. } if value.len() == FILE_BLOCK_BYTES => Ok(()),
                OverlayKey::Dirent { .. }
                    if value.len() == 8
                        && u64::from_le_bytes(
                            value[..8].try_into().map_err(|_| Errno::EINVAL)?,
                        ) != 0 =>
                {
                    Ok(())
                }
                _ => Err(Errno::EINVAL),
            }
        }
        Mutation::Delete {
            key: OverlayKey::FileZeroFrom(_),
        } => Err(Errno::EINVAL),
        Mutation::Delete { key } => validate_key(key),
    }
}

fn encode_key(out: &mut IoBuffer<u8>, key: &OverlayKey) {
    match key {
        OverlayKey::Inode(inode) => {
            out.push(1);
            out.extend_from_slice(&inode.to_le_bytes());
            out.extend_from_slice(&0u64.to_le_bytes());
            out.push(0);
        }
        OverlayKey::FileSize(inode) => {
            out.push(4);
            out.extend_from_slice(&inode.to_le_bytes());
            out.extend_from_slice(&0u64.to_le_bytes());
            out.push(0);
        }
        OverlayKey::FileZeroFrom(inode) => {
            out.push(5);
            out.extend_from_slice(&inode.to_le_bytes());
            out.extend_from_slice(&0u64.to_le_bytes());
            out.push(0);
        }
        OverlayKey::FileBlock { inode, block } => {
            out.push(2);
            out.extend_from_slice(&inode.to_le_bytes());
            out.extend_from_slice(&block.to_le_bytes());
            out.push(0);
        }
        OverlayKey::Dirent { parent, name } => {
            out.push(3);
            out.extend_from_slice(&parent.to_le_bytes());
            out.extend_from_slice(&0u64.to_le_bytes());
            out.push(name.len() as u8);
            out.extend_from_slice(name);
        }
    }
}

#[derive(Clone, Copy)]
enum ReplayFilter {
    All,
    MetadataOnly,
    RejectMetadata,
    VerifyOnly,
}

fn replay_transactions<S: OverlayStorage>(
    storage: &mut S,
    mut end: u64,
    size: u64,
    mut next_sequence: u64,
    state: &mut OverlayState,
    filter: ReplayFilter,
    allow_torn_tail: bool,
    has_checkpoint: bool,
    mut prefix_digest: Option<&mut Sha256>,
    mut record_check: Option<&mut dyn FnMut(&DecodedMutation<'_>, Option<u64>) -> Result<(), Errno>>,
) -> Result<(u64, u64), Errno> {
    while end < size {
        let remaining = size - end;
        if remaining < (TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES) as u64 {
            if allow_torn_tail {
                break;
            }
            return Err(Errno::EIO);
        }
        let mut header = [0u8; TRANSACTION_HEADER_BYTES];
        storage.read_exact_at(end, &mut header)?;
        if &header[..4] != TRANSACTION_MAGIC {
            return Err(Errno::EIO);
        }
        let length = u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) as usize;
        let length_complement =
            u32::from_le_bytes(header[20..24].try_into().map_err(|_| Errno::EIO)?);
        if length_complement != !(length as u32)
            || !(TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES..=MAX_TRANSACTION_BYTES)
                .contains(&length)
        {
            return Err(Errno::EIO);
        }
        if length as u64 > remaining {
            if allow_torn_tail {
                break;
            }
            return Err(Errno::EIO);
        }
        let mut transaction = IoBuffer::allocate(length, false, |bytes| reserve_transaction_bytes(bytes, length))?;
        transaction.resize(length, 0);
        storage.read_exact_at(end, &mut transaction)?;
        let sequence = u64::from_le_bytes(transaction[8..16].try_into().map_err(|_| Errno::EIO)?);
        if sequence != next_sequence {
            return Err(Errno::EIO);
        }
        let digest_start = length - TRANSACTION_TRAILER_BYTES;
        if &transaction[length - 4..] != COMMIT_MAGIC
            || transaction[digest_start..length - 4]
                != Sha256::digest(&transaction[..digest_start])[..]
        {
            return Err(Errno::EIO);
        }
        let mutations = decode_mutations(&transaction[TRANSACTION_HEADER_BYTES..digest_start])?;
        let count = u32::from_le_bytes(transaction[16..20].try_into().map_err(|_| Errno::EIO)?);
        if mutations.len() != count as usize {
            return Err(Errno::EIO);
        }
        for record in mutations {
            let is_block = record.is_block();
            if matches!(filter, ReplayFilter::RejectMetadata) && !is_block {
                return Err(Errno::EIO);
            }
            if !matches!(filter, ReplayFilter::All) && is_block && record_check.is_none() {
                continue;
            }
            let value_offset = record.value_offset
                .map(|offset| {
                    end.checked_add(TRANSACTION_HEADER_BYTES as u64)
                        .and_then(|start| start.checked_add(offset))
                        .ok_or(Errno::EIO)
                })
                .transpose()?;
            if let Some(check) = record_check.as_mut() {
                check(&record, value_offset)?;
            }
            if matches!(filter, ReplayFilter::VerifyOnly)
                || (!matches!(filter, ReplayFilter::All) && is_block)
            {
                continue;
            }
            state.apply(record, value_offset, has_checkpoint)?;
        }
        if let Some(digest) = &mut prefix_digest {
            digest.update(&transaction);
        }
        next_sequence = next_sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        end = end.checked_add(length as u64).ok_or(Errno::EOVERFLOW)?;
    }
    Ok((end, next_sequence))
}

fn encode_transaction(sequence: u64, mutations: &[Mutation]) -> Result<IoBuffer<u8>, Errno> {
    encode_transaction_in(sequence, mutations, false)
}

fn encode_transaction_in(sequence: u64, mutations: &[Mutation], writeback: bool) -> Result<IoBuffer<u8>, Errno> {
    let count = u32::try_from(mutations.len()).map_err(|_| Errno::EFBIG)?;
    let length = transaction_encoded_length(mutations)?;
    let mut out = IoBuffer::allocate(length, writeback, |bytes| reserve_transaction_bytes(bytes, length))?;
    out.extend_from_slice(TRANSACTION_MAGIC);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for mutation in mutations {
        match mutation {
            Mutation::Put { key, value } => {
                out.push(1);
                encode_key(&mut out, key);
                out.extend_from_slice(&(value.len() as u32).to_le_bytes());
                out.extend_from_slice(value);
            }
            Mutation::Delete { key } => {
                out.push(2);
                encode_key(&mut out, key);
                out.extend_from_slice(&0u32.to_le_bytes());
            }
        }
    }
    debug_assert_eq!(out.len() + TRANSACTION_TRAILER_BYTES, length);
    out[4..8].copy_from_slice(&(length as u32).to_le_bytes());
    out[20..24].copy_from_slice(&(!(length as u32)).to_le_bytes());
    let digest = Sha256::digest(&out);
    out.extend_from_slice(&digest);
    out.extend_from_slice(COMMIT_MAGIC);
    Ok(out)
}

pub(crate) fn transaction_encoded_length(mutations: &[Mutation]) -> Result<usize, Errno> {
    u32::try_from(mutations.len()).map_err(|_| Errno::EFBIG)?;
    let mut length = TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES;
    for mutation in mutations {
        validate_mutation(mutation)?;
        let name = match mutation_key(mutation) { OverlayKey::Dirent { name, .. } => name.len(), _ => 0 };
        let value = match mutation { Mutation::Put { value, .. } => value.len(), _ => 0 };
        length = length.checked_add(23).and_then(|length| length.checked_add(name))
            .and_then(|length| length.checked_add(value)).ok_or(Errno::EFBIG)?;
        if length > MAX_TRANSACTION_BYTES { return Err(Errno::EFBIG); }
    }
    Ok(length)
}

fn mutation_key(mutation: &Mutation) -> &OverlayKey {
    match mutation {
        Mutation::Put { key, .. } | Mutation::Delete { key } => key,
    }
}

fn resize_mutation_payload_credit(credit: &mut MetadataReservation<'_>, mutations: &[Mutation]) -> Result<(), Errno> {
    let bytes = mutations.iter().try_fold(0usize, |bytes, mutation| {
        let name = match mutation_key(mutation) { OverlayKey::Dirent { name, .. } => name.capacity(), _ => 0 };
        let value = match mutation { Mutation::Put { value, .. } => value.capacity(), _ => 0 };
        bytes.checked_add(name).and_then(|bytes| bytes.checked_add(value)).ok_or(Errno::ENOMEM)
    })?;
    credit.resize(bytes.checked_mul(2).ok_or(Errno::ENOMEM)?)
}

fn copy_transaction_bytes(source: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut owned = Vec::new();
    reserve_transaction_bytes(&mut owned, source.len())?;
    owned.extend_from_slice(source);
    Ok(owned)
}

#[cfg(test)]
static FAIL_TRANSACTION_AFTER: core::sync::atomic::AtomicUsize = core::sync::atomic::AtomicUsize::new(usize::MAX);

#[cfg(test)]
struct TransactionAllocationFailure;

#[cfg(test)]
fn fail_transaction_after(successes: usize) -> TransactionAllocationFailure {
    FAIL_TRANSACTION_AFTER.store(successes, core::sync::atomic::Ordering::SeqCst);
    TransactionAllocationFailure
}

#[cfg(test)]
impl Drop for TransactionAllocationFailure {
    fn drop(&mut self) {
        FAIL_TRANSACTION_AFTER.store(usize::MAX, core::sync::atomic::Ordering::SeqCst);
    }
}

fn reserve_transaction_bytes(bytes: &mut Vec<u8>, length: usize) -> Result<(), Errno> {
    if length <= bytes.capacity() { return Ok(()); }
    #[cfg(test)]
    {
        let remaining = FAIL_TRANSACTION_AFTER.load(core::sync::atomic::Ordering::SeqCst);
        if remaining != usize::MAX {
            FAIL_TRANSACTION_AFTER.store(remaining.wrapping_sub(1), core::sync::atomic::Ordering::SeqCst);
            if remaining == 0 { return Err(Errno::ENOMEM); }
        }
    }
    bytes.try_reserve_exact(length.saturating_sub(bytes.len())).map_err(|_| Errno::ENOMEM)
}

#[derive(Clone, Copy, Debug)]
struct DecodedMutation<'a> {
    kind: u8,
    inode: u64,
    block: u64,
    name: &'a [u8],
    value: Option<&'a [u8]>,
    value_offset: Option<u64>,
}

impl DecodedMutation<'_> {
    fn is_block(&self) -> bool { self.kind == 2 }

    fn owned_key(&self) -> Result<OverlayKey, Errno> {
        Ok(match self.kind {
            1 => OverlayKey::Inode(self.inode),
            2 => OverlayKey::FileBlock { inode: self.inode, block: self.block },
            3 => OverlayKey::Dirent { parent: self.inode, name: copy_transaction_bytes(self.name)? },
            4 => OverlayKey::FileSize(self.inode),
            5 => OverlayKey::FileZeroFrom(self.inode),
            _ => return Err(Errno::EIO),
        })
    }

    fn to_owned(self) -> Result<Mutation, Errno> {
        let key = self.owned_key()?;
        Ok(match self.value {
            Some(value) => Mutation::Put { key, value: copy_transaction_bytes(value)? },
            None => Mutation::Delete { key },
        })
    }
}

fn decode_mutation(bytes: &[u8], consumed: usize) -> Result<(DecodedMutation<'_>, usize), Errno> {
        if bytes.len() < 23 {
            return Err(Errno::EIO);
        }
        let operation = bytes[0];
        let kind = bytes[1];
        let inode = u64::from_le_bytes(bytes[2..10].try_into().map_err(|_| Errno::EIO)?);
        let block = u64::from_le_bytes(bytes[10..18].try_into().map_err(|_| Errno::EIO)?);
        let name_length = bytes[18] as usize;
        let mut bytes = &bytes[19..];
        if bytes.len() < name_length + 4 {
            return Err(Errno::EIO);
        }
        let name = &bytes[..name_length];
        bytes = &bytes[name_length..];
        let value_length =
            u32::from_le_bytes(bytes[..4].try_into().map_err(|_| Errno::EIO)?) as usize;
        bytes = &bytes[4..];
        if bytes.len() < value_length {
            return Err(Errno::EIO);
        }
        if inode == 0 || !match kind {
            1 | 4 | 5 => block == 0 && name_length == 0,
            2 => name_length == 0,
            3 => block == 0 && !name.is_empty() && name != b"." && name != b".."
                && !name.iter().any(|byte| *byte == 0 || *byte == b'/'),
            _ => false,
        } { return Err(Errno::EIO); }
        let value = match operation {
            1 => {
                let valid = match kind {
                    1 => value_length != 0 && value_length <= 4096,
                    2 => value_length == FILE_BLOCK_BYTES,
                    3 => value_length == 8 && bytes[..8] != [0; 8],
                    4 | 5 => value_length == 8,
                    _ => false,
                };
                if !valid { return Err(Errno::EIO); }
                Some(&bytes[..value_length])
            }
            2 if value_length == 0 && kind != 5 => None,
            _ => return Err(Errno::EIO),
        };
        let value_start = consumed.checked_add(23 + name_length).ok_or(Errno::EIO)?;
        let next = value_start.checked_add(value_length).ok_or(Errno::EIO)?;
        Ok((DecodedMutation { kind, inode, block, name, value,
            value_offset: value.map(|_| value_start as u64) }, next))
}

struct DecodedMutations<'a> { bytes: &'a [u8], consumed: usize, remaining: usize }

impl<'a> Iterator for DecodedMutations<'a> {
    type Item = DecodedMutation<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 { return None; }
        let (record, next) = decode_mutation(&self.bytes[self.consumed..], self.consumed)
            .expect("validated transaction record changed");
        self.consumed = next;
        self.remaining -= 1;
        Some(record)
    }

    fn size_hint(&self) -> (usize, Option<usize>) { (self.remaining, Some(self.remaining)) }
}

impl ExactSizeIterator for DecodedMutations<'_> {}
impl core::iter::FusedIterator for DecodedMutations<'_> {}

fn decode_mutations(bytes: &[u8]) -> Result<DecodedMutations<'_>, Errno> {
    if bytes.len() > MAX_TRANSACTION_BYTES - TRANSACTION_HEADER_BYTES - TRANSACTION_TRAILER_BYTES { return Err(Errno::EIO); }
    let mut consumed = 0;
    let mut count = 0;
    while consumed < bytes.len() {
        let (_, next) = decode_mutation(&bytes[consumed..], consumed)?;
        consumed = next;
        count += 1;
    }
    Ok(DecodedMutations { bytes, consumed: 0, remaining: count })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::sync::Arc;
    use core::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct MemoryStorage {
        bytes: Vec<u8>,
        flushes: usize,
        fail_flush: bool,
        fail_truncate: bool,
        fail_errno: Option<Errno>,
        fail_after_flushes: Option<usize>,
        fail_write_after_bytes: Option<usize>,
        read_bytes: Option<Arc<AtomicU64>>,
        io_peak: Option<Arc<AtomicU64>>,
        fail_map_allocation_after_flush: bool,
        fail_read_at: Option<(u64, Errno)>,
    }

    impl OverlayStorage for MemoryStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            self.observe_io();
            Ok(self.bytes.len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            self.observe_io();
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
            dst.copy_from_slice(self.bytes.get(start..end).ok_or(Errno::EIO)?);
            if let Some(read_bytes) = &self.read_bytes {
                read_bytes.fetch_add(dst.len() as u64, Ordering::Relaxed);
            }
            if let Some((failure_offset, error)) = self.fail_read_at {
                if failure_offset == offset { return Err(error); }
            }
            Ok(())
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
            self.observe_io();
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let written = self
                .fail_write_after_bytes
                .unwrap_or(src.len())
                .min(src.len());
            let end = start.checked_add(written).ok_or(Errno::EIO)?;
            if end > self.bytes.len() {
                self.bytes.resize(end, 0);
            }
            self.bytes[start..end].copy_from_slice(&src[..written]);
            if written < src.len() {
                Err(Errno::EIO)
            } else {
                Ok(())
            }
        }

        fn flush(&mut self) -> Result<(), Errno> {
            self.observe_io();
            if self.fail_flush || self.fail_after_flushes == Some(self.flushes) {
                return Err(self.fail_errno.unwrap_or(Errno::EIO));
            }
            self.flushes += 1;
            if self.fail_map_allocation_after_flush {
                self.fail_map_allocation_after_flush = false;
                crate::prepared_map::fail_after_allocations(0);
            }
            Ok(())
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            self.observe_io();
            if self.fail_truncate { return Err(Errno::EIO); }
            self.bytes
                .truncate(usize::try_from(len).map_err(|_| Errno::EIO)?);
            Ok(())
        }
    }

    impl MemoryStorage {
        fn observe_io(&self) {
            if let Some(peak) = &self.io_peak {
                peak.fetch_max(crate::io_buffer::IO_MEMORY.usage().0 as u64, Ordering::Relaxed);
            }
        }
    }

    fn inode_key() -> OverlayKey {
        OverlayKey::Inode(7)
    }

    fn directory_key(name: &[u8]) -> OverlayKey {
        OverlayKey::Dirent {
            parent: 1,
            name: name.to_vec(),
        }
    }

    #[test]
    fn mutation_batch_owns_actual_payload_capacity_and_preserves_credit_on_flush_error() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [109; 32]).unwrap();
        let mut batch = MutationBatch::new(1).unwrap();
        let slots = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _quota = crate::io_buffer::test_budget(slots);
            assert_eq!(batch.push_with(8, || panic!("copy called before payload admission")), Err(Errno::ENOMEM));
        }
        assert_eq!(batch.len(), 0);
        assert_eq!(batch.push_with(8, || Err(Errno::ENOMEM)), Err(Errno::ENOMEM));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, slots);
        batch.push_with(13, || {
            let mut name = Vec::with_capacity(24);
            name.extend_from_slice(b"entry");
            let mut value = Vec::with_capacity(37);
            value.extend_from_slice(&7u64.to_le_bytes());
            Ok(Mutation::Put { key: OverlayKey::Dirent { parent: 1, name }, value })
        }).unwrap();
        let actual = match &batch.as_slice()[0] {
            Mutation::Put { key: OverlayKey::Dirent { name, .. }, value } => 2 * (name.capacity() + value.capacity()),
            _ => unreachable!(),
        };
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, slots + actual);
        assert_eq!(batch.push_with(0, || panic!("copy called for full batch")), Err(Errno::EFBIG));
        journal.storage.fail_flush = true;
        assert_eq!(batch.flush(&mut journal), Err(Errno::EIO));
        assert_eq!(batch.len(), 1);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, slots + actual);
        drop(batch);
        drop(journal);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn compaction_payload_refusal_preserves_source_and_can_retry() {
        let mut source = OverlayJournal::open(MemoryStorage::default(), [110; 32]).unwrap();
        source.commit(&[Mutation::Put { key: inode_key(), value: vec![7; 4096] }]).unwrap();
        let original = source.storage.bytes.clone();
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let target = OverlayJournal::open(MemoryStorage::default(), [110; 32]).unwrap();
        let target_slots = crate::io_buffer::IO_MEMORY.usage().0 - used;
        drop(target);
        let batch_slots = 2 * 128 * core::mem::size_of::<Mutation>();
        for extra in [0, target_slots - 1, target_slots + batch_slots] {
            let _quota = crate::io_buffer::test_budget(used + extra);
            let fault = fail_transaction_after(0);
            assert!(matches!(source.compact_into(MemoryStorage::default()), Err(Errno::ENOMEM)));
            assert_eq!(copy_transaction_bytes(b"copy hook is still armed"), Err(Errno::ENOMEM));
            drop(fault);
            assert_eq!(source.storage.bytes, original);
            assert_eq!(source.failure, None);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, used);
        }
        let compacted = source.compact_into(MemoryStorage::default()).unwrap();
        assert_eq!(compacted.state.lookup(&inode_key()), Some(Some(&vec![7; 4096][..])));
        assert_eq!(source.storage.bytes, original);
    }

    #[test]
    fn indexed_reads_reclaim_optional_checkpoint_pages_before_required_payload_allocation() {
        use crate::io_buffer::{IO_MEMORY, WRITEBACK_MEMORY, test_budget};
        for metadata in [false, true] {
            let read_bytes = Arc::new(AtomicU64::new(0));
            let mut journal = OverlayJournal::open(MemoryStorage {
                read_bytes: Some(Arc::clone(&read_bytes)), ..MemoryStorage::default()
            }, [112; 32]).unwrap();
            let key = if metadata { inode_key() } else { OverlayKey::FileBlock { inode: 7, block: 0 } };
            journal.commit(&[Mutation::Put { key: key.clone(), value: vec![9; FILE_BLOCK_BYTES] }]).unwrap();
            if metadata {
                journal = journal.compact_metadata_into(MemoryStorage {
                    read_bytes: Some(Arc::clone(&read_bytes)), ..MemoryStorage::default()
                }).unwrap();
                journal.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
                journal.release_checkpoint_metadata().unwrap();
            } else { journal.install_fixed_block_checkpoint(Box::new(MemoryStorage::default())).unwrap(); }
            journal.discard_read_caches();
            let used = IO_MEMORY.usage().0;
            let writeback = WRITEBACK_MEMORY.usage().0;
            let checkpoint = journal.checkpoint.as_mut().unwrap();
            if metadata { checkpoint.lookup_metadata(&key).unwrap(); }
            else { checkpoint.lookup(7, 0).unwrap(); }
            let page_credits = IO_MEMORY.usage().0 - used;
            assert!(page_credits > 2 * FILE_BLOCK_BYTES);
            journal.discard_read_caches();
            read_bytes.store(0, Ordering::Relaxed);
            {
                let _quota = test_budget(used + page_credits);
                if metadata {
                    let value = journal.metadata_value(&key).unwrap().unwrap().unwrap();
                    assert_eq!(&*value, &vec![9; FILE_BLOCK_BYTES]);
                } else {
                    let mut actual = [0; FILE_BLOCK_BYTES];
                    assert_eq!(journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut actual,
                        |_, _| panic!("indexed data must satisfy the read")), Ok(FILE_BLOCK_BYTES));
                    assert_eq!(actual, [9; FILE_BLOCK_BYTES]);
                }
                assert!(IO_MEMORY.usage().0 <= used + page_credits);
                assert_eq!(WRITEBACK_MEMORY.usage().0, writeback);
                assert_eq!(read_bytes.load(Ordering::Relaxed), FILE_BLOCK_BYTES as u64);
                journal.discard_read_caches();
                assert_eq!(IO_MEMORY.usage().0, used);
            }
            if metadata {
                drop(journal.metadata_value(&key).unwrap());
                let cached = IO_MEMORY.usage().0;
                let before = read_bytes.load(Ordering::Relaxed);
                {
                    let _quota = test_budget(cached);
                    let value = journal.metadata_value(&key).unwrap().unwrap().unwrap();
                    assert_eq!(&*value, &vec![9; FILE_BLOCK_BYTES]);
                    assert_eq!(read_bytes.load(Ordering::Relaxed), before);
                }
            }
        }
    }

    #[test]
    fn indexed_storage_memory_errors_are_not_retried_as_cache_admission_failures() {
        for metadata in [false, true] {
            let read_bytes = Arc::new(AtomicU64::new(0));
            let mut journal = OverlayJournal::open(MemoryStorage {
                read_bytes: Some(Arc::clone(&read_bytes)), ..MemoryStorage::default()
            }, [113; 32]).unwrap();
            let key = if metadata { inode_key() } else { OverlayKey::FileBlock { inode: 7, block: 0 } };
            journal.commit(&[Mutation::Put { key: key.clone(), value: vec![9; FILE_BLOCK_BYTES] }]).unwrap();
            if metadata {
                journal = journal.compact_metadata_into(MemoryStorage {
                    read_bytes: Some(Arc::clone(&read_bytes)), ..MemoryStorage::default()
                }).unwrap();
                journal.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
                journal.release_checkpoint_metadata().unwrap();
            } else { journal.install_fixed_block_checkpoint(Box::new(MemoryStorage::default())).unwrap(); }
            journal.discard_read_caches();
            let checkpoint = journal.checkpoint.as_mut().unwrap();
            let offset = if metadata { checkpoint.lookup_metadata(&key).unwrap().unwrap().value.unwrap().0 }
                else { checkpoint.lookup(7, 0).unwrap().unwrap().offset };
            journal.storage.fail_read_at = Some((offset, Errno::ENOMEM));
            read_bytes.store(0, Ordering::Relaxed);
            if metadata { assert!(matches!(journal.metadata_value(&key), Err(Errno::ENOMEM))); }
            else {
                let mut actual = [0xAA; FILE_BLOCK_BYTES];
                assert_eq!(journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut actual, |_, _| unreachable!()), Err(Errno::ENOMEM));
                assert_eq!(actual, [0xAA; FILE_BLOCK_BYTES]);
            }
            assert_eq!(read_bytes.load(Ordering::Relaxed), FILE_BLOCK_BYTES as u64);
        }
    }

    #[test]
    fn indexed_prefix_verification_does_not_let_read_ahead_starve_a_larger_following_frame() {
        use crate::io_buffer::{IO_MEMORY, test_budget};
        let digest = [114; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        source.commit(&[Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![9; FILE_BLOCK_BYTES] }]).unwrap();
        let mutations: Vec<_> = (1..=128).map(|block| Mutation::Put {
            key: OverlayKey::FileBlock { inode: 7, block }, value: vec![block as u8; FILE_BLOCK_BYTES],
        }).collect();
        source.commit(&mutations).unwrap();
        source.track_committed_state = false;
        let checkpoint = source.checkpoint_blocks_with_metadata_into(MemoryStorage::default()).unwrap().into_storage();
        let checkpoint_end = source.end;
        let storage = source.into_storage();
        let first_length = u32::from_le_bytes(storage.bytes[HEADER_BYTES + 4..HEADER_BYTES + 8].try_into().unwrap()) as usize;
        let second = HEADER_BYTES + first_length;
        let second_length = u32::from_le_bytes(storage.bytes[second + 4..second + 8].try_into().unwrap()) as usize;
        assert!(second_length > 100 * first_length);
        let original = storage.bytes.clone();
        let baseline = IO_MEMORY.usage().0;
        let _quota = test_budget(baseline + 2 * second_length);
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(storage, checkpoint, digest, checkpoint_end).unwrap();
        assert_eq!(reopened.storage.bytes, original);
        let mut actual = [0; 16];
        assert_eq!(reopened.read_file_at(7, 129 * FILE_BLOCK_BYTES as u64, 128 * FILE_BLOCK_BYTES as u64,
            &mut actual, |_, _| unreachable!()), Ok(actual.len()));
        assert_eq!(actual, [128; 16]);
        assert!(IO_MEMORY.usage().0 <= baseline + 2 * second_length);
    }

    #[test]
    fn indexed_metadata_walk_admits_value_scratch_before_visiting_and_releases_it() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [111; 32]).unwrap();
        journal.commit(&[Mutation::Put { key: inode_key(), value: vec![9; 4096] }]).unwrap();
        let mut compacted = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
        compacted.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
        compacted.release_checkpoint_metadata().unwrap();
        let before = compacted.storage.bytes.clone();
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let mut visits = 0;
        {
            let _quota = crate::io_buffer::test_budget(used);
            assert_eq!(compacted.for_each_metadata(|_, _| { visits += 1; Ok(()) }), Err(Errno::ENOMEM));
        }
        assert_eq!(visits, 0);
        assert_eq!(compacted.storage.bytes, before);
        assert_eq!(compacted.failure, None);
        compacted.for_each_metadata(|key, value| {
            assert_eq!(key, &inode_key());
            assert_eq!(value, Some(&vec![9; 4096][..]));
            assert!(crate::io_buffer::IO_MEMORY.usage().0 >= used + 8192);
            visits += 1;
            Ok(())
        }).unwrap();
        assert_eq!(visits, 1);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, used);
    }

    #[test]
    fn resizable_conversion_releases_each_sort_phase_within_six_mib() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let _quota = crate::io_buffer::test_budget(baseline + 6 * 1024 * 1024);
        for count in [LEGACY_SORT_RUN_RECORDS + 3, 2 * LEGACY_SORT_RUN_RECORDS + 3] {
            let digest = [112; 32];
            let mut source = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
            for (sequence, start) in (0..count).step_by(2048).enumerate() {
                let mutations = (start..(start + 2048).min(count)).map(|position| Mutation::Delete {
                    key: OverlayKey::FileBlock { inode: 7, block: (count - position - 1) as u64 },
                }).collect::<Vec<_>>();
                let frame = encode_transaction(sequence as u64 + 1, &mutations).unwrap();
                source.bytes.extend_from_slice(&frame);
            }
            let before = source.bytes.clone();
            let peak = Arc::new(AtomicU64::new(0));
            source.io_peak = Some(peak.clone());
            let target = MemoryStorage { io_peak: Some(peak.clone()), ..MemoryStorage::default() };
            let scratch = MemoryStorage { io_peak: Some(peak.clone()), ..MemoryStorage::default() };
            let (target, index) = convert_unindexed_resizable_journal(&mut source, target, scratch, digest).unwrap();
            assert_eq!(source.bytes, before);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
            assert_eq!(crate::io_buffer::WRITEBACK_MEMORY.usage().0, 0);
            let expected = 2 * (LEGACY_SORT_RUN_RECORDS * core::mem::size_of::<LegacyMutationReference>()
                + 2 * LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES);
            assert!(peak.load(Ordering::Relaxed) as usize >= baseline + expected);
            assert!(peak.load(Ordering::Relaxed) as usize <= baseline + 6 * 1024 * 1024);
            let end = target.bytes.len() as u64;
            let mut reopened = OverlayJournal::open_with_checkpoint_metadata(target, index, digest, end).unwrap();
            assert_eq!(reopened.checkpoint.as_mut().unwrap().count(), count as u64);
            assert!(reopened.checkpoint.as_mut().unwrap().lookup(7, 0).unwrap().unwrap().is_tombstone());
            assert!(reopened.checkpoint.as_mut().unwrap().lookup(7, count as u64 - 1).unwrap().unwrap().is_tombstone());
            drop(reopened);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn reserved_dirty_size_slots_sort_replace_and_retain_without_growth() {
        let mut sizes = DirtyFileSizes::new().unwrap();
        let capacity = sizes.entries.capacity();
        let fault = fail_cache_after(0);
        for inode in (1..=CACHE_BLOCKS as u64).rev() { sizes.insert(inode, inode * 2); }
        sizes.insert(7, 999);
        assert_eq!(sizes.get(&7), Some(&999));
        assert_eq!(sizes.iter().map(|(&inode, _)| inode).collect::<Vec<_>>(), (1..=CACHE_BLOCKS as u64).collect::<Vec<_>>());
        sizes.retain(|inode, _| inode % 2 == 0);
        for inode in 100..100 + CACHE_BLOCKS as u64 / 2 { sizes.insert(inode, inode); }
        assert_eq!(sizes.len(), CACHE_BLOCKS);
        assert_eq!(sizes.entries.capacity(), capacity);
        assert!(matches!(cache_vector::<u8>(1), Err(Errno::ENOMEM)));
        drop(fault);
    }

    #[test]
    fn io_quota_refusal_keeps_the_writer_retryable_without_publishing_bytes() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [101; 32]).unwrap();
        let before = journal.storage.bytes.clone();
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let mutations = [Mutation::Put { key: inode_key(), value: b"admitted later".to_vec() }];
        {
            let _limit = crate::io_buffer::test_budget(used);
            assert_eq!(journal.commit(&mutations), Err(Errno::ENOMEM));
            assert_eq!(journal.storage.bytes, before);
            assert_eq!(journal.failure, None);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, used);
        }
        journal.commit(&mutations).unwrap();
        assert_eq!(journal.state.lookup(&inode_key()), Some(Some(&b"admitted later"[..])));
    }

    #[test]
    fn accepted_dirty_cache_drains_when_ordinary_io_admission_is_exhausted() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [102; 32]).unwrap();
        let source = vec![17; CACHE_BLOCKS * FILE_BLOCK_BYTES];
        journal.write_fixed_file_at_buffered(7, source.len() as u64, 0, &source, |_, _| panic!("full blocks need no base read")).unwrap();
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let tail = vec![23; FILE_BLOCK_BYTES];
        {
            let _limit = crate::io_buffer::test_budget(used);
            assert_eq!(journal.write_fixed_file_at_buffered(7, source.len() as u64, 0, &tail, |_, _| unreachable!()), Err(Errno::ENOMEM));
            let mut visible = vec![0; source.len()];
            journal.read_file_at(7, source.len() as u64, 0, &mut visible, |_, _| unreachable!()).unwrap();
            assert_eq!(visible, source);
            journal.sync().unwrap();
            assert!(journal.dirty_blocks.is_empty());
            assert_eq!(crate::io_buffer::WRITEBACK_MEMORY.usage().0, 0);
            assert!(crate::io_buffer::IO_MEMORY.usage().0 < used);
            journal.write_fixed_file_at_buffered(7, source.len() as u64, 0, &tail, |_, _| unreachable!()).unwrap();
            journal.sync().unwrap();
        }
        let mut reopened = OverlayJournal::open(journal.into_storage(), [102; 32]).unwrap();
        let mut visible = vec![0; source.len()];
        reopened.read_file_at(7, source.len() as u64, 0, &mut visible, |_, _| unreachable!()).unwrap();
        assert_eq!(&visible[..FILE_BLOCK_BYTES], &tail);
        assert_eq!(&visible[FILE_BLOCK_BYTES..], &source[FILE_BLOCK_BYTES..]);
        drop(reopened);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn clean_read_cache_evicts_owned_payload_before_retrying_admission() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [103; 32]).unwrap();
        for block in 0..2 {
            journal.commit(&[Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block }, value: vec![block as u8 + 31; FILE_BLOCK_BYTES] }]).unwrap();
        }
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(used + 2 * FILE_BLOCK_BYTES);
        let mut visible = [0; FILE_BLOCK_BYTES];
        for block in [0, 1, 0, 1] {
            journal.read_file_at(7, 2 * FILE_BLOCK_BYTES as u64, block * FILE_BLOCK_BYTES as u64, &mut visible, |_, _| unreachable!()).unwrap();
            assert_eq!(visible, [block as u8 + 31; FILE_BLOCK_BYTES]);
            assert_eq!(journal.block_cache.len(), 1);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, used + 2 * FILE_BLOCK_BYTES);
        }
    }

    #[test]
    fn failed_write_buffer_preparation_does_not_publish_any_new_dirty_data() {
        for failure_after in 0..3 {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), [83; 32]).unwrap();
            let source = vec![b'w'; 2 * FILE_BLOCK_BYTES];
            let fault = fail_cache_after(failure_after);
            let result = journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks need no base"));
            drop(fault);
            assert_eq!(result, Err(Errno::ENOMEM));
            assert!(journal.dirty_blocks.is_empty());
            assert!(journal.dirty_sizes.is_empty());
            assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
            assert_eq!(journal.storage.flushes, 1);
            assert_eq!(journal.failure, None);
            assert_eq!(journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks need no base")), Ok(source.len()));
            journal.sync().unwrap();
        }
    }

    #[test]
    fn cache_staging_failure_keeps_sync_dirty_bytes_and_sizes_retryable() {
        for failure_after in 0..4 {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), [84; 32]).unwrap();
            let source = vec![b's'; 2 * FILE_BLOCK_BYTES];
            journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks need no base")).unwrap();
            let revision = journal.compaction_revision();
            let fault = fail_cache_after(failure_after);
            let result = journal.sync();
            drop(fault);
            assert_eq!(result, Err(Errno::ENOMEM));
            assert_eq!(journal.compaction_revision(), revision);
            assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
            assert_eq!(journal.storage.flushes, 1);
            assert_eq!(journal.failure, None);
            assert_eq!(journal.dirty_blocks.len(), 2);
            assert_eq!(journal.dirty_sizes.get(&7), Some(&(source.len() as u64)));
            let mut actual = vec![0; source.len()];
            assert_eq!(journal.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("dirty bytes must remain resident")), Ok(source.len()));
            assert_eq!(actual, source);
            journal.sync().unwrap();
            let mut reopened = OverlayJournal::open(journal.into_storage(), [84; 32]).unwrap();
            assert_eq!(reopened.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("synced bytes must be journaled")), Ok(source.len()));
            assert_eq!(actual, source);
        }
    }

    #[test]
    fn eviction_preparation_failure_preserves_every_victim_and_rejects_new_bytes() {
        for failure_after in 0..21 {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), [85; 32]).unwrap();
            let source = vec![b'a'; CACHE_BLOCKS * FILE_BLOCK_BYTES];
            journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks need no base")).unwrap();
            let revision = journal.compaction_revision();
            let next = vec![b'z'; FILE_BLOCK_BYTES];
            let fault = fail_cache_after(failure_after);
            let result = journal.write_file_at_buffered(7, 0, source.len() as u64, &next, |_, _| panic!("full blocks need no base"));
            drop(fault);
            assert_eq!(result, Err(Errno::ENOMEM), "allocation {failure_after}");
            assert_eq!(journal.compaction_revision(), revision);
            assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
            assert_eq!(journal.storage.flushes, 1);
            assert_eq!(journal.failure, None);
            assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
            assert_eq!(journal.dirty_sizes.get(&7), Some(&(source.len() as u64)));
            for (position, (key, bytes)) in journal.dirty_blocks.iter().enumerate() {
                assert_eq!(*key, (7, position as u64));
                assert!(bytes.iter().all(|&byte| byte == b'a'));
            }
            assert_eq!(journal.write_file_at_buffered(7, 0, source.len() as u64, &next, |_, _| panic!("full blocks need no base")), Ok(next.len()));
            journal.sync().unwrap();
            let mut reopened = OverlayJournal::open(journal.into_storage(), [85; 32]).unwrap();
            let mut actual = vec![0; source.len() + next.len()];
            assert_eq!(reopened.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("all accepted bytes must be journaled")), Ok(actual.len()));
            assert_eq!(&actual[..source.len()], source.as_slice());
            assert_eq!(&actual[source.len()..], next.as_slice());
        }
    }

    #[test]
    fn cache_exhaustion_after_one_large_write_chunk_returns_only_its_accepted_prefix() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [86; 32]).unwrap();
        let source = vec![b'p'; (CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES];
        let fault = fail_cache_after(CACHE_BLOCKS + 1);
        let result = journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks need no base"));
        drop(fault);
        let prefix = CACHE_BLOCKS * FILE_BLOCK_BYTES;
        assert_eq!(result, Ok(prefix));
        assert_eq!(journal.dirty_sizes.get(&7), Some(&(prefix as u64)));
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
        assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
        assert_eq!(journal.write_file_at_buffered(7, 0, prefix as u64, &source[prefix..], |_, _| panic!("full blocks need no base")), Ok(FILE_BLOCK_BYTES));
        journal.sync().unwrap();
        let mut reopened = OverlayJournal::open(journal.into_storage(), [86; 32]).unwrap();
        let mut actual = vec![0; source.len()];
        assert_eq!(reopened.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("accepted prefix and retry must be journaled")), Ok(source.len()));
        assert_eq!(actual, source);
    }

    #[test]
    fn returned_metadata_keeps_admission_through_resident_indexed_and_cached_reads() {
        for source in 0..3 {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), [89; 32]).unwrap();
            let key = directory_key(b"owned");
            journal.commit(&[Mutation::Put { key: key.clone(), value: 7u64.to_le_bytes().to_vec() }]).unwrap();
            if source > 0 {
                journal = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
                journal.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
                journal.release_checkpoint_metadata().unwrap();
                if source == 2 {
                    drop(journal.metadata_value(&key).unwrap());
                    journal.checkpoint.as_mut().unwrap().reclaim_supplemental_read_cache();
                }
            }
            let committed = journal.storage.bytes.clone();
            let before = crate::io_buffer::IO_MEMORY.usage().0;
            let _budget = crate::io_buffer::test_budget(before + 16);
            let value = journal.metadata_value(&key).unwrap().unwrap().unwrap();
            assert_eq!(value.as_ref(), &7u64.to_le_bytes());
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before + 16);
            assert_eq!(journal.metadata_value(&key), Err(Errno::ENOMEM));
            assert_eq!(journal.storage.bytes, committed);
            drop(value);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
            let value = journal.metadata_value(&key).unwrap().unwrap().unwrap();
            assert_eq!(value.as_ref(), &7u64.to_le_bytes());
            drop(value);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
        }
    }

    #[test]
    fn metadata_cache_copy_failure_preserves_entries_and_allows_retry() {
        for failure_after in 0..3 {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), [87; 32]).unwrap();
            let key = directory_key(b"cached");
            journal.commit(&[Mutation::Put { key: key.clone(), value: 7u64.to_le_bytes().to_vec() }]).unwrap();
            let mut journal = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
            journal.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
            journal.release_checkpoint_metadata().unwrap();
            let committed = journal.storage.bytes.clone();
            journal.checkpoint.as_mut().unwrap().lookup_metadata(&key).unwrap();
            journal.checkpoint.as_mut().unwrap().reclaim_supplemental_read_cache();
            let fault = fail_cache_after(failure_after);
            let result = journal.metadata_value(&key);
            drop(fault);
            assert_eq!(result, Err(Errno::ENOMEM));
            assert!(journal.metadata_cache.is_empty());
            assert_eq!(journal.storage.bytes, committed);
            assert_eq!(journal.failure, None);
            assert_eq!(journal.metadata_value(&key), Ok(Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap()))));
            assert_eq!(journal.metadata_cache.len(), 1);
            let fault = fail_cache_after(0);
            let hit = journal.metadata_value(&key);
            drop(fault);
            assert_eq!(hit, Err(Errno::ENOMEM));
            assert_eq!(journal.metadata_cache.len(), 1);
            assert_eq!(journal.metadata_cache[0].key, key);
            assert_eq!(journal.metadata_value(&key), Ok(Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap()))));
        }
    }

    #[test]
    fn read_cache_miss_exhaustion_does_not_change_the_destination_and_hits_do_not_allocate() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [88; 32]).unwrap();
        journal.commit(&[Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![b'r'; FILE_BLOCK_BYTES] }]).unwrap();
        let mut actual = [9; 8];
        let fault = fail_cache_after(0);
        let result = journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut actual, |_, _| panic!("block must be journaled"));
        drop(fault);
        assert_eq!(result, Err(Errno::ENOMEM));
        assert_eq!(actual, [9; 8]);
        assert!(journal.block_cache.is_empty());
        assert_eq!(journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut actual, |_, _| panic!("block must be journaled")), Ok(8));
        let fault = fail_cache_after(0);
        assert_eq!(journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut actual, |_, _| panic!("cache hit must not read base")), Ok(8));
        assert_eq!(&actual, b"rrrrrrrr");
        assert!(matches!(cache_vector::<u8>(1), Err(Errno::ENOMEM)));
        drop(fault);
    }

    #[test]
    fn indexed_metadata_length_is_checked_before_cache_allocation() {
        let mut storage = MemoryStorage::default();
        let entry = MetadataCheckpointEntry { key: inode_key(), value: Some((72, 4097)), value_digest: None };
        let mut bytes = Vec::new();
        let fault = fail_cache_after(0);
        assert_eq!(read_indexed_metadata(&mut storage, &entry, &mut bytes), Err(Errno::EIO));
        assert!(matches!(cache_vector::<u8>(1), Err(Errno::ENOMEM)));
        drop(fault);
    }

    #[test]
    fn journal_state_nodes_are_prepared_before_any_write_or_flush() {
        for indexed in [false, true] {
            for failure_after in 0..if indexed { 8 } else { 6 } {
                let digest = [79; 32];
                let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
                journal.commit(&[
                    Mutation::Put { key: inode_key(), value: b"old".to_vec() },
                    Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 5 }, value: vec![1; FILE_BLOCK_BYTES] },
                ]).unwrap();
                if indexed { journal.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap(); }
                let transaction = [
                    Mutation::Put { key: inode_key(), value: b"new".to_vec() },
                    Mutation::Put { key: directory_key(b"new"), value: 7u64.to_le_bytes().to_vec() },
                    Mutation::Put { key: OverlayKey::FileZeroFrom(7), value: 3u64.to_le_bytes().to_vec() },
                    Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 4 }, value: vec![2; FILE_BLOCK_BYTES] },
                    Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 5 } },
                    Mutation::Put { key: OverlayKey::FileZeroFrom(7), value: 2u64.to_le_bytes().to_vec() },
                ];
                let before_bytes = journal.storage.bytes.clone();
                let before_flushes = journal.storage.flushes;
                let before_revision = journal.compaction_revision();
                let before_entries = journal.state.metadata_entries().map(|(key, value)| (key.clone(), value.map(<[u8]>::to_vec))).collect::<Vec<_>>();
                let before_blocks = journal.state.blocks.iter().map(|(key, value)| (*key, value.map(|location| (location.offset, location.digest)))).collect::<Vec<_>>();
                crate::prepared_map::fail_after_allocations(failure_after);
                assert_eq!(journal.commit(&transaction), Err(Errno::ENOMEM), "indexed={indexed}, allocation={failure_after}");
                assert_eq!(journal.storage.bytes, before_bytes);
                assert_eq!(journal.storage.flushes, before_flushes);
                assert_eq!(journal.compaction_revision(), before_revision);
                assert_eq!(journal.failure, None);
                assert_eq!(journal.state.metadata_entries().map(|(key, value)| (key.clone(), value.map(<[u8]>::to_vec))).collect::<Vec<_>>(), before_entries);
                assert_eq!(journal.state.blocks.iter().map(|(key, value)| (*key, value.map(|location| (location.offset, location.digest)))).collect::<Vec<_>>(), before_blocks);
                assert!(journal.state.invalid_checkpoint_from.is_empty());
                journal.commit(&transaction).unwrap();
                assert_eq!(journal.state.lookup(&inode_key()), Some(Some(&b"new"[..])));
                assert_eq!(journal.state.zero_from(7), Ok(Some(2)));
                assert!(journal.state.blocks.is_empty());
                assert_eq!(journal.state.invalid_checkpoint_from.get(&7).copied(), indexed.then_some(2));
                let reopened = OverlayJournal::open(journal.into_storage(), digest).unwrap();
                assert_eq!(reopened.state.lookup(&inode_key()), Some(Some(&b"new"[..])));
                assert_eq!(reopened.state.zero_from(7), Ok(Some(2)));
            }
        }
    }

    #[test]
    fn state_preparation_exhaustion_keeps_buffered_data_readable_and_retryable() {
        let digest = [82; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        let mut source = vec![b'z'; FILE_BLOCK_BYTES];
        source[..8].copy_from_slice(b"buffered");
        assert_eq!(journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full block has no base read")), Ok(FILE_BLOCK_BYTES));
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(journal.sync(), Err(Errno::ENOMEM));
        assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
        assert_eq!(journal.storage.flushes, 1);
        assert_eq!(journal.failure, None);
        assert_eq!(journal.dirty_blocks.len(), 1);
        assert_eq!(journal.dirty_sizes.get(&7), Some(&(FILE_BLOCK_BYTES as u64)));
        let mut actual = [0; 8];
        assert_eq!(journal.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("dirty data must remain readable")), Ok(8));
        assert_eq!(&actual, b"buffered");
        journal.sync().unwrap();
        assert!(journal.dirty_blocks.is_empty());
        assert!(journal.dirty_sizes.is_empty());
        let mut reopened = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        assert_eq!(reopened.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("synced block must be journaled")), Ok(8));
        assert_eq!(&actual, b"buffered");
    }

    #[test]
    fn aggregate_state_exhaustion_drops_all_staged_credits_without_publishing_or_poisoning() {
        let baseline = crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [111; 32]).unwrap();
        journal.commit(&[Mutation::Put { key: inode_key(), value: b"old".to_vec() }]).unwrap();
        let before_usage = crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0;
        let reservation = PreparedEntry::<OverlayKey, Option<Vec<u8>>>::reserve(1).unwrap();
        let allowance = reservation.bytes();
        drop(reservation);
        let before = journal.storage.bytes.clone();
        let revision = journal.compaction_revision();
        let transaction = [
            Mutation::Put { key: OverlayKey::Inode(8), value: b"a".to_vec() },
            Mutation::Put { key: OverlayKey::Inode(9), value: b"b".to_vec() },
        ];
        {
            let _budget = crate::prepared_map::test_budget(before_usage + allowance);
            assert_eq!(journal.commit(&transaction), Err(Errno::ENOMEM));
            assert_eq!(crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0, before_usage);
            assert_eq!(journal.storage.bytes, before);
            assert_eq!(journal.compaction_revision(), revision);
            assert_eq!(journal.failure, None);
            assert_eq!(journal.state.lookup(&inode_key()), Some(Some(&b"old"[..])));
            assert_eq!(journal.state.lookup(&OverlayKey::Inode(8)), None);
        }
        journal.commit(&transaction).unwrap();
        assert_eq!(journal.state.lookup(&OverlayKey::Inode(8)), Some(Some(&b"a"[..])));
        drop(journal);
        assert_eq!(crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0, baseline);
    }

    #[test]
    fn reserved_writeback_drains_accepted_data_and_timestamps_before_compaction_at_the_limit() {
        let baseline = crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [112; 32]).unwrap();
        let source = vec![9; CACHE_BLOCKS * FILE_BLOCK_BYTES];
        assert_eq!(journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks")), Ok(source.len()));
        let budget = crate::prepared_map::test_budget(baseline + 1);
        journal.sync().unwrap();
        assert!(journal.dirty_blocks.is_empty());
        assert!(crate::prepared_map::writeback_reserve_in_use());
        assert!(crate::rootfs::journal_state_memory_pressure());
        assert_eq!(journal.write_file_at_buffered(7, 0, source.len() as u64, &[1; FILE_BLOCK_BYTES], |_, _| panic!("must reject before I/O")), Err(Errno::ENOMEM));
        let timestamps = (100u64..164).map(|inode| Mutation::Put {
            key: OverlayKey::Inode(inode), value: vec![1; 52],
        }).collect::<Vec<_>>();
        journal.tail_limit_bytes = Some(0);
        assert_eq!(journal.commit(&timestamps), Err(Errno::ENOSPC));
        journal.commit_writeback_metadata(&timestamps).unwrap();
        journal.commit_writeback_metadata(&timestamps).unwrap();
        assert!(crate::prepared_map::JOURNAL_WRITEBACK_MEMORY.usage().0 <= crate::prepared_map::JOURNAL_WRITEBACK_HEADROOM);
        let mut compacted = journal.compact_metadata_reachable_into(MemoryStorage::default(), |_, _| true).unwrap();
        compacted.install_metadata_block_checkpoint(Box::new(MemoryStorage::default())).unwrap();
        compacted.release_checkpoint_metadata().unwrap();
        drop(journal);
        assert!(!crate::prepared_map::writeback_reserve_in_use());
        assert_eq!(crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0, baseline);
        drop(budget);
        let mut actual = [0; FILE_BLOCK_BYTES];
        assert_eq!(compacted.read_file_at(7, 0, 0, &mut actual, |_, _| panic!("compacted block")), Ok(FILE_BLOCK_BYTES));
        assert_eq!(actual, [9; FILE_BLOCK_BYTES]);
        assert_eq!(compacted.write_file_at_buffered(7, 0, source.len() as u64, &[2; FILE_BLOCK_BYTES], |_, _| panic!("full block")), Ok(FILE_BLOCK_BYTES));
        compacted.sync().unwrap();
    }

    #[test]
    fn emergency_eviction_rejects_new_bytes_but_keeps_all_previously_accepted_blocks_flushable() {
        let baseline = crate::prepared_map::JOURNAL_STATE_MEMORY.usage().0;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [113; 32]).unwrap();
        let source = vec![7; CACHE_BLOCKS * FILE_BLOCK_BYTES];
        assert_eq!(journal.write_file_at_buffered(7, 0, 0, &source, |_, _| panic!("full blocks")), Ok(source.len()));
        let _budget = crate::prepared_map::test_budget(baseline + 1);
        assert_eq!(journal.write_file_at_buffered(7, 0, source.len() as u64, &[8; FILE_BLOCK_BYTES], |_, _| panic!("full block")), Err(Errno::ENOMEM));
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS - CACHE_BLOCKS / 4);
        journal.sync().unwrap();
        assert!(journal.dirty_blocks.is_empty());
        assert_eq!(journal.visible_file_size(7, 0), Ok(source.len() as u64));
        for block in 0..CACHE_BLOCKS {
            let mut actual = [0; FILE_BLOCK_BYTES];
            assert_eq!(journal.read_file_at(7, 0, block as u64 * FILE_BLOCK_BYTES as u64,
                &mut actual, |_, _| panic!("accepted block must survive")), Ok(FILE_BLOCK_BYTES));
            assert_eq!(actual, [7; FILE_BLOCK_BYTES]);
        }
        drop(journal);
        assert!(!crate::prepared_map::writeback_reserve_in_use());
    }

    #[test]
    fn successful_flush_does_not_allocate_journal_state_nodes() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [80; 32]).unwrap();
        journal.storage.fail_map_allocation_after_flush = true;
        let committed = journal.commit(&[
            Mutation::Put { key: inode_key(), value: b"committed".to_vec() },
            Mutation::Put { key: directory_key(b"committed"), value: 7u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![3; FILE_BLOCK_BYTES] },
        ]);
        let still_armed = PreparedEntry::new(99u64, 0u64);
        assert!(matches!(still_armed, Err(Errno::ENOMEM)));
        assert_eq!(committed, Ok(()));
        assert_eq!(journal.state.lookup(&inode_key()), Some(Some(&b"committed"[..])));
        let reopened = OverlayJournal::open(journal.into_storage(), [80; 32]).unwrap();
        assert_eq!(reopened.state.lookup(&inode_key()), Some(Some(&b"committed"[..])));
    }

    #[test]
    fn transaction_length_preflight_needs_no_io_buffer_allocation() {
        let mutations = [Mutation::Put { key: inode_key(), value: b"contents".to_vec() }];
        let expected = TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES + 23 + 8;
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let _quota = crate::io_buffer::test_budget(baseline);
        assert_eq!(transaction_encoded_length(&mutations), Ok(expected));
        assert_eq!(encode_transaction(1, &mutations), Err(Errno::ENOMEM));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        let invalid = [Mutation::Put { key: directory_key(b"invalid/path"), value: 7u64.to_le_bytes().to_vec() }];
        assert_eq!(transaction_encoded_length(&invalid), Err(Errno::EINVAL));
    }

    #[test]
    fn transaction_size_preflight_accepts_the_exact_limit_and_rejects_extra_records() {
        let mut mutations = Vec::new();
        let mut remaining = MAX_TRANSACTION_BYTES - TRANSACTION_HEADER_BYTES - TRANSACTION_TRAILER_BYTES;
        while remaining > 4096 + 23 {
            mutations.push(Mutation::Put { key: OverlayKey::Inode(mutations.len() as u64 + 1), value: vec![7; 4096] });
            remaining -= 4096 + 23;
        }
        mutations.push(Mutation::Put { key: OverlayKey::Inode(mutations.len() as u64 + 1), value: vec![7; remaining - 23] });
        let encoded = encode_transaction(1, &mutations).unwrap();
        assert_eq!(transaction_encoded_length(&mutations), Ok(MAX_TRANSACTION_BYTES));
        assert_eq!(encoded.len(), MAX_TRANSACTION_BYTES);
        assert_eq!(decode_mutations(&encoded[TRANSACTION_HEADER_BYTES..encoded.len() - TRANSACTION_TRAILER_BYTES]).unwrap().len(), mutations.len());
        mutations.push(Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 0 } });
        assert_eq!(transaction_encoded_length(&mutations), Err(Errno::EFBIG));
        assert_eq!(encode_transaction(1, &mutations), Err(Errno::EFBIG));
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [81; 32]).unwrap();
        assert_eq!(journal.commit(&mutations), Err(Errno::EFBIG));
        assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
        assert_eq!(journal.storage.flushes, 1);
        assert_eq!(journal.failure, None);
    }

    #[test]
    fn borrowed_transaction_records_roundtrip_without_decoding_allocations() {
        let mutations = vec![
            Mutation::Put { key: inode_key(), value: vec![3; 4096] },
            Mutation::Put { key: OverlayKey::FileSize(7), value: 9000u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::FileZeroFrom(7), value: 1u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 9 }, value: vec![8; FILE_BLOCK_BYTES] },
            Mutation::Put { key: directory_key(&[b'n'; 255]), value: 7u64.to_le_bytes().to_vec() },
            Mutation::Delete { key: inode_key() },
            Mutation::Delete { key: OverlayKey::FileSize(7) },
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 8 } },
            Mutation::Delete { key: directory_key(b"removed") },
        ];
        let encoded = encode_transaction(1, &mutations).unwrap();
        let body = &encoded[TRANSACTION_HEADER_BYTES..encoded.len() - TRANSACTION_TRAILER_BYTES];
        {
            let _failure = fail_transaction_after(0);
            let mut records = decode_mutations(body).unwrap();
            assert_eq!(records.len(), mutations.len());
            for remaining in (0..mutations.len()).rev() {
                let record = records.next().unwrap();
                assert_eq!(records.len(), remaining);
                if let Some(value) = record.value {
                    let offset = record.value_offset.unwrap() as usize;
                    assert_eq!(value.as_ptr(), body[offset..].as_ptr());
                }
            }
            assert!(records.next().is_none());
            assert!(records.next().is_none());
            assert_eq!(copy_transaction_bytes(b"still armed"), Err(Errno::ENOMEM));
        }
        let actual = decode_mutations(body).unwrap().map(|record| record.to_owned().unwrap()).collect::<Vec<_>>();
        assert_eq!(actual, mutations);
    }

    #[test]
    fn borrowed_decoder_rejects_every_incomplete_record_without_allocating() {
        let encoded = encode_transaction(1, &[
            Mutation::Put { key: directory_key(b"name"), value: 7u64.to_le_bytes().to_vec() },
        ]).unwrap();
        let body = &encoded[TRANSACTION_HEADER_BYTES..encoded.len() - TRANSACTION_TRAILER_BYTES];
        let _failure = fail_transaction_after(0);
        for length in 1..body.len() {
            assert!(matches!(decode_mutations(&body[..length]), Err(Errno::EIO)), "length={length}");
        }
        assert!(decode_mutations(body).is_ok());
        assert_eq!(copy_transaction_bytes(b"still armed"), Err(Errno::ENOMEM));
    }

    #[test]
    fn replay_validates_the_entire_frame_before_visiting_or_publishing_records() {
        for bad_count in [false, true] {
            let digest = [95; 32];
            let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
            let mut encoded = encode_transaction(1, &[
                Mutation::Put { key: inode_key(), value: b"valid".to_vec() },
                Mutation::Delete { key: inode_key() },
            ]).unwrap();
            if bad_count {
                encoded[16..20].copy_from_slice(&3u32.to_le_bytes());
            } else {
                encoded[TRANSACTION_HEADER_BYTES + 23 + b"valid".len()] = 9;
            }
            let digest_start = encoded.len() - TRANSACTION_TRAILER_BYTES;
            let hash = Sha256::digest(&encoded[..digest_start]);
            encoded[digest_start..digest_start + 32].copy_from_slice(&hash);
            storage.bytes.extend_from_slice(&encoded);
            let before = storage.bytes.clone();
            let end = storage.bytes.len() as u64;
            let mut visits = 0;
            let mut visit = |_: &DecodedMutation<'_>, _: Option<u64>| { visits += 1; Ok(()) };
            let mut state = OverlayState::default();
            assert_eq!(replay_transactions(&mut storage, HEADER_BYTES as u64, end, 1,
                &mut state, ReplayFilter::All, true, false, None, Some(&mut visit)), Err(Errno::EIO));
            assert_eq!(visits, 0);
            assert!(state.entries.is_empty());
            assert_eq!(storage.bytes, before);
            let mut compacted = CompactedMetadataEntries::new(&mut storage, end, 2);
            assert!(matches!(compacted.next(), Some(Err(Errno::EIO))));
            assert!(compacted.next().is_none());
        }
    }

    #[test]
    fn maximum_record_count_compaction_keeps_one_frame_without_record_vectors() {
        let count = (MAX_TRANSACTION_BYTES - TRANSACTION_HEADER_BYTES - TRANSACTION_TRAILER_BYTES) / 23;
        let mutations = (0..count).map(|block| Mutation::Delete {
            key: OverlayKey::FileBlock { inode: 7, block: block as u64 },
        }).collect::<Vec<_>>();
        let encoded = encode_transaction(1, &mutations).unwrap();
        let digest = [96; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encoded);
        let end = storage.bytes.len() as u64;
        let _failure = fail_transaction_after(1);
        let mut entries = CompactedBlockEntries::new(&mut storage, end, 2, true);
        for block in 0..count {
            let entry = entries.next().unwrap().unwrap();
            assert_eq!((entry.inode, entry.block, entry.offset, entry.digest), (7, block as u64, 0, [0; 32]));
        }
        assert!(entries.next().is_none());
        assert!(entries.next().is_none());
        assert_eq!(entries.transactions.bytes.len(), encoded.len());
        assert!(entries.transactions.bytes.len() <= MAX_TRANSACTION_BYTES);
        assert_eq!(copy_transaction_bytes(b"only the frame allocated"), Err(Errno::ENOMEM));
    }

    #[test]
    fn compaction_reuses_its_frame_buffer_and_borrows_block_payloads() {
        let digest = [97; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        let mut offsets = Vec::new();
        for (sequence, mutation) in [
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![1; FILE_BLOCK_BYTES] },
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 1 } },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 2 }, value: vec![2; FILE_BLOCK_BYTES] },
        ].into_iter().enumerate() {
            offsets.push(storage.bytes.len() as u64 + TRANSACTION_HEADER_BYTES as u64 + 23);
            storage.bytes.extend_from_slice(&encode_transaction(sequence as u64 + 1, &[mutation]).unwrap());
        }
        let end = storage.bytes.len() as u64;
        let _failure = fail_transaction_after(1);
        let mut entries = CompactedBlockEntries::new(&mut storage, end, 4, true);
        for (block, expected) in [Some(1), None, Some(2)].into_iter().enumerate() {
            let entry = entries.next().unwrap().unwrap();
            assert_eq!(entry.block, block as u64);
            assert_eq!(entry.offset, expected.map_or(0, |_| offsets[block]));
            assert_eq!(entry.digest, expected.map_or([0; 32], |byte| Sha256::digest([byte; FILE_BLOCK_BYTES]).into()));
        }
        assert!(entries.next().is_none());
        assert_eq!(copy_transaction_bytes(b"no payload copy or frame growth"), Err(Errno::ENOMEM));
    }

    #[test]
    fn compaction_frame_and_name_copy_failures_leave_source_unchanged() {
        let digest = [98; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encode_transaction(1, &[
            Mutation::Put { key: directory_key(b"entry"), value: 7u64.to_le_bytes().to_vec() },
        ]).unwrap());
        let before = storage.bytes.clone();
        let end = storage.bytes.len() as u64;
        for allocation in 0..2 {
            let _failure = fail_transaction_after(allocation);
            let mut entries = CompactedMetadataEntries::new(&mut storage, end, 2);
            assert!(matches!(entries.next(), Some(Err(Errno::ENOMEM))));
            assert!(entries.next().is_none());
            drop(entries);
            assert_eq!(storage.bytes, before);
        }
        let mut entries = CompactedMetadataEntries::new(&mut storage, end, 2);
        let entry = entries.next().unwrap().unwrap();
        assert_eq!(entry.key, directory_key(b"entry"));
        assert!(entries.next().is_none());
    }

    #[test]
    fn fixed_compaction_rejects_later_metadata_before_returning_a_block() {
        let digest = [100; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encode_transaction(1, &[
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![5; FILE_BLOCK_BYTES] },
            Mutation::Delete { key: inode_key() },
        ]).unwrap());
        let end = storage.bytes.len() as u64;
        let mut entries = CompactedBlockEntries::new(&mut storage, end, 2, false);
        assert!(matches!(entries.next(), Some(Err(Errno::EIO))));
        assert!(entries.next().is_none());
    }

    #[test]
    fn block_recovery_prepares_locations_without_owned_payload_copies() {
        let digest = [101; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encode_transaction(1, &[
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![5; FILE_BLOCK_BYTES] },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 1 }, value: vec![6; FILE_BLOCK_BYTES] },
        ]).unwrap());
        let _failure = fail_transaction_after(1);
        let mut recovered = OverlayJournal::open(storage, digest).unwrap();
        assert_eq!(recovered.state.blocks.len(), 2);
        assert_eq!(copy_transaction_bytes(b"no block payload cloned"), Err(Errno::ENOMEM));
        let mut actual = [0; FILE_BLOCK_BYTES];
        for (block, byte) in [5, 6].into_iter().enumerate() {
            assert_eq!(recovered.read_file_at(7, 2 * FILE_BLOCK_BYTES as u64,
                block as u64 * FILE_BLOCK_BYTES as u64, &mut actual, |_, _| panic!("journal owns block")), Ok(FILE_BLOCK_BYTES));
            assert_eq!(actual, [byte; FILE_BLOCK_BYTES]);
        }
    }

    #[test]
    fn metadata_compaction_does_not_retain_a_record_list_or_copy_values() {
        let count = (MAX_TRANSACTION_BYTES - TRANSACTION_HEADER_BYTES - TRANSACTION_TRAILER_BYTES) / 23;
        let mutations = (0..count).map(|inode| Mutation::Delete {
            key: OverlayKey::Inode(inode as u64 + 1),
        }).collect::<Vec<_>>();
        let encoded = encode_transaction(1, &mutations).unwrap();
        let digest = [102; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encoded);
        let end = storage.bytes.len() as u64;
        let _failure = fail_transaction_after(1);
        let mut entries = CompactedMetadataEntries::new(&mut storage, end, 2);
        for inode in 0..count {
            let entry = entries.next().unwrap().unwrap();
            assert_eq!(entry.key, OverlayKey::Inode(inode as u64 + 1));
            assert_eq!(entry.value, None);
            assert_eq!(entry.value_digest, None);
        }
        assert!(entries.next().is_none());
        assert_eq!(entries.transactions.bytes.len(), encoded.len());
        assert_eq!(copy_transaction_bytes(b"only the frame allocated"), Err(Errno::ENOMEM));
    }

    #[test]
    fn verify_only_replay_borrows_values_without_copying_them() {
        let digest = [99; 32];
        let mut storage = OverlayJournal::open(MemoryStorage::default(), digest).unwrap().into_storage();
        storage.bytes.extend_from_slice(&encode_transaction(1, &[
            Mutation::Put { key: inode_key(), value: vec![4; 4096] },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 }, value: vec![5; FILE_BLOCK_BYTES] },
        ]).unwrap());
        let end = storage.bytes.len() as u64;
        let _failure = fail_transaction_after(1);
        let mut visits = 0;
        let mut visit = |record: &DecodedMutation<'_>, offset: Option<u64>| {
            assert_eq!(record.value.unwrap().len(), 4096);
            assert!(offset.is_some());
            visits += 1;
            Ok(())
        };
        let mut state = OverlayState::default();
        assert_eq!(replay_transactions(&mut storage, HEADER_BYTES as u64, end, 1, &mut state,
            ReplayFilter::VerifyOnly, false, false, None, Some(&mut visit)), Ok((end, 2)));
        assert_eq!(visits, 2);
        assert!(state.entries.is_empty());
        assert!(state.blocks.is_empty());
        assert_eq!(copy_transaction_bytes(b"no value copy"), Err(Errno::ENOMEM));
    }

    #[test]
    fn recovers_atomic_data_and_directory_changes() {
        let digest = [7; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![3; FILE_BLOCK_BYTES],
                },
                Mutation::Put {
                    key: OverlayKey::FileSize(7),
                    value: (FILE_BLOCK_BYTES as u64).to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: directory_key(b"new"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Delete {
                    key: directory_key(b"old"),
                },
            ])
            .unwrap();
        let storage = journal.into_storage();
        assert_eq!(storage.flushes, 2);
        let mut recovered = OverlayJournal::open(storage, digest).unwrap();
        assert_eq!(
            recovered.state().lookup(&inode_key()),
            Some(Some(&b"metadata"[..]))
        );
        assert_eq!(recovered.state().lookup(&directory_key(b"old")), Some(None));
        assert_eq!(
            recovered.state().lookup(&directory_key(b"new")),
            Some(Some(&7u64.to_le_bytes()[..]))
        );
        let mut block = vec![0; FILE_BLOCK_BYTES];
        assert_eq!(
            recovered.read_file_at(7, 0, 0, &mut block, |_, _| panic!("block is journaled")),
            Ok(FILE_BLOCK_BYTES)
        );
        assert_eq!(block, vec![3; FILE_BLOCK_BYTES]);
    }

    #[test]
    fn compaction_stages_only_live_records_and_preserves_the_source() {
        let digest = [23; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"inode".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileSize(7),
                    value: (FILE_BLOCK_BYTES as u64).to_le_bytes().to_vec(),
                },
                Mutation::Delete {
                    key: directory_key(b"removed"),
                },
            ])
            .unwrap();
        for value in 0..10 {
            journal
                .commit(&[Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![value; FILE_BLOCK_BYTES],
                }])
                .unwrap();
        }
        let source_bytes = journal.storage.bytes.clone();
        let compacted = journal.compact_into(MemoryStorage::default()).unwrap();
        let compacted_bytes = compacted.into_storage().bytes;
        assert!(compacted_bytes.len() < source_bytes.len() / 2);
        assert_eq!(journal.storage.bytes, source_bytes);
        assert!(matches!(
            OverlayJournal::open(
                MemoryStorage {
                    bytes: compacted_bytes.clone(),
                    ..MemoryStorage::default()
                },
                [24; 32]
            ),
            Err(Errno::EIO)
        ));
        let mut reopened = OverlayJournal::open(
            MemoryStorage {
                bytes: compacted_bytes,
                ..MemoryStorage::default()
            },
            digest,
        )
        .unwrap();
        assert_eq!(
            reopened.state().lookup(&inode_key()),
            Some(Some(&b"inode"[..]))
        );
        assert_eq!(
            reopened.state().lookup(&directory_key(b"removed")),
            Some(None)
        );
        assert_eq!(
            reopened.state().file_size(7, 0),
            Ok(FILE_BLOCK_BYTES as u64)
        );
        let mut block = vec![0; FILE_BLOCK_BYTES];
        assert_eq!(
            reopened.read_file_at(7, 0, 0, &mut block, |_, _| panic!("block is journaled")),
            Ok(FILE_BLOCK_BYTES)
        );
        assert_eq!(block, vec![9; FILE_BLOCK_BYTES]);
    }

    #[test]
    fn fixed_block_checkpoint_matches_the_current_journal_without_copying_blocks() {
        let digest = [32; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for block in 0..200 {
            journal
                .commit(&[Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block },
                    value: vec![block as u8; FILE_BLOCK_BYTES],
                }])
                .unwrap();
        }
        journal
            .write_fixed_file_at_buffered(
                7,
                200 * FILE_BLOCK_BYTES as u64,
                73 * FILE_BLOCK_BYTES as u64,
                &[9; FILE_BLOCK_BYTES],
                |_, _| panic!("full block needs no base read"),
            )
            .unwrap();
        let checkpoint = journal
            .checkpoint_fixed_blocks_into(MemoryStorage::default())
            .unwrap();
        assert!(journal.dirty_blocks.is_empty());
        let journal_end = journal.end;
        let journal_digest: [u8; 32] =
            Sha256::digest(&journal.storage.bytes[..journal_end as usize]).into();
        let mut reopened = BlockCheckpoint::open(
            checkpoint.into_storage(),
            digest,
            journal_digest,
            journal_end,
        )
        .unwrap();
        assert_eq!(reopened.count(), 200);
        let entry = reopened.lookup(7, 73).unwrap().unwrap();
        let expected_digest: [u8; 32] = Sha256::digest([9; FILE_BLOCK_BYTES]).into();
        assert_eq!(entry.digest, expected_digest);
        assert_eq!(
            &journal.storage.bytes[entry.offset as usize..entry.offset as usize + FILE_BLOCK_BYTES],
            &[9; FILE_BLOCK_BYTES]
        );
        assert_eq!(reopened.lookup(7, 200), Ok(None));
        journal.storage.bytes[entry.offset as usize] ^= 1;
        assert!(matches!(
            journal.checkpoint_fixed_blocks_into(MemoryStorage::default()),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn legacy_block_reference_sort_merges_multiple_bounded_runs() {
        let count = LEGACY_SORT_RUN_RECORDS as u64 * 2 + 3;
        let mut scratch = MemoryStorage::default();
        for position in 0..count {
            let reference = LegacyBlockReference {
                inode: 7,
                block: count - position - 1,
                order: position,
                offset: 72,
                digest: [0; 32],
            };
            scratch.write_all_at(position * LEGACY_SORT_RECORD_BYTES, &reference.encode()).unwrap();
        }
        let mut target = MemoryStorage::default();
        sort_legacy_block_references(&mut scratch, &mut target, count).unwrap();
        assert!(target.bytes.is_empty());
        for position in 0..count {
            let reference = legacy_record_at(&mut scratch, position).unwrap();
            assert_eq!(reference.block, position);
            assert_eq!(reference.order, count - position - 1);
        }
    }

    #[test]
    fn legacy_block_reference_rejects_a_changed_key_or_order() {
        let reference = LegacyBlockReference {
            inode: 7,
            block: 8,
            order: 9,
            offset: 72,
            digest: [1; 32],
        };
        for position in [0, 8, 16, 24, 32, 64] {
            let mut bytes = reference.encode();
            bytes[position] ^= 1;
            assert!(matches!(LegacyBlockReference::decode(bytes), Err(Errno::EIO)));
        }
    }

    #[test]
    fn unindexed_fixed_conversion_streams_latest_blocks_into_v5_checkpoint() {
        let digest = [54; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for block in 0..300 {
            journal.commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block },
                value: vec![block as u8; FILE_BLOCK_BYTES],
            }]).unwrap();
        }
        journal.commit(&[
            Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'x'; FILE_BLOCK_BYTES],
            },
            Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'y'; FILE_BLOCK_BYTES],
            },
        ]).unwrap();
        let mut source = journal.into_storage();
        source.bytes.extend_from_slice(b"torn");
        let original = source.bytes.clone();
        let (target, index) = convert_unindexed_fixed_journal(
            &mut source,
            MemoryStorage::default(),
            MemoryStorage::default(),
            digest,
        ).unwrap();
        assert_eq!(source.bytes, original);
        assert_eq!(&index.bytes[..4], b"KIDX");
        assert_eq!(u32::from_le_bytes(index.bytes[4..8].try_into().unwrap()), 5);
        assert_eq!(u64::from_le_bytes(index.bytes[80..88].try_into().unwrap()), 300);
        let checkpoint_end = target.bytes.len() as u64;
        let mut reopened = OverlayJournal::open_with_checkpoint(target, index, digest, checkpoint_end).unwrap();
        let mut block = [0; FILE_BLOCK_BYTES];
        assert_eq!(reopened.read_file_at(7, 300 * FILE_BLOCK_BYTES as u64, 0, &mut block, |_, _| panic!("block is journaled")), Ok(FILE_BLOCK_BYTES));
        assert_eq!(block, [b'y'; FILE_BLOCK_BYTES]);
        assert_eq!(reopened.read_file_at(7, 300 * FILE_BLOCK_BYTES as u64, 299 * FILE_BLOCK_BYTES as u64, &mut block, |_, _| panic!("block is journaled")), Ok(FILE_BLOCK_BYTES));
        assert_eq!(block, [(299 % 256) as u8; FILE_BLOCK_BYTES]);
    }

    #[test]
    fn unindexed_fixed_conversion_rejects_corruption_without_changing_source() {
        let digest = [55; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::FileBlock { inode: 7, block: 0 },
            value: vec![b'a'; FILE_BLOCK_BYTES],
        }]).unwrap();
        let mut source = journal.into_storage();
        source.bytes[HEADER_BYTES + TRANSACTION_HEADER_BYTES + 20] ^= 1;
        let original = source.bytes.clone();
        assert!(matches!(
            convert_unindexed_fixed_journal(&mut source, MemoryStorage::default(), MemoryStorage::default(), digest),
            Err(Errno::EIO)
        ));
        assert_eq!(source.bytes, original);
    }

    #[test]
    fn unindexed_fixed_conversion_failures_never_change_the_source() {
        let digest = [56; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::FileBlock { inode: 7, block: 0 },
            value: vec![b'a'; FILE_BLOCK_BYTES],
        }]).unwrap();
        let original = journal.into_storage().bytes;
        for fault in ["scratch-write", "target-write", "target-flush"] {
            let mut source = MemoryStorage { bytes: original.clone(), ..MemoryStorage::default() };
            let target = MemoryStorage {
                fail_write_after_bytes: (fault == "target-write").then_some(3),
                fail_flush: fault == "target-flush",
                ..MemoryStorage::default()
            };
            let scratch = MemoryStorage {
                fail_write_after_bytes: (fault == "scratch-write").then_some(3),
                ..MemoryStorage::default()
            };
            assert!(matches!(
                convert_unindexed_fixed_journal(&mut source, target, scratch, digest),
                Err(Errno::EIO)
            ), "{fault}");
            assert_eq!(source.bytes, original, "{fault}");
        }
    }

    #[test]
    fn legacy_mutation_reference_sort_merges_multiple_bounded_runs() {
        let count = LEGACY_SORT_RUN_RECORDS as u64 * 2 + 3;
        let mut scratch = MemoryStorage::default();
        for position in 0..count {
            let reference = LegacyMutationReference {
                kind: 3,
                inode: 7,
                block: count - position - 1,
                marker: 1,
                name: [0; 255],
                name_length: 0,
                order: position,
                offset: 72,
                value_length: FILE_BLOCK_BYTES as u32,
                digest: [1; 32],
                deleted: false,
            };
            scratch.write_all_at(position * LEGACY_MUTATION_RECORD_BYTES as u64, &reference.encode()).unwrap();
        }
        let mut target = MemoryStorage::default();
        sort_legacy_mutations(&mut scratch, &mut target, count).unwrap();
        assert!(target.bytes.is_empty());
        let mut reader = LegacyMutationCursor::new().unwrap();
        reader.reset(0, count);
        for position in 0..count {
            let reference = reader.next(&mut scratch).unwrap().unwrap();
            assert_eq!(reference.block, position);
            assert_eq!(reference.order, count - position - 1);
        }
        assert!(reader.next(&mut scratch).unwrap().is_none());
    }

    #[test]
    fn legacy_mutation_reference_rejects_damaged_key_and_value_location() {
        let reference = LegacyMutationReference {
            kind: 4,
            inode: 7,
            block: 0,
            marker: 0,
            name: {
                let mut name = [0; 255];
                name[..3].copy_from_slice(b"foo");
                name
            },
            name_length: 3,
            order: 9,
            offset: 72,
            value_length: 8,
            digest: [1; 32],
            deleted: false,
        };
        for position in [0, 2, 4, 20, 28, 36, 40, 72, 352] {
            let mut bytes = reference.encode();
            bytes[position] ^= 1;
            assert!(matches!(LegacyMutationReference::decode(bytes), Err(Errno::EIO)));
        }
    }

    #[test]
    fn unindexed_resizable_conversion_preserves_metadata_truncation_and_later_blocks() {
        let digest = [57; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[
            Mutation::Put { key: OverlayKey::Inode(7), value: b"first".to_vec() },
            Mutation::Put { key: OverlayKey::FileSize(7), value: (4 * FILE_BLOCK_BYTES as u64).to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"old".to_vec() }, value: 7u64.to_le_bytes().to_vec() },
        ]).unwrap();
        for block in 0..4 {
            journal.commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block },
                value: vec![b'a' + block as u8; FILE_BLOCK_BYTES],
            }]).unwrap();
        }
        journal.commit(&[
            Mutation::Put { key: OverlayKey::FileZeroFrom(7), value: 1u64.to_le_bytes().to_vec() },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"old".to_vec() } },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"new".to_vec() }, value: 7u64.to_le_bytes().to_vec() },
        ]).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::FileBlock { inode: 7, block: 1 }, value: vec![b'y'; FILE_BLOCK_BYTES],
        }]).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::FileZeroFrom(7), value: 2u64.to_le_bytes().to_vec(),
        }]).unwrap();
        journal.commit(&[
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 2 }, value: vec![b'z'; FILE_BLOCK_BYTES] },
            Mutation::Put { key: OverlayKey::Inode(7), value: b"final".to_vec() },
        ]).unwrap();
        let mut source = journal.into_storage();
        source.bytes.extend_from_slice(b"torn");
        let original = source.bytes.clone();
        let (target, index) = convert_unindexed_resizable_journal(
            &mut source, MemoryStorage::default(), MemoryStorage::default(), digest,
        ).unwrap();
        assert_eq!(source.bytes, original);
        assert_eq!(&index.bytes[..4], b"KIDX");
        assert_eq!(u32::from_le_bytes(index.bytes[4..8].try_into().unwrap()), 4);
        let end = target.bytes.len() as u64;
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(target, index, digest, end).unwrap();
        assert_eq!(reopened.metadata_value(&OverlayKey::Inode(7)).unwrap(), Some(Some(IoBuffer::copy_from(b"final").unwrap())));
        assert_eq!(reopened.metadata_value(&OverlayKey::Dirent { parent: 1, name: b"old".to_vec() }).unwrap(), Some(None));
        assert_eq!(reopened.metadata_value(&OverlayKey::Dirent { parent: 1, name: b"new".to_vec() }).unwrap(), Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap())));
        assert_eq!(reopened.metadata_value(&OverlayKey::FileZeroFrom(7)).unwrap(), Some(Some(IoBuffer::copy_from(&1u64.to_le_bytes()).unwrap())));
        let mut bytes = [0; FILE_BLOCK_BYTES];
        for (block, expected) in [(0, b'a'), (1, b'y'), (2, b'z'), (3, 0)] {
            bytes.fill(0);
            assert_eq!(reopened.read_file_at(
                7, 4 * FILE_BLOCK_BYTES as u64, block * FILE_BLOCK_BYTES as u64,
                &mut bytes, |_, _| panic!("unexpected base read"),
            ), Ok(FILE_BLOCK_BYTES));
            assert_eq!(bytes, [expected; FILE_BLOCK_BYTES]);
        }
    }

    #[test]
    fn unindexed_resizable_conversion_failure_preserves_source() {
        let digest = [58; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::Dirent { parent: 1, name: b"entry".to_vec() },
            value: 7u64.to_le_bytes().to_vec(),
        }]).unwrap();
        let original = journal.into_storage().bytes;
        for fault in ["scratch-write", "target-write", "target-flush"] {
            let mut source = MemoryStorage { bytes: original.clone(), ..MemoryStorage::default() };
            let target = MemoryStorage {
                fail_write_after_bytes: (fault == "target-write").then_some(3),
                fail_flush: fault == "target-flush",
                ..MemoryStorage::default()
            };
            let scratch = MemoryStorage {
                fail_write_after_bytes: (fault == "scratch-write").then_some(3),
                ..MemoryStorage::default()
            };
            assert!(matches!(
                convert_unindexed_resizable_journal(&mut source, target, scratch, digest),
                Err(Errno::EIO)
            ), "{fault}");
            assert_eq!(source.bytes, original, "{fault}");
        }
    }

    #[test]
    fn unindexed_resizable_conversion_rejects_corrupt_source_without_rewriting_it() {
        let digest = [60; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[Mutation::Put {
            key: OverlayKey::Dirent { parent: 1, name: b"entry".to_vec() },
            value: 7u64.to_le_bytes().to_vec(),
        }]).unwrap();
        let mut source = journal.into_storage();
        source.bytes[HEADER_BYTES + TRANSACTION_HEADER_BYTES + 20] ^= 1;
        let original = source.bytes.clone();
        assert!(matches!(
            convert_unindexed_resizable_journal(
                &mut source, MemoryStorage::default(), MemoryStorage::default(), digest,
            ),
            Err(Errno::EIO)
        ));
        assert_eq!(source.bytes, original);
    }

    #[test]
    fn unindexed_resizable_conversion_matches_full_replay_across_ordered_truncations() {
        let digest = [59; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        let mut random = 0x9e3779b97f4a7c15u64;
        for order in 0..500u64 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let block = (random >> 32) % 16;
            let mutation = match order % 11 {
                0 => Mutation::Put {
                    key: OverlayKey::FileZeroFrom(7),
                    value: block.to_le_bytes().to_vec(),
                },
                1 => Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block } },
                2 => Mutation::Put {
                    key: OverlayKey::Dirent { parent: 1, name: alloc::format!("item-{}", block).into_bytes() },
                    value: 7u64.to_le_bytes().to_vec(),
                },
                3 => Mutation::Delete {
                    key: OverlayKey::Dirent { parent: 1, name: alloc::format!("item-{}", block).into_bytes() },
                },
                _ => Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block },
                    value: vec![order as u8; FILE_BLOCK_BYTES],
                },
            };
            journal.commit(&[mutation]).unwrap();
        }
        let mut source = journal.into_storage();
        let mut original = OverlayJournal::open(MemoryStorage { bytes: source.bytes.clone(), ..MemoryStorage::default() }, digest).unwrap();
        let (target, index) = convert_unindexed_resizable_journal(
            &mut source, MemoryStorage::default(), MemoryStorage::default(), digest,
        ).unwrap();
        let end = target.bytes.len() as u64;
        let mut converted = OverlayJournal::open_with_checkpoint_metadata(target, index, digest, end).unwrap();
        let mut expected = [0; FILE_BLOCK_BYTES];
        let mut actual = [0; FILE_BLOCK_BYTES];
        for block in 0..16u64 {
            let offset = block * FILE_BLOCK_BYTES as u64;
            let read_base = |_: u64, destination: &mut [u8]| {
                destination.fill(b'b');
                Ok(destination.len())
            };
            assert_eq!(original.read_file_at(7, 16 * FILE_BLOCK_BYTES as u64, offset, &mut expected, read_base), Ok(FILE_BLOCK_BYTES));
            assert_eq!(converted.read_file_at(7, 16 * FILE_BLOCK_BYTES as u64, offset, &mut actual, read_base), Ok(FILE_BLOCK_BYTES));
            assert_eq!(actual, expected, "block {block}");
            let key = OverlayKey::Dirent { parent: 1, name: alloc::format!("item-{block}").into_bytes() };
            assert_eq!(converted.metadata_value(&key).unwrap(), original.metadata_value(&key).unwrap(), "dirent {block}");
        }
        assert_eq!(
            converted.metadata_value(&OverlayKey::FileZeroFrom(7)).unwrap(),
            original.metadata_value(&OverlayKey::FileZeroFrom(7)).unwrap(),
        );
    }

    #[test]
    fn allocated_file_blocks_merge_checkpoint_tail_and_dirty_cache() {
        let digest = [49; 32];
        let size = 100_001 * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for (inode, block) in [(7, 0), (7, 5), (7, 100_000), (8, 9)] {
            journal.commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode, block },
                value: vec![block as u8; FILE_BLOCK_BYTES],
            }]).unwrap();
        }
        assert_eq!(journal.allocated_file_blocks(7, size), Ok(vec![0, 5, 100_000]));
        let checkpoint = journal.checkpoint_fixed_blocks_into(MemoryStorage::default()).unwrap();
        let journal_end = journal.end;
        let mut reopened = OverlayJournal::open_with_checkpoint(
            journal.into_storage(),
            checkpoint.into_storage(),
            digest,
            journal_end,
        ).unwrap();
        assert_eq!(reopened.allocated_file_blocks(7, size), Ok(vec![0, 5, 100_000]));
        reopened.commit(&[
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 5 } },
            Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 70_000 },
                value: vec![4; FILE_BLOCK_BYTES],
            },
        ]).unwrap();
        reopened.write_fixed_file_at_buffered(
            7,
            size,
            17 * FILE_BLOCK_BYTES as u64,
            &[3; FILE_BLOCK_BYTES],
            |_, _| panic!("full block needs no base read"),
        ).unwrap();
        assert_eq!(reopened.allocated_file_blocks(7, size), Ok(vec![0, 17, 70_000, 100_000]));
        assert_eq!(
            reopened.composed_file_blocks(7, size, size, &[0, 5, 20, 100_000]),
            Ok(vec![0, 17, 20, 70_000, 100_000])
        );
        reopened.truncate_file_at(7, size, 2 * FILE_BLOCK_BYTES as u64, |_, _| {
            panic!("block-aligned truncation needs no base read")
        }).unwrap();
        reopened.truncate_file_at(7, size, size, |_, _| {
            panic!("extension needs no base read")
        }).unwrap();
        assert_eq!(reopened.allocated_file_blocks(7, size), Ok(vec![0]));
        assert_eq!(
            reopened.composed_file_blocks(7, size, size, &[0, 5, 20, 100_000]),
            Ok(vec![0])
        );
    }

    #[test]
    fn positioned_base_block_walk_merges_index_tail_and_dirty_without_a_list() {
        let digest = [62; 32];
        let stride = 1u64 << 20;
        let base_blocks = (1u64 << 30) + 1024;
        let base_size = base_blocks * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: stride } },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: stride * 2 }, value: vec![2; FILE_BLOCK_BYTES] },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 8, block: 0 }, value: vec![8; FILE_BLOCK_BYTES] },
        ]).unwrap();
        let mut compacted = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let index = compacted.checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap().into_storage();
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(), index, digest, end,
        ).unwrap();
        reopened.commit(&[Mutation::Delete {
            key: OverlayKey::FileBlock { inode: 7, block: stride * 3 },
        }]).unwrap();
        let extra = base_blocks + 3;
        for block in [0, extra] {
            reopened.write_file_at_buffered(7, base_size, block * FILE_BLOCK_BYTES as u64,
                &[9; FILE_BLOCK_BYTES], |_, _| panic!("full block needs no base read")).unwrap();
        }
        let stored_length = reopened.storage.bytes.len();
        let size = (extra + 1) * FILE_BLOCK_BYTES as u64;
        let mut next = 0;
        let mut queries = 0;
        let mut count = 0u64;
        let mut sum = 0u64;
        let mut previous = None;
        reopened.visit_composed_file_blocks_from(7, base_size, size, 0..size / FILE_BLOCK_BYTES as u64,
            || {
                queries += 1;
                let block = next;
                next += stride;
                Ok((block < base_blocks).then_some(block as u32))
            },
            |block| {
                assert!(previous.is_none_or(|prior| prior < block));
                previous = Some(block);
                count += 1;
                sum += u64::from(block);
                Ok(true)
            },
        ).unwrap();
        let base_count = base_blocks.div_ceil(stride);
        assert_eq!(count, base_count - 2 + 1);
        assert_eq!(sum, stride * base_count * (base_count - 1) / 2 - 4 * stride + extra);
        assert_eq!(queries, base_count + 1);
        assert_eq!(previous, Some(extra as u32));
        assert_eq!(reopened.storage.bytes.len(), stored_length);
        assert_eq!(reopened.dirty_blocks.len(), 2);
    }

    #[test]
    fn positioned_base_block_walk_is_lazy_and_preserves_source_errors() {
        let size = 16 * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [63; 32]).unwrap();
        let stored_length = journal.storage.bytes.len();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            assert_eq!(journal.visit_composed_file_blocks_from(7, size, size, 0..16,
                || Err(error), |_| panic!("failed source cannot yield a block")), Err(error));
            assert!(journal.failure.is_none());
        }
        let mut queries = 0;
        journal.visit_composed_file_blocks_from(7, size, size, 0..16,
            || { queries += 1; if queries == 1 { Ok(Some(3)) } else { Err(Errno::EIO) } },
            |block| { assert_eq!(block, 3); Ok(false) },
        ).unwrap();
        assert_eq!(queries, 1);
        assert_eq!(journal.visit_composed_file_blocks_from(7, size, size, 0..16,
            || Ok(Some(3)), |_| Err(Errno::ENOMEM)), Err(Errno::ENOMEM));
        for blocks in [[3, 3], [3, 2]] {
            let mut blocks = blocks.into_iter();
            assert_eq!(journal.visit_composed_file_blocks_from(7, size, size, 0..16,
                || Ok(blocks.next()), |_| Ok(true)), Err(Errno::EINVAL));
        }
        assert_eq!(journal.visit_composed_file_blocks_from(7, size, size, 4..16,
            || Ok(Some(3)), |_| Ok(true)), Err(Errno::EINVAL));
        assert_eq!(journal.storage.bytes.len(), stored_length);
        assert!(journal.failure.is_none());
    }

    #[test]
    fn positioned_base_block_walk_does_not_read_fenced_or_empty_base_ranges() {
        let size = 16 * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [64; 32]).unwrap();
        journal.truncate_file_at(7, size, 0, |_, _| panic!("zero truncate needs no base")).unwrap();
        journal.truncate_file_at(7, size, size, |_, _| panic!("extension needs no base")).unwrap();
        journal.write_file_at_buffered(7, size, 3 * FILE_BLOCK_BYTES as u64,
            &[3; FILE_BLOCK_BYTES], |_, _| panic!("full block needs no base")).unwrap();
        let mut visited = 0;
        journal.visit_composed_file_blocks_from(7, size, size, 0..16,
            || panic!("fenced base must not be queried"),
            |block| { assert_eq!(block, 3); visited += 1; Ok(true) },
        ).unwrap();
        assert_eq!(visited, 1);
        journal.visit_composed_file_blocks_from(8, 0, size, 0..16,
            || panic!("created file has no base"), |_| panic!("empty file has no blocks")).unwrap();
        journal.visit_composed_file_blocks_from(8, size, size, 16..32,
            || panic!("past EOF"), |_| panic!("past EOF")).unwrap();
        assert_eq!(journal.visit_composed_file_blocks_from(8, size, size, 3..2,
            || panic!("invalid range"), |_| panic!("invalid range")), Err(Errno::EINVAL));
    }

    #[test]
    fn streamed_dense_block_walk_counts_large_bases_with_overlays() {
        let digest = [61; 32];
        let base_blocks = (1u64 << 20) + 1;
        let base_size = base_blocks * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 5 } },
            Mutation::Put {
                key: OverlayKey::FileBlock { inode: 8, block: 0 },
                value: vec![8; FILE_BLOCK_BYTES],
            },
        ]).unwrap();
        let mut compacted = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let index = compacted.checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap().into_storage();
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(), index, digest, end,
        ).unwrap();
        reopened.commit(&[Mutation::Delete {
            key: OverlayKey::FileBlock { inode: 7, block: 7 },
        }]).unwrap();
        let extra = base_blocks + 2;
        for block in [5, extra] {
            reopened.write_file_at_buffered(
                7, base_size, block * FILE_BLOCK_BYTES as u64, &[9; FILE_BLOCK_BYTES],
                |_, _| panic!("full blocks need no base read"),
            ).unwrap();
        }
        let size = (extra + 1) * FILE_BLOCK_BYTES as u64;
        let stored_length = reopened.storage.bytes.len();
        let mut count = 0u64;
        let mut sum = 0u64;
        let mut previous = None;
        reopened.for_each_composed_file_block(7, base_size, size, None, |block| {
            assert!(previous.is_none_or(|prior| prior < block));
            previous = Some(block);
            count += 1;
            sum += u64::from(block);
            Ok(())
        }).unwrap();
        assert_eq!(count, base_blocks);
        assert_eq!(sum, base_blocks * (base_blocks - 1) / 2 - 7 + extra);
        assert_eq!(previous, Some(extra as u32));
        assert_eq!(reopened.storage.bytes.len(), stored_length);
        assert_eq!(reopened.dirty_blocks.len(), 2);
        assert_eq!(reopened.for_each_composed_file_block(7, base_size, size, None, |_| Err(Errno::EIO)), Err(Errno::EIO));
        assert!(reopened.failure.is_none());
        assert_eq!(reopened.for_each_composed_file_block(7, base_size, size, Some(&[2, 1]), |_| Ok(())), Err(Errno::EINVAL));

        reopened.truncate_file_at(7, base_size, 2 * FILE_BLOCK_BYTES as u64, |_, _| {
            panic!("aligned truncation needs no base read")
        }).unwrap();
        reopened.truncate_file_at(7, base_size, size, |_, _| {
            panic!("extension needs no base read")
        }).unwrap();
        let mut remaining = Vec::new();
        reopened.for_each_composed_file_block(7, base_size, size, None, |block| {
            remaining.push(block);
            Ok(())
        }).unwrap();
        assert_eq!(remaining, vec![0, 1]);
    }

    #[test]
    fn composed_block_ranges_seek_and_preserve_checkpoint_tail_and_dirty_precedence() {
        let digest = [112; 32];
        let high = 10_000_000u64;
        let base_size = (high + 1) * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[
            Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 5 } },
            Mutation::Put { key: OverlayKey::FileBlock { inode: 8, block: 0 }, value: vec![8; FILE_BLOCK_BYTES] },
        ]).unwrap();
        let mut compacted = journal.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let index = compacted.checkpoint_blocks_with_metadata_into(MemoryStorage::default()).unwrap().into_storage();
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(compacted.into_storage(), index, digest, end).unwrap();
        reopened.commit(&[Mutation::Delete { key: OverlayKey::FileBlock { inode: 7, block: 7 } }]).unwrap();
        reopened.write_file_at_buffered(7, base_size, 5 * FILE_BLOCK_BYTES as u64,
            &[9; FILE_BLOCK_BYTES], |_, _| panic!("full block needs no base read")).unwrap();
        let sparse = [0, 5, 7, high as u32];
        for (range, expected) in [(0..1, Some(0)), (5..6, Some(5)), (7..8, None),
            (8..high, None), (8..high + 1, Some(high as u32)), (high..high + 1, Some(high as u32)),
            (0..0, None), (high + 1..high + 2, None)] {
            assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, Some(&sparse), range), Ok(expected));
        }
        assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, None, high..high + 1), Ok(Some(high as u32)));
        assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, None, 9..8), Err(Errno::EINVAL));
        assert!(reopened.failure.is_none());
        reopened.truncate_file_at(7, base_size, 2 * FILE_BLOCK_BYTES as u64, |_, _| panic!("aligned truncate")).unwrap();
        reopened.truncate_file_at(7, base_size, base_size, |_, _| panic!("sparse extension")).unwrap();
        assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, Some(&sparse), 2..high + 1), Ok(None));
        reopened.write_file_at_buffered(7, base_size, high * FILE_BLOCK_BYTES as u64,
            &[4; FILE_BLOCK_BYTES], |_, _| panic!("full block needs no base read")).unwrap();
        assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, Some(&sparse), high..high + 1), Ok(Some(high as u32)));
        reopened.failure = Some(Errno::EIO);
        assert_eq!(reopened.first_composed_file_block(7, base_size, base_size, None, 0..0), Err(Errno::EIO));
    }

    #[test]
    fn streamed_compaction_checkpoint_rejects_target_damage() {
        let mut source = OverlayJournal::open(MemoryStorage::default(), [38; 32]).unwrap();
        source
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'a'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let mut compacted = source.compact_fixed_into(MemoryStorage::default()).unwrap();
        assert!(compacted.state.blocks.is_empty());
        let last_data_byte = compacted.storage.bytes.len() - TRANSACTION_TRAILER_BYTES - 1;
        compacted.storage.bytes[last_data_byte] ^= 1;
        assert!(matches!(
            compacted.checkpoint_fixed_blocks_into(MemoryStorage::default()),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn indexed_recovery_replays_only_the_tail_and_reads_older_blocks_on_demand() {
        let digest = [33; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for block in 0..200 {
            journal
                .commit(&[Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block },
                    value: vec![block as u8; FILE_BLOCK_BYTES],
                }])
                .unwrap();
        }
        let checkpoint_end = journal.end;
        let checkpoint = journal
            .checkpoint_fixed_blocks_into(MemoryStorage::default())
            .unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock {
                    inode: 7,
                    block: 73,
                },
                value: vec![9; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let checkpoint_bytes = checkpoint.into_storage().bytes;
        let mut reopened = OverlayJournal::open_with_checkpoint(
            journal.into_storage(),
            MemoryStorage {
                bytes: checkpoint_bytes.clone(),
                ..MemoryStorage::default()
            },
            digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(reopened.state.blocks.len(), 1);
        reopened
            .validate_fixed_image_blocks(|inode| {
                (inode == 7).then_some(200 * FILE_BLOCK_BYTES as u64)
            })
            .unwrap();
        for (block, expected) in [(0, 0), (73, 9), (199, 199)] {
            let mut byte = [0];
            assert_eq!(
                reopened.read_file_at(
                    7,
                    200 * FILE_BLOCK_BYTES as u64,
                    block * FILE_BLOCK_BYTES as u64,
                    &mut byte,
                    |_, _| panic!("checkpoint or tail must satisfy read"),
                ),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
        reopened
            .write_fixed_file_at_buffered(
                7,
                200 * FILE_BLOCK_BYTES as u64,
                74 * FILE_BLOCK_BYTES as u64,
                &[11; FILE_BLOCK_BYTES],
                |_, _| panic!("full block needs no base read"),
            )
            .unwrap();
        reopened.sync().unwrap();
        let mut reopened = OverlayJournal::open_with_checkpoint(
            reopened.into_storage(),
            MemoryStorage {
                bytes: checkpoint_bytes,
                ..MemoryStorage::default()
            },
            digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(reopened.state.blocks.len(), 2);
        let mut compacted = reopened
            .compact_fixed_into(MemoryStorage::default())
            .unwrap();
        assert!(compacted.state.blocks.is_empty());
        compacted
            .install_fixed_block_checkpoint(Box::new(MemoryStorage::default()))
            .unwrap();
        assert!(compacted.state.blocks.is_empty());
        for (block, expected) in [(0, 0), (73, 9), (74, 11), (199, 199)] {
            let mut byte = [0];
            assert_eq!(
                compacted.read_file_at(
                    7,
                    200 * FILE_BLOCK_BYTES as u64,
                    block * FILE_BLOCK_BYTES as u64,
                    &mut byte,
                    |_, _| panic!("compacted block must satisfy read"),
                ),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
    }

    #[test]
    fn indexed_recovery_rejects_corruption_and_preserves_torn_tail_until_write() {
        let digest = [34; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'a'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let block_offset = journal.state.blocks[&(7, 0)].unwrap().offset as usize;
        let checkpoint_end = journal.end;
        let checkpoint_bytes = journal
            .checkpoint_fixed_blocks_into(MemoryStorage::default())
            .unwrap()
            .into_storage()
            .bytes;
        let durable = journal.into_storage().bytes;
        let tail = encode_transaction(
            2,
            &[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'b'; FILE_BLOCK_BYTES],
            }],
        )
        .unwrap();
        let mut damaged_prefix = durable.clone();
        damaged_prefix[block_offset] ^= 1;
        assert!(matches!(
            OverlayJournal::open_with_checkpoint(
                MemoryStorage {
                    bytes: damaged_prefix,
                    ..MemoryStorage::default()
                },
                MemoryStorage {
                    bytes: checkpoint_bytes.clone(),
                    ..MemoryStorage::default()
                },
                digest,
                checkpoint_end,
            ),
            Err(Errno::EIO)
        ));
        let mut torn = durable.clone();
        torn.extend_from_slice(&tail[..24]);
        let mut recovered = OverlayJournal::open_with_checkpoint(
            MemoryStorage {
                bytes: torn.clone(),
                ..MemoryStorage::default()
            },
            MemoryStorage {
                bytes: checkpoint_bytes.clone(),
                ..MemoryStorage::default()
            },
            digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(recovered.storage.bytes, torn);
        let mut byte = [0];
        assert_eq!(
            recovered.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut byte, |_, _| {
                panic!("checkpoint must satisfy read")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'a']);
        recovered.commit(&[Mutation::Put { key: OverlayKey::FileBlock { inode: 7, block: 0 },
            value: vec![b'c'; FILE_BLOCK_BYTES] }]).unwrap();
        assert!(!recovered.needs_tail_repair);
        assert_eq!(recovered.end, recovered.storage.bytes.len() as u64);
        let mut damaged_tail = durable;
        damaged_tail.extend_from_slice(&tail);
        let last = damaged_tail.len() - 37;
        damaged_tail[last] ^= 1;
        assert!(matches!(
            OverlayJournal::open_with_checkpoint(
                MemoryStorage {
                    bytes: damaged_tail,
                    ..MemoryStorage::default()
                },
                MemoryStorage {
                    bytes: checkpoint_bytes,
                    ..MemoryStorage::default()
                },
                digest,
                checkpoint_end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn indexed_metadata_open_reads_the_prefix_once() {
        let base_digest = [50; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let checkpoint_end = journal.end;
        let checkpoint = journal
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let read_bytes = Arc::new(AtomicU64::new(0));
        let reopened = OverlayJournal::open_with_checkpoint_metadata(
            MemoryStorage {
                bytes: journal.into_storage().bytes,
                read_bytes: Some(Arc::clone(&read_bytes)),
                ..MemoryStorage::default()
            },
            checkpoint,
            base_digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(reopened.state().lookup(&inode_key()), Some(Some(&b"metadata"[..])));
        assert_eq!(
            read_bytes.load(Ordering::Relaxed),
            checkpoint_end + HEADER_BYTES as u64 + TRANSACTION_HEADER_BYTES as u64
        );
    }

    #[test]
    fn compacted_metadata_checkpoint_indexes_namespace_without_another_handle() {
        let base_digest = [51; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: directory_key(b"old"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Delete {
                    key: directory_key(b"old"),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let mut checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        assert_eq!(checkpoint.count(), 1);
        assert_eq!(checkpoint.metadata_count(), 2);
        assert_eq!(
            checkpoint
                .lookup_metadata(&inode_key())
                .unwrap()
                .unwrap()
                .value
                .unwrap()
                .1,
            8
        );
        assert_eq!(
            checkpoint
                .lookup_metadata(&directory_key(b"old"))
                .unwrap()
                .unwrap()
                .value,
            None
        );
        let mut recovered = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(),
            checkpoint.into_storage(),
            base_digest,
            end,
        )
        .unwrap();
        assert!(recovered.state.entries.is_empty());
        assert_eq!(
            recovered.metadata_value(&inode_key()),
            Ok(Some(Some(IoBuffer::copy_from(b"metadata").unwrap())))
        );
        assert_eq!(recovered.metadata_value(&directory_key(b"old")), Ok(Some(None)));
        assert_eq!(recovered.validate_fixed_image_blocks(|_| Some(8192)), Err(Errno::EIO));
        assert!(matches!(
            recovered.compact_fixed_into(MemoryStorage::default()),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn indexed_boot_rejects_a_self_consistent_but_false_metadata_location() {
        let base_digest = [52; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }])
            .unwrap();
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut index_bytes = checkpoint.into_storage().bytes;
        let false_offset = end - 8;
        index_bytes[160 + 265..160 + 273].copy_from_slice(&false_offset.to_le_bytes());
        let block_digest = Sha256::digest(&[]);
        let metadata_digest = Sha256::digest(&index_bytes[160..]);
        let mut combined = Sha256::new();
        combined.update(block_digest);
        combined.update(metadata_digest);
        index_bytes[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        let storage = MemoryStorage {
            bytes: index_bytes,
            ..MemoryStorage::default()
        };
        let index = BlockCheckpoint::open(
            MemoryStorage {
                bytes: storage.bytes.clone(),
                ..MemoryStorage::default()
            },
            base_digest,
            Sha256::digest(&compacted.storage.bytes[..end as usize]).into(),
            end,
        );
        assert!(index.is_ok());
        assert!(matches!(
            OverlayJournal::open_with_checkpoint_metadata(
                compacted.into_storage(),
                storage,
                base_digest,
                end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn indexed_boot_rejects_a_self_consistent_but_false_block_location() {
        let base_digest = [57; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 1 },
                    value: vec![b'b'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut index_bytes = checkpoint.into_storage().bytes;
        let second_location = index_bytes[160 + 56 + 16..160 + 2 * 56].to_vec();
        index_bytes[160 + 16..160 + 56].copy_from_slice(&second_location);
        let block_digest = Sha256::digest(&index_bytes[160..160 + 2 * 56]);
        let metadata_digest = Sha256::digest(&index_bytes[160 + 2 * 56..]);
        let mut combined = Sha256::new();
        combined.update(block_digest);
        combined.update(metadata_digest);
        index_bytes[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        let storage = MemoryStorage {
            bytes: index_bytes,
            ..MemoryStorage::default()
        };
        assert!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                base_digest,
                Sha256::digest(&compacted.storage.bytes[..end as usize]).into(),
                end,
            )
            .is_ok()
        );
        assert!(matches!(
            OverlayJournal::open_with_checkpoint_metadata(
                compacted.into_storage(),
                storage,
                base_digest,
                end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn compacted_fixed_index_rejects_a_self_consistent_but_false_block_location() {
        let base_digest = [58; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 1 },
                    value: vec![b'b'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut compacted = source.compact_fixed_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_fixed_blocks_into(MemoryStorage::default())
            .unwrap();
        let mut index_bytes = checkpoint.into_storage().bytes;
        assert_eq!(u32::from_le_bytes(index_bytes[4..8].try_into().unwrap()), 5);
        let second_location = index_bytes[160 + 56 + 16..160 + 2 * 56].to_vec();
        index_bytes[160 + 16..160 + 56].copy_from_slice(&second_location);
        let block_digest = Sha256::digest(&index_bytes[160..]);
        index_bytes[96..128].copy_from_slice(&block_digest);
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        let storage = MemoryStorage {
            bytes: index_bytes,
            ..MemoryStorage::default()
        };
        assert!(BlockCheckpoint::open(
            MemoryStorage {
                bytes: storage.bytes.clone(),
                ..MemoryStorage::default()
            },
            base_digest,
            Sha256::digest(&compacted.storage.bytes[..end as usize]).into(),
            end,
        )
        .is_ok());
        assert!(matches!(
            OverlayJournal::open_with_checkpoint(
                compacted.into_storage(),
                storage,
                base_digest,
                end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn released_checkpoint_metadata_uses_index_and_keeps_tail_updates() {
        let base_digest = [53; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileSize(7),
                    value: 8192u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileZeroFrom(7),
                    value: 2u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: directory_key(b"old"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(),
            checkpoint.into_storage(),
            base_digest,
            end,
        )
        .unwrap();
        reopened
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::FileSize(7),
                    value: 16384u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileZeroFrom(7),
                    value: 3u64.to_le_bytes().to_vec(),
                },
                Mutation::Delete {
                    key: directory_key(b"old"),
                },
            ])
            .unwrap();
        reopened.release_checkpoint_metadata().unwrap();
        assert_eq!(reopened.state.entries.len(), 3);
        assert_eq!(
            reopened.metadata_value(&inode_key()).unwrap(),
            Some(Some(IoBuffer::copy_from(b"metadata").unwrap()))
        );
        assert_eq!(reopened.visible_file_size(7, 0), Ok(16384));
        assert_eq!(reopened.visible_zero_from(7), Ok(Some(2)));
        assert_eq!(
            reopened.metadata_value(&directory_key(b"old")).unwrap(),
            Some(None)
        );
        let mut entries = Vec::new();
        reopened
            .for_each_metadata(|key, value| {
                entries.push((key.clone(), value.map(<[u8]>::to_vec)));
                Ok(())
            })
            .unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(
            entries.iter().find(|(key, _)| *key == OverlayKey::FileZeroFrom(7)).unwrap().1,
            Some(2u64.to_le_bytes().to_vec())
        );
        let mut cursor = reopened.metadata_cursor(4096).unwrap();
        let mut cursor_entries = Vec::new();
        while let Some((key, value)) = reopened.next_metadata(&mut cursor).unwrap() {
            let value = value.map(<[u8]>::to_vec);
            assert_eq!(reopened.metadata_value(key).unwrap(), Some(value.as_ref().map(|bytes| IoBuffer::copy_from(bytes).unwrap())));
            cursor_entries.push((key.clone(), value));
        }
        assert_eq!(cursor_entries, entries);
        drop(cursor);
        let mut second = reopened
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let second_end = second.end;
        let second_index = second
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut recovered = OverlayJournal::open_with_checkpoint_metadata(
            second.into_storage(),
            second_index.into_storage(),
            base_digest,
            second_end,
        )
        .unwrap();
        assert_eq!(recovered.visible_file_size(7, 0), Ok(16384));
        assert_eq!(recovered.visible_zero_from(7), Ok(Some(2)));
        assert_eq!(recovered.metadata_value(&directory_key(b"old")), Ok(Some(None)));
    }

    #[test]
    fn metadata_cursor_rejects_oversized_values_and_committed_changes() {
        for indexed in [false, true] {
            let mut source = OverlayJournal::open(MemoryStorage::default(), [17; 32]).unwrap();
            source.commit(&[Mutation::Put { key: inode_key(), value: vec![3; 128] }]).unwrap();
            let mut journal = if indexed {
                let checkpoint = source.checkpoint_blocks_with_metadata_into(MemoryStorage::default()).unwrap();
                let end = source.end;
                OverlayJournal::open_with_checkpoint_metadata(source.into_storage(), checkpoint.into_storage(), [17; 32], end).unwrap()
            } else { source };
            let before = ROOTFS_METADATA.temporary_usage();
            let mut cursor = journal.metadata_cursor(64).unwrap();
            assert!(matches!(journal.next_metadata(&mut cursor), Err(Errno::EIO)));
            assert_eq!(cursor.bytes.capacity(), 0);
            journal.commit(&[Mutation::Put { key: inode_key(), value: b"new".to_vec() }]).unwrap();
            assert!(matches!(journal.next_metadata(&mut cursor), Err(Errno::EBUSY)));
            drop(cursor);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), before);
        }
    }

    #[test]
    fn indexed_metadata_boot_streams_entries_across_checkpoint_pages() {
        let base_digest = [54; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        for chunk in 0..4 {
            let mutations: Vec<_> = (chunk * 64..(chunk + 1) * 64)
                .map(|number| Mutation::Put {
                    key: directory_key(alloc::format!("name-{number:03}").as_bytes()),
                    value: 7u64.to_le_bytes().to_vec(),
                })
                .collect();
            source.commit(&mutations).unwrap();
        }
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        assert_eq!(checkpoint.metadata_count(), 256);
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(),
            checkpoint.into_storage(),
            base_digest,
            end,
        )
        .unwrap();
        assert!(reopened.state.entries.is_empty());
        let mut count = 0;
        reopened
            .for_each_metadata(|key, value| {
                assert!(matches!(key, OverlayKey::Dirent { .. }));
                assert_eq!(value, Some(&7u64.to_le_bytes()[..]));
                count += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(count, 256);
        for number in [0, 13, 14, 127, 255] {
            let key = directory_key(alloc::format!("name-{number:03}").as_bytes());
            assert_eq!(
                reopened.metadata_value(&key),
                Ok(Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap())))
            );
        }
        for number in 0..256 {
            let key = directory_key(alloc::format!("name-{number:03}").as_bytes());
            reopened.metadata_value(&key).unwrap();
        }
        assert_eq!(reopened.metadata_cache.len(), METADATA_CACHE_ENTRIES);
    }

    #[test]
    fn indexed_metadata_cache_avoids_repeated_journal_value_reads() {
        let base_digest = [55; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::FileSize(7),
                    value: 8192u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileZeroFrom(7),
                    value: 2u64.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        let mut compacted = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let read_bytes = Arc::new(AtomicU64::new(0));
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            MemoryStorage {
                bytes: compacted.into_storage().bytes,
                read_bytes: Some(Arc::clone(&read_bytes)),
                ..MemoryStorage::default()
            },
            checkpoint.into_storage(),
            base_digest,
            end,
        )
        .unwrap();
        let before = read_bytes.load(Ordering::Relaxed);
        assert_eq!(reopened.visible_file_size(7, 0), Ok(8192));
        assert_eq!(read_bytes.load(Ordering::Relaxed) - before, 8);
        assert_eq!(reopened.visible_file_size(7, 0), Ok(8192));
        assert_eq!(read_bytes.load(Ordering::Relaxed) - before, 8);
        assert_eq!(reopened.visible_zero_from(7), Ok(Some(2)));
        assert_eq!(read_bytes.load(Ordering::Relaxed) - before, 16);
        assert_eq!(reopened.visible_zero_from(7), Ok(Some(2)));
        assert_eq!(read_bytes.load(Ordering::Relaxed) - before, 16);
    }

    #[test]
    fn indexed_metadata_read_rejects_damage_after_boot() {
        let base_digest = [56; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }])
            .unwrap();
        let mut compacted = source.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let mut checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let value_offset = checkpoint
            .lookup_metadata(&inode_key())
            .unwrap()
            .unwrap()
            .value
            .unwrap()
            .0 as usize;
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(),
            checkpoint.into_storage(),
            base_digest,
            end,
        )
        .unwrap();
        reopened.storage.bytes[value_offset] ^= 1;
        assert_eq!(reopened.metadata_value(&inode_key()), Err(Errno::EIO));
        assert_eq!(reopened.for_each_metadata(|_, _| Ok(())), Err(Errno::EIO));
        reopened.storage.bytes[value_offset] ^= 1;
        assert_eq!(reopened.metadata_value(&inode_key()), Ok(Some(Some(IoBuffer::copy_from(b"metadata").unwrap()))));
    }

    #[test]
    fn indexed_boot_reads_legacy_v3_metadata_checkpoint() {
        let base_digest = [57; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"metadata".to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'v'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut compacted = source.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut index_bytes = checkpoint.into_storage().bytes;
        index_bytes.truncate(160 + 56 + 280);
        index_bytes[4..8].copy_from_slice(&3u32.to_le_bytes());
        let mut combined = Sha256::new();
        combined.update(Sha256::digest(&index_bytes[160..216]));
        combined.update(Sha256::digest(&index_bytes[216..]));
        index_bytes[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        let journal_bytes = compacted.into_storage().bytes;
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            MemoryStorage { bytes: journal_bytes.clone(), ..MemoryStorage::default() },
            MemoryStorage {
                bytes: index_bytes.clone(),
                ..MemoryStorage::default()
            },
            base_digest,
            end,
        )
        .unwrap();
        assert_eq!(reopened.metadata_value(&inode_key()), Ok(Some(Some(IoBuffer::copy_from(b"metadata").unwrap()))));
        let mut block = [0; FILE_BLOCK_BYTES];
        assert_eq!(reopened.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut block, |_, _| panic!("block is journaled")), Ok(FILE_BLOCK_BYTES));
        assert_eq!(block, [b'v'; FILE_BLOCK_BYTES]);
        index_bytes[160 + 24] ^= 1;
        let mut combined = Sha256::new();
        combined.update(Sha256::digest(&index_bytes[160..216]));
        combined.update(Sha256::digest(&index_bytes[216..]));
        index_bytes[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        assert!(matches!(
            OverlayJournal::open_with_checkpoint_metadata(
                MemoryStorage { bytes: journal_bytes, ..MemoryStorage::default() },
                MemoryStorage { bytes: index_bytes, ..MemoryStorage::default() },
                base_digest,
                end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn indexed_metadata_replay_retains_namespace_without_a_prefix_block_map() {
        let digest = [36; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"file metadata".to_vec(),
                },
                Mutation::Put {
                    key: directory_key(b"old"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let checkpoint_end = journal.end;
        let checkpoint_sequence = journal.next_sequence;
        let location = journal.state.blocks[&(7, 0)].unwrap();
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            digest,
            Sha256::digest(&journal.storage.bytes).into(),
            checkpoint_end,
            checkpoint_sequence,
            [BlockCheckpointEntry {
                inode: 7,
                block: 0,
                offset: location.offset,
                digest: location.digest,
            }],
        )
        .unwrap()
        .into_storage();
        journal
            .commit(&[
                Mutation::Delete {
                    key: directory_key(b"old"),
                },
                Mutation::Put {
                    key: directory_key(b"new"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 1 },
                    value: vec![b'b'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let journal_bytes = journal.into_storage().bytes;
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            MemoryStorage {
                bytes: journal_bytes.clone(),
                ..MemoryStorage::default()
            },
            MemoryStorage {
                bytes: checkpoint.bytes.clone(),
                ..MemoryStorage::default()
            },
            digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(
            reopened.state.lookup(&inode_key()),
            Some(Some(&b"file metadata"[..]))
        );
        assert_eq!(reopened.state.lookup(&directory_key(b"old")), Some(None));
        assert_eq!(
            reopened.state.lookup(&directory_key(b"new")),
            Some(Some(&7u64.to_le_bytes()[..]))
        );
        assert_eq!(reopened.state.blocks.len(), 1);
        for (block, expected) in [(0, b'a'), (1, b'b')] {
            let mut byte = [0];
            assert_eq!(
                reopened.read_file_at(
                    7,
                    (2 * FILE_BLOCK_BYTES) as u64,
                    block * FILE_BLOCK_BYTES as u64,
                    &mut byte,
                    |_, _| { panic!("indexed block must satisfy read") }
                ),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
        let incorrect_sequence = BlockCheckpoint::create(
            MemoryStorage::default(),
            digest,
            Sha256::digest(&journal_bytes[..checkpoint_end as usize]).into(),
            checkpoint_end,
            checkpoint_sequence + 1,
            [BlockCheckpointEntry {
                inode: 7,
                block: 0,
                offset: location.offset,
                digest: location.digest,
            }],
        )
        .unwrap()
        .into_storage();
        assert!(matches!(
            OverlayJournal::open_with_checkpoint_metadata(
                MemoryStorage {
                    bytes: journal_bytes,
                    ..MemoryStorage::default()
                },
                incorrect_sequence,
                digest,
                checkpoint_end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn metadata_survives_two_streamed_indexed_compactions() {
        let digest = [37; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: inode_key(),
                    value: b"file metadata".to_vec(),
                },
                Mutation::Put {
                    key: directory_key(b"old"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut first = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        assert!(first.state.blocks.is_empty());
        assert_eq!(
            first.state.lookup(&inode_key()),
            Some(Some(&b"file metadata"[..]))
        );
        let first_end = first.end;
        let first_checkpoint = first
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            first.into_storage(),
            first_checkpoint,
            digest,
            first_end,
        )
        .unwrap();
        assert!(reopened.state.blocks.is_empty());
        assert!(reopened.state.entries.is_empty());
        reopened
            .commit(&[
                Mutation::Delete {
                    key: directory_key(b"old"),
                },
                Mutation::Put {
                    key: directory_key(b"new"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 1 },
                    value: vec![b'b'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut second = reopened
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        assert!(second.state.blocks.is_empty());
        let second_end = second.end;
        let second_checkpoint = second
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let mut recovered = OverlayJournal::open_with_checkpoint_metadata(
            second.into_storage(),
            second_checkpoint,
            digest,
            second_end,
        )
        .unwrap();
        assert_eq!(
            recovered.metadata_value(&inode_key()),
            Ok(Some(Some(IoBuffer::copy_from(b"file metadata").unwrap())))
        );
        assert_eq!(recovered.metadata_value(&directory_key(b"old")), Ok(Some(None)));
        assert_eq!(
            recovered.metadata_value(&directory_key(b"new")),
            Ok(Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap())))
        );
        assert!(recovered.state.blocks.is_empty());
        for (block, expected) in [(0, b'a'), (1, b'b')] {
            let mut byte = [0];
            assert_eq!(
                recovered.read_file_at(
                    7,
                    (2 * FILE_BLOCK_BYTES) as u64,
                    block * FILE_BLOCK_BYTES as u64,
                    &mut byte,
                    |_, _| { panic!("compacted block must satisfy read") }
                ),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
    }

    #[test]
    fn block_tombstone_survives_two_indexed_metadata_compactions() {
        let digest = [39; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        source
            .commit(&[
                Mutation::Put {
                    key: directory_key(b"file"),
                    value: 7u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 0 },
                    value: vec![b'a'; FILE_BLOCK_BYTES],
                },
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode: 7, block: 1 },
                    value: vec![b'b'; FILE_BLOCK_BYTES],
                },
            ])
            .unwrap();
        source
            .commit(&[Mutation::Delete {
                key: OverlayKey::FileBlock { inode: 7, block: 1 },
            }])
            .unwrap();
        let mut first = source
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let first_end = first.end;
        let first_checkpoint = first
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        assert_eq!(
            u32::from_le_bytes(first_checkpoint.bytes[4..8].try_into().unwrap()),
            4
        );
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            first.into_storage(),
            first_checkpoint,
            digest,
            first_end,
        )
        .unwrap();
        assert_eq!(reopened.dense_base_needs_sparse_export(7, 8192, 8192), Ok(true));
        assert_eq!(reopened.composed_file_blocks(7, 8192, 8192, &[0, 1]), Ok(vec![0]));
        assert_eq!(
            reopened.validate_fixed_image_blocks(|_| Some(8192)),
            Err(Errno::EIO)
        );
        let mut byte = [1];
        assert_eq!(
            reopened.read_file_at(7, 8192, 4096, &mut byte, |_, _| {
                panic!("tombstone must mask the base")
            }),
            Ok(1)
        );
        assert_eq!(byte, [0]);
        assert_eq!(
            reopened.metadata_value(&directory_key(b"file")),
            Ok(Some(Some(IoBuffer::copy_from(&7u64.to_le_bytes()).unwrap())))
        );
        reopened
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'c'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let mut second = reopened
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let second_end = second.end;
        let second_checkpoint = second
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let mut recovered = OverlayJournal::open_with_checkpoint_metadata(
            second.into_storage(),
            second_checkpoint,
            digest,
            second_end,
        )
        .unwrap();
        assert_eq!(recovered.dense_base_needs_sparse_export(7, 8192, 8192), Ok(true));
        assert_eq!(recovered.composed_file_blocks(7, 8192, 8192, &[0, 1]), Ok(vec![0]));
        assert_eq!(
            recovered.read_file_at(7, 8192, 0, &mut byte, |_, _| {
                panic!("indexed block must satisfy read")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'c']);
        assert_eq!(
            recovered.read_file_at(7, 8192, 4096, &mut byte, |_, _| {
                panic!("indexed tombstone must mask the base")
            }),
            Ok(1)
        );
        assert_eq!(byte, [0]);
        recovered
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 1 },
                value: vec![b'd'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        assert_eq!(
            recovered.composed_file_blocks(7, 8192, 8192, &[0, 1]),
            Ok(vec![0, 1])
        );
    }

    #[test]
    fn indexed_truncate_masks_huge_base_without_materializing_it() {
        let digest = [40; 32];
        let base_size = 8 * 1024 * 1024 * 1024u64;
        let mut source = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        source
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 2 },
                value: vec![b'x'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let prefix_end = source.end;
        let prefix_index = source
            .checkpoint_fixed_blocks_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let mut indexed = OverlayJournal::open_with_checkpoint_metadata(
            source.into_storage(),
            prefix_index,
            digest,
            prefix_end,
        )
        .unwrap();
        indexed
            .truncate_file_at(7, base_size, 4097, |_, dst| {
                dst.fill(b'a');
                Ok(dst.len())
            })
            .unwrap();
        indexed
            .truncate_file_at(7, base_size, base_size, |_, _| {
                panic!("growth must not read the base")
            })
            .unwrap();
        assert_eq!(
            indexed.validate_fixed_image_blocks(|_| Some(base_size)),
            Err(Errno::EIO)
        );
        let mut bytes = [0; 3];
        assert_eq!(
            indexed.read_file_at(7, base_size, 4096, &mut bytes, |_, _| {
                panic!("boundary must be journaled")
            }),
            Ok(3)
        );
        assert_eq!(bytes, [b'a', 0, 0]);
        let mut byte = [1];
        for offset in [8192, base_size - 1] {
            assert_eq!(
                indexed.read_file_at(7, base_size, offset, &mut byte, |_, _| {
                    panic!("truncated base must stay masked")
                }),
                Ok(1)
            );
            assert_eq!(byte, [0]);
        }
        indexed
            .write_file_at_buffered(7, base_size, 8195, b"z", |_, _| {
                panic!("post-truncate write must see zeros")
            })
            .unwrap();
        let mut first = indexed
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let first_end = first.end;
        let first_index = first
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        assert_eq!(first_index.bytes.len(), 160 + 2 * 56 + 2 * 312);
        assert_eq!(
            u32::from_le_bytes(first_index.bytes[4..8].try_into().unwrap()),
            4
        );
        let first_storage = first.into_storage();
        assert!(matches!(
            OverlayJournal::open_with_checkpoint(
                MemoryStorage {
                    bytes: first_storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                MemoryStorage {
                    bytes: first_index.bytes.clone(),
                    ..MemoryStorage::default()
                },
                digest,
                first_end,
            ),
            Err(Errno::EIO)
        ));
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            first_storage,
            first_index,
            digest,
            first_end,
        )
        .unwrap();
        assert_eq!(reopened.state.file_size(7, base_size), Ok(base_size));
        assert_eq!(
            reopened.read_file_at(7, base_size, 8195, &mut byte, |_, _| {
                panic!("new block must be indexed")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'z']);
        let mut second = reopened
            .compact_metadata_into(MemoryStorage::default())
            .unwrap();
        let second_end = second.end;
        let second_index = second
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap()
            .into_storage();
        let mut recovered = OverlayJournal::open_with_checkpoint_metadata(
            second.into_storage(),
            second_index,
            digest,
            second_end,
        )
        .unwrap();
        for (offset, expected) in [
            (4096, b'a'),
            (4097, 0),
            (8192, 0),
            (8195, b'z'),
            (base_size - 1, 0),
        ] {
            assert_eq!(
                recovered.read_file_at(7, base_size, offset, &mut byte, |_, _| {
                    panic!("compacted image must not need base bytes")
                }),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
    }

    #[test]
    fn repeated_shrinks_clear_only_blocks_after_each_cut() {
        let digest = [41; 32];
        let base_size = 3 * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .truncate_file_at(7, base_size, FILE_BLOCK_BYTES as u64, |_, _| {
                panic!("aligned shrink needs no base read")
            })
            .unwrap();
        journal
            .truncate_file_at(7, base_size, base_size, |_, _| {
                panic!("growth needs no base read")
            })
            .unwrap();
        journal
            .write_file_at(7, base_size, FILE_BLOCK_BYTES as u64, b"b", |_, _| {
                panic!("masked base must read as zeros")
            })
            .unwrap();
        journal
            .write_file_at(7, base_size, 2 * FILE_BLOCK_BYTES as u64, b"c", |_, _| {
                panic!("masked base must read as zeros")
            })
            .unwrap();
        journal
            .truncate_file_at(7, base_size, 2 * FILE_BLOCK_BYTES as u64, |_, _| {
                panic!("aligned shrink needs no base read")
            })
            .unwrap();
        journal
            .truncate_file_at(7, base_size, base_size, |_, _| {
                panic!("growth needs no base read")
            })
            .unwrap();
        assert_eq!(journal.state.zero_from(7), Ok(Some(1)));
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        let mut byte = [1];
        for (offset, expected) in [
            (0, b'a'),
            (FILE_BLOCK_BYTES as u64, b'b'),
            (2 * FILE_BLOCK_BYTES as u64, 0),
        ] {
            assert_eq!(
                recovered.read_file_at(7, base_size, offset, &mut byte, |_, dst| {
                    dst.fill(b'a');
                    Ok(dst.len())
                }),
                Ok(1)
            );
            assert_eq!(byte, [expected]);
        }
    }

    #[test]
    fn torn_truncate_never_publishes_the_zero_fence_or_size() {
        let digest = [42; 32];
        let base_size = 2 * FILE_BLOCK_BYTES as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .write_file_at(7, base_size, FILE_BLOCK_BYTES as u64, b"x", |_, dst| {
                dst.fill(b'a');
                Ok(dst.len())
            })
            .unwrap();
        let durable = journal.into_storage().bytes;
        let mut complete = OverlayJournal::open(
            MemoryStorage {
                bytes: durable.clone(),
                ..MemoryStorage::default()
            },
            digest,
        )
        .unwrap();
        complete
            .truncate_file_at(7, base_size, 0, |_, _| {
                panic!("zero truncate needs no base read")
            })
            .unwrap();
        let complete_bytes = complete.into_storage().bytes;
        let append = &complete_bytes[durable.len()..];
        for cut in [1, 24, append.len() / 2, append.len() - 1] {
            let mut torn = durable.clone();
            torn.extend_from_slice(&append[..cut]);
            let mut recovered = OverlayJournal::open(
                MemoryStorage {
                    bytes: torn.clone(),
                    ..MemoryStorage::default()
                },
                digest,
            )
            .unwrap();
            assert_eq!(recovered.storage.bytes, torn);
            assert_eq!(recovered.state.file_size(7, base_size), Ok(base_size));
            assert_eq!(recovered.state.zero_from(7), Ok(None));
            let mut byte = [0];
            assert_eq!(
                recovered.read_file_at(7, base_size, FILE_BLOCK_BYTES as u64, &mut byte, |_, _| {
                    panic!("old overlay block must survive")
                }),
                Ok(1)
            );
            assert_eq!(byte, [b'x']);
        }
    }

    #[test]
    fn compaction_refuses_corrupt_source_or_existing_target() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [25; 32]).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![1; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let old_length = journal.storage.bytes.len();
        assert!(matches!(
            journal.compact_into(MemoryStorage {
                fail_flush: true,
                ..MemoryStorage::default()
            }),
            Err(Errno::EIO)
        ));
        assert_eq!(journal.storage.bytes.len(), old_length);
        assert!(matches!(
            journal.compact_into(MemoryStorage {
                fail_after_flushes: Some(1),
                ..MemoryStorage::default()
            }),
            Err(Errno::EIO)
        ));
        assert_eq!(journal.storage.bytes.len(), old_length);
        assert!(matches!(
            journal.compact_into(MemoryStorage {
                bytes: vec![1],
                ..MemoryStorage::default()
            }),
            Err(Errno::EEXIST)
        ));
        let offset = journal.state.blocks.get(&(7, 0)).unwrap().unwrap().offset as usize;
        journal.storage.bytes[offset] ^= 1;
        assert!(matches!(
            journal.compact_into(MemoryStorage::default()),
            Err(Errno::EIO)
        ));
        assert_eq!(journal.storage.bytes.len(), old_length);
    }

    #[test]
    fn compaction_batches_across_transaction_boundaries() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [26; 32]).unwrap();
        let mut mutations = Vec::new();
        for block in 0..129 {
            mutations.push(Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block },
                value: vec![block as u8; FILE_BLOCK_BYTES],
            });
        }
        journal.commit(&mutations).unwrap();
        let compacted = journal.compact_into(MemoryStorage::default()).unwrap();
        assert_eq!(compacted.next_sequence, 3);
        let mut reopened = OverlayJournal::open(compacted.into_storage(), [26; 32]).unwrap();
        let mut block = vec![0; FILE_BLOCK_BYTES];
        assert_eq!(
            reopened.read_file_at(
                7,
                129 * FILE_BLOCK_BYTES as u64,
                128 * FILE_BLOCK_BYTES as u64,
                &mut block,
                |_, _| panic!("block is journaled"),
            ),
            Ok(FILE_BLOCK_BYTES)
        );
        assert_eq!(block, vec![128; FILE_BLOCK_BYTES]);
    }

    #[test]
    fn compaction_flushes_pending_dirty_blocks_before_copying() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [27; 32]).unwrap();
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                FILE_BLOCK_BYTES as u64,
                0,
                b"xy",
                |_, destination| {
                    destination.fill(b'a');
                    Ok(destination.len())
                },
            ),
            Ok(2)
        );
        assert_eq!(journal.dirty_blocks.len(), 1);
        let compacted = journal.compact_into(MemoryStorage::default()).unwrap();
        assert!(journal.dirty_blocks.is_empty());
        let mut reopened = OverlayJournal::open(compacted.into_storage(), [27; 32]).unwrap();
        let mut bytes = [0; 4];
        assert_eq!(
            reopened.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut bytes, |_, _| {
                panic!("block is journaled")
            }),
            Ok(4)
        );
        assert_eq!(&bytes, b"xyaa");
    }

    #[test]
    fn every_torn_transaction_recovers_the_previous_generation() {
        let digest = [4; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"old".to_vec(),
            }])
            .unwrap();
        let committed = journal.into_storage();
        let old_end = committed.bytes.len();
        let mut journal = OverlayJournal::open(committed, digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"new".to_vec(),
            }])
            .unwrap();
        let complete = journal.into_storage();
        for cut in old_end..=complete.bytes.len() {
            let mut storage = MemoryStorage {
                bytes: complete.bytes[..cut].to_vec(),
                ..MemoryStorage::default()
            };
            let expected = if cut == complete.bytes.len() {
                &b"new"[..]
            } else {
                &b"old"[..]
            };
            let mut recovered = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(
                recovered.state().lookup(&inode_key()),
                Some(Some(expected)),
                "cut {cut}"
            );
            assert_eq!(recovered.storage.bytes, complete.bytes[..cut]);
            recovered.sync().unwrap();
            assert_eq!(recovered.storage.bytes, complete.bytes[..cut]);
            recovered.commit(&[Mutation::Put { key: inode_key(), value: b"replacement".to_vec() }]).unwrap();
            storage = recovered.into_storage();
            let reopened = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(reopened.state().lookup(&inode_key()), Some(Some(&b"replacement"[..])));
            assert_eq!(reopened.end, reopened.storage.bytes.len() as u64);
        }
    }

    #[test]
    fn failed_tail_repair_never_publishes_a_new_transaction() {
        let digest = [4; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal.commit(&[Mutation::Put { key: inode_key(), value: b"committed".to_vec() }]).unwrap();
        let committed = journal.into_storage().bytes;
        for fail_truncate in [false, true] {
            let mut bytes = committed.clone();
            bytes.extend_from_slice(b"torn tail");
            let storage = MemoryStorage { bytes: bytes.clone(), fail_truncate, fail_flush: !fail_truncate,
                ..MemoryStorage::default() };
            let mut recovered = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(recovered.storage.bytes, bytes);
            let sequence = recovered.next_sequence;
            let mutations = [Mutation::Put { key: inode_key(), value: b"uncommitted".to_vec() }];
            assert_eq!(recovered.commit(&mutations), Err(Errno::EIO));
            assert_eq!(recovered.commit(&mutations), Err(Errno::EIO));
            assert_eq!(recovered.next_sequence, sequence);
            assert_eq!(recovered.state().lookup(&inode_key()), Some(Some(&b"committed"[..])));
            let mut storage = recovered.into_storage();
            assert_eq!(&storage.bytes[..committed.len()], committed);
            if fail_truncate { assert_eq!(storage.bytes, bytes); }
            storage.fail_truncate = false;
            storage.fail_flush = false;
            let reopened = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(reopened.state().lookup(&inode_key()), Some(Some(&b"committed"[..])));
        }
    }

    #[test]
    fn every_torn_namespace_create_replays_both_records_or_neither() {
        let digest = [47; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        let initial_end = journal.end as usize;
        let inode = OverlayKey::Inode(7);
        let dirent = directory_key(b"created");
        journal
            .commit(&[
                Mutation::Put {
                    key: inode.clone(),
                    value: b"inode record".to_vec(),
                },
                Mutation::Put {
                    key: dirent.clone(),
                    value: 7u64.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        let bytes = journal.into_storage().bytes;
        for cut in initial_end..=bytes.len() {
            let recovered = OverlayJournal::open(
                MemoryStorage {
                    bytes: bytes[..cut].to_vec(),
                    ..MemoryStorage::default()
                },
                digest,
            )
            .unwrap();
            if cut == bytes.len() {
                assert_eq!(recovered.state().lookup(&inode), Some(Some(&b"inode record"[..])));
                assert_eq!(
                    recovered.state().lookup(&dirent),
                    Some(Some(&7u64.to_le_bytes()[..]))
                );
            } else {
                assert_eq!(recovered.state().lookup(&inode), None);
                assert_eq!(recovered.state().lookup(&dirent), None);
                assert_eq!(recovered.end as usize, initial_end);
            }
        }
    }

    #[test]
    fn rejects_wrong_base_and_corrupted_committed_records() {
        let digest = [5; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"data".to_vec(),
            }])
            .unwrap();
        let storage = journal.into_storage();
        assert!(matches!(
            OverlayJournal::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                [6; 32]
            ),
            Err(Errno::EIO)
        ));
        let mut bad = storage;
        bad.bytes[HEADER_BYTES + TRANSACTION_HEADER_BYTES + 8] ^= 1;
        assert!(matches!(OverlayJournal::open(bad, digest), Err(Errno::EIO)));
    }

    #[test]
    fn flush_failure_keeps_state_unpublished_and_poisoned() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [8; 32]).unwrap();
        journal.storage.fail_flush = true;
        let mutation = Mutation::Put {
            key: inode_key(),
            value: b"data".to_vec(),
        };
        assert_eq!(journal.commit(&[mutation.clone()]), Err(Errno::EIO));
        assert_eq!(journal.state().lookup(&inode_key()), None);
        journal.storage.fail_flush = false;
        assert_eq!(journal.commit(&[mutation]), Err(Errno::EIO));
    }

    #[test]
    fn invalid_namespace_and_block_records_never_write() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [9; 32]).unwrap();
        let original_len = journal.storage.bytes.len();
        assert_eq!(
            journal.commit(&[Mutation::Put {
                key: directory_key(b"a/b"),
                value: 7u64.to_le_bytes().to_vec()
            }]),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            journal.commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![0; 3]
            }]),
            Err(Errno::EINVAL)
        );
        assert_eq!(journal.storage.bytes.len(), original_len);
    }

    #[test]
    fn sparse_write_reopens_without_allocating_the_hole() {
        let digest = [10; 32];
        let offset = 8 * 1024 * 1024 * 1024u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        assert_eq!(
            journal.write_file_at(7, 0, offset, b"hello", |_, _| panic!("no base bytes")),
            Ok(5)
        );
        let storage = journal.into_storage();
        assert!(storage.bytes.len() < 5000);
        let mut recovered = OverlayJournal::open(storage, digest).unwrap();
        assert_eq!(recovered.state().file_size(7, 0), Ok(offset + 5));
        let mut bytes = [0xff; 8];
        assert_eq!(
            recovered.read_file_at(7, 0, offset - 3, &mut bytes, |_, _| panic!("no base bytes")),
            Ok(8)
        );
        assert_eq!(&bytes, b"\0\0\0hello");
    }

    #[test]
    fn partial_write_preserves_only_the_touched_base_blocks() {
        let digest = [11; 32];
        let base = vec![b'a'; FILE_BLOCK_BYTES * 3];
        let mut reads = Vec::new();
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        assert_eq!(
            journal.write_file_at(
                7,
                base.len() as u64,
                (FILE_BLOCK_BYTES - 2) as u64,
                b"WXYZ",
                |offset, dst| {
                    reads.push((offset, dst.len()));
                    dst.copy_from_slice(&base[offset as usize..offset as usize + dst.len()]);
                    Ok(dst.len())
                }
            ),
            Ok(4)
        );
        assert_eq!(
            reads,
            vec![
                (0, FILE_BLOCK_BYTES),
                (FILE_BLOCK_BYTES as u64, FILE_BLOCK_BYTES)
            ]
        );
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        let mut bytes = [0; 8];
        assert_eq!(
            recovered.read_file_at(
                7,
                base.len() as u64,
                (FILE_BLOCK_BYTES - 4) as u64,
                &mut bytes,
                |_, _| panic!("modified blocks are journaled")
            ),
            Ok(8)
        );
        assert_eq!(&bytes, b"aaWXYZaa");
        let mut untouched = [0; 4];
        assert_eq!(
            recovered.read_file_at(
                7,
                base.len() as u64,
                (FILE_BLOCK_BYTES * 2) as u64,
                &mut untouched,
                |offset, dst| {
                    dst.copy_from_slice(&base[offset as usize..offset as usize + dst.len()]);
                    Ok(dst.len())
                }
            ),
            Ok(4)
        );
        assert_eq!(&untouched, b"aaaa");
    }

    #[test]
    fn full_block_replacement_needs_no_base_read_but_partial_failure_is_atomic() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [12; 32]).unwrap();
        assert_eq!(
            journal.write_file_at(
                7,
                FILE_BLOCK_BYTES as u64,
                0,
                &vec![b'x'; FILE_BLOCK_BYTES],
                |_, _| Err(Errno::EAGAIN)
            ),
            Ok(FILE_BLOCK_BYTES)
        );
        let old_len = journal.storage.bytes.len();
        assert_eq!(
            journal.write_file_at(
                7,
                FILE_BLOCK_BYTES as u64,
                FILE_BLOCK_BYTES as u64 + 1,
                b"y",
                |_, _| Err(Errno::EAGAIN)
            ),
            Ok(1)
        );
        assert!(journal.storage.bytes.len() > old_len);

        let mut fresh = OverlayJournal::open(MemoryStorage::default(), [13; 32]).unwrap();
        let old_len = fresh.storage.bytes.len();
        assert_eq!(
            fresh.write_file_at(7, FILE_BLOCK_BYTES as u64, 1, b"y", |_, _| Err(
                Errno::EAGAIN
            )),
            Err(Errno::EAGAIN)
        );
        assert_eq!(fresh.storage.bytes.len(), old_len);
        assert!(fresh.state().blocks.get(&(7, 0)).is_none());
    }

    #[test]
    fn oversized_write_is_rejected_before_reading_or_mutating() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [14; 32]).unwrap();
        let original_len = journal.storage.bytes.len();
        let bytes = vec![0; MAX_TRANSACTION_BYTES];
        assert_eq!(
            journal.write_file_at(7, 0, 0, &bytes, |_, _| panic!("oversized write read base")),
            Err(Errno::EFBIG)
        );
        assert_eq!(journal.storage.bytes.len(), original_len);
        assert_eq!(journal.state().file_size(7, 0), Ok(0));
    }

    #[test]
    fn torn_sparse_write_never_publishes_size_without_data() {
        let digest = [15; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .write_file_at(7, 0, 0, b"old", |_, _| panic!("no base bytes"))
            .unwrap();
        let committed = journal.into_storage();
        let old_end = committed.bytes.len();
        let mut journal = OverlayJournal::open(committed, digest).unwrap();
        journal
            .write_file_at(7, 0, 8192, b"new", |_, _| panic!("no base bytes"))
            .unwrap();
        let complete = journal.into_storage();
        for cut in old_end..=complete.bytes.len() {
            let storage = MemoryStorage {
                bytes: complete.bytes[..cut].to_vec(),
                ..MemoryStorage::default()
            };
            let mut recovered = OverlayJournal::open(storage, digest).unwrap();
            let committed_new = cut == complete.bytes.len();
            assert_eq!(
                recovered.state().file_size(7, 0),
                Ok(if committed_new { 8195 } else { 3 }),
                "cut {cut}"
            );
            let mut data = [0; 3];
            let read = recovered
                .read_file_at(7, 0, 8192, &mut data, |_, _| panic!("no base bytes"))
                .unwrap();
            assert_eq!(read, if committed_new { 3 } else { 0 }, "cut {cut}");
            if committed_new {
                assert_eq!(&data, b"new");
            }
        }
    }

    #[test]
    fn detects_block_corruption_after_recovery() {
        let digest = [16; 32];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        journal
            .write_file_at(7, 0, 0, b"hello", |_, _| panic!("no base bytes"))
            .unwrap();
        let mut reopened = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        let location = reopened.state.blocks[&(7, 0)].unwrap();
        reopened.storage.bytes[location.offset as usize] ^= 1;
        let mut bytes = [0; 5];
        assert_eq!(
            reopened.read_file_at(7, 0, 0, &mut bytes, |_, _| panic!("block is journaled")),
            Err(Errno::EIO)
        );
    }

    #[test]
    fn caches_at_most_sixty_four_blocks() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [17; 32]).unwrap();
        let data = vec![7; FILE_BLOCK_BYTES * (CACHE_BLOCKS + 1)];
        journal
            .write_file_at(7, 0, 0, &data, |_, _| panic!("no base bytes"))
            .unwrap();
        let mut reopened = OverlayJournal::open(journal.into_storage(), [17; 32]).unwrap();
        let mut bytes = [0; FILE_BLOCK_BYTES];
        for block in 0..=CACHE_BLOCKS {
            assert_eq!(
                reopened.read_file_at(
                    7,
                    0,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &mut bytes,
                    |_, _| panic!("block is journaled")
                ),
                Ok(FILE_BLOCK_BYTES)
            );
        }
        assert_eq!(reopened.block_cache.len(), CACHE_BLOCKS);
        assert_eq!(bytes, [7; FILE_BLOCK_BYTES]);
    }

    #[test]
    fn buffered_writes_are_visible_before_sync_but_lost_on_crash() {
        let digest = [18; 32];
        let base = vec![b'a'; FILE_BLOCK_BYTES];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        let durable_len = journal.storage.bytes.len();
        assert_eq!(
            journal.write_fixed_file_at_buffered(7, base.len() as u64, 1, b"new", |offset, dst| {
                dst.copy_from_slice(&base[offset as usize..offset as usize + dst.len()]);
                Ok(dst.len())
            }),
            Ok(3)
        );
        assert_eq!(journal.storage.bytes.len(), durable_len);
        let mut visible = [0; 5];
        assert_eq!(
            journal.read_file_at(7, base.len() as u64, 0, &mut visible, |_, _| {
                panic!("dirty block must satisfy the read")
            }),
            Ok(5)
        );
        assert_eq!(&visible, b"anewa");
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        let mut after_crash = [0; 5];
        recovered
            .read_file_at(7, base.len() as u64, 0, &mut after_crash, |offset, dst| {
                dst.copy_from_slice(&base[offset as usize..offset as usize + dst.len()]);
                Ok(dst.len())
            })
            .unwrap();
        assert_eq!(&after_crash, b"aaaaa");
    }

    #[test]
    fn buffered_sync_recovers_and_eviction_stays_bounded() {
        let digest = [19; 32];
        let size = ((CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES) as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for block in 0..=CACHE_BLOCKS {
            assert_eq!(
                journal.write_fixed_file_at_buffered(
                    7,
                    size,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &[block as u8; FILE_BLOCK_BYTES],
                    |_, _| panic!("full blocks need no base read")
                ),
                Ok(FILE_BLOCK_BYTES)
            );
        }
        assert_eq!(
            journal.dirty_blocks.len(),
            CACHE_BLOCKS - CACHE_BLOCKS / 4 + 1
        );
        assert!(journal.state.blocks.contains_key(&(7, 0)));
        assert!(!journal.state.blocks.contains_key(&(7, CACHE_BLOCKS as u64)));
        journal.sync().unwrap();
        assert!(journal.dirty_blocks.is_empty());
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        for block in 0..=CACHE_BLOCKS {
            let mut byte = [255];
            assert_eq!(
                recovered.read_file_at(
                    7,
                    size,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &mut byte,
                    |_, _| panic!("block must be journaled")
                ),
                Ok(1)
            );
            assert_eq!(byte[0], block as u8);
        }
    }

    #[test]
    fn buffered_write_evicts_only_blocks_outside_the_write() {
        let digest = [39; 32];
        let size = ((CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES) as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        for block in 0..CACHE_BLOCKS {
            journal
                .write_fixed_file_at_buffered(
                    7,
                    size,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &[b'a'; FILE_BLOCK_BYTES],
                    |_, _| panic!("full blocks need no base read"),
                )
                .unwrap();
        }
        let replacement = vec![b'b'; CACHE_BLOCKS * FILE_BLOCK_BYTES];
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                size,
                FILE_BLOCK_BYTES as u64,
                &replacement,
                |_, _| panic!("full blocks need no base read"),
            ),
            Ok(replacement.len())
        );
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
        assert!(journal.state.blocks.contains_key(&(7, 0)));
        journal.sync().unwrap();
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        for block in 0..=CACHE_BLOCKS {
            let mut byte = [0];
            recovered
                .read_file_at(
                    7,
                    size,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &mut byte,
                    |_, _| panic!("block must be journaled"),
                )
                .unwrap();
            assert_eq!(byte[0], if block == 0 { b'a' } else { b'b' });
        }
    }

    #[test]
    fn active_tail_limit_rejects_new_writes_until_checkpoint_handoff() {
        let size = (2 * FILE_BLOCK_BYTES) as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [37; 32]).unwrap();
        journal.tail_limit_bytes = Some(100);
        journal
            .write_fixed_file_at_buffered(7, size, 0, &[b'a'; FILE_BLOCK_BYTES], |_, _| {
                panic!("full block needs no base read")
            })
            .unwrap();
        journal.sync().unwrap();
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                size,
                FILE_BLOCK_BYTES as u64,
                b"new",
                |_, dst| {
                    dst.fill(0);
                    Ok(dst.len())
                }
            ),
            Err(Errno::ENOSPC)
        );
        let mut visible = [0];
        journal
            .read_file_at(7, size, 0, &mut visible, |_, _| {
                panic!("journal must satisfy read")
            })
            .unwrap();
        assert_eq!(visible, [b'a']);
        let mut compacted = journal
            .compact_fixed_into(MemoryStorage::default())
            .unwrap();
        assert!(compacted.state.blocks.is_empty());
        compacted
            .install_fixed_block_checkpoint(Box::new(MemoryStorage::default()))
            .unwrap();
        let mut visible = [0];
        compacted
            .read_file_at(7, size, 0, &mut visible, |_, _| {
                panic!("checkpoint must satisfy read")
            })
            .unwrap();
        assert_eq!(visible, [b'a']);
        compacted.tail_limit_bytes = Some(100);
        assert_eq!(
            compacted.write_fixed_file_at_buffered(
                7,
                size,
                FILE_BLOCK_BYTES as u64,
                b"new",
                |_, dst| {
                    dst.fill(0);
                    Ok(dst.len())
                }
            ),
            Ok(3)
        );
    }

    #[test]
    fn active_tail_limit_rejects_metadata_without_blocking_dirty_flush() {
        let mut metadata_only = OverlayJournal::open(MemoryStorage::default(), [48; 32]).unwrap();
        metadata_only.tail_limit_bytes = Some(1);
        metadata_only
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }])
            .unwrap();
        let metadata_end = metadata_only.storage.bytes.len();
        assert_eq!(
            metadata_only.commit(&[Mutation::Put {
                key: OverlayKey::Inode(8),
                value: b"more metadata".to_vec(),
            }]),
            Err(Errno::ENOSPC)
        );
        assert_eq!(metadata_only.storage.bytes.len(), metadata_end);

        let mut journal = OverlayJournal::open(MemoryStorage::default(), [47; 32]).unwrap();
        journal.tail_limit_bytes = Some(100);
        journal
            .write_fixed_file_at_buffered(7, FILE_BLOCK_BYTES as u64, 0, b"data", |_, dst| {
                dst.fill(0);
                Ok(dst.len())
            })
            .unwrap();
        journal
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }])
            .unwrap_err();
        assert_eq!(journal.dirty_blocks.len(), 0);
        assert_eq!(journal.state().lookup(&inode_key()), None);
        let end = journal.storage.bytes.len();
        assert_eq!(
            journal.commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }]),
            Err(Errno::ENOSPC)
        );
        assert_eq!(journal.storage.bytes.len(), end);
        journal.commit(&[]).unwrap();
        let mut recovered = OverlayJournal::open(journal.into_storage(), [47; 32]).unwrap();
        let mut visible = [0; 4];
        recovered
            .read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut visible, |_, dst| {
                dst.fill(0);
                Ok(dst.len())
            })
            .unwrap();
        assert_eq!(&visible, b"data");
    }

    #[test]
    fn buffered_sync_failure_preserves_dirty_data_and_rejects_durability() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [20; 32]).unwrap();
        journal
            .write_fixed_file_at_buffered(7, FILE_BLOCK_BYTES as u64, 0, b"data", |_, dst| {
                dst.fill(0);
                Ok(dst.len())
            })
            .unwrap();
        journal.storage.fail_flush = true;
        assert_eq!(journal.sync(), Err(Errno::EIO));
        assert_eq!(journal.dirty_blocks.len(), 1);
        let mut visible = [0; 4];
        assert_eq!(
            journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut visible, |_, _| {
                panic!("dirty block must remain readable")
            }),
            Ok(4)
        );
        assert_eq!(&visible, b"data");
        journal.storage.fail_flush = false;
        assert_eq!(journal.sync(), Err(Errno::EIO));
        assert_eq!(
            journal.write_fixed_file_at_buffered(7, FILE_BLOCK_BYTES as u64, 0, b"no", |_, _| {
                panic!("poisoned journal cannot write")
            }),
            Err(Errno::EIO)
        );
    }

    #[test]
    fn torn_truncate_preserves_the_synced_file_and_old_size() {
        let digest = [55; 32];
        let base_size = (FILE_BLOCK_BYTES * 2) as u64;
        for cut in [0, 24, 512, FILE_BLOCK_BYTES] {
            let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
            journal
                .write_file_at_buffered(7, base_size, 0, b"new!", |_, dst| {
                    dst.fill(b'a');
                    Ok(dst.len())
                })
                .unwrap();
            journal.sync().unwrap();
            journal.storage.fail_write_after_bytes = Some(cut);
            assert_eq!(
                journal.truncate_file_at(7, base_size, 1, |_, dst| {
                    dst.fill(b'a');
                    Ok(dst.len())
                }),
                Err(Errno::EIO)
            );
            assert_eq!(journal.visible_file_size(7, base_size), Ok(base_size));
            let mut live = [0; 4];
            assert_eq!(
                journal.read_file_at(7, base_size, 0, &mut live, |_, dst| {
                    dst.fill(b'a');
                    Ok(dst.len())
                }),
                Ok(live.len())
            );
            assert_eq!(&live, b"new!");

            let mut storage = journal.into_storage();
            storage.fail_write_after_bytes = None;
            let mut reopened = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(reopened.visible_file_size(7, base_size), Ok(base_size));
            let mut recovered = [0; 4];
            assert_eq!(
                reopened.read_file_at(7, base_size, 0, &mut recovered, |_, dst| {
                    dst.fill(b'a');
                    Ok(dst.len())
                }),
                Ok(recovered.len())
            );
            assert_eq!(&recovered, b"new!");
        }
    }

    #[test]
    fn every_torn_writeback_offset_recovers_the_previous_durable_block() {
        let digest = [29; 32];
        let mut initial = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        initial
            .commit(&[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'a'; FILE_BLOCK_BYTES],
            }])
            .unwrap();
        let durable = initial.into_storage().bytes;
        let transaction_length = encode_transaction(
            2,
            &[Mutation::Put {
                key: OverlayKey::FileBlock { inode: 7, block: 0 },
                value: vec![b'b'; FILE_BLOCK_BYTES],
            }],
        )
        .unwrap()
        .len();
        for cut in 0..transaction_length {
            let mut journal = OverlayJournal::open(
                MemoryStorage {
                    bytes: durable.clone(),
                    fail_write_after_bytes: Some(cut),
                    ..MemoryStorage::default()
                },
                digest,
            )
            .unwrap();
            journal
                .write_fixed_file_at_buffered(
                    7,
                    FILE_BLOCK_BYTES as u64,
                    0,
                    &[b'b'; FILE_BLOCK_BYTES],
                    |_, _| panic!("journaled block needs no base read"),
                )
                .unwrap();
            assert_eq!(journal.sync(), Err(Errno::EIO), "cut {cut}");
            assert_eq!(journal.dirty_blocks.len(), 1, "cut {cut}");
            let mut visible = [0];
            assert_eq!(
                journal.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut visible, |_, _| {
                    panic!("dirty block must satisfy read")
                }),
                Ok(1)
            );
            assert_eq!(visible, [b'b'], "cut {cut}");
            let mut storage = journal.into_storage();
            storage.fail_write_after_bytes = None;
            let written = storage.bytes.clone();
            let mut recovered = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(recovered.storage.bytes, written, "cut {cut}");
            assert_eq!(
                recovered.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut visible, |_, _| {
                    panic!("old block must remain journaled")
                }),
                Ok(1)
            );
            assert_eq!(visible, [b'a'], "cut {cut}");
        }
    }

    #[test]
    fn large_fixed_overwrite_uses_bounded_cache_and_replays_after_sync() {
        let size = 2 * 1024 * 1024 + FILE_BLOCK_BYTES;
        let offset = 13;
        let source: Vec<u8> = (0..2 * 1024 * 1024)
            .map(|index| ((index / FILE_BLOCK_BYTES) ^ index) as u8)
            .collect();
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [30; 32]).unwrap();
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                size as u64,
                offset,
                &source,
                |_, destination| {
                    destination.fill(0);
                    Ok(destination.len())
                },
            ),
            Ok(source.len())
        );
        assert!(journal.dirty_blocks.len() <= CACHE_BLOCKS);
        journal.sync().unwrap();
        let mut reopened = OverlayJournal::open(journal.into_storage(), [30; 32]).unwrap();
        let mut result = vec![0; source.len()];
        assert_eq!(
            reopened.read_file_at(7, size as u64, offset, &mut result, |_, destination| {
                destination.fill(0);
                Ok(destination.len())
            }),
            Ok(source.len())
        );
        assert_eq!(result, source);
    }

    #[test]
    fn large_fixed_overwrite_returns_short_count_when_later_writeback_fails() {
        let chunk_bytes = CACHE_BLOCKS * FILE_BLOCK_BYTES;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [31; 32]).unwrap();
        journal.storage.fail_flush = true;
        let source = vec![b'x'; chunk_bytes + FILE_BLOCK_BYTES];
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                source.len() as u64,
                0,
                &source,
                |_, _| panic!("full blocks need no base read"),
            ),
            Ok(chunk_bytes)
        );
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
        let mut first = [0];
        assert_eq!(
            journal.read_file_at(7, source.len() as u64, 0, &mut first, |_, _| {
                panic!("dirty block must remain readable")
            }),
            Ok(1)
        );
        assert_eq!(first, [b'x']);
        assert_eq!(journal.sync(), Err(Errno::EIO));
    }

    #[test]
    fn quota_failure_during_eviction_remains_visible_to_later_sync() {
        let chunk_bytes = CACHE_BLOCKS * FILE_BLOCK_BYTES;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [49; 32]).unwrap();
        journal.storage.fail_flush = true;
        journal.storage.fail_errno = Some(Errno::ENOSPC);
        let source = vec![b'x'; chunk_bytes + FILE_BLOCK_BYTES];
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                source.len() as u64,
                0,
                &source,
                |_, _| panic!("full blocks need no base read"),
            ),
            Ok(chunk_bytes)
        );
        assert_eq!(journal.sync(), Err(Errno::ENOSPC));
        assert_eq!(journal.commit(&[]), Err(Errno::ENOSPC));
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
        let mut visible = [0];
        assert_eq!(
            journal.read_file_at(7, source.len() as u64, 0, &mut visible, |_, _| {
                panic!("dirty block must remain readable")
            }),
            Ok(1)
        );
        assert_eq!(visible, [b'x']);
    }

    #[test]
    fn buffered_sparse_growth_reopens_without_allocating_the_hole() {
        let digest = [43; 32];
        let offset = 8 * 1024 * 1024 * 1024u64 + 7;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        assert_eq!(
            journal.write_file_at_buffered(7, 0, offset, b"hello", |_, _| {
                panic!("sparse write needs no base read")
            }),
            Ok(5)
        );
        assert_eq!(journal.storage.bytes.len(), HEADER_BYTES);
        assert_eq!(journal.dirty_sizes.get(&7), Some(&(offset + 5)));
        let mut visible = [1; 8];
        assert_eq!(
            journal.read_file_at(7, 0, offset - 3, &mut visible, |_, _| {
                panic!("dirty sparse block must satisfy read")
            }),
            Ok(8)
        );
        assert_eq!(&visible, b"\0\0\0hello");
        journal.sync().unwrap();
        assert!(journal.storage.bytes.len() < 5000);
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        assert_eq!(recovered.state.file_size(7, 0), Ok(offset + 5));
        assert_eq!(
            recovered.read_file_at(7, 0, offset - 3, &mut visible, |_, _| {
                panic!("journaled sparse block must satisfy read")
            }),
            Ok(8)
        );
        assert_eq!(&visible, b"\0\0\0hello");
    }

    #[test]
    fn growing_cache_eviction_publishes_size_with_committed_blocks() {
        let digest = [44; 32];
        let source = vec![b'x'; (CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES];
        let mut journal = OverlayJournal::open(MemoryStorage::default(), digest).unwrap();
        assert_eq!(
            journal.write_file_at_buffered(7, 0, 0, &source, |_, _| {
                panic!("full blocks need no base read")
            }),
            Ok(source.len())
        );
        assert!(journal.dirty_blocks.len() <= CACHE_BLOCKS);
        assert_eq!(journal.dirty_sizes.get(&7), Some(&(source.len() as u64)));
        let mut recovered = OverlayJournal::open(journal.into_storage(), digest).unwrap();
        assert_eq!(
            recovered.state.file_size(7, 0),
            Ok((CACHE_BLOCKS * FILE_BLOCK_BYTES) as u64)
        );
        let mut byte = [0];
        assert_eq!(
            recovered.read_file_at(7, 0, 0, &mut byte, |_, _| {
                panic!("evicted block must be journaled")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'x']);
        assert_eq!(
            recovered.read_file_at(
                7,
                0,
                (CACHE_BLOCKS - 1) as u64 * FILE_BLOCK_BYTES as u64,
                &mut byte,
                |_, _| { panic!("unflushed block must read as a hole") }
            ),
            Ok(1)
        );
        assert_eq!(byte, [0]);
    }

    #[test]
    fn growing_cache_bounds_pending_sizes_and_returns_short_on_writeback_failure() {
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [45; 32]).unwrap();
        for inode in 1..=CACHE_BLOCKS as u64 {
            journal
                .write_file_at_buffered(inode, 0, 0, b"x", |_, _| {
                    panic!("new files have no base bytes")
                })
                .unwrap();
        }
        assert_eq!(journal.dirty_sizes.len(), CACHE_BLOCKS);
        journal
            .write_file_at_buffered(CACHE_BLOCKS as u64 + 1, 0, 0, b"y", |_, _| {
                panic!("new files have no base bytes")
            })
            .unwrap();
        assert_eq!(journal.dirty_sizes.len(), 1);
        assert_eq!(journal.state.file_size(1, 0), Ok(1));
        journal.sync().unwrap();
        let mut recovered = OverlayJournal::open(journal.into_storage(), [45; 32]).unwrap();
        let mut byte = [0];
        assert_eq!(
            recovered.read_file_at(CACHE_BLOCKS as u64 + 1, 0, 0, &mut byte, |_, _| {
                panic!("last block must be journaled")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'y']);

        let mut failing = OverlayJournal::open(MemoryStorage::default(), [46; 32]).unwrap();
        failing.storage.fail_flush = true;
        let source = vec![b'x'; (CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES];
        assert_eq!(
            failing.write_file_at_buffered(7, 0, 0, &source, |_, _| {
                panic!("full blocks need no base read")
            }),
            Ok(CACHE_BLOCKS * FILE_BLOCK_BYTES)
        );
        assert_eq!(
            failing.dirty_sizes.get(&7),
            Some(&((CACHE_BLOCKS * FILE_BLOCK_BYTES) as u64))
        );
        assert_eq!(failing.sync(), Err(Errno::EIO));
    }

    #[test]
    fn failed_eviction_never_acknowledges_a_new_write() {
        let size = ((CACHE_BLOCKS + 1) * FILE_BLOCK_BYTES) as u64;
        let mut journal = OverlayJournal::open(MemoryStorage::default(), [21; 32]).unwrap();
        for block in 0..CACHE_BLOCKS {
            journal
                .write_fixed_file_at_buffered(
                    7,
                    size,
                    (block * FILE_BLOCK_BYTES) as u64,
                    &[block as u8; FILE_BLOCK_BYTES],
                    |_, _| panic!("full block needs no base read"),
                )
                .unwrap();
        }
        journal.storage.fail_flush = true;
        assert_eq!(
            journal.write_fixed_file_at_buffered(
                7,
                size,
                (CACHE_BLOCKS * FILE_BLOCK_BYTES) as u64,
                b"new",
                |_, dst| {
                    dst.fill(0);
                    Ok(dst.len())
                }
            ),
            Err(Errno::EIO)
        );
        assert_eq!(journal.dirty_blocks.len(), CACHE_BLOCKS);
        let mut previous = [0xff];
        assert_eq!(
            journal.read_file_at(7, size, 0, &mut previous, |_, _| {
                panic!("previous dirty block must remain readable")
            }),
            Ok(1)
        );
        assert_eq!(previous, [0]);
        assert!(
            !journal
                .dirty_blocks
                .iter()
                .any(|(key, _)| key.1 == CACHE_BLOCKS as u64)
        );
    }
}
