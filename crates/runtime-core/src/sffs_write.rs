//! Writer for the on-disk SFFS ("SharedFileSystem") image body.
//!
//! `sffs.rs` is the reader this repository already trusts: it mounts the real
//! 249 MiB `/` image and serves every base file's bytes out of it. This module
//! is its inverse — it BUILDS that body from a tree, so the kernel can emit a
//! VFS image without a TypeScript writer in the loop.
//!
//! # Why this is a port and not a fresh design
//!
//! The image body is a real block filesystem, and an image the kernel writes
//! must be readable by everything that reads images today. So the layout
//! decisions here are not free: they reproduce
//! `host/src/vfs/sharedfs-vendor.ts` — the same superblock geometry, the same
//! first-fit block and inode allocators, the same ext2-style variable-length
//! directory records with padding entries and `rec_len` extension, and the
//! same threshold above which that file's in-process directory index changes
//! where a new record lands. Reproducing the allocator is what makes the
//! cross-language fixture a BYTE comparison rather than a "both sides parse"
//! comparison, and a byte comparison is the only one that would catch a
//! writer that is merely self-consistent.
//!
//! # Why emission is a cursor, not a `Vec<u8>`
//!
//! `lamp.vfs` is 249 MiB and the kernel cannot hold an image in linear memory.
//! So the writer never materializes file CONTENT: a data block that carries
//! file bytes is recorded as a reference into a [`ContentSource`]
//! (`id` + offset + length) and resolved only when [`SffsImage::read_at`]
//! reaches it. What IS materialized is metadata — superblock, the two bitmaps,
//! the inode table, directory data, indirect blocks — which for the largest
//! image in the repo is a few MiB, the same order as the budget the reader
//! already spends walking one.
//!
//! [`SffsImage::read_at`] has the shape `rootfs::export_tree_read(offset, out)`
//! already needs, so streaming emission (W-3) layers on top of this without
//! redesigning the layout pass, and without a new host import.

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use crate::sffs::{
    BlockSource, DIRECT_BLOCKS, DIRENT_HEADER, INLINE_SYMLINK_SIZE, INODES_PER_BLOCK, INODE_SIZE,
    INO_ATIME, INO_CTIME, INO_DIRECT, INO_DOUBLE_INDIRECT, INO_GENERATION, INO_GID, INO_INDIRECT,
    INO_LINK_COUNT, INO_MODE, INO_MTIME, INO_SIZE, INO_UID, PTRS_PER_BLOCK, ROOT_INO, SFFS_MAGIC,
    SFFS_VERSION,
};

const BLOCK_SIZE: usize = 4096;

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
/// policy differs from the linear scan (see [`SffsWriter::dir_add_entry`]).
const DIR_INDEX_MIN_SIZE: u64 = 64 * 1024;

const GROW_CHUNK_BLOCKS: u32 = 256;

const S_IFMT: u32 = 0xf000;
const S_IFREG: u32 = 0x8000;
const S_IFDIR: u32 = 0x4000;
const S_IFLNK: u32 = 0xa000;
const S_ISUID: u32 = 0o4000;
const S_ISGID: u32 = 0o2000;

const MAX_NAME: usize = 255;

const MAX_FILE_BLOCKS: u64 =
    DIRECT_BLOCKS as u64 + PTRS_PER_BLOCK as u64 + PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;

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
}

impl Content<'_> {
    fn len(&self) -> u64 {
        match self {
            Content::Bytes(b) => b.len() as u64,
            Content::Deferred { len, .. } => *len,
        }
    }
}

/// What one block of the emitted image contains.
enum BlockContent {
    /// Materialized metadata: directory data, indirect blocks, too-long
    /// symlink targets, and small file content. Always `BLOCK_SIZE` bytes.
    Owned(Vec<u8>),
    /// A window into a [`ContentSource`]. The block's remaining bytes are
    /// zero, which is what the vendor allocator leaves behind.
    Content { id: u64, offset: u64, len: u32 },
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
pub struct SffsConfig {
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
    /// The cross-language fixtures pin this to 0 to match
    /// `snapshotBytes({ normalizeTimestampsMs: 0 })`.
    pub now_ms: u64,
}

impl SffsConfig {
    /// A non-growable image of `size_bytes` with the vendor's default maximum.
    pub fn fixed(size_bytes: u64) -> SffsConfig {
        SffsConfig {
            size_bytes,
            max_size_bytes: None,
            growable_to_bytes: size_bytes,
            now_ms: 0,
        }
    }
}

pub struct SffsWriter {
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
    block_alloc_hint: u32,
    inode_alloc_hint: u32,
    growable_to_blocks: u32,
    now_ms: u64,

