//! In-kernel tmpfs backing Kandelo's scratch mounts (`/tmp`, `/var/tmp`,
//! `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`).
//!
//! Part of Phase 5 of the rust-first runtime migration: filesystem *authority*
//! moves from the TypeScript host into the portable Rust kernel core. Scratch
//! mounts start empty, so this first slice needs no tar/zip/image parser — it is
//! a pure in-memory inode tree. See
//! `docs/plans/2026-08-28-phase5-vfs-to-rust.md`.
//!
//! Path resolution, symlink walking, `..`/mount crossing, and access checks are
//! already owned by `syscalls::resolve_namespace_path_from`; every path this
//! module receives is therefore an already-canonical, mount-relative-resolved
//! absolute path. This module owns only the *flat store* for scratch prefixes:
//! given a canonical path it serves lstat/open/read/write/mkdir/readdir/unlink.
//!
//! # Handle encoding
//! An open tmpfs regular file is named by a negative host handle
//! `-(TMPFS_FILE_HANDLE_BASE + inode_index)`; an open tmpfs directory stream by
//! `-(TMPFS_DIR_HANDLE_BASE + dir_iter_index)`. These ranges are disjoint from
//! every other negative-handle class (pipes, devices, procfs bufs, synthetic
//! regulars at `1e9`). The read/write cursor lives in the per-OFD
//! `OpenFileDesc::offset` field (like host files), so tmpfs is not a
//! shared-cursor backing.
//!
//! # NOTE on the mount table
//! The scratch mount layout is currently mirrored from
//! `host/src/vfs/default-mounts.ts`. Until the host passes mount config to the
//! kernel (a later increment), this list is the single Rust-side source of truth
//! and must be kept in sync with that file.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::mode::{S_IFDIR, S_IFMT, S_IFREG};
use wasm_posix_shared::Errno;
use wasm_posix_shared::WasmStat;

// Open-file creation flags we honor here (mirrors syscalls.rs values).
const O_ACCMODE: u32 = 0o3;
const O_RDONLY: u32 = 0o0;
const O_CREAT: u32 = 0o100;
const O_EXCL: u32 = 0o200;
const O_TRUNC: u32 = 0o1000;
const O_DIRECTORY: u32 = 0o200000;

/// Directory entry type codes as reported through getdents64 `d_type`.
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;

/// Disjoint negative-handle bases. Kept far from the small pipe/device/procfs
/// sentinels and from `SYNTHETIC_REGULAR_HANDLE_BASE` (1e9).
pub const TMPFS_FILE_HANDLE_BASE: i64 = 2_000_000_000;
pub const TMPFS_DIR_HANDLE_BASE: i64 = 3_000_000_000;

/// One synthetic `st_dev` per scratch mount so cross-mount `rename`/`link`
/// correctly raise EXDEV and `st_dev`-based file identity stays distinct.
const TMPFS_DEV_BASE: u64 = 0x7400_0000;

struct ScratchMount {
    /// Canonical mount point, no trailing slash (except the impossible "/").
    prefix: &'static [u8],
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    st_dev: u64,
}

/// Mirror of the `scratch` entries in `host/src/vfs/default-mounts.ts`.
const SCRATCH_MOUNTS: &[ScratchMount] = &[
    ScratchMount { prefix: b"/tmp", mode: 0o1777, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE },
    ScratchMount { prefix: b"/var/tmp", mode: 0o1777, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 1 },
    ScratchMount { prefix: b"/var/log", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 2 },
    ScratchMount { prefix: b"/var/run", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 3 },
    ScratchMount { prefix: b"/home/maker", mode: 0o755, uid: 1000, gid: 1000, st_dev: TMPFS_DEV_BASE + 4 },
    ScratchMount { prefix: b"/root", mode: 0o700, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 5 },
    ScratchMount { prefix: b"/srv", mode: 0o755, uid: 0, gid: 0, st_dev: TMPFS_DEV_BASE + 6 },
];

enum InodeKind {
    Dir(BTreeMap<Vec<u8>, u32>),
    Regular(Vec<u8>),
}

struct Inode {
    kind: InodeKind,
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    /// Number of directory entries (hard links) referencing this inode. A
    /// directory counts `.` plus one per child subdir plus its parent's entry.
    nlink: u32,
    /// Live open descriptions. The inode is freed only when both `nlink` and
    /// `open_count` reach zero (POSIX unlink-while-open).
    open_count: u32,
    st_dev: u64,
    ino: u64,
}

