//! Devfs implementation — synthetic /dev filesystem.
//!
//! Device files are handled as special-case opens in sys_open (match_virtual_device,
//! match_dev_fd, PTY paths). This module adds directory listing support so that
//! `ls /dev` and `ls /dev/pts` work by synthesizing getdents64 entries for all
//! known device nodes.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::mode::S_IFDIR;
use wasm_posix_shared::{Errno, WasmStat};

/// Sentinel host_handle for devfs directory OFDs.
pub const DEVFS_DIR_HANDLE: i64 = -160;

const DT_DIR: u8 = 4;
const DT_CHR: u8 = 2;
const DT_LNK: u8 = 10;

/// Devfs directory entries that can be listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevfsEntry {
    /// /dev
    Root,
    /// /dev/pts
    PtsDir,
    /// /dev/shm
    ShmDir,
    /// /dev/mqueue
    MqueueDir,
    /// /dev/fd
    FdDir,
}

/// Match a resolved path to a devfs directory entry.
pub fn match_devfs_dir(path: &[u8]) -> Option<DevfsEntry> {
    match path {
        b"/dev" => Some(DevfsEntry::Root),
        b"/dev/pts" => Some(DevfsEntry::PtsDir),
        b"/dev/shm" => Some(DevfsEntry::ShmDir),
        b"/dev/mqueue" => Some(DevfsEntry::MqueueDir),
        b"/dev/fd" => Some(DevfsEntry::FdDir),
        _ => None,
    }
}

/// Match a resolved path to any devfs entry (directory or file) for stat purposes.
pub fn match_devfs_stat(path: &[u8], uid: u32, gid: u32) -> Option<WasmStat> {
    if let Some(_entry) = match_devfs_dir(path) {
        return Some(WasmStat {
            st_dev: 6,
            st_ino: devfs_ino(path),
            st_mode: S_IFDIR | 0o755,
            st_nlink: 2,
            st_uid: uid,
            st_gid: gid,
            st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        });
    }
    None
}

/// Open a devfs directory, creating an OFD with the sentinel handle.
/// Returns the new fd number.
pub fn devfs_open_dir(
    proc: &mut crate::process::Process,
    path: Vec<u8>,
    oflags: u32,
) -> Result<i32, Errno> {
    use crate::fd::OpenFileDescRef;
    use crate::ofd::FileType;

    let creation_flags = 0o100 | 0o200 | 0o1000; // O_CREAT | O_EXCL | O_TRUNC
    let status_flags = oflags & !creation_flags;
    let ofd_idx = proc.ofd_table.create(
        FileType::Directory,
        status_flags,
        DEVFS_DIR_HANDLE,
        path,
    );
    if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
        ofd.dir_host_handle = DEVFS_DIR_HANDLE;
    }
    let fd_flags = if oflags & 0o2000000 != 0 { 1 } else { 0 }; // O_CLOEXEC -> FD_CLOEXEC
    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
    Ok(fd)
}

/// Generate getdents64 entries for a devfs directory.
/// Returns (bytes_written, new_offset, exhausted).
pub fn devfs_getdents64(
    proc: &crate::process::Process,
    path: &[u8],
    buf: &mut [u8],
    offset: i64,
) -> Result<(usize, i64, bool), Errno> {
    let entry = match_devfs_dir(path).ok_or(Errno::ENOENT)?;
    let entries = dir_entries(proc, &entry);

    let start = offset as usize;
    let mut pos = 0usize;
    let mut current = start;

    // Emit . and ..
    if current == 0 {
        let written = crate::procfs::write_dirent64(buf, pos, devfs_ino(path), 1, DT_DIR, b".");
        if written == 0 {
            if pos == 0 { return Err(Errno::EINVAL); }
            return Ok((pos, current as i64, false));
        }
        pos += written;
        current = 1;
    }
    if current == 1 {
        let written = crate::procfs::write_dirent64(buf, pos, 1, 2, DT_DIR, b"..");
        if written == 0 {
            return Ok((pos, current as i64, false));
        }
        pos += written;
        current = 2;
    }

    // Emit directory-specific entries
    let entry_start = current - 2;
    for (i, (name, d_type, ino)) in entries.iter().enumerate().skip(entry_start) {
        let d_off = (i + 3) as i64;
        let written = crate::procfs::write_dirent64(buf, pos, *ino, d_off, *d_type, name);
        if written == 0 {
            return Ok((pos, (i + 2) as i64, false));
        }
        pos += written;
        current = i + 3;
    }

    Ok((pos, current as i64, true))
}

