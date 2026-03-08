extern crate alloc;

use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::*;
use wasm_posix_shared::fd_flags::FD_CLOEXEC;
use wasm_posix_shared::fcntl_cmd::*;
use wasm_posix_shared::lock_type::*;
use wasm_posix_shared::seek::*;
use wasm_posix_shared::mode::S_IFIFO;
use wasm_posix_shared::{WasmFlock, WasmStat, WasmTimespec};

use crate::fd::OpenFileDescRef;
use crate::lock::FileLock;
use crate::ofd::FileType;
use crate::pipe::{PipeBuffer, DEFAULT_PIPE_CAPACITY};
use crate::process::{HostIO, Process};
use crate::signal::SignalHandler;
use wasm_posix_shared::signal::{SIG_DFL, SIG_IGN, SIG_BLOCK, SIG_UNBLOCK, SIG_SETMASK, SIGKILL, SIGSTOP, NSIG};
use wasm_posix_shared::mmap::{MAP_ANONYMOUS, MAP_FAILED};

/// Creation flags that are stripped from status_flags after open.
const CREATION_FLAGS: u32 = O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_DIRECTORY;

/// Open a file, returning the new file descriptor number.
pub fn sys_open(
    proc: &mut Process,
    host: &mut dyn HostIO,
    path: &[u8],
    oflags: u32,
    mode: u32,
) -> Result<i32, Errno> {
    let host_handle = host.host_open(path, oflags, mode)?;

    let file_type = if oflags & O_DIRECTORY != 0 {
        FileType::Directory
    } else {
        FileType::Regular
    };

    // Status flags = oflags minus creation-only flags
    let status_flags = oflags & !CREATION_FLAGS;

    let ofd_idx = proc.ofd_table.create(file_type, status_flags, host_handle);

    let fd_flags = if oflags & O_CLOEXEC != 0 {
        FD_CLOEXEC
    } else {
        0
    };

    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
    Ok(fd)
}

/// Close a file descriptor.
pub fn sys_close(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<(), Errno> {
    let ofd_ref = proc.fd_table.free(fd)?;
    let idx = ofd_ref.0;

    // Read host_handle, file_type, and status_flags BEFORE dec_ref
    // (since dec_ref may free the OFD slot).
    let (host_handle, file_type, status_flags) = {
        let ofd = proc.ofd_table.get(idx).ok_or(Errno::EBADF)?;
        (ofd.host_handle, ofd.file_type, ofd.status_flags)
    };

    let freed = proc.ofd_table.dec_ref(idx);

    if freed {
        match file_type {
            FileType::Pipe => {
                // host_handle for pipes is -(pipe_idx + 1)
                let pipe_idx = (-(host_handle + 1)) as usize;
                if let Some(pipe) = proc.pipes.get_mut(pipe_idx).and_then(|p| p.as_mut()) {
                    let access_mode = status_flags & O_ACCMODE;
                    if access_mode == O_RDONLY {
                        pipe.close_read_end();
                    } else {
                        pipe.close_write_end();
                    }
                }
            }
            _ => {
                host.host_close(host_handle)?;
            }
        }
    }

    Ok(())
}

/// Read from a file descriptor into `buf`, returning the number of bytes read.
pub fn sys_read(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    // Check that the fd is open for reading (access mode != O_WRONLY).
    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_WRONLY {
        return Err(Errno::EBADF);
    }

    let host_handle = ofd.host_handle;

    if host_handle < 0 {
        // Pipe read
        let pipe_idx = (-(host_handle + 1)) as usize;
        let pipe = proc
            .pipes
            .get_mut(pipe_idx)
            .and_then(|p| p.as_mut())
            .ok_or(Errno::EBADF)?;
        let n = pipe.read(buf);
        Ok(n)
    } else {
        // Host file read
        let n = host.host_read(host_handle, buf)?;
        // Update offset
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.offset += n as i64;
        }
        Ok(n)
    }
}

/// Write to a file descriptor from `buf`, returning the number of bytes written.
pub fn sys_write(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    // Check that the fd is open for writing (access mode != O_RDONLY).
    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_RDONLY {
        return Err(Errno::EBADF);
    }

    let host_handle = ofd.host_handle;

    if host_handle < 0 {
        // Pipe write
        let pipe_idx = (-(host_handle + 1)) as usize;
        let pipe = proc
            .pipes
            .get_mut(pipe_idx)
            .and_then(|p| p.as_mut())
            .ok_or(Errno::EBADF)?;

        // If read end is closed, return EPIPE.
        if !pipe.is_read_end_open() {
            return Err(Errno::EPIPE);
        }

        let n = pipe.write(buf);
        Ok(n)
    } else {
        // Host file write
        let n = host.host_write(host_handle, buf)?;
        // Update offset
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.offset += n as i64;
        }
        Ok(n)
    }
}

/// Seek to a position in a file, returning the new offset.
pub fn sys_lseek(
    proc: &mut Process,
    fd: i32,
    offset: i64,
    whence: u32,
) -> Result<i64, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;

    // Pipes are not seekable.
    if ofd.file_type == FileType::Pipe {
        return Err(Errno::ESPIPE);
    }

    let new_offset = match whence {
        SEEK_SET => offset,
        SEEK_CUR => ofd.offset + offset,
        SEEK_END => return Err(Errno::ENOSYS),
        _ => return Err(Errno::EINVAL),
    };

    if new_offset < 0 {
        return Err(Errno::EINVAL);
    }

    ofd.offset = new_offset;
    Ok(new_offset)
}

/// Duplicate a file descriptor, returning the new fd number.
pub fn sys_dup(proc: &mut Process, fd: i32) -> Result<i32, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_ref = entry.ofd_ref;

    proc.ofd_table.inc_ref(ofd_ref.0);

    match proc.fd_table.alloc(ofd_ref, 0) {
        Ok(new_fd) => Ok(new_fd),
        Err(e) => {
            // Undo the inc_ref on failure.
            proc.ofd_table.dec_ref(ofd_ref.0);
            Err(e)
        }
    }
}

