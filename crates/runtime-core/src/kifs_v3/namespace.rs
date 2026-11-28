//! Canonical inode encoding and on-demand namespace operations.
use super::{BLOCK_BYTES, Key, KifsVolume, KifsVolumeBuilder, Transaction};
use crate::filesystem_tree::{MAX_VALUE_BYTES, ORPHAN_KIND};
use crate::positioned_storage::PositionedStorage;
use wasm_posix_shared::Errno;
use wasm_posix_shared::mode::{
    S_IFBLK, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK, S_ISGID, S_ISUID,
};

mod deferred;
mod lookup_cache;
use lookup_cache::LookupCache;

pub const ROOT_INODE: u64 = 1;
pub const SYMLINK_TARGET: u32 = 1;
pub const DEFERRED_FILE: u32 = 2;
pub const IMAGE_METADATA: u32 = 3;
const INODE_BYTES: usize = 96;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Timestamp {
    pub seconds: u64,
    pub nanoseconds: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InodeRecord {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub links: u32,
    pub size: u64,
    pub parent: u64,
    pub device: u64,
    pub data_blocks: u64,
    pub accessed: Timestamp,
    pub modified: Timestamp,
    pub changed: Timestamp,
}

impl InodeRecord {
    fn clear_setid_on_modify(&mut self) {
        self.mode &= !S_ISUID;
        if self.mode & 0o0010 != 0 {
            self.mode &= !S_ISGID;
        }
    }

    pub(crate) fn new(mode: u32, uid: u32, gid: u32, time: Timestamp) -> Self {
        Self {
            mode,
            uid,
            gid,
            links: 1,
            size: 0,
            parent: 0,
            device: 0,
            data_blocks: 0,
            accessed: time,
            modified: time,
            changed: time,
        }
    }

    pub fn encode(self) -> Result<[u8; INODE_BYTES], Errno> {
        let file_type = self.mode & S_IFMT;
        if self.mode & !(S_IFMT | 0o7777) != 0
            || !matches!(
                file_type,
                S_IFREG | S_IFDIR | S_IFLNK | S_IFIFO | S_IFSOCK | S_IFBLK | S_IFCHR
            )
            || (file_type == S_IFDIR) != (self.parent != 0)
            || (!matches!(file_type, S_IFBLK | S_IFCHR) && self.device != 0)
            || (file_type != S_IFREG && self.data_blocks != 0)
            || self.data_blocks > self.size.div_ceil(BLOCK_BYTES as u64)
        {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0; INODE_BYTES];
        bytes[..4].copy_from_slice(&self.mode.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.uid.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.gid.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.links.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.size.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.parent.to_le_bytes());
        bytes[32..40].copy_from_slice(&self.device.to_le_bytes());
        bytes[40..48].copy_from_slice(&self.data_blocks.to_le_bytes());
        for (slot, time) in
            bytes[48..]
                .chunks_exact_mut(16)
                .zip([self.accessed, self.modified, self.changed])
        {
            if time.nanoseconds >= 1_000_000_000 {
                return Err(Errno::EINVAL);
            }
            slot[..8].copy_from_slice(&time.seconds.to_le_bytes());
            slot[8..12].copy_from_slice(&time.nanoseconds.to_le_bytes());
        }
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8; INODE_BYTES]) -> Result<Self, Errno> {
        let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let wide = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let time = |at| Timestamp {
            seconds: wide(at),
            nanoseconds: word(at + 8),
        };
        let inode = Self {
            mode: word(0),
            uid: word(4),
            gid: word(8),
            links: word(12),
            size: wide(16),
            parent: wide(24),
            device: wide(32),
            data_blocks: wide(40),
            accessed: time(48),
            modified: time(64),
            changed: time(80),
        };
        if inode.encode().map_err(|_| Errno::EIO)? != *bytes {
            return Err(Errno::EIO);
        }
        Ok(inode)
    }
}

/// Filesystem operations address an inode number or a name relative to a
/// directory inode. Path resolution and guest credentials belong to the VFS.
pub struct KifsNamespace<S> {
    pub(super) volume: KifsVolume<S>,
    prepared: Option<KifsVolume<S>>,
    lookup_cache: LookupCache,
}

impl<S: PositionedStorage> KifsNamespace<S> {
    pub fn format(
        storage: S,
        capacity_blocks: u64,
        identity: [u8; 32],
        time: Timestamp,
    ) -> Result<Self, Errno> {
        let mut builder = KifsVolumeBuilder::new(storage, capacity_blocks, identity)?;
        let root = InodeRecord {
            mode: S_IFDIR | 0o755,
            uid: 0,
            gid: 0,
            links: 2,
            size: 0,
            parent: ROOT_INODE,
            device: 0,
            data_blocks: 0,
            accessed: time,
            modified: time,
            changed: time,
        };
        builder.push_metadata(Key::Inode(ROOT_INODE), &root.encode()?)?;
        Self::open(builder.finish(ROOT_INODE + 1)?)
    }

