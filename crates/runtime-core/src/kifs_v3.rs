//! Positioned storage for KIFS v3. Each complete transaction changes the live
//! tree of namespace records and authenticated file blocks. Publication flushes
//! its appended pages before updating both durable root replicas.
use crate::IoBuffer;
use crate::filesystem_tree::{
    EncodedKey, MAX_LEVEL, MAX_VALUE_BYTES, PAGE_BYTES, Page, PageBuilder, PageRef, decode_key,
};
use crate::positioned_storage::PositionedStorage;
mod block_hash;
mod coalescing;
use block_hash::for_each_digest;
use coalescing::{ChangeMap, Epoch};
mod page_cache;
pub(crate) mod stat_invalidation;
mod record_cache;
mod stream_cursor;
use page_cache::PageCache;
use record_cache::RecordCache;
use stream_cursor::StreamCursor;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

pub use crate::filesystem_tree::NamespaceKey as Key;

mod namespace;
pub use namespace::{
    DEFERRED_FILE, IMAGE_METADATA, InodeRecord, KifsNamespace, ROOT_INODE, SYMLINK_TARGET,
    Timestamp,
};

pub const BLOCK_BYTES: usize = 4096;
pub const DEFAULT_VOLUME_BLOCKS: u64 = 1024 * 1024 * 1024 / BLOCK_BYTES as u64;
const STORAGE_START: u64 = 2 * BLOCK_BYTES as u64;
const BLOCK_UNITS: u64 = (BLOCK_BYTES / PAGE_BYTES) as u64;
const MAX_STORAGE_BYTES: u64 = (1 << 53) - 1;
const SUPERBLOCK_BYTES: usize = 168;
const CHECKSUM_START: usize = 136;
const MAGIC: &[u8; 4] = b"KIFS";
pub(crate) const VERSION: u32 = 3;

fn metadata_cache_budget() -> usize {
    (crate::io_buffer::IO_MEMORY.usage().1 / 64).min(crate::positioned_storage::READ_CACHE_MAX_BYTES)
}

