extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::*;
use wasm_posix_shared::fd_flags::{FD_CLOEXEC, FD_CLOFORK};
use wasm_posix_shared::fcntl_cmd::*;
use wasm_posix_shared::lock_type::*;
use wasm_posix_shared::flock_op::*;
use wasm_posix_shared::seek::*;
use wasm_posix_shared::mode::{S_IFCHR, S_IFIFO, S_IFREG};
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
const CREATION_FLAGS: u32 = O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_CLOFORK | O_DIRECTORY | O_NOFOLLOW;

/// Convert O_CLOEXEC / O_CLOFORK open flags to FD_CLOEXEC / FD_CLOFORK fd flags.
#[inline]
fn oflags_to_fd_flags(oflags: u32) -> u32 {
    let mut fd_flags = 0;
    if oflags & O_CLOEXEC != 0 { fd_flags |= FD_CLOEXEC; }
    if oflags & O_CLOFORK != 0 { fd_flags |= FD_CLOFORK; }
    fd_flags
}

/// Parse a byte slice as an ASCII unsigned integer.
fn parse_ascii_usize(bytes: &[u8]) -> Option<usize> {
    if bytes.is_empty() { return None; }
    let mut val: usize = 0;
    for &b in bytes {
        if b < b'0' || b > b'9' { return None; }
        val = val.checked_mul(10)?.checked_add((b - b'0') as usize)?;
    }
    Some(val)
}

/// Virtual character devices handled entirely in-kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualDevice {
    Null,     // /dev/null     host_handle = -1
    Zero,     // /dev/zero     host_handle = -2
    Urandom,  // /dev/urandom  host_handle = -3
    Full,     // /dev/full     host_handle = -4
    Fb0,      // /dev/fb0      host_handle = -5
}

impl VirtualDevice {
    /// Encode as a negative host_handle for CharDevice OFDs.
    pub fn host_handle(self) -> i64 {
        match self {
            VirtualDevice::Null => -1,
            VirtualDevice::Zero => -2,
            VirtualDevice::Urandom => -3,
            VirtualDevice::Full => -4,
            VirtualDevice::Fb0 => -5,
        }
    }

    /// Decode a negative CharDevice host_handle back to a VirtualDevice.
    pub fn from_host_handle(h: i64) -> Option<VirtualDevice> {
        match h {
            -1 => Some(VirtualDevice::Null),
            -2 => Some(VirtualDevice::Zero),
            -3 => Some(VirtualDevice::Urandom),
            -4 => Some(VirtualDevice::Full),
            -5 => Some(VirtualDevice::Fb0),
            _ => None,
        }
    }

    /// Synthetic inode number for stat.
    pub fn ino(self) -> u64 {
        match self {
            VirtualDevice::Null => 1,
            VirtualDevice::Zero => 2,
            VirtualDevice::Urandom => 3,
            VirtualDevice::Full => 4,
            VirtualDevice::Fb0 => 5,
        }
    }
}

/// Check if a resolved path is a virtual device node.
///
/// `/dev/console` aliases to `/dev/null` (write-discard, read-EOF).
/// Real consoles aren't meaningful in this hosted kernel — programs
/// that probe for /dev/console as a fallback log sink should succeed
/// with a sink that swallows output rather than failing with ENOENT.
fn match_virtual_device(path: &[u8]) -> Option<VirtualDevice> {
    match path {
        b"/dev/null" | b"/dev/console" => Some(VirtualDevice::Null),
        b"/dev/zero" => Some(VirtualDevice::Zero),
        b"/dev/urandom" | b"/dev/random" => Some(VirtualDevice::Urandom),
        b"/dev/full" => Some(VirtualDevice::Full),
        b"/dev/fb0" => Some(VirtualDevice::Fb0),
        _ => None,
    }
}

/// Sentinel host_handle for synthetic in-kernel files (/etc/passwd, etc.).
const SYNTHETIC_FILE_HANDLE: i64 = -100;

/// Return static content for synthetic /etc files.
/// These provide a minimal POSIX environment (user/group database, DNS).
///
/// Daemons (nginx, redis, postgres, ...) routinely call getpwnam("nobody")
/// or similar at startup; the system-account entries below cover the
/// common ones so daemons don't [emerg] before the rootfs.vfs mount-table
/// path lands (PR #342-#345). When that PR merges this whole function
/// goes away.
fn synthetic_file_content(path: &[u8]) -> Option<&'static [u8]> {
    match path {
        b"/etc/passwd" => Some(b"\
root:x:0:0:root:/root:/bin/sh\n\
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n\
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n\
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n\
redis:x:100:100:redis:/var/lib/redis:/usr/sbin/nologin\n\
mysql:x:101:101:mysql:/var/lib/mysql:/usr/sbin/nologin\n\
user:x:1000:1000:user:/home/user:/bin/sh\n\
"),
        b"/etc/group" => Some(b"\
root:x:0:\n\
daemon:x:1:\n\
nogroup:x:65534:\n\
nobody:x:65534:\n\
www-data:x:33:\n\
redis:x:100:\n\
mysql:x:101:\n\
user:x:1000:\n\
"),
        b"/etc/hosts" => Some(b"127.0.0.1\tlocalhost\n::1\tlocalhost\n"),
        _ => None,
    }
}

/// Check if path is a /dev/fd/N or /dev/stdin|stdout|stderr alias.
/// Returns Some(target_fd) if so.
fn match_dev_fd(path: &[u8]) -> Option<i32> {
    if path == b"/dev/stdin" { return Some(0); }
    if path == b"/dev/stdout" { return Some(1); }
    if path == b"/dev/stderr" { return Some(2); }
    if path.starts_with(b"/dev/fd/") {
        let num_bytes = &path[8..];
        if num_bytes.is_empty() { return None; }
        let mut n: i32 = 0;
        for &b in num_bytes {
            if b < b'0' || b > b'9' { return None; }
            n = n.checked_mul(10)?.checked_add((b - b'0') as i32)?;
        }
        return Some(n);
    }
    None
}

/// Try to claim `/dev/fb0` for the calling process.
///
/// `/dev/fb0` is single-owner: at most one process at a time can have an
/// open fd referencing it. Re-opens by the current owner are allowed
/// (mirrors Linux fbdev's "exclusive open" semantics). Anyone else gets
/// `EBUSY`.
fn acquire_fb0_or_busy(pid: u32) -> Result<(), Errno> {
    use core::sync::atomic::Ordering;
    let pid = pid as i32;
    let owner = crate::process_table::FB0_OWNER.load(Ordering::SeqCst);
    if owner != -1 && owner != pid {
        return Err(Errno::EBUSY);
    }
    let _ = crate::process_table::FB0_OWNER
        .compare_exchange(-1, pid, Ordering::SeqCst, Ordering::SeqCst);
    Ok(())
}

/// Release `/dev/fb0` ownership held by `pid`, if any. Idempotent: safe
/// to call from `close`, `munmap`, or process exit even when the process
/// never owned the device.
pub(crate) fn maybe_release_fb0(pid: u32) {
    use core::sync::atomic::Ordering;
    let _ = crate::process_table::FB0_OWNER
        .compare_exchange(pid as i32, -1, Ordering::SeqCst, Ordering::SeqCst);
}

/// True iff `proc` still has an open fd referencing `/dev/fb0`.
fn proc_has_fb0_fd(proc: &Process) -> bool {
    use crate::ofd::FileType;
    for fd_i in 0..1024i32 {
        if let Ok(entry) = proc.fd_table.get(fd_i) {
            if let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) {
                if ofd.file_type == FileType::CharDevice
                    && VirtualDevice::from_host_handle(ofd.host_handle)
                        == Some(VirtualDevice::Fb0)
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Fixed framebuffer geometry. fbDOOM is happy with whatever the device
/// reports; pinning a single mode keeps the implementation small.
const FB_WIDTH: u32 = 640;
const FB_HEIGHT: u32 = 400;
const FB_BYTES_PER_PIXEL: u32 = 4;
const FB_LINE_LENGTH: u32 = FB_WIDTH * FB_BYTES_PER_PIXEL;
const FB_SMEM_LEN: u32 = FB_LINE_LENGTH * FB_HEIGHT;

/// Handle ioctl on `/dev/fb0`.
///
/// Implements the four fbdev ioctls fbDOOM (and most fbdev clients)
/// actually use:
/// - `FBIOGET_VSCREENINFO` / `FBIOGET_FSCREENINFO` report fixed geometry
///   in BGRA32 packed-pixel form.
/// - `FBIOPAN_DISPLAY` is accepted but is a no-op (presentation is driven
///   by host RAF, not user-space pan calls).
/// - `FBIOPUT_VSCREENINFO` accepts only the geometry we expose; anything
///   else is `EINVAL`.
///
/// Anything else returns `ENOTTY`.
fn handle_fb_ioctl(request: u32, buf: &mut [u8]) -> Result<(), Errno> {
    use wasm_posix_shared::fbdev::*;
    match request {
        FBIOGET_VSCREENINFO => {
            if buf.len() < core::mem::size_of::<FbVarScreenInfo>() {
                return Err(Errno::EINVAL);
            }
            let mut v = FbVarScreenInfo::default();
            v.xres = FB_WIDTH;
            v.yres = FB_HEIGHT;
            v.xres_virtual = FB_WIDTH;
            v.yres_virtual = FB_HEIGHT;
            v.bits_per_pixel = FB_BYTES_PER_PIXEL * 8;
            // BGRA32: byte 0 = blue, 1 = green, 2 = red, 3 = alpha.
            v.blue   = FbBitfield { offset: 0,  length: 8, msb_right: 0 };
            v.green  = FbBitfield { offset: 8,  length: 8, msb_right: 0 };
            v.red    = FbBitfield { offset: 16, length: 8, msb_right: 0 };
            v.transp = FbBitfield { offset: 24, length: 8, msb_right: 0 };
            unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut FbVarScreenInfo, v); }
            Ok(())
        }
        FBIOGET_FSCREENINFO => {
            if buf.len() < core::mem::size_of::<FbFixScreenInfo>() {
                return Err(Errno::EINVAL);
            }
            let mut f = FbFixScreenInfo::default();
            f.id[..6].copy_from_slice(b"wasmfb");
            f.smem_len = FB_SMEM_LEN;
            f.line_length = FB_LINE_LENGTH;
            f.fb_type = FB_TYPE_PACKED_PIXELS;
            f.visual = FB_VISUAL_TRUECOLOR;
            unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut FbFixScreenInfo, f); }
            Ok(())
        }
        FBIOPAN_DISPLAY => Ok(()),
        FBIOPUT_VSCREENINFO => {
            if buf.len() < core::mem::size_of::<FbVarScreenInfo>() {
                return Err(Errno::EINVAL);
            }
            let v: FbVarScreenInfo = unsafe {
                core::ptr::read_unaligned(buf.as_ptr() as *const FbVarScreenInfo)
            };
            if v.xres != FB_WIDTH || v.yres != FB_HEIGHT
                || v.bits_per_pixel != FB_BYTES_PER_PIXEL * 8
            {
                return Err(Errno::EINVAL);
            }
            Ok(())
        }
        _ => Err(Errno::ENOTTY),
    }
}

/// Build a synthetic WasmStat for a virtual device.
fn virtual_device_stat(dev: VirtualDevice, uid: u32, gid: u32) -> WasmStat {
    use wasm_posix_shared::mode::S_IFCHR;
    WasmStat {
        st_dev: 5,
        st_ino: dev.ino(),
        st_mode: S_IFCHR | 0o666,
        st_nlink: 1,
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
    }
}

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

    // /dev/fd/N and /dev/stdin|stdout|stderr — dup an existing fd
    if let Some(target_fd) = match_dev_fd(&resolved) {
        let entry = proc.fd_table.get(target_fd)?;
        let ofd_ref = entry.ofd_ref;
        proc.ofd_table.inc_ref(ofd_ref.0);
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(ofd_ref, fd_flags)?;
        return Ok(fd);
    }

    // Virtual device nodes — handle in-kernel, no host call
    if let Some(dev) = match_virtual_device(&resolved) {
        if dev == VirtualDevice::Fb0 {
            acquire_fb0_or_busy(proc.pid)?;
        }
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::CharDevice, status_flags, dev.host_handle(), resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/ptmx — allocate a new PTY master
    if resolved == b"/dev/ptmx" {
        let pty_idx = crate::pty::alloc_pty().ok_or(Errno::ENOSPC)?;
        let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
        pty.master_refs += 1;
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::PtyMaster, status_flags, pty_idx as i64, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/pts/N — open PTY slave
    if resolved.starts_with(b"/dev/pts/") {
        let num_str = &resolved[9..];
        let pty_idx = parse_ascii_usize(num_str).ok_or(Errno::ENOENT)?;
        let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::ENOENT)?;
        if pty.locked {
            return Err(Errno::EIO); // must call unlockpt first
        }
        pty.slave_refs += 1;
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::PtySlave, status_flags, pty_idx as i64, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/tty — open controlling terminal (alias for current session's PTY or stdin)
    if resolved == b"/dev/tty" {
        // Check if any open fd refers to a PTY slave — use that
        for fd_i in 0..1024i32 {
            if let Ok(entry) = proc.fd_table.get(fd_i as i32) {
                if let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) {
                    if ofd.file_type == FileType::PtySlave {
                        // Dup this fd
                        proc.ofd_table.inc_ref(entry.ofd_ref.0);
                        let fd_flags = oflags_to_fd_flags(oflags);
                        let fd = proc.fd_table.alloc(entry.ofd_ref, fd_flags)?;
                        return Ok(fd);
                    }
                }
            }
        }
        // Fallback: dup stdin (fd 0) as the controlling terminal
        if let Ok(entry) = proc.fd_table.get(0) {
            let ofd_ref = entry.ofd_ref;
            proc.ofd_table.inc_ref(ofd_ref.0);
            let fd_flags = oflags_to_fd_flags(oflags);
            let fd = proc.fd_table.alloc(ofd_ref, fd_flags)?;
            return Ok(fd);
        }
        return Err(Errno::ENXIO);
    }

    // Synthetic /etc files — in-kernel read-only files (passwd, group, hosts)
    if synthetic_file_content(&resolved).is_some() {
        if oflags & (O_WRONLY | O_RDWR) != 0 {
            return Err(Errno::EACCES);
        }
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::Regular, status_flags, SYNTHETIC_FILE_HANDLE, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // Procfs (/proc/...) — in-kernel virtual filesystem
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        return crate::procfs::procfs_open(proc, &entry, resolved, oflags);
    }

    // Devfs (/dev, /dev/pts, etc.) — in-kernel directory listing
    if crate::devfs::match_devfs_dir(&resolved).is_some() {
        return crate::devfs::devfs_open_dir(proc, resolved, oflags);
    }

    // POSIX: open() on an existing directory with O_CREAT returns EISDIR
    if oflags & O_CREAT != 0 {
        if let Ok(st) = host.host_stat(&resolved) {
            if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
                return Err(Errno::EISDIR);
            }
        }
    }

    let host_handle = host.host_open(&resolved, oflags, effective_mode)?;

    let file_type = if oflags & O_DIRECTORY != 0 {
        FileType::Directory
    } else if let Ok(st) = host.host_stat(&resolved) {
        if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
            FileType::Directory
        } else {
            FileType::Regular
        }
    } else {
        FileType::Regular
    };

    // Status flags = oflags minus creation-only flags
    let status_flags = oflags & !CREATION_FLAGS;

    let ofd_idx = proc.ofd_table.create(file_type, status_flags, host_handle, resolved);

    let fd_flags = oflags_to_fd_flags(oflags);

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
    if host_handle >= 0 && file_type != FileType::Pipe && file_type != FileType::Socket
        && file_type != FileType::PtyMaster && file_type != FileType::PtySlave {
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
                    // Host-delegated pipe: only close if no other process shares it
                    if crate::ofd::host_handle_close_ref(host_handle) {
                        let _ = host.host_close(host_handle);
                    }
                } else {
                    // Kernel-internal pipe
                    let pipe_idx = (-(host_handle + 1)) as usize;
                    let pipe = if crate::is_centralized_mode() {
                        unsafe { crate::pipe::global_pipe_table().get_mut(pipe_idx) }
                    } else {
                        proc.pipes.get_mut(pipe_idx).and_then(|p| p.as_mut())
                    };
                    if let Some(pipe) = pipe {
                        let access_mode = status_flags & O_ACCMODE;
                        if access_mode == O_RDONLY {
                            pipe.close_read_end();
                        } else {
                            pipe.close_write_end();
                        }
                        // Free pipe slot if both endpoints are closed
                        if crate::is_centralized_mode() {
                            unsafe { crate::pipe::global_pipe_table().free_if_closed(pipe_idx) };
                        }
                    }
                }
            }
            FileType::Socket => {
                let sock_idx = (-(host_handle + 1)) as usize;
                let mut send_idx_to_free: Option<usize> = None;
                let mut recv_idx_to_free: Option<usize> = None;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    if let Some(net_handle) = sock.host_net_handle {
                        let _ = host.host_net_close(net_handle);
                    }
                    // Drop our reference to the shared listener backlog (if any).
                    // The slot is freed when the last process holding the
                    // listener closes it.
                    if let Some(shared_idx) = sock.shared_backlog_idx {
                        unsafe { crate::socket::shared_listener_backlog_table().dec_ref(shared_idx) };
                    }
                    let use_global = sock.global_pipes;
                    if let Some(send_idx) = sock.send_buf_idx {
                        let pipe = if use_global {
                            unsafe { crate::pipe::global_pipe_table().get_mut(send_idx) }
                        } else {
                            proc.pipes.get_mut(send_idx).and_then(|p| p.as_mut())
                        };
                        if let Some(pipe) = pipe {
                            pipe.close_write_end();
                            if use_global {
                                unsafe { crate::pipe::global_pipe_table().free_if_closed(send_idx) };
                            } else if pipe.is_fully_closed() {
                                send_idx_to_free = Some(send_idx);
                            }
                        }
                    }
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        let pipe = if use_global {
                            unsafe { crate::pipe::global_pipe_table().get_mut(recv_idx) }
                        } else {
                            proc.pipes.get_mut(recv_idx).and_then(|p| p.as_mut())
                        };
                        if let Some(pipe) = pipe {
                            pipe.close_read_end();
                            if use_global {
                                unsafe { crate::pipe::global_pipe_table().free_if_closed(recv_idx) };
                            } else if pipe.is_fully_closed() {
                                recv_idx_to_free = Some(recv_idx);
                            }
                        }
                    }
                }
                // Free fully-closed process-local pipe slots
                if let Some(idx) = send_idx_to_free {
                    if let Some(slot) = proc.pipes.get_mut(idx) { *slot = None; }
                }
                if let Some(idx) = recv_idx_to_free {
                    if let Some(slot) = proc.pipes.get_mut(idx) { *slot = None; }
                }
                proc.sockets.free(sock_idx);
            }
            FileType::EventFd => {
                // Free the eventfd state
                let efd_idx = (-(host_handle + 1)) as usize;
                if let Some(slot) = proc.eventfds.get_mut(efd_idx) {
                    *slot = None;
                }
            }
            FileType::Epoll => {
                let ep_idx = (-(host_handle + 1)) as usize;
                if let Some(slot) = proc.epolls.get_mut(ep_idx) { *slot = None; }
            }
            FileType::TimerFd => {
                let tfd_idx = (-(host_handle + 1)) as usize;
                if let Some(slot) = proc.timerfds.get_mut(tfd_idx) { *slot = None; }
            }
            FileType::SignalFd => {
                let sfd_idx = (-(host_handle + 1)) as usize;
                if let Some(slot) = proc.signalfds.get_mut(sfd_idx) { *slot = None; }
            }
            FileType::MemFd => {
                let memfd_idx = (-(host_handle + 1)) as usize;
                if let Some(slot) = proc.memfds.get_mut(memfd_idx) { *slot = None; }
            }
            FileType::PtyMaster => {
                let pty_idx = host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if pty.master_refs > 0 { pty.master_refs -= 1; }
                    if !pty.is_alive() { crate::pty::free_pty(pty_idx); }
                }
            }
            FileType::PtySlave => {
                let pty_idx = host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if pty.slave_refs > 0 { pty.slave_refs -= 1; }
                    if !pty.is_alive() { crate::pty::free_pty(pty_idx); }
                }
            }
            _ => {
                // Close any lazily-opened directory iteration handle
                if dir_host_handle >= 0 {
                    let _ = host.host_closedir(dir_host_handle);
                }
                // Procfs buffers: free the content buffer
                if crate::procfs::is_procfs_buf_handle(host_handle) {
                    let buf_idx = crate::procfs::procfs_buf_idx(host_handle);
                    if let Some(slot) = proc.procfs_bufs.get_mut(buf_idx) {
                        *slot = None;
                    }
                } else if host_handle == crate::procfs::PROCFS_DIR_HANDLE
                    || host_handle == crate::devfs::DEVFS_DIR_HANDLE {
                    // Procfs/devfs directory: nothing to clean up
                // Virtual char devices and synthetic files have no host handle to close
                } else if (file_type == FileType::CharDevice && host_handle < 0)
                    || host_handle == SYNTHETIC_FILE_HANDLE
                {
                    // Nothing to clean up on host side
                } else if crate::ofd::host_handle_close_ref(host_handle) {
                    // Cross-process refcount reached 0 — safe to close the host handle.
                    // If the handle was never shared (not in the refcount table),
                    // host_handle_close_ref returns true immediately.
                    host.host_close(host_handle)?;
                }
            }
        }
    }

    // /dev/fb0 ownership: release if this process no longer holds any
    // Fb0 fd and no live mmap remains. Linux semantics: an mmap
    // outlives close of its fd, so we only drop ownership when the
    // mapping is also gone (handled in munmap / process exit).
    if file_type == FileType::CharDevice
        && VirtualDevice::from_host_handle(host_handle) == Some(VirtualDevice::Fb0)
        && proc.fb_binding.is_none()
        && !proc_has_fb0_fd(proc)
    {
        maybe_release_fb0(proc.pid);
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
                // First attempt: try to read from pipe (centralized uses global table)
                {
                    let pipe = if crate::is_centralized_mode() {
                        unsafe { crate::pipe::global_pipe_table().get_mut(pipe_idx) }
                    } else {
                        proc.pipes.get_mut(pipe_idx).and_then(|p| p.as_mut())
                    }.ok_or(Errno::EBADF)?;
                    let n = pipe.read(buf);
                    if n > 0 {
                        return Ok(n);
                    }
                    if !pipe.is_write_end_open() {
                        return Ok(0); // EOF — write end closed
                    }
                }
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                // Non-centralized blocking loop (per-process pipes only)
                loop {
                    if proc.signals.deliverable() != 0 {
                        if !proc.signals.should_restart() {
                            return Err(Errno::EINTR);
                        }
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
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
                        return Ok(0);
                    }
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
                    // Loopback path: use pipe buffers if available
                    if let Some(recv_buf_idx) = sock.recv_buf_idx {
                        let use_global = sock.global_pipes;
                        loop {
                            let pipe = if use_global {
                                unsafe { crate::pipe::global_pipe_table().get_mut(recv_buf_idx) }
                            } else {
                                proc.pipes.get_mut(recv_buf_idx).and_then(|p| p.as_mut())
                            }.ok_or(Errno::EBADF)?;
                            let n = pipe.read(buf);
                            if n > 0 {
                                return Ok(n);
                            }
                            if !pipe.is_write_end_open() {
                                return Ok(0);
                            }
                            if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
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
                    // External path: delegate to host
                    let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
                    host.host_net_recv(net_handle, buf.len() as u32, 0, buf)
                }
                SocketDomain::Unix => {
                    let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
                    let use_global = sock.global_pipes;
                    loop {
                        let pipe = if use_global {
                            unsafe { crate::pipe::global_pipe_table().get_mut(recv_buf_idx) }
                        } else {
                            proc.pipes.get_mut(recv_buf_idx).and_then(|p| p.as_mut())
                        }.ok_or(Errno::EBADF)?;
                        let n = pipe.read(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                        if !pipe.is_write_end_open() {
                            return Ok(0); // EOF — peer closed
                        }
                        if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
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
        FileType::TimerFd => {
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let tfd_idx = (-(host_handle + 1)) as usize;
            // Compute expirations lazily
            let (now_sec, now_nsec) = host.host_clock_gettime(0)?;
            if let Some(Some(tfd)) = proc.timerfds.get_mut(tfd_idx) {
                timerfd_compute_expirations(tfd, now_sec, now_nsec);
            }
            let tfd = proc.timerfds.get_mut(tfd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            if tfd.expirations == 0 {
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                loop {
                    if proc.signals.deliverable() != 0 && !proc.signals.should_restart() {
                        return Err(Errno::EINTR);
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                    let (now_sec, now_nsec) = host.host_clock_gettime(0)?;
                    if let Some(Some(tfd)) = proc.timerfds.get_mut(tfd_idx) {
                        timerfd_compute_expirations(tfd, now_sec, now_nsec);
                        if tfd.expirations > 0 { break; }
                    } else {
                        return Err(Errno::EBADF);
                    }
                }
            }
            let tfd = proc.timerfds.get_mut(tfd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            let count = tfd.expirations;
            tfd.expirations = 0;
            buf[..8].copy_from_slice(&count.to_le_bytes());
            Ok(8)
        }
        FileType::SignalFd => {
            // signalfd read: return signalfd_siginfo for pending signals matching mask.
            // signalfd_siginfo is 128 bytes. For simplicity, we return a minimal version.
            if buf.len() < 128 {
                return Err(Errno::EINVAL);
            }
            let sfd_idx = (-(host_handle + 1)) as usize;
            let mask = proc.signalfds.get(sfd_idx)
                .and_then(|s| s.as_ref())
                .ok_or(Errno::EBADF)?
                .mask;
            // Find a pending signal matching the mask
            let pending = proc.signals.pending_mask();
            let matching = pending & mask;
            if matching == 0 {
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                // Block until signal arrives (non-centralized only)
                loop {
                    if proc.signals.deliverable() != 0 && !proc.signals.should_restart() {
                        return Err(Errno::EINTR);
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                    let mask2 = proc.signalfds.get(sfd_idx)
                        .and_then(|s| s.as_ref())
                        .ok_or(Errno::EBADF)?
                        .mask;
                    if proc.signals.pending_mask() & mask2 != 0 {
                        break;
                    }
                }
            }
            // Re-read mask and find signal
            let mask = proc.signalfds.get(sfd_idx)
                .and_then(|s| s.as_ref())
                .ok_or(Errno::EBADF)?
                .mask;
            let pending = proc.signals.pending_mask();
            let matching = pending & mask;
            if matching == 0 {
                return Err(Errno::EAGAIN);
            }
            // Find lowest matching signal (bit N = signal N+1, musl 0-based convention)
            let signo = matching.trailing_zeros() + 1;
            // Consume the signal from pending
            proc.signals.clear_pending(signo);
            // Write signalfd_siginfo (128 bytes): only ssi_signo at offset 0
            for b in buf[..128].iter_mut() { *b = 0; }
            buf[..4].copy_from_slice(&signo.to_le_bytes());
            Ok(128)
        }
        FileType::EventFd => {
            // eventfd read: must be exactly 8 bytes
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let efd_idx = (-(host_handle + 1)) as usize;
            let efd = proc.eventfds.get_mut(efd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            if efd.counter == 0 {
                // Would block
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                // Blocking mode: loop (non-centralized only)
                loop {
                    if proc.signals.deliverable() != 0 && !proc.signals.should_restart() {
                        return Err(Errno::EINTR);
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                    let efd = proc.eventfds.get_mut(efd_idx)
                        .and_then(|s| s.as_mut())
                        .ok_or(Errno::EBADF)?;
                    if efd.counter > 0 {
                        break;
                    }
                }
            }
            let efd = proc.eventfds.get_mut(efd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            let value = if efd.semaphore {
                efd.counter -= 1;
                1u64
            } else {
                let v = efd.counter;
                efd.counter = 0;
                v
            };
            buf[..8].copy_from_slice(&value.to_le_bytes());
            Ok(8)
        }
        FileType::PtyMaster => {
            let pty_idx = host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            if pty.slave_refs == 0 {
                return Ok(0); // EOF — slave side closed
            }
            let n = pty.master_read(buf);
            if n > 0 {
                return Ok(n);
            }
            // No data available
            if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                return Err(Errno::EAGAIN);
            }
            Ok(0)
        }
        FileType::PtySlave => {
            let pty_idx = host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            if pty.master_refs == 0 {
                return Ok(0); // EOF — master side closed (hangup)
            }
            let n = pty.slave_read(buf);
            if n > 0 {
                return Ok(n);
            }
            // No data available
            if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                return Err(Errno::EAGAIN);
            }
            Ok(0)
        }
        _ => {
            // Virtual character devices — handle in-kernel
            if file_type == FileType::CharDevice {
                if let Some(dev) = VirtualDevice::from_host_handle(host_handle) {
                    let n = match dev {
                        // /dev/fb0 doesn't support direct read — software is
                        // expected to mmap. Return 0 (EOF-like) rather than
                        // making up pixel bytes, matching the existing
                        // "no-op for unsupported access" pattern.
                        VirtualDevice::Null | VirtualDevice::Fb0 => 0,
                        VirtualDevice::Zero | VirtualDevice::Full => {
                            for b in buf.iter_mut() { *b = 0; }
                            buf.len()
                        }
                        VirtualDevice::Urandom => {
                            host.host_getrandom(buf)?
                        }
                    };
                    return Ok(n);
                }

                // Terminal (stdin) line discipline processing
                if host_handle == 0 {
                    if proc.terminal.is_canonical() {
                        // ICANON mode: return from cooked buffer if available
                        if proc.terminal.has_cooked_data() {
                            let n = proc.terminal.read_cooked(buf);
                            return Ok(n);
                        }
                        // Need more input — read from host and process through line discipline
                        let mut raw = [0u8; 256];
                        let raw_n = host.host_read(0, &mut raw)?;
                        if raw_n == 0 {
                            return Ok(0); // host EOF
                        }
                        for &byte in &raw[..raw_n] {
                            let (echo, _sig) = proc.terminal.process_input_byte(byte);
                            if !echo.is_empty() {
                                // Echo back to terminal (stdout = host_handle 1)
                                let _ = host.host_write(1, &echo);
                            }
                        }
                        // Return cooked data if a complete line is now available
                        let n = proc.terminal.read_cooked(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                        // No complete line yet — in centralized mode return EAGAIN,
                        // otherwise would loop (traditional blocking mode)
                        if crate::is_centralized_mode() || status_flags & O_NONBLOCK != 0 {
                            return Err(Errno::EAGAIN);
                        }
                        return Ok(0);
                    }
                    // Non-canonical mode: pass through raw bytes from host
                    // VMIN/VTIME semantics are approximated
                    let n = host.host_read(0, buf)?;
                    return Ok(n);
                }
            }
            // procfs: read from snapshot buffer
            if crate::procfs::is_procfs_buf_handle(host_handle) {
                let buf_idx = crate::procfs::procfs_buf_idx(host_handle);
                let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
                let offset = ofd.offset as usize;
                let data = proc.procfs_bufs.get(buf_idx)
                    .and_then(|s| s.as_ref())
                    .ok_or(Errno::EBADF)?;
                if offset >= data.len() {
                    return Ok(0); // EOF
                }
                let remaining = &data[offset..];
                let n = buf.len().min(remaining.len());
                buf[..n].copy_from_slice(&remaining[..n]);
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.offset += n as i64;
                return Ok(n);
            }

            // memfd: read from in-memory buffer
            if file_type == FileType::MemFd {
                let memfd_idx = (-(host_handle + 1)) as usize;
                let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
                let offset = ofd.offset as usize;
                let data = proc.memfds.get(memfd_idx)
                    .and_then(|s| s.as_ref())
                    .ok_or(Errno::EBADF)?;
                if offset >= data.len() {
                    return Ok(0); // EOF
                }
                let remaining = &data[offset..];
                let n = buf.len().min(remaining.len());
                buf[..n].copy_from_slice(&remaining[..n]);
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.offset += n as i64;
                return Ok(n);
            }

            // Synthetic in-kernel files (/etc/passwd, /etc/group, /etc/hosts)
            if host_handle == SYNTHETIC_FILE_HANDLE {
                let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
                let content = synthetic_file_content(&ofd.path).unwrap_or(b"");
                let offset = ofd.offset as usize;
                if offset >= content.len() {
                    return Ok(0); // EOF
                }
                let remaining = &content[offset..];
                let n = buf.len().min(remaining.len());
                buf[..n].copy_from_slice(&remaining[..n]);
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.offset += n as i64;
                return Ok(n);
            }

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

    // Zero-length write: POSIX returns 0 without writing
    if buf.is_empty() {
        return Ok(0);
    }

    match file_type {
        FileType::Pipe => {
            if host_handle >= 0 {
                // Host-delegated pipe (cross-process): use host_write
                let n = host.host_write(host_handle, buf)?;
                Ok(n)
            } else {
                // Kernel-internal pipe
                const PIPE_BUF: usize = 4096;
                let pipe_idx = (-(host_handle + 1)) as usize;
                // First attempt: try to write to pipe (centralized uses global table)
                {
                    let pipe = if crate::is_centralized_mode() {
                        unsafe { crate::pipe::global_pipe_table().get_mut(pipe_idx) }
                    } else {
                        proc.pipes.get_mut(pipe_idx).and_then(|p| p.as_mut())
                    }.ok_or(Errno::EBADF)?;
                    if !pipe.is_read_end_open() {
                        proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                        return Err(Errno::EPIPE);
                    }
                    // POSIX PIPE_BUF atomicity: writes ≤ PIPE_BUF must not be partial
                    if buf.len() <= PIPE_BUF && pipe.free_space() < buf.len() {
                        // Not enough space for atomic write — fall through to block/EAGAIN
                    } else {
                        let n = pipe.write(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                    }
                }
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                // Non-centralized blocking loop (per-process pipes only)
                loop {
                    if proc.signals.deliverable() != 0 {
                        if !proc.signals.should_restart() {
                            return Err(Errno::EINTR);
                        }
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                    let pipe = proc
                        .pipes
                        .get_mut(pipe_idx)
                        .and_then(|p| p.as_mut())
                        .ok_or(Errno::EBADF)?;
                    if !pipe.is_read_end_open() {
                        proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                        return Err(Errno::EPIPE);
                    }
                    if buf.len() <= PIPE_BUF && pipe.free_space() < buf.len() {
                        continue; // Not enough space for atomic write
                    }
                    let n = pipe.write(buf);
                    if n > 0 {
                        return Ok(n);
                    }
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
                    // Loopback path: use pipe buffers if available
                    if let Some(send_buf_idx) = sock.send_buf_idx {
                        let use_global = sock.global_pipes;
                        loop {
                            let pipe = if use_global {
                                unsafe { crate::pipe::global_pipe_table().get_mut(send_buf_idx) }
                            } else {
                                proc.pipes.get_mut(send_buf_idx).and_then(|p| p.as_mut())
                            }.ok_or(Errno::EBADF)?;
                            if !pipe.is_read_end_open() {
                                proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                                return Err(Errno::EPIPE);
                            }
                            let n = pipe.write(buf);
                            if n > 0 {
                                return Ok(n);
                            }
                            if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
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
                    // External path: delegate to host
                    let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
                    host.host_net_send(net_handle, buf, 0)
                }
                SocketDomain::Unix => {
                    if sock.send_buf_idx.is_none() && sock.sock_type == crate::socket::SocketType::Dgram {
                        return Ok(buf.len()); // bit-bucket for SOCK_DGRAM (syslog pattern)
                    }
                    let send_buf_idx = sock.send_buf_idx.ok_or(Errno::ENOTCONN)?;
                    let use_global = sock.global_pipes;
                    loop {
                        let pipe = if use_global {
                            unsafe { crate::pipe::global_pipe_table().get_mut(send_buf_idx) }
                        } else {
                            proc.pipes.get_mut(send_buf_idx).and_then(|p| p.as_mut())
                        }.ok_or(Errno::EBADF)?;
                        if !pipe.is_read_end_open() {
                            proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                            return Err(Errno::EPIPE);
                        }
                        let n = pipe.write(buf);
                        if n > 0 {
                            return Ok(n);
                        }
                        if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
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
        FileType::EventFd => {
            // eventfd write: must be exactly 8 bytes
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let value = u64::from_le_bytes(buf[..8].try_into().unwrap());
            if value == u64::MAX {
                return Err(Errno::EINVAL);
            }
            let efd_idx = (-(host_handle + 1)) as usize;
            let efd = proc.eventfds.get_mut(efd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            let max_val = u64::MAX - 1;
            if efd.counter > max_val - value {
                // Would overflow — block or EAGAIN
                if status_flags & O_NONBLOCK != 0 || crate::is_centralized_mode() {
                    return Err(Errno::EAGAIN);
                }
                loop {
                    if proc.signals.deliverable() != 0 && !proc.signals.should_restart() {
                        return Err(Errno::EINTR);
                    }
                    let _ = host.host_nanosleep(0, 1_000_000);
                    let efd = proc.eventfds.get_mut(efd_idx)
                        .and_then(|s| s.as_mut())
                        .ok_or(Errno::EBADF)?;
                    if efd.counter <= max_val - value {
                        break;
                    }
                }
            }
            let efd = proc.eventfds.get_mut(efd_idx)
                .and_then(|s| s.as_mut())
                .ok_or(Errno::EBADF)?;
            efd.counter += value;
            Ok(8)
        }
        FileType::PtyMaster => {
            let pty_idx = host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            if pty.slave_refs == 0 {
                proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                return Err(Errno::EIO);
            }
            // Master write → line discipline → slave input
            for &byte in buf.iter() {
                pty.process_master_input(byte);
            }
            Ok(buf.len())
        }
        FileType::PtySlave => {
            let pty_idx = host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            if pty.master_refs == 0 {
                proc.signals.raise(wasm_posix_shared::signal::SIGPIPE);
                return Err(Errno::EIO);
            }
            // Slave write → output processing → master read
            let n = pty.slave_write(buf);
            Ok(n)
        }
        _ => {
            // memfd: write to in-memory buffer
            if file_type == FileType::MemFd {
                let memfd_idx = (-(host_handle + 1)) as usize;
                let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
                let offset = ofd.offset as usize;
                let data = proc.memfds.get_mut(memfd_idx)
                    .and_then(|s| s.as_mut())
                    .ok_or(Errno::EBADF)?;
                let end = offset + buf.len();
                if end > data.len() {
                    data.resize(end, 0);
                }
                data[offset..end].copy_from_slice(buf);
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.offset += buf.len() as i64;
                return Ok(buf.len());
            }

            // Virtual character devices — handle in-kernel
            if file_type == FileType::CharDevice {
                if let Some(dev) = VirtualDevice::from_host_handle(host_handle) {
                    return match dev {
                        VirtualDevice::Full => Err(Errno::ENOSPC),
                        VirtualDevice::Fb0 => {
                            // Write-based fbdev clients (fbDOOM-style): the
                            // user fills its own buffer, then `write(fd_fb,
                            // pixels, len)` to push them to the framebuffer.
                            // We don't use mmap here — register a sentinel
                            // FbBinding with addr=0/len=0 on first write so
                            // the host knows to allocate its own pixel
                            // buffer for this pid; per-write deltas go
                            // through `fb_write`.
                            if proc.fb_binding.is_none() {
                                proc.fb_binding = Some(crate::process::FbBinding {
                                    addr: 0,
                                    len: 0,
                                    w: FB_WIDTH,
                                    h: FB_HEIGHT,
                                    stride: FB_LINE_LENGTH,
                                    fmt: 0,
                                });
                                host.bind_framebuffer(
                                    proc.pid as i32, 0, 0,
                                    FB_WIDTH, FB_HEIGHT, FB_LINE_LENGTH, 0,
                                );
                            }
                            let offset = ofd.offset.max(0) as usize;
                            let max_off = (FB_SMEM_LEN as usize)
                                .saturating_sub(offset);
                            let n = buf.len().min(max_off);
                            if n > 0 {
                                host.fb_write(proc.pid as i32, offset, &buf[..n]);
                                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                                    ofd.offset += n as i64;
                                }
                            }
                            // Linux fbdev returns the requested length even
                            // when capping at smem_len; we mirror that.
                            Ok(buf.len())
                        }
                        _ => Ok(buf.len()), // Null, Zero, Urandom: discard
                    };
                }
            }
            // O_APPEND: seek to end before writing (POSIX atomicity guaranteed by centralized kernel)
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

    // Non-seekable file types.
    if matches!(ofd.file_type, FileType::Pipe | FileType::Socket | FileType::EventFd | FileType::Epoll | FileType::TimerFd | FileType::SignalFd | FileType::PtyMaster | FileType::PtySlave) {
        return Err(Errno::ESPIPE);
    }

    // Directory: lseek(fd, offset, SEEK_SET) supports rewind and seekdir.
    // musl's seekdir calls lseek(fd, telldir_cookie, SEEK_SET) to restore
    // directory position. The cookie is the d_off value from getdents64.
    if ofd.file_type == FileType::Directory {
        if whence == SEEK_SET {
            // Close the existing dir handle if open
            if ofd.dir_host_handle >= 0 {
                let _ = host.host_closedir(ofd.dir_host_handle);
            }
            ofd.dir_host_handle = -1; // will be reopened by next getdents64
            ofd.dir_synth_state = 0;
            ofd.dir_entry_offset = 0;
            ofd.offset = offset;

            if offset > 0 {
                // Reopen directory and skip `offset` entries to reach the target position
                let path = ofd.path.clone();
                let h = host.host_opendir(&path)?;
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.dir_host_handle = h;
                ofd.dir_synth_state = 2; // skip synthetic . and ..

                // Skip entries until we reach the target offset
                // (d_off cookies are 1-based: . = 1, .. = 2, first host entry = 3, ...)
                let host_entries_to_skip = (offset - 2).max(0);
                let mut name_buf = [0u8; 256];
                let mut skipped = 0i64;
                while skipped < host_entries_to_skip {
                    match host.host_readdir(h, &mut name_buf)? {
                        Some((_, _, name_len)) => {
                            // Skip host "." and ".." (already counted in synthetic)
                            if (name_len == 1 && name_buf[0] == b'.') ||
                               (name_len == 2 && name_buf[0] == b'.' && name_buf[1] == b'.') {
                                continue;
                            }
                            skipped += 1;
                        }
                        None => break,
                    }
                }
                let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
                ofd.dir_entry_offset = offset;
            }
            return Ok(offset);
        }
        // Other whence values on directories: just return current offset
        return Ok(ofd.offset);
    }

    // Virtual char devices: seek is a no-op for null/zero/etc. /dev/fb0
    // is the exception — seek positions the cursor for the write-based
    // pixel-blit path used by fbDOOM-style software.
    if ofd.file_type == FileType::CharDevice {
        if let Some(dev) = VirtualDevice::from_host_handle(ofd.host_handle) {
            if dev == VirtualDevice::Fb0 {
                let cur = ofd.offset;
                let new_off = match whence {
                    SEEK_SET => offset,
                    SEEK_CUR => cur + offset,
                    SEEK_END => FB_SMEM_LEN as i64 + offset,
                    _ => return Err(Errno::EINVAL),
                };
                if new_off < 0 {
                    return Err(Errno::EINVAL);
                }
                ofd.offset = new_off;
                return Ok(new_off);
            }
            return Ok(0);
        }
    }

    // Procfs/devfs directory: lseek resets position
    if ofd.host_handle == crate::procfs::PROCFS_DIR_HANDLE
        || ofd.host_handle == crate::devfs::DEVFS_DIR_HANDLE {
        if whence == SEEK_SET {
            ofd.dir_synth_state = 0;
            ofd.dir_entry_offset = 0;
            ofd.offset = offset;
            return Ok(offset);
        }
        return Ok(ofd.offset);
    }

    // Procfs file buffers: compute offset against snapshot length
    if crate::procfs::is_procfs_buf_handle(ofd.host_handle) {
        let buf_idx = crate::procfs::procfs_buf_idx(ofd.host_handle);
        let size = proc.procfs_bufs.get(buf_idx)
            .and_then(|s| s.as_ref())
            .map_or(0, |d| d.len() as i64);
        let new_pos = match whence {
            SEEK_SET => offset,
            SEEK_CUR => ofd.offset + offset,
            SEEK_END => size + offset,
            _ => return Err(Errno::EINVAL),
        };
        if new_pos < 0 { return Err(Errno::EINVAL); }
        ofd.offset = new_pos;
        return Ok(new_pos);
    }

    // Synthetic in-kernel files: compute offset without host call
    if ofd.host_handle == SYNTHETIC_FILE_HANDLE {
        let size = synthetic_file_content(&ofd.path).map_or(0, |c| c.len() as i64);
        let new_pos = match whence {
            SEEK_SET => offset,
            SEEK_CUR => ofd.offset + offset,
            SEEK_END => size + offset,
            _ => return Err(Errno::EINVAL),
        };
        if new_pos < 0 { return Err(Errno::EINVAL); }
        ofd.offset = new_pos;
        return Ok(new_pos);
    }

    // MemFd: compute offset against in-memory buffer
    if ofd.file_type == FileType::MemFd {
        let memfd_idx = (-(ofd.host_handle + 1)) as usize;
        let size = proc.memfds.get(memfd_idx)
            .and_then(|s| s.as_ref())
            .map_or(0, |d| d.len() as i64);
        let new_pos = match whence {
            SEEK_SET => offset,
            SEEK_CUR => ofd.offset + offset,
            SEEK_END => size + offset,
            _ => return Err(Errno::EINVAL),
        };
        if new_pos < 0 { return Err(Errno::EINVAL); }
        ofd.offset = new_pos;
        return Ok(new_pos);
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
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_WRONLY {
        return Err(Errno::EBADF);
    }

    // pread is only valid for seekable fds
    if matches!(ofd.file_type, FileType::Pipe | FileType::Socket | FileType::EventFd | FileType::Epoll | FileType::TimerFd | FileType::SignalFd | FileType::PtyMaster | FileType::PtySlave) {
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
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_RDONLY {
        return Err(Errno::EBADF);
    }

    if matches!(ofd.file_type, FileType::Pipe | FileType::Socket | FileType::EventFd | FileType::Epoll | FileType::TimerFd | FileType::SignalFd | FileType::PtyMaster | FileType::PtySlave) {
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
            match sys_pread(proc, host, in_fd, &mut buf[..to_read], cur_offset) {
                Ok(n) => {
                    cur_offset += n as i64;
                    n
                }
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        } else {
            match sys_read(proc, host, in_fd, &mut buf[..to_read]) {
                Ok(n) => n,
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        };

        if n == 0 {
            break; // EOF
        }

        match sys_write(proc, host, out_fd, &buf[..n]) {
            Ok(written) => {
                total += written;
                if written < n {
                    break; // Short write
                }
            }
            Err(e) => {
                if total > 0 { return Ok(total); }
                return Err(e);
            }
        }
    }
    Ok(total)
}

/// copy_file_range -- copy data between file descriptors with offsets.
/// Emulated with pread+pwrite (no zero-copy in Wasm).
/// If off_in is None, reads from current position and advances it.
/// If off_out is None, writes to current position and advances it.
pub fn sys_copy_file_range(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd_in: i32,
    off_in: Option<i64>,
    fd_out: i32,
    off_out: Option<i64>,
    len: usize,
) -> Result<usize, Errno> {
    let mut total = 0usize;
    let mut buf = [0u8; 4096];
    let mut cur_off_in = off_in.unwrap_or(-1);
    let mut cur_off_out = off_out.unwrap_or(-1);

    while total < len {
        let to_read = (len - total).min(buf.len());
        let n = if off_in.is_some() {
            match sys_pread(proc, host, fd_in, &mut buf[..to_read], cur_off_in) {
                Ok(n) => {
                    cur_off_in += n as i64;
                    n
                }
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        } else {
            match sys_read(proc, host, fd_in, &mut buf[..to_read]) {
                Ok(n) => n,
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        };
        if n == 0 {
            break; // EOF
        }
        let written = if off_out.is_some() {
            match sys_pwrite(proc, host, fd_out, &buf[..n], cur_off_out) {
                Ok(w) => {
                    cur_off_out += w as i64;
                    w
                }
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        } else {
            match sys_write(proc, host, fd_out, &buf[..n]) {
                Ok(w) => w,
                Err(e) => {
                    if total > 0 { return Ok(total); }
                    return Err(e);
                }
            }
        };
        total += written;
        if written < n {
            break;
        }
    }
    Ok(total)
}

/// splice -- move data between two file descriptors.
/// At least one must be a pipe (not enforced here).
/// Emulated with read+write (no zero-copy in Wasm).
pub fn sys_splice(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd_in: i32,
    off_in: Option<i64>,
    fd_out: i32,
    off_out: Option<i64>,
    len: usize,
    _flags: u32,
) -> Result<usize, Errno> {
    // Reuse copy_file_range logic — same semantics
    sys_copy_file_range(proc, host, fd_in, off_in, fd_out, off_out, len)
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

    // Apply O_CLOEXEC / O_CLOFORK flags to the new fd.
    let new_fd_flags = oflags_to_fd_flags(flags);
    if new_fd_flags != 0 {
        if let Ok(entry) = proc.fd_table.get_mut(newfd) {
            entry.fd_flags = new_fd_flags;
        }
    }

    Ok(result)
}

/// Create a pipe, returning (read_fd, write_fd).
pub fn sys_pipe(proc: &mut Process) -> Result<(i32, i32), Errno> {
    // Fork child re-execution: return inherited pipe FDs instead of creating
    // new pipes. The child re-executes _start and calls pipe() again, but
    // should get the same FDs pointing to the shared pipe buffers.
    if proc.fork_child && !proc.fork_pipe_replay.is_empty() {
        let (read_fd, write_fd) = proc.fork_pipe_replay.remove(0);
        return Ok((read_fd, write_fd));
    }

    let pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);

    // Find or append a slot in the pipe table.
    // Centralized mode: use global pipe table (shared across processes for fork).
    // Non-centralized mode: use per-process pipe table (backward compat for tests).
    let pipe_idx = if crate::is_centralized_mode() {
        unsafe { crate::pipe::global_pipe_table().alloc(pipe) }
    } else {
        proc.alloc_pipe(pipe)
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

    let pipe_fd_flags = oflags_to_fd_flags(flags);
    if pipe_fd_flags != 0 {
        if let Ok(entry) = proc.fd_table.get_mut(read_fd) {
            entry.fd_flags = pipe_fd_flags;
        }
        if let Ok(entry) = proc.fd_table.get_mut(write_fd) {
            entry.fd_flags = pipe_fd_flags;
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

    if matches!(ofd.file_type, FileType::Pipe | FileType::Socket | FileType::EventFd | FileType::Epoll | FileType::TimerFd | FileType::SignalFd) {
        let mode = if ofd.file_type == FileType::Socket {
            wasm_posix_shared::mode::S_IFSOCK | 0o755
        } else {
            S_IFIFO | 0o600
        };
        Ok(WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: mode,
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
    } else if ofd.file_type == FileType::CharDevice {
        if let Some(dev) = VirtualDevice::from_host_handle(ofd.host_handle) {
            return Ok(virtual_device_stat(dev, proc.euid, proc.egid));
        }
        // Standard streams (0=stdin, 1=stdout, 2=stderr) — handle in-kernel
        // so browser hosts without real file descriptors still work.
        if ofd.host_handle >= 0 && ofd.host_handle <= 2 {
            return Ok(WasmStat {
                st_dev: 0,
                st_ino: 0x54545900 + ofd.host_handle as u64, // "TTY\0" + stream index
                st_mode: S_IFCHR | 0o620,
                st_nlink: 1,
                st_uid: proc.euid,
                st_gid: proc.egid,
                st_size: 0,
                st_atime_sec: 0, st_atime_nsec: 0,
                st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0,
                _pad: 0,
            });
        }
        // Other char devices — delegate to host. VFS is the source of truth
        // for ownership; host_fstat already returns the real uid/gid.
        host.host_fstat(ofd.host_handle)
    } else if matches!(ofd.file_type, FileType::PtyMaster | FileType::PtySlave) {
        let pty_idx = ofd.host_handle as usize;
        Ok(WasmStat {
            st_dev: 5, // synthetic devpts device
            st_ino: 0x50545900 + pty_idx as u64, // "PTY\0" + index
            st_mode: S_IFCHR | 0o620,
            st_nlink: 1,
            st_uid: proc.euid,
            st_gid: proc.egid,
            st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        })
    } else if ofd.file_type == FileType::MemFd {
        let memfd_idx = (-(ofd.host_handle + 1)) as usize;
        let size = proc.memfds.get(memfd_idx)
            .and_then(|s| s.as_ref())
            .map_or(0, |d| d.len() as u64);
        Ok(WasmStat {
            st_dev: 0,
            st_ino: 0x4D454D00 + memfd_idx as u64, // "MEM\0" + index
            st_mode: S_IFREG | 0o600,
            st_nlink: 1,
            st_uid: proc.euid,
            st_gid: proc.egid,
            st_size: size,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        })
    } else if ofd.host_handle == SYNTHETIC_FILE_HANDLE {
        let size = synthetic_file_content(&ofd.path).map_or(0, |c| c.len() as u64);
        Ok(WasmStat {
            st_dev: 0,
            st_ino: 0x45544300, // "ETC\0" — unique inode range for synthetic files
            st_mode: S_IFREG | 0o444,
            st_nlink: 1,
            st_uid: 0,
            st_gid: 0,
            st_size: size,
            st_atime_sec: 0, st_atime_nsec: 0,
            st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0,
            _pad: 0,
        })
    } else if crate::procfs::is_procfs_buf_handle(ofd.host_handle) {
        let buf_idx = crate::procfs::procfs_buf_idx(ofd.host_handle);
        let size = proc.procfs_bufs.get(buf_idx)
            .and_then(|s| s.as_ref())
            .map_or(0, |d| d.len() as u64);
        if let Some(entry) = crate::procfs::match_procfs(&ofd.path, proc.pid) {
            Ok(crate::procfs::procfs_stat(&entry, size, true))
        } else {
            Ok(crate::procfs::procfs_stat(&crate::procfs::ProcfsEntry::Stat(proc.pid), size, true))
        }
    } else if ofd.host_handle == crate::procfs::PROCFS_DIR_HANDLE {
        if let Some(entry) = crate::procfs::match_procfs(&ofd.path, proc.pid) {
            Ok(crate::procfs::procfs_stat(&entry, 0, true))
        } else {
            Ok(crate::procfs::procfs_stat(&crate::procfs::ProcfsEntry::Root, 0, true))
        }
    } else if ofd.host_handle == crate::devfs::DEVFS_DIR_HANDLE {
        Ok(crate::devfs::match_devfs_stat(&ofd.path, proc.euid, proc.egid)
            .unwrap_or(WasmStat {
                st_dev: 6, st_ino: 0xDE0100,
                st_mode: wasm_posix_shared::mode::S_IFDIR | 0o755, st_nlink: 2,
                st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            }))
    } else {
        // VFS is the source of truth for ownership: host_fstat already returns
        // the file's real uid/gid, so just propagate.
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
        F_DUPFD | F_DUPFD_CLOEXEC | F_DUPFD_CLOFORK => {
            let entry = proc.fd_table.get(fd)?;
            let ofd_ref = entry.ofd_ref;

            proc.ofd_table.inc_ref(ofd_ref.0);

            let new_fd_flags = if cmd == F_DUPFD_CLOEXEC {
                FD_CLOEXEC
            } else if cmd == F_DUPFD_CLOFORK {
                FD_CLOFORK
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

/// fcntl lock operations (F_GETLK, F_SETLK, F_SETLKW, F_OFD_*).
pub fn sys_fcntl_lock(
    proc: &mut Process,
    fd: i32,
    cmd: u32,
    flock: &mut WasmFlock,
    host: &mut dyn HostIO,
) -> Result<(), Errno> {
    use wasm_posix_shared::fcntl_cmd::{F_OFD_GETLK, F_OFD_SETLK, F_OFD_SETLKW};

    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    let host_handle = ofd.host_handle;

    // OFD locks use the OFD index as lock owner (not PID).
    // Map OFD and POSIX (5/6/7) commands to the internal lock constants (12/13/14).
    // On LP64 targets (wasm64posix), musl defines F_GETLK=5, F_SETLK=6, F_SETLKW=7.
    // On ILP32 targets (wasm32posix), musl defines F_GETLK=12, F_SETLK=13, F_SETLKW=14.
    let is_ofd = matches!(cmd, F_OFD_GETLK | F_OFD_SETLK | F_OFD_SETLKW);
    let base_cmd = match cmd {
        5 => F_GETLK,
        6 => F_SETLK,
        7 => F_SETLKW,
        F_OFD_GETLK => F_GETLK,
        F_OFD_SETLK => F_SETLK,
        F_OFD_SETLKW => F_SETLKW,
        other => other,
    };
    // OFD lock owners use high bit to avoid colliding with PIDs
    let lock_owner = if is_ofd { (ofd_idx as u32) | 0x80000000 } else { proc.pid };

    // Resolve start offset based on whence
    let start = match flock.l_whence {
        0 => flock.l_start,           // SEEK_SET
        1 => ofd.offset + flock.l_start, // SEEK_CUR
        2 => {
            // SEEK_END: resolve relative to file size
            if host_handle >= 0 {
                let stat = host.host_fstat(host_handle)?;
                (stat.st_size as i64) + flock.l_start
            } else {
                // Non-host files (pipes, etc.) — SEEK_END not meaningful
                return Err(Errno::EINVAL);
            }
        }
        _ => return Err(Errno::EINVAL),
    };

    // l_type as u32 for comparison with F_RDLCK/F_WRLCK/F_UNLCK constants
    let lock_type = flock.l_type as u32;

    // For host-backed files, delegate to the shared lock table via host import
    if host_handle >= 0 && !ofd.path.is_empty() {
        // Access mode check
        if base_cmd == F_SETLK || base_cmd == F_SETLKW {
            let access_mode = ofd.status_flags & O_ACCMODE;
            if lock_type == F_RDLCK && access_mode == O_WRONLY {
                return Err(Errno::EBADF);
            }
            if lock_type == F_WRLCK && access_mode == O_RDONLY {
                return Err(Errno::EBADF);
            }
        }
        let path = &ofd.path;
        let mut result_buf = [0u8; 24];
        host.host_fcntl_lock(
            path, lock_owner, base_cmd, lock_type,
            start, flock.l_len, &mut result_buf,
        )?;
        // For GETLK variants, parse result_buf back into flock
        if base_cmd == F_GETLK {
            let result_type = u32::from_le_bytes(result_buf[0..4].try_into().unwrap());
            flock.l_type = result_type as i16;
            if result_type != F_UNLCK {
                // OFD locks: POSIX says l_pid should be -1
                flock.l_pid = if is_ofd { 0xFFFFFFFF } else {
                    u32::from_le_bytes(result_buf[4..8].try_into().unwrap())
                };
                flock.l_start = i64::from_le_bytes(result_buf[8..16].try_into().unwrap());
                flock.l_len = i64::from_le_bytes(result_buf[16..24].try_into().unwrap());
                flock.l_whence = 0;
            }
        }
        return Ok(());
    }

    // Fallback: use local lock_table for non-host files (pipes, etc.)
    match base_cmd {
        F_GETLK => {
            match proc
                .lock_table
                .get_blocking_lock(host_handle, lock_type, start, flock.l_len, lock_owner)
            {
                Some(blocking) => {
                    flock.l_type = blocking.lock_type as i16;
                    flock.l_start = blocking.start;
                    flock.l_len = blocking.len;
                    // OFD locks: POSIX says l_pid should be -1
                    flock.l_pid = if is_ofd { 0xFFFFFFFF } else { blocking.pid };
                    flock.l_whence = 0;
                }
                None => {
                    flock.l_type = F_UNLCK as i16;
                }
            }
            Ok(())
        }
        F_SETLK | F_SETLKW => {
            let access_mode = ofd.status_flags & O_ACCMODE;
            if lock_type == F_RDLCK && access_mode == O_WRONLY {
                return Err(Errno::EBADF);
            }
            if lock_type == F_WRLCK && access_mode == O_RDONLY {
                return Err(Errno::EBADF);
            }

            if lock_type == F_UNLCK {
                let lock = FileLock {
                    pid: lock_owner,
                    lock_type: F_UNLCK,
                    start,
                    len: flock.l_len,
                };
                proc.lock_table.set_lock(host_handle, lock);
                return Ok(());
            }

            if proc
                .lock_table
                .get_blocking_lock(host_handle, lock_type, start, flock.l_len, lock_owner)
                .is_some()
            {
                if base_cmd == F_SETLK {
                    return Err(Errno::EAGAIN);
                }
                // F_SETLKW: in a single address space (Wasm), the caller owns
                // all local locks, so a conflict is always a self-deadlock.
                return Err(Errno::EDEADLK);
            }

            let lock = FileLock {
                pid: lock_owner,
                lock_type: lock_type,
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
        l_type: lock_type as i16,
        l_whence: 0, // SEEK_SET
        _pad1: 0,
        l_start: 0,
        l_len: 0, // 0 means entire file
        l_pid: proc.pid,
        _pad2: 0,
    };

    sys_fcntl_lock(proc, fd, cmd, &mut flock, host)
}

use wasm_posix_shared::WasmDirent;
use crate::process::{DirStream, ProcessState};
use crate::path::resolve_path;

/// Check if a resolved path is a PTY or terminal device path.
/// Returns a synthetic stat for /dev/ptmx, /dev/pts/N, /dev/tty.
fn match_pty_stat(resolved: &[u8], uid: u32, gid: u32) -> Option<WasmStat> {
    if resolved == b"/dev/ptmx" || resolved == b"/dev/tty" || resolved.starts_with(b"/dev/pts/") {
        Some(WasmStat {
            st_dev: 5, st_ino: 0x50545900,
            st_mode: S_IFCHR | 0o620, st_nlink: 1,
            st_uid: uid, st_gid: gid, st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        })
    } else {
        None
    }
}

pub fn sys_stat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    if let Some(dev) = match_virtual_device(&resolved) {
        return Ok(virtual_device_stat(dev, proc.euid, proc.egid));
    }
    if let Some(st) = match_pty_stat(&resolved, proc.euid, proc.egid) {
        return Ok(st);
    }
    if match_dev_fd(&resolved).is_some() {
        use wasm_posix_shared::mode::S_IFCHR;
        return Ok(WasmStat {
            st_dev: 5, st_ino: 0, st_mode: S_IFCHR | 0o666, st_nlink: 1,
            st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(content) = synthetic_file_content(&resolved) {
        return Ok(WasmStat {
            st_dev: 0, st_ino: 0x45544300,
            st_mode: S_IFREG | 0o444, st_nlink: 1,
            st_uid: 0, st_gid: 0, st_size: content.len() as u64,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        return Ok(crate::procfs::procfs_stat(&entry, 0, true));
    }
    if let Some(st) = crate::devfs::match_devfs_stat(&resolved, proc.euid, proc.egid) {
        return Ok(st);
    }
    // Check Unix socket registry
    {
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        if registry.contains(&resolved) {
            return Ok(WasmStat {
                st_dev: 0, st_ino: 0x554E5800, // "UNX\0"
                st_mode: wasm_posix_shared::mode::S_IFSOCK | 0o755, st_nlink: 1,
                st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            });
        }
    }
    // VFS is the source of truth for ownership: host_stat already returns the
    // file's real uid/gid, so just propagate.
    host.host_stat(&resolved)
}

pub fn sys_lstat(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    let resolved = resolve_path(path, &proc.cwd);
    if let Some(dev) = match_virtual_device(&resolved) {
        return Ok(virtual_device_stat(dev, proc.euid, proc.egid));
    }
    if let Some(st) = match_pty_stat(&resolved, proc.euid, proc.egid) {
        return Ok(st);
    }
    if match_dev_fd(&resolved).is_some() {
        use wasm_posix_shared::mode::S_IFCHR;
        return Ok(WasmStat {
            st_dev: 5, st_ino: 0, st_mode: S_IFCHR | 0o666, st_nlink: 1,
            st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(content) = synthetic_file_content(&resolved) {
        return Ok(WasmStat {
            st_dev: 0, st_ino: 0x45544300,
            st_mode: S_IFREG | 0o444, st_nlink: 1,
            st_uid: 0, st_gid: 0, st_size: content.len() as u64,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        return Ok(crate::procfs::procfs_stat(&entry, 0, false));
    }
    if let Some(st) = crate::devfs::match_devfs_stat(&resolved, proc.euid, proc.egid) {
        return Ok(st);
    }
    // Check Unix socket registry
    {
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        if registry.contains(&resolved) {
            return Ok(WasmStat {
                st_dev: 0, st_ino: 0x554E5800, // "UNX\0"
                st_mode: wasm_posix_shared::mode::S_IFSOCK | 0o755, st_nlink: 1,
                st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            });
        }
    }
    // VFS is the source of truth for ownership: host_lstat already returns the
    // link's real uid/gid, so just propagate.
    host.host_lstat(&resolved)
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
    // AF_UNIX bind() creates a real host inode, so unlink must remove both the
    // registry entry and the inode. ENOENT from host_unlink is tolerated because
    // some hosts (test mocks) don't track the inode.
    {
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        if registry.unregister(&resolved) {
            match host.host_unlink(&resolved) {
                Ok(()) | Err(Errno::ENOENT) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }
    match host.host_unlink(&resolved) {
        Err(Errno::EPERM) => {
            // Linux returns EISDIR when unlinking a directory; macOS returns EPERM.
            // musl's remove() depends on EISDIR to fall through to rmdir().
            if let Ok(st) = host.host_stat(&resolved) {
                if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
                    return Err(Errno::EISDIR);
                }
            }
            Err(Errno::EPERM)
        }
        other => other,
    }
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

    // Procfs symlinks — /proc/self, /proc/self/fd/N, /proc/self/cwd, /proc/self/exe, etc.
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        if entry.is_symlink() {
            return crate::procfs::procfs_readlink(proc, &entry, buf);
        }
        // Not a symlink — EINVAL per POSIX
        return Err(Errno::EINVAL);
    }

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
    if match_virtual_device(&resolved).is_some() || match_dev_fd(&resolved).is_some()
        || match_pty_stat(&resolved, 0, 0).is_some()
        || crate::devfs::match_devfs_dir(&resolved).is_some() {
        return Ok(());
    }
    if synthetic_file_content(&resolved).is_some() {
        // Synthetic files are read-only: allow R_OK and F_OK, deny W_OK/X_OK
        if amode & 0o2 != 0 { return Err(Errno::EACCES); } // W_OK
        return Ok(());
    }
    if crate::procfs::match_procfs(&resolved, proc.pid).is_some() {
        // Procfs entries are read-only: allow R_OK/F_OK/X_OK(dirs), deny W_OK
        if amode & 0o2 != 0 { return Err(Errno::EACCES); }
        return Ok(());
    }
    host.host_access(&resolved, amode)
}

/// Change the current working directory.
/// Validates that the path exists and is a directory via host_stat.
pub fn sys_chdir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    // Check virtual filesystems first (procfs, devfs), then fall through to host
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        let st = crate::procfs::procfs_stat(&entry, 0, true);
        if st.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFDIR {
            return Err(Errno::ENOTDIR);
        }
        proc.cwd = resolved;
        return Ok(());
    }
    if let Some(st) = crate::devfs::match_devfs_stat(&resolved, proc.euid, proc.egid) {
        if st.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFDIR {
            return Err(Errno::ENOTDIR);
        }
        proc.cwd = resolved;
        return Ok(());
    }
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
    // Linux getcwd returns the path WITH a null terminator and the length
    // includes the null byte.  musl expects this convention.
    let needed = proc.cwd.len() + 1; // +1 for NUL
    if buf.len() < needed {
        return Err(Errno::ERANGE);
    }
    buf[..proc.cwd.len()].copy_from_slice(&proc.cwd);
    buf[proc.cwd.len()] = 0;
    Ok(needed)
}

/// Open a directory for reading. Returns a directory stream handle.
pub fn sys_opendir(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<i32, Errno> {
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    let host_handle = host.host_opendir(&resolved)?;
    let stream = DirStream { host_handle, path: resolved, position: 0, synth_dot_state: 0 };

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
    let synth_state = stream.synth_dot_state;

    // Synthesize "." and ".." entries before host entries
    if synth_state < 2 {
        let (name, name_len) = if synth_state == 0 {
            (b"." as &[u8], 1usize)
        } else {
            (b".." as &[u8], 2usize)
        };
        let dirent = WasmDirent {
            d_ino: 1,
            d_type: 4, // DT_DIR
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
        if name_len <= name_buf.len() {
            name_buf[..name_len].copy_from_slice(name);
        }
        if let Some(stream) = proc.dir_streams.get_mut(idx).and_then(|s| s.as_mut()) {
            stream.synth_dot_state += 1;
            stream.position += 1;
        }
        return Ok(1);
    }

    match host.host_readdir(host_handle, name_buf)? {
        Some((d_ino, d_type, name_len)) => {
            // Skip host "." and ".." entries (we already synthesized them)
            if name_len == 1 && name_buf[0] == b'.' {
                // Recurse to get the next entry
                return sys_readdir(proc, host, dir_handle, dirent_buf, name_buf);
            }
            if name_len == 2 && name_buf[0] == b'.' && name_buf[1] == b'.' {
                return sys_readdir(proc, host, dir_handle, dirent_buf, name_buf);
            }

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
    stream.synth_dot_state = 0;
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

    // Skip entries: first 2 positions are synthetic "." and ".."
    let synth_to_skip = loc.min(2);
    let host_to_skip = loc.saturating_sub(2);

    // Advance synth state
    if let Some(stream) = proc.dir_streams.get_mut(idx).and_then(|s| s.as_mut()) {
        stream.synth_dot_state = synth_to_skip as u8;
    }

    // Skip host entries
    let mut name_buf = [0u8; 256];
    for _ in 0..host_to_skip {
        let stream = proc.dir_streams.get(idx).and_then(|s| s.as_ref()).ok_or(Errno::EBADF)?;
        let handle = stream.host_handle;
        match host.host_readdir(handle, &mut name_buf)? {
            Some(_) => {},
            None => break,
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

    // Devfs directories: generate entries in-kernel
    if dir_handle == crate::devfs::DEVFS_DIR_HANDLE || dir_handle == -2 && crate::devfs::match_devfs_dir(&path).is_some() {
        if dir_handle == -2 {
            return Ok(0); // exhausted
        }
        let entry_offset = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_entry_offset;
        let (bytes, new_offset, exhausted) =
            crate::devfs::devfs_getdents64(proc, &path, buf, entry_offset)?;
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_entry_offset = new_offset;
            if exhausted {
                ofd.dir_host_handle = -2;
            }
        }
        return Ok(bytes);
    }

    // Procfs directories: generate entries in-kernel
    if dir_handle == crate::procfs::PROCFS_DIR_HANDLE || dir_handle == -2 && crate::procfs::match_procfs(&path, proc.pid).is_some() {
        if dir_handle == -2 {
            return Ok(0); // exhausted
        }
        let entry_offset = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_entry_offset;

        // Get all PIDs for /proc root listing; includes self + other processes
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        let mut pids = crate::wasm_api::procfs_all_pids();
        #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
        let mut pids = alloc::vec::Vec::<u32>::new();
        if pids.is_empty() {
            pids.push(proc.pid); // fallback: at least self
        }

        // Check if this is a cross-process directory (e.g. /proc/<other_pid>/fd)
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        if let Some(entry) = crate::procfs::match_procfs(&path, proc.pid) {
            let target_pid = crate::procfs::entry_pid(&entry);
            if target_pid != 0 && target_pid != proc.pid {
                if let Some((bytes, new_offset, exhausted)) =
                    crate::wasm_api::procfs_getdents64_for_pid(target_pid, &path, buf, entry_offset)
                {
                    if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                        ofd.dir_entry_offset = new_offset;
                        if exhausted {
                            ofd.dir_host_handle = -2;
                        }
                    }
                    return Ok(bytes);
                }
                return Err(Errno::ENOENT);
            }
        }

        let (bytes, new_offset, exhausted) =
            crate::procfs::procfs_getdents64(proc, &path, buf, entry_offset, &pids)?;
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_entry_offset = new_offset;
            if exhausted {
                ofd.dir_host_handle = -2; // mark exhausted
            }
        }
        return Ok(bytes);
    }

    if dir_handle == -2 {
        // Already exhausted — return 0 (EOF)
        return Ok(0);
    }

    // Host entries exhausted but virtual entries still pending (root dir only)
    if dir_handle == -3 && path == b"/" {
        let mut pos = 0usize;
        let mut entry_offset = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_entry_offset;
        let virtuals: &[&[u8]] = &[b"dev", b"proc"];
        let virt_base = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_synth_state;
        let virt_start = if virt_base > 2 { (virt_base - 2) as usize } else { 0 };
        for (i, name) in virtuals.iter().enumerate() {
            if i < virt_start {
                continue;
            }
            entry_offset += 1;
            let written = write_dirent64(buf, pos, 2, entry_offset, 4 /* DT_DIR */, name);
            if written == 0 {
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.dir_entry_offset = entry_offset - 1;
                    ofd.dir_synth_state = 2 + i as u8;
                }
                if pos == 0 {
                    return Err(Errno::EINVAL);
                }
                return Ok(pos);
            }
            pos += written;
        }
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_entry_offset = entry_offset;
            ofd.dir_host_handle = -2;
        }
        return Ok(pos);
    }

    if dir_handle == -3 {
        // Non-root with -3 state — shouldn't happen, treat as exhausted
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
    // Use persistent entry offset from OFD for d_off values (seekdir cookie)
    let mut entry_offset = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_entry_offset;

    // Helper: write a single linux_dirent64 entry to buf at position pos.
    // Returns the number of bytes written, or 0 if it doesn't fit.
    fn write_dirent64(buf: &mut [u8], pos: usize, d_ino: u64, d_off: i64, d_type: u8, name: &[u8]) -> usize {
        let name_len = name.len();
        let reclen_raw = 19 + name_len + 1;
        let reclen = (reclen_raw + 7) & !7;
        if pos + reclen > buf.len() {
            return 0;
        }
        buf[pos..pos + 8].copy_from_slice(&d_ino.to_le_bytes());
        buf[pos + 8..pos + 16].copy_from_slice(&d_off.to_le_bytes());
        buf[pos + 16..pos + 18].copy_from_slice(&(reclen as u16).to_le_bytes());
        buf[pos + 18] = d_type;
        buf[pos + 19..pos + 19 + name_len].copy_from_slice(name);
        buf[pos + 19 + name_len] = 0;
        for i in pos + 19 + name_len + 1..pos + reclen {
            buf[i] = 0;
        }
        reclen
    }

    // Synthesize "." and ".." entries
    let synth_state = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_synth_state;
    if synth_state < 2 {
        let synth_entries: &[&[u8]] = if synth_state == 0 { &[b".", b".."] } else { &[b".."] };
        for name in synth_entries {
            entry_offset += 1;
            let written = write_dirent64(buf, pos, 1, entry_offset, 4 /* DT_DIR */, name);
            if written == 0 {
                if pos == 0 {
                    return Err(Errno::EINVAL);
                }
                // Save entry_offset before returning
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.dir_entry_offset = entry_offset - 1; // didn't emit this one
                }
                return Ok(pos);
            }
            pos += written;
        }
        if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
            ofd.dir_synth_state = 2;
        }
    }

    loop {
        match host.host_readdir(dir_handle, &mut name_buf)? {
            Some((d_ino, d_type, name_len)) => {
                // Skip host "." and ".." entries (we already synthesized them)
                if (name_len == 1 && name_buf[0] == b'.') ||
                   (name_len == 2 && name_buf[0] == b'.' && name_buf[1] == b'.') {
                    continue;
                }

                entry_offset += 1;
                let written = write_dirent64(buf, pos, d_ino, entry_offset, d_type as u8, &name_buf[..name_len]);
                if written == 0 {
                    if pos == 0 {
                        return Err(Errno::EINVAL);
                    }
                    break;
                }
                pos += written;
            }
            None => {
                // Close the host dir handle
                let _ = host.host_closedir(dir_handle);

                // Inject synthetic entries for virtual filesystems when listing "/"
                if path == b"/" {
                    let virtuals: &[&[u8]] = &[b"proc"];
                    // synth_state tracks how many virtual entries we've emitted (2 = done with . and ..)
                    let virt_base = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?.dir_synth_state;
                    let virt_start = if virt_base > 2 { (virt_base - 2) as usize } else { 0 };
                    for (i, name) in virtuals.iter().enumerate() {
                        if i < virt_start {
                            continue;
                        }
                        entry_offset += 1;
                        let written = write_dirent64(buf, pos, 2, entry_offset, 4 /* DT_DIR */, name);
                        if written == 0 {
                            // Save progress — we'll resume from here on next call
                            if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                                ofd.dir_entry_offset = entry_offset - 1;
                                ofd.dir_host_handle = -3; // signal: host exhausted, virtuals pending
                                ofd.dir_synth_state = 2 + i as u8;
                            }
                            if pos == 0 {
                                return Err(Errno::EINVAL);
                            }
                            return Ok(pos);
                        }
                        pos += written;
                    }
                }

                // Mark as fully exhausted
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.dir_host_handle = -2;
                }
                break;
            }
        }
    }

    // Persist the entry offset for subsequent calls
    if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
        ofd.dir_entry_offset = entry_offset;
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

/// getpgid -- get process group ID for a specific process.
/// pid=0 means current process.
pub fn sys_getpgid(proc: &Process, pid: u32) -> Result<u32, Errno> {
    if pid != 0 && pid != proc.pid {
        return Err(Errno::ESRCH);
    }
    Ok(proc.pgid)
}

/// setpgid -- set process group ID.
/// pid=0 means current process, pgid=0 means use pid as pgid.
pub fn sys_setpgid(proc: &mut Process, pid: u32, pgid: u32) -> Result<(), Errno> {
    // POSIX: negative pgid is invalid
    if (pgid as i32) < 0 {
        return Err(Errno::EINVAL);
    }
    // Only support setting own pgid (cross-process handled in wasm_api dispatch)
    if pid != 0 && pid != proc.pid {
        return Err(Errno::ESRCH);
    }
    // POSIX: a session leader cannot change its process group. Check the
    // explicit flag — `sid == pid` alone is wrong because a forked child
    // inherits the parent's sid and if that ever equals the child's pid
    // (e.g. PID reuse) we'd wrongly classify the child as a session leader.
    if proc.is_session_leader {
        return Err(Errno::EPERM);
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
    // POSIX: fail with EPERM if the calling process is already a session
    // leader. POSIX also requires EPERM if the caller is a process group
    // leader without being a session leader (reachable only via an explicit
    // `setpgid(0, 0)` with no prior `setsid` — a state we don't currently
    // distinguish from the Process::new default pgid == pid. Tightening
    // this would require changing Process::new to default pgid to 0 and
    // updating tests; worth doing but independent of the flag refactor.
    if proc.is_session_leader {
        return Err(Errno::EPERM);
    }
    proc.sid = proc.pid;
    proc.pgid = proc.pid;
    proc.is_session_leader = true;
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

/// Fork the current process. Delegates to host for worker creation.
/// Returns child PID in parent (> 0), 0 in child, or error.
pub fn sys_fork(_proc: &mut Process, host: &dyn HostIO) -> Result<u32, Errno> {
    let result = host.host_fork();
    if result < 0 {
        match Errno::from_u32((-result) as u32) {
            Some(e) => Err(e),
            None => Err(Errno::EIO),
        }
    } else {
        Ok(result as u32)
    }
}

/// Execute a new program. Delegates to host for binary loading.
/// On success, the kernel process will be replaced (POSIX: exec doesn't return on success).
/// On failure, returns the error.
pub fn sys_execve(proc: &mut Process, host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    if path.is_empty() {
        return Err(Errno::ENOENT);
    }
    // /dev/fb0 cleanup: exec wipes the binding. Tell the host before
    // its memory snapshot of the process is invalidated, then drop the
    // global ownership claim so the new image can re-acquire if it
    // needs the device.
    if proc.fb_binding.is_some() {
        host.unbind_framebuffer(proc.pid as i32);
        proc.fb_binding = None;
        maybe_release_fb0(proc.pid);
    }
    // Resolve relative paths against process CWD so the host sees absolute paths.
    // This is critical for posix_spawn with chdir file actions — the child's CWD
    // may differ from the initial data directory the host knows about.
    let resolved = crate::path::resolve_path(path, &proc.cwd);
    host.host_exec(&resolved)
}

/// Execute a new program using a file descriptor (fexecve / execveat).
/// When AT_EMPTY_PATH is set and path is empty, resolves the fd's file path.
/// Otherwise resolves path relative to the directory fd.
pub fn sys_execveat(proc: &mut Process, host: &mut dyn HostIO, dirfd: i32, path: &[u8], flags: u32) -> Result<(), Errno> {
    const AT_EMPTY_PATH: u32 = 0x1000;

    if flags & AT_EMPTY_PATH != 0 && path.is_empty() {
        // fexecve path: exec the file referenced by dirfd
        let entry = proc.fd_table.get(dirfd)?;
        let ofd_idx = entry.ofd_ref.0;
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.path.is_empty() {
            return Err(Errno::ENOENT);
        }
        let exec_path = ofd.path.clone();
        host.host_exec(&exec_path)
    } else if path.is_empty() {
        Err(Errno::ENOENT)
    } else if path[0] == b'/' {
        // Absolute path — ignore dirfd
        host.host_exec(path)
    } else {
        // Relative path — resolve against dirfd or CWD
        let base = if dirfd == -100 {
            // AT_FDCWD
            proc.cwd.clone()
        } else {
            let entry = proc.fd_table.get(dirfd)?;
            let ofd_idx = entry.ofd_ref.0;
            let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
            ofd.path.clone()
        };
        let resolved = crate::path::resolve_path(path, &base);
        host.host_exec(&resolved)
    }
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
/// Returns (signum, si_value, si_code) on success.
pub fn sys_sigtimedwait(
    proc: &mut Process,
    host: &mut dyn HostIO,
    mask: u64,
    timeout_ms: i32,
) -> Result<(u32, i32, i32), Errno> {
    use wasm_posix_shared::signal::NSIG;

    let tid = crate::process_table::current_tid();

    // Scan the calling thread's pending set (shared + directed) for a match.
    let pending_in_mask = proc.pending_for(tid) & mask;
    if pending_in_mask != 0 {
        let signum = pending_in_mask.trailing_zeros() + 1;
        if signum < NSIG {
            // Prefer directed delivery for non-main threads, same rule as
            // `kernel_dequeue_signal`.
            let bit = crate::signal::sig_bit(signum);
            if !proc.is_main_thread(tid) {
                if let Some(t) = proc.get_thread_mut(tid) {
                    if (t.signals.pending & bit) != 0 {
                        let (mut si_value, mut si_code) = (0i32, 0i32);
                        if let Some(pos) = t.signals.rt_queue.iter().position(|e| e.signum == signum) {
                            si_value = t.signals.rt_queue[pos].si_value;
                            si_code = t.signals.rt_queue[pos].si_code;
                            t.signals.rt_queue.remove(pos);
                        }
                        if signum >= crate::signal::SIGRTMIN {
                            if !t.signals.rt_queue.iter().any(|e| e.signum == signum) {
                                t.signals.pending &= !bit;
                            }
                        } else {
                            t.signals.pending &= !bit;
                        }
                        return Ok((signum, si_value, si_code));
                    }
                }
            }
            let (si_value, si_code) = proc.signals.consume_one(signum);
            return Ok((signum, si_value, si_code));
        }
    }

    if timeout_ms == 0 || crate::is_centralized_mode() {
        return Err(Errno::EAGAIN);
    }

    // Wait with 1ms sleep intervals, checking for signals
    let iterations = if timeout_ms < 0 { i32::MAX } else { timeout_ms };
    for _ in 0..iterations {
        host.host_nanosleep(0, 1_000_000)?; // 1ms

        let pending_in_mask = proc.pending_for(tid) & mask;
        if pending_in_mask != 0 {
            let signum = pending_in_mask.trailing_zeros() + 1;
            if signum < NSIG {
                let (si_value, si_code) = proc.signals.consume_one(signum);
                return Ok((signum, si_value, si_code));
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

    let tid = crate::process_table::current_tid();
    let sig_guard = crate::signal::sig_bit(SIGKILL) | crate::signal::sig_bit(SIGSTOP);
    let new_mask = mask & !sig_guard;

    // Centralized mode: keep sigsuspend mask active between EAGAIN retries.
    // On first call, save old mask. On retries, the temp mask is already set.
    if crate::is_centralized_mode() {
        if proc.sigsuspend_saved_mask_for(tid).is_none() {
            // First call: save old mask and install temporary mask
            let old = proc.blocked_for(tid);
            proc.set_sigsuspend_saved_mask_for(tid, Some(old));
            proc.set_blocked_for(tid, new_mask);
        }
        // Check if any signals are deliverable with the sigsuspend mask
        if proc.deliverable_for(tid) != 0 {
            // Signal arrived — return EINTR but keep temp mask active so that
            // dequeueSignalForDelivery picks the signal that woke sigsuspend
            // (deliverable under the temp mask). The mask will be restored in
            // kernel_dequeue_signal after the dequeue.
            return Err(Errno::EINTR);
        }
        // No signal yet — keep temp mask active, return EAGAIN for async retry
        return Err(Errno::EAGAIN);
    }

    let old_mask = proc.blocked_for(tid);
    proc.set_blocked_for(tid, new_mask);

    // Check if any signals are already deliverable with new mask
    if proc.deliverable_for(tid) != 0 {
        proc.set_blocked_for(tid, old_mask);
        return Err(Errno::EINTR);
    }

    // Block until a deliverable signal arrives
    loop {
        let sig = match host.host_sigsuspend_wait() {
            Ok(s) => s,
            Err(_) => {
                // Restore mask even on host error
                proc.set_blocked_for(tid, old_mask);
                return Err(Errno::EINTR);
            }
        };
        if sig > 0 && sig < NSIG {
            // Host reports a signal arrived — record it at the process level
            // (shared-pending). Thread-targeted signals would already be in
            // the thread's own pending queue.
            proc.signals.raise(sig);
        }
        if proc.deliverable_for(tid) != 0 {
            break;
        }
    }

    proc.set_blocked_for(tid, old_mask);
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

/// Manipulate the signal mask of the *currently-servicing* thread.
/// how: SIG_BLOCK, SIG_UNBLOCK, or SIG_SETMASK
/// set: bitmask of signals to modify
/// Returns the thread's old signal mask.
///
/// POSIX: `sigprocmask` in a multi-threaded program has the same effect as
/// `pthread_sigmask` — each thread has its own blocked mask. The current
/// thread id is read from the process table (set by the host before each
/// `kernel_handle_channel`). `tid == 0` or `tid == pid` selects the main
/// thread (process-level mask).
pub fn sys_sigprocmask(proc: &mut Process, how: u32, set: u64) -> Result<u64, Errno> {
    let tid = crate::process_table::current_tid();
    let old_mask = proc.blocked_for(tid);

    let mut new_mask = match how {
        SIG_BLOCK => old_mask | set,
        SIG_UNBLOCK => old_mask & !set,
        SIG_SETMASK => set,
        _ => return Err(Errno::EINVAL),
    };

    // SIGKILL and SIGSTOP cannot be blocked (POSIX)
    new_mask &= !(crate::signal::sig_bit(SIGKILL) | crate::signal::sig_bit(SIGSTOP));

    proc.set_blocked_for(tid, new_mask);
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
    // Centralized mode: return immediately, host handles the delay
    if crate::is_centralized_mode() {
        return Ok(());
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
        CLOCK_REALTIME | CLOCK_MONOTONIC | CLOCK_PROCESS_CPUTIME_ID | CLOCK_THREAD_CPUTIME_ID => {
            Ok(WasmTimespec { tv_sec: 0, tv_nsec: 1_000_000 }) // 1ms
        }
        id if (id & 7) == 2 => {
            // Per-process CPU clock: clock_getcpuclockid encodes as (-pid-1)*8 + 2
            Ok(WasmTimespec { tv_sec: 0, tv_nsec: 1_000_000 })
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
    req_ptr: *const u8,
) -> Result<(), Errno> {
    use wasm_posix_shared::clock::*;
    // Validate clock_id
    if clock_id != CLOCK_REALTIME && clock_id != CLOCK_MONOTONIC {
        return Err(Errno::EINVAL);
    }
    // Validate timespec
    if req.tv_sec < 0 || req.tv_nsec < 0 || req.tv_nsec >= 1_000_000_000 {
        return Err(Errno::EINVAL);
    }
    const TIMER_ABSTIME: u32 = 1;
    if flags & TIMER_ABSTIME != 0 {
        // Absolute sleep: compute relative delay from current clock
        let (now_sec, now_nsec) = host.host_clock_gettime(clock_id)?;
        let mut sec = req.tv_sec - now_sec;
        let mut nsec = req.tv_nsec - now_nsec;
        if nsec < 0 {
            sec -= 1;
            nsec += 1_000_000_000;
        }
        // Centralized mode: write relative delay to scratch and return
        // immediately — the host reads it from CH_DATA and sets up setTimeout.
        if crate::is_centralized_mode() {
            let out = unsafe { core::slice::from_raw_parts_mut(req_ptr as *mut u8, 16) };
            if sec < 0 {
                // Past deadline — zero out so host sees delayMs=0
                out[0..16].fill(0);
            } else {
                out[0..8].copy_from_slice(&sec.to_le_bytes());
                out[8..16].copy_from_slice(&nsec.to_le_bytes());
            }
            return Ok(());
        }
        // Already past the deadline — return immediately
        if sec < 0 {
            return Ok(());
        }
        host.host_nanosleep(sec, nsec)
    } else {
        // Centralized mode: return immediately, host handles the delay
        if crate::is_centralized_mode() {
            return Ok(());
        }
        host.host_nanosleep(req.tv_sec, req.tv_nsec)
    }
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
    // When path is empty (NULL from userspace), operate on dirfd directly.
    // This is how futimens(fd, times) works: utimensat(fd, NULL, times, 0).
    let resolved = if path.is_empty() && dirfd != wasm_posix_shared::flags::AT_FDCWD {
        let entry = proc.fd_table.get(dirfd)?;
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
        ofd.path.clone()
    } else {
        resolve_at_path(proc, dirfd, path)?
    };

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

/// Remap a memory mapping.
///
/// Supports in-place shrink, in-place grow (if adjacent gap exists),
/// and MREMAP_MAYMOVE (allocate new mapping, old mapping is freed).
pub fn sys_mremap(
    proc: &mut Process,
    old_addr: usize,
    old_len: usize,
    new_len: usize,
    flags: u32,
) -> Result<usize, Errno> {
    const MREMAP_MAYMOVE: u32 = 1;

    if old_len == 0 || new_len == 0 {
        return Err(Errno::EINVAL);
    }

    // Page-align both sizes
    let aligned_old = (old_len + 0xFFFF) & !0xFFFF;
    let aligned_new = (new_len + 0xFFFF) & !0xFFFF;

    // Shrink: munmap the tail portion
    if aligned_new <= aligned_old {
        if aligned_new < aligned_old {
            proc.memory.munmap(old_addr + aligned_new, aligned_old - aligned_new);
        }
        return Ok(old_addr);
    }

    // Grow: check if the mapping can expand in place
    let extra = aligned_new - aligned_old;
    let grow_start = old_addr + aligned_old;
    if proc.memory.can_grow_at(grow_start, extra) {
        proc.memory.extend_mapping(old_addr, aligned_old, aligned_new);
        return Ok(old_addr);
    }

    // MREMAP_MAYMOVE: allocate a new mapping and free the old one
    if flags & MREMAP_MAYMOVE != 0 {
        use wasm_posix_shared::mmap::{MAP_PRIVATE, MAP_ANONYMOUS};
        let new_addr = proc.memory.mmap_anonymous(0, aligned_new, 3, MAP_PRIVATE | MAP_ANONYMOUS);
        if new_addr == wasm_posix_shared::mmap::MAP_FAILED {
            return Err(Errno::ENOMEM);
        }
        // Wasm linear memory is flat — no need to copy data in kernel,
        // the host copies data between old and new addresses.
        // But since we ARE the kernel tracking mappings, we just move the tracking.
        // Actual memory content stays in Wasm linear memory — the caller (musl)
        // handles memcpy when needed.
        proc.memory.munmap(old_addr, aligned_old);
        return Ok(new_addr);
    }

    Err(Errno::ENOMEM)
}

/// Check if a file descriptor refers to a terminal.
/// Returns 1 if it's a terminal (CharDevice, PtyMaster, or PtySlave), Err(ENOTTY) otherwise.
pub fn sys_isatty(proc: &Process, fd: i32) -> Result<i32, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    if matches!(ofd.file_type, FileType::CharDevice | FileType::PtyMaster | FileType::PtySlave) {
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

/// mmap -- supports anonymous, file-backed MAP_PRIVATE and MAP_SHARED mappings.
/// File-backed mappings are allocated as anonymous regions; the host populates
/// them from the file and (for MAP_SHARED) writes back on msync/munmap.
///
/// Special case: when `fd` resolves to `/dev/fb0`, the mapping is recorded
/// as a framebuffer binding and the host is notified so it can mirror the
/// pixel range to a display surface. Linux fbdev allows only one mapping
/// per process; a second mmap on the same fd returns `EINVAL`.
pub fn sys_mmap(
    proc: &mut Process,
    host: &mut dyn HostIO,
    addr: usize,
    len: usize,
    prot: u32,
    flags: u32,
    fd: i32,
    _offset: i64,
) -> Result<usize, Errno> {
    if flags & MAP_ANONYMOUS == 0 {
        // File-backed mapping: validate the fd is open.
        if fd < 0 {
            return Err(Errno::EBADF);
        }
        // Verify the fd is a valid open file descriptor
        let _fd_entry = proc.fd_table.get(fd)?;

        // /dev/fb0: map the pixel buffer in process memory and notify the
        // host. Geometry is fixed at FB_WIDTH × FB_HEIGHT × 4; the caller
        // must request exactly that length.
        let entry = proc.fd_table.get(fd)?;
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
        if ofd.file_type == FileType::CharDevice
            && VirtualDevice::from_host_handle(ofd.host_handle) == Some(VirtualDevice::Fb0)
        {
            if proc.fb_binding.is_some() {
                return Err(Errno::EINVAL);
            }
            if len != FB_SMEM_LEN as usize {
                return Err(Errno::EINVAL);
            }
            let alloc_flags = flags | MAP_ANONYMOUS;
            let addr_out = proc.memory.mmap_anonymous(addr, len, prot, alloc_flags);
            if addr_out == MAP_FAILED {
                return Err(Errno::ENOMEM);
            }
            proc.fb_binding = Some(crate::process::FbBinding {
                addr: addr_out,
                len,
                w: FB_WIDTH,
                h: FB_HEIGHT,
                stride: FB_LINE_LENGTH,
                fmt: 0, // BGRA32
            });
            host.bind_framebuffer(
                proc.pid as i32, addr_out, len,
                FB_WIDTH, FB_HEIGHT, FB_LINE_LENGTH, 0,
            );
            return Ok(addr_out);
        }
    }

    // Allocate the region. Both anonymous and file-backed use the same
    // address space allocator. The host populates file-backed regions after
    // allocation and tracks MAP_SHARED regions for msync writeback.
    let alloc_flags = flags | MAP_ANONYMOUS;
    let result = proc.memory.mmap_anonymous(addr, len, prot, alloc_flags);
    if result == MAP_FAILED {
        return Err(Errno::ENOMEM);
    }
    Ok(result)
}

/// munmap -- unmap a previously mapped region.
pub fn sys_munmap(
    proc: &mut Process,
    host: &mut dyn HostIO,
    addr: usize,
    len: usize,
) -> Result<(), Errno> {
    if len == 0 {
        return Err(Errno::EINVAL);
    }
    // POSIX: addr must be page-aligned (Wasm page = 64KB).
    if addr & 0xFFFF != 0 {
        return Err(Errno::EINVAL);
    }
    // POSIX: addresses in [addr, addr+len) must be within the valid address space.
    // Reject if the range overflows or extends beyond Wasm linear memory limits.
    if addr.checked_add(len).is_none() {
        return Err(Errno::EINVAL);
    }

    // /dev/fb0 cleanup: if this munmap fully covers the framebuffer
    // binding, drop it and tell the host. We check before the actual
    // munmap so the host stops reading the region before its address
    // space is freed.
    let fb_release = if let Some(b) = proc.fb_binding {
        let end = addr.saturating_add(len);
        let b_end = b.addr.saturating_add(b.len);
        addr <= b.addr && end >= b_end
    } else {
        false
    };
    if fb_release {
        proc.fb_binding = None;
        host.unbind_framebuffer(proc.pid as i32);
        // Release ownership if the process also has no remaining Fb0 fds.
        if !proc_has_fb0_fd(proc) {
            maybe_release_fb0(proc.pid);
        }
    }

    // Linux munmap succeeds (returns 0) even if no mappings overlap the range,
    // as long as the address is valid and page-aligned.
    proc.memory.munmap(addr, len);
    Ok(())
}

/// brk -- set/get the program break.
/// If addr is 0, returns the current break.
/// Otherwise, sets the break to addr and returns the new break.
pub fn sys_brk(proc: &mut Process, addr: usize) -> usize {
    if addr == 0 {
        proc.memory.get_brk()
    } else {
        proc.memory.set_brk(addr)
    }
}

/// mprotect -- Wasm linear memory has no page-level protection.
/// Returns success (no-op) so callers like Zend's allocator don't fail.
pub fn sys_mprotect(_proc: &Process, _addr: usize, _len: usize, _prot: u32) -> Result<(), Errno> {
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

    // Allocate two ring buffers in the GLOBAL pipe table so they survive fork.
    // After fork, both parent and child share these buffers (like POSIX).
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let buf_ab_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));
    let buf_ba_idx = pipe_table.alloc(PipeBuffer::new(DEFAULT_PIPE_CAPACITY));

    // Socket A: sends to buf_ab, receives from buf_ba
    let mut sock_a = SocketInfo::new(SocketDomain::Unix, stype, 0);
    sock_a.state = SocketState::Connected;
    sock_a.send_buf_idx = Some(buf_ab_idx);
    sock_a.recv_buf_idx = Some(buf_ba_idx);
    sock_a.global_pipes = true;

    // Socket B: sends to buf_ba, receives from buf_ab
    let mut sock_b = SocketInfo::new(SocketDomain::Unix, stype, 0);
    sock_b.state = SocketState::Connected;
    sock_b.send_buf_idx = Some(buf_ba_idx);
    sock_b.recv_buf_idx = Some(buf_ab_idx);
    sock_b.global_pipes = true;

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
/// For AF_INET sockets, writes a full 16-byte sockaddr_in:
///   family(2 LE) + port(2 BE) + addr(4) + zero(8)
/// For AF_UNIX sockets, writes AF_UNIX (family=1) with empty path.
/// Returns the number of bytes written.
pub fn sys_getsockname(proc: &Process, fd: i32, buf: &mut [u8]) -> Result<usize, Errno> {
    use crate::socket::SocketDomain;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    match sock.domain {
        SocketDomain::Inet => {
            // sockaddr_in is 16 bytes: family(2) + port(2) + addr(4) + zero(8)
            let mut sa = [0u8; 16];
            sa[0] = 2; // AF_INET low byte
            sa[1] = 0; // AF_INET high byte
            let port_be = sock.bind_port.to_be_bytes();
            sa[2] = port_be[0];
            sa[3] = port_be[1];
            sa[4] = sock.bind_addr[0];
            sa[5] = sock.bind_addr[1];
            sa[6] = sock.bind_addr[2];
            sa[7] = sock.bind_addr[3];
            let n = buf.len().min(16);
            buf[..n].copy_from_slice(&sa[..n]);
            Ok(16)
        }
        SocketDomain::Inet6 => {
            if buf.len() >= 2 {
                buf[0] = 10; // AF_INET6
                buf[1] = 0;
            }
            Ok(2)
        }
        SocketDomain::Unix => {
            if let Some(ref path) = sock.bind_path {
                // sockaddr_un: family(2) + path (null-terminated)
                let total_len = 2 + path.len() + 1; // +1 for null terminator
                let n = buf.len().min(total_len);
                if n >= 1 { buf[0] = 1; } // AF_UNIX low byte
                if n >= 2 { buf[1] = 0; } // AF_UNIX high byte
                let path_copy = n.saturating_sub(2).min(path.len());
                if path_copy > 0 {
                    buf[2..2 + path_copy].copy_from_slice(&path[..path_copy]);
                }
                // Null terminate if room
                if n > 2 + path_copy {
                    buf[2 + path_copy] = 0;
                }
                Ok(total_len)
            } else {
                // Unbound AF_UNIX socket — return just the family
                if buf.len() >= 2 {
                    buf[0] = 1; // AF_UNIX
                    buf[1] = 0;
                }
                Ok(2)
            }
        }
    }
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
    match sock.domain {
        SocketDomain::Inet => {
            let mut sa = [0u8; 16];
            sa[0] = 2; // AF_INET low byte
            sa[1] = 0;
            let port_be = sock.peer_port.to_be_bytes();
            sa[2] = port_be[0];
            sa[3] = port_be[1];
            sa[4] = sock.peer_addr[0];
            sa[5] = sock.peer_addr[1];
            sa[6] = sock.peer_addr[2];
            sa[7] = sock.peer_addr[3];
            let n = buf.len().min(16);
            buf[..n].copy_from_slice(&sa[..n]);
            Ok(16)
        }
        SocketDomain::Inet6 => {
            if buf.len() >= 2 {
                buf[0] = 10; // AF_INET6
                buf[1] = 0;
            }
            Ok(2)
        }
        SocketDomain::Unix => {
            if buf.len() >= 2 {
                buf[0] = 1; // AF_UNIX
                buf[1] = 0;
            }
            Ok(2)
        }
    }
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
    let use_global = sock.global_pipes;

    match how {
        SHUT_RD => {
            sock.shut_rd = true;
        }
        SHUT_WR => {
            sock.shut_wr = true;
            if let Some(send_idx) = sock.send_buf_idx {
                let pipe = if use_global {
                    unsafe { crate::pipe::global_pipe_table().get_mut(send_idx) }
                } else {
                    proc.pipes.get_mut(send_idx).and_then(|p| p.as_mut())
                };
                if let Some(pipe) = pipe { pipe.close_write_end(); }
            }
        }
        SHUT_RDWR => {
            sock.shut_rd = true;
            sock.shut_wr = true;
            if let Some(net_handle) = sock.host_net_handle {
                let _ = host.host_net_close(net_handle);
            }
            if let Some(send_idx) = sock.send_buf_idx {
                let pipe = if use_global {
                    unsafe { crate::pipe::global_pipe_table().get_mut(send_idx) }
                } else {
                    proc.pipes.get_mut(send_idx).and_then(|p| p.as_mut())
                };
                if let Some(pipe) = pipe { pipe.close_write_end(); }
            }
            if let Some(recv_idx) = sock.recv_buf_idx {
                let pipe = if use_global {
                    unsafe { crate::pipe::global_pipe_table().get_mut(recv_idx) }
                } else {
                    proc.pipes.get_mut(recv_idx).and_then(|p| p.as_mut())
                };
                if let Some(pipe) = pipe { pipe.close_read_end(); }
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
    use wasm_posix_shared::socket::{MSG_NOSIGNAL, MSG_OOB};

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

    // MSG_OOB: store the last byte as out-of-band data on the peer socket.
    if flags & MSG_OOB != 0 {
        if buf.is_empty() {
            return Err(Errno::EINVAL);
        }
        let oob_byte = buf[buf.len() - 1];
        // Find peer socket and set OOB byte.
        // For loopback: peer_idx points to socket in same process.
        // For cross-process: peer is in another process (handled by global pipe path).
        if let Some(peer_idx) = sock.peer_idx {
            if let Some(peer_sock) = proc.sockets.get_mut(peer_idx) {
                peer_sock.oob_byte = Some(oob_byte);
            }
        }
        return Ok(buf.len());
    }

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            // Loopback path: use pipe buffers if available
            if sock.send_buf_idx.is_some() {
                return sys_write(proc, host, fd, buf);
            }
            let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
            host.host_net_send(net_handle, buf, flags)
        }
        SocketDomain::Unix => {
            // DGRAM bit-bucket (syslog pattern): data is discarded
            if sock.sock_type == crate::socket::SocketType::Dgram {
                return Ok(buf.len());
            }
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
    use wasm_posix_shared::socket::{MSG_DONTWAIT, MSG_OOB, MSG_PEEK};
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

    // MSG_OOB: read out-of-band byte stored on this socket.
    if flags & MSG_OOB != 0 {
        let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
        if let Some(byte) = sock.oob_byte.take() {
            if !buf.is_empty() {
                buf[0] = byte;
            }
            return Ok(1);
        }
        return Err(Errno::EINVAL); // no OOB data available
    }

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 if sock.recv_buf_idx.is_none() => {
            // Host-delegated network path (external connections)
            let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
            host.host_net_recv(net_handle, buf.len() as u32, flags, buf)
        }
        _ => {
            // Pipe-backed recv path (AF_UNIX and loopback INET)
            let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
            let use_global = sock.global_pipes;
            let peek = flags & MSG_PEEK != 0;
            let nonblock = (status_flags & O_NONBLOCK != 0) || (flags & MSG_DONTWAIT != 0) || crate::is_centralized_mode();
            let waitall = flags & MSG_WAITALL != 0 && !peek;
            let mut total = 0usize;

            loop {
                let pipe = if use_global {
                    unsafe { crate::pipe::global_pipe_table().get_mut(recv_buf_idx) }
                } else {
                    proc.pipes.get_mut(recv_buf_idx).and_then(|p| p.as_mut())
                }.ok_or(Errno::EBADF)?;
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
            SO_REUSEADDR | SO_KEEPALIVE |
            SO_LINGER | SO_BROADCAST => {
                Ok(sock.get_option(level, optname).unwrap_or(0))
            }
            // SO_RCVTIMEO/SO_SNDTIMEO handled by sys_getsockopt_timeout
            _ => Err(Errno::ENOPROTOOPT),
        },
        IPPROTO_TCP => match optname {
            TCP_NODELAY | TCP_CORK | TCP_KEEPIDLE | TCP_KEEPINTVL |
            TCP_KEEPCNT | TCP_DEFER_ACCEPT | TCP_QUICKACK | TCP_USER_TIMEOUT => {
                Ok(sock.get_option(level, optname).unwrap_or(0))
            }
            // TCP_INFO handled separately by sys_getsockopt_tcp_info
            _ => Err(Errno::ENOPROTOOPT),
        },
        _ => Err(Errno::ENOPROTOOPT),
    }
}

/// Size of `struct tcp_info` (musl/linux, wasm32).
pub const TCP_INFO_SIZE: usize = 232;

/// Build a virtual `struct tcp_info` for a socket.
/// Returns a byte buffer matching the musl `struct tcp_info` layout with
/// plausible values for a healthy virtual TCP connection.
pub fn sys_getsockopt_tcp_info(
    proc: &Process,
    fd: i32,
) -> Result<[u8; TCP_INFO_SIZE], Errno> {
    use crate::socket::SocketState;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    let mut buf = [0u8; TCP_INFO_SIZE];

    // tcpi_state (offset 0, u8)
    buf[0] = match sock.state {
        SocketState::Listening => 10, // TCP_LISTEN
        SocketState::Connected => 1,  // TCP_ESTABLISHED
        _ => 7,                       // TCP_CLOSE
    };
    // tcpi_options (offset 5, u8): TIMESTAMPS | SACK | WSCALE
    buf[5] = 7;
    // tcpi_snd_wscale:4 | tcpi_rcv_wscale:4 (offset 6, u8)
    buf[6] = (7 << 4) | 7;
    // tcpi_rto (offset 8, u32) — 200ms retransmit timeout
    buf[8..12].copy_from_slice(&200_000u32.to_le_bytes());
    // tcpi_ato (offset 12, u32) — 40ms delayed ack timeout
    buf[12..16].copy_from_slice(&40_000u32.to_le_bytes());
    // tcpi_snd_mss (offset 16, u32)
    buf[16..20].copy_from_slice(&1460u32.to_le_bytes());
    // tcpi_rcv_mss (offset 20, u32)
    buf[20..24].copy_from_slice(&1460u32.to_le_bytes());
    // tcpi_pmtu (offset 60, u32)
    buf[60..64].copy_from_slice(&1500u32.to_le_bytes());
    // tcpi_rcv_ssthresh (offset 64, u32)
    buf[64..68].copy_from_slice(&65535u32.to_le_bytes());
    // tcpi_rtt (offset 68, u32) — 1ms in microseconds
    buf[68..72].copy_from_slice(&1000u32.to_le_bytes());
    // tcpi_rttvar (offset 72, u32) — 0.5ms variance
    buf[72..76].copy_from_slice(&500u32.to_le_bytes());
    // tcpi_snd_ssthresh (offset 76, u32)
    buf[76..80].copy_from_slice(&0xFFFFu32.to_le_bytes());
    // tcpi_snd_cwnd (offset 80, u32) — 10 segments
    buf[80..84].copy_from_slice(&10u32.to_le_bytes());
    // tcpi_advmss (offset 84, u32)
    buf[84..88].copy_from_slice(&1460u32.to_le_bytes());
    // tcpi_reordering (offset 88, u32)
    buf[88..92].copy_from_slice(&3u32.to_le_bytes());
    // tcpi_rcv_space (offset 96, u32)
    buf[96..100].copy_from_slice(&65535u32.to_le_bytes());
    // tcpi_snd_wnd (offset 228, u32)
    buf[228..232].copy_from_slice(&65535u32.to_le_bytes());

    Ok(buf)
}

/// Get socket timeout value in microseconds (SO_RCVTIMEO / SO_SNDTIMEO).
pub fn sys_getsockopt_timeout(
    proc: &Process,
    fd: i32,
    optname: u32,
) -> Result<u64, Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    Ok(if optname == SO_RCVTIMEO { sock.recv_timeout_us } else { sock.send_timeout_us })
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
            SO_LINGER | SO_BROADCAST => {
                sock.set_option(level, optname, value);
                Ok(())
            }
            // SO_RCVTIMEO/SO_SNDTIMEO handled by sys_setsockopt_timeout
            _ => Err(Errno::ENOPROTOOPT),
        },
        IPPROTO_TCP => match optname {
            TCP_NODELAY | TCP_CORK | TCP_KEEPIDLE | TCP_KEEPINTVL |
            TCP_KEEPCNT | TCP_DEFER_ACCEPT | TCP_QUICKACK | TCP_USER_TIMEOUT => {
                sock.set_option(level, optname, value);
                Ok(())
            }
            _ => Err(Errno::ENOPROTOOPT),
        },
        _ => Err(Errno::ENOPROTOOPT),
    }
}

/// Set socket timeout (SO_RCVTIMEO / SO_SNDTIMEO) in microseconds.
pub fn sys_setsockopt_timeout(
    proc: &mut Process,
    fd: i32,
    optname: u32,
    timeout_us: u64,
) -> Result<(), Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    if optname == SO_RCVTIMEO {
        sock.recv_timeout_us = timeout_us;
    } else {
        sock.send_timeout_us = timeout_us;
    }
    Ok(())
}

/// Bind a socket to an address.
///
/// For AF_INET sockets, parses sockaddr_in and stores the IP + port.
/// If port == 0, assigns an ephemeral port.
pub fn sys_bind(proc: &mut Process, host: &mut dyn HostIO, fd: i32, addr: &[u8]) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketState};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    if sock.state != SocketState::Unbound {
        return Err(Errno::EINVAL);
    }

    match sock.domain {
        SocketDomain::Inet => {
            // sockaddr_in: family(2) + port(2 BE) + addr(4) = 8 bytes min
            if addr.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let port = u16::from_be_bytes([addr[2], addr[3]]);
            let ip = [addr[4], addr[5], addr[6], addr[7]];

            let assigned_port = if port == 0 {
                let p = proc.next_ephemeral_port;
                proc.next_ephemeral_port = proc.next_ephemeral_port.wrapping_add(1);
                if proc.next_ephemeral_port == 0 {
                    proc.next_ephemeral_port = 49152;
                }
                p
            } else {
                port
            };

            let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            sock.bind_addr = ip;
            sock.bind_port = assigned_port;
            sock.state = SocketState::Bound;
            Ok(())
        }
        SocketDomain::Unix => {
            // sockaddr_un: family(2) + sun_path (null-terminated, up to 108 bytes)
            if addr.len() < 3 {
                return Err(Errno::EINVAL);
            }
            // Extract path: starts at offset 2, null-terminated
            let path_bytes = &addr[2..];
            let path_end = path_bytes.iter().position(|&b| b == 0).unwrap_or(path_bytes.len());
            if path_end == 0 {
                return Err(Errno::EINVAL);
            }
            let sun_path = &path_bytes[..path_end];
            let resolved = crate::path::resolve_path(sun_path, &proc.cwd);

            // POSIX: bind() must create a filesystem inode at sun_path so
            // chmod/stat/ls find a node there. Do that first via host O_CREAT|
            // O_EXCL so a pre-existing path turns into EADDRINUSE, matching the
            // registry contract below. Other host_open errors (e.g. ENOENT for
            // missing parent dir) propagate unchanged. (PR #356 — restored
            // here after the package-management rebase dropped it; the same
            // code lives at the merge base but didn't survive into the
            // rebased branch.)
            use wasm_posix_shared::flags::{O_CREAT, O_EXCL, O_WRONLY};
            let h = match host.host_open(&resolved, O_CREAT | O_EXCL | O_WRONLY, 0o600) {
                Ok(h) => h,
                Err(Errno::EEXIST) => return Err(Errno::EADDRINUSE),
                Err(e) => return Err(e),
            };
            let _ = host.host_close(h);

            // Register in global Unix socket registry. If a stale entry exists
            // (host had no inode but registry did — shouldn't happen normally)
            // unwind the host inode so we don't leak.
            let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
            if !registry.register(resolved.clone(), proc.pid, sock_idx) {
                let _ = host.host_unlink(&resolved);
                return Err(Errno::EADDRINUSE);
            }

            let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            sock.bind_path = Some(resolved);
            sock.state = SocketState::Bound;
            Ok(())
        }
        SocketDomain::Inet6 => Err(Errno::EADDRNOTAVAIL),
    }
}

/// Listen for connections on a socket.
///
/// Sets the socket state to Listening so that connect() can find it.
pub fn sys_listen(proc: &mut Process, host: &mut dyn HostIO, fd: i32, _backlog: u32) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketState, SocketType};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    if sock.sock_type != SocketType::Stream {
        return Err(Errno::EOPNOTSUPP);
    }
    if sock.state != SocketState::Bound && sock.state != SocketState::Listening {
        return Err(Errno::EINVAL);
    }
    sock.state = SocketState::Listening;

    // For AF_INET listeners, allocate a shared accept queue that fork
    // children will inherit. This way every process sharing this listener
    // pulls from the same queue (POSIX semantics) — see socket.rs.
    let domain = sock.domain;
    if domain == SocketDomain::Inet && sock.shared_backlog_idx.is_none() {
        let backlog_idx = unsafe { crate::socket::shared_listener_backlog_table().alloc() };
        sock.shared_backlog_idx = Some(backlog_idx);
    }

    // Notify the host for AF_INET sockets so it can open a real TCP server
    let port = sock.bind_port;
    let addr = sock.bind_addr;
    if domain == SocketDomain::Inet {
        let _ = host.host_net_listen(fd, port, &addr);
    }
    Ok(())
}

/// Accept a connection on a listening socket.
///
/// Pops a pending connection from the listener's backlog, creates an OFD + FD
/// for the accepted socket, and returns the new fd.
pub fn sys_accept(proc: &mut Process, _host: &mut dyn HostIO, fd: i32) -> Result<i32, Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;

    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Listening {
        return Err(Errno::EINVAL);
    }

    // AF_INET listeners use a shared cross-process accept queue. Try
    // popping from there first; the accepted SocketInfo is created
    // lazily here in the accepting process. See socket.rs.
    if let Some(shared_idx) = sock.shared_backlog_idx {
        let bind_addr = sock.bind_addr;
        let bind_port = sock.bind_port;
        let pending = unsafe { crate::socket::shared_listener_backlog_table().pop(shared_idx) };
        if let Some(pc) = pending {
            let mut accepted = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
            accepted.state = SocketState::Connected;
            accepted.recv_buf_idx = Some(pc.recv_pipe_idx);
            accepted.send_buf_idx = Some(pc.send_pipe_idx);
            accepted.bind_addr = bind_addr;
            accepted.bind_port = bind_port;
            accepted.peer_addr = pc.peer_addr;
            accepted.peer_port = pc.peer_port;
            accepted.global_pipes = true;
            let accepted_sock_idx = proc.sockets.alloc(accepted);
            let host_handle = -((accepted_sock_idx as i64) + 1);
            let ofd_idx = proc.ofd_table.create(
                FileType::Socket,
                O_RDWR,
                host_handle,
                b"/dev/socket".to_vec(),
            );
            let new_fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), 0)?;
            return Ok(new_fd);
        }
        // Shared queue empty — fall through to per-process backlog
        // for AF_UNIX-style entries (none for INET listeners). We return
        // EAGAIN below if both queues are empty.
        let _ = SocketType::Stream; // silence unused-import warning if path unused
        let _ = SocketDomain::Inet;
    }

    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    if sock.listen_backlog.is_empty() {
        return Err(Errno::EAGAIN);
    }
    let accepted_sock_idx = sock.listen_backlog.remove(0);

    // Create OFD for the accepted socket
    let host_handle = -((accepted_sock_idx as i64) + 1);
    let ofd_idx = proc.ofd_table.create(
        FileType::Socket,
        O_RDWR,
        host_handle,
        b"/dev/socket".to_vec(),
    );

    // Allocate fd
    let new_fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), 0)?;
    Ok(new_fd)
}

/// Connect a socket to an address.
///
/// For AF_INET sockets connecting to 127.0.0.1, performs loopback connect:
/// finds the listening socket on the target port, creates pipe pairs, and
/// pushes a pending connection to the listener's backlog.
/// For non-loopback AF_INET/AF_INET6, delegates to the host via `host_net_connect`.
/// For AF_UNIX SOCK_STREAM, performs same-process connect via the global
/// UnixSocketRegistry (cross-process connect is handled in wasm_api.rs).
/// For AF_UNIX SOCK_DGRAM, connect succeeds as a bit-bucket.
pub fn sys_connect(proc: &mut Process, host: &mut dyn HostIO, fd: i32, addr: &[u8]) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
    use crate::pipe::PipeBuffer;

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
            let ip = [addr[4], addr[5], addr[6], addr[7]];

            // Check for loopback address (127.0.0.1)
            let is_loopback = ip == [127, 0, 0, 1];

            if is_loopback && sock.domain == SocketDomain::Inet {
                // UDP DGRAM connect: just record peer address (no listener needed)
                if sock.sock_type == SocketType::Dgram {
                    let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
                    let mut client_port = client_sock.bind_port;
                    if client_port == 0 {
                        client_port = proc.next_ephemeral_port;
                        proc.next_ephemeral_port = proc.next_ephemeral_port.wrapping_add(1);
                        if proc.next_ephemeral_port == 0 {
                            proc.next_ephemeral_port = 49152;
                        }
                    }
                    let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
                    client.state = SocketState::Connected;
                    client.peer_addr = ip;
                    client.peer_port = port;
                    if client.bind_port == 0 {
                        client.bind_port = client_port;
                        client.bind_addr = [127, 0, 0, 1];
                    }
                    return Ok(());
                }

                // TCP STREAM connect: find listening socket on target port
                let mut listener_idx = None;
                let sock_count = proc.sockets.len();
                for i in 0..sock_count {
                    if let Some(s) = proc.sockets.get(i) {
                        if s.state == SocketState::Listening
                            && s.bind_port == port
                            && s.sock_type == SocketType::Stream
                        {
                            listener_idx = Some(i);
                            break;
                        }
                    }
                }
                let listener_idx = listener_idx.ok_or(Errno::ECONNREFUSED)?;

                // Allocate two pipe buffers for bidirectional data:
                //   pipe_a: client writes → server reads
                //   pipe_b: server writes → client reads
                let (pipe_a_idx, pipe_b_idx) = proc.alloc_pipe_pair(
                    PipeBuffer::new(65536),
                    PipeBuffer::new(65536),
                );

                // Assign ephemeral port/addr to client if unbound
                let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
                let client_addr = if client_sock.bind_addr == [0; 4] { [127, 0, 0, 1] } else { client_sock.bind_addr };
                let mut client_port = client_sock.bind_port;
                if client_port == 0 {
                    client_port = proc.next_ephemeral_port;
                    proc.next_ephemeral_port = proc.next_ephemeral_port.wrapping_add(1);
                    if proc.next_ephemeral_port == 0 {
                        proc.next_ephemeral_port = 49152;
                    }
                }

                // Create accepted socket (server side) with cross-connected pipes
                let mut accepted_sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
                accepted_sock.state = SocketState::Connected;
                accepted_sock.recv_buf_idx = Some(pipe_a_idx); // reads from pipe_a (client's writes)
                accepted_sock.send_buf_idx = Some(pipe_b_idx); // writes to pipe_b (client's reads)
                accepted_sock.bind_addr = proc.sockets.get(listener_idx).map(|s| s.bind_addr).unwrap_or([0; 4]);
                accepted_sock.bind_port = proc.sockets.get(listener_idx).map(|s| s.bind_port).unwrap_or(0);
                accepted_sock.peer_addr = client_addr;
                accepted_sock.peer_port = client_port;
                let accepted_idx = proc.sockets.alloc(accepted_sock);

                // Push to listener's backlog
                let listener = proc.sockets.get_mut(listener_idx).ok_or(Errno::EBADF)?;
                listener.listen_backlog.push(accepted_idx);

                // Connect client socket with cross-connected pipes
                let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
                client.send_buf_idx = Some(pipe_a_idx); // writes to pipe_a (server's reads)
                client.recv_buf_idx = Some(pipe_b_idx); // reads from pipe_b (server's writes)
                client.state = SocketState::Connected;
                client.peer_addr = ip;
                client.peer_port = port;
                client.peer_idx = Some(accepted_idx);
                if client.bind_port == 0 {
                    client.bind_port = client_port;
                    client.bind_addr = [127, 0, 0, 1];
                }

                // Set peer_idx on accepted socket for OOB data exchange
                let accepted = proc.sockets.get_mut(accepted_idx).ok_or(Errno::EBADF)?;
                accepted.peer_idx = Some(sock_idx);

                Ok(())
            } else {
                // External connection: delegate to host
                let net_handle = sock_idx as i32;
                host.host_net_connect(net_handle, &ip, port)?;
                let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
                sock.state = SocketState::Connected;
                sock.host_net_handle = Some(net_handle);
                Ok(())
            }
        }
        SocketDomain::Unix => {
            let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
            if sock.sock_type == SocketType::Dgram {
                // SOCK_DGRAM connect on AF_UNIX succeeds as a bit-bucket (syslog pattern)
                let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
                sock.state = SocketState::Connected;
                return Ok(());
            }
            if sock.state == SocketState::Connected {
                return Err(Errno::EISCONN);
            }

            // Parse sockaddr_un to get the path
            if addr.len() < 3 {
                return Err(Errno::EINVAL);
            }
            let path_bytes = &addr[2..];
            let path_end = path_bytes.iter().position(|&b| b == 0).unwrap_or(path_bytes.len());
            if path_end == 0 {
                return Err(Errno::EINVAL);
            }
            let resolved = crate::path::resolve_path(&path_bytes[..path_end], &proc.cwd);

            // Look up the path in the global Unix socket registry
            let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
            let entry = registry.lookup(&resolved).ok_or(Errno::ECONNREFUSED)?;

            // Only same-process connect is handled here; cross-process is in wasm_api.rs
            if entry.pid != proc.pid {
                return Err(Errno::ECONNREFUSED);
            }
            let listener_sock_idx = entry.sock_idx;

            // Verify listener is actually listening
            let listener = proc.sockets.get(listener_sock_idx).ok_or(Errno::ECONNREFUSED)?;
            if listener.state != SocketState::Listening {
                return Err(Errno::ECONNREFUSED);
            }

            // Create pipe pair for bidirectional communication (in global table for fork safety)
            let pipe_table = unsafe { crate::pipe::global_pipe_table() };
            let pipe_a_idx = pipe_table.alloc(PipeBuffer::new(65536));
            let pipe_b_idx = pipe_table.alloc(PipeBuffer::new(65536));

            // Create accepted socket (server side)
            let mut accepted_sock = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
            accepted_sock.state = SocketState::Connected;
            accepted_sock.recv_buf_idx = Some(pipe_a_idx); // reads client's writes
            accepted_sock.send_buf_idx = Some(pipe_b_idx); // writes to client's reads
            accepted_sock.global_pipes = true;
            let accepted_idx = proc.sockets.alloc(accepted_sock);

            // Push to listener's backlog
            let listener = proc.sockets.get_mut(listener_sock_idx).ok_or(Errno::EBADF)?;
            listener.listen_backlog.push(accepted_idx);

            // Set up client socket
            let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            client.send_buf_idx = Some(pipe_a_idx); // writes to pipe_a (server's reads)
            client.recv_buf_idx = Some(pipe_b_idx); // reads from pipe_b (server's writes)
            client.state = SocketState::Connected;
            client.peer_idx = Some(accepted_idx);
            client.global_pipes = true;

            // Set peer_idx on accepted socket
            let accepted = proc.sockets.get_mut(accepted_idx).ok_or(Errno::EBADF)?;
            accepted.peer_idx = Some(sock_idx);

            Ok(())
        }
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

/// Send a message on a socket to a specific address.
///
/// For AF_INET DGRAM sockets with a loopback destination, finds the target
/// bound DGRAM socket and pushes the datagram to its queue.
pub fn sys_sendto(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    _flags: u32,
    addr: &[u8],
) -> Result<usize, Errno> {
    use crate::socket::{Datagram, SocketDomain, SocketState, SocketType};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    // AF_UNIX DGRAM connected sockets: bit-bucket (syslog pattern via send→sendto)
    if sock.domain == SocketDomain::Unix && sock.sock_type == SocketType::Dgram
        && sock.state == SocketState::Connected
    {
        return Ok(buf.len());
    }

    // sendto with null/empty addr on a connected socket → delegate to send (POSIX)
    if addr.is_empty() && sock.state == SocketState::Connected {
        return sys_send(proc, _host, fd, buf, _flags);
    }

    if sock.domain != SocketDomain::Inet || sock.sock_type != SocketType::Dgram {
        return Err(Errno::EOPNOTSUPP);
    }

    // Parse destination sockaddr_in
    if addr.len() < 8 {
        return Err(Errno::EINVAL);
    }
    let dst_port = u16::from_be_bytes([addr[2], addr[3]]);
    let dst_ip = [addr[4], addr[5], addr[6], addr[7]];

    // Only support loopback
    if dst_ip != [127, 0, 0, 1] {
        return Err(Errno::ENETUNREACH);
    }

    // Get sender info
    let src_addr = sock.bind_addr;
    let src_port = sock.bind_port;

    // Find target DGRAM socket bound to dst_port
    let mut target_idx = None;
    let sock_count = proc.sockets.len();
    for i in 0..sock_count {
        if let Some(s) = proc.sockets.get(i) {
            if s.sock_type == SocketType::Dgram
                && (s.state == SocketState::Bound || s.state == SocketState::Connected)
                && s.bind_port == dst_port
            {
                target_idx = Some(i);
                break;
            }
        }
    }
    let target_idx = target_idx.ok_or(Errno::ECONNREFUSED)?;

    let datagram = Datagram {
        data: buf.to_vec(),
        src_addr,
        src_port,
    };

    let target = proc.sockets.get_mut(target_idx).ok_or(Errno::EBADF)?;
    target.dgram_queue.push(datagram);

    Ok(buf.len())
}

/// Receive a message from a socket with sender address.
///
/// For AF_INET DGRAM sockets, dequeues a datagram and writes the sender address.
pub fn sys_recvfrom(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    _flags: u32,
    addr_buf: &mut [u8],
) -> Result<(usize, usize), Errno> {
    use crate::socket::{SocketDomain, SocketType};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    // For STREAM sockets, delegate to sys_recv (musl routes recv→recvfrom)
    if sock.sock_type == SocketType::Stream {
        let n = sys_recv(proc, _host, fd, buf, _flags)?;
        return Ok((n, 0));
    }
    if sock.domain != SocketDomain::Inet {
        return Err(Errno::EOPNOTSUPP);
    }

    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    if sock.dgram_queue.is_empty() {
        return Err(Errno::EAGAIN);
    }
    let datagram = sock.dgram_queue.remove(0);

    // Copy data to buffer
    let copy_len = buf.len().min(datagram.data.len());
    buf[..copy_len].copy_from_slice(&datagram.data[..copy_len]);

    // Write sender sockaddr_in to addr_buf
    let mut addr_written = 0;
    if !addr_buf.is_empty() {
        let mut sa = [0u8; 16];
        sa[0] = 2; // AF_INET
        sa[1] = 0;
        let port_be = datagram.src_port.to_be_bytes();
        sa[2] = port_be[0];
        sa[3] = port_be[1];
        sa[4] = datagram.src_addr[0];
        sa[5] = datagram.src_addr[1];
        sa[6] = datagram.src_addr[2];
        sa[7] = datagram.src_addr[3];
        let n = addr_buf.len().min(16);
        addr_buf[..n].copy_from_slice(&sa[..n]);
        addr_written = 16;
    }

    Ok((copy_len, addr_written))
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

    // Centralized mode: return EAGAIN so the host JS can retry asynchronously
    if crate::is_centralized_mode() {
        return Err(Errno::EAGAIN);
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

        // POSIX: negative fd → ignore this entry, revents stays 0
        if pollfd.fd < 0 {
            continue;
        }

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
            FileType::EventFd => {
                let efd_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(Some(efd)) = proc.eventfds.get(efd_idx) {
                    if pollfd.events & POLLIN != 0 && efd.counter > 0 {
                        revents |= POLLIN;
                    }
                    if pollfd.events & POLLOUT != 0 && efd.counter < u64::MAX - 1 {
                        revents |= POLLOUT;
                    }
                }
            }
            FileType::Epoll => {
                // Epoll fds are not typically polled; report not ready
            }
            FileType::TimerFd => {
                let tfd_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(Some(tfd)) = proc.timerfds.get(tfd_idx) {
                    // Check if timer has expired (lazy: just check expirations counter)
                    if pollfd.events & POLLIN != 0 && tfd.expirations > 0 {
                        revents |= POLLIN;
                    }
                }
            }
            FileType::SignalFd => {
                let sfd_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(Some(sfd)) = proc.signalfds.get(sfd_idx) {
                    let matching = proc.signals.pending_mask() & sfd.mask;
                    if pollfd.events & POLLIN != 0 && matching != 0 {
                        revents |= POLLIN;
                    }
                }
            }
            FileType::Regular | FileType::CharDevice | FileType::Directory | FileType::MemFd => {
                // Regular files and char devices are always ready
                if pollfd.events & POLLIN != 0 {
                    revents |= POLLIN;
                }
                if pollfd.events & POLLOUT != 0 {
                    revents |= POLLOUT;
                }
            }
            FileType::PtyMaster => {
                let pty_idx = ofd.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if pollfd.events & POLLIN != 0 && pty.master_has_data() {
                        revents |= POLLIN;
                    }
                    if pollfd.events & POLLOUT != 0 {
                        revents |= POLLOUT; // master write always ready
                    }
                    if pty.slave_refs == 0 {
                        revents |= POLLHUP;
                    }
                }
            }
            FileType::PtySlave => {
                let pty_idx = ofd.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if pollfd.events & POLLIN != 0 && pty.slave_has_data() {
                        revents |= POLLIN;
                    }
                    if pollfd.events & POLLOUT != 0 {
                        revents |= POLLOUT; // slave write always ready
                    }
                    if pty.master_refs == 0 {
                        revents |= POLLHUP;
                    }
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
                    let pipe = if crate::is_centralized_mode() {
                        unsafe { crate::pipe::global_pipe_table().get(pipe_idx) }
                    } else {
                        proc.pipes.get(pipe_idx).and_then(|p| p.as_ref())
                    };
                    if let Some(pipe) = pipe {
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
                    use crate::socket::SocketState;
                    // POLLERR: report error if socket has pending error or shut down for writing
                    if sock.shut_wr && sock.shut_rd {
                        revents |= POLLERR;
                    }
                    // Listening socket: POLLIN if backlog has pending connections
                    // Check both the shared cross-process queue (AF_INET) and the
                    // per-process backlog (AF_UNIX same-process).
                    if sock.state == SocketState::Listening {
                        let mut has_pending = !sock.listen_backlog.is_empty();
                        if !has_pending {
                            if let Some(shared_idx) = sock.shared_backlog_idx {
                                has_pending = unsafe {
                                    crate::socket::shared_listener_backlog_table().len(shared_idx) > 0
                                };
                            }
                        }
                        if has_pending && (pollfd.events & POLLIN != 0) {
                            revents |= POLLIN;
                        }
                    }
                    // DGRAM socket: POLLIN if datagram queue is non-empty
                    if !sock.dgram_queue.is_empty() {
                        if pollfd.events & POLLIN != 0 {
                            revents |= POLLIN;
                        }
                    }
                    // Check recv buffer for readability
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        let pipe_ref = if sock.global_pipes {
                            unsafe { crate::pipe::global_pipe_table().get(recv_idx) }
                        } else {
                            proc.pipes.get(recv_idx).and_then(|p| p.as_ref())
                        };
                        if let Some(pipe) = pipe_ref {
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
                        let pipe_ref = if sock.global_pipes {
                            unsafe { crate::pipe::global_pipe_table().get(send_idx) }
                        } else {
                            proc.pipes.get(send_idx).and_then(|p| p.as_ref())
                        };
                        if let Some(pipe) = pipe_ref {
                            if pollfd.events & POLLOUT != 0 && pipe.free_space() > 0 {
                                revents |= POLLOUT;
                            }
                        }
                    }
                    // Host-delegated external socket (no pipe buffers): report
                    // ready for requested events. The kernel can't see async
                    // host state (e.g. pending fetch), so we always report ready.
                    // If recv has no data yet, host_net_recv returns EAGAIN;
                    // non-blocking FDs get EAGAIN back immediately, and the
                    // program's poll loop retries — each iteration yields to the
                    // JS event loop, allowing the async fetch to complete.
                    if sock.host_net_handle.is_some()
                        && sock.recv_buf_idx.is_none()
                        && sock.send_buf_idx.is_none()
                        && sock.state == SocketState::Connected
                    {
                        if pollfd.events & POLLOUT != 0 {
                            revents |= POLLOUT;
                        }
                        if pollfd.events & POLLIN != 0 {
                            revents |= POLLIN;
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

    // /dev/fd/N and /dev/stdin|stdout|stderr — dup an existing fd
    if let Some(target_fd) = match_dev_fd(&resolved) {
        let entry = proc.fd_table.get(target_fd)?;
        let ofd_ref = entry.ofd_ref;
        proc.ofd_table.inc_ref(ofd_ref.0);
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(ofd_ref, fd_flags)?;
        return Ok(fd);
    }

    // Virtual device nodes — handle in-kernel, no host call
    if let Some(dev) = match_virtual_device(&resolved) {
        if dev == VirtualDevice::Fb0 {
            acquire_fb0_or_busy(proc.pid)?;
        }
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::CharDevice, status_flags, dev.host_handle(), resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/ptmx — allocate a new PTY master
    if resolved == b"/dev/ptmx" {
        let pty_idx = crate::pty::alloc_pty().ok_or(Errno::ENOSPC)?;
        let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
        pty.master_refs += 1;
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::PtyMaster, status_flags, pty_idx as i64, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/pts/N — open PTY slave
    if resolved.starts_with(b"/dev/pts/") {
        let num_str = &resolved[9..];
        let pty_idx = parse_ascii_usize(num_str).ok_or(Errno::ENOENT)?;
        let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::ENOENT)?;
        if pty.locked {
            return Err(Errno::EIO);
        }
        pty.slave_refs += 1;
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::PtySlave, status_flags, pty_idx as i64, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // /dev/tty — open controlling terminal
    if resolved == b"/dev/tty" {
        for fd_i in 0..1024i32 {
            if let Ok(entry) = proc.fd_table.get(fd_i as i32) {
                if let Some(ofd) = proc.ofd_table.get(entry.ofd_ref.0) {
                    if ofd.file_type == FileType::PtySlave {
                        proc.ofd_table.inc_ref(entry.ofd_ref.0);
                        let fd_flags = oflags_to_fd_flags(oflags);
                        let fd = proc.fd_table.alloc(entry.ofd_ref, fd_flags)?;
                        return Ok(fd);
                    }
                }
            }
        }
        if let Ok(entry) = proc.fd_table.get(0) {
            let ofd_ref = entry.ofd_ref;
            proc.ofd_table.inc_ref(ofd_ref.0);
            let fd_flags = oflags_to_fd_flags(oflags);
            let fd = proc.fd_table.alloc(ofd_ref, fd_flags)?;
            return Ok(fd);
        }
        return Err(Errno::ENXIO);
    }

    // Synthetic /etc files — in-kernel read-only files
    if synthetic_file_content(&resolved).is_some() {
        if oflags & (O_WRONLY | O_RDWR) != 0 {
            return Err(Errno::EACCES);
        }
        let status_flags = oflags & !CREATION_FLAGS;
        let ofd_idx = proc.ofd_table.create(
            FileType::Regular, status_flags, SYNTHETIC_FILE_HANDLE, resolved,
        );
        let fd_flags = oflags_to_fd_flags(oflags);
        let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags)?;
        return Ok(fd);
    }

    // Procfs (/proc/...) — in-kernel virtual filesystem
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        return crate::procfs::procfs_open(proc, &entry, resolved, oflags);
    }

    // Devfs (/dev, /dev/pts, etc.) — in-kernel directory listing
    if crate::devfs::match_devfs_dir(&resolved).is_some() {
        return crate::devfs::devfs_open_dir(proc, resolved, oflags);
    }

    let effective_mode = if oflags & O_CREAT != 0 {
        mode & !proc.umask
    } else {
        mode
    };

    // POSIX: open() on an existing directory with O_CREAT returns EISDIR
    if oflags & O_CREAT != 0 {
        if let Ok(st) = host.host_stat(&resolved) {
            if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
                return Err(Errno::EISDIR);
            }
        }
    }

    let host_handle = host.host_open(&resolved, oflags, effective_mode)?;

    let file_type = if oflags & O_DIRECTORY != 0 {
        FileType::Directory
    } else if let Ok(st) = host.host_stat(&resolved) {
        if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
            FileType::Directory
        } else {
            FileType::Regular
        }
    } else {
        FileType::Regular
    };

    let status_flags = oflags & !CREATION_FLAGS;
    let ofd_idx = proc.ofd_table.create(file_type, status_flags, host_handle, resolved);

    let fd_flags = oflags_to_fd_flags(oflags);

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
    if let Some(dev) = match_virtual_device(&resolved) {
        return Ok(virtual_device_stat(dev, proc.euid, proc.egid));
    }
    if match_dev_fd(&resolved).is_some() {
        use wasm_posix_shared::mode::S_IFCHR;
        return Ok(WasmStat {
            st_dev: 5, st_ino: 0, st_mode: S_IFCHR | 0o666, st_nlink: 1,
            st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(content) = synthetic_file_content(&resolved) {
        return Ok(WasmStat {
            st_dev: 0, st_ino: 0x45544300,
            st_mode: S_IFREG | 0o444, st_nlink: 1,
            st_uid: 0, st_gid: 0, st_size: content.len() as u64,
            st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
            st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        });
    }
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        let follow = flags & AT_SYMLINK_NOFOLLOW == 0;
        return Ok(crate::procfs::procfs_stat(&entry, 0, follow));
    }
    if let Some(st) = crate::devfs::match_devfs_stat(&resolved, proc.euid, proc.egid) {
        return Ok(st);
    }
    // Check Unix socket registry
    {
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        if registry.contains(&resolved) {
            return Ok(WasmStat {
                st_dev: 0, st_ino: 0x554E5800, // "UNX\0"
                st_mode: wasm_posix_shared::mode::S_IFSOCK | 0o755, st_nlink: 1,
                st_uid: proc.euid, st_gid: proc.egid, st_size: 0,
                st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            });
        }
    }
    // VFS is the source of truth for ownership: host_stat / host_lstat
    // already return the real uid/gid, so just propagate.
    if flags & AT_SYMLINK_NOFOLLOW != 0 {
        host.host_lstat(&resolved)
    } else {
        host.host_stat(&resolved)
    }
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
        // AF_UNIX bind() creates a host inode; remove both the registry
        // entry and the inode. (Same as sys_unlink.)
        {
            let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
            if registry.unregister(&resolved) {
                match host.host_unlink(&resolved) {
                    Ok(()) | Err(Errno::ENOENT) => return Ok(()),
                    Err(e) => return Err(e),
                }
            }
        }
        match host.host_unlink(&resolved) {
            Err(Errno::EPERM) => {
                // Linux returns EISDIR when unlinking a directory; macOS returns EPERM.
                if let Ok(st) = host.host_stat(&resolved) {
                    if st.st_mode & wasm_posix_shared::mode::S_IFMT == wasm_posix_shared::mode::S_IFDIR {
                        return Err(Errno::EISDIR);
                    }
                }
                Err(Errno::EPERM)
            }
            other => other,
        }
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

/// tcgetattr -- get terminal attributes (custom syscall 70).
/// Uses kernel's 48-byte format for backward compat: 4×u32 flags + c_cc[32].
pub fn sys_tcgetattr(proc: &mut Process, fd: i32, buf: &mut [u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    if !matches!(ofd.file_type, FileType::CharDevice | FileType::PtyMaster | FileType::PtySlave) {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    let ts = match ofd.file_type {
        FileType::PtyMaster | FileType::PtySlave => {
            let pty_idx = ofd.host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            &pty.terminal as *const crate::terminal::TerminalState
        }
        _ => &proc.terminal as *const crate::terminal::TerminalState,
    };
    // Safety: we hold &mut proc, and PTY table is kernel-global with single-threaded access
    let ts = unsafe { &*ts };
    buf[0..4].copy_from_slice(&ts.c_iflag.to_le_bytes());
    buf[4..8].copy_from_slice(&ts.c_oflag.to_le_bytes());
    buf[8..12].copy_from_slice(&ts.c_cflag.to_le_bytes());
    buf[12..16].copy_from_slice(&ts.c_lflag.to_le_bytes());
    buf[16..48].copy_from_slice(&ts.c_cc);
    Ok(())
}

/// tcsetattr -- set terminal attributes (custom syscall 71).
/// Uses kernel's 48-byte format for backward compat: 4×u32 flags + c_cc[32].
pub fn sys_tcsetattr(proc: &mut Process, fd: i32, _action: u32, buf: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    if !matches!(ofd.file_type, FileType::CharDevice | FileType::PtyMaster | FileType::PtySlave) {
        return Err(Errno::ENOTTY);
    }
    if buf.len() < 48 {
        return Err(Errno::EINVAL);
    }
    match ofd.file_type {
        FileType::PtyMaster | FileType::PtySlave => {
            let pty_idx = ofd.host_handle as usize;
            let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
            pty.terminal.c_iflag = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            pty.terminal.c_oflag = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            pty.terminal.c_cflag = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
            pty.terminal.c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
            pty.terminal.c_cc.copy_from_slice(&buf[16..48]);
        }
        _ => {
            proc.terminal.c_iflag = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            proc.terminal.c_oflag = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            proc.terminal.c_cflag = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
            proc.terminal.c_lflag = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
            proc.terminal.c_cc.copy_from_slice(&buf[16..48]);
        }
    }
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

    // FIOASYNC — toggle O_ASYNC on the OFD status_flags
    if request == 0x5452 {
        if buf.len() < 4 {
            return Err(Errno::EINVAL);
        }
        let val = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let ofd = proc.ofd_table.get_mut(ofd_idx).ok_or(Errno::EBADF)?;
        if val != 0 {
            ofd.status_flags |= wasm_posix_shared::flags::O_ASYNC;
        } else {
            ofd.status_flags &= !wasm_posix_shared::flags::O_ASYNC;
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
                    let pipe = if crate::is_centralized_mode() {
                        unsafe { crate::pipe::global_pipe_table().get(pipe_idx) }
                    } else {
                        proc.pipes.get(pipe_idx).and_then(|p| p.as_ref())
                    };
                    pipe.map(|p| p.available() as i32).unwrap_or(0)
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
            FileType::PtyMaster => {
                let pty_idx = ofd.host_handle as usize;
                crate::pty::get_pty(pty_idx)
                    .map(|p| p.output_buf.len() as i32)
                    .unwrap_or(0)
            }
            FileType::PtySlave => {
                let pty_idx = ofd.host_handle as usize;
                crate::pty::get_pty(pty_idx)
                    .map(|p| {
                        if p.terminal.is_canonical() {
                            p.terminal.cooked_buffer.len() as i32
                        } else {
                            p.input_buf.len() as i32
                        }
                    })
                    .unwrap_or(0)
            }
            _ => 0,
        };
        buf[0..4].copy_from_slice(&avail.to_le_bytes());
        return Ok(());
    }

    // SIOCATMARK — check if at out-of-band mark
    if request == 0x8905 {
        if buf.len() < 4 {
            return Err(Errno::EINVAL);
        }
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::Socket {
            return Err(Errno::ENOTSOCK);
        }
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let atmark: i32 = if let Some(sock) = proc.sockets.get(sock_idx) {
            if sock.oob_byte.is_some() { 1 } else { 0 }
        } else {
            0
        };
        buf[0..4].copy_from_slice(&atmark.to_le_bytes());
        return Ok(());
    }

    // --- PTY-specific ioctls (work on PtyMaster only) ---
    {
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

        // TIOCGPTN — get PTY number
        if request == crate::terminal::TIOCGPTN {
            if ofd.file_type != FileType::PtyMaster {
                return Err(Errno::ENOTTY);
            }
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let pty_idx = ofd.host_handle as u32;
            buf[0..4].copy_from_slice(&pty_idx.to_le_bytes());
            return Ok(());
        }

        // TIOCSPTLCK — set/clear PTY lock
        if request == crate::terminal::TIOCSPTLCK {
            if ofd.file_type != FileType::PtyMaster {
                return Err(Errno::ENOTTY);
            }
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let lock_val = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            let pty_idx = ofd.host_handle as usize;
            if let Some(pty) = crate::pty::get_pty(pty_idx) {
                pty.locked = lock_val != 0;
            }
            return Ok(());
        }
    }

    // --- /dev/fb0 ioctls — fbdev surface ---
    {
        let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
        if ofd.file_type == FileType::CharDevice
            && VirtualDevice::from_host_handle(ofd.host_handle) == Some(VirtualDevice::Fb0)
        {
            return handle_fb_ioctl(request, buf);
        }
    }

    // --- Linux VT keyboard ioctls (KDGKBTYPE / KDGKBMODE / KDSKBMODE) ---
    //
    // fbDOOM (and other Linux-VT-targeted software) calls these on a
    // tty fd to detect the keyboard and switch into raw-scancode mode.
    // We don't have a real VT — input arrives as a stream of bytes
    // through stdin from whatever the host is feeding (canvas
    // keyboard, in the browser demo). The ioctls succeed with sensible
    // defaults so software detecting "is this a Linux VT" sees yes.
    // Mode is otherwise a no-op — we don't actually translate stdin
    // based on the requested mode.
    match request {
        // KDGKBTYPE — return KB_101 (0x02) as a single byte.
        0x4B33 => {
            if buf.is_empty() { return Err(Errno::EINVAL); }
            buf[0] = 0x02;
            return Ok(());
        }
        // KDGKBMODE — return K_XLATE (1) as i32.
        0x4B44 => {
            if buf.len() < 4 { return Err(Errno::EINVAL); }
            buf[..4].copy_from_slice(&1i32.to_le_bytes());
            return Ok(());
        }
        // KDSKBMODE — accept any mode, no-op success.
        0x4B45 => return Ok(()),
        _ => {}
    }

    // --- Terminal ioctls (work on CharDevice, PtyMaster, PtySlave) ---
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
    let file_type = ofd.file_type;
    let host_handle = ofd.host_handle;

    let is_terminal = matches!(file_type, FileType::CharDevice | FileType::PtyMaster | FileType::PtySlave);
    if !is_terminal {
        return Err(Errno::ENOTTY);
    }

    // Helper: get mutable reference to the appropriate TerminalState.
    // For PTY fds → PTY pair's terminal state; for CharDevice → process terminal state.
    // We handle this by dispatching per-request below.

    use crate::terminal::*;

    match request {
        TCGETS => {
            if buf.len() < TERMIOS_SIZE {
                return Err(Errno::EINVAL);
            }
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
                    pty.terminal.write_termios(buf);
                }
                _ => {
                    proc.terminal.write_termios(buf);
                }
            }
            Ok(())
        }
        TCSETS | TCSETSW | TCSETSF => {
            if buf.len() < TERMIOS_SIZE {
                return Err(Errno::EINVAL);
            }
            // TCSETSF: also flush input queue
            if request == TCSETSF {
                match file_type {
                    FileType::PtyMaster | FileType::PtySlave => {
                        let pty_idx = host_handle as usize;
                        if let Some(pty) = crate::pty::get_pty(pty_idx) {
                            pty.input_buf.clear();
                            pty.terminal.line_buffer.clear();
                            pty.terminal.cooked_buffer.clear();
                        }
                    }
                    _ => {
                        proc.terminal.line_buffer.clear();
                        proc.terminal.cooked_buffer.clear();
                    }
                }
            }
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    let pty = crate::pty::get_pty(pty_idx).ok_or(Errno::EIO)?;
                    pty.terminal.read_termios(buf);
                }
                _ => {
                    proc.terminal.read_termios(buf);
                }
            }
            Ok(())
        }
        TIOCGPGRP => {
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let pgid = match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    crate::pty::get_pty(pty_idx)
                        .map(|p| p.terminal.foreground_pgid)
                        .unwrap_or(1)
                }
                _ => proc.terminal.foreground_pgid,
            };
            buf[0..4].copy_from_slice(&pgid.to_le_bytes());
            Ok(())
        }
        TIOCSPGRP => {
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let pgid = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            if pgid <= 0 {
                return Err(Errno::EINVAL);
            }
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.terminal.foreground_pgid = pgid;
                    }
                }
                _ => {
                    proc.terminal.foreground_pgid = pgid;
                }
            }
            Ok(())
        }
        TIOCGWINSZ => {
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    crate::pty::get_pty(pty_idx)
                        .map(|p| p.terminal.winsize)
                        .unwrap_or(WinSize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 })
                }
                _ => proc.terminal.winsize,
            };
            buf[0..2].copy_from_slice(&ws.ws_row.to_le_bytes());
            buf[2..4].copy_from_slice(&ws.ws_col.to_le_bytes());
            buf[4..6].copy_from_slice(&ws.ws_xpixel.to_le_bytes());
            buf[6..8].copy_from_slice(&ws.ws_ypixel.to_le_bytes());
            Ok(())
        }
        TIOCSWINSZ => {
            if buf.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let ws = WinSize {
                ws_row: u16::from_le_bytes([buf[0], buf[1]]),
                ws_col: u16::from_le_bytes([buf[2], buf[3]]),
                ws_xpixel: u16::from_le_bytes([buf[4], buf[5]]),
                ws_ypixel: u16::from_le_bytes([buf[6], buf[7]]),
            };
            let fg_pgid = match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.terminal.winsize = ws;
                        pty.terminal.foreground_pgid
                    } else { 0 }
                }
                _ => {
                    proc.terminal.winsize = ws;
                    proc.terminal.foreground_pgid
                }
            };
            // POSIX: TIOCSWINSZ sends SIGWINCH to the foreground process group
            if fg_pgid > 0 {
                proc.signals.raise(wasm_posix_shared::signal::SIGWINCH);
            }
            Ok(())
        }
        TCSBRK => {
            // tcdrain (arg=1) and tcsendbreak (arg=0): no-op — no real serial hardware
            Ok(())
        }
        TCXONC => {
            // tcflow: no-op — no flow control in virtual terminals
            Ok(())
        }
        TCFLSH => {
            // tcflush: flush input/output queues
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let queue = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        if queue == 0 || queue == 2 { // TCIFLUSH or TCIOFLUSH
                            pty.input_buf.clear();
                            pty.terminal.line_buffer.clear();
                            pty.terminal.cooked_buffer.clear();
                        }
                        if queue == 1 || queue == 2 { // TCOFLUSH or TCIOFLUSH
                            pty.output_buf.clear();
                        }
                    }
                }
                _ => {
                    if queue == 0 || queue == 2 {
                        proc.terminal.line_buffer.clear();
                        proc.terminal.cooked_buffer.clear();
                    }
                    // Output flush is a no-op for non-PTY terminals
                }
            }
            Ok(())
        }
        TIOCGSID => {
            // tcgetsid: return session ID of the terminal
            if buf.len() < 4 {
                return Err(Errno::EINVAL);
            }
            let sid = match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    crate::pty::get_pty(pty_idx)
                        .map(|p| p.terminal.session_id)
                        .unwrap_or(proc.sid as i32)
                }
                _ => proc.terminal.session_id,
            };
            // Return process's session ID if terminal session_id is not set
            let effective_sid = if sid != 0 { sid } else { proc.sid as i32 };
            buf[0..4].copy_from_slice(&effective_sid.to_le_bytes());
            Ok(())
        }
        TIOCSCTTY => {
            // Set controlling terminal: sets this terminal as the session's ctty
            // Also sets foreground pgrp to the calling process's pgid (POSIX)
            let pgid = proc.pgid as i32;
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.terminal.session_id = proc.sid as i32;
                        pty.terminal.foreground_pgid = pgid;
                    }
                }
                _ => {
                    proc.terminal.session_id = proc.sid as i32;
                    proc.terminal.foreground_pgid = pgid;
                }
            }
            Ok(())
        }
        TIOCNOTTY => {
            // Give up controlling terminal
            match file_type {
                FileType::PtyMaster | FileType::PtySlave => {
                    let pty_idx = host_handle as usize;
                    if let Some(pty) = crate::pty::get_pty(pty_idx) {
                        pty.terminal.session_id = 0;
                    }
                }
                _ => {
                    proc.terminal.session_id = 0;
                }
            }
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

// Returns thread ID. Without threading, tid == pid.
// Threading upgrade: return actual TID from thread table.
pub fn sys_gettid(proc: &Process) -> i32 {
    proc.pid as i32
}

// Stores tidptr for thread exit notification. Without threading, returns pid.
// Threading upgrade: store tidptr per-thread; kernel writes 0 + futex-wakes on exit.
pub fn sys_set_tid_address(proc: &Process) -> i32 {
    proc.pid as i32
}

// No-op — robust futex list tracking deferred until threading is implemented.
pub fn sys_set_robust_list() -> Result<(), Errno> {
    Ok(())
}

/// futex — real implementation using host Atomics.wait/notify.
pub fn sys_futex(
    host: &mut dyn HostIO,
    uaddr: usize,
    op: u32,
    val: u32,
    timeout: u32,
    uaddr2: usize,
    val3: u32,
) -> Result<i32, Errno> {
    const FUTEX_WAIT: u32 = 0;
    const FUTEX_WAKE: u32 = 1;
    #[allow(dead_code)]
    const FUTEX_FD: u32 = 2;
    const FUTEX_REQUEUE: u32 = 3;
    const FUTEX_CMP_REQUEUE: u32 = 4;
    const FUTEX_WAKE_OP: u32 = 5;
    const FUTEX_WAIT_BITSET: u32 = 9;
    const FUTEX_WAKE_BITSET: u32 = 10;
    const FUTEX_PRIVATE_FLAG: u32 = 128;
    const FUTEX_CLOCK_REALTIME: u32 = 256;

    let base_op = op & !(FUTEX_PRIVATE_FLAG | FUTEX_CLOCK_REALTIME);

    match base_op {
        FUTEX_WAIT | FUTEX_WAIT_BITSET => {
            // Centralized mode: return EAGAIN so host can wait asynchronously
            if crate::is_centralized_mode() {
                return Err(Errno::EAGAIN);
            }
            // timeout is a pointer to struct timespec in Wasm memory.
            // Layout (wasm32 time64): { tv_sec: i64, padding: 0, tv_nsec: i32, padding: 0 } = 16 bytes
            // For FUTEX_WAIT_BITSET, val3 is the bitmask (we ignore it, treat as full mask)
            let timeout_ns: i64 = if timeout != 0 {
                // Read timespec from Wasm memory (16 bytes for time64 layout)
                let mem = unsafe {
                    core::slice::from_raw_parts(timeout as *const u8, 16)
                };
                let sec = i64::from_le_bytes([
                    mem[0], mem[1], mem[2], mem[3],
                    mem[4], mem[5], mem[6], mem[7],
                ]);
                // tv_nsec is a long (4 bytes on wasm32) at offset 8
                let nsec = i32::from_le_bytes([mem[8], mem[9], mem[10], mem[11]]) as i64;
                sec * 1_000_000_000 + nsec
            } else {
                -1 // infinite wait
            };
            host.host_futex_wait(uaddr, val, timeout_ns)
        }
        FUTEX_WAKE | FUTEX_WAKE_BITSET => {
            host.host_futex_wake(uaddr, val)
        }
        FUTEX_REQUEUE => {
            // Wake val waiters on uaddr, requeue up to val2 waiters to uaddr2.
            // We can't truly requeue across futex addresses with Atomics, so
            // wake val + val2 on uaddr instead — woken threads will re-check
            // their conditions and re-wait on the correct address if needed.
            let val2 = timeout; // timeout param repurposed as val2 for REQUEUE
            host.host_futex_wake(uaddr, val + val2)
        }
        FUTEX_CMP_REQUEUE => {
            // Like REQUEUE but check *uaddr == val3 first
            let val2 = timeout;
            let actual = unsafe { core::ptr::read_volatile(uaddr as *const u32) };
            if actual != val3 {
                return Err(Errno::EAGAIN);
            }
            host.host_futex_wake(uaddr, val + val2)
        }
        FUTEX_WAKE_OP => {
            // Wake val waiters on uaddr, then conditionally wake val3 on uaddr2
            // Simplified: wake val on uaddr + val3 on uaddr2
            let woken1 = host.host_futex_wake(uaddr, val)?;
            let woken2 = if uaddr2 != 0 && val3 > 0 {
                host.host_futex_wake(uaddr2, val3)?
            } else {
                0
            };
            Ok(woken1 + woken2)
        }
        _ => Ok(0), // no-op for unrecognized ops
    }
}

/// clone — spawn a new thread.
///
/// In centralized mode: allocate a TID, store thread state, return TID.
/// The host's handleClone will then spawn the actual thread Worker.
///
/// In traditional mode: delegate to host_clone.
pub fn sys_clone(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fn_ptr: usize,
    stack_ptr: usize,
    flags: u32,
    arg: usize,
    ptid_ptr: usize,
    tls_ptr: usize,
    ctid_ptr: usize,
) -> Result<i32, Errno> {
    use crate::process::ThreadInfo;

    const CLONE_VM: u32 = 0x00000100;
    const CLONE_THREAD: u32 = 0x00010000;
    const CLONE_PARENT_SETTID: u32 = 0x00100000;
    #[allow(dead_code)]
    const CLONE_CHILD_SETTID: u32 = 0x01000000;
    const CLONE_CHILD_CLEARTID: u32 = 0x00200000;
    const CLONE_SETTLS: u32 = 0x00080000;

    // We only support thread-style clone (CLONE_VM | CLONE_THREAD)
    if flags & CLONE_VM == 0 || flags & CLONE_THREAD == 0 {
        return Err(Errno::ENOSYS);
    }

    let tid = if crate::is_centralized_mode() {
        // Centralized mode: allocate TID and store thread info in process.
        // The host will spawn the actual thread Worker after we return.
        let tid = proc.alloc_tid();
        let effective_tls = if flags & CLONE_SETTLS != 0 { tls_ptr } else { 0 };
        let effective_ctid = if flags & CLONE_CHILD_CLEARTID != 0 { ctid_ptr } else { 0 };
        // POSIX: new threads inherit the creator's signal mask.
        let caller_tid = crate::process_table::current_tid();
        let inherited_blocked = proc.blocked_for(caller_tid);
        let mut thread_info = ThreadInfo::new(tid, effective_ctid, stack_ptr, effective_tls);
        thread_info.signals.blocked = inherited_blocked;
        proc.add_thread(thread_info);
        tid as i32
    } else {
        // Traditional mode: delegate to host
        host.host_clone(fn_ptr, arg, stack_ptr, tls_ptr, ctid_ptr)?
    };

    // Write TID to parent's tid pointer if CLONE_PARENT_SETTID.
    // In centralized mode, ptid_ptr is in process memory (not kernel memory),
    // so the host must handle this write instead.
    if !crate::is_centralized_mode() && flags & CLONE_PARENT_SETTID != 0 && ptid_ptr != 0 {
        #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
        unsafe {
            let ptr = ptid_ptr as *mut i32;
            *ptr = tid;
        }
    }

    // Write TID to child's tid pointer if CLONE_CHILD_SETTID
    // (In centralized mode, the thread Worker will do this itself)
    let _ = (flags, ctid_ptr); // suppress unused warnings

    Ok(tid)
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
    // Centralized mode: use sigsuspend_saved_mask pattern for atomic mask swap.
    // The mask stays swapped across EAGAIN retries so cross-process signals
    // arriving between retries are caught on the next poll.
    if crate::is_centralized_mode() {
        let tid = crate::process_table::current_tid();
        if let Some(new_mask) = mask {
            use wasm_posix_shared::signal::{SIGKILL, SIGSTOP};
            if proc.sigsuspend_saved_mask_for(tid).is_none() {
                // First call: save original mask and install ppoll mask
                proc.set_sigsuspend_saved_mask_for(tid, Some(proc.blocked_for(tid)));
                let m = new_mask
                    & !(crate::signal::sig_bit(SIGKILL) | crate::signal::sig_bit(SIGSTOP));
                proc.set_blocked_for(tid, m);
            }
            // Check if any signals are deliverable with the ppoll mask
            if proc.deliverable_for(tid) != 0 {
                // Signal arrived — return EINTR. Keep temp mask active so
                // kernel_dequeue_signal can deliver the signal and restore
                // the original mask (via sigsuspend_saved_mask).
                return Err(Errno::EINTR);
            }
        }

        // Check fds (non-blocking) via sys_poll
        let result = sys_poll(proc, host, fds, timeout_ms);
        match result {
            Err(Errno::EAGAIN) => {
                // Still blocking — keep mask swapped for next retry
                return Err(Errno::EAGAIN);
            }
            _ => {
                // Poll completed (fds ready, timeout=0, or error).
                // If signals became deliverable during the ppoll window,
                // keep sigsuspend_saved_mask so kernel_dequeue_signal can
                // deliver them with the ppoll mask active, then restore
                // the original mask.  Otherwise restore immediately.
                if proc.deliverable_for(tid) == 0 {
                    if let Some(saved) = proc.take_sigsuspend_saved_mask_for(tid) {
                        proc.set_blocked_for(tid, saved);
                    }
                }
                return result;
            }
        }
    }

    // Non-centralized mode: simple save/restore around sys_poll
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
    // Centralized mode: use sigsuspend_saved_mask pattern for atomic mask swap.
    // The mask stays swapped across EAGAIN retries so cross-process signals
    // arriving between retries are caught on the next select.
    if crate::is_centralized_mode() {
        let tid = crate::process_table::current_tid();
        if let Some(new_mask) = mask {
            use wasm_posix_shared::signal::{SIGKILL, SIGSTOP};
            if proc.sigsuspend_saved_mask_for(tid).is_none() {
                // First call: save original mask and install pselect mask
                proc.set_sigsuspend_saved_mask_for(tid, Some(proc.blocked_for(tid)));
                let m = new_mask
                    & !(crate::signal::sig_bit(SIGKILL) | crate::signal::sig_bit(SIGSTOP));
                proc.set_blocked_for(tid, m);
            }
            // Check if any signals are deliverable with the pselect mask
            if proc.deliverable_for(tid) != 0 {
                return Err(Errno::EINTR);
            }
        }

        let result = sys_select(proc, host, nfds, readfds, writefds, exceptfds, timeout_ms);
        match result {
            Err(Errno::EAGAIN) => {
                // Still blocking — keep mask swapped for next retry
                return Err(Errno::EAGAIN);
            }
            _ => {
                // Select completed — if signals became deliverable during
                // the pselect window, keep sigsuspend_saved_mask so
                // kernel_dequeue_signal can deliver them first.
                if proc.deliverable_for(tid) == 0 {
                    if let Some(saved) = proc.take_sigsuspend_saved_mask_for(tid) {
                        proc.set_blocked_for(tid, saved);
                    }
                }
                return result;
            }
        }
    }

    // Non-centralized mode: simple save/restore around sys_select
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

/// eventfd2 — create an eventfd file descriptor.
///
/// Returns a file descriptor that can be used for event notification.
/// The counter is initialized to `initval`.
///
/// Flags: EFD_CLOEXEC (0o2000000), EFD_NONBLOCK (0o4000), EFD_SEMAPHORE (1).
pub fn sys_eventfd2(proc: &mut Process, initval: u32, flags: u32) -> Result<i32, Errno> {
    use crate::ofd::FileType;
    use crate::process::EventFdState;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    const EFD_SEMAPHORE: u32 = 1;

    let semaphore = flags & EFD_SEMAPHORE != 0;
    let cloexec = flags & O_CLOEXEC != 0;
    let nonblock = flags & O_NONBLOCK != 0;

    // Validate flags — only EFD_SEMAPHORE, EFD_CLOEXEC, EFD_NONBLOCK allowed
    let valid_flags = EFD_SEMAPHORE | O_CLOEXEC | O_NONBLOCK;
    if flags & !valid_flags != 0 {
        return Err(Errno::EINVAL);
    }

    let state = EventFdState {
        counter: initval as u64,
        semaphore,
    };

    // Allocate eventfd slot (reuse freed slots)
    let efd_idx = {
        let mut found = None;
        for (i, slot) in proc.eventfds.iter().enumerate() {
            if slot.is_none() {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                proc.eventfds[i] = Some(state);
                i
            }
            None => {
                let i = proc.eventfds.len();
                proc.eventfds.push(Some(state));
                i
            }
        }
    };

    // Eventfd handle is negative: -(efd_idx + 1)
    let efd_handle = -((efd_idx as i64) + 1);

    // Status flags: O_RDWR (readable and writable), plus O_NONBLOCK if requested
    let mut status_flags = O_RDWR;
    if nonblock {
        status_flags |= O_NONBLOCK;
    }

    let ofd_idx = proc.ofd_table.create(
        FileType::EventFd,
        status_flags,
        efd_handle,
        b"/dev/eventfd".to_vec(),
    );

    let fd_flags = if cloexec { FD_CLOEXEC } else { 0 };
    match proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd_idx);
            proc.eventfds[efd_idx] = None;
            Err(e)
        }
    }
}

/// inotify_init — create an inotify instance (stub).
///
/// Returns a file descriptor that can be polled/closed but never produces
/// events. Programs that use inotify as an optimization will fall back to
/// polling. Uses an eventfd internally with counter 0.
pub fn sys_inotify_init(proc: &mut Process) -> Result<i32, Errno> {
    // Reuse eventfd with counter=0 to get a valid, pollable fd
    sys_eventfd2(proc, 0, O_CLOEXEC | O_NONBLOCK)
}

/// epoll_create1 — create an epoll instance.
///
/// Returns a file descriptor for the new epoll instance.
/// Flags: EPOLL_CLOEXEC (O_CLOEXEC).
pub fn sys_epoll_create1(proc: &mut Process, flags: u32) -> Result<i32, Errno> {
    use crate::ofd::FileType;
    use crate::process::EpollInstance;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    let cloexec = flags & O_CLOEXEC != 0;

    // Only EPOLL_CLOEXEC is valid
    if flags & !O_CLOEXEC != 0 {
        return Err(Errno::EINVAL);
    }

    let instance = EpollInstance::new();

    // Allocate epoll slot
    let ep_idx = {
        let mut found = None;
        for (i, slot) in proc.epolls.iter().enumerate() {
            if slot.is_none() {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                proc.epolls[i] = Some(instance);
                i
            }
            None => {
                let i = proc.epolls.len();
                proc.epolls.push(Some(instance));
                i
            }
        }
    };

    let ep_handle = -((ep_idx as i64) + 1);
    let ofd_idx = proc.ofd_table.create(
        FileType::Epoll,
        O_RDWR,
        ep_handle,
        b"/dev/epoll".to_vec(),
    );

    let fd_flags = if cloexec { FD_CLOEXEC } else { 0 };
    match proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd_idx);
            proc.epolls[ep_idx] = None;
            Err(e)
        }
    }
}

/// epoll_ctl — modify an epoll interest list.
///
/// op: EPOLL_CTL_ADD (1), EPOLL_CTL_DEL (2), EPOLL_CTL_MOD (3).
pub fn sys_epoll_ctl(
    proc: &mut Process,
    epfd: i32,
    op: i32,
    fd: i32,
    events: u32,
    data: u64,
) -> Result<(), Errno> {
    const EPOLL_CTL_ADD: i32 = 1;
    const EPOLL_CTL_DEL: i32 = 2;
    const EPOLL_CTL_MOD: i32 = 3;

    // Look up the epoll instance
    let entry = proc.fd_table.get(epfd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Epoll {
        return Err(Errno::EINVAL);
    }
    let ep_idx = (-(ofd.host_handle + 1)) as usize;

    // Verify the target fd exists
    let _ = proc.fd_table.get(fd)?;

    let ep = proc.epolls.get_mut(ep_idx)
        .and_then(|s| s.as_mut())
        .ok_or(Errno::EBADF)?;

    match op {
        EPOLL_CTL_ADD => {
            // Check if fd already exists in interest list
            if ep.interests.iter().any(|e| e.fd == fd) {
                return Err(Errno::EEXIST);
            }
            ep.interests.push(crate::process::EpollInterest { fd, events, data });
            Ok(())
        }
        EPOLL_CTL_DEL => {
            let pos = ep.interests.iter().position(|e| e.fd == fd)
                .ok_or(Errno::ENOENT)?;
            ep.interests.swap_remove(pos);
            Ok(())
        }
        EPOLL_CTL_MOD => {
            let interest = ep.interests.iter_mut().find(|e| e.fd == fd)
                .ok_or(Errno::ENOENT)?;
            interest.events = events;
            interest.data = data;
            Ok(())
        }
        _ => Err(Errno::EINVAL),
    }
}

/// epoll_pwait — wait for events on an epoll instance.
///
/// Builds pollfds from the interest list, delegates to sys_poll,
/// then maps the results back to epoll_event format.
pub fn sys_epoll_pwait(
    proc: &mut Process,
    host: &mut dyn HostIO,
    epfd: i32,
    maxevents: i32,
    timeout_ms: i32,
    sigmask: Option<u64>,
) -> Result<(i32, Vec<(u32, u64)>), Errno> {
    use wasm_posix_shared::poll::*;

    if maxevents <= 0 {
        return Err(Errno::EINVAL);
    }

    // Look up the epoll instance
    let entry = proc.fd_table.get(epfd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Epoll {
        return Err(Errno::EINVAL);
    }
    let ep_idx = (-(ofd.host_handle + 1)) as usize;

    // Copy interest list (need to release borrow on proc)
    let interests = {
        let ep = proc.epolls.get(ep_idx)
            .and_then(|s| s.as_ref())
            .ok_or(Errno::EBADF)?;
        ep.interests.clone()
    };

    if interests.is_empty() {
        // No interests — just handle timeout/sigmask
        if let Some(new_mask) = sigmask {
            let old = sys_sigprocmask(proc, SIG_SETMASK, new_mask)?;
            if timeout_ms != 0 {
                // Brief sleep if timeout specified
                if timeout_ms > 0 {
                    let _ = host.host_nanosleep(0, (timeout_ms as i64) * 1_000_000);
                }
            }
            let _ = sys_sigprocmask(proc, SIG_SETMASK, old);
        }
        return Ok((0, Vec::new()));
    }

    // Map EPOLL events to poll events
    const EPOLLIN: u32 = 0x001;
    const EPOLLOUT: u32 = 0x004;
    const EPOLLERR: u32 = 0x008;
    const EPOLLHUP: u32 = 0x010;
    #[allow(dead_code)]
    const EPOLLRDHUP: u32 = 0x2000;

    // Build pollfds from interests
    let mut pollfds: Vec<WasmPollFd> = interests.iter().map(|interest| {
        let mut poll_events: i16 = 0;
        if interest.events & EPOLLIN != 0 { poll_events |= POLLIN; }
        if interest.events & EPOLLOUT != 0 { poll_events |= POLLOUT; }
        WasmPollFd {
            fd: interest.fd,
            events: poll_events,
            revents: 0,
        }
    }).collect();

    // Apply signal mask if provided
    let old_mask = if let Some(new_mask) = sigmask {
        let old = sys_sigprocmask(proc, SIG_SETMASK, new_mask)?;
        Some(old)
    } else {
        None
    };

    // Delegate to sys_poll
    let ready = sys_poll(proc, host, &mut pollfds, timeout_ms);

    // Restore signal mask
    if let Some(old) = old_mask {
        let _ = sys_sigprocmask(proc, SIG_SETMASK, old);
    }

    let _ready_count = ready?;

    // Map poll results back to epoll events
    let mut events_out: Vec<(u32, u64)> = Vec::new();
    for (i, pollfd) in pollfds.iter().enumerate() {
        if pollfd.revents != 0 && events_out.len() < maxevents as usize {
            let mut ep_events: u32 = 0;
            if pollfd.revents & POLLIN != 0 { ep_events |= EPOLLIN; }
            if pollfd.revents & POLLOUT != 0 { ep_events |= EPOLLOUT; }
            if pollfd.revents & POLLERR != 0 { ep_events |= EPOLLERR; }
            if pollfd.revents & POLLHUP != 0 { ep_events |= EPOLLHUP; }
            events_out.push((ep_events, interests[i].data));
        }
    }

    Ok((events_out.len() as i32, events_out))
}

/// timerfd_create — create a timer file descriptor.
pub fn sys_timerfd_create(proc: &mut Process, clock_id: u32, flags: u32) -> Result<i32, Errno> {
    use crate::ofd::FileType;
    use crate::process::TimerFdState;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    // TFD_CLOEXEC = O_CLOEXEC, TFD_NONBLOCK = O_NONBLOCK
    let cloexec = flags & O_CLOEXEC != 0;
    let nonblock = flags & O_NONBLOCK != 0;
    let valid_flags = O_CLOEXEC | O_NONBLOCK;
    if flags & !valid_flags != 0 {
        return Err(Errno::EINVAL);
    }

    let state = TimerFdState {
        clock_id,
        interval_sec: 0,
        interval_nsec: 0,
        value_sec: 0,
        value_nsec: 0,
        expirations: 0,
    };

    let tfd_idx = {
        let mut found = None;
        for (i, slot) in proc.timerfds.iter().enumerate() {
            if slot.is_none() { found = Some(i); break; }
        }
        match found {
            Some(i) => { proc.timerfds[i] = Some(state); i }
            None => { let i = proc.timerfds.len(); proc.timerfds.push(Some(state)); i }
        }
    };

    let handle = -((tfd_idx as i64) + 1);
    let mut status_flags = O_RDWR;
    if nonblock { status_flags |= O_NONBLOCK; }
    let ofd_idx = proc.ofd_table.create(FileType::TimerFd, status_flags, handle, b"/dev/timerfd".to_vec());
    let fd_flags = if cloexec { FD_CLOEXEC } else { 0 };
    match proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd_idx);
            proc.timerfds[tfd_idx] = None;
            Err(e)
        }
    }
}

/// timerfd_settime — arm or disarm a timer.
///
/// new_value: (interval_sec, interval_nsec, value_sec, value_nsec).
/// Returns old timer value if successful.
pub fn sys_timerfd_settime(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    flags: u32,
    interval_sec: i64,
    interval_nsec: i64,
    value_sec: i64,
    value_nsec: i64,
) -> Result<(i64, i64, i64, i64), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::TimerFd {
        return Err(Errno::EINVAL);
    }
    let tfd_idx = (-(ofd.host_handle + 1)) as usize;
    let tfd = proc.timerfds.get_mut(tfd_idx)
        .and_then(|s| s.as_mut())
        .ok_or(Errno::EBADF)?;

    let old = (tfd.interval_sec, tfd.interval_nsec, tfd.value_sec, tfd.value_nsec);

    const TFD_TIMER_ABSTIME: u32 = 1;

    if value_sec == 0 && value_nsec == 0 {
        // Disarm the timer
        tfd.interval_sec = 0;
        tfd.interval_nsec = 0;
        tfd.value_sec = 0;
        tfd.value_nsec = 0;
        tfd.expirations = 0;
    } else {
        tfd.interval_sec = interval_sec;
        tfd.interval_nsec = interval_nsec;
        if flags & TFD_TIMER_ABSTIME != 0 {
            tfd.value_sec = value_sec;
            tfd.value_nsec = value_nsec;
        } else {
            // Relative: add current time
            let clock_id = tfd.clock_id;
            let (now_sec, now_nsec) = host.host_clock_gettime(clock_id)?;
            let mut total_nsec = now_nsec + value_nsec;
            let mut total_sec = now_sec + value_sec;
            if total_nsec >= 1_000_000_000 {
                total_sec += total_nsec / 1_000_000_000;
                total_nsec %= 1_000_000_000;
            }
            tfd.value_sec = total_sec;
            tfd.value_nsec = total_nsec;
        }
        tfd.expirations = 0;
    }

    Ok(old)
}

/// timerfd_gettime — get remaining time until next expiration.
pub fn sys_timerfd_gettime(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
) -> Result<(i64, i64, i64, i64), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::TimerFd {
        return Err(Errno::EINVAL);
    }
    let tfd_idx = (-(ofd.host_handle + 1)) as usize;
    let tfd = proc.timerfds.get(tfd_idx)
        .and_then(|s| s.as_ref())
        .ok_or(Errno::EBADF)?;

    if tfd.value_sec == 0 && tfd.value_nsec == 0 {
        return Ok((0, 0, 0, 0));
    }

    let (now_sec, now_nsec) = host.host_clock_gettime(tfd.clock_id)?;
    let mut remain_sec = tfd.value_sec - now_sec;
    let mut remain_nsec = tfd.value_nsec - now_nsec;
    if remain_nsec < 0 {
        remain_sec -= 1;
        remain_nsec += 1_000_000_000;
    }
    if remain_sec < 0 {
        remain_sec = 0;
        remain_nsec = 0;
    }
    Ok((tfd.interval_sec, tfd.interval_nsec, remain_sec, remain_nsec))
}

/// Helper: compute timerfd expirations lazily.
fn timerfd_compute_expirations(tfd: &mut crate::process::TimerFdState, now_sec: i64, now_nsec: i64) {
    if tfd.value_sec == 0 && tfd.value_nsec == 0 {
        return; // disarmed
    }
    // Check if timer has expired
    if now_sec > tfd.value_sec || (now_sec == tfd.value_sec && now_nsec >= tfd.value_nsec) {
        if tfd.interval_sec == 0 && tfd.interval_nsec == 0 {
            // One-shot: one expiration
            tfd.expirations = 1;
            tfd.value_sec = 0;
            tfd.value_nsec = 0;
        } else {
            // Repeating: compute number of intervals elapsed
            let elapsed_sec = now_sec - tfd.value_sec;
            let elapsed_nsec = now_nsec - tfd.value_nsec;
            let elapsed_total_ns = elapsed_sec * 1_000_000_000 + elapsed_nsec;
            let interval_ns = tfd.interval_sec * 1_000_000_000 + tfd.interval_nsec;
            if interval_ns > 0 {
                let count = (elapsed_total_ns / interval_ns) + 1;
                tfd.expirations += count as u64;
                // Advance value to next future expiration
                let advance_ns = count * interval_ns;
                let new_ns = (tfd.value_sec * 1_000_000_000 + tfd.value_nsec) + advance_ns;
                tfd.value_sec = new_ns / 1_000_000_000;
                tfd.value_nsec = new_ns % 1_000_000_000;
            } else {
                tfd.expirations = 1;
            }
        }
    }
}

/// signalfd4 — create or update a signal fd.
///
/// If fd == -1, create a new signalfd. Otherwise, update the mask of an existing one.
pub fn sys_signalfd4(proc: &mut Process, fd: i32, mask: u64, flags: u32) -> Result<i32, Errno> {
    use crate::ofd::FileType;
    use crate::process::SignalFdState;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    // SFD_CLOEXEC = O_CLOEXEC, SFD_NONBLOCK = O_NONBLOCK
    let cloexec = flags & O_CLOEXEC != 0;
    let nonblock = flags & O_NONBLOCK != 0;
    let valid_flags = O_CLOEXEC | O_NONBLOCK;
    if flags & !valid_flags != 0 {
        return Err(Errno::EINVAL);
    }

    if fd != -1 {
        // Update existing signalfd
        let entry = proc.fd_table.get(fd)?;
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::SignalFd {
            return Err(Errno::EINVAL);
        }
        let sfd_idx = (-(ofd.host_handle + 1)) as usize;
        let sfd = proc.signalfds.get_mut(sfd_idx)
            .and_then(|s| s.as_mut())
            .ok_or(Errno::EBADF)?;
        sfd.mask = mask;
        return Ok(fd);
    }

    // Create new signalfd
    let state = SignalFdState { mask };

    let sfd_idx = {
        let mut found = None;
        for (i, slot) in proc.signalfds.iter().enumerate() {
            if slot.is_none() { found = Some(i); break; }
        }
        match found {
            Some(i) => { proc.signalfds[i] = Some(state); i }
            None => { let i = proc.signalfds.len(); proc.signalfds.push(Some(state)); i }
        }
    };

    let handle = -((sfd_idx as i64) + 1);
    let mut status_flags = O_RDONLY;
    if nonblock { status_flags |= O_NONBLOCK; }
    let ofd_idx = proc.ofd_table.create(FileType::SignalFd, status_flags, handle, b"/dev/signalfd".to_vec());
    let fd_flags = if cloexec { FD_CLOEXEC } else { 0 };
    match proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags) {
        Ok(fd) => Ok(fd),
        Err(e) => {
            proc.ofd_table.dec_ref(ofd_idx);
            proc.signalfds[sfd_idx] = None;
            Err(e)
        }
    }
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
    // Zero out buffer (up to 6 fields for _GNU_SOURCE domainname)
    let fill_len = buf.len().min(390);
    for b in buf[..fill_len].iter_mut() {
        *b = 0;
    }
    let fields: [&[u8]; 6] = [
        b"wasm-posix",        // sysname
        b"localhost",         // nodename
        b"1.0.0",             // release
        b"wasm-posix-kernel", // version
        b"wasm32",            // machine
        b"",                  // domainname (empty)
    ];
    let num_fields = if buf.len() >= 390 { 6 } else { 5 };
    for (i, field) in fields[..num_fields].iter().enumerate() {
        let offset = i * 65;
        let len = field.len().min(64);
        buf[offset..offset + len].copy_from_slice(&field[..len]);
    }
    Ok(())
}

/// sysconf — get configurable system variables
pub fn sys_sysconf(name: i32) -> Result<i64, Errno> {
    match name {
        0 => Ok(4096),   // _SC_ARG_MAX
        1 => Ok(0),      // _SC_CHILD_MAX (unspecified)
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

    // Must be a regular file or memfd
    if ofd.file_type != FileType::Regular && ofd.file_type != FileType::MemFd {
        return Err(Errno::EINVAL);
    }

    // Must be writable (O_WRONLY or O_RDWR)
    let access = ofd.status_flags & O_ACCMODE;
    if access == O_RDONLY {
        return Err(Errno::EINVAL);
    }

    // MemFd: truncate in-memory buffer
    if ofd.file_type == FileType::MemFd {
        let memfd_idx = (-(ofd.host_handle + 1)) as usize;
        let data = proc.memfds.get_mut(memfd_idx)
            .and_then(|s| s.as_mut())
            .ok_or(Errno::EBADF)?;
        data.resize(length as usize, 0);
        return Ok(());
    }

    // RLIMIT_FSIZE: check if truncate target exceeds file size limit
    let fsize_limit = proc.rlimits[1][0]; // RLIMIT_FSIZE soft limit
    if fsize_limit != u64::MAX && (length as u64) > fsize_limit {
        proc.signals.raise(wasm_posix_shared::signal::SIGXFSZ);
        return Err(Errno::EFBIG);
    }

    host.host_ftruncate(ofd.host_handle, length)
}

/// fallocate -- ensure space is allocated for a file region.
/// Mode 0 only: extends the file to offset+len if currently shorter.
pub fn sys_fallocate(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    offset: i64,
    len: i64,
) -> Result<(), Errno> {
    if offset < 0 || len <= 0 {
        return Err(Errno::EINVAL);
    }
    let required = offset + len;

    // Get current file size via fstat
    let stat = sys_fstat(proc, host, fd)?;
    let current_size = stat.st_size as i64;

    // Only extend if needed — fallocate never shrinks
    if required > current_size {
        sys_ftruncate(proc, host, fd, required)?;
    }
    Ok(())
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

    match ofd.file_type {
        FileType::Regular | FileType::Directory => host.host_fchmod(ofd.host_handle, mode),
        // CharDevice / Pipe / Socket / PtyMaster / PtySlave / etc.: Linux
        // allows fchmod on these (e.g. on /dev/stderr or a unix-domain
        // socket fd — daemons like dinit do this routinely and abort on
        // EINVAL). The mode change has no observable effect for kernel-
        // synthesized devices, but accepting the call is what user-space
        // expects.
        _ => Ok(()),
    }
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

    match ofd.file_type {
        FileType::Regular | FileType::Directory => host.host_fchown(ofd.host_handle, uid, gid),
        // Match sys_fchmod above — accept the call on all fd types so
        // daemons that touch ownership during startup don't fail.
        _ => Ok(()),
    }
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
        match sys_write(proc, host, fd, buf) {
            Ok(n) => {
                total += n;
                if n < buf.len() {
                    break; // Short write, stop
                }
            }
            Err(e) => {
                if total > 0 { return Ok(total); }
                return Err(e);
            }
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
        match sys_read(proc, host, fd, *buf) {
            Ok(n) => {
                total += n;
                if n < buf.len() || n == 0 {
                    break; // Short read or EOF, stop
                }
            }
            Err(e) => {
                if total > 0 { return Ok(total); }
                return Err(e);
            }
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

    // RLIMIT_DATA (resource 2): enforce brk limit in memory manager.
    if resource == 2 {
        proc.memory.set_data_limit(soft);
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
    if match_virtual_device(&resolved).is_some() || match_dev_fd(&resolved).is_some()
        || crate::devfs::match_devfs_dir(&resolved).is_some() {
        return Ok(());
    }
    if synthetic_file_content(&resolved).is_some() {
        if amode & 0o2 != 0 { return Err(Errno::EACCES); }
        return Ok(());
    }
    if crate::procfs::match_procfs(&resolved, proc.pid).is_some() {
        if amode & 0o2 != 0 { return Err(Errno::EACCES); }
        return Ok(());
    }
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

    // Procfs symlinks — /proc/self, /proc/self/fd/N, /proc/self/cwd, etc.
    if let Some(entry) = crate::procfs::match_procfs(&resolved, proc.pid) {
        if entry.is_symlink() {
            return crate::procfs::procfs_readlink(proc, &entry, buf);
        }
        return Err(Errno::EINVAL);
    }

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

    // Inline readiness check — avoids Vec allocations that leak with the
    // bump allocator. We check each fd directly from the fd_sets.
    let mut ready = 0i32;

    // Save input fd_sets before clearing (we need to know which fds were requested)
    // Use a fixed-size buffer: nfds <= 1024, so max 128 bytes per set.
    let mut in_read_buf = [0u8; 128];
    let mut in_write_buf = [0u8; 128];
    let mut in_except_buf = [0u8; 128];
    let set_bytes = nfds.div_ceil(8);

    if let Some(ref s) = readfds {
        in_read_buf[..set_bytes].copy_from_slice(&s[..set_bytes]);
    }
    if let Some(ref s) = writefds {
        in_write_buf[..set_bytes].copy_from_slice(&s[..set_bytes]);
    }
    if let Some(ref s) = exceptfds {
        in_except_buf[..set_bytes].copy_from_slice(&s[..set_bytes]);
    }

    // Clear output fd_sets
    if let Some(ref mut s) = readfds { s[..set_bytes].fill(0); }
    if let Some(ref mut s) = writefds { s[..set_bytes].fill(0); }
    if let Some(ref mut s) = exceptfds { s[..set_bytes].fill(0); }

    for fd in 0..nfds {
        let byte = fd / 8;
        let bit = fd % 8;

        let want_read = (in_read_buf[byte] >> bit) & 1 != 0;
        let want_write = (in_write_buf[byte] >> bit) & 1 != 0;
        let want_except = (in_except_buf[byte] >> bit) & 1 != 0;

        if !want_read && !want_write && !want_except {
            continue;
        }
        let mut events: i16 = 0;
        if want_read { events |= POLLIN; }
        if want_write { events |= POLLOUT; }
        if want_except { events |= POLLPRI; }

        let mut pollfd = WasmPollFd { fd: fd as i32, events, revents: 0 };
        poll_check(proc, core::slice::from_mut(&mut pollfd));

        let revents = pollfd.revents;
        let mut counted = false;

        if want_read && (revents & (POLLIN | POLLHUP | POLLERR)) != 0 {
            if let Some(ref mut s) = readfds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if want_write && (revents & (POLLOUT | POLLERR)) != 0 {
            if let Some(ref mut s) = writefds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if want_except && (revents & POLLPRI) != 0 {
            if let Some(ref mut s) = exceptfds { s[byte] |= 1 << bit; }
            counted = true;
        }
        if counted { ready += 1; }
    }

    if ready > 0 || timeout_ms == 0 {
        return Ok(ready);
    }
    // nfds=0 with no interested FDs but non-zero timeout: on Linux this
    // blocks until a signal arrives (like sigsuspend). Fall through to
    // EAGAIN/blocking path rather than returning immediately.

    // Centralized mode: return EAGAIN so the host JS can retry asynchronously
    if crate::is_centralized_mode() {
        return Err(Errno::EAGAIN);
    }

    // Non-centralized mode: blocking poll loop
    let deadline_ns: Option<u64> = if timeout_ms > 0 {
        let (sec, nsec) = host.host_clock_gettime(1)?;
        let now = sec as u64 * 1_000_000_000 + nsec as u64;
        Some(now + (timeout_ms as u64) * 1_000_000)
    } else {
        None
    };

    loop {
        if proc.signals.deliverable() != 0 {
            if !proc.signals.should_restart() {
                return Err(Errno::EINTR);
            }
        }

        let _ = host.host_nanosleep(0, 1_000_000);

        // Re-check readiness
        ready = 0;
        if let Some(ref mut s) = readfds { s[..set_bytes].fill(0); }
        if let Some(ref mut s) = writefds { s[..set_bytes].fill(0); }
        if let Some(ref mut s) = exceptfds { s[..set_bytes].fill(0); }

        for fd in 0..nfds {
            let byte = fd / 8;
            let bit = fd % 8;
            let want_read = (in_read_buf[byte] >> bit) & 1 != 0;
            let want_write = (in_write_buf[byte] >> bit) & 1 != 0;
            let want_except = (in_except_buf[byte] >> bit) & 1 != 0;
            if !want_read && !want_write && !want_except { continue; }

            let mut pollfd = WasmPollFd { fd: fd as i32, events: 0, revents: 0 };
            if want_read { pollfd.events |= POLLIN; }
            if want_write { pollfd.events |= POLLOUT; }
            if want_except { pollfd.events |= POLLPRI; }
            poll_check(proc, core::slice::from_mut(&mut pollfd));

            let revents = pollfd.revents;
            let mut counted = false;
            if want_read && (revents & (POLLIN | POLLHUP | POLLERR)) != 0 {
                if let Some(ref mut s) = readfds { s[byte] |= 1 << bit; }
                counted = true;
            }
            if want_write && (revents & (POLLOUT | POLLERR)) != 0 {
                if let Some(ref mut s) = writefds { s[byte] |= 1 << bit; }
                counted = true;
            }
            if want_except && (revents & POLLPRI) != 0 {
                if let Some(ref mut s) = exceptfds { s[byte] |= 1 << bit; }
                counted = true;
            }
            if counted { ready += 1; }
        }

        if ready > 0 { return Ok(ready); }

        if let Some(dl) = deadline_ns {
            let (sec, nsec) = host.host_clock_gettime(1)?;
            let now = sec as u64 * 1_000_000_000 + nsec as u64;
            if now >= dl { return Ok(0); }
        }
    }
}

/// setuid -- set real and effective user ID.
///
/// POSIX semantics (no saved-set-user-ID tracked):
/// - If caller's euid is 0 (root), set both `uid` and `euid` to `uid`.
/// - Else if the target `uid` equals the caller's real `uid`, set `euid` only.
/// - Otherwise return EPERM.
pub fn sys_setuid(proc: &mut Process, uid: u32) -> Result<(), Errno> {
    if proc.euid == 0 {
        proc.uid = uid;
        proc.euid = uid;
        Ok(())
    } else if uid == proc.uid {
        proc.euid = uid;
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// setgid -- set real and effective group ID.
///
/// Mirrors setuid's privilege rules, gated on euid (the kernel doesn't track a
/// separate "appropriate privileges" capability).
pub fn sys_setgid(proc: &mut Process, gid: u32) -> Result<(), Errno> {
    if proc.euid == 0 {
        proc.gid = gid;
        proc.egid = gid;
        Ok(())
    } else if gid == proc.gid {
        proc.egid = gid;
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// seteuid -- set effective user ID.
///
/// Root may set euid to any value. Others may only reset euid to their real uid.
pub fn sys_seteuid(proc: &mut Process, euid: u32) -> Result<(), Errno> {
    if proc.euid == 0 || euid == proc.uid {
        proc.euid = euid;
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// setegid -- set effective group ID.
pub fn sys_setegid(proc: &mut Process, egid: u32) -> Result<(), Errno> {
    if proc.euid == 0 || egid == proc.gid {
        proc.egid = egid;
        Ok(())
    } else {
        Err(Errno::EPERM)
    }
}

/// POSIX permission test for `kill(pid, sig)`.
///
/// Returns true if a process with (sender_uid, sender_euid) may signal a
/// process with (target_uid, target_euid). Per POSIX: sender's real or
/// effective uid must match target's real or saved-set-uid. Since we don't
/// track saved-set-user-ID separately, the real uid stands in for it.
pub fn can_signal(sender_uid: u32, sender_euid: u32, target_uid: u32, target_euid: u32) -> bool {
    if sender_euid == 0 {
        return true;
    }
    sender_uid == target_uid
        || sender_uid == target_euid
        || sender_euid == target_uid
        || sender_euid == target_euid
}

/// POSIX permission test for `sched_getparam`/`sched_getscheduler` and their
/// setter variants.
///
/// POSIX (sched.h): the caller may query/modify a target's scheduling
/// parameters only when the caller's *effective* uid equals the target's
/// effective uid or the target's real uid — or when the caller is root.
/// Note this is stricter than `can_signal`: `seteuid(non_root)` drops
/// sched permission even if the real uid is still root.
pub fn can_query_sched(sender_euid: u32, target_uid: u32, target_euid: u32) -> bool {
    sender_euid == 0 || sender_euid == target_uid || sender_euid == target_euid
}

/// getrusage -- get resource usage (simulated).
///
/// Returns mostly zeroed rusage struct. Wasm runtimes don't expose
/// CPU/memory usage metrics, so we can't track actual resource usage. The struct is
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

/// getpriority -- get scheduling priority.
/// In Wasm there is no real scheduler, so we store a per-process nice value.
/// Returns 20-nice (Linux convention: kernel returns 20-nice so 0 is never error).
pub fn sys_getpriority(proc: &Process, which: i32, who: u32) -> Result<i32, Errno> {
    // PRIO_PROCESS=0, PRIO_PGRP=1, PRIO_USER=2
    if which < 0 || which > 2 {
        return Err(Errno::EINVAL);
    }
    // who=0 means "self" for PRIO_PROCESS
    if which == 0 && who != 0 && who != proc.pid {
        return Err(Errno::ESRCH);
    }
    // Linux convention: return 20-nice so the result is always positive
    Ok(20 - proc.nice)
}

/// setpriority -- set scheduling priority.
pub fn sys_setpriority(proc: &mut Process, which: i32, who: u32, prio: i32) -> Result<(), Errno> {
    if which < 0 || which > 2 {
        return Err(Errno::EINVAL);
    }
    if which == 0 && who != 0 && who != proc.pid {
        return Err(Errno::ESRCH);
    }
    // Clamp to [-20, 19]
    let clamped = prio.max(-20).min(19);
    proc.nice = clamped;
    Ok(())
}

/// realpath -- resolve a pathname to a canonical absolute form.
///
/// Resolves the path against cwd, normalizes `.` and `..` components,
/// and resolves symlinks by walking each path component with lstat/readlink.
/// Returns ELOOP after 40 symlink resolutions.
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

    const MAX_SYMLINKS: u32 = 40;
    let mut symlink_count: u32 = 0;

    // Make absolute and normalize
    let absolute = resolve_path(path, &proc.cwd);
    let normalized = normalize_path(&absolute);

    // Split into components and resolve each
    let mut resolved = Vec::new();
    resolved.push(b'/');

    // Collect components (skip empty from split)
    let components: Vec<&[u8]> = normalized[1..].split(|&b| b == b'/').filter(|c| !c.is_empty()).collect();

    let mut i = 0;
    let mut remaining_components: Vec<Vec<u8>> = components.iter().map(|c| c.to_vec()).collect();

    while i < remaining_components.len() {
        let component = remaining_components[i].clone();
        i += 1;

        // Build the candidate path: resolved + "/" + component
        let mut candidate = resolved.clone();
        if candidate.len() > 1 {
            candidate.push(b'/');
        }
        candidate.extend_from_slice(&component);

        // lstat to check if this component is a symlink
        match host.host_lstat(&candidate) {
            Ok(stat) => {
                // S_IFLNK = 0o120000 = 0xA000
                if (stat.st_mode & 0o170000) == 0o120000 {
                    // It's a symlink — resolve it
                    symlink_count += 1;
                    if symlink_count > MAX_SYMLINKS {
                        return Err(Errno::ELOOP);
                    }

                    let mut link_target = [0u8; 4096];
                    let link_len = host.host_readlink(&candidate, &mut link_target)?;
                    let target = &link_target[..link_len];

                    if target.is_empty() {
                        return Err(Errno::ENOENT);
                    }

                    // Collect remaining components after this one
                    let rest: Vec<Vec<u8>> = remaining_components[i..].to_vec();

                    if target[0] == b'/' {
                        // Absolute symlink: restart from root
                        resolved.clear();
                        resolved.push(b'/');
                        let target_norm = normalize_path(target);
                        let mut new_components: Vec<Vec<u8>> = target_norm[1..]
                            .split(|&b| b == b'/')
                            .filter(|c| !c.is_empty())
                            .map(|c| c.to_vec())
                            .collect();
                        new_components.extend(rest);
                        remaining_components = new_components;
                        i = 0;
                    } else {
                        // Relative symlink: resolve relative to current resolved dir
                        let mut new_components: Vec<Vec<u8>> = target
                            .split(|&b| b == b'/')
                            .filter(|c| !c.is_empty())
                            .map(|c| c.to_vec())
                            .collect();
                        new_components.extend(rest);
                        remaining_components = new_components;
                        i = 0;
                    }
                } else {
                    // Not a symlink — add to resolved path
                    if component == b".." {
                        // Go up one level
                        if let Some(pos) = resolved.iter().rposition(|&b| b == b'/') {
                            if pos == 0 {
                                resolved.truncate(1); // stay at root
                            } else {
                                resolved.truncate(pos);
                            }
                        }
                    } else if component != b"." {
                        if resolved.len() > 1 {
                            resolved.push(b'/');
                        }
                        resolved.extend_from_slice(&component);
                    }
                }
            }
            Err(e) => return Err(e),
        }
    }

    // Final existence check
    host.host_stat(&resolved)?;

    let len = resolved.len();
    if buf.len() < len {
        return Err(Errno::ERANGE);
    }
    buf[..len].copy_from_slice(&resolved);
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

/// sysinfo — return system information.
///
/// Fills a struct sysinfo buffer with plausible values.
/// On wasm32, unsigned long is 4 bytes. Layout:
///   uptime(4) loads[3](12) totalram(4) freeram(4) sharedram(4)
///   bufferram(4) totalswap(4) freeswap(4) procs(2) pad(2)
///   totalhigh(4) freehigh(4) mem_unit(4) __reserved(256)
///   Total: 312 bytes
pub fn sys_sysinfo(buf: &mut [u8]) -> Result<(), Errno> {
    const SYSINFO_SIZE: usize = 312;
    if buf.len() < SYSINFO_SIZE {
        return Err(Errno::EFAULT);
    }
    // Zero the buffer first
    for b in buf[..SYSINFO_SIZE].iter_mut() {
        *b = 0;
    }
    let total_ram: u32 = 512 * 1024 * 1024; // 512 MB
    let free_ram: u32 = 256 * 1024 * 1024;  // 256 MB

    // uptime = 1 second
    buf[0..4].copy_from_slice(&1u32.to_le_bytes());
    // loads[0..3] = 0 (already zeroed)
    // totalram @ offset 16
    buf[16..20].copy_from_slice(&total_ram.to_le_bytes());
    // freeram @ offset 20
    buf[20..24].copy_from_slice(&free_ram.to_le_bytes());
    // procs @ offset 40 (u16)
    buf[40..42].copy_from_slice(&1u16.to_le_bytes());
    // mem_unit @ offset 52
    buf[52..56].copy_from_slice(&1u32.to_le_bytes());
    Ok(())
}

/// memfd_create — create an anonymous file backed by in-memory storage.
///
/// Returns a file descriptor that supports read, write, lseek, ftruncate, fstat.
/// MFD_CLOEXEC (0x0001) sets close-on-exec on the fd.
pub fn sys_memfd_create(proc: &mut Process, name: &[u8], flags: u32) -> Result<i32, Errno> {
    use crate::ofd::FileType;
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;

    const MFD_CLOEXEC: u32 = 0x0001;
    const MFD_ALLOW_SEALING: u32 = 0x0002;
    const MFD_KNOWN_FLAGS: u32 = MFD_CLOEXEC | MFD_ALLOW_SEALING;

    if flags & !MFD_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL);
    }

    // Allocate a memfd slot
    let memfd_idx = proc.memfds.len();
    proc.memfds.push(Some(Vec::new()));

    // Create OFD with MemFd file type.
    // Use negative host_handle encoding: -(memfd_idx + 1)
    let host_handle = -((memfd_idx as i64) + 1);
    // Build path: "memfd:<name>"
    let mut path = alloc::vec![b'm', b'e', b'm', b'f', b'd', b':'];
    let name_len = name.len().min(249); // limit path length
    path.extend_from_slice(&name[..name_len]);

    let ofd_idx = proc.ofd_table.create(
        FileType::MemFd,
        O_RDWR,
        host_handle,
        path,
    );
    let cloexec = if flags & MFD_CLOEXEC != 0 { FD_CLOEXEC } else { 0 };
    let fd = proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_idx), cloexec)?;
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::ProcessState;
    use wasm_posix_shared::mode::{S_IFDIR, S_IFMT, S_IFREG, S_IFLNK};
    use wasm_posix_shared::poll::{POLLIN, POLLOUT};

    /// Mutex to serialize tests that access the global Unix socket registry.
    /// The registry uses UnsafeCell internally and is not thread-safe, so tests
    /// that call sys_bind/sys_connect for AF_UNIX must hold this lock.
    static UNIX_REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Mock host I/O for testing.
    struct MockHostIO {
        next_handle: i64,
        dir_entry_returned: bool,
        dir_entry_index: usize,     // current position in mock directory
        dir_entry_count: usize,     // total number of mock entries
        sigsuspend_signal: u32,
        sigsuspend_error: bool,
        clock_time: (i64, i64),
        /// Per-path owner overrides for host_stat / host_lstat. Mirrors how a real
        /// host-side VFS owns ownership; tests use `set_file_with_owner` to seed.
        file_owners: std::collections::HashMap<Vec<u8>, (u32, u32)>,
        /// Per-handle owner mapping captured at host_open time so host_fstat
        /// returns the same owners host_stat would for the path.
        handle_owners: std::collections::HashMap<i64, (u32, u32)>,
    }

    impl MockHostIO {
        fn new() -> Self {
            MockHostIO {
                next_handle: 100,
                dir_entry_returned: false,
                dir_entry_index: 0,
                dir_entry_count: 1,
                sigsuspend_signal: 0,
                sigsuspend_error: false,
                clock_time: (1234567890, 123456789),
                file_owners: std::collections::HashMap::new(),
                handle_owners: std::collections::HashMap::new(),
            }
        }

        /// Seed the mock VFS with a file at `path` whose stat() will report the
        /// given uid/gid. `_mode` and `_content` are accepted for parity with
        /// the host-side helper but the existing MockHostIO does not track
        /// per-file mode or content (host_stat infers mode from path shape).
        fn set_file_with_owner(&mut self, path: &[u8], uid: u32, gid: u32, _mode: u32, _content: &[u8]) {
            self.file_owners.insert(path.to_vec(), (uid, gid));
        }
    }

    impl HostIO for MockHostIO {
        fn host_open(&mut self, path: &[u8], _flags: u32, _mode: u32) -> Result<i64, Errno> {
            let handle = self.next_handle;
            self.next_handle += 1;
            // Capture path -> owner mapping so host_fstat(handle) returns the
            // same uid/gid host_stat(path) would.
            if let Some(&owner) = self.file_owners.get(path) {
                self.handle_owners.insert(handle, owner);
            }
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

        fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
            let (uid, gid) = self.handle_owners.get(&handle).copied().unwrap_or((0, 0));
            Ok(WasmStat {
                st_dev: 0,
                st_ino: 0,
                st_mode: S_IFREG | 0o644,
                st_nlink: 1,
                st_uid: uid,
                st_gid: gid,
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
            let (uid, gid) = self.file_owners.get(path).copied().unwrap_or((0, 0));
            Ok(WasmStat {
                st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                st_uid: uid, st_gid: gid, st_size: 1024,
                st_atime_sec: 0, st_atime_nsec: 0,
                st_mtime_sec: 0, st_mtime_nsec: 0,
                st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
            })
        }

        fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
            // Return S_IFLNK for paths containing "link" (for symlink tests),
            // otherwise return regular file/directory mode.
            let is_symlink = path.windows(4).any(|w| w == b"link");
            let is_dir = path.ends_with(b"/") || path == b"/";
            let mode = if is_symlink {
                S_IFLNK | 0o777
            } else if is_dir {
                S_IFDIR | 0o755
            } else {
                S_IFREG | 0o644
            };
            let (uid, gid) = self.file_owners.get(path).copied().unwrap_or((0, 0));
            Ok(WasmStat {
                st_dev: 0, st_ino: 2, st_mode: mode, st_nlink: 1,
                st_uid: uid, st_gid: gid, st_size: 1024,
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
        fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
            // Mirror the host VFS: chown updates owner state. A subsequent
            // host_stat(path) must return the new uid/gid. Tests rely on this
            // to verify sys_chown propagates through to the host VFS.
            self.file_owners.insert(path.to_vec(), (uid, gid));
            Ok(())
        }
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
            Ok(self.clock_time)
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

        fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno> {
            // Mirror the host VFS: fchown updates the owner state visible via
            // both host_fstat(handle) and host_stat(path) for the underlying
            // inode. The mock open() captures handle->path indirectly through
            // file_owners; without a reverse map we update the per-handle
            // overlay so host_fstat returns the new owner. Tests that also
            // care about host_stat(path) after fchown can use sys_chown.
            self.handle_owners.insert(handle, (uid, gid));
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

        fn host_set_posix_timer(&mut self, _timer_id: i32, _signo: i32, _value_ms: i64, _interval_ms: i64) -> Result<(), Errno> {
            Ok(())
        }

        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
            if self.sigsuspend_error {
                return Err(Errno::EINTR);
            }
            Ok(self.sigsuspend_signal)
        }

        fn host_call_signal_handler(&mut self, _handler_index: u32, _signum: u32, _sa_flags: u32) -> Result<(), Errno> {
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
        fn host_net_listen(&mut self, _fd: i32, _port: u16, _addr: &[u8; 4]) -> Result<(), Errno> {
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
        fn host_fork(&self) -> i32 {
            -(Errno::ENOSYS as i32)
        }
        fn host_futex_wait(&mut self, _addr: usize, _expected: u32, _timeout_ns: i64) -> Result<i32, Errno> {
            Err(Errno::EAGAIN)
        }
        fn host_futex_wake(&mut self, _addr: usize, _count: u32) -> Result<i32, Errno> {
            Ok(0)
        }
        fn host_clone(&mut self, _fn_ptr: usize, _arg: usize, _stack_ptr: usize, _tls_ptr: usize, _ctid_ptr: usize) -> Result<i32, Errno> {
            Err(Errno::ENOSYS)
        }
        fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize,
                            _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
        fn unbind_framebuffer(&mut self, _pid: i32) {}
        fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {}
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

    /// VFS is the source of truth for file ownership. sys_stat must propagate
    /// uid/gid from the host VFS, not overwrite with the caller's effective
    /// ids. proc.euid defaults to 0; with a host_stat returning (1000, 1000),
    /// any override would clobber back to 0 (or to proc.euid) and fail.
    #[test]
    fn test_sys_stat_returns_host_uid_gid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/foo", 1000, 1000, 0o644, b"hi");
        let st = sys_stat(&mut proc, &mut host, b"/foo").unwrap();
        assert_eq!(st.st_uid, 1000);
        assert_eq!(st.st_gid, 1000);
    }

    /// sys_lstat must also propagate honest uid/gid from the host VFS.
    #[test]
    fn test_sys_lstat_returns_host_uid_gid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/bar", 1001, 1002, 0o644, b"hi");
        let st = sys_lstat(&mut proc, &mut host, b"/bar").unwrap();
        assert_eq!(st.st_uid, 1001);
        assert_eq!(st.st_gid, 1002);
    }

    /// sys_fstat must propagate uid/gid from the host VFS for the underlying
    /// file (asymmetric uid/gid catches any single-field override).
    #[test]
    fn test_sys_fstat_returns_host_uid_gid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/qux", 1234, 5678, 0o644, b"hi");
        let fd = sys_open(&mut proc, &mut host, b"/qux", O_RDONLY, 0o644).unwrap();
        let st = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(st.st_uid, 1234);
        assert_eq!(st.st_gid, 5678);
    }

    /// sys_fstatat (and therefore sys_statx, which delegates) must propagate
    /// uid/gid from the host VFS.
    #[test]
    fn test_sys_fstatat_returns_host_uid_gid() {
        use wasm_posix_shared::flags::AT_FDCWD;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/baz", 4242, 4343, 0o644, b"hi");
        let st = sys_fstatat(&mut proc, &mut host, AT_FDCWD, b"/baz", 0).unwrap();
        assert_eq!(st.st_uid, 4242);
        assert_eq!(st.st_gid, 4343);
    }

    /// sys_chown must propagate uid/gid into the host VFS so that a subsequent
    /// sys_stat returns the freshly written values. The asymmetric (uid != gid,
    /// neither equal to proc.euid) pair catches any single-field clobber and
    /// any "kernel overrides chown args with caller's euid" regression.
    #[test]
    fn test_sys_chown_round_trip_through_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Seed the file with owner (0, 0) so the post-chown values are clearly
        // distinguishable from the initial state.
        host.set_file_with_owner(b"/foo", 0, 0, 0o644, b"hi");
        sys_chown(&mut proc, &mut host, b"/foo", 1000, 2000).unwrap();
        let st = sys_stat(&mut proc, &mut host, b"/foo").unwrap();
        assert_eq!(st.st_uid, 1000, "sys_chown uid did not reach host VFS");
        assert_eq!(st.st_gid, 2000, "sys_chown gid did not reach host VFS");
    }

    /// sys_fchown must propagate uid/gid into the host VFS via the open file
    /// handle so that a subsequent sys_fstat returns the new values.
    #[test]
    fn test_sys_fchown_round_trip_through_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/bar", 0, 0, 0o644, b"hi");
        let fd = sys_open(&mut proc, &mut host, b"/bar", O_RDONLY, 0o644).unwrap();
        sys_fchown(&mut proc, &mut host, fd, 3000, 4000).unwrap();
        let st = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(st.st_uid, 3000, "sys_fchown uid did not reach host VFS");
        assert_eq!(st.st_gid, 4000, "sys_fchown gid did not reach host VFS");
    }

    /// sys_fchownat with AT_FDCWD shares its propagation path with sys_chown
    /// (resolves path then calls host.host_chown). Round-trip via sys_stat to
    /// confirm the *at variant also reaches the host VFS — the syscall is
    /// dispatched separately by libc-test/util-linux chown -h paths.
    #[test]
    fn test_sys_fchownat_round_trip_through_host() {
        use wasm_posix_shared::flags::AT_FDCWD;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.set_file_with_owner(b"/baz", 0, 0, 0o644, b"hi");
        sys_fchownat(&mut proc, &mut host, AT_FDCWD, b"/baz", 5000, 6000, 0).unwrap();
        let st = sys_stat(&mut proc, &mut host, b"/baz").unwrap();
        assert_eq!(st.st_uid, 5000, "sys_fchownat uid did not reach host VFS");
        assert_eq!(st.st_gid, 6000, "sys_fchownat gid did not reach host VFS");
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
        // Linux convention: returned length includes the NUL terminator
        assert_eq!(&buf[..n], b"/\0");
    }

    #[test]
    fn test_chdir_changes_cwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_chdir(&mut proc, &mut host, b"/tmp").unwrap();
        let mut buf = [0u8; 256];
        let n = sys_getcwd(&proc, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/tmp\0");
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
        assert_eq!(&buf[..n], b"/tmp/subdir\0");
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

        // First two calls return synthesized "." and ".."
        let result = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(result, 1);
        assert_eq!(&name_buf[..1], b".");

        let result = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(result, 1);
        assert_eq!(&name_buf[..2], b"..");

        // Third call should return host entry
        let result = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(result, 1);
        assert_eq!(&name_buf[..8], b"test.txt");

        // Fourth call should return end-of-directory
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

        // Skip synth entries
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap(); // "."
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap(); // ".."

        // Read first host entry
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..8], b"test.txt");

        // Read second host entry
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..7], b"foo.txt");

        // End of directory
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 0);

        // Rewind
        sys_rewinddir(&mut proc, &mut host, dh).unwrap();

        // After rewind, should get "." again
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..1], b".");

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

        // Read first 5 entries (. .. test.txt foo.txt bar.txt)
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 5);

        // Seek to position 1 (should be "..")
        sys_seekdir(&mut proc, &mut host, dh, 1).unwrap();
        assert_eq!(sys_telldir(&proc, dh).unwrap(), 1);

        // Read should give entry at position 1 ("..")
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..2], b"..");

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
        assert_eq!(sys_getuid(&proc), 0);
    }

    #[test]
    fn test_geteuid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_geteuid(&proc), 0);
    }

    #[test]
    fn test_getgid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getgid(&proc), 0);
    }

    #[test]
    fn test_getegid_returns_default() {
        let proc = Process::new(1);
        assert_eq!(sys_getegid(&proc), 0);
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
        let old = sys_sigprocmask(&mut proc, 0, crate::signal::sig_bit(2)).unwrap(); // SIG_BLOCK SIGINT
        assert_eq!(old, 0);
        assert!(proc.signals.is_blocked(2));
    }

    #[test]
    fn test_sigprocmask_cannot_block_sigkill() {
        let mut proc = Process::new(1);
        sys_sigprocmask(&mut proc, 2, crate::signal::sig_bit(9) | crate::signal::sig_bit(2)).unwrap(); // SIG_SETMASK SIGKILL+SIGINT
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
    fn test_signal_delivery_after_unblock() {
        // Reproduce the sigreturn test flow:
        // 1. Register handler for SIGINT
        // 2. Block SIGINT
        // 3. Raise SIGINT (becomes pending but undeliverable)
        // 4. Unblock SIGINT
        // 5. Verify signal is dequeued and handler is found
        let mut proc = Process::new(1);
        const SIGINT: u32 = 2;

        // Step 1: Set handler for SIGINT (handler_val=42, function pointer)
        let result = sys_sigaction(&mut proc, SIGINT, 42, 0, 0);
        assert!(result.is_ok(), "sigaction failed: {:?}", result);

        // Verify handler is stored
        let handler = proc.signals.get_handler(SIGINT);
        assert!(matches!(handler, crate::signal::SignalHandler::Handler(42)),
            "Expected Handler(42), got {:?}", handler);

        // Step 2: Block all signals (SIG_BLOCK with mask=0x7FFFFFFF)
        let result = sys_sigprocmask(&mut proc, 0, 0x7FFFFFFF);
        assert!(result.is_ok());
        assert!(proc.signals.blocked & crate::signal::sig_bit(SIGINT) != 0, "SIGINT should be blocked");

        // Step 3: Raise SIGINT
        let mut host = MockHostIO::new();
        let result = sys_raise(&mut proc, &mut host, SIGINT);
        assert!(result.is_ok());
        assert!(proc.signals.is_pending(SIGINT), "SIGINT should be pending");

        // Verify dequeue returns None while blocked
        assert!(proc.signals.dequeue().is_none(), "Shouldn't dequeue blocked signal");
        // Signal still pending since dequeue failed
        assert!(proc.signals.is_pending(SIGINT), "SIGINT should still be pending");

        // Step 4: Unblock all (SIG_SETMASK with mask=0)
        let result = sys_sigprocmask(&mut proc, 2, 0);
        assert!(result.is_ok());
        assert!(proc.signals.blocked == 0, "No signals should be blocked");

        // Step 5: Now dequeue should work
        let sig = proc.signals.dequeue();
        assert_eq!(sig, Some((SIGINT, 0, 0)), "Should dequeue SIGINT");

        // And handler should be Handler(42)
        let handler = proc.signals.get_handler(SIGINT);
        assert!(matches!(handler, crate::signal::SignalHandler::Handler(42)),
            "Handler should still be Handler(42), got {:?}", handler);
    }

    #[test]
    fn test_fcntl_setlk_and_getlk() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();

        // Set a write lock on bytes 0-99
        let mut flock = WasmFlock {
            l_type: F_WRLCK as i16,
            l_whence: 0,
            _pad1: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad2: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        // F_GETLK should report no conflict (same pid)
        let mut query = WasmFlock {
            l_type: F_WRLCK as i16,
            l_whence: 0,
            _pad1: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad2: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_GETLK, &mut query, &mut host).unwrap();
        assert_eq!(query.l_type as u32, F_UNLCK); // No conflict with self
    }

    #[test]
    fn test_fcntl_unlock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();

        // Set then unlock
        let mut flock = WasmFlock {
            l_type: F_WRLCK as i16,
            l_whence: 0,
            _pad1: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad2: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut flock, &mut host).unwrap();

        let mut unlock = WasmFlock {
            l_type: F_UNLCK as i16,
            l_whence: 0,
            _pad1: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad2: 0,
        };
        sys_fcntl_lock(&mut proc, fd, F_SETLK, &mut unlock, &mut host).unwrap();
    }

    #[test]
    fn test_fcntl_rdlck_requires_read_access() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_WRONLY | O_CREAT, 0o644).unwrap();

        let mut flock = WasmFlock {
            l_type: F_RDLCK as i16,
            l_whence: 0,
            _pad1: 0,
            l_start: 0,
            l_len: 100,
            l_pid: 0,
            _pad2: 0,
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
            l_type: F_WRLCK as i16, l_whence: 0, _pad1: 0, l_start: 0, l_len: 100, l_pid: 0, _pad2: 0,
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
            l_type: F_WRLCK as i16, l_whence: 0, _pad1: 0, l_start: 0, l_len: 100, l_pid: 0, _pad2: 0,
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
        let mut host = MockHostIO::new();
        let addr = sys_mmap(&mut proc, &mut host, 0, 4096, 3, 0x22, -1, 0).unwrap(); // PROT_READ|WRITE, MAP_PRIVATE|ANON
        assert_ne!(addr, 0xFFFFFFFF);
    }

    #[test]
    fn test_mmap_file_backed_private() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Open a file to get a valid fd
        let fd = sys_open(&mut proc, &mut host, b"/tmp/mmaptest", 0x42, 0o644).unwrap(); // O_CREAT|O_RDWR
        // MAP_PRIVATE without MAP_ANONYMOUS should succeed (host populates data)
        let addr = sys_mmap(&mut proc, &mut host, 0, 4096, 3, 0x02, fd, 0).unwrap(); // PROT_READ|WRITE, MAP_PRIVATE
        assert_ne!(addr, 0xFFFFFFFF);
    }

    #[test]
    fn test_mmap_file_backed_bad_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // MAP_PRIVATE with invalid fd should fail
        let result = sys_mmap(&mut proc, &mut host, 0, 4096, 3, 0x02, 99, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_mmap_file_backed_shared() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Open a file to get a valid fd
        let fd = sys_open(&mut proc, &mut host, b"/tmp/mmaptest_shared", 0x42, 0o644).unwrap(); // O_CREAT|O_RDWR
        // MAP_SHARED should succeed (allocates region, host does population + tracking)
        let addr = sys_mmap(&mut proc, &mut host, 0, 4096, 3, 0x01, fd, 0).unwrap(); // PROT_READ|WRITE, MAP_SHARED
        assert_ne!(addr, 0xFFFFFFFF);
    }

    #[test]
    fn test_munmap() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let addr = sys_mmap(&mut proc, &mut host, 0, 4096, 3, 0x22, -1, 0).unwrap();
        sys_munmap(&mut proc, &mut host, addr, 0x10000).unwrap();
    }

    #[test]
    fn test_munmap_invalid_address_minus_one() {
        // munmap((void*)-1, 1) — address 0xFFFFFFFF is not page-aligned, should return EINVAL
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        assert_eq!(sys_munmap(&mut proc, &mut host, 0xFFFFFFFF, 1), Err(Errno::EINVAL));
    }

    #[test]
    fn test_munmap_address_overflow() {
        // Page-aligned address where addr+len overflows usize
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let addr = usize::MAX & !0xFFFF; // page-aligned near max
        assert_eq!(sys_munmap(&mut proc, &mut host, addr, 0x20000), Err(Errno::EINVAL));
    }

    #[test]
    fn test_munmap_unaligned_address() {
        // munmap with non-page-aligned address should return EINVAL
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        assert_eq!(sys_munmap(&mut proc, &mut host, 0x1000, 0x10000), Err(Errno::EINVAL));
    }

    #[test]
    fn test_munmap_zero_length() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        assert_eq!(sys_munmap(&mut proc, &mut host, 0x10000, 0), Err(Errno::EINVAL));
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
    fn test_socketpair_close_both_frees_pipes() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Get the pipe indices used by these sockets
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let ofd0 = proc.ofd_table.get(proc.fd_table.get(fd0).unwrap().ofd_ref.0).unwrap();
        let sock0_idx = (-(ofd0.host_handle + 1)) as usize;
        let send0 = proc.sockets.get(sock0_idx).unwrap().send_buf_idx.unwrap();
        let recv0 = proc.sockets.get(sock0_idx).unwrap().recv_buf_idx.unwrap();

        // Verify pipes exist before close
        assert!(pipe_table.get(send0).is_some());
        assert!(pipe_table.get(recv0).is_some());

        // Close both fds — pipe buffers should be freed
        sys_close(&mut proc, &mut host, fd0).unwrap();
        sys_close(&mut proc, &mut host, fd1).unwrap();

        // Verify the specific pipe slots are freed
        assert!(pipe_table.get(send0).is_none(), "send pipe should be freed after both sockets close");
        assert!(pipe_table.get(recv0).is_none(), "recv pipe should be freed after both sockets close");
    }

    #[test]
    fn test_socketpair_uses_global_pipes() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;

        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Both sockets should use global pipes (for cross-fork sharing)
        let ofd0 = proc.ofd_table.get(proc.fd_table.get(fd0).unwrap().ofd_ref.0).unwrap();
        let sock0_idx = (-(ofd0.host_handle + 1)) as usize;
        assert!(proc.sockets.get(sock0_idx).unwrap().global_pipes, "sock_a should use global pipes");

        let ofd1 = proc.ofd_table.get(proc.fd_table.get(fd1).unwrap().ofd_ref.0).unwrap();
        let sock1_idx = (-(ofd1.host_handle + 1)) as usize;
        assert!(proc.sockets.get(sock1_idx).unwrap().global_pipes, "sock_b should use global pipes");

        // Verify pipes exist in the global table
        let pipe_table = unsafe { crate::pipe::global_pipe_table() };
        let send0 = proc.sockets.get(sock0_idx).unwrap().send_buf_idx.unwrap();
        let recv0 = proc.sockets.get(sock0_idx).unwrap().recv_buf_idx.unwrap();
        assert!(pipe_table.get(send0).is_some(), "send pipe should be in global table");
        assert!(pipe_table.get(recv0).is_some(), "recv pipe should be in global table");

        sys_close(&mut proc, &mut host, fd0).unwrap();
        sys_close(&mut proc, &mut host, fd1).unwrap();
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
    fn test_getsockopt_tcp_info_established() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // Bind + listen + mark connected
        let mut addr = [0u8; 16];
        addr[0] = 2; // AF_INET
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        // tcp_info should work on bound socket
        let buf = sys_getsockopt_tcp_info(&proc, fd).unwrap();
        assert_eq!(buf[0], 7); // TCP_CLOSE (not connected/listening yet)
        assert_eq!(buf.len(), TCP_INFO_SIZE);
        // Check plausible MSS at offset 16 (u32 LE)
        let snd_mss = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]);
        assert_eq!(snd_mss, 1460);
    }

    #[test]
    fn test_getsockopt_tcp_info_listening() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let mut addr = [0u8; 16];
        addr[0] = 2;
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        sys_listen(&mut proc, &mut host, fd, 5).unwrap();
        let buf = sys_getsockopt_tcp_info(&proc, fd).unwrap();
        assert_eq!(buf[0], 10); // TCP_LISTEN
    }

    #[test]
    fn test_getsockopt_tcp_info_not_socket() {
        let proc = Process::new(1);
        let result = sys_getsockopt_tcp_info(&proc, 0);
        assert_eq!(result, Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_setsockopt_tcp_keepalive_options() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // Set and get TCP_KEEPIDLE
        sys_setsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPIDLE, 60).unwrap();
        let val = sys_getsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPIDLE).unwrap();
        assert_eq!(val, 60);
        // Set and get TCP_KEEPINTVL
        sys_setsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPINTVL, 10).unwrap();
        let val = sys_getsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPINTVL).unwrap();
        assert_eq!(val, 10);
        // Set and get TCP_KEEPCNT
        sys_setsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPCNT, 5).unwrap();
        let val = sys_getsockopt(&mut proc, fd, IPPROTO_TCP, TCP_KEEPCNT).unwrap();
        assert_eq!(val, 5);
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
    fn test_bind_inet_succeeds() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // sockaddr_in: family=AF_INET(2), port=8080 (BE), addr=0.0.0.0
        let mut addr = [0u8; 16];
        addr[0] = 2; // AF_INET
        addr[2] = 0x1F; addr[3] = 0x90; // port 8080 big-endian
        let result = sys_bind(&mut proc, &mut host, fd, &addr);
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn test_bind_enotsock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_bind(&mut proc, &mut host, 0, &[0u8; 16]);
        assert_eq!(result, Err(Errno::ENOTSOCK));
    }

    #[test]
    fn test_bind_unix_stream() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(9010);
        let mut host = MockHostIO::new();
        let path = b"/tmp/test_9010.sock";
        // Clean up any stale registration
        let resolved = crate::path::resolve_path(path, &proc.cwd);
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);

        let fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap(); // AF_UNIX, SOCK_STREAM
        // sockaddr_un: family(2) + path
        let mut addr = [0u8; 110];
        addr[0] = 1; // AF_UNIX
        addr[1] = 0;
        addr[2..2 + path.len()].copy_from_slice(path);
        sys_bind(&mut proc, &mut host, fd, &addr[..2 + path.len() + 1]).unwrap();
        // Socket should be in Bound state
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let sock = proc.sockets.get(sock_idx).unwrap();
        assert_eq!(sock.state, crate::socket::SocketState::Bound);
        assert!(sock.bind_path.is_some());

        // Clean up
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);
    }

    #[test]
    fn test_bind_unix_duplicate_fails() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(9011);
        let mut host = MockHostIO::new();
        let path = b"/tmp/dup_9011.sock";
        // Clean up any stale registration
        let resolved = crate::path::resolve_path(path, &proc.cwd);
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);

        let fd1 = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let fd2 = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1; // AF_UNIX
        addr[2..2 + path.len()].copy_from_slice(path);
        let addrlen = 2 + path.len() + 1;
        sys_bind(&mut proc, &mut host, fd1, &addr[..addrlen]).unwrap();
        let err = sys_bind(&mut proc, &mut host, fd2, &addr[..addrlen]).unwrap_err();
        assert_eq!(err, Errno::EADDRINUSE);

        // Clean up
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);
    }

    #[test]
    fn test_listen_after_bind_succeeds() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // Must bind before listen
        let mut addr = [0u8; 16];
        addr[0] = 2;
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        let result = sys_listen(&mut proc, &mut host, fd, 5);
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn test_accept_eagain_on_empty_backlog() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let mut addr = [0u8; 16];
        addr[0] = 2;
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        sys_listen(&mut proc, &mut host, fd, 5).unwrap();
        let result = sys_accept(&mut proc, &mut host, fd);
        assert_eq!(result, Err(Errno::EAGAIN));
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
    fn test_poll_negative_fd_ignored() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::poll::*;
        let mut pollfd = WasmPollFd { fd: -1, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 0);
        assert_eq!(pollfd.revents, 0);
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
    fn test_pread_einval_on_negative_offset() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/f", O_RDWR | O_CREAT, 0o644).unwrap();
        let mut buf = [0u8; 4];
        assert_eq!(sys_pread(&mut proc, &mut host, fd, &mut buf, -1), Err(Errno::EINVAL));
        assert_eq!(sys_pread(&mut proc, &mut host, fd, &mut buf, i64::MIN), Err(Errno::EINVAL));
    }

    #[test]
    fn test_pwrite_einval_on_negative_offset() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/f", O_RDWR | O_CREAT, 0o644).unwrap();
        assert_eq!(sys_pwrite(&mut proc, &mut host, fd, b"x", -1), Err(Errno::EINVAL));
        assert_eq!(sys_pwrite(&mut proc, &mut host, fd, b"x", i64::MIN), Err(Errno::EINVAL));
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

    // ---- MSG_OOB / SIOCATMARK tests ----

    #[test]
    fn test_send_recv_msg_oob() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;

        let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // No OOB pending: SIOCATMARK returns 0
        let mut iobuf = [0u8; 4];
        sys_ioctl(&mut proc, fd1, 0x8905, &mut iobuf).unwrap();
        assert_eq!(i32::from_le_bytes(iobuf), 0);

        // Send OOB byte from fd0
        let n = sys_send(&mut proc, &mut host, fd0, b"X", MSG_OOB).unwrap();
        assert_eq!(n, 1);

        // SIOCATMARK on fd1 returns 1
        let mut iobuf = [0u8; 4];
        sys_ioctl(&mut proc, fd1, 0x8905, &mut iobuf).unwrap();
        assert_eq!(i32::from_le_bytes(iobuf), 1);

        // Recv OOB byte from fd1
        let mut buf = [0u8; 1];
        let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, MSG_OOB).unwrap();
        assert_eq!(n, 1);
        assert_eq!(buf[0], b'X');

        // After reading OOB, SIOCATMARK returns 0
        let mut iobuf = [0u8; 4];
        sys_ioctl(&mut proc, fd1, 0x8905, &mut iobuf).unwrap();
        assert_eq!(i32::from_le_bytes(iobuf), 0);
    }

    #[test]
    fn test_recv_msg_oob_no_data() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;

        let (_fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

        // Recv OOB with no OOB pending returns EINVAL
        let mut buf = [0u8; 1];
        let err = sys_recv(&mut proc, &mut host, fd1, &mut buf, MSG_OOB).unwrap_err();
        assert_eq!(err, Errno::EINVAL);
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
    fn test_fchmod_pipe_accepted() {
        // Linux accepts fchmod on non-regular fds (pipes, sockets, devices)
        // even though the mode change has no observable effect. dinit and
        // other daemons rely on this — pre-relaxation EINVAL aborted them
        // mid-startup.
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let result = sys_fchmod(&mut proc, &mut host, r, 0o755);
        assert_eq!(result, Ok(()));
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
    fn test_getpgid_self() {
        let proc = Process::new(1);
        assert_eq!(sys_getpgid(&proc, 0), Ok(1)); // pid=0 means current process
        assert_eq!(sys_getpgid(&proc, 1), Ok(1)); // pid=self works too
    }

    #[test]
    fn test_getpgid_other_esrch() {
        let proc = Process::new(1);
        assert_eq!(sys_getpgid(&proc, 999), Err(Errno::ESRCH));
    }

    #[test]
    fn test_setpgid_self() {
        let mut proc = Process::new(2);
        proc.sid = 1; // Not a session leader (child of pid 1)
        let result = sys_setpgid(&mut proc, 0, 42); // pid=0 means self
        assert!(result.is_ok());
        assert_eq!(proc.pgid, 42);
    }

    #[test]
    fn test_setpgid_zero_pgid() {
        let mut proc = Process::new(2);
        proc.sid = 1; // Not a session leader
        let result = sys_setpgid(&mut proc, 0, 0); // pgid=0 means use pid
        assert!(result.is_ok());
        assert_eq!(proc.pgid, 2); // pgid set to pid
    }

    #[test]
    fn test_setpgid_session_leader_eperm() {
        let mut proc = Process::new(1);
        // Make it a session leader by calling setsid
        let _ = sys_setsid(&mut proc);
        assert_eq!(proc.sid, proc.pid); // now a session leader
        let result = sys_setpgid(&mut proc, 0, 42);
        assert_eq!(result, Err(Errno::EPERM));
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
        assert_eq!(sys_getsid(&proc, 0), Ok(0)); // initial process has sid=0 (not a session leader)
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
        // First call setsid to become a session leader
        let result = sys_setsid(&mut proc);
        assert_eq!(result, Ok(1));
        assert_eq!(proc.sid, 1);
        // Second call should fail — already a session leader
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
    fn test_setuid_as_root_sets_both() {
        let mut proc = Process::new(1);
        assert_eq!(proc.uid, 0);
        sys_setuid(&mut proc, 42).unwrap();
        assert_eq!(proc.uid, 42);
        assert_eq!(proc.euid, 42);
    }

    #[test]
    fn test_setuid_nonroot_to_own_uid_sets_euid_only() {
        let mut proc = Process::new(1);
        sys_setuid(&mut proc, 7).unwrap(); // drop to uid=euid=7
        // Simulate regaining privilege partly: impossible without saved-set,
        // but setting euid back to real uid is always allowed.
        sys_seteuid(&mut proc, 7).unwrap();
        assert_eq!(proc.euid, 7);
    }

    #[test]
    fn test_setuid_nonroot_to_other_uid_fails() {
        let mut proc = Process::new(1);
        sys_setuid(&mut proc, 7).unwrap();
        assert_eq!(sys_setuid(&mut proc, 99), Err(Errno::EPERM));
        assert_eq!(proc.uid, 7);
        assert_eq!(proc.euid, 7);
    }

    #[test]
    fn test_setgid_as_root_sets_both() {
        let mut proc = Process::new(1);
        sys_setgid(&mut proc, 42).unwrap();
        assert_eq!(proc.gid, 42);
        assert_eq!(proc.egid, 42);
    }

    #[test]
    fn test_setgid_nonroot_to_other_gid_fails() {
        let mut proc = Process::new(1);
        sys_setuid(&mut proc, 7).unwrap(); // drop privilege
        assert_eq!(sys_setgid(&mut proc, 99), Err(Errno::EPERM));
    }

    #[test]
    fn test_seteuid_as_root_allows_any() {
        let mut proc = Process::new(1);
        sys_seteuid(&mut proc, 500).unwrap();
        assert_eq!(proc.uid, 0); // real uid unchanged
        assert_eq!(proc.euid, 500);
    }

    #[test]
    fn test_seteuid_nonroot_back_to_ruid() {
        let mut proc = Process::new(1);
        sys_setuid(&mut proc, 7).unwrap();
        sys_seteuid(&mut proc, 7).unwrap();
        assert_eq!(proc.euid, 7);
    }

    #[test]
    fn test_seteuid_nonroot_to_other_fails() {
        let mut proc = Process::new(1);
        sys_setuid(&mut proc, 7).unwrap();
        assert_eq!(sys_seteuid(&mut proc, 99), Err(Errno::EPERM));
    }

    #[test]
    fn test_setegid_as_root_allows_any() {
        let mut proc = Process::new(1);
        sys_setegid(&mut proc, 500).unwrap();
        assert_eq!(proc.gid, 0);
        assert_eq!(proc.egid, 500);
    }

    #[test]
    fn test_can_signal_root_to_anyone() {
        assert!(can_signal(0, 0, 1, 1));
        assert!(can_signal(0, 0, 42, 99));
    }

    #[test]
    fn test_can_signal_same_user() {
        assert!(can_signal(7, 7, 7, 7));
    }

    #[test]
    fn test_can_signal_matches_real_or_effective() {
        // sender.euid matches target.ruid
        assert!(can_signal(99, 7, 7, 0));
        // sender.ruid matches target.euid
        assert!(can_signal(7, 99, 0, 7));
    }

    #[test]
    fn test_can_signal_denies_cross_user() {
        assert!(!can_signal(7, 7, 0, 0));
        assert!(!can_signal(1, 1, 2, 2));
    }

    #[test]
    fn test_can_query_sched_root_allowed() {
        assert!(can_query_sched(0, 1, 1));
    }

    #[test]
    fn test_can_query_sched_euid_match() {
        assert!(can_query_sched(7, 7, 7));
        assert!(can_query_sched(7, 7, 99));
        assert!(can_query_sched(7, 99, 7));
    }

    #[test]
    fn test_can_query_sched_denies_when_only_ruid_matches() {
        // seteuid-only drop: sender ruid still matches target but euid does
        // not — POSIX sched_* still denies.
        assert!(!can_query_sched(1000, 0, 0));
        assert!(!can_query_sched(99, 7, 7));
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
    fn test_fork_returns_enosys_with_mock() {
        let mut proc = Process::new(1);
        let host = MockHostIO::new();
        let result = sys_fork(&mut proc, &host);
        assert_eq!(result, Err(Errno::ENOSYS));
    }

    #[test]
    fn test_fork_child_fields_default_to_false() {
        let proc = Process::new(1);
        assert!(!proc.fork_child);
        assert!(proc.fork_exec_path.is_none());
        assert!(proc.fork_exec_argv.is_none());
        assert!(proc.fork_fd_actions.is_empty());
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
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct BindFbCall {
        pid: i32,
        addr: usize,
        len: usize,
        w: u32,
        h: u32,
        stride: u32,
        fmt: u32,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FbWriteCall {
        pid: i32,
        offset: usize,
        len: usize,
    }

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
        bind_framebuffer_calls: Vec<BindFbCall>,
        unbind_framebuffer_calls: Vec<i32>,
        fb_write_calls: Vec<FbWriteCall>,
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
                bind_framebuffer_calls: Vec::new(),
                unbind_framebuffer_calls: Vec::new(),
                fb_write_calls: Vec::new(),
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
            // Return regular file/dir by default (not symlink) so realpath works
            let is_dir = path.ends_with(b"dir") || path.ends_with(b"tmp")
                || path.ends_with(b"/") || path == b"/";
            let mode = if is_dir { S_IFDIR | 0o755 } else { S_IFREG | 0o644 };
            Ok(WasmStat {
                st_dev: 0, st_ino: 2, st_mode: mode, st_nlink: 1,
                st_uid: 0, st_gid: 0, st_size: 1024,
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
        fn host_set_posix_timer(&mut self, _timer_id: i32, _signo: i32, _value_ms: i64, _interval_ms: i64) -> Result<(), Errno> { Ok(()) }
        fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
        fn host_call_signal_handler(&mut self, _handler_index: u32, _signum: u32, _sa_flags: u32) -> Result<(), Errno> { Ok(()) }
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
        fn host_net_listen(&mut self, _fd: i32, _port: u16, _addr: &[u8; 4]) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOENT)
        }
        fn host_fcntl_lock(&mut self, _path: &[u8], _pid: u32, _cmd: u32, _lock_type: u32, _start: i64, _len: i64, _result_buf: &mut [u8]) -> Result<(), Errno> {
            Ok(())
        }
        fn host_fork(&self) -> i32 {
            -(Errno::ENOSYS as i32)
        }
        fn host_futex_wait(&mut self, _addr: usize, _expected: u32, _timeout_ns: i64) -> Result<i32, Errno> {
            Err(Errno::EAGAIN)
        }
        fn host_futex_wake(&mut self, _addr: usize, _count: u32) -> Result<i32, Errno> {
            Ok(0)
        }
        fn host_clone(&mut self, _fn_ptr: usize, _arg: usize, _stack_ptr: usize, _tls_ptr: usize, _ctid_ptr: usize) -> Result<i32, Errno> {
            Err(Errno::ENOSYS)
        }
        fn bind_framebuffer(&mut self, pid: i32, addr: usize, len: usize,
                            w: u32, h: u32, stride: u32, fmt: u32) {
            self.bind_framebuffer_calls.push(BindFbCall { pid, addr, len, w, h, stride, fmt });
        }
        fn unbind_framebuffer(&mut self, pid: i32) {
            self.unbind_framebuffer_calls.push(pid);
        }
        fn fb_write(&mut self, pid: i32, offset: usize, bytes: &[u8]) {
            self.fb_write_calls.push(FbWriteCall {
                pid,
                offset,
                len: bytes.len(),
            });
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
        // AF_UNIX SOCK_STREAM connect to nonexistent path should fail with ECONNREFUSED
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1; // AF_UNIX
        let path = b"/tmp/noexist.sock";
        addr[2..2 + path.len()].copy_from_slice(path);
        let addrlen = 2 + path.len() + 1;
        let err = sys_connect(&mut proc, &mut host, fd, &addr[..addrlen]).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_unix_dgram_connect_succeeds_as_bit_bucket() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_DGRAM, 0).unwrap();
        let addr = [1, 0]; // AF_UNIX family
        sys_connect(&mut proc, &mut host, fd, &addr).unwrap();
        // Write should succeed and discard data
        let n = sys_write(&mut proc, &mut host, fd, b"hello syslog").unwrap();
        assert_eq!(n, 12);
    }

    #[test]
    fn test_unix_stream_connect_same_process() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(9001);
        let mut host = MockHostIO::new();
        let path = b"/tmp/connect_9001.sock";
        // Clean up any stale registration from a prior test run
        let resolved = crate::path::resolve_path(path, &proc.cwd);
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);

        // Create and bind a listener
        let server_fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap(); // AF_UNIX, SOCK_STREAM
        let mut addr = [0u8; 110];
        addr[0] = 1; // AF_UNIX
        addr[2..2 + path.len()].copy_from_slice(path);
        let addrlen = 2 + path.len() + 1;
        sys_bind(&mut proc, &mut host, server_fd, &addr[..addrlen]).unwrap();
        sys_listen(&mut proc, &mut host, server_fd, 5).unwrap();

        // Connect a client
        let client_fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        sys_connect(&mut proc, &mut host, client_fd, &addr[..addrlen]).unwrap();

        // Client should be connected
        let entry = proc.fd_table.get(client_fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        let sock_idx = (-(ofd.host_handle + 1)) as usize;
        let sock = proc.sockets.get(sock_idx).unwrap();
        assert_eq!(sock.state, crate::socket::SocketState::Connected);

        // Server should have a pending connection
        let accepted_fd = sys_accept(&mut proc, &mut host, server_fd).unwrap();
        assert!(accepted_fd >= 0);

        // Clean up
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);
    }

    #[test]
    fn test_unix_stream_connect_no_listener() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(9002);
        let mut host = MockHostIO::new();
        let client_fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1; // AF_UNIX
        let path = b"/tmp/noexist_9002.sock";
        addr[2..2 + path.len()].copy_from_slice(path);
        let addrlen = 2 + path.len() + 1;
        let err = sys_connect(&mut proc, &mut host, client_fd, &addr[..addrlen]).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_unix_stream_bidirectional_data() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(9003);
        let mut host = MockHostIO::new();
        let path = b"/tmp/bidir_9003.sock";
        // Clean up any stale registration from a prior test run
        let resolved = crate::path::resolve_path(path, &proc.cwd);
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);

        // Set up listener
        let server_fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1;
        addr[2..2 + path.len()].copy_from_slice(path);
        let addrlen = 2 + path.len() + 1;
        sys_bind(&mut proc, &mut host, server_fd, &addr[..addrlen]).unwrap();
        sys_listen(&mut proc, &mut host, server_fd, 5).unwrap();

        // Connect client
        let client_fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        sys_connect(&mut proc, &mut host, client_fd, &addr[..addrlen]).unwrap();
        let accepted_fd = sys_accept(&mut proc, &mut host, server_fd).unwrap();

        // Client sends, server receives
        let msg = b"hello from client";
        let sent = sys_send(&mut proc, &mut host, client_fd, msg, 0).unwrap();
        assert_eq!(sent, msg.len());
        let mut buf = [0u8; 64];
        let recvd = sys_recv(&mut proc, &mut host, accepted_fd, &mut buf, 0).unwrap();
        assert_eq!(&buf[..recvd], msg);

        // Server sends, client receives
        let reply = b"hello from server";
        let sent = sys_send(&mut proc, &mut host, accepted_fd, reply, 0).unwrap();
        assert_eq!(sent, reply.len());
        let recvd = sys_recv(&mut proc, &mut host, client_fd, &mut buf, 0).unwrap();
        assert_eq!(&buf[..recvd], reply);

        // Clean up
        unsafe { crate::unix_socket::global_unix_socket_registry() }.unregister(&resolved);
    }

    #[test]
    fn test_stat_unix_socket_path() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.pid = 9020;
        let fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1;
        let path = b"/tmp/stat.sock";
        addr[2..2 + path.len()].copy_from_slice(path);
        sys_bind(&mut proc, &mut host, fd, &addr[..2 + path.len() + 1]).unwrap();

        let st = sys_stat(&mut proc, &mut host, b"/tmp/stat.sock").unwrap();
        assert_eq!(st.st_mode & wasm_posix_shared::mode::S_IFMT, wasm_posix_shared::mode::S_IFSOCK);

        // Cleanup
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.cleanup_process(9020);
    }

    #[test]
    fn test_unlink_unix_socket_path() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.pid = 9021;
        let fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1;
        let path = b"/tmp/unlink.sock";
        addr[2..2 + path.len()].copy_from_slice(path);
        sys_bind(&mut proc, &mut host, fd, &addr[..2 + path.len() + 1]).unwrap();

        // Socket path should exist
        assert!(sys_stat(&mut proc, &mut host, b"/tmp/unlink.sock").is_ok());

        // Unlink removes the path from registry
        sys_unlink(&mut proc, &mut host, b"/tmp/unlink.sock").unwrap();

        // Another socket can now bind to the same path
        let fd2 = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        sys_bind(&mut proc, &mut host, fd2, &addr[..2 + path.len() + 1]).unwrap();

        // Cleanup
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.cleanup_process(9021);
    }

    #[test]
    fn test_fstat_socket_fd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let st = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(st.st_mode & wasm_posix_shared::mode::S_IFMT, wasm_posix_shared::mode::S_IFSOCK);
    }

    #[test]
    fn test_getsockname_unix_with_path() {
        let _lock = UNIX_REGISTRY_LOCK.lock().unwrap();
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        proc.pid = 9022;
        let fd = sys_socket(&mut proc, &mut host, 1, 1, 0).unwrap();
        let mut addr = [0u8; 110];
        addr[0] = 1;
        let path = b"/tmp/getsockname.sock";
        addr[2..2 + path.len()].copy_from_slice(path);
        sys_bind(&mut proc, &mut host, fd, &addr[..2 + path.len() + 1]).unwrap();

        let mut buf = [0u8; 128];
        let n = sys_getsockname(&proc, fd, &mut buf).unwrap();
        assert_eq!(buf[0], 1); // AF_UNIX
        assert!(n >= 2 + path.len());
        assert_eq!(&buf[2..2 + path.len()], path);

        // Cleanup
        let registry = unsafe { crate::unix_socket::global_unix_socket_registry() };
        registry.cleanup_process(9022);
    }

    #[test]
    fn test_clock_getres_per_process_cpu_clock() {
        let proc = Process::new(1);
        // clock_getcpuclockid(pid) encodes as (-pid-1)*8 + 2
        // For pid=1: (-1-1)*8 + 2 = -16 + 2 = -14, as u32 = 4294967282
        let clock_id = ((-1i32 - 1) * 8 + 2) as u32;
        let res = sys_clock_getres(&proc, clock_id).unwrap();
        assert_eq!(res.tv_sec, 0);
        assert_eq!(res.tv_nsec, 1_000_000);
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
            fn host_set_posix_timer(&mut self, _t: i32, _s: i32, _v: i64, _i: i64) -> Result<(), Errno> { Ok(()) }
            fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
            fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> { Ok(()) }
            fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0x42; } Ok(b.len()) }
            fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
            fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
            fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
            fn host_net_send(&mut self, _h: i32, data: &[u8], _f: u32) -> Result<usize, Errno> { Ok(data.len()) }
            fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
            fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> { Ok(()) }
            fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Err(Errno::ENOENT) }
            fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _cmd: u32, _lt: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
            fn host_fork(&self) -> i32 { -(Errno::ENOSYS as i32) }
            fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> { Err(Errno::EAGAIN) }
            fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> { Ok(0) }
            fn host_clone(&mut self, _f: usize, _a: usize, _s: usize, _t: usize, _c: usize) -> Result<i32, Errno> { Err(Errno::ENOSYS) }
            fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize, _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
            fn unbind_framebuffer(&mut self, _pid: i32) {}
            fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {}
        }

        let mut proc = Process::new(1);
        let mut host = NetMock;
        use wasm_posix_shared::socket::*;

        // Create socket
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();

        // Connect to a non-loopback address to test host delegation
        let addr = [2, 0, 0, 80, 93, 184, 216, 34, 0, 0, 0, 0, 0, 0, 0, 0];
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
        proc.signals.pending |= crate::signal::sig_bit(10);
        // Wait for SIGUSR1
        let mask = crate::signal::sig_bit(10);
        let (sig, _val, _code) = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(sig, 10);
        // Signal should be dequeued
        assert_eq!(proc.signals.pending & crate::signal::sig_bit(10), 0);
    }

    #[test]
    fn test_sigtimedwait_no_pending_timeout_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mask = crate::signal::sig_bit(10);
        let result = sys_sigtimedwait(&mut proc, &mut host, mask, 0);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_sigtimedwait_dequeues_lowest() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Raise both SIGUSR1 (10) and SIGUSR2 (12)
        proc.signals.pending |= crate::signal::sig_bit(10) | crate::signal::sig_bit(12);
        let mask = crate::signal::sig_bit(10) | crate::signal::sig_bit(12);
        let (sig, _val, _code) = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(sig, 10); // lowest first
        // Only SIGUSR1 should be dequeued
        assert_eq!(proc.signals.pending & crate::signal::sig_bit(10), 0);
        assert_ne!(proc.signals.pending & crate::signal::sig_bit(12), 0);
    }

    #[test]
    fn test_sigtimedwait_rt_queued_multiple() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Queue SIGRTMIN (32) three times
        proc.signals.raise(32);
        proc.signals.raise(32);
        proc.signals.raise(32);
        let mask = crate::signal::sig_bit(32);
        // First dequeue should return signal 32 and leave 2 queued
        let (s1, _, _) = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(s1, 32);
        assert!(proc.signals.is_pending(32), "should still be pending with 2 queued");
        // Second
        let (s2, _, _) = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(s2, 32);
        assert!(proc.signals.is_pending(32), "should still be pending with 1 queued");
        // Third
        let (s3, _, _) = sys_sigtimedwait(&mut proc, &mut host, mask, 0).unwrap();
        assert_eq!(s3, 32);
        assert!(!proc.signals.is_pending(32), "should no longer be pending");
        // Fourth should fail
        let r4 = sys_sigtimedwait(&mut proc, &mut host, mask, 0);
        assert_eq!(r4, Err(Errno::EAGAIN));
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

    // ---- virtual device tests ----

    #[test]
    fn test_stat_dev_null() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let st = sys_stat(&mut proc, &mut host, b"/dev/null").unwrap();
        assert_eq!(st.st_mode & 0xF000, wasm_posix_shared::mode::S_IFCHR);
        assert_eq!(st.st_mode & 0o777, 0o666);
        assert_eq!(st.st_ino, 1);
        assert_eq!(st.st_dev, 5);
    }

    #[test]
    fn test_fstat_dev_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/zero", O_RDONLY, 0).unwrap();
        let st = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(st.st_mode & 0xF000, wasm_posix_shared::mode::S_IFCHR);
        assert_eq!(st.st_ino, 2);
    }

    #[test]
    fn test_lseek_dev_null() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/null", O_RDWR, 0).unwrap();
        let pos = sys_lseek(&mut proc, &mut host, fd, 100, 0).unwrap();
        assert_eq!(pos, 0);
    }

    #[test]
    fn test_access_dev_urandom() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        sys_access(&mut proc, &mut host, b"/dev/urandom", 4).unwrap();
    }

    #[test]
    fn test_close_dev_null() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/null", O_RDWR, 0).unwrap();
        sys_close(&mut proc, &mut host, fd).unwrap();
        assert!(proc.fd_table.get(fd).is_err());
    }

    #[test]
    fn test_stat_dev_fd_path() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let st = sys_stat(&mut proc, &mut host, b"/dev/fd/0").unwrap();
        assert_eq!(st.st_mode & 0xF000, wasm_posix_shared::mode::S_IFCHR);
    }

    #[test]
    fn test_read_dev_null_eof() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/null", O_RDONLY, 0).unwrap();
        let mut buf = [0u8; 64];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_write_dev_null_discards() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/null", O_WRONLY, 0).unwrap();
        let n = sys_write(&mut proc, &mut host, fd, b"hello world").unwrap();
        assert_eq!(n, 11);
    }

    #[test]
    fn test_dev_console_aliases_dev_null() {
        // /dev/console is an alias for /dev/null: write-discard, read-EOF.
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/console", O_RDWR, 0).unwrap();
        let n = sys_write(&mut proc, &mut host, fd, b"console msg").unwrap();
        assert_eq!(n, 11);
        let mut buf = [0u8; 64];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_read_dev_zero_fills() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/zero", O_RDONLY, 0).unwrap();
        let mut buf = [0xFFu8; 32];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 32);
        assert!(buf.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_read_dev_urandom_returns_bytes() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/urandom", O_RDONLY, 0).unwrap();
        let mut buf = [0xFFu8; 32];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 32);
        // MockHostIO.host_getrandom fills with (i & 0xFF) pattern
        assert_eq!(buf[0], 0);
        assert_eq!(buf[1], 1);
        assert_eq!(buf[31], 31);
    }

    #[test]
    fn test_read_dev_full_fills_zeros() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/full", O_RDONLY, 0).unwrap();
        let mut buf = [0xFFu8; 16];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 16);
        assert!(buf.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_write_dev_full_enospc() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/full", O_WRONLY, 0).unwrap();
        let result = sys_write(&mut proc, &mut host, fd, b"data");
        assert_eq!(result, Err(Errno::ENOSPC));
    }

    #[test]
    fn test_write_dev_zero_discards() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/zero", O_WRONLY, 0).unwrap();
        let n = sys_write(&mut proc, &mut host, fd, b"data").unwrap();
        assert_eq!(n, 4);
    }

    #[test]
    fn test_open_dev_null() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/null", O_RDWR, 0).unwrap();
        assert!(fd >= 3);
        let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::CharDevice);
        assert_eq!(ofd.host_handle, -1);
    }

    #[test]
    fn test_open_dev_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/zero", O_RDONLY, 0).unwrap();
        let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
        assert_eq!(ofd.host_handle, -2);
    }

    #[test]
    fn test_open_dev_urandom() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/urandom", O_RDONLY, 0).unwrap();
        let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
        assert_eq!(ofd.host_handle, -3);
    }

    #[test]
    fn test_open_dev_full() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/full", O_RDWR, 0).unwrap();
        let ofd = proc.ofd_table.get(proc.fd_table.get(fd).unwrap().ofd_ref.0).unwrap();
        assert_eq!(ofd.host_handle, -4);
    }

    #[test]
    fn test_open_dev_fd_dups_existing() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 1 = stdout, opening /dev/fd/1 should dup it
        let fd = sys_open(&mut proc, &mut host, b"/dev/fd/1", O_WRONLY, 0).unwrap();
        assert!(fd >= 3);
        let ofd_ref_1 = proc.fd_table.get(1).unwrap().ofd_ref.0;
        let ofd_ref_new = proc.fd_table.get(fd).unwrap().ofd_ref.0;
        assert_eq!(ofd_ref_1, ofd_ref_new);
    }

    #[test]
    fn test_open_dev_stdin_alias() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/stdin", O_RDONLY, 0).unwrap();
        let ofd_ref_0 = proc.fd_table.get(0).unwrap().ofd_ref.0;
        let ofd_ref_new = proc.fd_table.get(fd).unwrap().ofd_ref.0;
        assert_eq!(ofd_ref_0, ofd_ref_new);
    }

    #[test]
    fn test_open_dev_fd_nonexistent() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_open(&mut proc, &mut host, b"/dev/fd/999", O_RDONLY, 0);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_match_virtual_device() {
        assert_eq!(match_virtual_device(b"/dev/null"), Some(VirtualDevice::Null));
        assert_eq!(match_virtual_device(b"/dev/console"), Some(VirtualDevice::Null));
        assert_eq!(match_virtual_device(b"/dev/zero"), Some(VirtualDevice::Zero));
        assert_eq!(match_virtual_device(b"/dev/urandom"), Some(VirtualDevice::Urandom));
        assert_eq!(match_virtual_device(b"/dev/random"), Some(VirtualDevice::Urandom));
        assert_eq!(match_virtual_device(b"/dev/full"), Some(VirtualDevice::Full));
        assert_eq!(match_virtual_device(b"/dev/tty"), None);
        assert_eq!(match_virtual_device(b"/tmp/foo"), None);
    }

    #[test]
    fn test_match_dev_fd() {
        assert_eq!(match_dev_fd(b"/dev/stdin"), Some(0));
        assert_eq!(match_dev_fd(b"/dev/stdout"), Some(1));
        assert_eq!(match_dev_fd(b"/dev/stderr"), Some(2));
        assert_eq!(match_dev_fd(b"/dev/fd/0"), Some(0));
        assert_eq!(match_dev_fd(b"/dev/fd/5"), Some(5));
        assert_eq!(match_dev_fd(b"/dev/fd/123"), Some(123));
        assert_eq!(match_dev_fd(b"/dev/fd/"), None);
        assert_eq!(match_dev_fd(b"/dev/fd/abc"), None);
        assert_eq!(match_dev_fd(b"/tmp/foo"), None);
    }

    #[test]
    fn test_virtual_device_roundtrip() {
        for dev in [VirtualDevice::Null, VirtualDevice::Zero, VirtualDevice::Urandom, VirtualDevice::Full, VirtualDevice::Fb0] {
            assert_eq!(VirtualDevice::from_host_handle(dev.host_handle()), Some(dev));
        }
        assert_eq!(VirtualDevice::from_host_handle(0), None);
        assert_eq!(VirtualDevice::from_host_handle(-6), None);
    }

    // ===== Loopback socket tests =====

    #[test]
    fn test_bind_inet_ephemeral_port() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_DGRAM, 0).unwrap();
        // Bind with port=0 → ephemeral
        let addr = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        // getsockname should show the assigned ephemeral port
        let mut buf = [0u8; 16];
        let n = sys_getsockname(&proc, fd, &mut buf).unwrap();
        assert_eq!(n, 16);
        assert_eq!(buf[0], 2); // AF_INET
        let port = u16::from_be_bytes([buf[2], buf[3]]);
        assert!(port >= 49152, "ephemeral port should be >= 49152, got {}", port);
    }

    #[test]
    fn test_getsockname_inet_explicit_port() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // Bind to port 8080
        let mut addr = [0u8; 16];
        addr[0] = 2;
        addr[2] = 0x1F; addr[3] = 0x90; // 8080 big-endian
        addr[4] = 127; addr[5] = 0; addr[6] = 0; addr[7] = 1;
        sys_bind(&mut proc, &mut host, fd, &addr).unwrap();
        let mut buf = [0u8; 16];
        sys_getsockname(&proc, fd, &mut buf).unwrap();
        assert_eq!(buf[0], 2); // AF_INET
        let port = u16::from_be_bytes([buf[2], buf[3]]);
        assert_eq!(port, 8080);
        assert_eq!(&buf[4..8], &[127, 0, 0, 1]);
    }

    #[test]
    fn test_tcp_loopback() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;

        // Server: socket → bind → listen
        let server_fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let mut addr = [0u8; 16];
        addr[0] = 2; // AF_INET
        addr[2] = 0x1F; addr[3] = 0x90; // port 8080
        sys_bind(&mut proc, &mut host, server_fd, &addr).unwrap();
        sys_listen(&mut proc, &mut host, server_fd, 5).unwrap();

        // Client: socket → connect to 127.0.0.1:8080
        let client_fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let mut connect_addr = [0u8; 16];
        connect_addr[0] = 2;
        connect_addr[2] = 0x1F; connect_addr[3] = 0x90; // port 8080
        connect_addr[4] = 127; connect_addr[5] = 0; connect_addr[6] = 0; connect_addr[7] = 1;
        sys_connect(&mut proc, &mut host, client_fd, &connect_addr).unwrap();

        // Server: accept
        let accepted_fd = sys_accept(&mut proc, &mut host, server_fd).unwrap();

        // Client writes, server reads
        let written = sys_write(&mut proc, &mut host, client_fd, b"hello TCP").unwrap();
        assert_eq!(written, 9);

        let mut buf = [0u8; 64];
        let n = sys_read(&mut proc, &mut host, accepted_fd, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello TCP");

        // Server writes, client reads
        let written = sys_write(&mut proc, &mut host, accepted_fd, b"reply").unwrap();
        assert_eq!(written, 5);

        let mut buf2 = [0u8; 64];
        let n2 = sys_read(&mut proc, &mut host, client_fd, &mut buf2).unwrap();
        assert_eq!(&buf2[..n2], b"reply");
    }

    #[test]
    fn test_udp_loopback() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::socket::*;

        // Create and bind a UDP socket (receiver)
        let recv_fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_DGRAM, 0).unwrap();
        let mut addr = [0u8; 16];
        addr[0] = 2;
        // port=0 → ephemeral
        sys_bind(&mut proc, &mut host, recv_fd, &addr).unwrap();

        // Get the assigned port
        let mut gsa_buf = [0u8; 16];
        sys_getsockname(&proc, recv_fd, &mut gsa_buf).unwrap();
        let port = u16::from_be_bytes([gsa_buf[2], gsa_buf[3]]);

        // Create and bind a sender UDP socket
        let send_fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_DGRAM, 0).unwrap();
        let mut sender_addr = [0u8; 16];
        sender_addr[0] = 2;
        sys_bind(&mut proc, &mut host, send_fd, &sender_addr).unwrap();

        // Send to the receiver via loopback
        let mut dest_addr = [0u8; 16];
        dest_addr[0] = 2;
        let port_be = port.to_be_bytes();
        dest_addr[2] = port_be[0]; dest_addr[3] = port_be[1];
        dest_addr[4] = 127; dest_addr[5] = 0; dest_addr[6] = 0; dest_addr[7] = 1;
        let n = sys_sendto(&mut proc, &mut host, send_fd, b"hello UDP", 0, &dest_addr).unwrap();
        assert_eq!(n, 9);

        // Receive
        let mut buf = [0u8; 64];
        let mut from_addr = [0u8; 16];
        let (data_len, addr_len) = sys_recvfrom(&mut proc, &mut host, recv_fd, &mut buf, 0, &mut from_addr).unwrap();
        assert_eq!(&buf[..data_len], b"hello UDP");
        assert_eq!(addr_len, 16);
        assert_eq!(from_addr[0], 2); // AF_INET
    }

    // ── Threading tests ──────────────────────────────────────────────

    #[test]
    fn test_process_thread_alloc_tid() {
        let mut proc = Process::new(42);
        let tid1 = proc.alloc_tid();
        let tid2 = proc.alloc_tid();
        assert_eq!(tid1, 43); // pid + 1
        assert_eq!(tid2, 44);
    }

    #[test]
    fn test_process_thread_add_remove() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(10);
        let tid = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(tid, 0x1000, 0x2000, 0x3000));
        assert!(proc.get_thread(tid).is_some());
        assert_eq!(proc.get_thread(tid).unwrap().stack_ptr, 0x2000);

        let removed = proc.remove_thread(tid);
        assert!(removed.is_some());
        assert!(proc.get_thread(tid).is_none());
    }

    #[test]
    fn test_clone_rejects_non_thread() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // Without CLONE_VM | CLONE_THREAD, clone should return ENOSYS
        let result = sys_clone(&mut proc, &mut host, 0, 0, 0, 0, 0, 0, 0);
        assert_eq!(result, Err(Errno::ENOSYS));
    }

    #[test]
    fn test_clone_rejects_clone_vm_only() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        const CLONE_VM: u32 = 0x00000100;
        // CLONE_VM without CLONE_THREAD should fail
        let result = sys_clone(&mut proc, &mut host, 0, 0x8000, CLONE_VM, 0, 0, 0, 0);
        assert_eq!(result, Err(Errno::ENOSYS));
    }

    #[test]
    fn test_clone_non_centralized_delegates_to_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        const CLONE_VM: u32 = 0x00000100;
        const CLONE_THREAD: u32 = 0x00010000;
        let flags = CLONE_VM | CLONE_THREAD;
        // In non-centralized mode, host_clone returns -ENOSYS (mock)
        let result = sys_clone(&mut proc, &mut host, 0, 0x8000, flags, 0, 0, 0, 0);
        assert_eq!(result, Err(Errno::ENOSYS));
    }

    #[test]
    fn test_process_multiple_threads() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(1);

        // Allocate 3 threads
        let t1 = proc.alloc_tid();
        let t2 = proc.alloc_tid();
        let t3 = proc.alloc_tid();

        proc.add_thread(ThreadInfo::new(t1, 0x100, 0x1000, 0x2000));
        proc.add_thread(ThreadInfo::new(t2, 0x200, 0x3000, 0x4000));
        proc.add_thread(ThreadInfo::new(t3, 0x300, 0x5000, 0x6000));

        assert_eq!(proc.threads.len(), 3);

        // Remove middle thread
        proc.remove_thread(t2);
        assert_eq!(proc.threads.len(), 2);
        assert!(proc.get_thread(t1).is_some());
        assert!(proc.get_thread(t2).is_none());
        assert!(proc.get_thread(t3).is_some());
    }

    #[test]
    fn test_thread_info_fields() {
        use crate::process::ThreadInfo;
        let mut info = ThreadInfo::new(42, 0xABC, 0xDEF, 0x123);
        assert_eq!(info.tid, 42);
        assert_eq!(info.ctid_ptr, 0xABC);
        assert_eq!(info.stack_ptr, 0xDEF);
        assert_eq!(info.tls_ptr, 0x123);
        assert_eq!(info.tidptr, 0); // default

        info.tidptr = 0x456;
        assert_eq!(info.tidptr, 0x456);
    }

    #[test]
    fn test_process_get_thread_mut() {
        use crate::process::ThreadInfo;
        let mut proc = Process::new(5);
        let tid = proc.alloc_tid();
        proc.add_thread(ThreadInfo::new(tid, 0, 0, 0));

        // Modify thread via mutable ref
        if let Some(t) = proc.get_thread_mut(tid) {
            t.tidptr = 0xBEEF;
        }
        assert_eq!(proc.get_thread(tid).unwrap().tidptr, 0xBEEF);
    }

    #[test]
    fn test_remove_nonexistent_thread() {
        let mut proc = Process::new(1);
        assert!(proc.remove_thread(999).is_none());
    }

    // ── epoll tests ───────────────────────────────────────────────────────

    #[test]
    fn test_epoll_create1_basic() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        assert!(epfd >= 3);

        let entry = proc.fd_table.get(epfd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::Epoll);
    }

    #[test]
    fn test_epoll_create1_cloexec() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, O_CLOEXEC).unwrap();
        let entry = proc.fd_table.get(epfd).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOEXEC);
    }

    #[test]
    fn test_epoll_create1_invalid_flags() {
        let mut proc = Process::new(1);
        let result = sys_epoll_create1(&mut proc, 0xDEAD);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_epoll_ctl_add_del() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        // Add stdin (fd 0)
        let epollin: u32 = 0x001;
        sys_epoll_ctl(&mut proc, epfd, 1, 0, epollin, 42).unwrap();

        // Verify interest was added
        let entry = proc.fd_table.get(epfd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        let ep_idx = (-(ofd.host_handle + 1)) as usize;
        let ep = proc.epolls[ep_idx].as_ref().unwrap();
        assert_eq!(ep.interests.len(), 1);
        assert_eq!(ep.interests[0].fd, 0);
        assert_eq!(ep.interests[0].data, 42);

        // Delete
        sys_epoll_ctl(&mut proc, epfd, 2, 0, 0, 0).unwrap();
        let ep = proc.epolls[ep_idx].as_ref().unwrap();
        assert_eq!(ep.interests.len(), 0);
    }

    #[test]
    fn test_epoll_ctl_add_duplicate_eexist() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        sys_epoll_ctl(&mut proc, epfd, 1, 0, 0x001, 0).unwrap();
        let result = sys_epoll_ctl(&mut proc, epfd, 1, 0, 0x001, 0);
        assert_eq!(result, Err(Errno::EEXIST));
    }

    #[test]
    fn test_epoll_ctl_del_nonexistent_enoent() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        let result = sys_epoll_ctl(&mut proc, epfd, 2, 0, 0, 0);
        assert_eq!(result, Err(Errno::ENOENT));
    }

    #[test]
    fn test_epoll_ctl_mod() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        let epollin: u32 = 0x001;
        let epollout: u32 = 0x004;
        sys_epoll_ctl(&mut proc, epfd, 1, 0, epollin, 10).unwrap();
        sys_epoll_ctl(&mut proc, epfd, 3, 0, epollout, 20).unwrap();

        let entry = proc.fd_table.get(epfd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        let ep_idx = (-(ofd.host_handle + 1)) as usize;
        let ep = proc.epolls[ep_idx].as_ref().unwrap();
        assert_eq!(ep.interests[0].events, epollout);
        assert_eq!(ep.interests[0].data, 20);
    }

    #[test]
    fn test_epoll_ctl_invalid_op() {
        let mut proc = Process::new(1);
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        let result = sys_epoll_ctl(&mut proc, epfd, 99, 0, 0, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_epoll_ctl_not_epoll_fd() {
        let mut proc = Process::new(1);
        // fd 0 is stdin, not an epoll fd
        let result = sys_epoll_ctl(&mut proc, 0, 1, 1, 0x001, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_epoll_pwait_pipe_readable() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Create a pipe and write data to it
        let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();
        sys_write(&mut proc, &mut host, write_fd, b"hello").unwrap();

        // Create epoll and add read end
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        let epollin: u32 = 0x001;
        sys_epoll_ctl(&mut proc, epfd, 1, read_fd, epollin, 99).unwrap();

        // Wait with timeout=0 (non-blocking)
        let (count, events) = sys_epoll_pwait(&mut proc, &mut host, epfd, 10, 0, None).unwrap();
        assert_eq!(count, 1);
        assert_ne!(events[0].0 & epollin, 0);
        assert_eq!(events[0].1, 99); // data preserved
    }

    #[test]
    fn test_epoll_pwait_empty_interests() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        let (count, events) = sys_epoll_pwait(&mut proc, &mut host, epfd, 10, 0, None).unwrap();
        assert_eq!(count, 0);
        assert!(events.is_empty());
    }

    #[test]
    fn test_epoll_pwait_invalid_maxevents() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        let result = sys_epoll_pwait(&mut proc, &mut host, epfd, 0, 0, None);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_epoll_close_frees_state() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        sys_close(&mut proc, &mut host, epfd).unwrap();
        assert!(proc.epolls[0].is_none());
    }

    #[test]
    fn test_epoll_lseek_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();

        let result = sys_lseek(&mut proc, &mut host, epfd, 0, SEEK_SET);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_epoll_with_eventfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // Create an eventfd with initial value
        let efd = sys_eventfd2(&mut proc, 5, O_NONBLOCK).unwrap();

        // Create epoll and watch eventfd
        let epfd = sys_epoll_create1(&mut proc, 0).unwrap();
        let epollin: u32 = 0x001;
        sys_epoll_ctl(&mut proc, epfd, 1, efd, epollin, 77).unwrap();

        // Should be readable (counter > 0)
        let (count, events) = sys_epoll_pwait(&mut proc, &mut host, epfd, 10, 0, None).unwrap();
        assert_eq!(count, 1);
        assert_ne!(events[0].0 & epollin, 0);
        assert_eq!(events[0].1, 77);

        // Read the eventfd to drain it
        let mut buf = [0u8; 8];
        sys_read(&mut proc, &mut host, efd, &mut buf).unwrap();

        // Now should NOT be readable
        let (count, _) = sys_epoll_pwait(&mut proc, &mut host, epfd, 10, 0, None).unwrap();
        assert_eq!(count, 0);
    }

    // ── eventfd tests ─────────────────────────────────────────────────────

    #[test]
    fn test_eventfd2_basic() {
        let mut proc = Process::new(1);
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();
        assert!(fd >= 3); // 0,1,2 are stdio

        // Verify OFD is EventFd type
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::EventFd);
        assert_eq!(ofd.status_flags & O_ACCMODE, O_RDWR);
    }

    #[test]
    fn test_eventfd2_with_initial_value() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 42, 0).unwrap();

        // Read should return the initial value
        let mut buf = [0u8; 8];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 8);
        let val = u64::from_le_bytes(buf);
        assert_eq!(val, 42);
    }

    #[test]
    fn test_eventfd2_read_resets_counter() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 10, O_NONBLOCK).unwrap();

        // First read: returns 10, resets to 0
        let mut buf = [0u8; 8];
        sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 10);

        // Second read: counter is 0, should EAGAIN
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_eventfd2_write_adds_to_counter() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 5, 0).unwrap();

        // Write 3 to the eventfd
        let val: u64 = 3;
        let n = sys_write(&mut proc, &mut host, fd, &val.to_le_bytes()).unwrap();
        assert_eq!(n, 8);

        // Read should return 5 + 3 = 8
        let mut buf = [0u8; 8];
        sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 8);
    }

    #[test]
    fn test_eventfd2_semaphore_mode() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let efd_semaphore: u32 = 1;
        let fd = sys_eventfd2(&mut proc, 3, efd_semaphore | O_NONBLOCK).unwrap();

        // Read in semaphore mode: returns 1, decrements counter
        let mut buf = [0u8; 8];
        sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 1);

        // Read again: returns 1, counter now 1
        sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 1);

        // Read again: returns 1, counter now 0
        sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 1);

        // Counter is now 0, should EAGAIN
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_eventfd2_cloexec() {
        let mut proc = Process::new(1);
        let fd = sys_eventfd2(&mut proc, 0, O_CLOEXEC).unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOEXEC);
    }

    #[test]
    fn test_eventfd2_nonblock() {
        let mut proc = Process::new(1);
        let fd = sys_eventfd2(&mut proc, 0, O_NONBLOCK).unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_ne!(ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_eventfd2_invalid_flags() {
        let mut proc = Process::new(1);
        let result = sys_eventfd2(&mut proc, 0, 0xDEAD);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_eventfd2_read_too_small_buf() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 1, 0).unwrap();

        let mut buf = [0u8; 4]; // too small, need 8
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_eventfd2_write_too_small_buf() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        let buf = [0u8; 4]; // too small, need 8
        let result = sys_write(&mut proc, &mut host, fd, &buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_eventfd2_write_u64_max_invalid() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        let val = u64::MAX;
        let result = sys_write(&mut proc, &mut host, fd, &val.to_le_bytes());
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_eventfd2_poll_readable_when_nonzero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 5, 0).unwrap();

        let mut fds = [WasmPollFd { fd, events: POLLIN | POLLOUT, revents: 0 }];
        let n = sys_poll(&mut proc, &mut host, &mut fds, 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(fds[0].revents & POLLIN, 0);
        assert_ne!(fds[0].revents & POLLOUT, 0);
    }

    #[test]
    fn test_eventfd2_poll_not_readable_when_zero() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        let mut fds = [WasmPollFd { fd, events: POLLIN | POLLOUT, revents: 0 }];
        let n = sys_poll(&mut proc, &mut host, &mut fds, 0).unwrap();
        assert_eq!(n, 1);
        assert_eq!(fds[0].revents & POLLIN, 0);
        assert_ne!(fds[0].revents & POLLOUT, 0);
    }

    #[test]
    fn test_eventfd2_close_frees_state() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 42, 0).unwrap();

        // Close the eventfd
        sys_close(&mut proc, &mut host, fd).unwrap();

        // eventfd slot should be freed
        assert!(proc.eventfds[0].is_none());
    }

    #[test]
    fn test_eventfd2_lseek_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        let result = sys_lseek(&mut proc, &mut host, fd, 0, SEEK_SET);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_eventfd2_fstat() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        let stat = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(stat.st_mode & S_IFIFO, S_IFIFO);
    }

    #[test]
    fn test_eventfd2_dup_shares_counter() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_eventfd2(&mut proc, 0, 0).unwrap();

        // Dup the eventfd
        let fd2 = sys_dup(&mut proc, fd).unwrap();
        assert_ne!(fd, fd2);

        // Write on fd
        let val: u64 = 7;
        sys_write(&mut proc, &mut host, fd, &val.to_le_bytes()).unwrap();

        // Read on fd2 should see the value (they share the same OFD)
        let mut buf = [0u8; 8];
        sys_read(&mut proc, &mut host, fd2, &mut buf).unwrap();
        assert_eq!(u64::from_le_bytes(buf), 7);
    }

    // ── inotify tests ────────────────────────────────────────────────────

    #[test]
    fn test_inotify_init_returns_fd() {
        let mut proc = Process::new(1);
        let fd = sys_inotify_init(&mut proc).unwrap();
        assert!(fd >= 3);
        // The fd should be valid and closeable
        let mut host = MockHostIO::new();
        assert_eq!(sys_close(&mut proc, &mut host, fd), Ok(()));
    }

    #[test]
    fn test_inotify_init_fd_is_cloexec() {
        let mut proc = Process::new(1);
        let fd = sys_inotify_init(&mut proc).unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        // inotify_init stub sets O_CLOEXEC
        assert_ne!(entry.fd_flags & wasm_posix_shared::fd_flags::FD_CLOEXEC, 0);
    }

    // ── timerfd tests ────────────────────────────────────────────────────

    #[test]
    fn test_timerfd_create_basic() {
        let mut proc = Process::new(1);
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap(); // CLOCK_REALTIME
        assert!(fd >= 3);

        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::TimerFd);
    }

    #[test]
    fn test_timerfd_create_with_flags() {
        let mut proc = Process::new(1);
        let fd = sys_timerfd_create(&mut proc, 1, O_NONBLOCK | O_CLOEXEC).unwrap();
        assert!(fd >= 3);

        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_ne!(ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_timerfd_create_invalid_flags() {
        let mut proc = Process::new(1);
        let result = sys_timerfd_create(&mut proc, 0, 0xDEAD);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_timerfd_settime_disarm() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap();

        // Set then disarm
        host.clock_time = (100, 0);
        sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 105, 0).unwrap();
        let (isec, insec, _vsec, _vnsec) = sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 0, 0).unwrap();
        // Old value was: interval=(0,0), value was set
        assert_eq!(isec, 0);
        assert_eq!(insec, 0);

        // After disarming, gettime should return all zeros
        let result = sys_timerfd_gettime(&mut proc, &mut host, fd).unwrap();
        assert_eq!(result, (0, 0, 0, 0));
    }

    #[test]
    fn test_timerfd_settime_relative() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap();

        host.clock_time = (100, 0);
        // Set timer to expire in 5 seconds (relative)
        let old = sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 5, 0).unwrap();
        // Old timer was disarmed
        assert_eq!(old, (0, 0, 0, 0));

        // Timer should now expire at absolute time 105
        let (isec, insec, vsec, vnsec) = sys_timerfd_gettime(&mut proc, &mut host, fd).unwrap();
        assert_eq!(isec, 0);
        assert_eq!(insec, 0);
        assert_eq!(vsec, 5); // 5 seconds remaining
        assert_eq!(vnsec, 0);
    }

    #[test]
    fn test_timerfd_settime_absolute() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap();

        host.clock_time = (100, 0);
        // Set timer to expire at absolute time 110 (TFD_TIMER_ABSTIME = 1)
        sys_timerfd_settime(&mut proc, &mut host, fd, 1, 0, 0, 110, 0).unwrap();

        // Timer should show ~10 seconds remaining
        let (_, _, vsec, _) = sys_timerfd_gettime(&mut proc, &mut host, fd).unwrap();
        assert_eq!(vsec, 10);
    }

    #[test]
    fn test_timerfd_read_no_expiration_eagain() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, O_NONBLOCK).unwrap();

        host.clock_time = (100, 0);
        // Set timer to expire in 5 seconds
        sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 5, 0).unwrap();

        // Read before expiration should return EAGAIN
        let mut buf = [0u8; 8];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_timerfd_read_after_expiration() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, O_NONBLOCK).unwrap();

        host.clock_time = (100, 0);
        // Set one-shot timer to expire in 5 seconds
        sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 5, 0).unwrap();

        // Advance time past expiration
        host.clock_time = (106, 0);
        let mut buf = [0u8; 8];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 8);
        let expirations = u64::from_le_bytes(buf);
        assert_eq!(expirations, 1);
    }

    #[test]
    fn test_timerfd_read_repeating() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, O_NONBLOCK).unwrap();

        host.clock_time = (100, 0);
        // Set repeating timer: interval=2s, first expiration in 1s
        sys_timerfd_settime(&mut proc, &mut host, fd, 0, 2, 0, 1, 0).unwrap();

        // Advance 5.5 seconds: first at 101, then 103, 105 => 3 expirations
        host.clock_time = (105, 500_000_000);
        let mut buf = [0u8; 8];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 8);
        let expirations = u64::from_le_bytes(buf);
        assert!(expirations >= 3);
    }

    #[test]
    fn test_timerfd_read_small_buf() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, O_NONBLOCK).unwrap();

        let mut buf = [0u8; 4]; // too small
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_timerfd_poll_not_expired() {
        use wasm_posix_shared::WasmPollFd;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, O_NONBLOCK).unwrap();

        host.clock_time = (100, 0);
        sys_timerfd_settime(&mut proc, &mut host, fd, 0, 0, 0, 5, 0).unwrap();

        // Timer not yet expired: poll should report not ready
        let mut pollfd = WasmPollFd { fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_timerfd_lseek_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap();

        let result = sys_lseek(&mut proc, &mut host, fd, 0, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_timerfd_close() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_timerfd_create(&mut proc, 0, 0).unwrap();

        sys_close(&mut proc, &mut host, fd).unwrap();
        let result = sys_read(&mut proc, &mut host, fd, &mut [0u8; 8]);
        assert_eq!(result, Err(Errno::EBADF));
    }

    #[test]
    fn test_timerfd_gettime_not_timerfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        // fd 0 is stdin, not a timerfd
        let result = sys_timerfd_gettime(&mut proc, &mut host, 0);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    // ── signalfd tests ───────────────────────────────────────────────────

    #[test]
    fn test_signalfd4_create() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::signal::SIGINT;
        let mask = crate::signal::sig_bit(SIGINT);
        let fd = sys_signalfd4(&mut proc, -1, mask, 0).unwrap();
        assert!(fd >= 3);

        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_eq!(ofd.file_type, FileType::SignalFd);
    }

    #[test]
    fn test_signalfd4_create_with_flags() {
        let mut proc = Process::new(1);
        let fd = sys_signalfd4(&mut proc, -1, 0x04, O_NONBLOCK | O_CLOEXEC).unwrap();
        assert!(fd >= 3);

        let entry = proc.fd_table.get(fd).unwrap();
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
        assert_ne!(ofd.status_flags & O_NONBLOCK, 0);
    }

    #[test]
    fn test_signalfd4_invalid_flags() {
        let mut proc = Process::new(1);
        let result = sys_signalfd4(&mut proc, -1, 0x04, 0xDEAD);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_signalfd4_update_existing() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::signal::{SIGINT, SIGTERM};
        let mask1 = crate::signal::sig_bit(SIGINT);
        let fd = sys_signalfd4(&mut proc, -1, mask1, 0).unwrap();

        // Update mask
        let mask2 = crate::signal::sig_bit(SIGTERM);
        let fd2 = sys_signalfd4(&mut proc, fd, mask2, 0).unwrap();
        assert_eq!(fd, fd2); // Same fd returned
    }

    #[test]
    fn test_signalfd4_read_no_signal_eagain() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::signal::SIGINT;
        let mask = crate::signal::sig_bit(SIGINT);
        let fd = sys_signalfd4(&mut proc, -1, mask, O_NONBLOCK).unwrap();

        // No signal pending: read should EAGAIN
        let mut buf = [0u8; 128];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_signalfd4_read_with_pending_signal() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::signal::SIGINT;
        let mask = crate::signal::sig_bit(SIGINT);
        let fd = sys_signalfd4(&mut proc, -1, mask, O_NONBLOCK).unwrap();

        // Raise SIGINT
        proc.signals.raise(SIGINT);

        // Read should return signalfd_siginfo with ssi_signo=SIGINT
        let mut buf = [0u8; 128];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 128);
        let signo = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        assert_eq!(signo, SIGINT);

        // Signal should be consumed from pending
        assert!(!proc.signals.is_pending(SIGINT));
    }

    #[test]
    fn test_signalfd4_read_small_buf() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_signalfd4(&mut proc, -1, 0x04, O_NONBLOCK).unwrap();

        let mut buf = [0u8; 64]; // too small (needs 128)
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EINVAL));
    }

    #[test]
    fn test_signalfd4_read_ignores_unmasked_signals() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        use wasm_posix_shared::signal::{SIGINT, SIGTERM};
        let mask = crate::signal::sig_bit(SIGINT); // only watching SIGINT
        let fd = sys_signalfd4(&mut proc, -1, mask, O_NONBLOCK).unwrap();

        // Raise SIGTERM (not in mask)
        proc.signals.raise(SIGTERM);

        // Read should EAGAIN (SIGTERM not in mask)
        let mut buf = [0u8; 128];
        let result = sys_read(&mut proc, &mut host, fd, &mut buf);
        assert_eq!(result, Err(Errno::EAGAIN));

        // SIGTERM should still be pending
        assert!(proc.signals.is_pending(SIGTERM));
    }

    #[test]
    fn test_signalfd4_poll_with_signal() {
        use wasm_posix_shared::WasmPollFd;
        use wasm_posix_shared::signal::SIGINT;
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mask = crate::signal::sig_bit(SIGINT);
        let fd = sys_signalfd4(&mut proc, -1, mask, O_NONBLOCK).unwrap();

        // No signal: poll should report not ready
        let mut pollfd = WasmPollFd { fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 0);

        // Raise signal
        proc.signals.raise(SIGINT);

        // Now poll should report readable
        let mut pollfd = WasmPollFd { fd, events: POLLIN, revents: 0 };
        let n = sys_poll(&mut proc, &mut host, core::slice::from_mut(&mut pollfd), 0).unwrap();
        assert_eq!(n, 1);
        assert_ne!(pollfd.revents & POLLIN, 0);
    }

    #[test]
    fn test_signalfd4_lseek_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_signalfd4(&mut proc, -1, 0x04, 0).unwrap();

        let result = sys_lseek(&mut proc, &mut host, fd, 0, 0);
        assert_eq!(result, Err(Errno::ESPIPE));
    }

    #[test]
    fn test_signalfd4_close() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_signalfd4(&mut proc, -1, 0x04, 0).unwrap();

        sys_close(&mut proc, &mut host, fd).unwrap();
        let result = sys_read(&mut proc, &mut host, fd, &mut [0u8; 128]);
        assert_eq!(result, Err(Errno::EBADF));
    }

    // ── Phase 5 tests ────────────────────────────────────────────────────

    #[test]
    fn test_readdir_synthesizes_dot_entries() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        host.dir_entry_count = 0; // no host entries
        let dh = sys_opendir(&mut proc, &mut host, b"/tmp").unwrap();

        let mut dirent_buf = [0u8; 16];
        let mut name_buf = [0u8; 256];

        // Should get "." first
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..1], b".");

        // Then ".."
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 1);
        assert_eq!(&name_buf[..2], b"..");

        // Then end of directory (no host entries)
        let r = sys_readdir(&mut proc, &mut host, dh, &mut dirent_buf, &mut name_buf).unwrap();
        assert_eq!(r, 0);
    }

    #[test]
    fn test_pipe_buf_atomicity() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

        // Set write end to nonblocking
        sys_fcntl(&mut proc, write_fd, 4, O_NONBLOCK).unwrap(); // F_SETFL

        // Fill most of the pipe (capacity is 65536)
        let big_buf = [0u8; 65530];
        sys_write(&mut proc, &mut host, write_fd, &big_buf).unwrap();

        // Now only 6 bytes free. A write of 100 bytes (≤ PIPE_BUF=4096)
        // should fail with EAGAIN rather than doing a partial write.
        let small_buf = [0u8; 100];
        let result = sys_write(&mut proc, &mut host, write_fd, &small_buf);
        assert_eq!(result, Err(Errno::EAGAIN));
    }

    #[test]
    fn test_tiocgpgrp_tiocspgrp() {
        let mut proc = Process::new(1);
        let mut buf = [0u8; 4];

        // TIOCGPGRP on stdin (fd 0, which is a CharDevice)
        sys_ioctl(&mut proc, 0, 0x540F, &mut buf).unwrap();
        let pgid = i32::from_le_bytes(buf);
        assert_eq!(pgid, 1); // default foreground_pgid

        // TIOCSPGRP — set to 42
        buf.copy_from_slice(&42i32.to_le_bytes());
        sys_ioctl(&mut proc, 0, 0x5410, &mut buf).unwrap();

        // Read back
        sys_ioctl(&mut proc, 0, 0x540F, &mut buf).unwrap();
        let pgid = i32::from_le_bytes(buf);
        assert_eq!(pgid, 42);
    }

    #[test]
    fn test_tiocgpgrp_not_tty() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 4];

        // Open a regular file
        let fd = sys_open(&mut proc, &mut host, b"/tmp/test", O_RDWR | O_CREAT, 0o644).unwrap();
        let result = sys_ioctl(&mut proc, fd, 0x540F, &mut buf);
        assert_eq!(result, Err(Errno::ENOTTY));
    }

    // ── Phase 6 tests ────────────────────────────────────────────────────

    #[test]
    fn test_realpath_resolves_symlink() {
        // Custom mock where /tmp/mylink is a symlink to /tmp/realfile
        struct SymlinkMock;
        impl HostIO for SymlinkMock {
            fn host_open(&mut self, _p: &[u8], _f: u32, _m: u32) -> Result<i64, Errno> { Ok(100) }
            fn host_close(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_write(&mut self, _h: i64, _b: &[u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> { Ok(0) }
            fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> {
                Ok(WasmStat {
                    st_dev: 0, st_ino: 1, st_mode: S_IFREG | 0o644, st_nlink: 1,
                    st_uid: 0, st_gid: 0, st_size: 100,
                    st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                    st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
                })
            }
            fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
                let mode = if path == b"/tmp/mylink" {
                    S_IFLNK | 0o777
                } else if path == b"/tmp" || path == b"/" {
                    S_IFDIR | 0o755
                } else {
                    S_IFREG | 0o644
                };
                Ok(WasmStat {
                    st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                    st_uid: 0, st_gid: 0, st_size: 100,
                    st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                    st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
                })
            }
            fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_link(&mut self, _e: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_symlink(&mut self, _t: &[u8], _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
                if path == b"/tmp/mylink" {
                    let target = b"/tmp/realfile";
                    buf[..target.len()].copy_from_slice(target);
                    Ok(target.len())
                } else {
                    Err(Errno::EINVAL)
                }
            }
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
            fn host_set_posix_timer(&mut self, _t: i32, _s: i32, _v: i64, _i: i64) -> Result<(), Errno> { Ok(()) }
            fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
            fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> { Ok(()) }
            fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0x42; } Ok(b.len()) }
            fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
            fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
            fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
            fn host_net_send(&mut self, _h: i32, data: &[u8], _f: u32) -> Result<usize, Errno> { Ok(data.len()) }
            fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
            fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> { Ok(()) }
            fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _c: u32, _t: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
            fn host_fork(&self) -> i32 { -1 }
            fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> { Ok(0) }
            fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> { Ok(0) }
            fn host_clone(&mut self, _f: usize, _a: usize, _s: usize, _t: usize, _c: usize) -> Result<i32, Errno> { Err(Errno::ENOSYS) }
            fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize, _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
            fn unbind_framebuffer(&mut self, _pid: i32) {}
            fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {}
        }

        let mut proc = Process::new(1);
        let mut host = SymlinkMock;
        let mut buf = [0u8; 4096];

        // /tmp/mylink is a symlink to /tmp/realfile
        let len = sys_realpath(&mut proc, &mut host, b"/tmp/mylink", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/tmp/realfile");
    }

    #[test]
    fn test_realpath_eloop() {
        // Mock where /tmp/loop1 -> /tmp/loop2 -> /tmp/loop1 (circular)
        struct LoopMock;
        impl HostIO for LoopMock {
            fn host_open(&mut self, _p: &[u8], _f: u32, _m: u32) -> Result<i64, Errno> { Ok(100) }
            fn host_close(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_write(&mut self, _h: i64, _b: &[u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> { Ok(0) }
            fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
                let mode = if path == b"/tmp/loop1" || path == b"/tmp/loop2" {
                    S_IFLNK | 0o777
                } else if path == b"/tmp" || path == b"/" {
                    S_IFDIR | 0o755
                } else {
                    S_IFREG | 0o644
                };
                Ok(WasmStat {
                    st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                    st_uid: 0, st_gid: 0, st_size: 100,
                    st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                    st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
                })
            }
            fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_link(&mut self, _e: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_symlink(&mut self, _t: &[u8], _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
                let target = if path == b"/tmp/loop1" { b"/tmp/loop2" as &[u8] }
                    else if path == b"/tmp/loop2" { b"/tmp/loop1" }
                    else { return Err(Errno::EINVAL); };
                buf[..target.len()].copy_from_slice(target);
                Ok(target.len())
            }
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
            fn host_set_posix_timer(&mut self, _t: i32, _s: i32, _v: i64, _i: i64) -> Result<(), Errno> { Ok(()) }
            fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
            fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> { Ok(()) }
            fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0x42; } Ok(b.len()) }
            fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
            fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
            fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
            fn host_net_send(&mut self, _h: i32, data: &[u8], _f: u32) -> Result<usize, Errno> { Ok(data.len()) }
            fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
            fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> { Ok(()) }
            fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _c: u32, _t: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
            fn host_fork(&self) -> i32 { -1 }
            fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> { Ok(0) }
            fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> { Ok(0) }
            fn host_clone(&mut self, _f: usize, _a: usize, _s: usize, _t: usize, _c: usize) -> Result<i32, Errno> { Err(Errno::ENOSYS) }
            fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize, _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
            fn unbind_framebuffer(&mut self, _pid: i32) {}
            fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {}
        }

        let mut proc = Process::new(1);
        let mut host = LoopMock;
        let mut buf = [0u8; 4096];

        let result = sys_realpath(&mut proc, &mut host, b"/tmp/loop1", &mut buf);
        assert_eq!(result, Err(Errno::ELOOP));
    }

    #[test]
    fn test_realpath_relative_symlink() {
        // Mock where /a/b/sym -> ../c/target (relative symlink)
        struct RelSymlinkMock;
        impl HostIO for RelSymlinkMock {
            fn host_open(&mut self, _p: &[u8], _f: u32, _m: u32) -> Result<i64, Errno> { Ok(100) }
            fn host_close(&mut self, _h: i64) -> Result<(), Errno> { Ok(()) }
            fn host_read(&mut self, _h: i64, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_write(&mut self, _h: i64, _b: &[u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_seek(&mut self, _h: i64, _o: i64, _w: u32) -> Result<i64, Errno> { Ok(0) }
            fn host_fstat(&mut self, _h: i64) -> Result<WasmStat, Errno> { Ok(unsafe { core::mem::zeroed() }) }
            fn host_stat(&mut self, _p: &[u8]) -> Result<WasmStat, Errno> {
                Ok(WasmStat {
                    st_dev: 0, st_ino: 1, st_mode: S_IFREG | 0o644, st_nlink: 1,
                    st_uid: 0, st_gid: 0, st_size: 100,
                    st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                    st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
                })
            }
            fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
                let mode = if path == b"/a/b/sym" {
                    S_IFLNK | 0o777
                } else if path == b"/" || path == b"/a" || path == b"/a/b"
                       || path == b"/a/c" {
                    S_IFDIR | 0o755
                } else {
                    S_IFREG | 0o644
                };
                Ok(WasmStat {
                    st_dev: 0, st_ino: 1, st_mode: mode, st_nlink: 1,
                    st_uid: 0, st_gid: 0, st_size: 100,
                    st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0, st_mtime_nsec: 0,
                    st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
                })
            }
            fn host_mkdir(&mut self, _p: &[u8], _m: u32) -> Result<(), Errno> { Ok(()) }
            fn host_rmdir(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_unlink(&mut self, _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_rename(&mut self, _o: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_link(&mut self, _e: &[u8], _n: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_symlink(&mut self, _t: &[u8], _p: &[u8]) -> Result<(), Errno> { Ok(()) }
            fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
                if path == b"/a/b/sym" {
                    let target = b"../c/target";
                    buf[..target.len()].copy_from_slice(target);
                    Ok(target.len())
                } else {
                    Err(Errno::EINVAL)
                }
            }
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
            fn host_set_posix_timer(&mut self, _t: i32, _s: i32, _v: i64, _i: i64) -> Result<(), Errno> { Ok(()) }
            fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> { Err(Errno::EINTR) }
            fn host_call_signal_handler(&mut self, _h: u32, _s: u32, _f: u32) -> Result<(), Errno> { Ok(()) }
            fn host_getrandom(&mut self, b: &mut [u8]) -> Result<usize, Errno> { for x in b.iter_mut() { *x = 0x42; } Ok(b.len()) }
            fn host_utimensat(&mut self, _p: &[u8], _as: i64, _an: i64, _ms: i64, _mn: i64) -> Result<(), Errno> { Ok(()) }
            fn host_waitpid(&mut self, _p: i32, _o: u32) -> Result<(i32, i32), Errno> { Err(Errno::ECHILD) }
            fn host_net_connect(&mut self, _h: i32, _a: &[u8], _p: u16) -> Result<(), Errno> { Ok(()) }
            fn host_net_send(&mut self, _h: i32, data: &[u8], _f: u32) -> Result<usize, Errno> { Ok(data.len()) }
            fn host_net_recv(&mut self, _h: i32, _l: u32, _f: u32, _b: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_net_close(&mut self, _h: i32) -> Result<(), Errno> { Ok(()) }
            fn host_net_listen(&mut self, _f: i32, _p: u16, _a: &[u8; 4]) -> Result<(), Errno> { Ok(()) }
            fn host_getaddrinfo(&mut self, _n: &[u8], _r: &mut [u8]) -> Result<usize, Errno> { Ok(0) }
            fn host_fcntl_lock(&mut self, _p: &[u8], _pid: u32, _c: u32, _t: u32, _s: i64, _l: i64, _r: &mut [u8]) -> Result<(), Errno> { Ok(()) }
            fn host_fork(&self) -> i32 { -1 }
            fn host_futex_wait(&mut self, _a: usize, _e: u32, _t: i64) -> Result<i32, Errno> { Ok(0) }
            fn host_futex_wake(&mut self, _a: usize, _c: u32) -> Result<i32, Errno> { Ok(0) }
            fn host_clone(&mut self, _f: usize, _a: usize, _s: usize, _t: usize, _c: usize) -> Result<i32, Errno> { Err(Errno::ENOSYS) }
            fn bind_framebuffer(&mut self, _pid: i32, _addr: usize, _len: usize, _w: u32, _h: u32, _stride: u32, _fmt: u32) {}
            fn unbind_framebuffer(&mut self, _pid: i32) {}
            fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {}
        }

        let mut proc = Process::new(1);
        let mut host = RelSymlinkMock;
        let mut buf = [0u8; 4096];

        // /a/b/sym -> ../c/target resolves to /a/c/target
        let len = sys_realpath(&mut proc, &mut host, b"/a/b/sym", &mut buf).unwrap();
        assert_eq!(&buf[..len], b"/a/c/target");
    }

    #[test]
    fn test_sa_siginfo_flag_stored() {
        use wasm_posix_shared::signal::*;
        let mut proc = Process::new(1);
        // Set handler with SA_SIGINFO flag
        let (_, old_flags, _) = sys_sigaction(&mut proc, SIGUSR1, 42, SA_SIGINFO, 0).unwrap();
        assert_eq!(old_flags, 0); // was default

        // Read back the action
        let action = proc.signals.get_action(SIGUSR1);
        assert_eq!(action.flags & SA_SIGINFO, SA_SIGINFO);
    }

    #[test]
    fn test_rt_signal_queuing() {
        let mut state = crate::signal::SignalState::new();
        let rt_sig = 34u32; // SIGRTMIN + 2

        // Raise the same RT signal 3 times
        state.raise(rt_sig);
        state.raise(rt_sig);
        state.raise(rt_sig);

        // Should dequeue 3 separate instances
        assert_eq!(state.dequeue(), Some((rt_sig, 0, 0)));
        assert_eq!(state.dequeue(), Some((rt_sig, 0, 0)));
        assert_eq!(state.dequeue(), Some((rt_sig, 0, 0)));
        // Now exhausted
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_standard_signal_coalesced() {
        let mut state = crate::signal::SignalState::new();
        use wasm_posix_shared::signal::SIGUSR1;

        // Raise SIGUSR1 (standard, signal 10) 3 times
        state.raise(SIGUSR1);
        state.raise(SIGUSR1);
        state.raise(SIGUSR1);

        // Should only dequeue once (coalesced)
        assert_eq!(state.dequeue(), Some((SIGUSR1, 0, 0)));
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_rt_signal_ordering() {
        let mut state = crate::signal::SignalState::new();
        let rt1 = 33u32;
        let rt2 = 34u32;

        // Raise rt2 first, then rt1
        state.raise(rt2);
        state.raise(rt1);

        // Should dequeue in signal number order (lowest first from bitmask)
        assert_eq!(state.dequeue(), Some((rt1, 0, 0)));
        assert_eq!(state.dequeue(), Some((rt2, 0, 0)));
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_rt_signal_clear_removes_all() {
        let mut state = crate::signal::SignalState::new();
        let rt_sig = 35u32;

        state.raise(rt_sig);
        state.raise(rt_sig);
        state.raise(rt_sig);

        // Clear should remove all queued instances
        state.clear(rt_sig);
        assert!(!state.is_pending(rt_sig));
        assert_eq!(state.dequeue(), None);
    }

    #[test]
    fn test_mixed_standard_and_rt_signals() {
        use wasm_posix_shared::signal::SIGINT;
        let mut state = crate::signal::SignalState::new();
        let rt_sig = 40u32;

        state.raise(rt_sig);
        state.raise(rt_sig);
        state.raise(SIGINT); // standard signal 2

        // Standard signals have lower numbers, so SIGINT dequeues first
        assert_eq!(state.dequeue(), Some((SIGINT, 0, 0)));
        // Then both RT signal instances
        assert_eq!(state.dequeue(), Some((rt_sig, 0, 0)));
        assert_eq!(state.dequeue(), Some((rt_sig, 0, 0)));
        assert_eq!(state.dequeue(), None);
    }

    // ── Synthetic /etc file tests ──

    #[test]
    fn test_synthetic_file_open_read_close() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/etc/passwd", O_RDONLY, 0).unwrap();
        assert!(fd >= 0);

        let mut buf = [0u8; 256];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert!(n > 0);
        let content = &buf[..n];
        assert!(content.starts_with(b"root:x:0:0:"));

        // Second read should return remaining or 0 (EOF)
        let n2 = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        // Total should be the full content
        let passwd_content = synthetic_file_content(b"/etc/passwd").unwrap();
        assert_eq!(n + n2, passwd_content.len());

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn test_synthetic_file_stat() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let st = sys_stat(&mut proc, &mut host, b"/etc/passwd").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        let passwd_content = synthetic_file_content(b"/etc/passwd").unwrap();
        assert_eq!(st.st_size, passwd_content.len() as u64);
    }

    #[test]
    fn test_synthetic_file_hosts() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/etc/hosts", O_RDONLY, 0).unwrap();
        let mut buf = [0u8; 256];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        let content = core::str::from_utf8(&buf[..n]).unwrap();
        assert!(content.contains("127.0.0.1"));
        assert!(content.contains("localhost"));
        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn test_synthetic_file_lseek() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/etc/passwd", O_RDONLY, 0).unwrap();

        // Read a few bytes
        let mut buf = [0u8; 5];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 5);

        // Seek back to start
        let pos = sys_lseek(&mut proc, &mut host, fd, 0, SEEK_SET).unwrap();
        assert_eq!(pos, 0);

        // Read again — should get same content
        let n2 = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n2, 5);
        assert_eq!(&buf[..5], b"root:");

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn test_synthetic_file_write_denied() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let result = sys_open(&mut proc, &mut host, b"/etc/passwd", O_WRONLY, 0);
        assert_eq!(result.unwrap_err(), Errno::EACCES);
    }

    #[test]
    fn test_sysinfo() {
        let mut buf = [0u8; 312];
        sys_sysinfo(&mut buf).unwrap();
        // uptime = 1
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 1);
        // totalram = 512 MB
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 512 * 1024 * 1024);
        // freeram = 256 MB
        assert_eq!(u32::from_le_bytes(buf[20..24].try_into().unwrap()), 256 * 1024 * 1024);
        // procs = 1
        assert_eq!(u16::from_le_bytes(buf[40..42].try_into().unwrap()), 1);
        // mem_unit = 1
        assert_eq!(u32::from_le_bytes(buf[52..56].try_into().unwrap()), 1);
    }

    #[test]
    fn test_sysinfo_buffer_too_small() {
        let mut buf = [0u8; 100];
        assert_eq!(sys_sysinfo(&mut buf).unwrap_err(), Errno::EFAULT);
    }

    #[test]
    fn test_fcntl_lock_seek_end_non_host() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (_fd0, fd1) = sys_pipe(&mut proc).unwrap();

        // SEEK_END on non-host file should return EINVAL
        let mut flock = WasmFlock {
            l_type: F_RDLCK as i16,
            l_whence: 2, // SEEK_END
            _pad1: 0,
            l_start: 0,
            l_len: 10,
            l_pid: 0,
            _pad2: 0,
        };
        let result = sys_fcntl_lock(&mut proc, fd1, F_GETLK, &mut flock, &mut host);
        assert_eq!(result.unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_memfd_create_basic() {
        let mut proc = Process::new(1);
        let fd = sys_memfd_create(&mut proc, b"test", 0).unwrap();
        assert!(fd >= 0);

        // fstat should report size 0
        let mut host = MockHostIO::new();
        let stat = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(stat.st_size, 0);
    }

    #[test]
    fn test_memfd_write_read() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_memfd_create(&mut proc, b"test", 0).unwrap();

        // Write data
        let data = b"hello memfd";
        let n = sys_write(&mut proc, &mut host, fd, data).unwrap();
        assert_eq!(n, data.len());

        // Seek back to start
        let pos = sys_lseek(&mut proc, &mut host, fd, 0, SEEK_SET).unwrap();
        assert_eq!(pos, 0);

        // Read data back
        let mut buf = [0u8; 32];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, data.len());
        assert_eq!(&buf[..n], data);
    }

    #[test]
    fn test_memfd_ftruncate() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_memfd_create(&mut proc, b"trunc", 0).unwrap();

        // Write some data
        sys_write(&mut proc, &mut host, fd, b"abcdef").unwrap();

        // Truncate to 3 bytes
        sys_ftruncate(&mut proc, &mut host, fd, 3).unwrap();

        // fstat should report size 3
        let stat = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(stat.st_size, 3);

        // Read from start: should get "abc"
        sys_lseek(&mut proc, &mut host, fd, 0, SEEK_SET).unwrap();
        let mut buf = [0u8; 16];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, 3);
        assert_eq!(&buf[..3], b"abc");
    }

    #[test]
    fn test_memfd_lseek_end() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_memfd_create(&mut proc, b"seek", 0).unwrap();

        sys_write(&mut proc, &mut host, fd, b"12345").unwrap();

        // SEEK_END with offset 0 -> should be at position 5
        let pos = sys_lseek(&mut proc, &mut host, fd, 0, SEEK_END).unwrap();
        assert_eq!(pos, 5);

        // SEEK_END with negative offset
        let pos = sys_lseek(&mut proc, &mut host, fd, -2, SEEK_END).unwrap();
        assert_eq!(pos, 3);
    }

    #[test]
    fn test_memfd_close_frees_buffer() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_memfd_create(&mut proc, b"close", 0).unwrap();
        sys_write(&mut proc, &mut host, fd, b"data").unwrap();

        // Close should succeed
        sys_close(&mut proc, &mut host, fd).unwrap();

        // fd should no longer be valid
        assert_eq!(sys_read(&mut proc, &mut host, fd, &mut [0u8; 4]).unwrap_err(), Errno::EBADF);
    }

    #[test]
    fn test_memfd_invalid_flags() {
        let mut proc = Process::new(1);
        let result = sys_memfd_create(&mut proc, b"bad", 0xFFFF);
        assert_eq!(result.unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn test_copy_file_range_memfd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        let src = sys_memfd_create(&mut proc, b"src", 0).unwrap();
        let dst = sys_memfd_create(&mut proc, b"dst", 0).unwrap();

        // Write data to source
        sys_write(&mut proc, &mut host, src, b"hello world").unwrap();
        sys_lseek(&mut proc, &mut host, src, 0, SEEK_SET).unwrap();

        // Copy 5 bytes
        let copied = sys_copy_file_range(&mut proc, &mut host, src, None, dst, None, 5).unwrap();
        assert_eq!(copied, 5);

        // Read from destination
        sys_lseek(&mut proc, &mut host, dst, 0, SEEK_SET).unwrap();
        let mut buf = [0u8; 16];
        let n = sys_read(&mut proc, &mut host, dst, &mut buf).unwrap();
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_mremap_shrink_in_place() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::mmap::{MAP_PRIVATE, MAP_ANONYMOUS, PROT_READ, PROT_WRITE};
        // mmap 3 pages
        let addr = proc.memory.mmap_anonymous(0, 0x30000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // Shrink to 1 page
        let new_addr = sys_mremap(&mut proc, addr, 0x30000, 0x10000, 0).unwrap();
        assert_eq!(new_addr, addr);
        assert!(proc.memory.is_mapped(addr));
        assert!(!proc.memory.is_mapped(addr + 0x20000));
    }

    #[test]
    fn test_mremap_grow_in_place() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::mmap::{MAP_PRIVATE, MAP_ANONYMOUS, PROT_READ, PROT_WRITE};
        // mmap 1 page
        let addr = proc.memory.mmap_anonymous(0, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // Grow to 2 pages — should succeed since adjacent space is free
        let new_addr = sys_mremap(&mut proc, addr, 0x10000, 0x20000, 0).unwrap();
        assert_eq!(new_addr, addr);
        assert!(proc.memory.is_mapped(addr + 0x10000));
    }

    #[test]
    fn test_mremap_maymove() {
        let mut proc = Process::new(1);
        use wasm_posix_shared::mmap::{MAP_PRIVATE, MAP_ANONYMOUS, PROT_READ, PROT_WRITE};
        // mmap 1 page
        let addr1 = proc.memory.mmap_anonymous(0, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        // mmap another right next to block growth
        let addr2 = proc.memory.mmap_anonymous(0, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS);
        assert_eq!(addr2, addr1 + 0x10000);
        // Try to grow with MREMAP_MAYMOVE — should move to new location
        let new_addr = sys_mremap(&mut proc, addr1, 0x10000, 0x20000, 1).unwrap();
        assert_ne!(new_addr, addr1); // moved
        assert!(proc.memory.is_mapped(new_addr));
        assert!(!proc.memory.is_mapped(addr1)); // old freed
    }

    // ---- O_CLOFORK / FD_CLOFORK tests ----

    #[test]
    fn test_open_clofork_sets_fd_flag() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/clofork", O_CREAT | O_RDWR | O_CLOFORK, 0o644).unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        assert_ne!(entry.fd_flags & FD_CLOFORK, 0);
        assert_eq!(entry.fd_flags & FD_CLOEXEC, 0); // only CLOFORK, not CLOEXEC
    }

    #[test]
    fn test_open_clofork_and_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/tmp/both", O_CREAT | O_RDWR | O_CLOFORK | O_CLOEXEC, 0o644).unwrap();
        let entry = proc.fd_table.get(fd).unwrap();
        assert_ne!(entry.fd_flags & FD_CLOFORK, 0);
        assert_ne!(entry.fd_flags & FD_CLOEXEC, 0);
    }

    #[test]
    fn test_pipe2_clofork() {
        let mut proc = Process::new(1);
        let (r, w) = sys_pipe2(&mut proc, O_CLOFORK).unwrap();
        let r_entry = proc.fd_table.get(r).unwrap();
        let w_entry = proc.fd_table.get(w).unwrap();
        assert_ne!(r_entry.fd_flags & FD_CLOFORK, 0);
        assert_ne!(w_entry.fd_flags & FD_CLOFORK, 0);
        assert_eq!(r_entry.fd_flags & FD_CLOEXEC, 0);
    }

    #[test]
    fn test_pipe2_clofork_and_cloexec() {
        let mut proc = Process::new(1);
        let (r, w) = sys_pipe2(&mut proc, O_CLOFORK | O_CLOEXEC).unwrap();
        let r_entry = proc.fd_table.get(r).unwrap();
        let w_entry = proc.fd_table.get(w).unwrap();
        assert_eq!(r_entry.fd_flags, FD_CLOFORK | FD_CLOEXEC);
        assert_eq!(w_entry.fd_flags, FD_CLOFORK | FD_CLOEXEC);
    }

    #[test]
    fn test_dup3_clofork() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let new_fd = sys_dup3(&mut proc, &mut host, r, 10, O_CLOFORK).unwrap();
        assert_eq!(new_fd, 10);
        let entry = proc.fd_table.get(new_fd).unwrap();
        assert_ne!(entry.fd_flags & FD_CLOFORK, 0);
        assert_eq!(entry.fd_flags & FD_CLOEXEC, 0);
    }

    #[test]
    fn test_dup3_clofork_and_cloexec() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let new_fd = sys_dup3(&mut proc, &mut host, r, 10, O_CLOFORK | O_CLOEXEC).unwrap();
        let entry = proc.fd_table.get(new_fd).unwrap();
        assert_eq!(entry.fd_flags, FD_CLOFORK | FD_CLOEXEC);
    }

    #[test]
    fn test_fcntl_dupfd_clofork() {
        let mut proc = Process::new(1);
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        let new_fd = sys_fcntl(&mut proc, r, F_DUPFD_CLOFORK, 0).unwrap();
        let entry = proc.fd_table.get(new_fd).unwrap();
        assert_ne!(entry.fd_flags & FD_CLOFORK, 0);
        assert_eq!(entry.fd_flags & FD_CLOEXEC, 0);
    }

    #[test]
    fn test_fcntl_setfd_clofork() {
        let mut proc = Process::new(1);
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        // Initially no flags
        let flags = sys_fcntl(&mut proc, r, F_GETFD, 0).unwrap();
        assert_eq!(flags, 0);
        // Set FD_CLOFORK
        sys_fcntl(&mut proc, r, F_SETFD, FD_CLOFORK).unwrap();
        let flags = sys_fcntl(&mut proc, r, F_GETFD, 0).unwrap();
        assert_eq!(flags as u32 & FD_CLOFORK, FD_CLOFORK);
    }

    #[test]
    fn test_fcntl_setfd_clofork_and_cloexec() {
        let mut proc = Process::new(1);
        let (r, _w) = sys_pipe(&mut proc).unwrap();
        sys_fcntl(&mut proc, r, F_SETFD, FD_CLOFORK | FD_CLOEXEC).unwrap();
        let flags = sys_fcntl(&mut proc, r, F_GETFD, 0).unwrap();
        assert_eq!(flags as u32, FD_CLOFORK | FD_CLOEXEC);
    }

    #[test]
    fn test_fork_skips_clofork_fds() {
        use crate::process_table::ProcessTable;
        let mut table = ProcessTable::new();
        // PID 1 is reserved for the virtual init process; use 100 for the test
        // parent so create_process doesn't collide with the auto-registered init.
        table.create_process(100).unwrap();

        // Create a pipe in the parent
        {
            let parent = table.get_mut(100).unwrap();
            let (_r, _w) = sys_pipe(parent).unwrap();
            // r=fd 0, w=fd 1 (Process::new starts with empty fd table in tests)
            // Mark fd 0 as FD_CLOFORK
            let entry = parent.fd_table.get_mut(0).unwrap();
            entry.fd_flags = FD_CLOFORK;
            // fd 1 stays with no flags
        }

        // Fork
        table.fork_process(100, 101).unwrap();

        // Child should NOT have fd 0 (CLOFORK), but SHOULD have fd 1
        let child = table.get(101).unwrap();
        assert!(child.fd_table.get(0).is_err(), "fd 0 with FD_CLOFORK should not be inherited");
        assert!(child.fd_table.get(1).is_ok(), "fd 1 without FD_CLOFORK should be inherited");
    }

    // ── Procfs integration tests ─────────────────────────────────────────

    #[test]
    fn test_procfs_self_stat_open_read_close() {
        let mut proc = Process::new(1);
        proc.argv.push(b"test".to_vec());
        let mut host = MockHostIO::new();

        // open /proc/self/stat
        let fd = sys_open(&mut proc, &mut host, b"/proc/self/stat", O_RDONLY, 0).unwrap();
        assert!(fd >= 3); // after stdio

        // read content
        let mut buf = [0u8; 1024];
        let n = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert!(n > 0);
        let content = core::str::from_utf8(&buf[..n]).unwrap();
        assert!(content.starts_with("1 (test) R"));

        // lseek back to start and re-read
        let pos = sys_lseek(&mut proc, &mut host, fd, 0, SEEK_SET).unwrap();
        assert_eq!(pos, 0);
        let n2 = sys_read(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n, n2); // same content (snapshot)

        // fstat
        let st = sys_fstat(&mut proc, &mut host, fd).unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_dev, 0x50);

        // close
        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn test_procfs_readlink_self() {
        let mut proc = Process::new(42);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 64];
        let n = sys_readlink(&mut proc, &mut host, b"/proc/self", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"42");
    }

    #[test]
    fn test_procfs_readlink_cwd() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut buf = [0u8; 64];
        let n = sys_readlink(&mut proc, &mut host, b"/proc/self/cwd", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"/");
    }

    #[test]
    fn test_procfs_stat_dir() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let st = sys_stat(&mut proc, &mut host, b"/proc").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFDIR);
        assert_eq!(st.st_mode & 0o777, 0o555);
    }

    #[test]
    fn test_procfs_lstat_self_symlink() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let st = sys_lstat(&mut proc, &mut host, b"/proc/self").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFLNK);
    }

    #[test]
    fn test_procfs_fd_dir_getdents64() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // open /proc/self/fd
        let fd = sys_open(&mut proc, &mut host, b"/proc/self/fd", O_RDONLY | O_DIRECTORY, 0).unwrap();

        // getdents64
        let mut buf = [0u8; 4096];
        let n = sys_getdents64(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert!(n > 0);

        // Subsequent call should return 0 (exhausted)
        let n2 = sys_getdents64(&mut proc, &mut host, fd, &mut buf).unwrap();
        assert_eq!(n2, 0);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn test_procfs_access() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();

        // F_OK should succeed for /proc/self/stat
        sys_access(&mut proc, &mut host, b"/proc/self/stat", 0).unwrap();

        // R_OK should succeed
        sys_access(&mut proc, &mut host, b"/proc/self/stat", 4).unwrap();

        // W_OK should fail
        assert_eq!(
            sys_access(&mut proc, &mut host, b"/proc/self/stat", 2).unwrap_err(),
            Errno::EACCES,
        );
    }

    #[test]
    fn test_procfs_open_write_fails() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        assert_eq!(
            sys_open(&mut proc, &mut host, b"/proc/self/stat", O_WRONLY, 0).unwrap_err(),
            Errno::EACCES,
        );
    }

    #[test]
    fn match_virtual_device_recognizes_fb0() {
        assert_eq!(match_virtual_device(b"/dev/fb0"), Some(VirtualDevice::Fb0));
        // Single-fb only — no /dev/fb1 yet.
        assert_eq!(match_virtual_device(b"/dev/fb1"), None);
    }

    #[test]
    fn fb0_has_unique_host_handle_sentinel() {
        let h = VirtualDevice::Fb0.host_handle();
        assert_eq!(VirtualDevice::from_host_handle(h), Some(VirtualDevice::Fb0));
        assert_ne!(h, VirtualDevice::Null.host_handle());
        assert_ne!(h, VirtualDevice::Zero.host_handle());
        assert_ne!(h, VirtualDevice::Urandom.host_handle());
        assert_ne!(h, VirtualDevice::Full.host_handle());
    }

    #[test]
    fn fb0_stat_is_chr() {
        let st = virtual_device_stat(VirtualDevice::Fb0, 0, 0);
        assert_eq!(st.st_mode & wasm_posix_shared::mode::S_IFMT,
                   wasm_posix_shared::mode::S_IFCHR);
        assert_eq!(st.st_ino, VirtualDevice::Fb0.ino());
    }

    #[test]
    fn fbioget_vscreeninfo_returns_640x400_bgra32() {
        use wasm_posix_shared::fbdev::*;
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let mut buf = [0u8; 160];
        sys_ioctl(&mut proc, fd, FBIOGET_VSCREENINFO, &mut buf).unwrap();
        let v: FbVarScreenInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(v.xres, 640);
        assert_eq!(v.yres, 400);
        assert_eq!(v.bits_per_pixel, 32);
        assert_eq!(v.blue.offset, 0);   assert_eq!(v.blue.length, 8);
        assert_eq!(v.green.offset, 8);  assert_eq!(v.green.length, 8);
        assert_eq!(v.red.offset, 16);   assert_eq!(v.red.length, 8);
        assert_eq!(v.transp.offset, 24); assert_eq!(v.transp.length, 8);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn fbioget_fscreeninfo_reports_correct_smem_len() {
        use wasm_posix_shared::fbdev::*;
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let mut buf = [0u8; 80];
        sys_ioctl(&mut proc, fd, FBIOGET_FSCREENINFO, &mut buf).unwrap();
        let f: FbFixScreenInfo = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const _) };
        assert_eq!(&f.id[..6], b"wasmfb");
        assert_eq!(f.smem_len, 640 * 400 * 4);
        assert_eq!(f.line_length, 640 * 4);
        assert_eq!(f.fb_type, FB_TYPE_PACKED_PIXELS);
        assert_eq!(f.visual, FB_VISUAL_TRUECOLOR);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn fbiopan_display_succeeds() {
        use wasm_posix_shared::fbdev::*;
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let mut buf = [0u8; 160];
        sys_ioctl(&mut proc, fd, FBIOPAN_DISPLAY, &mut buf).unwrap();
        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn fbioput_vscreeninfo_rejects_mismatched_geometry() {
        use wasm_posix_shared::fbdev::*;
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let mut v = FbVarScreenInfo::default();
        v.xres = 320; v.yres = 200; v.bits_per_pixel = 32;
        let mut buf = [0u8; 160];
        unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, v); }
        let err = sys_ioctl(&mut proc, fd, FBIOPUT_VSCREENINFO, &mut buf).unwrap_err();
        assert_eq!(err, Errno::EINVAL);

        // Matching geometry succeeds.
        let mut v = FbVarScreenInfo::default();
        v.xres = 640; v.yres = 400; v.bits_per_pixel = 32;
        unsafe { core::ptr::write_unaligned(buf.as_mut_ptr() as *mut _, v); }
        sys_ioctl(&mut proc, fd, FBIOPUT_VSCREENINFO, &mut buf).unwrap();

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn unknown_fb_ioctl_returns_enotty() {
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let mut buf = [0u8; 160];  // big enough that ENOTTY is the only failure mode
        let err = sys_ioctl(&mut proc, fd, 0x46FF, &mut buf).unwrap_err();
        assert_eq!(err, Errno::ENOTTY);
        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn write_fb0_lazy_binds_and_forwards_pixels() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();

        // Seek to a known offset.
        let off = 640 * 4 * 10; // start of row 10
        let new_off = sys_lseek(&mut proc, &mut host, fd, off as i64, 0).unwrap();
        assert_eq!(new_off, off as i64);

        // First write lazily binds (addr=0/len=0 sentinel) and pushes.
        let pixels: alloc::vec::Vec<u8> = (0..16).map(|i| i as u8).collect();
        let n = sys_write(&mut proc, &mut host, fd, &pixels).unwrap();
        assert_eq!(n, pixels.len());

        // Bind fired exactly once with the sentinel layout.
        assert_eq!(host.bind_framebuffer_calls.len(), 1);
        let b = &host.bind_framebuffer_calls[0];
        assert_eq!((b.pid, b.addr, b.len, b.w, b.h, b.stride),
                   (proc.pid as i32, 0, 0, 640, 400, 640 * 4));

        // fb_write fired with the right offset and length.
        assert_eq!(host.fb_write_calls.len(), 1);
        assert_eq!(host.fb_write_calls[0].pid, proc.pid as i32);
        assert_eq!(host.fb_write_calls[0].offset, off);
        assert_eq!(host.fb_write_calls[0].len, pixels.len());

        // Cursor advanced by the write length.
        let cur = sys_lseek(&mut proc, &mut host, fd, 0, 1 /* SEEK_CUR */).unwrap();
        assert_eq!(cur, (off + pixels.len()) as i64);

        // Second write pushes another delta but does NOT re-bind.
        let _ = sys_write(&mut proc, &mut host, fd, &pixels).unwrap();
        assert_eq!(host.bind_framebuffer_calls.len(), 1);
        assert_eq!(host.fb_write_calls.len(), 2);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn mmap_fb0_records_binding_and_calls_host() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        use wasm_posix_shared::mmap::{MAP_SHARED, PROT_READ, PROT_WRITE};
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let len = (640 * 400 * 4) as usize;
        let addr = sys_mmap(&mut proc, &mut host, 0, len,
                            PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        assert_ne!(addr, 0);
        let b = proc.fb_binding.expect("fb_binding should be Some after mmap");
        assert_eq!(b.addr, addr);
        assert_eq!(b.len, len);
        assert_eq!(b.w, 640);
        assert_eq!(b.h, 400);
        assert_eq!(b.stride, 640 * 4);
        assert_eq!(host.bind_framebuffer_calls.len(), 1);
        let call = &host.bind_framebuffer_calls[0];
        assert_eq!(call.pid, proc.pid as i32);
        assert_eq!(call.addr, addr);
        assert_eq!(call.len, len);
        assert_eq!(call.w, 640);
        assert_eq!(call.h, 400);
        assert_eq!(call.stride, 640 * 4);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn second_mmap_of_fb0_returns_einval() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        use wasm_posix_shared::mmap::{MAP_SHARED, PROT_READ, PROT_WRITE};
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let len = (640 * 400 * 4) as usize;
        let _ = sys_mmap(&mut proc, &mut host, 0, len,
                         PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        let err = sys_mmap(&mut proc, &mut host, 0, len,
                           PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
        assert_eq!(err, Errno::EINVAL);

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn mmap_fb0_with_wrong_length_returns_einval() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        use wasm_posix_shared::mmap::{MAP_SHARED, PROT_READ, PROT_WRITE};
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        // Wrong size — fbDOOM-style code requests smem_len exactly.
        let err = sys_mmap(&mut proc, &mut host, 0, 4096,
                           PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap_err();
        assert_eq!(err, Errno::EINVAL);
        // No host call when validation fails.
        assert!(host.bind_framebuffer_calls.is_empty());

        sys_close(&mut proc, &mut host, fd).unwrap();
    }

    #[test]
    fn munmap_of_fb_region_clears_binding_and_unbinds_host() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        use wasm_posix_shared::mmap::{MAP_SHARED, PROT_READ, PROT_WRITE};
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let len = (640 * 400 * 4) as usize;
        let addr = sys_mmap(&mut proc, &mut host, 0, len,
                            PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        sys_munmap(&mut proc, &mut host, addr, len).unwrap();
        assert!(proc.fb_binding.is_none());
        assert_eq!(host.unbind_framebuffer_calls, alloc::vec![proc.pid as i32]);

        // Closing the fd then releases ownership (no binding remains).
        sys_close(&mut proc, &mut host, fd).unwrap();
        assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), -1);
    }

    #[test]
    fn execve_releases_fb_binding_and_unbinds() {
        use core::sync::atomic::Ordering;
        use wasm_posix_shared::flags::O_RDWR;
        use wasm_posix_shared::mmap::{MAP_SHARED, PROT_READ, PROT_WRITE};
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc = Process::new(1);
        let mut host = TrackingHostIO::new();
        let fd = sys_open(&mut proc, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        let len = (640 * 400 * 4) as usize;
        let _ = sys_mmap(&mut proc, &mut host, 0, len,
                         PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0).unwrap();
        // execve invokes host_exec which the tracking host returns Ok(()) for.
        sys_execve(&mut proc, &mut host, b"/bin/sh").unwrap();
        assert!(proc.fb_binding.is_none());
        assert_eq!(host.unbind_framebuffer_calls, alloc::vec![proc.pid as i32]);
        assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), -1);
    }

    #[test]
    fn open_dev_fb0_is_single_owner() {
        use core::sync::atomic::Ordering;
        crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);

        let mut proc1 = Process::new(1);
        let mut proc2 = Process::new(2);
        let mut host = MockHostIO::new();

        // First open from pid 1 succeeds.
        let fd1 = sys_open(&mut proc1, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();

        // Second open from a different process is EBUSY.
        let err = sys_open(&mut proc2, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap_err();
        assert_eq!(err, Errno::EBUSY);

        // Re-open by the SAME process is allowed.
        let fd1b = sys_open(&mut proc1, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        assert_ne!(fd1, fd1b);

        // After both fds in the owning process close, ownership releases.
        sys_close(&mut proc1, &mut host, fd1).unwrap();
        assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), proc1.pid as i32);
        sys_close(&mut proc1, &mut host, fd1b).unwrap();
        assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), -1);

        // Now another process can open.
        let fd2 = sys_open(&mut proc2, &mut host, b"/dev/fb0", O_RDWR, 0).unwrap();
        sys_close(&mut proc2, &mut host, fd2).unwrap();
        assert_eq!(crate::process_table::FB0_OWNER.load(Ordering::SeqCst), -1);
    }
}