    inode_bitmap: Vec<u8>,
    block_bitmap: Vec<u8>,
    inode_table: Vec<u8>,
    blocks: BTreeMap<u32, BlockContent>,
    dir_indexes: BTreeMap<u32, Vec<FreeSlot>>,
}

fn w32(buf: &mut [u8], off: usize, value: u32) {
    buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
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

impl SffsWriter {
    /// Format an empty filesystem. Mirrors the vendor's `SharedFS.mkfs`,
    /// including its "grow the buffer if the metadata does not fit" step.
    pub fn mkfs(config: SffsConfig) -> Result<SffsWriter, Errno> {
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

        let mut total_inodes = max_blocks / 4;
        if total_inodes < 32 {
            total_inodes = 32;
        }
        total_inodes = total_inodes.div_ceil(INODES_PER_BLOCK) * INODES_PER_BLOCK;

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

        let mut writer = SffsWriter {
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
            block_alloc_hint: data_start,
            inode_alloc_hint: 2,
            growable_to_blocks: growable_to_blocks.max(total_blocks),
            now_ms: config.now_ms,
            inode_bitmap: vec![0u8; inode_bitmap_blocks as usize * BLOCK_SIZE],
            block_bitmap: vec![0u8; block_bitmap_blocks as usize * BLOCK_SIZE],
            inode_table: vec![0u8; inode_table_blocks as usize * BLOCK_SIZE],
            blocks: BTreeMap::new(),
            dir_indexes: BTreeMap::new(),
        };

        for b in 0..data_start {
            set_bit(&mut writer.block_bitmap, b);
        }
        set_bit(&mut writer.inode_bitmap, 0);
        set_bit(&mut writer.inode_bitmap, 1);

        // Root inode: an empty directory holding only "." and "..".
        let root_off = writer.inode_offset(ROOT_INO);
        w32(&mut writer.inode_table, root_off + INO_MODE, S_IFDIR | 0o755);
        w32(&mut writer.inode_table, root_off + INO_LINK_COUNT, 2);
        w64(&mut writer.inode_table, root_off + INO_GENERATION, 1);

        let root_block = writer.block_alloc()?;
        w32(&mut writer.inode_table, root_off + INO_DIRECT, root_block);
        writer.write_dot_entries(root_block, ROOT_INO, ROOT_INO);
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
    fn block_mut(&mut self, phys: u32) -> Result<&mut Vec<u8>, Errno> {
        if phys < self.data_start || phys >= self.total_blocks {
            return Err(Errno::EIO);
        }
        match self
            .blocks
            .entry(phys)
            .or_insert_with(|| BlockContent::Owned(vec![0u8; BLOCK_SIZE]))
        {
            BlockContent::Owned(v) => Ok(v),
            BlockContent::Content { .. } => Err(Errno::EIO),
        }
    }

    fn block_r16(&self, phys: u32, off: usize) -> u16 {
        match self.blocks.get(&phys) {
            Some(BlockContent::Owned(v)) => r16(v, off),
            _ => 0,
        }
    }

    fn block_r32(&self, phys: u32, off: usize) -> u32 {
        match self.blocks.get(&phys) {
            Some(BlockContent::Owned(v)) => r32(v, off),
            _ => 0,
        }
    }

    // ── Allocators ───────────────────────────────────────────────────

    /// First-fit from a rotating hint, exactly as the vendor allocates. The
    /// writer never frees, so in practice the hint always names the answer —
    /// but the scan is kept because the hint is the vendor's and a divergence
    /// here would be invisible until an image compared byte-for-byte.
    fn block_alloc_no_grow(&mut self) -> Option<u32> {
        let allocatable = self.total_blocks - self.data_start;
        if allocatable == 0 {
            return None;
        }
        let start = if self.block_alloc_hint >= self.data_start
            && self.block_alloc_hint < self.total_blocks
        {
            self.block_alloc_hint
        } else {
            self.data_start
        };
        for checked in 0..allocatable {
            let block_no = self.data_start + ((start - self.data_start + checked) % allocatable);
            if get_bit(&self.block_bitmap, block_no) {
                continue;
            }
            set_bit(&mut self.block_bitmap, block_no);
            self.free_blocks -= 1;
            self.block_alloc_hint = if block_no + 1 < self.total_blocks {
                block_no + 1
            } else {
                self.data_start
            };
            return Some(block_no);
        }
        None
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
        self.block_alloc_hint = current;
        Ok(())
    }

    fn block_alloc(&mut self) -> Result<u32, Errno> {
        if let Some(b) = self.block_alloc_no_grow() {
            return Ok(b);
        }
        self.grow()?;
        self.block_alloc_no_grow().ok_or(Errno::ENOSPC)
    }

    fn inode_alloc(&mut self) -> Result<u32, Errno> {
        let allocatable = self.total_inodes - 2;
        let start = if self.inode_alloc_hint >= 2 && self.inode_alloc_hint < self.total_inodes {
            self.inode_alloc_hint
        } else {
            2
        };
        for checked in 0..allocatable {
            let ino = 2 + ((start - 2 + checked) % allocatable);
            if get_bit(&self.inode_bitmap, ino) {
                continue;
            }
            set_bit(&mut self.inode_bitmap, ino);
            self.free_inodes -= 1;
            self.inode_alloc_hint = if ino + 1 < self.total_inodes { ino + 1 } else { 2 };
            let off = self.inode_offset(ino);
            self.inode_table[off..off + INODE_SIZE].fill(0);
            // The vendor's `nextInodeGeneration` is `Atomics.add(gen, 1) + 1`:
            // the counter and the new inode's generation end up equal.
            self.generation += 1;
            let generation = self.generation;
            w64(&mut self.inode_table, off + INO_GENERATION, generation as u64);
            return Ok(ino);
        }
        Err(Errno::ENOSPC)
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
            let ptr = self.block_r32(ind, ptr_off);
            if ptr != 0 {
                return Ok(ptr);
            }
            if !allocate {
                return Ok(0);
            }
            let blk = self.block_alloc()?;
            w32(self.block_mut(ind)?, ptr_off, blk);
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
            let mut l1 = self.block_r32(dind, l1_off);
            if l1 == 0 {
                if !allocate {
                    return Ok(0);
                }
                l1 = self.block_alloc()?;
                w32(self.block_mut(dind)?, l1_off, l1);
            }
            let l2_off = idx2 as usize * 4;
            let ptr = self.block_r32(l1, l2_off);
            if ptr != 0 {
                return Ok(ptr);
            }
            if !allocate {
                return Ok(0);
            }
            let blk = self.block_alloc()?;
            w32(self.block_mut(l1)?, l2_off, blk);
            return Ok(blk);
        }

        Err(Errno::EINVAL)
    }

    // ── Directory records ────────────────────────────────────────────

    fn write_dot_entries(&mut self, phys: u32, self_ino: u32, parent_ino: u32) {
        let dot = align4(DIRENT_HEADER + 1);
        let dotdot = align4(DIRENT_HEADER + 2);
        let block = self
            .blocks
            .entry(phys)
            .or_insert_with(|| BlockContent::Owned(vec![0u8; BLOCK_SIZE]));
        let BlockContent::Owned(b) = block else {
            return;
        };
        w32(b, 0, self_ino);
        w16(b, 4, dot as u16);
        w16(b, 6, 1);
        b[DIRENT_HEADER] = b'.';
        w32(b, dot, parent_ino);
        w16(b, dot + 4, dotdot as u16);
        w16(b, dot + 6, 2);
        b[dot + DIRENT_HEADER] = b'.';
        b[dot + DIRENT_HEADER + 1] = b'.';
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
        let block = self.block_mut(phys)?;
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

            if gap >= DIRENT_HEADER {
                let block = self.block_mut(pad_phys)?;
                w32(block, block_off, 0);
                w16(block, block_off + 4, gap as u16);
                w16(block, block_off + 6, 0);
            } else {
                let (phys, off) = last_ent.ok_or(Errno::EIO)?;
                let new_rec_len = self.block_r16(phys, off + 4) + gap as u16;
                w16(self.block_mut(phys)?, off + 4, new_rec_len);
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
        let mut free = Vec::new();
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
                    free.push(FreeSlot {
                        phys,
                        off: off as u16,
                        rec_len: rec_len as u16,
                    });
                }
                off += rec_len;
            }
            pos += remain as u64;
        }
        self.dir_indexes.insert(dir_ino, free);
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
                let free = self.dir_indexes.get_mut(&dir_ino).ok_or(Errno::EIO)?;
                let mut found = None;
                for i in (0..free.len()).rev() {
                    if (free[i].rec_len as usize) < needed {
                        continue;
                    }
                    found = Some(free.remove(i));
                    break;
                }
                found
            };
            let Some(slot) = candidate else {
                return Ok(false);
            };
            if self.block_r32(slot.phys, slot.off as usize) != 0
                || self.block_r16(slot.phys, slot.off as usize + 4) != slot.rec_len
            {
                continue;
            }
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
                    w16(self.block_mut(phys)?, off + 4, actual_len as u16);
                    let new_off = off + actual_len;
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
                    let matches = match self.blocks.get(&phys) {
                        Some(BlockContent::Owned(v)) => {
                            &v[off + DIRENT_HEADER..off + DIRENT_HEADER + name_len] == name
                        }
                        _ => false,
                    };
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

