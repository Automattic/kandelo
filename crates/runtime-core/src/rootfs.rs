//! In-kernel overlay for the image-backed root filesystem `/`.
//!
//! Part of Phase 5 (Increment 2) of the rust-first runtime migration: filesystem
//! *authority* for `/` moves from the TypeScript host into the portable Rust
//! kernel core. Where `tmpfs.rs` owns the empty scratch mounts, this module owns
//! the rootfs tree — which is **not** empty, so it is an *overlay*:
//!
//! - an **immutable base layer** — dirs, symlinks, and regular-file *metadata*
//!   owned in Rust, populated at boot from a host-supplied manifest. A base
//!   regular file carries a `blob_id` + `size`; its bytes are fetched on demand
//!   through a `blob_read` host callback (the host stays the byte store). Base
//!   bytes are never mutated.
//! - a **mutable overlay layer** — Rust-owned, identical to the tmpfs model:
//!   files created under `/`, and base files copied-on-write on first write.
//!   (Increment 2b.)
//! - **whiteouts** hiding deleted base entries. (Increment 2b.)
//!
//! This first slice (Increment 2a) implements the read-only base layer only:
//! the data model, a base-tree builder, and the read-path operations
//! (lstat/readlink/open-rdonly/read/opendir/readdir/getdents64/statfs). It is
//! **dormant by default** (`set_enabled`, default off) and not yet wired into
//! syscall dispatch, so behavior is unchanged until the cutover increment. The
//! mutable overlay (COW/create/unlink/rename/chmod/…) lands in Increment 2b.
//! See `docs/plans/2026-08-28-phase5-vfs-to-rust.md`.
//!
//! # Handle encoding
//! Disjoint negative-handle bands, 1e9 wide, below the tmpfs bands:
//! rootfs file `(-5e9, -4e9]`, rootfs dir `(-6e9, -5e9]`. The read/write cursor
//! lives in the per-OFD `OpenFileDesc::offset` field (like host and tmpfs
//! files), so rootfs is not a shared-cursor backing.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK, S_IFMT, S_IFREG};
use wasm_posix_shared::Errno;
use wasm_posix_shared::WasmStat;
use wasm_posix_shared::WasmStatfs;

// Open-file creation flags we honor here (mirrors syscalls.rs / tmpfs.rs).
const O_ACCMODE: u32 = 0o3;
const O_RDONLY: u32 = 0o0;
const O_DIRECTORY: u32 = 0o200000;

/// Directory entry type codes as reported through getdents64 `d_type`.
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;
const DT_LNK: u32 = 10;

/// Dirent `d_type` for an inode.
fn dirent_type(inode: &Inode) -> u8 {
    match inode.kind {
        InodeKind::Dir(_) => DT_DIR as u8,
        InodeKind::Symlink(_) => DT_LNK as u8,
        InodeKind::BaseRegular { .. } => DT_REG as u8,
    }
}

/// Disjoint negative-handle bands, below the tmpfs bands (see `tmpfs.rs`).
pub const ROOTFS_FILE_HANDLE_BASE: i64 = 4_000_000_000;
pub const ROOTFS_DIR_HANDLE_BASE: i64 = 5_000_000_000;
use crate::tmpfs::HANDLE_BAND_WIDTH;

/// Sentinel host handle marking an open rootfs *directory* descriptor. Distinct
/// from procfs (-150), devfs (-160), and tmpfs (-170) directory sentinels.
pub const ROOTFS_DIR_SENTINEL: i64 = -180;

/// `st_dev` for the rootfs overlay (one filesystem identity). Distinct from the
/// per-scratch-mount tmpfs devs (`0x7400_0000`+).
const ROOTFS_DEV: u64 = 0x7300_0000;

/// An inode in the rootfs overlay. Increment 2a carries only base (immutable)
/// kinds; the mutable overlay kinds (`Regular(Vec<u8>)` for COW/created files)
/// arrive in Increment 2b.
enum InodeKind {
    Dir(BTreeMap<Vec<u8>, u32>),
    /// A base regular file: bytes live in the host byte store, addressed by
    /// `blob_id`; `size` is authoritative metadata from the manifest.
    BaseRegular { blob_id: u64, size: u64 },
    /// Symbolic link holding its target path bytes.
    Symlink(Vec<u8>),
}

