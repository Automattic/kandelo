extern crate alloc;

use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::*;
use wasm_posix_shared::fd_flags::FD_CLOEXEC;
use wasm_posix_shared::fcntl_cmd::*;
use wasm_posix_shared::lock_type::*;
use wasm_posix_shared::flock_op::*;
use wasm_posix_shared::seek::*;
use wasm_posix_shared::mode::S_IFIFO;
use wasm_posix_shared::{WasmFlock, WasmPollFd, WasmStat, WasmTimespec};

use crate::fd::OpenFileDescRef;
use crate::lock::FileLock;
use crate::ofd::FileType;
use crate::pipe::{PipeBuffer, DEFAULT_PIPE_CAPACITY};
use crate::process::{HostIO, Process};
use crate::signal::SignalHandler;
use wasm_posix_shared::signal::{SIG_DFL, SIG_IGN, SIG_BLOCK, SIG_UNBLOCK, SIG_SETMASK, SIGKILL, SIGSTOP, NSIG};
use wasm_posix_shared::mmap::{MAP_ANONYMOUS, MAP_FAILED};

/// Creation flags that are stripped from status_flags after open.
const CREATION_FLAGS: u32 = O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW;

/// Open a file, returning the new file descriptor number.
pub fn sys_open(
    proc: &mut Process,
    host: &mut dyn HostIO,
    path: &[u8],
    oflags: u32,
    mode: u32,
) -> Result<i32, Errno> {
    let effective_mode = if oflags & O_CREAT != 0 {
        mode & !proc.umask
    } else {
        mode
    };
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    let host_handle = host.host_open(&resolved, oflags, effective_mode)?;

    let file_type = if oflags & O_DIRECTORY != 0 {
        FileType::Directory
    } else {
        FileType::Regular
    };

    // Status flags = oflags minus creation-only flags
    let status_flags = oflags & !CREATION_FLAGS;

    let ofd_idx = proc.ofd_table.create(file_type, status_flags, host_handle, resolved);

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

    // Read host_handle, file_type, status_flags, dir_host_handle, and path BEFORE dec_ref
    // (since dec_ref may free the OFD slot).
    let (host_handle, file_type, status_flags, dir_host_handle, path) = {
        let ofd = proc.ofd_table.get(idx).ok_or(Errno::EBADF)?;
        (ofd.host_handle, ofd.file_type, ofd.status_flags, ofd.dir_host_handle, ofd.path.clone())
    };

    // POSIX: closing any fd for a file releases all advisory locks on that file
    // held by this process, regardless of which fd acquired the lock.
    if host_handle >= 0 && file_type != FileType::Pipe && file_type != FileType::Socket {
        proc.lock_table.remove_for_handle(host_handle, proc.pid);
        // Also release in the shared (cross-process) lock table
        if !path.is_empty() {
            let mut dummy = [0u8; 24];
            let _ = host.host_fcntl_lock(
                &path, proc.pid, F_SETLK, F_UNLCK,
                0, 0, &mut dummy,
            );
        }
    }

    let freed = proc.ofd_table.dec_ref(idx);

    if freed {
        match file_type {
            FileType::Pipe => {
                if host_handle >= 0 {
                    // Host-delegated pipe: let host handle cleanup
                    let _ = host.host_close(host_handle);
                } else {
                    // Kernel-internal pipe
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
            }
            FileType::Socket => {
                let sock_idx = (-(host_handle + 1)) as usize;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    if let Some(net_handle) = sock.host_net_handle {
                        let _ = host.host_net_close(net_handle);
                    }
                    if let Some(send_idx) = sock.send_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                            pipe.close_write_end();
                        }
                    }
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get_mut(recv_idx) {
                            pipe.close_read_end();
                        }
                    }
                }
                proc.sockets.free(sock_idx);
            }
            _ => {
                // Close any lazily-opened directory iteration handle
                if dir_host_handle >= 0 {
                    let _ = host.host_closedir(dir_host_handle);
                }
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
    let file_type = ofd.file_type;
    let status_flags = ofd.status_flags;

    match file_type {
        FileType::Pipe => {
            if host_handle >= 0 {
                // Host-delegated pipe (cross-process): use host_read
                let n = host.host_read(host_handle, buf)?;
                Ok(n)
            } else {
                // Kernel-internal pipe
                let pipe_idx = (-(host_handle + 1)) as usize;
                loop {
                    let pipe = proc
                        .pipes
                        .get_mut(pipe_idx)
                        .and_then(|p| p.as_mut())
                        .ok_or(Errno::EBADF)?;
                    let n = pipe.read(buf);
                    if n > 0 {
                        return Ok(n);
                    }
                    if !pipe.is_write_end_open() {
                        return Ok(0); // EOF — write end closed
                    }
                    if status_flags & O_NONBLOCK != 0 {
                        return Err(Errno::EAGAIN);
                    }
                    // Block: check for signals then sleep 1ms
                    if proc.signals.deliverable() != 0 {
                        if !proc.signals.should_restart() {
                            return Err(Errno::EINTR);
                        }
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                }
            }
        }
        FileType::Socket => {
            use crate::socket::SocketDomain;
            let sock_idx = (-(host_handle + 1)) as usize;
            let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
            if sock.shut_rd {
                return Ok(0);
            }
            match sock.domain {
                SocketDomain::Inet | SocketDomain::Inet6 => {
                    let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
                    host.host_net_recv(net_handle, buf.len() as u32, 0, buf)
                }
                SocketDomain::Unix => {
                    let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
                    loop {
                        let pipe = proc
                            .pipes
                            .get_mut(recv_buf_idx)
                            .and_then(|p| p.as_mut())
                            .ok_or(Errno::EBADF)?;
                        let n = pipe.read(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                        if !pipe.is_write_end_open() {
                            return Ok(0); // EOF — peer closed
                        }
                        if status_flags & O_NONBLOCK != 0 {
                            return Err(Errno::EAGAIN);
                        }
                        if proc.signals.deliverable() != 0 {
                            if !proc.signals.should_restart() {
                                return Err(Errno::EINTR);
                            }
                        }
                        let _ = host.host_nanosleep(0, 1_000_000);
                    }
                }
            }
        }
        _ => {
            let n = host.host_read(host_handle, buf)?;
            if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                ofd.offset += n as i64;
            }
            Ok(n)
        }
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
    let file_type = ofd.file_type;
    let status_flags = ofd.status_flags;

    match file_type {
        FileType::Pipe => {
            if host_handle >= 0 {
                // Host-delegated pipe (cross-process): use host_write
                let n = host.host_write(host_handle, buf)?;
                Ok(n)
            } else {
                // Kernel-internal pipe
                let pipe_idx = (-(host_handle + 1)) as usize;
                loop {
                    let pipe = proc
                        .pipes
                        .get_mut(pipe_idx)
                        .and_then(|p| p.as_mut())
                        .ok_or(Errno::EBADF)?;
                    if !pipe.is_read_end_open() {
                        proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                        return Err(Errno::EPIPE);
                    }
                    let n = pipe.write(buf);
                    if n > 0 {
                        return Ok(n);
                    }
                    if status_flags & O_NONBLOCK != 0 {
                        return Err(Errno::EAGAIN);
                    }
                    // Block: check for signals then sleep 1ms
                    if proc.signals.deliverable() != 0 {
                        if !proc.signals.should_restart() {
                            return Err(Errno::EINTR);
                        }
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                }
            }
        }
        FileType::Socket => {
            use crate::socket::SocketDomain;
            let sock_idx = (-(host_handle + 1)) as usize;
            let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
            if sock.shut_wr {
                proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                return Err(Errno::EPIPE);
            }
            match sock.domain {
                SocketDomain::Inet | SocketDomain::Inet6 => {
                    let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
                    host.host_net_send(net_handle, buf, 0)
                }
                SocketDomain::Unix => {
                    let send_buf_idx = sock.send_buf_idx.ok_or(Errno::ENOTCONN)?;
                    loop {
                        let pipe = proc
                            .pipes
                            .get_mut(send_buf_idx)
                            .and_then(|p| p.as_mut())
                            .ok_or(Errno::EBADF)?;
                        if !pipe.is_read_end_open() {
                            proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                            return Err(Errno::EPIPE);
                        }
                        let n = pipe.write(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                        if status_flags & O_NONBLOCK != 0 {
                            return Err(Errno::EAGAIN);
                        }
                        if proc.signals.deliverable() != 0 {
                            if !proc.signals.should_restart() {
                                return Err(Errno::EINTR);
                            }
                        }
                        let _ = host.host_nanosleep(0, 1_000_000);
                    }
                }
            }
        }
        _ => {
            // O_APPEND: seek to end before writing (POSIX atomicity for single-process)
            if status_flags & O_APPEND != 0 {
                let end = host.host_seek(host_handle, 0, 2)?; // SEEK_END
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.offset = end;
                }
            }
            // RLIMIT_FSIZE: check if write would exceed file size limit
            let fsize_limit = proc.rlimits[1][0]; // RLIMIT_FSIZE soft limit
            if fsize_limit != u64::MAX {
                let current_offset = proc.ofd_table.get(ofd_idx).map_or(0, |o| o.offset);
                let end_pos = current_offset as u64 + buf.len() as u64;
                if end_pos > fsize_limit {
                    proc.signals.raise(wasm_posix_shared::signal::SIGXFSZ);
                    return Err(Errno::EFBIG);
                }
            }
            let n = host.host_write(host_handle, buf)?;
            if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                ofd.offset += n as i64;
            }
            Ok(n)
        }
    }
}

/// Seek to a position in a file, returning the new offset.
pub fn sys_lseek(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    offset: i64,
    whence: u32,
) -> Result<i64, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;

    // Pipes are not seekable.
    if ofd.file_type == FileType::Pipe || ofd.file_type == FileType::Socket {
        return Err(Errno::ESPIPE);
    }

    let new_offset = match whence {
        SEEK_SET => {
            host.host_seek(ofd.host_handle, offset, whence)?;
            offset
        }
        SEEK_CUR => {
            let pos = ofd.offset + offset;
            host.host_seek(ofd.host_handle, pos, SEEK_SET)?;
            pos
        }
        SEEK_END => host.host_seek(ofd.host_handle, offset, whence)?,
        _ => return Err(Errno::EINVAL),
    };

    if new_offset < 0 {
        return Err(Errno::EINVAL);
    }

    ofd.offset = new_offset;
    Ok(new_offset)
}

/// Read from a file descriptor at a given offset without modifying the file position.
pub fn sys_pread(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    offset: i64,
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_WRONLY {
        return Err(Errno::EBADF);
    }

    // pread is only valid for seekable fds (not pipes or sockets)
    if ofd.file_type == FileType::Pipe || ofd.file_type == FileType::Socket {
        return Err(Errno::ESPIPE);
    }

    let host_handle = ofd.host_handle;
    let saved_offset = ofd.offset;

    // Seek to the requested offset, read, then restore.
    // Single-threaded, so save/seek/read/restore is safe.
    host.host_seek(host_handle, offset, SEEK_SET)?;
    let n = host.host_read(host_handle, buf)?;
    host.host_seek(host_handle, saved_offset, SEEK_SET)?;

    Ok(n)
}

/// Write to a file descriptor at a given offset without modifying the file position.
pub fn sys_pwrite(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    offset: i64,
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_RDONLY {
        return Err(Errno::EBADF);
    }

    if ofd.file_type == FileType::Pipe || ofd.file_type == FileType::Socket {
        return Err(Errno::ESPIPE);
    }

    let host_handle = ofd.host_handle;
    let saved_offset = ofd.offset;

    host.host_seek(host_handle, offset, SEEK_SET)?;
    let n = host.host_write(host_handle, buf)?;
    host.host_seek(host_handle, saved_offset, SEEK_SET)?;

    Ok(n)
}

/// preadv -- scatter-gather read at offset.
/// Reads into multiple buffers from a file descriptor at the given offset
/// without modifying the file position.
pub fn sys_preadv(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    iovecs: &mut [&mut [u8]],
    offset: i64,
) -> Result<usize, Errno> {
    let mut total = 0usize;
    let mut cur_offset = offset;
    for buf in iovecs.iter_mut() {
        if buf.is_empty() {
            continue;
        }
        let n = sys_pread(proc, host, fd, *buf, cur_offset)?;
        total += n;
        cur_offset += n as i64;
        if n < buf.len() || n == 0 {
            break; // Short read or EOF
        }
    }
    Ok(total)
}

/// pwritev -- scatter-gather write at offset.
/// Writes from multiple buffers to a file descriptor at the given offset
/// without modifying the file position.
pub fn sys_pwritev(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    iovecs: &[&[u8]],
    offset: i64,
) -> Result<usize, Errno> {
    let mut total = 0usize;
    let mut cur_offset = offset;
    for buf in iovecs {
        if buf.is_empty() {
            continue;
        }
        let n = sys_pwrite(proc, host, fd, buf, cur_offset)?;
        total += n;
        cur_offset += n as i64;
        if n < buf.len() {
            break; // Short write
        }
    }
    Ok(total)
}

/// sendfile -- copy data between file descriptors.
/// Emulated with read+write since we don't have zero-copy support.
/// If offset_ptr is provided (non-negative), reads from that offset without
/// changing the in_fd's position. Otherwise reads from current position.
pub fn sys_sendfile(
    proc: &mut Process,
    host: &mut dyn HostIO,
    out_fd: i32,
    in_fd: i32,
    offset: i64,
    count: usize,
) -> Result<usize, Errno> {
    let mut total = 0usize;
    let mut buf = [0u8; 4096];
    let mut cur_offset = offset;

    while total < count {
        let to_read = (count - total).min(buf.len());
        let n = if offset >= 0 {
            let n = sys_pread(proc, host, in_fd, &mut buf[..to_read], cur_offset)?;
            cur_offset += n as i64;
            n
        } else {
            sys_read(proc, host, in_fd, &mut buf[..to_read])?
        };

        if n == 0 {
            break; // EOF
        }

        let written = sys_write(proc, host, out_fd, &buf[..n])?;
        total += written;
        if written < n {
            break; // Short write
        }
    }
    Ok(total)
}

/// statx -- extended file status.
/// Delegates to fstatat and fills the statx structure from WasmStat.
pub fn sys_statx(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    flags: u32,
    _mask: u32,
) -> Result<WasmStat, Errno> {
    // statx is essentially fstatat with extra fields we don't track
    sys_fstatat(proc, host, dirfd, path, flags)
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

/// Duplicate a file descriptor to a specific fd number with flags.
/// Unlike dup2, returns EINVAL if oldfd == newfd.
pub fn sys_dup3(
    proc: &mut Process,
    host: &mut dyn HostIO,
    oldfd: i32,
    newfd: i32,
    flags: u32,
) -> Result<i32, Errno> {
    if oldfd == newfd {
        return Err(Errno::EINVAL);
    }

    // Reuse dup2 logic: close newfd if open, then dup oldfd to newfd.
    let result = sys_dup2(proc, host, oldfd, newfd)?;

    // Apply O_CLOEXEC flag to the new fd.
    if flags & O_CLOEXEC != 0 {
        if let Ok(entry) = proc.fd_table.get_mut(newfd) {
            entry.fd_flags = FD_CLOEXEC;
        }
    }

    Ok(result)
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
    let read_ofd = proc.ofd_table.create(FileType::Pipe, O_RDONLY, pipe_handle, b"/dev/pipe".to_vec());
    let write_ofd = proc.ofd_table.create(FileType::Pipe, O_WRONLY, pipe_handle, b"/dev/pipe".to_vec());

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

/// Create a pipe with flags (O_NONBLOCK, O_CLOEXEC).
pub fn sys_pipe2(proc: &mut Process, flags: u32) -> Result<(i32, i32), Errno> {
    let (read_fd, write_fd) = sys_pipe(proc)?;

    if flags & O_CLOEXEC != 0 {
        if let Ok(entry) = proc.fd_table.get_mut(read_fd) {
            entry.fd_flags = FD_CLOEXEC;
        }
        if let Ok(entry) = proc.fd_table.get_mut(write_fd) {
            entry.fd_flags = FD_CLOEXEC;
        }
    }

    if flags & O_NONBLOCK != 0 {
        let read_ofd_idx = proc.fd_table.get(read_fd)?.ofd_ref.0;
        let write_ofd_idx = proc.fd_table.get(write_fd)?.ofd_ref.0;
        if let Some(ofd) = proc.ofd_table.get_mut(read_ofd_idx) {
            ofd.status_flags |= O_NONBLOCK;
        }
        if let Some(ofd) = proc.ofd_table.get_mut(write_ofd_idx) {
            ofd.status_flags |= O_NONBLOCK;
        }
    }

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
        let mut st = host.host_fstat(ofd.host_handle)?;
        st.st_uid = proc.euid;
        st.st_gid = proc.egid;
        Ok(st)
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
        F_SETOWN => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_idx = entry.ofd_ref.0;
            let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
            ofd.owner_pid = arg;
            Ok(0)
        }
        F_GETOWN => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_idx = entry.ofd_ref.0;
            let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
            Ok(ofd.owner_pid as i32)
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
    host: &mut dyn HostIO,
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

    // For host-backed files, delegate to the shared lock table via host import
    if host_handle >= 0 && !ofd.path.is_empty() {
        // Access mode check
        if cmd == F_SETLK || cmd == F_SETLKW {
            let access_mode = ofd.status_flags & O_ACCMODE;
            if flock.l_type == F_RDLCK && access_mode == O_WRONLY {
                return Err(Errno::EBADF);
            }
            if flock.l_type == F_WRLCK && access_mode == O_RDONLY {
                return Err(Errno::EBADF);
            }
        }
        let path = &ofd.path;
        let mut result_buf = [0u8; 24];
        host.host_fcntl_lock(
            path, proc.pid, cmd, flock.l_type,
            start, flock.l_len, &mut result_buf,
        )?;
        // For F_GETLK, parse result_buf back into flock
        if cmd == F_GETLK {
            flock.l_type = u32::from_le_bytes(result_buf[0..4].try_into().unwrap());
            if flock.l_type != F_UNLCK {
                flock.l_pid = u32::from_le_bytes(result_buf[4..8].try_into().unwrap());
                flock.l_start = i64::from_le_bytes(result_buf[8..16].try_into().unwrap());
                flock.l_len = i64::from_le_bytes(result_buf[16..24].try_into().unwrap());
                flock.l_whence = 0;
            }
        }
        return Ok(());
    }

    // Fallback: use local lock_table for non-host files (pipes, etc.)
    match cmd {
        F_GETLK => {
            match proc
                .lock_table
                .get_blocking_lock(host_handle, flock.l_type, start, flock.l_len, proc.pid)
            {
                Some(blocking) => {
                    flock.l_type = blocking.lock_type;
                    flock.l_start = blocking.start;
                    flock.l_len = blocking.len;
                    flock.l_pid = blocking.pid;
                    flock.l_whence = 0;
                }
                None => {
                    flock.l_type = F_UNLCK;
                }
            }
            Ok(())
        }
        F_SETLK | F_SETLKW => {
            let access_mode = ofd.status_flags & O_ACCMODE;
            if flock.l_type == F_RDLCK && access_mode == O_WRONLY {
                return Err(Errno::EBADF);
            }
            if flock.l_type == F_WRLCK && access_mode == O_RDONLY {
                return Err(Errno::EBADF);
            }

            if flock.l_type == F_UNLCK {
                let lock = FileLock {
                    pid: proc.pid,
                    lock_type: F_UNLCK,
                    start,
                    len: flock.l_len,
                };
                proc.lock_table.set_lock(host_handle, lock);
                return Ok(());
            }

            if proc
                .lock_table
                .get_blocking_lock(host_handle, flock.l_type, start, flock.l_len, proc.pid)
                .is_some()
            {
                if cmd == F_SETLK {
                    return Err(Errno::EAGAIN);
                }
                return Err(Errno::ENOSYS);
            }

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

/// BSD flock() — whole-file locking mapped to fcntl advisory locks.
///
/// Maps LOCK_SH/LOCK_EX/LOCK_UN to F_RDLCK/F_WRLCK/F_UNLCK on the entire file.
/// LOCK_NB flag switches from F_SETLKW (blocking) to F_SETLK (non-blocking).
pub fn sys_flock(proc: &mut Process, fd: i32, operation: u32, host: &mut dyn HostIO) -> Result<(), Errno> {
    let nonblock = operation & LOCK_NB != 0;
    let op = operation & !LOCK_NB;

    let lock_type = match op {
        LOCK_SH => F_RDLCK,
        LOCK_EX => F_WRLCK,
        LOCK_UN => F_UNLCK,
        _ => return Err(Errno::EINVAL),
    };

    let cmd = if lock_type == F_UNLCK || nonblock { F_SETLK } else { F_SETLKW };

    let mut flock = WasmFlock {
        l_type: lock_type,
        l_whence: 0, // SEEK_SET
        l_start: 0,
        l_len: 0, // 0 means entire file
        l_pid: proc.pid,
        _pad: 0,
    };

    sys_fcntl_lock(proc, fd, cmd, &mut flock, host)
}

use wasm_posix_shared::WasmDirent;
use crate::process::{DirStream, ProcessState};
use crate::path::resolve_path;

pub fn sys_stat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    let mut st = host.host_stat(&resolved)?;
    st.st_uid = proc.euid;
    st.st_gid = proc.egid;
    Ok(st)
}

pub fn sys_lstat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    let mut st = host.host_lstat(&resolved)?;
    st.st_uid = proc.euid;
    st.st_gid = proc.egid;
    Ok(st)
}

pub fn sys_mkdir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8], mode: u32) -> Result<(), Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    let effective_mode = mode & !proc.umask;
    host.host_mkdir(&resolved, effective_mode)
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

/// Change directory by file descriptor.
pub fn sys_fchdir(proc: &mut Process, fd: i32) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Directory {
        return Err(Errno::ENOTDIR);
    }
    proc.cwd = ofd.path.clone();
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
    let stream = DirStream { host_handle, path: resolved, position: 0 };

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
            // Increment position
            if let Some(stream) = proc.dir_streams.get_mut(idx).and_then(|s| s.as_mut()) {
                stream.position += 1;
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

/// Rewind a directory stream to the beginning.
pub fn sys_rewinddir(proc: &mut Process, host: &mut dyn HostIO, dir_handle: i32) -> Result<(), Errno> {
    let idx = dir_handle as usize;
    let stream = proc.dir_streams.get(idx).and_then(|s| s.as_ref()).ok_or(Errno::EBADF)?;
    let path = stream.path.clone();
    let old_handle = stream.host_handle;

    host.host_closedir(old_handle)?;
    let new_handle = host.host_opendir(&path)?;

    let stream = proc.dir_streams.get_mut(idx).and_then(|s| s.as_mut()).ok_or(Errno::EBADF)?;
    stream.host_handle = new_handle;
    stream.position = 0;
    Ok(())
}

/// Return the current position in a directory stream.
pub fn sys_telldir(proc: &Process, dir_handle: i32) -> Result<u64, Errno> {
    let idx = dir_handle as usize;
    let stream = proc.dir_streams.get(idx).and_then(|s| s.as_ref()).ok_or(Errno::EBADF)?;
    Ok(stream.position)
}

/// Seek to a position in a directory stream.
pub fn sys_seekdir(proc: &mut Process, host: &mut dyn HostIO, dir_handle: i32, loc: u64) -> Result<(), Errno> {
    // Rewind to beginning, then skip `loc` entries
    sys_rewinddir(proc, host, dir_handle)?;
    let idx = dir_handle as usize;
    let mut name_buf = [0u8; 256];
    for _ in 0..loc {
        let stream = proc.dir_streams.get(idx).and_then(|s| s.as_ref()).ok_or(Errno::EBADF)?;
        let handle = stream.host_handle;
        match host.host_readdir(handle, &mut name_buf)? {
            Some(_) => {},
            None => break, // past end of directory
        }
    }
    if let Some(stream) = proc.dir_streams.get_mut(idx).and_then(|s| s.as_mut()) {
        stream.position = loc;
    }
    Ok(())
}

/// getdents64 — read directory entries in linux_dirent64 format.
/// This is called by musl's readdir() via SYS_getdents64.
/// Takes an fd opened with O_DIRECTORY.
///
/// linux_dirent64 layout (per entry):
///   u64  d_ino       (8 bytes)
///   i64  d_off       (8 bytes) — offset to next entry
///   u16  d_reclen    (2 bytes) — total size of this entry
///   u8   d_type      (1 byte)
///   char d_name[]    (null-terminated, padded to 8-byte alignment)
pub fn sys_getdents64(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if ofd.file_type != FileType::Directory {
        return Err(Errno::ENOTDIR);
    }

    let path = ofd.path.clone();

    // Lazily open the directory for iteration
    let dir_handle = {
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        ofd.dir_host_handle
    };

    if dir_handle == -2 {
        // Already exhausted — return 0 (EOF)
        return Ok(0);
    }

    let dir_handle = if dir_handle == -1 {
        // Open the directory for iteration
        let h = host.host_opendir(&path)?;
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_host_handle = h;
        }
        h
    } else {
        dir_handle
    };

    let mut pos = 0usize;
    let mut name_buf = [0u8; 256];
    let mut entry_count = 0i64;

    loop {
        match host.host_readdir(dir_handle, &mut name_buf)? {
            Some((d_ino, d_type, name_len)) => {
                // Calculate entry size: 19 bytes fixed + name + null + padding to 8-byte align
                let reclen_raw = 19 + name_len + 1; // d_ino(8) + d_off(8) + d_reclen(2) + d_type(1) + name + null
                let reclen = (reclen_raw + 7) & !7; // align to 8 bytes

                if pos + reclen > buf.len() {
                    if pos == 0 {
                        return Err(Errno::EINVAL); // buffer too small for even one entry
                    }
                    // Can't fit more entries; stop and return what we have.
                    // We need to "push back" this entry. Since host_readdir is stateful,
                    // we can't un-read. We'll close and mark as needing re-iteration.
                    // This is a simplification — real getdents uses a seekable dir position.
                    break;
                }

                entry_count += 1;

                // Write d_ino (u64 LE)
                buf[pos..pos + 8].copy_from_slice(&d_ino.to_le_bytes());
                // Write d_off (i64 LE) — use entry count as offset
                buf[pos + 8..pos + 16].copy_from_slice(&entry_count.to_le_bytes());
                // Write d_reclen (u16 LE)
                buf[pos + 16..pos + 18].copy_from_slice(&(reclen as u16).to_le_bytes());
                // Write d_type (u8)
                buf[pos + 18] = d_type as u8;
                // Write d_name (null-terminated)
                buf[pos + 19..pos + 19 + name_len].copy_from_slice(&name_buf[..name_len]);
                buf[pos + 19 + name_len] = 0; // null terminator
                // Zero-fill padding
                for i in pos + 19 + name_len + 1..pos + reclen {
                    buf[i] = 0;
                }

                pos += reclen;
            }
            None => {
                // End of directory — mark as exhausted
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.dir_host_handle = -2;
                }
                // Close the host dir handle
                let _ = host.host_closedir(dir_handle);
                break;
            }
        }
    }

    Ok(pos)
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

/// getpgrp -- get process group ID.
pub fn sys_getpgrp(proc: &Process) -> u32 {
    proc.pgid
}

/// setpgid -- set process group ID.
/// pid=0 means current process, pgid=0 means use pid as pgid.
pub fn sys_setpgid(proc: &mut Process, pid: u32, pgid: u32) -> Result<(), Errno> {
    // Only support setting own pgid (single-process)
    if pid != 0 && pid != proc.pid {
        return Err(Errno::ESRCH);
    }
    let new_pgid = if pgid == 0 { proc.pid } else { pgid };
    proc.pgid = new_pgid;
    Ok(())
}

/// getsid -- get session ID.
pub fn sys_getsid(proc: &Process, pid: u32) -> Result<u32, Errno> {
    if pid != 0 && pid != proc.pid {
        return Err(Errno::ESRCH);
    }
    Ok(proc.sid)
}

/// setsid -- create session and set process group ID.
pub fn sys_setsid(proc: &mut Process) -> Result<u32, Errno> {
    // POSIX: fail with EPERM if the calling process is already a session leader
    if proc.sid == proc.pid {
        return Err(Errno::EPERM);
    }
    proc.sid = proc.pid;
    proc.pgid = proc.pid;
    Ok(proc.sid)
}

/// Send a signal to a process.
/// If pid matches current process, is 0 (process group), or is the negative of our pgid,
/// raises locally. Otherwise delegates to host for cross-process delivery.
pub fn sys_kill(proc: &mut Process, host: &mut dyn HostIO, pid: i32, sig: u32) -> Result<(), Errno> {
    if sig >= NSIG && sig != 0 {
        return Err(Errno::EINVAL);
    }
    let is_local = pid == proc.pid as i32 || pid == 0 || pid == -(proc.pgid as i32);
    if sig == 0 {
        // sig=0 is a validity/existence check. Local always succeeds.
        // For remote pids, delegate to host so it can return ESRCH if needed.
        if is_local {
            return Ok(());
        } else {
            return host.host_kill(pid, sig);
        }
    }
    if is_local {
        proc.signals.raise(sig);
        Ok(())
    } else {
        host.host_kill(pid, sig)
    }
}

/// Send a signal to the current process.
pub fn sys_raise(proc: &mut Process, host: &mut dyn HostIO, sig: u32) -> Result<(), Errno> {
    sys_kill(proc, host, proc.pid as i32, sig)
}

/// Execute a new program. Delegates to host for binary loading.
/// On success, the kernel process will be replaced (POSIX: exec doesn't return on success).
/// On failure, returns the error.
pub fn sys_execve(_proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    if path.is_empty() {
        return Err(Errno::ENOENT);
    }
    host.host_exec(path)
}

/// Schedule a SIGALRM signal after `seconds` seconds.
/// Returns the number of seconds remaining from a previously scheduled alarm, or 0.
/// If `seconds` is 0, any pending alarm is cancelled.
pub fn sys_alarm(proc: &mut Process, host: &mut dyn HostIO, seconds: u32) -> Result<u32, Errno> {
    let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)?;
    let now_ns = (sec as u64).wrapping_mul(1_000_000_000).wrapping_add(nsec as u64);

    // Compute remaining seconds from previous alarm (rounded up)
    let remaining = if proc.alarm_deadline_ns > now_ns {
        ((proc.alarm_deadline_ns - now_ns + 999_999_999) / 1_000_000_000) as u32
    } else {
        0
    };

    // Set new deadline
    if seconds > 0 {
        proc.alarm_deadline_ns = now_ns + (seconds as u64) * 1_000_000_000;
    } else {
        proc.alarm_deadline_ns = 0;
    }

    // Tell host to schedule/cancel timer
    host.host_set_alarm(seconds)?;

    Ok(remaining)
}

