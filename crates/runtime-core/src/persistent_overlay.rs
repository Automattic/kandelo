//! Experimental append-only journal for a writable overlay on one immutable image.
//!
//! The base image is identified by its SHA-256 digest. A transaction contains
//! inode, file-size, file-block, or directory-entry replacements and one trailing commit
//! marker. Recovery publishes only complete, checksummed transactions. The
//! kernel's POSIX namespace remains the authority. The experimental fixed-size
//! overwrite mode mounts only file-block changes; general namespace replay is
//! not yet supported.
//! Storage implementations must provide exclusive single-writer access,
//! exact positioned I/O, and a flush that makes prior writes durable.

use crate::persistent_overlay_index::{BlockCheckpoint, BlockCheckpointEntry};
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
const ACTIVE_TAIL_LIMIT_BYTES: u64 = 63 * 1024 * 1024;

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

    fn apply(&mut self, mutation: Mutation, value_offset: Option<u64>) {
        match mutation {
            Mutation::Put { key, value } => {
                if let OverlayKey::FileBlock { inode, block } = key {
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
    failed: bool,
    block_cache: Vec<((u64, u64), Vec<u8>)>,
    dirty_blocks: Vec<((u64, u64), Vec<u8>)>,
    tail_limit_bytes: Option<u64>,
    track_committed_state: bool,
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
        checkpoint_storage: T,
        base_digest: [u8; 32],
        checkpoint_end: u64,
        replay_metadata: bool,
    ) -> Result<Self, Errno> {
        if checkpoint_end < HEADER_BYTES as u64 || storage.len()? < checkpoint_end {
            return Err(Errno::EIO);
        }
        let mut digest = Sha256::new();
        let mut bytes = [0; 64 * 1024];
        let mut offset = 0;
        while offset < checkpoint_end {
            let length = (checkpoint_end - offset).min(bytes.len() as u64) as usize;
            storage.read_exact_at(offset, &mut bytes[..length])?;
            digest.update(&bytes[..length]);
            offset += length as u64;
        }
        let checkpoint_storage: Box<dyn OverlayStorage + Send> = Box::new(checkpoint_storage);
        let checkpoint = BlockCheckpoint::open(
            checkpoint_storage,
            base_digest,
            digest.finalize().into(),
            checkpoint_end,
        )?;
        let mut state = OverlayState::default();
        if replay_metadata {
            let (replayed_end, next_sequence) = replay_transactions(
                &mut storage,
                HEADER_BYTES as u64,
                checkpoint_end,
                1,
                &mut state,
                false,
                false,
            )?;
            if replayed_end != checkpoint_end || next_sequence != checkpoint.next_sequence() {
                return Err(Errno::EIO);
            }
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
            let mut header = [0u8; HEADER_BYTES];
            storage.read_exact_at(0, &mut header)?;
            if &header[..4] != MAGIC
                || u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) != VERSION
                || header[8..40] != base_digest
                || header[40..] != Sha256::digest(&header[..40])[..]
            {
                return Err(Errno::EIO);
            }
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
            true,
            true,
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
            failed: false,
            block_cache: Vec::new(),
            dirty_blocks: Vec::new(),
            tail_limit_bytes: None,
            track_committed_state: true,
        })
    }

    pub fn limit_active_tail(&mut self) {
        self.tail_limit_bytes = Some(ACTIVE_TAIL_LIMIT_BYTES);
    }

    pub fn state(&self) -> &OverlayState {
        &self.state
    }

    pub fn compaction_revision(&self) -> (u64, u64) {
        (self.end, self.next_sequence)
    }

    pub fn can_activate_compaction(&self, revision: (u64, u64)) -> bool {
        !self.failed && self.dirty_blocks.is_empty() && self.compaction_revision() == revision
    }

    pub fn validate_fixed_image_blocks<F>(&mut self, mut base_size: F) -> Result<(), Errno>
    where
        F: FnMut(u64) -> Option<u64>,
    {
        self.state.validate_fixed_image_blocks(&mut base_size)?;
        if let Some(checkpoint) = self.checkpoint.as_mut() {
            for index in 0..checkpoint.count() {
                let entry = checkpoint.entry_at(index)?.ok_or(Errno::EIO)?;
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
        if (!allow_metadata && !self.state.entries.is_empty())
            || self.state.blocks.values().any(Option::is_none)
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
        if self.track_committed_state {
            let records = self
                .state
                .blocks
                .iter()
                .filter_map(|(&(inode, block), location)| {
                    location.map(|location| BlockCheckpointEntry {
                        inode,
                        block,
                        offset: location.offset,
                        digest: location.digest,
                    })
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
            BlockCheckpoint::create_checked(
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
        }
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

    pub fn compact_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.compact_into_internal(target, true)
    }

    pub fn compact_fixed_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        if !self.state.entries.is_empty() || self.state.blocks.values().any(Option::is_none) {
            return Err(Errno::EIO);
        }
        self.compact_into_internal(target, false)
    }

    pub fn compact_metadata_into<T: OverlayStorage>(
        &mut self,
        target: T,
    ) -> Result<OverlayJournal<T>, Errno> {
        if self.state.blocks.values().any(Option::is_none) {
            return Err(Errno::EOPNOTSUPP);
        }
        self.compact_into_internal(target, false)
    }

    fn compact_into_internal<T: OverlayStorage>(
        &mut self,
        mut target: T,
        track_committed_state: bool,
    ) -> Result<OverlayJournal<T>, Errno> {
        self.sync()?;
        if target.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        let mut compacted = OverlayJournal::open(target, self.base_digest)?;
        compacted.track_committed_state = track_committed_state;
        let mut batch = Vec::new();
        batch.try_reserve_exact(128).map_err(|_| Errno::ENOMEM)?;
        for (key, value) in &self.state.entries {
            let mutation = match value {
                Some(bytes) => Mutation::Put {
                    key: key.clone(),
                    value: bytes.clone(),
                },
                None => Mutation::Delete { key: key.clone() },
            };
            batch.push(mutation);
            if batch.len() == 128 {
                compacted.commit_transaction(&batch)?;
                batch.clear();
            }
        }
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
                    Some(BlockLocation {
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
            let key = OverlayKey::FileBlock { inode, block };
            let mutation = match location {
                Some(location) => {
                    let mut bytes = alloc::vec![0; FILE_BLOCK_BYTES];
                    self.storage.read_exact_at(location.offset, &mut bytes)?;
                    if Sha256::digest(&bytes)[..] != location.digest {
                        return Err(Errno::EIO);
                    }
                    Mutation::Put { key, value: bytes }
                }
                None => Mutation::Delete { key },
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
        if self.failed {
            return Err(Errno::EIO);
        }
        if self.dirty_blocks.is_empty() {
            self.storage.flush()
        } else {
            self.flush_dirty()
        }
    }

    pub fn commit(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        self.flush_dirty()?;
        self.commit_transaction(mutations)
    }

    fn flush_dirty(&mut self) -> Result<(), Errno> {
        if self.dirty_blocks.is_empty() {
            return Ok(());
        }
        let mutations: Vec<_> = self
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
        self.commit_transaction(&mutations)?;
        self.dirty_blocks.clear();
        Ok(())
    }

    fn commit_transaction(&mut self, mutations: &[Mutation]) -> Result<(), Errno> {
        if self.failed {
            return Err(Errno::EIO);
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
            self.failed = true;
            return Err(error);
        }
        if self.track_committed_state {
            let records = decode_mutations(
                &transaction
                    [TRANSACTION_HEADER_BYTES..transaction.len() - TRANSACTION_TRAILER_BYTES],
            )?;
            for (mutation, relative_offset) in records {
                if let OverlayKey::FileBlock { inode, block } = &mutation_key(&mutation) {
                    self.block_cache
                        .retain(|(cached, _)| *cached != (*inode, *block));
                }
                let value_offset = relative_offset
                    .map(|offset| self.end + TRANSACTION_HEADER_BYTES as u64 + offset);
                self.state.apply(mutation, value_offset);
            }
        } else {
            for mutation in mutations {
                if !matches!(mutation_key(mutation), OverlayKey::FileBlock { .. }) {
                    self.state.apply(mutation.clone(), None);
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
        mut read_base: F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        if self.failed {
            return Err(Errno::EIO);
        }
        if src.is_empty() {
            return Ok(0);
        }
        self.check_active_tail_limit()?;
        let end = offset.checked_add(src.len() as u64).ok_or(Errno::EFBIG)?;
        if end > base_size {
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
                match self.write_fixed_file_chunk(
                    inode,
                    base_size,
                    position,
                    &src[done..done + chunk],
                    &mut read_base,
                ) {
                    Ok(written) => done += written,
                    Err(_) if done > 0 => return Ok(done),
                    Err(error) => return Err(error),
                }
            }
            return Ok(done);
        }
        self.write_fixed_file_chunk(inode, base_size, offset, src, &mut read_base)
    }

    fn write_fixed_file_chunk<F>(
        &mut self,
        inode: u64,
        base_size: u64,
        offset: u64,
        src: &[u8],
        read_base: &mut F,
    ) -> Result<usize, Errno>
    where
        F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    {
        self.check_active_tail_limit()?;
        let end = offset + src.len() as u64;
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
            let mutations: Vec<_> = victims
                .iter()
                .map(|(key, bytes)| Mutation::Put {
                    key: OverlayKey::FileBlock {
                        inode: key.0,
                        block: key.1,
                    },
                    value: bytes.clone(),
                })
                .collect();
            self.commit_transaction(&mutations)?;
            self.dirty_blocks
                .retain(|(key, _)| !victims.iter().any(|(victim, _)| victim == key));
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
        if self.failed {
            return Err(Errno::EIO);
        }
        let size = self.state.file_size(inode, base_size)?;
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
        let size = self.state.file_size(inode, base_size)?;
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
                    let from_base = if position < base_size {
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

    fn block_location(
        &mut self,
        inode: u64,
        block: u64,
    ) -> Result<Option<Option<BlockLocation>>, Errno> {
        if let Some(location) = self.state.blocks.get(&(inode, block)) {
            return Ok(Some(*location));
        }
        match self.checkpoint.as_mut() {
            Some(checkpoint) => Ok(checkpoint.lookup(inode, block)?.map(|entry| {
                Some(BlockLocation {
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
            let (inode, block, value) = match mutation {
                Mutation::Put {
                    key: OverlayKey::FileBlock { inode, block },
                    value,
                } => (inode, block, value),
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
                offset: self.position
                    + TRANSACTION_HEADER_BYTES as u64
                    + relative_offset.ok_or(Errno::EIO)?,
                digest: Sha256::digest(value).into(),
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

fn validate_key(key: &OverlayKey) -> Result<(), Errno> {
    match key {
        OverlayKey::Inode(inode) if *inode != 0 => Ok(()),
        OverlayKey::FileSize(inode) if *inode != 0 => Ok(()),
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

fn replay_transactions<S: OverlayStorage>(
    storage: &mut S,
    mut end: u64,
    size: u64,
    mut next_sequence: u64,
    state: &mut OverlayState,
    include_blocks: bool,
    allow_torn_tail: bool,
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
            if include_blocks || !matches!(mutation_key(&mutation), OverlayKey::FileBlock { .. }) {
                let value_offset =
                    relative_offset.map(|offset| end + TRANSACTION_HEADER_BYTES as u64 + offset);
                state.apply(mutation, value_offset);
            }
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

    #[derive(Default)]
    struct MemoryStorage {
        bytes: Vec<u8>,
        flushes: usize,
        fail_flush: bool,
        fail_after_flushes: Option<usize>,
        fail_write_after_bytes: Option<usize>,
    }

    impl OverlayStorage for MemoryStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            Ok(self.bytes.len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
            dst.copy_from_slice(self.bytes.get(start..end).ok_or(Errno::EIO)?);
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
                return Err(Errno::EIO);
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
            recovered.state.lookup(&inode_key()),
            Some(Some(&b"file metadata"[..]))
        );
        assert_eq!(recovered.state.lookup(&directory_key(b"old")), Some(None));
        assert_eq!(
            recovered.state.lookup(&directory_key(b"new")),
            Some(Some(&7u64.to_le_bytes()[..]))
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
