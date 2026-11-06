use crate::{IoBuffer, kandelo_image_fs::BlockSource};
use core::cell::RefCell;
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

pub const DATA_BYTES: usize = 64 * 1024;
pub const INDEX_BYTES: usize = 4096;
pub const HEADER_BYTES: usize = 128;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum IntegrityPolicy {
    Crc32c = 1,
    Sha256 = 2,
}

impl IntegrityPolicy {
    fn digest_bytes(self) -> usize {
        match self {
            Self::Crc32c => 4,
            Self::Sha256 => 32,
        }
    }

    fn fanout(self) -> usize {
        INDEX_BYTES / self.digest_bytes()
    }

    fn decode(value: u32) -> Result<Self, Errno> {
        match value {
            1 => Ok(Self::Crc32c),
            2 => Ok(Self::Sha256),
            _ => Err(Errno::EINVAL),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CacheConfig {
    data_pages: usize,
    index_pages: usize,
}

impl CacheConfig {
    pub const CONSTRAINED: Self = Self {
        data_pages: 2,
        index_pages: 2,
    };
    pub const DESKTOP: Self = Self {
        data_pages: 8,
        index_pages: 8,
    };

    pub fn new(data_pages: usize, index_pages: usize) -> Result<Self, Errno> {
        if !(1..=64).contains(&data_pages) || !(1..=64).contains(&index_pages) {
            return Err(Errno::EINVAL);
        }
        Ok(Self {
            data_pages,
            index_pages,
        })
    }

    pub fn payload_limit(self) -> usize {
        self.data_pages * DATA_BYTES + self.index_pages * INDEX_BYTES
    }

    pub fn from_host_limits(data_pages: usize, index_pages: usize) -> Result<Self, Errno> {
        if data_pages == 0 && index_pages == 0 {
            return Ok(Self::automatic_for_io_limit(crate::io_buffer::IO_MEMORY.usage().1));
        }
        Self::new(data_pages, index_pages)
    }

    fn automatic_for_io_limit(io_limit: usize) -> Self {
        let payload_budget = io_limit / 16;
        let index_pages = (payload_budget / (16 * INDEX_BYTES)).clamp(1, 4);
        let data_pages = (payload_budget.saturating_sub(index_pages * INDEX_BYTES) / DATA_BYTES)
            .clamp(1, 16);
        Self { data_pages, index_pages }
    }
}

mod checksum;
use checksum::Checksum;
const MAX_LEVELS: usize = 8;
const MAGIC: &[u8; 8] = b"KDIIMG1\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Level {
    offset: u64,
    entries: u64,
    nodes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    policy: IntegrityPolicy,
    payload_length: u64,
    physical_length: u64,
    levels: [Level; MAX_LEVELS],
    level_count: usize,
}

impl Layout {
    pub fn new(payload_length: u64, policy: IntegrityPolicy) -> Result<Self, Errno> {
        if payload_length == 0 {
            return Err(Errno::EINVAL);
        }
        let mut entries = payload_length.div_ceil(DATA_BYTES as u64);
        let mut offset = (HEADER_BYTES as u64)
            .checked_add(payload_length)
            .ok_or(Errno::EINVAL)?;
        let mut levels = [Level {
            offset: 0,
            entries: 0,
            nodes: 0,
        }; MAX_LEVELS];
        let mut level_count = 0;
        loop {
            if level_count == MAX_LEVELS {
                return Err(Errno::EINVAL);
            }
            let nodes = entries.div_ceil(policy.fanout() as u64);
            levels[level_count] = Level {
                offset,
                entries,
                nodes,
            };
            offset = offset
                .checked_add(nodes.checked_mul(INDEX_BYTES as u64).ok_or(Errno::EINVAL)?)
                .ok_or(Errno::EINVAL)?;
            level_count += 1;
            if nodes == 1 {
                break;
            }
            entries = nodes;
        }
        Ok(Self {
            policy,
            payload_length,
            physical_length: offset,
            levels,
            level_count,
        })
    }

    pub fn physical_length(&self) -> u64 {
        self.physical_length
    }

    fn node_entries(&self, level: usize, node: u64) -> Result<usize, Errno> {
        let geometry = self
            .levels
            .get(level)
            .filter(|_| level < self.level_count)
            .ok_or(Errno::EIO)?;
        if node >= geometry.nodes {
            return Err(Errno::EIO);
        }
        Ok(
            (geometry.entries - node * self.policy.fanout() as u64).min(self.policy.fanout() as u64)
                as usize,
        )
    }

    fn node_offset(&self, level: usize, node: u64) -> Result<u64, Errno> {
        self.node_entries(level, node)?;
        self.levels[level]
            .offset
            .checked_add(node.checked_mul(INDEX_BYTES as u64).ok_or(Errno::EIO)?)
            .ok_or(Errno::EIO)
    }

    fn block_length(&self, block: u64) -> Result<usize, Errno> {
        let offset = block.checked_mul(DATA_BYTES as u64).ok_or(Errno::EIO)?;
        if offset >= self.payload_length {
            return Err(Errno::EIO);
        }
        Ok((self.payload_length - offset).min(DATA_BYTES as u64) as usize)
    }

    fn encode(&self, root: [u8; 32]) -> ([u8; HEADER_BYTES], [u8; 32]) {
        let mut header = [0u8; HEADER_BYTES];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&1u32.to_le_bytes());
        header[12..16].copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
        header[16..24].copy_from_slice(&self.payload_length.to_le_bytes());
        header[24..28].copy_from_slice(&(DATA_BYTES as u32).to_le_bytes());
        header[28..32].copy_from_slice(&(self.policy.fanout() as u32).to_le_bytes());
        header[32..40].copy_from_slice(&(HEADER_BYTES as u64).to_le_bytes());
        header[40..48].copy_from_slice(&self.levels[0].offset.to_le_bytes());
        header[48..56]
            .copy_from_slice(&(self.physical_length - self.levels[0].offset).to_le_bytes());
        header[56..60].copy_from_slice(&(self.level_count as u32).to_le_bytes());
        header[60..64].copy_from_slice(&(self.policy as u32).to_le_bytes());
        header[64..96].copy_from_slice(&root);
        let mut hash = Sha256::new();
        hash.update(b"Kandelo image header v1\0");
        hash.update(&header[..96]);
        let identity: [u8; 32] = hash.finalize().into();
        header[96..].copy_from_slice(&identity);
        (header, identity)
    }

    fn decode(
        header: &[u8; HEADER_BYTES],
        physical_length: u64,
        expected: [u8; 32],
    ) -> Result<(Self, [u8; 32]), Errno> {
        let payload_length =
            u64::from_le_bytes(header[16..24].try_into().map_err(|_| Errno::EINVAL)?);
        let policy = IntegrityPolicy::decode(u32::from_le_bytes(
            header[60..64].try_into().map_err(|_| Errno::EINVAL)?,
        ))?;
        let layout = Self::new(payload_length, policy)?;
        if layout.physical_length != physical_length {
            return Err(Errno::EIO);
        }
        if header[64 + policy.digest_bytes()..96]
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(Errno::EIO);
        }
        let root = header[64..96].try_into().map_err(|_| Errno::EINVAL)?;
        let (canonical, identity) = layout.encode(root);
        if canonical != *header || identity != expected {
            return Err(Errno::EIO);
        }
        Ok((layout, root))
    }
}