    fn require_dir(&self, ino: u32) -> Result<(), Errno> {
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
        self.write_dot_entries(blk, ino, parent);
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
        self.write_content(ino, content)?;
        Ok(ino)
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
        let old = self.ino_r32(ino, INO_MODE);
        self.ino_w32(ino, INO_MODE, (old & S_IFMT) | (mode & 0o7777));
        let now = self.now_ms;
        self.ino_w64(ino, INO_CTIME, now);
        Ok(())
    }

    /// Explicit timestamps, for an image that must carry real mtimes rather
    /// than the pinned zero the cross-language fixtures use.
    pub fn set_times(&mut self, ino: u32, atime_ms: u64, mtime_ms: u64, ctime_ms: u64) {
        self.ino_w64(ino, INO_ATIME, atime_ms);
        self.ino_w64(ino, INO_MTIME, mtime_ms);
        self.ino_w64(ino, INO_CTIME, ctime_ms);
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
        let mut pos = 0u64;
        while pos < len {
            let file_block = (pos / BLOCK_SIZE as u64) as u32;
            let chunk = core::cmp::min(BLOCK_SIZE as u64, len - pos) as usize;
            let phys = self.inode_block_map(ino, file_block, true)?;
            match &content {
                Content::Bytes(bytes) => {
                    let start = pos as usize;
                    let block = self.block_mut(phys)?;
                    block[..chunk].copy_from_slice(&bytes[start..start + chunk]);
                }
                Content::Deferred { id, .. } => {
                    self.blocks.insert(
                        phys,
                        BlockContent::Content {
                            id: *id,
                            offset: pos,
                            len: chunk as u32,
                        },
                    );
                }
            }
            pos += chunk as u64;
        }
        self.ino_w64(ino, INO_SIZE, len);
        let now = self.now_ms;
        self.ino_w64(ino, INO_MTIME, now);
        self.ino_w64(ino, INO_CTIME, now);
        let seq = self.ino_r32(ino, INO_DATA_SEQUENCE).wrapping_add(1);
        self.ino_w32(ino, INO_DATA_SEQUENCE, seq);
        Ok(())
    }