impl Inode {
    fn stat(&self) -> WasmStat {
        let type_bits = match self.kind {
            InodeKind::Dir(_) => S_IFDIR,
            InodeKind::Regular(_) => S_IFREG,
        };
        let size = match &self.kind {
            InodeKind::Dir(entries) => entries.len() as u64,
            InodeKind::Regular(data) => data.len() as u64,
        };
        WasmStat {
            st_dev: self.st_dev,
            st_ino: self.ino,
            st_mode: type_bits | (self.mode & 0o7777),
            st_nlink: self.nlink,
            st_uid: self.uid,
            st_gid: self.gid,
            st_size: size,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        }
    }

    fn is_dir(&self) -> bool {
        matches!(self.kind, InodeKind::Dir(_))
    }
}

/// A materialized directory stream: a snapshot of entries plus a cursor. Taken
/// at `opendir` time; concurrent modifications after that are not reflected,
/// which matches how the host readdir stream behaves.
struct DirIter {
    entries: Vec<(Vec<u8>, u64, u32)>,
    cursor: usize,
}

struct TmpfsState {
    /// Inode slab; index is the inode's stable table index (distinct from `ino`).
    inodes: Vec<Option<Inode>>,
    free_inodes: Vec<u32>,
    /// Root inode index per `SCRATCH_MOUNTS` entry, lazily created on first use.
    mount_roots: Vec<Option<u32>>,
    /// Open directory streams keyed by dir-iter index.
    dir_iters: Vec<Option<DirIter>>,
    free_dir_iters: Vec<u32>,
    next_ino: u64,
}

impl TmpfsState {
    fn new() -> Self {
        TmpfsState {
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            mount_roots: alloc::vec![None; SCRATCH_MOUNTS.len()],
            dir_iters: Vec::new(),
            free_dir_iters: Vec::new(),
            next_ino: 1,
        }
    }

    fn alloc_ino(&mut self) -> u64 {
        let ino = self.next_ino;
        self.next_ino += 1;
        ino
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

    /// Free an inode if it has no remaining names and no open descriptions.
    fn maybe_free(&mut self, idx: u32) {
        let drop_it = self
            .get(idx)
            .map(|inode| inode.nlink == 0 && inode.open_count == 0)
            .unwrap_or(false);
        if drop_it {
            self.inodes[idx as usize] = None;
            self.free_inodes.push(idx);
        }
    }

    /// Root inode index for a mount, creating it on first touch.
    fn mount_root(&mut self, mount_idx: usize) -> u32 {
        if let Some(root) = self.mount_roots[mount_idx] {
            return root;
        }
        let mount = &SCRATCH_MOUNTS[mount_idx];
        let ino = self.alloc_ino();
        let root = self.insert_inode(Inode {
            kind: InodeKind::Dir(BTreeMap::new()),
            mode: mount.mode,
            uid: mount.uid,
            gid: mount.gid,
            // A fresh directory has two links: its own entry and `.`.
            nlink: 2,
            open_count: 0,
            st_dev: mount.st_dev,
            ino,
        });
        self.mount_roots[mount_idx] = Some(root);
        root
    }

    /// Walk `components` from `mount_root`, returning the target inode index.
    /// Every intermediate component must be an existing directory.
    fn walk(&self, mut cur: u32, components: &[&[u8]]) -> Result<u32, Errno> {
        for comp in components {
            let inode = self.get(cur).ok_or(Errno::ENOENT)?;
            match &inode.kind {
                InodeKind::Dir(entries) => {
                    cur = *entries.get(*comp).ok_or(Errno::ENOENT)?;
                }
                InodeKind::Regular(_) => return Err(Errno::ENOTDIR),
            }
        }
        Ok(cur)
    }

    /// Resolve a path to (parent_dir_idx, final_component, target_if_present).
    /// The mount root itself is returned as `(root, None, Some(root))`.
    fn resolve<'a>(
        &mut self,
        mount_idx: usize,
        rel: &'a [&'a [u8]],
    ) -> Result<(u32, Option<&'a [u8]>, Option<u32>), Errno> {
        let root = self.mount_root(mount_idx);
        if rel.is_empty() {
            return Ok((root, None, Some(root)));
        }
        let (parent_comps, last) = rel.split_at(rel.len() - 1);
        let parent = self.walk(root, parent_comps)?;
        let last = last[0];
        let parent_inode = self.get(parent).ok_or(Errno::ENOENT)?;
        let target = match &parent_inode.kind {
            InodeKind::Dir(entries) => entries.get(last).copied(),
            InodeKind::Regular(_) => return Err(Errno::ENOTDIR),
        };
        Ok((parent, Some(last), target))
    }
}

