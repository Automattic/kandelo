//! Read-only parser for the on-disk KIFS (Kandelo Image File System) image and its
//! VFSI container. Originally ported from the TypeScript filesystem that
//! defined the format (since deleted). no_std + alloc.
//! Consumes DECOMPRESSED bytes (zstd is a host-side transport codec).
//!
//! The reader is a positioned cursor over a [`BlockSource`], not a resident
//! buffer. A `/` image can be larger than runtime memory, but a tree build
//! reads its superblock, inode and directory metadata, and regular-file
//! pointer blocks to count allocations; it does not read file contents.
//! Holding the whole image resident in kernel memory would duplicate a
//! decompressed copy the host already owns.
//!
//! `impl BlockSource for [u8]` keeps a plain slice a first-class source, so a
//! resident image costs a small `memcpy` per field read rather than a fetch.

use alloc::vec::Vec;
use wasm_posix_shared::Errno; // same import syscalls.rs uses

const VFSI_MAGIC: u32 = 0x5646_5349; // "VFSI" LE
const VFSI_VERSION: u32 = 1;
const VFSI_EXTENDED_VERSION: u32 = 2;
const VFSI_HEADER: usize = 16;
const VFSI_EXTENDED_HEADER: usize = 24;

/// A positioned, read-only byte source for one image.
///
/// Every read must answer synchronously. Resident images use a `memcpy`;
/// browser OPFS images use positioned reads from a worker-owned sync handle.
/// A source that could park would make the whole tree build restartable.
pub trait BlockSource {
    /// Total length of the image in bytes.
    fn len(&self) -> u64;