/// setitimer -- set an interval timer.
///
/// ITIMER_REAL (0): delivers SIGALRM based on wall clock time, using the existing
/// host_set_alarm mechanism. Stores interval for repeating timers.
/// ITIMER_VIRTUAL (1) / ITIMER_PROF (2): no-op (no CPU time tracking in Wasm).
///
/// `new_value` is (interval_sec, interval_usec, value_sec, value_usec).
/// Returns the old timer value as (interval_sec, interval_usec, value_sec, value_usec).
pub fn sys_setitimer(
    proc: &mut Process,
    host: &mut dyn HostIO,
    which: u32,
    new_interval_sec: i64,
    new_interval_usec: i64,
    new_value_sec: i64,
    new_value_usec: i64,
) -> Result<(i64, i64, i64, i64), Errno> {
    // First, get old value (same as getitimer)
    let old = sys_getitimer(proc, host, which)?;

    match which {
        0 => {
            // ITIMER_REAL
            let interval_ns = (new_interval_sec as u64) * 1_000_000_000
                + (new_interval_usec as u64) * 1_000;
            let value_ns = (new_value_sec as u64) * 1_000_000_000
                + (new_value_usec as u64) * 1_000;

            proc.alarm_interval_ns = interval_ns;

            if value_ns > 0 {
                let (sec, nsec) = host.host_clock_gettime(
                    wasm_posix_shared::clock::CLOCK_MONOTONIC,
                )?;
                let now_ns = (sec as u64).wrapping_mul(1_000_000_000)
                    .wrapping_add(nsec as u64);
                proc.alarm_deadline_ns = now_ns + value_ns;

                // Convert to whole seconds for host_set_alarm (round up)
                let alarm_secs = ((value_ns + 999_999_999) / 1_000_000_000) as u32;
                let alarm_secs = if alarm_secs == 0 { 1 } else { alarm_secs };
                host.host_set_alarm(alarm_secs)?;
            } else {
                proc.alarm_deadline_ns = 0;
                proc.alarm_interval_ns = 0;
                host.host_set_alarm(0)?;
            }

            Ok(old)
        }
        1 | 2 => {
            // ITIMER_VIRTUAL / ITIMER_PROF: no-op
            Ok(old)
        }
        _ => Err(Errno::EINVAL),
    }
}

/// getitimer -- get the current value of an interval timer.
///
/// Returns (interval_sec, interval_usec, value_sec, value_usec).
pub fn sys_getitimer(
    proc: &mut Process,
    host: &mut dyn HostIO,
    which: u32,
) -> Result<(i64, i64, i64, i64), Errno> {
    match which {
        0 => {
            // ITIMER_REAL
            let interval_sec = (proc.alarm_interval_ns / 1_000_000_000) as i64;
            let interval_usec = ((proc.alarm_interval_ns % 1_000_000_000) / 1_000) as i64;

            if proc.alarm_deadline_ns == 0 {
                return Ok((interval_sec, interval_usec, 0, 0));
            }

            let (sec, nsec) = host.host_clock_gettime(
                wasm_posix_shared::clock::CLOCK_MONOTONIC,
            )?;
            let now_ns = (sec as u64).wrapping_mul(1_000_000_000)
                .wrapping_add(nsec as u64);

            let remaining_ns = if proc.alarm_deadline_ns > now_ns {
                proc.alarm_deadline_ns - now_ns
            } else {
                0
            };

            let value_sec = (remaining_ns / 1_000_000_000) as i64;
            let value_usec = ((remaining_ns % 1_000_000_000) / 1_000) as i64;

            Ok((interval_sec, interval_usec, value_sec, value_usec))
        }
        1 | 2 => {
            // ITIMER_VIRTUAL / ITIMER_PROF: always zero
            Ok((0, 0, 0, 0))
        }
        _ => Err(Errno::EINVAL),
    }
}

/// rt_sigtimedwait -- wait for a signal from a specified set.
///
/// Checks if any signal in `mask` is already pending and dequeues it.
/// If `timeout_ms` >= 0, waits up to that many milliseconds for a signal.
/// If `timeout_ms` < 0, waits indefinitely.
/// Returns the signal number on success, or EAGAIN on timeout.
pub fn sys_sigtimedwait(
    proc: &mut Process,
    host: &mut dyn HostIO,
    mask: u64,
    timeout_ms: i32,
) -> Result<u32, Errno> {
    use wasm_posix_shared::signal::NSIG;

    // Check if any signal in mask is already pending
    let pending_in_mask = proc.signals.pending & mask;
    if pending_in_mask != 0 {
        // Dequeue the lowest numbered signal
        for sig in 1..NSIG {
            if pending_in_mask & (1u64 << sig) != 0 {
                proc.signals.pending &= !(1u64 << sig);
                return Ok(sig);
            }
        }
    }

    if timeout_ms == 0 {
        return Err(Errno::EAGAIN);
    }

    // Wait with 1ms sleep intervals, checking for signals
    let iterations = if timeout_ms < 0 { i32::MAX } else { timeout_ms };
    for _ in 0..iterations {
        host.host_nanosleep(0, 1_000_000)?; // 1ms

        let pending_in_mask = proc.signals.pending & mask;
        if pending_in_mask != 0 {
            for sig in 1..NSIG {
                if pending_in_mask & (1u64 << sig) != 0 {
                    proc.signals.pending &= !(1u64 << sig);
                    return Ok(sig);
                }
            }
        }
    }

    Err(Errno::EAGAIN)
}

/// sigsuspend -- temporarily replace the signal mask and suspend until a signal is delivered.
///
/// Atomically replaces the process's signal mask with `mask` (SIGKILL and SIGSTOP cannot
/// be blocked), then blocks until a deliverable signal arrives. The original mask is
/// restored before returning. Always returns Err(EINTR).
pub fn sys_sigsuspend(proc: &mut Process, host: &mut dyn HostIO, mask: u64) -> Result<(), Errno> {
    use wasm_posix_shared::signal::{NSIG, SIGKILL, SIGSTOP};

    let old_mask = proc.signals.blocked;
    // Cannot block SIGKILL or SIGSTOP
    proc.signals.blocked = mask & !((1u64 << SIGKILL) | (1u64 << SIGSTOP));

    // Check if any signals are already deliverable with new mask
    if proc.signals.deliverable() != 0 {
        proc.signals.blocked = old_mask;
        return Err(Errno::EINTR);
    }

    // Block until a deliverable signal arrives
    loop {
        let sig = match host.host_sigsuspend_wait() {
            Ok(s) => s,
            Err(_) => {
                // Restore mask even on host error
                proc.signals.blocked = old_mask;
                return Err(Errno::EINTR);
            }
        };
        if sig > 0 && sig < NSIG {
            proc.signals.raise(sig);
        }
        if proc.signals.deliverable() != 0 {
            break;
        }
    }

    proc.signals.blocked = old_mask;
    Err(Errno::EINTR)
}

/// pause -- suspend until a signal is delivered.
///
/// Equivalent to sigsuspend with the current signal mask (blocks until any
/// unblocked signal arrives). Always returns EINTR.
pub fn sys_pause(proc: &mut Process, host: &mut dyn HostIO) -> Result<(), Errno> {
    let current_mask = proc.signals.blocked;
    sys_sigsuspend(proc, host, current_mask)
}

/// Set signal action. Accepts full sigaction struct fields.
/// Returns the old action as (handler, flags, mask).
pub fn sys_sigaction(
    proc: &mut Process,
    sig: u32,
    handler_val: u32,
    flags: u32,
    mask: u64,
) -> Result<(u32, u32, u64), Errno> {
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

    let new_action = crate::signal::SignalAction {
        handler: new_handler,
        flags,
        mask,
    };

    let old = proc.signals.set_action(sig, new_action)
        .map_err(|_| Errno::EINVAL)?;

    let old_handler_val = match old.handler {
        SignalHandler::Default => SIG_DFL,
        SignalHandler::Ignore => SIG_IGN,
        SignalHandler::Handler(ptr) => ptr,
    };

    Ok((old_handler_val, old.flags, old.mask))
}

/// signal() — set signal handler (legacy API, wraps sigaction semantics)
/// Returns previous handler value: SIG_DFL=0, SIG_IGN=1, or function pointer
pub fn sys_signal(proc: &mut Process, signum: u32, handler_val: u32) -> Result<i32, Errno> {
    let new_handler = match handler_val {
        SIG_DFL => SignalHandler::Default,
        SIG_IGN => SignalHandler::Ignore,
        ptr => SignalHandler::Handler(ptr),
    };

    let old = proc.signals.set_handler(signum, new_handler)
        .map_err(|_| Errno::EINVAL)?;

    let old_val = match old {
        SignalHandler::Default => SIG_DFL as i32,
        SignalHandler::Ignore => SIG_IGN as i32,
        SignalHandler::Handler(ptr) => ptr as i32,
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

    // POSIX: all advisory locks held by the process are released on exit.
    proc.lock_table.remove_all_for_pid(proc.pid);

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

/// Get clock resolution. Returns hardcoded values since Wasm doesn't
/// have sub-millisecond timer guarantees.
pub fn sys_clock_getres(
    _proc: &Process,
    clock_id: u32,
) -> Result<WasmTimespec, Errno> {
    use wasm_posix_shared::clock::*;
    match clock_id {
        CLOCK_REALTIME | CLOCK_MONOTONIC => {
            Ok(WasmTimespec { tv_sec: 0, tv_nsec: 1_000_000 }) // 1ms
        }
        _ => Err(Errno::EINVAL),
    }
}

/// Sleep using a specific clock. Only relative (TIMER_RELTIME=0) mode
/// is supported — absolute mode returns ENOTSUP.
pub fn sys_clock_nanosleep(
    _proc: &Process,
    host: &mut dyn HostIO,
    clock_id: u32,
    flags: u32,
    req: &WasmTimespec,
) -> Result<(), Errno> {
    use wasm_posix_shared::clock::*;
    // Validate clock_id
    if clock_id != CLOCK_REALTIME && clock_id != CLOCK_MONOTONIC {
        return Err(Errno::EINVAL);
    }
    // Only support relative sleep (flags == 0 means TIMER_RELTIME)
    const TIMER_ABSTIME: u32 = 1;
    if flags & TIMER_ABSTIME != 0 {
        return Err(Errno::EOPNOTSUPP);
    }
    // Validate timespec
    if req.tv_sec < 0 || req.tv_nsec < 0 || req.tv_nsec >= 1_000_000_000 {
        return Err(Errno::EINVAL);
    }
    host.host_nanosleep(req.tv_sec, req.tv_nsec)
}

/// Set file timestamps. Delegates to host.
pub fn sys_utimensat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    times: Option<&[WasmTimespec; 2]>,
    _flags: u32,
) -> Result<(), Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;

    // Default: set both to current time
    let (atime_sec, atime_nsec, mtime_sec, mtime_nsec) = if let Some(ts) = times {
        (ts[0].tv_sec, ts[0].tv_nsec, ts[1].tv_sec, ts[1].tv_nsec)
    } else {
        // NULL times = set both to current time
        let (sec, nsec) = host.host_clock_gettime(0)?; // CLOCK_REALTIME
        (sec, nsec, sec, nsec)
    };

    host.host_utimensat(&resolved, atime_sec, atime_nsec, mtime_sec, mtime_nsec)
}

/// Memory advice hint. No-op in Wasm — there's no virtual memory paging.
pub fn sys_madvise(
    _proc: &mut Process,
    _addr: u32,
    _len: u32,
    _advice: u32,
) -> Result<(), Errno> {
    Ok(())
}

/// Remap a memory mapping. Not supported in Wasm — returns ENOSYS.
pub fn sys_mremap(
    _proc: &mut Process,
    _old_addr: u32,
    _old_len: u32,
    _new_len: u32,
    _flags: u32,
) -> Result<u32, Errno> {
    Err(Errno::ENOSYS)
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

/// mmap -- supports anonymous mappings, with MAP_FIXED.
pub fn sys_mmap(
    proc: &mut Process,
    addr: u32,
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

    let result = proc.memory.mmap_anonymous(addr, len, prot, flags);
    if result == MAP_FAILED {
        return Err(Errno::ENOMEM);
    }
    Ok(result)
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

/// mprotect -- Wasm linear memory has no page-level protection.
/// Returns success (no-op) so callers like Zend's allocator don't fail.
pub fn sys_mprotect(_proc: &Process, _addr: u32, _len: u32, _prot: u32) -> Result<(), Errno> {
    Ok(())
}

/// Create a socket, returning the new fd.
pub fn sys_socket(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    domain: u32,
    sock_type: u32,
    protocol: u32,
) -> Result<i32, Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketType};
    use wasm_posix_shared::socket::*;

    let dom = match domain {
        AF_UNIX => SocketDomain::Unix,
        AF_INET => SocketDomain::Inet,
        AF_INET6 => SocketDomain::Inet6,
        _ => return Err(Errno::EAFNOSUPPORT),
    };

    let base_type = sock_type & !(SOCK_NONBLOCK | SOCK_CLOEXEC);
    let stype = match base_type {
        SOCK_STREAM => SocketType::Stream,
        SOCK_DGRAM => SocketType::Dgram,
        _ => return Err(Errno::EPROTOTYPE),
    };

    let sock = SocketInfo::new(dom, stype, protocol);
    let sock_idx = proc.sockets.alloc(sock);

    let mut status_flags = O_RDWR;
    if sock_type & SOCK_NONBLOCK != 0 {
        status_flags |= O_NONBLOCK;
    }
    let host_handle = -((sock_idx as i64) + 1);
    let ofd_idx = proc.ofd_table.create(FileType::Socket, status_flags, host_handle, b"/dev/socket".to_vec());

    let fd_flags = if sock_type & SOCK_CLOEXEC != 0 {
        FD_CLOEXEC
    } else {
        0
    };
    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;

    Ok(fd)
}

