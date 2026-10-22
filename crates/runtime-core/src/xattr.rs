//! Extended attribute syscalls (`getxattr(2)`, `setxattr(2)`, `listxattr(2)`,
//! `removexattr(2)` and their `l` and `f` variants).
//!
//! POSIX does not define extended attributes; this follows Linux. No Kandelo
//! filesystem stores extended attributes yet, so every target behaves as a
//! Linux filesystem without xattr handlers does: the get, set, and remove
//! calls fail with ENOTSUP, and list succeeds with an empty list, which is the
//! truth. The exchange filesystem will be the first to implement `user.*`.
//!
//! Argument checks keep Linux's order. `setxattr` validates its flags, name,
//! and size before resolving the path (Linux copies them in first); the other
//! calls resolve the path or descriptor first and then validate the name.
//! Path errors are exactly those of `stat` (or `lstat` for the `l` variants),
//! and a descriptor must be open and not `O_PATH` (Linux `fdget`). One
//! difference: a name longer than 255 bytes is rejected with ERANGE by the
//! host's argument marshalling, before any path is resolved.

use wasm_posix_shared::platform_limits::{XATTR_NAME_MAX_BYTES, XATTR_SIZE_MAX_BYTES};
use wasm_posix_shared::Errno;

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

/// Resolve the target exactly as `stat`/`lstat`/`fstat`-style calls do, so
/// path and descriptor errors are reported before lack of support.
fn resolve(proc: &mut Process, host: &mut dyn HostIO, target: XattrTarget<'_>) -> Result<(), Errno> {
    match target {
        XattrTarget::Path { path, follow: true } => syscalls::sys_stat(proc, host, path).map(drop),
        XattrTarget::Path { path, follow: false } => syscalls::sys_lstat(proc, host, path).map(drop),
        XattrTarget::Fd(fd) => syscalls::require_io_fd(proc, fd),
    }
}

/// Linux `XATTR_NAME_MAX`: a name is 1 to 255 bytes, else ERANGE.
fn validate_name(name: &[u8]) -> Result<(), Errno> {
    if name.is_empty() || name.len() >= XATTR_NAME_MAX_BYTES {
        return Err(Errno::ERANGE);
    }
    Ok(())
}

pub fn sys_getxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
) -> Result<usize, Errno> {
    resolve(proc, host, target)?;
    validate_name(name)?;
    Err(Errno::ENOTSUP)
}

pub fn sys_setxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
    size: usize,
    flags: u32,
) -> Result<(), Errno> {
    // Linux accepts both flags together; each is then checked on its own.
    if flags & !(XATTR_CREATE | XATTR_REPLACE) != 0 {
        return Err(Errno::EINVAL);
    }
    validate_name(name)?;
    if size > XATTR_SIZE_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    resolve(proc, host, target)?;
    Err(Errno::ENOTSUP)
}

/// Returns the size of the name list. With no attributes stored anywhere,
/// that is always 0, for any buffer size.
pub fn sys_listxattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
) -> Result<usize, Errno> {
    resolve(proc, host, target)?;
    Ok(0)
}

pub fn sys_removexattr(
    proc: &mut Process,
    host: &mut dyn HostIO,
    target: XattrTarget<'_>,
    name: &[u8],
) -> Result<(), Errno> {
    resolve(proc, host, target)?;
    validate_name(name)?;
    Err(Errno::ENOTSUP)
}