/// Duplicate a file descriptor to a specific fd number.
pub fn sys_dup2(
    proc: &mut Process,
    host: &mut dyn HostIO,
    oldfd: i32,
    newfd: i32,
) -> Result<i32, Errno> {
    // Validate oldfd.
    let _ = proc.fd_table.get(oldfd)?;

    // If oldfd == newfd and valid, return newfd (no-op).
    if oldfd == newfd {
        return Ok(newfd);
    }

    // Close newfd if it's open (ignore errors).
    let _ = sys_close(proc, host, newfd);

    // Re-read oldfd entry since sys_close may have mutated tables
    // (only if newfd happened to share an OFD with oldfd).
    let entry = proc.fd_table.get(oldfd)?;
    let ofd_ref = entry.ofd_ref;

    proc.ofd_table.inc_ref(ofd_ref.0);

    // Place at the specific newfd slot with FD_CLOEXEC=0.
    match proc.fd_table.set_at(newfd, ofd_ref, 0) {
        Ok(_old) => Ok(newfd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd_ref.0);
            Err(e)
        }
    }
}

/// Create a pipe, returning (read_fd, write_fd).
pub fn sys_pipe(proc: &mut Process) -> Result<(i32, i32), Errno> {
    let pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);

    // Find or append a slot in the pipe table.
    let pipe_idx = {
        let mut found = None;
        for (i, slot) in proc.pipes.iter().enumerate() {
            if slot.is_none() {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                proc.pipes[i] = Some(pipe);
                i
            }
            None => {
                let i = proc.pipes.len();
                proc.pipes.push(Some(pipe));
                i
            }
        }
    };

    // Pipe handle is negative: -(pipe_idx + 1)
    let pipe_handle = -((pipe_idx as i64) + 1);

    // Create two OFDs: read end (O_RDONLY) and write end (O_WRONLY).
    let read_ofd = proc.ofd_table.create(FileType::Pipe, O_RDONLY, pipe_handle);
    let write_ofd = proc.ofd_table.create(FileType::Pipe, O_WRONLY, pipe_handle);

    // Allocate two fds.
    let read_fd = match proc.fd_table.alloc(OpenFileDescRef(read_ofd), 0) {
        Ok(fd) => fd,
        Err(e) => {
            proc.ofd_table.dec_ref(read_ofd);
            proc.ofd_table.dec_ref(write_ofd);
            return Err(e);
        }
    };

    let write_fd = match proc.fd_table.alloc(OpenFileDescRef(write_ofd), 0) {
        Ok(fd) => fd,
        Err(e) => {
            proc.fd_table.free(read_fd).ok();
            proc.ofd_table.dec_ref(read_ofd);
            proc.ofd_table.dec_ref(write_ofd);
            return Err(e);
        }
    };

    Ok((read_fd, write_fd))
}

/// Get file status information.
pub fn sys_fstat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<WasmStat, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if ofd.file_type == FileType::Pipe {
        Ok(WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: S_IFIFO | 0o600,
            st_nlink: 0,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        })
    } else {
        host.host_fstat(ofd.host_handle)
    }
}

/// fcntl operations on a file descriptor.
pub fn sys_fcntl(
    proc: &mut Process,
    fd: i32,
    cmd: u32,
    arg: u32,
) -> Result<i32, Errno> {
    match cmd {
        F_DUPFD | F_DUPFD_CLOEXEC => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_ref = entry.ofd_ref;

            proc.ofd_table.inc_ref(ofd_ref.0);

            let new_fd_flags = if cmd == F_DUPFD_CLOEXEC {
                FD_CLOEXEC
            } else {
                0
            };

            match proc
                .fd_table
                .alloc_at_min(ofd_ref, new_fd_flags, arg as i32)
            {
                Ok(new_fd) => Ok(new_fd),
                Err(e) => {
                    proc.ofd_table.dec_ref(ofd_ref.0);
                    Err(e)
                }
            }
        }
        F_GETFD => {
            let entry = proc.fd_table.get(fd)?;
            Ok(entry.fd_flags as i32)
        }
        F_SETFD => {
            let entry = proc.fd_table.get_mut(fd)?;
            entry.fd_flags = arg;
            Ok(0)
        }
        F_GETFL => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_idx = entry.ofd_ref.0;
            let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
            Ok(ofd.status_flags as i32)
        }
        F_SETFL => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_idx = entry.ofd_ref.0;
            proc.ofd_table.set_status_flags(ofd_idx, arg);
            Ok(0)
        }
        F_GETLK | F_SETLK | F_SETLKW => {
            // Lock operations need the flock struct - use sys_fcntl_lock instead
            Err(Errno::EINVAL)
        }
        _ => Err(Errno::EINVAL),
    }
}

/// fcntl lock operations (F_GETLK, F_SETLK, F_SETLKW).
pub fn sys_fcntl_lock(
    proc: &mut Process,
    fd: i32,
    cmd: u32,
    flock: &mut WasmFlock,
) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    let host_handle = ofd.host_handle;

    // Resolve start offset based on whence
    let start = match flock.l_whence {
        0 => flock.l_start,           // SEEK_SET
        1 => ofd.offset + flock.l_start, // SEEK_CUR
        2 => return Err(Errno::ENOSYS), // SEEK_END needs file size
        _ => return Err(Errno::EINVAL),
    };

    match cmd {
        F_GETLK => {
            // Check if the requested lock would conflict
            match proc
                .lock_table
                .get_blocking_lock(host_handle, flock.l_type, start, flock.l_len, proc.pid)
            {
                Some(blocking) => {
                    // Return info about the blocking lock
                    flock.l_type = blocking.lock_type;
                    flock.l_start = blocking.start;
                    flock.l_len = blocking.len;
                    flock.l_pid = blocking.pid;
                    flock.l_whence = 0; // SEEK_SET (absolute)
                }
                None => {
                    // No conflict - set l_type to F_UNLCK
                    flock.l_type = F_UNLCK;
                }
            }
            Ok(())
        }
        F_SETLK | F_SETLKW => {
            // Check for access mode compatibility
            let access_mode = ofd.status_flags & O_ACCMODE;
            if flock.l_type == F_RDLCK && access_mode == O_WRONLY {
                return Err(Errno::EBADF);
            }
            if flock.l_type == F_WRLCK && access_mode == O_RDONLY {
                return Err(Errno::EBADF);
            }

            if flock.l_type == F_UNLCK {
                // Unlock
                let lock = FileLock {
                    pid: proc.pid,
                    lock_type: F_UNLCK,
                    start,
                    len: flock.l_len,
                };
                proc.lock_table.set_lock(host_handle, lock);
                return Ok(());
            }

            // Check for conflicts
            if proc
                .lock_table
                .get_blocking_lock(host_handle, flock.l_type, start, flock.l_len, proc.pid)
                .is_some()
            {
                if cmd == F_SETLK {
                    // Non-blocking: return error
                    return Err(Errno::EAGAIN);
                }
                // F_SETLKW would block -- but in single-process this can't happen
                // (same-pid locks never conflict). If we get here with multi-process,
                // we'd need to block. For now, return ENOSYS.
                return Err(Errno::ENOSYS);
            }

            // Set the lock
            let lock = FileLock {
                pid: proc.pid,
                lock_type: flock.l_type,
                start,
                len: flock.l_len,
            };
            proc.lock_table.set_lock(host_handle, lock);
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

use wasm_posix_shared::WasmDirent;
use crate::process::{DirStream, ProcessState};
use crate::path::resolve_path;

pub fn sys_stat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_stat(&resolved)
}

pub fn sys_lstat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_lstat(&resolved)
}