    /// Fill `dst` from `offset`. Any range that is not wholly within the
    /// source is `EIO` — the same failure a short slice index produced before
    /// this became a cursor.
    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno>;

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl BlockSource for [u8] {
    fn len(&self) -> u64 {
        <[u8]>::len(self) as u64
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
        let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
        let src = self.get(start..end).ok_or(Errno::EIO)?;
        dst.copy_from_slice(src);
        Ok(())
    }
}

impl BlockSource for Vec<u8> {
    fn len(&self) -> u64 {
        self.as_slice().len() as u64
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        <[u8] as BlockSource>::read_exact_at(self.as_slice(), offset, dst)
    }
}

impl<T: BlockSource + ?Sized> BlockSource for &T {
    fn len(&self) -> u64 {
        (**self).len()
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        (**self).read_exact_at(offset, dst)
    }
}

pub(crate) fn r32(b: &[u8], off: usize) -> Option<u32> {
    let e = off.checked_add(4)?;
    if e > b.len() { return None; }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

pub(crate) fn r64(b: &[u8], off: usize) -> Option<u64> {
    let e = off.checked_add(8)?;
    if e > b.len() { return None; }
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[off..e]);
    Some(u64::from_le_bytes(a))
}

fn source_u32(source: &impl BlockSource, offset: u64) -> Result<u32, Errno> {
    let mut buf = [0u8; 4];
    source.read_exact_at(offset, &mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

/// Turn a header read's failure into a container verdict WITHOUT flattening a
/// transport failure into one.
///
/// A resident `[u8]` source can only fail one way — the range is not in the
/// image — so "read failed" and "the container is malformed" used to be the same
/// statement. A host-backed source can also fail because the host has no image
/// installed (`ENOSYS`), because the transport broke (`EIO`), or because the
/// bytes are not ready yet (`EAGAIN`). Reporting any of those as `EINVAL` would
/// tell the operator their image is corrupt when it is not, and would swallow
/// the one errno the kernel must be able to act on. Only the out-of-range case
/// becomes `EINVAL`; every other errno propagates as itself.
fn container_errno(error: Errno) -> Errno {
    match error {
        Errno::EIO => Errno::EINVAL,
        other => other,
    }
}

/// Byte span of the inner KIFS filesystem inside a VFSI container.
///
/// Version 1 stores a 32-bit body length in a 16-byte header. Version 2
/// stores a 64-bit body length after its 24-byte header size field.
/// Everything after the body is host-side metadata (see [`kernel_lazy_span`]).
pub fn kandelo_image_span(source: &impl BlockSource) -> Result<(u64, u64), Errno> {
    if source_u32(source, 0).map_err(container_errno)? != VFSI_MAGIC {
        return Err(Errno::EINVAL);
    }
    let (body_offset, sab_len) = match source_u32(source, 4).map_err(container_errno)? {
        VFSI_VERSION => (VFSI_HEADER as u64, source_u32(source, 12).map_err(container_errno)? as u64),
        VFSI_EXTENDED_VERSION => {
            if source_u32(source, 12).map_err(container_errno)? != VFSI_EXTENDED_HEADER as u32 {
                return Err(Errno::EINVAL);
            }
            let mut length = [0u8; 8];
            source.read_exact_at(16, &mut length).map_err(container_errno)?;
            (VFSI_EXTENDED_HEADER as u64, u64::from_le_bytes(length))
        }
        _ => return Err(Errno::EINVAL),
    };
    let end = body_offset.checked_add(sab_len).ok_or(Errno::EINVAL)?;
    if end > source.len() {
        return Err(Errno::EINVAL);
    }
    Ok((body_offset, sab_len))
}

pub fn unwrap_vfsi(image: &[u8]) -> Result<&[u8], Errno> {
    let (offset, len) = kandelo_image_span(&image)?;
    let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = start
        .checked_add(usize::try_from(len).map_err(|_| Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    image.get(start..end).ok_or(Errno::EINVAL)
}

/// Container flag bits.
///
/// These are ABI: every image already published carries them, they are
/// written by [`crate::vfsi_container`] and read here, and a reader that
/// disagrees about a bit walks the trailer to the wrong offset. They live
/// together so the writer and the readers below cannot drift.
///
/// `VFS_IMAGE_FLAG_HAS_KERNEL_LAZY` is deliberately NOT redefined here -- it
/// already has a home in `wasm_posix_shared::abi`, and a second definition is
/// the drift this grouping exists to prevent.
pub const VFS_IMAGE_FLAG_HAS_LAZY: u32 = 1 << 0;
pub const VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES: u32 = 1 << 1;
pub const VFS_IMAGE_FLAG_HAS_METADATA: u32 = 1 << 2;
pub const VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES: u32 = 1 << 3;

/// Container header: magic(4) | version(4) | flags(4) | body length(4).
pub const VFSI_HEADER_SIZE: usize = VFSI_HEADER;
pub const VFSI_EXTENDED_HEADER_SIZE: usize = VFSI_EXTENDED_HEADER;

/// The container magic, for the writer.
pub const VFSI_CONTAINER_MAGIC: u32 = VFSI_MAGIC;

/// The container version used for bodies with a 32-bit length.
pub const VFSI_CONTAINER_VERSION: u32 = VFSI_VERSION;
/// The container version used for bodies requiring a 64-bit length.
pub const VFSI_EXTENDED_CONTAINER_VERSION: u32 = VFSI_EXTENDED_VERSION;

/// The container's flag word.
///
/// The flags are the image's own statement about which sections it carries,
/// and they are written from the WRITER's view of the tree rather than from
/// the section a reader will actually parse. That difference is the whole
/// reason this is exposed: a reader that finds a flag set and the
/// corresponding description absent is looking at an image whose contents it
/// cannot see, which is a refusal rather than an empty result.
pub fn container_flags(source: &impl BlockSource) -> Result<u32, Errno> {
    // Validates magic and version first, so a flag word is never read out of
    // bytes that are not a container.
    kandelo_image_span(source)?;
    source_u32(source, 8).map_err(container_errno)
}

/// Byte span of the image's metadata section, or `None` when it declares none.
///
/// # Why the bytes stay opaque
///
/// The metadata is JSON with an open shape: `version`, an optional
/// `kernelAbi`, an optional `createdBy`, and -- explicitly -- any further key,
/// "to preserve forwards compatibility for future signed/provenance fields".
///
/// A Rust reader that parsed it into a struct and re-serialized would silently
/// drop every field it did not know about, which is the opposite of what an
/// open shape is for. And teaching the kernel crate to parse JSON to read
/// three fields it does not act on would buy a parser's attack surface for
/// nothing. So this hands back the bytes and lets whoever cares interpret
/// them, exactly as the deferred section hands back an opaque payload.
pub fn metadata_span(source: &impl BlockSource) -> Result<Option<(u64, u64)>, Errno> {
    let (sab_offset, sab_len) = kandelo_image_span(source)?;
    let flags = source_u32(source, 8).map_err(container_errno)?;
    if flags & VFS_IMAGE_FLAG_HAS_METADATA == 0 {
        return Ok(None);
    }

    let mut offset = sab_offset.checked_add(sab_len).ok_or(Errno::EINVAL)?;
    let skip_section = |offset: &mut u64| -> Result<(), Errno> {
        let len = source_u32(source, *offset).map_err(container_errno)? as u64;
        *offset = offset
            .checked_add(4)
            .and_then(|value| value.checked_add(len))
            .ok_or(Errno::EINVAL)?;
        if *offset > source.len() {
            return Err(Errno::EINVAL);
        }
        Ok(())
    };
    // The lazy-file JSON section is unconditional; the archive section is
    // flagged and precedes metadata.
    skip_section(&mut offset)?;
    if flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES != 0 {
        skip_section(&mut offset)?;
    }

    let len = source_u32(source, offset).map_err(container_errno)? as u64;
    let start = offset.checked_add(4).ok_or(Errno::EINVAL)?;
    let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
    if end > source.len() {
        return Err(Errno::EINVAL);
    }
    Ok(Some((start, len)))
}

/// Slice form of [`metadata_span`] for a resident image.
pub fn metadata_section(image: &[u8]) -> Result<Option<&[u8]>, Errno> {
    let Some((offset, len)) = metadata_span(&image)? else {
        return Ok(None);
    };
    let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = start
        .checked_add(usize::try_from(len).map_err(|_| Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    image.get(start..end).map(Some).ok_or(Errno::EINVAL)
}

/// Byte span of the image's kernel-facing lazy-linkage section ("KLZY"), or
/// `None` when the image does not declare one.
///
/// An image without the flag predates the section; that is a legitimate older
/// image, not a corrupt one, so it reads as `Ok(None)`. A flag set over
/// truncated or self-inconsistent framing is corruption and reads as `EINVAL`.
///
/// The section sits after the three JSON sections, whose lengths must be
/// walked to find it: `u32 lazyLen | lazyJson` (always present), then
/// `u32 archiveLen | archiveJson` and `u32 metadataLen | metadataJson` when
/// their flags are set. See [`crate::klzy`] for the section's own contents.
pub fn kernel_lazy_span(source: &impl BlockSource) -> Result<Option<(u64, u64)>, Errno> {
    let (sab_offset, sab_len) = kandelo_image_span(source)?;
    let flags = source_u32(source, 8).map_err(container_errno)?;
    if flags & wasm_posix_shared::abi::VFS_IMAGE_FLAG_HAS_KERNEL_LAZY == 0 {
        return Ok(None);
    }

    let mut offset = sab_offset.checked_add(sab_len).ok_or(Errno::EINVAL)?;
    // The lazy-file JSON section is unconditional; the other two are flagged.
    let skip_section = |offset: &mut u64| -> Result<(), Errno> {
        let len = source_u32(source, *offset).map_err(container_errno)? as u64;
        *offset = offset
            .checked_add(4)
            .and_then(|value| value.checked_add(len))
            .ok_or(Errno::EINVAL)?;
        if *offset > source.len() {
            return Err(Errno::EINVAL);
        }
        Ok(())
    };
    skip_section(&mut offset)?;
    if flags & VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES != 0 {
        skip_section(&mut offset)?;
    }
    if flags & VFS_IMAGE_FLAG_HAS_METADATA != 0 {
        skip_section(&mut offset)?;
    }

    let len = source_u32(source, offset).map_err(container_errno)? as u64;
    let start = offset.checked_add(4).ok_or(Errno::EINVAL)?;
    let end = start.checked_add(len).ok_or(Errno::EINVAL)?;
    if end > source.len() {
        return Err(Errno::EINVAL);
    }
    Ok(Some((start, len)))
}

/// Slice form of [`kernel_lazy_span`] for a resident image.
pub fn kernel_lazy_section(image: &[u8]) -> Result<Option<&[u8]>, Errno> {
    let Some((offset, len)) = kernel_lazy_span(&image)? else {
        return Ok(None);
    };
    let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = start
        .checked_add(usize::try_from(len).map_err(|_| Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    image.get(start..end).map(Some).ok_or(Errno::EINVAL)
}

pub(crate) const KANDELO_IMAGE_MAGIC: u32 = 0x5346_494B; // "KIFS" in LE byte order
pub(crate) const KANDELO_IMAGE_VERSION: u32 = 1;
pub(crate) const KANDELO_IMAGE_EXTENDED_VERSION: u32 = 2;
pub(crate) const BLOCK_SIZE: usize = 4096;
pub(crate) const SB_INODE_TABLE_START: u64 = 36;

pub const ROOT_INO: u32 = 1;
pub(crate) const INODES_PER_BLOCK: u32 = 32;
pub(crate) const INODE_SIZE: usize = 128;
pub(crate) const INO_MODE: usize = 8;
pub(crate) const INO_LINK_COUNT: usize = 12;
pub(crate) const INO_SIZE: usize = 16;
pub(crate) const INO_MTIME: usize = 24;
pub(crate) const INO_CTIME: usize = 32;
pub(crate) const INO_ATIME: usize = 40;
pub(crate) const INO_UID: usize = 96;
pub(crate) const INO_GID: usize = 100;
pub(crate) const INO_GENERATION: usize = 104;

pub(crate) const DIRECT_BLOCKS: u32 = 10;
pub(crate) const PTRS_PER_BLOCK: u32 = 1024;
pub(crate) const INO_DIRECT: usize = 48;
pub(crate) const INO_INDIRECT: usize = 88;
pub(crate) const INO_DOUBLE_INDIRECT: usize = 92;
pub(crate) const INO_TRIPLE_INDIRECT: usize = 124;
pub(crate) const INLINE_SYMLINK_SIZE: u64 = 40;
pub(crate) const V1_MAX_FILE_BLOCKS: u64 = DIRECT_BLOCKS as u64
    + PTRS_PER_BLOCK as u64
    + PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;
pub(crate) const MAX_FILE_BLOCKS: u64 = V1_MAX_FILE_BLOCKS
    + PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;

/// One inode's raw 128 bytes, read in a single positioned fetch. Every field
/// accessor below indexes this buffer rather than the image, so a `stat` costs
/// one read instead of nine and a whole-file `read_at` costs one instead of
/// one per 4 KiB chunk.
type RawInode = [u8; INODE_SIZE];

#[derive(Clone, Copy)]
pub struct DirectoryPosition {
    inode: RawInode,
    size: u64,
    offset: u64,
}

pub struct DirectoryCursor<'a, S: BlockSource> {
    filesystem: &'a KandeloImageFs<S>,
    position: DirectoryPosition,
    block_start: Option<u64>,
    block: [u8; BLOCK_SIZE],
}

pub struct KandeloImageDirentRef<'a> {
    pub ino: u32,
    pub name: &'a [u8],
}

impl<S: BlockSource> DirectoryCursor<'_, S> {
    pub fn position(&self) -> DirectoryPosition {
        self.position
    }

    pub fn next_entry(&mut self) -> Result<Option<KandeloImageDirentRef<'_>>, Errno> {
        while self.position.offset < self.position.size {
            let block_start = self.position.offset / BLOCK_SIZE as u64 * BLOCK_SIZE as u64;
            let length = (self.position.size - block_start).min(BLOCK_SIZE as u64) as usize;
            if self.block_start != Some(block_start) {
                let read = self.filesystem.read_at_in(
                    &self.position.inode, block_start, &mut self.block[..length],
                )?;
                if read != length {
                    return Err(Errno::EIO);
                }
                self.block_start = Some(block_start);
            }
            let offset = (self.position.offset - block_start) as usize;
            if length - offset < DIRENT_HEADER {
                return Err(Errno::EIO);
            }
            let ino = r32(&self.block, offset).ok_or(Errno::EIO)?;
            let record_length = u16::from_le_bytes(
                self.block[offset + 4..offset + 6].try_into().map_err(|_| Errno::EIO)?,
            ) as usize;
            let name_length = u16::from_le_bytes(
                self.block[offset + 6..offset + 8].try_into().map_err(|_| Errno::EIO)?,
            ) as usize;
            if record_length < DIRENT_HEADER || record_length % 4 != 0
                || record_length > length - offset
                || name_length > record_length - DIRENT_HEADER
            {
                return Err(Errno::EIO);
            }
            self.position.offset += record_length as u64;
            if ino != 0 {
                return Ok(Some(KandeloImageDirentRef {
                    ino,
                    name: &self.block[offset + DIRENT_HEADER..offset + DIRENT_HEADER + name_length],
                }));
            }
        }
        Ok(None)
    }
}

pub struct KandeloImageStat {
    pub ino: u32,
    pub mode: u32,
    pub nlink: u32,
    pub size: u64,
    pub mtime_ms: u64,
    pub ctime_ms: u64,
    pub atime_ms: u64,
    pub uid: u32,
    pub gid: u32,
    pub generation: u64,
}

pub fn file_type(mode: u32) -> u32 {
    mode & 0xf000
}

pub struct FileAllocationCursor<'a, S: BlockSource> {
    filesystem: &'a KandeloImageFs<S>,
    blocks: FileReadPosition,
    position: u64,
    limit: u64,
}

pub(crate) struct FileReadPosition {
    inode: RawInode,
    pages: [(u32, [u8; BLOCK_SIZE]); 3],
}

impl FileReadPosition {
    fn pointer_at<S: BlockSource>(&mut self, filesystem: &KandeloImageFs<S>, block: u32, index: u64, level: usize) -> Result<u32, Errno> {
        if self.pages[level].0 != block {
            let bytes = filesystem.pointer_block(block)?;
            self.pages[level] = (block, bytes);
        }
        r32(&self.pages[level].1, index as usize * 4).ok_or(Errno::EIO)
    }

    fn mapped_block<S: BlockSource>(&mut self, filesystem: &KandeloImageFs<S>, logical: u64) -> Result<(u32, u64), Errno> {
        let direct = DIRECT_BLOCKS as u64;
        let pointers = PTRS_PER_BLOCK as u64;
        let double_start = direct + pointers;
        if logical < direct {
            return Ok((r32(&self.inode, INO_DIRECT + logical as usize * 4).ok_or(Errno::EIO)?, logical + 1));
        }
        if logical < double_start {
            let root = r32(&self.inode, INO_INDIRECT).ok_or(Errno::EIO)?;
            if root == 0 { return Ok((0, double_start)); }
            return Ok((self.pointer_at(filesystem, root, logical - direct, 0)?, logical + 1));
        }
        if logical < V1_MAX_FILE_BLOCKS {
            let root = r32(&self.inode, INO_DOUBLE_INDIRECT).ok_or(Errno::EIO)?;
            if root == 0 { return Ok((0, V1_MAX_FILE_BLOCKS)); }
            let relative = logical - double_start;
            let group = relative / pointers;
            let leaf = self.pointer_at(filesystem, root, group, 0)?;
            if leaf == 0 { return Ok((0, double_start + (group + 1) * pointers)); }
            return Ok((self.pointer_at(filesystem, leaf, relative % pointers, 1)?, logical + 1));
        }
        let root = r32(&self.inode, INO_TRIPLE_INDIRECT).ok_or(Errno::EIO)?;
        if root == 0 { return Ok((0, MAX_FILE_BLOCKS)); }
        let relative = logical - V1_MAX_FILE_BLOCKS;
        let top = relative / (pointers * pointers);
        let middle = self.pointer_at(filesystem, root, top, 0)?;
        if middle == 0 { return Ok((0, V1_MAX_FILE_BLOCKS + (top + 1) * pointers * pointers)); }
        let group = relative / pointers;
        let leaf = self.pointer_at(filesystem, middle, group % pointers, 1)?;
        if leaf == 0 { return Ok((0, V1_MAX_FILE_BLOCKS + (group + 1) * pointers)); }
        Ok((self.pointer_at(filesystem, leaf, relative % pointers, 2)?, logical + 1))
    }
}

impl<S: BlockSource> FileAllocationCursor<'_, S> {
    pub fn next_block(&mut self) -> Result<Option<u32>, Errno> {
        while self.position < self.limit {
            let logical = self.position;
            let (physical, next) = self.blocks.mapped_block(self.filesystem, logical)?;
            self.filesystem.validate_block_ptr(physical)?;
            self.position = next.min(self.limit);
            if physical != 0 {
                return u32::try_from(logical).map(Some).map_err(|_| Errno::EFBIG);
            }
        }
        Ok(None)
    }
}

pub struct KandeloImageFs<S: BlockSource> {
    source: S,
    version: u32,
    total_blocks: u32,
    data_start: u32,
    pub(crate) inode_table_start: u32,
    total_inodes: u32,
    deferred_inode: u32,
}

/// The superblock facts a mounted [`KandeloImageFs`] keeps, separated from the source so
/// a caller that mounts once can re-address the same filesystem later without
/// re-reading and re-validating the superblock.
///
/// This exists because the `/` image is mounted once, at boot, but its bytes
/// are read for the whole session: every base regular file's content is served
/// out of it on demand. Re-running [`KandeloImageFs::mount`] per read would cost three
/// extra source reads and repeat validation the boot already did; carrying the
/// validated geometry forward costs six 32-bit words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KandeloImageGeometry {
    pub version: u32,
    pub total_blocks: u32,
    pub data_start: u32,
    pub inode_table_start: u32,
    pub total_inodes: u32,
    /// Inode holding the deferred-file section, or 0 when the image declares
    /// none. Carried here for the same reason the other two are: a caller that
    /// mounts once and re-addresses the filesystem later should not have to
    /// re-read and re-validate the superblock to find it.
    pub deferred_inode: u32,
}

pub(crate) const SB_TOTAL_INODES: u64 = 16;
/// `f_type` for a mounted KIFS image: "KIFS" in ASCII.
///
/// The value is the one `host/src/statfs.ts` also reports
/// (`KANDELO_IMAGE_SUPER_MAGIC`), so a program sees one filesystem type
/// whichever side answers `statfs`. Divergence here would be a
/// platform-visible difference between two descriptions of one filesystem.
pub const KANDELO_IMAGE_SUPER_MAGIC: u32 = 0x5346_494B;

pub(crate) const SB_TOTAL_BLOCKS: u64 = 12;
const SB_INODE_BITMAP_START: u64 = 28;
const SB_BLOCK_BITMAP_START: u64 = 32;
const SB_BLOCK_BITMAP_BLOCKS: u64 = 48;
const SB_INODE_BITMAP_BLOCKS: u64 = 44;
const SB_INODE_TABLE_BLOCKS: u64 = 52;
const SB_DATA_START: u64 = 40;
pub(crate) const SB_FREE_BLOCKS: u64 = 20;
pub(crate) const SB_FREE_INODES: u64 = 24;
pub(crate) const SB_MAX_SIZE_BLOCKS: u64 = 68;
/// Inode holding the deferred-file section, or 0. See
/// [`crate::sdef`] for the section, and the writer's own
/// `SB_DEFERRED_INODE` for why a consistency checker must read this field
/// before judging that inode unreachable.
const SB_DEFERRED_INODE: u64 = 76;

impl<S: BlockSource> KandeloImageFs<S> {
    pub fn mount(source: S) -> Result<KandeloImageFs<S>, Errno> {
        let mut superblock = [0u8; BLOCK_SIZE];
        source.read_exact_at(0, &mut superblock).map_err(container_errno)?;
        let word = |offset: u64| r32(&superblock, offset as usize).ok_or(Errno::EINVAL);
        if word(0)? != KANDELO_IMAGE_MAGIC {
            return Err(Errno::EINVAL);
        }
        let version = word(4)?;
        if version != KANDELO_IMAGE_VERSION && version != KANDELO_IMAGE_EXTENDED_VERSION {
            return Err(Errno::EINVAL);
        }
        if word(8)? != BLOCK_SIZE as u32 {
            return Err(Errno::EINVAL);
        }
        let total_blocks = word(SB_TOTAL_BLOCKS)?;
        let total_inodes = word(SB_TOTAL_INODES)?;
        let inode_bitmap_start = word(SB_INODE_BITMAP_START)?;
        let inode_bitmap_blocks = word(SB_INODE_BITMAP_BLOCKS)?;
        let block_bitmap_start = word(SB_BLOCK_BITMAP_START)?;
        let block_bitmap_blocks = word(SB_BLOCK_BITMAP_BLOCKS)?;
        let inode_table_start = word(SB_INODE_TABLE_START)?;
        let inode_table_blocks = word(SB_INODE_TABLE_BLOCKS)?;
        let data_start = word(SB_DATA_START)?;
        // The inode table spans `total_inodes.div_ceil(32)` blocks starting at
        // `inode_table_start`; require the whole region to fit in the source
        // so every accepted `ino < total_inodes` yields an in-bounds
        // `inode_offset` without further per-call bounds checking.
        let table_blocks = (total_inodes as u64).div_ceil(INODES_PER_BLOCK as u64);
        let table_end = (inode_table_start as u64 + table_blocks)
            .checked_mul(BLOCK_SIZE as u64)
            .ok_or(Errno::EINVAL)?;
        if total_inodes <= ROOT_INO
            || inode_bitmap_start == 0
            || inode_bitmap_start.checked_add(inode_bitmap_blocks) != Some(block_bitmap_start)
            || block_bitmap_start.checked_add(block_bitmap_blocks) != Some(inode_table_start)
            || inode_table_start.checked_add(inode_table_blocks) != Some(data_start)
            || data_start >= total_blocks
            || u64::from(inode_bitmap_blocks) * BLOCK_SIZE as u64 * 8 < u64::from(total_inodes)
            || u64::from(block_bitmap_blocks) * BLOCK_SIZE as u64 * 8 < u64::from(total_blocks)
            || u64::from(inode_table_blocks) < table_blocks
            || u64::from(total_blocks) * BLOCK_SIZE as u64 > source.len()
            || table_end > source.len()
        {
            return Err(Errno::EINVAL);
        }
        // Read unvalidated: 0 means "no section", which is what every image
        // written before this field existed carries here, so an older image
        // reads as having none rather than as corrupt.
        let deferred_inode = word(SB_DEFERRED_INODE)?;
        Ok(KandeloImageFs {
            source,
            version,
            total_blocks,
            data_start,
            inode_table_start,
            total_inodes,
            deferred_inode,
        })
    }

    /// The validated superblock geometry of this mount.
    pub fn geometry(&self) -> KandeloImageGeometry {
        KandeloImageGeometry {
            version: self.version,
            total_blocks: self.total_blocks,
            data_start: self.data_start,
            inode_table_start: self.inode_table_start,
            total_inodes: self.total_inodes,
            deferred_inode: self.deferred_inode,
        }
    }

    /// Re-address a filesystem whose superblock a previous [`KandeloImageFs::mount`]
    /// already read and validated.
    ///
    /// The caller owes the same invariant `mount` establishes: `geometry` came
    /// from a successful `mount` of a source addressing the SAME filesystem
    /// bytes. It is not a way to skip validation on an unvalidated image — the
    /// `/` image loader mounts first and only then remembers the geometry, so a
    /// corrupt superblock is still rejected at boot, loudly, exactly once.
    pub fn from_geometry(source: S, geometry: KandeloImageGeometry) -> KandeloImageFs<S> {
        KandeloImageFs {
            source,
            version: geometry.version,
            total_blocks: geometry.total_blocks,
            data_start: geometry.data_start,
            inode_table_start: geometry.inode_table_start,
            total_inodes: geometry.total_inodes,
            deferred_inode: geometry.deferred_inode,
        }
    }

    /// Invariant relied on by callers: `ino` has already been checked by
    /// `stat_ino` against `0 < ino < total_inodes`, and `mount` validated
    /// that the whole inode-table region (through `total_inodes`) fits in
    /// the source. So the offset computed here is provably in-bounds and
    /// needs no further self-check.
    pub(crate) fn inode_offset(&self, ino: u32) -> u64 {
        let block = self.inode_table_start as u64 + (ino / INODES_PER_BLOCK) as u64;
        block * BLOCK_SIZE as u64 + (ino % INODES_PER_BLOCK) as u64 * INODE_SIZE as u64
    }

    /// Fetch one inode's raw bytes. `ENOENT` for an out-of-range or free slot,
    /// matching what a caller of `stat_ino` observes.
    fn read_inode(&self, ino: u32) -> Result<RawInode, Errno> {
        if ino == 0 || ino >= self.total_inodes { return Err(Errno::ENOENT); }
        let mut raw = [0u8; INODE_SIZE];
        self.source.read_exact_at(self.inode_offset(ino), &mut raw)?;
        Ok(raw)
    }

    /// The image's encoded GROWTH CEILING in bytes -- how large this
    /// filesystem was built to be allowed to become, which is not how large it
    /// currently is.
    ///
    /// Product images are published against a profile ("this demo's VFS may
    /// grow to 512 MiB"), and the ceiling is baked into the superblock at
    /// build time. A published image carrying the wrong ceiling boots and runs
    /// and then fails later, when something tries to grow it past a limit
    /// nobody meant to set -- which is why it is checked at publication.
    ///
    /// Clamped up to the body's own length. An image whose recorded ceiling is
    /// SMALLER than the bytes it already occupies has a ceiling that is not
    /// merely wrong but unusable, so this reports the real floor rather than a
    /// number the filesystem has already exceeded.
    pub fn growth_ceiling_bytes(&self) -> Result<u64, Errno> {
        let max_blocks = source_u32(&self.source, SB_MAX_SIZE_BLOCKS).map_err(container_errno)?;
        let configured = (max_blocks as u64).saturating_mul(BLOCK_SIZE as u64);
        Ok(configured.max(self.source.len()))
    }

    /// `statfs` for a mounted image, read from its own superblock.
    ///
    /// This looks derivable from `KandeloImageFs::geometry`. It is not, quite:
    /// geometry carries the inode-table start, the inode count and
    /// the deferred inode, and deliberately not the FREE counts, which change
    /// as a writer fills the image. They come from the superblock, which
    /// `KandeloImageWriter` already maintains at `SB_FREE_BLOCKS`/`SB_FREE_INODES`.
    ///
    /// The caller that needs this is the image builder's headroom assertion:
    /// "this product image must still have N free bytes and M free inodes when
    /// it ships". That is a question about the artifact on disk, so answering
    /// it from the artifact's own superblock is the only answer that cannot
    /// drift from what was written.
    ///
    /// `f_bavail` equals `f_bfree`: KIFS reserves no blocks for a privileged
    /// user, so there is no second number to report and inventing a reserve
    /// here would understate the headroom a builder actually has.
    pub fn statfs(&self) -> Result<wasm_posix_shared::WasmStatfs, Errno> {
        let total_blocks = source_u32(&self.source, SB_TOTAL_BLOCKS).map_err(container_errno)?;
        let total_inodes = source_u32(&self.source, SB_TOTAL_INODES).map_err(container_errno)?;
        let free_blocks = source_u32(&self.source, SB_FREE_BLOCKS).map_err(container_errno)?;
        let free_inodes = source_u32(&self.source, SB_FREE_INODES).map_err(container_errno)?;
        if free_blocks > total_blocks || free_inodes > total_inodes {
            // A superblock claiming more free than it has is corruption, not a
            // filesystem that happens to be empty.
            return Err(Errno::EINVAL);
        }
        Ok(wasm_posix_shared::WasmStatfs {
            f_type: KANDELO_IMAGE_SUPER_MAGIC,
            f_bsize: BLOCK_SIZE as u32,
            f_blocks: total_blocks as u64,
            f_bfree: free_blocks as u64,
            f_bavail: free_blocks as u64,
            f_files: total_inodes as u64,
            f_ffree: free_inodes as u64,
            f_fsid: 0,
            f_namelen: 255,
            f_frsize: BLOCK_SIZE as u32,
            f_flags: 0,
            _pad: 0,
        })
    }

    pub fn stat_ino(&self, ino: u32) -> Result<KandeloImageStat, Errno> {
        let raw = self.read_inode(ino)?;
        let nlink = r32(&raw, INO_LINK_COUNT).ok_or(Errno::EIO)?;
        if nlink == 0 { return Err(Errno::ENOENT); } // free/orphaned slot
        Ok(KandeloImageStat {
            ino,
            mode: r32(&raw, INO_MODE).ok_or(Errno::EIO)?,
            nlink,
            size: r64(&raw, INO_SIZE).ok_or(Errno::EIO)?,
            mtime_ms: r64(&raw, INO_MTIME).ok_or(Errno::EIO)?,
            ctime_ms: r64(&raw, INO_CTIME).ok_or(Errno::EIO)?,
            atime_ms: r64(&raw, INO_ATIME).ok_or(Errno::EIO)?,
            uid: r32(&raw, INO_UID).ok_or(Errno::EIO)?,
            gid: r32(&raw, INO_GID).ok_or(Errno::EIO)?,
            generation: r64(&raw, INO_GENERATION).ok_or(Errno::EIO)?,
        })
    }

    fn validate_block_ptr(&self, block: u32) -> Result<u32, Errno> {
        if block != 0 && (block < self.data_start || block >= self.total_blocks) {
            return Err(Errno::EIO);
        }
        Ok(block)
    }

    /// Read a block pointer at `index` (a 4-byte slot) within block `block`.
    /// A zero `block` means the parent indirect block is missing, i.e. a
    /// sparse hole; self-guards by returning `Ok(0)` rather than relying on
    /// callers to check first.
    fn block_ptr_in(&self, block: u32, index: u32) -> Result<u32, Errno> {
        if block == 0 {
            return Ok(0); // missing indirect block => sparse hole
        }
        self.validate_block_ptr(block)?;
        // Computed in u64 so a huge (corrupt) `block` cannot wrap a 32-bit
        // offset and alias a small in-bounds one.
        let off = block as u64 * BLOCK_SIZE as u64 + index as u64 * 4;
        self.validate_block_ptr(source_u32(&self.source, off)?)
    }

    /// Resolve a file block number to a physical block number, given the
    /// inode's already-fetched bytes.
    /// Direct blocks 0..9, single-indirect 10..1033, then double-indirect and
    /// (in KIFS v2) triple-indirect ranges.
    /// ptr 0 = sparse hole; returns 0. Otherwise returns the block number.
    fn block_map_in(&self, raw: &RawInode, file_block: u32) -> Result<u32, Errno> {
        if file_block < DIRECT_BLOCKS {
            return self.validate_block_ptr(
                r32(raw, INO_DIRECT + file_block as usize * 4).ok_or(Errno::EIO)?,
            );
        }
        let fb = file_block - DIRECT_BLOCKS;
        if fb < PTRS_PER_BLOCK {
            let ind = r32(raw, INO_INDIRECT).ok_or(Errno::EIO)?;
            return self.block_ptr_in(ind, fb);
        }
        let fb = fb - PTRS_PER_BLOCK;
        let max = PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64;
        if (fb as u64) < max {
            let dind = r32(raw, INO_DOUBLE_INDIRECT).ok_or(Errno::EIO)?;
            let l1 = self.block_ptr_in(dind, fb / PTRS_PER_BLOCK)?;
            return self.block_ptr_in(l1, fb % PTRS_PER_BLOCK);
        }
        let fb = fb as u64 - max;
        if self.version != KANDELO_IMAGE_EXTENDED_VERSION
            || fb >= MAX_FILE_BLOCKS - V1_MAX_FILE_BLOCKS
        {
            return Err(Errno::EINVAL);
        }
        let pointers = PTRS_PER_BLOCK as u64;
        let triple = r32(raw, INO_TRIPLE_INDIRECT).ok_or(Errno::EIO)?;
        let middle = self.block_ptr_in(triple, (fb / (pointers * pointers)) as u32)?;
        let leaf = self.block_ptr_in(middle, ((fb / pointers) % pointers) as u32)?;
        self.block_ptr_in(leaf, (fb % pointers) as u32)
    }

    fn pointer_block(&self, block: u32) -> Result<[u8; BLOCK_SIZE], Errno> {
        self.validate_block_ptr(block)?;
        if block == 0 {
            return Err(Errno::EIO);
        }
        let mut pointers = [0; BLOCK_SIZE];
        self.source
            .read_exact_at(u64::from(block) * BLOCK_SIZE as u64, &mut pointers)?;
        Ok(pointers)
    }

    /// Return the logical block numbers backed by data in a regular file.
    /// Missing indirect branches cost no reads or output memory.
    pub fn file_allocations(&self, ino: u32, range: core::ops::Range<u64>) -> Result<FileAllocationCursor<'_, S>, Errno> {
        if range.start > range.end { return Err(Errno::EINVAL); }
        let raw = self.read_inode(ino)?;
        if r32(&raw, INO_LINK_COUNT).ok_or(Errno::EIO)? == 0 {
            return Err(Errno::ENOENT);
        }
        if r32(&raw, INO_MODE).ok_or(Errno::EIO)? & 0xf000 != 0x8000 {
            return Err(Errno::EINVAL);
        }
        let count = r64(&raw, INO_SIZE)
            .ok_or(Errno::EIO)?
            .div_ceil(BLOCK_SIZE as u64);
        let maximum = if self.version == KANDELO_IMAGE_EXTENDED_VERSION {
            MAX_FILE_BLOCKS
        } else {
            V1_MAX_FILE_BLOCKS
        };
        if count > maximum {
            return Err(Errno::EFBIG);
        }
        let limit = range.end.min(count);
        Ok(FileAllocationCursor {
            filesystem: self, blocks: FileReadPosition { inode: raw, pages: [(0, [0; BLOCK_SIZE]); 3] },
            position: range.start.min(limit), limit,
        })
    }

    pub(crate) fn file_read_position(&self, ino: u32) -> Result<FileReadPosition, Errno> {
        Ok(self.file_allocations(ino, 0..0)?.blocks)
    }

    pub(crate) fn read_at_position(&self, position: &mut FileReadPosition, offset: u64, destination: &mut [u8]) -> Result<usize, Errno> {
        let size = r64(&position.inode, INO_SIZE).ok_or(Errno::EIO)?;
        if offset >= size { return Ok(0); }
        let length = destination.len().min(usize::try_from(size - offset).unwrap_or(usize::MAX));
        let mut done = 0;
        while done < length {
            let at = offset + done as u64;
            let logical = at / BLOCK_SIZE as u64;
            let within = (at % BLOCK_SIZE as u64) as usize;
            let (physical, next) = position.mapped_block(self, logical)?;
            self.validate_block_ptr(physical)?;
            let count = if physical == 0 {
                (length - done).min(usize::try_from(next * BLOCK_SIZE as u64 - at).unwrap_or(usize::MAX))
            } else {
                (length - done).min(BLOCK_SIZE - within)
            };
            let target = &mut destination[done..done + count];
            if physical == 0 {
                target.fill(0);
            } else {
                self.source.read_exact_at(u64::from(physical) * BLOCK_SIZE as u64 + within as u64, target)?;
            }
            done += count;
        }
        Ok(done)
    }

    pub fn allocated_file_block_count(&self, ino: u32) -> Result<u64, Errno> {
        let mut cursor = self.file_allocations(ino, 0..u64::MAX)?;
        let mut count = 0;
        while cursor.next_block()?.is_some() { count += 1; }
        Ok(count)
    }

    #[cfg(test)]
    pub(crate) fn sparse_file_blocks(&self, ino: u32) -> Result<Option<Vec<u32>>, Errno> {
        let mut cursor = self.file_allocations(ino, 0..u64::MAX)?;
        let mut next_dense = 0u64;
        let mut sparse: Option<Vec<u32>> = None;
        let prefix = |limit: u64| -> Result<Vec<u32>, Errno> {
            let mut blocks = Vec::new();
            blocks.try_reserve_exact(usize::try_from(limit).map_err(|_| Errno::ENOMEM)?)
                .map_err(|_| Errno::ENOMEM)?;
            for block in 0..limit { blocks.push(block as u32); }
            Ok(blocks)
        };
        while let Some(block) = cursor.next_block()? {
            if sparse.is_none() && u64::from(block) != next_dense {
                sparse = Some(prefix(next_dense)?);
            }
            if let Some(blocks) = &mut sparse {
                blocks.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
                blocks.push(block);
            }
            next_dense = u64::from(block) + 1;
        }
        if sparse.is_none() && next_dense != cursor.limit { sparse = Some(prefix(next_dense)?); }
        Ok(sparse)
    }

    pub fn allocated_file_blocks(&self, ino: u32) -> Result<Vec<u32>, Errno> {
        let mut cursor = self.file_allocations(ino, 0..u64::MAX)?;
        let mut blocks = Vec::new();
        while let Some(block) = cursor.next_block()? {
            blocks.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            blocks.push(block);
        }
        Ok(blocks)
    }

    /// `block_map_in` for a caller that has only the inode number. Every
    /// production path already holds the inode bytes (that is the point of the
    /// cursor), so this exists for tests that name an inode directly.
    #[cfg(test)]
    fn block_map(&self, ino: u32, file_block: u32) -> Result<u32, Errno> {
        let raw = self.read_inode(ino)?;
        self.block_map_in(&raw, file_block)
    }

    /// Positioned read: fills `dst` from file data starting at `offset`,
    /// clamped to the file size. Sparse holes (physical block 0) read as
    /// zeros. Returns the number of bytes read (0 at or after EOF).
    pub fn read_at(&self, ino: u32, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
        let raw = self.read_inode(ino)?;
        self.read_at_in(&raw, offset, dst)
    }

    fn read_at_in(&self, raw: &RawInode, offset: u64, dst: &mut [u8]) -> Result<usize, Errno> {
        if r32(raw, INO_LINK_COUNT).ok_or(Errno::EIO)? == 0 { return Err(Errno::ENOENT); }
        let size = r64(raw, INO_SIZE).ok_or(Errno::EIO)?;
        if offset >= size { return Ok(0); }
        let mut remaining = core::cmp::min(dst.len() as u64, size - offset) as usize;
        let mut pos = offset;
        let mut out = 0usize;
        while remaining > 0 {
            let file_block = u32::try_from(pos / BLOCK_SIZE as u64).map_err(|_| Errno::EFBIG)?;
            let block_off = (pos % BLOCK_SIZE as u64) as usize;
            let chunk = core::cmp::min(BLOCK_SIZE - block_off, remaining);
            let phys = self.block_map_in(raw, file_block)?;
            if phys == 0 {
                for b in &mut dst[out..out + chunk] { *b = 0; } // sparse hole
            } else {
                // Computed in u64 so a huge (corrupt) `phys` cannot wrap.
                let src = phys as u64 * BLOCK_SIZE as u64 + block_off as u64;
                self.source.read_exact_at(src, &mut dst[out..out + chunk])?;
            }
            out += chunk; pos += chunk as u64; remaining -= chunk;
        }
        Ok(out)
    }

    /// List directory entries. Walks dirent records across the directory's
    /// data one block at a time (via `read_at` into a block-sized buffer so
    /// records never straddle a block boundary). Skips free slots (`ino==0`)
    /// but still advances by `rec_len`; includes `.`/`..` (callers filter).
    /// A malformed record fails the whole listing instead of hiding later
    /// names.
    pub fn directory_entries(&self, dir_ino: u32) -> Result<DirectoryCursor<'_, S>, Errno> {
        let inode = self.read_inode(dir_ino)?;
        if r32(&inode, INO_LINK_COUNT).ok_or(Errno::EIO)? == 0 {
            return Err(Errno::ENOENT);
        }
        if file_type(r32(&inode, INO_MODE).ok_or(Errno::EIO)?) != 0x4000 {
            return Err(Errno::ENOTDIR);
        }
        let size = r64(&inode, INO_SIZE).ok_or(Errno::EIO)?;
        let maximum = if self.version == KANDELO_IMAGE_EXTENDED_VERSION {
            MAX_FILE_BLOCKS
        } else {
            V1_MAX_FILE_BLOCKS
        };
        if size.div_ceil(BLOCK_SIZE as u64) > maximum {
            return Err(Errno::EFBIG);
        }
        Ok(self.resume_directory(DirectoryPosition { inode, size, offset: 0 }))
    }