fn leaf_hasher(policy: IntegrityPolicy, length: usize) -> Checksum {
    let mut hash = Checksum::new(policy);
    hash.update(b"Kandelo image data v1\0");
    hash.update((length as u32).to_le_bytes());
    hash
}

fn leaf_digest(policy: IntegrityPolicy, bytes: &[u8]) -> [u8; 32] {
    let mut hash = leaf_hasher(policy, bytes.len());
    hash.update(bytes);
    hash.finalize().into()
}

fn zero_digest(policy: IntegrityPolicy, length: usize) -> [u8; 32] {
    let mut hash = leaf_hasher(policy, length);
    let zeros = [0u8; 1024];
    let mut remaining = length;
    while remaining > 0 {
        let count = remaining.min(zeros.len());
        hash.update(&zeros[..count]);
        remaining -= count;
    }
    hash.finalize().into()
}

fn index_digest(policy: IntegrityPolicy, level: usize, entries: usize, bytes: &[u8]) -> [u8; 32] {
    let mut hash = Checksum::new(policy);
    hash.update(b"Kandelo image index v1\0");
    hash.update((level as u32).to_le_bytes());
    hash.update((entries as u32).to_le_bytes());
    hash.update(bytes);
    hash.finalize().into()
}

pub trait PositionedImageWriter {
    fn get_size(&self) -> Result<u64, Errno>;
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno>;
    fn set_size(&mut self, length: u64) -> Result<(), Errno>;
    fn flush(&mut self) -> Result<(), Errno>;
}

