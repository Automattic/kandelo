//! Kernel-side resolution of foreign-mount paths into (directory handle, one
//! path component) pairs.
//!
//! # The contract this module exists to enforce
//!
//! **The host resolves at most one path component, relative to a directory
//! handle it previously issued. It never receives a guest path, a mount prefix,
//! a `..`, or a symlink chain.**
//!
//! Before this module, a host was asked to reimplement a POSIX filesystem
//! namespace in its own language — mount-prefix routing, symlink resolution,
//! `..` handling, and permission semantics — and to keep that reimplementation
//! consistent with the kernel's. That was the single largest concept in the
//! host contract and every host had to implement it. The kernel had already
//! walked the path component by component before handing the whole spelling
//! back to the host, which then walked it again.
//!
//! What remains for a host is one operation, one directory handle it already
//! holds, and one path component — the shape of the POSIX `*at` family, which a
//! host author already knows.
//!
//! # Why the final component cannot be a handle
//!
//! `mkdir`, `unlink`, `rename`, `link`, and `symlink` name an entry that does
//! not yet exist or is about to stop existing; there is no handle for it.
//! `lstat`, `lchown`, and a `AT_SYMLINK_NOFOLLOW` `utimensat` name an entry the
//! host must *not* open, because opening a symlink follows it. No host API
//! escapes this — Node has `fs.mkdirSync(path)`, not `mkdirat(fd, name)`, and
//! even OPFS's `getDirectoryHandle(name, {create:true})` takes a name. POSIX
//! concedes the same point: the `*at` family exists precisely because the final
//! component is irreducible.
//!
//! So the honest target is not "no names" but **no name resolution**: one
//! component, never a path.
//!
//! # Reachability
//!
//! Every path operation runs `tmpfs::claims_path` then `rootfs::claims_path`
//! before it can reach the host, and `rootfs::owns_path` excludes only paths
//! under a registered foreign prefix. So this module is reached *only* for a
//! path under a foreign mount whose root handle the host published through
//! `kernel_rootfs_set_foreign_mount_roots`. A host that exposes no directory
//! capability — which is every browser host once `/` is overlay-owned — never
//! has any of these imports called.
//!
//! # Cost
//!
//! Resolving a foreign path walks its components with `host_openat` rather than
//! handing one string to a host that walks it itself. The host was already
//! re-walking the whole path on every call (longest-prefix mount routing, then
//! a backend that re-splits the string), so the work is not new; it moves into
//! Rust, where the walk is typed and shared by every host. Intermediate
//! directory handles are opened and closed around each operation; see
//! [`with_parent`] for the ownership rule.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, WasmStat};

use crate::process::HostIO;

/// `O_DIRECTORY | O_NOFOLLOW`, the flags every intermediate step of a walk uses.
///
/// `O_DIRECTORY` because a non-directory in the middle of a path is `ENOTDIR`.
/// `O_NOFOLLOW` because the kernel has already resolved every symlink in the
/// canonical path it hands us: if a component is *still* a symlink, the tree
/// changed underneath the walk, and `ELOOP` is the truthful answer rather than
/// a silently re-followed link the kernel never authorised.
const WALK_FLAGS: u32 = wasm_posix_shared::flags::O_DIRECTORY | wasm_posix_shared::flags::O_NOFOLLOW;

/// A directory handle held during a walk, plus whether this walk opened it.
///
/// A mount root is borrowed — it belongs to the host's mount table and outlives
/// every walk — so closing it would retire the mount. Every handle a walk opens
/// itself is owned and must be closed exactly once.
struct DirRef {
    handle: i64,
    owned: bool,
}

impl DirRef {
    fn borrowed(handle: i64) -> Self {
        DirRef {
            handle,
            owned: false,
        }
    }

    /// Release the handle if this walk opened it. Takes `host` explicitly
    /// rather than implementing `Drop`, because closing needs the host and a
    /// `&mut dyn HostIO` cannot be captured by a destructor.
    fn release(self, host: &mut dyn HostIO) {
        if self.owned {
            // A failed close leaves nothing the kernel can do and must not mask
            // the operation's own result.
            let _ = host.host_close(self.handle);
        }
    }
}

/// Split a canonical absolute path into the foreign mount that owns it and the
/// components below that mount's root.
///
/// Returns `Err(ENOSYS)` when the path is not under a foreign mount with a
/// published root handle. That is the truthful answer for the two ways it can
/// happen: the caller reached a host filesystem operation for a path no host
/// filesystem owns, or the host declared a mount but exposed no directory
/// capability for it. Neither is a reason to fall back to name resolution.
fn locate(path: &[u8]) -> Result<(i64, Vec<&[u8]>), Errno> {
    // A foreign mount beneath an overlay-owned `/` wins on longest prefix.
    // Failing that, a host that serves `/` itself anchors every path at its
    // root handle — the whole path is then components below that root.
    let (root, prefix_len) = match crate::rootfs::foreign_mount_root(path) {
        Some(found) => found,
        None => (crate::rootfs::host_root_handle().ok_or(Errno::ENOSYS)?, 0),
    };
    let components = path[prefix_len..]
        .split(|&b| b == b'/')
        .filter(|c| !c.is_empty())
        .collect();
    Ok((root, components))
}