struct TmpfsGlobal {
    locked: AtomicBool,
    state: UnsafeCell<Option<TmpfsState>>,
}

struct UnlockOnDrop<'a>(&'a AtomicBool);

impl Drop for UnlockOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl TmpfsGlobal {
    const fn new() -> Self {
        TmpfsGlobal {
            locked: AtomicBool::new(false),
            state: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut TmpfsState) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: `locked` serializes every access; Kandelo enters one kernel
        // instance at a time, exactly like the other GlobalBackingTable stores.
        let slot = unsafe { &mut *self.state.get() };
        f(slot.get_or_insert_with(TmpfsState::new))
    }
}

// SAFETY: identical invariant to descriptor_backing's GlobalBackingTable — the
// spinlock is the sole gate and no reference escapes the closure.
unsafe impl Sync for TmpfsGlobal {}

static TMPFS: TmpfsGlobal = TmpfsGlobal::new();

/// Split a canonical mount-relative remainder into non-empty components.
fn split_components(rel: &[u8]) -> Vec<&[u8]> {
    rel.split(|&b| b == b'/').filter(|c| !c.is_empty()).collect()
}

/// If `path` lies within a scratch mount, return `(mount_idx, relative_bytes)`.
/// `relative_bytes` is the portion after the mount prefix (may be empty for the
/// mount root). Chooses the longest matching prefix.
fn match_mount(path: &[u8]) -> Option<(usize, &[u8])> {
    let mut best: Option<(usize, &[u8])> = None;
    for (idx, mount) in SCRATCH_MOUNTS.iter().enumerate() {
        let p = mount.prefix;
        let is_match = path == p
            || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/');
        if is_match {
            let better = best.map_or(true, |(_, r)| p.len() > (path.len() - r.len()));
            if better {
                best = Some((idx, &path[p.len()..]));
            }
        }
    }
    best
}

/// Master switch for in-kernel tmpfs authority over the scratch mounts.
///
/// Defaults OFF so this machinery is dormant: real hosts keep serving the
/// scratch mounts from their own backends until the cutover increment enables
/// tmpfs (and removes the host-side scratch mounts) at boot. Tests enable it
/// explicitly. `owns_path` stays a pure prefix predicate; the syscall dispatch
/// gates on `claims_path`, which additionally requires this flag.
static TMPFS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable or disable in-kernel tmpfs authority. Returns the previous value.
pub fn set_enabled(enabled: bool) -> bool {
    TMPFS_ENABLED.swap(enabled, Ordering::SeqCst)
}

/// Whether in-kernel tmpfs authority is currently active.
pub fn is_enabled() -> bool {
    TMPFS_ENABLED.load(Ordering::SeqCst)
}

/// Whether a canonical path lies within a scratch-mount prefix. Pure predicate;
/// does not consider whether tmpfs authority is enabled.
pub fn owns_path(path: &[u8]) -> bool {
    match_mount(path).is_some()
}

/// Whether the in-kernel tmpfs currently claims authority over a path: tmpfs is
/// enabled AND the path is within a scratch mount. The syscall dispatch gates
/// every path-op interception on this.
pub fn claims_path(path: &[u8]) -> bool {
    is_enabled() && owns_path(path)
}

/// Whether a host handle names an open tmpfs regular file.
pub fn is_tmpfs_file_handle(handle: i64) -> bool {
    handle <= -TMPFS_FILE_HANDLE_BASE && handle > -TMPFS_DIR_HANDLE_BASE
}

/// Whether a host handle names an open tmpfs directory stream.
pub fn is_tmpfs_dir_handle(handle: i64) -> bool {
    handle <= -TMPFS_DIR_HANDLE_BASE
}

