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
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
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
const FILE_BLOCK_BYTES: usize = 4096;
const CACHE_BLOCKS: usize = 64;
const METADATA_CACHE_ENTRIES: usize = 64;
const ACTIVE_TAIL_LIMIT_BYTES: u64 = 63 * 1024 * 1024;
const LEGACY_SORT_RECORD_BYTES: u64 = 96;
const LEGACY_SORT_RUN_RECORDS: usize = 4 * 1024;
const LEGACY_SORT_IO_RECORDS: usize = 1024;
const LEGACY_MUTATION_RECORD_BYTES: usize = 384;

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
    entries: BTreeMap<OverlayKey, Option<Vec<u8>>>,
    blocks: BTreeMap<(u64, u64), Option<BlockLocation>>,
    invalid_checkpoint_from: BTreeMap<u64, u64>,
}

#[derive(Clone, Copy)]
struct BlockLocation {
    offset: u64,
    digest: [u8; 32],
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

    fn apply(&mut self, mutation: Mutation, value_offset: Option<u64>, has_checkpoint: bool) {
        match mutation {
            Mutation::Put { key, value } => {
                if let OverlayKey::FileZeroFrom(inode) = key {
                    let block = u64::from_le_bytes(value[..8].try_into().unwrap());
                    self.blocks
                        .retain(|(owner, index), _| *owner != inode || *index < block);
                    if has_checkpoint {
                        self.invalid_checkpoint_from
                            .entry(inode)
                            .and_modify(|old| *old = (*old).min(block))
                            .or_insert(block);
                    }
                    let previous = self.zero_from(inode).ok().flatten().unwrap_or(u64::MAX);
                    self.entries
                        .insert(key, Some(previous.min(block).to_le_bytes().to_vec()));
                } else if let OverlayKey::FileBlock { inode, block } = key {
                    let digest: [u8; 32] = Sha256::digest(&value).into();
                    self.blocks.insert(
                        (inode, block),
                        value_offset.map(|offset| BlockLocation { offset, digest }),
                    );
                } else {
                    self.entries.insert(key, Some(value));
                }
            }
            Mutation::Delete { key } => {
                if let OverlayKey::FileBlock { inode, block } = key {
                    self.blocks.insert((inode, block), None);
                } else {
                    self.entries.insert(key, None);
                }
            }
        }
    }
}

pub struct OverlayJournal<S: OverlayStorage> {
    storage: S,
    base_digest: [u8; 32],
    state: OverlayState,
    checkpoint: Option<BlockCheckpoint<Box<dyn OverlayStorage + Send>>>,
    next_sequence: u64,
    end: u64,
    failure: Option<Errno>,
    block_cache: Vec<((u64, u64), Vec<u8>)>,
    dirty_blocks: Vec<((u64, u64), Vec<u8>)>,
    dirty_sizes: BTreeMap<u64, u64>,
    metadata_cache: Vec<(OverlayKey, Option<Option<Vec<u8>>>)>,
    tail_limit_bytes: Option<u64>,
    track_committed_state: bool,
    retain_compacted_metadata: bool,
    metadata_prefix_resident: bool,
}

fn read_overlay_header<S: OverlayStorage>(
    storage: &mut S,
    base_digest: [u8; 32],
) -> Result<[u8; HEADER_BYTES], Errno> {
    let mut header = [0u8; HEADER_BYTES];
    storage.read_exact_at(0, &mut header)?;
    if &header[..4] != MAGIC
        || u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) != VERSION
        || header[8..40] != base_digest
        || header[40..] != Sha256::digest(&header[..40])[..]
    {
        return Err(Errno::EIO);
    }
    Ok(header)
}