    pub fn open(volume: KifsVolume<S>) -> Result<Self, Errno> {
        let mut namespace = Self { volume, prepared: None, lookup_cache: LookupCache::new() };
        let root = namespace.inode(ROOT_INODE)?.ok_or(Errno::EIO)?;
        if root.mode & S_IFMT != S_IFDIR || root.parent != ROOT_INODE || root.links == 0 {
            return Err(Errno::EIO);
        }
        Ok(namespace)
    }

    pub fn into_volume(self) -> KifsVolume<S> {
        self.volume
    }

    pub(crate) fn compact_into<T: PositionedStorage>(&mut self, target: T) -> Result<(), Errno> {
        self.volume.compact_into(target)?;
        Ok(())
    }

    /// Physical COW history can grow even at constant logical usage. Keep
    /// periodic checks scalar and avoid repeatedly copying small volumes.
    pub(crate) fn needs_compaction(&self) -> Result<bool, Errno> {
        let live = self.volume.usage().allocated_blocks() * super::BLOCK_BYTES as u64;
        let committed_bytes = super::offset(self.volume.live.end)?;
        Ok(committed_bytes > (32 * 1024 * 1024).max(live.saturating_mul(3)))
    }

    pub(crate) fn prepare_handoff(&mut self, target: S, identity: [u8; 32]) -> Result<(), Errno> {
        if self.prepared.is_some() { return Err(Errno::EBUSY); }
        if identity == self.volume.live.identity { return Err(Errno::EINVAL); }
        let candidate = self.volume.compact_into_as(target, identity)?;
        self.prepared = Some(Self::open(candidate)?.into_volume());
        self.volume.handoff_pending = true;
        Ok(())
    }

    pub(crate) fn cancel_handoff(&mut self) {
        self.prepared = None;
        self.volume.handoff_pending = false;
    }

    pub(crate) fn activate_handoff(&mut self, active_storage: S) -> Result<(), Errno> {
        let mut next = self.prepared.take().ok_or(Errno::EINVAL)?;
        // The adapter now routes the active import to the verified target.
        // Directory descriptions, open inodes, mappings and orphan pins stay
        // mounted. No read, allocation or orphan recovery occurs at cutover.
        next.storage = active_storage;
        self.lookup_cache.clear();
        next.group_commit = self.volume.group_commit;
        next.epoch.enabled = self.volume.epoch.enabled;
        next.cache.inherit_budget(&self.volume.cache);
        self.volume = next;
        Ok(())
    }

    pub(crate) fn usage(&self) -> super::Usage {
        self.volume.usage()
    }

    pub(crate) fn sync(&mut self) -> Result<(), Errno> {
        self.volume.publish_pending()
    }

    pub(crate) fn enable_group_commit(&mut self) {
        self.volume.group_commit = true;
        self.volume.epoch.enabled = true;
    }

    pub(crate) fn enable_lookup_cache(&mut self) {
        let released = self.lookup_cache.enable();
        self.volume.cache.use_released_lookup_budget(released);
    }

    pub fn inode(&mut self, inode: u64) -> Result<Option<InodeRecord>, Errno> {
        let sequence = self.volume.revision;
        if inode == ROOT_INODE {
            if let Some(record) = self.lookup_cache.root(sequence) { return Ok(Some(record)); }
        }
        let record = read_inode(|bytes| self.volume.lookup(Key::Inode(inode), bytes))?;
        if inode == ROOT_INODE {
            if let Some(record) = record { self.lookup_cache.save_root(sequence, record); }
        }
        Ok(record)
    }

    pub(crate) fn update_inode(
        &mut self,
        inode: u64,
        update: impl FnOnce(&mut InodeRecord) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        self.volume.transaction(|tx| {
            let mut record = transaction_inode(tx, inode)?.ok_or(Errno::ENOENT)?;
            update(&mut record)?;
            tx.put_metadata(Key::Inode(inode), &record.encode()?)
        })
    }

    pub fn lookup(
        &mut self,
        parent: u64,
        name: &[u8],
    ) -> Result<Option<(u64, InodeRecord)>, Errno> {
        let directory = self.inode(parent)?.ok_or(Errno::ENOENT)?;
        self.lookup_child(parent, directory, name)
    }

