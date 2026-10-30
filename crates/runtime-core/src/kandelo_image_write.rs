//! Writer for the on-disk KIFS (Kandelo Image File System) image body.
//!
//! `kandelo_image_fs.rs` is the reader: it mounts the real 249 MiB `/` image
//! and serves every base file's bytes out of it. This module is its inverse —
//! it BUILDS that body from a tree, so the kernel can emit a VFS image without
//! a TypeScript writer in the loop.
//!
//! # Why this is a port and not a fresh design
//!
//! The image body is a real block filesystem, and an image the kernel writes
//! must be readable by everything that reads images today. So the layout
//! decisions here are not free: they reproduce the TypeScript filesystem that
//! originally defined the format (vendored into the host as
//! `sharedfs-vendor.ts`, since deleted; "the vendor" below means that writer)
//! — the same superblock geometry, the same
//! first-fit block and inode allocators, the same ext2-style variable-length
//! directory records with padding entries and `rec_len` extension, and the
//! same threshold above which that file's in-process directory index changes
//! where a new record lands. Reproducing the allocator is what made the
//! cross-language fixtures (committed under `testdata/`, produced by that
//! writer) a BYTE comparison rather than a "both sides parse" comparison, and
//! a byte comparison is the only one that would catch a writer that is merely
//! self-consistent.
//!
//! # Why emission is a cursor, not a `Vec<u8>`
//!
//! `lamp.vfs` is 249 MiB and the kernel cannot hold an image in linear memory.
//! So the writer never materializes file CONTENT: a data block that carries
//! file bytes is recorded as a reference into a [`ContentSource`]
//! (`id` + offset + length) and resolved only when [`KandeloImage::read_at`]
//! reaches it. What IS materialized is metadata — superblock, occupied bitmap
//! and inode-table pages, directory data, indirect blocks — which for
//! the largest image in the repo is a few MiB, the same order as the budget
//! the reader already spends walking one.
//!
//! [`KandeloImage::read_at`] has the same offset-addressed shape as
//! `rootfs::export_tree_read(offset, out)`, so streaming emission
//! (`rootfs::export_image_read`) layers on top of this without redesigning the
//! layout pass, and without a new host import.

use alloc::vec;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use crate::io_buffer::{IoBuffer, IO_MEMORY};
use crate::prepared_map::{MapMemory, PreparedEntry, PreparedMap};

use crate::kandelo_image_fs::{
    BlockSource, DIRECT_BLOCKS, DIRENT_HEADER, INLINE_SYMLINK_SIZE, INO_ATIME, INO_CTIME,
    INO_DIRECT, INO_DOUBLE_INDIRECT, INO_GENERATION, INO_GID, INO_INDIRECT, INO_LINK_COUNT,
    INO_MODE, INO_MTIME, INO_SIZE, INO_TRIPLE_INDIRECT, INO_UID, INODE_SIZE, INODES_PER_BLOCK,
    MAX_FILE_BLOCKS, PTRS_PER_BLOCK, ROOT_INO, V1_MAX_FILE_BLOCKS, KANDELO_IMAGE_MAGIC,
    KANDELO_IMAGE_VERSION, KANDELO_IMAGE_EXTENDED_VERSION,
};

const BLOCK_SIZE: usize = 4096;
const DEFERRED_FINISH_HEADROOM: usize = 256 * 1024;

// Superblock field offsets. The reader needs only two of these; the writer
// fills every one the vendor's `mkfs` fills, so the images agree field for
// field and not merely on the fields a reader happens to consult.
const SB_MAGIC: usize = 0;
const SB_VERSION: usize = 4;
const SB_BLOCK_SIZE: usize = 8;
const SB_TOTAL_BLOCKS: usize = 12;
const SB_TOTAL_INODES: usize = 16;
const SB_FREE_BLOCKS: usize = 20;
const SB_FREE_INODES: usize = 24;
const SB_INODE_BITMAP_START: usize = 28;
const SB_BLOCK_BITMAP_START: usize = 32;
const SB_INODE_TABLE_START: usize = 36;
const SB_DATA_START: usize = 40;
const SB_INODE_BITMAP_BLOCKS: usize = 44;
const SB_BLOCK_BITMAP_BLOCKS: usize = 48;
const SB_INODE_TABLE_BLOCKS: usize = 52;
const SB_GENERATION: usize = 56;
/// Inode holding the deferred-file section ("SDEF"), or 0 when the image
/// declares no deferred files.
///
/// The section is stored as an ordinary inode's data — it needs block
/// addressing, growth and indirect blocks, and the format already has all
/// three for files, so this reuses `inode_block_map`, the allocator, and both
/// readers verbatim instead of adding a second way to address blocks. The
/// inode is deliberately unlinked: no directory entry points at it, so it is
/// invisible to every path lookup and every directory walk.
///
/// A consistency checker must consult THIS FIELD before judging reachability.
/// An unlinked inode with `nlink = 1` looks like a leak to a checker that only
/// walks directories, and the reason it is not one is that the superblock
/// names it. That is why the field exists rather than, say, a flag on the
/// inode: reachability is decided from the superblock, which a checker reads
/// first, so the inode can never be silently reclaimed as garbage.
const SB_DEFERRED_INODE: usize = 76;
const SB_MAX_SIZE_BLOCKS: usize = 68;
const SB_GROW_CHUNK_BLOCKS: usize = 72;

/// Inode fields the reader does not expose but that are part of the image.
///
/// `INO_DIR_SEQUENCE` and `INO_DATA_SEQUENCE` are live counters in the vendor
/// filesystem, and `snapshotBytes` does NOT clear them — they are image bytes.
/// A writer that left them zero would produce an image that differs from the
/// TypeScript writer's in a field no reader checks, which is exactly the kind
/// of drift a byte fixture exists to catch.
const INO_DIR_SEQUENCE: usize = 116;
const INO_DATA_SEQUENCE: usize = 120;

/// Mirrors the vendor's `DIR_INDEX_MIN_SIZE`. At and above this directory
/// size the TypeScript writer switches to an in-process index whose free-slot
/// policy differs from the linear scan (see [`KandeloImageWriter::dir_add_entry`]).
const DIR_INDEX_MIN_SIZE: u64 = 64 * 1024;

#[derive(Clone, Copy, Default)]
struct DirectorySpace {
    remaining: u16,
    unoccupied: bool,
}

pub(crate) struct DirectorySizeCounter {
    size: u64,
    spaces: [DirectorySpace; DIR_INDEX_MIN_SIZE as usize / BLOCK_SIZE],
    space_count: usize,
    indexed: bool,
}

impl DirectorySizeCounter {
    pub(crate) fn new() -> Self {
        Self {
            size: (align4(DIRENT_HEADER + 1) + align4(DIRENT_HEADER + 2)) as u64,
            spaces: [DirectorySpace::default(); DIR_INDEX_MIN_SIZE as usize / BLOCK_SIZE],
            space_count: 0,
            indexed: false,
        }
    }

    pub(crate) fn push(&mut self, name_len: usize) -> Result<(), Errno> {
        if name_len == 0 || name_len > 255 {
            return Err(Errno::ENAMETOOLONG);
        }
        let needed = align4(DIRENT_HEADER + name_len) as u16;
        if !self.indexed && self.size >= DIR_INDEX_MIN_SIZE {
            let mut retained = 0;
            for index in 0..self.space_count {
                if self.spaces[index].unoccupied {
                    self.spaces[retained] = self.spaces[index];
                    retained += 1;
                }
            }
            self.space_count = retained;
            self.indexed = true;
        }
        let available = &self.spaces[..self.space_count];
        let chosen = if self.indexed {
            available.iter().rposition(|space| space.remaining >= needed)
        } else {
            available.iter().position(|space| space.remaining >= needed)
        };
        if let Some(index) = chosen {
            if self.indexed {
                self.spaces.copy_within(index + 1..self.space_count, index);
                self.space_count -= 1;
            } else {
                self.spaces[index].remaining -= needed;
                self.spaces[index].unoccupied = false;
            }
            return Ok(());
        }
        let offset = (self.size % BLOCK_SIZE as u64) as usize;
        if offset != 0 && offset + usize::from(needed) > BLOCK_SIZE {
            let gap = BLOCK_SIZE - offset;
            if !self.indexed && gap >= DIRENT_HEADER {
                let space = self.spaces.get_mut(self.space_count).ok_or(Errno::EIO)?;
                *space = DirectorySpace { remaining: gap as u16, unoccupied: true };
                self.space_count += 1;
            }
            self.size = self.size.checked_add(gap as u64).ok_or(Errno::EFBIG)?;
        }
        self.size = self.size.checked_add(u64::from(needed)).ok_or(Errno::EFBIG)?;
        Ok(())
    }

    pub(crate) fn size(&self) -> u64 {
        self.size
    }
}

const GROW_CHUNK_BLOCKS: u32 = 256;

const S_IFMT: u32 = 0xf000;
const S_IFREG: u32 = 0x8000;
const S_IFDIR: u32 = 0x4000;
const S_IFLNK: u32 = 0xa000;
const S_IFIFO: u32 = 0x1000;
const S_IFSOCK: u32 = 0xc000;
const S_ISUID: u32 = 0o4000;
const S_ISGID: u32 = 0o2000;

const MAX_NAME: usize = 255;

pub(crate) const V1_MAX_FILE_BYTES: u64 = V1_MAX_FILE_BLOCKS * BLOCK_SIZE as u64;
pub(crate) const MAX_FILE_BYTES: u64 = MAX_FILE_BLOCKS * BLOCK_SIZE as u64;

fn align4(x: usize) -> usize {
    (x + 3) & !3
}

/// Byte source for file CONTENT that the writer refuses to buffer.
///
/// `id` is the caller's own handle for one file's bytes; the writer never
/// interprets it. The kernel will pass an inode number and read out of the
/// image it already has mounted; a test passes an index into a table of
/// slices.
pub trait ContentSource {
    fn read_exact_at(&self, id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;
}

/// A [`ContentSource`] for images built entirely from [`Content::Bytes`].
pub struct NoContent;

impl ContentSource for NoContent {
    fn read_exact_at(&self, _id: u64, _offset: u64, _dst: &mut [u8]) -> Result<(), Errno> {
        Err(Errno::EIO)
    }
}

/// Where one file's bytes come from.
pub enum Content<'a> {
    /// Bytes the writer copies into materialized blocks. Correct for small
    /// files; a 249 MiB image must not be built this way.
    Bytes(&'a [u8]),
    /// Bytes the writer records a reference to and reads only at emission.
    Deferred { id: u64, len: u64 },
    SparseDeferred {
        id: u64,
        len: u64,
        blocks: &'a [u32],
    },
}

impl Content<'_> {
    fn len(&self) -> u64 {
        match self {
            Content::Bytes(b) => b.len() as u64,
            Content::Deferred { len, .. } | Content::SparseDeferred { len, .. } => *len,
        }
    }
}

#[derive(Clone, Copy)]
struct ContentExtent {
    blocks: u32,
    id: u64,
    offset: u64,
    last_len: u32,
}

#[derive(Clone)]
struct PointerRun {
    start: u16,
    len: u16,
    first: u32,
    stride: u32,
}

enum PointerPage {
    Runs(IoBuffer<PointerRun>),
    Bytes(IoBuffer<u8>),
}

impl Default for PointerPage {
    fn default() -> Self { Self::Runs(IoBuffer::new()) }
}

impl MapMemory for PointerPage {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

impl MapMemory for ContentExtent {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

fn prepare_image_entry<Value: MapMemory>(key: u32, value: Value) -> Result<PreparedEntry<u32, Value>, Errno> {
    let reservation = PreparedEntry::<u32, Value>::reserve_in(&IO_MEMORY, 0)?;
    PreparedEntry::new_reserved_in(&IO_MEMORY, key, value, reservation)
}

impl PointerPage {
    fn get(&self, slot: u16) -> u32 {
        match self {
            Self::Bytes(bytes) => r32(bytes, usize::from(slot) * 4),
            Self::Runs(runs) => {
                let Some(index) = runs.partition_point(|run| run.start <= slot).checked_sub(1)
                    else { return 0 };
                let run = &runs[index];
                if slot - run.start >= run.len { return 0; }
                run.first + u32::from(slot - run.start) * run.stride
            }
        }
    }

    fn set(&mut self, slot: u16, value: u32) -> Result<(), Errno> {
        if u32::from(slot) >= PTRS_PER_BLOCK || value == 0 || self.get(slot) != 0 {
            return Err(Errno::EIO);
        }
        if let Self::Runs(runs) = self {
            if let Some(last) = runs.last_mut() {
                if slot == last.start + last.len {
                    let stride = if last.len == 1 { value.checked_sub(last.first) }
                        else { Some(last.stride) };
                    if let Some(stride) = stride {
                        if stride.checked_mul(u32::from(last.len))
                            .and_then(|offset| last.first.checked_add(offset)) == Some(value)
                        {
                            last.stride = stride;
                            last.len += 1;
                            return Ok(());
                        }
                    }
                }
            }
            if runs.len() < 64 && runs.last().is_none_or(|last| slot >= last.start + last.len) {
                runs.try_push(PointerRun { start: slot, len: 1, first: value, stride: 0 })?;
                return Ok(());
            }
            let mut bytes = allocate_image_bytes(BLOCK_SIZE)?;
            for run in runs.iter() {
                for index in 0..run.len {
                    w32(&mut bytes, usize::from(run.start + index) * 4,
                        run.first + u32::from(index) * run.stride);
                }
            }
            *self = Self::Bytes(bytes);
        }
        let Self::Bytes(bytes) = self else { return Err(Errno::EIO) };
        w32(bytes, usize::from(slot) * 4, value);
        Ok(())
    }

    fn read_at(&self, offset: usize, destination: &mut [u8]) {
        if let Self::Bytes(bytes) = self {
            destination.copy_from_slice(&bytes[offset..offset + destination.len()]);
            return;
        }
        let mut done = 0;
        while done < destination.len() {
            let position = offset + done;
            let word = self.get((position / 4) as u16).to_le_bytes();
            let within = position % 4;
            let count = core::cmp::min(4 - within, destination.len() - done);
            destination[done..done + count].copy_from_slice(&word[within..within + count]);
            done += count;
        }
    }

    fn resident_bytes(&self) -> usize {
        match self {
            Self::Runs(runs) => runs.capacity() * core::mem::size_of::<PointerRun>(),
            Self::Bytes(bytes) => bytes.capacity(),
        }
    }
}

fn content_block(extents: &PreparedMap<u32, ContentExtent>, phys: u32) -> Option<(u64, u64, u32)> {
    let (&start, extent) = extents.at_or_before(&phys)?;
    let block = phys - start;
    if block >= extent.blocks {
        return None;
    }
    let offset = extent.offset + block as u64 * BLOCK_SIZE as u64;
    let len = if block + 1 == extent.blocks {
        extent.last_len
    } else {
        BLOCK_SIZE as u32
    };
    Some((extent.id, offset, len))
}

/// One free (deleted or padding) directory record the vendor's directory
/// index remembers.
#[derive(Clone, Copy)]
struct FreeSlot {
    phys: u32,
    off: u16,
    rec_len: u16,
}

/// Geometry and sizing, mirroring the vendor's `mkfs(buffer, maxSizeBytes)`.
pub struct KandeloImageConfig {
    /// Initial image length in bytes. Must be a multiple of `BLOCK_SIZE` and
    /// at least 16 blocks, matching the vendor's own floor.
    pub size_bytes: u64,
    /// The vendor's `maxSizeBytes`. `None` means "four times the initial
    /// size", which is what the vendor computes when the argument is omitted.
    /// This drives inode count and bitmap sizing, so it changes the LAYOUT
    /// even for an image that never grows.
    pub max_size_bytes: Option<u64>,
    /// How far the backing store may actually grow. In TypeScript this is a
    /// property of the `SharedArrayBuffer`, not of `mkfs`: a fixed-length SAB
    /// makes every `grow()` fail with `ENOSPC` no matter what
    /// `max_size_bytes` says. Set it equal to `size_bytes` to model that.
    pub growable_to_bytes: u64,
    /// Value written to every inode's atime/mtime/ctime as it is created.
    /// [`KandeloImageConfig::fixed`] defaults it to Kandelo's reference
    /// instant ([`wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS`]), never
    /// 0: software reads 0 as "no timestamp" (opcache will not cache such a
    /// file). The cross-language fixtures pin it to 0 explicitly to match
    /// `snapshotBytes({ normalizeTimestampsMs: 0 })`.
    pub now_ms: u64,
}

impl KandeloImageConfig {
    /// A non-growable image of `size_bytes` with the vendor's default maximum.
    pub fn fixed(size_bytes: u64) -> KandeloImageConfig {
        KandeloImageConfig {
            size_bytes,
            max_size_bytes: None,
            growable_to_bytes: size_bytes,
            now_ms: wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS,
        }
    }
}

pub struct KandeloImageWriter {
    version: u32,
    total_blocks: u32,
    max_blocks: u32,
    total_inodes: u32,
    inode_bitmap_start: u32,
    block_bitmap_start: u32,
    inode_table_start: u32,
    data_start: u32,
    inode_bitmap_blocks: u32,
    block_bitmap_blocks: u32,
    inode_table_blocks: u32,
    free_blocks: u32,
    free_inodes: u32,
    generation: u32,
    growable_to_blocks: u32,
    now_ms: u64,

    inode_table: crate::io_buffer::IoBuffer<u8>,
    blocks: PreparedMap<u32, IoBuffer<u8>>,
    pointer_blocks: PreparedMap<u32, PointerPage>,
    content_extents: PreparedMap<u32, ContentExtent>,
    dir_indexes: PreparedMap<u32, IoBuffer<FreeSlot>>,
    /// Whether this writer states its deferred files in-body even when there
    /// are none. Set by [`Self::declare_deferred_section`]; see
    /// [`Self::emit_deferred_section`] for why it is not the default.
    declares_deferred: bool,
    deferred: PreparedMap<u32, crate::sdef::DeferredRecord>,
    deferred_field_bytes: usize,
    deferred_finish_credit: Option<crate::metadata_budget::MetadataReservation<'static>>,
    /// Archives the deferred records may point at. Declared separately from the
    /// records because an archive's LENGTH is per-archive, not per-member, and
    /// because a record naming an undeclared archive must be refusable.
    deferred_archives: PreparedMap<u32, crate::sdef::DeferredArchive>,
}

impl MapMemory for crate::sdef::DeferredRecord {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        self.source_path.capacity().checked_add(self.uri.capacity())
            .and_then(|bytes| bytes.checked_add(self.payload.capacity())).ok_or(Errno::ENOMEM)
    }
}

impl MapMemory for crate::sdef::DeferredArchive {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        self.uri.capacity().checked_add(self.payload.capacity()).ok_or(Errno::ENOMEM)
    }
}

fn copy_deferred_fields<const COUNT: usize>(
    sources: [&[u8]; COUNT],
    reservation: &crate::metadata_budget::MetadataReservation<'static>,
) -> Result<[Vec<u8>; COUNT], Errno> {
    let length = sources.iter().try_fold(0usize, |length, source|
        length.checked_add(<[u8]>::len(source)).ok_or(Errno::ENOMEM))?;
    if !core::ptr::eq(reservation.budget(), &IO_MEMORY)
        || reservation.bytes() < length.checked_mul(2).ok_or(Errno::ENOMEM)? { return Err(Errno::EIO); }
    let mut copies = core::array::from_fn(|_| Vec::new());
    for (source, copy) in sources.iter().zip(copies.iter_mut()) {
        *copy = crate::sdef::copy_metadata_bytes(source)?;
    }
    Ok(copies)
}

fn w32(buf: &mut [u8], off: usize, value: u32) {
    buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
}

fn allocate_image_bytes(length: usize) -> Result<crate::io_buffer::IoBuffer<u8>, Errno> {
    crate::io_buffer::IoBuffer::allocate(length, false, |bytes| {
        bytes.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
        bytes.resize(length, 0);
        Ok(())
    })
}

fn w64(buf: &mut [u8], off: usize, value: u64) {
    buf[off..off + 8].copy_from_slice(&value.to_le_bytes());
}

fn w16(buf: &mut [u8], off: usize, value: u16) {
    buf[off..off + 2].copy_from_slice(&value.to_le_bytes());
}

fn r32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn r64(buf: &[u8], off: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&buf[off..off + 8]);
    u64::from_le_bytes(a)
}

fn r16(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}

impl KandeloImageWriter {
    /// Format an empty filesystem. Mirrors the vendor's `SharedFS.mkfs`,
    /// including its "grow the buffer if the metadata does not fit" step.
    pub fn mkfs(config: KandeloImageConfig) -> Result<KandeloImageWriter, Errno> {
        Self::mkfs_with_inode_capacity(config, None)
    }