    pub fn resume_directory(&self, position: DirectoryPosition) -> DirectoryCursor<'_, S> {
        DirectoryCursor { filesystem: self, position, block_start: None, block: [0; BLOCK_SIZE] }
    }

    pub fn read_dir(&self, dir_ino: u32) -> Result<Vec<KandeloImageDirent>, Errno> {
        let mut cursor = self.directory_entries(dir_ino)?;
        let mut out = Vec::new();
        while let Some(entry) = cursor.next_entry()? {
            out.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
            let mut name = Vec::new();
            name.try_reserve_exact(entry.name.len()).map_err(|_| Errno::ENOMEM)?;
            name.extend_from_slice(entry.name);
            out.push(KandeloImageDirent { ino: entry.ino, name });
        }
        Ok(out)
    }

    /// Resolves `name` to a child ino within `dir_ino` via a linear scan of
    /// directory records. The writer's directory index is an in-process optimization
    /// with no on-disk form, so a linear scan is correct here.
    pub fn lookup(&self, dir_ino: u32, name: &[u8]) -> Result<u32, Errno> {
        let mut cursor = self.directory_entries(dir_ino)?;
        let mut found = None;
        while let Some(entry) = cursor.next_entry()? {
            if found.is_none() && entry.name == name {
                found = Some(entry.ino);
            }
        }
        found.ok_or(Errno::ENOENT)
    }

    /// The image's deferred-file section, or `None` when it declares none.
    ///
    /// Reads the unlinked inode the superblock names and parses it. The
    /// payload inside each record is returned untouched — see
    /// [`crate::sdef`] for why this layer refuses to look inside it.
    ///
    /// An image written before this section existed carries 0 in the
    /// superblock field and reads as `None`, not as corrupt.
    pub fn deferred_section(&self) -> Result<Option<crate::sdef::DeferredSection>, Errno> {
        self.deferred_section_with_admission(|_| Ok(()))
    }

    pub fn deferred_section_with_admission(
        &self,
        admit: impl FnMut(usize) -> Result<(), Errno>,
    ) -> Result<Option<crate::sdef::DeferredSection>, Errno> {
        if self.deferred_inode == 0 {
            return Ok(None);
        }
        let stat = self.stat_ino(self.deferred_inode)?;
        // The section is metadata the image carries about itself, so its size
        // is bounded by the image; a size past that is corruption, not a large
        // section, and must not drive an allocation.
        if stat.size > self.source.len() {
            return Err(Errno::EINVAL);
        }
        crate::sdef::decode_from_with_admission(stat.size, crate::sdef::METADATA_BUDGET_BYTES,
            |offset, destination| self.read_at(self.deferred_inode, offset, destination), admit).map(Some)
    }

    /// Reads a symlink's target. Short targets (`size <= 40`) are stored
    /// inline in the inode's direct-pointer area (no data block allocated);
    /// longer targets are stored as regular file data via `read_at`.
    pub fn read_link(&self, ino: u32) -> Result<Vec<u8>, Errno> {
        let st = self.stat_ino(ino)?;
        if file_type(st.mode) != 0xa000 { return Err(Errno::EINVAL); }
        let size = st.size;
        if size <= INLINE_SYMLINK_SIZE {
            // `INO_DIRECT + 40 <= INODE_SIZE`, so an inline target is wholly
            // inside the inode bytes already fetched.
            let raw = self.read_inode(ino)?;
            let end = INO_DIRECT.checked_add(size as usize).ok_or(Errno::EIO)?;
            return raw.get(INO_DIRECT..end).map(<[u8]>::to_vec).ok_or(Errno::EIO);
        }
        // A symlink target cannot exceed the whole image; caps `size` before
        // it drives an allocation.
        if size > self.source.len() { return Err(Errno::EIO); }
        let length = usize::try_from(size).map_err(|_| Errno::ENOMEM)?;
        let mut buf = Vec::new();
        buf.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
        buf.resize(length, 0);
        if self.read_link_into(ino, &mut buf)? != length { return Err(Errno::EIO); }
        Ok(buf)
    }

    pub fn read_link_into(&self, ino: u32, destination: &mut [u8]) -> Result<usize, Errno> {
        let stat = self.stat_ino(ino)?;
        if file_type(stat.mode) != 0xa000 { return Err(Errno::EINVAL); }
        if stat.size > self.source.len() { return Err(Errno::EIO); }
        let length = stat.size.min(destination.len() as u64) as usize;
        if stat.size <= INLINE_SYMLINK_SIZE {
            let raw = self.read_inode(ino)?;
            destination[..length].copy_from_slice(&raw[INO_DIRECT..INO_DIRECT + length]);
            return Ok(length);
        }
        self.read_at(ino, 0, &mut destination[..length])
    }

    /// Resolves an absolute path to an inode number, starting from
    /// `ROOT_INO`. Intermediate components must be directories (`ENOTDIR`
    /// otherwise). Symlinks are always followed for intermediate
    /// components; the final component is followed only if `follow_final`
    /// is set (the `stat` vs `lstat` distinction). Symlink targets are
    /// spliced into the front of the remaining component queue; an
    /// absolute target restarts resolution at the root. Resolution is
    /// capped at `MAX_SYMLINK_HOPS` hops (`ELOOP`).
    ///
    /// NOTE on `..`: this minimal version treats `..` as a no-op (correct
    /// for root; nested `..` needs a parent stack). The base `/` images the
    /// overlay loads are canonical and the kernel's own resolver already
    /// handles `..` before this layer is consulted (later wiring), so full
    /// `..` support is deferred; add a parent-stack only if a fixture
    /// proves it necessary.
    pub fn resolve(&self, path: &[u8], follow_final: bool) -> Result<u32, Errno> {
        // Build the component queue (absolute paths only; leading '/' required).
        if path.first() != Some(&b'/') { return Err(Errno::EINVAL); }
        let mut comps: alloc::collections::VecDeque<Vec<u8>> = path
            .split(|&c| c == b'/').filter(|c| !c.is_empty())
            .map(|c| c.to_vec()).collect();
        let mut cur = ROOT_INO;
        let mut hops = 0u32;
        while let Some(comp) = comps.pop_front() {
            let is_final = comps.is_empty();
            let st = self.stat_ino(cur)?;
            if file_type(st.mode) != 0x4000 { return Err(Errno::ENOTDIR); }
            if comp.as_slice() == b"." { continue; }
            if comp.as_slice() == b".." { continue; } // root's .. is root; nested handled below
            let child = self.lookup(cur, &comp)?;
            let cst = self.stat_ino(child)?;
            let is_link = file_type(cst.mode) == 0xa000;
            if is_link && (!is_final || follow_final) {
                hops += 1;
                if hops > MAX_SYMLINK_HOPS { return Err(Errno::ELOOP); }
                let target = self.read_link(child)?;
                let absolute = target.first() == Some(&b'/');
                let spliced: alloc::collections::VecDeque<Vec<u8>> = target
                    .split(|&c| c == b'/').filter(|c| !c.is_empty())
                    .map(|c| c.to_vec()).collect();
                if absolute { cur = ROOT_INO; }
                // Prepend spliced target components before the remaining ones.
                for c in spliced.into_iter().rev() { comps.push_front(c); }
                continue;
            }
            cur = child;
        }
        Ok(cur)
    }
}

