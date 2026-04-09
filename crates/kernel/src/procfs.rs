//! Procfs implementation — synthetic /proc filesystem.
//!
//! All proc data lives in the kernel (ProcessTable, FdTable, OfdTable,
//! MemoryManager), so procfs is implemented entirely in Rust. Path matching,
//! content generation, stat synthesis, and directory iteration are handled here.
//! Syscall functions in syscalls.rs call into procfs:: at the same points they
//! check for virtual devices and synthetic files.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK, S_IFREG};
use wasm_posix_shared::{Errno, WasmStat};

use crate::process::Process;

/// Sentinel host_handle for procfs directory OFDs.
pub const PROCFS_DIR_HANDLE: i64 = -150;

/// Sentinel host_handle base for procfs content buffers.
/// Actual handle = -(PROCFS_BUF_BASE + buf_idx).
pub const PROCFS_BUF_BASE: i64 = 200;

/// Check if a host_handle is a procfs buffer handle.
#[inline]
pub fn is_procfs_buf_handle(h: i64) -> bool {
    h <= -PROCFS_BUF_BASE
}

/// Decode a procfs buffer index from a host_handle.
#[inline]
pub fn procfs_buf_idx(h: i64) -> usize {
    (-(h + PROCFS_BUF_BASE)) as usize
}

/// Encode a procfs buffer index as a host_handle.
#[inline]
fn procfs_buf_handle(idx: usize) -> i64 {
    -(PROCFS_BUF_BASE + idx as i64)
}

// ── Entry types ─────────────────────────────────────────────────────────────

/// A parsed procfs path entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcfsEntry {
    Root,                    // /proc
    SelfLink,               // /proc/self (symlink → /proc/<pid>)
    ThreadSelfLink,         // /proc/thread-self (symlink)
    PidDir(u32),             // /proc/<pid>
    FdDir(u32),              // /proc/<pid>/fd
    FdLink(u32, i32),        // /proc/<pid>/fd/<N> (symlink)
    FdInfoDir(u32),          // /proc/<pid>/fdinfo
    FdInfo(u32, i32),        // /proc/<pid>/fdinfo/<N>
    Stat(u32),               // /proc/<pid>/stat
    Status(u32),             // /proc/<pid>/status
    Cmdline(u32),            // /proc/<pid>/cmdline
    Environ(u32),            // /proc/<pid>/environ
    Maps(u32),               // /proc/<pid>/maps
    Cwd(u32),                // /proc/<pid>/cwd (symlink)
    Exe(u32),                // /proc/<pid>/exe (symlink)
    Root_(u32),              // /proc/<pid>/root (symlink)
    NetDir,                  // /proc/net
    NetTcp,                  // /proc/net/tcp
    NetUnix,                 // /proc/net/unix
}

impl ProcfsEntry {
    /// Is this entry a symlink?
    pub fn is_symlink(&self) -> bool {
        matches!(
            self,
            ProcfsEntry::SelfLink
                | ProcfsEntry::ThreadSelfLink
                | ProcfsEntry::FdLink(_, _)
                | ProcfsEntry::Cwd(_)
                | ProcfsEntry::Exe(_)
                | ProcfsEntry::Root_(_)
        )
    }

    /// Is this entry a directory?
    pub fn is_dir(&self) -> bool {
        matches!(
            self,
            ProcfsEntry::Root
                | ProcfsEntry::PidDir(_)
                | ProcfsEntry::FdDir(_)
                | ProcfsEntry::FdInfoDir(_)
                | ProcfsEntry::NetDir
        )
    }
}

/// Extract the pid from a ProcfsEntry (0 for root/net entries).
pub fn entry_pid(entry: &ProcfsEntry) -> u32 {
    entry_ids(entry).0
}

// ── Path matching ───────────────────────────────────────────────────────────

/// Parse an ASCII byte slice as a u32.
fn parse_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() {
        return None;
    }
    let mut val: u32 = 0;
    for &b in bytes {
        if b < b'0' || b > b'9' {
            return None;
        }
        val = val.checked_mul(10)?.checked_add((b - b'0') as u32)?;
    }
    Some(val)
}

/// Parse an ASCII byte slice as an i32.
fn parse_i32(bytes: &[u8]) -> Option<i32> {
    parse_u32(bytes).map(|v| v as i32)
}

/// Match a resolved absolute path against procfs entries.
/// Resolves `/proc/self/...` → `/proc/<current_pid>/...`.
pub fn match_procfs(path: &[u8], current_pid: u32) -> Option<ProcfsEntry> {
    if !path.starts_with(b"/proc") {
        return None;
    }

    let rest = &path[5..]; // after "/proc"

    // /proc or /proc/
    if rest.is_empty() || rest == b"/" {
        return Some(ProcfsEntry::Root);
    }

    // Must have a leading /
    if rest[0] != b'/' {
        return None;
    }
    let rest = &rest[1..]; // after "/proc/"

    // /proc/self/... → resolve to current pid
    // /proc/thread-self/... → resolve to current pid (simplified)
    let (pid, remainder) = if rest.starts_with(b"self") {
        let after = &rest[4..];
        if after.is_empty() {
            return Some(ProcfsEntry::SelfLink);
        }
        if after[0] != b'/' {
            // e.g. /proc/selfxyz — not a match, try numeric
            match_pid_path(rest)
        } else {
            (current_pid, &after[1..])
        }
    } else if rest.starts_with(b"thread-self") {
        let after = &rest[11..];
        if after.is_empty() {
            return Some(ProcfsEntry::ThreadSelfLink);
        }
        if after[0] != b'/' {
            match_pid_path(rest)
        } else {
            (current_pid, &after[1..])
        }
    } else if rest == b"net" || rest.starts_with(b"net/") {
        return match_net_path(rest);
    } else {
        match_pid_path(rest)
    };

    // Now parse remainder under /proc/<pid>/
    match_pid_subpath(pid, remainder)
}