struct Inode {
    kind: InodeKind,
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    /// Number of directory entries (hard links) referencing this inode.
    nlink: u32,
    /// Live open descriptions (for handle validity / future unlink-while-open).
    open_count: u32,
    ino: u64,
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
}

impl Inode {
    fn new(kind: InodeKind, mode: u32, uid: u32, gid: u32, nlink: u32, ino: u64) -> Self {
        let (sec, nsec) = now();
        Inode {
            kind,
            mode,
            uid,
            gid,
            nlink,
            open_count: 0,
            ino,
            atime_sec: sec,
            atime_nsec: nsec,
            mtime_sec: sec,
            mtime_nsec: nsec,
            ctime_sec: sec,
            ctime_nsec: nsec,
        }
    }

    fn stat(&self) -> WasmStat {
        let type_bits = match self.kind {
            InodeKind::Dir(_) => S_IFDIR,
            InodeKind::BaseRegular { .. } => S_IFREG,
            InodeKind::Symlink(_) => S_IFLNK,
        };
        let size = match &self.kind {
            InodeKind::Dir(entries) => entries.len() as u64,
            InodeKind::BaseRegular { size, .. } => *size,
            InodeKind::Symlink(target) => target.len() as u64,
        };
        WasmStat {
            st_dev: ROOTFS_DEV,
            st_ino: self.ino,
            st_mode: type_bits | (self.mode & 0o7777),
            st_nlink: self.nlink,
            st_uid: self.uid,
            st_gid: self.gid,
            st_size: size,
            st_atime_sec: self.atime_sec,
            st_atime_nsec: self.atime_nsec,
            st_mtime_sec: self.mtime_sec,
            st_mtime_nsec: self.mtime_nsec,
            st_ctime_sec: self.ctime_sec,
            st_ctime_nsec: self.ctime_nsec,
            _pad: 0,
        }
    }

    fn is_dir(&self) -> bool {
        matches!(self.kind, InodeKind::Dir(_))
    }
}

/// A materialized directory stream: a snapshot of entries plus a cursor.
struct DirIter {
    entries: Vec<(Vec<u8>, u64, u32)>,
    cursor: usize,
}

struct RootfsState {
    inodes: Vec<Option<Inode>>,
    free_inodes: Vec<u32>,
    /// Root ("/") inode index, created on first use.
    root: Option<u32>,
    dir_iters: Vec<Option<DirIter>>,
    free_dir_iters: Vec<u32>,
    /// Inode numbers for overlay-created inodes; base inos come from the
    /// manifest. Starts high to avoid colliding with typical manifest inos.
    next_ino: u64,
}

impl RootfsState {
    fn new() -> Self {
        RootfsState {
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            root: None,
            dir_iters: Vec::new(),
            free_dir_iters: Vec::new(),
            next_ino: 1,
        }
    }

    fn bump_next_ino(&mut self, seen: u64) {
        if seen >= self.next_ino {
            self.next_ino = seen + 1;
        }
    }

    fn insert_inode(&mut self, inode: Inode) -> u32 {
        if let Some(idx) = self.free_inodes.pop() {
            self.inodes[idx as usize] = Some(inode);
            idx
        } else {
            let idx = self.inodes.len() as u32;
            self.inodes.push(Some(inode));
            idx
        }
    }

    fn get(&self, idx: u32) -> Option<&Inode> {
        self.inodes.get(idx as usize).and_then(|slot| slot.as_ref())
    }

    fn get_mut(&mut self, idx: u32) -> Option<&mut Inode> {
        self.inodes
            .get_mut(idx as usize)
            .and_then(|slot| slot.as_mut())
    }