/// Build directory entries for a devfs directory.
fn dir_entries(
    proc: &crate::process::Process,
    entry: &DevfsEntry,
) -> Vec<(Vec<u8>, u8, u64)> {
    let mut entries = Vec::new();

    match entry {
        DevfsEntry::Root => {
            // Character devices
            entries.push((b"null".into(), DT_CHR, devfs_ino(b"/dev/null")));
            entries.push((b"zero".into(), DT_CHR, devfs_ino(b"/dev/zero")));
            entries.push((b"full".into(), DT_CHR, devfs_ino(b"/dev/full")));
            entries.push((b"random".into(), DT_CHR, devfs_ino(b"/dev/random")));
            entries.push((b"urandom".into(), DT_CHR, devfs_ino(b"/dev/urandom")));
            entries.push((b"tty".into(), DT_CHR, devfs_ino(b"/dev/tty")));
            entries.push((b"console".into(), DT_CHR, devfs_ino(b"/dev/console")));
            entries.push((b"ptmx".into(), DT_CHR, devfs_ino(b"/dev/ptmx")));

            // Symlinks
            entries.push((b"stdin".into(), DT_LNK, devfs_ino(b"/dev/stdin")));
            entries.push((b"stdout".into(), DT_LNK, devfs_ino(b"/dev/stdout")));
            entries.push((b"stderr".into(), DT_LNK, devfs_ino(b"/dev/stderr")));

            // Subdirectories
            entries.push((b"fd".into(), DT_DIR, devfs_ino(b"/dev/fd")));
            entries.push((b"pts".into(), DT_DIR, devfs_ino(b"/dev/pts")));
            entries.push((b"shm".into(), DT_DIR, devfs_ino(b"/dev/shm")));
            entries.push((b"mqueue".into(), DT_DIR, devfs_ino(b"/dev/mqueue")));
        }
        DevfsEntry::PtsDir => {
            // List active PTY slaves
            for i in 0..crate::pty::MAX_PTYS {
                if let Some(pty) = crate::pty::get_pty(i) {
                    if pty.slave_refs > 0 || pty.master_refs > 0 {
                        let name = alloc::format!("{}", i).into_bytes();
                        entries.push((name, DT_CHR, devfs_ino(b"/dev/pts/0") + i as u64));
                    }
                }
            }
        }
        DevfsEntry::FdDir => {
            // List open file descriptors for this process
            for fd in 0..1024i32 {
                if proc.fd_table.get(fd).is_ok() {
                    let name = alloc::format!("{}", fd).into_bytes();
                    entries.push((name, DT_LNK, 0xDE0FD000 + fd as u64));
                }
            }
        }
        DevfsEntry::ShmDir | DevfsEntry::MqueueDir => {
            // Empty directories for now
        }
    }

    entries
}

/// Compute a stable inode number from a device path.
fn devfs_ino(path: &[u8]) -> u64 {
    // Simple hash to generate unique inodes
    let mut h: u64 = 0xDE0100;
    for &b in path {
        h = h.wrapping_mul(31).wrapping_add(b as u64);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_match_devfs_dir() {
        assert_eq!(match_devfs_dir(b"/dev"), Some(DevfsEntry::Root));
        assert_eq!(match_devfs_dir(b"/dev/pts"), Some(DevfsEntry::PtsDir));
        assert_eq!(match_devfs_dir(b"/dev/shm"), Some(DevfsEntry::ShmDir));
        assert_eq!(match_devfs_dir(b"/dev/mqueue"), Some(DevfsEntry::MqueueDir));
        assert_eq!(match_devfs_dir(b"/dev/fd"), Some(DevfsEntry::FdDir));
        assert_eq!(match_devfs_dir(b"/dev/null"), None);
        assert_eq!(match_devfs_dir(b"/tmp"), None);
    }

    #[test]
    fn test_match_devfs_stat() {
        let st = match_devfs_stat(b"/dev", 0, 0).unwrap();
        assert_eq!(st.st_mode & 0o170000, S_IFDIR);
        assert_eq!(st.st_mode & 0o777, 0o755);

        let st = match_devfs_stat(b"/dev/pts", 1000, 1000).unwrap();
        assert_eq!(st.st_uid, 1000);
        assert_eq!(st.st_mode & 0o170000, S_IFDIR);

        assert!(match_devfs_stat(b"/dev/null", 0, 0).is_none());
    }

    #[test]
    fn test_devfs_ino_uniqueness() {
        let ino1 = devfs_ino(b"/dev/null");
        let ino2 = devfs_ino(b"/dev/zero");
        let ino3 = devfs_ino(b"/dev/urandom");
        assert_ne!(ino1, ino2);
        assert_ne!(ino2, ino3);
        assert_ne!(ino1, ino3);
    }
}