fn record_cache_budget() -> usize {
    (metadata_cache_budget() / 4).min(8 * 1024)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Usage {
    pub capacity_blocks: u64,
    pub data_blocks: u64,
    pub metadata_bytes: u64,
}

impl Usage {
    fn remove_record(&mut self, key: &[u8], length: usize, block: bool) -> Result<(), Errno> {
        self.metadata_bytes = self
            .metadata_bytes
            .checked_sub(record_bytes(key, length))
            .ok_or(Errno::EIO)?;
        self.data_blocks = self
            .data_blocks
            .checked_sub(u64::from(block))
            .ok_or(Errno::EIO)?;
        Ok(())
    }

    pub fn allocated_blocks(self) -> u64 {
        STORAGE_START / BLOCK_BYTES as u64
            + self.data_blocks
            + self.metadata_bytes.div_ceil(BLOCK_BYTES as u64)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Superblock {
    sequence: u64,
    end: u64,
    usage: Usage,
    next_inode: u64,
    root: PageRef,
    level: u8,
    identity: [u8; 32],
}

impl Superblock {
    fn encode(self) -> [u8; SUPERBLOCK_BYTES] {
        let mut bytes = [0; SUPERBLOCK_BYTES];
        bytes[..4].copy_from_slice(MAGIC);
        bytes[4..8].copy_from_slice(&VERSION.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.sequence.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.end.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.usage.capacity_blocks.to_le_bytes());
        bytes[32..40].copy_from_slice(&self.usage.metadata_bytes.to_le_bytes());
        bytes[40..48].copy_from_slice(&self.usage.data_blocks.to_le_bytes());
        bytes[48..56].copy_from_slice(&self.next_inode.to_le_bytes());
        bytes[56..64].copy_from_slice(&self.root.number.to_le_bytes());
        bytes[64..96].copy_from_slice(&self.root.digest);
        bytes[96..128].copy_from_slice(&self.identity);
        bytes[128] = self.level;
        let checksum = Sha256::digest(&bytes[..CHECKSUM_START]);
        bytes[CHECKSUM_START..].copy_from_slice(&checksum);
        bytes
    }

    fn decode(bytes: &[u8; SUPERBLOCK_BYTES]) -> Result<Self, Errno> {
        if &bytes[..4] != MAGIC
            || bytes[4..8] != VERSION.to_le_bytes()
            || bytes[129..CHECKSUM_START] != [0; 7]
            || Sha256::digest(&bytes[..CHECKSUM_START])[..] != bytes[CHECKSUM_START..]
        {
            return Err(Errno::EIO);
        }
        let field = |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        let block = Self {
            sequence: field(8),
            end: field(16),
            usage: Usage {
                capacity_blocks: field(24),
                metadata_bytes: field(32),
                data_blocks: field(40),
            },
            next_inode: field(48),
            root: PageRef {
                number: field(56),
                digest: bytes[64..96].try_into().unwrap(),
            },
            level: bytes[128],
            identity: bytes[96..128].try_into().unwrap(),
        };
        if block.sequence == 0
            || block.root.number >= block.end
            || block.level > MAX_LEVEL
            || block.next_inode == 0
            || block.usage.capacity_blocks > MAX_STORAGE_BYTES / BLOCK_BYTES as u64
            || block.usage.data_blocks > block.usage.capacity_blocks
            || block.usage.allocated_blocks() > block.usage.capacity_blocks
        {
            return Err(Errno::EIO);
        }
        offset(block.end).map_err(|_| Errno::EIO)?;
        Ok(block)
    }
}

fn offset(unit: u64) -> Result<u64, Errno> {
    unit.checked_mul(PAGE_BYTES as u64)
        .and_then(|bytes| STORAGE_START.checked_add(bytes))
        .filter(|end| *end <= MAX_STORAGE_BYTES)
        .ok_or(Errno::EFBIG)
}

fn read_superblock(
    storage: &mut impl PositionedStorage,
    slot: u64,
) -> Result<Option<Superblock>, Errno> {
    let mut bytes = [0; SUPERBLOCK_BYTES];
    storage.read_exact_at(slot * BLOCK_BYTES as u64, &mut bytes)?;
    if &bytes[..4] == MAGIC && bytes[4..8] != VERSION.to_le_bytes() {
        return Err(Errno::EIO);
    }
    if Sha256::digest(&bytes[..CHECKSUM_START])[..] != bytes[CHECKSUM_START..] {
        return Ok(None);
    }
    Superblock::decode(&bytes).map(Some)
}

pub struct KifsVolume<S> {
    storage: S,
    cache: PageCache,
    records: RecordCache,
    stream_cursor: StreamCursor,
    // Reads use the latest complete transaction, including unsynced changes.
    live: Superblock,
    epoch: Epoch,
    published_end: u64,
    pending_operations: u16,
    group_commit: bool,
    revision: u64,
    stat_generations: stat_invalidation::Generations,
    first_write_slot: u64,
    publication_error: Option<Errno>,
    handoff_pending: bool,
}

impl<S: PositionedStorage> KifsVolume<S> {
    pub fn create(storage: S, capacity_blocks: u64, identity: [u8; 32]) -> Result<Self, Errno> {
        KifsVolumeBuilder::new(storage, capacity_blocks, identity)?.finish(1)
    }

    pub fn open(mut storage: S, identity: [u8; 32]) -> Result<Self, Errno> {
        let first = read_superblock(&mut storage, 0)?;
        let second = read_superblock(&mut storage, 1)?;
        let (committed, first_write_slot) = match (first, second) {
            (Some(first), Some(second)) => {
                if first.identity != second.identity
                    || first.usage.capacity_blocks != second.usage.capacity_blocks
                    || first.sequence.abs_diff(second.sequence) > 1
                    || (first.sequence == second.sequence && first != second)
                {
                    return Err(Errno::EIO);
                }
                match first.sequence.cmp(&second.sequence) {
                    core::cmp::Ordering::Greater => (first, 1),
                    core::cmp::Ordering::Less => (second, 0),
                    core::cmp::Ordering::Equal => (first, (first.sequence % 2) ^ 1),
                }
            }
            // Preserve the only valid copy until the new root is durable.
            (Some(block), None) => (block, 1),
            (None, Some(block)) => (block, 0),
            (None, None) => return Err(Errno::EIO),
        };
        if committed.identity != identity || offset(committed.end)? > storage.len()? {
            return Err(Errno::EIO);
        }
        let mut volume = Self {
            storage,
            cache: PageCache::new(),
            records: RecordCache::new(),
            stream_cursor: StreamCursor::default(),
            live: committed,
            epoch: Epoch::default(),
            published_end: committed.end,
            pending_operations: 0,
            group_commit: false,
            revision: 0,
            stat_generations: stat_invalidation::Generations::new(),
            first_write_slot,
            publication_error: None,
            handoff_pending: false,
        };
        let mut bytes = [0; PAGE_BYTES];
        let root = volume
            .tree()
            .read(committed.root, committed.level, &mut bytes, true)?;
        root.verify_records(committed.root, committed.level)?;
        Ok(volume)
    }

    pub fn usage(&self) -> Usage {
        self.live.usage
    }

    pub fn next_inode(&self) -> u64 {
        self.live.next_inode
    }

    pub fn publication_error(&self) -> Option<Errno> {
        self.publication_error
    }

    pub fn into_storage(self) -> S {
        self.storage
    }

    fn tree(&mut self) -> Tree<'_, S> {
        Tree {
            storage: &mut self.storage,
            cache: &mut self.cache,
            records: self.group_commit.then_some(&mut self.records),
            end: self.live.end,
            base_usage: self.epoch.base_usage.unwrap_or(self.live.usage),
            base_edits: self.epoch.enabled.then_some(&self.epoch.points),
            edits: ChangeMap::new(),
            scan: None,
            appends: None,
            try_append_window: false,
        }
    }

    pub fn lookup(&mut self, key: Key<'_>, output: &mut [u8]) -> Result<Option<usize>, Errno> {
        if matches!(key, Key::Block { .. }) {
            return Err(Errno::EINVAL);
        }
        let root = self.live;
        self.tree()
            .lookup_record(root, EncodedKey::new(key)?.bytes(), output)
    }

    pub fn read_block(
        &mut self,
        inode: u64,
        block: u64,
        output: &mut [u8; BLOCK_BYTES],
    ) -> Result<bool, Errno> {
        let root = self.live;
        self.tree().read_block(root, inode, block, output)
    }

    // Read aligned blocks in verified physical runs. Old volumes can have
    // interleaved index pages, and absent logical blocks still read as zeros.
    fn read_file_blocks(&mut self, inode: u64, first: u64, output: &mut [u8]) -> Result<(), Errno> {
        let count = output.len() / BLOCK_BYTES;
        debug_assert!(count > 0 && count <= BLOCK_BATCH && output.len() % BLOCK_BYTES == 0);
        let mut locations = [None; BLOCK_BATCH];
        let root = self.live;
        let revision = self.revision;
        let mut cursor = core::mem::take(&mut self.stream_cursor);
        let locations_found = cursor.collect(
            &mut self.tree(), root, revision, inode, first, &mut locations[..count],
        );
        self.stream_cursor = cursor;
        locations_found?;
        let mut i = 0;
        while i < count {
            let Some(start) = locations[i] else {
                output[i * BLOCK_BYTES..(i + 1) * BLOCK_BYTES].fill(0);
                i += 1;
                continue;
            };
            let mut end = i + 1;
            while end < count
                && locations[end]
                    .is_some_and(|r| r.number == start.number + (end - i) as u64 * BLOCK_UNITS)
            {
                end += 1;
            }
            let run = &mut output[i * BLOCK_BYTES..end * BLOCK_BYTES];
            self.storage.read_exact_at(offset(start.number)?, run)?;
            for_each_digest(run, |slot, digest| {
                if digest != locations[i + slot].ok_or(Errno::EIO)?.digest {
                    return Err(Errno::EIO);
                }
                Ok(())
            })?;
            i = end;
        }
        Ok(())
    }

    pub fn for_directory(
        &mut self,
        parent: u64,
        after: Option<&[u8]>,
        mut visit: impl FnMut(&[u8], &[u8]) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        self.visit_directory(parent, after, |name, value| {
            visit(name, value)?;
            Ok(true)
        })
    }

    pub fn next_in_directory(
        &mut self,
        parent: u64,
        after: Option<&[u8]>,
        output: &mut [u8],
    ) -> Result<Option<(usize, u64)>, Errno> {
        let mut found = None;
        self.visit_directory(parent, after, |name, value| {
            let number = u64::from_le_bytes(value.try_into().map_err(|_| Errno::EIO)?);
            if number == 0 {
                return Err(Errno::EIO);
            }
            output
                .get_mut(..name.len())
                .ok_or(Errno::ERANGE)?
                .copy_from_slice(name);
            found = Some((name.len(), number));
            Ok(false)
        })?;
        Ok(found)
    }

    fn visit_directory(
        &mut self,
        parent: u64,
        after: Option<&[u8]>,
        visit: impl FnMut(&[u8], &[u8]) -> Result<bool, Errno>,
    ) -> Result<(), Errno> {
        let root = self.live;
        self.tree()
            .visit_directory(root, parent, after, visit)
            .map(|_| ())
    }

    /// Verify all referenced metadata and content from storage and recompute
    /// the allocation counters. The mount layer also checks inode semantics.
    pub fn verify(&mut self) -> Result<(), Errno> {
        self.verified_record_count().map(|_| ())
    }

    pub(crate) fn verified_record_count(&mut self) -> Result<u64, Errno> {
        let root = self.live;
        let mut records = 0u64;
        let mut found = Usage {
            capacity_blocks: root.usage.capacity_blocks,
            data_blocks: 0,
            metadata_bytes: 0,
        };
        let mut last: Option<EncodedKey> = None;
        let mut data = IoBuffer::try_filled(BLOCK_BYTES, 0)?;
        self.scan()?.visit(
            root.root,
            root.level,
            None,
            Bounds::ALL,
            &mut |storage, leaf, key, value| {
                if last
                    .as_ref()
                    .is_some_and(|previous| previous.bytes() >= key)
                {
                    return Err(Errno::EIO);
                }
                last = Some(EncodedKey::from_bytes(key));
                match decode_key(key)? {
                    Key::Inode(inode) if inode >= root.next_inode => return Err(Errno::EIO),
                    Key::Block { .. } => {
                        let location = PageRef::decode(value, leaf)?;
                        read_block_at(storage, None, location, leaf, &mut data)?;
                        found.data_blocks += 1;
                    }
                    _ => {}
                }
                records += 1;
                found.metadata_bytes += record_bytes(key, value.len());
                Ok(true)
            },
        )?;
        if found != root.usage {
            return Err(Errno::EIO);
        }
        Ok(records)
    }

    /// Stream reachable records into an empty target and authenticate the
    /// result from storage. Publication belongs to the generation owner.
    pub fn compact_into<T: PositionedStorage>(
        &mut self,
        target: T,
    ) -> Result<KifsVolume<T>, Errno> {
        self.compact_into_as(target, self.live.identity)
    }

    fn compact_into_as<T: PositionedStorage>(
        &mut self,
        target: T,
        identity: [u8; 32],
    ) -> Result<KifsVolume<T>, Errno> {
        if let Some(error) = self.publication_error {
            return Err(error);
        }
        self.publish_pending()?;
        let root = self.live;
        let mut builder = KifsVolumeBuilder::new(target, root.usage.capacity_blocks, identity)?;
        let mut data = IoBuffer::try_filled(BLOCK_BYTES, 0)?;
        self.scan()?.visit(
            root.root,
            root.level,
            None,
            Bounds::ALL,
            &mut |storage, leaf, key, value| {
                match decode_key(key)? {
                    Key::Block { inode, block } => {
                        let location = PageRef::decode(value, leaf)?;
                        read_block_at(storage, None, location, leaf, &mut data)?;
                        builder.push_block(inode, block, (&*data).try_into().unwrap())?;
                    }
                    key => builder.push_metadata(key, value)?,
                }
                Ok(true)
            },
        )?;
        if builder.usage != root.usage {
            return Err(Errno::EIO);
        }
        let mut candidate = builder.finish(root.next_inode)?;
        candidate.verify()?;
        Ok(candidate)
    }

    fn scan(&mut self) -> Result<Tree<'_, S>, Errno> {
        let mut tree = self.tree();
        tree.scan = Some(ScanWindow {
            bytes: IoBuffer::try_filled(BLOCK_BYTES, 0)?,
            start: None,
        });
        Ok(tree)
    }

    /// Publish an atomic mutation batch. Payload writes can fail without
    /// changing the published root. An uncertain root write poisons this
    /// handle and must be resolved by reopening the volume.
    pub fn transaction<R>(
        &mut self,
        apply: impl FnOnce(&mut Transaction<'_, S>) -> Result<R, Errno>,
    ) -> Result<R, Errno> {
        let result = self.apply_transaction(apply);
        if result.is_err() {
            self.records.clear();
        }
        result
    }

    fn apply_transaction<R>(
        &mut self,
        apply: impl FnOnce(&mut Transaction<'_, S>) -> Result<R, Errno>,
    ) -> Result<R, Errno> {
        if let Some(error) = self.publication_error {
            return Err(error);
        }
        if self.handoff_pending {
            return Err(Errno::EBUSY);
        }
        // Bound unpublished operations and appended file data independently.
        // The change map also limits the resident set of unpublished index edits.
        if self.pending_operations >= 64
            || (self.live.end - self.published_end) >= self.epoch.publication_limit()
        {
            self.publish_pending()?;
        }
        let previous = self.live;
        let grouped = self.group_commit;
        let first = self.epoch.enabled && self.pending_operations == 0;
        let mut tree = self.tree();
        if first { tree.base_edits = None; }
        tree.try_append_window = grouped;
        let mut pending = Transaction {
            next: previous,
            tree,
            error: None,
            stat_changes: stat_invalidation::Changes::default(),
        };
        let value = apply(&mut pending)?;
        if let Some(error) = pending.error {
            return Err(error);
        }
        let stat_changes = pending.stat_changes;
        let materialized = pending.tree.base_edits.is_none();
        let edits = core::mem::take(&mut pending.tree.edits);
        let mut next = pending.next;
        next.end = pending.tree.end;
        if next == previous && edits.is_empty() {
            return Ok(value);
        }
        if next.usage.allocated_blocks() > next.usage.capacity_blocks {
            return Err(Errno::ENOSPC);
        }
        if let Some(window) = &mut pending.tree.appends {
            window.drain(pending.tree.storage)?;
        }
        let revision = self.revision.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        if self.epoch.enabled && materialized && !first {
            // This large operation folded the whole pending epoch in its
            // private transaction. The previous map remains intact on failure.
            self.publish(next)?;
            self.epoch.points.clear();
            self.epoch.base_usage = None;
            self.records.clear();
        } else if self.group_commit {
            // Reserve a representable publication sequence before acknowledging.
            next.sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            if self.epoch.enabled && !first {
                self.epoch.points.merge(edits)?;
                self.epoch.base_usage.get_or_insert(previous.usage);
            }
            self.pending_operations += 1;
            self.live = next;
        } else {
            self.publish(next)?;
        }
        self.stat_generations.commit(stat_changes, revision);
        self.revision = revision;
        Ok(value)
    }

    fn publish_pending(&mut self) -> Result<(), Errno> {
        if let Some(error) = self.publication_error {
            return Err(error);
        }
        if self.pending_operations != 0 {
            if self.epoch.base_usage.is_some() {
                self.publish_coalesced()?;
            } else {
                self.publish(self.live)?;
            }
        }
        Ok(())
    }

    fn publish(&mut self, mut next: Superblock) -> Result<(), Errno> {
        next.sequence = next.sequence.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        self.storage.flush()?;
        let first = self.first_write_slot;
        for slot in [first, 1 - first] {
            if let Err(error) = write_superblock(&mut self.storage, slot, next) {
                self.publication_error = Some(error);
                return Err(error);
            }
        }
        self.live = next;
        self.published_end = next.end;
        self.pending_operations = 0;
        self.first_write_slot = (next.sequence % 2) ^ 1;
        Ok(())
    }
}

fn record_bytes(key: &[u8], value_length: usize) -> u64 {
    // Two slot bytes and the two length fields accompany each leaf record.
    (key.len() + value_length + 6) as u64
}

fn read_block_at(
    storage: &mut impl PositionedStorage,
    appends: Option<&AppendWindow>,
    location: PageRef,
    end: u64,
    output: &mut [u8],
) -> Result<(), Errno> {
    if location
        .number
        .checked_add(BLOCK_UNITS)
        .is_none_or(|end_of_block| end_of_block > end)
    {
        return Err(Errno::EIO);
    }
    if !appends.is_some_and(|window| window.read(location.number, output)) {
        storage.read_exact_at(offset(location.number)?, output)?;
    }
    if Sha256::digest(&*output)[..] != location.digest {
        return Err(Errno::EIO);
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Bounds<'a> {
    after: Option<&'a [u8]>,
    end: Option<&'a [u8]>,
}

impl Bounds<'_> {
    const ALL: Self = Self {
        after: None,
        end: None,
    };
}

struct Tree<'a, S> {
    storage: &'a mut S,
    cache: &'a mut PageCache,
    records: Option<&'a mut RecordCache>,
    end: u64,
    base_usage: Usage,
    base_edits: Option<&'a ChangeMap>,
    edits: ChangeMap,
    scan: Option<ScanWindow>,
    appends: Option<AppendWindow>,
    try_append_window: bool,
}

// Each transaction appends whole tree pages or data blocks. A spill never
// splits either one, so readers can satisfy each reference from a single source.
const APPEND_WINDOW_BYTES: usize = 16 * 1024;

struct AppendWindow {
    first_unit: u64,
    bytes: IoBuffer<u8>,
}

impl AppendWindow {
    fn try_new() -> Result<Option<Self>, Errno> {
        match IoBuffer::try_with_capacity(APPEND_WINDOW_BYTES) {
            Ok(bytes) => Ok(Some(Self {
                first_unit: 0,
                bytes,
            })),
            Err(Errno::ENOMEM) => Ok(None), // Direct writes need no window.
            Err(error) => Err(error),
        }
    }

    fn read(&self, unit: u64, dst: &mut [u8]) -> bool {
        let Some(index) = unit
            .checked_sub(self.first_unit)
            .filter(|delta| *delta < (self.bytes.len() / PAGE_BYTES) as u64)
        else {
            return false;
        };
        let start = index as usize * PAGE_BYTES;
        let Some(bytes) = self.bytes.get(start..start + dst.len()) else {
            return false;
        };
        dst.copy_from_slice(bytes);
        true
    }

    fn drain(&mut self, storage: &mut impl PositionedStorage) -> Result<(), Errno> {
        if !self.bytes.is_empty() {
            storage.write_all_at(offset(self.first_unit)?, &self.bytes)?;
            self.bytes.clear();
        }
        Ok(())
    }

    fn append(
        &mut self,
        storage: &mut impl PositionedStorage,
        unit: u64,
        src: &[u8],
    ) -> Result<(), Errno> {
        if self.bytes.len() + src.len() > APPEND_WINDOW_BYTES {
            self.drain(storage)?;
        }
        if self.bytes.is_empty() {
            self.first_unit = unit;
        }
        self.bytes.extend_from_slice(src);
        Ok(())
    }
}

struct ScanWindow {
    bytes: IoBuffer<u8>,
    start: Option<u64>,
}

impl<S: PositionedStorage> Tree<'_, S> {
    fn append(&mut self, bytes: &[u8]) -> Result<PageRef, Errno> {
        // Metadata-only edits and direct bulk payload writes can finish
        // without a window. Try admission once when a buffered append
        // would actually use it.
        if core::mem::take(&mut self.try_append_window) {
            self.appends = AppendWindow::try_new()?;
        }
        let reference = append(self.storage, &mut self.end, bytes, self.appends.as_mut())?;
        if self.appends.is_some() && bytes.len() == PAGE_BYTES {
            self.cache.remember(reference, bytes)?;
        }
        Ok(reference)
    }

    fn read<'a>(
        &mut self,
        reference: PageRef,
        level: u8,
        bytes: &'a mut [u8],
        admit: bool,
    ) -> Result<Page<'a>, Errno> {
        if reference.number >= self.end {
            return Err(Errno::EIO);
        }
        if self.scan.is_none() && self.cache.copy(reference, bytes) {
            return Page::open(bytes, level);
        }
        self.read_uncached(reference, level, bytes, admit)
    }

    fn read_uncached<'a>(
        &mut self,
        reference: PageRef,
        level: u8,
        bytes: &'a mut [u8],
        admit: bool,
    ) -> Result<Page<'a>, Errno> {
        if self
            .appends
            .as_ref()
            .is_some_and(|window| window.read(reference.number, bytes))
        {
            if Sha256::digest(&*bytes)[..] != reference.digest {
                return Err(Errno::EIO);
            }
        } else if let Some(scan) = &mut self.scan {
            let start = reference.number / BLOCK_UNITS * BLOCK_UNITS;
            if scan.start != Some(start) {
                let length = (self.end - start).min(BLOCK_UNITS) as usize * PAGE_BYTES;
                self.storage
                    .read_exact_at(offset(start)?, &mut scan.bytes[..length])?;
                scan.start = Some(start);
            }
            let in_window = (reference.number - start) as usize * PAGE_BYTES;
            bytes.copy_from_slice(&scan.bytes[in_window..in_window + PAGE_BYTES]);
            if Sha256::digest(&*bytes)[..] != reference.digest {
                return Err(Errno::EIO);
            }
        } else {
            self.storage
                .read_exact_at(offset(reference.number)?, bytes)?;
            if Sha256::digest(&*bytes)[..] != reference.digest {
                return Err(Errno::EIO);
            }
            if admit {
                self.cache.remember(reference, bytes)?;
            }
        }
        Page::open(bytes, level)
    }

    fn lookup_record(
        &mut self,
        root: Superblock,
        key: &[u8],
        output: &mut [u8],
    ) -> Result<Option<usize>, Errno> {
        if let Some(change) = self.pending_record(key) {
            return Self::copy_value(change, output);
        }
        if let Some(cache) = &self.records {
            if let Some(hit) = cache.lookup(key, output)? {
                return Ok(hit);
            }
        }
        let count = self.lookup_base(root, key, output)?.map(|(length, _)| length);
        if let Some(cache) = &mut self.records {
            cache.remember(key, count.map(|n| &output[..n]));
        }
        Ok(count)
    }

    fn lookup(
        &mut self,
        root: Superblock,
        key: &[u8],
        output: &mut [u8],
    ) -> Result<Option<(usize, u64)>, Errno> {
        if let Some(change) = self.pending_record(key) {
            return Ok(Self::copy_value(change, output)?.map(|length| (length, self.end)));
        }
        self.lookup_base(root, key, output)
    }

    fn pending_record(&self, key: &[u8]) -> Option<Option<&[u8]>> {
        self.edits
            .get(key)
            .or_else(|| self.base_edits.and_then(|map| map.get(key)))
    }

    fn copy_value(value: Option<&[u8]>, output: &mut [u8]) -> Result<Option<usize>, Errno> {
        let Some(value) = value else {
            return Ok(None);
        };
        output
            .get_mut(..value.len())
            .ok_or(Errno::ERANGE)?
            .copy_from_slice(value);
        Ok(Some(value.len()))
    }

    fn lookup_base(
        &mut self,
        root: Superblock,
        key: &[u8],
        output: &mut [u8],
    ) -> Result<Option<(usize, u64)>, Errno> {
        let mut reference = root.root;
        let mut scratch = None;
        for level in (0..=root.level).rev() {
            if reference.number >= self.end {
                return Err(Errno::EIO);
            }
            // A point descent uses the page only until it has copied the
            // result or decoded the child. Range walks keep private pages so
            // recursion can fill or evict cache entries.
            let cached = if self.scan.is_none() { self.cache.locate(reference) } else { None };
            let page = match cached {
                Some(hit) => Page::open(self.cache.page(hit), level)?,
                None => self.read_uncached(
                    reference,
                    level,
                    scratch.get_or_insert_with(|| [0; PAGE_BYTES]),
                    true,
                )?,
            };
            let slot = page.lower_bound(key)?;
            let exact = slot < page.count && page.record(slot)?.0 == key;
            if level == 0 {
                if !exact {
                    return Ok(None);
                }
                let value = page.record(slot)?.1;
                output
                    .get_mut(..value.len())
                    .ok_or(Errno::ERANGE)?
                    .copy_from_slice(value);
                return Ok(Some((value.len(), reference.number)));
            }
            let child = if exact {
                slot
            } else if slot == 0 {
                return Ok(None);
            } else {
                slot - 1
            };
            reference = PageRef::decode(page.record(child)?.1, reference.number)?;
        }
        Err(Errno::EIO)
    }

    fn read_block(
        &mut self,
        root: Superblock,
        inode: u64,
        block: u64,
        output: &mut [u8; BLOCK_BYTES],
    ) -> Result<bool, Errno> {
        let key = EncodedKey::new(Key::Block { inode, block })?;
        let mut value = [0; crate::filesystem_tree::CHILD_BYTES];
        let Some((length, leaf)) = self
            .lookup(root, key.bytes(), &mut value)
            .map_err(|error| {
                if error == Errno::ERANGE {
                    Errno::EIO
                } else {
                    error
                }
            })?
        else {
            output.fill(0);
            return Ok(false);
        };
        let location = PageRef::decode(&value[..length], leaf)?;
        read_block_at(self.storage, self.appends.as_ref(), location, leaf, output)?;
        Ok(true)
    }

    fn visit_directory(
        &mut self,
        root: Superblock,
        parent: u64,
        after: Option<&[u8]>,
        mut visit: impl FnMut(&[u8], &[u8]) -> Result<bool, Errno>,
    ) -> Result<bool, Errno> {
        if parent == 0 {
            return Err(Errno::EINVAL);
        }
        let first = match after {
            Some(name) => EncodedKey::new(Key::Dirent { parent, name })?,
            None => EncodedKey::from_bytes(&key_prefix(2, parent)),
        };
        let last = parent
            .checked_add(1)
            .map_or_else(|| key_prefix(3, 0), |next| key_prefix(2, next));
        self.visit(
            root.root,
            root.level,
            None,
            Bounds {
                after: Some(first.bytes()),
                end: Some(&last),
            },
            &mut |_, _, key, value| match decode_key(key)? {
                Key::Dirent {
                    parent: actual,
                    name,
                } if parent == actual => visit(name, value),
                _ => Err(Errno::EIO),
            },
        )
    }

    fn visit(
        &mut self,
        reference: PageRef,
        level: u8,
        first: Option<&[u8]>,
        bounds: Bounds<'_>,
        visit: &mut impl FnMut(&mut S, u64, &[u8], &[u8]) -> Result<bool, Errno>,
    ) -> Result<bool, Errno> {
        if self.base_edits.is_some_and(|m| !m.is_empty()) || !self.edits.is_empty() {
            return self.visit_merged(reference, level, first, bounds, visit);
        }
        self.visit_base(reference, level, first, bounds, visit)
    }

    fn visit_base(
        &mut self, reference: PageRef, level: u8, first: Option<&[u8]>, bounds: Bounds<'_>,
        visit: &mut impl FnMut(&mut S, u64, &[u8], &[u8]) -> Result<bool, Errno>,
    ) -> Result<bool, Errno> {
        let mut bytes = IoBuffer::try_filled(PAGE_BYTES, 0)?;
        let page = self.read(reference, level, &mut bytes, false)?;
        page.verify_records(reference, level)?;
        if let Some(first) = first {
            if page.record(0)?.0 != first {
                return Err(Errno::EIO);
            }
        }
        let mut start = bounds
            .after
            .map_or(Ok(0), |after| page.lower_bound(after))?;
        if level != 0
            && start > 0
            && (start == page.count || Some(page.record(start)?.0) != bounds.after)
        {
            start -= 1;
        }
        for slot in start..page.count {
            let (key, value) = page.record(slot)?;
            if bounds.end.is_some_and(|end| key >= end) {
                break;
            }
            if level == 0 {
                if bounds.after.is_none_or(|after| key > after)
                    && !visit(self.storage, reference.number, key, value)?
                {
                    return Ok(false);
                }
            } else {
                let child = PageRef::decode(value, reference.number)?;
                if !self.visit_base(child, level - 1, Some(key), bounds, visit)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}

fn append(
    storage: &mut impl PositionedStorage,
    end: &mut u64,
    bytes: &[u8],
    window: Option<&mut AppendWindow>,
) -> Result<PageRef, Errno> {
    debug_assert_eq!(bytes.len() % PAGE_BYTES, 0);
    let number = *end;
    let next = number
        .checked_add((bytes.len() / PAGE_BYTES) as u64)
        .ok_or(Errno::EFBIG)?;
    offset(next)?;
    match window {
        Some(window) => window.append(storage, number, bytes)?,
        None => storage.write_all_at(offset(number)?, bytes)?,
    }
    *end = next;
    Ok(PageRef {
        number,
        digest: Sha256::digest(bytes).into(),
    })
}

/// Build a sealed volume from sorted records. Images, migration and
/// compaction can all stream into this builder.
pub struct KifsVolumeBuilder<S> {
    storage: S,
    levels: IoBuffer<PageBuilder>,
    pending_pages: IoBuffer<u8>,
    pending_units: u64,
    last: Option<EncodedKey>,
    max_inode: u64,
    end: u64,
    usage: Usage,
    identity: [u8; 32],
    error: Option<Errno>,
}

impl<S: PositionedStorage> KifsVolumeBuilder<S> {
    pub fn new(mut storage: S, capacity_blocks: u64, identity: [u8; 32]) -> Result<Self, Errno> {
        if storage.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        let usage = Usage {
            capacity_blocks,
            data_blocks: 0,
            metadata_bytes: 0,
        };
        if capacity_blocks < usage.allocated_blocks()
            || capacity_blocks > MAX_STORAGE_BYTES / BLOCK_BYTES as u64
        {
            return Err(Errno::EINVAL);
        }
        let mut levels = IoBuffer::try_with_capacity(1)?;
        levels.push(PageBuilder::new(0));
        Ok(Self {
            storage,
            levels,
            pending_pages: IoBuffer::try_filled(BLOCK_BYTES, 0)?,
            pending_units: 0,
            last: None,
            max_inode: 0,
            end: 0,
            usage,
            identity,
            error: None,
        })
    }

    pub fn push_metadata(&mut self, key: Key<'_>, value: &[u8]) -> Result<(), Errno> {
        if matches!(key, Key::Block { .. }) || value.is_empty() || value.len() > MAX_VALUE_BYTES {
            return Err(Errno::EINVAL);
        }
        let encoded = EncodedKey::new(key)?;
        self.push_record(&encoded, value, 0)?;
        if let Key::Inode(inode) = key {
            self.max_inode = self.max_inode.max(inode);
        }
        Ok(())
    }

    pub fn push_block(
        &mut self,
        inode: u64,
        block: u64,
        data: &[u8; BLOCK_BYTES],
    ) -> Result<(), Errno> {
        let key = EncodedKey::new(Key::Block { inode, block })?;
        let result = (|| {
            self.check_key(&key)?;
            self.flush_pages()?;
            let reference = append(&mut self.storage, &mut self.end, data, None)?;
            self.push_record(&key, &reference.encode(), 1)
        })();
        if let Err(error) = result {
            self.error = Some(error);
        }
        result
    }

    fn check_key(&self, key: &EncodedKey) -> Result<(), Errno> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if self
            .last
            .as_ref()
            .is_some_and(|last| last.bytes() >= key.bytes())
        {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    fn push_record(&mut self, key: &EncodedKey, value: &[u8], blocks: u64) -> Result<(), Errno> {
        self.check_key(key)?;
        self.usage.metadata_bytes += record_bytes(key.bytes(), value.len());
        self.usage.data_blocks += blocks;
        let result = if self.usage.allocated_blocks() > self.usage.capacity_blocks {
            Err(Errno::ENOSPC)
        } else {
            self.push_at(0, key, value)
        };
        if let Err(error) = result {
            self.error = Some(error);
            return Err(error);
        }
        self.last = Some(*key);
        Ok(())
    }

    fn push_at(&mut self, level: u8, key: &EncodedKey, value: &[u8]) -> Result<(), Errno> {
        if level > MAX_LEVEL {
            return Err(Errno::EFBIG);
        }
        let index = usize::from(level);
        if index == self.levels.len() {
            self.levels.try_reserve_exact(1)?;
            self.levels.push(PageBuilder::new(level));
        }
        if !self.levels[index].push(key, value) {
            let (first, reference) = self.spill(level)?;
            self.push_at(level + 1, &first, &reference.encode())?;
            if !self.levels[index].push(key, value) {
                return Err(Errno::EIO);
            }
        }
        Ok(())
    }

    fn spill(&mut self, level: u8) -> Result<(EncodedKey, PageRef), Errno> {
        let page = &mut self.levels[usize::from(level)];
        page.finish();
        let reference = PageRef {
            number: self.end,
            digest: Sha256::digest(page.bytes).into(),
        };
        offset(self.end + 1)?;
        let start = self.pending_units as usize * PAGE_BYTES;
        self.pending_pages[start..start + PAGE_BYTES].copy_from_slice(&page.bytes);
        self.pending_units += 1;
        self.end += 1;
        let first = page.first_key();
        *page = PageBuilder::new(level);
        if self.pending_units == BLOCK_UNITS {
            self.flush_pages()?;
        }
        Ok((first, reference))
    }

    fn flush_pages(&mut self) -> Result<(), Errno> {
        if self.pending_units != 0 {
            let start = offset(self.end - self.pending_units)?;
            let length = self.pending_units as usize * PAGE_BYTES;
            self.storage
                .write_all_at(start, &self.pending_pages[..length])?;
            self.pending_units = 0;
        }
        Ok(())
    }

    pub fn finish(mut self, next_inode: u64) -> Result<KifsVolume<S>, Errno> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if next_inode <= self.max_inode {
            return Err(Errno::EINVAL);
        }
        let mut level = 0;
        while usize::from(level) + 1 < self.levels.len() {
            let (first, reference) = self.spill(level)?;
            self.push_at(level + 1, &first, &reference.encode())?;
            level += 1;
        }
        let (_, root) = self.spill(level)?;
        self.flush_pages()?;
        let committed = Superblock {
            sequence: 1,
            root,
            level,
            end: self.end,
            usage: self.usage,
            next_inode,
            identity: self.identity,
        };
        self.storage.flush()?;
        for slot in [1, 0] {
            write_superblock(&mut self.storage, slot, committed)?;
        }
        // A new generation must start with two intact authorities. A mounted
        // computer can recover an older commit with one surviving replica.
        for slot in [0, 1] {
            if read_superblock(&mut self.storage, slot)? != Some(committed) {
                return Err(Errno::EIO);
            }
        }
        Ok(KifsVolume {
            storage: self.storage,
            cache: PageCache::new(),
            records: RecordCache::new(),
            stream_cursor: StreamCursor::default(),
            live: committed,
            epoch: Epoch::default(),
            published_end: committed.end,
            pending_operations: 0,
            group_commit: false,
            revision: 0,
            stat_generations: stat_invalidation::Generations::new(),
            first_write_slot: 0,
            publication_error: None,
            handoff_pending: false,
        })
    }
}

fn write_superblock(
    storage: &mut impl PositionedStorage,
    slot: u64,
    block: Superblock,
) -> Result<(), Errno> {
    storage.write_all_at(slot * BLOCK_BYTES as u64, &block.encode())?;
    storage.flush()
}

pub struct Transaction<'a, S> {
    stat_changes: stat_invalidation::Changes,
    next: Superblock,
    tree: Tree<'a, S>,
    error: Option<Errno>,
}

impl<S: PositionedStorage> Transaction<'_, S> {
    pub fn allocate_inode(&mut self) -> Result<u64, Errno> {
        let number = self.next.next_inode;
        self.next.next_inode = number.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(number)
    }

    pub fn lookup(&mut self, key: Key<'_>, output: &mut [u8]) -> Result<Option<usize>, Errno> {
        if matches!(key, Key::Block { .. }) {
            return Err(Errno::EINVAL);
        }
        self.tree
            .lookup_record(self.next, EncodedKey::new(key)?.bytes(), output)
    }

    pub fn read_block(
        &mut self,
        inode: u64,
        block: u64,
        output: &mut [u8; BLOCK_BYTES],
    ) -> Result<bool, Errno> {
        self.tree.read_block(self.next, inode, block, output)
    }

    pub fn directory_is_empty(&mut self, inode: u64) -> Result<bool, Errno> {
        self.tree
            .visit_directory(self.next, inode, None, |_, _| Ok(false))
    }

    pub fn put_metadata(&mut self, key: Key<'_>, value: &[u8]) -> Result<(), Errno> {
        if matches!(key, Key::Block { .. })
            || matches!(key, Key::Inode(number) if number >= self.next.next_inode)
            || value.is_empty()
            || value.len() > MAX_VALUE_BYTES
        {
            return Err(Errno::EINVAL);
        }
        self.change(EncodedKey::new(key)?, Some(value))
    }

    pub fn put_block(
        &mut self,
        inode: u64,
        block: u64,
        bytes: &[u8; BLOCK_BYTES],
    ) -> Result<(), Errno> {
        let key = EncodedKey::new(Key::Block { inode, block })?;
        let result = (|| {
            if let Some(error) = self.error {
                return Err(error);
            }
            let reference = self.tree.append(bytes)?;
            self.change(key, Some(&reference.encode()))
        })();
        if let Err(error) = result {
            self.error = Some(error);
        }
        result
    }

    pub fn remove(&mut self, key: Key<'_>) -> Result<(), Errno> {
        self.change(EncodedKey::new(key)?, None)
    }

    /// Retire all data and metadata after the caller releases the last
    /// namespace link, descriptor and shared mapping.
    pub fn reclaim_inode(&mut self, inode: u64) -> Result<(), Errno> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let key = EncodedKey::new(Key::Inode(inode))?;
        let result = self.retire_records(inode, &[Edit::point(key.bytes(), None)]);
        if let Err(error) = result {
            self.error = Some(error);
        }
        result
    }

    fn retire_records(&mut self, inode: u64, metadata: &[Edit<'_>]) -> Result<(), Errno> {
        let blocks = key_prefix(3, inode);
        let blocks_end = prefix_end(3, inode);
        let attrs = key_prefix(4, inode);
        let attrs_end = prefix_end(4, inode);
        // Metadata contains the inode and, on unlink, its parent and name.
        debug_assert!(!metadata.is_empty() && metadata.len() <= 3);
        let mut edits = [metadata[0]; 5];
        edits[..metadata.len()].copy_from_slice(metadata);
        edits[metadata.len()] = Edit::range(&blocks, &blocks_end);
        edits[metadata.len() + 1] = Edit::range(&attrs, &attrs_end);
        self.apply_edits(&edits[..metadata.len() + 2])
    }

    fn remove_blocks_from(&mut self, inode: u64, first: u64) -> Result<u64, Errno> {
        let start = EncodedKey::new(Key::Block {
            inode,
            block: first,
        })?;
        let end = prefix_end(3, inode);
        let before = self.next.usage.data_blocks;
        self.apply_edits(&[Edit::range(start.bytes(), &end)])?;
        Ok(before - self.next.usage.data_blocks)
    }

    fn change(&mut self, key: EncodedKey, value: Option<&[u8]>) -> Result<(), Errno> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let result = self.apply_edits(&[Edit::point(key.bytes(), value)]);
        if let Err(error) = result {
            self.error = Some(error);
        }
        result
    }

    // Edits are unique and sorted in the namespace's encoded key order.
    fn apply_edits(&mut self, edits: &[Edit<'_>]) -> Result<(), Errno> {
        self.stat_changes.observe(edits);
        debug_assert!(edits.windows(2).all(|pair| pair[0].key < pair[1].key));
        if self.tree.base_edits.is_some() {
            return self.stage_edits(edits);
        }
        let Some(mut replacements) =
            self.tree
                .rewrite(self.next.root, self.next.level, edits, &mut self.next.usage)?
        else {
            return Ok(());
        };
        let mut level = self.next.level;
        while replacements.children().len() > 1 {
            if level == MAX_LEVEL {
                replacements = self.tree.repack_top(&replacements, level)?;
                break;
            }
            level += 1;
            let mut writer = PageRewriter::new(level, None);
            for child in replacements.children() {
                writer.push(
                    &mut self.tree,
                    child.first.bytes(),
                    &child.reference.encode(),
                )?;
            }
            replacements = writer.finish(&mut self.tree)?;
        }
        self.set_root(replacements.children().first(), level)?;
        if let Some(cache) = &mut self.tree.records {
            for edit in edits {
                // Range erasure only removes blocks and attributes. Cached
                // attribute misses remain valid when such keys disappear.
                debug_assert!(edit.end.is_none() || matches!(edit.key[0], 3 | 4));
                if edit.end.is_none() {
                    cache.remember(edit.key, edit.value);
                }
            }
        }
        Ok(())
    }

    // All these complete blocks lie beyond the old logical EOF. Partial
    // overwrites take the ordinary authenticated read-modify-write path.
    fn append_file_blocks(
        &mut self,
        inode: u64,
        first: u64,
        bytes: &[u8],
        inode_value: Option<&[u8]>,
    ) -> Result<(), Errno> {
        let count = bytes.len() / BLOCK_BYTES;
        debug_assert!(count > 0 && count <= BLOCK_BATCH && bytes.len() % BLOCK_BYTES == 0);
        let mut keys = [[0u8; 17]; BLOCK_BATCH];
        let mut references = [[0u8; crate::filesystem_tree::CHILD_BYTES]; BLOCK_BATCH];
        let start = self.tree.end;
        let direct = bytes.len() >= APPEND_WINDOW_BYTES;
        let stage_run =
            direct && self.can_stage_block_run(inode, first, count, inode_value.is_some())?;
        if direct {
            if let Some(window) = &mut self.tree.appends {
                window.drain(self.tree.storage)?;
            }
            let next = start
                .checked_add(count as u64 * BLOCK_UNITS)
                .ok_or(Errno::EFBIG)?;
            offset(next)?;
            self.tree.storage.write_all_at(offset(start)?, bytes)?;
            self.tree.end = next;
        }
        if direct {
            for_each_digest(bytes, |index, digest| {
                references[index] = PageRef {
                    number: start + index as u64 * BLOCK_UNITS,
                    digest,
                }.encode();
                Ok(())
            })?;
        }
        for (i, block) in bytes.chunks_exact(BLOCK_BYTES).enumerate() {
            let key = EncodedKey::new(Key::Block { inode, block: first + i as u64 })?;
            keys[i].copy_from_slice(key.bytes());
            if !direct {
                references[i] = self.tree.append(block)?.encode();
            }
        }
        let inode_key = EncodedKey::new(Key::Inode(inode))?;
        let mut edits = [Edit::point(inode_key.bytes(), inode_value); BLOCK_BATCH + 1];
        for i in 0..count {
            edits[i + 1] = Edit::point(&keys[i], Some(&references[i]));
        }
        let old = self.next.usage.data_blocks;
        if stage_run {
            self.stat_changes.block_run(inode, inode_value);
            self.stage_new_block_run(inode_value.map(|_| edits[0]), &edits[1..count + 1])?;
        } else {
            self.apply_edits(&edits[usize::from(inode_value.is_none())..count + 1])?;
        }
        if self.next.usage.data_blocks.checked_sub(old) != Some(count as u64) {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn set_root(&mut self, replacement: Option<&Child>, level: u8) -> Result<(), Errno> {
        let (mut root, mut level) = match replacement {
            Some(child) => (child.reference, level),
            None => {
                let mut page = PageBuilder::new(0);
                page.finish();
                (self.tree.append(&page.bytes)?, 0)
            }
        };
        let mut bytes = [0; PAGE_BYTES];
        while level != 0 {
            let page = self.tree.read(root, level, &mut bytes, false)?;
            if page.count != 1 {
                break;
            }
            root = PageRef::decode(page.record(0)?.1, root.number)?;
            level -= 1;
        }
        self.next.root = root;
        self.next.level = level;
        Ok(())
    }
}

fn key_prefix(kind: u8, inode: u64) -> [u8; 9] {
    let mut key = [kind; 9];
    key[1..].copy_from_slice(&inode.to_be_bytes());
    key
}

#[derive(Clone, Copy)]
struct Edit<'a> {
    key: &'a [u8],
    value: Option<&'a [u8]>,
    end: Option<&'a [u8]>,
}

impl<'a> Edit<'a> {
    fn point(key: &'a [u8], value: Option<&'a [u8]>) -> Self {
        Self {
            key,
            value,
            end: None,
        }
    }

    fn range(start: &'a [u8], end: &'a [u8]) -> Self {
        Self {
            key: start,
            value: None,
            end: Some(end),
        }
    }
}

fn prefix_end(kind: u8, inode: u64) -> [u8; 9] {
    inode
        .checked_add(1)
        .map_or_else(|| key_prefix(kind + 1, 0), |next| key_prefix(kind, next))
}

// Bounds the workspace for keys and references, independently of the syscall size.
const BLOCK_BATCH: usize = 16;

struct Child {
    first: EncodedKey,
    reference: PageRef,
}

/// A page normally produces exactly one child. Splits alone need a vector.
enum Replacements {
    Empty,
    One(Child),
    Split(IoBuffer<Child>),
}

impl Replacements {
    fn push(&mut self, child: Child) -> Result<(), Errno> {
        match self {
            Self::Empty => *self = Self::One(child),
            Self::One(_) => {
                let mut split = IoBuffer::try_with_capacity(2)?;
                let Self::One(first) = core::mem::replace(self, Self::Empty) else {
                    unreachable!()
                };
                split.push(first);
                split.push(child);
                *self = Self::Split(split);
            }
            Self::Split(split) => {
                split.try_reserve(1)?;
                split.push(child);
            }
        }
        Ok(())
    }

    fn children(&self) -> &[Child] {
        match self {
            Self::Empty => &[],
            Self::One(child) => core::slice::from_ref(child),
            Self::Split(children) => children,
        }
    }
}

struct PageRewriter<'a> {
    level: u8,
    original_last_key: Option<&'a [u8]>,
    page: PageBuilder,
    children: Replacements,
}