    /// Root ("/") inode index, created on first touch with default 0755 root:root
    /// metadata. A manifest `/` entry refines that metadata via
    /// [`insert_base_dir`].
    fn mount_root(&mut self) -> u32 {
        if let Some(root) = self.root {
            return root;
        }
        let ino = 1;
        self.bump_next_ino(ino);
        let root = self.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            0o755,
            0,
            0,
            2,
            ino,
        ));
        self.root = Some(root);
        root
    }

    /// Walk `components` from the root, returning the target inode index. Every
    /// intermediate component must be an existing directory.
    fn walk(&self, mut cur: u32, components: &[&[u8]]) -> Result<u32, Errno> {
        for comp in components {
            let inode = self.get(cur).ok_or(Errno::ENOENT)?;
            match &inode.kind {
                InodeKind::Dir(entries) => {
                    cur = *entries.get(*comp).ok_or(Errno::ENOENT)?;
                }
                _ => return Err(Errno::ENOTDIR),
            }
        }
        Ok(cur)
    }
}

struct RootfsGlobal {
    locked: AtomicBool,
    state: UnsafeCell<Option<RootfsState>>,
}

struct UnlockOnDrop<'a>(&'a AtomicBool);

impl Drop for UnlockOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl RootfsGlobal {
    const fn new() -> Self {
        RootfsGlobal {
            locked: AtomicBool::new(false),
            state: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut RootfsState) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: `locked` serializes every access; Kandelo enters one kernel
        // instance at a time, exactly like tmpfs and the other global stores.
        let slot = unsafe { &mut *self.state.get() };
        f(slot.get_or_insert_with(RootfsState::new))
    }
}

// SAFETY: identical invariant to tmpfs's TmpfsGlobal — the spinlock is the sole
// gate and no reference escapes the closure.
unsafe impl Sync for RootfsGlobal {}

static ROOTFS: RootfsGlobal = RootfsGlobal::new();

/// Split a canonical absolute path into non-empty components.
fn split_components(path: &[u8]) -> Vec<&[u8]> {
    path.split(|&b| b == b'/').filter(|c| !c.is_empty()).collect()
}

/// Master switch for in-kernel rootfs authority over `/`. Defaults OFF; the
/// cutover increment enables it at boot (and drops the host `/` image backend).
static ROOTFS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable or disable in-kernel rootfs authority. Returns the previous value.
pub fn set_enabled(enabled: bool) -> bool {
    ROOTFS_ENABLED.swap(enabled, Ordering::SeqCst)
}

/// Whether in-kernel rootfs authority is currently active.
pub fn is_enabled() -> bool {
    ROOTFS_ENABLED.load(Ordering::SeqCst)
}

static ROOTFS_NOW_SEC: AtomicU64 = AtomicU64::new(0);
static ROOTFS_NOW_NSEC: AtomicU32 = AtomicU32::new(0);

/// Publish the current wall-clock time for subsequent metadata stamps (the core
/// stays host-free; the syscall layer reads the host clock once per mutating op).
pub fn set_now(sec: u64, nsec: u32) {
    ROOTFS_NOW_SEC.store(sec, Ordering::Relaxed);
    ROOTFS_NOW_NSEC.store(nsec, Ordering::Relaxed);
}

fn now() -> (u64, u32) {
    (
        ROOTFS_NOW_SEC.load(Ordering::Relaxed),
        ROOTFS_NOW_NSEC.load(Ordering::Relaxed),
    )
}

/// Whether a canonical path belongs to the rootfs overlay: any absolute path
/// that is not owned by the tmpfs scratch mounts. Pure predicate; does not
/// consider whether rootfs authority is enabled. Synthetic namespaces (procfs,
/// devfs, pty, `/dev/fd`, synthetic regulars) are matched *before* rootfs in
/// `namespace_lstat_raw`, exactly where the host `/` fall-through sits today, so
/// they never reach this predicate in dispatch.
pub fn owns_path(path: &[u8]) -> bool {
    path.first() == Some(&b'/') && !crate::tmpfs::owns_path(path)
}

/// Whether the in-kernel rootfs currently claims authority over a path: rootfs
/// is enabled AND the path is a rootfs path.
pub fn claims_path(path: &[u8]) -> bool {
    is_enabled() && owns_path(path)
}

/// Whether a host handle names an open rootfs regular file.
pub fn is_rootfs_file_handle(handle: i64) -> bool {
    handle <= -ROOTFS_FILE_HANDLE_BASE && handle > -ROOTFS_DIR_HANDLE_BASE
}