    pub fn mkfs_with_inode_capacity(
        config: KandeloImageConfig,
        inode_capacity: Option<u32>,
    ) -> Result<KandeloImageWriter, Errno> {
        let size_bytes = config.size_bytes;
        if size_bytes % BLOCK_SIZE as u64 != 0 {
            // The vendor tolerates a ragged tail because a SharedArrayBuffer
            // can be any length; a kernel-side writer chooses its own length,
            // so refuse the ambiguity rather than silently dropping bytes.
            return Err(Errno::EINVAL);
        }
        if size_bytes < (BLOCK_SIZE * 16) as u64 {
            return Err(Errno::EINVAL);
        }

        let mut total_blocks =
            u32::try_from(size_bytes / BLOCK_SIZE as u64).map_err(|_| Errno::EINVAL)?;
        let max_blocks = match config.max_size_bytes {
            Some(max) => u32::try_from(max / BLOCK_SIZE as u64).map_err(|_| Errno::EINVAL)?,
            None => total_blocks.checked_mul(4).ok_or(Errno::EINVAL)?,
        };
        let total_inodes = match inode_capacity {
            Some(capacity) if capacity <= ROOT_INO => return Err(Errno::EINVAL),
            Some(capacity) => capacity,
            None => core::cmp::max(32, max_blocks / 4).div_ceil(INODES_PER_BLOCK) * INODES_PER_BLOCK,
        };

        let inode_bitmap_blocks = total_inodes.div_ceil(BLOCK_SIZE as u32 * 8);
        let block_bitmap_blocks = max_blocks.div_ceil(BLOCK_SIZE as u32 * 8);
        let inode_table_blocks =
            ((total_inodes as u64 * INODE_SIZE as u64).div_ceil(BLOCK_SIZE as u64)) as u32;

        let inode_bitmap_start = 1;
        let block_bitmap_start = inode_bitmap_start + inode_bitmap_blocks;
        let inode_table_start = block_bitmap_start + block_bitmap_blocks;
        let data_start = inode_table_start + inode_table_blocks;

        let growable_to_blocks = u32::try_from(config.growable_to_bytes / BLOCK_SIZE as u64)
            .map_err(|_| Errno::EINVAL)?;

        if data_start >= total_blocks {
            // Same recovery the vendor performs: a growable filesystem sizes
            // its bitmaps for the configured maximum, which can need more
            // metadata blocks than a deliberately small initial buffer holds.
            let minimum_blocks = data_start + 1;
            if minimum_blocks > growable_to_blocks {
                return Err(Errno::ENOSPC);
            }
            total_blocks = minimum_blocks;
        }
        if u64::from(total_blocks) > u64::from(block_bitmap_blocks) * BLOCK_SIZE as u64 * 8 {
            return Err(Errno::EINVAL);
        }

        let mut writer = KandeloImageWriter {
            version: KANDELO_IMAGE_VERSION,
            total_blocks,
            max_blocks,
            total_inodes,
            inode_bitmap_start,
            block_bitmap_start,
            inode_table_start,
            data_start,
            inode_bitmap_blocks,
            block_bitmap_blocks,
            inode_table_blocks,
            free_blocks: total_blocks - data_start,
            free_inodes: total_inodes - 2,
            generation: 0,
            growable_to_blocks: growable_to_blocks.max(total_blocks),
            now_ms: config.now_ms,
            inode_table: allocate_image_bytes(BLOCK_SIZE)?,
            blocks: PreparedMap::default(),
            pointer_blocks: PreparedMap::default(),
            content_extents: PreparedMap::default(),
            dir_indexes: PreparedMap::default(),
            declares_deferred: false,
            deferred: PreparedMap::default(),
            deferred_field_bytes: 0,
            deferred_finish_credit: None,
            deferred_archives: PreparedMap::default(),
        };

        // Root inode: an empty directory holding only "." and "..".
        let root_off = writer.inode_offset(ROOT_INO);
        w32(&mut writer.inode_table, root_off + INO_MODE, S_IFDIR | 0o755);
        w32(&mut writer.inode_table, root_off + INO_LINK_COUNT, 2);
        w64(&mut writer.inode_table, root_off + INO_GENERATION, 1);

        let root_block = writer.block_alloc()?;
        w32(&mut writer.inode_table, root_off + INO_DIRECT, root_block);
        writer.write_dot_entries(root_block, ROOT_INO, ROOT_INO)?;
        let dot_size = (align4(DIRENT_HEADER + 1) + align4(DIRENT_HEADER + 2)) as u64;
        w64(&mut writer.inode_table, root_off + INO_SIZE, dot_size);

        writer.generation = 1;
        Ok(writer)
    }

    pub fn root(&self) -> u32 {
        ROOT_INO
    }

    // ── Region accessors ─────────────────────────────────────────────

    /// Byte offset of `ino` WITHIN the inode table region (not within the
    /// image). The reader's `inode_offset` is image-absolute; this one is
    /// region-relative because the writer keeps the table as its own buffer.
    fn inode_offset(&self, ino: u32) -> usize {
        (ino / INODES_PER_BLOCK) as usize * BLOCK_SIZE
            + (ino % INODES_PER_BLOCK) as usize * INODE_SIZE
    }

    fn ino_r32(&self, ino: u32, field: usize) -> u32 {
        r32(&self.inode_table, self.inode_offset(ino) + field)
    }

    fn ino_r64(&self, ino: u32, field: usize) -> u64 {
        r64(&self.inode_table, self.inode_offset(ino) + field)
    }

    fn ino_w32(&mut self, ino: u32, field: usize, value: u32) {
        let off = self.inode_offset(ino) + field;
        w32(&mut self.inode_table, off, value);
    }

    fn ino_w64(&mut self, ino: u32, field: usize, value: u64) {
        let off = self.inode_offset(ino) + field;
        w64(&mut self.inode_table, off, value);
    }