/// Run `f` against the directory holding `path`'s final component.
///
/// Walks from the owning mount's root through every component but the last,
/// opening each with [`WALK_FLAGS`], then calls `f(host, dir_handle, name)`.
/// Every handle the walk opened is closed before returning, on both the success
/// and the error path, so a failing operation cannot leak a host descriptor.
///
/// A path that *is* a mount root has no final component to name. It resolves to
/// `(root, ".")`, which is what POSIX `*at` calls mean by a directory naming
/// itself, and is what lets `stat` of a mount point answer from the mount
/// rather than from the directory that contains it.
fn with_parent<T>(
    host: &mut dyn HostIO,
    path: &[u8],
    f: impl FnOnce(&mut dyn HostIO, i64, &[u8]) -> Result<T, Errno>,
) -> Result<T, Errno> {
    let (root, components) = locate(path)?;
    let Some((last, parents)) = components.split_last() else {
        // The path is the mount root itself.
        return f(host, root, b".");
    };
    let mut dir = DirRef::borrowed(root);
    for component in parents {
        match host.host_openat(dir.handle, component, WALK_FLAGS, 0) {
            Ok(next) => {
                dir.release(host);
                dir = DirRef {
                    handle: next,
                    owned: true,
                };
            }
            Err(err) => {
                dir.release(host);
                return Err(err);
            }
        }
    }
    let result = f(host, dir.handle, last);
    dir.release(host);
    result
}

/// Run `f` against the directories holding two paths' final components.
///
/// `rename` and `link` are the only operations that name two entries, and both
/// must present them to the host in one call: performing them as two steps
/// would lose the atomicity the host filesystem provides. Both walks are
/// unwound whatever the outcome.
fn with_parent2<T>(
    host: &mut dyn HostIO,
    old_path: &[u8],
    new_path: &[u8],
    f: impl FnOnce(&mut dyn HostIO, i64, &[u8], i64, &[u8]) -> Result<T, Errno>,
) -> Result<T, Errno> {
    with_parent(host, old_path, |host, old_dir, old_name| {
        // `old_name` borrows the caller's path buffer, which outlives the inner
        // walk, so the two walks nest without copying either component.
        with_parent(host, new_path, |host, new_dir, new_name| {
            f(host, old_dir, old_name, new_dir, new_name)
        })
    })
}

// ---------------------------------------------------------------------------
// Path-shaped operations, handle-only underneath
//
// Each function keeps the path-shaped signature its callers in `syscalls.rs`
// already use, and performs the walk internally. The host sees only
// `(directory handle, one component)`.
// ---------------------------------------------------------------------------

/// `open(2)` on a foreign mount.
pub fn open(host: &mut dyn HostIO, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_openat(dir, name, flags, mode)
    })
}

/// `open(2)` with `O_DIRECTORY`, for directory iteration.
///
/// There is no separate `opendir` import: a directory stream is an open handle
/// like any other, read with `host_readdir` and released with `host_close`.
/// Collapsing it removes a whole host-owned handle namespace — hosts used to
/// maintain a directory-cursor table disjoint from their file table, and the
/// kernel had to remember which close to call for which handle.
pub fn opendir(host: &mut dyn HostIO, path: &[u8]) -> Result<i64, Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_openat(
            dir,
            name,
            wasm_posix_shared::flags::O_DIRECTORY,
            0,
        )
    })
}

/// `stat(2)`: metadata with the final symlink followed.
pub fn stat(host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    with_parent(host, path, |host, dir, name| host.host_fstatat(dir, name, 0))
}

/// `lstat(2)`: metadata without following the final symlink.
pub fn lstat(host: &mut dyn HostIO, path: &[u8]) -> Result<WasmStat, Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_fstatat(dir, name, wasm_posix_shared::flags::AT_SYMLINK_NOFOLLOW)
    })
}

/// `mkdir(2)`.
pub fn mkdir(host: &mut dyn HostIO, path: &[u8], mode: u32) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_mkdirat(dir, name, mode)
    })
}

/// `rmdir(2)`, which is `unlinkat` with `AT_REMOVEDIR` — the same host
/// operation `unlink` uses, distinguished by the flag POSIX defines for it.
pub fn rmdir(host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_unlinkat(dir, name, wasm_posix_shared::flags::AT_REMOVEDIR)
    })
}

/// `unlink(2)`.
pub fn unlink(host: &mut dyn HostIO, path: &[u8]) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_unlinkat(dir, name, 0)
    })
}