/// Whether a host handle names an open rootfs directory stream.
pub fn is_rootfs_dir_handle(handle: i64) -> bool {
    handle <= -ROOTFS_DIR_HANDLE_BASE
        && handle > -(ROOTFS_DIR_HANDLE_BASE + HANDLE_BAND_WIDTH)
}

fn file_handle_to_inode(handle: i64) -> Result<u32, Errno> {
    if !is_rootfs_file_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - ROOTFS_FILE_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn inode_to_file_handle(idx: u32) -> i64 {
    -(ROOTFS_FILE_HANDLE_BASE + idx as i64)
}

fn dir_handle_to_iter(handle: i64) -> Result<u32, Errno> {
    if !is_rootfs_dir_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - ROOTFS_DIR_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn iter_to_dir_handle(idx: u32) -> i64 {
    -(ROOTFS_DIR_HANDLE_BASE + idx as i64)
}

// ---------------------------------------------------------------------------
// Base-tree builder (populated at boot from the host manifest; used directly by
// unit tests). Parents must be inserted before their children (a manifest is
// walked parent-first). Each insert refuses to clobber an existing entry.
// ---------------------------------------------------------------------------

/// Clear the whole overlay (drops every inode and open stream). Used before
/// repopulating from a fresh manifest and by tests for isolation.
pub fn reset() {
    ROOTFS.with(|state| *state = RootfsState::new());
}

/// Split an absolute path into (parent components, final component). Returns
/// `None` for the root itself.
fn parent_and_last(path: &[u8]) -> Option<(Vec<&[u8]>, &[u8])> {
    let comps = split_components(path);
    if comps.is_empty() {
        return None;
    }
    let last = comps[comps.len() - 1];
    let parent = comps[..comps.len() - 1].to_vec();
    Some((parent, last))
}

fn link_into_parent(
    state: &mut RootfsState,
    parent_comps: &[&[u8]],
    last: &[u8],
    child: u32,
) -> Result<(), Errno> {
    let root = state.mount_root();
    let parent = state.walk(root, parent_comps)?;
    match state.get_mut(parent).map(|i| &mut i.kind) {
        Some(InodeKind::Dir(entries)) => {
            if entries.contains_key(last) {
                return Err(Errno::EEXIST);
            }
            entries.insert(last.to_vec(), child);
            Ok(())
        }
        Some(_) => Err(Errno::ENOTDIR),
        None => Err(Errno::ENOENT),
    }
}

/// Insert a base directory. For `/` this sets the root's metadata (creating the
/// root if needed) rather than adding a child.
pub fn insert_base_dir(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let Some((parent_comps, last)) = parent_and_last(path) else {
            // Root: create-or-update its metadata.
            let root = state.mount_root();
            if let Some(inode) = state.get_mut(root) {
                inode.mode = mode & 0o7777;
                inode.uid = uid;
                inode.gid = gid;
                inode.ino = ino;
            }
            return Ok(());
        };
        let child = state.insert_inode(Inode::new(
            InodeKind::Dir(BTreeMap::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        match link_into_parent(state, &comps, last, child) {
            Ok(()) => {
                // Bump the parent's link count for the new subdirectory's `..`.
                let root = state.mount_root();
                if let Ok(parent) = state.walk(root, &comps) {
                    if let Some(p) = state.get_mut(parent) {
                        p.nlink += 1;
                    }
                }
                Ok(())
            }
            Err(e) => {
                // Roll back the orphaned inode.
                state.inodes[child as usize] = None;
                state.free_inodes.push(child);
                Err(e)
            }
        }
    })
}

/// Insert a base regular file whose bytes are served from the host byte store
/// (`blob_id`, `size` authoritative from the manifest).
pub fn insert_base_file(
    path: &[u8],
    blob_id: u64,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::BaseRegular { blob_id, size },
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

/// Insert a base symlink holding `target` bytes.
pub fn insert_base_symlink(
    path: &[u8],
    target: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::Symlink(target.to_vec()),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ));
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Read-path operations (Increment 2a).
// ---------------------------------------------------------------------------

/// lstat a canonical rootfs path. The final component is not followed (the
/// caller resolved symlinks per the syscall's FOLLOW policy already).
pub fn lstat(path: &[u8]) -> Result<WasmStat, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        Ok(state.get(idx).ok_or(Errno::ENOENT)?.stat())
    })
}