pub fn sys_mkdir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], mode: u32) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_mkdir(&resolved, mode)
}

pub fn sys_rmdir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_rmdir(&resolved)
}

pub fn sys_unlink(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_unlink(&resolved)
}

pub fn sys_rename(proc: &mut Process, host: &mut dyn HostIO, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
    let old = resolve_path(oldpath, &proc.cwd);
    let new = resolve_path(newpath, &proc.cwd);
    host.host_rename(&old, &new)
}

pub fn sys_link(proc: &mut Process, host: &mut dyn HostIO, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
    let old = resolve_path(oldpath, &proc.cwd);
    let new = resolve_path(newpath, &proc.cwd);
    host.host_link(&old, &new)
}

pub fn sys_symlink(proc: &mut Process, host: &mut dyn HostIO, target: &[u8], linkpath: &[u8]) -> Result<(), Errno> {
    // Note: symlink target is stored as-is (not resolved), but linkpath is resolved
    let link = resolve_path(linkpath, &proc.cwd);
    host.host_symlink(target, &link)
}

pub fn sys_readlink(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_readlink(&resolved, buf)
}

pub fn sys_chmod(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], mode: u32) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_chmod(&resolved, mode)
}

pub fn sys_chown(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_chown(&resolved, uid, gid)
}

pub fn sys_access(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], amode: u32) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    host.host_access(&resolved, amode)
}

/// Change the current working directory.
/// Validates that the path exists and is a directory via host_stat.
pub fn sys_chdir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    // Validate the path exists and is a directory
    let stat = host.host_stat(&resolved)?;
    let file_type = stat.st_mode & wasm_posix_shared::mode::S_IFMT;
    if file_type != wasm_posix_shared::mode::S_IFDIR {
        return Err(Errno::ENOTDIR);
    }
    proc.cwd = resolved;
    Ok(())
}

/// Get the current working directory.
/// Writes the cwd path to `buf` and returns the number of bytes written.
/// Returns ERANGE if the buffer is too small.
pub fn sys_getcwd(proc: &Process, buf: &mut [u8]) -> Result<usize, Errno> {
    if buf.len() < proc.cwd.len() {
        return Err(Errno::ERANGE);
    }
    buf[..proc.cwd.len()].copy_from_slice(&proc.cwd);
    Ok(proc.cwd.len())
}

/// Open a directory for reading. Returns a directory stream handle.
pub fn sys_opendir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<i32, Errno> {
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    let host_handle = host.host_opendir(&resolved)?;
    let stream = DirStream { host_handle };

    // Find a free slot or append
    for (i, slot) in proc.dir_streams.iter().enumerate() {
        if slot.is_none() {
            proc.dir_streams[i] = Some(stream);
            return Ok(i as i32);
        }
    }
    let idx = proc.dir_streams.len();
    proc.dir_streams.push(Some(stream));
    Ok(idx as i32)
}

/// Read the next directory entry. Returns:
/// - 1 if an entry was written to dirent_buf and name_buf
/// - 0 if end of directory
/// - Err(errno) on error
pub fn sys_readdir(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dir_handle: i32,
    dirent_buf: &mut [u8],
    name_buf: &mut [u8],
) -> Result<i32, Errno> {
    let idx = dir_handle as usize;
    let stream = proc.dir_streams
        .get(idx)
        .and_then(|s| s.as_ref())
        .ok_or(Errno::EBADF)?;
    let host_handle = stream.host_handle;

    match host.host_readdir(host_handle, name_buf)? {
        Some((d_ino, d_type, name_len)) => {
            // Write WasmDirent to dirent_buf if it fits
            let dirent = WasmDirent {
                d_ino,
                d_type,
                d_namlen: name_len as u32,
            };
            let dirent_size = core::mem::size_of::<WasmDirent>();
            if dirent_buf.len() >= dirent_size {
                let dirent_bytes = unsafe {
                    core::slice::from_raw_parts(
                        &dirent as *const WasmDirent as *const u8,
                        dirent_size,
                    )
                };
                dirent_buf[..dirent_size].copy_from_slice(dirent_bytes);
            }
            Ok(1)
        }
        None => Ok(0),
    }
}

/// Close a directory stream.
pub fn sys_closedir(proc: &mut Process, host: &mut dyn HostIO, dir_handle: i32) -> Result<(), Errno> {
    let idx = dir_handle as usize;
    if idx >= proc.dir_streams.len() {
        return Err(Errno::EBADF);
    }
    let stream = proc.dir_streams[idx].take().ok_or(Errno::EBADF)?;
    host.host_closedir(stream.host_handle)
}

/// Get the process ID.
pub fn sys_getpid(proc: &Process) -> i32 {
    proc.pid as i32
}

/// Get the parent process ID.
pub fn sys_getppid(proc: &Process) -> i32 {
    proc.ppid as i32
}

/// Get the real user ID.
pub fn sys_getuid(proc: &Process) -> u32 {
    proc.uid
}

/// Get the effective user ID.
pub fn sys_geteuid(proc: &Process) -> u32 {
    proc.euid
}

/// Get the real group ID.
pub fn sys_getgid(proc: &Process) -> u32 {
    proc.gid
}

/// Get the effective group ID.
pub fn sys_getegid(proc: &Process) -> u32 {
    proc.egid
}

/// Send a signal to the current process (since we only have one process).
/// Returns Ok(()) on success, Err(EINVAL) for invalid signal.
pub fn sys_kill(proc: &mut Process, _pid: i32, sig: u32) -> Result<(), Errno> {
    if sig == 0 {
        // sig=0 is a validity check -- just return success
        return Ok(());
    }
    if sig >= NSIG {
        return Err(Errno::EINVAL);
    }
    proc.signals.raise(sig);
    Ok(())
}

