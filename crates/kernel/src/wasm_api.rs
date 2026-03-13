//! Wasm export layer -- FFI boundary that the TypeScript host calls.
//!
//! This module declares:
//! 1. Host function imports (functions the host must provide).
//! 2. A `WasmHostIO` struct implementing the `HostIO` trait via those imports.
//! 3. Global kernel state (`PROCESS`).
//! 4. Export functions for each syscall.

extern crate alloc;

use core::slice;

use wasm_posix_shared::{Errno, WasmDirent, WasmStat, WasmTimespec};

use crate::ofd::FileType;
use crate::process::{HostIO, Process};
use crate::syscalls;

// ---------------------------------------------------------------------------
// 1. Host function imports
// ---------------------------------------------------------------------------

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i64;
    fn host_close(handle: i64) -> i32;
    fn host_read(handle: i64, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_write(handle: i64, buf_ptr: *const u8, buf_len: u32) -> i32;
    fn host_seek(handle: i64, offset_lo: u32, offset_hi: i32, whence: u32) -> i64;
    fn host_fstat(handle: i64, stat_ptr: *mut u8) -> i32;
    fn host_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_rmdir(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_unlink(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_rename(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_link(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_symlink(target_ptr: *const u8, target_len: u32, link_ptr: *const u8, link_len: u32) -> i32;
    fn host_readlink(path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32;
    fn host_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32;
    fn host_opendir(path_ptr: *const u8, path_len: u32) -> i64;
    fn host_readdir(dir_handle: i64, dirent_ptr: *mut u8, name_ptr: *mut u8, name_len: u32) -> i32;
    fn host_closedir(dir_handle: i64) -> i32;
    fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
    fn host_nanosleep(sec: i64, nsec: i64) -> i32;
    fn host_ftruncate(handle: i64, length: i64) -> i32;
    fn host_fsync(handle: i64) -> i32;
    fn host_fchmod(handle: i64, mode: u32) -> i32;
    fn host_fchown(handle: i64, uid: u32, gid: u32) -> i32;
    fn host_kill(pid: i32, sig: u32) -> i32;
    fn host_exec(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_set_alarm(seconds: u32) -> i32;
    fn host_sigsuspend_wait() -> i32;
    fn host_call_signal_handler(handler_index: u32, signum: u32) -> i32;
    fn host_getrandom(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_utimensat(path_ptr: *const u8, path_len: u32, atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> i32;
    fn host_waitpid(pid: i32, options: u32, status_ptr: *mut i32) -> i32;
    fn host_net_connect(handle: i32, addr_ptr: *const u8, addr_len: u32, port: u32) -> i32;
    fn host_net_send(handle: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_recv(handle: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_close(handle: i32) -> i32;
    fn host_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8, result_len: u32) -> i32;
}

// ---------------------------------------------------------------------------
// 2. WasmHostIO -- bridges HostIO trait to the imported host functions
// ---------------------------------------------------------------------------

struct WasmHostIO;

/// Map a negative i32 return value from the host to an `Errno`.
/// Negative means error; the absolute value is the errno code.
fn i32_to_result(val: i32) -> Result<(), Errno> {
    if val < 0 {
        match Errno::from_u32((-val) as u32) {
            Some(e) => Err(e),
            None => Err(Errno::EIO),
        }
    } else {
        Ok(())
    }
}

impl HostIO for WasmHostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno> {
        let result = unsafe { host_open(path.as_ptr(), path.len() as u32, flags, mode) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_close(handle) };
        i32_to_result(result)
    }

    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_read(handle, buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno> {
        let result = unsafe { host_write(handle, buf.as_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno> {
        let offset_lo = offset as u32;
        let offset_hi = (offset >> 32) as i32;
        let result = unsafe { host_seek(handle, offset_lo, offset_hi, whence) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: 0,
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
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_fstat(handle, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0, st_ino: 0, st_mode: 0, st_nlink: 0, st_uid: 0, st_gid: 0,
            st_size: 0, st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0,
            st_mtime_nsec: 0, st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_stat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0, st_ino: 0, st_mode: 0, st_nlink: 0, st_uid: 0, st_gid: 0,
            st_size: 0, st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0,
            st_mtime_nsec: 0, st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_lstat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_mkdir(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_rmdir(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_unlink(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_rename(
                oldpath.as_ptr(), oldpath.len() as u32,
                newpath.as_ptr(), newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_link(
                oldpath.as_ptr(), oldpath.len() as u32,
                newpath.as_ptr(), newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_symlink(
                target.as_ptr(), target.len() as u32,
                linkpath.as_ptr(), linkpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe {
            host_readlink(path.as_ptr(), path.len() as u32, buf.as_mut_ptr(), buf.len() as u32)
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_chmod(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_chown(path.as_ptr(), path.len() as u32, uid, gid) };
        i32_to_result(result)
    }

    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno> {
        let result = unsafe { host_access(path.as_ptr(), path.len() as u32, amode) };
        i32_to_result(result)
    }

    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno> {
        let result = unsafe { host_opendir(path.as_ptr(), path.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_readdir(&mut self, handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
        let mut dirent = WasmDirent { d_ino: 0, d_type: 0, d_namlen: 0 };
        let dirent_ptr = &mut dirent as *mut WasmDirent as *mut u8;
        let result = unsafe {
            host_readdir(handle, dirent_ptr, name_buf.as_mut_ptr(), name_buf.len() as u32)
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else if result == 0 {
            Ok(None)
        } else {
            Ok(Some((dirent.d_ino, dirent.d_type, dirent.d_namlen as usize)))
        }
    }

    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_closedir(handle) };
        i32_to_result(result)
    }

    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), Errno> {
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        let result = unsafe {
            host_clock_gettime(clock_id, &mut sec as *mut i64, &mut nsec as *mut i64)
        };
        i32_to_result(result)?;
        Ok((sec, nsec))
    }

    fn host_nanosleep(&mut self, seconds: i64, nanoseconds: i64) -> Result<(), Errno> {
        let result = unsafe { host_nanosleep(seconds, nanoseconds) };
        i32_to_result(result)
    }

    fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno> {
        let result = unsafe { host_ftruncate(handle, length) };
        i32_to_result(result)
    }

    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_fsync(handle) };
        i32_to_result(result)
    }

    fn host_fchmod(&mut self, handle: i64, mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchmod(handle, mode) };
        i32_to_result(result)
    }

    fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchown(handle, uid, gid) };
        i32_to_result(result)
    }

    fn host_kill(&mut self, pid: i32, sig: u32) -> Result<(), Errno> {
        let ret = unsafe { host_kill(pid, sig) };
        if ret < 0 {
            match Errno::from_u32((-ret) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(())
        }
    }

    fn host_exec(&mut self, path: &[u8]) -> Result<(), Errno> {
        let ret = unsafe { host_exec(path.as_ptr(), path.len() as u32) };
        if ret < 0 {
            match Errno::from_u32((-ret) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(())
        }
    }

    fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno> {
        let result = unsafe { host_set_alarm(seconds) };
        i32_to_result(result)
    }

    fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
        let result = unsafe { host_sigsuspend_wait() };
        if result < 0 {
            Err(Errno::from_u32((-result) as u32).unwrap_or(Errno::EINTR))
        } else {
            Ok(result as u32)
        }
    }

    fn host_call_signal_handler(&mut self, handler_index: u32, signum: u32) -> Result<(), Errno> {
        let result = unsafe { host_call_signal_handler(handler_index, signum) };
        i32_to_result(result)
    }

    fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getrandom(buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_utimensat(&mut self, path: &[u8], atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> Result<(), Errno> {
        let result = unsafe { host_utimensat(path.as_ptr(), path.len() as u32, atime_sec, atime_nsec, mtime_sec, mtime_nsec) };
        i32_to_result(result)
    }
    fn host_waitpid(&mut self, pid: i32, options: u32) -> Result<(i32, i32), Errno> {
        let mut status: i32 = 0;
        let result = unsafe { host_waitpid(pid, options, &mut status) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok((result, status))
        }
    }

    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno> {
        let result = unsafe { host_net_connect(handle, addr.as_ptr(), addr.len() as u32, port as u32) };
        i32_to_result(result)
    }

    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno> {
        let result = unsafe { host_net_send(handle, data.as_ptr(), data.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_recv(&mut self, handle: i32, _len: u32, flags: u32, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_net_recv(handle, buf.as_mut_ptr(), buf.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_net_close(handle) };
        i32_to_result(result)
    }

    fn host_getaddrinfo(&mut self, name: &[u8], result_buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getaddrinfo(name.as_ptr(), name.len() as u32, result_buf.as_mut_ptr(), result_buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Global kernel state
// ---------------------------------------------------------------------------

use core::cell::UnsafeCell;

/// Wrapper to allow `UnsafeCell<Option<Process>>` in a `static`.
/// Sound because Wasm is single-threaded within an instance.
struct GlobalProcess(UnsafeCell<Option<Process>>);

/// SAFETY: Wasm instances are single-threaded; no concurrent access occurs.
unsafe impl Sync for GlobalProcess {}

static PROCESS: GlobalProcess = GlobalProcess(UnsafeCell::new(None));

/// Helper to get a mutable reference to the global process, trapping if
/// `kernel_init` has not been called.
///
/// SAFETY: Caller must ensure no aliasing references exist. This is
/// guaranteed by Wasm's single-threaded execution model and the fact that
/// each exported function borrows the process for its own duration only.
#[inline]
unsafe fn get_process() -> &'static mut Process {
    let ptr = PROCESS.0.get();
    match unsafe { &mut *ptr } {
        Some(p) => p,
        None => core::arch::wasm32::unreachable(),
    }
}

// ---------------------------------------------------------------------------
// 3b. Memory growth helper
// ---------------------------------------------------------------------------

/// Grow Wasm memory if `end_addr` exceeds the current memory size.
/// Wasm pages are 64KB each. Returns true if memory was sufficient or grown.
#[cfg(target_arch = "wasm32")]
fn ensure_memory_covers(end_addr: u32) {
    let current_pages = core::arch::wasm32::memory_size(0) as u32;
    let current_bytes = current_pages * 65536;
    if end_addr > current_bytes {
        let needed_pages = (end_addr - current_bytes + 65535) / 65536;
        core::arch::wasm32::memory_grow(0, needed_pages as usize);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn ensure_memory_covers(_end_addr: u32) {
    // No-op on non-Wasm targets (tests)
}

// 3c. Signal delivery at syscall boundaries
// ---------------------------------------------------------------------------

/// Check for and deliver pending signals before/after syscall.
fn deliver_pending_signals(proc: &mut Process, host: &mut WasmHostIO) {
    use crate::signal::{DefaultAction, default_action, SignalHandler};
    while let Some(signum) = proc.signals.dequeue() {
        if proc.state == crate::process::ProcessState::Exited {
            break;
        }
        match proc.signals.get_handler(signum) {
            SignalHandler::Handler(idx) => {
                let _ = host.host_call_signal_handler(idx, signum);
            }
            SignalHandler::Default => {
                match default_action(signum) {
                    DefaultAction::Terminate | DefaultAction::CoreDump => {
                        proc.state = crate::process::ProcessState::Exited;
                        proc.exit_status = 128 + signum as i32;
                    }
                    _ => {}
                }
            }
            SignalHandler::Ignore => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Exported kernel functions
// ---------------------------------------------------------------------------

/// Initialize the kernel with a new process.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init(pid: u32) {
    unsafe {
        *PROCESS.0.get() = Some(Process::new(pid));
    }
}

/// Serialize current process state for fork. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_fork_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Initialize kernel from serialized fork state (child side).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init_from_fork(buf_ptr: *const u8, buf_len: u32, child_pid: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match crate::fork::deserialize_fork_state(buf, child_pid) {
        Ok(proc) => {
            unsafe { *PROCESS.0.get() = Some(proc); }
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Serialize exec-safe state. Returns bytes written on success, negative errno on error.
/// Exec state differs from fork: closes CLOEXEC fds, resets caught signal handlers,
/// preserves pending signals and signal mask.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_exec_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_exec_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Initialize kernel from exec state (replaces current process image).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init_from_exec(buf_ptr: *const u8, buf_len: u32, pid: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match crate::fork::deserialize_exec_state(buf, pid) {
        Ok(proc) => {
            unsafe { *PROCESS.0.get() = Some(proc); }
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Convert a pipe's OFD from kernel-internal to host-delegated.
/// After this, reads/writes for this OFD will go through host_read/host_write.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_convert_pipe_to_host(ofd_idx: u32, new_host_handle: i64) -> i32 {
    let proc = unsafe { get_process() };
    let ofd = match proc.ofd_table.get_mut(ofd_idx as usize) {
        Some(ofd) => ofd,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Pipe {
        return -(Errno::EINVAL as i32);
    }
    ofd.host_handle = new_host_handle;
    0
}

/// Open a file. Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_open(
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
    mode: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Close a file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_close(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_close(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read from a file descriptor. Returns bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_read(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_read(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Write to a file descriptor. Returns bytes written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_write(fd: i32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_write(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Seek within a file. The 64-bit offset is passed as two 32-bit halves
/// because some Wasm host bindings lack native i64 support.
/// Returns the new offset (i64) or negative errno (i64).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lseek(fd: i32, offset_lo: u32, offset_hi: i32, whence: u32) -> i64 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_lseek(proc, &mut host, fd, offset, whence) {
        Ok(pos) => pos,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pread - read at offset without modifying position. Returns bytes read or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pread(fd: i32, buf_ptr: *mut u8, buf_len: u32, offset_lo: u32, offset_hi: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_pread(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pwrite - write at offset without modifying position. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pwrite(fd: i32, buf_ptr: *const u8, buf_len: u32, offset_lo: u32, offset_hi: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_pwrite(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor. Returns new fd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_dup(proc, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup2(oldfd: i32, newfd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_dup2(proc, &mut host, oldfd, newfd) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a pipe. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe(fildes_ptr: *mut i32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_pipe(proc) {
        Ok((read_fd, write_fd)) => {
            unsafe {
                *fildes_ptr = read_fd;
                *fildes_ptr.add(1) = write_fd;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd with flags.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup3(oldfd: i32, newfd: i32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_dup3(proc, &mut host, oldfd, newfd, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a pipe with flags. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe2(flags: u32, fd_ptr: *mut i32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_pipe2(proc, flags) {
        Ok((r, w)) => {
            unsafe {
                *fd_ptr = r;
                *fd_ptr.add(1) = w;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get file status. Writes a `WasmStat` struct to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstat(fd: i32, stat_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstat(proc, &mut host, fd) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fcntl operations. Returns result (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl(fd: i32, cmd: u32, arg: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_fcntl(proc, fd, cmd, arg) {
        Ok(val) => val,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// fcntl lock operations. The flock struct is read from/written to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl_lock(fd: i32, cmd: u32, flock_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let flock = unsafe { &mut *(flock_ptr as *mut wasm_posix_shared::WasmFlock) };
    let result = match syscalls::sys_fcntl_lock(proc, fd, cmd, flock) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// BSD flock() — whole-file advisory locking.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_flock(fd: i32, operation: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_flock(proc, fd, operation) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Stat a file by path. Writes a `WasmStat` struct to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_stat(proc, &mut host, path) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Lstat a file by path (does not follow symlinks). Writes a `WasmStat` struct.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_lstat(proc, &mut host, path) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mkdir(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remove a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rmdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rmdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Unlink (delete) a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlink(path_ptr: *const u8, path_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_unlink(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Rename a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rename(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rename(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a hard link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_link(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_link(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a symbolic link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlink(
    target_ptr: *const u8,
    target_len: u32,
    link_ptr: *const u8,
    link_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_symlink(proc, &mut host, target, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read a symbolic link. Returns bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlink(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readlink(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file permissions. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chmod(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file ownership. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chown(proc, &mut host, path, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Check file accessibility. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_access(proc, &mut host, path, amode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change working directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change directory by file descriptor. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchdir(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchdir(proc, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get current working directory. Returns length written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getcwd(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getcwd(proc, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Open a directory for reading. Returns dir handle (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_opendir(path_ptr: *const u8, path_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_opendir(proc, &mut host, path) {
        Ok(dh) => dh,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read next directory entry. Returns 1 if entry read, 0 if end, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readdir(
    dir_handle: i32,
    dirent_ptr: *mut u8,
    name_ptr: *mut u8,
    name_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let dirent_buf = unsafe {
        slice::from_raw_parts_mut(dirent_ptr, core::mem::size_of::<WasmDirent>())
    };
    let name_buf = unsafe { slice::from_raw_parts_mut(name_ptr, name_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readdir(proc, &mut host, dir_handle, dirent_buf, name_buf) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Close a directory stream. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_closedir(dir_handle: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_closedir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read directory entries in linux_dirent64 format. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getdents64(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getdents64(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Rewind a directory stream to the beginning. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rewinddir(dir_handle: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rewinddir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Return current position in a directory stream. Returns position (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_telldir(dir_handle: i32) -> i64 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_telldir(proc, dir_handle) {
        Ok(pos) => pos as i64,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Seek to a position in a directory stream. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seekdir(dir_handle: i32, loc_lo: u32, loc_hi: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let loc = (loc_hi as u64) << 32 | (loc_lo as u64);
    let result = match syscalls::sys_seekdir(proc, &mut host, dir_handle, loc) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpid() -> i32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getpid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the parent process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getppid() -> i32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getppid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the real user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getuid() -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_geteuid() -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_geteuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the real group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgid() -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getgid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getegid() -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getegid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the process group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpgrp() -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_getpgrp(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set the process group ID. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setpgid(pid: u32, pgid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setpgid(proc, pid, pgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the session ID. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsid(pid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_getsid(proc, pid) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a new session. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsid() -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setsid(proc) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Send a signal to a process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kill(pid: i32, sig: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_kill(proc, &mut host, pid, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Deliver a signal from an external source (host). Called by host when
/// another process sends a signal to this one via kill().
/// Returns 0 on success, -EINVAL for invalid signal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_deliver_signal(sig: u32) -> i32 {
    let proc = unsafe { get_process() };
    if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
        return -(Errno::EINVAL as i32);
    }
    proc.signals.raise(sig);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// Send a signal to the current process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_raise(sig: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_raise(proc, &mut host, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set signal handler. Returns old handler value (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigaction(sig: u32, handler: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_sigaction(proc, sig, handler) {
        Ok(old) => old as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// signal() — set signal handler (legacy API). Returns old handler or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signal(signum: u32, handler: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_signal(proc, signum, handler) {
        Ok(old) => old,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Manipulate the signal mask. The 64-bit set is passed as two 32-bit halves.
/// Returns old mask as i64 (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigprocmask(how: u32, set_lo: u32, set_hi: u32) -> i64 {
    let proc = unsafe { get_process() };
    let set = ((set_hi as u64) << 32) | (set_lo as u64);
    let result = match syscalls::sys_sigprocmask(proc, how, set) {
        Ok(old) => old as i64,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the current time from a clock source.
/// Writes a WasmTimespec struct to ts_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_gettime(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_gettime(proc, &mut host, clock_id) {
        Ok(ts) => {
            let ts_bytes = unsafe {
                slice::from_raw_parts(
                    &ts as *const WasmTimespec as *const u8,
                    core::mem::size_of::<WasmTimespec>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Sleep for a specified duration.
/// Reads a WasmTimespec struct from req_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_nanosleep(req_ptr: *const u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_nanosleep(proc, &mut host, req) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get clock resolution. Returns 0 or negative errno. Writes WasmTimespec to ts_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_getres(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_getres(proc, clock_id) {
        Ok(ts) => {
            if !ts_ptr.is_null() {
                let ts_bytes = unsafe {
                    slice::from_raw_parts(
                        &ts as *const WasmTimespec as *const u8,
                        core::mem::size_of::<WasmTimespec>(),
                    )
                };
                unsafe {
                    core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
                }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Sleep with clock selection. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_nanosleep(clock_id: u32, flags: u32, req_ptr: *const u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_clock_nanosleep(proc, &mut host, clock_id, flags, req) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set file timestamps. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_utimensat(dirfd: i32, path_ptr: *const u8, path_len: u32, times_ptr: *const u8, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let times = if times_ptr.is_null() {
        None
    } else {
        Some(unsafe { &*(times_ptr as *const [WasmTimespec; 2]) })
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_utimensat(proc, &mut host, dirfd, path, times, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remap memory. Returns MAP_FAILED (-1 as u32) since Wasm doesn't support this.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mremap(old_addr: u32, old_len: u32, new_len: u32, flags: u32) -> u32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mremap(proc, old_addr, old_len, new_len, flags) {
        Ok(addr) => addr,
        Err(e) => (-(e as i32)) as u32,
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Memory advice hint. No-op, returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_madvise(addr: u32, len: u32, advice: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_madvise(proc, addr, len, advice) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// statfs — get filesystem statistics. Writes WasmStatfs struct to buf_ptr.
/// Returns 0 on success.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_statfs(path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let _path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let statfs = syscalls::sys_statfs(proc);
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
    let bytes = unsafe { core::slice::from_raw_parts(&statfs as *const _ as *const u8, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
    buf.copy_from_slice(bytes);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// fstatfs — get filesystem statistics for an open fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatfs(fd: i32, buf_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstatfs(proc, fd) {
        Ok(statfs) => {
            let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
            let bytes = unsafe { core::slice::from_raw_parts(&statfs as *const _ as *const u8, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
            buf.copy_from_slice(bytes);
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// setresuid — set real, effective, and saved user IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresuid(ruid: u32, euid: u32, suid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setresuid(proc, ruid, euid, suid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getresuid — get real, effective, and saved user IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresuid(ruid_ptr: *mut u32, euid_ptr: *mut u32, suid_ptr: *mut u32) -> i32 {
    let proc = unsafe { get_process() };
    let (ruid, euid, suid) = syscalls::sys_getresuid(proc);
    unsafe {
        *ruid_ptr = ruid;
        *euid_ptr = euid;
        *suid_ptr = suid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// setresgid — set real, effective, and saved group IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresgid(rgid: u32, egid: u32, sgid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setresgid(proc, rgid, egid, sgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getresgid — get real, effective, and saved group IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresgid(rgid_ptr: *mut u32, egid_ptr: *mut u32, sgid_ptr: *mut u32) -> i32 {
    let proc = unsafe { get_process() };
    let (rgid, egid, sgid) = syscalls::sys_getresgid(proc);
    unsafe {
        *rgid_ptr = rgid;
        *egid_ptr = egid;
        *sgid_ptr = sgid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// getgroups — get supplementary group IDs.
/// Returns count on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgroups(size: u32, list_ptr: *mut u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_getgroups(proc, size) {
        Ok((count, gid)) => {
            if size > 0 {
                unsafe { *list_ptr = gid; }
            }
            count as i32
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setgroups — set supplementary group IDs (no-op).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgroups(size: u32, _list_ptr: *const u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setgroups(proc, size) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// sendmsg — send a message on a socket.
/// Parses msghdr to extract iov[0] and delegates to sys_sendmsg.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendmsg(fd: i32, msg_ptr: *const u8, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_iov at offset 8, msg_iovlen at offset 12
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Parse first iovec: iov_base at offset 0, iov_len at offset 4
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts(base as *const u8, len) };
    let result = match syscalls::sys_sendmsg(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// recvmsg — receive a message from a socket.
/// Parses msghdr to extract iov[0] and delegates to sys_recvmsg.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvmsg(fd: i32, msg_ptr: *mut u8, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_iov at offset 8, msg_iovlen at offset 12
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Parse first iovec
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len) };
    let result = match syscalls::sys_recvmsg(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    // Zero out msg_controllen to indicate no ancillary data
    let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, 28) };
    msg_mut[20..24].copy_from_slice(&0u32.to_le_bytes());
    deliver_pending_signals(proc, &mut host);
    result
}

/// wait4 — wait for child process. Writes status to wstatus_ptr, ignores rusage.
/// Returns child pid on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_wait4(pid: i32, wstatus_ptr: *mut i32, options: u32, _rusage_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_waitpid(proc, &mut host, pid, options) {
        Ok((child_pid, status)) => {
            if !wstatus_ptr.is_null() {
                unsafe { *wstatus_ptr = status; }
            }
            child_pid
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Check if a file descriptor refers to a terminal.
/// Returns 1 if terminal, or negative errno on error (ENOTTY if not a terminal).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_isatty(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_isatty(proc, fd) {
        Ok(v) => v,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get an environment variable by name.
/// Returns the length of the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getenv(
    name_ptr: *const u8,
    name_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getenv(proc, name, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setenv(
    name_ptr: *const u8,
    name_len: u32,
    val_ptr: *const u8,
    val_len: u32,
    overwrite: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let value = unsafe { slice::from_raw_parts(val_ptr, val_len as usize) };
    let result = match syscalls::sys_setenv(proc, name, value, overwrite != 0) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remove an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unsetenv(name_ptr: *const u8, name_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result = match syscalls::sys_unsetenv(proc, name) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Argv support — host pushes args, program reads them at startup
// ---------------------------------------------------------------------------

/// Push an argument string. Called by host before _start.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_push_argv(ptr: *const u8, len: u32) {
    let proc = unsafe { get_process() };
    let data = unsafe { slice::from_raw_parts(ptr, len as usize) };
    proc.argv.push(data.to_vec());
}

/// Return the number of arguments.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_argc() -> u32 {
    let proc = unsafe { get_process() };
    proc.argv.len() as u32
}

/// Copy argument at `index` into `buf_ptr`. Returns bytes written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_argv_read(index: u32, buf_ptr: *mut u8, buf_max: u32) -> u32 {
    let proc = unsafe { get_process() };
    if let Some(arg) = proc.argv.get(index as usize) {
        let len = arg.len().min(buf_max as usize);
        let dst = unsafe { slice::from_raw_parts_mut(buf_ptr, len) };
        dst.copy_from_slice(&arg[..len]);
        len as u32
    } else {
        0
    }
}

/// getrandom — fill buffer with random bytes from the host.
/// Returns number of bytes written, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrandom(buf_ptr: *mut u8, buf_len: u32, _flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match host.host_getrandom(buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// mmap. Returns address or MAP_FAILED (0xFFFFFFFF).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mmap(addr: u32, len: u32, prot: u32, flags: u32, fd: i32, offset_lo: u32, offset_hi: i32) -> u32 {
    let proc = unsafe { get_process() };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_mmap(proc, addr, len, prot, flags, fd, offset) {
        Ok(a) => a,
        Err(_) => wasm_posix_shared::mmap::MAP_FAILED,
    };

    // Ensure Wasm memory covers the mapped region.
    if result != wasm_posix_shared::mmap::MAP_FAILED {
        let end = result.saturating_add(len);
        ensure_memory_covers(end);
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// munmap. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_munmap(addr: u32, len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_munmap(proc, addr, len) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// brk. Returns the current or new program break.
/// Grows Wasm memory if the new break exceeds the current memory size.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_brk(addr: u32) -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_brk(proc, addr);

    // Ensure Wasm memory covers the new program break.
    if result > 0 {
        ensure_memory_covers(result);
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// mprotect. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mprotect(addr: u32, len: u32, prot: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_mprotect(proc, addr, len, prot) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Exit the process. Closes all fds and dir streams, sets state to Exited.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exit(status: i32) {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    syscalls::sys_exit(proc, &mut host, status);
    // No signal delivery after exit -- process is already terminated.
}

/// Get the exit status of the current process (set by kernel_exit).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_exit_status() -> i32 {
    let proc = unsafe { get_process() };
    proc.exit_status
}

// ---------------------------------------------------------------------------
// Socket and poll exports
// ---------------------------------------------------------------------------

/// Create a socket. Returns fd or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socket(domain: u32, sock_type: u32, protocol: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socket(proc, &mut host, domain, sock_type, protocol) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a connected pair of sockets. Returns 0 on success, negative errno on error.
/// Writes the two fds to sv_ptr[0] and sv_ptr[1].
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socketpair(domain: u32, sock_type: u32, protocol: u32, sv_ptr: *mut i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socketpair(proc, &mut host, domain, sock_type, protocol) {
        Ok((fd0, fd1)) => {
            unsafe {
                *sv_ptr = fd0;
                *sv_ptr.add(1) = fd1;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Bind a socket to an address. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_bind(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_bind(proc, fd, addr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Listen for connections. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_listen(fd: i32, backlog: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_listen(proc, fd, backlog) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Accept a connection. Returns new fd or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_accept(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_accept(proc, &mut host, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Connect to an address. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_connect(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_connect(proc, &mut host, fd, addr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Send data on a socket. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_send(fd: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_send(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Receive data from a socket. Returns bytes received or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recv(fd: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_recv(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Shut down a socket. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_shutdown(fd: i32, how: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_shutdown(proc, &mut host, fd, how) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get socket option. Returns 0 on success, negative errno on error.
/// Writes the option value to optval_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockopt(fd: i32, level: u32, optname: u32, optval_ptr: *mut u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_getsockopt(proc, fd, level, optname) {
        Ok(val) => {
            unsafe { *optval_ptr = val; }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set socket option. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsockopt(fd: i32, level: u32, optname: u32, optval: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setsockopt(proc, fd, level, optname, optval) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Poll file descriptors. Returns number of ready fds, or negative errno.
/// fds_ptr points to an array of WasmPollFd structs (8 bytes each: i32 fd, i16 events, i16 revents).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_poll(fds_ptr: *mut u8, nfds: u32, timeout: i32) -> i32 {
    let proc = unsafe { get_process() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_poll(proc, &mut host, fds, timeout) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Send data to a specific address. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendto(
    fd: i32,
    buf_ptr: *const u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *const u8,
    addr_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_sendto(proc, &mut host, fd, buf, flags, addr) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Receive data with sender address. Returns bytes received or negative errno.
/// Writes sender address to addr_ptr and address length to addr_len_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvfrom(
    fd: i32,
    buf_ptr: *mut u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *mut u8,
    addr_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let addr_buf = unsafe { slice::from_raw_parts_mut(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_recvfrom(proc, &mut host, fd, buf, flags, addr_buf) {
        Ok((n, _addr_len)) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// time() - returns seconds since epoch as i64.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_time() -> i64 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_time(proc, &mut host) {
        Ok(t) => t,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// gettimeofday() - writes sec and usec to the given pointers.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_gettimeofday(sec_ptr: *mut i64, usec_ptr: *mut i64) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_gettimeofday(proc, &mut host) {
        Ok((sec, usec)) => {
            unsafe {
                *sec_ptr = sec;
                *usec_ptr = usec;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// usleep() - sleep for usec microseconds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_usleep(usec: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_usleep(proc, &mut host, usec) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// openat() - open relative to directory fd.
/// Returns fd on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_openat(dirfd: i32, path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_openat(proc, &mut host, dirfd, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fstatat() - stat relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatat(dirfd: i32, path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fstatat(proc, &mut host, dirfd, path, flags) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// unlinkat() - unlink relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlinkat(dirfd: i32, path_ptr: *const u8, path_len: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_unlinkat(proc, &mut host, dirfd, path, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// mkdirat() - mkdir relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdirat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_mkdirat(proc, &mut host, dirfd, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// renameat() - rename relative to directory fds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_renameat(olddirfd: i32, old_ptr: *const u8, old_len: u32, newdirfd: i32, new_ptr: *const u8, new_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result = match syscalls::sys_renameat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Terminal / ioctl exports
// ---------------------------------------------------------------------------

/// Get terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcgetattr(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcgetattr(proc, fd, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcsetattr(fd: i32, action: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcsetattr(proc, fd, action, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Perform an ioctl operation. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ioctl(fd: i32, request: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_ioctl(proc, fd, request, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set file creation mask. Returns the previous mask value.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_umask(mask: u32) -> u32 {
    let proc = unsafe { get_process() };
    let result = syscalls::sys_umask(proc, mask);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get system identification. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_uname(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_uname(buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get configurable system variables. Returns the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sysconf(name: i32) -> i64 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_sysconf(name) {
        Ok(val) => val,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Truncate a file to a specified length. Returns 0 on success, or negative errno on error.
/// The 64-bit length is passed as two 32-bit halves for Wasm compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ftruncate(fd: i32, length_lo: u32, length_hi: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let length = ((length_hi as i64) << 32) | (length_lo as u64 as i64);
    let result = match syscalls::sys_ftruncate(proc, &mut host, fd, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Synchronize file state to storage. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fsync(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fsync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Truncate a file to a specified length (path-based). Returns 0 on success, or negative errno on error.
/// The 64-bit length is passed as two 32-bit halves for Wasm compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_truncate(path_ptr: *const u8, path_len: u32, length_lo: u32, length_hi: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let length = ((length_hi as i64) << 32) | (length_lo as u64 as i64);
    let result = match syscalls::sys_truncate(proc, &mut host, path, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Synchronize file data to storage (alias for fsync). Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fdatasync(fd: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fdatasync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file mode via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmod(fd: i32, mode: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchmod(proc, &mut host, fd, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file owner and group via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchown(fd: i32, uid: u32, gid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchown(proc, &mut host, fd, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Write data from multiple buffers (scatter-gather I/O).
/// iov_ptr points to an array of iovec structs, each 8 bytes: (iov_base: u32, iov_len: u32).
/// Returns total bytes written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_writev(fd: i32, iov_ptr: *const u8, iovcnt: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts(base as *const u8, len as usize) };
            match syscalls::sys_write(proc, &mut host, fd, buf) {
                Ok(n) => {
                    total += n;
                    if n < len as usize {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read data into multiple buffers (scatter-gather I/O).
/// iov_ptr points to an array of iovec structs, each 8 bytes: (iov_base: u32, iov_len: u32).
/// Returns total bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readv(fd: i32, iov_ptr: *mut u8, iovcnt: i32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len as usize) };
            match syscalls::sys_read(proc, &mut host, fd, buf) {
                Ok(n) => {
                    total += n;
                    if n < len as usize || n == 0 {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get resource limits. Writes soft and hard limits as two u64 LE values (16 bytes) to rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrlimit(resource: u32, rlim_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_getrlimit(proc, resource) {
        Ok((soft, hard)) => {
            let buf = unsafe { core::slice::from_raw_parts_mut(rlim_ptr, 16) };
            buf[0..8].copy_from_slice(&soft.to_le_bytes());
            buf[8..16].copy_from_slice(&hard.to_le_bytes());
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set resource limits. Reads soft and hard limits as two u64 LE values (16 bytes) from rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setrlimit(resource: u32, rlim_ptr: *const u8) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts(rlim_ptr, 16) };
    let soft = u64::from_le_bytes([buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7]]);
    let hard = u64::from_le_bytes([buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]]);
    let result = match syscalls::sys_setrlimit(proc, resource, soft, hard) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: Remaining *at() variants
// ---------------------------------------------------------------------------

/// faccessat — check file accessibility relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_faccessat(dirfd: i32, path_ptr: *const u8, path_len: u32, amode: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_faccessat(proc, &mut host, dirfd, path, amode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fchmodat — change file mode relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmodat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchmodat(proc, &mut host, dirfd, path, mode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fchownat — change file owner/group relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchownat(dirfd: i32, path_ptr: *const u8, path_len: u32, uid: u32, gid: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchownat(proc, &mut host, dirfd, path, uid, gid, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// linkat — create hard link relative to directory fds.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_linkat(olddirfd: i32, old_ptr: *const u8, old_len: u32, newdirfd: i32, new_ptr: *const u8, new_len: u32, flags: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result = match syscalls::sys_linkat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// symlinkat — create symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlinkat(target_ptr: *const u8, target_len: u32, newdirfd: i32, link_ptr: *const u8, link_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let result = match syscalls::sys_symlinkat(proc, &mut host, target, newdirfd, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// readlinkat — read symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlinkat(dirfd: i32, path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_readlinkat(proc, &mut host, dirfd, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: select()
// ---------------------------------------------------------------------------

/// select — synchronous I/O multiplexing.
///
/// Each fd_set is 128 bytes (1024 bits). Null pointer means that set is not used.
/// Returns number of ready fds, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_select(
    nfds: i32,
    readfds_ptr: *mut u8,
    writefds_ptr: *mut u8,
    exceptfds_ptr: *mut u8,
    timeout_ms: i32,
) -> i32 {
    let proc = unsafe { get_process() };

    let readfds = if readfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(readfds_ptr, 128) })
    };
    let writefds = if writefds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(writefds_ptr, 128) })
    };
    let exceptfds = if exceptfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(exceptfds_ptr, 128) })
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_select(proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: setuid/setgid/seteuid/setegid
// ---------------------------------------------------------------------------

/// setuid — set real and effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setuid(uid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setuid(proc, uid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setgid — set real and effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgid(gid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setgid(proc, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// seteuid — set effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seteuid(euid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_seteuid(proc, euid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setegid — set effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setegid(egid: u32) -> i32 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_setegid(proc, egid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: getrusage
// ---------------------------------------------------------------------------

/// getrusage — get resource usage. Writes 144-byte rusage struct.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrusage(who: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getrusage(proc, who, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// realpath
// ---------------------------------------------------------------------------

/// realpath — resolve canonical path. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_realpath(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_realpath(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// execve
// ---------------------------------------------------------------------------

/// Execute a new program. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_execve(path_ptr: *const u8, path_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_execve(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// alarm
// ---------------------------------------------------------------------------

/// Schedule a SIGALRM after `seconds` seconds.
/// Returns the number of seconds remaining from a previous alarm, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alarm(seconds: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_alarm(proc, &mut host, seconds) {
        Ok(remaining) => remaining as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// sigsuspend
// ---------------------------------------------------------------------------

/// Temporarily replace the signal mask and suspend until a signal is delivered.
/// The mask is passed as two u32 halves (lo, hi) to form a u64.
/// Always returns negative EINTR on success (signal was delivered).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigsuspend(mask_lo: u32, mask_hi: u32) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    let result = match syscalls::sys_sigsuspend(proc, &mut host, mask) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pause -- suspend until a signal is delivered.
/// Always returns negative EINTR.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pause() -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pause(proc, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pathconf -- get configurable pathname variable for a path.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pathconf(path_ptr: u32, path_len: u32, name: i32) -> i64 {
    let proc = unsafe { get_process() };
    let path = unsafe {
        core::slice::from_raw_parts(path_ptr as *const u8, path_len as usize)
    };
    let result = match syscalls::sys_pathconf(path, name) {
        Ok(v) => v,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// fpathconf -- get configurable pathname variable for an open fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fpathconf(fd: i32, name: i32) -> i64 {
    let proc = unsafe { get_process() };
    let result = match syscalls::sys_fpathconf(proc, fd, name) {
        Ok(v) => v,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getsockname -- get local socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockname(fd: i32, buf_ptr: u32, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, buf_len as usize)
    };
    let result = match syscalls::sys_getsockname(proc, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getpeername -- get remote socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpeername(fd: i32, buf_ptr: u32, buf_len: u32) -> i32 {
    let proc = unsafe { get_process() };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, buf_len as usize)
    };
    let result = match syscalls::sys_getpeername(proc, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Resolve a hostname to an IP address. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result_buf = unsafe { slice::from_raw_parts_mut(result_ptr, 16) };
    match syscalls::sys_getaddrinfo(proc, &mut host, name, result_buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}
