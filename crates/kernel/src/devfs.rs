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
    /// /dev/input
    InputDir,
    /// /dev/dri
    DriDir,
}

/// Match a resolved path to a devfs directory entry.
pub fn match_devfs_dir(path: &[u8]) -> Option<DevfsEntry> {
    match path {
        b"/dev" => Some(DevfsEntry::Root),
        b"/dev/pts" => Some(DevfsEntry::PtsDir),
        b"/dev/shm" => Some(DevfsEntry::ShmDir),
        b"/dev/mqueue" => Some(DevfsEntry::MqueueDir),
        b"/dev/fd" => Some(DevfsEntry::FdDir),
        b"/dev/input" => Some(DevfsEntry::InputDir),
        b"/dev/dri" => Some(DevfsEntry::DriDir),
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
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
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
    let ofd_idx = proc
        .ofd_table
        .create(FileType::Directory, status_flags, DEVFS_DIR_HANDLE, path);
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
    crate::procfs::write_virtual_dirents64(buf, offset, devfs_ino(path), 1, &entries)
}

/// Build directory entries for a devfs directory.
fn dir_entries(proc: &crate::process::Process, entry: &DevfsEntry) -> Vec<(Vec<u8>, u8, u64)> {
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
            entries.push((b"fb0".into(), DT_CHR, devfs_ino(b"/dev/fb0")));
            entries.push((b"dsp".into(), DT_CHR, devfs_ino(b"/dev/dsp")));

            // Symlinks
            entries.push((b"stdin".into(), DT_LNK, devfs_ino(b"/dev/stdin")));
            entries.push((b"stdout".into(), DT_LNK, devfs_ino(b"/dev/stdout")));
            entries.push((b"stderr".into(), DT_LNK, devfs_ino(b"/dev/stderr")));

            // Subdirectories
            entries.push((b"fd".into(), DT_DIR, devfs_ino(b"/dev/fd")));
            entries.push((b"pts".into(), DT_DIR, devfs_ino(b"/dev/pts")));
            entries.push((b"shm".into(), DT_DIR, devfs_ino(b"/dev/shm")));
            entries.push((b"mqueue".into(), DT_DIR, devfs_ino(b"/dev/mqueue")));
            entries.push((b"input".into(), DT_DIR, devfs_ino(b"/dev/input")));
            entries.push((b"dri".into(), DT_DIR, devfs_ino(b"/dev/dri")));
        }
        DevfsEntry::InputDir => {
            // /dev/input/mice — Linux-compatible PS/2 mouse stream.
            // No /dev/input/eventN evdev nodes yet (mousedev surface only).
            entries.push((b"mice".into(), DT_CHR, devfs_ino(b"/dev/input/mice")));
        }
        DevfsEntry::DriDir => {
            // /dev/dri/card0 — KMS / display side.
            // /dev/dri/renderD128 — render / GPU side.
            entries.push((b"card0".into(), DT_CHR, devfs_ino(b"/dev/dri/card0")));
            entries.push((
                b"renderD128".into(),
                DT_CHR,
                devfs_ino(b"/dev/dri/renderD128"),
            ));
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

    fn dirent_len(name: &[u8]) -> usize {
        (19 + name.len() + 1 + 7) & !7
    }

    fn decode_dirents(buf: &[u8]) -> Vec<(Vec<u8>, i64)> {
        let mut entries = Vec::new();
        let mut pos = 0usize;
        while pos < buf.len() {
            assert!(buf.len() - pos >= 19, "truncated dirent header at {pos}");
            let d_off = i64::from_le_bytes(buf[pos + 8..pos + 16].try_into().unwrap());
            let reclen = u16::from_le_bytes(buf[pos + 16..pos + 18].try_into().unwrap()) as usize;
            assert!(reclen >= 20, "invalid dirent record length {reclen}");
            assert!(pos + reclen <= buf.len(), "dirent extends past result");
            let name_start = pos + 19;
            let name_end = buf[name_start..pos + reclen]
                .iter()
                .position(|byte| *byte == 0)
                .map(|end| name_start + end)
                .expect("dirent name is not NUL-terminated");
            entries.push((buf[name_start..name_end].to_vec(), d_off));
            pos += reclen;
        }
        entries
    }

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

    #[test]
    fn fb0_is_listed_in_dev_dir() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::Root);
        let names: Vec<&[u8]> = entries.iter().map(|(n, _, _)| n.as_slice()).collect();
        assert!(
            names.iter().any(|n| *n == b"fb0"),
            "fb0 missing from /dev listing: {:?}",
            names
        );
        // Listed as a character device.
        for (name, dtype, _) in entries.iter() {
            if name == b"fb0" {
                assert_eq!(*dtype, DT_CHR);
            }
        }
    }

    #[test]
    fn input_dir_is_listed_under_dev() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::Root);
        let mut found = false;
        for (name, dtype, _) in entries.iter() {
            if name.as_slice() == b"input" {
                assert_eq!(*dtype, DT_DIR);
                found = true;
            }
        }
        assert!(found, "input subdir missing from /dev listing");
    }

    #[test]
    fn dsp_is_listed_in_dev_dir() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::Root);
        let mut found = false;
        for (name, dtype, _) in entries.iter() {
            if name.as_slice() == b"dsp" {
                assert_eq!(*dtype, DT_CHR);
                found = true;
            }
        }
        assert!(found, "dsp missing from /dev listing");
    }

    #[test]
    fn dri_dir_is_listed_under_dev() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::Root);
        let mut found = false;
        for (name, dtype, _) in entries.iter() {
            if name.as_slice() == b"dri" {
                assert_eq!(*dtype, DT_DIR);
                found = true;
            }
        }
        assert!(found, "dri subdir missing from /dev listing");
    }

    #[test]
    fn dri_dir_lists_card0_and_renderd128() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::DriDir);
        let names: Vec<&[u8]> = entries.iter().map(|(n, _, _)| n.as_slice()).collect();
        assert!(names.iter().any(|n| *n == b"card0"));
        assert!(names.iter().any(|n| *n == b"renderD128"));
        for (_, dtype, _) in entries.iter() {
            assert_eq!(*dtype, DT_CHR);
        }
        let st = match_devfs_stat(b"/dev/dri", 0, 0).unwrap();
        assert_eq!(st.st_mode & 0o170000, S_IFDIR);
    }

    #[test]
    fn mice_is_listed_in_dev_input_dir() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::InputDir);
        let mut found = false;
        for (name, dtype, _) in entries.iter() {
            if name.as_slice() == b"mice" {
                assert_eq!(*dtype, DT_CHR);
                found = true;
            }
        }
        assert!(found, "mice missing from /dev/input listing");
        // /dev/input itself stats as a directory.
        let st = match_devfs_stat(b"/dev/input", 0, 0).unwrap();
        assert_eq!(st.st_mode & 0o170000, S_IFDIR);
    }

    #[test]
    fn devfs_getdents64_retries_one_byte_short_synthetic_entry_at_exact_cookie() {
        let proc = crate::process::Process::new(1);
        let dot_len = dirent_len(b".");
        let mut too_short = vec![0u8; dot_len - 1];

        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut too_short, 0),
            Err(Errno::EINVAL)
        );

        let mut exact = vec![0u8; dot_len];
        let (bytes, cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut exact, 0).unwrap();
        assert_eq!(bytes, dot_len);
        assert_eq!(cookie, 1);
        assert!(!exhausted);
        assert_eq!(decode_dirents(&exact[..bytes]), vec![(b".".to_vec(), 1)]);

        // A too-small call that starts at `..` is also an error, and a retry
        // from the unchanged cookie returns that exact record.
        let dotdot_len = dirent_len(b"..");
        let mut too_short = vec![0u8; dotdot_len - 1];
        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut too_short, cookie),
            Err(Errno::EINVAL)
        );

        let mut exact = vec![0u8; dotdot_len];
        let (bytes, cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut exact, cookie).unwrap();
        assert_eq!(bytes, dotdot_len);
        assert_eq!(cookie, 2);
        assert!(!exhausted);
        assert_eq!(decode_dirents(&exact[..bytes]), vec![(b"..".to_vec(), 2)]);
    }

    #[test]
    fn devfs_getdents64_retries_one_byte_short_real_entry_at_exact_cookie() {
        let proc = crate::process::Process::new(1);
        let null_len = dirent_len(b"null");
        let mut too_short = vec![0u8; null_len - 1];

        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut too_short, 2),
            Err(Errno::EINVAL)
        );

        let mut exact = vec![0u8; null_len];
        let (bytes, cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut exact, 2).unwrap();
        assert_eq!(bytes, null_len);
        assert_eq!(cookie, 3);
        assert!(!exhausted);
        assert_eq!(
            decode_dirents(&exact[..bytes]),
            vec![(b"null".to_vec(), 3)]
        );
    }

    #[test]
    fn devfs_getdents64_returns_a_short_prefix_and_resumes_without_loss() {
        let proc = crate::process::Process::new(1);
        let mut full_buf = [0u8; 4096];
        let (full_bytes, end_cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut full_buf, 0).unwrap();
        assert!(exhausted);
        let expected = decode_dirents(&full_buf[..full_bytes]);

        // Fit `.`, `..`, and `null`, then leave the buffer one byte short of
        // `zero`. Complete records are a valid short read and must be kept.
        let prefix_len = dirent_len(b".") + dirent_len(b"..") + dirent_len(b"null");
        let mut prefix_buf = vec![0u8; prefix_len + dirent_len(b"zero") - 1];
        let (prefix_bytes, resume_cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut prefix_buf, 0).unwrap();
        assert_eq!(prefix_bytes, prefix_len);
        assert_eq!(resume_cookie, 3);
        assert!(!exhausted);

        let mut suffix_buf = [0u8; 4096];
        let (suffix_bytes, resumed_end, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut suffix_buf, resume_cookie).unwrap();
        assert!(exhausted);
        assert_eq!(resumed_end, end_cookie);

        let mut resumed = decode_dirents(&prefix_buf[..prefix_bytes]);
        resumed.extend(decode_dirents(&suffix_buf[..suffix_bytes]));
        assert_eq!(resumed, expected);
        assert_eq!(
            resumed.iter().map(|(_, d_off)| *d_off).collect::<Vec<_>>(),
            (1..=end_cookie).collect::<Vec<_>>()
        );
    }

    #[test]
    fn devfs_getdents64_exact_last_entry_and_eof_preserve_cookies() {
        let proc = crate::process::Process::new(1);
        let entries = dir_entries(&proc, &DevfsEntry::Root);
        let end_cookie = i64::try_from(entries.len()).unwrap() + 2;
        let last_name = entries.last().unwrap().0.clone();
        let mut exact = vec![0u8; dirent_len(&last_name)];

        let (bytes, cookie, exhausted) =
            devfs_getdents64(&proc, b"/dev", &mut exact, end_cookie - 1).unwrap();
        assert_eq!(bytes, exact.len());
        assert_eq!(cookie, end_cookie);
        assert!(exhausted);
        assert_eq!(
            decode_dirents(&exact[..bytes]),
            vec![(last_name, end_cookie)]
        );

        let mut empty = [];
        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut empty, end_cookie),
            Ok((0, end_cookie, true))
        );
        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut empty, i64::MAX),
            Ok((0, i64::MAX, true))
        );
        assert_eq!(
            devfs_getdents64(&proc, b"/dev", &mut empty, -1),
            Err(Errno::EINVAL)
        );
    }
}
