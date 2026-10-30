use crate::persistent_overlay::{OverlayKey, OverlayStorage};
use crate::IoBuffer;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

const MAGIC: &[u8; 4] = b"KIDX";
const VERSION: u32 = 1;
const TOMBSTONE_VERSION: u32 = 2;
const METADATA_VERSION: u32 = 3;
const HASHED_METADATA_VERSION: u32 = 4;
const CANONICAL_BLOCK_VERSION: u32 = 5;
const HEADER_BYTES: usize = 160;
const RECORD_BYTES: usize = 56;
const RECORDS_PER_PAGE: usize = 73;
const PAGE_BYTES: usize = RECORD_BYTES * RECORDS_PER_PAGE;
const METADATA_RECORD_BYTES: usize = 280;
const METADATA_RECORDS_PER_PAGE: usize = 14;
const HASHED_METADATA_RECORD_BYTES: usize = 312;
const HASHED_METADATA_RECORDS_PER_PAGE: usize = 13;
const METADATA_PAGE_BYTES: usize = HASHED_METADATA_RECORD_BYTES * HASHED_METADATA_RECORDS_PER_PAGE;
const READ_CACHE_PAGE_BYTES: usize = 4096;
const READ_CACHE_MAX_PAGES: usize = 32;

struct CachedIndexPage {
    offset: u64,
    length: usize,
    bytes: IoBuffer<u8>,
}

struct IndexReadCache {
    pages: IoBuffer<CachedIndexPage>,
    limit: usize,
}

impl IndexReadCache {
    fn new() -> Self {
        let limit = (crate::io_buffer::IO_MEMORY.usage().1 / 64 / READ_CACHE_PAGE_BYTES)
            .min(READ_CACHE_MAX_PAGES);
        Self { pages: IoBuffer::new(), limit }
    }

    fn discard(&mut self) -> bool {
        let owned = self.pages.capacity() != 0;
        self.pages = IoBuffer::new();
        owned
    }