/// readlink a rootfs symlink.
pub fn readlink(path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Symlink(target) => {
                let n = target.len().min(buf.len());
                buf[..n].copy_from_slice(&target[..n]);
                Ok(n)
            }
            _ => Err(Errno::EINVAL),
        }
    })
}

/// Whether a canonical rootfs path names an existing directory.
pub fn is_dir(path: &[u8]) -> bool {
    lstat(path)
        .map(|st| st.st_mode & S_IFMT == S_IFDIR)
        .unwrap_or(false)
}

/// Open a rootfs regular file. Increment 2a is read-only: only `O_RDONLY` opens
/// of base regular files are supported; any write intent returns `EROFS` until
/// the mutable overlay (Increment 2b) lands. Directories go through `opendir`.
pub fn open(path: &[u8], flags: u32, _mode: u32, _uid: u32, _gid: u32) -> Result<i64, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        let inode = state.get(idx).ok_or(Errno::ENOENT)?;
        if inode.is_dir() {
            return Err(Errno::EISDIR);
        }
        if flags & O_DIRECTORY != 0 {
            return Err(Errno::ENOTDIR);
        }
        if matches!(inode.kind, InodeKind::Symlink(_)) {
            // The caller resolves symlinks before open; a symlink reaching here
            // with O_NOFOLLOW semantics is not a regular file.
            return Err(Errno::ELOOP);
        }
        if flags & O_ACCMODE != O_RDONLY {
            // Mutable overlay (COW): Increment 2b.
            return Err(Errno::EROFS);
        }
        state.get_mut(idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(idx))
    })
}

/// Read up to `buf.len()` bytes at `offset` from an open rootfs file. Base-file
/// bytes come from the host byte store via `blob_read(blob_id, offset, buf)`;
/// the store computes the EOF clamp and releases its lock *before* the host
/// callback so no host boundary call runs under the spinlock. Returns the number
/// of bytes read (0 at EOF).
pub fn read<F>(handle: i64, offset: i64, buf: &mut [u8], mut blob_read: F) -> Result<usize, Errno>
where
    F: FnMut(u64, u64, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let (blob_id, size) = ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::BaseRegular { blob_id, size } => Ok((*blob_id, *size)),
            InodeKind::Dir(_) => Err(Errno::EISDIR),
            InodeKind::Symlink(_) => Err(Errno::EINVAL),
        }
    })?;
    let start = offset as u64;
    if start >= size {
        return Ok(0);
    }
    let n = core::cmp::min(buf.len() as u64, size - start) as usize;
    blob_read(blob_id, start, &mut buf[..n])
}

/// Current size of an open rootfs file (for `SEEK_END`).
pub fn size(handle: i64) -> Result<i64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::BaseRegular { size, .. } => Ok(*size as i64),
            _ => Err(Errno::EISDIR),
        }
    })
}

/// fstat an open rootfs file handle.
pub fn fstat(handle: i64) -> Result<WasmStat, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| Ok(state.get(idx).ok_or(Errno::EBADF)?.stat()))
}

/// Add an owning reference (fork/dup inheriting a rootfs fd). Returns whether the
/// handle was recognized.
pub fn add_ref_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    ROOTFS.with(|state| {
        if let Some(inode) = state.get_mut(idx) {
            inode.open_count += 1;
            true
        } else {
            false
        }
    })
}

/// Drop one owning reference (close/exec-cloexec). Returns `true` when this drop
/// released the final open reference. Base inodes are never freed (they belong to
/// the immutable base); overlay/COW inode freeing arrives in Increment 2b.
pub fn release_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    ROOTFS.with(|state| {
        let Some(inode) = state.get_mut(idx) else {
            return false;
        };
        inode.open_count = inode.open_count.saturating_sub(1);
        inode.open_count == 0
    })
}

