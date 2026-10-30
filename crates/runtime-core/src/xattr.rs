//! Extended attribute syscalls (`getxattr(2)`, `setxattr(2)`, `listxattr(2)`,
//! `removexattr(2)` and their `l` and `f` variants).
//!
//! POSIX does not define extended attributes; this follows Linux. The
//! exchange filesystem stores `user.` attributes (see `exchange::xattr`).
//! Every other Kandelo filesystem behaves as a Linux filesystem without xattr
//! handlers does: get, set, and remove fail with ENOTSUP, and list succeeds
//! with an empty list, which is the truth.
//!
//! Argument checks keep Linux's order. `setxattr` validates its flags, name,
//! and size before resolving the path (Linux copies them in first); the other
//! calls resolve the path or descriptor first and then validate the name.
//! Path errors are exactly those of `stat` (or `lstat` for the `l` variants),
//! and a descriptor must be open and not `O_PATH` (Linux `fdget`). One
//! difference: a name longer than 255 bytes is rejected with ERANGE by the
//! host's argument marshalling, before any path is resolved.

use alloc::vec::Vec;
use wasm_posix_shared::access::{R_OK, W_OK};
use wasm_posix_shared::mode::{S_IFDIR, S_IFIFO, S_IFMT, S_IFREG};
use wasm_posix_shared::platform_limits::{XATTR_NAME_MAX_BYTES, XATTR_SIZE_MAX_BYTES};
use wasm_posix_shared::{Errno, WasmStat};

use crate::exchange::xattr as exchange_xattr;
use crate::ofd::FileType;
use crate::process::{HostIO, Process};
use crate::syscalls;

/// `XATTR_CREATE`: fail with EEXIST if the attribute already exists.
pub const XATTR_CREATE: u32 = 1;
/// `XATTR_REPLACE`: fail with ENODATA if the attribute does not exist.
pub const XATTR_REPLACE: u32 = 2;

/// What an xattr call names: a path (following a final symlink or not) or an
/// open descriptor.
#[derive(Debug, Clone, Copy)]
pub enum XattrTarget<'a> {
    Path { path: &'a [u8], follow: bool },
    Fd(i32),
}

/// A resolved target.
enum Resolved {
    /// On the exchange filesystem: its canonical path, its stat, and the
    /// tmpfs handle when the target is an open regular file (which may have
    /// been renamed since it was opened).
    Exchange { path: crate::ofd::OfdPath, stat: WasmStat, handle: Option<i64> },
    /// A filesystem that stores no extended attributes.
    Unsupported,
}

/// Resolve the target exactly as `stat`/`lstat`/`fstat`-style calls do, so
/// path and descriptor errors are reported before anything else.
fn resolve(proc: &mut Process, host: &mut dyn HostIO, target: XattrTarget<'_>) -> Result<Resolved, Errno> {
    match target {
        XattrTarget::Path { path, follow } => {
            let stat = if follow {
                syscalls::sys_stat(proc, host, path)?
            } else {
                syscalls::sys_lstat(proc, host, path)?
            };
            let canonical = syscalls::canonical_path(proc, host, path, follow)?;
            if crate::exchange::owns_path(&canonical) && crate::tmpfs::claims_path(&canonical) {
                Ok(Resolved::Exchange { path: crate::ofd::OfdPath::copy_from(&canonical)?, stat, handle: None })
            } else {
                Ok(Resolved::Unsupported)
            }
        }
        XattrTarget::Fd(fd) => {
            syscalls::require_io_fd(proc, fd)?;
            let ofd_idx = syscalls::resolve_io_ofd(proc, fd)?;
            let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;
            if !crate::exchange::owns_path(&ofd.path) || !crate::tmpfs::claims_path(&ofd.path) {
                return Ok(Resolved::Unsupported);
            }
            let path = ofd.path.clone();
            if ofd.file_type == FileType::Regular && crate::tmpfs::is_tmpfs_file_handle(ofd.host_handle) {
                let handle = ofd.host_handle;
                Ok(Resolved::Exchange { path, stat: crate::tmpfs::fstat(handle)?, handle: Some(handle) })
            } else {
                let stat = crate::tmpfs::lstat(&path)?;
                Ok(Resolved::Exchange { path, stat, handle: None })
            }
        }
    }
}

/// Linux `XATTR_NAME_MAX`: a name is 1 to 255 bytes, else ERANGE.
fn validate_name(name: &[u8]) -> Result<(), Errno> {
    if name.is_empty() || name.len() >= XATTR_NAME_MAX_BYTES {
        return Err(Errno::ERANGE);
    }
    Ok(())
}