impl<'a> PageRewriter<'a> {
    fn new(level: u8, original_last_key: Option<&'a [u8]>) -> Self {
        Self {
            level,
            original_last_key,
            page: PageBuilder::new(level),
            children: Replacements::Empty,
        }
    }

    fn push<S: PositionedStorage>(
        &mut self,
        tree: &mut Tree<'_, S>,
        key: &[u8],
        value: &[u8],
    ) -> Result<(), Errno> {
        if !self.page.push_bytes(key, value) {
            // An interior insertion displaced an existing key. Sealing a
            // full left page here would let reverse inserts repeatedly split
            // the same path, building a spine of single-child index pages.
            if self.original_last_key.is_some_and(|last| key <= last) {
                let right = self.page.split_with_record(key, value)?;
                self.spill(tree)?;
                self.page = right;
                return Ok(());
            }
            self.spill(tree)?;
            if !self.page.push_bytes(key, value) {
                return Err(Errno::EIO);
            }
        }
        Ok(())
    }

    fn spill<S: PositionedStorage>(&mut self, tree: &mut Tree<'_, S>) -> Result<(), Errno> {
        self.page.finish();
        self.children.push(Child {
            first: self.page.first_key(),
            reference: tree.append(&self.page.bytes)?,
        })?;
        self.page = PageBuilder::new(self.level);
        Ok(())
    }