    /// Walk components that the VFS has resolved for this mount. The VFS
    /// handles permission checks, symlink expansion, and mount crossings.
    pub fn walk<'a>(
        &mut self,
        start: u64,
        components: impl IntoIterator<Item = &'a [u8]>,
    ) -> Result<(u64, InodeRecord), Errno> {
        let mut inode = start;
        let mut record = self.inode(start)?.ok_or(Errno::ENOENT)?;
        for name in components {
            (inode, record) = self
                .lookup_child(inode, record, name)?
                .ok_or(Errno::ENOENT)?;
        }
        Ok((inode, record))
    }

    /// Reuse directory prefixes between VFS probes. Other names are cached
    /// by parent inode and component, so each leaf uses one cache entry.
    pub(crate) fn lookup_path(&mut self, path: &[u8]) -> Result<(u64, InodeRecord), Errno> {
        let revision = self.volume.revision;
        let slot = self.lookup_cache.slot(0, path);
        if let Some(found) = slot.and_then(|slot| self.lookup_cache.get(slot, revision, 0, path)) {
            return Ok(found);
        }
        let parent = path.iter().rposition(|&byte| byte == b'/').and_then(|separator| {
            let name = &path[separator + 1..];
            if name.is_empty() { return None; }
            let prefix = &path[..separator.max(1)];
            let slot = self.lookup_cache.slot(0, prefix)?;
            self.lookup_cache.get(slot, revision, 0, prefix).map(|(ino, dir)| (ino, dir, name))
        });
        let (ino, record) = match parent {
            Some((parent, directory, name)) => self.lookup_child(parent, directory, name)?.ok_or(Errno::ENOENT)?,
            None => self.walk(ROOT_INODE, path.split(|&byte| byte == b'/').filter(|name| !name.is_empty()))?,
        };
        if let Some(slot) = slot.filter(|_| record.mode & S_IFMT == S_IFDIR) {
            self.lookup_cache.remember(slot, revision, 0, path, ino, record);
        }
        Ok((ino, record))
    }

    fn lookup_child(
        &mut self,
        parent: u64,
        directory: InodeRecord,
        name: &[u8],
    ) -> Result<Option<(u64, InodeRecord)>, Errno> {
        if directory.mode & S_IFMT != S_IFDIR {
            return Err(Errno::ENOTDIR);
        }
        let sequence = self.volume.revision;
        let slot = self.lookup_cache.slot(parent, name);
        if let Some(slot) = slot {
            if let Some(found) = self.lookup_cache.get(slot, sequence, parent, name) { return Ok(Some(found)); }
        }
        let child = match name {
            b"." => parent,
            b".." => directory.parent,
            _ => {
                let Some(child) =
                    read_dirent(|bytes| self.volume.lookup(Key::Dirent { parent, name }, bytes))?
                else {
                    return Ok(None);
                };
                child
            }
        };
        let record = self.inode(child)?.ok_or(Errno::EIO)?;
        if record.links == 0 {
            return Err(Errno::EIO);
        }
        if let Some(slot) = slot { self.lookup_cache.remember(slot, sequence, parent, name, child, record); }
        Ok(Some((child, record)))
    }

    pub fn for_directory(
        &mut self,
        parent: u64,
        after: Option<&[u8]>,
        mut visit: impl FnMut(&[u8], u64) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        if self.inode(parent)?.ok_or(Errno::ENOENT)?.mode & S_IFMT != S_IFDIR {
            return Err(Errno::ENOTDIR);
        }
        self.volume.for_directory(parent, after, |name, record| {
            let inode = u64::from_le_bytes(record.try_into().map_err(|_| Errno::EIO)?);
            if inode == 0 {
                return Err(Errno::EIO);
            }
            visit(name, inode)
        })
    }

    /// Read one directory entry after the given name into caller-owned space.
    /// The caller has already checked the parent inode's type.
    pub(crate) fn next_dirent(
        &mut self,
        parent: u64,
        after: Option<&[u8]>,
        name: &mut [u8],
    ) -> Result<Option<(usize, u64, InodeRecord)>, Errno> {
        let Some((length, inode)) = self.volume.next_in_directory(parent, after, name)? else {
            return Ok(None);
        };
        let record = self
            .inode(inode)?
            .filter(|record| record.links != 0)
            .ok_or(Errno::EIO)?;
        Ok(Some((length, inode, record)))
    }

    /// A trial mount must distinguish a sparse hole from an allocated zero block.
    pub(crate) fn read_allocated_block(
        &mut self, inode: u64, block: u64, bytes: &mut [u8; BLOCK_BYTES],
    ) -> Result<bool, Errno> {
        self.volume.read_block(inode, block, bytes)
    }

    pub fn read_file(
        &mut self,
        inode: u64,
        offset: u64,
        output: &mut [u8],
    ) -> Result<usize, Errno> {
        let record = self.inode(inode)?.ok_or(Errno::ENOENT)?;
        match record.mode & S_IFMT {
            S_IFREG => {}
            S_IFDIR => return Err(Errno::EISDIR),
            _ => return Err(Errno::EINVAL),
        }
        reject_deferred(Errno::ENOTSUP, self.volume.lookup(
            Key::Attribute {
                inode,
                kind: DEFERRED_FILE,
                chunk: 0,
            },
            &mut [],
        ))?;
        let length = output
            .len()
            .min(usize::try_from(record.size.saturating_sub(offset)).unwrap_or(usize::MAX));
        let mut read = 0;
        let mut block = [0; BLOCK_BYTES];
        while read < length {
            let position = offset + read as u64;
            let within = (position % BLOCK_BYTES as u64) as usize;
            let full = ((length - read) / BLOCK_BYTES).min(super::BLOCK_BATCH);
            if within == 0 && full > 1 {
                let bytes = full * BLOCK_BYTES;
                self.volume.read_file_blocks(inode, position / BLOCK_BYTES as u64, &mut output[read..read + bytes])?;
                read += bytes;
                continue;
            }
            let amount = (length - read).min(BLOCK_BYTES - within);
            self.volume
                .read_block(inode, position / BLOCK_BYTES as u64, &mut block)?;
            output[read..read + amount].copy_from_slice(&block[within..within + amount]);
            read += amount;
        }
        Ok(length)
    }

    pub fn write_file(
        &mut self,
        inode: u64,
        offset: u64,
        input: &[u8],
        time: Timestamp,
    ) -> Result<(), Errno> {
        let end = offset
            .checked_add(input.len() as u64)
            .filter(|end| *end <= i64::MAX as u64)
            .ok_or(Errno::EFBIG)?;
        self.volume.transaction(|transaction| {
            let mut record = transaction_inode(transaction, inode)?.ok_or(Errno::ENOENT)?;
            match record.mode & S_IFMT {
                S_IFREG => {}
                S_IFDIR => return Err(Errno::EISDIR),
                _ => return Err(Errno::EINVAL),
            }
            reject_deferred(Errno::EROFS, transaction.lookup(
                Key::Attribute {
                    inode,
                    kind: DEFERRED_FILE,
                    chunk: 0,
                },
                &mut [],
            ))?;
            if input.is_empty() {
                return Ok(());
            }
            let old_size = record.size;
            record.size = record.size.max(end);
            record.clear_setid_on_modify();
            record.modified = time;
            record.changed = time;
            let mut written = 0;
            let mut bytes = [0; BLOCK_BYTES];
            let mut last_block = None;
            while written < input.len() {
                let position = offset + written as u64;
                let block = position / BLOCK_BYTES as u64;
                let within = (position % BLOCK_BYTES as u64) as usize;
                let full = ((input.len() - written) / BLOCK_BYTES).min(super::BLOCK_BATCH);
                if within == 0 && position >= old_size && full != 0 {
                    let bytes = full * BLOCK_BYTES;
                    // An allocated block beyond EOF would contradict the inode.
                    record.data_blocks += full as u64;
                    let final_batch = written + bytes == input.len();
                    let encoded = final_batch.then(|| record.encode()).transpose()?;
                    transaction.append_file_blocks(inode, block, &input[written..written + bytes], encoded.as_ref().map(|record| record.as_slice()))?;
                    written += bytes;
                    if final_batch { return Ok(()); }
                    continue;
                }
                let count = (input.len() - written).min(BLOCK_BYTES - within);
                let beyond_eof = position - within as u64 >= old_size;
                let allocated = if beyond_eof {
                    bytes.fill(0);
                    false
                } else {
                    transaction.read_block(inode, block, &mut bytes)?
                };
                record.data_blocks += u64::from(!allocated);
                bytes[within..within + count].copy_from_slice(&input[written..written + count]);
                written += count;
                if beyond_eof {
                    // The append validates that insertion actually adds a
                    // block. An unexpected live reference is corruption.
                    let final_block = written == input.len();
                    let encoded = final_block.then(|| record.encode()).transpose()?;
                    transaction.append_file_blocks(
                        inode,
                        block,
                        &bytes,
                        encoded.as_ref().map(|value| value.as_slice()),
                    )?;
                    if final_block {
                        return Ok(());
                    }
                } else if written == input.len() {
                    last_block = Some((super::EncodedKey::new(Key::Block { inode, block })?,
                        transaction.tree.append(&bytes)?.encode()));
                } else {
                    transaction.put_block(inode, block, &bytes)?;
                }
            }
            let encoded = record.encode()?;
            if let Some((block_key, reference)) = last_block {
                let key = super::EncodedKey::new(Key::Inode(inode))?;
                transaction.apply_edits(&[super::Edit::point(key.bytes(), Some(&encoded)),
                    super::Edit::point(block_key.bytes(), Some(&reference))])
            } else {
                transaction.put_metadata(Key::Inode(inode), &encoded)
            }
        })
    }

    pub(crate) fn truncate_file(
        &mut self,
        inode: u64,
        size: u64,
        time: Timestamp,
    ) -> Result<(), Errno> {
        self.volume.transaction(|tx| {
            let mut record = transaction_inode(tx, inode)?.ok_or(Errno::ENOENT)?;
            if record.mode & S_IFMT != S_IFREG {
                return Err(Errno::EINVAL);
            }
            reject_deferred(Errno::EROFS, tx.lookup(
                Key::Attribute {
                    inode,
                    kind: DEFERRED_FILE,
                    chunk: 0,
                },
                &mut [],
            ))?;
            if size < record.size {
                let width = BLOCK_BYTES as u64;
                let removed = tx.remove_blocks_from(inode, size.div_ceil(width))?;
                record.data_blocks = record.data_blocks.checked_sub(removed).ok_or(Errno::EIO)?;
                let tail = (size % width) as usize;
                if tail != 0 {
                    let mut bytes = [0; BLOCK_BYTES];
                    if tx.read_block(inode, size / width, &mut bytes)? {
                        bytes[tail..].fill(0);
                        tx.put_block(inode, size / width, &bytes)?;
                    }
                }
            }
            if record.size != size {
                record.clear_setid_on_modify();
            }
            record.size = size;
            record.modified = time;
            record.changed = time;
            tx.put_metadata(Key::Inode(inode), &record.encode()?)
        })
    }

    pub fn read_link(&mut self, inode: u64, output: &mut [u8]) -> Result<usize, Errno> {
        let record = self.inode(inode)?.ok_or(Errno::ENOENT)?;
        if record.mode & S_IFMT != S_IFLNK {
            return Err(Errno::EINVAL);
        }
        let length = output
            .len()
            .min(usize::try_from(record.size).unwrap_or(usize::MAX));
        let mut read = 0;
        let mut piece = [0; MAX_VALUE_BYTES];
        for chunk in 0..length.div_ceil(MAX_VALUE_BYTES) {
            let key = Key::Attribute {
                inode,
                kind: SYMLINK_TARGET,
                chunk: u32::try_from(chunk).map_err(|_| Errno::EIO)?,
            };
            let actual = self.volume.lookup(key, &mut piece)?.ok_or(Errno::EIO)?;
            let expected = (record.size - read as u64).min(MAX_VALUE_BYTES as u64) as usize;
            if actual != expected {
                return Err(Errno::EIO);
            }
            let amount = (length - read).min(actual);
            output[read..read + amount].copy_from_slice(&piece[..amount]);
            read += amount;
        }
        Ok(read)
    }

    /// Publish a new filesystem object with its first name. A symlink is
    /// stored as bounded metadata chunks in the same transaction.
    pub fn create(
        &mut self,
        parent: u64,
        name: &[u8],
        mut record: InodeRecord,
        symlink: Option<&[u8]>,
    ) -> Result<u64, Errno> {
        let kind = record.mode & S_IFMT;
        if (kind == S_IFLNK) != symlink.is_some()
            || symlink.is_some_and(|target| target.is_empty() || target.contains(&0))
        {
            return Err(Errno::EINVAL);
        }
        self.volume.transaction(|transaction| {
            let mut directory = transaction_inode(transaction, parent)?.ok_or(Errno::ENOENT)?;
            if directory.mode & S_IFMT != S_IFDIR {
                return Err(Errno::ENOTDIR);
            }
            let key = Key::Dirent { parent, name };
            if read_dirent(|bytes| transaction.lookup(key, bytes))?.is_some() {
                return Err(Errno::EEXIST);
            }
            let inode = transaction.allocate_inode()?;
            record.links = if kind == S_IFDIR { 2 } else { 1 };
            record.parent = if kind == S_IFDIR { parent } else { 0 };
            record.size = symlink.map_or(0, |target| target.len() as u64);
            record.data_blocks = 0;
            if kind == S_IFDIR {
                directory.links = directory.links.checked_add(1).ok_or(Errno::EMLINK)?;
            }
            directory.size = directory.size.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            directory.modified = record.changed;
            directory.changed = record.changed;
            let parent_key = super::EncodedKey::new(Key::Inode(parent))?;
            let inode_key = super::EncodedKey::new(Key::Inode(inode))?;
            let dirent_key = super::EncodedKey::new(key)?;
            transaction.apply_edits(&[
                super::Edit::point(parent_key.bytes(), Some(&directory.encode()?)),
                super::Edit::point(inode_key.bytes(), Some(&record.encode()?)),
                super::Edit::point(dirent_key.bytes(), Some(&inode.to_le_bytes())),
            ])?;
            if let Some(target) = symlink {
                for (chunk, bytes) in target.chunks(MAX_VALUE_BYTES).enumerate() {
                    let chunk = u32::try_from(chunk).map_err(|_| Errno::EFBIG)?;
                    transaction.put_metadata(
                        Key::Attribute {
                            inode,
                            kind: SYMLINK_TARGET,
                            chunk,
                        },
                        bytes,
                    )?;
                }
            }
            Ok(inode)
        })
    }

    pub fn link(
        &mut self,
        inode: u64,
        parent: u64,
        name: &[u8],
        time: Timestamp,
    ) -> Result<(), Errno> {
        self.volume.transaction(|transaction| {
            let mut source = transaction_inode(transaction, inode)?.ok_or(Errno::ENOENT)?;
            if source.mode & S_IFMT == S_IFDIR {
                return Err(Errno::EPERM);
            }
            let mut directory = transaction_inode(transaction, parent)?.ok_or(Errno::ENOENT)?;
            if directory.mode & S_IFMT != S_IFDIR {
                return Err(Errno::ENOTDIR);
            }
            let key = Key::Dirent { parent, name };
            if read_dirent(|bytes| transaction.lookup(key, bytes))?.is_some() {
                return Err(Errno::EEXIST);
            }
            source.links = source.links.checked_add(1).ok_or(Errno::EMLINK)?;
            source.changed = time;
            directory.size = directory.size.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            directory.modified = time;
            directory.changed = time;
            transaction.put_metadata(Key::Inode(inode), &source.encode()?)?;
            transaction.put_metadata(Key::Inode(parent), &directory.encode()?)?;
            transaction.put_metadata(key, &inode.to_le_bytes())
        })
    }

    /// Move a name without changing the source inode's identity. The VFS
    /// supplies the replacement policy and whether an overwritten inode is pinned.
    pub fn rename(
        &mut self,
        origin: (u64, &[u8]),
        target: (u64, &[u8]),
        replace: bool,
        target_pinned: bool,
        time: Timestamp,
    ) -> Result<(), Errno> {
        self.volume.transaction(|tx| {
            let (origin_parent, origin_name) = origin;
            let (target_parent, target_name) = target;
            let old_key = Key::Dirent {
                parent: origin_parent,
                name: origin_name,
            };
            let new_key = Key::Dirent {
                parent: target_parent,
                name: target_name,
            };
            let mut origin_directory = directory_inode(tx, origin_parent)?;
            let mut target_directory = if origin_parent == target_parent {
                origin_directory
            } else {
                directory_inode(tx, target_parent)?
            };
            let origin_inode =
                read_dirent(|bytes| tx.lookup(old_key, bytes))?.ok_or(Errno::ENOENT)?;
            let mut moving = transaction_inode(tx, origin_inode)?.ok_or(Errno::EIO)?;
            let is_directory = moving.mode & S_IFMT == S_IFDIR;
            let replaced = read_dirent(|bytes| tx.lookup(new_key, bytes))?;
            if let Some(replaced) = replaced {
                if !replace {
                    return Err(Errno::EEXIST);
                }
                if replaced == origin_inode {
                    return Ok(());
                }
            }
            if is_directory {
                ensure_acyclic_move(tx, origin_inode, target_parent)?;
                moving.parent = target_parent;
            }
            if let Some(replaced) = replaced {
                let mut victim = transaction_inode(tx, replaced)?.ok_or(Errno::EIO)?;
                let victim_is_dir = victim.mode & S_IFMT == S_IFDIR;
                match (is_directory, victim_is_dir) {
                    (true, false) => return Err(Errno::ENOTDIR),
                    (false, true) => return Err(Errno::EISDIR),
                    (true, true) if !tx.directory_is_empty(replaced)? => {
                        return Err(Errno::ENOTEMPTY);
                    }
                    _ => {}
                }
                victim.links = if victim_is_dir {
                    0
                } else {
                    victim.links.checked_sub(1).ok_or(Errno::EIO)?
                };
                victim.changed = time;
                retire_link(tx, replaced, victim, target_pinned)?;
            }

            // Removing the old name and then inserting at the target gives
            // the same count deltas for both the same-parent and cross-parent cases.
            origin_directory.size = origin_directory.size.checked_sub(1).ok_or(Errno::EIO)?;
            if is_directory {
                origin_directory.links = origin_directory.links.checked_sub(1).ok_or(Errno::EIO)?;
            }
            if origin_parent == target_parent {
                target_directory = origin_directory;
            }
            if replaced.is_none() {
                target_directory.size = target_directory
                    .size
                    .checked_add(1)
                    .ok_or(Errno::EOVERFLOW)?;
                if is_directory {
                    target_directory.links =
                        target_directory.links.checked_add(1).ok_or(Errno::EMLINK)?;
                }
            }
            moving.changed = time;
            origin_directory.changed = time;
            origin_directory.modified = time;
            target_directory.changed = time;
            target_directory.modified = time;
            tx.remove(old_key)?;
            tx.put_metadata(new_key, &origin_inode.to_le_bytes())?;
            tx.put_metadata(Key::Inode(origin_inode), &moving.encode()?)?;
            if origin_parent != target_parent {
                tx.put_metadata(Key::Inode(origin_parent), &origin_directory.encode()?)?;
            }
            tx.put_metadata(Key::Inode(target_parent), &target_directory.encode()?)
        })
    }

    /// Remove a non-directory name. The VFS holds inode pins on behalf of
    /// open descriptions and shared mappings, and supplies their liveness.
    pub fn unlink_file(
        &mut self,
        parent: u64,
        name: &[u8],
        pinned: bool,
        time: Timestamp,
    ) -> Result<u64, Errno> {
        self.remove_name(parent, name, false, pinned, time)
    }

    pub(crate) fn remove_name(
        &mut self,
        parent: u64,
        name: &[u8],
        remove_directory: bool,
        pinned: bool,
        time: Timestamp,
    ) -> Result<u64, Errno> {
        self.remove_name_with_pin(parent, name, remove_directory, time, |_| pinned)
            .map(|(inode, _)| inode)
    }

    pub(crate) fn remove_name_with_pin(
        &mut self,
        parent: u64,
        name: &[u8],
        remove_directory: bool,
        time: Timestamp,
        is_pinned: impl FnOnce(u64) -> bool,
    ) -> Result<(u64, u32), Errno> {
        self.volume.transaction(|transaction| {
            let mut directory = transaction_inode(transaction, parent)?.ok_or(Errno::ENOENT)?;
            if directory.mode & S_IFMT != S_IFDIR {
                return Err(Errno::ENOTDIR);
            }
            let entry = Key::Dirent { parent, name };
            let inode =
                read_dirent(|bytes| transaction.lookup(entry, bytes))?.ok_or(Errno::ENOENT)?;
            let mut record = transaction_inode(transaction, inode)?.ok_or(Errno::EIO)?;
            if record.links == 0 {
                return Err(Errno::EIO);
            }
            if remove_directory {
                if record.mode & S_IFMT != S_IFDIR {
                    return Err(Errno::ENOTDIR);
                }
                if !transaction.directory_is_empty(inode)? {
                    return Err(Errno::ENOTEMPTY);
                }
                record.links = 0;
                directory.links = directory.links.checked_sub(1).ok_or(Errno::EIO)?;
            } else {
                if record.mode & S_IFMT == S_IFDIR {
                    return Err(Errno::EISDIR);
                }
                record.links = record.links.checked_sub(1).ok_or(Errno::EIO)?;
            }
            record.changed = time;
            directory.size = directory.size.checked_sub(1).ok_or(Errno::EIO)?;
            directory.modified = time;
            directory.changed = time;
            let parent_key = super::EncodedKey::new(Key::Inode(parent))?;
            let inode_key = super::EncodedKey::new(Key::Inode(inode))?;
            let dirent_key = super::EncodedKey::new(entry)?;
            let parent_bytes = directory.encode()?;
            let inode_bytes = record.encode()?;
            let pinned = is_pinned(inode);
            let final_link = record.links == 0 && !pinned;
            let mut changes = [
                super::Edit::point(parent_key.bytes(), Some(&parent_bytes)),
                super::Edit::point(inode_key.bytes(), (!final_link).then_some(&inode_bytes[..])),
                super::Edit::point(dirent_key.bytes(), None),
            ];
            changes.sort_unstable_by(|a, b| a.key.cmp(b.key));
            if final_link {
                transaction.retire_records(inode, &changes)?;
            } else {
                transaction.apply_edits(&changes)?;
                if record.links == 0 { transaction.put_metadata(Key::Orphan(inode), &[1])?; }
            }
            Ok((inode, record.links))
        })
    }

    /// Retire a detached inode when the VFS releases its final pin.
    pub fn reclaim_unlinked(&mut self, inode: u64) -> Result<(), Errno> {
        self.volume.transaction(|tx| {
            let record = transaction_inode(tx, inode)?.ok_or(Errno::EIO)?;
            if record.links != 0 {
                return Err(Errno::EBUSY);
            }
            let mut marker = [0];
            if tx.lookup(Key::Orphan(inode), &mut marker)? != Some(1) || marker != [1] {
                return Err(Errno::EIO);
            }
            tx.reclaim_inode(inode)?;
            tx.remove(Key::Orphan(inode))
        })
    }

    /// Called only on a fresh, exclusive writable mount. An interrupted
    /// cleanup leaves its marker and allocation in the same committed root.
    pub(crate) fn recover_orphans(&mut self) -> Result<(), Errno> {
        loop {
            let root = self.volume.live;
            let mut orphan = None;
            self.volume.tree().visit(
                root.root,
                root.level,
                None,
                super::Bounds {
                    after: Some(&[ORPHAN_KIND]),
                    end: Some(&[ORPHAN_KIND + 1]),
                },
                &mut |_, _, key, value| {
                    match crate::filesystem_tree::decode_key(key)? {
                        Key::Orphan(inode) if value == [1] => orphan = Some(inode),
                        _ => return Err(Errno::EIO),
                    }
                    Ok(false)
                },
            )?;
            let Some(inode) = orphan else { return Ok(()) };
            self.reclaim_unlinked(inode).map_err(|error| {
                if error == Errno::EBUSY {
                    Errno::EIO
                } else {
                    error
                }
            })?;
        }
    }

    /// Descriptor teardown also runs on process exit and mapping release.
    /// Surface a failed asynchronous reclaim at sync and retry it on remount.
    pub(crate) fn release_orphan(&mut self, inode: u64) -> Result<(), Errno> {
        let result = self.reclaim_unlinked(inode);
        if let Err(error) = result {
            self.volume.publication_error.get_or_insert(error);
        }
        result
    }
}