/// Create a connected pair of Unix domain stream sockets.
pub fn sys_socketpair(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    domain: u32,
    sock_type: u32,
    _protocol: u32,
) -> Result<(i32, i32), Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
    use wasm_posix_shared::socket::*;

    if domain != AF_UNIX {
        return Err(Errno::EAFNOSUPPORT);
    }

    let base_type = sock_type & !(SOCK_NONBLOCK | SOCK_CLOEXEC);
    let stype = match base_type {
        SOCK_STREAM => SocketType::Stream,
        _ => return Err(Errno::EPROTOTYPE),
    };

    // Allocate two ring buffers: buf_ab (A→B) and buf_ba (B→A)
    let buf_ab_idx = proc.pipes.len();
    proc.pipes.push(Some(PipeBuffer::new(DEFAULT_PIPE_CAPACITY)));
    let buf_ba_idx = proc.pipes.len();
    proc.pipes.push(Some(PipeBuffer::new(DEFAULT_PIPE_CAPACITY)));

    // Socket A: sends to buf_ab, receives from buf_ba
    let mut sock_a = SocketInfo::new(SocketDomain::Unix, stype, 0);
    sock_a.state = SocketState::Connected;
    sock_a.send_buf_idx = Some(buf_ab_idx);
    sock_a.recv_buf_idx = Some(buf_ba_idx);

    // Socket B: sends to buf_ba, receives from buf_ab
    let mut sock_b = SocketInfo::new(SocketDomain::Unix, stype, 0);
    sock_b.state = SocketState::Connected;
    sock_b.send_buf_idx = Some(buf_ba_idx);
    sock_b.recv_buf_idx = Some(buf_ab_idx);

    let sock_a_idx = proc.sockets.alloc(sock_a);
    let sock_b_idx = proc.sockets.alloc(sock_b);

    // Set peer indices
    proc.sockets.get_mut(sock_a_idx).unwrap().peer_idx = Some(sock_b_idx);
    proc.sockets.get_mut(sock_b_idx).unwrap().peer_idx = Some(sock_a_idx);

    // Create OFDs
    let mut status_flags = O_RDWR;
    if sock_type & SOCK_NONBLOCK != 0 {
        status_flags |= O_NONBLOCK;
    }

    let handle_a = -((sock_a_idx as i64) + 1);
    let handle_b = -((sock_b_idx as i64) + 1);
    let ofd_a = proc.ofd_table.create(FileType::Socket, status_flags, handle_a, b"/dev/socket".to_vec());
    let ofd_b = proc.ofd_table.create(FileType::Socket, status_flags, handle_b, b"/dev/socket".to_vec());

    let fd_flags = if sock_type & SOCK_CLOEXEC != 0 {
        FD_CLOEXEC
    } else {
        0
    };
    let fd0 = proc.fd_table.alloc(OpenFileDescRef(ofd_a), fd_flags)?;
    let fd1 = proc.fd_table.alloc(OpenFileDescRef(ofd_b), fd_flags)?;

    Ok((fd0, fd1))
}

/// getsockname -- get local socket address.
///
/// For kernel-internal AF_UNIX sockets, writes AF_UNIX (family=1) with
/// empty path. Returns the number of bytes written (2 bytes minimum for
/// sa_family). Returns AF_INET for inet sockets, AF_UNIX for unix sockets.
pub fn sys_getsockname(proc: &Process, fd: i32, buf: &mut [u8]) -> Result<usize, Errno> {
    use crate::socket::SocketDomain;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if buf.len() >= 2 {
        let family: u16 = match sock.domain {
            SocketDomain::Inet => 2,  // AF_INET
            SocketDomain::Inet6 => 10, // AF_INET6
            SocketDomain::Unix => 1,  // AF_UNIX
        };
        buf[0] = family as u8;       // low byte
        buf[1] = (family >> 8) as u8; // high byte
    }
    Ok(2)
}

/// getpeername -- get remote socket address.
///
/// For AF_UNIX socketpairs, returns AF_UNIX family.
/// For AF_INET/AF_INET6 sockets, returns the corresponding family.
pub fn sys_getpeername(proc: &Process, fd: i32, buf: &mut [u8]) -> Result<usize, Errno> {
    use crate::socket::{SocketDomain, SocketState};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    // Must be connected
    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            if sock.state != SocketState::Connected {
                return Err(Errno::ENOTCONN);
            }
        }
        SocketDomain::Unix => {
            if sock.send_buf_idx.is_none() {
                return Err(Errno::ENOTCONN);
            }
        }
    }
    if buf.len() >= 2 {
        let family: u16 = match sock.domain {
            SocketDomain::Inet => 2,  // AF_INET
            SocketDomain::Inet6 => 10, // AF_INET6
            SocketDomain::Unix => 1,  // AF_UNIX
        };
        buf[0] = family as u8;       // low byte
        buf[1] = (family >> 8) as u8; // high byte
    }
    Ok(2)
}

/// Shut down part of a full-duplex socket connection.
///
/// For AF_INET/AF_INET6 sockets with SHUT_RDWR, also closes the host network handle.
pub fn sys_shutdown(proc: &mut Process, host: &mut dyn HostIO, fd: i32, how: u32) -> Result<(), Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;

    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;

    match how {
        SHUT_RD => {
            sock.shut_rd = true;
        }
        SHUT_WR => {
            sock.shut_wr = true;
            if let Some(send_idx) = sock.send_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                    pipe.close_write_end();
                }
            }
        }
        SHUT_RDWR => {
            sock.shut_rd = true;
            sock.shut_wr = true;
            if let Some(net_handle) = sock.host_net_handle {
                let _ = host.host_net_close(net_handle);
            }
            if let Some(send_idx) = sock.send_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                    pipe.close_write_end();
                }
            }
            if let Some(recv_idx) = sock.recv_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(recv_idx) {
                    pipe.close_read_end();
                }
            }
        }
        _ => return Err(Errno::EINVAL),
    }
    Ok(())
}

/// Send data on a connected socket.
///
/// For AF_INET/AF_INET6 sockets, delegates to the host via `host_net_send`.
/// For AF_UNIX sockets, uses the existing pipe-backed path via sys_write.
pub fn sys_send(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    flags: u32,
) -> Result<usize, Errno> {
    use crate::socket::{SocketDomain, SocketState};
    use wasm_posix_shared::socket::MSG_NOSIGNAL;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Connected {
        return Err(Errno::ENOTCONN);
    }

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
            host.host_net_send(net_handle, buf, flags)
        }
        SocketDomain::Unix => {
            let nosignal = flags & MSG_NOSIGNAL != 0;
            let sigpipe_was_pending = proc.signals.is_pending(wasm_posix_shared::signal::SIGPIPE);
            let result = sys_write(proc, host, fd, buf);
            // MSG_NOSIGNAL: suppress SIGPIPE raised by write
            if nosignal && !sigpipe_was_pending {
                proc.signals.clear(wasm_posix_shared::signal::SIGPIPE);
            }
            result
        }
    }
}

/// Receive data from a connected socket.
///
/// For AF_INET/AF_INET6 sockets, delegates to the host via `host_net_recv`.
/// For AF_UNIX sockets, uses the existing pipe-backed path.
pub fn sys_recv(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    flags: u32,
) -> Result<usize, Errno> {
    use crate::socket::{SocketDomain, SocketState};
    use wasm_posix_shared::socket::{MSG_DONTWAIT, MSG_PEEK};
    const MSG_WAITALL: u32 = 0x100;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let status_flags = ofd.status_flags;
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Connected {
        return Err(Errno::ENOTCONN);
    }
    if sock.shut_rd {
        return Ok(0);
    }

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
            host.host_net_recv(net_handle, buf.len() as u32, flags, buf)
        }
        SocketDomain::Unix => {
            let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
            let peek = flags & MSG_PEEK != 0;
            let nonblock = (status_flags & O_NONBLOCK != 0) || (flags & MSG_DONTWAIT != 0);
            let waitall = flags & MSG_WAITALL != 0 && !peek;
            let mut total = 0usize;

            loop {
                let pipe = proc
                    .pipes
                    .get_mut(recv_buf_idx)
                    .and_then(|p| p.as_mut())
                    .ok_or(Errno::EBADF)?;
                let n = if peek { pipe.peek(&mut buf[total..]) } else { pipe.read(&mut buf[total..]) };
                total += n;
                if total >= buf.len() || (total > 0 && !waitall) {
                    return Ok(total);
                }
                if n == 0 && !pipe.is_write_end_open() {
                    return Ok(total); // peer closed — return what we have
                }
                if nonblock {
                    return Err(Errno::EAGAIN);
                }
                if proc.signals.deliverable() != 0 {
                    if !proc.signals.should_restart() {
                        return Err(Errno::EINTR);
                    }
                }
                let _ = host.host_nanosleep(0, 1_000_000);
            }
        }
    }
}

/// Get socket option value.
pub fn sys_getsockopt(
    proc: &mut Process,
    fd: i32,
    level: u32,
    optname: u32,
) -> Result<u32, Errno> {
    use crate::socket::{SocketDomain, SocketState, SocketType};
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    match level {
        SOL_SOCKET => match optname {
            SO_TYPE => Ok(match sock.sock_type {
                SocketType::Stream => SOCK_STREAM,
                SocketType::Dgram => SOCK_DGRAM,
            }),
            SO_DOMAIN => Ok(match sock.domain {
                SocketDomain::Unix => AF_UNIX,
                SocketDomain::Inet => AF_INET,
                SocketDomain::Inet6 => AF_INET6,
            }),
            SO_ERROR => Ok(0),
            SO_ACCEPTCONN => Ok(if sock.state == SocketState::Listening { 1 } else { 0 }),
            SO_RCVBUF | SO_SNDBUF => Ok(DEFAULT_PIPE_CAPACITY as u32),
            SO_LINGER | SO_RCVTIMEO | SO_SNDTIMEO | SO_BROADCAST => {
                Ok(sock.get_option(level, optname).unwrap_or(0))
            }
            _ => Err(Errno::ENOPROTOOPT),
        },
        IPPROTO_TCP => match optname {
            TCP_NODELAY => Ok(sock.get_option(level, optname).unwrap_or(0)),
            _ => Err(Errno::ENOPROTOOPT),
        },
        _ => Err(Errno::ENOPROTOOPT),
    }
}

/// Set socket option value.
pub fn sys_setsockopt(
    proc: &mut Process,
    fd: i32,
    level: u32,
    optname: u32,
    value: u32,
) -> Result<(), Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;

    match level {
        SOL_SOCKET => match optname {
            SO_REUSEADDR | SO_KEEPALIVE | SO_RCVBUF | SO_SNDBUF |
            SO_LINGER | SO_RCVTIMEO | SO_SNDTIMEO | SO_BROADCAST => {
                sock.set_option(level, optname, value);
                Ok(())
            }
            _ => Err(Errno::ENOPROTOOPT),
        },
        IPPROTO_TCP => match optname {
            TCP_NODELAY => {
                sock.set_option(level, optname, value);
                Ok(())
            }
            _ => Err(Errno::ENOPROTOOPT),
        },
        _ => Err(Errno::ENOPROTOOPT),
    }
}

/// Bind a socket to an address. No network binding available in Wasm.
pub fn sys_bind(proc: &mut Process, fd: i32, _addr: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::EADDRNOTAVAIL)
}

/// Listen for connections on a socket. No-op (no real network).
pub fn sys_listen(proc: &mut Process, fd: i32, _backlog: u32) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Ok(())
}

/// Accept a connection on a listening socket. No connections possible.
pub fn sys_accept(proc: &mut Process, _host: &mut dyn HostIO, fd: i32) -> Result<i32, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ECONNABORTED)
}

/// Connect a socket to an address.
///
/// For AF_INET/AF_INET6 sockets, delegates to the host via `host_net_connect`.
/// For AF_UNIX sockets, returns ECONNREFUSED (no Unix domain listener support).
pub fn sys_connect(proc: &mut Process, host: &mut dyn HostIO, fd: i32, addr: &[u8]) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketState};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            if sock.state == SocketState::Connected {
                return Err(Errno::EISCONN);
            }
            // Parse sockaddr_in: family(2) + port(2 big-endian) + addr(4)
            if addr.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let port = u16::from_be_bytes([addr[2], addr[3]]);
            let ip = &addr[4..8];
            let net_handle = sock_idx as i32;
            host.host_net_connect(net_handle, ip, port)?;
            let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            sock.state = SocketState::Connected;
            sock.host_net_handle = Some(net_handle);
            Ok(())
        }
        SocketDomain::Unix => Err(Errno::ECONNREFUSED),
    }
}

/// Resolve a hostname to an IP address via the host.
///
/// `name` is the hostname bytes. `result_buf` receives the resolved address(es).
/// Returns the number of bytes written to `result_buf`.
pub fn sys_getaddrinfo(
    _proc: &mut Process,
    host: &mut dyn HostIO,
    name: &[u8],
    result_buf: &mut [u8],
) -> Result<usize, Errno> {
    if result_buf.len() < 4 {
        return Err(Errno::EINVAL);
    }
    host.host_getaddrinfo(name, result_buf)
}

/// Send a message on a socket to a specific address. No datagram support.
pub fn sys_sendto(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    fd: i32,
    _buf: &[u8],
    _flags: u32,
    _addr: &[u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::EDESTADDRREQ)
}

/// Receive a message from a socket with sender address. No datagram support.
pub fn sys_recvfrom(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    fd: i32,
    _buf: &mut [u8],
    _flags: u32,
    _addr_buf: &mut [u8],
) -> Result<(usize, usize), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOTCONN)
}

/// Poll file descriptors for I/O readiness.
pub fn sys_poll(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fds: &mut [WasmPollFd],
    timeout_ms: i32,
) -> Result<i32, Errno> {
    // First non-blocking check
    let ready = poll_check(proc, fds);
    if ready > 0 || timeout_ms == 0 {
        return Ok(ready);
    }

    // timeout_ms < 0 means wait indefinitely; > 0 means wait up to that many ms.
    // Use polling loop with short sleeps (1ms intervals).
    let deadline_ns: Option<u64> = if timeout_ms > 0 {
        let (sec, nsec) = host.host_clock_gettime(1)?; // CLOCK_MONOTONIC
        let now = sec as u64 * 1_000_000_000 + nsec as u64;
        Some(now + (timeout_ms as u64) * 1_000_000)
    } else {
        None // infinite wait
    };

    loop {
        // Check for pending signals — POSIX: poll is interruptible
        if proc.signals.deliverable() != 0 {
            if !proc.signals.should_restart() {
                return Err(Errno::EINTR);
            }
        }

        // Sleep 1ms
        let _ = host.host_nanosleep(0, 1_000_000);

        let ready = poll_check(proc, fds);
        if ready > 0 {
            return Ok(ready);
        }

        // Check deadline
        if let Some(dl) = deadline_ns {
            let (sec, nsec) = host.host_clock_gettime(1)?;
            let now = sec as u64 * 1_000_000_000 + nsec as u64;
            if now >= dl {
                return Ok(0); // Timeout expired, nothing ready
            }
        }
    }
}

/// Single non-blocking pass checking fd readiness. Used by sys_poll's loop.
fn poll_check(proc: &mut Process, fds: &mut [WasmPollFd]) -> i32 {
    use wasm_posix_shared::poll::*;

    let mut ready_count = 0i32;

    for pollfd in fds.iter_mut() {
        pollfd.revents = 0;

        // Check if fd is valid
        let entry = match proc.fd_table.get(pollfd.fd) {
            Ok(e) => e,
            Err(_) => {
                pollfd.revents = POLLNVAL;
                ready_count += 1;
                continue;
            }
        };

        let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
            Some(o) => o,
            None => {
                pollfd.revents = POLLNVAL;
                ready_count += 1;
                continue;
            }
        };

        let mut revents: i16 = 0;

        match ofd.file_type {
            FileType::Regular | FileType::CharDevice | FileType::Directory => {
                // Regular files and char devices are always ready
                if pollfd.events & POLLIN != 0 {
                    revents |= POLLIN;
                }
                if pollfd.events & POLLOUT != 0 {
                    revents |= POLLOUT;
                }
            }
            FileType::Pipe => {
                if ofd.host_handle >= 0 {
                    // Host-delegated pipe: report as ready (non-blocking)
                    if pollfd.events & POLLIN != 0 {
                        revents |= POLLIN;
                    }
                    if pollfd.events & POLLOUT != 0 {
                        revents |= POLLOUT;
                    }
                } else {
                    // Kernel-internal pipe
                    let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                    if let Some(Some(pipe)) = proc.pipes.get(pipe_idx) {
                        if pollfd.events & POLLIN != 0 && pipe.available() > 0 {
                            revents |= POLLIN;
                        }
                        if pollfd.events & POLLOUT != 0 && pipe.free_space() > 0 {
                            revents |= POLLOUT;
                        }
                        if !pipe.is_write_end_open() {
                            revents |= POLLHUP;
                        }
                    }
                }
            }
            FileType::Socket => {
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    // POLLERR: report error if socket has pending error or shut down for writing
                    if sock.shut_wr && sock.shut_rd {
                        revents |= POLLERR;
                    }
                    // Check recv buffer for readability
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get(recv_idx) {
                            if pollfd.events & POLLIN != 0 && pipe.available() > 0 {
                                revents |= POLLIN;
                            }
                            if !pipe.is_write_end_open() {
                                revents |= POLLHUP;
                            }
                        }
                    }
                    // Check send buffer for writability
                    if let Some(send_idx) = sock.send_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get(send_idx) {
                            if pollfd.events & POLLOUT != 0 && pipe.free_space() > 0 {
                                revents |= POLLOUT;
                            }
                        }
                    }
                }
            }
        }

        pollfd.revents = revents;
        if revents != 0 {
            ready_count += 1;
        }
    }

    ready_count
}

/// Get current time in seconds since epoch.
pub fn sys_time(
    _proc: &mut Process,
    host: &mut dyn HostIO,
) -> Result<i64, Errno> {
    let (sec, _nsec) = host.host_clock_gettime(0)?; // CLOCK_REALTIME = 0
    Ok(sec)
}

/// Get current time with microsecond precision.
/// Returns (seconds, microseconds).
pub fn sys_gettimeofday(
    _proc: &mut Process,
    host: &mut dyn HostIO,
) -> Result<(i64, i64), Errno> {
    let (sec, nsec) = host.host_clock_gettime(0)?; // CLOCK_REALTIME = 0
    let usec = nsec / 1000; // nanoseconds to microseconds
    Ok((sec, usec))
}

/// Sleep for a specified number of microseconds.
pub fn sys_usleep(
    _proc: &mut Process,
    host: &mut dyn HostIO,
    usec: u32,
) -> Result<(), Errno> {
    let sec = (usec / 1_000_000) as i64;
    let nsec = ((usec % 1_000_000) * 1000) as i64;
    host.host_nanosleep(sec, nsec)
}

/// Resolve a path relative to a directory fd.
/// - Absolute paths: returned as-is (dirfd ignored)
/// - AT_FDCWD: resolved relative to cwd
/// - Real dirfd: resolved relative to the directory's stored path
fn resolve_at_path(
    proc: &Process,
    dirfd: i32,
    path: &[u8],
) -> Result<alloc::vec::Vec<u8>, Errno> {
    use wasm_posix_shared::flags::AT_FDCWD;

    if !path.is_empty() && path[0] == b'/' {
        return Ok(path.to_vec());
    }
    if dirfd == AT_FDCWD {
        return Ok(crate::path::resolve_path(path, &proc.cwd));
    }

    let entry = proc.fd_table.get(dirfd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Directory {
        return Err(Errno::ENOTDIR);
    }

    Ok(crate::path::resolve_path(path, &ofd.path))
}

/// Open a file relative to a directory file descriptor.
///
/// If dirfd is AT_FDCWD, the path is resolved relative to the process cwd
/// (same as open()). If dirfd is a valid directory fd, the path is resolved
/// relative to that directory. Absolute paths ignore dirfd.
pub fn sys_openat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    oflags: u32,
    mode: u32,
) -> Result<i32, Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;

    let effective_mode = if oflags & O_CREAT != 0 {
        mode & !proc.umask
    } else {
        mode
    };
    let host_handle = host.host_open(&resolved, oflags, effective_mode)?;

    let file_type = if oflags & O_DIRECTORY != 0 {
        FileType::Directory
    } else {
        FileType::Regular
    };

    let status_flags = oflags & !CREATION_FLAGS;
    let ofd_idx = proc.ofd_table.create(file_type, status_flags, host_handle, resolved);

    let fd_flags = if oflags & O_CLOEXEC != 0 {
        FD_CLOEXEC
    } else {
        0
    };

    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
    Ok(fd)
}

/// fstatat -- stat relative to directory fd.
///
/// Resolves the path relative to dirfd, then stats the file.
/// When AT_SYMLINK_NOFOLLOW is set, uses lstat instead of stat.
pub fn sys_fstatat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    flags: u32,
) -> Result<WasmStat, Errno> {
    use wasm_posix_shared::flags::AT_SYMLINK_NOFOLLOW;

    let resolved = resolve_at_path(proc, dirfd, path)?;
    let mut st = if flags & AT_SYMLINK_NOFOLLOW != 0 {
        host.host_lstat(&resolved)?
    } else {
        host.host_stat(&resolved)?
    };
    st.st_uid = proc.euid;
    st.st_gid = proc.egid;
    Ok(st)
}

/// unlinkat -- unlink relative to directory fd.
///
/// If flags contains AT_REMOVEDIR, acts like rmdir. Otherwise acts like unlink.
pub fn sys_unlinkat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    flags: u32,
) -> Result<(), Errno> {
    use wasm_posix_shared::flags::AT_REMOVEDIR;

    let resolved = resolve_at_path(proc, dirfd, path)?;
    if flags & AT_REMOVEDIR != 0 {
        host.host_rmdir(&resolved)
    } else {
        host.host_unlink(&resolved)
    }
}

/// mkdirat -- mkdir relative to directory fd.
pub fn sys_mkdirat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    mode: u32,
) -> Result<(), Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;
    let effective_mode = mode & !proc.umask;
    host.host_mkdir(&resolved, effective_mode)
}

/// renameat -- rename relative to directory fds.
pub fn sys_renameat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    olddirfd: i32,
    oldpath: &[u8],
    newdirfd: i32,
    newpath: &[u8],
) -> Result<(), Errno> {
    let old_resolved = resolve_at_path(proc, olddirfd, oldpath)?;
    let new_resolved = resolve_at_path(proc, newdirfd, newpath)?;
    host.host_rename(&old_resolved, &new_resolved)
}