/// Parse `/proc/<pid>[/...]` — returns (pid, remainder after pid/).
fn match_pid_path(rest: &[u8]) -> (u32, &[u8]) {
    // Find end of numeric pid
    let end = rest.iter().position(|&b| b == b'/').unwrap_or(rest.len());
    let pid_bytes = &rest[..end];
    if let Some(pid) = parse_u32(pid_bytes) {
        let remainder = if end < rest.len() { &rest[end + 1..] } else { b"" };
        (pid, remainder)
    } else {
        // Not a valid pid — return sentinel that won't match anything
        (u32::MAX, b"")
    }
}

/// Match paths under /proc/<pid>/.
fn match_pid_subpath(pid: u32, remainder: &[u8]) -> Option<ProcfsEntry> {
    if pid == u32::MAX {
        return None;
    }
    if remainder.is_empty() {
        return Some(ProcfsEntry::PidDir(pid));
    }

    // Strip trailing slash
    let rem = if remainder.ends_with(b"/") && remainder.len() > 1 {
        &remainder[..remainder.len() - 1]
    } else {
        remainder
    };

    match rem {
        b"stat" => Some(ProcfsEntry::Stat(pid)),
        b"status" => Some(ProcfsEntry::Status(pid)),
        b"cmdline" => Some(ProcfsEntry::Cmdline(pid)),
        b"environ" => Some(ProcfsEntry::Environ(pid)),
        b"maps" => Some(ProcfsEntry::Maps(pid)),
        b"cwd" => Some(ProcfsEntry::Cwd(pid)),
        b"exe" => Some(ProcfsEntry::Exe(pid)),
        b"root" => Some(ProcfsEntry::Root_(pid)),
        b"fd" => Some(ProcfsEntry::FdDir(pid)),
        b"fdinfo" => Some(ProcfsEntry::FdInfoDir(pid)),
        _ => {
            if rem.starts_with(b"fd/") {
                let fd_str = &rem[3..];
                parse_i32(fd_str).map(|fd| ProcfsEntry::FdLink(pid, fd))
            } else if rem.starts_with(b"fdinfo/") {
                let fd_str = &rem[7..];
                parse_i32(fd_str).map(|fd| ProcfsEntry::FdInfo(pid, fd))
            } else if rem == b"net" || rem.starts_with(b"net/") {
                match_net_path(rem)
            } else {
                None
            }
        }
    }
}

/// Match /proc/net/* paths.
fn match_net_path(rest: &[u8]) -> Option<ProcfsEntry> {
    if rest == b"net" || rest == b"net/" {
        return Some(ProcfsEntry::NetDir);
    }
    if rest.starts_with(b"net/") {
        match &rest[4..] {
            b"tcp" => return Some(ProcfsEntry::NetTcp),
            b"unix" => return Some(ProcfsEntry::NetUnix),
            _ => return None,
        }
    }
    None
}

// ── Content generators ──────────────────────────────────────────────────────

/// Generate /proc/<pid>/stat content.
pub fn generate_stat(proc: &Process) -> Vec<u8> {
    use alloc::format;

    let name = process_name(proc);
    let state = if proc.state == crate::process::ProcessState::Running {
        'R'
    } else {
        'Z'
    };

    // Linux /proc/pid/stat format (simplified):
    // pid (comm) state ppid pgrp session tty_nr tpgid flags
    // minflt cminflt majflt cmajflt utime stime cutime cstime
    // priority nice num_threads itrealvalue starttime vsize rss ...
    let line = format!(
        "{} ({}) {} {} {} {} 0 0 0 0 0 0 0 0 0 0 {} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
        proc.pid,
        name,
        state,
        proc.ppid,
        proc.pgid,
        proc.sid,
        proc.nice,
    );
    line.into_bytes()
}

/// Generate /proc/<pid>/status content.
pub fn generate_status(proc: &Process) -> Vec<u8> {
    use alloc::format;

    let name = process_name(proc);

    let state_str = if proc.state == crate::process::ProcessState::Running {
        "R (running)"
    } else {
        "Z (zombie)"
    };

    let content = format!(
        "Name:\t{}\n\
         Umask:\t{:04o}\n\
         State:\t{}\n\
         Tgid:\t{}\n\
         Ngid:\t0\n\
         Pid:\t{}\n\
         PPid:\t{}\n\
         TracerPid:\t0\n\
         Uid:\t{}\t{}\t{}\t{}\n\
         Gid:\t{}\t{}\t{}\t{}\n\
         FDSize:\t{}\n\
         VmSize:\t0 kB\n\
         Threads:\t{}\n\
         SigPnd:\t{:016x}\n\
         SigBlk:\t{:016x}\n",
        name,
        proc.umask,
        state_str,
        proc.pid,
        proc.pid,
        proc.ppid,
        proc.uid, proc.euid, proc.euid, proc.euid,
        proc.gid, proc.egid, proc.egid, proc.egid,
        count_open_fds(&proc.fd_table),
        1 + proc.threads.len(), // main thread + spawned threads
        proc.signals.pending_mask(),
        proc.signals.blocked,
    );
    content.into_bytes()
}