fn retire_link(
    tx: &mut Transaction<'_, impl PositionedStorage>,
    inode: u64,
    record: InodeRecord,
    pinned: bool,
) -> Result<(), Errno> {
    if record.links == 0 {
        if !pinned {
            return tx.reclaim_inode(inode);
        }
        tx.put_metadata(Key::Orphan(inode), &[1])?;
    }
    tx.put_metadata(Key::Inode(inode), &record.encode()?)
}

fn read_inode(
    lookup: impl FnOnce(&mut [u8]) -> Result<Option<usize>, Errno>,
) -> Result<Option<InodeRecord>, Errno> {
    let mut bytes = [0; INODE_BYTES];
    match lookup(&mut bytes) {
        Ok(None) => Ok(None),
        Ok(Some(INODE_BYTES)) => InodeRecord::decode(&bytes).map(Some),
        Ok(Some(_)) | Err(Errno::ERANGE) => Err(Errno::EIO),
        Err(error) => Err(error),
    }
}

fn reject_deferred(error: Errno, present: Result<Option<usize>, Errno>) -> Result<(), Errno> {
    match present {
        Ok(None) => Ok(()),
        Err(Errno::ERANGE) => Err(error),
        Ok(Some(_)) => Err(Errno::EIO),
        Err(error) => Err(error),
    }
}