    /// Materialize `phys` so metadata can be written into it. A block that is
    /// already a content reference is a writer bug, not a runtime condition.
    fn block_mut(&mut self, phys: u32, required: usize) -> Result<&mut IoBuffer<u8>, Errno> {
        if phys < self.data_start || phys >= self.total_blocks || required == 0 || required > BLOCK_SIZE {
            return Err(Errno::EIO);
        }
        if content_block(&self.content_extents, phys).is_some() || self.pointer_blocks.contains_key(&phys) {
            return Err(Errno::EIO);
        }
        if !self.blocks.contains_key(&phys) {
            let block = allocate_image_bytes(required)?;
            let entry = prepare_image_entry(phys, block)?;
            self.blocks.insert_prepared(entry);
        }
        let block = self.blocks.get_mut(&phys).ok_or(Errno::EIO)?;
        if required > block.capacity() {
            let capacity = block.capacity().saturating_mul(2).max(required).min(BLOCK_SIZE);
            block.reserve_with(capacity, |bytes| bytes.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))?;
        }
        if required > block.len() { block.resize(required, 0); }
        Ok(block)
    }

    fn block_r16(&self, phys: u32, off: usize) -> u16 {
        self.blocks.get(&phys).filter(|block| off + 2 <= block.len()).map_or(0, |block| r16(block, off))
    }

    fn block_r32(&self, phys: u32, off: usize) -> u32 {
        self.blocks.get(&phys).filter(|block| off + 4 <= block.len()).map_or(0, |block| r32(block, off))
    }

    fn pointer_r32(&self, phys: u32, off: usize) -> u32 {
        self.pointer_blocks.get(&phys).map_or(0, |page| page.get((off / 4) as u16))
    }

    fn pointer_w32(&mut self, phys: u32, off: usize, value: u32) -> Result<(), Errno> {
        if phys < self.data_start || phys >= self.total_blocks || off % 4 != 0 || off >= BLOCK_SIZE
            || self.blocks.contains_key(&phys) || content_block(&self.content_extents, phys).is_some()
        {
            return Err(Errno::EIO);
        }
        if let Some(page) = self.pointer_blocks.get_mut(&phys) {
            return page.set((off / 4) as u16, value);
        }
        let mut page = PointerPage::default();
        page.set((off / 4) as u16, value)?;
        let entry = prepare_image_entry(phys, page)?;
        self.pointer_blocks.insert_prepared(entry);
        Ok(())
    }

    // ── Allocators ───────────────────────────────────────────────────

    /// The writer never frees: the vendor's first-fit rotating hint always
    /// allocates the next block in a contiguous prefix. Its end is exactly
    /// total minus free blocks, so bitmap bytes can be generated on export
    /// without retaining a bit for every allocation.
    fn block_alloc_no_grow(&mut self) -> Option<u32> {
        if self.free_blocks == 0 {
            return None;
        }
        let block = self.total_blocks - self.free_blocks;
        self.free_blocks -= 1;
        Some(block)
    }

    /// The vendor's `grow()`: one chunk at a time up to `max_blocks`, bumping
    /// the superblock generation. It fails when the backing store cannot
    /// actually be extended, which is what a fixed-length buffer means.
    fn grow(&mut self) -> Result<(), Errno> {
        if self.free_blocks > 0 {
            return Ok(());
        }
        let current = self.total_blocks;
        let mut grow_by = GROW_CHUNK_BLOCKS;
        let mut new_total = current.saturating_add(grow_by);
        if new_total > self.max_blocks {
            new_total = self.max_blocks;
            grow_by = new_total.saturating_sub(current);
            if grow_by == 0 {
                return Err(Errno::ENOSPC);
            }
        }
        if new_total > self.growable_to_blocks {
            return Err(Errno::ENOSPC);
        }
        self.total_blocks = new_total;
        self.free_blocks += grow_by;
        self.generation += 1;
        Ok(())
    }

    fn block_alloc(&mut self) -> Result<u32, Errno> {
        if let Some(b) = self.block_alloc_no_grow() {
            return Ok(b);
        }
        self.grow()?;
        self.block_alloc_no_grow().ok_or(Errno::ENOSPC)
    }

    fn prepare_inode_slot(&mut self, reserve_section: bool) -> Result<(), Errno> {
        let trailing = u32::from(reserve_section);
        if self.free_inodes <= trailing {
            return Err(Errno::ENOSPC);
        }
        let ino = (self.total_inodes - self.free_inodes).checked_add(trailing).ok_or(Errno::ENOMEM)?;
        let length = (self.inode_offset(ino) / BLOCK_SIZE + 1) * BLOCK_SIZE;
        if length > self.inode_table.capacity() {
            let capacity = self.inode_table.capacity().checked_mul(2)
                .ok_or(Errno::ENOMEM)?.max(length);
            let reserve = |table: &mut IoBuffer<u8>, capacity| table.reserve_with(capacity, |bytes| {
                bytes.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
            });
            match reserve(&mut self.inode_table, capacity) {
                Err(Errno::ENOMEM) if capacity > length => reserve(&mut self.inode_table, length)?,
                result => result?,
            }
        }
        Ok(())
    }

    fn inode_alloc(&mut self) -> Result<u32, Errno> {
        self.prepare_inode_slot(self.declares_deferred || !self.deferred.is_empty())?;
        let ino = self.total_inodes - self.free_inodes;
        let off = self.inode_offset(ino);
        let length = (off / BLOCK_SIZE + 1) * BLOCK_SIZE;
        if length > self.inode_table.len() { self.inode_table.resize(length, 0); }
        self.free_inodes -= 1;
        self.inode_table[off..off + INODE_SIZE].fill(0);
        // The vendor's `nextInodeGeneration` is `Atomics.add(gen, 1) + 1`:
        // the counter and the new inode's generation end up equal.
        self.generation += 1;
        let generation = self.generation;
        w64(&mut self.inode_table, off + INO_GENERATION, generation as u64);
        Ok(ino)
    }

    // ── Block map ────────────────────────────────────────────────────

    fn inode_block_map(&mut self, ino: u32, file_block: u32, allocate: bool) -> Result<u32, Errno> {
        let ino_off = self.inode_offset(ino);
        if file_block < DIRECT_BLOCKS {
            let slot = ino_off + INO_DIRECT + file_block as usize * 4;
            let ptr = r32(&self.inode_table, slot);
            if ptr != 0 {
                return Ok(ptr);
            }
            if !allocate {
                return Ok(0);
            }
            let blk = self.block_alloc()?;
            w32(&mut self.inode_table, slot, blk);
            return Ok(blk);
        }

        let file_block = file_block - DIRECT_BLOCKS;
        if file_block < PTRS_PER_BLOCK {
            let mut ind = r32(&self.inode_table, ino_off + INO_INDIRECT);
            if ind == 0 {
                if !allocate {
                    return Ok(0);
                }
                ind = self.block_alloc()?;
                w32(&mut self.inode_table, ino_off + INO_INDIRECT, ind);
            }
            let ptr_off = file_block as usize * 4;
            let ptr = self.pointer_r32(ind, ptr_off);
            if ptr != 0 {
                return Ok(ptr);
            }
            if !allocate {
                return Ok(0);
            }
            let blk = self.block_alloc()?;
            self.pointer_w32(ind, ptr_off, blk)?;
            return Ok(blk);
        }

        let file_block = file_block - PTRS_PER_BLOCK;
        if (file_block as u64) < PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64 {
            let idx1 = file_block / PTRS_PER_BLOCK;
            let idx2 = file_block % PTRS_PER_BLOCK;

            let mut dind = r32(&self.inode_table, ino_off + INO_DOUBLE_INDIRECT);
            if dind == 0 {
                if !allocate {
                    return Ok(0);
                }
                dind = self.block_alloc()?;
                w32(&mut self.inode_table, ino_off + INO_DOUBLE_INDIRECT, dind);
            }
            let l1_off = idx1 as usize * 4;
            let mut l1 = self.pointer_r32(dind, l1_off);
            if l1 == 0 {
                if !allocate {
                    return Ok(0);
                }
                l1 = self.block_alloc()?;
                self.pointer_w32(dind, l1_off, l1)?;
            }
            let l2_off = idx2 as usize * 4;
            let ptr = self.pointer_r32(l1, l2_off);
            if ptr != 0 {
                return Ok(ptr);
            }
            if !allocate {
                return Ok(0);
            }
            let blk = self.block_alloc()?;
            self.pointer_w32(l1, l2_off, blk)?;
            return Ok(blk);
        }

        let file_block = file_block as u64 - PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;
        if file_block >= MAX_FILE_BLOCKS - V1_MAX_FILE_BLOCKS {
            return Err(Errno::EINVAL);
        }
        let pointers = PTRS_PER_BLOCK as u64;
        let top_index = (file_block / (pointers * pointers)) as usize * 4;
        let middle_index = ((file_block / pointers) % pointers) as usize * 4;
        let leaf_index = (file_block % pointers) as usize * 4;
        let mut triple = r32(&self.inode_table, ino_off + INO_TRIPLE_INDIRECT);
        if triple == 0 {
            if !allocate {
                return Ok(0);
            }
            triple = self.block_alloc()?;
            w32(&mut self.inode_table, ino_off + INO_TRIPLE_INDIRECT, triple);
        }
        let mut middle = self.pointer_r32(triple, top_index);
        if middle == 0 {
            if !allocate {
                return Ok(0);
            }
            middle = self.block_alloc()?;
            self.pointer_w32(triple, top_index, middle)?;
        }
        let mut leaf = self.pointer_r32(middle, middle_index);
        if leaf == 0 {
            if !allocate {
                return Ok(0);
            }
            leaf = self.block_alloc()?;
            self.pointer_w32(middle, middle_index, leaf)?;
        }
        let pointer = self.pointer_r32(leaf, leaf_index);
        if pointer != 0 || !allocate {
            return Ok(pointer);
        }
        let block = self.block_alloc()?;
        self.pointer_w32(leaf, leaf_index, block)?;
        Ok(block)
    }

    // ── Directory records ────────────────────────────────────────────

    fn write_dot_entries(&mut self, phys: u32, self_ino: u32, parent_ino: u32) -> Result<(), Errno> {
        let dot = align4(DIRENT_HEADER + 1);
        let dotdot = align4(DIRENT_HEADER + 2);
        let block = self.block_mut(phys, dot + dotdot)?;
        w32(block, 0, self_ino);
        w16(block, 4, dot as u16);
        w16(block, 6, 1);
        block[DIRENT_HEADER] = b'.';
        w32(block, dot, parent_ino);
        w16(block, dot + 4, dotdot as u16);
        w16(block, dot + 6, 2);
        block[dot + DIRENT_HEADER] = b'.';
        block[dot + DIRENT_HEADER + 1] = b'.';
        Ok(())
    }

    fn touch_directory_mutation(&mut self, dir_ino: u32) {
        let now = self.now_ms;
        self.ino_w64(dir_ino, INO_MTIME, now);
        self.ino_w64(dir_ino, INO_CTIME, now);
        let seq = self.ino_r32(dir_ino, INO_DIR_SEQUENCE).wrapping_add(1);
        self.ino_w32(dir_ino, INO_DIR_SEQUENCE, seq);
    }

    fn write_dir_record(
        &mut self,
        phys: u32,
        off: usize,
        child_ino: u32,
        rec_len: Option<u16>,
        name: &[u8],
    ) -> Result<(), Errno> {
        let block = self.block_mut(phys, off + DIRENT_HEADER + name.len())?;
        w32(block, off, child_ino);
        if let Some(rec_len) = rec_len {
            w16(block, off + 4, rec_len);
        }
        w16(block, off + 6, name.len() as u16);
        block[off + DIRENT_HEADER..off + DIRENT_HEADER + name.len()].copy_from_slice(name);
        Ok(())
    }

    /// The vendor's `findLastDirEntryInBlock`, returning `(phys, off)`.
    fn find_last_dir_entry_in_block(
        &mut self,
        dir_ino: u32,
        file_block: u32,
        end_off: usize,
    ) -> Result<Option<(u32, usize)>, Errno> {
        let phys = self.inode_block_map(dir_ino, file_block, false)?;
        if phys == 0 {
            return Ok(None);
        }
        let mut off = 0usize;
        let mut last = None;
        while off < end_off {
            let rec_len = self.block_r16(phys, off + 4) as usize;
            if rec_len < DIRENT_HEADER || rec_len % 4 != 0 || off + rec_len > end_off {
                return Ok(None);
            }
            last = Some(off);
            off += rec_len;
        }
        if off == end_off {
            Ok(last.map(|o| (phys, o)))
        } else {
            Ok(None)
        }
    }

    /// The vendor's `dirAppendEntry`. `last_ent` is the caller's already-known
    /// final record, which only matters when the tail gap is too small to hold
    /// a padding record and the previous record's `rec_len` must absorb it.
    fn dir_append_entry(
        &mut self,
        dir_ino: u32,
        name: &[u8],
        child_ino: u32,
        mut last_ent: Option<(u32, usize)>,
    ) -> Result<(), Errno> {
        let dir_size = self.ino_r64(dir_ino, INO_SIZE);
        let needed = align4(DIRENT_HEADER + name.len());

        let mut append_pos = dir_size;
        let mut file_block = (append_pos / BLOCK_SIZE as u64) as u32;
        let mut block_off = (append_pos % BLOCK_SIZE as u64) as usize;
        let mut reserved_phys = 0u32;

        if block_off != 0 && block_off + needed > BLOCK_SIZE {
            let gap = BLOCK_SIZE - block_off;
            let mut pad_phys = 0u32;
            if gap >= DIRENT_HEADER {
                pad_phys = self.inode_block_map(dir_ino, file_block, false)?;
                if pad_phys == 0 {
                    return Err(Errno::EIO);
                }
            } else {
                if last_ent.is_none() {
                    last_ent = self.find_last_dir_entry_in_block(dir_ino, file_block, block_off)?;
                }
                if last_ent.is_none() {
                    return Err(Errno::EIO);
                }
            }

            // Reserve the destination block BEFORE editing the old tail, so a
            // failed allocation leaves the directory byte-for-byte unchanged.
            reserved_phys = self.inode_block_map(dir_ino, file_block + 1, true)?;
            self.block_mut(reserved_phys, DIRENT_HEADER + name.len())?;

            if gap >= DIRENT_HEADER {
                let block = self.block_mut(pad_phys, block_off + DIRENT_HEADER)?;
                w32(block, block_off, 0);
                w16(block, block_off + 4, gap as u16);
                w16(block, block_off + 6, 0);
            } else {
                let (phys, off) = last_ent.ok_or(Errno::EIO)?;
                let new_rec_len = self.block_r16(phys, off + 4) + gap as u16;
                w16(self.block_mut(phys, off + 6)?, off + 4, new_rec_len);
            }
            append_pos = (file_block as u64 + 1) * BLOCK_SIZE as u64;
            file_block += 1;
            block_off = 0;
        }

        let phys = if block_off == 0 {
            if reserved_phys != 0 {
                reserved_phys
            } else {
                self.inode_block_map(dir_ino, file_block, true)?
            }
        } else {
            let p = self.inode_block_map(dir_ino, file_block, false)?;
            if p == 0 {
                return Err(Errno::EIO);
            }
            p
        };

        self.write_dir_record(phys, block_off, child_ino, Some(needed as u16), name)?;
        self.ino_w64(dir_ino, INO_SIZE, append_pos + needed as u64);
        self.touch_directory_mutation(dir_ino);
        Ok(())
    }

    /// Build the vendor's directory index if this directory has reached the
    /// threshold. Returns whether an index is in force.
    ///
    /// Faithfulness note: the vendor rebuilds only when its cached index is
    /// stale, and every mutation keeps the cache in sync, so an index built
    /// once is never rebuilt. Padding records created AFTER the index exists
    /// are therefore invisible to it and never reused — which is exactly why
    /// this cannot be modelled as "always rescan".
    fn ensure_dir_index(&mut self, dir_ino: u32) -> Result<bool, Errno> {
        if self.dir_indexes.contains_key(&dir_ino) {
            return Ok(true);
        }
        let dir_size = self.ino_r64(dir_ino, INO_SIZE);
        if dir_size < DIR_INDEX_MIN_SIZE {
            return Ok(false);
        }
        let mut free = IoBuffer::new();
        let mut pos = 0u64;
        while pos < dir_size {
            let file_block = (pos / BLOCK_SIZE as u64) as u32;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let phys = self.inode_block_map(dir_ino, file_block, false)?;
            if phys == 0 {
                return Err(Errno::EIO);
            }
            let mut remain = (dir_size - pos) as usize;
            if remain > BLOCK_SIZE - block_off {
                remain = BLOCK_SIZE - block_off;
            }
            let mut off = block_off;
            while off < block_off + remain {
                let ent_ino = self.block_r32(phys, off);
                let rec_len = self.block_r16(phys, off + 4) as usize;
                let name_len = self.block_r16(phys, off + 6) as usize;
                if rec_len < DIRENT_HEADER
                    || rec_len % 4 != 0
                    || off + rec_len > block_off + remain
                    || name_len > rec_len - DIRENT_HEADER
                {
                    return Err(Errno::EIO);
                }
                if ent_ino == 0 && rec_len >= DIRENT_HEADER {
                    free.try_push(FreeSlot {
                        phys,
                        off: off as u16,
                        rec_len: rec_len as u16,
                    })?;
                }
                off += rec_len;
            }
            pos += remain as u64;
        }
        let entry = prepare_image_entry(dir_ino, free)?;
        self.dir_indexes.insert_prepared(entry);
        Ok(true)
    }

    /// The vendor's `useDirIndexFreeSlot`: scan the remembered free records
    /// from the END, drop each candidate as it is considered, and re-verify it
    /// against the bytes on disk before using it.
    fn use_dir_index_free_slot(
        &mut self,
        dir_ino: u32,
        name: &[u8],
        child_ino: u32,
    ) -> Result<bool, Errno> {
        let needed = align4(DIRENT_HEADER + name.len());
        loop {
            let candidate = {
                let free = self.dir_indexes.get(&dir_ino).ok_or(Errno::EIO)?;
                free.iter().enumerate().rev()
                    .find(|(_, slot)| usize::from(slot.rec_len) >= needed)
                    .map(|(index, slot)| (index, *slot))
            };
            let Some((index, slot)) = candidate else {
                return Ok(false);
            };
            if self.block_r32(slot.phys, slot.off as usize) != 0
                || self.block_r16(slot.phys, slot.off as usize + 4) != slot.rec_len
            {
                self.dir_indexes.get_mut(&dir_ino).ok_or(Errno::EIO)?.remove(index);
                continue;
            }
            self.block_mut(slot.phys, usize::from(slot.off) + DIRENT_HEADER + name.len())?;
            self.dir_indexes.get_mut(&dir_ino).ok_or(Errno::EIO)?.remove(index);
            self.write_dir_record(slot.phys, slot.off as usize, child_ino, None, name)?;
            self.touch_directory_mutation(dir_ino);
            return Ok(true);
        }
    }

    /// The vendor's `dirAddEntry`.
    fn dir_add_entry(&mut self, dir_ino: u32, name: &[u8], child_ino: u32) -> Result<(), Errno> {
        if self.ensure_dir_index(dir_ino)? {
            if self.use_dir_index_free_slot(dir_ino, name, child_ino)? {
                return Ok(());
            }
            return self.dir_append_entry(dir_ino, name, child_ino, None);
        }

        let dir_size = self.ino_r64(dir_ino, INO_SIZE);
        let needed = align4(DIRENT_HEADER + name.len());
        let mut last_ent: Option<(u32, usize)> = None;

        let mut pos = 0u64;
        while pos < dir_size {
            let file_block = (pos / BLOCK_SIZE as u64) as u32;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let phys = self.inode_block_map(dir_ino, file_block, false)?;
            if phys == 0 {
                return Err(Errno::EIO);
            }
            let mut remain = (dir_size - pos) as usize;
            if remain > BLOCK_SIZE - block_off {
                remain = BLOCK_SIZE - block_off;
            }
            let mut off = block_off;
            while off < block_off + remain {
                let ent_ino = self.block_r32(phys, off);
                let rec_len = self.block_r16(phys, off + 4) as usize;
                let ent_name_len = self.block_r16(phys, off + 6) as usize;
                if rec_len < DIRENT_HEADER
                    || rec_len % 4 != 0
                    || off + rec_len > block_off + remain
                    || ent_name_len > rec_len - DIRENT_HEADER
                {
                    return Err(Errno::EIO);
                }

                if ent_ino == 0 && rec_len >= needed {
                    self.write_dir_record(phys, off, child_ino, None, name)?;
                    self.touch_directory_mutation(dir_ino);
                    return Ok(());
                }

                let actual_len = align4(DIRENT_HEADER + ent_name_len);
                let slack = rec_len - actual_len;
                if ent_ino != 0 && slack >= needed {
                    let new_off = off + actual_len;
                    self.block_mut(phys, new_off + DIRENT_HEADER + name.len())?;
                    w16(self.block_mut(phys, off + 6)?, off + 4, actual_len as u16);
                    self.write_dir_record(phys, new_off, child_ino, Some(slack as u16), name)?;
                    self.touch_directory_mutation(dir_ino);
                    return Ok(());
                }

                last_ent = Some((phys, off));
                off += rec_len;
            }
            pos += remain as u64;
        }

        self.dir_append_entry(dir_ino, name, child_ino, last_ent)
    }

    fn lookup(&mut self, dir_ino: u32, name: &[u8]) -> Result<Option<u32>, Errno> {
        let dir_size = self.ino_r64(dir_ino, INO_SIZE);
        let mut pos = 0u64;
        while pos < dir_size {
            let file_block = (pos / BLOCK_SIZE as u64) as u32;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let phys = self.inode_block_map(dir_ino, file_block, false)?;
            if phys == 0 {
                return Err(Errno::EIO);
            }
            let mut remain = (dir_size - pos) as usize;
            if remain > BLOCK_SIZE - block_off {
                remain = BLOCK_SIZE - block_off;
            }
            let mut off = block_off;
            while off < block_off + remain {
                let ent_ino = self.block_r32(phys, off);
                let rec_len = self.block_r16(phys, off + 4) as usize;
                let name_len = self.block_r16(phys, off + 6) as usize;
                if rec_len < DIRENT_HEADER || rec_len % 4 != 0 || off + rec_len > block_off + remain
                {
                    return Err(Errno::EIO);
                }
                if ent_ino != 0 && name_len == name.len() {
                    let matches = self.blocks.get(&phys).is_some_and(|block| {
                        &block[off + DIRENT_HEADER..off + DIRENT_HEADER + name_len] == name
                    });
                    if matches {
                        return Ok(Some(ent_ino));
                    }
                }
                off += rec_len;
            }
            pos += remain as u64;
        }
        Ok(None)
    }

    // ── Tree construction ────────────────────────────────────────────

    fn check_name(&self, name: &[u8]) -> Result<(), Errno> {
        if name.is_empty() || name == b"." || name == b".." || name.contains(&b'/') {
            return Err(Errno::EINVAL);
        }
        if name.len() > MAX_NAME {
            return Err(Errno::ENAMETOOLONG);
        }
        Ok(())
    }

    fn require_inode(&self, ino: u32) -> Result<(), Errno> {
        if ino == 0 || ino >= self.total_inodes - self.free_inodes {
            return Err(Errno::ENOENT);
        }
        Ok(())
    }

    fn require_dir(&self, ino: u32) -> Result<(), Errno> {
        self.require_inode(ino)?;
        if self.ino_r32(ino, INO_MODE) & S_IFMT != S_IFDIR {
            return Err(Errno::ENOTDIR);
        }
        Ok(())
    }

    fn precheck(&mut self, parent: u32, name: &[u8]) -> Result<(), Errno> {
        self.check_name(name)?;
        self.require_dir(parent)?;
        if self.lookup(parent, name)?.is_some() {
            return Err(Errno::EEXIST);
        }
        Ok(())
    }

    pub fn mkdir(&mut self, parent: u32, name: &[u8], mode: u32) -> Result<u32, Errno> {
        self.precheck(parent, name)?;
        let ino = self.inode_alloc()?;
        let now = self.now_ms;
        self.ino_w32(ino, INO_MODE, S_IFDIR | (mode & 0o7777));
        self.ino_w32(ino, INO_LINK_COUNT, 2);
        self.ino_w64(ino, INO_SIZE, 0);
        self.ino_w64(ino, INO_ATIME, now);
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);

        let blk = self.block_alloc()?;
        self.ino_w32(ino, INO_DIRECT, blk);
        self.write_dot_entries(blk, ino, parent)?;
        let dot_size = (align4(DIRENT_HEADER + 1) + align4(DIRENT_HEADER + 2)) as u64;
        self.ino_w64(ino, INO_SIZE, dot_size);

        self.dir_add_entry(parent, name, ino)?;
        let links = self.ino_r32(parent, INO_LINK_COUNT) + 1;
        self.ino_w32(parent, INO_LINK_COUNT, links);
        Ok(ino)
    }

    pub fn create_file(
        &mut self,
        parent: u32,
        name: &[u8],
        mode: u32,
        content: Content<'_>,
    ) -> Result<u32, Errno> {
        if content.len() > MAX_FILE_BYTES {
            return Err(Errno::EFBIG);
        }
        if let Content::SparseDeferred { len, blocks, .. } = &content {
            let mut previous = None;
            for &block in *blocks {
                if u64::from(block) >= len.div_ceil(BLOCK_SIZE as u64)
                    || previous.is_some_and(|previous| previous >= block)
                {
                    return Err(Errno::EINVAL);
                }
                previous = Some(block);
            }
        }
        self.precheck(parent, name)?;
        let ino = self.inode_alloc()?;
        let now = self.now_ms;
        self.ino_w32(ino, INO_MODE, S_IFREG | (mode & 0o7777));
        self.ino_w32(ino, INO_LINK_COUNT, 1);
        self.ino_w64(ino, INO_SIZE, 0);
        self.ino_w64(ino, INO_ATIME, now);
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        self.dir_add_entry(parent, name, ino)?;
        self.truncate_to_zero(ino);
        self.write_content(ino, content)?;
        Ok(ino)
    }

    pub fn create_sparse_file_from(
        &mut self,
        parent: u32,
        name: &[u8],
        mode: u32,
        id: u64,
        len: u64,
        mut allocations: impl FnMut(&mut dyn FnMut(u32) -> Result<(), Errno>) -> Result<(), Errno>,
    ) -> Result<u32, Errno> {
        if len > MAX_FILE_BYTES {
            return Err(Errno::EFBIG);
        }
        let mut previous = None;
        allocations(&mut |block| {
            if u64::from(block) >= len.div_ceil(BLOCK_SIZE as u64)
                || previous.is_some_and(|previous| previous >= block)
            {
                return Err(Errno::EINVAL);
            }
            previous = Some(block);
            Ok(())
        })?;
        let ino = self.create_file(parent, name, mode, Content::Bytes(&[]))?;
        if len == 0 {
            return Ok(ino);
        }
        if len > V1_MAX_FILE_BYTES {
            self.version = KANDELO_IMAGE_EXTENDED_VERSION;
        }
        previous = None;
        allocations(&mut |block| {
            if u64::from(block) >= len.div_ceil(BLOCK_SIZE as u64)
                || previous.is_some_and(|previous| previous >= block)
            {
                return Err(Errno::EINVAL);
            }
            previous = Some(block);
            let pos = u64::from(block) * BLOCK_SIZE as u64;
            let chunk = core::cmp::min(BLOCK_SIZE as u64, len - pos) as usize;
            let phys = self.inode_block_map(ino, block, true)?;
            self.defer_content_block(phys, id, pos, chunk)
        })?;
        self.finish_content(ino, len);
        Ok(ino)
    }

    pub fn mknod_special(
        &mut self,
        parent: u32,
        name: &[u8],
        mode: u32,
        type_bits: u32,
    ) -> Result<u32, Errno> {
        if type_bits != S_IFIFO && type_bits != S_IFSOCK {
            return Err(Errno::EINVAL);
        }
        self.precheck(parent, name)?;
        let ino = self.inode_alloc()?;
        let now = self.now_ms;
        self.ino_w32(ino, INO_MODE, type_bits | (mode & 0o7777));
        self.ino_w32(ino, INO_LINK_COUNT, 1);
        self.ino_w64(ino, INO_SIZE, 0);
        self.ino_w64(ino, INO_ATIME, now);
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        self.dir_add_entry(parent, name, ino)?;
        Ok(ino)
    }

    /// The data mutation every production image builder's `O_TRUNC` performs.
    ///
    /// This looks like dead work on a file that was just created at size
    /// zero, and it is not. The TypeScript image builders that produced every
    /// shipped image opened base files `O_WRONLY | O_CREAT | O_TRUNC`, and the
    /// vendor's `inodeTruncate(ino, 0, forceDataMutation =
    /// true)` bumps `INO_DATA_SEQUENCE` unconditionally under that flag —
    /// `sizeChanged` is false, but `forceDataMutation` is not. That counter
    /// is image state, not runtime state: `snapshotBytes` does not clear it.
    ///
    /// So every regular file in every image this repository has ever shipped
    /// carries one bump from the truncate plus one more if it was then
    /// written. A writer that skipped it would produce images that differ
    /// from today's in a field no reader consults — invisible until
    /// something compared two images and disagreed. The cross-language
    /// fixture caught exactly this.
    fn truncate_to_zero(&mut self, ino: u32) {
        self.ino_w64(ino, INO_SIZE, 0);
        let now = self.now_ms;
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        let seq = self.ino_r32(ino, INO_DATA_SEQUENCE).wrapping_add(1);
        self.ino_w32(ino, INO_DATA_SEQUENCE, seq);
    }

    /// Create a file whose CONTENTS the image does not carry.
    ///
    /// The body gets a real inode with real metadata and no data, and the
    /// deferred section gets a record saying how big the file actually is and
    /// carrying the opaque description of where to get it. One writer produces
    /// both, in one artifact, so they cannot disagree — which is the whole
    /// reason the record lives here rather than in a separate section written
    /// by somebody else.
    ///
    /// `payload` is never interpreted. See [`crate::sdef`].
    /// Declare a lazy archive that deferred records may point into, with the
    /// total byte length that bounds a whole-archive fetch.
    ///
    /// Declaring the same id twice is an error rather than a silent overwrite:
    /// two lengths for one archive is a writer bug, and the reader would have
    /// no way to tell which was meant.
    /// `uri` is where the archive is, and `digest` is the SHA-256 the fetched
    /// bytes must hash to. `payload` is what is left once those two come out:
    /// transport selection and activation mode, carried opaquely exactly as a
    /// deferred file's is.
    ///
    /// `digest` is empty or exactly [`crate::sdef::DIGEST_LEN`] bytes;
    /// empty records that the producer declared none. Empty rather than a
    /// zero-filled array so that "I have no digest" is something a caller
    /// states, not something it can arrive at by forgetting to fill a buffer.
    /// Whether a producer SHOULD have one is a policy question this layer does
    /// not answer.
    pub fn declare_lazy_archive(
        &mut self,
        archive_id: u32,
        bytes: u64,
        uri: &[u8],
        digest: &[u8],
        payload: &[u8],
    ) -> Result<(), Errno> {
        if archive_id == 0 {
            return Err(Errno::EINVAL);
        }
        if payload.len() > crate::sdef::MAX_PAYLOAD_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if uri.len() > crate::sdef::MAX_URI_LEN as usize {
            return Err(Errno::EINVAL);
        }
        let digest = crate::sdef::digest_from(digest)?;
        if self.deferred_archives.contains_key(&archive_id) {
            return Err(Errno::EINVAL);
        }
        let fields = uri.len().checked_add(payload.len()).ok_or(Errno::ENOMEM)?;
        let total_fields = self.reserve_deferred_metadata(false, fields)?;
        let progress = self.prepare_deferred_finish(self.deferred.len(), self.deferred_archives.len() + 1, total_fields)?;
        let credit = PreparedEntry::<u32, crate::sdef::DeferredArchive>::reserve_in(&IO_MEMORY, fields)?;
        let [uri, payload] = copy_deferred_fields([uri, payload], &credit)?;
        let entry = PreparedEntry::new_reserved_in(&IO_MEMORY, archive_id, crate::sdef::DeferredArchive {
                archive_id,
                bytes,
                uri,
                digest,
                payload,
            }, credit)?;
        self.deferred_archives.insert_prepared(entry);
        self.retain_deferred_finish(progress);
        self.deferred_field_bytes = total_fields;
        Ok(())
    }

    /// `archive_id`/`source_path` are the kernel-facing linkage: which lazy
    /// archive backs the file and which member within it. Pass `0` and `b""`
    /// for a file fetched standalone, where `uri` is the only way to find the
    /// bytes. The pair is all-or-nothing and [`crate::sdef::encode`]
    /// refuses a half-specified one, so a caller cannot record an archive with
    /// no member.
    ///
    /// `uri` addresses a STANDALONE file only; an archive member is addressed
    /// by its archive, and passing both is refused rather than ignored.
    /// `digest` is empty or [`crate::sdef::DIGEST_LEN`] bytes and
    /// covers the file's `size` bytes as they should land — the inflated
    /// member for an archive member, the fetched bytes for a standalone file.
    #[allow(clippy::too_many_arguments)]
    pub fn create_deferred_file(
        &mut self,
        parent: u32,
        name: &[u8],
        mode: u32,
        size: u64,
        archive_id: u32,
        source_path: &[u8],
        uri: &[u8],
        digest: &[u8],
        payload: &[u8],
    ) -> Result<u32, Errno> {
        if payload.len() > crate::sdef::MAX_PAYLOAD_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if source_path.len() > crate::sdef::MAX_SOURCE_PATH_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if uri.len() > crate::sdef::MAX_URI_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if archive_id != 0 && !uri.is_empty() {
            return Err(Errno::EINVAL);
        }
        let digest = crate::sdef::digest_from(digest)?;
        // Rejected at the call rather than at `finish`, so the caller that got
        // it wrong is the one that sees the error.
        if (archive_id == 0) != source_path.is_empty() {
            return Err(Errno::EINVAL);
        }
        let fields = uri.len().checked_add(payload.len())
            .and_then(|bytes| bytes.checked_add(source_path.len())).ok_or(Errno::ENOMEM)?;
        let total_fields = self.reserve_deferred_metadata(true, fields)?;
        let progress = self.prepare_deferred_finish(self.deferred.len() + 1, self.deferred_archives.len(), total_fields)?;
        let credit = PreparedEntry::<u32, crate::sdef::DeferredRecord>::reserve_in(&IO_MEMORY, fields)?;
        let [source_path, uri, payload] = copy_deferred_fields([source_path, uri, payload], &credit)?;
        let mut entry = PreparedEntry::new_reserved_in(&IO_MEMORY, self.deferred.len() as u32,
            crate::sdef::DeferredRecord {
                ino: 0,
                size,
                archive_id,
                source_path,
                uri,
                digest,
                payload,
            }, credit)?;
        self.prepare_inode_slot(true)?;
        let ino = self.create_file(parent, name, mode, Content::Bytes(b""))?;
        entry.value_mut().ino = ino;
        self.deferred.insert_prepared(entry);
        self.retain_deferred_finish(progress);
        self.deferred_field_bytes = total_fields;
        Ok(ino)
    }

    fn prepare_deferred_finish(&self, records: usize, archives: usize, fields: usize)
        -> Result<crate::metadata_budget::MetadataReservation<'static>, Errno>
    {
        let encoded = records.checked_mul(crate::sdef::RECORD_HEADER_SIZE as usize + 3)
            .and_then(|bytes| archives.checked_mul(crate::sdef::ARCHIVE_ENTRY_SIZE as usize + 3)
                .and_then(|archive_bytes| bytes.checked_add(archive_bytes)))
            .and_then(|bytes| bytes.checked_add(fields))
            .and_then(|bytes| bytes.checked_add(crate::sdef::HEADER_SIZE as usize)).ok_or(Errno::ENOMEM)?;
        let node_bytes = PreparedEntry::<u32, IoBuffer<u8>>::memory_bytes(0)?;
        let required = encoded.div_ceil(BLOCK_SIZE).checked_mul(node_bytes)
            .and_then(|bytes| bytes.checked_add(DEFERRED_FINISH_HEADROOM)).ok_or(Errno::ENOMEM)?;
        let held = self.deferred_finish_credit.as_ref().map_or(0, |credit| credit.bytes());
        IO_MEMORY.reserve(required.checked_sub(held).ok_or(Errno::EIO)?)
    }

    fn retain_deferred_finish(&mut self, credit: crate::metadata_budget::MetadataReservation<'static>) {
        match &mut self.deferred_finish_credit {
            Some(held) => held.merge(credit),
            None => self.deferred_finish_credit = Some(credit),
        }
    }

    fn reserve_deferred_metadata(&self, record: bool, fields: usize) -> Result<usize, Errno> {
        if (record && self.deferred.len() >= crate::sdef::MAX_RECORDS as usize)
            || (!record && self.deferred_archives.len() >= crate::sdef::MAX_ARCHIVES as usize)
        {
            return Err(Errno::EINVAL);
        }
        let record_count = self.deferred.len() + usize::from(record);
        let archive_count = self.deferred_archives.len() + usize::from(!record);
        let total_fields = self.deferred_field_bytes.checked_add(fields).ok_or(Errno::ENOMEM)?;
        let charge = record_count.checked_mul(crate::sdef::RECORD_RESIDENT_BYTES)
            .and_then(|bytes| archive_count.checked_mul(crate::sdef::ARCHIVE_RESIDENT_BYTES)
                .and_then(|archives| bytes.checked_add(archives)))
            .and_then(|bytes| bytes.checked_add(total_fields)).ok_or(Errno::ENOMEM)?;
        if charge > crate::sdef::METADATA_BUDGET_BYTES { return Err(Errno::ENOMEM); }
        Ok(total_fields)
    }

    /// Write the deferred section into an unlinked inode and name it in the
    /// superblock. Returns the inode, or 0 when nothing is deferred AND this
    /// writer has not been asked to declare the section regardless.
    ///
    /// # Why "nothing deferred" and "no section" are different statements
    ///
    /// `rootfs::load_image` refuses an image that declares neither `KLZY` nor
    /// `SDEF`, because it cannot tell "this image has no lazy files" from "this
    /// image records its lazy files only in the host-side JSON the kernel
    /// cannot read", and accepting the second builds a tree where every
    /// deferred file reports size 0 — a wrong tree that looks like a right one.
    ///
    /// An EMPTY section is therefore not a formality: it is the statement "this
    /// image was written by something that would have told you", and it is the
    /// difference between silence and an answer. It costs one inode and one
    /// block.
    ///
    /// It is opt-in rather than automatic because only a producer that really
    /// would have told you may make that statement, and the TypeScript writer
    /// this one is byte-compared against cannot. Emitting it unconditionally
    /// broke four `matches_the_typescript_writer` tests, which is the migration
    /// safety property saying so. See [`Self::declare_deferred_section`].
    /// State that this producer describes its deferred files in this image's
    /// body, so an image with none still carries an empty section rather than
    /// no section at all.
    ///
    /// Only a producer that would genuinely have written the records may say
    /// this. The kernel's own export may; a writer driven by a host that keeps
    /// its lazy manifest in JSON beside the image may not, because for that
    /// image "no section" is the truth and the loader is right to refuse it.
    pub fn declare_deferred_section(&mut self) -> Result<(), Errno> {
        if self.declares_deferred { return Ok(()); }
        let progress = self.prepare_deferred_finish(self.deferred.len(), self.deferred_archives.len(),
            self.deferred_field_bytes)?;
        self.prepare_inode_slot(false)?;
        self.retain_deferred_finish(progress);
        self.declares_deferred = true;
        Ok(())
    }

    fn emit_deferred_section(&mut self) -> Result<u32, Errno> {
        if self.deferred.is_empty() && !self.declares_deferred {
            self.deferred_archives.clear();
            drop(self.deferred_finish_credit.take());
            return Ok(0);
        }
        let length = crate::sdef::encoded_len(
            self.deferred_archives.values(),
            self.deferred.values(),
            |id| self.deferred_archives.contains_key(&id),
        )?;
        let mut records = core::mem::take(&mut self.deferred);
        let mut archives = core::mem::take(&mut self.deferred_archives);
        drop(self.deferred_finish_credit.take());
        let mut buffer = allocate_image_bytes(BLOCK_SIZE)?;
        self.declares_deferred = false;

        let ino = self.inode_alloc()?;
        let now = self.now_ms;
        // Mode 0: nothing may open it even if something contrives a path to
        // it. There is no such path — no directory entry references this
        // inode — but the permission bits should not be the only thing
        // standing between a guest and the image's own metadata.
        self.ino_w32(ino, INO_MODE, S_IFREG);
        // `nlink = 1` with no directory entry. See `SB_DEFERRED_INODE` for why
        // that is not a leak and what a consistency checker owes it.
        self.ino_w32(ino, INO_LINK_COUNT, 1);
        self.ino_w64(ino, INO_SIZE, 0);
        self.ino_w64(ino, INO_ATIME, now);
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        let mut used = 0;
        let mut position = 0;
        let mut emit = |mut bytes: &[u8]| -> Result<(), Errno> {
            while !bytes.is_empty() {
                let count = core::cmp::min(bytes.len(), BLOCK_SIZE - used);
                buffer[used..used + count].copy_from_slice(&bytes[..count]);
                used += count;
                bytes = &bytes[count..];
                if used == BLOCK_SIZE {
                    self.write_section_block(ino, position, &buffer)?;
                    position += BLOCK_SIZE as u64;
                    used = 0;
                }
            }
            Ok(())
        };
        crate::sdef::encode_header(archives.len(), records.len(), &mut emit)?;
        while let Some(key) = archives.iter().next().map(|(&key, _)| key) {
            let (archive, credit) = archives.remove_entry(&key).ok_or(Errno::EIO)?.into_reserved_value();
            crate::sdef::encode_archive(&archive, &mut emit)?;
            drop(archive);
            drop(credit);
        }
        while let Some(key) = records.iter().next().map(|(&key, _)| key) {
            let (record, credit) = records.remove_entry(&key).ok_or(Errno::EIO)?.into_reserved_value();
            crate::sdef::encode_record(&record, &mut emit)?;
            drop(record);
            drop(credit);
        }
        drop(emit);
        if used != 0 { self.write_section_block(ino, position, &buffer[..used])?; }
        if position + used as u64 != length as u64 { return Err(Errno::EIO); }
        self.finish_content(ino, length as u64);
        Ok(ino)
    }

    fn write_section_block(&mut self, ino: u32, position: u64, bytes: &[u8]) -> Result<(), Errno> {
        let phys = self.inode_block_map(ino, (position / BLOCK_SIZE as u64) as u32, true)?;
        self.block_mut(phys, bytes.len())?[..bytes.len()].copy_from_slice(bytes);
        Ok(())
    }

    pub fn symlink(&mut self, parent: u32, name: &[u8], target: &[u8]) -> Result<u32, Errno> {
        self.precheck(parent, name)?;
        if target.is_empty() {
            return Err(Errno::EINVAL);
        }
        let ino = self.inode_alloc()?;
        self.ino_w32(ino, INO_MODE, S_IFLNK | 0o777);
        self.ino_w32(ino, INO_LINK_COUNT, 1);
        if target.len() as u64 <= INLINE_SYMLINK_SIZE {
            // Inline in the direct-pointer area: no data block is allocated,
            // which is the layout the reader's `read_link` expects.
            let off = self.inode_offset(ino) + INO_DIRECT;
            self.inode_table[off..off + target.len()].copy_from_slice(target);
            self.ino_w64(ino, INO_SIZE, target.len() as u64);
        } else {
            self.ino_w64(ino, INO_SIZE, 0);
            self.write_content(ino, Content::Bytes(target))?;
        }
        self.dir_add_entry(parent, name, ino)?;
        Ok(ino)
    }

    /// Hard-link an existing non-directory inode under a new name.
    pub fn link(&mut self, parent: u32, name: &[u8], target_ino: u32) -> Result<(), Errno> {
        self.precheck(parent, name)?;
        self.require_inode(target_ino)?;
        if self.ino_r32(target_ino, INO_MODE) & S_IFMT == S_IFDIR {
            return Err(Errno::EPERM);
        }
        self.dir_add_entry(parent, name, target_ino)?;
        let links = self.ino_r32(target_ino, INO_LINK_COUNT) + 1;
        self.ino_w32(target_ino, INO_LINK_COUNT, links);
        let now = self.now_ms;
        self.ino_w64(target_ino, INO_CTIME, now);
        Ok(())
    }

    /// `chown`. Clears the set-user/set-group bits of a regular file exactly
    /// as the vendor does, so callers that want a setuid file must apply the
    /// mode AFTER ownership — the same ordering a shell script needs.
    pub fn set_owner(&mut self, ino: u32, uid: u32, gid: u32) -> Result<(), Errno> {
        self.require_inode(ino)?;
        self.ino_w32(ino, INO_UID, uid);
        self.ino_w32(ino, INO_GID, gid);
        let mode = self.ino_r32(ino, INO_MODE);
        if mode & S_IFMT == S_IFREG {
            self.ino_w32(ino, INO_MODE, mode & !(S_ISUID | S_ISGID));
        }
        let now = self.now_ms;
        self.ino_w64(ino, INO_CTIME, now);
        Ok(())
    }

    /// `chmod`: replaces the permission bits, preserving the file type.
    pub fn set_mode(&mut self, ino: u32, mode: u32) -> Result<(), Errno> {
        self.require_inode(ino)?;
        let old = self.ino_r32(ino, INO_MODE);
        self.ino_w32(ino, INO_MODE, (old & S_IFMT) | (mode & 0o7777));
        let now = self.now_ms;
        self.ino_w64(ino, INO_CTIME, now);
        Ok(())
    }

    /// Explicit timestamps, for an image that must carry real mtimes rather
    /// than the pinned zero the cross-language fixtures use.
    pub fn set_times(
        &mut self,
        ino: u32,
        atime_ms: u64,
        mtime_ms: u64,
        ctime_ms: u64,
    ) -> Result<(), Errno> {
        self.require_inode(ino)?;
        self.ino_w64(ino, INO_ATIME, atime_ms);
        self.ino_w64(ino, INO_MTIME, mtime_ms);
        self.ino_w64(ino, INO_CTIME, ctime_ms);
        Ok(())
    }

    /// Lay out `content` as this inode's data. Deferred content is recorded,
    /// never copied.
    fn write_content(&mut self, ino: u32, content: Content<'_>) -> Result<(), Errno> {
        let len = content.len();
        if len == 0 {
            return Ok(());
        }
        if len.div_ceil(BLOCK_SIZE as u64) > MAX_FILE_BLOCKS {
            return Err(Errno::EFBIG);
        }
        if len > V1_MAX_FILE_BYTES {
            self.version = KANDELO_IMAGE_EXTENDED_VERSION;
        }
        match &content {
            Content::SparseDeferred { id, blocks, .. } => {
                for &file_block in *blocks {
                    let pos = u64::from(file_block) * BLOCK_SIZE as u64;
                    let chunk = core::cmp::min(BLOCK_SIZE as u64, len - pos) as usize;
                    let phys = self.inode_block_map(ino, file_block, true)?;
                    self.defer_content_block(phys, *id, pos, chunk)?;
                }
            }
            _ => {
                let mut pos = 0u64;
                while pos < len {
                    let file_block = (pos / BLOCK_SIZE as u64) as u32;
                    let chunk = core::cmp::min(BLOCK_SIZE as u64, len - pos) as usize;
                    let phys = self.inode_block_map(ino, file_block, true)?;
                    match &content {
                        Content::Bytes(bytes) => {
                            let block = self.block_mut(phys, chunk)?;
                            block[..chunk]
                                .copy_from_slice(&bytes[pos as usize..pos as usize + chunk]);
                        }
                        Content::Deferred { id, .. } => {
                            self.defer_content_block(phys, *id, pos, chunk)?;
                        }
                        Content::SparseDeferred { .. } => unreachable!(),
                    }
                    pos += chunk as u64;
                }
            }
        }
        self.finish_content(ino, len);
        Ok(())
    }

    fn finish_content(&mut self, ino: u32, len: u64) {
        self.ino_w64(ino, INO_SIZE, len);
        let now = self.now_ms;
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        let seq = self.ino_r32(ino, INO_DATA_SEQUENCE).wrapping_add(1);
        self.ino_w32(ino, INO_DATA_SEQUENCE, seq);
    }

    fn defer_content_block(
        &mut self,
        phys: u32,
        id: u64,
        pos: u64,
        chunk: usize,
    ) -> Result<(), Errno> {
        let extend = self.content_extents.last_key_value().and_then(|(&start, extent)| {
            (start.checked_add(extent.blocks) == Some(phys)
                && extent.id == id
                && extent.offset + extent.blocks as u64 * BLOCK_SIZE as u64 == pos
                && extent.last_len == BLOCK_SIZE as u32)
                .then_some(start)
        });
        if let Some(start) = extend {
            let extent = self.content_extents.get_mut(&start).ok_or(Errno::EIO)?;
            extent.blocks += 1;
            extent.last_len = chunk as u32;
        } else {
            let entry = prepare_image_entry(
                phys,
                ContentExtent {
                    blocks: 1,
                    id,
                    offset: pos,
                    last_len: chunk as u32,
                },
            )?;
            self.content_extents.insert_prepared(entry);
        }
        Ok(())
    }

    /// Seal the filesystem and hand back an offset-addressable image.
    ///
    /// Fallible now, because sealing writes the deferred section. An image
    /// with no deferred files cannot fail here and allocates nothing extra.
    pub fn finish(mut self) -> Result<KandeloImage, Errno> {
        self.dir_indexes.clear();
        let deferred_inode = self.emit_deferred_section()?;
        let mut superblock = allocate_image_bytes(BLOCK_SIZE)?;
        w32(&mut superblock, SB_MAGIC, KANDELO_IMAGE_MAGIC);
        w32(&mut superblock, SB_VERSION, self.version);
        w32(&mut superblock, SB_BLOCK_SIZE, BLOCK_SIZE as u32);
        w32(&mut superblock, SB_TOTAL_BLOCKS, self.total_blocks);
        w32(&mut superblock, SB_TOTAL_INODES, self.total_inodes);
        w32(&mut superblock, SB_FREE_BLOCKS, self.free_blocks);
        w32(&mut superblock, SB_FREE_INODES, self.free_inodes);
        w32(
            &mut superblock,
            SB_INODE_BITMAP_START,
            self.inode_bitmap_start,
        );
        w32(
            &mut superblock,
            SB_BLOCK_BITMAP_START,
            self.block_bitmap_start,
        );
        w32(&mut superblock, SB_INODE_TABLE_START, self.inode_table_start);
        w32(&mut superblock, SB_DATA_START, self.data_start);
        w32(
            &mut superblock,
            SB_INODE_BITMAP_BLOCKS,
            self.inode_bitmap_blocks,
        );
        w32(
            &mut superblock,
            SB_BLOCK_BITMAP_BLOCKS,
            self.block_bitmap_blocks,
        );
        w32(
            &mut superblock,
            SB_INODE_TABLE_BLOCKS,
            self.inode_table_blocks,
        );
        w32(&mut superblock, SB_GENERATION, self.generation);
        w32(&mut superblock, SB_MAX_SIZE_BLOCKS, self.max_blocks);
        w32(&mut superblock, SB_GROW_CHUNK_BLOCKS, GROW_CHUNK_BLOCKS);
        // Zero when nothing is deferred, which is what every image written
        // before this section existed already has here.
        w32(&mut superblock, SB_DEFERRED_INODE, deferred_inode);

        Ok(KandeloImage {
            superblock,
            allocated_inodes: self.total_inodes - self.free_inodes,
            allocated_blocks: self.total_blocks - self.free_blocks,
            inode_table: self.inode_table,
            blocks: self.blocks,
            pointer_blocks: self.pointer_blocks,
            content_extents: self.content_extents,
            total_blocks: self.total_blocks,
            inode_bitmap_start: self.inode_bitmap_start,
            block_bitmap_start: self.block_bitmap_start,
            inode_table_start: self.inode_table_start,
            data_start: self.data_start,
        })
    }
}