fn file_handle_to_inode(handle: i64) -> Result<u32, Errno> {
    if !is_tmpfs_file_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - TMPFS_FILE_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn inode_to_file_handle(idx: u32) -> i64 {
    -(TMPFS_FILE_HANDLE_BASE + idx as i64)
}

fn dir_handle_to_iter(handle: i64) -> Result<u32, Errno> {
    if !is_tmpfs_dir_handle(handle) {
        return Err(Errno::EBADF);
    }
    u32::try_from(-handle - TMPFS_DIR_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

fn iter_to_dir_handle(idx: u32) -> i64 {
    -(TMPFS_DIR_HANDLE_BASE + idx as i64)
}

/// lstat a canonical tmpfs path. (No symlinks in this increment, so `stat`
/// resolves identically.)
pub fn lstat(path: &[u8]) -> Result<WasmStat, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        Ok(state.get(idx).ok_or(Errno::ENOENT)?.stat())
    })
}

/// Open (optionally creating) a tmpfs regular file. Returns the encoded host
/// handle and the inode number. The caller is responsible for building the OFD
/// and honoring the access mode; `open_count` is incremented here and released
/// via [`release_handle`].
pub fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let inode_idx = match target {
            Some(existing) => {
                if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                    return Err(Errno::EEXIST);
                }
                let inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if inode.is_dir() {
                    if flags & O_ACCMODE != O_RDONLY {
                        return Err(Errno::EISDIR);
                    }
                } else if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                if flags & O_TRUNC != 0 && !inode.is_dir() && flags & O_ACCMODE != O_RDONLY {
                    if let Some(InodeKind::Regular(data)) =
                        state.get_mut(existing).map(|i| &mut i.kind)
                    {
                        data.clear();
                    }
                }
                existing
            }
            None => {
                if flags & O_CREAT == 0 {
                    return Err(Errno::ENOENT);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                let last = last.ok_or(Errno::ENOENT)?;
                let ino = state.alloc_ino();
                let new_idx = state.insert_inode(Inode {
                    kind: InodeKind::Regular(Vec::new()),
                    mode: mode & 0o7777,
                    uid,
                    gid,
                    nlink: 1,
                    open_count: 0,
                    st_dev,
                    ino,
                });
                if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
                    entries.insert(last.to_vec(), new_idx);
                } else {
                    return Err(Errno::ENOTDIR);
                }
                new_idx
            }
        };
        // A directory opened O_RDONLY is legal (e.g. for fstat/fchdir) but this
        // increment routes directory descriptors through opendir; refuse here so
        // callers use the right path and never treat a dir handle as a file.
        if state.get(inode_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        state.get_mut(inode_idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(inode_idx))
    })
}

/// Read up to `buf.len()` bytes at `offset`. Returns the number read (0 at EOF).
pub fn read(handle: i64, offset: i64, buf: &mut [u8]) -> Result<usize, Errno> {
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    TMPFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        let InodeKind::Regular(data) = &inode.kind else {
            return Err(Errno::EISDIR);
        };
        let start = offset as usize;
        if start >= data.len() {
            return Ok(0);
        }
        let n = core::cmp::min(buf.len(), data.len() - start);
        buf[..n].copy_from_slice(&data[start..start + n]);
        Ok(n)
    })
}

/// Write `buf` at `offset`, growing (and zero-filling any gap) as needed.
pub fn write(handle: i64, offset: i64, buf: &[u8]) -> Result<usize, Errno> {
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        let InodeKind::Regular(data) = &mut inode.kind else {
            return Err(Errno::EISDIR);
        };
        let start = offset as usize;
        let end = start.checked_add(buf.len()).ok_or(Errno::EFBIG)?;
        if end > data.len() {
            data.resize(end, 0);
        }
        data[start..end].copy_from_slice(buf);
        Ok(buf.len())
    })
}

/// Current size of an open tmpfs file (for `SEEK_END`).
pub fn size(handle: i64) -> Result<i64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::Regular(data) => Ok(data.len() as i64),
            InodeKind::Dir(_) => Err(Errno::EISDIR),
        }
    })
}

/// fstat an open tmpfs file handle.
pub fn fstat(handle: i64) -> Result<WasmStat, Errno> {
    let idx = file_handle_to_inode(handle)?;
    TMPFS.with(|state| Ok(state.get(idx).ok_or(Errno::EBADF)?.stat()))
}