/// tcgetattr -- get terminal attributes.
/// Writes c_iflag, c_oflag, c_cflag, c_lflag (4 x u32 = 16 bytes) then c_cc (32 bytes) = 48 bytes total.
pub fn sys_tcgetattr(proc: &mut Process, fd: i32, buf: &mut [u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    let ts = &proc.terminal;
    buf[0..4].copy_from_slice(&ts.c_iflag.to_le_bytes());
    buf[4..8].copy_from_slice(&ts.c_oflag.to_le_bytes());
    buf[8..12].copy_from_slice(&ts.c_cflag.to_le_bytes());
    buf[12..16].copy_from_slice(&ts.c_lflag.to_le_bytes());
    buf[16..48].copy_from_slice(&ts.c_cc);
    Ok(())
}

/// tcsetattr -- set terminal attributes.
/// Reads c_iflag, c_oflag, c_cflag, c_lflag (4 x u32 = 16 bytes) then c_cc (32 bytes) = 48 bytes.
/// action: 0=TCSANOW, 1=TCSADRAIN, 2=TCSAFLUSH (all treated same in single-process).
pub fn sys_tcsetattr(proc: &mut Process, fd: i32, _action: u32, buf: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    let ts = &mut proc.terminal;
    ts.c_iflag = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    ts.c_oflag = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    ts.c_cflag = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    ts.c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    ts.c_cc.copy_from_slice(&buf[16..48]);
    Ok(())
}

/// ioctl -- device control.
/// Supports generic ioctls (FIONREAD, FIONBIO, FIOCLEX, FIONCLEX) on any fd type,
/// plus terminal ioctls (TIOCGWINSZ, TIOCSWINSZ) on CharDevice fds only.
pub fn sys_ioctl(proc: &mut Process, fd: i32, request: u32, buf: &mut [u8]) -> Result<(), Errno> {
    // FIOCLEX / FIONCLEX operate on the fd entry directly, not the OFD.
    match request {
        0x5451 => { // FIOCLEX — set FD_CLOEXEC
            let entry = proc.fd_table.get_mut(fd)?;
            entry.fd_flags |= wasm_posix_shared::fd_flags::FD_CLOEXEC;
            return Ok(());
        }
        0x5450 => { // FIONCLEX — clear FD_CLOEXEC
            let entry = proc.fd_table.get_mut(fd)?;
            entry.fd_flags &= !wasm_posix_shared::fd_flags::FD_CLOEXEC;
            return Ok(());
        }
        _ => {}
    }

    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;

    // FIONBIO — toggle O_NONBLOCK on the OFD status_flags
    if request == 0x5421 {
        if buf.len() < 4 {
            return Err(Errno::EINVAL);
        }
        let val = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
        if val != 0 {
            ofd.status_flags |= wasm_posix_shared::flags::O_NONBLOCK;
        } else {
            ofd.status_flags &= !wasm_posix_shared::flags::O_NONBLOCK;
        }
        return Ok(());
    }

    // FIONREAD — return available bytes
    if request == 0x541B {
        if buf.len() < 4 {
            return Err(Errno::EINVAL);
        }
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        let avail: i32 = match ofd.file_type {
            FileType::Pipe => {
                if ofd.host_handle < 0 {
                    let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                    proc.pipes.get(pipe_idx)
                        .and_then(|p| p.as_ref())
                        .map(|p| p.available() as i32)
                        .unwrap_or(0)
                } else {
                    0
                }
            }
            FileType::Socket => {
                if ofd.host_handle < 0 {
                    let sock_idx = (-(ofd.host_handle + 1)) as usize;
                    if let Some(sock) = proc.sockets.get(sock_idx) {
                        if let Some(recv_idx) = sock.recv_buf_idx {
                            proc.pipes.get(recv_idx)
                                .and_then(|p| p.as_ref())
                                .map(|p| p.available() as i32)
                                .unwrap_or(0)
                        } else {
                            0
                        }
                    } else {
                        0
                    }
                } else {
                    0
                }
            }
            _ => 0,
        };
        buf[0..4].copy_from_slice(&avail.to_le_bytes());
        return Ok(());
    }

    // Terminal-specific ioctls: require CharDevice
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::CharDevice {
        return Err(Errno::ENOTTY);
    }
    match request {
        0x5413 => { // TIOCGWINSZ
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = &proc.terminal.winsize;
            buf[0..2].copy_from_slice(&ws.ws_row.to_le_bytes());
            buf[2..4].copy_from_slice(&ws.ws_col.to_le_bytes());
            buf[4..6].copy_from_slice(&ws.ws_xpixel.to_le_bytes());
            buf[6..8].copy_from_slice(&ws.ws_ypixel.to_le_bytes());
            Ok(())
        }
        0x5414 => { // TIOCSWINSZ
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = &mut proc.terminal.winsize;
            ws.ws_row = u16::from_le_bytes([buf[0], buf[1]]);
            ws.ws_col = u16::from_le_bytes([buf[2], buf[3]]);
            ws.ws_xpixel = u16::from_le_bytes([buf[4], buf[5]]);
            ws.ws_ypixel = u16::from_le_bytes([buf[6], buf[7]]);
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}

/// prctl — process control operations.
/// PR_SET_NAME (15) stores thread name, PR_GET_NAME (16) returns it.
/// All other operations are no-ops returning success.
pub fn sys_prctl(proc: &mut Process, option: u32, _arg2: u32, buf: &mut [u8]) -> Result<(), Errno> {
    const PR_SET_NAME: u32 = 15;
    const PR_GET_NAME: u32 = 16;

    match option {
        PR_SET_NAME => {
            // arg2 is a pointer to the name string in our buffer
            // The name comes in via buf (up to 16 bytes, null-terminated)
            let name_len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len()).min(15);
            proc.thread_name = [0u8; 16];
            proc.thread_name[..name_len].copy_from_slice(&buf[..name_len]);
            Ok(())
        }
        PR_GET_NAME => {
            if buf.len() < 16 {
                return Err(Errno::EINVAL);
            }
            buf[..16].copy_from_slice(&proc.thread_name);
            Ok(())
        }
        _ => Ok(()), // no-op for unrecognized operations
    }
}

// STUB: single-threaded — returns pid (tid == pid in single-threaded mode)
pub fn sys_gettid(proc: &Process) -> i32 {
    proc.pid as i32
}

// STUB: single-threaded — ignores tidptr, returns pid
pub fn sys_set_tid_address(proc: &Process) -> i32 {
    proc.pid as i32
}

// STUB: single-threaded — no-op (no robust futex list to track)
pub fn sys_set_robust_list() -> Result<(), Errno> {
    Ok(())
}

// STUB: single-threaded — see plan for threading upgrade notes
// In single-threaded Wasm, contention is impossible:
// - FUTEX_WAIT returns EAGAIN (value always "changed" since no other thread)
// - FUTEX_WAKE returns 0 (no waiters to wake)
pub fn sys_futex(op: u32) -> Result<i32, Errno> {
    const FUTEX_WAIT: u32 = 0;
    const FUTEX_WAKE: u32 = 1;
    const FUTEX_PRIVATE_FLAG: u32 = 128;

    let base_op = op & !FUTEX_PRIVATE_FLAG;
    match base_op {
        FUTEX_WAIT => Err(Errno::EAGAIN),
        FUTEX_WAKE => Ok(0),
        _ => Ok(0), // no-op for all other futex operations
    }
}

/// ppoll — poll with atomic signal mask swap.
/// Wraps sys_poll: save old mask → set new mask → poll → restore old mask.
pub fn sys_ppoll(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fds: &mut [WasmPollFd],
    timeout_ms: i32,
    mask: Option<u64>,
) -> Result<i32, Errno> {
    let old_mask = if let Some(new_mask) = mask {
        let old = sys_sigprocmask(proc, SIG_SETMASK, new_mask)?;
        Some(old)
    } else {
        None
    };

    let result = sys_poll(proc, host, fds, timeout_ms);

    if let Some(old) = old_mask {
        let _ = sys_sigprocmask(proc, SIG_SETMASK, old);
    }

    result
}

/// pselect6 — select with atomic signal mask swap.
/// Wraps sys_select: save old mask → set new mask → select → restore old mask.
pub fn sys_pselect6(
    proc: &mut Process,
    host: &mut dyn HostIO,
    nfds: i32,
    readfds: Option<&mut [u8]>,
    writefds: Option<&mut [u8]>,
    exceptfds: Option<&mut [u8]>,
    timeout_ms: i32,
    mask: Option<u64>,
) -> Result<i32, Errno> {
    let old_mask = if let Some(new_mask) = mask {
        let old = sys_sigprocmask(proc, SIG_SETMASK, new_mask)?;
        Some(old)
    } else {
        None
    };

    let result = sys_select(proc, host, nfds, readfds, writefds, exceptfds, timeout_ms);

    if let Some(old) = old_mask {
        let _ = sys_sigprocmask(proc, SIG_SETMASK, old);
    }

    result
}

/// umask — set file creation mask, return previous mask
pub fn sys_umask(proc: &mut Process, mask: u32) -> u32 {
    let old = proc.umask;
    proc.umask = mask & 0o777;
    old
}

/// uname — get system identification
/// Writes 5 null-terminated strings of 65 bytes each (325 bytes total):
/// sysname, nodename, release, version, machine
pub fn sys_uname(buf: &mut [u8]) -> Result<(), Errno> {
    if buf.len() < 325 {
        return Err(Errno::EINVAL);
    }
    // Zero out buffer first
    for b in buf[..325].iter_mut() {
        *b = 0;
    }
    let fields: [&[u8]; 5] = [
        b"wasm-posix",        // sysname
        b"localhost",         // nodename
        b"1.0.0",             // release
        b"wasm-posix-kernel", // version
        b"wasm32",            // machine
    ];
    for (i, field) in fields.iter().enumerate() {
        let offset = i * 65;
        let len = field.len().min(64);
        buf[offset..offset + len].copy_from_slice(&field[..len]);
        // null terminator already set by zeroing
    }
    Ok(())
}

/// sysconf — get configurable system variables
pub fn sys_sysconf(name: i32) -> Result<i64, Errno> {
    match name {
        0 => Ok(4096),   // _SC_ARG_MAX
        1 => Ok(0),      // _SC_CHILD_MAX (no fork)
        2 => Ok(100),    // _SC_CLK_TCK
        4 => Ok(1024),   // _SC_OPEN_MAX
        6 => Ok(1),      // _SC_NPROCESSORS_ONLN
        8 => Ok(1),      // _SC_NPROCESSORS_CONF
        11 => Ok(65536), // _SC_PAGESIZE (Wasm page = 64KB)
        30 => Ok(65536), // _SC_PAGE_SIZE (alias)
        _ => Err(Errno::EINVAL),
    }
}

/// pathconf -- get configurable pathname variable values.
///
/// Returns POSIX-required compile-time constants for the given name.
/// The path is not validated (we return the same values regardless).
pub fn sys_pathconf(_path: &[u8], name: i32) -> Result<i64, Errno> {
    pathconf_value(name)
}

/// fpathconf -- get configurable pathname variable values for an open fd.
pub fn sys_fpathconf(proc: &Process, fd: i32, name: i32) -> Result<i64, Errno> {
    let _ = proc.fd_table.get(fd)?;
    pathconf_value(name)
}

fn pathconf_value(name: i32) -> Result<i64, Errno> {
    match name {
        1 => Ok(14),         // _PC_LINK_MAX
        2 => Ok(13),         // _PC_MAX_CANON
        3 => Ok(255),        // _PC_MAX_INPUT
        4 => Ok(255),        // _PC_NAME_MAX
        5 => Ok(4096),       // _PC_PATH_MAX
        6 => Ok(4096),       // _PC_PIPE_BUF
        7 => Ok(1),          // _PC_CHOWN_RESTRICTED
        8 => Ok(1),          // _PC_NO_TRUNC
        9 => Ok(0),          // _PC_VDISABLE
        _ => Err(Errno::EINVAL),
    }
}

/// ftruncate -- truncate a file to a specified length.
pub fn sys_ftruncate(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    length: i64,
) -> Result<(), Errno> {
    if length < 0 {
        return Err(Errno::EINVAL);
    }
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    // Must be a regular file
    if ofd.file_type != FileType::Regular {
        return Err(Errno::EINVAL);
    }

    // Must be writable (O_WRONLY or O_RDWR)
    let access = ofd.status_flags & O_ACCMODE;
    if access == O_RDONLY {
        return Err(Errno::EINVAL);
    }

    // RLIMIT_FSIZE: check if truncate target exceeds file size limit
    let fsize_limit = proc.rlimits[1][0]; // RLIMIT_FSIZE soft limit
    if fsize_limit != u64::MAX && (length as u64) > fsize_limit {
        proc.signals.raise(wasm_posix_shared::signal::SIGXFSZ);
        return Err(Errno::EFBIG);
    }

    host.host_ftruncate(ofd.host_handle, length)
}

/// fsync -- synchronize file state to storage.
pub fn sys_fsync(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    // Must be a regular file
    if ofd.file_type != FileType::Regular {
        return Err(Errno::EINVAL);
    }

    host.host_fsync(ofd.host_handle)
}

/// truncate -- truncate a file to a specified length (path-based).
/// Opens the file for writing, truncates it, then closes it.
pub fn sys_truncate(
    proc: &mut Process,
    host: &mut dyn HostIO,
    path: &[u8],
    length: i64,
) -> Result<(), Errno> {
    let fd = sys_open(proc, host, path, O_WRONLY, 0)?;
    let result = sys_ftruncate(proc, host, fd, length);
    let _ = sys_close(proc, host, fd);
    result
}

/// fdatasync -- synchronize file data to storage.
/// In our Wasm environment this is an alias for fsync.
pub fn sys_fdatasync(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<(), Errno> {
    sys_fsync(proc, host, fd)
}

/// fchmod -- change file mode via file descriptor.
pub fn sys_fchmod(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    mode: u32,
) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if ofd.file_type != FileType::Regular && ofd.file_type != FileType::Directory {
        return Err(Errno::EINVAL);
    }

    host.host_fchmod(ofd.host_handle, mode)
}

/// fchown -- change file owner and group via file descriptor.
pub fn sys_fchown(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    uid: u32,
    gid: u32,
) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if ofd.file_type != FileType::Regular && ofd.file_type != FileType::Directory {
        return Err(Errno::EINVAL);
    }

    host.host_fchown(ofd.host_handle, uid, gid)
}

/// writev -- write data from multiple buffers (scatter-gather I/O).
/// Iterates over the provided buffer slices, writing each in order.
/// Stops on a short write or error, returning the total bytes written.
pub fn sys_writev(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buffers: &[&[u8]],
) -> Result<usize, Errno> {
    let mut total = 0usize;
    for buf in buffers {
        if buf.is_empty() {
            continue;
        }
        let n = sys_write(proc, host, fd, buf)?;
        total += n;
        if n < buf.len() {
            break; // Short write, stop
        }
    }
    Ok(total)
}

/// readv -- read data into multiple buffers (scatter-gather I/O).
/// Iterates over the provided buffer slices, reading into each in order.
/// Stops on a short read, EOF, or error, returning the total bytes read.
pub fn sys_readv(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buffers: &mut [&mut [u8]],
) -> Result<usize, Errno> {
    let mut total = 0usize;
    for buf in buffers.iter_mut() {
        if buf.is_empty() {
            continue;
        }
        let n = sys_read(proc, host, fd, *buf)?;
        total += n;
        if n < buf.len() || n == 0 {
            break; // Short read or EOF, stop
        }
    }
    Ok(total)
}

/// getrlimit — get resource limits
/// Returns (soft_limit, hard_limit) for the given resource.
pub fn sys_getrlimit(proc: &Process, resource: u32) -> Result<(u64, u64), Errno> {
    if resource as usize >= 16 {
        return Err(Errno::EINVAL);
    }
    let limits = proc.rlimits[resource as usize];
    Ok((limits[0], limits[1]))
}

/// setrlimit — set resource limits (advisory, not enforced)
pub fn sys_setrlimit(proc: &mut Process, resource: u32, soft: u64, hard: u64) -> Result<(), Errno> {
    if resource as usize >= 16 {
        return Err(Errno::EINVAL);
    }
    // Soft limit cannot exceed hard limit
    if soft > hard {
        return Err(Errno::EINVAL);
    }
    // Non-root: cannot raise hard limit above current
    // (In our simulated environment, we allow it since uid check is simulated)
    proc.rlimits[resource as usize] = [soft, hard];

    // RLIMIT_NOFILE (resource 7): sync fd table max_fds with new soft limit.
    if resource == 7 {
        let max = if soft == u64::MAX { 1024 * 1024 } else { soft as usize };
        proc.fd_table.set_max_fds(max);
    }

    Ok(())
}

/// faccessat -- check file accessibility relative to directory fd.
///
/// Only AT_FDCWD and absolute paths are currently supported.
pub fn sys_faccessat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    amode: u32,
    _flags: u32,
) -> Result<(), Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;
    host.host_access(&resolved, amode)
}

/// fchmodat -- change file mode relative to directory fd.
///
/// AT_SYMLINK_NOFOLLOW is accepted but not distinguishable from
/// regular chmod in our host delegation model.
pub fn sys_fchmodat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    mode: u32,
    _flags: u32,
) -> Result<(), Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;
    host.host_chmod(&resolved, mode)
}

/// fchownat -- change file owner/group relative to directory fd.
pub fn sys_fchownat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    uid: u32,
    gid: u32,
    _flags: u32,
) -> Result<(), Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;
    host.host_chown(&resolved, uid, gid)
}

/// linkat -- create hard link relative to directory fds.
pub fn sys_linkat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    olddirfd: i32,
    oldpath: &[u8],
    newdirfd: i32,
    newpath: &[u8],
    _flags: u32,
) -> Result<(), Errno> {
    let old_resolved = resolve_at_path(proc, olddirfd, oldpath)?;
    let new_resolved = resolve_at_path(proc, newdirfd, newpath)?;
    host.host_link(&old_resolved, &new_resolved)
}

/// symlinkat -- create symbolic link relative to directory fd.
///
/// The target path is stored as-is (not resolved). Only the linkpath
/// is resolved relative to newdirfd.
pub fn sys_symlinkat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: &[u8],
    newdirfd: i32,
    linkpath: &[u8],
) -> Result<(), Errno> {
    let resolved_link = resolve_at_path(proc, newdirfd, linkpath)?;
    host.host_symlink(target, &resolved_link)
}

/// readlinkat -- read symbolic link relative to directory fd.
pub fn sys_readlinkat(
    proc: &mut Process,
    host: &mut dyn HostIO,
    dirfd: i32,
    path: &[u8],
    buf: &mut [u8],
) -> Result<usize, Errno> {
    let resolved = resolve_at_path(proc, dirfd, path)?;
    host.host_readlink(&resolved, buf)
}