/// Whether a rootfs handle still names a live backing (trust-boundary check).
pub fn handle_is_live(handle: i64) -> bool {
    if let Ok(idx) = file_handle_to_inode(handle) {
        return ROOTFS.with(|state| state.get(idx).is_some());
    }
    if let Ok(idx) = dir_handle_to_iter(handle) {
        return ROOTFS.with(|state| {
            state
                .dir_iters
                .get(idx as usize)
                .map(|slot| slot.is_some())
                .unwrap_or(false)
        });
    }
    false
}

/// Open a directory stream over a rootfs directory, returning an encoded handle.
pub fn opendir(path: &[u8]) -> Result<i64, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        let entries = match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(map) => {
                let mut out: Vec<(Vec<u8>, u64, u32)> = Vec::with_capacity(map.len());
                for (name, &child_idx) in map.iter() {
                    let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
                    out.push((name.clone(), child.ino, dirent_type(child) as u32));
                }
                out
            }
            _ => return Err(Errno::ENOTDIR),
        };
        let iter = DirIter { entries, cursor: 0 };
        let slot_idx = if let Some(i) = state.free_dir_iters.pop() {
            state.dir_iters[i as usize] = Some(iter);
            i
        } else {
            let i = state.dir_iters.len() as u32;
            state.dir_iters.push(Some(iter));
            i
        };
        Ok(iter_to_dir_handle(slot_idx))
    })
}

/// Read the next entry from a rootfs directory stream. Mirrors `host_readdir`.
pub fn readdir(handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    ROOTFS.with(|state| {
        let iter = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .and_then(|slot| slot.as_mut())
            .ok_or(Errno::EBADF)?;
        let Some((name, ino, d_type)) = iter.entries.get(iter.cursor) else {
            return Ok(None);
        };
        let n = name.len();
        if n > name_buf.len() {
            return Err(Errno::EINVAL);
        }
        name_buf[..n].copy_from_slice(name);
        let result = (*ino, *d_type, n);
        iter.cursor += 1;
        Ok(Some(result))
    })
}

/// getdents64 for a rootfs directory: build the entry list from the live store
/// and hand it to the shared virtual-dirent formatter (which injects `.`/`..`
/// and honors the cookie/short-buffer protocol). Returns
/// `(bytes_written, new_cookie, exhausted)`.
pub fn getdents64(path: &[u8], buf: &mut [u8], offset: i64) -> Result<(usize, i64, bool), Errno> {
    let comps = split_components(path);
    let (dir_ino, entries) = ROOTFS.with(|state| {
        let root = state.mount_root();
        let idx = state.walk(root, &comps)?;
        let dir = state.get(idx).ok_or(Errno::ENOENT)?;
        let InodeKind::Dir(map) = &dir.kind else {
            return Err(Errno::ENOTDIR);
        };
        let dir_ino = dir.ino;
        let mut out: Vec<(Vec<u8>, u8, u64)> = Vec::with_capacity(map.len());
        for (name, &child_idx) in map.iter() {
            let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
            out.push((name.clone(), dirent_type(child), child.ino));
        }
        Ok((dir_ino, out))
    })?;
    crate::procfs::write_virtual_dirents64(buf, offset, dir_ino, dir_ino, &entries)
}

/// Close a rootfs directory stream.
pub fn closedir(handle: i64) -> Result<(), Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    ROOTFS.with(|state| {
        let slot = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .ok_or(Errno::EBADF)?;
        if slot.is_none() {
            return Err(Errno::EBADF);
        }
        *slot = None;
        state.free_dir_iters.push(iter_idx);
        Ok(())
    })
}