/// `rename(2)`. Both entries are presented in one host call so the host
/// filesystem's atomicity is preserved.
pub fn rename(host: &mut dyn HostIO, old_path: &[u8], new_path: &[u8]) -> Result<(), Errno> {
    with_parent2(host, old_path, new_path, |host, od, on, nd, nn| {
        host.host_renameat(od, on, nd, nn)
    })
}

/// `link(2)`. `flags` is always 0 here: the kernel resolves the existing path
/// itself, so `AT_SYMLINK_FOLLOW` has already been applied or withheld by the
/// caller's own resolution.
pub fn link(host: &mut dyn HostIO, old_path: &[u8], new_path: &[u8]) -> Result<(), Errno> {
    with_parent2(host, old_path, new_path, |host, od, on, nd, nn| {
        host.host_linkat(od, on, nd, nn, 0)
    })
}

/// `symlink(2)`. The target is opaque data the host stores verbatim — it is
/// never resolved by the host — while the link path names an entry to create.
pub fn symlink(host: &mut dyn HostIO, target: &[u8], link_path: &[u8]) -> Result<(), Errno> {
    with_parent(host, link_path, |host, dir, name| {
        host.host_symlinkat(target, dir, name)
    })
}

/// `readlink(2)`.
pub fn readlink(host: &mut dyn HostIO, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_readlinkat(dir, name, buf)
    })
}

/// `chmod(2)`.
///
/// This is `fchmodat`, not an open followed by `fchmod`. Opening a file in
/// order to change its mode is not equivalent: `open(O_RDONLY)` fails with
/// `EACCES` on a file the caller owns but cannot read — which `chmod` must
/// still permit — and blocks indefinitely on a FIFO with no writer. Both are
/// real POSIX behaviours that no shipped package need exercise for them to be
/// required.
pub fn chmod(host: &mut dyn HostIO, path: &[u8], mode: u32) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_fchmodat(dir, name, mode)
    })
}

/// `chown(2)`: follows a final symlink.
pub fn chown(host: &mut dyn HostIO, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_fchownat(dir, name, uid, gid, 0)
    })
}

/// `lchown(2)`: does not follow a final symlink.
///
/// This is why `fchown` on an opened handle is not sufficient for the ownership
/// family: a symlink cannot be opened without following it, so changing a
/// symlink's own ownership requires naming it.
pub fn lchown(host: &mut dyn HostIO, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_fchownat(
            dir,
            name,
            uid,
            gid,
            wasm_posix_shared::flags::AT_SYMLINK_NOFOLLOW,
        )
    })
}

/// `utimensat(2)`. `flags` carries `AT_SYMLINK_NOFOLLOW` when the timestamps
/// belong to a symlink rather than to its target.
pub fn utimensat(
    host: &mut dyn HostIO,
    path: &[u8],
    atime_sec: i64,
    atime_nsec: i64,
    mtime_sec: i64,
    mtime_nsec: i64,
    flags: u32,
) -> Result<(), Errno> {
    with_parent(host, path, |host, dir, name| {
        host.host_utimensat(dir, name, atime_sec, atime_nsec, mtime_sec, mtime_nsec, flags)
    })
}

/// Open the directory holding `path`'s final component, for the queries whose
/// answer is a property of the *filesystem* rather than of the named file:
/// `statfs` and `pathconf`.
///
/// Those two used to take a path of their own, which meant a second full host
/// walk to learn something the containing directory already knows. Answering
/// them from the parent directory handle is both more truthful — it is the same
/// filesystem by construction — and side-effect free, where opening the named
/// file could block on a FIFO or disturb a device.
pub fn with_containing_dir<T>(
    host: &mut dyn HostIO,
    path: &[u8],
    f: impl FnOnce(&mut dyn HostIO, i64) -> Result<T, Errno>,
) -> Result<T, Errno> {
    let (root, components) = locate(path)?;
    // Every component including the last: the containing directory of `path`'s
    // *filesystem* question is the deepest directory on the way to it, and for a
    // path naming a directory that is the directory itself.
    let (last, parents) = match components.split_last() {
        Some(split) => split,
        None => return f(host, root),
    };
    let mut dir = DirRef::borrowed(root);
    for component in parents {
        match host.host_openat(dir.handle, component, WALK_FLAGS, 0) {
            Ok(next) => {
                dir.release(host);
                dir = DirRef {
                    handle: next,
                    owned: true,
                };
            }
            Err(err) => {
                // An intermediate component that is missing or not a directory
                // is a real failure of the path, not something to answer from a
                // shallower directory.
                dir.release(host);
                return Err(err);
            }
        }
    }
    // The final component may legitimately not be a directory — `statfs` of a
    // regular file is well-formed — so descend into it only if it is one, and
    // otherwise answer from its parent, which is on the same filesystem.
    if let Ok(next) = host.host_openat(dir.handle, last, WALK_FLAGS, 0) {
        dir.release(host);
        dir = DirRef {
            handle: next,
            owned: true,
        };
    }
    let result = f(host, dir.handle);
    dir.release(host);
    result
}
