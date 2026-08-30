//! Read-only parser for the on-disk SFFS ("SharedFileSystem") image and its
//! VFSI container. Ported from host/src/vfs/sharedfs-vendor.ts. no_std + alloc.
//! Consumes DECOMPRESSED bytes (zstd is a host-side transport codec).

use wasm_posix_shared::Errno; // same import syscalls.rs uses

const VFSI_MAGIC: u32 = 0x5646_5349; // "VFSI" LE
const VFSI_VERSION: u32 = 1;
const VFSI_HEADER: usize = 16;

pub(crate) fn r32(b: &[u8], off: usize) -> Option<u32> {
    let e = off.checked_add(4)?;
    if e > b.len() { return None; }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

// Unused until later tasks in the SFFS-reader migration parse 64-bit fields
// (offsets/lengths in the superblock and inode table).
#[allow(dead_code)]
pub(crate) fn r64(b: &[u8], off: usize) -> Option<u64> {
    let e = off.checked_add(8)?;
    if e > b.len() { return None; }
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[off..e]);
    Some(u64::from_le_bytes(a))
}

pub fn unwrap_vfsi(image: &[u8]) -> Result<&[u8], Errno> {
    if r32(image, 0) != Some(VFSI_MAGIC) { return Err(Errno::EINVAL); }
    if r32(image, 4) != Some(VFSI_VERSION) { return Err(Errno::EINVAL); }
    let sab_len = r32(image, 12).ok_or(Errno::EINVAL)? as usize;
    let end = VFSI_HEADER.checked_add(sab_len).ok_or(Errno::EINVAL)?;
    if end > image.len() { return Err(Errno::EINVAL); }
    Ok(&image[VFSI_HEADER..end])
}

const SFFS_MAGIC: u32 = 0x5346_4653; // "SFFS"
const SFFS_VERSION: u32 = 1;
pub(crate) const BLOCK_SIZE: usize = 4096;
const SB_INODE_TABLE_START: usize = 36;

pub struct Sffs<'a> {
    // Unused until later tasks read file/inode data through this handle.
    #[allow(dead_code)]
    bytes: &'a [u8],
    pub(crate) inode_table_start: u32,
}

impl<'a> Sffs<'a> {
    pub fn mount(bytes: &'a [u8]) -> Result<Sffs<'a>, Errno> {
        if r32(bytes, 0) != Some(SFFS_MAGIC) { return Err(Errno::EINVAL); }
        if r32(bytes, 4) != Some(SFFS_VERSION) { return Err(Errno::EINVAL); }
        if r32(bytes, 8) != Some(BLOCK_SIZE as u32) { return Err(Errno::EINVAL); }
        let inode_table_start = r32(bytes, SB_INODE_TABLE_START).ok_or(Errno::EINVAL)?;
        Ok(Sffs { bytes, inode_table_start })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TINY_VFS: &[u8] = include_bytes!("testdata/tiny.vfs");

    #[test]
    fn unwrap_vfsi_returns_sffs_with_valid_magic() {
        let sffs = unwrap_vfsi(TINY_VFS).expect("VFSI unwrap");
        // Inner SFFS superblock magic "SFFS" (0x53464653) at byte 0, LE.
        assert_eq!(r32(sffs, 0), Some(0x5346_4653));
    }

    #[test]
    fn unwrap_vfsi_rejects_bad_magic() {
        let mut bad = TINY_VFS.to_vec();
        bad[0] ^= 0xff;
        assert!(unwrap_vfsi(&bad).is_err());
    }

    #[test]
    fn mount_validates_superblock() {
        let sffs = unwrap_vfsi(TINY_VFS).unwrap();
        let fs = Sffs::mount(sffs).expect("mount");
        assert!(fs.inode_table_start >= 1);
    }

    #[test]
    fn mount_rejects_wrong_block_size() {
        let mut bad = unwrap_vfsi(TINY_VFS).unwrap().to_vec();
        bad[8] = 0; bad[9] = 0; bad[10] = 0; bad[11] = 0; // BLOCK_SIZE=0
        assert!(Sffs::mount(&bad).is_err());
    }
}