    fn finish<S: PositionedStorage>(
        mut self,
        tree: &mut Tree<'_, S>,
    ) -> Result<Replacements, Errno> {
        if self.page.count != 0 {
            self.spill(tree)?;
        }
        Ok(self.children)
    }
}

impl<S: PositionedStorage> Tree<'_, S> {
    // Older sparse trees can reach the wire-format depth ceiling while
    // neighboring index pages remain nearly empty. Repack just the top
    // two levels before refusing a root split.
    fn repack_top(&mut self, roots: &Replacements, level: u8) -> Result<Replacements, Errno> {
        let mut lower = PageRewriter::new(level - 1, None);
        let mut last_key: Option<EncodedKey> = None;
        for top in roots.children() {
            let mut top_bytes = [0; PAGE_BYTES];
            let top_page = self.read(top.reference, level, &mut top_bytes, false)?;
            top_page.verify_records(top.reference, level)?;
            if top_page.record(0)?.0 != top.first.bytes() {
                return Err(Errno::EIO);
            }
            for slot in 0..top_page.count {
                let (separator, value) = top_page.record(slot)?;
                let child = PageRef::decode(value, top.reference.number)?;
                let mut bytes = [0; PAGE_BYTES];
                let page = self.read(child, level - 1, &mut bytes, false)?;
                page.verify_records(child, level - 1)?;
                if page.record(0)?.0 != separator
                    || last_key.as_ref().is_some_and(|last| last.bytes() >= separator)
                {
                    return Err(Errno::EIO);
                }
                for i in 0..page.count {
                    let (key, value) = page.record(i)?;
                    lower.push(self, key, value)?;
                }
                last_key = Some(EncodedKey::from_bytes(page.record(page.count - 1)?.0));
            }
        }
        let children = lower.finish(self)?;
        let mut packed = PageRewriter::new(level, None);
        for child in children.children() {
            packed.push(self, child.first.bytes(), &child.reference.encode())?;
        }
        let result = packed.finish(self)?;
        if result.children().len() != 1 {
            return Err(Errno::EFBIG);
        }
        Ok(result)
    }

    fn rewrite(
        &mut self,
        reference: PageRef,
        level: u8,
        edits: &[Edit<'_>],
        usage: &mut Usage,
    ) -> Result<Option<Replacements>, Errno> {
        let mut bytes = IoBuffer::try_filled(PAGE_BYTES, 0)?;
        let page = self.read(reference, level, &mut bytes, true)?;
        let last_key = if page.count == 0 {
            None
        } else {
            Some(page.record(page.count - 1)?.0)
        };
        let mut writer = PageRewriter::new(level, last_key);
        let mut changed = false;
        if level == 0 {
            let mut slot = 0;
            for edit in edits {
                while slot < page.count && page.record(slot)?.0 < edit.key {
                    let (key, value) = page.record(slot)?;
                    writer.push(self, key, value)?;
                    slot += 1;
                }
                if let Some(end) = edit.end {
                    while slot < page.count {
                        let (key, value) = page.record(slot)?;
                        if key >= end {
                            break;
                        }
                        let block = matches!(decode_key(key)?, Key::Block { .. });
                        usage.remove_record(key, value.len(), block)?;
                        changed = true;
                        slot += 1;
                    }
                    continue;
                }
                let old = if slot < page.count && page.record(slot)?.0 == edit.key {
                    let value = page.record(slot)?.1;
                    slot += 1;
                    Some(value)
                } else {
                    None
                };
                if old != edit.value {
                    changed = true;
                    let block = u64::from(edit.key[0] == 3);
                    if let Some(value) = old {
                        usage.remove_record(edit.key, value.len(), block != 0)?;
                    }
                    if let Some(value) = edit.value {
                        usage.metadata_bytes += record_bytes(edit.key, value.len());
                        usage.data_blocks += block;
                    }
                }
                if let Some(value) = edit.value {
                    writer.push(self, edit.key, value)?;
                }
            }
            for slot in slot..page.count {
                let (key, value) = page.record(slot)?;
                writer.push(self, key, value)?;
            }
        } else {
            let mut remaining = edits;
            // Until a separator changes, only fixed-size child references
            // differ. Keep the original page layout and patch those references.
            let mut patched = [0u8; PAGE_BYTES];
            let mut repacking = false;
            for slot in 0..page.count {
                let (key, value) = page.record(slot)?;
                let boundary = if slot + 1 < page.count {
                    Some(page.record(slot + 1)?.0)
                } else {
                    None
                };
                let count = boundary.map_or(remaining.len(), |end| {
                    remaining.partition_point(|edit| edit.key < end)
                });
                if count != 0 {
                    let child = PageRef::decode(value, reference.number)?;
                    let subset = &remaining[..count];
                    let crosses = boundary
                        .is_some_and(|key| subset[count - 1].end.is_some_and(|end| end > key));
                    remaining = &remaining[count - usize::from(crosses)..];
                    if let Some(replacements) = self.rewrite(child, level - 1, subset, usage)? {
                        if !repacking {
                            if !changed {
                                patched.copy_from_slice(page.bytes());
                            }
                            if let [new] = replacements.children() {
                                if new.first.bytes() == key {
                                    let start = page.value_offset(slot, key.len());
                                    patched[start..start + value.len()]
                                        .copy_from_slice(&new.reference.encode());
                                    changed = true;
                                    continue;
                                }
                            }
                            let preceding = Page::open(&patched, level)?;
                            for previous in 0..slot {
                                let (key, value) = preceding.record(previous)?;
                                writer.push(self, key, value)?;
                            }
                            repacking = true;
                        }
                        for new in replacements.children() {
                            writer.push(self, new.first.bytes(), &new.reference.encode())?;
                        }
                        changed = true;
                        continue;
                    }
                }
                if repacking {
                    writer.push(self, key, value)?;
                }
            }
            if changed && !repacking {
                self.cache.discard(reference);
                return Ok(Some(Replacements::One(Child {
                    first: EncodedKey::from_bytes(page.record(0)?.0),
                    reference: self.append(&patched)?,
                })));
            }
        }
        if changed {
            self.cache.discard(reference);
            Ok(Some(writer.finish(self)?))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests;