/// select -- synchronous I/O multiplexing.
///
/// Wraps poll() by converting fd_set bitmasks into pollfd entries.
/// Each fd_set is FD_SETSIZE/8 = 128 bytes. Null sets are allowed.
pub fn sys_select(
    proc: &mut Process,
    host: &mut dyn HostIO,
    nfds: i32,
    mut readfds: Option<&mut [u8]>,
    mut writefds: Option<&mut [u8]>,
    mut exceptfds: Option<&mut [u8]>,
    timeout_ms: i32,
) -> Result<i32, Errno> {
    use wasm_posix_shared::poll::{POLLIN, POLLOUT, POLLPRI, POLLERR, POLLHUP};

    if nfds < 0 || nfds > 1024 {
        return Err(Errno::EINVAL);
    }

    let nfds = nfds as usize;

    // Build pollfd array from fd_sets
    let mut pollfds: alloc::vec::Vec<WasmPollFd> = alloc::vec::Vec::new();
    // Track which fds are in which sets
    let mut fd_info: alloc::vec::Vec<(usize, bool, bool, bool)> = alloc::vec::Vec::new();

    for fd in 0..nfds {
        let byte = fd / 8;
        let bit = fd % 8;

        let in_read = readfds.as_ref().map_or(false, |s| (s[byte] >> bit) & 1 != 0);
        let in_write = writefds.as_ref().map_or(false, |s| (s[byte] >> bit) & 1 != 0);
        let in_except = exceptfds.as_ref().map_or(false, |s| (s[byte] >> bit) & 1 != 0);

        if in_read || in_write || in_except {
            let mut events: i16 = 0;
            if in_read { events |= POLLIN; }
            if in_write { events |= POLLOUT; }
            if in_except { events |= POLLPRI; }

            pollfds.push(WasmPollFd {
                fd: fd as i32,
                events,
                revents: 0,
            });
            fd_info.push((fd, in_read, in_write, in_except));
        }
    }

    // Run poll with timeout forwarded
    sys_poll(proc, host, &mut pollfds, timeout_ms)?;

    // Clear the output fd_sets
    if let Some(ref mut s) = readfds { s[..nfds.div_ceil(8)].fill(0); }
    if let Some(ref mut s) = writefds { s[..nfds.div_ceil(8)].fill(0); }
    if let Some(ref mut s) = exceptfds { s[..nfds.div_ceil(8)].fill(0); }

    // Convert poll results back to fd_sets
    let mut ready = 0i32;
    for (i, pollfd) in pollfds.iter().enumerate() {
        let (fd, in_read, in_write, in_except) = fd_info[i];
        let byte = fd / 8;
        let bit = fd % 8;
        let mut counted = false;

        if in_read && (pollfd.revents & (POLLIN | POLLHUP | POLLERR)) != 0 {
            if let Some(ref mut s) = readfds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if in_write && (pollfd.revents & (POLLOUT | POLLERR)) != 0 {
            if let Some(ref mut s) = writefds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if in_except && (pollfd.revents & POLLPRI) != 0 {
            if let Some(ref mut s) = exceptfds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if counted { ready += 1; }
    }

    Ok(ready)
}

/// setuid -- set real and effective user ID (simulated).
pub fn sys_setuid(proc: &mut Process, uid: u32) -> Result<(), Errno> {
    proc.uid = uid;
    proc.euid = uid;
    Ok(())
}

/// setgid -- set real and effective group ID (simulated).
pub fn sys_setgid(proc: &mut Process, gid: u32) -> Result<(), Errno> {
    proc.gid = gid;
    proc.egid = gid;
    Ok(())
}

/// seteuid -- set effective user ID (simulated).
pub fn sys_seteuid(proc: &mut Process, euid: u32) -> Result<(), Errno> {
    proc.euid = euid;
    Ok(())
}

/// setegid -- set effective group ID (simulated).
pub fn sys_setegid(proc: &mut Process, egid: u32) -> Result<(), Errno> {
    proc.egid = egid;
    Ok(())
}

/// getrusage -- get resource usage (simulated).
///
/// Returns mostly zeroed rusage struct. In our single-process Wasm
/// environment, we don't track actual resource usage. The struct is
/// 144 bytes: 2 x timeval (16 bytes each) + 14 x i64.
pub fn sys_getrusage(_proc: &mut Process, who: i32, buf: &mut [u8]) -> Result<(), Errno> {
    use wasm_posix_shared::rusage::{RUSAGE_SELF, RUSAGE_CHILDREN};

    if who != RUSAGE_SELF && who != RUSAGE_CHILDREN {
        return Err(Errno::EINVAL);
    }
    if buf.len() < 144 {
        return Err(Errno::EINVAL);
    }
    // Zero the entire struct — all fields are 0
    // In a more complete implementation, ru_utime could track elapsed time
    buf[..144].fill(0);
    Ok(())
}

/// realpath -- resolve a pathname to a canonical absolute form.
///
/// Resolves the path against cwd, normalizes `.` and `..` components,
/// and verifies the path exists via host stat. Intermediate symlink
/// resolution is not performed (would require walking each component
/// with lstat/readlink; noted as future enhancement).
pub fn sys_realpath(
    proc: &mut Process,
    host: &mut dyn HostIO,
    path: &[u8],
    buf: &mut [u8],
) -> Result<usize, Errno> {
    use crate::path::{resolve_path, normalize_path};

    if path.is_empty() {
        return Err(Errno::ENOENT);
    }

    // Make absolute
    let absolute = resolve_path(path, &proc.cwd);
    // Normalize . and ..
    let normalized = normalize_path(&absolute);
    // Verify path exists
    host.host_stat(&normalized)?;

    let len = normalized.len();
    if buf.len() < len {
        return Err(Errno::ERANGE);
    }
    buf[..len].copy_from_slice(&normalized);
    Ok(len)
}

/// statfs — get filesystem statistics. Returns hardcoded values.
pub fn sys_statfs(_proc: &mut Process) -> wasm_posix_shared::WasmStatfs {
    wasm_posix_shared::WasmStatfs {
        f_type: 0xEF53,       // EXT2_SUPER_MAGIC
        f_bsize: 4096,
        f_blocks: 1048576,    // 4GB
        f_bfree: 524288,      // 2GB free
        f_bavail: 524288,
        f_files: 65536,
        f_ffree: 32768,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: 0,
        _pad: 0,
    }
}

/// fstatfs — get filesystem statistics for an open fd. Returns hardcoded values.
pub fn sys_fstatfs(proc: &mut Process, fd: i32) -> Result<wasm_posix_shared::WasmStatfs, Errno> {
    // Validate the fd exists
    let _ = proc.fd_table.get(fd)?;
    Ok(sys_statfs(proc))
}

/// setresuid — set real, effective, and saved user IDs (simulated).
pub fn sys_setresuid(proc: &mut Process, ruid: u32, euid: u32, _suid: u32) -> Result<(), Errno> {
    if ruid != 0xFFFFFFFF { proc.uid = ruid; }
    if euid != 0xFFFFFFFF { proc.euid = euid; }
    Ok(())
}

/// getresuid — get real, effective, and saved user IDs.
pub fn sys_getresuid(proc: &Process) -> (u32, u32, u32) {
    (proc.uid, proc.euid, proc.uid)
}

/// setresgid — set real, effective, and saved group IDs (simulated).
pub fn sys_setresgid(proc: &mut Process, rgid: u32, egid: u32, _sgid: u32) -> Result<(), Errno> {
    if rgid != 0xFFFFFFFF { proc.gid = rgid; }
    if egid != 0xFFFFFFFF { proc.egid = egid; }
    Ok(())
}

/// getresgid — get real, effective, and saved group IDs.
pub fn sys_getresgid(proc: &Process) -> (u32, u32, u32) {
    (proc.gid, proc.egid, proc.gid)
}

/// getgroups — get supplementary group IDs.
/// Returns 1 group (the process's primary gid).
pub fn sys_getgroups(proc: &Process, size: u32) -> Result<(u32, u32), Errno> {
    if size == 0 {
        // Return count only
        return Ok((1, 0));
    }
    // Return count=1 and the group
    Ok((1, proc.gid))
}

/// setgroups — set supplementary group IDs (no-op).
pub fn sys_setgroups(_proc: &mut Process, _size: u32) -> Result<(), Errno> {
    Ok(())
}

/// sendmsg — send a message on a socket (minimal: extracts iov[0] and delegates to send).
pub fn sys_sendmsg(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    iov_base: &[u8],
    flags: u32,
) -> Result<usize, Errno> {
    sys_send(proc, host, fd, iov_base, flags)
}

/// recvmsg — receive a message from a socket (minimal: extracts iov[0] and delegates to recv).
pub fn sys_recvmsg(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    iov_buf: &mut [u8],
    flags: u32,
) -> Result<usize, Errno> {
    sys_recv(proc, host, fd, iov_buf, flags)
}

/// wait4 — wait for a child process. Delegates to host.
pub fn sys_waitpid(
    _proc: &mut Process,
    host: &mut dyn HostIO,
    pid: i32,
    options: u32,
) -> Result<(i32, i32), Errno> {
    host.host_waitpid(pid, options)
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
        dir_entry_index: usize,     // current position in mock directory
        dir_entry_count: usize,     // total number of mock entries
        sigsuspend_signal: u32,
        sigsuspend_error: bool,
    }

    impl MockHostIO {
        fn new() -> Self {
            MockHostIO { next_handle: 100, dir_entry_returned: false, dir_entry_index: 0, dir_entry_count: 1, sigsuspend_signal: 0, sigsuspend_error: false }
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

        fn host_opendir(&mut self, _path: &[u8]) -> Result<i64, Errno> {
            self.dir_entry_returned = false;
            self.dir_entry_index = 0;
            Ok(200)
        }

        fn host_readdir(&mut self, _handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
            if self.dir_entry_index < self.dir_entry_count {
                let idx = self.dir_entry_index;
                self.dir_entry_index += 1;
                self.dir_entry_returned = true;
                // Generate distinct entries based on index
                let names: [&[u8]; 5] = [b"test.txt", b"foo.txt", b"bar.txt", b"baz.txt", b"qux.txt"];
                let name = if idx < names.len() { names[idx] } else { b"test.txt" };
                let n = name_buf.len().min(name.len());
                name_buf[..n].copy_from_slice(&name[..n]);
                Ok(Some(((42 + idx as u64), 8, n))) // d_ino varies, d_type=DT_REG=8
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

        fn host_ftruncate(&mut self, _handle: i64, _length: i64) -> Result<(), Errno> {
            Ok(())
        }

        fn host_fsync(&mut self, _handle: i64) -> Result<(), Errno> {
            Ok(())
        }

        fn host_fchmod(&mut self, _handle: i64, _mode: u32) -> Result<(), Errno> {
            Ok(())
        }

        fn host_fchown(&mut self, _handle: i64, _uid: u32, _gid: u32) -> Result<(), Errno> {
            Ok(())
        }

        fn host_kill(&mut self, _pid: i32, _sig: u32) -> Result<(), Errno> {
            Ok(())
        }

        fn host_exec(&mut self, _path: &[u8]) -> Result<(), Errno> {
            Ok(())
        }

        fn host_set_alarm(&mut self, _seconds: u32) -> Result<(), Errno> {
            Ok(())
        }

        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
            if self.sigsuspend_error {
                return Err(Errno::EINTR);
            }
            Ok(self.sigsuspend_signal)
        }

        fn host_call_signal_handler(&mut self, _handler_index: u32, _signum: u32) -> Result<(), Errno> {
            Ok(())
        }

        fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno> {
            // Fill with deterministic pattern for testing
            for (i, b) in buf.iter_mut().enumerate() {
                *b = (i & 0xFF) as u8;
            }
            Ok(buf.len())
        }
        fn host_utimensat(&mut self, _path: &[u8], _atime_sec: i64, _atime_nsec: i64, _mtime_sec: i64, _mtime_nsec: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_waitpid(&mut self, _pid: i32, _options: u32) -> Result<(i32, i32), Errno> {
            Err(Errno::ECHILD)
        }
        fn host_net_connect(&mut self, _handle: i32, _addr: &[u8], _port: u16) -> Result<(), Errno> {
            Err(Errno::ECONNREFUSED)
        }
        fn host_net_send(&mut self, _handle: i32, _data: &[u8], _flags: u32) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_recv(&mut self, _handle: i32, _len: u32, _flags: u32, _buf: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_close(&mut self, _handle: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_fcntl_lock(&mut self, _path: &[u8], _pid: u32, cmd: u32, _lock_type: u32, _start: i64, _len: i64, result_buf: &mut [u8]) -> Result<(), Errno> {
            // For F_GETLK (12): write F_UNLCK (2) to indicate no conflict
            if cmd == 12 && result_buf.len() >= 4 {
                result_buf[0..4].copy_from_slice(&2u32.to_le_bytes()); // F_UNLCK
            }
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
        let pos = sys_lseek(&mut proc, &mut host, fd, 100, SEEK_SET).unwrap();
        assert_eq!(pos, 100);

        // SEEK_CUR -10 -> 90
        let pos = sys_lseek(&mut proc, &mut host, fd, -10, SEEK_CUR).unwrap();
        assert_eq!(pos, 90);
    }

    #[test]
    fn test_lseek_pipe_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();

        let result = sys_lseek(&mut proc, &mut host, read_fd, 0, SEEK_SET);
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
    fn test_rewinddir_resets_position() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.dir_entry_count = 2; // two entries: test.txt, foo.txt
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();

        let mut dirent_buf = [0u8; 16];
        let mut name_buf = [0u8; 256];

        // Read first entry
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..8], b"test.txt");

        // Read second entry
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..7], b"foo.txt");

        // End of directory
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 0);

        // Rewind
        sys_rewinddir(&mut proc, &mut host, dh).unwrap();

        // Read again — should get first entry again
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..8], b"test.txt");

        sys_closedir(&mut proc, &mut host, dh).unwrap();
    }

    #[test]
    fn test_telldir_returns_position() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.dir_entry_count = 3;
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();

        // Position starts at 0
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 0);

        let mut dirent_buf = [0u8; 16];
        let mut name_buf = [0u8; 256];

        // Read one entry, position should be 1
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 1);

        // Read another, position should be 2
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 2);

        sys_closedir(&mut proc, &mut host, dh).unwrap();
    }

    #[test]
    fn test_seekdir_skips_entries() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.dir_entry_count = 4; // test.txt, foo.txt, bar.txt, baz.txt

        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();

        let mut dirent_buf = [0u8; 16];
        let mut name_buf = [0u8; 256];

        // Read first 3 entries
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 3);

        // Seek to position 1
        sys_seekdir(&mut proc, &mut host, dh, 1).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 1);

        // Read should give entry at position 1 (foo.txt)
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..7], b"foo.txt");

        sys_closedir(&mut proc, &mut host, dh).unwrap();
    }

    #[test]
    fn test_rewinddir_invalid_handle() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_rewinddir(&mut proc, &mut host, 99);
        assert_eq!(result, Err(Errno::EBADF));
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
        let mut host = MockHostIO::new();
        sys_kill(&mut proc, &mut host, 1, 2).unwrap(); // SIGINT=2
        assert!(proc.signals.is_pending(2));
    }

    #[test]
    fn test_kill_sig_zero_is_noop() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_kill(&mut proc, &mut host, 1, 0).unwrap();
        assert_eq!(proc.signals.pending, 0);
    }

    #[test]
    fn test_kill_invalid_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_kill(&mut proc, &mut host, 1, 100);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_kill_remote_pid_calls_host_kill() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_kill(&mut proc, &mut host, 2, 15);
        assert!(result.is_ok());
        assert!(!proc.signals.is_pending(15)); // NOT pending locally
    }

    #[test]
    fn test_kill_self_raises_locally() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_kill(&mut proc, &mut host, 1, 2);
        assert!(result.is_ok());
        assert!(proc.signals.is_pending(2));
    }

    #[test]
    fn test_kill_pid_zero_raises_locally() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_kill(&mut proc, &mut host, 0, 2);
        assert!(result.is_ok());
        assert!(proc.signals.is_pending(2));
    }

    #[test]
    fn test_kill_sig_zero_remote_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // sig=0 to remote pid should delegate to host for existence check
        let result = sys_kill(&mut proc, &mut host, 2, 0);
        assert!(result.is_ok()); // MockHostIO returns Ok(())
        assert_eq!(proc.signals.pending, 0); // no signal raised locally
    }

    #[test]
    fn test_sigaction_set_ignore() {
        let mut proc = Process::new(1);
        let (old_h, old_f, old_m) = sys_sigaction(&mut proc, 2, 1, 0, 0).unwrap(); // SIGINT, SIG_IGN
        assert_eq!(old_h, 0); // was SIG_DFL
        assert_eq!(old_f, 0);
        assert_eq!(old_m, 0);
        let (old_h, _, _) = sys_sigaction(&mut proc, 2, 0, 0, 0).unwrap(); // back to SIG_DFL
        assert_eq!(old_h, 1); // was SIG_IGN
    }

    #[test]
    fn test_sigaction_with_flags_and_mask() {
        use wasm_posix_shared::signal::SA_RESTART;
        let mut proc = Process::new(1);
        let _ = sys_sigaction(&mut proc, 2, 42, SA_RESTART, 0x04).unwrap();
        let (old_h, old_f, old_m) = sys_sigaction(&mut proc, 2, 0, 0, 0).unwrap();
        assert_eq!(old_h, 42);
        assert_eq!(old_f, SA_RESTART);
        assert_eq!(old_m, 0x04);
    }

    #[test]
    fn test_sigaction_cannot_change_sigkill() {
        let mut proc = Process::new(1);
        let result = sys_sigaction(&mut proc, 9, 1, 0, 0); // SIGKILL, SIG_IGN
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_signal_set_ignore() {
        let mut proc = Process::new(1);
        // signal(SIGUSR1, SIG_IGN) — returns old handler (SIG_DFL=0)
        let result = sys_signal(&mut proc, 10, 1); // SIGUSR1=10, SIG_IGN=1
        assert_eq!(result, Ok(0)); // Was SIG_DFL
    }

    #[test]
    fn test_signal_set_handler() {
        let mut proc = Process::new(1);
        // Set handler to function pointer 42
        let result = sys_signal(&mut proc, 10, 42); // SIGUSR1=10
        assert_eq!(result, Ok(0)); // Was SIG_DFL
        // Set back to default, should return 42
        let result = sys_signal(&mut proc, 10, 0); // SIG_DFL
        assert_eq!(result, Ok(42));
    }

    #[test]
    fn test_signal_sigkill_immutable() {
        let mut proc = Process::new(1);
        let result = sys_signal(&mut proc, 9, 1); // SIGKILL, SIG_IGN
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_signal_sigstop_immutable() {
        let mut proc = Process::new(1);
        let result = sys_signal(&mut proc, 19, 1); // SIGSTOP=19, SIG_IGN
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
        let mut host = MockHostIO::new();
        sys_raise(&mut proc, &mut host, 15).unwrap(); // SIGTERM
        assert!(proc.signals.is_pending(15));
    }

    #[test]
    fn test_deliver_signal_marks_pending() {
        let mut proc = Process::new(1);
        // Simulate what kernel_deliver_signal does
        proc.signals.raise(15); // SIGTERM
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
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        // F_GETLK should report no conflict (same pid)
        let mut query = WasmFlock {
            l_type: F_WRLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_GETLK, &mut query, &mut host).unwrap();
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
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        let mut unlock = WasmFlock {
            l_type: F_UNLCK,
            l_whence: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut unlock, &mut host).unwrap();
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
        let result = sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_close_releases_fcntl_locks() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/lockfile", O_RDWR | O_CREAT, 0o644).unwrap();

        // Acquire a write lock (delegates to host for host-backed files)
        let mut flock = WasmFlock {
            l_type: F_WRLCK, l_whence: 0, l_start: 0, l_len: 100, l_pid: 0, _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        // Close the fd — should release all locks on this file (delegates unlock to host)
        sys_close(&mut proc, &mut host, fd).unwrap();

        // Verify the fd was actually closed
        assert!(proc.fd_table.get(fd).is_err());
    }

    #[test]
    fn test_exit_releases_fcntl_locks() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/lockfile", O_RDWR | O_CREAT, 0o644).unwrap();

        // Acquire a write lock (delegates to host for host-backed files)
        let mut flock = WasmFlock {
            l_type: F_WRLCK, l_whence: 0, l_start: 0, l_len: 100, l_pid: 0, _pad: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        // Exit the process — should release all locks (both local and via host)
        sys_exit(&mut proc, &mut host, 0);

        // Process should be in Exited state
        assert_eq!(proc.state, ProcessState::Exited);
        // Local lock table should also be cleaned
        assert!(proc.lock_table.get_blocking_lock(0, F_WRLCK as u32, 0, 100, 999).is_none());
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
    fn test_mprotect_succeeds_noop() {
        let proc = Process::new(1);
        assert_eq!(sys_mprotect(&proc, 0, 4096, 3), Ok(()));
    }

    #[test]
    fn test_socket_creation() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        assert!(fd >= 3);
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::Socket);
    }

    #[test]
    fn test_socket_unsupported_domain() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_socket(&mut proc, &mut host, 999, 1, 0);
        assert_eq!(result, Err(Errno::EAFNOSUPPORT));
    }

    #[test]
    fn test_socket_unsupported_type() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::AF_UNIX;
        let result = sys_socket(&mut proc, &mut host, AF_UNIX, 999, 0);
        assert_eq!(result, Err(Errno::EPROTOTYPE));
    }

    #[test]
    fn test_socketpair_unix_stream() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        assert!(fd0 >= 3);
        assert!(fd1 >= 3);
        assert_ne!(fd0, fd1);

        // Write through fd0, read from fd1
        let n = sys_write(&mut proc, &mut host, fd0, b"hello").unwrap();
        assert_eq!(n, 5);
        let mut buf = [0u8; 5];
        let n = sys_read(&mut proc, &mut host, fd1, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf, b"hello");

        // Write through fd1, read from fd0 (bidirectional)
        let n = sys_write(&mut proc, &mut host, fd1, b"world").unwrap();
        assert_eq!(n, 5);
        let mut buf = [0u8; 5];
        let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf, b"world");
    }

    #[test]
    fn test_socketpair_close_one_end() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        sys_close(&mut proc, &mut host, fd1).unwrap();

        // Write to fd0 should return EPIPE (peer closed)
        let result = sys_write(&mut proc, &mut host, fd0, b"test");
        assert_eq!(result, Err(Errno::EPIPE));

        // Read from fd0 should return 0 (EOF)
        let mut buf = [0u8; 4];
        let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_write_broken_pipe_raises_sigpipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        // Close read end
        sys_close(&mut proc, &mut host, read_fd).unwrap();

        // Write should fail with EPIPE and raise SIGPIPE
        let result = sys_write(&mut proc, &mut host, write_fd, b"data");
        assert_eq!(result, Err(Errno::EPIPE));
        assert!(proc.signals.is_pending(wasm_posix_shared::signal::SIGPIPE));
    }

    #[test]
    fn test_write_shutdown_socket_raises_sigpipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        sys_shutdown(&mut proc, &mut host, fd0, SHUT_WR).unwrap();

        let result = sys_write(&mut proc, &mut host, fd0, b"test");
        assert_eq!(result, Err(Errno::EPIPE));
        assert!(proc.signals.is_pending(wasm_posix_shared::signal::SIGPIPE));
    }

    #[test]
    fn test_socketpair_not_unix() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let result = sys_socketpair(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0);
        assert_eq!(result, Err(Errno::EAFNOSUPPORT));
    }

    #[test]
    fn test_shutdown_read() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        sys_shutdown(&mut proc, &mut host, fd0, SHUT_RD).unwrap();
        let mut buf = [0u8; 4];
        let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_shutdown_write() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        sys_shutdown(&mut proc, &mut host, fd0, SHUT_WR).unwrap();
        let result = sys_write(&mut proc, &mut host, fd0, b"test");
        assert_eq!(result, Err(Errno::EPIPE));
    }

    #[test]
    fn test_send_recv() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        let n = sys_send(&mut proc, &mut host, fd0, b"test", 0).unwrap();
        assert_eq!(n, 4);

        let mut buf = [0u8; 4];
        let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, 0).unwrap();
        assert_eq!(n, 4);
        assert_eq!(&buf, b"test");
    }

    #[test]
    fn test_recv_msg_peek() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Write data via fd0
        sys_send(&mut proc, &mut host, fd0, b"peek test", 0).unwrap();

        // Peek via fd1 — data should be returned but not consumed
        let mut buf = [0u8; 32];
        let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, 2).unwrap(); // MSG_PEEK=2
        assert_eq!(n, 9);
        assert_eq!(&buf[..9], b"peek test");

        // Regular read — data should still be there
        let n2 = sys_recv(&mut proc, &mut host, fd1, &mut buf, 0).unwrap();
        assert_eq!(n2, 9);
        assert_eq!(&buf[..9], b"peek test");

        // Now data is consumed — use MSG_DONTWAIT to avoid blocking
        let result = sys_recv(&mut proc, &mut host, fd1, &mut buf, MSG_DONTWAIT);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_recv_msg_waitall() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Write 10 bytes in two chunks
        sys_send(&mut proc, &mut host, fd0, b"hello", 0).unwrap();
        sys_send(&mut proc, &mut host, fd0, b"world", 0).unwrap();

        // Recv with MSG_WAITALL should get all 10 bytes at once
        let mut buf = [0u8; 10];
        let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, 0x100).unwrap(); // MSG_WAITALL=0x100
        assert_eq!(n, 10);
        assert_eq!(&buf, b"helloworld");
    }

    #[test]
    fn test_recv_msg_waitall_peer_closed() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Write only 5 bytes, then close
        sys_send(&mut proc, &mut host, fd0, b"short", 0).unwrap();
        sys_close(&mut proc, &mut host, fd0).unwrap();

        // MSG_WAITALL should return short read when peer closes
        let mut buf = [0u8; 20];
        let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, 0x100).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"short");
    }

    #[test]
    fn test_send_msg_nosignal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Close peer to trigger EPIPE on write
        sys_close(&mut proc, &mut host, fd1).unwrap();

        // Send with MSG_NOSIGNAL — should get EPIPE but NOT raise SIGPIPE
        let result = sys_send(&mut proc, &mut host, fd0, b"test", MSG_NOSIGNAL);
        assert_eq!(result, Err(Errno::EPIPE));
        assert!(!proc.signals.is_pending(wasm_posix_shared::signal::SIGPIPE));
    }

    #[test]
    fn test_send_not_connected() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let result = sys_send(&mut proc, &mut host, fd, b"test", 0);
        assert_eq!(result, Err(Errno::ENOTCONN));
    }

    #[test]
    fn test_getsockopt_so_type() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let val = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_TYPE).unwrap();
        assert_eq!(val, SOCK_STREAM);
    }

    #[test]
    fn test_getsockopt_so_domain() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let val = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_DOMAIN).unwrap();
        assert_eq!(val, AF_UNIX);
    }

    #[test]
    fn test_getsockopt_not_socket() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::socket::*;
        let result = sys_getsockopt(&mut proc, 0, SOL_SOCKET, SO_TYPE);
        assert_eq!(result, Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_setsockopt_tcp_nodelay() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        assert!(sys_setsockopt(&mut proc, fd, IPPROTO_TCP, TCP_NODELAY, 1).is_ok());
        let val = sys_getsockopt(&mut proc, fd, IPPROTO_TCP, TCP_NODELAY).unwrap();
        assert_eq!(val, 1);
    }

    #[test]
    fn test_setsockopt_so_linger() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        assert!(sys_setsockopt(&mut proc, fd, SOL_SOCKET, SO_LINGER, 5).is_ok());
        let val = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_LINGER).unwrap();
        assert_eq!(val, 5);
    }

    #[test]
    fn test_setsockopt_so_broadcast() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        assert!(sys_setsockopt(&mut proc, fd, SOL_SOCKET, SO_BROADCAST, 1).is_ok());
    }

    #[test]
    fn test_getsockopt_default_tcp_nodelay() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let val = sys_getsockopt(&mut proc, fd, IPPROTO_TCP, TCP_NODELAY).unwrap();
        assert_eq!(val, 0); // default
    }

    #[test]
    fn test_shutdown_not_socket() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let result = sys_shutdown(&mut proc, &mut host, 0, SHUT_RDWR);
        assert_eq!(result, Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_bind_eaddrnotavail_for_inet() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let result = sys_bind(&mut proc, fd, &[0u8; 16]);
        assert_eq!(result, Err(Errno::EADDRNOTAVAIL));
    }

    #[test]
    fn test_bind_enotsock() {
        let mut proc = Process::new(1);
        let result = sys_bind(&mut proc, 0, &[0u8; 16]);
        assert_eq!(result, Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_listen_succeeds_noop() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let result = sys_listen(&mut proc, fd, 5);
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn test_accept_econnaborted() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let result = sys_accept(&mut proc, &mut host, fd);
        assert_eq!(result, Err(Errno::ECONNABORTED));
    }

    #[test]
    fn test_connect_econnrefused() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let result = sys_connect(&mut proc, &mut host, fd, &[0u8; 16]);
        assert_eq!(result, Err(Errno::ECONNREFUSED));
    }

    #[test]
    fn test_poll_regular_file_always_ready() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        // stdout (fd 1) should be ready for writing
        let mut pollfd = WasmPollFd { fd: 1, events: POLLOUT, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLOUT, 0);
    }

    #[test]
    fn test_poll_pipe_readable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        // Pipe is empty — not readable yet
        let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 0);
        assert_eq!(pollfd.revents, 0);

        // Write data into pipe
        sys_write(&mut proc, &mut host, write_fd, b"data").unwrap();

        // Now pipe should be readable
        let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLIN, 0);
    }

    #[test]
    fn test_poll_pipe_writable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        let mut pollfd = WasmPollFd { fd: write_fd, events: POLLOUT, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLOUT, 0);
    }

    #[test]
    fn test_poll_pipe_hangup() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        sys_close(&mut proc, &mut host, write_fd).unwrap();

        let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLHUP, 0);
    }

    #[test]
    fn test_poll_invalid_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        let mut pollfd = WasmPollFd { fd: 99, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLNVAL, 0);
    }

    #[test]
    fn test_poll_socket_pair() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Socket is writable (send buffer has space)
        let mut pollfd = WasmPollFd { fd: fd0, events: POLLOUT, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLOUT, 0);

        // Socket is not readable (no data yet)
        let mut pollfd = WasmPollFd { fd: fd0, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 0);

        // Write to fd1, now fd0 is readable
        sys_write(&mut proc, &mut host, fd1, b"x").unwrap();
        let mut pollfd = WasmPollFd { fd: fd0, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLIN, 0);
    }

    #[test]
    fn test_poll_multiple_fds() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        use wasm_posix_shared::socket::*;
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        let mut pollfds = [
            WasmPollFd { fd: 1, events: POLLOUT, revents: 0 },
            WasmPollFd { fd: fd0, events: POLLIN, revents: 0 },
        ];
        let n = sys_poll(&mut proc, &mut host, &mut pollfds, 0).unwrap();
        assert_eq!(n, 1); // Only stdout ready
        assert_ne!(pollfds[0].revents & POLLOUT, 0);
        assert_eq!(pollfds[1].revents, 0);
    }

    #[test]
    fn test_lseek_seek_end_on_pipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        // SEEK_END on pipe should return ESPIPE
        let result = sys_lseek(&mut proc, &mut host, read_fd, 0, SEEK_END);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_pread_espipe_on_pipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        let mut buf = [0u8; 4];
        let result = sys_pread(&mut proc, &mut host, read_fd, &mut buf, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_pwrite_espipe_on_pipe() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        let result = sys_pwrite(&mut proc, &mut host, write_fd, b"test", 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_pread_espipe_on_socket() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let mut buf = [0u8; 4];
        let result = sys_pread(&mut proc, &mut host, fd, &mut buf, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_time_returns_positive() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let t = sys_time(&mut proc, &mut host).unwrap();
        // MockHostIO returns (1234567890, 123456789) for clock_gettime
        assert_eq!(t, 1234567890);
    }

    #[test]
    fn test_gettimeofday() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (sec, usec) = sys_gettimeofday(&mut proc, &mut host).unwrap();
        assert_eq!(sec, 1234567890);
        assert_eq!(usec, 123456); // 123456789 nsec / 1000 = 123456 usec
    }

    #[test]
    fn test_usleep() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // MockHostIO nanosleep is a no-op, so this should succeed
        sys_usleep(&mut proc, &mut host, 1000).unwrap();
    }

    #[test]
    fn test_openat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::flags::AT_FDCWD;
        // AT_FDCWD should work like open()
        let result = sys_openat(&mut proc, &mut host, AT_FDCWD, b"/tmp/test", O_RDONLY, 0);
        // MockHostIO.host_open returns Ok(100), so we get a valid fd
        assert!(result.is_ok());
    }

    #[test]
    fn test_openat_absolute_path_ignores_dirfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Absolute path should ignore dirfd
        let result = sys_openat(&mut proc, &mut host, 999, b"/tmp/test", O_RDONLY, 0);
        // Even with invalid dirfd, absolute path works
        assert!(result.is_ok());
    }

    #[test]
    fn test_openat_dirfd_enotdir() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 0 is stdin (CharDevice, not Directory)
        let result = sys_openat(&mut proc, &mut host, 0, b"relative", O_RDONLY, 0);
        assert_eq!(result, Err(Errno::ENOTDIR));
    }

    #[test]
    fn test_fstatat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_fstatat(&mut proc, &mut host, AT_FDCWD, b"/tmp/test", 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fstatat_absolute_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Absolute path ignores dirfd
        let result = sys_fstatat(&mut proc, &mut host, 5, b"/tmp/test", 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fstatat_symlink_nofollow() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_fstatat(&mut proc, &mut host, AT_FDCWD, b"/tmp/link", AT_SYMLINK_NOFOLLOW);
        assert!(result.is_ok());
        let stat = result.unwrap();
        // MockHostIO lstat returns S_IFLNK
        assert_eq!(stat.st_mode & S_IFLNK, S_IFLNK);
    }

    #[test]
    fn test_fstatat_relative_invalid_dirfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_fstatat(&mut proc, &mut host, 5, b"relative", 0);
        assert!(matches!(result, Err(Errno::EBADF)));
    }

    #[test]
    fn test_unlinkat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_unlinkat(&mut proc, &mut host, AT_FDCWD, b"/tmp/test", 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_unlinkat_removedir() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_unlinkat(&mut proc, &mut host, AT_FDCWD, b"/tmp/dir", AT_REMOVEDIR);
        assert!(result.is_ok());
    }

    #[test]
    fn test_unlinkat_relative_invalid_dirfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_unlinkat(&mut proc, &mut host, 5, b"relative", 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_mkdirat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_mkdirat(&mut proc, &mut host, AT_FDCWD, b"/tmp/newdir", 0o755);
        assert!(result.is_ok());
    }

    #[test]
    fn test_mkdirat_relative_invalid_dirfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_mkdirat(&mut proc, &mut host, 5, b"relative", 0o755);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_renameat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_renameat(&mut proc, &mut host, AT_FDCWD, b"/tmp/old", AT_FDCWD, b"/tmp/new");
        assert!(result.is_ok());
    }

    #[test]
    fn test_renameat_absolute_paths() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Both paths absolute, dirfds are ignored
        let result = sys_renameat(&mut proc, &mut host, 5, b"/tmp/old", 6, b"/tmp/new");
        assert!(result.is_ok());
    }

    #[test]
    fn test_renameat_relative_invalid_dirfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Old path relative with non-existent dirfd
        let result = sys_renameat(&mut proc, &mut host, 5, b"relative", AT_FDCWD, b"/tmp/new");
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_tcgetattr_returns_terminal_state() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 60];
        let result = sys_tcgetattr(&mut proc, 0, &mut buf);
        assert!(result.is_ok());
        // Verify c_lflag has ECHO set (in the 4th u32, bytes 12-15)
        let c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        assert!(c_lflag & 0o0010 != 0); // ECHO
    }

    #[test]
    fn test_tcgetattr_enotty_for_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0).unwrap();
        let mut buf = [0u8; 60];
        let result = sys_tcgetattr(&mut proc, fd, &mut buf);
        assert_eq!(result, Err(Errno::ENOTTY));
    }

    #[test]
    fn test_tcsetattr_modifies_terminal_state() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 60];
        sys_tcgetattr(&mut proc, 0, &mut buf).unwrap();
        // Clear ECHO in c_lflag (4th u32, bytes 12-15)
        let c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        let new_lflag = c_lflag & !0o0010; // Clear ECHO
        buf[12..16].copy_from_slice(&new_lflag.to_le_bytes());
        // Set attrs with TCSANOW=0
        let result = sys_tcsetattr(&mut proc, 0, 0, &buf);
        assert!(result.is_ok());
        // Read back
        let mut buf2 = [0u8; 60];
        sys_tcgetattr(&mut proc, 0, &mut buf2).unwrap();
        let c_lflag2 = u32::from_le_bytes([buf2[12], buf2[13], buf2[14], buf2[15]]);
        assert_eq!(c_lflag2 & 0o0010, 0); // ECHO cleared
    }

    #[test]
    fn test_ioctl_tiocgwinsz() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 8];
        let result = sys_ioctl(&mut proc, 0, 0x5413, &mut buf); // TIOCGWINSZ
        assert!(result.is_ok());
        let ws_row = u16::from_le_bytes([buf[0], buf[1]]);
        let ws_col = u16::from_le_bytes([buf[2], buf[3]]);
        assert_eq!(ws_row, 24);
        assert_eq!(ws_col, 80);
    }

    #[test]
    fn test_ioctl_tiocswinsz() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 8];
        buf[0..2].copy_from_slice(&120u16.to_le_bytes()); // rows
        buf[2..4].copy_from_slice(&200u16.to_le_bytes()); // cols
        let result = sys_ioctl(&mut proc, 0, 0x5414, &mut buf); // TIOCSWINSZ
        assert!(result.is_ok());
        // Read back
        let mut buf2 = [0u8; 8];
        sys_ioctl(&mut proc, 0, 0x5413, &mut buf2).unwrap(); // TIOCGWINSZ
        let ws_row = u16::from_le_bytes([buf2[0], buf2[1]]);
        let ws_col = u16::from_le_bytes([buf2[2], buf2[3]]);
        assert_eq!(ws_row, 120);
        assert_eq!(ws_col, 200);
    }

    #[test]
    fn test_ioctl_unsupported_returns_enotty() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 8];
        let result = sys_ioctl(&mut proc, 0, 0x9999, &mut buf);
        assert_eq!(result, Err(Errno::ENOTTY));
    }

    #[test]
    fn test_ioctl_fionbio_set_nonblock() {
        let mut proc = Process::new(1);
        // Set O_NONBLOCK via FIONBIO on stdout (fd 1)
        let mut buf = 1i32.to_le_bytes();
        let result = sys_ioctl(&mut proc, 1, 0x5421, &mut buf);
        assert!(result.is_ok());
        let ofd = proc.ofd_table.get(proc.fd_table.get(1).unwrap().ofd_ref.0).unwrap();
        assert_ne!(ofd.status_flags & wasm_posix_shared::flags::O_NONBLOCK, 0);
        // Clear it
        let mut buf = 0i32.to_le_bytes();
        sys_ioctl(&mut proc, 1, 0x5421, &mut buf).unwrap();
        let ofd = proc.ofd_table.get(proc.fd_table.get(1).unwrap().ofd_ref.0).unwrap();
        assert_eq!(ofd.status_flags & wasm_posix_shared::flags::O_NONBLOCK, 0);
    }

    #[test]
    fn test_ioctl_fioclex_fionclex() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 4];
        // Set FD_CLOEXEC via FIOCLEX on fd 0
        sys_ioctl(&mut proc, 0, 0x5451, &mut buf).unwrap();
        assert_ne!(proc.fd_table.get(0).unwrap().fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC, 0);
        // Clear via FIONCLEX
        sys_ioctl(&mut proc, 0, 0x5450, &mut buf).unwrap();
        assert_eq!(proc.fd_table.get(0).unwrap().fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC, 0);
    }

    #[test]
    fn test_ioctl_fionread_pipe() {
        let mut proc = Process::new(1);
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        let mut host = MockHostIO::new();
        // Write some data
        sys_write(&mut proc, &mut host, write_fd, b"hello").unwrap();
        // FIONREAD should return 5
        let mut buf = [0u8; 4];
        sys_ioctl(&mut proc, read_fd, 0x541B, &mut buf).unwrap();
        let avail = i32::from_le_bytes(buf);
        assert_eq!(avail, 5);
    }

    #[test]
    fn test_ioctl_fionread_regular() {
        let mut proc = Process::new(1);
        // FIONREAD on a CharDevice returns 0
        let mut buf = [0u8; 4];
        sys_ioctl(&mut proc, 0, 0x541B, &mut buf).unwrap();
        let avail = i32::from_le_bytes(buf);
        assert_eq!(avail, 0);
    }

    // ---- prctl tests ----

    #[test]
    fn test_prctl_set_get_name() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 16];
        buf[..5].copy_from_slice(b"hello");
        sys_prctl(&mut proc, 15, 0, &mut buf).unwrap(); // PR_SET_NAME
        let mut out = [0u8; 16];
        sys_prctl(&mut proc, 16, 0, &mut out).unwrap(); // PR_GET_NAME
        assert_eq!(&out[..5], b"hello");
        assert_eq!(out[5], 0);
    }

    #[test]
    fn test_prctl_unknown_is_noop() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 16];
        assert!(sys_prctl(&mut proc, 999, 0, &mut buf).is_ok());
    }

    #[test]
    fn test_fcntl_f_getown_default_zero() {
        let mut proc = Process::new(1);
        let result = sys_fcntl(&mut proc, 0, 9, 0); // F_GETOWN
        assert_eq!(result, Ok(0));
    }

    #[test]
    fn test_fcntl_f_setown_and_getown() {
        let mut proc = Process::new(1);
        // Set owner to pid 42
        let result = sys_fcntl(&mut proc, 0, 8, 42); // F_SETOWN
        assert_eq!(result, Ok(0));
        // Get owner
        let result = sys_fcntl(&mut proc, 0, 9, 0); // F_GETOWN
        assert_eq!(result, Ok(42));
    }

    #[test]
    fn test_open_nofollow_passed_through() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::flags::O_NOFOLLOW;
        // Open with O_NOFOLLOW should work for regular files
        let result = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY | O_NOFOLLOW, 0);
        assert!(result.is_ok());
        // Verify O_NOFOLLOW is NOT stored in status flags
        let fd = result.unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.status_flags & O_NOFOLLOW, 0); // Not in status flags
    }

    #[test]
    fn test_pipe_read_nonblock_eagain() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        // Set read end to non-blocking
        sys_fcntl(&mut proc, read_fd, F_SETFL, O_NONBLOCK).unwrap();
        // Read with nothing in pipe — should get EAGAIN
        let mut buf = [0u8; 16];
        let result = sys_read(&mut proc, &mut host, read_fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_pipe_read_nonblock_with_data() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        sys_fcntl(&mut proc, read_fd, F_SETFL, O_NONBLOCK).unwrap();
        // Write some data
        sys_write(&mut proc, &mut host, write_fd, b"hello").unwrap();
        // Read — should succeed
        let mut buf = [0u8; 16];
        let n = sys_read(&mut proc, &mut host, read_fd, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_pipe_read_eof_when_write_end_closed() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        sys_fcntl(&mut proc, read_fd, F_SETFL, O_NONBLOCK).unwrap();
        // Close write end
        sys_close(&mut proc, &mut host, write_fd).unwrap();
        // Read — should get 0 (EOF), not EAGAIN
        let mut buf = [0u8; 16];
        let n = sys_read(&mut proc, &mut host, read_fd, &mut buf).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_pipe_write_nonblock_eagain_when_full() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        sys_fcntl(&mut proc, write_fd, F_SETFL, O_NONBLOCK).unwrap();
        // Fill pipe buffer (64KB)
        let big = [0u8; 65536];
        let n = sys_write(&mut proc, &mut host, write_fd, &big).unwrap();
        assert_eq!(n, 65536);
        // Next write should get EAGAIN
        let result = sys_write(&mut proc, &mut host, write_fd, b"x");
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_blocking_pipe_read_eintr_on_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        // Don't set O_NONBLOCK — default is blocking

        // Raise a signal so the blocking read returns EINTR
        proc.signals.raise(wasm_posix_shared::signal::SIGTERM);

        let mut buf = [0u8; 16];
        let result = sys_read(&mut proc, &mut host, read_fd, &mut buf);
        assert_eq!(result, Err(Errno::EINTR));
    }

    #[test]
    fn test_blocking_pipe_write_eintr_on_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        // Fill the pipe buffer
        let big = [0u8; 65536];
        let n = sys_write(&mut proc, &mut host, write_fd, &big).unwrap();
        assert_eq!(n, 65536);
        // Don't set O_NONBLOCK — default is blocking

        // Raise a signal so the blocking write returns EINTR
        proc.signals.raise(wasm_posix_shared::signal::SIGTERM);

        let result = sys_write(&mut proc, &mut host, write_fd, b"x");
        assert_eq!(result, Err(Errno::EINTR));
    }

    // ---- umask tests ----

    #[test]
    fn test_umask_default() {
        let proc = Process::new(1);
        assert_eq!(proc.umask, 0o022);
    }

    #[test]
    fn test_umask_set_and_get_old() {
        let mut proc = Process::new(1);
        let old = sys_umask(&mut proc, 0o077);
        assert_eq!(old, 0o022); // previous default
        let old2 = sys_umask(&mut proc, 0o000);
        assert_eq!(old2, 0o077);
    }

    #[test]
    fn test_umask_masks_high_bits() {
        let mut proc = Process::new(1);
        let old = sys_umask(&mut proc, 0o7777); // only 0o777 stored
        assert_eq!(old, 0o022);
        assert_eq!(proc.umask, 0o777);
    }

    // ---- uname tests ----

    #[test]
    fn test_uname_returns_fields() {
        let mut buf = [0u8; 325];
        let result = sys_uname(&mut buf);
        assert!(result.is_ok());
        // sysname at offset 0
        assert_eq!(&buf[0..10], b"wasm-posix");
        assert_eq!(buf[10], 0); // null terminated
        // nodename at offset 65
        assert_eq!(&buf[65..74], b"localhost");
        // machine at offset 260
        assert_eq!(&buf[260..266], b"wasm32");
    }

    #[test]
    fn test_uname_buffer_too_small() {
        let mut buf = [0u8; 100];
        let result = sys_uname(&mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ---- sysconf tests ----

    #[test]
    fn test_sysconf_page_size() {
        assert_eq!(sys_sysconf(30), Ok(65536)); // _SC_PAGE_SIZE
        assert_eq!(sys_sysconf(11), Ok(65536)); // _SC_PAGESIZE
    }

    #[test]
    fn test_sysconf_open_max() {
        assert_eq!(sys_sysconf(4), Ok(1024)); // _SC_OPEN_MAX
    }

    #[test]
    fn test_sysconf_nprocessors() {
        assert_eq!(sys_sysconf(6), Ok(1)); // _SC_NPROCESSORS_ONLN
    }

    #[test]
    fn test_sysconf_invalid() {
        assert_eq!(sys_sysconf(9999), Err(Errno::EINVAL));
    }

    // ---- pathconf/fpathconf tests ----

    #[test]
    fn test_pathconf_name_max() {
        assert_eq!(sys_pathconf(b"/tmp/foo", 4), Ok(255)); // _PC_NAME_MAX
    }

    #[test]
    fn test_pathconf_pipe_buf() {
        assert_eq!(sys_pathconf(b"/tmp/foo", 6), Ok(4096)); // _PC_PIPE_BUF
    }

    #[test]
    fn test_pathconf_invalid_name() {
        assert_eq!(sys_pathconf(b"/tmp/foo", 999), Err(Errno::EINVAL));
    }

    #[test]
    fn test_fpathconf_valid_fd() {
        let proc = Process::new(1);
        // fd 0 is pre-opened (stdin)
        assert_eq!(sys_fpathconf(&proc, 0, 5), Ok(4096)); // _PC_PATH_MAX
    }

    #[test]
    fn test_fpathconf_invalid_fd() {
        let proc = Process::new(1);
        assert_eq!(sys_fpathconf(&proc, 99, 5), Err(Errno::EBADF));
    }

    // ---- getsockname/getpeername tests ----

    #[test]
    fn test_getsockname_socket() {
        use wasm_posix_shared::socket::*;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let mut buf = [0u8; 16];
        let n = sys_getsockname(&proc, fd0, &mut buf).unwrap();
        assert_eq!(n, 2);
        assert_eq!(buf[0], 1); // AF_UNIX
        assert_eq!(buf[1], 0);
    }

    #[test]
    fn test_getsockname_non_socket() {
        let proc = Process::new(1);
        let mut buf = [0u8; 16];
        // fd 0 is stdin, not a socket
        assert_eq!(sys_getsockname(&proc, 0, &mut buf), Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_getpeername_connected() {
        use wasm_posix_shared::socket::*;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let mut buf = [0u8; 16];
        let n = sys_getpeername(&proc, fd0, &mut buf).unwrap();
        assert_eq!(n, 2);
        assert_eq!(buf[0], 1); // AF_UNIX
    }

    // ---- ftruncate tests ----

    #[test]
    fn test_ftruncate_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_ftruncate(&mut proc, &mut host, fd, 100);
        assert!(result.is_ok());
    }

    #[test]
    fn test_ftruncate_negative_length() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_ftruncate(&mut proc, &mut host, fd, -1);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_ftruncate_bad_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_ftruncate(&mut proc, &mut host, 99, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_ftruncate_pipe_einval() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let result = sys_ftruncate(&mut proc, &mut host, r, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_ftruncate_rdonly_einval() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDONLY, 0o644).unwrap();
        let result = sys_ftruncate(&mut proc, &mut host, fd, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ---- fsync tests ----

    #[test]
    fn test_fsync_regular_file() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_fsync(&mut proc, &mut host, fd);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fsync_bad_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_fsync(&mut proc, &mut host, 99);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_fsync_pipe_einval() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let result = sys_fsync(&mut proc, &mut host, r);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_dup3_with_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // dup3 fd 0 to fd 5 with O_CLOEXEC
        let result = sys_dup3(&mut proc, &mut host, 0, 5, O_CLOEXEC);
        assert_eq!(result, Ok(5));
        let entry = proc.fd_table.get(5).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOEXEC);
    }

    #[test]
    fn test_dup3_without_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_dup3(&mut proc, &mut host, 0, 5, 0);
        assert_eq!(result, Ok(5));
        let entry = proc.fd_table.get(5).unwrap();
        assert_eq!(entry.fd_flags, 0);
    }

    #[test]
    fn test_dup3_same_fd_einval() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_dup3(&mut proc, &mut host, 0, 0, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_pipe2_cloexec() {
        let mut proc = Process::new(1);
        let (r, w) = sys_pipe2(&mut proc, O_CLOEXEC).unwrap();
        let r_entry = proc.fd_table.get(r).unwrap();
        let w_entry = proc.fd_table.get(w).unwrap();
        assert_eq!(r_entry.fd_flags, FD_CLOEXEC);
        assert_eq!(w_entry.fd_flags, FD_CLOEXEC);
    }

    #[test]
    fn test_pipe2_nonblock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe2(&mut proc, O_NONBLOCK).unwrap();
        // Verify O_NONBLOCK is set — read empty pipe should return EAGAIN
        let mut buf = [0u8; 16];
        let result = sys_read(&mut proc, &mut host, r, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_pipe2_both_flags() {
        let mut proc = Process::new(1);
        let (r, w) = sys_pipe2(&mut proc, O_CLOEXEC | O_NONBLOCK).unwrap();
        let r_entry = proc.fd_table.get(r).unwrap();
        let w_entry = proc.fd_table.get(w).unwrap();
        assert_eq!(r_entry.fd_flags, FD_CLOEXEC);
        assert_eq!(w_entry.fd_flags, FD_CLOEXEC);
        // Verify O_NONBLOCK is set on the OFDs
        let r_ofd = proc.ofd_table.get(r_entry.ofd_ref.0).unwrap();
        let w_ofd = proc.ofd_table.get(w_entry.ofd_ref.0).unwrap();
        assert_ne!(r_ofd.status_flags & O_NONBLOCK, 0);
        assert_ne!(w_ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_writev_multiple_buffers() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, w) = sys_pipe(&mut proc).unwrap();
        let bufs: &[&[u8]] = &[b"hello", b" ", b"world"];
        let n = sys_writev(&mut proc, &mut host, w, bufs).unwrap();
        assert_eq!(n, 11);
        // Read back
        let mut rbuf = [0u8; 32];
        let n2 = sys_read(&mut proc, &mut host, r, &mut rbuf).unwrap();
        assert_eq!(n2, 11);
        assert_eq!(&rbuf[..11], b"hello world");
    }

    #[test]
    fn test_readv_multiple_buffers() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, w) = sys_pipe(&mut proc).unwrap();
        // Write data to pipe
        sys_write(&mut proc, &mut host, w, b"helloworld").unwrap();
        // Read into multiple buffers
        let mut buf1 = [0u8; 5];
        let mut buf2 = [0u8; 5];
        let mut buffers: [&mut [u8]; 2] = [&mut buf1, &mut buf2];
        let n = sys_readv(&mut proc, &mut host, r, &mut buffers).unwrap();
        assert_eq!(n, 10);
        assert_eq!(&buf1, b"hello");
        assert_eq!(&buf2, b"world");
    }

    #[test]
    fn test_writev_empty_buffer() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_r, w) = sys_pipe(&mut proc).unwrap();
        let bufs: &[&[u8]] = &[b"", b"data", b""];
        let n = sys_writev(&mut proc, &mut host, w, bufs).unwrap();
        assert_eq!(n, 4);
    }

    #[test]
    fn test_writev_bad_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let bufs: &[&[u8]] = &[b"hello"];
        let result = sys_writev(&mut proc, &mut host, 99, bufs);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_readv_bad_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf1 = [0u8; 5];
        let mut buffers: [&mut [u8]; 1] = [&mut buf1];
        let result = sys_readv(&mut proc, &mut host, 99, &mut buffers);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_readv_empty_buffers() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, w) = sys_pipe(&mut proc).unwrap();
        sys_write(&mut proc, &mut host, w, b"data").unwrap();
        let mut buf1 = [0u8; 0];
        let mut buf2 = [0u8; 4];
        let mut buffers: [&mut [u8]; 2] = [&mut buf1, &mut buf2];
        let n = sys_readv(&mut proc, &mut host, r, &mut buffers).unwrap();
        assert_eq!(n, 4);
        assert_eq!(&buf2, b"data");
    }

    #[test]
    fn test_getrlimit_nofile_default() {
        let proc = Process::new(1);
        let (soft, hard) = sys_getrlimit(&proc, 7).unwrap(); // RLIMIT_NOFILE
        assert_eq!(soft, 1024);
        assert_eq!(hard, 4096);
    }

    #[test]
    fn test_getrlimit_stack_default() {
        let proc = Process::new(1);
        let (soft, hard) = sys_getrlimit(&proc, 3).unwrap(); // RLIMIT_STACK
        assert_eq!(soft, 8 * 1024 * 1024);
        assert_eq!(hard, u64::MAX);
    }

    #[test]
    fn test_setrlimit_and_getrlimit() {
        let mut proc = Process::new(1);
        sys_setrlimit(&mut proc, 7, 512, 2048).unwrap(); // RLIMIT_NOFILE
        let (soft, hard) = sys_getrlimit(&proc, 7).unwrap();
        assert_eq!(soft, 512);
        assert_eq!(hard, 2048);
    }

    #[test]
    fn test_setrlimit_soft_exceeds_hard() {
        let mut proc = Process::new(1);
        let result = sys_setrlimit(&mut proc, 7, 5000, 1000);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_setrlimit_nofile_enforced() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Lower RLIMIT_NOFILE soft limit to 5
        sys_setrlimit(&mut proc, 7, 5, 4096).unwrap();

        // fds 0,1,2 are pre-opened (stdio). We can open 2 more (fd 3, 4).
        let fd3 = sys_open(&mut proc, &mut host, b"/tmp/a", O_RDWR | O_CREAT, 0o644).unwrap();
        assert_eq!(fd3, 3);
        let fd4 = sys_open(&mut proc, &mut host, b"/tmp/b", O_RDWR | O_CREAT, 0o644).unwrap();
        assert_eq!(fd4, 4);

        // fd 5 should fail with EMFILE
        let result = sys_open(&mut proc, &mut host, b"/tmp/c", O_RDWR | O_CREAT, 0o644);
        assert_eq!(result, Err(Errno::EMFILE));
    }

    #[test]
    fn test_rlimit_fsize_enforced() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Open a file for writing
        let fd = sys_open(&mut proc, &mut host, b"/tmp/fsize_test", O_WRONLY | O_CREAT, 0o644).unwrap();

        // Set RLIMIT_FSIZE to 10 bytes
        sys_setrlimit(&mut proc, 1, 10, 10).unwrap(); // resource 1 = RLIMIT_FSIZE

        // Writing 5 bytes at offset 0 should succeed (end_pos=5 <= 10)
        let result = sys_write(&mut proc, &mut host, fd, &[1, 2, 3, 4, 5]);
        assert!(result.is_ok());

        // Writing 10 more bytes should fail (end_pos=15 > 10) with EFBIG
        let result = sys_write(&mut proc, &mut host, fd, &[0u8; 10]);
        assert_eq!(result, Err(Errno::EFBIG));

        // SIGXFSZ should have been raised
        assert_ne!(proc.signals.deliverable(), 0);
    }

    #[test]
    fn test_ftruncate_rlimit_fsize() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/ftrunc_test", O_WRONLY | O_CREAT, 0o644).unwrap();

        // Set RLIMIT_FSIZE to 100 bytes
        sys_setrlimit(&mut proc, 1, 100, 100).unwrap();

        // Truncate to 50 should succeed
        assert!(sys_ftruncate(&mut proc, &mut host, fd, 50).is_ok());

        // Truncate to 200 should fail with EFBIG
        let result = sys_ftruncate(&mut proc, &mut host, fd, 200);
        assert_eq!(result, Err(Errno::EFBIG));
    }

    #[test]
    fn test_poll_socket_pollerr() {
        use wasm_posix_shared::socket::*;
        use wasm_posix_shared::poll::*;

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (fd0, _fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Shutdown both directions to trigger POLLERR
        sys_shutdown(&mut proc, &mut host, fd0, SHUT_RDWR).unwrap();

        let mut fds = [WasmPollFd { fd: fd0, events: POLLIN | POLLOUT, revents: 0 }];
        let result = sys_poll(&mut proc, &mut host, &mut fds, 0).unwrap();
        assert!(result > 0);
        assert_ne!(fds[0].revents & POLLERR, 0);
    }

    #[test]
    fn test_getrlimit_invalid_resource() {
        let proc = Process::new(1);
        let result = sys_getrlimit(&proc, 99);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ---- truncate tests ----

    #[test]
    fn test_truncate_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_truncate(&mut proc, &mut host, b"/tmp/test", 100);
        assert!(result.is_ok());
    }

    // ---- fdatasync tests ----

    #[test]
    fn test_fdatasync() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_fdatasync(&mut proc, &mut host, fd);
        assert!(result.is_ok());
    }

    // ---- fchmod tests ----

    #[test]
    fn test_fchmod() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_fchmod(&mut proc, &mut host, fd, 0o755);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fchmod_pipe_einval() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let result = sys_fchmod(&mut proc, &mut host, r, 0o755);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ---- fchown tests ----

    #[test]
    fn test_fchown() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();
        let result = sys_fchown(&mut proc, &mut host, fd, 1000, 1000);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // Process group and session tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_getpgrp_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getpgrp(&proc), 1); // pgid == pid
    }

    #[test]
    fn test_setpgid_self() {
        let mut proc = Process::new(1);
        let result = sys_setpgid(&mut proc, 0, 42); // pid=0 means self
        assert!(result.is_ok());
        assert_eq!(proc.pgid, 42);
    }

    #[test]
    fn test_setpgid_zero_pgid() {
        let mut proc = Process::new(1);
        let result = sys_setpgid(&mut proc, 0, 0); // pgid=0 means use pid
        assert!(result.is_ok());
        assert_eq!(proc.pgid, 1); // pgid set to pid
    }

    #[test]
    fn test_setpgid_other_process_esrch() {
        let mut proc = Process::new(1);
        let result = sys_setpgid(&mut proc, 999, 42); // pid != self
        assert_eq!(result, Err(Errno::ESRCH));
    }

    #[test]
    fn test_getsid_self() {
        let proc = Process::new(1);
        assert_eq!(sys_getsid(&proc, 0), Ok(1)); // sid == pid
    }

    #[test]
    fn test_getsid_other_esrch() {
        let proc = Process::new(1);
        assert_eq!(sys_getsid(&proc, 999), Err(Errno::ESRCH));
    }

    #[test]
    fn test_setsid() {
        // Simulate a child process (pid=2) that inherited parent's session (sid=1)
        let mut proc = Process::new(2);
        proc.sid = 1;
        proc.pgid = 1;
        let result = sys_setsid(&mut proc);
        assert_eq!(result, Ok(2)); // Returns new session id == pid
        assert_eq!(proc.sid, 2);
        assert_eq!(proc.pgid, 2);
    }

    #[test]
    fn test_setsid_already_leader_fails() {
        let mut proc = Process::new(1);
        // pid == sid, so already a session leader
        let result = sys_setsid(&mut proc);
        assert_eq!(result, Err(Errno::EPERM));
    }

    // ---- Phase 12: Remaining *at() variants ----

    #[test]
    fn test_faccessat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Should delegate to sys_access
        let result = sys_faccessat(&mut proc, &mut host, -100, b"/tmp/test", 0, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_faccessat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_faccessat(&mut proc, &mut host, 5, b"relative", 0, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_faccessat_absolute_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_faccessat(&mut proc, &mut host, 5, b"/absolute", 0, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fchmodat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_fchmodat(&mut proc, &mut host, -100, b"/tmp/test", 0o644, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fchmodat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_fchmodat(&mut proc, &mut host, 5, b"relative", 0o644, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_fchownat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_fchownat(&mut proc, &mut host, -100, b"/tmp/test", 1000, 1000, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_fchownat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_fchownat(&mut proc, &mut host, 5, b"relative", 1000, 1000, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_linkat_both_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_linkat(&mut proc, &mut host, -100, b"/old", -100, b"/new", 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_linkat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_linkat(&mut proc, &mut host, 5, b"old", -100, b"/new", 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_symlinkat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_symlinkat(&mut proc, &mut host, b"target", -100, b"/link");
        assert!(result.is_ok());
    }

    #[test]
    fn test_symlinkat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 5 doesn't exist, should get EBADF
        let result = sys_symlinkat(&mut proc, &mut host, b"target", 5, b"link");
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_readlinkat_at_fdcwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let result = sys_readlinkat(&mut proc, &mut host, -100, b"/some/link", &mut buf);
        // MockHostIO host_readlink returns placeholder data
        assert!(result.is_ok());
    }

    #[test]
    fn test_readlinkat_real_dirfd_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        // fd 5 doesn't exist, should get EBADF
        let result = sys_readlinkat(&mut proc, &mut host, 5, b"relative/link", &mut buf);
        assert_eq!(result, Err(Errno::EBADF));
    }

    // ---- Phase 12: select() ----

    #[test]
    fn test_select_regular_file_readable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Open a regular file
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", 0, 0o644).unwrap();
        assert_eq!(fd, 3);

        // Set fd 3 in readfds
        let mut readfds = [0u8; 128];
        readfds[0] = 0b1000; // bit 3
        let result = sys_select(&mut proc, &mut host, 4, Some(&mut readfds), None, None, 0);
        assert_eq!(result, Ok(1));
        assert_eq!(readfds[0] & 0b1000, 0b1000); // fd 3 still set
    }

    #[test]
    fn test_select_empty_sets() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_select(&mut proc, &mut host, 0, None, None, None, 0);
        assert_eq!(result, Ok(0));
    }

    #[test]
    fn test_select_invalid_nfds() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_select(&mut proc, &mut host, -1, None, None, None, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_select_pipe_readable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let (rfd, wfd) = sys_pipe(&mut proc).unwrap();
        // Write data to pipe
        sys_write(&mut proc, &mut host, wfd, b"hello").unwrap();

        let mut readfds = [0u8; 128];
        let byte = rfd as usize / 8;
        let bit = rfd as usize % 8;
        readfds[byte] = 1 << bit;

        let result = sys_select(&mut proc, &mut host, rfd + 1, Some(&mut readfds), None, None, 0);
        assert_eq!(result, Ok(1));
        assert_ne!(readfds[byte] & (1 << bit), 0);
    }

    #[test]
    fn test_select_pipe_writable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let (_rfd, wfd) = sys_pipe(&mut proc).unwrap();

        let mut writefds = [0u8; 128];
        let byte = wfd as usize / 8;
        let bit = wfd as usize % 8;
        writefds[byte] = 1 << bit;

        let result = sys_select(&mut proc, &mut host, wfd + 1, None, Some(&mut writefds), None, 0);
        assert_eq!(result, Ok(1));
        assert_ne!(writefds[byte] & (1 << bit), 0);
    }

    #[test]
    fn test_select_multiple_fds() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let fd1 = sys_open(&mut proc, &mut host, b"/file1", 0, 0o644).unwrap();
        let fd2 = sys_open(&mut proc, &mut host, b"/file2", 0, 0o644).unwrap();

        let mut readfds = [0u8; 128];
        readfds[fd1 as usize / 8] |= 1 << (fd1 as usize % 8);
        readfds[fd2 as usize / 8] |= 1 << (fd2 as usize % 8);

        let max_fd = core::cmp::max(fd1, fd2) + 1;
        let result = sys_select(&mut proc, &mut host, max_fd, Some(&mut readfds), None, None, 0);
        assert_eq!(result, Ok(2));
    }

    // ---- Phase 12: setuid/setgid/seteuid/setegid ----

    #[test]
    fn test_setuid() {
        let mut proc = Process::new(1);
        assert_eq!(proc.uid, 1000);
        sys_setuid(&mut proc, 0).unwrap();
        assert_eq!(proc.uid, 0);
        assert_eq!(proc.euid, 0);
    }

    #[test]
    fn test_setgid() {
        let mut proc = Process::new(1);
        assert_eq!(proc.gid, 1000);
        sys_setgid(&mut proc, 0).unwrap();
        assert_eq!(proc.gid, 0);
        assert_eq!(proc.egid, 0);
    }

    #[test]
    fn test_seteuid() {
        let mut proc = Process::new(1);
        sys_seteuid(&mut proc, 500).unwrap();
        assert_eq!(proc.uid, 1000); // Real uid unchanged
        assert_eq!(proc.euid, 500);
    }

    #[test]
    fn test_setegid() {
        let mut proc = Process::new(1);
        sys_setegid(&mut proc, 500).unwrap();
        assert_eq!(proc.gid, 1000); // Real gid unchanged
        assert_eq!(proc.egid, 500);
    }

    // ---- Phase 12: getrusage ----

    #[test]
    fn test_getrusage_self() {
        let mut proc = Process::new(1);
        let mut buf = [0xFFu8; 144];
        let result = sys_getrusage(&mut proc, 0, &mut buf);
        assert!(result.is_ok());
        // All fields should be zeroed
        assert!(buf.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_getrusage_children() {
        let mut proc = Process::new(1);
        let mut buf = [0xFFu8; 144];
        let result = sys_getrusage(&mut proc, -1, &mut buf);
        assert!(result.is_ok());
        assert!(buf.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_getrusage_invalid_who() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 144];
        let result = sys_getrusage(&mut proc, 5, &mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_getrusage_buffer_too_small() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 10];
        let result = sys_getrusage(&mut proc, 0, &mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ---- realpath ----

    #[test]
    fn test_realpath_absolute() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let len = sys_realpath(&mut proc, &mut host, b"/tmp/test", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/tmp/test");
    }

    #[test]
    fn test_realpath_relative() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user".to_vec();
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let len = sys_realpath(&mut proc, &mut host, b"file.txt", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/home/user/file.txt");
    }

    #[test]
    fn test_realpath_dotdot() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user".to_vec();
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let len = sys_realpath(&mut proc, &mut host, b"../file.txt", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/home/file.txt");
    }

    #[test]
    fn test_realpath_dot() {
        let mut proc = Process::new(1);
        proc.cwd = b"/home/user".to_vec();
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let len = sys_realpath(&mut proc, &mut host, b"./file.txt", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/home/user/file.txt");
    }

    #[test]
    fn test_realpath_empty_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 256];
        let result = sys_realpath(&mut proc, &mut host, b"", &mut buf);
        assert_eq!(result, Err(Errno::ENOENT));
    }

    #[test]
    fn test_realpath_buffer_too_small() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 3]; // Too small for "/tmp/test"
        let result = sys_realpath(&mut proc, &mut host, b"/tmp/test", &mut buf);
        assert_eq!(result, Err(Errno::ERANGE));
    }

    #[test]
    fn test_execve_empty_path_returns_enoent() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_execve(&mut proc, &mut host, b"");
        assert_eq!(result, Err(Errno::ENOENT));
    }

    #[test]
    fn test_execve_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_execve(&mut proc, &mut host, b"/bin/ls");
        assert!(result.is_ok());
    }

    #[test]
    fn test_alarm_sets_deadline_and_returns_zero_initially() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let remaining = sys_alarm(&mut proc, &mut host, 5).unwrap();
        assert_eq!(remaining, 0);
        assert!(proc.alarm_deadline_ns > 0);
    }

    #[test]
    fn test_alarm_returns_previous_remaining() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_alarm(&mut proc, &mut host, 10).unwrap();
        let remaining = sys_alarm(&mut proc, &mut host, 5).unwrap();
        assert!(remaining > 0 && remaining <= 10);
    }

    #[test]
    fn test_alarm_zero_cancels() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_alarm(&mut proc, &mut host, 5).unwrap();
        let remaining = sys_alarm(&mut proc, &mut host, 0).unwrap();
        assert!(remaining > 0);
        assert_eq!(proc.alarm_deadline_ns, 0);
    }

    #[test]
    fn test_sigsuspend_returns_eintr_when_signal_already_pending() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.signals.raise(2); // SIGINT
        let result = sys_sigsuspend(&mut proc, &mut host, 0);
        assert_eq!(result, Err(Errno::EINTR));
    }

    #[test]
    fn test_sigsuspend_restores_old_mask() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.signals.blocked = 0xFF;
        proc.signals.raise(2); // SIGINT pending
        let _ = sys_sigsuspend(&mut proc, &mut host, 0);
        assert_eq!(proc.signals.blocked, 0xFF);
    }

    #[test]
    fn test_sigsuspend_blocks_until_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.sigsuspend_signal = 15; // SIGTERM
        let result = sys_sigsuspend(&mut proc, &mut host, 0);
        assert_eq!(result, Err(Errno::EINTR));
        assert!(proc.signals.is_pending(15));
    }

    #[test]
    fn test_sigsuspend_cannot_block_sigkill() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.sigsuspend_signal = 9; // SIGKILL
        let mask = u64::MAX; // try to block everything
        let result = sys_sigsuspend(&mut proc, &mut host, mask);
        assert_eq!(result, Err(Errno::EINTR));
        assert!(proc.signals.is_pending(9));
    }

    #[test]
    fn test_sigsuspend_restores_mask_on_host_error() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.signals.blocked = 0xFF;
        host.sigsuspend_error = true;
        let result = sys_sigsuspend(&mut proc, &mut host, 0);
        assert_eq!(result, Err(Errno::EINTR));
        // Mask must be restored even when host returns error
        assert_eq!(proc.signals.blocked, 0xFF);
    }

    // ---- *at() syscalls with real dirfd ----

    /// A mock HostIO that records the resolved paths passed to host calls.
    struct TrackingHostIO {
        next_handle: i64,
        last_open_path: Vec<u8>,
        last_stat_path: Vec<u8>,
        last_lstat_path: Vec<u8>,
        last_unlink_path: Vec<u8>,
        last_rmdir_path: Vec<u8>,
        last_mkdir_path: Vec<u8>,
        last_rename_old: Vec<u8>,
        last_rename_new: Vec<u8>,
        last_chmod_path: Vec<u8>,
        last_chown_path: Vec<u8>,
        last_access_path: Vec<u8>,
        last_link_old: Vec<u8>,
        last_link_new: Vec<u8>,
        last_symlink_target: Vec<u8>,
        last_symlink_linkpath: Vec<u8>,
        last_readlink_path: Vec<u8>,
    }

    impl TrackingHostIO {
        fn new() -> Self {
            TrackingHostIO {
                next_handle: 100,
                last_open_path: Vec::new(),
                last_stat_path: Vec::new(),
                last_lstat_path: Vec::new(),
                last_unlink_path: Vec::new(),
                last_rmdir_path: Vec::new(),
                last_mkdir_path: Vec::new(),
                last_rename_old: Vec::new(),
                last_rename_new: Vec::new(),
                last_chmod_path: Vec::new(),
                last_chown_path: Vec::new(),
                last_access_path: Vec::new(),
                last_link_old: Vec::new(),
                last_link_new: Vec::new(),
                last_symlink_target: Vec::new(),
                last_symlink_linkpath: Vec::new(),
                last_readlink_path: Vec::new(),
            }
        }
    }

    impl HostIO for TrackingHostIO {
        fn host_open(&mut self, path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> {
            self.last_open_path = path.to_vec();
            let h = self.next_handle;
            self.next_handle += 1;
            Ok(h)
        }
        fn host_close(&mut self, _handle: i64) -> Result<(), Errno> { Ok(()) }
        fn host_read(&mut self, _handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
            let n = buf.len().min(5);
            buf[..n].copy_from_slice(&b"hello"[..n]);
            Ok(n)
        }
        fn host_write(&mut self, _handle: i64, buf: &[u8]) -> Result<usize, Errno> { Ok(buf.len()) }
        fn host_seek(&mut self, _handle: i64, _offset: i64, _whence: u32) -> Result<i64, Errno> { Ok(0) }
        fn host_fstat(&mut self, _handle: i64) -> Result<WasmStat, Errno> {
            Ok(WasmStat {
                st_dev: 0, st_ino: 0, st_mode: S_IFREG | 0o644, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 1024,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }
        fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
            self.last_stat_path = path.to_vec();
            let is_dir = path.ends_with(b"dir") || path.ends_with(b"tmp")
                || path.ends_with(b"/") || path == b"/";
            let mode = if is_dir { S_IFDIR | 0o755 } else { S_IFREG | 0o644 };
            Ok(WasmStat {
                st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 1024,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }
        fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
            self.last_lstat_path = path.to_vec();
            Ok(WasmStat {
                st_dev: 0, st_ino: 2, st_mode: S_IFLNK | 0o777, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 7,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }
        fn host_mkdir(&mut self, path: &[u8], _mode: u32) -> Result<(), Errno> {
            self.last_mkdir_path = path.to_vec();
            Ok(())
        }
        fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno> {
            self.last_rmdir_path = path.to_vec();
            Ok(())
        }
        fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno> {
            self.last_unlink_path = path.to_vec();
            Ok(())
        }
        fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
            self.last_rename_old = oldpath.to_vec();
            self.last_rename_new = newpath.to_vec();
            Ok(())
        }
        fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
            self.last_link_old = oldpath.to_vec();
            self.last_link_new = newpath.to_vec();
            Ok(())
        }
        fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno> {
            self.last_symlink_target = target.to_vec();
            self.last_symlink_linkpath = linkpath.to_vec();
            Ok(())
        }
        fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
            self.last_readlink_path = path.to_vec();
            let target = b"/target";
            let n = buf.len().min(target.len());
            buf[..n].copy_from_slice(&target[..n]);
            Ok(n)
        }
        fn host_chmod(&mut self, path: &[u8], _mode: u32) -> Result<(), Errno> {
            self.last_chmod_path = path.to_vec();
            Ok(())
        }
        fn host_chown(&mut self, path: &[u8], _uid: u32, _gid: u32) -> Result<(), Errno> {
            self.last_chown_path = path.to_vec();
            Ok(())
        }
        fn host_access(&mut self, path: &[u8], _amode: u32) -> Result<(), Errno> {
            self.last_access_path = path.to_vec();
            Ok(())
        }
        fn host_opendir(&mut self, _path: &[u8]) -> Result<i64, Errno> { Ok(200) }
        fn host_readdir(&mut self, _handle: i64, _name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> { Ok(None) }
        fn host_closedir(&mut self, _handle: i64) -> Result<(), Errno> { Ok(()) }
        fn host_clock_gettime(&mut self, _clock_id: u32) -> Result<(i64, i64), Errno> { Ok((0, 0)) }
        fn host_nanosleep(&mut self, _seconds: i64, _nanoseconds: i64) -> Result<(), Errno> { Ok(()) }
        fn host_ftruncate(&mut self, _handle: i64, _length: i64) -> Result<(), Errno> { Ok(()) }
        fn host_fsync(&mut self, _handle: i64) -> Result<(), Errno> { Ok(()) }
        fn host_fchmod(&mut self, _handle: i64, _mode: u32) -> Result<(), Errno> { Ok(()) }
        fn host_fchown(&mut self, _handle: i64, _uid: u32, _gid: u32) -> Result<(), Errno> { Ok(()) }
        fn host_kill(&mut self, _pid: i32, _sig: u32) -> Result<(), Errno> { Ok(()) }
        fn host_exec(&mut self, _path: &[u8]) -> Result<(), Errno> { Ok(()) }
        fn host_set_alarm(&mut self, _seconds: u32) -> Result<(), Errno> { Ok(()) }
        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
        fn host_call_signal_handler(&mut self, _handler_index: u32, _signum: u32) -> Result<(), Errno> { Ok(()) }
        fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno> {
            for (i, b) in buf.iter_mut().enumerate() { *b = (i & 0xFF) as u8; }
            Ok(buf.len())
        }
        fn host_utimensat(&mut self, _path: &[u8], _atime_sec: i64, _atime_nsec: i64, _mtime_sec: i64, _mtime_nsec: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_waitpid(&mut self, _pid: i32, _options: u32) -> Result<(i32, i32), Errno> {
            Err(Errno::ECHILD)
        }
        fn host_net_connect(&mut self, _handle: i32, _addr: &[u8], _port: u16) -> Result<(), Errno> {
            Err(Errno::ECONNREFUSED)
        }
        fn host_net_send(&mut self, _handle: i32, _data: &[u8], _flags: u32) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_recv(&mut self, _handle: i32, _len: u32, _flags: u32, _buf: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_close(&mut self, _handle: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_fcntl_lock(&mut self, _path: &[u8], _pid: u32, _cmd: u32, _lock_type: u32, _start: i64, _len: i64, _result_buf: &mut [u8]) -> Result<(), Errno> {
            Ok(())
        }
    }

    /// Helper: open a directory and return its fd.
    fn open_dir_fd(proc: &mut Process, host: &mut dyn HostIO, dir_path: &[u8]) -> i32 {
        sys_open(proc, host, dir_path, O_RDONLY | O_DIRECTORY, 0).expect("open dir should succeed")
    }

    #[test]
    fn test_openat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/home/user/dir");
        // open a file relative to /home/user/dir
        let fd = sys_openat(&mut proc, &mut host, dirfd, b"file.txt", O_RDONLY, 0);
        assert!(fd.is_ok());
        assert_eq!(host.last_open_path, b"/home/user/dir/file.txt");
    }

    #[test]
    fn test_fstatat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/var/dir");
        let result = sys_fstatat(&mut proc, &mut host, dirfd, b"subdir", 0);
        assert!(result.is_ok());
        assert_eq!(host.last_stat_path, b"/var/dir/subdir");
    }

    #[test]
    fn test_fstatat_with_real_dirfd_nofollow() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/var/dir");
        let result = sys_fstatat(&mut proc, &mut host, dirfd, b"link", AT_SYMLINK_NOFOLLOW);
        assert!(result.is_ok());
        assert_eq!(host.last_lstat_path, b"/var/dir/link");
    }

    #[test]
    fn test_unlinkat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/tmp/dir");
        let result = sys_unlinkat(&mut proc, &mut host, dirfd, b"file", 0);
        assert!(result.is_ok());
        assert_eq!(host.last_unlink_path, b"/tmp/dir/file");
    }

    #[test]
    fn test_unlinkat_removedir_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/tmp/dir");
        let result = sys_unlinkat(&mut proc, &mut host, dirfd, b"subdir", AT_REMOVEDIR);
        assert!(result.is_ok());
        assert_eq!(host.last_rmdir_path, b"/tmp/dir/subdir");
    }

    #[test]
    fn test_mkdirat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/home/dir");
        let result = sys_mkdirat(&mut proc, &mut host, dirfd, b"newdir", 0o755);
        assert!(result.is_ok());
        assert_eq!(host.last_mkdir_path, b"/home/dir/newdir");
    }

    #[test]
    fn test_renameat_with_real_dirfds() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd1 = open_dir_fd(&mut proc, &mut host, b"/src/dir");
        let dirfd2 = open_dir_fd(&mut proc, &mut host, b"/dst/dir");
        let result = sys_renameat(&mut proc, &mut host, dirfd1, b"old", dirfd2, b"new");
        assert!(result.is_ok());
        assert_eq!(host.last_rename_old, b"/src/dir/old");
        assert_eq!(host.last_rename_new, b"/dst/dir/new");
    }

    #[test]
    fn test_linkat_with_real_dirfds() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/data/dir");
        let result = sys_linkat(&mut proc, &mut host, dirfd, b"existing", dirfd, b"link", 0);
        assert!(result.is_ok());
        assert_eq!(host.last_link_old, b"/data/dir/existing");
        assert_eq!(host.last_link_new, b"/data/dir/link");
    }

    #[test]
    fn test_symlinkat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/opt/dir");
        let result = sys_symlinkat(&mut proc, &mut host, b"../target", dirfd, b"link");
        assert!(result.is_ok());
        // target is stored as-is, only linkpath is resolved
        assert_eq!(host.last_symlink_target, b"../target");
        assert_eq!(host.last_symlink_linkpath, b"/opt/dir/link");
    }

    #[test]
    fn test_readlinkat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/etc/dir");
        let mut buf = [0u8; 256];
        let result = sys_readlinkat(&mut proc, &mut host, dirfd, b"link", &mut buf);
        assert!(result.is_ok());
        assert_eq!(host.last_readlink_path, b"/etc/dir/link");
    }

    #[test]
    fn test_fchmodat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/var/dir");
        let result = sys_fchmodat(&mut proc, &mut host, dirfd, b"file", 0o644, 0);
        assert!(result.is_ok());
        assert_eq!(host.last_chmod_path, b"/var/dir/file");
    }

    #[test]
    fn test_fchownat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/var/dir");
        let result = sys_fchownat(&mut proc, &mut host, dirfd, b"file", 1000, 1000, 0);
        assert!(result.is_ok());
        assert_eq!(host.last_chown_path, b"/var/dir/file");
    }

    #[test]
    fn test_faccessat_with_real_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/var/dir");
        let result = sys_faccessat(&mut proc, &mut host, dirfd, b"file", 0, 0);
        assert!(result.is_ok());
        assert_eq!(host.last_access_path, b"/var/dir/file");
    }

    #[test]
    fn test_at_absolute_path_ignores_dirfd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/wrong/dir");
        // Absolute path should ignore dirfd
        let result = sys_fstatat(&mut proc, &mut host, dirfd, b"/absolute/path", 0);
        assert!(result.is_ok());
        assert_eq!(host.last_stat_path, b"/absolute/path");
    }

    #[test]
    fn test_at_enotdir_when_dirfd_is_regular_file() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        // Open a regular file (not a directory)
        let fd = sys_open(&mut proc, &mut host, b"/some/file.txt", O_RDONLY, 0).unwrap();
        // Try to use it as a dirfd - should get ENOTDIR
        let result = sys_fstatat(&mut proc, &mut host, fd, b"relative", 0);
        assert!(matches!(result, Err(Errno::ENOTDIR)));
    }

    #[test]
    fn test_openat_stores_resolved_path_in_ofd() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let dirfd = open_dir_fd(&mut proc, &mut host, b"/base/dir");
        let fd = sys_openat(&mut proc, &mut host, dirfd, b"child/dir", O_RDONLY | O_DIRECTORY, 0).unwrap();
        // The new OFD should have the resolved path stored
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.path, b"/base/dir/child/dir");
    }

    #[test]
    fn test_inet_socket_creation() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        assert!(fd >= 0);
    }

    #[test]
    fn test_inet_connect_returns_econnrefused_with_mock() {
        // MockHostIO returns ECONNREFUSED for host_net_connect
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // sockaddr_in: AF_INET(2) + port(80) + IP(127.0.0.1)
        let addr = [2, 0, 0, 80, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        let err = sys_connect(&mut proc, &mut host, fd, &addr).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_inet_send_on_unconnected_returns_enotconn() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let err = sys_send(&mut proc, &mut host, fd, b"hello", 0).unwrap_err();
        assert_eq!(err, Errno::ENOTCONN);
    }

    #[test]
    fn test_unix_socket_connect_still_returns_econnrefused() {
        // Regression: AF_UNIX connect should still fail
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let addr = [1, 0]; // AF_UNIX family
        let err = sys_connect(&mut proc, &mut host, fd, &addr).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_getaddrinfo_returns_enoent_with_mock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut result = [0u8; 16];
        let err = sys_getaddrinfo(&mut proc, &mut host, b"example.com", &mut result).unwrap_err();
        assert_eq!(err, Errno::ENOENT);
    }

    #[test]
    fn test_inet_write_after_connect_succeeds() {
        // Create a mock that accepts connect and send
        struct NetMock;
        impl HostIO for NetMock {
            fn host_open(&mut self, _p: &[u8], _f: u32, _m: u32) -> Result<i64, Errno> { Ok(100) }
            fn host_close(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_write(&mut self, _h: i64, _b: &[u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> { Ok(0) }
            fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_lstat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_link(&mut self, _e: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_symlink(&mut self, _t: &[u8], _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_readlink(&mut self, _p: &[u8], _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_chmod(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_chown(&mut self, _p: &[u8], _u: u32, _g: u32) -> Result<(), Errno> { Ok(()) }
            fn host_access(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_opendir(&mut self, _p: &[u8]) -> Result<i64, Errno> { Ok(200) }
            fn host_readdir(&mut self, _h: i64, _n: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> { Ok(None) }
            fn host_closedir(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_clock_gettime(&mut self, _c: u32) -> Result<(i64, i64), Errno> { Ok((0, 0)) }
            fn host_nanosleep(&mut self, _s: i64, _n: i64) -> Result<(), Errno> { Ok(()) }
            fn host_ftruncate(&mut self, _h: i64, _l: i64) -> Result<(), Errno> { Ok(()) }
            fn host_fsync(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_fchmod(&mut self, _h: i64, _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_fchown(&mut self, _h: i64, _u: u32, _g: u32) -> Result<(), Errno> { Ok(()) }
            fn host_kill(&mut self, _p: i32, _s: u32) -> Result<(), Errno> { Ok(()) }
            fn host_exec(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_set_alarm(&mut self, _s: u32) -> Result<(), Errno> { Ok(()) }
            fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
            fn host_call_signal_handler(&mut self, _h: u32, _s: u32) -> Result<(), Errno> { Ok(()) }
            fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0x42; } Ok(b.len()) }
            fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
            fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
            fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
            fn host_net_send(&mut self, _h: i32, data: &[u8], _f: u32) -> Result<usize, Errno> { Ok(data.len()) }
            fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
            fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Err(Errno::ENOENT) }
            fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _cmd: u32, _lt: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
        }

        let mut proc = Process::new(1);
        let mut host = NetMock;
        use wasm_posix_shared::socket::*;

        // Create socket
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();

        // Connect
        let addr = [2, 0, 0, 80, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        sys_connect(&mut proc, &mut host, fd, &addr).unwrap();

        // Write should succeed (delegating to host_net_send)
        let result = sys_write(&mut proc, &mut host, fd, b"hello world");
        assert!(result.is_ok(), "sys_write on connected AF_INET socket should succeed, got: {:?}", result);
        assert_eq!(result.unwrap(), 11);

        // Read should succeed (delegating to host_net_recv, returns 0 = EOF from mock)
        let mut buf = [0u8; 64];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert!(result.is_ok(), "sys_read on connected AF_INET socket should succeed, got: {:?}", result);
        assert_eq!(result.unwrap(), 0);
    }

    // ===== setitimer / getitimer tests =====

    #[test]
    fn test_getitimer_initial_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_getitimer(&mut proc, &mut host, 0).unwrap();
        assert_eq!(result, (0, 0, 0, 0));
    }

    #[test]
    fn test_getitimer_virtual_always_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_getitimer(&mut proc, &mut host, 1).unwrap();
        assert_eq!(result, (0, 0, 0, 0));
    }

    #[test]
    fn test_getitimer_invalid_which() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_getitimer(&mut proc, &mut host, 3);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_setitimer_cancel() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Set an alarm first
        proc.alarm_deadline_ns = 1_000_000_000;
        proc.alarm_interval_ns = 500_000_000;
        // Cancel it
        let old = sys_setitimer(&mut proc, &mut host, 0, 0, 0, 0, 0).unwrap();
        // Old should have had interval 0.5s
        assert_eq!(old.0, 0); // interval_sec
        assert_eq!(old.1, 500000); // interval_usec
        // Now timer should be cleared
        assert_eq!(proc.alarm_deadline_ns, 0);
        assert_eq!(proc.alarm_interval_ns, 0);
    }

    #[test]
    fn test_setitimer_sets_alarm() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // MockHostIO returns time (1234567890, 123456789)
        let now_ns = 1234567890u64 * 1_000_000_000 + 123456789u64;
        // Set a 2.5 second timer with 1 second interval
        let result = sys_setitimer(&mut proc, &mut host, 0, 1, 0, 2, 500000).unwrap();
        // Old was zero
        assert_eq!(result, (0, 0, 0, 0));
        // Interval should be stored
        assert_eq!(proc.alarm_interval_ns, 1_000_000_000);
        // Deadline should be now_ns + 2.5s
        assert_eq!(proc.alarm_deadline_ns, now_ns + 2_500_000_000);
    }

    #[test]
    fn test_setitimer_virtual_noop() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_setitimer(&mut proc, &mut host, 1, 1, 0, 1, 0).unwrap();
        assert_eq!(result, (0, 0, 0, 0));
        // ITIMER_VIRTUAL doesn't affect alarm_deadline_ns
        assert_eq!(proc.alarm_deadline_ns, 0);
    }

    // ===== sigtimedwait tests =====

    #[test]
    fn test_sigtimedwait_pending_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Raise SIGUSR1 (signal 10)
        proc.signals.pending |= 1u64 << 10;
        // Wait for SIGUSR1
        let mask = 1u64 << 10;
        let result = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(result, 10);
        // Signal should be dequeued
        assert_eq!(proc.signals.pending & (1u64 << 10), 0);
    }

    #[test]
    fn test_sigtimedwait_no_pending_timeout_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mask = 1u64 << 10;
        let result = sys_sigtimedwait(&mut proc, &mut host, mask, 0);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_sigtimedwait_dequeues_lowest() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Raise both SIGUSR1 (10) and SIGUSR2 (12)
        proc.signals.pending |= (1u64 << 10) | (1u64 << 12);
        let mask = (1u64 << 10) | (1u64 << 12);
        let result = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(result, 10); // lowest first
        // Only SIGUSR1 should be dequeued
        assert_eq!(proc.signals.pending & (1u64 << 10), 0);
        assert_ne!(proc.signals.pending & (1u64 << 12), 0);
    }

    // ===== preadv / pwritev tests =====

    #[test]
    fn test_preadv_basic() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/test/file", O_RDONLY, 0).unwrap();
        let mut buf1 = [0u8; 4];
        let mut buf2 = [0u8; 4];
        let mut iovecs: [&mut [u8]; 2] = [&mut buf1, &mut buf2];
        // TrackingHostIO reads return 0 (EOF), so total should be 0
        let result = sys_preadv(&mut proc, &mut host, fd, &mut iovecs, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_preadv_rejects_pipe() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let (read_fd, _write_fd) = sys_pipe(&mut proc).unwrap();
        let mut buf = [0u8; 4];
        let mut iovecs: [&mut [u8]; 1] = [&mut buf];
        let result = sys_preadv(&mut proc, &mut host, read_fd, &mut iovecs, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_pwritev_rejects_pipe() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        let iovecs: [&[u8]; 1] = [b"hello"];
        let result = sys_pwritev(&mut proc, &mut host, write_fd, &iovecs, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    // ===== sendfile tests =====

    #[test]
    fn test_sendfile_copies_data() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let in_fd = sys_open(&mut proc, &mut host, b"/test/in", O_RDONLY, 0).unwrap();
        let out_fd = sys_open(&mut proc, &mut host, b"/test/out", O_WRONLY, 0).unwrap();
        // TrackingHostIO reads 5 bytes ("hello") per call, count=10 → copies 10 bytes
        let result = sys_sendfile(&mut proc, &mut host, out_fd, in_fd, 0, 10);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 10);
    }

    // ===== statx tests =====

    #[test]
    fn test_statx_delegates_to_fstatat() {
        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let result = sys_statx(&mut proc, &mut host, -100, b"/test/file", 0, 0);
        assert!(result.is_ok());
        assert_eq!(host.last_stat_path, b"/test/file");
    }
}