const MAX_SYMLINK_HOPS: u32 = 8;

pub(crate) const DIRENT_HEADER: usize = 8;

pub struct KandeloImageDirent {
    pub ino: u32,
    pub name: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");

    struct VirtualAllocationSource {
        blocks: u64,
        present: Option<&'static [u64]>,
        reads: core::cell::Cell<u64>,
        fail_pages: core::cell::Cell<Option<Errno>>,
        corrupt: Option<u64>,
    }

    impl VirtualAllocationSource {
        const SINGLE: u32 = 100;
        const DOUBLE: u32 = 101;
        const DOUBLE_LEAVES: u32 = 102;
        const TRIPLE: u32 = Self::DOUBLE_LEAVES + PTRS_PER_BLOCK;
        const TRIPLE_MIDDLES: u32 = Self::TRIPLE + 1;
        const TRIPLE_LEAVES: u32 = Self::TRIPLE_MIDDLES + PTRS_PER_BLOCK;
        const DATA: u32 = 2_000_000;

        fn dense(blocks: u64) -> Self {
            Self { blocks, present: None, reads: core::cell::Cell::new(0),
                fail_pages: core::cell::Cell::new(None), corrupt: None }
        }

        fn has_data(&self, start: u64, end: u64) -> bool {
            start < self.blocks && self.present.is_none_or(|blocks| {
                blocks.iter().any(|&block| block >= start && block < end.min(self.blocks))
            })
        }