    /// Seal the filesystem and hand back an offset-addressable image.
    pub fn finish(self) -> SffsImage {
        let mut superblock = vec![0u8; BLOCK_SIZE];
        w32(&mut superblock, SB_MAGIC, SFFS_MAGIC);
        w32(&mut superblock, SB_VERSION, SFFS_VERSION);
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

        SffsImage {
            superblock,
            inode_bitmap: self.inode_bitmap,
            block_bitmap: self.block_bitmap,
            inode_table: self.inode_table,
            blocks: self.blocks,
            total_blocks: self.total_blocks,
            inode_bitmap_start: self.inode_bitmap_start,
            block_bitmap_start: self.block_bitmap_start,
            inode_table_start: self.inode_table_start,
            data_start: self.data_start,
        }
    }
}

/// A finished image, addressable by byte offset without being resident.
pub struct SffsImage {
    superblock: Vec<u8>,
    inode_bitmap: Vec<u8>,
    block_bitmap: Vec<u8>,
    inode_table: Vec<u8>,
    blocks: BTreeMap<u32, BlockContent>,
    total_blocks: u32,
    inode_bitmap_start: u32,
    block_bitmap_start: u32,
    inode_table_start: u32,
    data_start: u32,
}

enum BlockView<'a> {
    Zeros,
    Bytes(&'a [u8]),
    Content { id: u64, offset: u64, len: u32 },
}