/// Send a signal to the current process.
pub fn sys_raise(proc: &mut Process, sig: u32) -> Result<(), Errno> {
    sys_kill(proc, proc.pid as i32, sig)
}

/// Set signal handler. Returns the previous handler disposition as a u32.
/// handler_val: 0=SIG_DFL, 1=SIG_IGN, anything else=function pointer (future use)
pub fn sys_sigaction(proc: &mut Process, sig: u32, handler_val: u32) -> Result<u32, Errno> {
    if sig == 0 || sig >= NSIG {
        return Err(Errno::EINVAL);
    }
    if sig == SIGKILL || sig == SIGSTOP {
        return Err(Errno::EINVAL);
    }

    let new_handler = match handler_val {
        SIG_DFL => SignalHandler::Default,
        SIG_IGN => SignalHandler::Ignore,
        ptr => SignalHandler::Handler(ptr),
    };

    let old = proc.signals.set_handler(sig, new_handler)
        .map_err(|_| Errno::EINVAL)?;

    let old_val = match old {
        SignalHandler::Default => SIG_DFL,
        SignalHandler::Ignore => SIG_IGN,
        SignalHandler::Handler(ptr) => ptr,
    };

    Ok(old_val)
}

/// Manipulate the signal mask.
/// how: SIG_BLOCK, SIG_UNBLOCK, or SIG_SETMASK
/// set: bitmask of signals to modify
/// Returns the old signal mask.
pub fn sys_sigprocmask(proc: &mut Process, how: u32, set: u64) -> Result<u64, Errno> {
    let old_mask = proc.signals.blocked;

    match how {
        SIG_BLOCK => {
            proc.signals.blocked |= set;
        }
        SIG_UNBLOCK => {
            proc.signals.blocked &= !set;
        }
        SIG_SETMASK => {
            proc.signals.blocked = set;
        }
        _ => return Err(Errno::EINVAL),
    }

    // SIGKILL and SIGSTOP cannot be blocked (POSIX)
    proc.signals.blocked &= !((1u64 << SIGKILL) | (1u64 << SIGSTOP));

    Ok(old_mask)
}

/// Exit the process. Closes all fds and dir streams, sets state to Exited.
pub fn sys_exit(proc: &mut Process, host: &mut dyn HostIO, status: i32) {
    // Close all file descriptors
    let max_fd = 1024; // Use a reasonable upper bound
    for fd in 0..max_fd {
        let _ = sys_close(proc, host, fd);
    }

    // Close all directory streams
    let num_streams = proc.dir_streams.len();
    for i in 0..num_streams {
        if proc.dir_streams[i].is_some() {
            let stream = proc.dir_streams[i].take().unwrap();
            let _ = host.host_closedir(stream.host_handle);
        }
    }

    proc.state = ProcessState::Exited;
    proc.exit_status = status;
}

/// Get the current time from the specified clock.
pub fn sys_clock_gettime(
    _proc: &Process,
    host: &mut dyn HostIO,
    clock_id: u32,
) -> Result<WasmTimespec, Errno> {
    let (sec, nsec) = host.host_clock_gettime(clock_id)?;
    Ok(WasmTimespec { tv_sec: sec, tv_nsec: nsec })
}

/// Sleep for the specified duration.
pub fn sys_nanosleep(
    _proc: &Process,
    host: &mut dyn HostIO,
    req: &WasmTimespec,
) -> Result<(), Errno> {
    if req.tv_sec < 0 || req.tv_nsec < 0 || req.tv_nsec >= 1_000_000_000 {
        return Err(Errno::EINVAL);
    }
    host.host_nanosleep(req.tv_sec, req.tv_nsec)
}

/// Check if a file descriptor refers to a terminal.
/// Returns 1 if it's a terminal (CharDevice), Err(ENOTTY) otherwise.
pub fn sys_isatty(proc: &Process, fd: i32) -> Result<i32, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if ofd.file_type == FileType::CharDevice {
        Ok(1)
    } else {
        Err(Errno::ENOTTY)
    }
}

/// Get an environment variable by name.
/// Returns the value (not including "KEY=") or Err(ENOENT) if not found.
pub fn sys_getenv(proc: &Process, name: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    for entry in &proc.environ {
        if let Some(eq_pos) = entry.iter().position(|&b| b == b'=') {
            if &entry[..eq_pos] == name {
                let value = &entry[eq_pos + 1..];
                if buf.len() < value.len() {
                    return Err(Errno::ERANGE);
                }
                buf[..value.len()].copy_from_slice(value);
                return Ok(value.len());
            }
        }
    }
    Err(Errno::ENOENT)
}

/// Set an environment variable. If `overwrite` is true, replace existing.
pub fn sys_setenv(proc: &mut Process, name: &[u8], value: &[u8], overwrite: bool) -> Result<(), Errno> {
    if name.is_empty() || name.contains(&b'=') {
        return Err(Errno::EINVAL);
    }

    // Check if it already exists
    for entry in proc.environ.iter_mut() {
        if let Some(eq_pos) = entry.iter().position(|&b| b == b'=') {
            if &entry[..eq_pos] == name {
                if overwrite {
                    let mut new_entry = name.to_vec();
                    new_entry.push(b'=');
                    new_entry.extend_from_slice(value);
                    *entry = new_entry;
                }
                return Ok(());
            }
        }
    }

    // Not found - add new
    let mut new_entry = name.to_vec();
    new_entry.push(b'=');
    new_entry.extend_from_slice(value);
    proc.environ.push(new_entry);
    Ok(())
}

/// Remove an environment variable.
pub fn sys_unsetenv(proc: &mut Process, name: &[u8]) -> Result<(), Errno> {
    if name.is_empty() || name.contains(&b'=') {
        return Err(Errno::EINVAL);
    }
    proc.environ.retain(|entry| {
        if let Some(eq_pos) = entry.iter().position(|&b| b == b'=') {
            &entry[..eq_pos] != name
        } else {
            true
        }
    });
    Ok(())
}

/// mmap -- currently only supports anonymous mappings.
pub fn sys_mmap(
    proc: &mut Process,
    _addr: u32,  // hint address (ignored for now)
    len: u32,
    prot: u32,
    flags: u32,
    _fd: i32,     // ignored for anonymous
    _offset: i64, // ignored for anonymous
) -> Result<u32, Errno> {
    // Only anonymous mappings supported
    if flags & MAP_ANONYMOUS == 0 {
        return Err(Errno::ENOSYS);
    }

    let addr = proc.memory.mmap_anonymous(len, prot, flags);
    if addr == MAP_FAILED {
        return Err(Errno::ENOMEM);
    }
    Ok(addr)
}