/// Truncate an open tmpfs regular file to `length`, zero-filling any growth.
/// The caller enforces access mode and RLIMIT_FSIZE.
pub fn truncate_handle(handle: i64, length: i64) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    let new_len = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
    TMPFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        match &mut inode.kind {
            InodeKind::Regular(data) => {
                data.resize(new_len, 0);
                Ok(())
            }
            InodeKind::Dir(_) => Err(Errno::EISDIR),
        }
    })
}

/// Add an owning reference (fork/dup inheriting a tmpfs fd). Returns whether the
/// handle was recognized as a tmpfs file handle.
pub fn add_ref_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    TMPFS.with(|state| {
        if let Some(inode) = state.get_mut(idx) {
            inode.open_count += 1;
            true
        } else {
            false
        }
    })
}

/// Drop one owning reference (close/exec-cloexec). Frees the inode if it was the
/// last reference and the file had already been unlinked. Returns `true` when
/// this drop released the final open reference (open_count reached zero),
/// mirroring `descriptor_backing::release_for_ofd` so the caller knows to
/// release this description's advisory locks. A stale/unrecognized handle
/// returns `false`.
pub fn release_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    TMPFS.with(|state| {
        let Some(inode) = state.get_mut(idx) else {
            return false;
        };
        inode.open_count = inode.open_count.saturating_sub(1);
        let was_last = inode.open_count == 0;
        state.maybe_free(idx);
        was_last
    })
}

/// Whether a tmpfs handle still names a live backing (trust-boundary check).
pub fn handle_is_live(handle: i64) -> bool {
    if let Ok(idx) = file_handle_to_inode(handle) {
        return TMPFS.with(|state| state.get(idx).is_some());
    }
    if let Ok(idx) = dir_handle_to_iter(handle) {
        return TMPFS.with(|state| {
            state
                .dir_iters
                .get(idx as usize)
                .map(|slot| slot.is_some())
                .unwrap_or(false)
        });
    }
    false
}

/// mkdir a tmpfs directory.
pub fn mkdir(path: &[u8], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        // The mount root already exists.
        return Err(Errno::EEXIST);
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let st_dev = SCRATCH_MOUNTS[mount_idx].st_dev;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode {
            kind: InodeKind::Dir(BTreeMap::new()),
            mode: mode & 0o7777,
            uid,
            gid,
            nlink: 2,
            open_count: 0,
            st_dev,
            ino,
        });
        match state.get_mut(parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert(last.to_vec(), new_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        // A new subdirectory bumps the parent's link count (its `..`).
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink += 1;
        }
        Ok(())
    })
}

/// Remove an empty tmpfs directory.
pub fn rmdir(path: &[u8]) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EBUSY); // cannot remove a mount root
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        match &state.get(target).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(entries) => {
                if !entries.is_empty() {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            InodeKind::Regular(_) => return Err(Errno::ENOTDIR),
        }
        if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
            entries.remove(last);
        }
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink = parent_inode.nlink.saturating_sub(1);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = 0;
        }
        state.maybe_free(target);
        Ok(())
    })
}

/// Unlink a tmpfs non-directory name.
pub fn unlink(path: &[u8]) -> Result<(), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    if comps.is_empty() {
        return Err(Errno::EISDIR);
    }
    TMPFS.with(|state| {
        let (parent, last, target) = state.resolve(mount_idx, &comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) {
            entries.remove(last);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = inode.nlink.saturating_sub(1);
        }
        state.maybe_free(target);
        Ok(())
    })
}

/// Open a directory stream over a tmpfs directory, returning an encoded handle.
pub fn opendir(path: &[u8]) -> Result<i64, Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        let entries = match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(map) => {
                let mut out: Vec<(Vec<u8>, u64, u32)> = Vec::with_capacity(map.len());
                for (name, &child_idx) in map.iter() {
                    let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
                    let d_type = if child.is_dir() { DT_DIR } else { DT_REG };
                    out.push((name.clone(), child.ino, d_type));
                }
                out
            }
            InodeKind::Regular(_) => return Err(Errno::ENOTDIR),
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