fn transaction_inode(
    transaction: &mut Transaction<'_, impl PositionedStorage>,
    inode: u64,
) -> Result<Option<InodeRecord>, Errno> {
    read_inode(|bytes| transaction.lookup(Key::Inode(inode), bytes))
}

fn directory_inode(
    tx: &mut Transaction<'_, impl PositionedStorage>,
    inode: u64,
) -> Result<InodeRecord, Errno> {
    let record = transaction_inode(tx, inode)?.ok_or(Errno::ENOENT)?;
    if record.mode & S_IFMT != S_IFDIR {
        return Err(Errno::ENOTDIR);
    }
    Ok(record)
}

fn ensure_acyclic_move(
    tx: &mut Transaction<'_, impl PositionedStorage>,
    moving: u64,
    parent: u64,
) -> Result<(), Errno> {
    let (mut slow, mut fast) = (parent, parent);
    loop {
        if slow == moving {
            return Err(Errno::EINVAL);
        }
        if slow == ROOT_INODE {
            return Ok(());
        }
        slow = directory_inode(tx, slow)?.parent;
        if fast != ROOT_INODE {
            fast = directory_inode(tx, fast)?.parent;
        }
        if fast != ROOT_INODE {
            fast = directory_inode(tx, fast)?.parent;
        }
        if slow == fast && slow != ROOT_INODE {
            return Err(Errno::EIO);
        }
    }
}

fn read_dirent(
    lookup: impl FnOnce(&mut [u8]) -> Result<Option<usize>, Errno>,
) -> Result<Option<u64>, Errno> {
    let mut bytes = [0; 8];
    match lookup(&mut bytes) {
        Ok(None) => Ok(None),
        Ok(Some(8)) if bytes != [0; 8] => Ok(Some(u64::from_le_bytes(bytes))),
        Ok(Some(_)) | Err(Errno::ERANGE) => Err(Errno::EIO),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
mod page_cost;

impl<S: PositionedStorage> KifsNamespace<S> {
    pub(crate) fn stat_stamp(&self, route: u64, inode: u64) -> Option<crate::rootfs::StatStamp> {
        if self.volume.publication_error.is_some() || self.volume.handoff_pending { return None; }
        Some(self.volume.stat_generations.stamp(route, inode))
    }

    pub(crate) fn write_stat_lease_buckets(
        &self, inode: u64, expected: crate::rootfs::StatStamp, out: &mut [u8],
    ) -> Option<usize> {
        if self.stat_stamp(expected.route, inode) != Some(expected) { return None; }
        self.volume.stat_generations.write_buckets(inode, out)
    }
}