/// munmap -- unmap a previously mapped region.
pub fn sys_munmap(proc: &mut Process, addr: u32, len: u32) -> Result<(), Errno> {
    if proc.memory.munmap(addr, len) {
        Ok(())
    } else {
        Err(Errno::EINVAL)
    }
}

/// brk -- set/get the program break.
/// If addr is 0, returns the current break.
/// Otherwise, sets the break to addr and returns the new break.
pub fn sys_brk(proc: &mut Process, addr: u32) -> u32 {
    if addr == 0 {
        proc.memory.get_brk()
    } else {
        proc.memory.set_brk(addr)
    }
}

/// mprotect -- not applicable to Wasm linear memory.
pub fn sys_mprotect(_proc: &Process, _addr: u32, _len: u32, _prot: u32) -> Result<(), Errno> {
    Err(Errno::ENOSYS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::ProcessState;
    use wasm_posix_shared::mode::{S_IFDIR, S_IFREG, S_IFLNK};

    /// Mock host I/O for testing.
    struct MockHostIO {
        next_handle: i64,
        dir_entry_returned: bool,
    }

    impl MockHostIO {
        fn new() -> Self {
            MockHostIO { next_handle: 100, dir_entry_returned: false }
        }
    }

    impl HostIO for MockHostIO {
        fn host_open(&mut self, _path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> {
            let handle = self.next_handle;
            self.next_handle += 1;
            Ok(handle)
        }

        fn host_close(&mut self, _handle: i64) -> Result<(), Errno> {
            Ok(())
        }

        fn host_read(&mut self, _handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
            let data = b"hello";
            let n = buf.len().min(data.len());
            buf[..n].copy_from_slice(&data[..n]);
            Ok(n)
        }

        fn host_write(&mut self, _handle: i64, buf: &[u8]) -> Result<usize, Errno> {
            Ok(buf.len())
        }

        fn host_seek(
            &mut self,
            _handle: i64,
            _offset: i64,
            _whence: u32,
        ) -> Result<i64, Errno> {
            Ok(0)
        }

        fn host_fstat(&mut self, _handle: i64) -> Result<WasmStat, Errno> {
            Ok(WasmStat {
                st_dev: 0,
                st_ino: 0,
                st_mode: S_IFREG | 0o644,
                st_nlink: 1,
                st_uid: 0,
                st_gid: 0,
                st_size: 1024,
                st_atime_sec: 0,
                st_atime_nsec: 0,
                st_mtime_sec: 0,
                st_mtime_nsec: 0,
                st_ctime_sec: 0,
                st_ctime_nsec: 0,
                _pad: 0,
            })
        }

        fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
            // Return S_IFDIR for paths that look like directories
            let is_dir = path.ends_with(b"dir") || path.ends_with(b"tmp")
                || path.ends_with(b"/") || path == b"/";
            let mode = if is_dir {
                S_IFDIR | 0o755
            } else {
                S_IFREG | 0o644
            };
            Ok(WasmStat {
                st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 1024,
                st_atime_sec: 0, st_atime_nsec: 0,
                st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }

        fn host_lstat(&mut self, _path: &[u8]) -> Result<WasmStat, Errno> {
            // Return S_IFLNK to distinguish from stat
            Ok(WasmStat {
                st_dev: 0, st_ino: 2, st_mode: S_IFLNK | 0o777, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 7,
                st_atime_sec: 0, st_atime_nsec: 0,
                st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }

        fn host_mkdir(&mut self, _path: &[u8], _mode: u32) -> Result<(), Errno> { Ok(()) }
        fn host_rmdir(&mut self, _path: &[u8]) -> Result<(), Errno> { Ok(()) }
        fn host_unlink(&mut self, _path: &[u8]) -> Result<(), Errno> { Ok(()) }
        fn host_rename(&mut self, _oldpath: &[u8], _newpath: &[u8]) -> Result<(), Errno> { Ok(()) }
        fn host_link(&mut self, _oldpath: &[u8], _newpath: &[u8]) -> Result<(), Errno> { Ok(()) }
        fn host_symlink(&mut self, _target: &[u8], _linkpath: &[u8]) -> Result<(), Errno> { Ok(()) }

        fn host_readlink(&mut self, _path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
            let target = b"/target";
            let n = buf.len().min(target.len());
            buf[..n].copy_from_slice(&target[..n]);
            Ok(n)
        }

        fn host_chmod(&mut self, _path: &[u8], _mode: u32) -> Result<(), Errno> { Ok(()) }
        fn host_chown(&mut self, _path: &[u8], _uid: u32, _gid: u32) -> Result<(), Errno> { Ok(()) }
        fn host_access(&mut self, _path: &[u8], _amode: u32) -> Result<(), Errno> { Ok(()) }

        fn host_opendir(&mut self, _path: &[u8]) -> Result<i64, Errno> { Ok(200) }

        fn host_readdir(&mut self, _handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
            if !self.dir_entry_returned {
                self.dir_entry_returned = true;
                let name = b"test.txt";
                let n = name_buf.len().min(name.len());
                name_buf[..n].copy_from_slice(&name[..n]);
                Ok(Some((42, 8, n))) // d_ino=42, d_type=DT_REG=8, name_len
            } else {
                Ok(None) // end of directory
            }
        }

        fn host_closedir(&mut self, _handle: i64) -> Result<(), Errno> { Ok(()) }

        fn host_clock_gettime(&mut self, _clock_id: u32) -> Result<(i64, i64), Errno> {
            Ok((1234567890, 123456789))
        }

        fn host_nanosleep(&mut self, _seconds: i64, _nanoseconds: i64) -> Result<(), Errno> {
            Ok(())
        }
    }

    #[test]
    fn test_open_close_cycle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();
        assert_eq!(fd, 3); // 0,1,2 are stdio

        sys_close(&mut proc, &mut host, fd).unwrap();

        // fd 3 should now be EBADF
        assert_eq!(proc.fd_table.get(fd), Err(Errno::EBADF));
    }

    #[test]
    fn test_dup_shares_ofd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();
        let dup_fd = sys_dup(&mut proc, fd).unwrap();

        // Both fds should point to the same OFD ref.
        let ofd_ref1 = proc.fd_table.get(fd).unwrap().ofd_ref;
        let ofd_ref2 = proc.fd_table.get(dup_fd).unwrap().ofd_ref;
        assert_eq!(ofd_ref1, ofd_ref2);
    }

    #[test]
    fn test_dup2_replaces_target() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();
        let result = sys_dup2(&mut proc, &mut host, fd, 10).unwrap();
        assert_eq!(result, 10);

        // fd 10 should be valid and share the same OFD.
        let ofd_ref_orig = proc.fd_table.get(fd).unwrap().ofd_ref;
        let ofd_ref_dup = proc.fd_table.get(10).unwrap().ofd_ref;
        assert_eq!(ofd_ref_orig, ofd_ref_dup);
    }

    #[test]
    fn test_dup2_same_fd_noop() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();
        let ofd_ref_before = proc.fd_table.get(fd).unwrap().ofd_ref;
        let ref_count_before = proc.ofd_table.get(ofd_ref_before.0).unwrap().ref_count;

        let result = sys_dup2(&mut proc, &mut host, fd, fd).unwrap();
        assert_eq!(result, fd);

        // Ref count should not have changed.
        let ref_count_after = proc.ofd_table.get(ofd_ref_before.0).unwrap().ref_count;
        assert_eq!(ref_count_before, ref_count_after);
    }

    #[test]
    fn test_pipe_read_write() {
        let mut proc = Process::new(1);
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        // Pipe fds should be 3 and 4 (after stdio 0,1,2).
        assert_eq!(read_fd, 3);
        assert_eq!(write_fd, 4);
    }

    #[test]
    fn test_fcntl_dupfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();

        // F_DUPFD with arg=10 should return fd >= 10.
        let new_fd = sys_fcntl(&mut proc, fd, F_DUPFD, 10).unwrap();
        assert!(new_fd >= 10);
    }

    #[test]
    fn test_fcntl_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Open with O_CLOEXEC
        let fd =
            sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CLOEXEC, 0o644).unwrap();

        // F_GETFD should return FD_CLOEXEC.
        let flags = sys_fcntl(&mut proc, fd, F_GETFD, 0).unwrap();
        assert_eq!(flags as u32, FD_CLOEXEC);

        // F_SETFD to clear FD_CLOEXEC.
        sys_fcntl(&mut proc, fd, F_SETFD, 0).unwrap();
        let flags = sys_fcntl(&mut proc, fd, F_GETFD, 0).unwrap();
        assert_eq!(flags, 0);
    }

    #[test]
    fn test_fcntl_getfl_setfl() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();

        // F_GETFL should return O_RDWR (access mode).
        let flags = sys_fcntl(&mut proc, fd, F_GETFL, 0).unwrap() as u32;
        assert_eq!(flags & O_ACCMODE, O_RDWR);

        // F_SETFL to set O_NONBLOCK.
        sys_fcntl(&mut proc, fd, F_SETFL, O_NONBLOCK).unwrap();

        // F_GETFL should now have O_NONBLOCK set, but access mode preserved.
        let flags = sys_fcntl(&mut proc, fd, F_GETFL, 0).unwrap() as u32;
        assert_eq!(flags & O_ACCMODE, O_RDWR);
        assert_ne!(flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_lseek() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR, 0o644).unwrap();

        // SEEK_SET to 100
        let pos = sys_lseek(&mut proc, fd, 100, SEEK_SET).unwrap();
        assert_eq!(pos, 100);

        // SEEK_CUR -10 -> 90
        let pos = sys_lseek(&mut proc, fd, -10, SEEK_CUR).unwrap();
        assert_eq!(pos, 90);
    }

    #[test]
    fn test_lseek_pipe_fails() {
        let mut proc = Process::new(1);
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();

        let result = sys_lseek(&mut proc, read_fd, 0, SEEK_SET);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_read_write_only_fd_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();

        let mut buf = [0u8; 10];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_write_read_only_fd_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0o644).unwrap();

        let result = sys_write(&mut proc, &mut host, fd, b"hello");
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_fstat_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0o644).unwrap();
        let stat = sys_fstat(&mut proc, &mut host, fd).unwrap();

        assert_eq!(stat.st_mode & S_IFREG, S_IFREG);
    }

    #[test]
    fn test_fstat_pipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        let stat = sys_fstat(&mut proc, &mut host, read_fd).unwrap();

        assert_eq!(stat.st_mode & S_IFIFO, S_IFIFO);
    }

    #[test]
    fn test_pipe_write_then_read() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        // Write "hello" to the write end.
        let n = sys_write(&mut proc, &mut host, write_fd, b"hello").unwrap();
        assert_eq!(n, 5);

        // Read from the read end.
        let mut buf = [0u8; 10];
        let n = sys_read(&mut proc, &mut host, read_fd, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_stat_returns_file_info() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let stat = sys_stat(&mut proc, &mut host, b"/tmp/file").unwrap();
        assert_eq!(stat.st_mode & S_IFREG, S_IFREG);
        assert_eq!(stat.st_size, 1024);
    }

    #[test]
    fn test_lstat_returns_symlink_info() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let stat = sys_lstat(&mut proc, &mut host, b"/tmp/link").unwrap();
        assert_eq!(stat.st_mode & S_IFLNK, S_IFLNK);
    }

    #[test]
    fn test_stat_resolves_relative_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.cwd = b"/home/user".to_vec();
        // Should not fail - relative paths get cwd prepended
        let stat = sys_stat(&mut proc, &mut host, b"file.txt").unwrap();
        assert_eq!(stat.st_mode & S_IFREG, S_IFREG);
    }

    #[test]
    fn test_mkdir_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_mkdir(&mut proc, &mut host, b"/tmp/newdir", 0o755).unwrap();
    }

    #[test]
    fn test_unlink_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_unlink(&mut proc, &mut host, b"/tmp/file").unwrap();
    }

    #[test]
    fn test_readlink_returns_target() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let n = sys_readlink(&mut proc, &mut host, b"/tmp/link", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/target");
    }

    #[test]
    fn test_rename_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_rename(&mut proc, &mut host, b"/tmp/old", b"/tmp/new").unwrap();
    }

    #[test]
    fn test_access_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_access(&mut proc, &mut host, b"/tmp/file", 0).unwrap(); // F_OK
    }

    #[test]
    fn test_symlink_target_not_resolved() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // symlink target is stored as-is, only linkpath is resolved
        sys_symlink(&mut proc, &mut host, b"../relative-target", b"/tmp/link").unwrap();
    }

    #[test]
    fn test_getcwd_returns_initial_cwd() {
        let proc = Process::new(1);
        let mut buf = [0u8; 256];
        let n = sys_getcwd(&proc, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/");
    }

    #[test]
    fn test_chdir_changes_cwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_chdir(&mut proc, &mut host, b"/tmp").unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getcwd(&proc, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/tmp");
    }

    #[test]
    fn test_chdir_relative_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // First chdir to /tmp (ends with "tmp", so MockHostIO returns S_IFDIR)
        sys_chdir(&mut proc, &mut host, b"/tmp").unwrap();
        // Then chdir to "subdir" relative (resolves to /tmp/subdir, ends with "dir")
        sys_chdir(&mut proc, &mut host, b"subdir").unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getcwd(&proc, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/tmp/subdir");
    }

    #[test]
    fn test_chdir_rejects_non_directory() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Path "file.txt" doesn't end with dir/tmp, so MockHostIO returns S_IFREG
        let result = sys_chdir(&mut proc, &mut host, b"/file.txt");
        assert_eq!(result, Err(Errno::ENOTDIR));
    }

    #[test]
    fn test_getcwd_erange_when_buffer_too_small() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_chdir(&mut proc, &mut host, b"/tmp").unwrap();
        let mut buf = [0u8; 2]; // too small for "/tmp"
        let result = sys_getcwd(&proc, &mut buf);
        assert_eq!(result, Err(Errno::ERANGE));
    }

    #[test]
    fn test_opendir_closedir_cycle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();
        assert!(dh >= 0);
        sys_closedir(&mut proc, &mut host, dh).unwrap();
    }

    #[test]
    fn test_closedir_invalid_handle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_closedir(&mut proc, &mut host, 99);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_closedir_already_closed() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();
        sys_closedir(&mut proc, &mut host, dh).unwrap();
        // Double close should fail
        let result = sys_closedir(&mut proc, &mut host, dh);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_readdir_returns_entry_then_done() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();

        let mut dirent_buf = [0u8; 16]; // WasmDirent is 16 bytes
        let mut name_buf = [0u8; 256];

        // First call should return entry
        let result = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(result, 1);
        assert_eq!(&name_buf[..8], b"test.txt");

        // Second call should return end-of-directory
        let result = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(result, 0);

        sys_closedir(&mut proc, &mut host, dh).unwrap();
    }

    #[test]
    fn test_readdir_invalid_handle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut dirent_buf = [0u8; 16];
        let mut name_buf = [0u8; 256];
        let result = sys_readdir(&mut proc, &mut host, 99, &mut dirent_buf, &mut name_buf);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_dir_stream_slot_reuse() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let dh0 = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();
        assert_eq!(dh0, 0);
        sys_closedir(&mut proc, &mut host, dh0).unwrap();
        // Reopen should reuse slot 0
        let dh1 = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();
        assert_eq!(dh1, 0);
        sys_closedir(&mut proc, &mut host, dh1).unwrap();
    }

    #[test]
    fn test_getpid_returns_pid() {
        let proc = Process::new(42);
        assert_eq!(sys_getpid(&proc), 42);
    }

    #[test]
    fn test_getppid_returns_zero_for_init() {
        let proc = Process::new(1);
        assert_eq!(sys_getppid(&proc), 0);
    }

    #[test]
    fn test_getuid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getuid(&proc), 1000);
    }

    #[test]
    fn test_geteuid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_geteuid(&proc), 1000);
    }

    #[test]
    fn test_getgid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getgid(&proc), 1000);
    }

    #[test]
    fn test_getegid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getegid(&proc), 1000);
    }

    #[test]
    fn test_exit_closes_fds_and_sets_state() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Open a file to ensure there's something to close
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();
        assert!(fd >= 3); // After stdio

        sys_exit(&mut proc, &mut host, 42);

        assert_eq!(proc.state, ProcessState::Exited);
        assert_eq!(proc.exit_status, 42);

        // All fds should be closed - trying to read from fd should fail
        let mut buf = [0u8; 10];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_exit_with_zero_status() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_exit(&mut proc, &mut host, 0);
        assert_eq!(proc.state, ProcessState::Exited);
        assert_eq!(proc.exit_status, 0);
    }

    #[test]
    fn test_kill_marks_signal_pending() {
        let mut proc = Process::new(1);
        let mut _host = MockHostIO::new();
        sys_kill(&mut proc, 1, 2).unwrap(); // SIGINT=2
        assert!(proc.signals.is_pending(2));
    }

    #[test]
    fn test_kill_sig_zero_is_noop() {
        let mut proc = Process::new(1);
        sys_kill(&mut proc, 1, 0).unwrap();
        assert_eq!(proc.signals.pending, 0);
    }

    #[test]
    fn test_kill_invalid_signal() {
        let mut proc = Process::new(1);
        let result = sys_kill(&mut proc, 1, 100);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_sigaction_set_ignore() {
        let mut proc = Process::new(1);
        let old = sys_sigaction(&mut proc, 2, 1).unwrap(); // SIGINT, SIG_IGN
        assert_eq!(old, 0); // was SIG_DFL
        let old = sys_sigaction(&mut proc, 2, 0).unwrap(); // back to SIG_DFL
        assert_eq!(old, 1); // was SIG_IGN
    }

    #[test]
    fn test_sigaction_cannot_change_sigkill() {
        let mut proc = Process::new(1);
        let result = sys_sigaction(&mut proc, 9, 1); // SIGKILL, SIG_IGN
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_sigprocmask_block() {
        let mut proc = Process::new(1);
        let old = sys_sigprocmask(&mut proc, 0, 1u64 << 2).unwrap(); // SIG_BLOCK SIGINT
        assert_eq!(old, 0);
        assert!(proc.signals.is_blocked(2));
    }

    #[test]
    fn test_sigprocmask_cannot_block_sigkill() {
        let mut proc = Process::new(1);
        sys_sigprocmask(&mut proc, 2, (1u64 << 9) | (1u64 << 2)).unwrap(); // SIG_SETMASK SIGKILL+SIGINT
        assert!(!proc.signals.is_blocked(9)); // SIGKILL cannot be blocked
        assert!(proc.signals.is_blocked(2)); // SIGINT can be blocked
    }

    #[test]
    fn test_raise_is_kill_to_self() {
        let mut proc = Process::new(42);
        sys_raise(&mut proc, 15).unwrap(); // SIGTERM
        assert!(proc.signals.is_pending(15));
    }

    #[test]
    fn test_fcntl_setlk_and_getlk() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();

        // Set a write lock on bytes 0-99
        let mut flock = WasmFlock {
            l_type: F_WRLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock).unwrap();

        // F_GETLK should report no conflict (same pid)
        let mut query = WasmFlock {
            l_type: F_WRLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_GETLK, &mut query).unwrap();
        assert_eq!(query.l_type, F_UNLCK); // No conflict with self
    }

    #[test]
    fn test_fcntl_unlock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();

        // Set then unlock
        let mut flock = WasmFlock {
            l_type: F_WRLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock).unwrap();

        let mut unlock = WasmFlock {
            l_type: F_UNLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut unlock).unwrap();
    }

    #[test]
    fn test_fcntl_rdlck_requires_read_access() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();

        let mut flock = WasmFlock {
            l_type: F_RDLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        let result = sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_clock_gettime() {
        let proc = Process::new(1);
        let mut host = MockHostIO::new();
        let ts = sys_clock_gettime(&proc, &mut host, 0).unwrap();
        assert_eq!(ts.tv_sec, 1234567890);
        assert_eq!(ts.tv_nsec, 123456789);
    }

    #[test]
    fn test_nanosleep_rejects_negative() {
        let proc = Process::new(1);
        let mut host = MockHostIO::new();
        let req = WasmTimespec { tv_sec: -1, tv_nsec: 0 };
        assert_eq!(sys_nanosleep(&proc, &mut host, &req), Err(Errno::EINVAL));
    }

    #[test]
    fn test_nanosleep_rejects_invalid_nsec() {
        let proc = Process::new(1);
        let mut host = MockHostIO::new();
        let req = WasmTimespec { tv_sec: 0, tv_nsec: 1_000_000_000 };
        assert_eq!(sys_nanosleep(&proc, &mut host, &req), Err(Errno::EINVAL));
    }

    #[test]
    fn test_nanosleep_valid() {
        let proc = Process::new(1);
        let mut host = MockHostIO::new();
        let req = WasmTimespec { tv_sec: 1, tv_nsec: 500_000_000 };
        assert_eq!(sys_nanosleep(&proc, &mut host, &req), Ok(()));
    }

    #[test]
    fn test_isatty_stdin() {
        let proc = Process::new(1);
        assert_eq!(sys_isatty(&proc, 0), Ok(1));
    }

    #[test]
    fn test_isatty_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0o644).unwrap();
        assert_eq!(sys_isatty(&proc, fd), Err(Errno::ENOTTY));
    }

    #[test]
    fn test_isatty_invalid_fd() {
        let proc = Process::new(1);
        assert_eq!(sys_isatty(&proc, 99), Err(Errno::EBADF));
    }

    #[test]
    fn test_setenv_getenv() {
        let mut proc = Process::new(1);
        sys_setenv(&mut proc, b"HOME", b"/home/user", true).unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getenv(&proc, b"HOME", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/home/user");
    }

    #[test]
    fn test_setenv_no_overwrite() {
        let mut proc = Process::new(1);
        sys_setenv(&mut proc, b"HOME", b"/home/user", true).unwrap();
        sys_setenv(&mut proc, b"HOME", b"/other", false).unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getenv(&proc, b"HOME", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/home/user");
    }

    #[test]
    fn test_setenv_overwrite() {
        let mut proc = Process::new(1);
        sys_setenv(&mut proc, b"HOME", b"/home/user", true).unwrap();
        sys_setenv(&mut proc, b"HOME", b"/other", true).unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getenv(&proc, b"HOME", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/other");
    }

    #[test]
    fn test_unsetenv() {
        let mut proc = Process::new(1);
        sys_setenv(&mut proc, b"HOME", b"/home/user", true).unwrap();
        sys_unsetenv(&mut proc, b"HOME").unwrap();
        let mut buf = [0u8; 256];
        assert_eq!(sys_getenv(&proc, b"HOME", &mut buf), Err(Errno::ENOENT));
    }

    #[test]
    fn test_getenv_not_found() {
        let proc = Process::new(1);
        let mut buf = [0u8; 256];
        assert_eq!(sys_getenv(&proc, b"NONEXIST", &mut buf), Err(Errno::ENOENT));
    }

    #[test]
    fn test_setenv_rejects_empty_name() {
        let mut proc = Process::new(1);
        assert_eq!(sys_setenv(&mut proc, b"", b"value", true), Err(Errno::EINVAL));
    }

    #[test]
    fn test_setenv_rejects_name_with_equals() {
        let mut proc = Process::new(1);
        assert_eq!(sys_setenv(&mut proc, b"A=B", b"value", true), Err(Errno::EINVAL));
    }

    #[test]
    fn test_mmap_anonymous() {
        let mut proc = Process::new(1);
        let addr = sys_mmap(&mut proc, 0, 4096, 3, 0x22, -1, 0).unwrap(); // PROT_READ|WRITE, MAP_PRIVATE|ANON
        assert_ne!(addr, 0xFFFFFFFF);
    }

    #[test]
    fn test_mmap_file_backed_unsupported() {
        let mut proc = Process::new(1);
        let result = sys_mmap(&mut proc, 0, 4096, 3, 0x02, 3, 0); // MAP_PRIVATE without MAP_ANONYMOUS
        assert_eq!(result, Err(Errno::ENOSYS));
    }

    #[test]
    fn test_munmap() {
        let mut proc = Process::new(1);
        let addr = sys_mmap(&mut proc, 0, 4096, 3, 0x22, -1, 0).unwrap();
        sys_munmap(&mut proc, addr, 0x10000).unwrap();
    }

    #[test]
    fn test_brk_query() {
        let mut proc = Process::new(1);
        let brk = sys_brk(&mut proc, 0);
        assert!(brk > 0);
    }

    #[test]
    fn test_brk_set() {
        let mut proc = Process::new(1);
        let initial = sys_brk(&mut proc, 0);
        let new_brk = sys_brk(&mut proc, initial + 4096);
        assert_eq!(new_brk, initial + 4096);
    }

    #[test]
    fn test_mprotect_returns_enosys() {
        let proc = Process::new(1);
        assert_eq!(sys_mprotect(&proc, 0, 4096, 3), Err(Errno::ENOSYS));
    }
}