/// Whether `user.` attributes may live on this file type: regular files and
/// directories, as on Linux, plus FIFOs on the exchange filesystem.
fn holds_user_attributes(stat: &WasmStat) -> bool {
    matches!(stat.st_mode & S_IFMT, S_IFREG | S_IFDIR | S_IFIFO)
}

fn get(path: &[u8], handle: Option<i64>, name: &[u8]) -> Result<Vec<u8>, Errno> {
    match handle {
        Some(handle) => crate::tmpfs::xattr_get_handle(handle, name),
        None => crate::tmpfs::xattr_get(path, name),
    }
}

pub fn sys_getxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
    out: &mut [u8],
) -> Result<usize, Errno> {
    let resolved = resolve(proc, host, target)?;
    validate_name(name)?;
    let Resolved::Exchange { path, stat, handle } = resolved else {
        return Err(Errno::ENOTSUP);
    };
    exchange_xattr::check_namespace(name)?;
    if !holds_user_attributes(&stat) {
        return Err(Errno::ENODATA);
    }
    syscalls::check_access_mode(proc, &stat, R_OK)?;
    let value = get(&path, handle, name)?;
    exchange_xattr::copy_value(&value, out)
}

pub fn sys_setxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
    value: &[u8],
    flags: u32,
) -> Result<(), Errno> {
    // Linux accepts both flags together; each is then checked on its own.
    if flags & !(XATTR_CREATE | XATTR_REPLACE) != 0 {
        return Err(Errno::EINVAL);
    }
    validate_name(name)?;
    if value.len() > XATTR_SIZE_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    let resolved = resolve(proc, host, target)?;
    let Resolved::Exchange { path, stat, handle } = resolved else {
        return Err(Errno::ENOTSUP);
    };
    exchange_xattr::check_namespace(name)?;
    if !holds_user_attributes(&stat) {
        return Err(Errno::EPERM);
    }
    syscalls::check_access_mode(proc, &stat, W_OK)?;
    exchange_xattr::check_change(&path, name, Some(value))?;
    if exchange_xattr::is_stream_end(&path, name) {
        // Set once, so XATTR_REPLACE can never succeed.
        if flags & XATTR_REPLACE != 0 {
            return Err(Errno::ENODATA);
        }
        return crate::exchange::outputs::set_end(&path, value);
    }
    let exists = get(&path, handle, name).is_ok();
    if flags & XATTR_CREATE != 0 && exists {
        return Err(Errno::EEXIST);
    }
    if flags & XATTR_REPLACE != 0 && !exists {
        return Err(Errno::ENODATA);
    }
    match handle {
        Some(handle) => crate::tmpfs::xattr_set_handle(handle, name, value)?,
        None => crate::tmpfs::xattr_set(&path, name, value)?,
    }
    if name == b"user.kandelo.status" {
        if let Some(batch) = crate::exchange::batches::inbox_child_name(&path) {
            crate::exchange::batches::on_status(batch, value);
        }
    }
    Ok(())
}

/// Writes the NUL-terminated names and returns their total size. Listing
/// needs no permission, as on Linux.
pub fn sys_listxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    out: &mut [u8],
) -> Result<usize, Errno> {
    let Resolved::Exchange { path, stat, handle } = resolve(proc, host, target)? else {
        return Ok(0);
    };
    if !holds_user_attributes(&stat) {
        return Ok(0);
    }
    let names = match handle {
        Some(handle) => crate::tmpfs::xattr_names_handle(handle)?,
        None => crate::tmpfs::xattr_names(&path)?,
    };
    exchange_xattr::copy_names(&names, out)
}

pub fn sys_removexattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
) -> Result<(), Errno> {
    let resolved = resolve(proc, host, target)?;
    validate_name(name)?;
    let Resolved::Exchange { path, stat, handle } = resolved else {
        return Err(Errno::ENOTSUP);
    };
    exchange_xattr::check_namespace(name)?;
    if !holds_user_attributes(&stat) {
        return Err(Errno::EPERM);
    }
    syscalls::check_access_mode(proc, &stat, W_OK)?;
    exchange_xattr::check_change(&path, name, None)?;
    match handle {
        Some(handle) => crate::tmpfs::xattr_remove_handle(handle, name),
        None => crate::tmpfs::xattr_remove(&path, name),
    }
}