/// A finished image, addressable by byte offset without being resident.
pub struct KandeloImage {
    superblock: crate::io_buffer::IoBuffer<u8>,
    allocated_inodes: u32,
    allocated_blocks: u32,
    inode_table: crate::io_buffer::IoBuffer<u8>,
    blocks: PreparedMap<u32, IoBuffer<u8>>,
    pointer_blocks: PreparedMap<u32, PointerPage>,
    content_extents: PreparedMap<u32, ContentExtent>,
    total_blocks: u32,
    inode_bitmap_start: u32,
    block_bitmap_start: u32,
    inode_table_start: u32,
    data_start: u32,
}

enum BlockView<'a> {
    Zeros,
    Bytes(&'a [u8]),
    Pointers(&'a PointerPage),
    BitmapPrefix { allocated_bits: u32, byte_offset: u64 },
    Content { id: u64, offset: u64, len: u32 },
}

impl KandeloImage {
    pub fn len(&self) -> u64 {
        self.total_blocks as u64 * BLOCK_SIZE as u64
    }

    pub fn is_empty(&self) -> bool {
        self.total_blocks == 0
    }

    /// Materialized image payload and extent-record bytes, excluding map
    /// allocator overhead.
    ///
    /// The whole point of the deferred path is that emitting a 249 MiB image
    /// does not cost 249 MiB of kernel memory, and "the design says so" is not
    /// evidence. This makes the claim measurable: it counts the materialized
    /// metadata — superblock, the allocated inode-table pages, directory data,
    /// indirect blocks, and extent records — but not referenced file content,
    /// the implicit allocation bitmaps, or the map allocator's node overhead.
    pub fn resident_bytes(&self) -> u64 {
        let owned: u64 = self.blocks.values().map(|block| block.len() as u64).sum();
        owned
            + self.pointer_blocks.values().map(|page| page.resident_bytes() as u64).sum::<u64>()
            + self.superblock.len() as u64
            + self.inode_table.len() as u64
            + (self.content_extents.len() * core::mem::size_of::<(u32, ContentExtent)>()) as u64
    }

    fn block_view(&self, n: u32) -> BlockView<'_> {
        if n == 0 {
            return BlockView::Bytes(&self.superblock);
        }
        if n >= self.inode_bitmap_start && n < self.block_bitmap_start {
            return BlockView::BitmapPrefix {
                allocated_bits: self.allocated_inodes,
                byte_offset: u64::from(n - self.inode_bitmap_start) * BLOCK_SIZE as u64,
            };
        }
        if n >= self.block_bitmap_start && n < self.inode_table_start {
            return BlockView::BitmapPrefix {
                allocated_bits: self.allocated_blocks,
                byte_offset: u64::from(n - self.block_bitmap_start) * BLOCK_SIZE as u64,
            };
        }
        if n >= self.inode_table_start && n < self.data_start {
            let off = (n - self.inode_table_start) as usize * BLOCK_SIZE;
            return if off < self.inode_table.len() {
                BlockView::Bytes(&self.inode_table[off..off + BLOCK_SIZE])
            } else {
                BlockView::Zeros
            };
        }
        if let Some(block) = self.blocks.get(&n) {
            return BlockView::Bytes(block);
        }
        if let Some(page) = self.pointer_blocks.get(&n) {
            return BlockView::Pointers(page);
        }
        match content_block(&self.content_extents, n) {
            Some((id, offset, len)) => BlockView::Content { id, offset, len },
            None => BlockView::Zeros,
        }
    }

    /// Fill `dst` from image offset `offset`, clamped to the image length.
    /// Returns how many bytes were produced (0 at or past the end).
    ///
    /// This is the cursor the streamed image export reads through: it never needs more than one
    /// block of the image resident, and content blocks are pulled from
    /// `source` as they are reached.
    pub fn read_at<S: ContentSource + ?Sized>(
        &self,
        source: &S,
        offset: u64,
        dst: &mut [u8],
    ) -> Result<usize, Errno> {
        let total = self.len();
        if offset >= total {
            return Ok(0);
        }
        let mut remaining = core::cmp::min(dst.len() as u64, total - offset) as usize;
        let mut pos = offset;
        let mut out = 0usize;
        while remaining > 0 {
            let n = (pos / BLOCK_SIZE as u64) as u32;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let chunk = core::cmp::min(BLOCK_SIZE - block_off, remaining);
            let target = &mut dst[out..out + chunk];
            match self.block_view(n) {
                BlockView::Zeros => target.fill(0),
                BlockView::Bytes(bytes) => {
                    let count = core::cmp::min(chunk, bytes.len().saturating_sub(block_off));
                    if count > 0 { target[..count].copy_from_slice(&bytes[block_off..block_off + count]); }
                    target[count..].fill(0);
                }
                BlockView::Pointers(page) => page.read_at(block_off, target),
                BlockView::BitmapPrefix { allocated_bits, byte_offset } => {
                    read_bitmap_prefix(allocated_bits, byte_offset + block_off as u64, target);
                }
                BlockView::Content {
                    id,
                    offset: base,
                    len,
                } => {
                    let len = len as usize;
                    if block_off >= len {
                        target.fill(0);
                    } else {
                        let take = core::cmp::min(chunk, len - block_off);
                        source.read_exact_at(id, base + block_off as u64, &mut target[..take])?;
                        target[take..].fill(0);
                    }
                }
            }
            out += chunk;
            pos += chunk as u64;
            remaining -= chunk;
        }
        Ok(out)
    }

    /// Whole-image convenience for tests and for callers that already know the
    /// image is small. Production emission must use [`KandeloImage::read_at`].
    pub fn to_vec<S: ContentSource + ?Sized>(&self, source: &S) -> Result<Vec<u8>, Errno> {
        let mut out = vec![0u8; self.len() as usize];
        let n = self.read_at(source, 0, &mut out)?;
        if n as u64 != self.len() {
            return Err(Errno::EIO);
        }
        Ok(out)
    }
}

/// A [`BlockSource`] over a finished image, so the reader in `image.rs` can
/// mount what the writer produced without the image ever being resident.
pub struct KandeloImageSource<'a, S: ContentSource + ?Sized> {
    pub image: &'a KandeloImage,
    pub content: &'a S,
}

impl<S: ContentSource + ?Sized> BlockSource for KandeloImageSource<'_, S> {
    fn len(&self) -> u64 {
        self.image.len()
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        let n = self.image.read_at(self.content, offset, dst)?;
        if n != dst.len() {
            return Err(Errno::EIO);
        }
        Ok(())
    }
}