/// Generate /proc/<pid>/cmdline content (null-separated argv).
pub fn generate_cmdline(proc: &Process) -> Vec<u8> {
    let mut buf = Vec::new();
    for (i, arg) in proc.argv.iter().enumerate() {
        buf.extend_from_slice(arg);
        if i + 1 < proc.argv.len() {
            buf.push(0);
        }
    }
    if !buf.is_empty() {
        buf.push(0); // trailing NUL
    }
    buf
}

/// Generate /proc/<pid>/environ content (null-separated environ).
pub fn generate_environ(proc: &Process) -> Vec<u8> {
    let mut buf = Vec::new();
    for var in &proc.environ {
        buf.extend_from_slice(var);
        buf.push(0);
    }
    buf
}

/// Generate /proc/<pid>/maps content.
pub fn generate_maps(proc: &Process) -> Vec<u8> {
    use alloc::format;

    let mut buf = Vec::new();
    for region in proc.memory.mappings() {
        let start = region.addr as u64;
        let end = start + region.len as u64;
        let r = if region.prot & 1 != 0 { 'r' } else { '-' }; // PROT_READ
        let w = if region.prot & 2 != 0 { 'w' } else { '-' }; // PROT_WRITE
        let x = if region.prot & 4 != 0 { 'x' } else { '-' }; // PROT_EXEC
        let p = if region.flags & 2 != 0 { 's' } else { 'p' }; // MAP_SHARED vs MAP_PRIVATE
        let line = format!(
            "{:08x}-{:08x} {}{}{}{} 00000000 00:00 0\n",
            start, end, r, w, x, p,
        );
        buf.extend_from_slice(line.as_bytes());
    }
    buf
}

/// Generate /proc/<pid>/fdinfo/<fd> content.
pub fn generate_fdinfo(proc: &Process, fd: i32) -> Option<Vec<u8>> {
    use alloc::format;

    let entry = proc.fd_table.get(fd).ok()?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0)?;
    let content = format!(
        "pos:\t{}\nflags:\t{:o}\nmnt_id:\t0\n",
        ofd.offset, ofd.status_flags,
    );
    Some(content.into_bytes())
}

/// Generate /proc/net/tcp content header (simplified).
/// Content can be extended by passing socket info from the process table.
pub fn generate_net_tcp_header() -> Vec<u8> {
    b"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n".to_vec()
}

/// Generate /proc/net/unix content header (simplified).
pub fn generate_net_unix_header() -> Vec<u8> {
    b"Num       RefCount Protocol Flags    Type St Inode Path\n".to_vec()
}

// ── Stat synthesis ──────────────────────────────────────────────────────────

/// Synthetic inode for procfs entries.
fn procfs_ino(pid: u32, entry_type: u8) -> u64 {
    0x50_00_0000u64 | ((pid as u64) << 8) | (entry_type as u64)
}

/// Build a synthetic WasmStat for a procfs entry.
/// `content_size` is used for regular file st_size (pass 0 for dirs/symlinks).
pub fn procfs_stat(entry: &ProcfsEntry, content_size: u64, follow_symlinks: bool) -> WasmStat {
    if entry.is_symlink() && !follow_symlinks {
        let (pid, etype) = entry_ids(entry);
        return WasmStat {
            st_dev: 0x50,
            st_ino: procfs_ino(pid, etype),
            st_mode: S_IFLNK | 0o777,
            st_nlink: 1,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        };
    }

    if entry.is_dir() {
        let (pid, etype) = entry_ids(entry);
        return WasmStat {
            st_dev: 0x50,
            st_ino: procfs_ino(pid, etype),
            st_mode: S_IFDIR | 0o555,
            st_nlink: 2,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        };
    }

    // Regular file
    let (pid, etype) = entry_ids(entry);
    WasmStat {
        st_dev: 0x50,
        st_ino: procfs_ino(pid, etype),
        st_mode: S_IFREG | 0o444,
        st_nlink: 1,
        st_uid: 0,
        st_gid: 0,
        st_size: content_size,
        st_atime_sec: 0, st_atime_nsec: 0,
        st_mtime_sec: 0, st_mtime_nsec: 0,
        st_ctime_sec: 0, st_ctime_nsec: 0,
        _pad: 0,
    }
}