impl SffsImage {
    pub fn len(&self) -> u64 {
        self.total_blocks as u64 * BLOCK_SIZE as u64
    }

    pub fn is_empty(&self) -> bool {
        self.total_blocks == 0
    }

    fn block_view(&self, n: u32) -> BlockView<'_> {
        if n == 0 {
            return BlockView::Bytes(&self.superblock);
        }
        if n >= self.inode_bitmap_start && n < self.block_bitmap_start {
            let off = (n - self.inode_bitmap_start) as usize * BLOCK_SIZE;
            return BlockView::Bytes(&self.inode_bitmap[off..off + BLOCK_SIZE]);
        }
        if n >= self.block_bitmap_start && n < self.inode_table_start {
            let off = (n - self.block_bitmap_start) as usize * BLOCK_SIZE;
            return BlockView::Bytes(&self.block_bitmap[off..off + BLOCK_SIZE]);
        }
        if n >= self.inode_table_start && n < self.data_start {
            let off = (n - self.inode_table_start) as usize * BLOCK_SIZE;
            return BlockView::Bytes(&self.inode_table[off..off + BLOCK_SIZE]);
        }
        match self.blocks.get(&n) {
            Some(BlockContent::Owned(v)) => BlockView::Bytes(v),
            Some(BlockContent::Content { id, offset, len }) => BlockView::Content {
                id: *id,
                offset: *offset,
                len: *len,
            },
            None => BlockView::Zeros,
        }
    }

    /// Fill `dst` from image offset `offset`, clamped to the image length.
    /// Returns how many bytes were produced (0 at or past the end).
    ///
    /// This is the cursor W-3 streams through: it never needs more than one
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
                    target.copy_from_slice(&bytes[block_off..block_off + chunk])
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
    /// image is small. Production emission must use [`SffsImage::read_at`].
    pub fn to_vec<S: ContentSource + ?Sized>(&self, source: &S) -> Result<Vec<u8>, Errno> {
        let mut out = vec![0u8; self.len() as usize];
        let n = self.read_at(source, 0, &mut out)?;
        if n as u64 != self.len() {
            return Err(Errno::EIO);
        }
        Ok(out)
    }
}

/// A [`BlockSource`] over a finished image, so the reader in `sffs.rs` can
/// mount what the writer produced without the image ever being resident.
pub struct SffsImageSource<'a, S: ContentSource + ?Sized> {
    pub image: &'a SffsImage,
    pub content: &'a S,
}

impl<S: ContentSource + ?Sized> BlockSource for SffsImageSource<'_, S> {
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

fn set_bit(bitmap: &mut [u8], index: u32) {
    // The vendor sets bit `index & 31` of the little-endian 32-bit word at
    // `index >> 5`, which is the same byte and bit this computes.
    bitmap[(index >> 3) as usize] |= 1 << (index & 7);
}

fn get_bit(bitmap: &[u8], index: u32) -> bool {
    bitmap[(index >> 3) as usize] & (1 << (index & 7)) != 0
}