impl<Target: PositionedImageWriter + ?Sized> PositionedImageWriter for &mut Target {
    fn get_size(&self) -> Result<u64, Errno> {
        (**self).get_size()
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        (**self).write_all_at(offset, bytes)
    }
    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        (**self).set_size(length)
    }
    fn flush(&mut self) -> Result<(), Errno> {
        (**self).flush()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageIdentity {
    pub payload_length: u64,
    pub physical_length: u64,
    pub digest: [u8; 32],
}

pub struct ImageBuilder<Target: PositionedImageWriter> {
    target: Target,
    layout: Layout,
    position: u64,
    leaf: Option<Checksum>,
    leaf_filled: usize,
    pending: IoBuffer<u8>,
    counts: [usize; MAX_LEVELS],
    nodes: [u64; MAX_LEVELS],
    root: Option<[u8; 32]>,
    full_zero: Option<[u8; 32]>,
    failed: bool,
}

impl<Target: PositionedImageWriter> ImageBuilder<Target> {
    pub fn begin(length: u64, policy: IntegrityPolicy, mut target: Target) -> Result<Self, Errno> {
        let layout = Layout::new(length, policy)?;
        if target.get_size()? != 0 {
            return Err(Errno::EINVAL);
        }
        let pending = IoBuffer::try_filled(INDEX_BYTES * layout.level_count, 0)?;
        target.write_all_at(0, &[0; HEADER_BYTES])?;
        Ok(Self {
            target,
            layout,
            position: 0,
            leaf: None,
            leaf_filled: 0,
            pending,
            counts: [0; MAX_LEVELS],
            nodes: [0; MAX_LEVELS],
            root: None,
            full_zero: None,
            failed: false,
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), Errno> {
        if self.failed
            || bytes.is_empty()
            || bytes.len() > DATA_BYTES
            || bytes.len() as u64 > self.layout.payload_length - self.position
        {
            return Err(Errno::EINVAL);
        }
        let result = (|| {
            self.target
                .write_all_at(HEADER_BYTES as u64 + self.position, bytes)?;
            let mut consumed = 0;
            while consumed < bytes.len() {
                let length = self
                    .layout
                    .block_length(self.position / DATA_BYTES as u64)?;
                let count = (bytes.len() - consumed).min(length - self.leaf_filled);
                self.leaf
                    .get_or_insert_with(|| leaf_hasher(self.layout.policy, length))
                    .update(&bytes[consumed..consumed + count]);
                self.position += count as u64;
                self.leaf_filled += count;
                consumed += count;
                if self.leaf_filled == length {
                    let hash = self.leaf.take().ok_or(Errno::EIO)?;
                    self.leaf_filled = 0;
                    self.append_digest(0, hash.finalize().into())?;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    pub fn push_zeroes(&mut self, mut length: u64) -> Result<(), Errno> {
        if self.failed || length == 0 || length > self.layout.payload_length - self.position {
            return Err(Errno::EINVAL);
        }
        let result = (|| {
            while length > 0 {
                let block_length = self
                    .layout
                    .block_length(self.position / DATA_BYTES as u64)?;
                if self.leaf_filled == 0 && length >= block_length as u64 {
                    let digest = if block_length == DATA_BYTES {
                        *self
                            .full_zero
                            .get_or_insert_with(|| zero_digest(self.layout.policy, DATA_BYTES))
                    } else {
                        zero_digest(self.layout.policy, block_length)
                    };
                    self.position += block_length as u64;
                    length -= block_length as u64;
                    self.append_digest(0, digest)?;
                } else {
                    let zeros = [0u8; 1024];
                    let count = length
                        .min(zeros.len() as u64)
                        .min((block_length - self.leaf_filled) as u64)
                        as usize;
                    self.leaf
                        .get_or_insert_with(|| leaf_hasher(self.layout.policy, block_length))
                        .update(&zeros[..count]);
                    self.position += count as u64;
                    self.leaf_filled += count;
                    length -= count as u64;
                    if self.leaf_filled == block_length {
                        let hash = self.leaf.take().ok_or(Errno::EIO)?;
                        self.leaf_filled = 0;
                        self.append_digest(0, hash.finalize().into())?;
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn append_digest(&mut self, level: usize, digest: [u8; 32]) -> Result<(), Errno> {
        if level >= self.layout.level_count || self.counts[level] >= self.layout.policy.fanout() {
            return Err(Errno::EIO);
        }
        let width = self.layout.policy.digest_bytes();
        let start = level * INDEX_BYTES + self.counts[level] * width;
        self.pending[start..start + width].copy_from_slice(&digest[..width]);
        self.counts[level] += 1;
        if self.counts[level] == self.layout.policy.fanout() {
            self.flush_level(level)?;
        }
        Ok(())
    }

    fn flush_level(&mut self, level: usize) -> Result<(), Errno> {
        let entries = self.layout.node_entries(level, self.nodes[level])?;
        if self.counts[level] != entries {
            return Err(Errno::EIO);
        }
        let offset = self.layout.node_offset(level, self.nodes[level])?;
        let page = &mut self.pending[level * INDEX_BYTES..(level + 1) * INDEX_BYTES];
        self.target.write_all_at(offset, page)?;
        let digest = index_digest(self.layout.policy, level, entries, page);
        page.fill(0);
        self.counts[level] = 0;
        self.nodes[level] += 1;
        if level + 1 == self.layout.level_count {
            if self.root.replace(digest).is_some() {
                return Err(Errno::EIO);
            }
        } else {
            self.append_digest(level + 1, digest)?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<ImageIdentity, Errno> {
        if self.failed || self.position != self.layout.payload_length || self.leaf.is_some() {
            return Err(Errno::EINVAL);
        }
        for level in 0..self.layout.level_count {
            if self.counts[level] != 0 {
                self.flush_level(level)?;
            }
            if self.nodes[level] != self.layout.levels[level].nodes {
                return Err(Errno::EIO);
            }
        }
        let root = self.root.ok_or(Errno::EIO)?;
        let (header, digest) = self.layout.encode(root);
        self.target.set_size(self.layout.physical_length)?;
        self.target.write_all_at(0, &header)?;
        self.target.flush()?;
        Ok(ImageIdentity {
            payload_length: self.layout.payload_length,
            physical_length: self.layout.physical_length,
            digest,
        })
    }
}

struct CachedPage<Key> {
    key: Option<Key>,
    bytes: IoBuffer<u8>,
}

struct ReadCache {
    data: IoBuffer<CachedPage<u64>>,
    index: IoBuffer<CachedPage<(usize, u64)>>,
}

fn prepare_cache_page<Key>(pages: &mut [CachedPage<Key>], length: usize) -> Result<(), Errno> {
    if !pages[0].bytes.is_empty() {
        return Ok(());
    }
    match IoBuffer::try_filled(length, 0) {
        Ok(bytes) => pages[0].bytes = bytes,
        Err(Errno::ENOMEM) => {
            let victim = pages
                .iter()
                .position(|page| !page.bytes.is_empty())
                .ok_or(Errno::ENOMEM)?;
            pages.swap(0, victim);
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

impl ReadCache {
    fn discard(&mut self) -> usize {
        let mut released = 0;
        for page in self.data.iter_mut() {
            released += page.bytes.capacity();
            page.key = None;
            page.bytes = IoBuffer::new();
        }
        for page in self.index.iter_mut() {
            released += page.bytes.capacity();
            page.key = None;
            page.bytes = IoBuffer::new();
        }
        released
    }

    fn new(config: CacheConfig) -> Result<Self, Errno> {
        let mut data = IoBuffer::try_with_capacity(config.data_pages)?;
        for _ in 0..config.data_pages {
            data.push(CachedPage {
                key: None,
                bytes: IoBuffer::new(),
            });
        }
        let mut index = IoBuffer::try_with_capacity(config.index_pages)?;
        for _ in 0..config.index_pages {
            index.push(CachedPage {
                key: None,
                bytes: IoBuffer::new(),
            });
        }
        Ok(Self { data, index })
    }

    fn ensure_index<Source: BlockSource>(
        &mut self,
        image: &VerifiedImage<Source>,
        level: usize,
        node: u64,
    ) -> Result<usize, Errno> {
        image.layout.node_entries(level, node)?;
        if let Some(position) = self
            .index
            .iter()
            .position(|page| page.key == Some((level, node)))
        {
            self.index[position..].rotate_left(1);
            return Ok(self.index.len() - 1);
        }
        let expected = if level + 1 == image.layout.level_count {
            image.root
        } else {
            let parent =
                self.ensure_index(image, level + 1, node / image.layout.policy.fanout() as u64)?;
            let width = image.layout.policy.digest_bytes();
            let start = (node % image.layout.policy.fanout() as u64) as usize * width;
            let mut digest = [0; 32];
            digest[..width].copy_from_slice(&self.index[parent].bytes[start..start + width]);
            if self.index.iter().all(|page| page.key.is_some()) {
                self.index[..=parent].rotate_right(1);
            }
            digest
        };
        prepare_cache_page(&mut self.index, INDEX_BYTES)?;
        self.index[0].key = None;
        image.source.read_exact_at(
            image.layout.node_offset(level, node)?,
            &mut self.index[0].bytes,
        )?;
        let entries = image.layout.node_entries(level, node)?;
        if self.index[0].bytes[entries * image.layout.policy.digest_bytes()..]
            .iter()
            .any(|byte| *byte != 0)
            || index_digest(image.layout.policy, level, entries, &self.index[0].bytes) != expected
        {
            return Err(Errno::EIO);
        }
        self.index[0].key = Some((level, node));
        self.index.rotate_left(1);
        Ok(self.index.len() - 1)
    }

    fn ensure_data<Source: BlockSource>(
        &mut self,
        image: &VerifiedImage<Source>,
        block: u64,
    ) -> Result<usize, Errno> {
        if let Some(position) = self.data.iter().position(|page| page.key == Some(block)) {
            self.data[position..].rotate_left(1);
            return Ok(self.data.len() - 1);
        }
        let width = image.layout.policy.digest_bytes();
        let fanout = image.layout.policy.fanout() as u64;
        let node = self.ensure_index(image, 0, block / fanout)?;
        let start = (block % fanout) as usize * width;
        let mut expected = [0; 32];
        expected[..width].copy_from_slice(&self.index[node].bytes[start..start + width]);
        let length = image.layout.block_length(block)?;
        prepare_cache_page(&mut self.data, DATA_BYTES)?;
        self.data[0].key = None;
        let offset = HEADER_BYTES as u64 + block * DATA_BYTES as u64;
        image
            .source
            .read_exact_at(offset, &mut self.data[0].bytes[..length])?;
        if leaf_digest(image.layout.policy, &self.data[0].bytes[..length]) != expected {
            return Err(Errno::EIO);
        }
        self.data[0].key = Some(block);
        self.data.rotate_left(1);
        Ok(self.data.len() - 1)
    }
}

pub struct VerifiedImage<Source> {
    source: Source,
    layout: Layout,
    root: [u8; 32],
    identity: [u8; 32],
    cache: RefCell<ReadCache>,
}

impl<Source: BlockSource> VerifiedImage<Source> {
    pub fn open(
        source: Source,
        expected: [u8; 32],
        cache_config: CacheConfig,
    ) -> Result<Self, Errno> {
        let mut header = [0; HEADER_BYTES];
        source.read_exact_at(0, &mut header)?;
        let (layout, root) = Layout::decode(&header, source.len(), expected)?;
        Ok(Self {
            source,
            layout,
            root,
            identity: expected,
            cache: RefCell::new(ReadCache::new(cache_config)?),
        })
    }

    pub fn identity(&self) -> [u8; 32] {
        self.identity
    }
    pub fn binding(&self) -> ImageIdentity {
        ImageIdentity {
            payload_length: self.layout.payload_length,
            physical_length: self.layout.physical_length,
            digest: self.identity,
        }
    }
    pub fn payload_length(&self) -> u64 {
        self.layout.payload_length
    }
    pub fn policy(&self) -> IntegrityPolicy {
        self.layout.policy
    }

    pub fn discard_read_caches(&self) -> Result<usize, Errno> {
        Ok(self
            .cache
            .try_borrow_mut()
            .map_err(|_| Errno::EBUSY)?
            .discard())
    }

    pub fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if self.source.len() != self.layout.physical_length
            || offset
                .checked_add(destination.len() as u64)
                .filter(|end| *end <= self.layout.payload_length)
                .is_none()
        {
            return Err(Errno::EIO);
        }
        let mut cache = self.cache.try_borrow_mut().map_err(|_| Errno::EIO)?;
        let mut done = 0;
        while done < destination.len() {
            let position = offset + done as u64;
            let block = position / DATA_BYTES as u64;
            let within = (position % DATA_BYTES as u64) as usize;
            let page = cache.ensure_data(self, block)?;
            let count = (destination.len() - done).min(self.layout.block_length(block)? - within);
            destination[done..done + count]
                .copy_from_slice(&cache.data[page].bytes[within..within + count]);
            done += count;
        }
        Ok(())
    }
}

impl<Source: BlockSource> BlockSource for VerifiedImage<Source> {
    fn len(&self) -> u64 {
        self.payload_length()
    }
    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        self.read_exact_at(offset, destination)
    }
}

#[cfg(test)]
mod tests;