/// Extract (pid, entry_type_id) for inode generation.
fn entry_ids(entry: &ProcfsEntry) -> (u32, u8) {
    match entry {
        ProcfsEntry::Root => (0, 0),
        ProcfsEntry::SelfLink => (0, 1),
        ProcfsEntry::ThreadSelfLink => (0, 2),
        ProcfsEntry::PidDir(pid) => (*pid, 3),
        ProcfsEntry::FdDir(pid) => (*pid, 4),
        ProcfsEntry::FdLink(pid, _) => (*pid, 5),
        ProcfsEntry::FdInfoDir(pid) => (*pid, 6),
        ProcfsEntry::FdInfo(pid, _) => (*pid, 7),
        ProcfsEntry::Stat(pid) => (*pid, 8),
        ProcfsEntry::Status(pid) => (*pid, 9),
        ProcfsEntry::Cmdline(pid) => (*pid, 10),
        ProcfsEntry::Environ(pid) => (*pid, 11),
        ProcfsEntry::Maps(pid) => (*pid, 12),
        ProcfsEntry::Cwd(pid) => (*pid, 13),
        ProcfsEntry::Exe(pid) => (*pid, 14),
        ProcfsEntry::Root_(pid) => (*pid, 15),
        ProcfsEntry::NetDir => (0, 16),
        ProcfsEntry::NetTcp => (0, 17),
        ProcfsEntry::NetUnix => (0, 18),
    }
}

// ── Open handler ────────────────────────────────────────────────────────────

/// Open a procfs entry. Returns the fd number on success.
///
/// - Regular files: generates content snapshot → stores in proc.procfs_bufs
/// - Directories: creates OFD with PROCFS_DIR_HANDLE
/// - Symlinks: returns ELOOP (caller should follow the link)
pub fn procfs_open(
    proc: &mut Process,
    entry: &ProcfsEntry,
    resolved_path: Vec<u8>,
    oflags: u32,
) -> Result<i32, Errno> {
    use crate::fd::OpenFileDescRef;
    use crate::ofd::FileType;
    use wasm_posix_shared::flags::{O_WRONLY, O_RDWR, O_CLOEXEC, O_CLOFORK, O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY, O_NOFOLLOW};
    use wasm_posix_shared::fd_flags::{FD_CLOEXEC, FD_CLOFORK};

    // Procfs is read-only
    if oflags & (O_WRONLY | O_RDWR) != 0 {
        return Err(Errno::EACCES);
    }

    let creation_flags = O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_CLOFORK | O_DIRECTORY | O_NOFOLLOW;
    let status_flags = oflags & !creation_flags;
    let mut fd_flags = 0u32;
    if oflags & O_CLOEXEC != 0 { fd_flags |= FD_CLOEXEC; }
    if oflags & O_CLOFORK != 0 { fd_flags |= FD_CLOFORK; }

    if entry.is_symlink() {
        // Opening a symlink with O_NOFOLLOW should fail with ELOOP.
        // Otherwise the caller (sys_open) should have followed the link.
        if oflags & O_NOFOLLOW != 0 {
            return Err(Errno::ELOOP);
        }
        // Follow the symlink — let caller handle
        return Err(Errno::ELOOP);
    }

    if entry.is_dir() {
        // Validate that the target pid exists for pid-scoped directories
        let target_pid = entry_pid(entry);
        if target_pid != 0 {
            validate_pid(proc, target_pid)?;
        }
        let ofd_idx = proc.ofd_table.create(
            FileType::Directory,
            status_flags,
            PROCFS_DIR_HANDLE,
            resolved_path,
        );
        // Set dir_host_handle so sys_getdents64 recognizes this as a procfs dir
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_host_handle = PROCFS_DIR_HANDLE;
        }
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // Regular file: generate content and store in procfs_bufs
    let content = generate_content(proc, entry)?;
    let buf_idx = alloc_procfs_buf(proc, content);
    let host_handle = procfs_buf_handle(buf_idx);

    let ofd_idx = proc.ofd_table.create(
        FileType::Regular,
        status_flags,
        host_handle,
        resolved_path,
    );
    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
    Ok(fd)
}

/// Generate content for a procfs regular file entry.
fn generate_content(proc: &Process, entry: &ProcfsEntry) -> Result<Vec<u8>, Errno> {
    match entry {
        ProcfsEntry::Stat(pid) | ProcfsEntry::Status(pid) | ProcfsEntry::Cmdline(pid)
        | ProcfsEntry::Environ(pid) | ProcfsEntry::Maps(pid) => {
            validate_pid(proc, *pid)?;
            if *pid == proc.pid {
                match entry {
                    ProcfsEntry::Stat(_) => Ok(generate_stat(proc)),
                    ProcfsEntry::Status(_) => Ok(generate_status(proc)),
                    ProcfsEntry::Cmdline(_) => Ok(generate_cmdline(proc)),
                    ProcfsEntry::Environ(_) => Ok(generate_environ(proc)),
                    ProcfsEntry::Maps(_) => Ok(generate_maps(proc)),
                    _ => unreachable!(),
                }
            } else {
                #[cfg(target_arch = "wasm32")]
                { crate::wasm_api::procfs_generate_for_pid(*pid, entry).ok_or(Errno::ENOENT) }
                #[cfg(not(target_arch = "wasm32"))]
                { Err(Errno::ENOENT) }
            }
        }
        ProcfsEntry::FdInfo(pid, fd) => {
            validate_pid(proc, *pid)?;
            if *pid == proc.pid {
                generate_fdinfo(proc, *fd).ok_or(Errno::ENOENT)
            } else {
                #[cfg(target_arch = "wasm32")]
                { crate::wasm_api::procfs_generate_for_pid(*pid, entry).ok_or(Errno::ENOENT) }
                #[cfg(not(target_arch = "wasm32"))]
                { let _ = fd; Err(Errno::ENOENT) }
            }
        }
        ProcfsEntry::NetTcp => {
            Ok(b"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n".to_vec())
        }
        ProcfsEntry::NetUnix => {
            Ok(b"Num       RefCount Protocol Flags    Type St Inode Path\n".to_vec())
        }
        _ => Err(Errno::ENOENT),
    }
}

