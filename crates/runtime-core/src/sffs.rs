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

pub const ROOT_INO: u32 = 1;
const INODES_PER_BLOCK: u32 = 32;
const INODE_SIZE: usize = 128;
const INO_MODE: usize = 8;
const INO_LINK_COUNT: usize = 12;
const INO_SIZE: usize = 16;
const INO_MTIME: usize = 24;
const INO_CTIME: usize = 32;
const INO_ATIME: usize = 40;
const INO_UID: usize = 96;
const INO_GID: usize = 100;
const INO_GENERATION: usize = 104;

pub struct SffsStat {
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

pub struct Sffs<'a> {
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

    fn inode_offset(&self, ino: u32) -> usize {
        let block = self.inode_table_start + ino / INODES_PER_BLOCK;
        block as usize * BLOCK_SIZE + (ino % INODES_PER_BLOCK) as usize * INODE_SIZE
    }

    pub fn stat_ino(&self, ino: u32) -> Result<SffsStat, Errno> {
        if ino == 0 { return Err(Errno::ENOENT); }
        let o = self.inode_offset(ino);
        let mode = r32(self.bytes, o + INO_MODE).ok_or(Errno::EIO)?;
        let nlink = r32(self.bytes, o + INO_LINK_COUNT).ok_or(Errno::EIO)?;
        if nlink == 0 { return Err(Errno::ENOENT); } // free/orphaned slot
        Ok(SffsStat {
            ino,
            mode,
            nlink,
            size: r64(self.bytes, o + INO_SIZE).ok_or(Errno::EIO)?,
            mtime_ms: r64(self.bytes, o + INO_MTIME).ok_or(Errno::EIO)?,
            ctime_ms: r64(self.bytes, o + INO_CTIME).ok_or(Errno::EIO)?,
            atime_ms: r64(self.bytes, o + INO_ATIME).ok_or(Errno::EIO)?,
            uid: r32(self.bytes, o + INO_UID).ok_or(Errno::EIO)?,
            gid: r32(self.bytes, o + INO_GID).ok_or(Errno::EIO)?,
            generation: r64(self.bytes, o + INO_GENERATION).ok_or(Errno::EIO)?,
        })
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

    #[test]
    fn root_inode_is_a_directory() {
        let fs = Sffs::mount(unwrap_vfsi(TINY_VFS).unwrap()).unwrap();
        let st = fs.stat_ino(ROOT_INO).unwrap();
        assert_eq!(st.mode & 0xf000, 0x4000, "root is S_IFDIR");
        assert!(st.nlink >= 2, "dir has >= 2 links (. and ..)");
    }
}