fn read_bitmap_prefix(allocated_bits: u32, byte_offset: u64, destination: &mut [u8]) {
    let whole_bytes = u64::from(allocated_bits / 8);
    let filled = whole_bytes.saturating_sub(byte_offset).min(destination.len() as u64) as usize;
    destination[..filled].fill(255);
    destination[filled..].fill(0);
    if let Some(boundary) = whole_bytes.checked_sub(byte_offset)
        .and_then(|offset| usize::try_from(offset).ok())
        .and_then(|offset| destination.get_mut(offset))
    {
        *boundary = ((1u16 << (allocated_bits % 8)) - 1) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_directory_size_matches_writer_padding_and_index_policy() {
        assert!(core::mem::size_of::<DirectorySizeCounter>() <= 128);
        for seed in [1u32, 37, 9127] {
            let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig {
                size_bytes: 4 * 1024 * 1024,
                max_size_bytes: Some(128 * 1024 * 1024),
                growable_to_bytes: 128 * 1024 * 1024,
                now_ms: 0,
            }).unwrap();
            let mut counter = DirectorySizeCounter::new();
            let mut random = seed;
            for index in 0..6000 {
                random = random.wrapping_mul(1664525).wrapping_add(1013904223);
                let name_len = 8 + random as usize % 248;
                let mut name = alloc::format!("{index:08}").into_bytes();
                name.resize(name_len, b'x');
                writer.create_file(writer.root(), &name, 0o644, Content::Bytes(b"")).unwrap();
                counter.push(name.len()).unwrap();
                assert_eq!(counter.size(), writer.ino_r64(writer.root(), INO_SIZE),
                    "seed {seed}, entry {index}, length {name_len}");
            }
            assert!(counter.indexed);
            assert!(counter.size() > DIR_INDEX_MIN_SIZE);
        }
    }
    use crate::kandelo_image_fs::KandeloImageFs;
    use alloc::format;
    use alloc::string::{String, ToString};

    /// The cross-language fixtures: the RAW KIFS body the TypeScript writer
    /// (the vendor) produced for the same tree, raw-deflated. FROZEN: their
    /// generator existed to pin this writer to the TypeScript one, and both
    /// were deleted with the TypeScript filesystem, so these bytes cannot be
    /// regenerated -- they pin this writer to the format every shipped image
    /// already uses.
    const SMALL_FIXTURE: &[u8] = include_bytes!("testdata/kandelo-image-small.deflate");
    const WIDE_FIXTURE: &[u8] = include_bytes!("testdata/kandelo-image-wide.deflate");
    const SLOTS_FIXTURE: &[u8] = include_bytes!("testdata/kandelo-image-slots.deflate");
    const TAIL_FIXTURE: &[u8] = include_bytes!("testdata/kandelo-image-tail.deflate");

    fn inflate(packed: &[u8]) -> Vec<u8> {
        miniz_oxide::inflate::decompress_to_vec(packed).expect("fixture inflates")
    }

    /// Content addressed by index, so the byte-comparison tests exercise the
    /// DEFERRED path — the one the streamed export reads through — and not only the
    /// copy-into-a-block path.
    struct Slices(Vec<Vec<u8>>);

    impl ContentSource for Slices {
        fn read_exact_at(&self, id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let bytes = self.0.get(id as usize).ok_or(Errno::EIO)?;
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
            dst.copy_from_slice(bytes.get(start..end).ok_or(Errno::EIO)?);
            Ok(())
        }
    }

    /// Mirrors `pattern()` in the fixture generator.
    fn pattern(len: usize, seed: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 7 + seed) % 251) as u8).collect()
    }

    /// open/write/close -> chown -> chmod, the ordering the generator uses.
    /// Only a trailing chmod can leave S_ISUID set, because both the write
    /// and the chown clear it.
    fn write_file(
        w: &mut KandeloImageWriter,
        parent: u32,
        name: &[u8],
        content: Content<'_>,
        mode: u32,
        uid: u32,
        gid: u32,
    ) -> u32 {
        let ino = w.create_file(parent, name, mode, content).expect("create");
        w.set_owner(ino, uid, gid).expect("chown");
        w.set_mode(ino, mode).expect("chmod");
        ino
    }

    fn small_config() -> KandeloImageConfig {
        KandeloImageConfig {
            size_bytes: 128 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 128 * 1024,
            now_ms: 0,
        }
    }

    /// Builds the tree the `kandelo-image-small` fixture describes. `hello_mode` is a
    /// parameter only so the sensitivity test can perturb exactly one bit and
    /// still go through the real writer rather than patching bytes.
    fn build_small_with(hello_mode: u32) -> (KandeloImage, Slices) {
        let big = pattern(45000, 1);
        let content = Slices(alloc::vec![big]);

        let mut w = KandeloImageWriter::mkfs(small_config()).expect("mkfs");
        let root = w.root();

        let hello = write_file(
            &mut w,
            root,
            b"hello.txt",
            Content::Bytes(b"hello sffs\n"),
            hello_mode,
            0,
            0,
        );
        write_file(&mut w, root, b"empty", Content::Bytes(b""), 0o600, 0, 0);

        let dir = w.mkdir(root, b"dir", 0o755).expect("mkdir /dir");
        w.set_owner(dir, 0, 0).expect("chown /dir");
        write_file(
            &mut w,
            dir,
            b"nested.txt",
            Content::Bytes(b"nested\n"),
            0o644,
            12,
            34,
        );
        let deep = w.mkdir(dir, b"deep", 0o700).expect("mkdir /dir/deep");
        w.set_owner(deep, 0, 0).expect("chown /dir/deep");
        write_file(&mut w, deep, b"leaf", Content::Bytes(b"leaf\n"), 0o444, 0, 0);

        write_file(
            &mut w,
            root,
            b"big.txt",
            Content::Deferred { id: 0, len: 45000 },
            0o644,
            0,
            0,
        );

        w.symlink(root, b"link", b"hello.txt").expect("symlink");
        w.symlink(
            root,
            b"longlink",
            b"/dir/deep/a-target-path-long-enough-to-need-its-own-block",
        )
        .expect("long symlink");
        w.link(root, b"hardlink", hello).expect("hard link");

        write_file(
            &mut w,
            root,
            b"suid",
            Content::Bytes(b"#!/bin/sh\n"),
            0o4755,
            0,
            0,
        );

        (w.finish().expect("finish"), content)
    }

    fn build_small() -> (KandeloImage, Slices) {
        build_small_with(0o644)
    }

    /// Mirrors the generator's name construction exactly: pad to `width`
    /// with 'n', then truncate to `width`, then append "-{i}".
    fn wide_name(i: usize) -> Vec<u8> {
        let width = 1 + (i % 37);
        let digits = i.to_string();
        let padded: String = if digits.len() >= width {
            digits
        } else {
            let mut s = String::new();
            for _ in 0..(width - digits.len()) {
                s.push('n');
            }
            s.push_str(&digits);
            s
        };
        let name: String = padded.chars().take(width).collect();
        format!("{name}-{i}").into_bytes()
    }

    fn build_wide() -> (KandeloImage, Slices) {
        let huge = pattern(1034 * BLOCK_SIZE + 1234, 9);
        let huge_len = huge.len() as u64;
        let content = Slices(alloc::vec![huge]);

        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 8 * 1024 * 1024,
            max_size_bytes: Some(64 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();

        let wide = w.mkdir(root, b"wide", 0o755).expect("mkdir /wide");
        for i in 0..3000usize {
            let name = wide_name(i);
            write_file(&mut w, wide, &name, Content::Bytes(b""), 0o644, 0, 0);
        }
        write_file(
            &mut w,
            root,
            b"huge.bin",
            Content::Deferred {
                id: 0,
                len: huge_len,
            },
            0o644,
            0,
            0,
        );

        (w.finish().expect("finish"), content)
    }

    /// Reports where two images first differ, with enough context to name the
    /// structure rather than only the offset.
    fn first_difference(actual: &[u8], expected: &[u8]) -> Option<String> {
        let at = actual.iter().zip(expected).position(|(a, b)| a != b)?;
        Some(format!(
            "byte {at} (block {}, offset {} in block): got {:#04x}, want {:#04x}",
            at / BLOCK_SIZE,
            at % BLOCK_SIZE,
            actual[at],
            expected[at]
        ))
    }

    // ── The cross-language claim ─────────────────────────────────────

    #[test]
    fn small_tree_matches_the_typescript_writer_byte_for_byte() {
        let expected = inflate(SMALL_FIXTURE);
        let (image, content) = build_small();
        let actual = image.to_vec(&content).expect("emit");
        assert_eq!(actual.len(), expected.len(), "image length");
        assert_eq!(
            first_difference(&actual, &expected),
            None,
            "Rust writer disagrees with the TypeScript writer"
        );
    }

    #[test]
    fn wide_directory_and_double_indirect_match_the_typescript_writer() {
        // This is the fixture that reaches the two structures a small image
        // cannot: a directory past DIR_INDEX_MIN_SIZE, where the vendor
        // switches to its in-process index and changes free-slot policy, and
        // a file past 10 + 1024 blocks, which needs the double-indirect
        // block.
        let expected = inflate(WIDE_FIXTURE);
        let (image, content) = build_wide();
        let actual = image.to_vec(&content).expect("emit");
        assert_eq!(actual.len(), expected.len(), "image length");
        assert_eq!(
            first_difference(&actual, &expected),
            None,
            "Rust writer disagrees with the TypeScript writer"
        );
    }

    fn build_slots() -> KandeloImage {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 1024 * 1024,
            max_size_bytes: Some(32 * 1024 * 1024),
            growable_to_bytes: 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        let slots = w.mkdir(root, b"slots", 0o755).expect("mkdir /slots");
        for i in 0..1700usize {
            let digits = i.to_string();
            let mut name = String::new();
            for _ in 0..(32 - digits.len()) {
                name.push('0');
            }
            name.push_str(&digits);
            write_file(
                &mut w,
                slots,
                name.as_bytes(),
                Content::Bytes(b""),
                0o644,
                0,
                0,
            );
        }
        for i in 0..40usize {
            let name = format!("s{i}").into_bytes();
            write_file(&mut w, slots, &name, Content::Bytes(b""), 0o644, 0, 0);
        }
        w.finish().expect("finish")
    }

    #[test]
    fn directory_index_free_slot_choice_matches_the_typescript_writer() {
        // Pins which remembered free record the index reuses. `kandelo-image-wide`
        // cannot distinguish a last-first scan from a first-found one — its
        // free list only ever held two slots of different sizes, and the one
        // reuse needed more than the smaller of them, so both directions
        // agree. Here every padding record is the same size and the reusing
        // names fit all of them, so the direction changes the bytes.
        let expected = inflate(SLOTS_FIXTURE);
        let image = build_slots();
        let actual = image.to_vec(&NoContent).expect("emit");
        assert_eq!(actual.len(), expected.len(), "image length");
        assert_eq!(
            first_difference(&actual, &expected),
            None,
            "Rust writer disagrees with the TypeScript writer"
        );
    }

    /// A writer the caller gave no time stamps what it creates with Kandelo's
    /// reference instant. Zero would read as "no timestamp" to whatever later
    /// stats the file -- PHP's opcache refuses to cache such a file.
    #[test]
    fn the_default_clock_is_the_reference_instant_not_zero() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        let dir = w.mkdir(root, b"www", 0o755).expect("mkdir");
        w.create_file(dir, b"index.php", 0o644, Content::Bytes(b"<?php\n"))
            .expect("create");
        let image = w.finish().expect("finish");
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        for path in [&b"/"[..], b"/www", b"/www/index.php"] {
            let st = fs.stat_ino(fs.resolve(path, false).expect("resolve")).expect("stat");
            assert_eq!(st.mtime_ms, wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS);
        }
    }

    #[test]
    fn every_slots_name_is_still_reachable_through_the_reader() {
        // Reused padding records are the easiest place for a writer to
        // corrupt a directory, because the record is overwritten in place
        // without its rec_len changing. Walk the whole directory back.
        let image = build_slots();
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        let slots = fs.resolve(b"/slots", true).expect("resolve /slots");
        let entries = fs.read_dir(slots).expect("read_dir");
        assert_eq!(entries.len(), 1700 + 40 + 2, "every record survives");
        for i in [0usize, 1, 1699] {
            let digits = i.to_string();
            let mut name = String::new();
            for _ in 0..(32 - digits.len()) {
                name.push('0');
            }
            name.push_str(&digits);
            assert!(fs.lookup(slots, name.as_bytes()).is_ok(), "missing {name}");
        }
        for i in [0usize, 17, 39] {
            let name = format!("s{i}");
            assert!(fs.lookup(slots, name.as_bytes()).is_ok(), "missing {name}");
        }
    }

    /// Exactly four characters, so every directory record is 12 bytes.
    fn name4(i: usize) -> Vec<u8> {
        const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut out = [0u8; 4];
        let mut n = i;
        for k in (0..4).rev() {
            out[k] = ALPHA[n % 36];
            n /= 36;
        }
        out.to_vec()
    }

    fn build_tail() -> KandeloImage {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 2 * 1024 * 1024,
            max_size_bytes: Some(128 * 1024 * 1024),
            growable_to_bytes: 2 * 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        let tail = w.mkdir(root, b"tail", 0o755).expect("mkdir /tail");
        for i in 0..6000usize {
            write_file(&mut w, tail, &name4(i), Content::Bytes(b""), 0o644, 0, 0);
        }
        w.finish().expect("finish")
    }

    #[test]
    fn trailing_gap_extension_matches_the_typescript_writer() {
        // The branch no other fixture reaches: a trailing gap of exactly 4
        // bytes, too small for a padding record, which the vendor absorbs by
        // growing the PREVIOUS record's rec_len. Every rec_len is 4-aligned
        // so every gap is a multiple of 4, and 4 is the only value that
        // separates this branch from the padding branch.
        let expected = inflate(TAIL_FIXTURE);
        let image = build_tail();
        let actual = image.to_vec(&NoContent).expect("emit");
        assert_eq!(actual.len(), expected.len(), "image length");
        assert_eq!(
            first_difference(&actual, &expected),
            None,
            "Rust writer disagrees with the TypeScript writer"
        );
    }

    #[test]
    fn an_extended_record_still_reads_back_as_one_entry() {
        // Growing a record's rec_len to swallow the block tail is the one
        // place a writer can silently make a directory unwalkable: the reader
        // steps by rec_len, so an over-long record eats its successor.
        let image = build_tail();
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        let tail = fs.resolve(b"/tail", true).expect("resolve /tail");
        let entries = fs.read_dir(tail).expect("read_dir");
        assert_eq!(entries.len(), 6000 + 2, "no record may be swallowed");
        // The directory must actually be past the index threshold, so the
        // extension ran on the index path too, where the writer has to go
        // find the last record itself.
        assert!(fs.stat_ino(tail).unwrap().size > DIR_INDEX_MIN_SIZE);
        for i in [0usize, 338, 339, 340, 5999] {
            let name = name4(i);
            assert!(
                fs.lookup(tail, &name).is_ok(),
                "missing {:?}",
                core::str::from_utf8(&name)
            );
        }
    }

    // ── Guard sensitivity: the comparison above must have teeth ──────

    #[test]
    fn the_byte_comparison_detects_a_one_bit_tree_change() {
        // A byte fixture is only evidence if it FAILS for a tree that
        // differs. Build the same tree with one permission bit changed and
        // assert the images diverge. Without this, a comparison that somehow
        // passed vacuously would look identical to one that passed honestly.
        let expected = inflate(SMALL_FIXTURE);
        let (image, content) = build_small_with(0o645);
        let actual = image.to_vec(&content).expect("emit");
        assert!(
            first_difference(&actual, &expected).is_some(),
            "a changed file mode must change the image"
        );
    }

    #[test]
    fn the_byte_comparison_detects_a_reordered_tree() {
        // Same files, same contents, different creation order: inode and
        // block assignment shift, so the bytes must differ. This is what
        // proves the fixture pins ALLOCATION and not merely file contents.
        let expected = inflate(SMALL_FIXTURE);
        let mut w = KandeloImageWriter::mkfs(small_config()).expect("mkfs");
        let root = w.root();
        write_file(&mut w, root, b"empty", Content::Bytes(b""), 0o600, 0, 0);
        write_file(
            &mut w,
            root,
            b"hello.txt",
            Content::Bytes(b"hello sffs\n"),
            0o644,
            0,
            0,
        );
        let image = w.finish().expect("finish");
        let actual = image.to_vec(&NoContent).expect("emit");
        assert!(
            first_difference(&actual, &expected).is_some(),
            "a reordered tree must change the image"
        );
    }

    // ── Round trip through the reader this repository already trusts ──

    #[test]
    fn the_existing_reader_mounts_what_the_writer_produced() {
        let (image, content) = build_small();
        let source = KandeloImageSource {
            image: &image,
            content: &content,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");

        let root = fs.stat_ino(ROOT_INO).expect("root");
        assert_eq!(root.mode & 0xf000, 0x4000);

        let hello = fs.resolve(b"/hello.txt", true).expect("resolve hello");
        let mut buf = [0u8; 32];
        let n = fs.read_at(hello, 0, &mut buf).expect("read hello");
        assert_eq!(&buf[..n], b"hello sffs\n");

        // A hard link is the SAME inode, with two names and nlink 2.
        let hard = fs.resolve(b"/hardlink", true).expect("resolve hardlink");
        assert_eq!(hard, hello);
        assert_eq!(fs.stat_ino(hello).unwrap().nlink, 2);

        // Empty file: present, zero length, mode preserved.
        let empty = fs.resolve(b"/empty", true).expect("resolve empty");
        assert_eq!(fs.stat_ino(empty).unwrap().size, 0);
        assert_eq!(fs.stat_ino(empty).unwrap().mode & 0o7777, 0o600);

        // setuid survived the write and the chown.
        let suid = fs.resolve(b"/suid", true).expect("resolve suid");
        assert_eq!(fs.stat_ino(suid).unwrap().mode & 0o7777, 0o4755);

        // Ownership round-trips.
        let nested = fs.resolve(b"/dir/nested.txt", true).expect("resolve nested");
        let st = fs.stat_ino(nested).unwrap();
        assert_eq!((st.uid, st.gid), (12, 34));

        // Both symlink encodings: inline (<= 40 bytes) and block-backed.
        let link = fs.resolve(b"/link", false).expect("resolve link");
        assert_eq!(fs.read_link(link).unwrap(), b"hello.txt");
        let long = fs.resolve(b"/longlink", false).expect("resolve longlink");
        let target: &[u8] = b"/dir/deep/a-target-path-long-enough-to-need-its-own-block";
        assert!(
            target.len() as u64 > INLINE_SYMLINK_SIZE,
            "must be block-backed"
        );
        assert_eq!(fs.read_link(long).unwrap(), target);

        // Deferred content, read back through the single-indirect block.
        let big = fs.resolve(b"/big.txt", true).expect("resolve big");
        let size = fs.stat_ino(big).unwrap().size as usize;
        assert_eq!(size, 45000);
        let mut out = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(big, 0, &mut out).unwrap(), size);
        assert_eq!(out, pattern(45000, 1));

        // Deep nesting.
        let leaf = fs.resolve(b"/dir/deep/leaf", true).expect("resolve leaf");
        let mut lbuf = [0u8; 8];
        let n = fs.read_at(leaf, 0, &mut lbuf).unwrap();
        assert_eq!(&lbuf[..n], b"leaf\n");
    }

    #[test]
    fn the_existing_reader_walks_a_wide_directory_and_double_indirect_file() {
        let (image, content) = build_wide();
        let source = KandeloImageSource {
            image: &image,
            content: &content,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");

        let wide = fs.resolve(b"/wide", true).expect("resolve /wide");
        let entries = fs.read_dir(wide).expect("read_dir");
        // 3000 names plus "." and "..".
        assert_eq!(entries.len(), 3002, "every record must survive the walk");
        assert!(
            fs.stat_ino(wide).unwrap().size >= 64 * 1024,
            "the directory must be past the index threshold"
        );

        // Spot-check names across the whole range, including ones that land
        // right after a padding record.
        for i in [0usize, 1, 36, 37, 999, 1500, 2999] {
            let name = wide_name(i);
            assert!(
                fs.lookup(wide, &name).is_ok(),
                "missing {:?}",
                core::str::from_utf8(&name)
            );
        }

        let huge = fs.resolve(b"/huge.bin", true).expect("resolve huge");
        let size = fs.stat_ino(huge).unwrap().size as usize;
        assert_eq!(size, 1034 * BLOCK_SIZE + 1234);
        let expected = pattern(size, 9);
        // Read the tail, which lives past the double-indirect boundary.
        let tail_at = 1034 * BLOCK_SIZE;
        let mut tail = alloc::vec![0u8; size - tail_at];
        let n = fs.read_at(huge, tail_at as u64, &mut tail).unwrap();
        assert_eq!(n, size - tail_at);
        assert_eq!(tail, expected[tail_at..]);
        // And the whole file, so the direct/indirect/double-indirect seams
        // are all crossed in one read.
        let mut all = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(huge, 0, &mut all).unwrap(), size);
        assert_eq!(all, expected);
    }

    // ── The emission cursor ──────────────────────────────────────────

    #[test]
    fn read_at_is_offset_addressable_and_chunk_independent() {
        // The export streams this image out in host-sized chunks, so a read at
        // an arbitrary offset and width must agree with the whole-image bytes.
        // A writer that only worked via `to_vec` would pass every other test
        // here and still fail the streamed export.
        let (image, content) = build_small();
        let whole = image.to_vec(&content).expect("emit");

        for chunk in [1usize, 7, 100, 4095, 4096, 4097, 9000] {
            let mut rebuilt = Vec::new();
            let mut offset = 0u64;
            loop {
                let mut buf = alloc::vec![0u8; chunk];
                let n = image.read_at(&content, offset, &mut buf).expect("read");
                if n == 0 {
                    break;
                }
                rebuilt.extend_from_slice(&buf[..n]);
                offset += n as u64;
            }
            assert_eq!(rebuilt, whole, "chunk size {chunk}");
        }

        // Reads at or past the end, and a read that clamps.
        let mut buf = [0u8; 16];
        assert_eq!(image.read_at(&content, image.len(), &mut buf).unwrap(), 0);
        assert_eq!(
            image
                .read_at(&content, image.len() + 4096, &mut buf)
                .unwrap(),
            0
        );
        let n = image.read_at(&content, image.len() - 4, &mut buf).unwrap();
        assert_eq!(n, 4, "a read at the end clamps to the image");
    }

    #[test]
    fn deferred_content_is_never_buffered_by_the_writer() {
        // The point of the deferred path is that a 249 MiB image does not
        // become 249 MiB of kernel memory. Assert the writer holds no
        // materialized block for the content blocks of a deferred file: they
        // must be references, not copies.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(8 * 1024 * 1024)).expect("mkfs");
        let root = w.root();
        let len = 2 * 1024 * 1024u64;
        w.create_file(root, b"f", 0o644, Content::Deferred { id: 0, len })
            .expect("create");
        let materialized = w.blocks.len() + w.pointer_blocks.len();
        let referenced: u32 = w.content_extents.values().map(|extent| extent.blocks).sum();
        assert_eq!(referenced, (len / BLOCK_SIZE as u64) as u32);
        assert_eq!(w.content_extents.len(), 2);
        // Only the root directory block and the file's single indirect block
        // are materialized.
        assert_eq!(materialized, 2, "only metadata may be resident");
    }

    #[test]
    fn large_deferred_file_uses_metadata_sized_extents() {
        struct OffsetPattern;

        impl ContentSource for OffsetPattern {
            fn read_exact_at(&self, _id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                for (index, byte) in dst.iter_mut().enumerate() {
                    *byte = ((offset + index as u64) % 251) as u8;
                }
                Ok(())
            }
        }

        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024 * 1024))
            .expect("mkfs");
        let len = 32 * 1024 * 1024u64 + 17;
        let file = writer
            .create_file(
                writer.root(),
                b"large",
                0o644,
                Content::Deferred { id: 7, len },
            )
            .expect("create");
        let file_blocks = [0u32, 11, 12, 1035, 1036, 8192];
        let positions: Vec<(u32, u32)> = file_blocks
            .iter()
            .map(|&block| {
                (
                    block,
                    writer.inode_block_map(file, block, false).expect("mapped"),
                )
            })
            .collect();
        assert!(
            writer.content_extents.len() < 20,
            "one extent per metadata gap"
        );
        let image = writer.finish().expect("finish");
        assert!(image.resident_bytes() < 3 * 1024 * 1024);

        for (block, phys) in positions {
            let mut bytes = [0u8; 32];
            assert_eq!(
                image.read_at(&OffsetPattern, phys as u64 * BLOCK_SIZE as u64, &mut bytes),
                Ok(32)
            );
            let content_len = if block == 8192 { 17 } else { bytes.len() };
            for (index, &byte) in bytes[..content_len].iter().enumerate() {
                let offset = block as u64 * BLOCK_SIZE as u64 + index as u64;
                assert_eq!(byte, (offset % 251) as u8, "file block {block}");
            }
            assert!(bytes[content_len..].iter().all(|&byte| byte == 0));
        }
    }

    #[test]
    fn deferred_record_budget_refuses_before_allocating_an_inode_and_still_exports() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024 * 1024)).unwrap();
        let payload = vec![7; crate::sdef::MAX_PAYLOAD_LEN as usize];
        let mut accepted = 0;
        loop {
            let before = (writer.free_inodes, writer.free_blocks, writer.generation,
                writer.deferred.len(), writer.deferred_field_bytes);
            let name = alloc::format!("deferred-{accepted}");
            match writer.create_deferred_file(writer.root(), name.as_bytes(), 0o644,
                42, 0, b"", b"", b"", &payload) {
                Ok(_) => accepted += 1,
                Err(error) => {
                    assert_eq!(error, Errno::ENOMEM);
                    assert_eq!((writer.free_inodes, writer.free_blocks, writer.generation,
                        writer.deferred.len(), writer.deferred_field_bytes), before);
                    assert_eq!(writer.lookup(writer.root(), name.as_bytes()), Ok(None));
                    break;
                }
            }
        }
        assert_eq!(accepted, 127);
        writer.create_file(writer.root(), b"ordinary", 0o600, Content::Bytes(b"ok")).unwrap();
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let section = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!(section.records.len(), accepted);
        assert!(section.records.iter().all(|record| record.payload == payload));
    }

    #[test]
    fn deferred_fields_and_nodes_are_admitted_before_namespace_publication() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
        let retained = IO_MEMORY.usage().0;
        let before = (writer.free_inodes, writer.free_blocks, writer.generation,
            writer.inode_table.as_slice().to_vec());
        for allowance in [0, 64] {
            let _limit = crate::io_buffer::test_budget(retained + allowance);
            assert_eq!(writer.create_deferred_file(writer.root(), b"refused", 0o600,
                42, 0, b"", b"address", b"", &[7; 25]), Err(Errno::ENOMEM));
            assert!(writer.deferred.is_empty());
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(writer.create_deferred_file(writer.root(), b"refused", 0o600,
            42, 0, b"", b"address", b"", &[7; 25]), Err(Errno::ENOMEM));
        assert_eq!(IO_MEMORY.usage().0, retained);
        assert_eq!((writer.free_inodes, writer.free_blocks, writer.generation,
            writer.inode_table.as_slice().to_vec()), before);
        assert_eq!(writer.lookup(writer.root(), b"refused"), Ok(None));
        let ino = writer.create_deferred_file(writer.root(), b"retry", 0o600,
            42, 0, b"", b"address", b"", &[7; 25]).unwrap();
        assert_eq!(writer.deferred.values().next().unwrap().ino, ino);
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.deferred_section().unwrap().unwrap().get(ino).unwrap().uri, b"address");
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn deferred_hidden_inode_backing_is_prepared_before_namespace_publication() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
        while writer.total_inodes - writer.free_inodes < INODES_PER_BLOCK - 1 {
            let next = writer.total_inodes - writer.free_inodes;
            writer.create_file(writer.root(), alloc::format!("ordinary-{next}").as_bytes(),
                0o600, Content::Bytes(b"")).unwrap();
        }
        let retained = IO_MEMORY.usage().0;
        let node = PreparedEntry::<u32, crate::sdef::DeferredRecord>::reserve_in(&IO_MEMORY, 0).unwrap();
        let node_bytes = node.bytes();
        drop(node);
        let before = (writer.free_inodes, writer.free_blocks, writer.generation,
            writer.inode_table.as_slice().to_vec());
        {
            let output_node = PreparedEntry::<u32, IoBuffer<u8>>::memory_bytes(0).unwrap();
            let _limit = crate::io_buffer::test_budget(retained + node_bytes + DEFERRED_FINISH_HEADROOM + output_node);
            assert_eq!(writer.create_deferred_file(writer.root(), b"denied", 0o600,
                42, 0, b"", b"", b"", b""), Err(Errno::ENOMEM));
        }
        assert_eq!(IO_MEMORY.usage().0, retained);
        assert_eq!((writer.free_inodes, writer.free_blocks, writer.generation,
            writer.inode_table.as_slice().to_vec()), before);
        assert_eq!(writer.lookup(writer.root(), b"denied"), Ok(None));
        let ino = writer.create_deferred_file(writer.root(), b"retry", 0o600,
            42, 0, b"", b"", b"", b"").unwrap();
        assert_eq!(ino, INODES_PER_BLOCK - 1);
        assert_eq!(writer.inode_table.len(), BLOCK_SIZE);
        assert!(writer.inode_table.capacity() >= 2 * BLOCK_SIZE);
        let image = writer.finish().unwrap();
        assert_eq!(r32(&image.superblock, SB_DEFERRED_INODE), INODES_PER_BLOCK);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn late_section_declaration_prepares_backing_before_publishing_its_flag() {
        let baseline = IO_MEMORY.usage().0;
        for archive in [false, true] {
            let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
            while writer.total_inodes - writer.free_inodes < INODES_PER_BLOCK {
                let next = writer.total_inodes - writer.free_inodes;
                writer.create_file(writer.root(), alloc::format!("ordinary-{next}").as_bytes(),
                    0o600, Content::Bytes(b"")).unwrap();
            }
            if archive { writer.declare_lazy_archive(3, 42, b"uri", b"", b"payload").unwrap(); }
            let retained = IO_MEMORY.usage().0;
            let before = (writer.free_inodes, writer.free_blocks, writer.generation, writer.inode_table.len());
            let finalization = if archive { 0 } else {
                DEFERRED_FINISH_HEADROOM + PreparedEntry::<u32, IoBuffer<u8>>::memory_bytes(0).unwrap()
            };
            {
                let _limit = crate::io_buffer::test_budget(retained + finalization);
                assert_eq!(writer.declare_deferred_section(), Err(Errno::ENOMEM));
            }
            assert!(!writer.declares_deferred);
            assert_eq!(IO_MEMORY.usage().0, retained);
            assert_eq!((writer.free_inodes, writer.free_blocks, writer.generation, writer.inode_table.len()), before);
            writer.declare_deferred_section().unwrap();
            assert_eq!(writer.inode_table.len(), BLOCK_SIZE);
            let image = writer.finish().unwrap();
            assert_eq!(r32(&image.superblock, SB_DEFERRED_INODE), INODES_PER_BLOCK);
            let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
            assert_eq!(filesystem.deferred_section().unwrap().unwrap().archives.len(), usize::from(archive));
            drop(filesystem);
            drop(image);
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn deferred_stream_failure_releases_every_unpublished_input_and_output_owner() {
        let baseline = IO_MEMORY.usage().0;
        let build = || {
            let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
            writer.create_deferred_file(writer.root(), b"file", 0o600, 42, 0,
                b"", b"address", b"", &vec![7; crate::sdef::MAX_PAYLOAD_LEN as usize]).unwrap();
            writer
        };
        for successful_allocations in [0, 1, 17] {
            let writer = build();
            let retained = IO_MEMORY.usage().0;
            let _limit = crate::io_buffer::test_budget(retained);
            crate::prepared_map::fail_after_allocations(successful_allocations);
            assert_eq!(writer.finish().err(), Some(Errno::ENOMEM));
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
        let image = build().finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.deferred_section().unwrap().unwrap().records[0].payload,
            vec![7; crate::sdef::MAX_PAYLOAD_LEN as usize]);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn many_small_deferred_records_release_input_backing_while_encoding() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024 * 1024)).unwrap();
        for index in 0..4096 {
            writer.create_deferred_file(writer.root(), alloc::format!("record-{index:04}").as_bytes(),
                0o600, index, 0, b"", b"uri", b"", b"small").unwrap();
        }
        let retained = IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(retained + 4 * BLOCK_SIZE);
        let image = writer.finish().unwrap();
        assert!(IO_MEMORY.usage().0 < retained);
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let section = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!(section.records.len(), 4096);
        assert!(section.records.iter().all(|record| record.uri == b"uri" && record.payload == b"small"));
        drop(section);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn deferred_archive_admission_exhaustion_still_exports_its_accepted_prefix() {
        let baseline = IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(baseline + 2 * 1024 * 1024);
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(8 * 1024 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        let mut accepted = 0;
        loop {
            let retained = IO_MEMORY.usage().0;
            match writer.declare_lazy_archive(accepted + 1, 42, b"uri", b"", &[7; 64]) {
                Ok(()) => accepted += 1,
                Err(error) => {
                    assert_eq!(error, Errno::ENOMEM);
                    assert_eq!(IO_MEMORY.usage().0, retained);
                    assert_eq!(writer.deferred_archives.len(), accepted as usize);
                    break;
                }
            }
        }
        assert!(accepted > 1024);
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let section = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!(section.archives.len(), accepted as usize);
        assert!(section.archives.iter().all(|archive| archive.payload == [7; 64]));
        drop(section);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn deferred_finalization_headroom_handles_maximum_fields_without_extra_credit() {
        let baseline = IO_MEMORY.usage().0;
        let node = PreparedEntry::<u32, IoBuffer<u8>>::reserve_in(&IO_MEMORY, 0).unwrap();
        let node_bytes = node.bytes();
        drop(node);
        let maximum_record = crate::sdef::RECORD_HEADER_SIZE as usize + crate::sdef::MAX_PAYLOAD_LEN as usize
            + crate::sdef::MAX_SOURCE_PATH_LEN as usize + crate::sdef::MAX_URI_LEN as usize;
        let burst = (maximum_record.div_ceil(BLOCK_SIZE) + 1 + 4) * (BLOCK_SIZE * 2 + node_bytes)
            + 4 * BLOCK_SIZE;
        assert!(burst <= DEFERRED_FINISH_HEADROOM);
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(16 * 1024 * 1024)).unwrap();
        let payload = vec![7; crate::sdef::MAX_PAYLOAD_LEN as usize];
        let uri = vec![b'u'; crate::sdef::MAX_URI_LEN as usize];
        let source_path = vec![b'p'; crate::sdef::MAX_SOURCE_PATH_LEN as usize];
        for archive_id in 1..=32 {
            writer.declare_lazy_archive(archive_id, 123, &uri, &[3; 32], &payload).unwrap();
        }
        for index in 0..64 {
            writer.create_deferred_file(writer.root(), alloc::format!("member-{index}").as_bytes(), 0o600,
                42, 1 + index % 32, &source_path, b"", &[5; 32], &payload).unwrap();
        }
        let retained = IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(retained);
        let image = writer.finish().unwrap();
        assert!(IO_MEMORY.usage().0 < retained);
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let section = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!((section.archives.len(), section.records.len()), (32, 64));
        assert!(section.records.iter().all(|record| record.payload == payload && record.source_path == source_path));
        assert!(section.archives.iter().all(|archive| archive.payload == payload && archive.uri == uri));
        drop(section);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn deferred_streaming_preserves_buffered_image_layout_and_padding() {
        for payload_len in [0, 1, 4095, 4096, 65536] {
            let build = || {
                let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
                writer.declare_deferred_section().unwrap();
                writer.declare_lazy_archive(9, 456, b"archive-nine", &[9; 32], b"opaque-nine").unwrap();
                writer.declare_lazy_archive(3, 123, b"archive-three", &[3; 32], b"opaque-three").unwrap();
                writer.create_deferred_file(writer.root(), b"standalone", 0o640, 42, 0,
                    b"", b"address", &[7; 32], &vec![11; payload_len]).unwrap();
                writer.create_deferred_file(writer.root(), b"member", 0o600, 17, 3,
                    b"member/path", b"", &[5; 32], b"member-data").unwrap();
                writer
            };
            let streamed = build().finish().unwrap();
            let mut buffered = build();
            let archives: Vec<_> = buffered.deferred_archives.values().cloned().collect();
            let records: Vec<_> = buffered.deferred.values().cloned().collect();
            let encoded = crate::sdef::encode(&archives, &records).unwrap();
            buffered.deferred.clear();
            buffered.deferred_archives.clear();
            buffered.declares_deferred = false;
            let ino = buffered.inode_alloc().unwrap();
            let now = buffered.now_ms;
            buffered.ino_w32(ino, INO_MODE, S_IFREG);
            buffered.ino_w32(ino, INO_LINK_COUNT, 1);
            buffered.ino_w64(ino, INO_ATIME, now);
            buffered.ino_w64(ino, INO_MTIME, now);
            buffered.ino_w64(ino, INO_CTIME, now);
            buffered.write_content(ino, Content::Bytes(&encoded)).unwrap();
            let mut buffered = buffered.finish().unwrap();
            w32(&mut buffered.superblock, SB_DEFERRED_INODE, ino);
            assert_eq!(streamed.to_vec(&NoContent).unwrap(), buffered.to_vec(&NoContent).unwrap());
        }
    }

    #[test]
    fn deferred_archive_nodes_use_actual_counts_for_the_semantic_cap() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(8 * 1024 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        for archive_id in 1..=32769 {
            writer.declare_lazy_archive(archive_id, 42, b"", b"", &[7; 64]).unwrap();
        }
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let section = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!(section.archives.len(), 32769);
        assert!(section.archives.iter().all(|archive| archive.payload == [7; 64]));
        drop(section);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn deferred_hidden_inode_crosses_the_large_table_boundary_under_the_default_budget() {
        let baseline = IO_MEMORY.usage().0;
        for count in [32765, 32766, 32767] {
            let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(
                KandeloImageConfig::fixed(64 * 1024 * 1024), Some(65536)).unwrap();
            let mut directory = writer.root();
            let mut records = 0;
            for index in 0..count {
                if index % 512 == 0 {
                    directory = writer.mkdir(writer.root(), alloc::format!("directory-{index}").as_bytes(), 0o755).unwrap();
                } else {
                    writer.create_deferred_file(directory, alloc::format!("record-{index:05}").as_bytes(),
                        0o600, index, 0, b"", b"", b"", b"").unwrap();
                    records += 1;
                }
            }
            let image = writer.finish().unwrap();
            let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
            assert_eq!(filesystem.deferred_section().unwrap().unwrap().records.len(), records);
            drop(filesystem);
            drop(image);
            assert_eq!(IO_MEMORY.usage().0, baseline);
        }
    }

    #[test]
    fn deferred_archives_and_records_share_admission_before_namespace_mutation() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        let payload = vec![7; crate::sdef::MAX_PAYLOAD_LEN as usize];
        for archive_id in 1..128 {
            writer.declare_lazy_archive(archive_id, 42, b"", b"", &payload).unwrap();
        }
        let before = (writer.free_inodes, writer.free_blocks, writer.generation,
            writer.deferred_archives.len(), writer.deferred_field_bytes);
        assert_eq!(writer.declare_lazy_archive(128, 42, b"", b"", &payload), Err(Errno::ENOMEM));
        assert_eq!(writer.create_deferred_file(writer.root(), b"refused", 0o600,
            42, 0, b"", b"", b"", &payload), Err(Errno::ENOMEM));
        assert_eq!((writer.free_inodes, writer.free_blocks, writer.generation,
            writer.deferred_archives.len(), writer.deferred_field_bytes), before);
        assert_eq!(writer.lookup(writer.root(), b"refused"), Ok(None));
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.deferred_section().unwrap().unwrap().archives.len(), 127);
    }

    #[test]
    fn deferred_metadata_reader_rejects_a_large_sparse_section_before_allocating_its_body() {
        struct ExtendedSource<'a> {
            image: &'a KandeloImage,
            largest: &'a core::cell::Cell<usize>,
        }
        impl BlockSource for ExtendedSource<'_> {
            fn len(&self) -> u64 { 32 * 1024 * 1024 * 1024 }
            fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
                self.largest.set(self.largest.get().max(destination.len()));
                assert!(destination.len() <= BLOCK_SIZE);
                if self.image.read_at(&NoContent, offset, destination)? != destination.len() { return Err(Errno::EIO); }
                Ok(())
            }
        }
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        let mut image = writer.finish().unwrap();
        w32(&mut image.superblock, SB_VERSION, KANDELO_IMAGE_EXTENDED_VERSION);
        let metadata_inode = r32(&image.superblock, SB_DEFERRED_INODE);
        let offset = metadata_inode as usize * INODE_SIZE;
        w64(&mut image.inode_table, offset + INO_SIZE, 32 * 1024 * 1024 * 1024);
        let largest = core::cell::Cell::new(0);
        let source = ExtendedSource { image: &image, largest: &largest };
        let filesystem = KandeloImageFs::mount(source).unwrap();
        assert_eq!(filesystem.deferred_section(), Err(Errno::EINVAL));
        assert!(largest.get() <= BLOCK_SIZE);
    }

    #[test]
    fn pointer_runs_emit_exact_little_endian_bytes_for_arbitrary_windows() {
        let mut page = PointerPage::default();
        let mut expected = [0; BLOCK_SIZE];
        for (start, length, first, stride) in [(0u16, 10, 17, 1), (17, 87, 99, 1025), (1000, 24, 800_000, 2)] {
            for index in 0..length {
                let value = first + u32::from(index) * stride;
                page.set(start + index, value).unwrap();
                w32(&mut expected, usize::from(start + index) * 4, value);
            }
        }
        assert!(page.resident_bytes() < 1024);
        for offset in (0..BLOCK_SIZE).step_by(13) {
            for requested in [1, 3, 4, 7, 97, BLOCK_SIZE] {
                let count = core::cmp::min(requested, BLOCK_SIZE - offset);
                let mut actual = vec![0; count];
                page.read_at(offset, &mut actual);
                assert_eq!(actual, expected[offset..offset + count]);
            }
        }
    }

    #[test]
    fn fragmented_pointer_runs_fall_back_to_one_page_without_losing_holes() {
        let mut page = PointerPage::default();
        let mut expected = [0; BLOCK_SIZE];
        for index in 0..65u16 {
            page.set(index * 2, 100 + u32::from(index)).unwrap();
            w32(&mut expected, usize::from(index * 2) * 4, 100 + u32::from(index));
        }
        assert!(matches!(page, PointerPage::Bytes(_)));
        assert_eq!(page.resident_bytes(), BLOCK_SIZE);
        for index in 0..65u16 {
            page.set(index * 2 + 1, 900 + u32::from(index)).unwrap();
            w32(&mut expected, usize::from(index * 2 + 1) * 4, 900 + u32::from(index));
        }
        let mut actual = [0; BLOCK_SIZE];
        page.read_at(0, &mut actual);
        assert_eq!(actual, expected);
    }

    #[test]
    fn pointer_pages_preserve_out_of_order_values_and_reject_invalid_changes() {
        let mut page = PointerPage::default();
        page.set(1023, u32::MAX).unwrap();
        page.set(0, 7).unwrap();
        page.set(512, 11).unwrap();
        assert!(matches!(page, PointerPage::Bytes(_)));
        assert_eq!(page.get(1023), u32::MAX);
        assert_eq!(page.get(0), 7);
        assert_eq!(page.get(512), 11);
        assert_eq!(page.get(513), 0);
        let mut before = [0; BLOCK_SIZE];
        page.read_at(0, &mut before);
        for (slot, value) in [(1024, 9), (512, 13), (513, 0)] {
            assert_eq!(page.set(slot, value), Err(Errno::EIO));
        }
        let mut after = [0; BLOCK_SIZE];
        page.read_at(0, &mut after);
        assert_eq!(before, after);
        let mut overflow = PointerPage::default();
        overflow.set(0, 7).unwrap();
        overflow.set(1, u32::MAX - 1).unwrap();
        overflow.set(2, u32::MAX).unwrap();
        assert_eq!(overflow.get(2), u32::MAX);
    }

    #[test]
    fn streamed_sparse_allocations_match_the_slice_writer_byte_for_byte() {
        let file_len = 9 * 1024 * 1024 * 1024u64 + 17;
        for blocks in [
            &[][..],
            &[0, 9, 10, 11, 1033, 1034, 1035, 2057, 2058][..],
            &[V1_MAX_FILE_BLOCKS as u32 - 1, V1_MAX_FILE_BLOCKS as u32,
                V1_MAX_FILE_BLOCKS as u32 + 1024, (file_len / BLOCK_SIZE as u64) as u32][..],
        ] {
            let config = || KandeloImageConfig::fixed(256 * 1024);
            let mut slice_writer = KandeloImageWriter::mkfs(config()).unwrap();
            slice_writer.create_file(slice_writer.root(), b"file", 0o640,
                Content::SparseDeferred { id: 7, len: file_len, blocks }).unwrap();
            let mut stream_writer = KandeloImageWriter::mkfs(config()).unwrap();
            let mut passes = 0;
            stream_writer.create_sparse_file_from(stream_writer.root(), b"file", 0o640,
                7, file_len, |visit| {
                    passes += 1;
                    for &block in blocks { visit(block)?; }
                    Ok(())
                }).unwrap();
            assert_eq!(passes, 2);
            let slice_image = slice_writer.finish().unwrap();
            let stream_image = stream_writer.finish().unwrap();
            let offsets = (0..slice_image.len()).step_by(BLOCK_SIZE);
            for offset in offsets {
                match (slice_image.block_view((offset / BLOCK_SIZE as u64) as u32),
                    stream_image.block_view((offset / BLOCK_SIZE as u64) as u32)) {
                    (BlockView::Content { id: first_id, offset: first_offset, len: first_len },
                        BlockView::Content { id, offset, len }) => {
                        assert_eq!((id, offset, len), (first_id, first_offset, first_len));
                    }
                    _ => {
                        let mut first = [0; BLOCK_SIZE];
                        let mut second = [0; BLOCK_SIZE];
                        assert_eq!(slice_image.read_at(&NoContent, offset, &mut first), Ok(BLOCK_SIZE));
                        assert_eq!(stream_image.read_at(&NoContent, offset, &mut second), Ok(BLOCK_SIZE));
                        assert_eq!(first, second);
                    }
                }
            }
        }
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let inode = writer.create_sparse_file_from(writer.root(), b"empty", 0o600, 0, 0,
            |_| Ok(())).unwrap();
        assert_eq!(writer.ino_r32(inode, INO_DATA_SEQUENCE), 1);
    }

    #[test]
    fn streamed_sparse_preflight_errors_preserve_existing_writer_state() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let snapshot = (writer.free_blocks, writer.free_inodes, writer.generation,
            writer.inode_table.as_slice().to_vec(), writer.blocks.iter().map(|(key, block)| (*key, block.as_slice().to_vec())).collect::<Vec<_>>());
        for blocks in [&[0, 0][..], &[2, 1], &[3]] {
            assert_eq!(writer.create_sparse_file_from(writer.root(), b"invalid", 0o600,
                0, 3 * BLOCK_SIZE as u64, |visit| {
                    for &block in blocks { visit(block)?; }
                    Ok(())
                }), Err(Errno::EINVAL));
        }
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            assert_eq!(writer.create_sparse_file_from(writer.root(), b"error", 0o600,
                0, 8192, |visit| { visit(0)?; Err(error) }), Err(error));
        }
        assert_eq!(writer.create_sparse_file_from(writer.root(), b"too-large", 0o600,
            0, MAX_FILE_BYTES + 1, |_| panic!("oversized input must not be traversed")), Err(Errno::EFBIG));
        assert_eq!((writer.free_blocks, writer.free_inodes, writer.generation,
            writer.inode_table.as_slice().to_vec(), writer.blocks.iter().map(|(key, block)| (*key, block.as_slice().to_vec())).collect::<Vec<_>>()), snapshot);
    }

    #[test]
    fn inode_table_growth_refusal_preserves_allocator_state_and_retries() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(1024 * 1024)).unwrap();
        while writer.total_inodes - writer.free_inodes < INODES_PER_BLOCK {
            writer.inode_alloc().unwrap();
        }
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        let state = (writer.free_inodes, writer.generation, writer.inode_table.as_slice().to_vec());
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(writer.inode_alloc(), Err(Errno::ENOMEM));
            assert_eq!((writer.free_inodes, writer.generation, writer.inode_table.as_slice().to_vec()), state);
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        }
        assert_eq!(writer.inode_alloc().unwrap(), INODES_PER_BLOCK);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > retained);
        drop(writer);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn materialized_block_admission_and_node_refusal_leave_no_unpublished_owner() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let physical = writer.block_alloc().unwrap();
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained + BLOCK_SIZE * 2);
            assert!(matches!(writer.block_mut(physical, BLOCK_SIZE), Err(Errno::ENOMEM)));
            assert!(!writer.blocks.contains_key(&physical));
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        crate::prepared_map::fail_after_allocations(0);
        assert!(matches!(writer.block_mut(physical, BLOCK_SIZE), Err(Errno::ENOMEM)));
        assert!(!writer.blocks.contains_key(&physical));
        assert_eq!(IO_MEMORY.usage().0, retained);
        writer.block_mut(physical, BLOCK_SIZE).unwrap()[0] = 91;
        assert_eq!(writer.blocks.get(&physical).unwrap()[0], 91);
        let retained = IO_MEMORY.usage().0;
        let image = writer.finish().unwrap();
        assert_eq!(IO_MEMORY.usage().0, retained + BLOCK_SIZE * 2);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn small_directory_blocks_admit_only_their_prefix_and_emit_zero_tails() {
        let baseline = IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(baseline + 1024 * 1024);
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(8 * 1024 * 1024)).unwrap();
        let mut first = 0;
        for index in 0..512 {
            let inode = writer.mkdir(ROOT_INO, &name4(index), 0o700).unwrap();
            if index == 0 { first = writer.ino_r32(inode, INO_DIRECT); }
        }
        assert_eq!(writer.blocks.values().filter(|block| block.len() == 24).count(), 512);
        assert!(IO_MEMORY.usage().0 - baseline < 1024 * 1024);
        let image = writer.finish().unwrap();
        let mut bytes = [0xcc; BLOCK_SIZE];
        assert_eq!(image.read_at(&NoContent, u64::from(first) * BLOCK_SIZE as u64, &mut bytes), Ok(BLOCK_SIZE));
        assert!(bytes[24..].iter().all(|byte| *byte == 0));
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.read_dir(ROOT_INO).unwrap().len(), 514);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn directory_record_split_admits_prefix_growth_before_shortening_old_record() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let target = writer.create_file(ROOT_INO, b"seed", 0o600, Content::Bytes(b"")).unwrap();
        let physical = writer.ino_r32(ROOT_INO, INO_DIRECT);
        w16(writer.block_mut(physical, 30).unwrap(), 28, (BLOCK_SIZE - 24) as u16);
        writer.ino_w64(ROOT_INO, INO_SIZE, BLOCK_SIZE as u64);
        let before = writer.blocks.get(&physical).unwrap().as_slice().to_vec();
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(writer.link(ROOT_INO, b"new-target", target), Err(Errno::ENOMEM));
            assert!(writer.blocks.get(&physical).unwrap().as_slice() == before.as_slice());
            assert_eq!(writer.lookup(ROOT_INO, b"seed"), Ok(Some(target)));
            assert_eq!(writer.lookup(ROOT_INO, b"new-target"), Ok(None));
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        writer.link(ROOT_INO, b"new-target", target).unwrap();
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.lookup(ROOT_INO, b"new-target"), Ok(target));
        assert_eq!(filesystem.read_dir(ROOT_INO).unwrap().len(), 4);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn indexed_free_slot_survives_denied_prefix_growth_for_retry() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let target = writer.create_file(ROOT_INO, b"seed", 0o600, Content::Bytes(b"")).unwrap();
        let physical = writer.ino_r32(ROOT_INO, INO_DIRECT);
        writer.write_dir_record(physical, 36, 0, Some((BLOCK_SIZE - 36) as u16), b"").unwrap();
        writer.ino_w64(ROOT_INO, INO_SIZE, BLOCK_SIZE as u64);
        let mut slots = IoBuffer::new();
        slots.try_push(FreeSlot { phys: physical, off: 36, rec_len: (BLOCK_SIZE - 36) as u16 }).unwrap();
        writer.dir_indexes.insert_prepared(prepare_image_entry(ROOT_INO, slots).unwrap());
        let name = vec![b'n'; 200];
        let before = writer.blocks.get(&physical).unwrap().as_slice().to_vec();
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(writer.link(ROOT_INO, &name, target), Err(Errno::ENOMEM));
            assert_eq!(writer.dir_indexes.get(&ROOT_INO).unwrap().len(), 1);
            assert!(writer.blocks.get(&physical).unwrap().as_slice() == before.as_slice());
            assert_eq!(writer.lookup(ROOT_INO, &name), Ok(None));
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        writer.link(ROOT_INO, &name, target).unwrap();
        assert!(writer.dir_indexes.get(&ROOT_INO).unwrap().is_empty());
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.lookup(ROOT_INO, &name), Ok(target));
        assert_eq!(filesystem.read_dir(ROOT_INO).unwrap().len(), 4);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn pointer_run_expansion_admits_old_and_new_backing_before_replacement() {
        let baseline = IO_MEMORY.usage().0;
        let mut page = PointerPage::default();
        for index in 0..64u16 { page.set(index * 2, u32::from(index) + 100).unwrap(); }
        let retained = IO_MEMORY.usage().0;
        let mut before = [0; BLOCK_SIZE];
        page.read_at(0, &mut before);
        {
            let _limit = crate::io_buffer::test_budget(retained + BLOCK_SIZE * 2 - 1);
            assert_eq!(page.set(128, 164), Err(Errno::ENOMEM));
            let mut after = [0; BLOCK_SIZE];
            page.read_at(0, &mut after);
            assert_eq!(before, after);
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        page.set(128, 164).unwrap();
        assert_eq!(page.get(128), 164);
        for index in 0..64u16 { assert_eq!(page.get(index * 2), u32::from(index) + 100); }
        drop(page);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn directory_tail_refusal_preserves_existing_records_and_retry() {
        for name_length in [4, 5] {
            for allowance in [Some(0), Some((DIRENT_HEADER + name_length) * 2), None] {
                let baseline = IO_MEMORY.usage().0;
                let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
                let name = |index| {
                    let mut bytes = name4(index);
                    if name_length == 5 { bytes.push(b'x'); }
                    bytes
                };
                let target = writer.create_file(ROOT_INO, &name(0), 0o600, Content::Bytes(b"")).unwrap();
                let needed = align4(DIRENT_HEADER + name_length);
                let mut index = 1;
                while writer.ino_r64(ROOT_INO, INO_SIZE) as usize % BLOCK_SIZE + needed <= BLOCK_SIZE {
                    writer.link(ROOT_INO, &name(index), target).unwrap();
                    index += 1;
                }
                assert_eq!(writer.ino_r64(ROOT_INO, INO_SIZE) as usize, BLOCK_SIZE - if name_length == 4 { 4 } else { 8 });
                let physical = writer.ino_r32(ROOT_INO, INO_DIRECT);
                let before = writer.blocks.get(&physical).unwrap().as_slice().to_vec();
                let retained = IO_MEMORY.usage().0;
                {
                    let _limit = allowance.map(|bytes| crate::io_buffer::test_budget(retained + bytes));
                    if allowance.is_none() { crate::prepared_map::fail_after_allocations(0); }
                    assert_eq!(writer.link(ROOT_INO, &name(index), target), Err(Errno::ENOMEM));
                    assert!(writer.blocks.get(&physical).unwrap().as_slice() == before.as_slice(), "directory tail changed before destination admission");
                    assert_eq!(writer.lookup(ROOT_INO, &name(0)), Ok(Some(target)));
                    assert_eq!(writer.lookup(ROOT_INO, &name(index)), Ok(None));
                    assert_eq!(IO_MEMORY.usage().0, retained);
                }
                writer.link(ROOT_INO, &name(index), target).unwrap();
                let image = writer.finish().unwrap();
                let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
                assert_eq!(filesystem.lookup(ROOT_INO, &name(index)), Ok(target));
                assert_eq!(filesystem.read_dir(ROOT_INO).unwrap().len(), index + 3);
                drop(filesystem);
                drop(image);
                assert_eq!(IO_MEMORY.usage().0, baseline);
            }
        }
    }

    #[test]
    fn pointer_and_content_map_refusal_does_not_publish_entries_and_allows_retry() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let pointer = writer.block_alloc().unwrap();
        let content = writer.block_alloc().unwrap();
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(writer.pointer_w32(pointer, 0, content), Err(Errno::ENOMEM));
            assert!(!writer.pointer_blocks.contains_key(&pointer));
            assert_eq!(writer.defer_content_block(content, 7, 0, BLOCK_SIZE), Err(Errno::ENOMEM));
            assert!(!writer.content_extents.contains_key(&content));
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        writer.pointer_w32(pointer, 0, content).unwrap();
        writer.defer_content_block(content, 7, 0, BLOCK_SIZE).unwrap();
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            writer.defer_content_block(content + 1, 7, BLOCK_SIZE as u64, BLOCK_SIZE).unwrap();
            assert_eq!(content_block(&writer.content_extents, content + 1), Some((7, BLOCK_SIZE as u64, BLOCK_SIZE as u32)));
            assert_eq!(writer.defer_content_block(content + 2, 8, 0, BLOCK_SIZE), Err(Errno::ENOMEM));
            assert_eq!(writer.content_extents.len(), 1);
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        drop(writer);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn directory_index_admission_is_unpublished_on_refusal_and_released_at_finish() {
        let baseline = IO_MEMORY.usage().0;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(4 * 1024 * 1024)).unwrap();
        let mut index = 0;
        while writer.ino_r64(ROOT_INO, INO_SIZE) < DIR_INDEX_MIN_SIZE {
            let name = alloc::format!("{index:04}-{}", "x".repeat(250));
            writer.create_file(ROOT_INO, name.as_bytes(), 0o600, Content::Bytes(b"")).unwrap();
            index += 1;
        }
        assert!(writer.dir_indexes.is_empty());
        let retained = IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(retained);
            assert_eq!(writer.ensure_dir_index(ROOT_INO), Err(Errno::ENOMEM));
            assert!(writer.dir_indexes.is_empty());
            assert_eq!(IO_MEMORY.usage().0, retained);
        }
        assert_eq!(writer.ensure_dir_index(ROOT_INO), Ok(true));
        let index_credit = IO_MEMORY.usage().0 - retained;
        assert!(index_credit > 0);
        let image = writer.finish().unwrap();
        assert_eq!(IO_MEMORY.usage().0, retained + BLOCK_SIZE * 2);
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.read_dir(ROOT_INO).unwrap().len(), index + 2);
        drop(filesystem);
        drop(image);
        assert_eq!(IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn finished_image_retains_header_and_inode_credit_until_drop() {
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(retained > baseline);
        let image = writer.finish().unwrap();
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > retained);
        drop(image);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        let writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert!(matches!(writer.finish(), Err(Errno::ENOMEM)));
        }
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn streamed_sparse_construction_rejects_changed_order_and_propagates_source_errors() {
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC, Errno::EINVAL] {
            let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
            let mut passes = 0;
            assert_eq!(writer.create_sparse_file_from(writer.root(), b"error", 0o600,
                0, 8192, |visit| {
                    passes += 1;
                    visit(0)?;
                    if passes == 2 {
                        if error == Errno::EINVAL { visit(0)?; }
                        return Err(error);
                    }
                    Ok(())
                }), Err(error));
            assert_eq!(passes, 2);
        }
    }

    #[test]
    fn streamed_near_dense_32_gib_file_needs_no_input_allocation_list() {
        let len = 32 * 1024 * 1024 * 1024u64 + 8192;
        let maximum = len + 80 * 1024 * 1024;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: maximum, max_size_bytes: Some(maximum),
            growable_to_bytes: maximum, now_ms: 0,
        }, Some(32)).unwrap();
        let mut passes = 0;
        writer.create_sparse_file_from(writer.root(), b"large", 0o600, 0, len, |visit| {
            passes += 1;
            for block in 1..(len / BLOCK_SIZE as u64) as u32 { visit(block)?; }
            Ok(())
        }).unwrap();
        assert_eq!(passes, 2);
        let image = writer.finish().unwrap();
        assert!(image.resident_bytes() < 1024 * 1024);
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let inode = filesystem.resolve(b"/large", true).unwrap();
        assert_eq!(filesystem.stat_ino(inode).unwrap().size, len);
        let mut zero = [1; 16];
        assert_eq!(filesystem.read_at(inode, 0, &mut zero), Ok(16));
        assert_eq!(zero, [0; 16]);
        let mut cursor = filesystem.file_allocations(inode,
            len / BLOCK_SIZE as u64 - 2..len / BLOCK_SIZE as u64).unwrap();
        assert_eq!(cursor.next_block(), Ok(Some((len / BLOCK_SIZE as u64 - 2) as u32)));
        assert_eq!(cursor.next_block(), Ok(Some((len / BLOCK_SIZE as u64 - 1) as u32)));
        assert_eq!(cursor.next_block(), Ok(None));
    }

    #[test]
    fn sparse_deferred_file_keeps_unwritten_blocks_unallocated() {
        struct OffsetPattern;

        impl ContentSource for OffsetPattern {
            fn read_exact_at(&self, _id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                for (index, byte) in dst.iter_mut().enumerate() {
                    *byte = ((offset + index as u64) % 251) as u8;
                }
                Ok(())
            }
        }

        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        let len = 2 * 1024 * 1024 * 1024u64 + 17;
        let last_block = (len / BLOCK_SIZE as u64) as u32;
        let blocks = [0, 1034, last_block];
        writer
            .create_file(
                writer.root(),
                b"sparse",
                0o644,
                Content::SparseDeferred {
                    id: 7,
                    len,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let image = writer.finish().unwrap();
        assert!(image.len() < 256 * 1024);
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &OffsetPattern,
        })
        .unwrap();
        let ino = filesystem.resolve(b"/sparse", true).unwrap();
        for block in blocks {
            let mut byte = [0];
            assert_eq!(
                filesystem.read_at(ino, block as u64 * BLOCK_SIZE as u64, &mut byte),
                Ok(1)
            );
            assert_eq!(byte[0], (block as u64 * BLOCK_SIZE as u64 % 251) as u8);
        }
        let mut hole = [1u8; 32];
        assert_eq!(filesystem.read_at(ino, 1024 * 1024 * 1024, &mut hole), Ok(32));
        assert_eq!(hole, [0; 32]);
        let mut end = [0; 32];
        assert_eq!(filesystem.read_at(ino, len - 17, &mut end), Ok(17));
    }

    #[test]
    fn extended_sparse_file_crosses_double_indirect_limit_without_resident_hole() {
        struct OffsetPattern;

        impl ContentSource for OffsetPattern {
            fn read_exact_at(&self, _id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                for (index, byte) in dst.iter_mut().enumerate() {
                    *byte = ((offset + index as u64) % 251) as u8;
                }
                Ok(())
            }
        }

        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        let len = 9 * 1024 * 1024 * 1024u64 + 7;
        let last_block = (len / BLOCK_SIZE as u64) as u32;
        let blocks = [
            0,
            V1_MAX_FILE_BLOCKS as u32 - 1,
            V1_MAX_FILE_BLOCKS as u32,
            last_block,
        ];
        writer
            .create_file(
                writer.root(),
                b"extended",
                0o644,
                Content::SparseDeferred {
                    id: 7,
                    len,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let image = writer.finish().unwrap();
        assert!(image.len() < 256 * 1024);
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &OffsetPattern,
        })
        .unwrap();
        assert_eq!(
            filesystem.geometry().version,
            KANDELO_IMAGE_EXTENDED_VERSION
        );
        let ino = filesystem.resolve(b"/extended", true).unwrap();
        assert_eq!(filesystem.allocated_file_blocks(ino), Ok(blocks.to_vec()));
        for block in blocks {
            let mut byte = [0];
            let offset = block as u64 * BLOCK_SIZE as u64;
            assert_eq!(filesystem.read_at(ino, offset, &mut byte), Ok(1));
            assert_eq!(byte[0], (offset % 251) as u8);
        }
        let mut hole = [1u8; 16];
        assert_eq!(filesystem.read_at(ino, len - BLOCK_SIZE as u64 - 16, &mut hole), Ok(16));
        assert_eq!(hole, [0; 16]);
        let mut tail = [0u8; 16];
        assert_eq!(filesystem.read_at(ino, len - 7, &mut tail), Ok(7));
    }

    #[test]
    fn sparse_file_at_the_v1_limit_keeps_the_v1_image_format() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        let blocks = [V1_MAX_FILE_BLOCKS as u32 - 1];
        writer
            .create_file(
                writer.root(),
                b"v1-limit",
                0o644,
                Content::SparseDeferred {
                    id: 1,
                    len: V1_MAX_FILE_BYTES,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &NoContent,
        })
        .unwrap();
        assert_eq!(filesystem.geometry().version, KANDELO_IMAGE_VERSION);
        let ino = filesystem.resolve(b"/v1-limit", true).unwrap();
        assert_eq!(filesystem.allocated_file_blocks(ino), Ok(blocks.to_vec()));
    }

    #[test]
    fn invalid_sparse_block_map_does_not_mutate_the_writer() {
        let mut writer = KandeloImageWriter::mkfs(small_config()).unwrap();
        let free_blocks = writer.free_blocks;
        let free_inodes = writer.free_inodes;
        let generation = writer.generation;
        for blocks in [&[1, 1][..], &[2, 1], &[3, 4]] {
            assert_eq!(
                writer.create_file(
                    writer.root(),
                    b"invalid",
                    0o644,
                    Content::SparseDeferred {
                        id: 1,
                        len: 4 * BLOCK_SIZE as u64,
                        blocks,
                    }
                ),
                Err(Errno::EINVAL)
            );
            assert_eq!(writer.free_blocks, free_blocks);
            assert_eq!(writer.free_inodes, free_inodes);
            assert_eq!(writer.generation, generation);
        }
    }

    #[test]
    fn oversized_file_does_not_mutate_the_image_writer() {
        let mut writer = KandeloImageWriter::mkfs(small_config()).expect("mkfs");
        let free_blocks = writer.free_blocks;
        let free_inodes = writer.free_inodes;
        let generation = writer.generation;
        assert_eq!(
            writer.create_file(
                writer.root(),
                b"too-large",
                0o644,
                Content::Deferred {
                    id: 1,
                    len: MAX_FILE_BYTES + 1,
                },
            ),
            Err(Errno::EFBIG)
        );
        assert_eq!(writer.free_blocks, free_blocks);
        assert_eq!(writer.free_inodes, free_inodes);
        assert_eq!(writer.generation, generation);
        writer
            .create_file(writer.root(), b"valid", 0o644, Content::Bytes(b"ok"))
            .expect("create after refusal");
        let image = writer.finish().expect("finish");
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &NoContent,
        })
        .expect("mount");
        assert_eq!(filesystem.resolve(b"/too-large", true), Err(Errno::ENOENT));
        assert!(filesystem.resolve(b"/valid", true).is_ok());
    }

    // ── Geometry and failure modes ───────────────────────────────────

    #[test]
    fn bitmap_prefix_windows_match_little_endian_bits_at_all_boundaries() {
        for allocated in (0..=260u32).chain([32_767, 32_768, 32_769, 65_535, u32::MAX - 1, u32::MAX]) {
            let boundary = u64::from(allocated / 8);
            for offset in [0, 1, 31, 4094, 4095, 4096, boundary.saturating_sub(1), boundary,
                boundary + 1, u64::MAX - 8, u64::MAX]
            {
                let mut bytes = [0xa5; 17];
                read_bitmap_prefix(allocated, offset, &mut bytes);
                for (index, byte) in bytes.into_iter().enumerate() {
                    let start_bit = (u128::from(offset) + index as u128) * 8;
                    let mut expected = 0;
                    for bit in 0..8u32 {
                        if start_bit + u128::from(bit) < u128::from(allocated) {
                            expected |= 1 << bit;
                        }
                    }
                    assert_eq!(byte, expected, "allocated={allocated} offset={offset} index={index}");
                }
                read_bitmap_prefix(allocated, offset, &mut []);
            }
        }
    }

    #[test]
    fn bitmap_prefix_allocators_preserve_growth_generations_and_exhaustion() {
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 16 * BLOCK_SIZE as u64, max_size_bytes: Some(33 * BLOCK_SIZE as u64),
            growable_to_bytes: 33 * BLOCK_SIZE as u64, now_ms: 0,
        }, Some(67)).unwrap();
        let first = writer.total_blocks - writer.free_blocks;
        for block in first..16 {
            assert_eq!(writer.block_alloc_no_grow(), Some(block));
        }
        assert_eq!(writer.block_alloc_no_grow(), None);
        let generation = writer.generation;
        assert_eq!(writer.block_alloc(), Ok(16));
        assert_eq!(writer.total_blocks, 33);
        assert_eq!(writer.generation, generation + 1);
        for block in 17..33 { assert_eq!(writer.block_alloc(), Ok(block)); }
        assert_eq!(writer.block_alloc(), Err(Errno::ENOSPC));
        assert_eq!(writer.generation, generation + 1);
        assert_eq!(writer.free_blocks, 0);
        assert_eq!(writer.require_inode(0), Err(Errno::ENOENT));
        assert_eq!(writer.require_inode(ROOT_INO), Ok(()));
        for inode in 2..67 {
            assert_eq!(writer.require_inode(inode), Err(Errno::ENOENT));
            assert_eq!(writer.inode_alloc(), Ok(inode));
            assert_eq!(writer.require_inode(inode), Ok(()));
        }
        assert_eq!(writer.inode_alloc(), Err(Errno::ENOSPC));
        assert_eq!(writer.free_inodes, 0);
        assert_eq!(writer.generation, generation + 66);
        let bitmap_start = writer.inode_bitmap_start;
        let image = writer.finish().unwrap();
        let mut bytes = [0; 16];
        image.read_at(&NoContent, u64::from(bitmap_start) * BLOCK_SIZE as u64, &mut bytes).unwrap();
        assert_eq!(&bytes[..8], &[255; 8]);
        assert_eq!(bytes[8], 7);
        assert_eq!(&bytes[9..], &[0; 7]);
    }

    #[test]
    fn bitmap_prefix_maximum_format_capacity_needs_no_resident_bitmap_pages() {
        let maximum = u64::from(u32::MAX) * BLOCK_SIZE as u64;
        let writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(maximum),
            growable_to_bytes: maximum, now_ms: 0,
        }, Some(32)).unwrap();
        let bitmap_start = writer.block_bitmap_start;
        let bitmap_blocks = writer.block_bitmap_blocks;
        let allocated = writer.total_blocks - writer.free_blocks;
        let image = writer.finish().unwrap();
        assert!(image.len() > 512 * 1024 * 1024);
        assert!(image.resident_bytes() < 16 * 1024);
        let mut bytes = [0; BLOCK_SIZE];
        image.read_at(&NoContent, u64::from(bitmap_start) * BLOCK_SIZE as u64, &mut bytes).unwrap();
        assert_eq!(bytes, [255; BLOCK_SIZE]);
        let boundary = u64::from(bitmap_start) * BLOCK_SIZE as u64 + u64::from(allocated / 8);
        image.read_at(&NoContent, boundary, &mut bytes).unwrap();
        assert_eq!(bytes[0], ((1u16 << (allocated % 8)) - 1) as u8);
        assert!(bytes[1..].iter().all(|byte| *byte == 0));
        let last = u64::from(bitmap_start + bitmap_blocks - 1) * BLOCK_SIZE as u64;
        image.read_at(&NoContent, last, &mut bytes).unwrap();
        assert_eq!(bytes, [0; BLOCK_SIZE]);
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        assert_eq!(filesystem.growth_ceiling_bytes(), Ok(maximum));
        assert_eq!(filesystem.statfs().unwrap().f_bfree, 0);
    }

    #[test]
    fn bitmap_prefix_survives_a_failed_creation_without_freeing_allocations() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        writer.create_file(writer.root(), b"kept", 0o644, Content::Bytes(b"kept")).unwrap();
        assert_eq!(writer.create_file(writer.root(), b"huge", 0o644,
            Content::Deferred { id: 7, len: 256 * 1024 }), Err(Errno::ENOSPC));
        let allocated = writer.total_blocks - writer.free_blocks;
        let bitmap_start = writer.block_bitmap_start;
        let image = writer.finish().unwrap();
        let mut bytes = [0; 32];
        image.read_at(&NoContent, u64::from(bitmap_start) * BLOCK_SIZE as u64, &mut bytes).unwrap();
        for block in 0..bytes.len() * 8 {
            assert_eq!(bytes[block / 8] & (1 << (block % 8)) != 0, block < allocated as usize);
        }
        let filesystem = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &NoContent }).unwrap();
        let inode = filesystem.resolve(b"/kept", true).unwrap();
        let mut kept = [0; 4];
        assert_eq!(filesystem.read_at(inode, 0, &mut kept), Ok(4));
        assert_eq!(&kept, b"kept");
    }

    #[test]
    fn allocated_bitmap_prefix_stays_constant_memory_for_a_32_gib_working_set() {
        let maximum = 34 * 1024 * 1024 * 1024u64;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: maximum, max_size_bytes: Some(maximum),
            growable_to_bytes: maximum, now_ms: 0,
        }, Some(32)).unwrap();
        let first = writer.total_blocks - writer.free_blocks;
        for index in 0..(1u32 << 23) {
            assert_eq!(writer.block_alloc_no_grow(), Some(first + index));
        }
        let bitmap_start = writer.block_bitmap_start;
        let allocated = writer.total_blocks - writer.free_blocks;
        let image = writer.finish().unwrap();
        assert!(image.resident_bytes() < 64 * 1024);
        let mut bytes = [0u8; 32];
        let offset = u64::from(bitmap_start) * BLOCK_SIZE as u64 + u64::from(allocated / 8) - 16;
        assert_eq!(image.read_at(&NoContent, offset, &mut bytes), Ok(bytes.len()));
        for (index, byte) in bytes.into_iter().enumerate() {
            let byte_index = u64::from(allocated / 8) - 16 + index as u64;
            let expected = if byte_index < u64::from(allocated / 8) { 255 }
                else if byte_index == u64::from(allocated / 8) { ((1u16 << (allocated % 8)) - 1) as u8 }
                else { 0 };
            assert_eq!(byte, expected);
        }
    }

    #[test]
    fn large_possible_capacity_keeps_unallocated_inode_pages_out_of_memory() {
        let maximum = 8 * 1024 * 1024 * 1024u64;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 64 * 1024 * 1024,
            max_size_bytes: Some(maximum),
            growable_to_bytes: maximum,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = writer.root();
        for index in 0..40 {
            writer
                .create_file(
                    root,
                    format!("file-{index}").as_bytes(),
                    0o644,
                    Content::Bytes(b""),
                )
                .expect("create");
        }
        assert_eq!(writer.total_inodes - writer.free_inodes, 42);
        assert_eq!(writer.inode_table.len(), 2 * BLOCK_SIZE);
        let missing = writer.total_inodes - 1;
        assert_eq!(writer.mkdir(missing, b"child", 0o755), Err(Errno::ENOENT));
        assert_eq!(writer.link(root, b"invalid", missing), Err(Errno::ENOENT));
        assert_eq!(writer.set_owner(missing, 1, 1), Err(Errno::ENOENT));
        assert_eq!(writer.set_mode(missing, 0o644), Err(Errno::ENOENT));
        assert_eq!(writer.set_times(missing, 1, 1, 1), Err(Errno::ENOENT));
        let unused_blocks = [
            writer.block_bitmap_start - 1,
            writer.inode_table_start - 1,
            writer.inode_table_start + writer.inode_table_blocks - 1,
        ];
        let image = writer.finish().expect("finish");
        assert!(image.resident_bytes() < 128 * 1024);
        let mut bytes = [1u8; BLOCK_SIZE];
        for block in unused_blocks {
            bytes.fill(1);
            assert_eq!(
                image.read_at(&NoContent, block as u64 * BLOCK_SIZE as u64, &mut bytes),
                Ok(BLOCK_SIZE),
            );
            assert!(bytes.iter().all(|byte| *byte == 0));
        }
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &NoContent,
        })
        .expect("mount");
        assert!(filesystem.resolve(b"/file-39", true).is_ok());
    }

    #[test]
    fn bitmap_prefix_emits_allocations_across_a_bitmap_page() {
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(256 * 1024 * 1024))
            .expect("mkfs");
        writer
            .create_file(
                writer.root(),
                b"large",
                0o644,
                Content::Deferred {
                    id: 7,
                    len: 132 * 1024 * 1024,
                },
            )
            .expect("create");
        assert!(writer.total_blocks - writer.free_blocks > 32_768);
        let second_bitmap_block = writer.block_bitmap_start + 1;
        let image = writer.finish().expect("finish");
        let mut bytes = [0u8; BLOCK_SIZE];
        assert_eq!(
            image.read_at(
                &NoContent,
                second_bitmap_block as u64 * BLOCK_SIZE as u64,
                &mut bytes,
            ),
            Ok(BLOCK_SIZE),
        );
        assert_ne!(bytes[0] & 1, 0);
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &NoContent,
        })
        .expect("mount");
        let inode = filesystem.resolve(b"/large", true).expect("resolve");
        assert_eq!(
            filesystem.stat_ino(inode).expect("stat").size,
            132 * 1024 * 1024,
        );
    }

    #[test]
    fn mkfs_rejects_sizes_the_vendor_would_reject() {
        assert!(
            KandeloImageWriter::mkfs(KandeloImageConfig::fixed(4096 * 15)).is_err(),
            "under 16 blocks"
        );
        assert!(
            KandeloImageWriter::mkfs(KandeloImageConfig {
                size_bytes: 128 * 1024 + 1,
                max_size_bytes: None,
                growable_to_bytes: 128 * 1024 + 1,
                now_ms: 0,
            })
            .is_err(),
            "a ragged tail is ambiguous and must be refused"
        );
    }

    #[test]
    fn mkfs_rejects_a_bitmap_that_cannot_describe_the_initial_image() {
        let config = |size_bytes, max_size_bytes| KandeloImageConfig {
            size_bytes,
            max_size_bytes: Some(max_size_bytes),
            growable_to_bytes: size_bytes,
            now_ms: 0,
        };
        assert!(matches!(
            KandeloImageWriter::mkfs(config(64 * 1024, 0)),
            Err(Errno::EINVAL)
        ));
        assert!(matches!(
            KandeloImageWriter::mkfs(config(128 * 1024 * 1024 + BLOCK_SIZE as u64, 4096)),
            Err(Errno::EINVAL)
        ));
        assert!(KandeloImageWriter::mkfs(config(128 * 1024 * 1024, 4096)).is_ok());
    }

    /// Running out of BLOCKS, which is a different exhaustion from running out
    /// of inodes and was not covered.
    ///
    /// The test below is named for a full filesystem and fills it with 4096
    /// tiny files, which exhausts the INODE table first -- measured by handing
    /// `block_alloc` a mutation that returns block zero on its out-of-space
    /// path and watching every assertion still pass. The block allocator's
    /// ENOSPC was reachable only through code no test ran.
    ///
    /// One file larger than the filesystem reaches it directly.
    #[test]
    fn exhausting_blocks_reports_enospc_and_leaves_a_mountable_image() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).expect("mkfs");
        let root = w.root();
        w.create_file(root, b"small", 0o644, Content::Bytes(b"kept"))
            .expect("a small file fits");

        // Larger than the whole filesystem: this cannot be satisfied by any
        // number of blocks the configuration allows.
        let huge = alloc::vec![9u8; 256 * 1024];
        assert_eq!(
            w.create_file(root, b"huge", 0o644, Content::Bytes(&huge)).err(),
            Some(Errno::ENOSPC),
            "a file larger than the filesystem must be refused, not truncated",
        );

        // And the refusal leaves what was already written readable.
        let image = w.finish().expect("finish after a refused write");
        let content = NoContent;
        let fs = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &content })
            .expect("a refused write leaves a mountable image");
        let small = fs.resolve(b"/small", true).expect("the earlier file survives");
        let mut buf = [0u8; 8];
        let n = fs.read_at(small, 0, &mut buf).expect("read");
        assert_eq!(&buf[..n], b"kept", "a survivor's bytes are its own");
    }

    /// A producer that DECLARES it describes its deferred files must emit the
    /// section even with none to describe.
    ///
    /// The distinction is between "this image says it has no deferred files"
    /// and "this image says nothing", and only the first is safe for a loader
    /// to trust. `rootfs::build_export_image` declares it; a writer driven by
    /// a host that keeps its lazy manifest in JSON beside the image must not,
    /// because for that image no section IS the truth.
    ///
    /// Nothing covered it: deleting `!self.declares_deferred` from the emit
    /// guard left the whole suite green, so a declaring producer could fall
    /// silent and no test would notice.
    #[test]
    fn a_declaring_producer_emits_the_section_even_with_nothing_to_declare() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).expect("mkfs");
        let root = w.root();
        w.create_file(root, b"plain", 0o644, Content::Bytes(b"no deferred files here"))
            .expect("create");
        w.declare_deferred_section().unwrap();

        let image = w.finish().expect("finish");
        let content = NoContent;
        let fs = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &content })
            .expect("mount");
        assert_ne!(
            fs.geometry().deferred_inode,
            0,
            "a declaring producer emitted NO deferred section, which a loader \
             cannot tell from an image that never described its deferred files",
        );

        // And a producer that does not declare stays silent, so the assertion
        // above is about the declaration rather than about a section this
        // writer always emits.
        let mut quiet = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).expect("mkfs");
        let quiet_root = quiet.root();
        quiet
            .create_file(quiet_root, b"plain", 0o644, Content::Bytes(b"same tree"))
            .expect("create");
        let quiet_image = quiet.finish().expect("finish");
        let quiet_fs = KandeloImageFs::mount(KandeloImageSource { image: &quiet_image, content: &content })
            .expect("mount");
        assert_eq!(quiet_fs.geometry().deferred_inode, 0);
    }

    #[test]
    fn a_full_filesystem_reports_enospc_rather_than_corrupting() {
        // Truthful failure: a writer that ran out of blocks must say so.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).expect("mkfs");
        let root = w.root();
        let mut last = Ok(0);
        for i in 0..4096 {
            let name = format!("f{i}").into_bytes();
            last = w.create_file(root, &name, 0o644, Content::Bytes(&[7u8; 4096]));
            if last.is_err() {
                break;
            }
        }
        assert_eq!(last.err(), Some(Errno::ENOSPC));

        // "rather than corrupting" is the half of this test's own name that
        // nothing asserted. A writer that runs out of blocks mid-tree must
        // leave what it already wrote intact and MOUNTABLE -- an image that
        // reports ENOSPC and then cannot be read is worse than one that
        // refuses at the start, because the failure moves to whoever loads it.
        let image = w.finish().expect("a full filesystem still finishes");
        let content = NoContent;
        let fs = KandeloImageFs::mount(KandeloImageSource { image: &image, content: &content })
            .expect("a full filesystem is still a mountable one");
        let root = fs.stat_ino(ROOT_INO).expect("root survives the failed write");
        assert_eq!(root.mode & 0xf000, 0x4000);

        // The first file written is still there, with its exact bytes.
        let first = fs.resolve(b"/f0", true).expect("the first file survives");
        let mut buf = [0u8; 8];
        let n = fs.read_at(first, 0, &mut buf).expect("read the first file");
        assert_eq!(&buf[..n], &[7u8; 8], "a survivor's bytes are its own");
    }

    #[test]
    fn duplicate_names_and_bad_names_are_refused() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        w.mkdir(root, b"a", 0o755).expect("mkdir");
        assert_eq!(w.mkdir(root, b"a", 0o755).err(), Some(Errno::EEXIST));
        assert_eq!(
            w.create_file(root, b"a", 0o644, Content::Bytes(b"")).err(),
            Some(Errno::EEXIST)
        );
        assert_eq!(w.mkdir(root, b".", 0o755).err(), Some(Errno::EINVAL));
        assert_eq!(w.mkdir(root, b"..", 0o755).err(), Some(Errno::EINVAL));
        assert_eq!(w.mkdir(root, b"a/b", 0o755).err(), Some(Errno::EINVAL));
        assert_eq!(w.mkdir(root, b"", 0o755).err(), Some(Errno::EINVAL));
        let long = alloc::vec![b'x'; 256];
        assert_eq!(w.mkdir(root, &long, 0o755).err(), Some(Errno::ENAMETOOLONG));

        // A non-directory parent is ENOTDIR, and a directory cannot be
        // hard-linked.
        let f = w
            .create_file(root, b"f", 0o644, Content::Bytes(b"x"))
            .expect("create");
        assert_eq!(w.mkdir(f, b"child", 0o755).err(), Some(Errno::ENOTDIR));
        let d = w.lookup(root, b"a").unwrap().unwrap();
        assert_eq!(w.link(root, b"dlink", d).err(), Some(Errno::EPERM));
    }

    #[test]
    fn growth_extends_the_image_and_bumps_the_generation() {
        // The vendor grows in 256-block chunks and bumps SB_GENERATION each
        // time. An image that must grow is a different image from one sized
        // correctly up front, so the writer has to model it rather than
        // assume a caller always sizes perfectly.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(4 * 1024 * 1024),
            growable_to_bytes: 4 * 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let before = w.total_blocks;
        let generation_before = w.generation;
        let root = w.root();
        w.create_file(root, b"big", 0o644, Content::Bytes(&[3u8; 200_000]))
            .expect("create");
        assert!(w.total_blocks > before, "the image grew");
        assert_eq!(
            (w.total_blocks - before) % GROW_CHUNK_BLOCKS,
            0,
            "growth happens in whole chunks"
        );
        let grows = (w.total_blocks - before) / GROW_CHUNK_BLOCKS;
        // One generation bump per grow, plus one per inode allocated.
        assert_eq!(w.generation, generation_before + grows + 1);

        let image = w.finish().expect("finish");
        // The grown image is still mountable and the file still reads back.
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount grown image");
        let ino = fs.resolve(b"/big", true).expect("resolve");
        assert_eq!(fs.stat_ino(ino).unwrap().size, 200_000);
    }

    #[test]
    fn a_fixed_length_image_refuses_to_grow() {
        // `growable_to_bytes == size_bytes` models a non-growable
        // SharedArrayBuffer, where the vendor's `buffer.grow()` throws and
        // the allocation fails. A generous `max_size_bytes` must not
        // override that.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(4 * 1024 * 1024),
            growable_to_bytes: 64 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        assert_eq!(
            w.create_file(root, b"big", 0o644, Content::Bytes(&[3u8; 200_000]))
                .err(),
            Some(Errno::ENOSPC)
        );
    }

    #[test]
    fn explicit_timestamps_reach_the_inode() {
        // The fixtures pin times to zero because the TypeScript writer
        // stamps `Date.now()` unconditionally. A kernel-written image needs
        // real mtimes, so the writer must be able to set them.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        let ino = w
            .create_file(root, b"f", 0o644, Content::Bytes(b"x"))
            .expect("create");
        w.set_times(ino, 111, 222, 333).expect("set times");
        let image = w.finish().expect("finish");
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        let st = fs.stat_ino(ino).expect("stat");
        assert_eq!((st.atime_ms, st.mtime_ms, st.ctime_ms), (111, 222, 333));
    }

    // ── Deferred files carried in the body ───────────────────────────

    #[test]
    fn a_deferred_file_round_trips_through_the_existing_reader() {
        // One writer produces the stub and the record, in one artifact, so the
        // two cannot disagree. That is the whole reason the record lives in
        // the body instead of a separate section written by somebody else.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        let url: &[u8] = b"https://example.invalid/big.bin";
        let deferred = w
            .create_deferred_file(root, b"big.bin", 0o644, 4242, 0, b"", b"", b"", url)
            .expect("deferred");
        write_file(&mut w, root, b"present", Content::Bytes(b"here"), 0o600, 0, 0);
        let image = w.finish().expect("finish");

        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");

        // The stub is a real, ordinary file in the tree.
        let ino = fs.resolve(b"/big.bin", true).expect("resolve");
        assert_eq!(ino, deferred);
        assert_eq!(fs.stat_ino(ino).unwrap().mode, 0x8000 | 0o644);

        let section = fs
            .deferred_section()
            .expect("read section")
            .expect("section present");
        assert_eq!(section.len(), 1);
        let record = section.get(deferred).expect("record for the stub");
        assert_eq!(record.size, 4242);
        assert_eq!(record.payload, url);

        // The ordinary file is not in the section.
        let present = fs.resolve(b"/present", true).unwrap();
        assert!(section.get(present).is_none());
    }

    #[test]
    fn an_image_with_no_deferred_files_carries_no_section_and_costs_nothing() {
        // The common case must not pay for the rare one. An image that defers
        // nothing allocates no extra block and writes a zero in the superblock
        // — which is exactly what every image written before this section
        // existed already has there.
        let mut plain = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = plain.root();
        write_file(&mut plain, root, b"f", Content::Bytes(b"x"), 0o644, 0, 0);
        let plain = plain.finish().expect("finish");

        let bytes = plain.to_vec(&NoContent).expect("emit");
        assert_eq!(
            u32::from_le_bytes([bytes[76], bytes[77], bytes[78], bytes[79]]),
            0,
            "no section means a zero in the superblock"
        );

        let source = KandeloImageSource {
            image: &plain,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        assert!(fs.deferred_section().expect("no section").is_none());
    }

    #[test]
    fn an_archive_members_linkage_survives_into_the_image() {
        // The round trip that matters for kernel-written images: the writer is told which archive
        // backs a file and which member within it, and a reader of the finished
        // image gets those back. Without this the export could emit a deferred
        // record that says a file is deferred but not where its bytes are.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        w.declare_lazy_archive(7, 8_000_000, b"", b"", b"")
            .expect("declare archive 7");
        let deferred = w
            .create_deferred_file(
                root,
                b"php",
                0o755,
                99_999,
                7,
                b"usr/bin/php",
                b"",
                b"",
                b"",
            )
            .expect("deferred");
        let image = w.finish().expect("finish");

        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        let record = fs
            .deferred_section()
            .expect("read section")
            .expect("section present")
            .get(deferred)
            .cloned()
            .expect("record for the stub");
        assert_eq!(record.archive_id, 7);
        assert_eq!(record.source_path, b"usr/bin/php");
        assert_eq!(record.size, 99_999);
        // The archive's length rides in the section too, because fetching one
        // member means fetching the archive, and that read has to be bounded.
        assert_eq!(
            fs.deferred_section()
                .expect("read section")
                .expect("section present")
                .archive_bytes(7),
            Some(8_000_000),
        );

        // The body still holds a zero-length stub: the point is to describe the
        // bytes, not to materialize them.
        assert_eq!(fs.stat_ino(deferred).expect("stat").size, 0);
    }

    #[test]
    fn a_member_of_an_undeclared_archive_cannot_be_finished_into_an_image() {
        // A record pointing at an archive with no declared length is a dangling
        // reference: something would have to fetch an archive without knowing
        // how much to read. Refused at `finish`, which is the first moment the
        // writer can see the whole section.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        w.create_deferred_file(
            root,
            b"php",
            0o755,
            99_999,
            7,
            b"usr/bin/php",
            b"",
            b"",
            b"",
        )
        .expect("the record itself is well-formed");
        assert_eq!(w.finish().err(), Some(Errno::EINVAL));
    }

    #[test]
    fn one_archive_cannot_be_declared_with_two_lengths() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        w.declare_lazy_archive(7, 100, b"", b"", b"")
            .expect("first declaration");
        assert_eq!(
            w.declare_lazy_archive(7, 200, b"", b"", b""),
            Err(Errno::EINVAL)
        );
        // And an archive id of zero is the "no archive" sentinel, not an id.
        assert_eq!(
            w.declare_lazy_archive(0, 100, b"", b"", b""),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn an_oversized_member_path_is_refused_by_the_writer_not_by_finish() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        let too_long = alloc::vec![b'x'; crate::sdef::MAX_SOURCE_PATH_LEN as usize + 1];
        assert_eq!(
            w.create_deferred_file(root, b"a", 0o644, 10, 4, &too_long, b"", b"", b""),
            Err(Errno::EINVAL)
        );
        // The refusal has to happen HERE. If it only happened in `encode`, the
        // writer would accept the file, create its name, and fail much later at
        // `finish` — with the tree already built and nothing pointing at the
        // call that was wrong. Finishing cleanly is what proves that.
        w.finish().expect("the writer was left in a usable state");
    }

    #[test]
    fn a_half_specified_archive_linkage_is_refused_at_the_call() {
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();

        // An archive with no member to extract from it.
        assert_eq!(
            w.create_deferred_file(root, b"a", 0o644, 10, 4, b"", b"", b"", b""),
            Err(Errno::EINVAL)
        );
        // A member with no archive to extract it from.
        assert_eq!(
            w.create_deferred_file(root, b"b", 0o644, 10, 0, b"m", b"", b"", b""),
            Err(Errno::EINVAL)
        );
        // Refused at the CALL, not at `finish`: neither name was created, so
        // the writer is not left holding a file it will later fail to describe.
        assert!(
            w.create_deferred_file(root, b"a", 0o644, 10, 4, b"m", b"", b"", b"")
                .is_ok()
        );
    }

    #[test]
    fn the_section_inode_is_unreachable_by_name() {
        // The inode holding the section is deliberately unlinked. Nothing in
        // the directory tree points at it, so no path resolves to it and no
        // directory walk returns it — the superblock is the only thing that
        // names it.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        w.create_deferred_file(root, b"a", 0o644, 10, 0, b"", b"", b"", b"u")
            .expect("deferred");
        let image = w.finish().expect("finish");
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");

        let names: Vec<Vec<u8>> = fs
            .read_dir(ROOT_INO)
            .expect("read_dir")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names.len(), 3, "., .. and a — nothing else");
        assert!(names.iter().any(|n| n == b"a"));

        // It is nonetheless a live inode, because the superblock names it.
        // A consistency checker that walks only directories would call this a
        // leak; it must read the superblock field first.
        let section_ino = fs.geometry().deferred_inode;
        assert!(section_ino != 0);
        assert_eq!(fs.stat_ino(section_ino).unwrap().nlink, 1);
    }

    #[test]
    fn many_deferred_files_keep_their_own_payloads() {
        // Records are keyed by inode and looked up by binary search, so a
        // mixed tree must not cross payloads between files.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 1024 * 1024,
            max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let root = w.root();
        let dir = w.mkdir(root, b"d", 0o755).expect("mkdir");
        let mut expected = alloc::vec::Vec::new();
        for i in 0..64usize {
            let name = format!("f{i}").into_bytes();
            let payload = format!("https://example.invalid/{i}").into_bytes();
            let parent = if i % 2 == 0 { root } else { dir };
            // Interleave ordinary files so the stubs are not contiguous.
            if i % 3 == 0 {
                let ordinary = format!("o{i}").into_bytes();
                write_file(&mut w, parent, &ordinary, Content::Bytes(b"z"), 0o644, 0, 0);
            }
            let ino = w
                .create_deferred_file(
                    parent,
                    &name,
                    0o644,
                    i as u64 * 1000,
                    0,
                    b"",
                    b"",
                    b"",
                    &payload,
                )
                .expect("deferred");
            expected.push((ino, i as u64 * 1000, payload));
        }
        let image = w.finish().expect("finish");
        let source = KandeloImageSource {
            image: &image,
            content: &NoContent,
        };
        let fs = KandeloImageFs::mount(source).expect("mount");
        let section = fs.deferred_section().unwrap().expect("section");
        assert_eq!(section.len(), 64);
        for (ino, size, payload) in expected {
            let record = section.get(ino).expect("record");
            assert_eq!(record.size, size);
            assert_eq!(record.payload, payload, "payload for inode {ino}");
        }
    }

    #[test]
    fn a_corrupt_section_is_refused_rather_than_half_read() {
        // The section is untrusted input: an image can arrive from a shared
        // link. A damaged section must fail the read, not yield some records.
        let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).expect("mkfs");
        let root = w.root();
        w.create_deferred_file(root, b"a", 0o644, 10, 0, b"", b"", b"", b"payload")
            .expect("deferred");
        let image = w.finish().expect("finish");
        let mut bytes = image.to_vec(&NoContent).expect("emit");

        // Find the section by its magic and break it.
        let at = bytes
            .windows(4)
            .position(|w| w == b"SDEF")
            .expect("section is in the image");
        bytes[at + 8] ^= 0xff; // record count

        let fs = KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        assert!(
            fs.deferred_section().is_err(),
            "a corrupt section must be refused"
        );
    }

}