/// statfs for the rootfs overlay: a memory-backed filesystem (its mutable layer
/// grows within kernel Wasm memory). The exact magic/flags are reconciled with
/// the host image backend at cutover (Increment 2e).
pub fn statfs(path: &[u8]) -> Result<WasmStatfs, Errno> {
    if !owns_path(path) {
        return Err(Errno::ENOENT);
    }
    Ok(WasmStatfs {
        f_type: 0x858458f6, // RAMFS_MAGIC (placeholder; reconciled at cutover)
        f_bsize: 4096,
        f_blocks: 262_144,
        f_bfree: 262_144,
        f_bavail: 262_144,
        f_files: 65_536,
        f_ffree: 65_536,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: 0,
        _pad: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests: the store is a process-global singleton. Each test
    /// resets first, and no two run concurrently under this guard.
    static TEST_LOCK: AtomicBool = AtomicBool::new(false);

    struct TestGuard;
    impl TestGuard {
        fn acquire() -> Self {
            while TEST_LOCK
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                spin_loop();
            }
            reset();
            set_now(1_000, 0);
            TestGuard
        }
    }
    impl Drop for TestGuard {
        fn drop(&mut self) {
            reset();
            set_enabled(false);
            TEST_LOCK.store(false, Ordering::Release);
        }
    }

    /// A small in-memory byte store standing in for the host `blob_read`.
    fn make_blob_reader(
        blobs: alloc::vec::Vec<(u64, alloc::vec::Vec<u8>)>,
    ) -> impl FnMut(u64, u64, &mut [u8]) -> Result<usize, Errno> {
        move |blob_id, offset, buf| {
            let (_, data) = blobs
                .iter()
                .find(|(id, _)| *id == blob_id)
                .ok_or(Errno::EIO)?;
            let start = offset as usize;
            if start >= data.len() {
                return Ok(0);
            }
            let n = core::cmp::min(buf.len(), data.len() - start);
            buf[..n].copy_from_slice(&data[start..start + n]);
            Ok(n)
        }
    }

    fn build_sample_tree() {
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/usr", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/usr/bin", 0o755, 0, 0, 3).unwrap();
        insert_base_file(b"/usr/bin/hello", 42, 11, 0o755, 0, 0, 4).unwrap();
        insert_base_symlink(b"/usr/bin/hi", b"hello", 0o777, 0, 0, 5).unwrap();
        insert_base_file(b"/etc-issue-blob-empty", 43, 0, 0o644, 0, 0, 6).unwrap();
    }

    #[test]
    fn owns_path_excludes_tmpfs_scratch_and_relative() {
        assert!(owns_path(b"/usr/bin/ls"));
        assert!(owns_path(b"/"));
        assert!(owns_path(b"/etc/passwd"));
        // tmpfs scratch prefixes belong to tmpfs, not rootfs.
        assert!(!owns_path(b"/tmp"));
        assert!(!owns_path(b"/tmp/x"));
        assert!(!owns_path(b"/var/run/php.sock"));
        // non-absolute is never a rootfs path.
        assert!(!owns_path(b"relative"));
    }

    #[test]
    fn claims_path_gated_on_enable() {
        let _g = TestGuard::acquire();
        assert!(!claims_path(b"/usr/bin/ls"));
        set_enabled(true);
        assert!(claims_path(b"/usr/bin/ls"));
        assert!(!claims_path(b"/tmp/x")); // still tmpfs's
    }

    #[test]
    fn lstat_reports_kind_mode_and_size() {
        let _g = TestGuard::acquire();
        build_sample_tree();

        let d = lstat(b"/usr/bin").unwrap();
        assert_eq!(d.st_mode & S_IFMT, S_IFDIR);
        assert_eq!(d.st_mode & 0o7777, 0o755);

        let f = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!(f.st_mode & S_IFMT, S_IFREG);
        assert_eq!(f.st_size, 11);
        assert_eq!(f.st_mode & 0o7777, 0o755);
        assert_eq!(f.st_dev, ROOTFS_DEV);
        assert_eq!(f.st_ino, 4);

        let l = lstat(b"/usr/bin/hi").unwrap();
        assert_eq!(l.st_mode & S_IFMT, S_IFLNK);
        assert_eq!(l.st_size, 5); // "hello"

        assert_eq!(lstat(b"/nope").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/usr/bin/hello/x").unwrap_err(), Errno::ENOTDIR);
    }

    #[test]
    fn readlink_returns_target() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut buf = [0u8; 64];
        let n = readlink(b"/usr/bin/hi", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello");
        assert_eq!(readlink(b"/usr/bin/hello", &mut buf).unwrap_err(), Errno::EINVAL);
    }

    #[test]
    fn open_read_base_file_through_blob_callback() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut blob = make_blob_reader(alloc::vec![(42u64, b"hello world".to_vec())]);

        let h = open(b"/usr/bin/hello", O_RDONLY, 0, 0, 0).unwrap();
        assert!(is_rootfs_file_handle(h));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(h));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(h));

        assert_eq!(size(h).unwrap(), 11);
        let st = fstat(h).unwrap();
        assert_eq!(st.st_ino, 4);

        let mut buf = [0u8; 5];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 5);
        assert_eq!(&buf, b"hello");

        let mut buf2 = [0u8; 32];
        assert_eq!(read(h, 6, &mut buf2, &mut blob).unwrap(), 5); // "world" (clamped to size 11)
        assert_eq!(&buf2[..5], b"world");

        // Read at/after EOF returns 0.
        assert_eq!(read(h, 11, &mut buf2, &mut blob).unwrap(), 0);

        assert!(release_handle(h));
    }

    #[test]
    fn empty_base_file_reads_zero_without_touching_blob() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // A reader that would panic if called proves the EOF clamp short-circuits.
        let mut blob = |_id: u64, _off: u64, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("blob_read must not be called for an empty file");
        };
        let h = open(b"/etc-issue-blob-empty", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 0);
        assert!(release_handle(h));
    }

    #[test]
    fn open_directory_is_eisdir_and_write_is_erofs() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert_eq!(open(b"/usr/bin", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::EISDIR);
        // O_WRONLY == 1: write intent is EROFS until the mutable overlay (2b).
        assert_eq!(open(b"/usr/bin/hello", 1, 0, 0, 0).unwrap_err(), Errno::EROFS);
    }

    #[test]
    fn opendir_readdir_lists_children() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let h = opendir(b"/usr/bin").unwrap();
        assert!(is_rootfs_dir_handle(h));
        let mut names: alloc::vec::Vec<alloc::vec::Vec<u8>> = alloc::vec::Vec::new();
        let mut namebuf = [0u8; 256];
        while let Some((_ino, _dt, n)) = readdir(h, &mut namebuf).unwrap() {
            names.push(namebuf[..n].to_vec());
        }
        names.sort();
        assert_eq!(names, alloc::vec![b"hello".to_vec(), b"hi".to_vec()]);
        closedir(h).unwrap();
        assert_eq!(readdir(h, &mut namebuf).unwrap_err(), Errno::EBADF);
    }

    #[test]
    fn getdents64_injects_dot_entries() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut buf = [0u8; 512];
        let (written, _cookie, _done) = getdents64(b"/usr/bin", &mut buf, 0).unwrap();
        assert!(written > 0);
        // The formatter injects "." and ".."; the raw buffer should contain the
        // child names too.
        let hay = &buf[..written];
        assert!(hay.windows(5).any(|w| w == b"hello"));
        assert!(hay.windows(2).any(|w| w == b"hi"));
    }

    #[test]
    fn is_dir_predicate() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert!(is_dir(b"/usr/bin"));
        assert!(!is_dir(b"/usr/bin/hello"));
        assert!(!is_dir(b"/nope"));
    }

    #[test]
    fn duplicate_insert_is_eexist_and_missing_parent_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/a", 0o755, 0, 0, 2).unwrap();
        assert_eq!(insert_base_dir(b"/a", 0o755, 0, 0, 9).unwrap_err(), Errno::EEXIST);
        assert_eq!(
            insert_base_file(b"/missing/child", 1, 1, 0o644, 0, 0, 9).unwrap_err(),
            Errno::ENOENT
        );
    }

    #[test]
    fn handle_bands_disjoint_from_tmpfs() {
        // A rootfs file/dir handle must not be misread as a tmpfs handle, and
        // vice versa, now that is_tmpfs_dir_handle is bounded.
        let rootfs_file = inode_to_file_handle(0);
        let rootfs_dir = iter_to_dir_handle(0);
        assert!(is_rootfs_file_handle(rootfs_file));
        assert!(is_rootfs_dir_handle(rootfs_dir));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(rootfs_file));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(rootfs_file));
        assert!(!crate::tmpfs::is_tmpfs_file_handle(rootfs_dir));
        assert!(!crate::tmpfs::is_tmpfs_dir_handle(rootfs_dir));
    }
}