    fn remember(&mut self, offset: u64, source: &[u8]) -> Result<(), Errno> {
        if source.len() > READ_CACHE_PAGE_BYTES { return Err(Errno::EIO); }
        if self.pages.len() < self.limit {
            let prepared = (|| {
                let mut bytes = IoBuffer::try_filled(READ_CACHE_PAGE_BYTES, 0)?;
                self.pages.try_reserve(1)?;
                bytes[..source.len()].copy_from_slice(source);
                Ok(CachedIndexPage { offset, length: source.len(), bytes })
            })();
            match prepared {
                Ok(page) => { self.pages.push(page); return Ok(()); }
                Err(Errno::ENOMEM) => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(page) = self.pages.first_mut() {
            page.bytes[..source.len()].copy_from_slice(source);
            page.offset = offset;
            page.length = source.len();
            self.pages.rotate_left(1);
        }
        Ok(())
    }

    fn read_exact_at<S: OverlayStorage>(&mut self, storage: &mut S, offset: u64, destination: &mut [u8], admit: bool) -> Result<(), Errno> {
        if destination.len() > READ_CACHE_PAGE_BYTES { return Err(Errno::EIO); }
        if let Some(position) = self.pages.iter().position(|page| page.offset == offset && page.length == destination.len()) {
            destination.copy_from_slice(&self.pages[position].bytes[..destination.len()]);
            self.pages[position..].rotate_left(1);
            return Ok(());
        }
        storage.read_exact_at(offset, destination)?;
        if admit { self.remember(offset, destination) } else { Ok(()) }
    }
}

pub(crate) struct CheckpointHeader {
    version: u32,
    base_digest: [u8; 32],
    journal_digest: [u8; 32],
    journal_end: u64,
    count: u64,
    next_sequence: u64,
}

impl CheckpointHeader {
    pub(crate) const BYTES: usize = HEADER_BYTES;

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != HEADER_BYTES || &bytes[..4] != MAGIC
            || bytes[128..] != Sha256::digest(&bytes[..128])[..]
        {
            return Err(Errno::EIO);
        }
        let version = u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| Errno::EIO)?);
        if !matches!(version, VERSION | TOMBSTONE_VERSION | METADATA_VERSION
            | HASHED_METADATA_VERSION | CANONICAL_BLOCK_VERSION)
        {
            return Err(Errno::EIO);
        }
        let header = Self {
            version,
            base_digest: bytes[8..40].try_into().map_err(|_| Errno::EIO)?,
            journal_digest: bytes[40..72].try_into().map_err(|_| Errno::EIO)?,
            journal_end: u64::from_le_bytes(bytes[72..80].try_into().map_err(|_| Errno::EIO)?),
            count: u64::from_le_bytes(bytes[80..88].try_into().map_err(|_| Errno::EIO)?),
            next_sequence: u64::from_le_bytes(bytes[88..96].try_into().map_err(|_| Errno::EIO)?),
        };
        if header.journal_end < 72 || header.next_sequence == 0 {
            return Err(Errno::EIO);
        }
        record_offset(header.count).map_err(|_| Errno::EIO)?;
        Ok(header)
    }

    pub(crate) fn requires_conversion(&self) -> bool {
        matches!(self.version, VERSION | TOMBSTONE_VERSION)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataCheckpointEntry {
    pub key: OverlayKey,
    pub value: Option<(u64, u32)>,
    pub value_digest: Option<[u8; 32]>,
}

impl MetadataCheckpointEntry {
    fn encode(&self, version: u32) -> Result<[u8; HASHED_METADATA_RECORD_BYTES], Errno> {
        let mut bytes = [0; HASHED_METADATA_RECORD_BYTES];
        let (kind, inode, name) = match &self.key {
            OverlayKey::Inode(inode) => (1, *inode, &[][..]),
            OverlayKey::FileSize(inode) => (2, *inode, &[][..]),
            OverlayKey::FileZeroFrom(inode) => (3, *inode, &[][..]),
            OverlayKey::Dirent { parent, name } => (4, *parent, name.as_slice()),
            OverlayKey::FileBlock { .. } => return Err(Errno::EINVAL),
        };
        bytes[0] = kind;
        bytes[1] = name.len() as u8;
        bytes[2..10].copy_from_slice(&inode.to_le_bytes());
        bytes[10..10 + name.len()].copy_from_slice(name);
        if let Some((offset, length)) = self.value {
            bytes[265..273].copy_from_slice(&offset.to_le_bytes());
            bytes[273..277].copy_from_slice(&length.to_le_bytes());
        }
        if version == HASHED_METADATA_VERSION {
            if let Some(digest) = self.value_digest {
                bytes[280..312].copy_from_slice(&digest);
            }
        }
        Ok(bytes)
    }

    fn decode(bytes: &[u8], version: u32) -> Result<Self, Errno> {
        if bytes.len() != metadata_record_bytes(version)?
            || bytes[277..280].iter().any(|byte| *byte != 0)
        {
            return Err(Errno::EIO);
        }
        let inode = u64::from_le_bytes(bytes[2..10].try_into().map_err(|_| Errno::EIO)?);
        let name_length = bytes[1] as usize;
        if bytes[10 + name_length..265].iter().any(|byte| *byte != 0) {
            return Err(Errno::EIO);
        }
        let key = match (bytes[0], name_length) {
            (1, 0) => OverlayKey::Inode(inode),
            (2, 0) => OverlayKey::FileSize(inode),
            (3, 0) => OverlayKey::FileZeroFrom(inode),
            (4, 1..=255) => {
                let mut name = alloc::vec::Vec::new();
                name.try_reserve_exact(name_length).map_err(|_| Errno::ENOMEM)?;
                name.extend_from_slice(&bytes[10..10 + name_length]);
                OverlayKey::Dirent { parent: inode, name }
            },
            _ => return Err(Errno::EIO),
        };
        let offset = u64::from_le_bytes(bytes[265..273].try_into().map_err(|_| Errno::EIO)?);
        let length = u32::from_le_bytes(bytes[273..277].try_into().map_err(|_| Errno::EIO)?);
        let value = (offset != 0 || length != 0).then_some((offset, length));
        let value_digest = if version == HASHED_METADATA_VERSION && value.is_some() {
            let mut digest = [0; 32];
            digest.copy_from_slice(&bytes[280..312]);
            Some(digest)
        } else {
            if version == HASHED_METADATA_VERSION && bytes[280..312].iter().any(|byte| *byte != 0) {
                return Err(Errno::EIO);
            }
            None
        };
        Ok(Self {
            key,
            value,
            value_digest,
        })
    }

    fn validate(&self, journal_end: u64, version: u32) -> Result<(), Errno> {
        let valid_key = match &self.key {
            OverlayKey::Inode(inode)
            | OverlayKey::FileSize(inode)
            | OverlayKey::FileZeroFrom(inode) => *inode != 0,
            OverlayKey::Dirent { parent, name } => {
                *parent != 0
                    && !name.is_empty()
                    && name.len() <= 255
                    && name != b"."
                    && name != b".."
                    && !name.iter().any(|byte| *byte == 0 || *byte == b'/')
            }
            OverlayKey::FileBlock { .. } => false,
        };
        if !valid_key || matches!(self.key, OverlayKey::FileZeroFrom(_)) && self.value.is_none() {
            return Err(Errno::EIO);
        }
        if (version == HASHED_METADATA_VERSION && self.value.is_some())
            != self.value_digest.is_some()
        {
            return Err(Errno::EIO);
        }
        if let Some((offset, length)) = self.value {
            let valid_length = match self.key {
                OverlayKey::Inode(_) => (1..=4096).contains(&length),
                _ => length == 8,
            };
            if !valid_length
                || offset < 72
                || offset.checked_add(u64::from(length)).ok_or(Errno::EIO)? > journal_end
            {
                return Err(Errno::EIO);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockCheckpointEntry {
    pub inode: u64,
    pub block: u64,
    pub offset: u64,
    pub digest: [u8; 32],
}

impl BlockCheckpointEntry {
    pub fn is_tombstone(&self) -> bool {
        self.offset == 0
    }

    fn encode(self) -> [u8; RECORD_BYTES] {
        let mut bytes = [0; RECORD_BYTES];
        bytes[..8].copy_from_slice(&self.inode.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.block.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.offset.to_le_bytes());
        bytes[24..].copy_from_slice(&self.digest);
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != RECORD_BYTES {
            return Err(Errno::EIO);
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[24..]);
        Ok(Self {
            inode: u64::from_le_bytes(bytes[..8].try_into().map_err(|_| Errno::EIO)?),
            block: u64::from_le_bytes(bytes[8..16].try_into().map_err(|_| Errno::EIO)?),
            offset: u64::from_le_bytes(bytes[16..24].try_into().map_err(|_| Errno::EIO)?),
            digest,
        })
    }

    fn validate(&self, journal_end: u64, allow_tombstone: bool) -> Result<(), Errno> {
        if self.inode == 0 {
            return Err(Errno::EIO);
        }
        if self.is_tombstone() {
            return if allow_tombstone && self.digest == [0; 32] {
                Ok(())
            } else {
                Err(Errno::EIO)
            };
        }
        if self.offset < 72 || self.offset.checked_add(4096).ok_or(Errno::EIO)? > journal_end {
            return Err(Errno::EIO);
        }
        Ok(())
    }
}

pub struct BlockCheckpoint<S: OverlayStorage> {
    storage: S,
    read_cache: IndexReadCache,
    count: u64,
    journal_end: u64,
    next_sequence: u64,
    cached_page: [u8; PAGE_BYTES],
    cached_page_index: Option<u64>,
    metadata_count: u64,
    metadata_version: u32,
    canonical_block_stream: bool,
    metadata_page: [u8; METADATA_PAGE_BYTES],
    metadata_page_index: Option<u64>,
}

impl<S: OverlayStorage> BlockCheckpoint<S> {
    pub fn indexed_journal_digest(storage: &mut S) -> Result<Option<[u8; 32]>, Errno> {
        let mut header = [0; HEADER_BYTES];
        storage.read_exact_at(0, &mut header)?;
        let decoded = CheckpointHeader::decode(&header)?;
        Ok((!decoded.requires_conversion()).then_some(decoded.journal_digest))
    }

    pub fn create(
        storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = BlockCheckpointEntry>,
    ) -> Result<Self, Errno> {
        Self::create_checked(
            storage,
            base_digest,
            journal_digest,
            journal_end,
            next_sequence,
            entries.into_iter().map(Ok),
        )
    }

    pub fn create_checked(
        storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = Result<BlockCheckpointEntry, Errno>>,
    ) -> Result<Self, Errno> {
        Self::create_checked_internal(
            storage, base_digest, journal_digest, journal_end, next_sequence, entries, false,
        )
    }

    pub(crate) fn create_compacted_checked(
        storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = Result<BlockCheckpointEntry, Errno>>,
    ) -> Result<Self, Errno> {
        Self::create_checked_internal(
            storage, base_digest, journal_digest, journal_end, next_sequence, entries, true,
        )
    }

    fn create_checked_internal(
        mut storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
        next_sequence: u64,
        entries: impl IntoIterator<Item = Result<BlockCheckpointEntry, Errno>>,
        canonical_block_stream: bool,
    ) -> Result<Self, Errno> {
        if storage.len()? != 0 {
            return Err(Errno::EEXIST);
        }
        if journal_end < 72 || next_sequence == 0 {
            return Err(Errno::EINVAL);
        }
        let mut page = [0; PAGE_BYTES];
        let mut page_entries = 0usize;
        let mut count = 0u64;
        let mut digest = Sha256::new();
        let mut previous = None;
        let mut has_tombstone = false;
        for entry in entries {
            let entry = entry?;
            entry.validate(journal_end, true)?;
            has_tombstone |= entry.is_tombstone();
            let key = (entry.inode, entry.block);
            if previous.is_some_and(|previous| previous >= key) {
                return Err(Errno::EINVAL);
            }
            let encoded = entry.encode();
            page[page_entries * RECORD_BYTES..(page_entries + 1) * RECORD_BYTES]
                .copy_from_slice(&encoded);
            digest.update(encoded);
            page_entries += 1;
            count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            if page_entries == RECORDS_PER_PAGE {
                let offset = record_offset(count - page_entries as u64)?;
                storage.write_all_at(offset, &page)?;
                page_entries = 0;
            }
            previous = Some(key);
        }
        if page_entries != 0 {
            let offset = record_offset(count - page_entries as u64)?;
            storage.write_all_at(offset, &page[..page_entries * RECORD_BYTES])?;
        }
        storage.flush()?;
        let mut header = [0; HEADER_BYTES];
        header[..4].copy_from_slice(MAGIC);
        let version = if canonical_block_stream {
            CANONICAL_BLOCK_VERSION
        } else if has_tombstone {
            TOMBSTONE_VERSION
        } else {
            VERSION
        };
        header[4..8].copy_from_slice(&version.to_le_bytes());
        header[8..40].copy_from_slice(&base_digest);
        header[40..72].copy_from_slice(&journal_digest);
        header[72..80].copy_from_slice(&journal_end.to_le_bytes());
        header[80..88].copy_from_slice(&count.to_le_bytes());
        header[88..96].copy_from_slice(&next_sequence.to_le_bytes());
        header[96..128].copy_from_slice(&digest.finalize());
        let header_digest = Sha256::digest(&header[..128]);
        header[128..].copy_from_slice(&header_digest);
        storage.write_all_at(0, &header)?;
        storage.flush()?;
        Ok(Self {
            storage,
            read_cache: IndexReadCache::new(),
            count,
            journal_end,
            next_sequence,
            cached_page: [0; PAGE_BYTES],
            cached_page_index: None,
            metadata_count: 0,
            metadata_version: 0,
            canonical_block_stream,
            metadata_page: [0; METADATA_PAGE_BYTES],
            metadata_page_index: None,
        })
    }

    pub fn append_metadata_checked(
        &mut self,
        entries: impl IntoIterator<Item = Result<MetadataCheckpointEntry, Errno>>,
    ) -> Result<(), Errno> {
        self.append_metadata_checked_version(entries, HASHED_METADATA_VERSION)
    }

    fn append_metadata_checked_version(
        &mut self,
        entries: impl IntoIterator<Item = Result<MetadataCheckpointEntry, Errno>>,
        version: u32,
    ) -> Result<(), Errno> {
        let record_bytes = metadata_record_bytes(version)?;
        let records_per_page = metadata_records_per_page(version)?;
        if self.metadata_count != 0 || self.storage.len()? != record_offset(self.count)? {
            return Err(Errno::EEXIST);
        }
        let mut header = [0; HEADER_BYTES];
        self.storage.read_exact_at(0, &mut header)?;
        if &header[..4] != MAGIC
            || self.metadata_version != 0
            || header[128..] != Sha256::digest(&header[..128])[..]
        {
            return Err(Errno::EIO);
        }
        self.discard_read_caches();
        let block_digest = &header[96..128];
        let mut metadata_digest = Sha256::new();
        let mut previous = None;
        let mut count = 0u64;
        let mut page = [0; METADATA_PAGE_BYTES];
        let mut page_entries = 0usize;
        for entry in entries {
            let entry = entry?;
            entry.validate(self.journal_end, version)?;
            if previous
                .as_ref()
                .is_some_and(|previous| previous >= &entry.key)
            {
                return Err(Errno::EINVAL);
            }
            let encoded = entry.encode(version)?;
            page[page_entries * record_bytes..(page_entries + 1) * record_bytes]
                .copy_from_slice(&encoded[..record_bytes]);
            metadata_digest.update(&encoded[..record_bytes]);
            page_entries += 1;
            count = count.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            if page_entries == records_per_page {
                let offset = metadata_offset(self.count, count - page_entries as u64, version)?;
                self.storage
                    .write_all_at(offset, &page[..records_per_page * record_bytes])?;
                page_entries = 0;
            }
            previous = Some(entry.key);
        }
        if page_entries != 0 {
            let offset = metadata_offset(self.count, count - page_entries as u64, version)?;
            self.storage
                .write_all_at(offset, &page[..page_entries * record_bytes])?;
        }
        self.storage.flush()?;
        let mut combined = Sha256::new();
        combined.update(block_digest);
        combined.update(metadata_digest.finalize());
        header[4..8].copy_from_slice(&version.to_le_bytes());
        header[96..128].copy_from_slice(&combined.finalize());
        let header_digest = Sha256::digest(&header[..128]);
        header[128..].copy_from_slice(&header_digest);
        self.storage.write_all_at(0, &header)?;
        self.storage.flush()?;
        self.metadata_count = count;
        self.metadata_version = version;
        self.canonical_block_stream = version == METADATA_VERSION || version == HASHED_METADATA_VERSION;
        Ok(())
    }

    pub fn open(
        mut storage: S,
        base_digest: [u8; 32],
        journal_digest: [u8; 32],
        journal_end: u64,
    ) -> Result<Self, Errno> {
        if journal_end < 72 {
            return Err(Errno::EIO);
        }
        let mut header = [0; HEADER_BYTES];
        storage.read_exact_at(0, &mut header)?;
        let decoded = CheckpointHeader::decode(&header)?;
        let version = decoded.version;
        if decoded.base_digest != base_digest || decoded.journal_digest != journal_digest
            || decoded.journal_end != journal_end
        {
            return Err(Errno::EIO);
        }
        let count = decoded.count;
        let next_sequence = decoded.next_sequence;
        let block_end = record_offset(count).map_err(|_| Errno::EIO)?;
        let storage_length = storage.len()?;
        let has_metadata = version == METADATA_VERSION || version == HASHED_METADATA_VERSION;
        let record_bytes = if has_metadata {
            metadata_record_bytes(version)?
        } else {
            0
        };
        if storage_length < block_end
            || !has_metadata && storage_length != block_end
            || has_metadata && (storage_length - block_end) % record_bytes as u64 != 0
        {
            return Err(Errno::EIO);
        }
        let metadata_count = if has_metadata {
            (storage_length - block_end) / record_bytes as u64
        } else {
            0
        };
        let mut digest = Sha256::new();
        let mut page = [0; PAGE_BYTES];
        let mut scanned = 0u64;
        let mut previous = None;
        while scanned < count {
            let entries = (count - scanned).min(RECORDS_PER_PAGE as u64) as usize;
            let bytes = &mut page[..entries * RECORD_BYTES];
            storage.read_exact_at(record_offset(scanned)?, bytes)?;
            digest.update(&*bytes);
            for record in bytes.chunks_exact(RECORD_BYTES) {
                let entry = BlockCheckpointEntry::decode(record)?;
                entry.validate(journal_end, version != VERSION)?;
                let key = (entry.inode, entry.block);
                if previous.is_some_and(|previous| previous >= key) {
                    return Err(Errno::EIO);
                }
                previous = Some(key);
            }
            scanned += entries as u64;
        }
        let block_digest = digest.finalize();
        let expected_digest = if has_metadata {
            let mut metadata_digest = Sha256::new();
            let mut scanned = 0u64;
            let mut previous = None;
            let mut page = [0; METADATA_PAGE_BYTES];
            while scanned < metadata_count {
                let entries = (metadata_count - scanned)
                    .min(metadata_records_per_page(version)? as u64) as usize;
                let bytes = &mut page[..entries * record_bytes];
                storage.read_exact_at(metadata_offset(count, scanned, version)?, bytes)?;
                metadata_digest.update(&*bytes);
                for record in bytes.chunks_exact(record_bytes) {
                    let entry = MetadataCheckpointEntry::decode(record, version)?;
                    entry.validate(journal_end, version)?;
                    if previous
                        .as_ref()
                        .is_some_and(|previous| previous >= &entry.key)
                    {
                        return Err(Errno::EIO);
                    }
                    previous = Some(entry.key);
                }
                scanned += entries as u64;
            }
            let mut combined = Sha256::new();
            combined.update(block_digest);
            combined.update(metadata_digest.finalize());
            combined.finalize()
        } else {
            block_digest
        };
        if header[96..128] != expected_digest[..] {
            return Err(Errno::EIO);
        }
        Ok(Self {
            storage,
            read_cache: IndexReadCache::new(),
            count,
            journal_end,
            next_sequence,
            cached_page: [0; PAGE_BYTES],
            cached_page_index: None,
            metadata_count,
            metadata_version: if has_metadata { version } else { 0 },
            canonical_block_stream: version == METADATA_VERSION
                || version == HASHED_METADATA_VERSION
                || version == CANONICAL_BLOCK_VERSION,
            metadata_page: [0; METADATA_PAGE_BYTES],
            metadata_page_index: None,
        })
    }

    pub fn metadata_count(&self) -> u64 {
        self.metadata_count
    }

    pub fn has_metadata_index(&self) -> bool {
        self.metadata_version != 0
    }

    pub fn has_metadata_value_digests(&self) -> bool {
        self.metadata_version == HASHED_METADATA_VERSION
    }

    pub fn has_canonical_block_stream(&self) -> bool {
        self.canonical_block_stream
    }

    pub fn metadata_entry_at(
        &mut self,
        index: u64,
    ) -> Result<Option<MetadataCheckpointEntry>, Errno> {
        self.read_metadata_entry(index, false)
    }

    fn read_metadata_entry(&mut self, index: u64, cache_lookup: bool) -> Result<Option<MetadataCheckpointEntry>, Errno> {
        if index >= self.metadata_count {
            return Ok(None);
        }
        let record_bytes = metadata_record_bytes(self.metadata_version)?;
        let records_per_page = metadata_records_per_page(self.metadata_version)?;
        let page_index = index / records_per_page as u64;
        if self.metadata_page_index != Some(page_index) {
            let first = page_index * records_per_page as u64;
            let entries = (self.metadata_count - first).min(records_per_page as u64) as usize;
            self.metadata_page_index = None;
            self.read_cache.read_exact_at(&mut self.storage,
                metadata_offset(self.count, first, self.metadata_version)?,
                &mut self.metadata_page[..entries * record_bytes],
                cache_lookup,
            )?;
            self.metadata_page_index = Some(page_index);
        }
        let within = index as usize % records_per_page;
        MetadataCheckpointEntry::decode(
            &self.metadata_page
                [within * record_bytes..(within + 1) * record_bytes],
            self.metadata_version,
        )
        .map(Some)
    }

    pub fn lookup_metadata(
        &mut self,
        key: &OverlayKey,
    ) -> Result<Option<MetadataCheckpointEntry>, Errno> {
        let mut low = 0;
        let mut high = self.metadata_count;
        while low < high {
            let middle = low + (high - low) / 2;
            let entry = self.read_metadata_entry(middle, true)?.ok_or(Errno::EIO)?;
            match entry.key.cmp(key) {
                core::cmp::Ordering::Less => low = middle + 1,
                core::cmp::Ordering::Greater => high = middle,
                core::cmp::Ordering::Equal => return Ok(Some(entry)),
            }
        }
        Ok(None)
    }

    pub fn lookup(
        &mut self,
        inode: u64,
        block: u64,
    ) -> Result<Option<BlockCheckpointEntry>, Errno> {
        let mut low = 0;
        let mut high = self.count;
        while low < high {
            let middle = low + (high - low) / 2;
            let entry = self.read_entry(middle, true)?;
            match (entry.inode, entry.block).cmp(&(inode, block)) {
                core::cmp::Ordering::Less => low = middle + 1,
                core::cmp::Ordering::Greater => high = middle,
                core::cmp::Ordering::Equal => return Ok(Some(entry)),
            }
        }
        Ok(None)
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    pub fn journal_end(&self) -> u64 {
        self.journal_end
    }

    pub fn entry_at(&mut self, index: u64) -> Result<Option<BlockCheckpointEntry>, Errno> {
        if index >= self.count {
            return Ok(None);
        }
        self.read_entry(index, false).map(Some)
    }

    pub fn into_storage(self) -> S {
        self.storage
    }

    pub(crate) fn discard_read_caches(&mut self) -> bool {
        let released = self.reclaim_supplemental_read_cache();
        self.cached_page_index = None;
        self.metadata_page_index = None;
        released
    }

    pub(crate) fn reclaim_supplemental_read_cache(&mut self) -> bool {
        self.read_cache.discard()
    }

    fn read_entry(&mut self, index: u64, cache_lookup: bool) -> Result<BlockCheckpointEntry, Errno> {
        let page_index = index / RECORDS_PER_PAGE as u64;
        if self.cached_page_index != Some(page_index) {
            let first = page_index * RECORDS_PER_PAGE as u64;
            let entries = (self.count - first).min(RECORDS_PER_PAGE as u64) as usize;
            self.cached_page_index = None;
            self.read_cache.read_exact_at(&mut self.storage,
                record_offset(first)?,
                &mut self.cached_page[..entries * RECORD_BYTES],
                cache_lookup,
            )?;
            self.cached_page_index = Some(page_index);
        }
        let within = index as usize % RECORDS_PER_PAGE;
        BlockCheckpointEntry::decode(
            &self.cached_page[within * RECORD_BYTES..(within + 1) * RECORD_BYTES],
        )
    }
}

fn record_offset(index: u64) -> Result<u64, Errno> {
    index
        .checked_mul(RECORD_BYTES as u64)
        .and_then(|bytes| bytes.checked_add(HEADER_BYTES as u64))
        .ok_or(Errno::EOVERFLOW)
}

fn metadata_record_bytes(version: u32) -> Result<usize, Errno> {
    match version {
        METADATA_VERSION => Ok(METADATA_RECORD_BYTES),
        HASHED_METADATA_VERSION => Ok(HASHED_METADATA_RECORD_BYTES),
        _ => Err(Errno::EIO),
    }
}

fn metadata_records_per_page(version: u32) -> Result<usize, Errno> {
    match version {
        METADATA_VERSION => Ok(METADATA_RECORDS_PER_PAGE),
        HASHED_METADATA_VERSION => Ok(HASHED_METADATA_RECORDS_PER_PAGE),
        _ => Err(Errno::EIO),
    }
}

fn metadata_offset(block_count: u64, index: u64, version: u32) -> Result<u64, Errno> {
    record_offset(block_count)?
        .checked_add(
            index
                .checked_mul(metadata_record_bytes(version)? as u64)
                .ok_or(Errno::EOVERFLOW)?,
        )
        .ok_or(Errno::EOVERFLOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[derive(Default)]
    struct MemoryStorage {
        bytes: Vec<u8>,
        fail_flush: bool,
        read_bytes: usize,
        fail_read: Option<(u64, Errno)>,
        fail_write: Option<u64>,
        flushes: usize,
        fail_flush_at: Option<usize>,
    }

    impl OverlayStorage for MemoryStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            Ok(self.bytes.len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
            self.read_bytes += destination.len();
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(destination.len()).ok_or(Errno::EIO)?;
            let source = self.bytes.get(start..end).ok_or(Errno::EIO)?;
            if let Some((failure_offset, error)) = self.fail_read {
                if failure_offset == offset {
                    let prefix = destination.len().min(16);
                    destination[..prefix].copy_from_slice(&source[..prefix]);
                    return Err(error);
                }
            }
            destination.copy_from_slice(source);
            Ok(())
        }

        fn write_all_at(&mut self, offset: u64, source: &[u8]) -> Result<(), Errno> {
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(source.len()).ok_or(Errno::EIO)?;
            if end > self.bytes.len() {
                self.bytes.resize(end, 0);
            }
            if self.fail_write == Some(offset) {
                let prefix = source.len().min(16);
                self.bytes[start..start + prefix].copy_from_slice(&source[..prefix]);
                return Err(Errno::EIO);
            }
            self.bytes[start..end].copy_from_slice(source);
            Ok(())
        }

        fn flush(&mut self) -> Result<(), Errno> {
            self.flushes += 1;
            if self.fail_flush || self.fail_flush_at == Some(self.flushes) {
                Err(Errno::EIO)
            } else {
                Ok(())
            }
        }

        fn truncate(&mut self, length: u64) -> Result<(), Errno> {
            self.bytes
                .truncate(usize::try_from(length).map_err(|_| Errno::EIO)?);
            Ok(())
        }
    }

    fn entries() -> Vec<BlockCheckpointEntry> {
        (0..200)
            .map(|block| BlockCheckpointEntry {
                inode: 7,
                block,
                offset: 72 + block * 4096,
                digest: [block as u8; 32],
            })
            .collect()
    }

    #[test]
    fn failed_page_replacement_never_exposes_a_partially_overwritten_cached_record() {
        for error in [Errno::EIO, Errno::ENOMEM, Errno::ENOSPC, Errno::EINTR, Errno::EAGAIN] {
            let records = entries();
            let mut checkpoint = BlockCheckpoint::create(MemoryStorage::default(), [1; 32], [2; 32],
                72 + 200 * 4096, 201, records.clone()).unwrap();
            assert_eq!(checkpoint.entry_at(0), Ok(Some(records[0])));
            checkpoint.storage.fail_read = Some((record_offset(RECORDS_PER_PAGE as u64).unwrap(), error));
            for _ in 0..2 {
                assert_eq!(checkpoint.entry_at(RECORDS_PER_PAGE as u64), Err(error));
            }
            checkpoint.storage.fail_read = None;
            assert_eq!(checkpoint.entry_at(0), Ok(Some(records[0])));
            assert_eq!(checkpoint.entry_at(RECORDS_PER_PAGE as u64), Ok(Some(records[RECORDS_PER_PAGE])));

            let metadata: Vec<_> = (1..=40).map(|inode| MetadataCheckpointEntry {
                key: OverlayKey::Inode(inode), value: Some((72, 12)), value_digest: Some([1; 32]),
            }).collect();
            checkpoint.append_metadata_checked(metadata.iter().cloned().map(Ok)).unwrap();
            assert_eq!(checkpoint.metadata_entry_at(0), Ok(Some(metadata[0].clone())));
            let next = HASHED_METADATA_RECORDS_PER_PAGE as u64;
            checkpoint.storage.fail_read = Some((metadata_offset(checkpoint.count, next, HASHED_METADATA_VERSION).unwrap(), error));
            for _ in 0..2 { assert_eq!(checkpoint.metadata_entry_at(next), Err(error)); }
            checkpoint.storage.fail_read = None;
            assert_eq!(checkpoint.metadata_entry_at(0), Ok(Some(metadata[0].clone())));
            assert_eq!(checkpoint.metadata_entry_at(next), Ok(Some(metadata[next as usize].clone())));
        }
    }

    #[test]
    fn repeated_binary_searches_reuse_bounded_block_and_metadata_page_working_sets() {
        let count = 4096;
        let records: Vec<_> = (0..count).map(|block| BlockCheckpointEntry {
            inode: 7, block, offset: 72 + block * 4096, digest: [block as u8; 32],
        }).collect();
        let metadata: Vec<_> = (1..=1024).map(|inode| MetadataCheckpointEntry {
            key: OverlayKey::Inode(inode), value: Some((72, 12)), value_digest: Some([1; 32]),
        }).collect();
        let mut checkpoint = BlockCheckpoint::create(MemoryStorage::default(), [1; 32], [2; 32],
            72 + count * 4096, count + 1, records.clone()).unwrap();
        checkpoint.append_metadata_checked(metadata.iter().cloned().map(Ok)).unwrap();
        for block in 1000..1008 {
            assert_eq!(checkpoint.lookup(7, block), Ok(Some(records[block as usize])));
            assert_eq!(checkpoint.lookup_metadata(&OverlayKey::Inode(block - 500)),
                Ok(Some(metadata[(block - 501) as usize].clone())));
        }
        let primed = checkpoint.storage.read_bytes;
        for _ in 0..16 {
            for block in 1000..1008 {
                assert_eq!(checkpoint.lookup(7, block), Ok(Some(records[block as usize])));
                assert_eq!(checkpoint.lookup_metadata(&OverlayKey::Inode(block - 500)),
                    Ok(Some(metadata[(block - 501) as usize].clone())));
            }
        }
        assert_eq!(checkpoint.storage.read_bytes, primed);
    }

    #[test]
    fn supplemental_cache_is_optional_bounded_and_reclaims_payload_and_slot_credits() {
        use crate::io_buffer::{IO_MEMORY, WRITEBACK_MEMORY, test_budget};
        let baseline = IO_MEMORY.usage().0;
        let writeback = WRITEBACK_MEMORY.usage().0;
        let records: Vec<_> = (0..4096).map(|block| BlockCheckpointEntry {
            inode: 7, block, offset: 72 + block * 4096, digest: [block as u8; 32],
        }).collect();
        let mut checkpoint = BlockCheckpoint::create(MemoryStorage::default(), [1; 32], [2; 32],
            72 + 4096 * 4096, 4097, records.clone()).unwrap();
        assert!(checkpoint.read_cache.pages.is_empty());
        assert_eq!(IO_MEMORY.usage().0, baseline);
        for page in 0..40 {
            let index = page * RECORDS_PER_PAGE;
            assert_eq!(checkpoint.lookup(7, index as u64), Ok(Some(records[index])));
        }
        assert_eq!(checkpoint.read_cache.pages.len(), READ_CACHE_MAX_PAGES);
        let charged = IO_MEMORY.usage().0;
        assert!(charged > baseline);
        assert!(charged <= baseline + 2 * READ_CACHE_MAX_PAGES * (READ_CACHE_PAGE_BYTES + core::mem::size_of::<CachedIndexPage>()));
        {
            let _pressure = test_budget(charged);
            assert_eq!(checkpoint.lookup(7, 4000), Ok(Some(records[4000])));
            assert_eq!(IO_MEMORY.usage().0, charged);
        }
        checkpoint.discard_read_caches();
        assert_eq!(IO_MEMORY.usage().0, baseline);
        assert_eq!(checkpoint.read_cache.pages.capacity(), 0);
        {
            let _pressure = test_budget(baseline);
            for index in [0, 100, 200, 0] {
                assert_eq!(checkpoint.lookup(7, index), Ok(Some(records[index as usize])));
            }
            assert!(checkpoint.read_cache.pages.is_empty());
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
        assert_eq!(WRITEBACK_MEMORY.usage().0, writeback);
        assert_eq!(checkpoint.lookup(7, 4000), Ok(Some(records[4000])));
        assert!(IO_MEMORY.usage().0 > baseline);
        let storage = checkpoint.into_storage();
        assert_eq!(IO_MEMORY.usage().0, baseline);
        {
            let mut reopened = BlockCheckpoint::open(storage, [1; 32], [2; 32], 72 + 4096 * 4096).unwrap();
            assert_eq!(reopened.lookup(7, 4000), Ok(Some(records[4000])));
            assert!(IO_MEMORY.usage().0 > baseline);
        }
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn supplemental_eviction_never_publishes_a_failed_read_or_confuses_short_pages() {
        let mut storage = MemoryStorage { bytes: vec![0; 3 * READ_CACHE_PAGE_BYTES], ..MemoryStorage::default() };
        storage.bytes[READ_CACHE_PAGE_BYTES..2 * READ_CACHE_PAGE_BYTES].fill(1);
        storage.bytes[2 * READ_CACHE_PAGE_BYTES..].fill(2);
        let mut cache = IndexReadCache::new();
        cache.limit = 2;
        let mut actual = [0; READ_CACHE_PAGE_BYTES];
        cache.read_exact_at(&mut storage, 0, &mut actual, true).unwrap();
        cache.read_exact_at(&mut storage, READ_CACHE_PAGE_BYTES as u64, &mut actual, true).unwrap();
        storage.fail_read = Some(((2 * READ_CACHE_PAGE_BYTES) as u64, Errno::EAGAIN));
        assert_eq!(cache.read_exact_at(&mut storage, (2 * READ_CACHE_PAGE_BYTES) as u64, &mut actual, true), Err(Errno::EAGAIN));
        let after_failure = storage.read_bytes;
        cache.read_exact_at(&mut storage, 0, &mut actual, true).unwrap();
        assert_eq!(actual, [0; READ_CACHE_PAGE_BYTES]);
        cache.read_exact_at(&mut storage, READ_CACHE_PAGE_BYTES as u64, &mut actual, true).unwrap();
        assert_eq!(actual, [1; READ_CACHE_PAGE_BYTES]);
        assert_eq!(storage.read_bytes, after_failure);
        storage.fail_read = None;
        cache.read_exact_at(&mut storage, (2 * READ_CACHE_PAGE_BYTES) as u64, &mut actual[..56], true).unwrap();
        assert_eq!(&actual[..56], &[2; 56]);
        let before_full = storage.read_bytes;
        cache.read_exact_at(&mut storage, (2 * READ_CACHE_PAGE_BYTES) as u64, &mut actual, true).unwrap();
        assert_eq!(actual, [2; READ_CACHE_PAGE_BYTES]);
        assert_eq!(storage.read_bytes, before_full + READ_CACHE_PAGE_BYTES);
        assert_eq!(cache.pages.len(), 2);
    }

    #[test]
    fn metadata_append_discards_warmed_pages_on_success_and_storage_failure() {
        use crate::io_buffer::IO_MEMORY;
        let baseline = IO_MEMORY.usage().0;
        for cut in 0..4 {
            let records = entries();
            let mut checkpoint = BlockCheckpoint::create(MemoryStorage::default(), [1; 32], [2; 32],
                72 + 200 * 4096, 201, records.clone()).unwrap();
            assert_eq!(checkpoint.lookup(7, 0), Ok(Some(records[0])));
            assert!(IO_MEMORY.usage().0 > baseline);
            checkpoint.storage.flushes = 0;
            if cut == 1 { checkpoint.storage.fail_write = Some(record_offset(200).unwrap()); }
            if cut >= 2 { checkpoint.storage.fail_flush_at = Some(cut - 1); }
            let metadata = MetadataCheckpointEntry {
                key: OverlayKey::Inode(7), value: Some((72, 12)), value_digest: Some([1; 32]),
            };
            let result = checkpoint.append_metadata_checked([Ok(metadata.clone())]);
            assert_eq!(result, if cut == 0 { Ok(()) } else { Err(Errno::EIO) });
            assert_eq!(IO_MEMORY.usage().0, baseline);
            assert_eq!(checkpoint.metadata_count(), if cut == 0 { 1 } else { 0 });
            checkpoint.storage.fail_write = None;
            checkpoint.storage.fail_flush_at = None;
            assert_eq!(checkpoint.entry_at(0), Ok(Some(records[0])));
            if cut == 0 { assert_eq!(checkpoint.metadata_entry_at(0), Ok(Some(metadata))); }
            drop(checkpoint);
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn supplemented_metadata_pages_preserve_version_geometry_and_short_final_pages() {
        for version in [METADATA_VERSION, HASHED_METADATA_VERSION] {
            let mut checkpoint = BlockCheckpoint::create(MemoryStorage::default(), [1; 32], [2; 32],
                72 + 200 * 4096, 201, entries()).unwrap();
            let records: Vec<_> = (1..=40).map(|inode| MetadataCheckpointEntry {
                key: OverlayKey::Inode(inode),
                value: if inode % 2 == 0 { None } else { Some((72, 12)) },
                value_digest: if version == HASHED_METADATA_VERSION && inode % 2 != 0 { Some([1; 32]) } else { None },
            }).collect();
            checkpoint.append_metadata_checked_version(records.iter().cloned().map(Ok), version).unwrap();
            let mut reopened = BlockCheckpoint::open(checkpoint.into_storage(), [1; 32], [2; 32], 72 + 200 * 4096).unwrap();
            for record in &records { assert_eq!(reopened.lookup_metadata(&record.key), Ok(Some(record.clone()))); }
            let primed = reopened.storage.read_bytes;
            for record in records.iter().rev() { assert_eq!(reopened.lookup_metadata(&record.key), Ok(Some(record.clone()))); }
            assert_eq!(reopened.metadata_entry_at(40), Ok(None));
            assert_eq!(reopened.lookup_metadata(&OverlayKey::Inode(41)), Ok(None));
            assert_eq!(reopened.storage.read_bytes, primed);
        }
    }

    #[test]
    fn sorted_checkpoint_reopens_and_finds_blocks_without_a_resident_map() {
        let records = entries();
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72 + 200 * 4096,
            201,
            records.clone(),
        )
        .unwrap();
        let storage = checkpoint.into_storage();
        assert_eq!(u32::from_le_bytes(storage.bytes[4..8].try_into().unwrap()), 1);
        let mut reopened =
            BlockCheckpoint::open(storage, [1; 32], [2; 32], 72 + 200 * 4096).unwrap();
        assert_eq!(reopened.count(), 200);
        assert_eq!(reopened.next_sequence(), 201);
        for record in records {
            assert_eq!(
                reopened.lookup(record.inode, record.block),
                Ok(Some(record))
            );
        }
        assert_eq!(reopened.lookup(7, 200), Ok(None));
        assert_eq!(reopened.lookup(8, 0), Ok(None));
    }

    #[test]
    fn tombstone_checkpoint_uses_v2_and_v1_remains_readable() {
        let entry = BlockCheckpointEntry {
            inode: 7,
            block: 3,
            offset: 0,
            digest: [0; 32],
        };
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage::default(),
                [1; 32],
                [2; 32],
                72,
                2,
                [BlockCheckpointEntry {
                    digest: [1; 32],
                    ..entry
                }],
            ),
            Err(Errno::EIO)
        ));
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72,
            2,
            [entry],
        )
        .unwrap();
        let mut storage = checkpoint.into_storage();
        assert_eq!(u32::from_le_bytes(storage.bytes[4..8].try_into().unwrap()), 2);
        let mut reopened = BlockCheckpoint::open(
            MemoryStorage {
                bytes: storage.bytes.clone(),
                ..MemoryStorage::default()
            },
            [1; 32],
            [2; 32],
            72,
        )
        .unwrap();
        assert_eq!(reopened.lookup(7, 3), Ok(Some(entry)));
        storage.bytes[4..8].copy_from_slice(&VERSION.to_le_bytes());
        let digest = Sha256::digest(&storage.bytes[..128]);
        storage.bytes[128..160].copy_from_slice(&digest);
        assert!(matches!(
            BlockCheckpoint::open(storage, [1; 32], [2; 32], 72),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn metadata_checkpoint_reopens_and_rejects_damage() {
        let journal_end = 72 + 200 * 4096;
        let mut checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            journal_end,
            201,
            entries(),
        )
        .unwrap();
        let metadata = [
            MetadataCheckpointEntry {
                key: OverlayKey::Inode(7),
                value: Some((72, 12)),
                value_digest: Some([1; 32]),
            },
            MetadataCheckpointEntry {
                key: OverlayKey::FileSize(7),
                value: Some((100, 8)),
                value_digest: Some([2; 32]),
            },
            MetadataCheckpointEntry {
                key: OverlayKey::FileZeroFrom(7),
                value: Some((120, 8)),
                value_digest: Some([3; 32]),
            },
            MetadataCheckpointEntry {
                key: OverlayKey::Dirent {
                    parent: 7,
                    name: b"file".to_vec(),
                },
                value: None,
                value_digest: None,
            },
        ];
        checkpoint
            .append_metadata_checked(metadata.iter().cloned().map(Ok))
            .unwrap();
        assert_eq!(checkpoint.metadata_count(), 4);
        for entry in &metadata {
            assert_eq!(checkpoint.lookup_metadata(&entry.key), Ok(Some(entry.clone())));
        }
        let storage = checkpoint.into_storage();
        assert_eq!(u32::from_le_bytes(storage.bytes[4..8].try_into().unwrap()), 4);
        let mut reopened = BlockCheckpoint::open(
            MemoryStorage {
                bytes: storage.bytes.clone(),
                ..MemoryStorage::default()
            },
            [1; 32],
            [2; 32],
            journal_end,
        )
        .unwrap();
        assert_eq!(reopened.metadata_count(), 4);
        assert_eq!(reopened.lookup(7, 10), Ok(Some(entries()[10])));
        for (index, entry) in metadata.iter().enumerate() {
            assert_eq!(reopened.metadata_entry_at(index as u64), Ok(Some(entry.clone())));
        }
        assert_eq!(reopened.metadata_entry_at(4), Ok(None));
        let mut damaged = storage.bytes.clone();
        damaged[metadata_offset(200, 3, HASHED_METADATA_VERSION).unwrap() as usize + 10] ^= 1;
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: damaged,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                journal_end,
            ),
            Err(Errno::EIO)
        ));
        let mut truncated = storage.bytes;
        truncated.pop();
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: truncated,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                journal_end,
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn metadata_checkpoint_refuses_duplicate_or_unsorted_keys() {
        let mut checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            4096,
            2,
            [],
        )
        .unwrap();
        let entry = MetadataCheckpointEntry {
            key: OverlayKey::Inode(7),
            value: Some((72, 12)),
            value_digest: Some([1; 32]),
        };
        assert_eq!(
            checkpoint.append_metadata_checked([Ok(entry.clone()), Ok(entry.clone())]),
            Err(Errno::EINVAL)
        );
        let mut checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            4096,
            2,
            [],
        )
        .unwrap();
        checkpoint.append_metadata_checked([Ok(entry)]).unwrap();
        assert_eq!(checkpoint.append_metadata_checked([]), Err(Errno::EEXIST));
    }

    #[test]
    fn legacy_v3_metadata_checkpoint_remains_readable() {
        let mut checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            4096,
            2,
            [],
        )
        .unwrap();
        let entry = MetadataCheckpointEntry {
            key: OverlayKey::Inode(7),
            value: Some((72, 12)),
            value_digest: None,
        };
        checkpoint
            .append_metadata_checked_version([Ok(entry.clone())], METADATA_VERSION)
            .unwrap();
        let storage = checkpoint.into_storage();
        assert_eq!(storage.bytes.len(), HEADER_BYTES + METADATA_RECORD_BYTES);
        let mut reopened = BlockCheckpoint::open(storage, [1; 32], [2; 32], 4096).unwrap();
        assert!(reopened.has_metadata_index());
        assert!(!reopened.has_metadata_value_digests());
        assert_eq!(reopened.lookup_metadata(&entry.key), Ok(Some(entry)));
    }

    #[test]
    fn damaged_or_wrongly_bound_checkpoint_is_rejected() {
        let checkpoint = BlockCheckpoint::create(
            MemoryStorage::default(),
            [1; 32],
            [2; 32],
            72 + 200 * 4096,
            201,
            entries(),
        )
        .unwrap();
        let storage = checkpoint.into_storage();
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                [3; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: storage.bytes.clone(),
                    ..MemoryStorage::default()
                },
                [1; 32],
                [3; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        let mut damaged = storage.bytes.clone();
        damaged[HEADER_BYTES + 100 * RECORD_BYTES + 5] ^= 1;
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: damaged,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
        let mut truncated = storage.bytes;
        truncated.pop();
        assert!(matches!(
            BlockCheckpoint::open(
                MemoryStorage {
                    bytes: truncated,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096
            ),
            Err(Errno::EIO)
        ));
    }

    #[test]
    fn unsorted_entries_and_failed_flush_cannot_publish_a_checkpoint() {
        let mut unsorted = entries();
        unsorted.swap(0, 1);
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage::default(),
                [1; 32],
                [2; 32],
                72 + 200 * 4096,
                201,
                unsorted
            ),
            Err(Errno::EINVAL)
        ));
        assert!(matches!(
            BlockCheckpoint::create(
                MemoryStorage {
                    fail_flush: true,
                    ..MemoryStorage::default()
                },
                [1; 32],
                [2; 32],
                72 + 200 * 4096,
                201,
                entries()
            ),
            Err(Errno::EIO)
        ));
    }
}