fn read_indexed_metadata<S: OverlayStorage>(
    storage: &mut S,
    entry: &MetadataCheckpointEntry,
    bytes: &mut Vec<u8>,
) -> Result<bool, Errno> {
    let Some((offset, length)) = entry.value else {
        return Ok(false);
    };
    bytes.resize(length as usize, 0);
    storage.read_exact_at(offset, bytes)?;
    if entry.value_digest.is_some_and(|digest| Sha256::digest(&*bytes)[..] != digest) {
        return Err(Errno::EIO);
    }
    Ok(true)
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
            let mut verify_record = |mutation: &Mutation, value_offset: Option<u64>| {
                if let OverlayKey::FileBlock { inode, block } = mutation_key(mutation) {
                    if verify_blocks {
                        let (offset, digest) = match mutation {
                            Mutation::Put { value, .. } => (
                                value_offset.ok_or(Errno::EIO)?,
                                Sha256::digest(value).into(),
                            ),
                            Mutation::Delete { .. } => (0, [0; 32]),
                        };
                        let record = BlockCheckpointEntry {
                            inode: *inode,
                            block: *block,
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
                let value = match mutation {
                    Mutation::Put { value, .. } => Some((
                        value_offset.ok_or(Errno::EIO)?,
                        u32::try_from(value.len()).map_err(|_| Errno::EIO)?,
                    )),
                    Mutation::Delete { .. } => None,
                };
                let record = MetadataCheckpointEntry {
                    key: mutation_key(mutation).clone(),
                    value,
                    value_digest: match mutation {
                        Mutation::Put { value, .. } if verify_blocks => {
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
        checkpoint: Option<BlockCheckpoint<Box<dyn OverlayStorage + Send>>>,
        mut state: OverlayState,
    ) -> Result<Self, Errno> {
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
        if end < size {
            storage.truncate(end)?;
            storage.flush()?;
        }
        Ok(Self {
            storage,
            base_digest,
            state,
            checkpoint,
            next_sequence,
            end,
            failure: None,
            block_cache: Vec::new(),
            dirty_blocks: Vec::new(),
            dirty_sizes: BTreeMap::new(),
            metadata_cache: Vec::new(),
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

    pub fn metadata_value(&mut self, key: &OverlayKey) -> Result<Option<Option<Vec<u8>>>, Errno> {
        if matches!(key, OverlayKey::FileBlock { .. }) {
            return Err(Errno::EINVAL);
        }
        let current = self.state.entries.get(key).cloned();
        if !matches!(key, OverlayKey::FileZeroFrom(_)) && current.is_some() {
            return Ok(current);
        }
        let indexed_value = self.indexed_metadata_value(key)?;
        match (key, current, indexed_value) {
            (OverlayKey::FileZeroFrom(_), Some(Some(current)), Some(Some(indexed))) => {
                let current =
                    u64::from_le_bytes(current.as_slice().try_into().map_err(|_| Errno::EIO)?);
                let indexed =
                    u64::from_le_bytes(indexed.as_slice().try_into().map_err(|_| Errno::EIO)?);
                Ok(Some(Some(current.min(indexed).to_le_bytes().to_vec())))
            }
            (_, Some(value), _) => Ok(Some(value)),
            (_, None, value) => Ok(value),
        }
    }

    fn indexed_metadata_value(
        &mut self,
        key: &OverlayKey,
    ) -> Result<Option<Option<Vec<u8>>>, Errno> {
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
            .position(|(cached, _)| cached == key)
        {
            let cached = self.metadata_cache.remove(position);
            let result = cached.1.clone();
            self.metadata_cache.push(cached);
            return Ok(result);
        }
        let indexed = checkpoint.lookup_metadata(key)?;
        let result = match indexed {
            Some(entry) => {
                let mut bytes = Vec::new();
                Some(read_indexed_metadata(&mut self.storage, &entry, &mut bytes)?.then_some(bytes))
            }
            None => None,
        };
        if self.metadata_cache.len() == METADATA_CACHE_ENTRIES {
            self.metadata_cache.remove(0);
        }
        self.metadata_cache.push((key.clone(), result.clone()));
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
        let mut indexed = match checkpoint.as_mut() {
            Some(ref mut checkpoint) => checkpoint.metadata_entry_at(0)?,
            None => None,
        };
        let mut tail = self.state.entries.iter().peekable();
        let mut indexed_bytes = Vec::new();
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
                        read_indexed_metadata(&mut self.storage, entry, &mut indexed_bytes)?
                            .then_some(indexed_bytes.as_slice());
                    visit(&entry.key, value)?;
                }
                core::cmp::Ordering::Equal => {
                    let entry = indexed.as_ref().ok_or(Errno::EIO)?;
                    let (key, value) = tail.next().ok_or(Errno::EIO)?;
                    if matches!(key, OverlayKey::FileZeroFrom(_)) {
                        if let Some(current) = value {
                            if read_indexed_metadata(&mut self.storage, entry, &mut indexed_bytes)?
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

    pub fn release_checkpoint_metadata(&mut self) -> Result<(), Errno> {
        self.release_checkpoint_metadata_with(|_| {})
    }

    pub(crate) fn release_checkpoint_metadata_with<F>(&mut self, before_release: F) -> Result<(), Errno>
    where
        F: FnOnce(&OverlayState),
    {
        if !self.metadata_prefix_resident {
            before_release(&self.state);
            return Ok(());
        }
        if self.checkpoint.as_ref().map(BlockCheckpoint::journal_end) != Some(self.end) {
            return Err(Errno::EBUSY);
        }
        before_release(&self.state);
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
        F: FnMut(u64) -> Option<u64>,
    {
        let max_zero_block = i64::MAX as u64 / FILE_BLOCK_BYTES as u64 + 1;
        self.for_each_metadata(|key, value| {
            if matches!(key, OverlayKey::Dirent { .. } | OverlayKey::Inode(_)) {
                return Ok(());
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
            base_size(inode).ok_or(Errno::EIO)?;
            Ok(())
        })?;
        for &(inode, block) in self.state.blocks.keys() {
            if block > i64::MAX as u64 / FILE_BLOCK_BYTES as u64 {
                return Err(Errno::EIO);
            }
            base_size(inode).ok_or(Errno::EIO)?;
        }
        if let Some(checkpoint) = self.checkpoint.as_mut() {
            for index in 0..checkpoint.count() {
                let entry = checkpoint.entry_at(index)?.ok_or(Errno::EIO)?;
                if entry.block > i64::MAX as u64 / FILE_BLOCK_BYTES as u64 {
                    return Err(Errno::EIO);
                }
                base_size(entry.inode).ok_or(Errno::EIO)?;
            }
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
        self.compact_into_internal(target, true, true, |_, _| true)
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
        self.compact_into_internal(target, false, false, |_, _| true)
    }

    pub fn compact_metadata_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, false, true, |_, _| true)
    }

    pub(crate) fn compact_metadata_reachable_into<
        T: OverlayStorage,
        F: FnMut(&OverlayKey, Option<&[u8]>) -> bool,
    >(
        &mut self,
        target: T,
        retain: F,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, false, true, retain)
    }

    fn compact_into_internal<T: OverlayStorage, F: FnMut(&OverlayKey, Option<&[u8]>) -> bool>(
        &mut self,
        mut target: T,
        track_committed_state: bool,
        allow_tombstones: bool,
        mut retain: F,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.sync()?;
        if target.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        let mut compacted = OverlayJournal::open(target, self.base_digest)?;
        compacted.track_committed_state = track_committed_state;
        let mut batch = Vec::new();
        batch.try_reserve_exact(128).map_err(|_| Errno::ENOMEM)?;
        self.for_each_metadata(|key, value| {
            if retain(key, value) {
                let mutation = match value {
                    Some(bytes) => Mutation::Put {
                        key: key.clone(),
                        value: bytes.to_vec(),
                    },
                    None => Mutation::Delete { key: key.clone() },
                };
                batch.push(mutation);
                if batch.len() == 128 {
                    compacted.commit_transaction(&batch)?;
                    batch.clear();
                }
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
            let mutation = match location {
                Some(location) => {
                    let mut bytes = alloc::vec![0; FILE_BLOCK_BYTES];
                    self.storage.read_exact_at(location.offset, &mut bytes)?;
                    if Sha256::digest(&bytes)[..] != location.digest {
                        return Err(Errno::EIO);
                    }
                    Mutation::Put { key, value: bytes }
                }
                None if allow_tombstones => Mutation::Delete { key },
                None => return Err(Errno::EIO),
            };
            batch.push(mutation);
            if batch.len() == 128 {
                compacted.commit_transaction(&batch)?;
                batch.clear();
            }
        }
        compacted.commit_transaction(&batch)?;
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

    fn flush_dirty(&mut self) -> Result<(), Errno> {
        if self.dirty_blocks.is_empty() && self.dirty_sizes.is_empty() {
            return Ok(());
        }
        let mut mutations: Vec<_> = self
            .dirty_blocks
            .iter()
            .map(|((inode, block), bytes)| Mutation::Put {
                key: OverlayKey::FileBlock {
                    inode: *inode,
                    block: *block,
                },
                value: bytes.clone(),
            })
            .collect();
        mutations.extend(
            self.dirty_sizes
                .iter()
                .map(|(&inode, &size)| Mutation::Put {
                    key: OverlayKey::FileSize(inode),
                    value: size.to_le_bytes().to_vec(),
                }),
        );
        self.commit_transaction(&mutations)?;
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
                bytes.as_slice().try_into().map_err(|_| Errno::EIO)?,
            )),
            Some(None) | None => Ok(base_size),
        }
    }

    fn visible_zero_from(&mut self, inode: u64) -> Result<Option<u64>, Errno> {
        match self.metadata_value(&OverlayKey::FileZeroFrom(inode))? {
            Some(Some(bytes)) => Ok(Some(u64::from_le_bytes(
                bytes.as_slice().try_into().map_err(|_| Errno::EIO)?,
            ))),
            Some(None) => Err(Errno::EIO),
            None => Ok(None),
        }
    }

    fn commit_transaction(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if mutations.is_empty() {
            return Ok(());
        }
        let following_sequence = self.next_sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let transaction = encode_transaction(self.next_sequence, mutations)?;
        let following_end = self
            .end
            .checked_add(transaction.len() as u64)
            .ok_or(Errno::EOVERFLOW)?;
        if let Err(error) = self
            .storage
            .write_all_at(self.end, &transaction)
            .and_then(|()| self.storage.flush())
        {
            self.failure = Some(error);
            return Err(error);
        }
        if self.track_committed_state {
            let records = decode_mutations(
                &transaction
                    [TRANSACTION_HEADER_BYTES..transaction.len() - TRANSACTION_TRAILER_BYTES],
            )?;
            for (mutation, relative_offset) in records {
                match mutation_key(&mutation) {
                    OverlayKey::FileBlock { inode, block } => {
                        self.block_cache
                            .retain(|(cached, _)| *cached != (*inode, *block));
                    }
                    OverlayKey::FileZeroFrom(inode) => {
                        let Mutation::Put { value, .. } = &mutation else {
                            return Err(Errno::EIO);
                        };
                        let from =
                            u64::from_le_bytes(value[..8].try_into().map_err(|_| Errno::EIO)?);
                        self.block_cache
                            .retain(|((owner, block), _)| *owner != *inode || *block < from);
                    }
                    _ => {}
                }
                let value_offset = relative_offset
                    .map(|offset| self.end + TRANSACTION_HEADER_BYTES as u64 + offset);
                self.state
                    .apply(mutation, value_offset, self.checkpoint.is_some());
            }
        } else if self.retain_compacted_metadata {
            for mutation in mutations {
                if !matches!(mutation_key(mutation), OverlayKey::FileBlock { .. }) {
                    self.state.apply(mutation.clone(), None, false);
                }
            }
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
        self.check_active_tail_limit()?;
        let end = offset + src.len() as u64;
        let grows = !fixed_size && end > self.visible_file_size(inode, base_size)?;
        if grows && !self.dirty_sizes.contains_key(&inode) && self.dirty_sizes.len() == CACHE_BLOCKS
        {
            self.flush_dirty()?;
        }
        let block_count =
            (end - 1) / FILE_BLOCK_BYTES as u64 - offset / FILE_BLOCK_BYTES as u64 + 1;
        let mut prepared = Vec::new();
        prepared
            .try_reserve_exact(block_count as usize)
            .map_err(|_| Errno::ENOMEM)?;
        let mut done = 0usize;
        while done < src.len() {
            let position = offset + done as u64;
            let block = position / FILE_BLOCK_BYTES as u64;
            let block_start = block * FILE_BLOCK_BYTES as u64;
            let within_block = position as usize % FILE_BLOCK_BYTES;
            let chunk = (src.len() - done).min(FILE_BLOCK_BYTES - within_block);
            let mut bytes = alloc::vec![0; FILE_BLOCK_BYTES];
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
            let count = (self.dirty_blocks.len() + new_blocks - CACHE_BLOCKS).max(CACHE_BLOCKS / 4);
            let victims: Vec<_> = self
                .dirty_blocks
                .iter()
                .filter(|(key, _)| !prepared.iter().any(|(prepared_key, _)| prepared_key == key))
                .take(count)
                .map(|(key, bytes)| (*key, bytes.clone()))
                .collect();
            if victims.len() < count {
                return Err(Errno::EIO);
            }
            let mut mutations: Vec<_> = victims
                .iter()
                .map(|(key, bytes)| Mutation::Put {
                    key: OverlayKey::FileBlock {
                        inode: key.0,
                        block: key.1,
                    },
                    value: bytes.clone(),
                })
                .collect();
            for (&owner, &size) in &self.dirty_sizes {
                if victims.iter().any(|(key, _)| key.0 == owner) {
                    mutations.push(Mutation::Put {
                        key: OverlayKey::FileSize(owner),
                        value: size.to_le_bytes().to_vec(),
                    });
                }
            }
            self.commit_transaction(&mutations)?;
            self.dirty_blocks
                .retain(|(key, _)| !victims.iter().any(|(victim, _)| victim == key));
            self.dirty_sizes
                .retain(|owner, _| !victims.iter().any(|(key, _)| key.0 == *owner));
        }
        for (key, bytes) in prepared {
            self.block_cache.retain(|(cached, _)| *cached != key);
            if let Some(index) = self
                .dirty_blocks
                .iter()
                .position(|(cached, _)| *cached == key)
            {
                self.dirty_blocks.remove(index);
            }
            self.dirty_blocks.push((key, bytes));
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
        let mut mutations = Vec::new();
        let mut done = 0usize;
        while done < src.len() {
            let position = offset.checked_add(done as u64).ok_or(Errno::EFBIG)?;
            let block = position / FILE_BLOCK_BYTES as u64;
            let block_start = block
                .checked_mul(FILE_BLOCK_BYTES as u64)
                .ok_or(Errno::EFBIG)?;
            let within_block = position as usize % FILE_BLOCK_BYTES;
            let chunk = (src.len() - done).min(FILE_BLOCK_BYTES - within_block);
            let mut bytes = alloc::vec![0; FILE_BLOCK_BYTES];
            if within_block != 0 || chunk != FILE_BLOCK_BYTES {
                self.read_file_at(inode, base_size, block_start, &mut bytes, &mut read_base)?;
            }
            bytes[within_block..within_block + chunk].copy_from_slice(&src[done..done + chunk]);
            mutations.push(Mutation::Put {
                key: OverlayKey::FileBlock { inode, block },
                value: bytes,
            });
            done += chunk;
        }
        if end > size {
            mutations.push(Mutation::Put {
                key: OverlayKey::FileSize(inode),
                value: end.to_le_bytes().to_vec(),
            });
        }
        self.commit(&mutations)?;
        Ok(src.len())
    }

    pub fn truncate_file_at<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        new_size: u64,
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
        let mut mutations = Vec::new();
        if new_size < old_size {
            let block = new_size / FILE_BLOCK_BYTES as u64;
            let remainder = (new_size % FILE_BLOCK_BYTES as u64) as usize;
            let clear_from = block + u64::from(remainder != 0);
            mutations.push(Mutation::Put {
                key: OverlayKey::FileZeroFrom(inode),
                value: clear_from.to_le_bytes().to_vec(),
            });
            if remainder != 0 {
                let mut bytes = alloc::vec![0; FILE_BLOCK_BYTES];
                self.read_file_at(
                    inode,
                    base_size,
                    block * FILE_BLOCK_BYTES as u64,
                    &mut bytes,
                    &mut read_base,
                )?;
                bytes[remainder..].fill(0);
                mutations.push(Mutation::Put {
                    key: OverlayKey::FileBlock { inode, block },
                    value: bytes,
                });
            }
        }
        mutations.push(Mutation::Put {
            key: OverlayKey::FileSize(inode),
            value: new_size.to_le_bytes().to_vec(),
        });
        self.commit(&mutations)
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
                self.dirty_blocks.push(cached);
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
        if let Some(error) = self.failure {
            return Err(error);
        }
        if inode == 0 {
            return Err(Errno::EINVAL);
        }
        let limit = size.div_ceil(FILE_BLOCK_BYTES as u64);
        let mut blocks = Vec::new();
        for (&(_, block), location) in self.state.blocks.range((inode, 0)..=(inode, u64::MAX)) {
            if block < limit && location.is_some() {
                blocks.push(u32::try_from(block).map_err(|_| Errno::EFBIG)?);
            }
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
                if entry.inode != inode {
                    break;
                }
                if entry.block < limit
                    && !entry.is_tombstone()
                    && !self.state.blocks.contains_key(&(inode, entry.block))
                    && self
                        .state
                        .invalid_checkpoint_from
                        .get(&inode)
                        .is_none_or(|from| entry.block < *from)
                {
                    blocks.push(u32::try_from(entry.block).map_err(|_| Errno::EFBIG)?);
                }
            }
        }
        for &((owner, block), _) in &self.dirty_blocks {
            if owner == inode && block < limit {
                blocks.push(u32::try_from(block).map_err(|_| Errno::EFBIG)?);
            }
        }
        blocks.sort_unstable();
        blocks.dedup();
        Ok(blocks)
    }

    pub fn composed_file_blocks(
        &mut self,
        inode: u64,
        base_size: u64,
        size: u64,
        base_blocks: &[u32],
    ) -> Result<Vec<u32>, Errno> {
        let mut blocks = self.allocated_file_blocks(inode, size)?;
        let base_limit = base_size.min(size).div_ceil(FILE_BLOCK_BYTES as u64);
        let zero_from = self.visible_zero_from(inode)?;
        let invalid_checkpoint_from = self.state.invalid_checkpoint_from.get(&inode).copied();
        let mut checkpoint_tombstones = Vec::new();
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
                if entry.inode != inode || entry.block >= base_limit {
                    break;
                }
                if entry.is_tombstone() {
                    checkpoint_tombstones
                        .push(u32::try_from(entry.block).map_err(|_| Errno::EFBIG)?);
                }
            }
        }
        for &block in base_blocks {
            if u64::from(block) >= base_limit {
                continue;
            }
            if zero_from.is_some_and(|from| u64::from(block) >= from) {
                continue;
            }
            if self.state.blocks.contains_key(&(inode, u64::from(block))) {
                continue;
            }
            if invalid_checkpoint_from.is_some_and(|from| u64::from(block) >= from) {
                continue;
            }
            if checkpoint_tombstones.binary_search(&block).is_err() {
                blocks.push(block);
            }
        }
        blocks.sort_unstable();
        blocks.dedup();
        Ok(blocks)
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
            self.block_cache.push(cached);
            return Ok(());
        }
        let mut block = alloc::vec![0; FILE_BLOCK_BYTES];
        self.storage.read_exact_at(location.offset, &mut block)?;
        if Sha256::digest(&block)[..] != location.digest {
            return Err(Errno::EIO);
        }
        target.copy_from_slice(&block[within_block..within_block + target.len()]);
        if self.block_cache.len() == CACHE_BLOCKS {
            self.block_cache.remove(0);
        }
        self.block_cache.push((key, block));
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
    buffer: Vec<u8>,
}

impl LegacyReadCursor {
    fn new() -> Result<Self, Errno> {
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)
            .map_err(|_| Errno::ENOMEM)?;
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
    let mut output = Vec::new();
    output.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)
        .map_err(|_| Errno::ENOMEM)?;
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
    let mut run = Vec::new();
    run.try_reserve_exact(LEGACY_SORT_RUN_RECORDS).map_err(|_| Errno::ENOMEM)?;
    let mut reader = LegacyReadCursor::new()?;
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
            let mut bytes = [0; LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize];
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
        let mut buffer = [0; 64 * 1024];
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
    batch: &mut Vec<Mutation>,
    reference: LegacyBlockReference,
) -> Result<(), Errno> {
    let mut value = alloc::vec![0; FILE_BLOCK_BYTES];
    source.read_exact_at(reference.offset, &mut value)?;
    if Sha256::digest(&value)[..] != reference.digest {
        return Err(Errno::EIO);
    }
    batch.push(Mutation::Put {
        key: OverlayKey::FileBlock { inode: reference.inode, block: reference.block },
        value,
    });
    if batch.len() == 128 {
        target.commit_transaction(batch)?;
        batch.clear();
    }
    Ok(())
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
    let mut record_buffer = Vec::new();
    record_buffer.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_SORT_RECORD_BYTES as usize)
        .map_err(|_| Errno::ENOMEM)?;
    let mut record_write_offset = 0u64;
    let mut record = |mutation: &Mutation, value_offset: Option<u64>| {
        let Mutation::Put { key: OverlayKey::FileBlock { inode, block }, value } = mutation else {
            return Err(Errno::EIO);
        };
        let reference = LegacyBlockReference {
            inode: *inode,
            block: *block,
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
    sort_legacy_block_references(&mut scratch, &mut target, count)?;
    let mut compacted = OverlayJournal::open(target, base_digest)?;
    compacted.track_committed_state = false;
    compacted.retain_compacted_metadata = false;
    let mut batch = Vec::new();
    batch.try_reserve_exact(128).map_err(|_| Errno::ENOMEM)?;
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
    compacted.commit_transaction(&batch)?;
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
            4 => OverlayKey::Dirent { parent: self.inode, name: self.name[..self.name_length as usize].to_vec() },
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
    buffer: Vec<u8>,
}

impl LegacyMutationCursor {
    fn new() -> Result<Self, Errno> {
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)
            .map_err(|_| Errno::ENOMEM)?;
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
    let mut output = Vec::new();
    output.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)
        .map_err(|_| Errno::ENOMEM)?;
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
    let mut run = Vec::new();
    run.try_reserve_exact(LEGACY_SORT_RUN_RECORDS).map_err(|_| Errno::ENOMEM)?;
    let mut reader = LegacyMutationCursor::new()?;
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
            let mut bytes = [0; LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES];
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
        let mut buffer = [0; 64 * 1024];
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
    source.read_exact_at(reference.offset, &mut value)?;
    if Sha256::digest(&value)[..] != reference.digest {
        return Err(Errno::EIO);
    }
    Ok(Some(value))
}

fn emit_legacy_mutation<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut OverlayJournal<T>,
    batch: &mut Vec<Mutation>,
    reference: LegacyMutationReference,
) -> Result<(), Errno> {
    let key = reference.key()?;
    let mutation = match read_legacy_mutation_value(source, reference)? {
        Some(value) => Mutation::Put { key, value },
        None => Mutation::Delete { key },
    };
    validate_mutation(&mutation).map_err(|_| Errno::EIO)?;
    batch.push(mutation);
    if batch.len() == 128 {
        target.commit_transaction(batch)?;
        batch.clear();
    }
    Ok(())
}

fn emit_legacy_zero<T: OverlayStorage>(
    target: &mut OverlayJournal<T>,
    batch: &mut Vec<Mutation>,
    zero: (u64, u64),
) -> Result<(), Errno> {
    batch.push(Mutation::Put {
        key: OverlayKey::FileZeroFrom(zero.0),
        value: zero.1.to_le_bytes().to_vec(),
    });
    if batch.len() == 128 {
        target.commit_transaction(batch)?;
        batch.clear();
    }
    Ok(())
}

fn emit_legacy_pending<S: OverlayStorage, T: OverlayStorage>(
    source: &mut S,
    target: &mut OverlayJournal<T>,
    batch: &mut Vec<Mutation>,
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
    let mut record_buffer = Vec::new();
    record_buffer.try_reserve_exact(LEGACY_SORT_IO_RECORDS * LEGACY_MUTATION_RECORD_BYTES)
        .map_err(|_| Errno::ENOMEM)?;
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
    let mut record = |mutation: &Mutation, value_offset: Option<u64>| -> Result<(), Errno> {
        let key = mutation_key(mutation);
        let (kind, inode, block, name) = match key {
            OverlayKey::Inode(inode) => (0, *inode, 0, &[][..]),
            OverlayKey::FileSize(inode) => (1, *inode, 0, &[][..]),
            OverlayKey::FileZeroFrom(inode) => (2, *inode, 0, &[][..]),
            OverlayKey::FileBlock { inode, block } => (3, *inode, *block, &[][..]),
            OverlayKey::Dirent { parent, name } => (4, *parent, 0, name.as_slice()),
        };
        let (offset, value_length, digest, deleted) = match mutation {
            Mutation::Put { value, .. } => (
                value_offset.ok_or(Errno::EIO)?,
                u32::try_from(value.len()).map_err(|_| Errno::EIO)?,
                Sha256::digest(value).into(),
                false,
            ),
            Mutation::Delete { .. } => (0, 0, [0; 32], true),
        };
        let mut name_bytes = [0; 255];
        name_bytes[..name.len()].copy_from_slice(name);
        let reference = LegacyMutationReference {
            kind, inode, block, marker: u8::from(kind == 3), name: name_bytes,
            name_length: name.len() as u8, order, offset, value_length, digest, deleted,
        };
        push_reference(reference)?;
        if let Mutation::Put { value, .. } = mutation {
            if kind == 2 {
                let from = u64::from_le_bytes(value.as_slice().try_into().map_err(|_| Errno::EIO)?);
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
    sort_legacy_mutations(&mut scratch, &mut target, count)?;
    let mut compacted = OverlayJournal::open(target, base_digest)?;
    compacted.track_committed_state = false;
    compacted.retain_compacted_metadata = false;
    let mut batch = Vec::new();
    batch.try_reserve_exact(128).map_err(|_| Errno::ENOMEM)?;
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
                let value = read_legacy_mutation_value(source, reference)?.ok_or(Errno::EIO)?;
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
    compacted.commit_transaction(&batch)?;
    scratch.truncate(0)?;
    scratch.flush()?;
    let checkpoint = compacted.checkpoint_blocks_with_metadata_into(scratch)?;
    Ok((compacted.into_storage(), checkpoint.into_storage()))
}

struct CompactedBlockEntries<'a, S: OverlayStorage> {
    storage: &'a mut S,
    end: u64,
    position: u64,
    sequence: u64,
    expected_sequence: u64,
    allow_metadata: bool,
    finished: bool,
    pending: Vec<BlockCheckpointEntry>,
    pending_position: usize,
}

impl<'a, S: OverlayStorage> CompactedBlockEntries<'a, S> {
    fn new(storage: &'a mut S, end: u64, expected_sequence: u64, allow_metadata: bool) -> Self {
        Self {
            storage,
            end,
            position: HEADER_BYTES as u64,
            sequence: 1,
            expected_sequence,
            allow_metadata,
            finished: false,
            pending: Vec::new(),
            pending_position: 0,
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
        let mut bytes = alloc::vec![0; length];
        self.storage.read_exact_at(self.position, &mut bytes)?;
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
        self.pending.clear();
        self.pending_position = 0;
        for (mutation, relative_offset) in mutations {
            let (inode, block, offset, digest) = match mutation {
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode, block },
                    value,
                } => (
                    inode,
                    block,
                    self.position
                        + TRANSACTION_HEADER_BYTES as u64
                        + relative_offset.ok_or(Errno::EIO)?,
                    Sha256::digest(value).into(),
                ),
                Mutation::Delete {
                    key: OverlayKey::FileBlock { inode, block },
                } if self.allow_metadata => (inode, block, 0, [0; 32]),
                mutation
                    if self.allow_metadata
                        && !matches!(mutation_key(&mutation), OverlayKey::FileBlock { .. }) =>
                {
                    continue;
                }
                _ => return Err(Errno::EIO),
            };
            self.pending.push(BlockCheckpointEntry {
                inode,
                block,
                offset,
                digest,
            });
        }
        self.position = self
            .position
            .checked_add(length as u64)
            .ok_or(Errno::EOVERFLOW)?;
        self.sequence = self.sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }
}

impl<S: OverlayStorage> Iterator for CompactedBlockEntries<'_, S> {
    type Item = Result<BlockCheckpointEntry, Errno>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            if let Some(entry) = self.pending.get(self.pending_position).copied() {
                self.pending_position += 1;
                return Some(Ok(entry));
            }
            if self.position == self.end {
                self.finished = true;
                return (self.sequence != self.expected_sequence).then_some(Err(Errno::EIO));
            }
            if let Err(error) = self.read_transaction() {
                self.finished = true;
                return Some(Err(error));
            }
        }
    }
}

struct CompactedMetadataEntries<'a, S: OverlayStorage> {
    storage: &'a mut S,
    end: u64,
    position: u64,
    sequence: u64,
    expected_sequence: u64,
    finished: bool,
    pending: Vec<MetadataCheckpointEntry>,
    pending_position: usize,
}

impl<'a, S: OverlayStorage> CompactedMetadataEntries<'a, S> {
    fn new(storage: &'a mut S, end: u64, expected_sequence: u64) -> Self {
        Self {
            storage,
            end,
            position: HEADER_BYTES as u64,
            sequence: 1,
            expected_sequence,
            finished: false,
            pending: Vec::new(),
            pending_position: 0,
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
        let mut bytes = alloc::vec![0; length];
        self.storage.read_exact_at(self.position, &mut bytes)?;
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
        self.pending.clear();
        self.pending_position = 0;
        for (mutation, relative_offset) in mutations {
            if matches!(mutation_key(&mutation), OverlayKey::FileBlock { .. }) {
                continue;
            }
            let value = match &mutation {
                Mutation::Put { value, .. } => Some((
                    self.position
                        .checked_add(TRANSACTION_HEADER_BYTES as u64)
                        .and_then(|offset| offset.checked_add(relative_offset?))
                        .ok_or(Errno::EIO)?,
                    u32::try_from(value.len()).map_err(|_| Errno::EIO)?,
                )),
                Mutation::Delete { .. } => None,
            };
            self.pending.push(MetadataCheckpointEntry {
                key: mutation_key(&mutation).clone(),
                value,
                value_digest: match &mutation {
                    Mutation::Put { value, .. } => Some(Sha256::digest(value).into()),
                    Mutation::Delete { .. } => None,
                },
            });
        }
        self.position = self
            .position
            .checked_add(length as u64)
            .ok_or(Errno::EOVERFLOW)?;
        self.sequence = self.sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    }
}

impl<S: OverlayStorage> Iterator for CompactedMetadataEntries<'_, S> {
    type Item = Result<MetadataCheckpointEntry, Errno>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            if let Some(entry) = self.pending.get(self.pending_position).cloned() {
                self.pending_position += 1;
                return Some(Ok(entry));
            }
            if self.position == self.end {
                self.finished = true;
                return (self.sequence != self.expected_sequence).then_some(Err(Errno::EIO));
            }
            if let Err(error) = self.read_transaction() {
                self.finished = true;
                return Some(Err(error));
            }
        }
    }
}

fn validate_key(key: &OverlayKey) -> Result<(), Errno> {
    match key {
        OverlayKey::Inode(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileSize(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileZeroFrom(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileBlock { inode, .. } if *inode != 0 => Ok(()),
        OverlayKey::Dirent { parent, name }
            if *parent != 0
                && !name.is_empty()
                && name.len() <= 255
                && name != b"."
                && name != b".."
                && !name.iter().any(|byte| *byte == 0 || *byte == b'/') =>
        {
            Ok(())
        }
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

fn encode_key(out: &mut Vec<u8>, key: &OverlayKey) {
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
    mut record_check: Option<&mut dyn FnMut(&Mutation, Option<u64>) -> Result<(), Errno>>,
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
        let mut transaction = Vec::new();
        transaction
            .try_reserve_exact(length)
            .map_err(|_| Errno::ENOMEM)?;
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
        for (mutation, relative_offset) in mutations {
            let is_block = matches!(mutation_key(&mutation), OverlayKey::FileBlock { .. });
            if matches!(filter, ReplayFilter::RejectMetadata) && !is_block {
                return Err(Errno::EIO);
            }
            if !matches!(filter, ReplayFilter::All) && is_block && record_check.is_none() {
                continue;
            }
            let value_offset = relative_offset
                .map(|offset| {
                    end.checked_add(TRANSACTION_HEADER_BYTES as u64)
                        .and_then(|start| start.checked_add(offset))
                        .ok_or(Errno::EIO)
                })
                .transpose()?;
            if let Some(check) = record_check.as_mut() {
                check(&mutation, value_offset)?;
            }
            if matches!(filter, ReplayFilter::VerifyOnly)
                || (!matches!(filter, ReplayFilter::All) && is_block)
            {
                continue;
            }
            state.apply(mutation, value_offset, has_checkpoint);
        }
        if let Some(digest) = &mut prefix_digest {
            digest.update(&transaction);
        }
        next_sequence = next_sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        end = end.checked_add(length as u64).ok_or(Errno::EOVERFLOW)?;
    }
    Ok((end, next_sequence))
}

fn encode_transaction(sequence: u64, mutations: &[Mutation]) -> Result<Vec<u8>, Errno> {
    let count = u32::try_from(mutations.len()).map_err(|_| Errno::EFBIG)?;
    let mut out = Vec::new();
    out.extend_from_slice(TRANSACTION_MAGIC);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for mutation in mutations {
        validate_mutation(mutation)?;
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
        if out.len() + TRANSACTION_TRAILER_BYTES > MAX_TRANSACTION_BYTES {
            return Err(Errno::EFBIG);
        }
    }
    let length = out.len() + TRANSACTION_TRAILER_BYTES;
    out[4..8].copy_from_slice(&(length as u32).to_le_bytes());
    out[20..24].copy_from_slice(&(!(length as u32)).to_le_bytes());
    let digest = Sha256::digest(&out);
    out.extend_from_slice(&digest);
    out.extend_from_slice(COMMIT_MAGIC);
    Ok(out)
}

fn mutation_key(mutation: &Mutation) -> &OverlayKey {
    match mutation {
        Mutation::Put { key, .. } | Mutation::Delete { key } => key,
    }
}

fn decode_mutations(mut bytes: &[u8]) -> Result<Vec<(Mutation, Option<u64>)>, Errno> {
    let mut mutations = Vec::new();
    let mut consumed = 0u64;
    while !bytes.is_empty() {
        if bytes.len() < 23 {
            return Err(Errno::EIO);
        }
        let operation = bytes[0];
        let kind = bytes[1];
        let inode = u64::from_le_bytes(bytes[2..10].try_into().map_err(|_| Errno::EIO)?);
        let block = u64::from_le_bytes(bytes[10..18].try_into().map_err(|_| Errno::EIO)?);
        let name_length = bytes[18] as usize;
        bytes = &bytes[19..];
        consumed += 19;
        if bytes.len() < name_length + 4 {
            return Err(Errno::EIO);
        }
        let name = bytes[..name_length].to_vec();
        bytes = &bytes[name_length..];
        consumed += name_length as u64;
        let value_length =
            u32::from_le_bytes(bytes[..4].try_into().map_err(|_| Errno::EIO)?) as usize;
        bytes = &bytes[4..];
        consumed += 4;
        if bytes.len() < value_length {
            return Err(Errno::EIO);
        }
        let key = match kind {
            1 if block == 0 && name_length == 0 => OverlayKey::Inode(inode),
            4 if block == 0 && name_length == 0 => OverlayKey::FileSize(inode),
            5 if block == 0 && name_length == 0 => OverlayKey::FileZeroFrom(inode),
            2 if name_length == 0 => OverlayKey::FileBlock { inode, block },
            3 if block == 0 => OverlayKey::Dirent {
                parent: inode,
                name,
            },
            _ => return Err(Errno::EIO),
        };
        let mutation = match operation {
            1 => Mutation::Put {
                key,
                value: bytes[..value_length].to_vec(),
            },
            2 if value_length == 0 => Mutation::Delete { key },
            _ => return Err(Errno::EIO),
        };
        validate_mutation(&mutation).map_err(|_| Errno::EIO)?;
        let value_offset = if matches!(mutation, Mutation::Put { .. }) {
            Some(consumed)
        } else {
            None
        };
        mutations.push((mutation, value_offset));
        bytes = &bytes[value_length..];
        consumed += value_length as u64;
    }
    Ok(mutations)
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
        fail_errno: Option<Errno>,
        fail_after_flushes: Option<usize>,
        fail_write_after_bytes: Option<usize>,
        read_bytes: Option<Arc<AtomicU64>>,
    }

    impl OverlayStorage for MemoryStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            Ok(self.bytes.len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
            dst.copy_from_slice(self.bytes.get(start..end).ok_or(Errno::EIO)?);
            if let Some(read_bytes) = &self.read_bytes {
                read_bytes.fetch_add(dst.len() as u64, Ordering::Relaxed);
            }
            Ok(())
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
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
            if self.fail_flush || self.fail_after_flushes == Some(self.flushes) {
                return Err(self.fail_errno.unwrap_or(Errno::EIO));
            }
            self.flushes += 1;
            Ok(())
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            self.bytes
                .truncate(usize::try_from(len).map_err(|_| Errno::EIO)?);
            Ok(())
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
        assert_eq!(reopened.metadata_value(&OverlayKey::Inode(7)).unwrap(), Some(Some(b"final".to_vec())));
        assert_eq!(reopened.metadata_value(&OverlayKey::Dirent { parent: 1, name: b"old".to_vec() }).unwrap(), Some(None));
        assert_eq!(reopened.metadata_value(&OverlayKey::Dirent { parent: 1, name: b"new".to_vec() }).unwrap(), Some(Some(7u64.to_le_bytes().to_vec())));
        assert_eq!(reopened.metadata_value(&OverlayKey::FileZeroFrom(7)).unwrap(), Some(Some(1u64.to_le_bytes().to_vec())));
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
    fn indexed_recovery_rejects_corrupt_prefix_or_tail_and_truncates_torn_append() {
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
                bytes: torn,
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
        assert_eq!(recovered.storage.bytes, durable);
        let mut byte = [0];
        assert_eq!(
            recovered.read_file_at(7, FILE_BLOCK_BYTES as u64, 0, &mut byte, |_, _| {
                panic!("checkpoint must satisfy read")
            }),
            Ok(1)
        );
        assert_eq!(byte, [b'a']);
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
            Ok(Some(Some(b"metadata".to_vec())))
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
            Some(Some(b"metadata".to_vec()))
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
                Ok(Some(Some(7u64.to_le_bytes().to_vec())))
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
        assert_eq!(reopened.metadata_value(&inode_key()), Ok(Some(Some(b"metadata".to_vec()))));
    }

    #[test]
    fn indexed_boot_reads_legacy_v3_metadata_checkpoint() {
        let base_digest = [57; 32];
        let mut source = OverlayJournal::open(MemoryStorage::default(), base_digest).unwrap();
        source
            .commit(&[Mutation::Put {
                key: inode_key(),
                value: b"metadata".to_vec(),
            }])
            .unwrap();
        let mut compacted = source.compact_metadata_into(MemoryStorage::default()).unwrap();
        let end = compacted.end;
        let checkpoint = compacted
            .checkpoint_blocks_with_metadata_into(MemoryStorage::default())
            .unwrap();
        let mut index_bytes = checkpoint.into_storage().bytes;
        index_bytes.truncate(160 + 280);
        index_bytes[4..8].copy_from_slice(&3u32.to_le_bytes());
        let mut combined = Sha256::new();
        combined.update(Sha256::digest([]));
        combined.update(Sha256::digest(&index_bytes[160..]));
        index_bytes[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&index_bytes[..128]);
        index_bytes[128..160].copy_from_slice(&header_digest);
        let mut reopened = OverlayJournal::open_with_checkpoint_metadata(
            compacted.into_storage(),
            MemoryStorage {
                bytes: index_bytes,
                ..MemoryStorage::default()
            },
            base_digest,
            end,
        )
        .unwrap();
        assert_eq!(reopened.metadata_value(&inode_key()), Ok(Some(Some(b"metadata".to_vec()))));
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
            Ok(Some(Some(b"file metadata".to_vec())))
        );
        assert_eq!(recovered.metadata_value(&directory_key(b"old")), Ok(Some(None)));
        assert_eq!(
            recovered.metadata_value(&directory_key(b"new")),
            Ok(Some(Some(7u64.to_le_bytes().to_vec())))
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
            Ok(Some(Some(7u64.to_le_bytes().to_vec())))
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
                    bytes: torn,
                    ..MemoryStorage::default()
                },
                digest,
            )
            .unwrap();
            assert_eq!(recovered.storage.bytes, durable);
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
            let recovered = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(
                recovered.state().lookup(&inode_key()),
                Some(Some(expected)),
                "cut {cut}"
            );
            storage = recovered.into_storage();
            assert_eq!(
                storage.bytes.len(),
                if cut == complete.bytes.len() {
                    cut
                } else {
                    old_end
                }
            );
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
            let mut recovered = OverlayJournal::open(storage, digest).unwrap();
            assert_eq!(recovered.storage.bytes, durable, "cut {cut}");
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