/// Validate that a pid is accessible. Self-access always works.
/// Cross-process access delegates to wasm_api helpers.
fn validate_pid(proc: &Process, pid: u32) -> Result<(), Errno> {
    if pid == proc.pid {
        return Ok(());
    }
    // Cross-process: check if pid exists via process table
    #[cfg(target_arch = "wasm32")]
    {
        let all_pids = crate::wasm_api::procfs_all_pids();
        if all_pids.contains(&pid) {
            return Ok(());
        }
    }
    Err(Errno::ENOENT)
}

/// Allocate a procfs buffer slot, reusing freed slots.
fn alloc_procfs_buf(proc: &mut Process, data: Vec<u8>) -> usize {
    for (i, slot) in proc.procfs_bufs.iter().enumerate() {
        if slot.is_none() {
            proc.procfs_bufs[i] = Some(data);
            return i;
        }
    }
    let idx = proc.procfs_bufs.len();
    proc.procfs_bufs.push(Some(data));
    idx
}

// ── Readlink handler ────────────────────────────────────────────────────────

/// Handle readlink for procfs symlinks.
pub fn procfs_readlink(
    proc: &Process,
    entry: &ProcfsEntry,
    buf: &mut [u8],
) -> Result<usize, Errno> {
    let target = match entry {
        ProcfsEntry::SelfLink => {
            use alloc::format;
            let s = format!("{}", proc.pid);
            s.into_bytes()
        }
        ProcfsEntry::ThreadSelfLink => {
            use alloc::format;
            let s = format!("{}/task/{}", proc.pid, proc.pid);
            s.into_bytes()
        }
        ProcfsEntry::FdLink(pid, _) | ProcfsEntry::Cwd(pid) | ProcfsEntry::Exe(pid)
        | ProcfsEntry::Root_(pid) => {
            if *pid != proc.pid {
                #[cfg(target_arch = "wasm32")]
                {
                    return crate::wasm_api::procfs_readlink_for_pid(*pid, entry, buf)
                        .ok_or(Errno::ENOENT);
                }
                #[cfg(not(target_arch = "wasm32"))]
                return Err(Errno::ENOENT);
            }
            match entry {
                ProcfsEntry::FdLink(_, fd) => {
                    let fe = proc.fd_table.get(*fd).map_err(|_| Errno::EBADF)?;
                    let ofd = proc.ofd_table.get(fe.ofd_ref.0).ok_or(Errno::EBADF)?;
                    ofd.path.clone()
                }
                ProcfsEntry::Cwd(_) => proc.cwd.clone(),
                ProcfsEntry::Exe(_) => {
                    if !proc.argv.is_empty() {
                        proc.argv[0].clone()
                    } else {
                        b"/usr/bin/unknown".to_vec()
                    }
                }
                ProcfsEntry::Root_(_) => b"/".to_vec(),
                _ => unreachable!(),
            }
        }
        _ => return Err(Errno::EINVAL),
    };

    let n = buf.len().min(target.len());
    buf[..n].copy_from_slice(&target[..n]);
    Ok(n)
}

// ── Directory iteration ─────────────────────────────────────────────────────

/// Write a single linux_dirent64 entry to buf at position pos.
/// Returns the number of bytes written, or 0 if it doesn't fit.
pub fn write_dirent64(
    buf: &mut [u8],
    pos: usize,
    d_ino: u64,
    d_off: i64,
    d_type: u8,
    name: &[u8],
) -> usize {
    let name_len = name.len();
    let reclen_raw = 19 + name_len + 1;
    let reclen = (reclen_raw + 7) & !7; // 8-byte aligned
    if pos + reclen > buf.len() {
        return 0;
    }
    buf[pos..pos + 8].copy_from_slice(&d_ino.to_le_bytes());
    buf[pos + 8..pos + 16].copy_from_slice(&d_off.to_le_bytes());
    buf[pos + 16..pos + 18].copy_from_slice(&(reclen as u16).to_le_bytes());
    buf[pos + 18] = d_type;
    buf[pos + 19..pos + 19 + name_len].copy_from_slice(name);
    buf[pos + 19 + name_len] = 0;
    // Zero-pad to alignment
    for i in pos + 19 + name_len + 1..pos + reclen {
        buf[i] = 0;
    }
    reclen
}

/// DT_* constants for directory entries.
const DT_DIR: u8 = 4;
const DT_REG: u8 = 8;
const DT_LNK: u8 = 10;