        fn data_pointer(&self, logical: u64) -> u32 {
            if !self.has_data(logical, logical + 1) { return 0; }
            if self.corrupt == Some(logical) { return u32::MAX; }
            Self::DATA + logical as u32
        }

        fn geometry(&self) -> KandeloImageGeometry {
            KandeloImageGeometry { version: KANDELO_IMAGE_EXTENDED_VERSION,
                total_blocks: Self::DATA + self.blocks as u32 + 1, data_start: 100,
                inode_table_start: 1, total_inodes: INODES_PER_BLOCK, deferred_inode: 0 }
        }
    }

    impl BlockSource for VirtualAllocationSource {
        fn len(&self) -> u64 { self.geometry().total_blocks as u64 * BLOCK_SIZE as u64 }

        fn read_exact_at(&self, offset: u64, target: &mut [u8]) -> Result<(), Errno> {
            self.reads.set(self.reads.get() + 1);
            target.fill(0);
            let pointers = PTRS_PER_BLOCK as u64;
            let double_start = DIRECT_BLOCKS as u64 + pointers;
            if offset == BLOCK_SIZE as u64 + 2 * INODE_SIZE as u64 && target.len() == INODE_SIZE {
                target[INO_MODE..INO_MODE + 4].copy_from_slice(&0o100644u32.to_le_bytes());
                target[INO_LINK_COUNT..INO_LINK_COUNT + 4].copy_from_slice(&1u32.to_le_bytes());
                target[INO_SIZE..INO_SIZE + 8].copy_from_slice(&self.blocks.saturating_mul(BLOCK_SIZE as u64).saturating_sub(1).to_le_bytes());
                for logical in 0..DIRECT_BLOCKS {
                    let field = INO_DIRECT + logical as usize * 4;
                    target[field..field + 4].copy_from_slice(&self.data_pointer(logical as u64).to_le_bytes());
                }
                for (field, pointer, start, end) in [
                    (INO_INDIRECT, Self::SINGLE, DIRECT_BLOCKS as u64, double_start),
                    (INO_DOUBLE_INDIRECT, Self::DOUBLE, double_start, V1_MAX_FILE_BLOCKS),
                    (INO_TRIPLE_INDIRECT, Self::TRIPLE, V1_MAX_FILE_BLOCKS, MAX_FILE_BLOCKS),
                ] {
                    let pointer = if self.has_data(start, end) { pointer } else { 0 };
                    target[field..field + 4].copy_from_slice(&pointer.to_le_bytes());
                }
                return Ok(());
            }
            let data_block = offset / BLOCK_SIZE as u64;
            if data_block >= u64::from(Self::DATA) && data_block - u64::from(Self::DATA) < self.blocks {
                let logical = data_block - u64::from(Self::DATA);
                let within = offset % BLOCK_SIZE as u64;
                for (index, byte) in target.iter_mut().enumerate() {
                    *byte = ((logical + within + index as u64) % 251) as u8;
                }
                return Ok(());
            }
            if target.len() != BLOCK_SIZE || !offset.is_multiple_of(BLOCK_SIZE as u64) { return Err(Errno::EIO); }
            if let Some(error) = self.fail_pages.get() { return Err(error); }
            let block = u32::try_from(offset / BLOCK_SIZE as u64).map_err(|_| Errno::EIO)?;
            for index in 0..PTRS_PER_BLOCK {
                let pointer = if block == Self::SINGLE {
                    self.data_pointer(DIRECT_BLOCKS as u64 + index as u64)
                } else if block == Self::DOUBLE {
                    let start = double_start + index as u64 * pointers;
                    if self.has_data(start, start + pointers) { Self::DOUBLE_LEAVES + index } else { 0 }
                } else if (Self::DOUBLE_LEAVES..Self::TRIPLE).contains(&block) {
                    self.data_pointer(double_start + (block - Self::DOUBLE_LEAVES) as u64 * pointers + index as u64)
                } else if block == Self::TRIPLE {
                    let start = V1_MAX_FILE_BLOCKS + index as u64 * pointers * pointers;
                    if self.has_data(start, start + pointers * pointers) { Self::TRIPLE_MIDDLES + index } else { 0 }
                } else if (Self::TRIPLE_MIDDLES..Self::TRIPLE_LEAVES).contains(&block) {
                    let group = (block - Self::TRIPLE_MIDDLES) * PTRS_PER_BLOCK + index;
                    let start = V1_MAX_FILE_BLOCKS + group as u64 * pointers;
                    if self.has_data(start, start + pointers) { Self::TRIPLE_LEAVES + group } else { 0 }
                } else if (Self::TRIPLE_LEAVES..Self::TRIPLE_LEAVES + PTRS_PER_BLOCK * PTRS_PER_BLOCK).contains(&block) {
                    self.data_pointer(V1_MAX_FILE_BLOCKS + (block - Self::TRIPLE_LEAVES) as u64 * pointers + index as u64)
                } else {
                    return Err(Errno::EIO);
                };
                let field = index as usize * 4;
                target[field..field + 4].copy_from_slice(&pointer.to_le_bytes());
            }
            Ok(())
        }
    }

    #[test]
    fn file_read_position_reuses_bounded_traversal_pages_across_small_reads() {
        let source = VirtualAllocationSource::dense(V1_MAX_FILE_BLOCKS + 2);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        let mut position = filesystem.file_read_position(2).unwrap();
        assert!(core::mem::size_of::<FileReadPosition>() < 16 * 1024);
        for start in [0, DIRECT_BLOCKS as u64, DIRECT_BLOCKS as u64 + PTRS_PER_BLOCK as u64,
            V1_MAX_FILE_BLOCKS] {
            source.reads.set(0);
            for logical in start..start + 2 {
                let mut actual = [0; 97];
                assert_eq!(filesystem.read_at_position(&mut position, logical * BLOCK_SIZE as u64 + 123, &mut actual), Ok(actual.len()));
                for (index, byte) in actual.into_iter().enumerate() {
                    assert_eq!(byte, ((logical + 123 + index as u64) % 251) as u8);
                }
            }
            assert!(source.reads.get() <= 5, "indirect depth must not be paid for each read");
        }
        let mut tail = [0xCC; 11];
        let size = source.blocks * BLOCK_SIZE as u64 - 1;
        assert_eq!(filesystem.read_at_position(&mut position, size - 3, &mut tail), Ok(3));
        assert_eq!(&tail[3..], &[0xCC; 8]);
        assert_eq!(filesystem.read_at_position(&mut position, size, &mut tail), Ok(0));
    }