/// Read the next entry from a tmpfs directory stream. Returns
/// `Ok(Some((ino, d_type, name_len)))` after copying the name into `name_buf`,
/// or `Ok(None)` at end of stream. Mirrors the `host_readdir` contract.
pub fn readdir(handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    TMPFS.with(|state| {
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

/// Sentinel host handle marking an open tmpfs *directory* descriptor. Distinct
/// from the procfs (-150) and devfs (-160) directory sentinels. A tmpfs
/// directory OFD carries this in both `host_handle` and `dir_host_handle`;
/// contents are regenerated per getdents from the live store (mirrors devfs), so
/// no per-open backing is needed.
pub const TMPFS_DIR_SENTINEL: i64 = -170;

/// Whether a canonical tmpfs path names an existing directory.
pub fn is_dir(path: &[u8]) -> bool {
    lstat(path)
        .map(|st| st.st_mode & S_IFMT == S_IFDIR)
        .unwrap_or(false)
}

/// getdents64 for a tmpfs directory: build the entry list from the live store
/// and hand it to the shared virtual-dirent formatter, which injects `.`/`..`
/// and honors the cookie/short-buffer protocol. Returns
/// `(bytes_written, new_cookie, exhausted)`.
pub fn getdents64(path: &[u8], buf: &mut [u8], offset: i64) -> Result<(usize, i64, bool), Errno> {
    let (mount_idx, rel) = match_mount(path).ok_or(Errno::ENOENT)?;
    let comps = split_components(rel);
    let (dir_ino, entries) = TMPFS.with(|state| {
        let root = state.mount_root(mount_idx);
        let idx = state.walk(root, &comps)?;
        let dir = state.get(idx).ok_or(Errno::ENOENT)?;
        let InodeKind::Dir(map) = &dir.kind else {
            return Err(Errno::ENOTDIR);
        };
        let dir_ino = dir.ino;
        let mut out: Vec<(Vec<u8>, u8, u64)> = Vec::with_capacity(map.len());
        for (name, &child_idx) in map.iter() {
            let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
            let d_type = if child.is_dir() { DT_DIR as u8 } else { DT_REG as u8 };
            out.push((name.clone(), d_type, child.ino));
        }
        Ok((dir_ino, out))
    })?;
    // `..` inode is not tracked across the tmpfs/host boundary; report the
    // directory's own inode, which callers never rely on for `..`.
    crate::procfs::write_virtual_dirents64(buf, offset, dir_ino, dir_ino, &entries)
}

/// Close a tmpfs directory stream.
pub fn closedir(handle: i64) -> Result<(), Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    TMPFS.with(|state| {
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

#[cfg(test)]
mod tests {
    use super::*;

    const O_RDWR: u32 = 0o2;

    // These tests run against the process-global TMPFS. Each test uses a unique
    // path subtree so they remain independent even when run in one binary.

    fn read_all(handle: i64) -> Vec<u8> {
        let mut out = Vec::new();
        let mut off = 0i64;
        let mut buf = [0u8; 8];
        loop {
            let n = read(handle, off, &mut buf).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            off += n as i64;
        }
        out
    }

    #[test]
    fn ownership_matches_scratch_prefixes_only() {
        assert!(owns_path(b"/tmp"));
        assert!(owns_path(b"/tmp/a"));
        assert!(owns_path(b"/var/run/nginx.pid"));
        assert!(owns_path(b"/home/maker/x"));
        assert!(!owns_path(b"/tmpfoo")); // prefix must be a path boundary
        assert!(!owns_path(b"/usr/bin/sh"));
        assert!(!owns_path(b"/var")); // /var itself is not a scratch mount
    }

    #[test]
    fn create_write_read_roundtrip() {
        let p = b"/tmp/roundtrip.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(h, 0, b"hello ").unwrap(), 6);
        assert_eq!(write(h, 6, b"world").unwrap(), 5);
        assert_eq!(read_all(h), b"hello world");
        let st = fstat(h).unwrap();
        assert_eq!(st.st_size, 11);
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_mode & 0o7777, 0o644);
        // lstat by path agrees with fstat.
        let lst = lstat(p).unwrap();
        assert_eq!(lst.st_ino, st.st_ino);
        assert_eq!(lst.st_size, 11);
        assert!(release_handle(h));
    }

    #[test]
    fn truncate_grows_and_shrinks() {
        let h = open(b"/tmp/trunc_h", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"abcdef").unwrap();
        truncate_handle(h, 3).unwrap();
        assert_eq!(read_all(h), b"abc");
        truncate_handle(h, 5).unwrap();
        assert_eq!(read_all(h), &[b'a', b'b', b'c', 0, 0]);
        assert_eq!(fstat(h).unwrap().st_size, 5);
        release_handle(h);
    }

    #[test]
    fn write_past_end_zero_fills_gap() {
        let h = open(b"/tmp/sparse.bin", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(h, 4, b"AB").unwrap(), 2);
        assert_eq!(read_all(h), &[0, 0, 0, 0, b'A', b'B']);
        release_handle(h);
    }

    #[test]
    fn o_excl_rejects_existing() {
        let p = b"/tmp/excl.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(h);
        assert_eq!(
            open(p, O_CREAT | O_EXCL | O_RDWR, 0o644, 0, 0).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn o_trunc_clears_content() {
        let p = b"/tmp/trunc.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"content").unwrap();
        release_handle(h);
        let h2 = open(p, O_TRUNC | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(read_all(h2), b"");
        release_handle(h2);
    }

    #[test]
    fn open_missing_without_creat_is_enoent() {
        assert_eq!(open(b"/tmp/nope", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn mkdir_and_readdir() {
        mkdir(b"/srv/d", 0o755, 0, 0).unwrap();
        let a = open(b"/srv/d/a", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(a);
        mkdir(b"/srv/d/sub", 0o755, 0, 0).unwrap();

        let dh = opendir(b"/srv/d").unwrap();
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut namebuf = [0u8; 256];
        while let Some((_ino, _dt, n)) = readdir(dh, &mut namebuf).unwrap() {
            names.push(namebuf[..n].to_vec());
        }
        closedir(dh).unwrap();
        names.sort();
        assert_eq!(names, alloc::vec![b"a".to_vec(), b"sub".to_vec()]);

        // Parent gained a link from the subdirectory's `..`.
        let st = lstat(b"/srv/d").unwrap();
        assert_eq!(st.st_nlink, 3); // self + `.` + sub/..
    }

    #[test]
    fn mkdir_existing_is_eexist() {
        mkdir(b"/var/log/dir1", 0o755, 0, 0).unwrap();
        assert_eq!(mkdir(b"/var/log/dir1", 0o755, 0, 0).unwrap_err(), Errno::EEXIST);
    }

    #[test]
    fn rmdir_nonempty_is_enotempty() {
        mkdir(b"/var/tmp/rd", 0o755, 0, 0).unwrap();
        let f = open(b"/var/tmp/rd/f", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(f);
        assert_eq!(rmdir(b"/var/tmp/rd").unwrap_err(), Errno::ENOTEMPTY);
        unlink(b"/var/tmp/rd/f").unwrap();
        rmdir(b"/var/tmp/rd").unwrap();
        assert_eq!(lstat(b"/var/tmp/rd").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn unlink_while_open_keeps_data_until_last_close() {
        let p = b"/tmp/unlinked.txt";
        let h = open(p, O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        write(h, 0, b"still here").unwrap();
        unlink(p).unwrap();
        // Name is gone...
        assert_eq!(lstat(p).unwrap_err(), Errno::ENOENT);
        // ...but the open handle still reads its data.
        assert_eq!(read_all(h), b"still here");
        assert!(handle_is_live(h));
        release_handle(h);
        assert!(!handle_is_live(h));
    }

    #[test]
    fn handle_ranges_are_disjoint() {
        let fh = open(b"/tmp/disjoint", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let dh = opendir(b"/tmp").unwrap();
        assert!(is_tmpfs_file_handle(fh));
        assert!(!is_tmpfs_dir_handle(fh));
        assert!(is_tmpfs_dir_handle(dh));
        assert!(!is_tmpfs_file_handle(dh));
        // Neither collides with the synthetic-regular range (1e9): a tmpfs
        // handle must not be misclassified as a synthetic regular, or the
        // synthetic dispatch arms would shadow it.
        assert!(fh <= -TMPFS_FILE_HANDLE_BASE);
        assert!(!crate::descriptor_backing::is_synthetic_regular_handle(fh));
        assert!(!crate::descriptor_backing::is_synthetic_regular_handle(dh));
        closedir(dh).unwrap();
        release_handle(fh);
    }

    #[test]
    fn opening_a_directory_as_file_is_eisdir() {
        mkdir(b"/root/adir", 0o755, 0, 0).unwrap();
        assert_eq!(
            open(b"/root/adir", O_RDONLY, 0, 0, 0).unwrap_err(),
            Errno::EISDIR
        );
    }
}