/// Generate directory entries for a procfs directory.
/// `ofd_path` is the directory path, `offset` is the cursor position.
/// Returns (entries_written_bytes, new_offset, exhausted).
pub fn procfs_getdents64(
    proc: &Process,
    ofd_path: &[u8],
    buf: &mut [u8],
    offset: i64,
    pids: &[u32],
) -> Result<(usize, i64, bool), Errno> {
    let entries = dir_entries(proc, ofd_path, pids)?;

    // offset is 0-based entry index (after . and ..)
    // The first two entries are . and ..
    let start = offset as usize;

    let mut pos = 0usize;
    let mut current = start;

    // Emit . and .. if we haven't passed them
    if current == 0 {
        let ino = procfs_ino(0, 0);
        let written = write_dirent64(buf, pos, ino, 1, DT_DIR, b".");
        if written == 0 {
            if pos == 0 { return Err(Errno::EINVAL); }
            return Ok((pos, current as i64, false));
        }
        pos += written;
        current = 1;
    }
    if current == 1 {
        let ino = procfs_ino(0, 0);
        let written = write_dirent64(buf, pos, ino, 2, DT_DIR, b"..");
        if written == 0 {
            return Ok((pos, current as i64, false));
        }
        pos += written;
        current = 2;
    }

    // Emit directory-specific entries
    let entry_start = current - 2; // index into entries[]
    for (i, (name, d_type, ino)) in entries.iter().enumerate().skip(entry_start) {
        let d_off = (i + 3) as i64; // 1=., 2=.., 3+=entries
        let written = write_dirent64(buf, pos, *ino, d_off, *d_type, name);
        if written == 0 {
            return Ok((pos, (i + 2) as i64, false));
        }
        pos += written;
        current = i + 3;
    }

    Ok((pos, current as i64, true))
}