    #[test]
    fn file_read_position_skips_holes_and_retries_failed_pointer_refills() {
        const PRESENT: &[u64] = &[0, V1_MAX_FILE_BLOCKS + 1024];
        let mut source = VirtualAllocationSource::dense(V1_MAX_FILE_BLOCKS + 1025);
        source.present = Some(PRESENT);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        let mut position = filesystem.file_read_position(2).unwrap();
        let mut hole = [0xCC; 8192];
        assert_eq!(filesystem.read_at_position(&mut position, 1034 * BLOCK_SIZE as u64, &mut hole), Ok(hole.len()));
        assert_eq!(hole, [0; 8192]);
        let at = PRESENT[1] * BLOCK_SIZE as u64;
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO] {
            source.fail_pages.set(Some(error));
            let mut untouched = [0xCC; 31];
            assert_eq!(filesystem.read_at_position(&mut position, at, &mut untouched), Err(error));
            assert_eq!(untouched, [0xCC; 31]);
        }
        source.fail_pages.set(None);
        let mut actual = [0; 31];
        assert_eq!(filesystem.read_at_position(&mut position, at, &mut actual), Ok(actual.len()));
        assert_ne!(actual, [0; 31]);
    }

    #[test]
    fn file_allocation_cursor_counts_dense_file_without_a_block_list() {
        let source = VirtualAllocationSource::dense((1 << 23) + 1);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        assert_eq!(filesystem.allocated_file_block_count(2), Ok(source.blocks));
        assert!(source.reads.get() <= source.blocks.div_ceil(PTRS_PER_BLOCK as u64)
            + source.blocks.div_ceil(PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64) + 8);
        assert!(core::mem::size_of::<FileAllocationCursor<'_, &VirtualAllocationSource>>() < 16 * 1024);
        source.reads.set(0);
        assert_eq!(filesystem.sparse_file_blocks(2), Ok(None));
        assert!(source.reads.get() <= source.blocks.div_ceil(PTRS_PER_BLOCK as u64)
            + source.blocks.div_ceil(PTRS_PER_BLOCK as u64 * PTRS_PER_BLOCK as u64) + 8);
    }

    #[test]
    fn file_allocation_cursor_keeps_leading_trailing_and_empty_sparse_maps_distinct() {
        for (blocks, present, expected) in [
            (12, &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9][..], (0..10).collect::<Vec<u32>>()),
            (12, &[10, 11][..], alloc::vec![10, 11]),
            (12, &[][..], Vec::new()),
        ] {
            let mut source = VirtualAllocationSource::dense(blocks);
            source.present = Some(present);
            let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
            assert_eq!(filesystem.sparse_file_blocks(2), Ok(Some(expected)));
            assert!(source.reads.get() <= 2);
        }
        let source = VirtualAllocationSource::dense(0);
        assert_eq!(KandeloImageFs::from_geometry(&source, source.geometry()).sparse_file_blocks(2), Ok(None));
    }

    #[test]
    fn file_allocation_cursor_skips_empty_branches_across_the_full_v2_range() {
        const PRESENT: &[u64] = &[0, 9, 10, 1033, 1034, V1_MAX_FILE_BLOCKS - 1,
            V1_MAX_FILE_BLOCKS, V1_MAX_FILE_BLOCKS + 1024, MAX_FILE_BLOCKS - 1];
        let mut source = VirtualAllocationSource::dense(MAX_FILE_BLOCKS);
        source.present = Some(PRESENT);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        let mut cursor = filesystem.file_allocations(2, 0..u64::MAX).unwrap();
        for &expected in PRESENT { assert_eq!(cursor.next_block(), Ok(Some(expected as u32))); }
        assert_eq!(cursor.next_block(), Ok(None));
        assert_eq!(cursor.next_block(), Ok(None));
        assert!(source.reads.get() < 32);
    }

    #[test]
    fn file_allocation_cursor_clamps_ranges_and_checks_only_the_requested_branches() {
        let source = VirtualAllocationSource::dense(MAX_FILE_BLOCKS);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        for start in [8, 1032, V1_MAX_FILE_BLOCKS - 1, MAX_FILE_BLOCKS - 1] {
            let before = source.reads.get();
            let mut cursor = filesystem.file_allocations(2, start..start + 3).unwrap();
            for block in start..(start + 3).min(MAX_FILE_BLOCKS) {
                assert_eq!(cursor.next_block(), Ok(Some(block as u32)));
            }
            assert_eq!(cursor.next_block(), Ok(None));
            assert!(source.reads.get() - before <= 6);
        }
        assert!(matches!(filesystem.file_allocations(2, 8..7), Err(Errno::EINVAL)));
        assert_eq!(filesystem.file_allocations(2, MAX_FILE_BLOCKS..u64::MAX).unwrap().next_block(), Ok(None));
    }

    #[test]
    fn file_allocation_cursor_preserves_source_errors_and_can_retry_a_failed_page() {
        let source = VirtualAllocationSource::dense(32);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        let mut cursor = filesystem.file_allocations(2, 10..32).unwrap();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO] {
            source.fail_pages.set(Some(error));
            assert_eq!(cursor.next_block(), Err(error));
        }
        source.fail_pages.set(None);
        assert_eq!(cursor.next_block(), Ok(Some(10)));
    }

    #[test]
    fn file_allocation_cursor_does_not_hide_corrupt_pointers_after_sparse_holes() {
        let mut source = VirtualAllocationSource::dense(MAX_FILE_BLOCKS);
        source.present = Some(&[10, 1034, MAX_FILE_BLOCKS - 1]);
        source.corrupt = Some(MAX_FILE_BLOCKS - 1);
        let filesystem = KandeloImageFs::from_geometry(&source, source.geometry());
        let mut cursor = filesystem.file_allocations(2, 0..u64::MAX).unwrap();
        assert_eq!(cursor.next_block(), Ok(Some(10)));
        assert_eq!(cursor.next_block(), Ok(Some(1034)));
        assert_eq!(cursor.next_block(), Err(Errno::EIO));
        assert_eq!(filesystem.allocated_file_block_count(2), Err(Errno::EIO));
        let mut geometry = source.geometry();
        geometry.version = KANDELO_IMAGE_VERSION;
        assert!(matches!(KandeloImageFs::from_geometry(&source, geometry).file_allocations(2, 0..u64::MAX), Err(Errno::EFBIG)));
    }

    /// The metadata section round-trips through the container writer, at every
    /// combination of the OPTIONAL sections that precede it.
    ///
    /// That matters more than a single happy path: the section is found by
    /// walking past the lazy JSON and, conditionally, the archive JSON. A walk
    /// that forgets one conditional still works whenever that section is
    /// absent, so only the combinations expose it.
    #[test]
    fn metadata_section_round_trips_behind_every_optional_section() {
        use crate::vfsi_container::{wrap, ContainerSections};
        let meta: &[u8] = br#"{"version":1,"kernelAbi":44,"createdBy":"a test"}"#;
        let body: &[u8] = b"body bytes, not a real filesystem";
        for archive in [None, Some(&b"[archive json]"[..])] {
            for lazy in [&b""[..], &b"{\"lazy\":1}"[..]] {
                let image = wrap(
                    body,
                    &ContainerSections {
                        lazy_json: lazy,
                        archive_json: archive,
                        metadata_json: Some(meta),
                        kernel_lazy: Some(b"KLZY"),
                    },
                )
                .expect("wrap");
                assert_eq!(
                    metadata_section(&image).expect("metadata"),
                    Some(meta),
                    "metadata must be found with lazy={lazy:?} archive={archive:?}",
                );
                // And the KLZY walk must still land correctly alongside it.
                assert_eq!(kernel_lazy_section(&image).expect("klzy"), Some(&b"KLZY"[..]));
            }
        }
    }

    /// An image that declares no metadata reports none, rather than reading
    /// whichever bytes happen to follow.
    #[test]
    fn metadata_section_is_absent_when_the_flag_is_clear() {
        use crate::vfsi_container::{wrap, ContainerSections};
        let image = wrap(
            b"body",
            &ContainerSections {
                lazy_json: b"{}",
                archive_json: None,
                metadata_json: None,
                kernel_lazy: Some(b"KLZY"),
            },
        )
        .expect("wrap");
        assert_eq!(metadata_section(&image).expect("metadata"), None);
    }

    /// The ceiling is the CONFIGURED maximum, asserted against a literal.
    ///
    /// Written after mutation testing killed the original version of these
    /// tests -- which derived the expected value by calling the function under
    /// test, so dropping the block-size multiply and dropping the clamp both
    /// survived. A test whose expectation comes from the implementation
    /// verifies only that the implementation equals itself.
    #[test]
    fn growth_ceiling_reports_the_configured_maximum() {
        use crate::kandelo_image_write::{NoContent, KandeloImageConfig, KandeloImageWriter};
        // The initial size must hold the metadata that max_size_bytes sizes:
        // a larger ceiling means more inodes, a bigger block bitmap and a
        // bigger inode table, and mkfs answers ENOSPC when those do not fit.
        let w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 2 * 1024 * 1024,
            max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 2 * 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let body = w.finish().expect("finish").to_vec(&NoContent).expect("to_vec");
        let fs = KandeloImageFs::mount(body).expect("mount");
        assert_eq!(
            fs.growth_ceiling_bytes().expect("ceiling"),
            8 * 1024 * 1024,
            "the ceiling is max_size_blocks * block size, and 8 MiB is what was configured",
        );
    }

    /// A configured maximum SMALLER than the body reports the body instead.
    ///
    /// The clamp has no effect on an ordinary image, which is why dropping it
    /// went unnoticed: only an image whose recorded ceiling it has already
    /// outgrown can tell the difference.
    #[test]
    fn growth_ceiling_clamps_up_when_the_configured_maximum_is_already_exceeded() {
        use crate::kandelo_image_write::{NoContent, KandeloImageConfig, KandeloImageWriter};
        let w = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 2 * 1024 * 1024,
            // 64 KiB: far below the 2 MiB body this image occupies.
            max_size_bytes: Some(64 * 1024),
            growable_to_bytes: 2 * 1024 * 1024,
            now_ms: 0,
        })
        .expect("mkfs");
        let body = w.finish().expect("finish").to_vec(&NoContent).expect("to_vec");
        let body_len = body.len() as u64;
        let fs = KandeloImageFs::mount(body).expect("mount");
        assert_eq!(
            fs.growth_ceiling_bytes().expect("ceiling"),
            body_len,
            "a ceiling below the current size is a limit already exceeded; report the real floor",
        );
        assert!(
            body_len > 64 * 1024,
            "the fixture must actually exceed its configured max, or the clamp is untested",
        );
    }

    /// `statfs` answers from the real fixture's superblock, and the numbers
    /// are internally consistent with the tree it describes.
    ///
    /// Asserted as relationships rather than hardcoded totals: pinning
    /// "f_blocks == 32" would break the moment the fixture is regenerated at a
    /// different size and would be testing the fixture, not the reader.
    #[test]
    fn statfs_reports_the_images_own_geometry() {
        let image = unwrap_vfsi(TINY_VFS).expect("VFSI unwrap");
        let fs = KandeloImageFs::mount(image).expect("mount");
        let st = fs.statfs().expect("statfs");

        assert_eq!(st.f_type, KANDELO_IMAGE_SUPER_MAGIC, "reports itself as KIFS");
        assert_eq!(st.f_bsize, BLOCK_SIZE as u32);
        assert_eq!(st.f_frsize, st.f_bsize, "KIFS has no fragment size distinct from its block size");
        assert_eq!(st.f_bavail, st.f_bfree, "KIFS reserves no blocks, so available == free");

        assert!(st.f_blocks > 0 && st.f_files > 0, "a mounted image has blocks and inodes");
        assert!(st.f_bfree <= st.f_blocks, "free blocks cannot exceed the total");
        assert!(st.f_ffree <= st.f_files, "free inodes cannot exceed the total");
        assert!(
            st.f_ffree < st.f_files,
            "the fixture holds a tree, so some inodes are in use",
        );
        assert_eq!(
            st.f_blocks * st.f_bsize as u64,
            fs.source.len() as u64,
            "the block count must describe the whole filesystem body",
        );
    }

    /// A superblock claiming more free than it has is corruption, not an empty
    /// filesystem. Without this the headroom assertion a builder runs would
    /// read a wildly generous free count off a damaged image and pass.
    #[test]
    fn statfs_refuses_a_superblock_claiming_impossible_free_counts() {
        let image = unwrap_vfsi(TINY_VFS).expect("VFSI unwrap");
        let mut owned = image.to_vec();
        let total_blocks = u32::from_le_bytes(owned[12..16].try_into().unwrap());
        owned[20..24].copy_from_slice(&(total_blocks + 1).to_le_bytes());
        let fs = KandeloImageFs::mount(owned).expect("mount");
        assert_eq!(fs.statfs().unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn unwrap_vfsi_returns_the_image_with_valid_magic() {
        let image = unwrap_vfsi(TINY_VFS).expect("VFSI unwrap");
        // Inner filesystem superblock magic "KIFS" at byte 0. The constant is
        // 0x5346_494B because it is read as a LITTLE-ENDIAN u32, so the low
        // byte is the first character. "SFFS" hid this: its bytes are a
        // palindrome, so the old constant read correctly either way.
        assert_eq!(r32(image, 0), Some(0x5346_494B));
    }

    #[test]
    fn unwrap_vfsi_rejects_bad_magic() {
        let mut bad = TINY_VFS.to_vec();
        bad[0] ^= 0xff;
        assert!(unwrap_vfsi(&bad).is_err());
    }

    #[test]
    fn mount_validates_superblock() {
        let image = unwrap_vfsi(TINY_VFS).unwrap();
        let fs = KandeloImageFs::mount(image).expect("mount");
        assert!(fs.inode_table_start >= 1);
    }

    #[test]
    fn mount_rejects_wrong_block_size() {
        let mut bad = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        bad[8] = 0; bad[9] = 0; bad[10] = 0; bad[11] = 0; // BLOCK_SIZE=0
        assert!(KandeloImageFs::mount(bad.as_slice()).is_err());
    }

    #[test]
    fn mount_rejects_bitmap_that_cannot_describe_the_image() {
        let mut bad = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        bad[SB_BLOCK_BITMAP_BLOCKS as usize..SB_BLOCK_BITMAP_BLOCKS as usize + 4].fill(0);
        assert!(KandeloImageFs::mount(bad.as_slice()).is_err());
        bad[SB_TOTAL_BLOCKS as usize..SB_TOTAL_BLOCKS as usize + 4].fill(0);
        assert!(KandeloImageFs::mount(bad.as_slice()).is_err());
    }

    #[test]
    fn mount_rejects_overlapping_or_truncated_metadata_regions() {
        let original = unwrap_vfsi(TINY_VFS).unwrap();
        let mut overlapping = original.to_vec();
        overlapping[32..36].copy_from_slice(&1u32.to_le_bytes());
        assert!(matches!(KandeloImageFs::mount(overlapping.as_slice()), Err(Errno::EINVAL)));

        let mut missing_inode_bitmap = original.to_vec();
        missing_inode_bitmap[44..48].fill(0);
        assert!(matches!(KandeloImageFs::mount(missing_inode_bitmap.as_slice()), Err(Errno::EINVAL)));

        let mut truncated = original.to_vec();
        truncated.pop();
        assert!(matches!(KandeloImageFs::mount(truncated.as_slice()), Err(Errno::EINVAL)));
    }

    #[test]
    fn mount_accepts_an_owned_source() {
        // `Vec<u8>` is a `BlockSource` too, so a caller that owns the image
        // does not have to keep a borrow alive alongside the mount.
        let owned = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let fs = KandeloImageFs::mount(owned).expect("mount owned");
        assert_eq!(fs.stat_ino(ROOT_INO).unwrap().mode & 0xf000, 0x4000);
    }

    #[test]
    fn root_inode_is_a_directory() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let st = fs.stat_ino(ROOT_INO).unwrap();
        assert_eq!(st.mode & 0xf000, 0x4000, "root is S_IFDIR");
        assert!(st.nlink >= 2, "dir has >= 2 links (. and ..)");
    }

    #[test]
    fn block_map_direct_hole_and_beyond_max() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        // Root dir's first data block is allocated (non-zero physical block).
        assert!(fs.block_map(ROOT_INO, 0).unwrap() != 0, "root dir data block 0");
        // An unallocated direct block within range reads as a sparse hole (0).
        assert_eq!(fs.block_map(ROOT_INO, 5).unwrap(), 0, "unallocated direct block is a hole");
        // A file block beyond the double-indirect range is EINVAL, not a hole.
        assert!(fs.block_map(ROOT_INO, 2_000_000).is_err(), "beyond max file blocks -> EINVAL");
    }

    #[test]
    fn allocated_file_blocks_skip_sparse_indirect_branches() {
        use crate::kandelo_image_write::{
            Content, ContentSource, KandeloImageConfig, KandeloImageSource, KandeloImageWriter,
        };

        struct TailContent;

        impl ContentSource for TailContent {
            fn read_exact_at(&self, _id: u64, _offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                dst.fill(b'x');
                Ok(())
            }
        }

        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        let blocks = [0, 10, 1034, 105_000];
        writer
            .create_file(
                writer.root(),
                b"sparse",
                0o644,
                Content::SparseDeferred {
                    id: 1,
                    len: 512 * 1024 * 1024 + 1,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let image = writer.finish().unwrap();
        let filesystem = KandeloImageFs::mount(KandeloImageSource {
            image: &image,
            content: &TailContent,
        })
        .unwrap();
        let inode = filesystem.resolve(b"/sparse", true).unwrap();
        assert_eq!(filesystem.allocated_file_blocks(inode), Ok(blocks.to_vec()));
        assert_eq!(filesystem.allocated_file_blocks(ROOT_INO), Err(Errno::EINVAL));
        let mut hole = [1; 8];
        assert_eq!(filesystem.read_at(inode, 100 * BLOCK_SIZE as u64, &mut hole), Ok(8));
        assert_eq!(hole, [0; 8]);
    }

    #[test]
    fn allocated_file_blocks_reject_out_of_bounds_indirect_pointer() {
        let mut image = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let inode = filesystem.resolve(b"/big.txt", true).unwrap();
        let pointer_offset = filesystem.inode_offset(inode) as usize + INO_INDIRECT;
        image[pointer_offset..pointer_offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        assert_eq!(damaged.allocated_file_blocks(inode), Err(Errno::EIO));
    }

    #[test]
    fn direct_pointer_into_metadata_is_not_read_as_file_content() {
        let mut image = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let inode = filesystem.resolve(b"/big.txt", true).unwrap();
        let pointer_offset = filesystem.inode_offset(inode) as usize + INO_DIRECT;
        image[pointer_offset..pointer_offset + 4].copy_from_slice(&1u32.to_le_bytes());

        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        let mut byte = [0];
        assert_eq!(damaged.read_at(inode, 0, &mut byte), Err(Errno::EIO));
        assert_eq!(damaged.allocated_file_blocks(inode), Err(Errno::EIO));
    }

    #[test]
    fn direct_pointer_past_declared_blocks_cannot_read_a_trailer() {
        let mut image = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let inode = filesystem.resolve(b"/big.txt", true).unwrap();
        let pointer_offset = filesystem.inode_offset(inode) as usize + INO_DIRECT;
        let total_blocks = filesystem.geometry().total_blocks;
        image[pointer_offset..pointer_offset + 4].copy_from_slice(&total_blocks.to_le_bytes());
        image.extend_from_slice(&[b'x'; BLOCK_SIZE]);

        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        let mut byte = [0];
        assert_eq!(damaged.read_at(inode, 0, &mut byte), Err(Errno::EIO));
        assert_eq!(damaged.allocated_file_blocks(inode), Err(Errno::EIO));
    }

    #[test]
    fn extended_pointer_into_metadata_is_not_read_as_file_content() {
        use crate::kandelo_image_write::{
            Content, ContentSource, KandeloImageConfig, KandeloImageWriter,
        };

        struct Zeros;

        impl ContentSource for Zeros {
            fn read_exact_at(&self, _id: u64, _offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                dst.fill(0);
                Ok(())
            }
        }

        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        let offset = 9 * 1024 * 1024 * 1024u64;
        let blocks = [(offset / BLOCK_SIZE as u64) as u32];
        writer
            .create_file(
                writer.root(),
                b"extended",
                0o644,
                Content::SparseDeferred {
                    id: 1,
                    len: offset + 1,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let mut image = writer.finish().unwrap().to_vec(&Zeros).unwrap();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let inode = filesystem.resolve(b"/extended", true).unwrap();
        let pointer_offset = filesystem.inode_offset(inode) as usize + INO_TRIPLE_INDIRECT;
        image[pointer_offset..pointer_offset + 4].copy_from_slice(&1u32.to_le_bytes());

        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        let mut byte = [0];
        assert_eq!(damaged.read_at(inode, offset, &mut byte), Err(Errno::EIO));
        assert_eq!(damaged.allocated_file_blocks(inode), Err(Errno::EIO));
    }

    #[test]
    fn read_at_reads_root_dir_bytes_nonzero() {
        // Directory data is readable via read_at too; assert we get bytes.
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let size = fs.stat_ino(ROOT_INO).unwrap().size;
        let mut buf = [0u8; 64];
        let n = fs.read_at(ROOT_INO, 0, &mut buf).unwrap();
        assert!(n > 0 && (n as u64) <= size);
        // beyond EOF returns 0
        assert_eq!(fs.read_at(ROOT_INO, size + 10, &mut buf).unwrap(), 0);
    }

    #[test]
    fn read_at_spans_indirect_blocks() {
        // /big.txt is 45000 bytes (big[i] = i % 251), which exceeds the ten
        // direct blocks, so a whole-file read walks the single-indirect
        // block. Under the cursor the inode is fetched once for the whole
        // read rather than once per 4 KiB chunk; the bytes must be identical.
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let ino = fs.resolve(b"/big.txt", true).unwrap();
        let size = fs.stat_ino(ino).unwrap().size as usize;
        assert_eq!(size, 45000);
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(ino, 0, &mut buf).unwrap(), size);
        for (i, b) in buf.iter().enumerate() {
            assert_eq!(*b, (i % 251) as u8, "byte {i}");
        }
        // A read that starts mid-block and crosses the direct/indirect
        // boundary returns the same bytes as the whole-file read.
        let mut mid = alloc::vec![0u8; 8192];
        let n = fs.read_at(ino, 40_000, &mut mid).unwrap();
        assert_eq!(n, size - 40_000);
        assert_eq!(&mid[..n], &buf[40_000..]);
    }

    #[test]
    fn read_dir_lists_root_entries() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let names: alloc::vec::Vec<alloc::vec::Vec<u8>> =
            fs.read_dir(ROOT_INO).unwrap().into_iter().map(|e| e.name).collect();
        for want in [b"hello.txt".as_slice(), b"dir", b"link", b"big.txt"] {
            assert!(names.iter().any(|n| n.as_slice() == want), "missing {:?}", want);
        }
        // ENOTDIR on a non-directory: hello.txt's inode
        let file_ino = fs.read_dir(ROOT_INO).unwrap().into_iter()
            .find(|e| e.name == b"hello.txt").unwrap().ino;
        assert!(fs.read_dir(file_ino).is_err());
    }

    fn wide_directory_image() -> Vec<u8> {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 2 * 1024 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 2 * 1024 * 1024,
            now_ms: 0,
        }).unwrap();
        for index in 0..300 {
            let name = alloc::format!("{index:04}-{}", "n".repeat(200));
            writer.create_file(writer.root(), name.as_bytes(), 0o644, Content::Bytes(b"")).unwrap();
        }
        writer.finish().unwrap().to_vec(&NoContent).unwrap()
    }

    #[test]
    fn directory_cursor_streams_direct_and_indirect_blocks_and_resumes() {
        use core::cell::Cell;
        struct Observed<'a> {
            bytes: &'a [u8],
            calls: Cell<usize>,
        }
        impl BlockSource for Observed<'_> {
            fn len(&self) -> u64 { self.bytes.len() as u64 }
            fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
                assert!(destination.len() <= BLOCK_SIZE);
                self.calls.set(self.calls.get() + 1);
                self.bytes.read_exact_at(offset, destination)
            }
        }
        let bytes = wide_directory_image();
        let source = Observed { bytes: &bytes, calls: Cell::new(0) };
        let filesystem = KandeloImageFs::mount(&source).unwrap();
        let mut cursor = filesystem.directory_entries(ROOT_INO).unwrap();
        let initial_calls = source.calls.get();
        assert_eq!(cursor.next_entry().unwrap().unwrap().name, b".");
        assert_eq!(cursor.next_entry().unwrap().unwrap().name, b"..");
        for index in 0..300 {
            if index == 137 {
                cursor = filesystem.resume_directory(cursor.position());
            }
            let entry = cursor.next_entry().unwrap().unwrap();
            assert_eq!(entry.name, alloc::format!("{index:04}-{}", "n".repeat(200)).as_bytes());
        }
        assert!(cursor.next_entry().unwrap().is_none());
        assert!(source.calls.get() - initial_calls < 35);
        assert!(core::mem::size_of::<DirectoryCursor<'_, &[u8]>>() <= BLOCK_SIZE + 192);
        assert!(core::mem::size_of::<DirectoryPosition>() <= 144);
    }

    #[test]
    fn directory_cursor_retries_typed_source_failures_without_advancing() {
        use core::cell::Cell;
        struct Failing<'a> {
            bytes: &'a [u8],
            failure: Cell<Option<Errno>>,
        }
        impl BlockSource for Failing<'_> {
            fn len(&self) -> u64 { self.bytes.len() as u64 }
            fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
                if let Some(error) = self.failure.take() { return Err(error); }
                self.bytes.read_exact_at(offset, destination)
            }
        }
        let bytes = wide_directory_image();
        let source = Failing { bytes: &bytes, failure: Cell::new(None) };
        let filesystem = KandeloImageFs::mount(&source).unwrap();
        let mut cursor = filesystem.directory_entries(ROOT_INO).unwrap();
        for _ in 0..131 { cursor.next_entry().unwrap().unwrap(); }
        let position = cursor.position();
        let expected = cursor.next_entry().unwrap().unwrap().name.to_vec();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            let mut resumed = filesystem.resume_directory(position);
            source.failure.set(Some(error));
            assert!(matches!(resumed.next_entry(), Err(actual) if actual == error));
            assert_eq!(resumed.position().offset, position.offset);
            assert_eq!(resumed.next_entry().unwrap().unwrap().name, expected);
        }
    }

    #[test]
    fn directory_cursor_does_not_materialize_a_declared_large_directory() {
        use core::cell::Cell;
        struct PrefixOnly<'a> {
            bytes: &'a [u8],
            allowed_block: Cell<Option<u64>>,
            data_reads: Cell<usize>,
        }
        impl BlockSource for PrefixOnly<'_> {
            fn len(&self) -> u64 { self.bytes.len() as u64 }
            fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
                if let Some(allowed) = self.allowed_block.get() {
                    assert_eq!(offset, allowed);
                    self.data_reads.set(self.data_reads.get() + 1);
                }
                self.bytes.read_exact_at(offset, destination)
            }
        }
        let mut bytes = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(bytes.as_slice()).unwrap();
        let root_offset = filesystem.inode_offset(ROOT_INO) as usize;
        let physical = u64::from(filesystem.block_map(ROOT_INO, 0).unwrap()) * BLOCK_SIZE as u64;
        bytes[root_offset + INO_SIZE..root_offset + INO_SIZE + 8]
            .copy_from_slice(&(1024u64 * 1024 * 1024).to_le_bytes());
        let source = PrefixOnly { bytes: &bytes, allowed_block: Cell::new(None), data_reads: Cell::new(0) };
        let filesystem = KandeloImageFs::mount(&source).unwrap();
        let mut cursor = filesystem.directory_entries(ROOT_INO).unwrap();
        source.allowed_block.set(Some(physical));
        assert_eq!(cursor.next_entry().unwrap().unwrap().name, b".");
        assert_eq!(cursor.next_entry().unwrap().unwrap().name, b"..");
        assert_eq!(source.data_reads.get(), 1);
    }

    #[test]
    fn read_dir_rejects_a_malformed_record_after_valid_entries() {
        let mut image = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let physical = filesystem.block_map(ROOT_INO, 0).unwrap() as usize * BLOCK_SIZE;
        let first_len = u16::from_le_bytes(image[physical + 4..physical + 6].try_into().unwrap())
            as usize;
        assert!(
            first_len + DIRENT_HEADER <= filesystem.stat_ino(ROOT_INO).unwrap().size as usize
        );
        image[physical + first_len + 4..physical + first_len + 6]
            .copy_from_slice(&0u16.to_le_bytes());

        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        assert!(matches!(damaged.read_dir(ROOT_INO), Err(Errno::EIO)));
        assert_eq!(damaged.lookup(ROOT_INO, b"."), Err(Errno::EIO));
    }

    #[test]
    fn read_dir_rejects_an_incomplete_terminal_record() {
        let mut image = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        let filesystem = KandeloImageFs::mount(image.as_slice()).unwrap();
        let inode_offset = filesystem.inode_offset(ROOT_INO) as usize;
        let size = filesystem.stat_ino(ROOT_INO).unwrap().size;
        image[inode_offset + INO_SIZE..inode_offset + INO_SIZE + 8]
            .copy_from_slice(&(size + 1).to_le_bytes());

        let damaged = KandeloImageFs::mount(image.as_slice()).unwrap();
        assert!(matches!(damaged.read_dir(ROOT_INO), Err(Errno::EIO)));
    }

    #[test]
    fn lookup_finds_children_and_misses() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let dir = fs.lookup(ROOT_INO, b"dir").unwrap();
        assert_eq!(fs.stat_ino(dir).unwrap().mode & 0xf000, 0x4000);
        assert!(fs.lookup(dir, b"nested.txt").is_ok());
        assert_eq!(fs.lookup(ROOT_INO, b"nope").unwrap_err(), Errno::ENOENT);
        // A component that is not a directory is ENOTDIR, not ENOENT: the
        // name exists, it just cannot be descended into.
        assert_eq!(fs.lookup(fs.lookup(ROOT_INO, b"hello.txt").unwrap(), b"x").unwrap_err(), Errno::ENOTDIR);
    }

    #[test]
    fn read_link_into_bounds_inline_and_block_backed_targets() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let link = fs.lookup(ROOT_INO, b"link").unwrap();
        let mut short = [0xcc; 4];
        assert_eq!(fs.read_link_into(link, &mut short).unwrap(), 4);
        assert_eq!(&short, b"hell");
        let mut long = [0xcc; 64];
        assert_eq!(fs.read_link_into(link, &mut long).unwrap(), 9);
        assert_eq!(&long[..9], b"hello.txt");
        assert!(long[9..].iter().all(|byte| *byte == 0xcc));
        assert_eq!(fs.read_link_into(link, &mut []), Ok(0));
        let file = fs.lookup(ROOT_INO, b"hello.txt").unwrap();
        assert_eq!(fs.read_link_into(file, &mut short), Err(Errno::EINVAL));
        let raw = fs.read_inode(file).unwrap();
        let inode_offset = VFSI_HEADER + fs.inode_offset(link) as usize;
        drop(fs);
        let mut image = TINY_VFS.to_vec();
        image[inode_offset + INO_SIZE..inode_offset + INO_SIZE + 8].copy_from_slice(&64u64.to_le_bytes());
        image[inode_offset + INO_DIRECT..inode_offset + INO_DIRECT + 4]
            .copy_from_slice(&raw[INO_DIRECT..INO_DIRECT + 4]);
        let fs = KandeloImageFs::mount(unwrap_vfsi(&image).unwrap()).unwrap();
        let mut expected = [0; 4];
        assert_eq!(fs.read_at(file, 0, &mut expected), Ok(4));
        assert_eq!(fs.read_link_into(link, &mut short), Ok(4));
        assert_eq!(short, expected);
    }

    #[test]
    fn read_link_inline_target() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let link = fs.lookup(ROOT_INO, b"link").unwrap();
        assert_eq!(fs.stat_ino(link).unwrap().mode & 0xf000, 0xa000);
        assert_eq!(fs.read_link(link).unwrap(), b"hello.txt");
        // non-symlink => EINVAL
        let file = fs.lookup(ROOT_INO, b"hello.txt").unwrap();
        assert!(fs.read_link(file).is_err());
    }

    #[test]
    fn resolve_paths_and_symlink() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        // exact content read through a resolved path
        let ino = fs.resolve(b"/hello.txt", true).unwrap();
        let mut buf = [0u8; 32];
        let n = fs.read_at(ino, 0, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello sffs\n");
        // nested
        assert!(fs.resolve(b"/dir/nested.txt", true).is_ok());
        // symlink: follow vs no-follow
        let via_link = fs.resolve(b"/link", true).unwrap();       // -> hello.txt
        let direct = fs.resolve(b"/hello.txt", true).unwrap();
        assert_eq!(via_link, direct);
        let link_itself = fs.resolve(b"/link", false).unwrap();   // the symlink inode
        assert_eq!(fs.stat_ino(link_itself).unwrap().mode & 0xf000, 0xa000);
        // ENOTDIR: descend through a file
        assert!(fs.resolve(b"/hello.txt/x", true).is_err());
        // ENOENT
        assert!(fs.resolve(b"/nope", true).is_err());
    }

    #[test]
    fn mount_rejects_oversized_inode_table() {
        // The KIFS superblock TOTAL_INODES is at filesystem-offset 16; the VFSI header
        // adds 16 bytes, so the field lives at absolute `.vfs` offset 32.
        let mut img = TINY_VFS.to_vec();
        img[32..36].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert!(KandeloImageFs::mount(unwrap_vfsi(&img).unwrap()).is_err());
    }

    #[test]
    fn stat_ino_rejects_out_of_range_ino() {
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        // The errno is the contract, not merely that it failed: a reader
        // returning EIO here would look identical to `is_err()`.
        // `.err()` rather than `unwrap_err()`: the Ok type is `KandeloImageStat`,
        // which is not `Debug`, and a production struct should not grow a
        // derive to satisfy a test.
        assert_eq!(fs.stat_ino(u32::MAX).err(), Some(Errno::ENOENT));
        assert_eq!(fs.stat_ino(0).err(), Some(Errno::ENOENT));
    }

    #[test]
    fn read_link_rejects_oversized_symlink() {
        // Locate /link's inode, then patch its INO_SIZE field (an
        // in-inode-table absolute offset we can compute via the crate-private
        // `inode_offset`) to a value larger than the whole image, and assert
        // `read_link` fails rather than allocating/reading garbage.
        let fs = KandeloImageFs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let link = fs.lookup(ROOT_INO, b"link").unwrap();
        let size_off = fs.inode_offset(link) as usize + INO_SIZE;
        drop(fs);
        let mut img = TINY_VFS.to_vec();
        let abs = VFSI_HEADER + size_off;
        img[abs..abs + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let fs2 = KandeloImageFs::mount(unwrap_vfsi(&img).unwrap()).unwrap();
        assert!(fs2.read_link(link).is_err());
        assert_eq!(fs2.read_link_into(link, &mut [0; 4]), Err(Errno::EIO));
    }

    #[test]
    fn kernel_lazy_span_absent_when_the_flag_is_clear() {
        // The fixture predates the section, so a reader must report "not
        // declared" rather than inventing one out of the bytes that follow.
        assert_eq!(kernel_lazy_section(TINY_VFS).unwrap(), None);
    }

    #[test]
    fn kernel_lazy_span_reads_an_appended_section() {
        // Append a section to the fixture the way `saveImage` does and check
        // the container walk lands on exactly those bytes. `tiny.vfs` sets no
        // archive/metadata flags, so its trailer is the lazy JSON length alone.
        let payload: &[u8] = b"KLZY-payload-bytes";
        let mut img = TINY_VFS.to_vec();
        let flags = u32::from_le_bytes([img[8], img[9], img[10], img[11]]);
        img[8..12].copy_from_slice(
            &(flags | wasm_posix_shared::abi::VFS_IMAGE_FLAG_HAS_KERNEL_LAZY).to_le_bytes(),
        );
        img.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        img.extend_from_slice(payload);
        assert_eq!(kernel_lazy_section(&img).unwrap(), Some(payload));

        // A declared section whose length runs past the end of the image is
        // corruption, not an older image.
        let mut truncated = img.clone();
        truncated.truncate(truncated.len() - 1);
        assert!(kernel_lazy_section(&truncated).is_err());
    }

    #[test]
    fn real_rootfs_image_lists_root_and_reads_passwd() {
        // std is available in tests. Locate the uncompressed real image; skip if absent.
        let candidates = [
            "../../local-binaries/source-only-v1/programs/wasm32/rootfs.vfs",
            "../../host/wasm/rootfs.vfs",
        ];
        let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
        let Some(path) = path else { eprintln!("skip: no rootfs.vfs"); return; };
        let image = std::fs::read(path).unwrap();
        let fs = KandeloImageFs::mount(unwrap_vfsi(&image).unwrap()).unwrap();
        // Root lists the usual FHS dirs.
        let names: std::collections::BTreeSet<Vec<u8>> =
            fs.read_dir(ROOT_INO).unwrap().into_iter().map(|e| e.name).collect();
        for want in [b"etc".as_slice(), b"usr", b"bin"] {
            assert!(names.iter().any(|n| n.as_slice() == want), "root missing {:?}", want);
        }
        // /etc/passwd resolves and reads non-empty (exercises deeper paths + reads).
        let ino = fs.resolve(b"/etc/passwd", true).unwrap();
        let size = fs.stat_ino(ino).unwrap().size as usize;
        let mut buf = vec![0u8; size];
        let n = fs.read_at(ino, 0, &mut buf).unwrap();
        assert_eq!(n, size);
        assert!(buf.windows(5).any(|w| w == b"root:"), "passwd should contain root:");
    }
}