/// Build the list of directory entries for a procfs directory path.
/// Returns (name, d_type, ino) tuples.
fn dir_entries(
    proc: &Process,
    path: &[u8],
    pids: &[u32],
) -> Result<Vec<(Vec<u8>, u8, u64)>, Errno> {
    use alloc::format;

    let entry = match_procfs(path, proc.pid).ok_or(Errno::ENOENT)?;
    let mut entries = Vec::new();

    match entry {
        ProcfsEntry::Root => {
            // /proc: self (symlink), numeric PIDs (dirs), net (dir)
            entries.push((b"self".to_vec(), DT_LNK, procfs_ino(0, 1)));
            entries.push((b"thread-self".to_vec(), DT_LNK, procfs_ino(0, 2)));
            for &pid in pids {
                let name = format!("{}", pid).into_bytes();
                entries.push((name, DT_DIR, procfs_ino(pid, 3)));
            }
            entries.push((b"net".to_vec(), DT_DIR, procfs_ino(0, 16)));
        }
        ProcfsEntry::PidDir(pid) => {
            // /proc/<pid>/: fd, fdinfo (dirs), stat, status, cmdline, environ, maps (files), cwd, exe (symlinks)
            entries.push((b"fd".to_vec(), DT_DIR, procfs_ino(pid, 4)));
            entries.push((b"fdinfo".to_vec(), DT_DIR, procfs_ino(pid, 6)));
            entries.push((b"stat".to_vec(), DT_REG, procfs_ino(pid, 8)));
            entries.push((b"status".to_vec(), DT_REG, procfs_ino(pid, 9)));
            entries.push((b"cmdline".to_vec(), DT_REG, procfs_ino(pid, 10)));
            entries.push((b"environ".to_vec(), DT_REG, procfs_ino(pid, 11)));
            entries.push((b"maps".to_vec(), DT_REG, procfs_ino(pid, 12)));
            entries.push((b"cwd".to_vec(), DT_LNK, procfs_ino(pid, 13)));
            entries.push((b"exe".to_vec(), DT_LNK, procfs_ino(pid, 14)));
            entries.push((b"root".to_vec(), DT_LNK, procfs_ino(pid, 15)));
            entries.push((b"net".to_vec(), DT_DIR, procfs_ino(pid, 16)));
        }
        ProcfsEntry::FdDir(pid) => {
            // /proc/<pid>/fd/: one symlink per open fd
            if pid == proc.pid {
                for fd in 0..1024i32 {
                    if proc.fd_table.get(fd).is_ok() {
                        let name = format!("{}", fd).into_bytes();
                        entries.push((name, DT_LNK, procfs_ino(pid, 5)));
                    }
                }
            }
        }
        ProcfsEntry::FdInfoDir(pid) => {
            // /proc/<pid>/fdinfo/: one file per open fd
            if pid == proc.pid {
                for fd in 0..1024i32 {
                    if proc.fd_table.get(fd).is_ok() {
                        let name = format!("{}", fd).into_bytes();
                        entries.push((name, DT_REG, procfs_ino(pid, 7)));
                    }
                }
            }
        }
        ProcfsEntry::NetDir => {
            entries.push((b"tcp".to_vec(), DT_REG, procfs_ino(0, 17)));
            entries.push((b"unix".to_vec(), DT_REG, procfs_ino(0, 18)));
        }
        _ => return Err(Errno::ENOTDIR),
    }

    Ok(entries)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Get the process name from argv[0] or thread_name.
fn process_name(proc: &Process) -> &str {
    // Try thread_name first (set by prctl PR_SET_NAME)
    let name_len = proc.thread_name.iter().position(|&b| b == 0).unwrap_or(16);
    if name_len > 0 {
        if let Ok(s) = core::str::from_utf8(&proc.thread_name[..name_len]) {
            if !s.is_empty() {
                return s;
            }
        }
    }
    // Fall back to basename of argv[0]
    if let Some(arg0) = proc.argv.first() {
        if let Some(slash) = arg0.iter().rposition(|&b| b == b'/') {
            if let Ok(s) = core::str::from_utf8(&arg0[slash + 1..]) {
                return s;
            }
        }
        if let Ok(s) = core::str::from_utf8(arg0) {
            return s;
        }
    }
    "unknown"
}

/// Count open file descriptors.
fn count_open_fds(fd_table: &crate::fd::FdTable) -> usize {
    let mut count = 0;
    for fd in 0..1024i32 {
        if fd_table.get(fd).is_ok() {
            count += 1;
        }
    }
    count
}


// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::Process;

    #[test]
    fn test_match_procfs_root() {
        assert_eq!(match_procfs(b"/proc", 1), Some(ProcfsEntry::Root));
        assert_eq!(match_procfs(b"/proc/", 1), Some(ProcfsEntry::Root));
    }

    #[test]
    fn test_match_procfs_self() {
        assert_eq!(match_procfs(b"/proc/self", 1), Some(ProcfsEntry::SelfLink));
        assert_eq!(
            match_procfs(b"/proc/self/stat", 42),
            Some(ProcfsEntry::Stat(42))
        );
        assert_eq!(
            match_procfs(b"/proc/self/fd/3", 5),
            Some(ProcfsEntry::FdLink(5, 3))
        );
    }

    #[test]
    fn test_match_procfs_pid() {
        assert_eq!(match_procfs(b"/proc/1", 1), Some(ProcfsEntry::PidDir(1)));
        assert_eq!(
            match_procfs(b"/proc/42/stat", 1),
            Some(ProcfsEntry::Stat(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/status", 1),
            Some(ProcfsEntry::Status(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/cmdline", 1),
            Some(ProcfsEntry::Cmdline(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/environ", 1),
            Some(ProcfsEntry::Environ(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/maps", 1),
            Some(ProcfsEntry::Maps(42))
        );
        assert_eq!(match_procfs(b"/proc/42/cwd", 1), Some(ProcfsEntry::Cwd(42)));
        assert_eq!(match_procfs(b"/proc/42/exe", 1), Some(ProcfsEntry::Exe(42)));
        assert_eq!(
            match_procfs(b"/proc/42/fd", 1),
            Some(ProcfsEntry::FdDir(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/fd/7", 1),
            Some(ProcfsEntry::FdLink(42, 7))
        );
        assert_eq!(
            match_procfs(b"/proc/42/fdinfo", 1),
            Some(ProcfsEntry::FdInfoDir(42))
        );
        assert_eq!(
            match_procfs(b"/proc/42/fdinfo/7", 1),
            Some(ProcfsEntry::FdInfo(42, 7))
        );
    }

    #[test]
    fn test_match_procfs_net() {
        assert_eq!(match_procfs(b"/proc/net", 1), Some(ProcfsEntry::NetDir));
        assert_eq!(match_procfs(b"/proc/net/tcp", 1), Some(ProcfsEntry::NetTcp));
        assert_eq!(
            match_procfs(b"/proc/net/unix", 1),
            Some(ProcfsEntry::NetUnix)
        );
    }

    #[test]
    fn test_match_procfs_no_match() {
        assert_eq!(match_procfs(b"/etc/passwd", 1), None);
        assert_eq!(match_procfs(b"/proc/selfxyz", 1), None);
        assert_eq!(match_procfs(b"/proc/42/nonexistent", 1), None);
    }

    #[test]
    fn test_generate_stat() {
        let mut proc = Process::new(42);
        proc.ppid = 1;
        proc.pgid = 42;
        proc.sid = 1;
        proc.nice = 5;
        proc.argv.push(b"test_program".to_vec());

        let stat = generate_stat(&proc);
        let stat_str = core::str::from_utf8(&stat).unwrap();
        assert!(stat_str.starts_with("42 (test_program) R 1 42 1"));
        assert!(stat_str.contains(" 5 ")); // nice value
    }

    #[test]
    fn test_generate_status() {
        let mut proc = Process::new(1);
        proc.argv.push(b"init".to_vec());
        proc.umask = 0o022;

        let status = generate_status(&proc);
        let status_str = core::str::from_utf8(&status).unwrap();
        assert!(status_str.contains("Name:\tinit\n"));
        assert!(status_str.contains("Pid:\t1\n"));
        assert!(status_str.contains("Umask:\t0022\n"));
    }

    #[test]
    fn test_generate_cmdline() {
        let mut proc = Process::new(1);
        proc.argv.push(b"/bin/sh".to_vec());
        proc.argv.push(b"-c".to_vec());
        proc.argv.push(b"echo hello".to_vec());

        let cmdline = generate_cmdline(&proc);
        // Should be null-separated
        assert_eq!(cmdline, b"/bin/sh\0-c\0echo hello\0");
    }

    #[test]
    fn test_generate_environ() {
        let mut proc = Process::new(1);
        proc.environ.push(b"HOME=/root".to_vec());
        proc.environ.push(b"PATH=/usr/bin".to_vec());

        let environ = generate_environ(&proc);
        assert_eq!(environ, b"HOME=/root\0PATH=/usr/bin\0");
    }

    #[test]
    fn test_procfs_stat_dir() {
        let entry = ProcfsEntry::Root;
        let st = procfs_stat(&entry, 0, true);
        assert_eq!(st.st_mode, S_IFDIR | 0o555);
        assert_eq!(st.st_dev, 0x50);
    }

    #[test]
    fn test_procfs_stat_symlink_nofollow() {
        let entry = ProcfsEntry::SelfLink;
        let st = procfs_stat(&entry, 0, false);
        assert_eq!(st.st_mode, S_IFLNK | 0o777);
    }

    #[test]
    fn test_procfs_stat_regular() {
        let entry = ProcfsEntry::Stat(1);
        let st = procfs_stat(&entry, 100, true);
        assert_eq!(st.st_mode, S_IFREG | 0o444);
        assert_eq!(st.st_size, 100);
    }

    #[test]
    fn test_write_dirent64() {
        let mut buf = [0u8; 256];
        let n = write_dirent64(&mut buf, 0, 42, 1, DT_DIR, b"test");
        assert!(n > 0);
        assert_eq!(n % 8, 0); // 8-byte aligned
        // Check d_ino
        assert_eq!(u64::from_le_bytes(buf[0..8].try_into().unwrap()), 42);
        // Check d_off
        assert_eq!(i64::from_le_bytes(buf[8..16].try_into().unwrap()), 1);
        // Check d_type
        assert_eq!(buf[18], DT_DIR);
        // Check name
        assert_eq!(&buf[19..23], b"test");
        assert_eq!(buf[23], 0); // NUL terminator
    }

    #[test]
    fn test_procfs_open_read_stat() {
        let mut proc = Process::new(1);
        proc.argv.push(b"test".to_vec());

        let entry = ProcfsEntry::Stat(1);
        let fd = procfs_open(&mut proc, &entry, b"/proc/1/stat".to_vec(), 0).unwrap();
        assert!(fd >= 0);

        // Verify buffer was stored
        assert!(!proc.procfs_bufs.is_empty());
        assert!(proc.procfs_bufs[0].is_some());

        // Verify OFD has procfs buf handle
        let fe = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(fe.ofd_ref.0).unwrap();
        assert!(is_procfs_buf_handle(ofd.host_handle));
    }

    #[test]
    fn test_procfs_readlink_self() {
        let proc = Process::new(42);
        let entry = ProcfsEntry::SelfLink;
        let mut buf = [0u8; 64];
        let n = procfs_readlink(&proc, &entry, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"42");
    }

    #[test]
    fn test_procfs_readlink_cwd() {
        let proc = Process::new(1);
        let entry = ProcfsEntry::Cwd(1);
        let mut buf = [0u8; 64];
        let n = procfs_readlink(&proc, &entry, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/");
    }

    #[test]
    fn test_procfs_getdents64_root() {
        let proc = Process::new(1);
        let pids = vec![1u32];
        let mut buf = [0u8; 4096];
        let (bytes, offset, exhausted) =
            procfs_getdents64(&proc, b"/proc", &mut buf, 0, &pids).unwrap();
        assert!(bytes > 0);
        assert!(exhausted);
        // Should have: . , .. , self, thread-self, 1, net = 6 entries
        assert_eq!(offset, 6);
    }

    #[test]
    fn test_procfs_getdents64_pid_dir() {
        let proc = Process::new(1);
        let mut buf = [0u8; 4096];
        let (bytes, offset, exhausted) =
            procfs_getdents64(&proc, b"/proc/1", &mut buf, 0, &[1]).unwrap();
        assert!(bytes > 0);
        assert!(exhausted);
        // . , .. , fd, fdinfo, stat, status, cmdline, environ, maps, cwd, exe, root, net = 13
        assert_eq!(offset, 13);
    }

    #[test]
    fn test_procfs_getdents64_fd_dir() {
        let proc = Process::new(1);
        // Process::new pre-opens fds 0, 1, 2
        let mut buf = [0u8; 4096];
        let (bytes, offset, exhausted) =
            procfs_getdents64(&proc, b"/proc/1/fd", &mut buf, 0, &[1]).unwrap();
        assert!(bytes > 0);
        assert!(exhausted);
        // . , .. , 0, 1, 2 = 5
        assert_eq!(offset, 5);
    }

    #[test]
    fn test_is_procfs_buf_handle() {
        assert!(is_procfs_buf_handle(-200));
        assert!(is_procfs_buf_handle(-201));
        assert!(!is_procfs_buf_handle(-100));
        assert!(!is_procfs_buf_handle(-1));
        assert!(!is_procfs_buf_handle(0));
    }

    #[test]
    fn test_procfs_buf_handle_roundtrip() {
        for idx in 0..10 {
            let h = procfs_buf_handle(idx);
            assert!(is_procfs_buf_handle(h));
            assert_eq!(procfs_buf_idx(h), idx);
        }
    }
}
