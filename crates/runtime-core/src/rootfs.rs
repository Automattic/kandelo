//! In-kernel overlay for the image-backed root filesystem `/`.
//!
//! The kernel, not the host, is the filesystem authority for `/`: the portable
//! Rust kernel core owns the tree, its metadata and every mutation, so Node and
//! browser hosts see one implementation. Where `tmpfs.rs` owns the empty
//! scratch mounts, this module owns the rootfs tree — which is **not** empty,
//! so it is an *overlay*:
//!
//! - an **immutable base layer** — dirs, symlinks, and regular-file *metadata*
//!   owned in Rust, built at boot by the kernel parsing the VFS image itself
//!   ([`load_image`], reached through `kernel_rootfs_load_image`). An ordinary
//!   base file's bytes are read on demand from that image (the host serves
//!   positioned reads of it through `host_image_read`); a deferred file's bytes
//!   are fetched by the URI the image recorded (`host_fetch_deferred`). Base
//!   bytes are never mutated.
//! - a **mutable overlay layer** — Rust-owned, identical to the tmpfs model:
//!   files created under `/`, and base files copied-on-write on first write.
//! - **whiteouts** hiding deleted base entries.
//!
//! [`export_tree_read`] remains a metadata-only diagnostic dump of the tree.
//! The store is **dormant by default**
//! (`set_enabled`, default off): the host enables it at boot after the image
//! has loaded.
//!
//! # Handle encoding
//! Disjoint negative-handle bands, 1e9 wide, below the tmpfs bands:
//! rootfs file `(-5e9, -4e9]`, rootfs dir `(-6e9, -5e9]`. The read/write cursor
//! lives in the per-OFD `OpenFileDesc::offset` field (like host and tmpfs
//! files), so rootfs is not a shared-cursor backing.

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use sha2::{Digest, Sha256};
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};

use crate::persistent_overlay::{Mutation, OverlayJournal, OverlayKey, OverlayStorage};
use crate::directory_entries::{DirectoryEntries, PreparedDirectoryName};
use crate::metadata_budget::{MetadataReservation, ROOTFS_METADATA};
use spin::Mutex;
pub use crate::rootfs_image::PhysicalImageRead;
use wasm_posix_shared::Errno;
use wasm_posix_shared::WasmStat;
use wasm_posix_shared::WasmStatfs;
use wasm_posix_shared::mode::{S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFREG, S_IFSOCK};

mod metadata_export;
mod namespace_activation;
mod recovery_slots;

// Open-file creation flags we honor here (mirrors syscalls.rs / tmpfs.rs).
const O_ACCMODE: u32 = 0o3;
const O_RDONLY: u32 = 0o0;
const O_WRONLY: u32 = 0o1;
const O_CREAT: u32 = 0o100;
const O_EXCL: u32 = 0o200;
const O_TRUNC: u32 = 0o1000;
const O_DIRECTORY: u32 = 0o200000;
const MAX_DIRTY_PERSISTENT_TIMESTAMPS: usize = 64;
const RESERVED_IMAGE_INODES: u64 = 2;
const INODE_METADATA_BYTES: usize = 512;
const FREE_INODE_METADATA_BYTES: usize = 8;
type OwnedMetadata = crate::metadata_budget::MetadataBytes<'static>;

fn own_metadata(bytes: &[u8]) -> Result<OwnedMetadata, Errno> {
    OwnedMetadata::copy_from(&ROOTFS_METADATA, bytes)
}
const _: () = assert!(core::mem::size_of::<Option<Inode>>() <= INODE_METADATA_BYTES);

/// Directory entry type codes as reported through getdents64 `d_type`.
const DT_FIFO: u32 = 1;
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;
const DT_LNK: u32 = 10;
const DT_SOCK: u32 = 12;

/// Dirent `d_type` for an inode.
fn dirent_type(inode: &Inode) -> u8 {
    match inode.kind {
        InodeKind::Dir(_) => DT_DIR as u8,
        InodeKind::Symlink(_) => DT_LNK as u8,
        InodeKind::BaseRegular { .. }
        | InodeKind::Regular(_)
        | InodeKind::PersistentRegular
        | InodeKind::LazyMember { .. } => {
            DT_REG as u8
        }
        InodeKind::Special(type_bits) => {
            if type_bits & S_IFMT == S_IFSOCK {
                DT_SOCK as u8
            } else {
                DT_FIFO as u8
            }
        }
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

/// An inode in the rootfs overlay: base (immutable) kinds placed by a loader,
/// plus the mutable overlay kinds (`Regular(Vec<u8>)` for copied-on-write or
/// created files).
enum InodeKind {
    Dir(DirectoryEntries<'static>),
    /// A base regular file: immutable content the overlay did not create.
    /// `size` is authoritative metadata from whichever loader placed the node,
    /// and `source` says where the bytes come from — see [`BaseSource`].
    BaseRegular {
        blob_id: u64,
        size: u64,
        source: BaseSource,
    },
    /// A Rust-owned mutable regular file: either created under `/` at runtime or
    /// a base file copied-on-write on first write. Bytes live in kernel memory.
    Regular(Vec<u8>),
    PersistentRegular,
    /// Symbolic link holding its target path bytes.
    Symlink(OwnedMetadata),
    /// A metadata-only special file (AF_UNIX socket or FIFO). The `S_IF*` type
    /// bits are stored; the communication endpoint lives in the socket registry
    /// or fifo table, keyed by path — mirrors the tmpfs `Special` node.
    Special(u32),
    /// A lazy-archive member: metadata (`size`, mode, etc.) is authoritative
    /// from the loader like `BaseRegular`, but the bytes live in a
    /// not-yet-fetched archive (`archive_id`) at `source_path` within it. The
    /// first read fetches and decodes the archive ([`ensure_archive_member`]).
    LazyMember {
        archive_id: u32,
        source_path: OwnedMetadata,
        size: u64,
    },
}

/// Where a [`InodeKind::BaseRegular`] file's bytes come from.
///
/// The `/` image is the kernel's own artifact: the kernel mounts it and walks
/// it at boot ([`load_image`]), so for an ordinary file in
/// that image the kernel can also *read* it, through the same KIFS cursor, and
/// needs no host byte store at all. That is the whole point of `Image`: a base
/// file's bytes stop being something the host resolves by path on the kernel's
/// behalf and become something the kernel addresses in the artifact it already
/// parsed.
///
/// `Host` is what remains: bytes the image genuinely does not carry. Today that
/// is a URL-backed lazy file — the image records only its real size, and the
/// host owns the transport that fetches it — plus a base file placed by
/// [`insert_base_file`] with host-held bytes. (The RTFS manifest loader that
/// once placed whole host-walked trees this way was removed on 2026-10-02.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseSource {
    /// The bytes are in the `/` image, at KIFS inode `blob_id`. Served by the
    /// kernel's own KIFS reader; no host byte-store call.
    Image,
    /// The bytes are outside the image: fetched through the host by the
    /// deferred URI the image recorded (`ByteReq::Deferred`).
    Host,
}

struct Inode {
    kind: InodeKind,
    base_dense: bool,
    allocated_blocks: u64,
    /// The opaque deferred description the loaded image carried for this file,
    /// or empty when it carried none.
    ///
    /// This is RETAINED rather than reconstructed, because the kernel cannot
    /// reconstruct it: for a URL-backed base file the fetch descriptor (URL,
    /// transport, digest) lives entirely in the payload, and the only other
    /// thing identifying such a file is its inode number in the image it came
    /// from — which an export renumbers. Carrying the bytes through is what
    /// lets an exported image say where a deferred file's content is without
    /// the kernel ever parsing what it says. See [`crate::sdef`].
    ///
    /// It lives on the inode rather than in a side table keyed by index so it
    /// dies with the inode; a freed index cannot hand a stale payload to
    /// whatever is allocated there next.
    deferred_payload: OwnedMetadata,
    /// Where this file's bytes are, as an address the kernel relays to whoever
    /// fetches, and what they must hash to. Both retained verbatim from the
    /// image that described the file, for the same reason the payload is: this
    /// inode number does not survive an export's renumbering, so if the address
    /// is not kept beside the file, an exported image loses the only thing that
    /// says where its bytes are.
    ///
    /// Empty / [`crate::sdef::DIGEST_NONE`] when the image declared
    /// none, which every `KLZY`-described image does — it has no field for
    /// either.
    deferred_uri: OwnedMetadata,
    deferred_digest: [u8; crate::sdef::DIGEST_LEN],
    /// This file's bytes are NOT in the image, whether or not the image said
    /// where they come from.
    ///
    /// `deferred_payload` cannot answer this. A `KLZY`-described image records
    /// that a file is deferred and how big it really is, and carries NO fetch
    /// description at all -- the URL lives in host-side JSON the kernel does
    /// not read. So a deferred file loaded from one arrives with an empty
    /// payload, which is indistinguishable from a base file the host WALKED,
    /// whose bytes are an ordinary host file and which was never deferred.
    ///
    /// Those two must not be confused, because the export treats them
    /// oppositely: a walked base file is a stub with nothing to re-emit, and a
    /// deferred file re-emitted as a stub silently becomes a zero-length
    /// ordinary file, which is the loss this flag exists to prevent.
    deferred_base: bool,
    /// Permission bits only (no `S_IFMT`).
    mode: u32,
    uid: u32,
    gid: u32,
    /// Number of directory entries (hard links) referencing this inode.
    nlink: u32,
    /// Live open descriptions (for handle validity / future unlink-while-open).
    open_count: u32,
    /// Shared-mapping references (see [`pin_mapping`]). Like `open_count`, they
    /// keep an unlinked inode alive, but they are counted apart from it on
    /// purpose: the last *descriptor* close is the moment POSIX releases the
    /// description's locks, and a live mapping must not postpone that.
    map_pins: u32,
    /// Bumped by every content mutation (see [`content_generation`]).
    content_gen: u64,
    synced_content_gen: u64,
    ino: u64,
    persistent_size: Option<u64>,
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
            base_dense: true,
            allocated_blocks: 0,
            deferred_payload: OwnedMetadata::empty(&ROOTFS_METADATA),
            deferred_uri: OwnedMetadata::empty(&ROOTFS_METADATA),
            deferred_digest: crate::sdef::DIGEST_NONE,
            deferred_base: false,
            mode,
            uid,
            gid,
            nlink,
            open_count: 0,
            map_pins: 0,
            content_gen: 0,
            synced_content_gen: 0,
            ino,
            persistent_size: None,
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
            InodeKind::BaseRegular { .. }
            | InodeKind::Regular(_)
            | InodeKind::PersistentRegular
            | InodeKind::LazyMember { .. } => {
                S_IFREG
            }
            InodeKind::Symlink(_) => S_IFLNK,
            InodeKind::Special(type_bits) => type_bits,
        };
        let size = match &self.kind {
            InodeKind::Dir(entries) => entries.len() as u64,
            InodeKind::BaseRegular { size, .. } => self.persistent_size.unwrap_or(*size),
            InodeKind::Regular(data) => data.len() as u64,
            InodeKind::PersistentRegular => self.persistent_size.unwrap_or(0),
            InodeKind::Symlink(target) => target.len() as u64,
            InodeKind::Special(_) => 0,
            InodeKind::LazyMember { size, .. } => *size,
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
            // Image and tmpfs special nodes record only their type bits,
            // not a device number, so there is none to report.
            st_rdev: 0,
        }
    }

    fn is_dir(&self) -> bool {
        matches!(self.kind, InodeKind::Dir(_))
    }

    /// Stamp mtime and ctime (a content mutation: write, truncate), and advance
    /// the content generation.
    fn touch_modified(&mut self) {
        self.content_gen = self.content_gen.wrapping_add(1);
        let (sec, nsec) = now();
        self.mtime_sec = sec;
        self.mtime_nsec = nsec;
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Stamp ctime only (a metadata mutation: chmod, chown, link).
    fn touch_changed(&mut self) {
        let (sec, nsec) = now();
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }

    /// Clear set-user-ID, and set-group-ID on a group-executable file, on a
    /// content-modifying operation — the POSIX "a successful write clears
    /// set-user-ID" rule, matching the host path and tmpfs.
    /// Drop set-user-ID and set-group-ID because these bytes arrived without a
    /// digest to check them against.
    ///
    /// The rule: *the setuid bit is not honoured on unverified bytes.* A
    /// deferred setuid-root binary fetched over a URL with its
    /// LENGTH as the only check is bytes of the right size from wherever the
    /// host got them — a substituting host, a poisoned cache, a network
    /// position — executing as root inside the guest.
    ///
    /// Demoted rather than refused, which is what "not honoured" says. The file
    /// still runs; it runs as the calling user. Refusing would make an image
    /// that predates digests unbootable, and the truthful statement is not
    /// "these bytes are wrong" — it is "nothing here can tell you they are
    /// right, so they do not get to be root."
    fn demote_setid_unverified(&mut self) {
        const S_ISUID: u32 = 0o4000;
        const S_ISGID: u32 = 0o2000;
        self.mode &= !(S_ISUID | S_ISGID);
    }

    fn clear_setid_on_modify(&mut self) {
        const S_ISUID: u32 = 0o4000;
        const S_ISGID: u32 = 0o2000;
        const S_IXGRP: u32 = 0o0010;
        self.mode &= !S_ISUID;
        if self.mode & S_IXGRP != 0 {
            self.mode &= !S_ISGID;
        }
    }
}

struct DirIter {
    directory: u32,
    last_name: Option<Vec<u8>>,
    exhausted: bool,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum InodeReservationFailure {
    Arena,
    Reclamation,
}

struct RootfsState {
    inodes: Vec<Option<Inode>>,
    free_inodes: Vec<u32>,
    arena_metadata: MetadataReservation<'static>,
    #[cfg(test)]
    fail_inode_reservation: Option<InodeReservationFailure>,
    dirty_persistent_timestamps: BTreeSet<u32>,
    /// Root ("/") inode index, created on first use.
    root: Option<u32>,
    dir_iters: Vec<Option<DirIter>>,
    free_dir_iters: Vec<u32>,
    /// Inode numbers for overlay-created inodes; base inos come from the
    /// loader. Starts high to avoid colliding with typical manifest inos.
    next_ino: u64,
    /// Lazy-archive registry, populated by the loader from the image's archive
    /// declarations: `archive_id -> ArchiveEntry`. Consumed by the
    /// byte-serving path ([`ensure_archive_member`]); cleared by `reset()` like
    /// the rest of the store, so a failed load never leaves stale entries.
    archives: BTreeMap<u32, ArchiveEntry>,
    /// Set by [`set_export_timestamp`]; overrides every emitted inode's times.
    export_timestamp_ms: Option<u64>,
    /// The capacity a builder asked the next exported image to have, if any.
    ///
    /// A product declares this (`expectedMaxByteLength`) and its publication
    /// gate checks the artifact against it. Without it the export sizes to its
    /// own tree, so the image has no runtime growth room and meets no declared
    /// capacity.
    image_capacity_bytes: Option<u64>,
    /// Image metadata for the next export, as opaque bytes. The kernel neither
    /// writes nor reads what is in here — `version`, `kernelAbi`, `createdBy`
    /// are the builder's statements about its own artifact — but the section
    /// has to be in the container, and the container is the kernel's to write.
    image_metadata: Option<OwnedMetadata>,
    /// Where the `/` VFS image's KIFS filesystem lives inside the container,
    /// and the superblock geometry [`load_image`] already validated. `None`
    /// until an image is loaded, and cleared by `reset()` with the rest of the
    /// store, so a failed load never leaves a geometry pointing at a tree that
    /// is not there.
    ///
    /// Held because the image is the byte store for every `BaseSource::Image`
    /// file, for the life of the session — not just for the boot walk.
    image: Option<ImageGeometry>,
    persistent_allocated_blocks: Option<u64>,
    verified_reads: crate::verified_read_cache::VerifiedReadCache,
    archive_verified_reads: crate::verified_read_cache::VerifiedReadCache,
    archive_readers: Vec<(u32, crate::zip_stream::MemberReader)>,
    archive_directories: Vec<(u32, crate::zip_stream::Directory)>,
}

/// The `/` image's container-relative KIFS span plus its validated superblock
/// geometry. Enough to re-address the image's filesystem on any later read
/// without re-parsing the container header or the superblock.
#[derive(Debug, Clone, Copy)]
struct ImageGeometry {
    /// Length of the whole VFSI container, as the host declared it at load.
    image_len: u64,
    /// Byte offset of the KIFS filesystem within the container.
    fs_offset: u64,
    /// Byte length of the KIFS filesystem. NOT `image_len` above, which is the
    /// whole container — the two differ by the header and every other section.
    fs_len: u64,
    capacity_bytes: u64,
    image: crate::kandelo_image_fs::KandeloImageGeometry,
}

/// Registry entry for one lazy archive: manifest-authoritative `size`, plus a
/// fetch/decode cache populated lazily on first touch of any member.
///
/// `size` comes from the image's archive declaration and is always present.
/// `raw`, `directory`, and `members` start empty and are filled in by the
/// byte-serving path ([`ensure_archive_member`]): `raw` holds the whole
/// fetched archive blob (fetched once, on first touch of any member of this
/// archive), `directory` holds the parsed central directory, and `members`
/// caches each member's inflated bytes on first read of that member.
struct ArchiveEntry {
    /// The archive's own fetch description, retained from the image that
    /// declared it so an export can re-emit it. Empty when the image carried
    /// none — `KLZY` has no field for one, so an image described that way
    /// always yields empty here.
    payload: OwnedMetadata,
    /// Where the archive is, and what its `size` fetched bytes must hash to.
    /// Retained for the same reason the payload is, and read — not merely
    /// carried — by the fetch path: the URI is what the kernel hands the host
    /// as the address, and the digest is what it checks the arriving bytes
    /// against before any of them are cached.
    uri: OwnedMetadata,
    digest: [u8; crate::sdef::DIGEST_LEN],
    size: u64,
    raw: Option<Arc<Vec<u8>>>,
    directory: Option<Arc<Vec<crate::zip::ZipEntry>>>,
    members: BTreeMap<Vec<u8>, Arc<Vec<u8>>>,
    _metadata: MetadataReservation<'static>,
}

impl ArchiveEntry {
    fn new(size: u64, uri: &[u8], digest: [u8; crate::sdef::DIGEST_LEN], payload: &[u8]) -> Result<Self, Errno> {
        let metadata = ROOTFS_METADATA.reserve(4096)?;
        let uri = own_metadata(uri)?;
        let payload = own_metadata(payload)?;
        Ok(Self { payload, uri, digest, size, raw: None, directory: None,
            members: BTreeMap::new(), _metadata: metadata })
    }
}

impl RootfsState {
    fn new() -> Self {
        RootfsState {
            inodes: Vec::new(),
            free_inodes: Vec::new(),
            arena_metadata: ROOTFS_METADATA.empty(),
            #[cfg(test)]
            fail_inode_reservation: None,
            dirty_persistent_timestamps: BTreeSet::new(),
            root: None,
            dir_iters: Vec::new(),
            free_dir_iters: Vec::new(),
            next_ino: 1,
            archives: BTreeMap::new(),
            export_timestamp_ms: None,
            image: None,
            image_capacity_bytes: None,
            image_metadata: None,
            persistent_allocated_blocks: None,
            verified_reads: crate::verified_read_cache::VerifiedReadCache::new(),
            archive_verified_reads: crate::verified_read_cache::VerifiedReadCache::new(),
            archive_readers: Vec::new(),
            archive_directories: Vec::new(),
        }
    }

    fn bump_next_ino(&mut self, seen: u64) {
        if seen >= self.next_ino {
            self.next_ino = seen + 1;
        }
    }

    /// Allocate a fresh inode number for an overlay-created file (base inos come
    /// from the loaded image or manifest; `bump_next_ino` keeps this ahead of
    /// them).
    fn alloc_ino(&mut self) -> u64 {
        let ino = self.next_ino;
        self.next_ino += 1;
        ino
    }

    fn reserve_inode_slots(&mut self, additional: usize) -> Result<(), Errno> {
        let appended = additional.saturating_sub(self.free_inodes.len());
        let required = self.inodes.len().checked_add(appended).ok_or(Errno::ENOMEM)?;
        if required != 0 && u32::try_from(required - 1).is_err() {
            return Err(Errno::ENOMEM);
        }
        let inode_capacity = if required > self.inodes.capacity() {
            required.max(self.inodes.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?).max(4)
        } else { self.inodes.capacity() };
        let free_capacity = if required > self.free_inodes.capacity() {
            required.max(self.free_inodes.capacity().checked_mul(2).ok_or(Errno::ENOMEM)?).max(4)
        } else { self.free_inodes.capacity() };
        let charge = |inodes: usize, free: usize| inodes.checked_mul(INODE_METADATA_BYTES)
            .and_then(|bytes| free.checked_mul(FREE_INODE_METADATA_BYTES).and_then(|free| bytes.checked_add(free)))
            .ok_or(Errno::ENOMEM);
        let previous = self.arena_metadata.bytes();
        self.arena_metadata.resize(charge(inode_capacity, free_capacity)?)?;
        let temporary_bytes = charge(
            if inode_capacity > self.inodes.capacity() { self.inodes.capacity() } else { 0 },
            if free_capacity > self.free_inodes.capacity() { self.free_inodes.capacity() } else { 0 },
        )?;
        let temporary = match ROOTFS_METADATA.reserve_temporary(temporary_bytes) {
            Ok(reservation) => reservation,
            Err(error) => {
                self.arena_metadata.resize(previous).expect("arena reservation rollback failed");
                return Err(error);
            }
        };
        let result = (|| {
            #[cfg(test)]
            if inode_capacity > self.inodes.capacity()
                && self.fail_inode_reservation == Some(InodeReservationFailure::Arena)
            { return Err(Errno::ENOMEM); }
            self.inodes.try_reserve_exact(inode_capacity.saturating_sub(self.inodes.len())).map_err(|_| Errno::ENOMEM)?;
            #[cfg(test)]
            if free_capacity > self.free_inodes.capacity()
                && self.fail_inode_reservation == Some(InodeReservationFailure::Reclamation)
            { return Err(Errno::ENOMEM); }
            self.free_inodes.try_reserve_exact(free_capacity.saturating_sub(self.free_inodes.len()))
                .map_err(|_| Errno::ENOMEM)
        })();
        self.arena_metadata.resize(charge(self.inodes.capacity(), self.free_inodes.capacity())?)?;
        drop(temporary);
        result
    }

    fn link_unpublished_inode(&mut self, parent: u32, name: &[u8], child: u32) -> Result<(), Errno> {
        let result = match self.get_mut(parent).map(|inode| &mut inode.kind) {
            Some(InodeKind::Dir(entries)) => entries.try_insert(name, child).map(|_| ()),
            _ => Err(Errno::ENOTDIR),
        };
        if result.is_err() {
            self.inodes[child as usize] = None;
            self.free_inodes.push(child);
            self.persistent_allocated_blocks = None;
        }
        result
    }

    fn insert_inode(&mut self, inode: Inode) -> Result<u32, Errno> {
        self.reserve_inode_slots(1)?;
        Ok(self.insert_prepared_inode(inode))
    }

    fn insert_prepared_inode(&mut self, inode: Inode) -> u32 {
        assert!(self.free_inodes.capacity() >= self.inodes.len());
        self.persistent_allocated_blocks = None;
        if let Some(idx) = self.free_inodes.pop() {
            self.inodes[idx as usize] = Some(inode);
            idx
        } else {
            assert!(self.inodes.len() < self.inodes.capacity());
            assert!(self.free_inodes.capacity() > self.inodes.len());
            let idx = self.inodes.len() as u32;
            self.inodes.push(Some(inode));
            idx
        }
    }

    fn invalidate_verified_uri(&mut self, uri: &[u8]) {
        for inode in self.inodes.iter().flatten() {
            let matches = match &inode.kind {
                InodeKind::BaseRegular { source: BaseSource::Host, .. } => inode.deferred_uri == uri,
                InodeKind::LazyMember { archive_id, .. } => self.archives.get(archive_id).is_some_and(|archive| archive.uri == uri),
                _ => false,
            };
            if matches { self.verified_reads.invalidate(inode.ino); }
        }
        for (archive_id, archive) in self.archives.iter_mut().filter(|(_, archive)| archive.uri == uri) {
            self.archive_verified_reads.invalidate(*archive_id as u64);
            self.archive_readers.retain(|(cached_id, _)| cached_id != archive_id);
            self.archive_directories.retain(|(cached_id, _)| cached_id != archive_id);
            archive.raw = None;
            archive.directory = None;
            archive.members.clear();
        }
    }

    fn image_inode_counts(&self) -> Option<(u64, u64)> {
        self.image.map(|image| {
            let capacity = u64::from(image.image.total_inodes);
            let allocated = (self.inodes.len() - self.free_inodes.len()) as u64
                + RESERVED_IMAGE_INODES;
            (capacity, capacity.saturating_sub(allocated))
        })
    }

    fn require_image_inode_slot(&mut self) -> Result<(), Errno> {
        if self.image_inode_counts().is_some_and(|(_, free)| free == 0) {
            return Err(Errno::ENOSPC);
        }
        self.reserve_inode_slots(1)
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
    /// metadata. The loader's `/` entry refines that metadata via
    /// [`insert_base_dir`].
    fn mount_root(&mut self) -> Result<u32, Errno> {
        if let Some(root) = self.root {
            return Ok(root);
        }
        let ino = 1;
        let root = self.insert_inode(Inode::new(
            InodeKind::Dir(DirectoryEntries::new()),
            0o755,
            0,
            0,
            2,
            ino,
        ))?;
        self.bump_next_ino(ino);
        self.root = Some(root);
        Ok(root)
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

    /// Resolve a path to (parent_dir_idx, final_component, target_if_present).
    /// The root itself is returned as `(root, None, Some(root))`. Mirrors the
    /// tmpfs resolver.
    fn resolve<'a>(
        &mut self,
        rel: &'a [&'a [u8]],
    ) -> Result<(u32, Option<&'a [u8]>, Option<u32>), Errno> {
        let root = self.mount_root()?;
        if rel.is_empty() {
            return Ok((root, None, Some(root)));
        }
        let (parent_comps, last) = rel.split_at(rel.len() - 1);
        let parent = self.walk(root, parent_comps)?;
        let last = last[0];
        let parent_inode = self.get(parent).ok_or(Errno::ENOENT)?;
        let target = match &parent_inode.kind {
            InodeKind::Dir(entries) => entries.get(last).copied(),
            _ => return Err(Errno::ENOTDIR),
        };
        Ok((parent, Some(last), target))
    }

    /// Free an inode if it has no remaining names and no open descriptions
    /// (POSIX unlink-while-open). Base and overlay inodes alike: a base file's
    /// bytes live in the host, so dropping the inode just forgets the mapping.
    fn maybe_free(&mut self, idx: u32) {
        let drop_it = self
            .get(idx)
            .map(|inode| inode.nlink == 0 && inode.open_count == 0 && inode.map_pins == 0)
            .unwrap_or(false);
        if drop_it {
            if let Some(key) = self.get(idx).map(|inode| inode.ino) {
                self.verified_reads.invalidate(key);
            }
            self.persistent_allocated_blocks = None;
            self.dirty_persistent_timestamps.remove(&idx);
            self.inodes[idx as usize] = None;
            self.free_inodes.push(idx);
        }
    }

    /// Recompute a directory's link count from scratch: 2 (self + `.`) plus one
    /// per child subdirectory (each child dir's `..`). Robust against any move,
    /// replace, or removal.
    fn recompute_dir_nlink(&mut self, dir_idx: u32) {
        let child_dirs = match self.get(dir_idx) {
            Some(inode) => match &inode.kind {
                InodeKind::Dir(entries) => entries
                    .values()
                    .filter(|&&child| self.get(child).is_some_and(|i| i.is_dir()))
                    .count(),
                _ => return,
            },
            None => return,
        };
        if let Some(inode) = self.get_mut(dir_idx) {
            inode.nlink = 2 + child_dirs as u32;
        }
    }
}

/// Walk to a rootfs inode index for a metadata update. The final component is
/// not followed (the kernel already resolved symlinks per the syscall's FOLLOW
/// policy before calling), so lchown-style callers land on the link itself.
fn walk_to_inode(path: &[u8]) -> Result<u32, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        state.walk(root, &comps)
    })
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

type PersistentJournal = OverlayJournal<Box<dyn OverlayStorage + Send>>;
const PERSISTENT_REGULAR_RECORD_BYTES: usize = 52;

#[derive(Clone, Copy)]
struct PersistentInodeMetadata {
    mode: u32,
    uid: u32,
    gid: u32,
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
}

impl PersistentInodeMetadata {
    fn from_inode(inode: &Inode) -> Self {
        Self {
            mode: inode.mode,
            uid: inode.uid,
            gid: inode.gid,
            atime_sec: inode.atime_sec,
            atime_nsec: inode.atime_nsec,
            mtime_sec: inode.mtime_sec,
            mtime_nsec: inode.mtime_nsec,
            ctime_sec: inode.ctime_sec,
            ctime_nsec: inode.ctime_nsec,
        }
    }

    fn apply(self, inode: &mut Inode) {
        inode.mode = self.mode;
        inode.uid = self.uid;
        inode.gid = self.gid;
        inode.atime_sec = self.atime_sec;
        inode.atime_nsec = self.atime_nsec;
        inode.mtime_sec = self.mtime_sec;
        inode.mtime_nsec = self.mtime_nsec;
        inode.ctime_sec = self.ctime_sec;
        inode.ctime_nsec = self.ctime_nsec;
    }

    fn touch_changed(&mut self) {
        let (sec, nsec) = now();
        self.ctime_sec = sec;
        self.ctime_nsec = nsec;
    }
}

#[derive(Clone, Copy)]
enum NamespaceTimestamp {
    Modified,
    Changed,
}

struct PreparedPersistentMetadataChange {
    index: u32,
    ino: u64,
    kind: u8,
    target: Vec<u8>,
    metadata: PersistentInodeMetadata,
}

impl PreparedPersistentMetadataChange {
    fn from_inode(index: u32, inode: &Inode) -> Result<Self, Errno> {
        let kind = match &inode.kind {
            InodeKind::PersistentRegular => 1,
            InodeKind::Dir(_) => 2,
            InodeKind::Symlink(_) => 3,
            InodeKind::BaseRegular { .. } | InodeKind::LazyMember { .. } => 4,
            InodeKind::Special(S_IFIFO) => 5,
            InodeKind::Special(S_IFSOCK) => 6,
            InodeKind::Special(_) => return Err(Errno::EINVAL),
            InodeKind::Regular(_) => return Err(Errno::EROFS),
        };
        let target = match &inode.kind {
            InodeKind::Symlink(target) => {
                let mut owned = Vec::new();
                owned.try_reserve_exact(target.len()).map_err(|_| Errno::ENOMEM)?;
                owned.extend_from_slice(target);
                owned
            }
            _ => Vec::new(),
        };
        Ok(Self {
            index,
            ino: inode.ino,
            kind,
            target,
            metadata: PersistentInodeMetadata::from_inode(inode),
        })
    }

    fn mutation(&self, journal: &mut PersistentJournal) -> Result<Mutation, Errno> {
        let stored_kind = match journal.metadata_value(&OverlayKey::Inode(self.ino))? {
            Some(Some(bytes)) if bytes.len() >= 2 => bytes[1],
            Some(_) => return Err(Errno::EIO),
            None => 4,
        };
        if (stored_kind != 4 && stored_kind != self.kind)
            || (stored_kind == 4 && self.kind == 1)
        {
            return Err(Errno::EIO);
        }
        let record_kind = if stored_kind == 4 { 4 } else { self.kind };
        let mode_kind = if record_kind == 4 && matches!(self.kind, 1 | 4) { 1 } else { record_kind };
        if self.metadata.mode & !persistent_inode_mode_mask(mode_kind) != 0 {
            return Err(Errno::EPERM);
        }
        let value = encode_inode_record(
            record_kind,
            if record_kind == 3 { &self.target } else { &[] },
            self.metadata,
        )?;
        Ok(Mutation::Put { key: OverlayKey::Inode(self.ino), value })
    }

    fn apply(self, state: &mut RootfsState) -> Result<(), Errno> {
        let inode = state.get_mut(self.index).ok_or(Errno::EIO)?;
        self.metadata.apply(inode);
        inode.synced_content_gen = inode.content_gen;
        state.dirty_persistent_timestamps.remove(&self.index);
        Ok(())
    }
}

struct CommittedNamespace {
    allocated: u64,
    names: Vec<(u32, PreparedDirectoryName<'static>)>,
    removed_names: Vec<RemovedNamespaceName>,
    _reservation: MetadataReservation<'static>,
}

struct RemovedNamespaceName {
    parent: u32,
    name: Vec<u8>,
    credit: Option<MetadataReservation<'static>>,
}

impl Drop for CommittedNamespace {
    fn drop(&mut self) {
        assert!(self.removed_names.is_empty(), "committed namespace removal not published");
    }
}

impl CommittedNamespace {
    fn remove_from(&mut self, state: &mut RootfsState, parent: u32, name: &[u8]) -> Result<(), Errno> {
        let position = self.removed_names.iter().position(|removed| removed.parent == parent && removed.name == name)
            .ok_or(Errno::EIO)?;
        let mut removed = self.removed_names.swap_remove(position);
        let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|inode| &mut inode.kind) else {
            return Err(Errno::EIO);
        };
        entries.remove_prepared(name, removed.credit.take().ok_or(Errno::EIO)?);
        Ok(())
    }

    fn take_name(&mut self, parent: u32, name: &[u8]) -> Result<PreparedDirectoryName<'static>, Errno> {
        let position = self.names.iter().position(|(directory, prepared)| *directory == parent && prepared.name() == name)
            .ok_or(Errno::EIO)?;
        let (_, prepared) = self.names.swap_remove(position);
        Ok(prepared)
    }

    fn insert_into(&mut self, state: &mut RootfsState, parent: u32, name: &[u8], inode: u32) -> Result<(), Errno> {
        let prepared = self.take_name(parent, name)?;
        let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|inode| &mut inode.kind) else {
            return Err(Errno::EIO);
        };
        entries.insert_prepared(prepared, inode);
        Ok(())
    }
}

struct PreparedReplayChange {
    parent: u32,
    name: Vec<u8>,
    target: Option<u32>,
    prepared: Option<PreparedDirectoryName<'static>>,
    removed_credit: Option<MetadataReservation<'static>>,
}

struct PreparedNamespaceReplay {
    changes: Vec<PreparedReplayChange>,
    links: Vec<u32>,
    scratch: MetadataReservation<'static>,
}

struct CanonicalDirentOrder {
    parent: Option<u64>,
    name: [u8; 255],
    length: usize,
}

impl CanonicalDirentOrder {
    fn new() -> Self { Self { parent: None, name: [0; 255], length: 0 } }

    fn accept(&mut self, parent: u64, name: &[u8]) -> Result<(), Errno> {
        crate::persistent_overlay::validate_dirent_name(parent, name).map_err(|_| Errno::EIO)?;
        if self.parent.is_some_and(|previous| parent < previous
                || (parent == previous && name <= &self.name[..self.length]))
        {
            return Err(Errno::EIO);
        }
        self.parent = Some(parent);
        self.name[..name.len()].copy_from_slice(name);
        self.length = name.len();
        Ok(())
    }
}

fn reserve_replay_vec<T>(count: usize, scratch: &mut MetadataReservation<'_>) -> Result<Vec<T>, Errno> {
    let charge = |capacity: usize| capacity.checked_mul(core::mem::size_of::<T>())
        .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM);
    let previous = scratch.bytes();
    scratch.resize(previous.checked_add(charge(count)?).ok_or(Errno::ENOMEM)?)?;
    let mut result = Vec::new();
    result.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)?;
    scratch.resize(previous.checked_add(charge(result.capacity())?).ok_or(Errno::ENOMEM)?)?;
    Ok(result)
}

impl PreparedNamespaceReplay {
    fn load(state: &RootfsState, journal: &mut PersistentJournal, created: &[(u64, Inode)], unlinked_parent_floor: Option<u64>) -> Result<Self, Errno> {
        Self::load_from_dirents(state, created, unlinked_parent_floor, |visit| {
            journal.for_each_metadata(|key, value| {
                if let OverlayKey::Dirent { parent, name } = key {
                    visit(*parent, name, value)?;
                }
                Ok(())
            })
        })
    }

    fn load_from_dirents(
        state: &RootfsState,
        created: &[(u64, Inode)],
        unlinked_parent_floor: Option<u64>,
        mut for_each: impl FnMut(&mut dyn FnMut(u64, &[u8], Option<&[u8]>) -> Result<(), Errno>) -> Result<(), Errno>,
    ) -> Result<Self, Errno> {
        let mut scratch = ROOTFS_METADATA.reserve_temporary(0)?;
        let count = state.inodes.iter().flatten().count().checked_add(created.len()).ok_or(Errno::ENOMEM)?;
        let length = state.inodes.len().checked_add(created.len().saturating_sub(state.free_inodes.len()))
            .ok_or(Errno::ENOMEM)?;
        let mut indices = reserve_replay_vec(count, &mut scratch)?;
        let mut directories = reserve_replay_vec(length, &mut scratch)?;
        directories.resize(length, false);
        for (index, inode) in state.inodes.iter().enumerate() {
            if let Some(inode) = inode {
                indices.push((inode.ino, u32::try_from(index).map_err(|_| Errno::EIO)?, inode.is_dir()));
                directories[index] = inode.is_dir();
            }
        }
        for (position, (ino, inode)) in created.iter().enumerate() {
            if matches!(&inode.kind, InodeKind::Dir(entries) if !entries.is_empty()) { return Err(Errno::EIO); }
            let index = if position < state.free_inodes.len() {
                state.free_inodes[state.free_inodes.len() - 1 - position]
            } else {
                u32::try_from(state.inodes.len() + position - state.free_inodes.len()).map_err(|_| Errno::ENOMEM)?
            };
            if state.get(index).is_some() { return Err(Errno::EIO); }
            indices.push((*ino, index, inode.is_dir()));
            *directories.get_mut(index as usize).ok_or(Errno::EIO)? = inode.is_dir();
        }
        indices.sort_unstable_by_key(|entry| entry.0);
        if indices.windows(2).any(|pair| pair[0].0 == pair[1].0) { return Err(Errno::EIO); }
        let index_for = |ino| indices.binary_search_by_key(&ino, |entry| entry.0)
            .map(|position| indices[position]).map_err(|_| Errno::EIO);
        let resolve = |parent, name: &[u8], value: Option<&[u8]>| {
            let (_, parent_index, directory) = match index_for(parent) {
                Ok(entry) => entry,
                Err(_) if value.is_none() && unlinked_parent_floor.is_some_and(|floor| parent >= floor) => return Ok(None),
                Err(error) => return Err(error),
            };
            if !directory { return Err(Errno::EIO); }
            let prior = match state.get(parent_index).map(|inode| &inode.kind) {
                Some(InodeKind::Dir(entries)) => entries.get(name).copied(),
                None => None,
                _ => return Err(Errno::EIO),
            };
            let target = value.map(|bytes| {
                let ino = u64::from_le_bytes(bytes.try_into().map_err(|_| Errno::EIO)?);
                index_for(ino).map(|(_, index, _)| index)
            }).transpose()?;
            Ok::<_, Errno>(Some((parent_index, prior, target)))
        };
        let mut change_count = 0usize;
        let mut order = CanonicalDirentOrder::new();
        for_each(&mut |parent, name, value| {
            order.accept(parent, name)?;
            let Some((_, prior, target)) = resolve(parent, name, value)? else { return Ok(()) };
            if prior != target { change_count = change_count.checked_add(1).ok_or(Errno::ENOMEM)?; }
            Ok(())
        })?;
        let mut changes = reserve_replay_vec(change_count, &mut scratch)?;
        let mut links = reserve_replay_vec(length, &mut scratch)?;
        links.resize(length, 0u32);
        let mut children = reserve_replay_vec(length, &mut scratch)?;
        children.resize(length, 0u32);
        for (parent, inode) in state.inodes.iter().enumerate() {
            if let Some(InodeKind::Dir(entries)) = inode.as_ref().map(|inode| &inode.kind) {
                for &index in entries.values() {
                    state.get(index).ok_or(Errno::EIO)?;
                    let count = links.get_mut(index as usize).ok_or(Errno::EIO)?;
                    *count = count.checked_add(1).ok_or(Errno::EIO)?;
                    if directories[index as usize] {
                        children[parent] = children[parent].checked_add(1).ok_or(Errno::EIO)?;
                    }
                }
            }
        }
        order = CanonicalDirentOrder::new();
        for_each(&mut |parent, name, value| {
            order.accept(parent, name)?;
            let Some((parent, prior, target)) = resolve(parent, name, value)? else { return Ok(()) };
            if prior == target { return Ok(()); }
            if changes.len() == change_count { return Err(Errno::EIO); }
            if let Some(index) = prior {
                links[index as usize] = links[index as usize].checked_sub(1).ok_or(Errno::EIO)?;
                if directories[index as usize] {
                    children[parent as usize] = children[parent as usize].checked_sub(1).ok_or(Errno::EIO)?;
                }
            }
            if let Some(index) = target {
                links[index as usize] = links[index as usize].checked_add(1).ok_or(Errno::EIO)?;
                if directories[index as usize] {
                    children[parent as usize] = children[parent as usize].checked_add(1).ok_or(Errno::EIO)?;
                }
            }
            let prepared = if prior.is_none() && target.is_some() {
                Some(PreparedDirectoryName::new_temporary(&ROOTFS_METADATA, name)?)
            } else { None };
            let mut owned = reserve_replay_vec(name.len(), &mut scratch)?;
            owned.extend_from_slice(name);
            changes.push(PreparedReplayChange { parent, name: owned, target, prepared, removed_credit: None });
            Ok(())
        })?;
        if changes.len() != change_count { return Err(Errno::EIO); }
        changes.sort_unstable_by(|left, right| left.parent.cmp(&right.parent).then_with(|| left.name.cmp(&right.name)));
        Self::validate_graph(state, &changes, &links, &directories, &mut scratch)?;
        for (index, count) in links.iter_mut().enumerate() {
            if directories[index] {
                *count = if Some(index as u32) == state.root || *count != 0 {
                    children[index].checked_add(2).ok_or(Errno::EIO)?
                } else { 0 };
            }
        }
        Ok(Self { changes, links, scratch })
    }

    fn validate_graph(
        state: &RootfsState,
        changes: &[PreparedReplayChange],
        links: &[u32],
        directories: &[bool],
        scratch: &mut MetadataReservation<'_>,
    ) -> Result<(), Errno> {
        let root = state.root.ok_or(Errno::EIO)? as usize;
        if !directories.get(root).copied().unwrap_or(false) { return Err(Errno::EIO); }
        let lookup = |parent: u32, name: &[u8], prior| {
            changes.binary_search_by(|change| change.parent.cmp(&parent).then_with(|| change.name.as_slice().cmp(name)))
                .map_or(prior, |index| changes[index].target)
        };
        let mut parents = reserve_replay_vec(directories.len(), scratch)?;
        parents.resize(directories.len(), None);
        let mut flags = reserve_replay_vec(directories.len(), scratch)?;
        flags.resize(directories.len(), 0u8);
        let mut pending = reserve_replay_vec(directories.iter().filter(|&&directory| directory).count(), scratch)?;
        for (parent, inode) in state.inodes.iter().enumerate() {
            if let Some(InodeKind::Dir(entries)) = inode.as_ref().map(|inode| &inode.kind) {
                for (name, &prior) in entries {
                    if let Some(child) = lookup(parent as u32, name, Some(prior)) {
                        if directories[child as usize] { parents[child as usize] = Some(parent as u32); }
                    }
                }
            }
        }
        for change in changes {
            if change.prepared.is_some() {
                if let Some(child) = change.target {
                    if directories[child as usize] { parents[child as usize] = Some(change.parent); }
                }
            }
        }
        for (index, &directory) in directories.iter().enumerate() {
            if !directory { continue; }
            if links[index] > 1 || (index == root && links[index] != 0) { return Err(Errno::EIO); }
            if index != root && links[index] == 0 {
                let start = changes.partition_point(|change| change.parent < index as u32);
                let end = changes.partition_point(|change| change.parent <= index as u32);
                if changes[start..end].iter().any(|change| change.target.is_some()) { return Err(Errno::EIO); }
                if let Some(InodeKind::Dir(entries)) = state.get(index as u32).map(|inode| &inode.kind) {
                    if entries.iter().any(|(name, &prior)| lookup(index as u32, name, Some(prior)).is_some()) {
                        return Err(Errno::EIO);
                    }
                }
            }
            let mut current = Some(index as u32);
            while let Some(directory) = current {
                match flags[directory as usize] {
                    2 => break,
                    1 => return Err(Errno::EIO),
                    _ => {}
                }
                flags[directory as usize] = 1;
                pending.push(directory);
                current = parents[directory as usize];
            }
            for directory in pending.drain(..) { flags[directory as usize] = 2; }
        }
        Ok(())
    }

    fn admit(self, state: &mut RootfsState) -> Result<Self, Errno> {
        self.admit_with(state, &mut [], || Ok(()))
    }

    fn admit_with(
        mut self,
        state: &mut RootfsState,
        additional: &mut [&mut MetadataReservation<'static>],
        operation: impl FnOnce() -> Result<(), Errno>,
    ) -> Result<Self, Errno> {
        let promoted = self.changes.iter().filter(|change| change.prepared.is_some()).count()
            .checked_add(additional.len()).ok_or(Errno::ENOMEM)?;
        let demoted = self.changes.iter().filter(|change| change.target.is_none()).count();
        let mut promote = reserve_replay_vec(promoted, &mut self.scratch)?;
        let mut demote = reserve_replay_vec(demoted, &mut self.scratch)?;
        for change in &mut self.changes {
            if change.target.is_none() {
                let InodeKind::Dir(entries) = &mut state.get_mut(change.parent).expect("replay parent missing").kind else {
                    unreachable!("replay parent is not a directory");
                };
                change.removed_credit = Some(entries.extract_name_credit(&change.name));
            }
            if let Some(prepared) = &mut change.prepared { promote.push(prepared.reservation_mut()); }
            if let Some(credit) = &mut change.removed_credit { demote.push(credit); }
        }
        for reservation in additional { promote.push(&mut **reservation); }
        let result = ROOTFS_METADATA.exchange(&mut promote, &mut demote).and_then(|()| {
            let result = operation();
            if result.is_err() {
                ROOTFS_METADATA.exchange(&mut demote, &mut promote)
                    .expect("namespace replay admission rollback failed");
            }
            result
        });
        drop((promote, demote));
        if let Err(error) = result {
            for change in &mut self.changes {
                if let Some(credit) = change.removed_credit.take() {
                    let InodeKind::Dir(entries) = &mut state.get_mut(change.parent).expect("replay parent missing").kind else {
                        unreachable!("replay parent is not a directory");
                    };
                    entries.restore_name_credit(credit);
                }
            }
            return Err(error);
        }
        Ok(self)
    }

    fn remove_prepared_names(&mut self, state: &mut RootfsState) {
        for change in &mut self.changes {
            if let Some(credit) = change.removed_credit.take() {
                let InodeKind::Dir(entries) = &mut state.get_mut(change.parent).expect("replay parent missing").kind else {
                    unreachable!("replay parent is not a directory");
                };
                entries.remove_prepared(&change.name, credit);
            }
        }
    }

    fn publish(mut self, state: &mut RootfsState) {
        self.remove_prepared_names(state);
        for change in self.changes {
            if let Some(target) = change.target {
                let InodeKind::Dir(entries) = &mut state.get_mut(change.parent).expect("replay parent missing").kind else {
                    unreachable!("replay parent is not a directory");
                };
                match change.prepared {
                    Some(prepared) => { entries.insert_prepared(prepared, target); }
                    None => entries.replace_existing(&change.name, target),
                }
            }
        }
        for (index, inode) in state.inodes.iter_mut().enumerate() {
            if let Some(inode) = inode { inode.nlink = self.links[index]; }
        }
        for index in 0..state.inodes.len() { state.maybe_free(index as u32); }
    }
}

fn commit_persistent_namespace(
    mutations: &[Mutation],
    timestamps: &[(u32, NamespaceTimestamp)],
) -> Result<CommittedNamespace, Errno> {
    persistent_statfs()?;
    let name_count = mutations.iter().filter(|mutation| matches!(mutation,
        Mutation::Put { key: OverlayKey::Dirent { .. }, .. })).count();
    let mut reservation = ROOTFS_METADATA.reserve_temporary(name_count.checked_mul(
        core::mem::size_of::<(u32, PreparedDirectoryName<'static>)>()).ok_or(Errno::ENOMEM)?)?;
    let mut names = Vec::new();
    names.try_reserve_exact(name_count).map_err(|_| Errno::ENOMEM)?;
    let (sec, nsec) = now();
    let mut retained_scratch = ROOTFS_METADATA.reserve_temporary(0)?;
    let mut present_dirents = reserve_replay_vec(mutations.len(), &mut retained_scratch)?;
    let mut removed_names = reserve_replay_vec(mutations.len(), &mut retained_scratch)?;
    let (changes, present_dirents) = ROOTFS.with(|state| {
        let mut changes: Vec<PreparedPersistentMetadataChange> = Vec::new();
        for mutation in mutations {
            let key = match mutation {
                Mutation::Put { key, .. } | Mutation::Delete { key } => key,
            };
            if let OverlayKey::Dirent { parent, name } = key {
                let parent_index = timestamps
                    .iter()
                    .find_map(|(index, _)| {
                        state
                            .get(*index)
                            .is_some_and(|inode| inode.ino == *parent)
                            .then_some(*index)
                    })
                    .ok_or(Errno::EIO)?;
                if let Some(InodeKind::Dir(entries)) =
                    state.get(parent_index).map(|inode| &inode.kind)
                {
                    if matches!(mutation, Mutation::Put { .. }) {
                        names.push((parent_index, PreparedDirectoryName::new_temporary(&ROOTFS_METADATA, name)?));
                    }
                    if entries.contains_key(name) {
                        present_dirents.push(key);
                        let mut owned = reserve_replay_vec(name.len(), &mut retained_scratch)?;
                        owned.extend_from_slice(name);
                        removed_names.push(RemovedNamespaceName { parent: parent_index, name: owned, credit: None });
                    }
                } else {
                    return Err(Errno::EIO);
                }
            }
        }
        for &(index, stamp) in timestamps {
            if let Some(change) = changes.iter_mut().find(|change| change.index == index) {
                if matches!(stamp, NamespaceTimestamp::Modified) {
                    change.metadata.mtime_sec = sec;
                    change.metadata.mtime_nsec = nsec;
                }
                continue;
            }
            let mut change = PreparedPersistentMetadataChange::from_inode(
                index,
                state.get(index).ok_or(Errno::EIO)?,
            )?;
            if matches!(stamp, NamespaceTimestamp::Modified) {
                change.metadata.mtime_sec = sec;
                change.metadata.mtime_nsec = nsec;
            }
            change.metadata.ctime_sec = sec;
            change.metadata.ctime_nsec = nsec;
            changes.push(change);
        }
        Ok::<_, Errno>((changes, present_dirents))
    })?;
    let mut active = PERSISTENT_ROOTFS.lock();
    let mount = active.as_mut().ok_or(Errno::EIO)?;
    let projected = ROOTFS.with(|state| {
        let allocated = state.persistent_allocated_blocks.ok_or(Errno::EIO)?;
        let projected = persistent_namespace_blocks(state, mutations, timestamps)?;
        let capacity = state.image.ok_or(Errno::EIO)?.capacity_bytes.div_ceil(4096);
        if projected > capacity && projected > allocated {
            return Err(Errno::ENOSPC);
        }
        Ok::<_, Errno>(projected)
    })?;
    let mut base_dirents = reserve_replay_vec(present_dirents.len(), &mut retained_scratch)?;
    for key in present_dirents {
        if mount.journal.metadata_value(key)?.is_none() {
            if let Some(prepared) = mount.base_dirents.prepare_temporary(key)? {
                base_dirents.push(prepared);
            }
        }
    }
    let journal = &mut mount.journal;
    let mut transaction = mutations.to_vec();
    for change in &changes {
        transaction.push(change.mutation(journal)?);
    }
    let mut promote = reserve_replay_vec(names.len().checked_add(base_dirents.len()).ok_or(Errno::ENOMEM)?, &mut retained_scratch)?;
    let mut demote = reserve_replay_vec(removed_names.len(), &mut retained_scratch)?;
    ROOTFS.with(|state| {
        for removed in &mut removed_names {
            let Some(InodeKind::Dir(entries)) = state.get_mut(removed.parent).map(|inode| &mut inode.kind) else {
                unreachable!("prepared namespace parent missing");
            };
            removed.credit = Some(entries.extract_name_credit(&removed.name));
        }
    });
    for (_, prepared) in &mut names { promote.push(prepared.reservation_mut()); }
    for prepared in &mut base_dirents { promote.push(prepared.reservation_mut()); }
    for removed in &mut removed_names { demote.push(removed.credit.as_mut().expect("prepared namespace credit missing")); }
    let admitted = ROOTFS_METADATA.exchange(&mut promote, &mut demote);
    let committed = admitted.and_then(|()| {
        let committed = journal.commit(&transaction);
        if committed.is_err() {
            ROOTFS_METADATA.exchange(&mut demote, &mut promote).expect("namespace admission rollback failed");
        }
        committed
    });
    drop((promote, demote));
    if let Err(error) = committed {
        ROOTFS.with(|state| {
            for removed in &mut removed_names {
                let Some(InodeKind::Dir(entries)) = state.get_mut(removed.parent).map(|inode| &mut inode.kind) else {
                    unreachable!("prepared namespace parent missing");
                };
                entries.restore_name_credit(removed.credit.take().expect("prepared namespace credit missing"));
            }
        });
        return Err(error);
    }
    for prepared in base_dirents { mount.base_dirents.insert_prepared(prepared); }
    ROOTFS.with(|state| {
        state.persistent_allocated_blocks = None;
        for change in changes {
            change.apply(state)?;
        }
        Ok::<_, Errno>(())
    })?;
    reservation.merge(retained_scratch);
    Ok(CommittedNamespace { allocated: projected, names, removed_names, _reservation: reservation })
}

fn encode_inode_record(kind: u8, target: &[u8], metadata: PersistentInodeMetadata) -> Result<Vec<u8>, Errno> {
    let length = PERSISTENT_REGULAR_RECORD_BYTES.checked_add(target.len()).ok_or(Errno::ENOMEM)?;
    let mut value = Vec::new();
    value.try_reserve_exact(length).map_err(|_| Errno::ENOMEM)?;
    value.extend_from_slice(&[1, kind, 0, 0]);
    value.extend_from_slice(&metadata.mode.to_le_bytes());
    value.extend_from_slice(&metadata.uid.to_le_bytes());
    value.extend_from_slice(&metadata.gid.to_le_bytes());
    value.extend_from_slice(&metadata.atime_sec.to_le_bytes());
    value.extend_from_slice(&metadata.atime_nsec.to_le_bytes());
    value.extend_from_slice(&metadata.mtime_sec.to_le_bytes());
    value.extend_from_slice(&metadata.mtime_nsec.to_le_bytes());
    value.extend_from_slice(&metadata.ctime_sec.to_le_bytes());
    value.extend_from_slice(&metadata.ctime_nsec.to_le_bytes());
    value.extend_from_slice(target);
    Ok(value)
}

fn persistent_inode_mode_mask(kind: u8) -> u32 {
    if matches!(kind, 2 | 3 | 4) { 0o7777 } else { 0o1777 }
}

fn encode_persistent_inode(inode: &Inode) -> Result<Vec<u8>, Errno> {
    let (kind, target) = match &inode.kind {
        InodeKind::PersistentRegular => (1, &[][..]),
        InodeKind::Dir(_) => (2, &[][..]),
        InodeKind::Symlink(target) => (3, target.as_slice()),
        InodeKind::Special(S_IFIFO) => (5, &[][..]),
        InodeKind::Special(S_IFSOCK) => (6, &[][..]),
        _ => unreachable!(),
    };
    if inode.mode & !persistent_inode_mode_mask(kind) != 0 {
        return Err(Errno::EPERM);
    }
    encode_inode_record(kind, target, PersistentInodeMetadata::from_inode(inode))
}

fn decode_inode_record(value: &[u8]) -> Result<PersistentInodeMetadata, Errno> {
    if value.len() < PERSISTENT_REGULAR_RECORD_BYTES
        || value.len() > 4096
        || value[0] != 1
        || value[2..4] != [0, 0]
    {
        return Err(Errno::EIO);
    }
    let read_u32 = |start| u32::from_le_bytes(value[start..start + 4].try_into().unwrap());
    let read_u64 = |start| u64::from_le_bytes(value[start..start + 8].try_into().unwrap());
    let metadata = PersistentInodeMetadata {
        mode: read_u32(4),
        uid: read_u32(8),
        gid: read_u32(12),
        atime_sec: read_u64(16),
        atime_nsec: read_u32(24),
        mtime_sec: read_u64(28),
        mtime_nsec: read_u32(36),
        ctime_sec: read_u64(40),
        ctime_nsec: read_u32(48),
    };
    if metadata.atime_nsec >= 1_000_000_000
        || metadata.mtime_nsec >= 1_000_000_000
        || metadata.ctime_nsec >= 1_000_000_000
    {
        return Err(Errno::EIO);
    }
    Ok(metadata)
}

fn validate_persistent_inode_record(value: &[u8]) -> Result<PersistentInodeMetadata, Errno> {
    let metadata = decode_inode_record(value)?;
    match value[1] {
        1 | 2 | 5 | 6 if value.len() == PERSISTENT_REGULAR_RECORD_BYTES => {},
        3 if value.len() > PERSISTENT_REGULAR_RECORD_BYTES => {},
        _ => return Err(Errno::EIO),
    }
    if metadata.mode & !persistent_inode_mode_mask(value[1]) != 0 {
        return Err(Errno::EIO);
    }
    Ok(metadata)
}

fn decode_persistent_inode(ino: u64, value: &[u8]) -> Result<Inode, Errno> {
    let metadata = validate_persistent_inode_record(value)?;
    let kind = match value[1] {
        1 if value.len() == PERSISTENT_REGULAR_RECORD_BYTES => InodeKind::PersistentRegular,
        2 if value.len() == PERSISTENT_REGULAR_RECORD_BYTES => InodeKind::Dir(DirectoryEntries::new()),
        3 if value.len() > PERSISTENT_REGULAR_RECORD_BYTES => {
            InodeKind::Symlink(own_metadata(&value[PERSISTENT_REGULAR_RECORD_BYTES..])?)
        }
        5 if value.len() == PERSISTENT_REGULAR_RECORD_BYTES => InodeKind::Special(S_IFIFO),
        6 if value.len() == PERSISTENT_REGULAR_RECORD_BYTES => InodeKind::Special(S_IFSOCK),
        _ => return Err(Errno::EIO),
    };
    let nlink = if matches!(kind, InodeKind::Dir(_)) { 2 } else { 0 };
    let mut inode = Inode::new(kind, metadata.mode, metadata.uid, metadata.gid, nlink, ino);
    if matches!(inode.kind, InodeKind::PersistentRegular) {
        inode.persistent_size = Some(0);
    }
    metadata.apply(&mut inode);
    Ok(inode)
}

struct PersistentMount {
    journal: PersistentJournal,
    resizable: bool,
    base_dirents: crate::retained_dirents::RetainedDirents<'static>,
}
static PERSISTENT_ROOTFS: Mutex<Option<PersistentMount>> = Mutex::new(None);
struct PreparedPersistence {
    journal: PersistentJournal,
    source_revision: (u64, u64),
    resizable: bool,
}
static PREPARED_PERSISTENCE: Mutex<Option<PreparedPersistence>> = Mutex::new(None);
static PERSISTENCE_RECOVERY_PRISTINE: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
static FAIL_PERSISTENCE_FIFO_RESTORE: AtomicBool = AtomicBool::new(false);

pub fn persistence_recovery_is_pristine() -> bool {
    PERSISTENCE_RECOVERY_PRISTINE.load(Ordering::SeqCst)
}

pub fn enable_fixed_persistence(
    storage: Box<dyn OverlayStorage + Send>,
    base_digest: [u8; 32],
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<(), Errno> {
    enable_persistence_internal(storage, None, base_digest, false, byte_source)
}

pub fn enable_fixed_persistence_indexed(
    storage: Box<dyn OverlayStorage + Send>,
    index: Box<dyn OverlayStorage + Send>,
    base_digest: [u8; 32],
    checkpoint_end: u64,
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<(), Errno> {
    enable_persistence_internal(storage, Some((index, checkpoint_end)), base_digest, false, byte_source)
}

pub fn enable_resizable_persistence(
    storage: Box<dyn OverlayStorage + Send>,
    base_digest: [u8; 32],
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<(), Errno> {
    enable_persistence_internal(storage, None, base_digest, true, byte_source)
}

pub fn enable_resizable_persistence_indexed(
    storage: Box<dyn OverlayStorage + Send>,
    index: Box<dyn OverlayStorage + Send>,
    base_digest: [u8; 32],
    checkpoint_end: u64,
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<(), Errno> {
    enable_persistence_internal(storage, Some((index, checkpoint_end)), base_digest, true, byte_source)
}

fn enable_persistence_internal(
    storage: Box<dyn OverlayStorage + Send>,
    checkpoint: Option<(Box<dyn OverlayStorage + Send>, u64)>,
    base_digest: [u8; 32],
    resizable: bool,
    mut byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<(), Errno> {
    PERSISTENCE_RECOVERY_PRISTINE.store(false, Ordering::SeqCst);
    if PERSISTENT_ROOTFS.lock().is_some() { return Err(Errno::EBUSY); }
    if persistent_image_binding().is_some_and(|binding| binding.digest != base_digest) {
        return Err(Errno::EIO);
    }
    PERSISTENCE_RECOVERY_PRISTINE.store(true, Ordering::SeqCst);
    let mut journal = match checkpoint {
        Some((index, checkpoint_end)) if resizable => {
            OverlayJournal::open_with_checkpoint_metadata(
                storage,
                index,
                base_digest,
                checkpoint_end,
            )?
        }
        Some((index, checkpoint_end)) => {
            OverlayJournal::open_with_checkpoint(storage, index, base_digest, checkpoint_end)?
        }
        None => OverlayJournal::open(storage, base_digest)?,
    };
    let minimum_created_ino = ROOTFS.with(|state| state.next_ino);
    let mut recovery_scratch = ROOTFS_METADATA.reserve_temporary(0)?;
    let base_indices = ROOTFS.with(|state| {
        let mut indices = reserve_replay_vec(state.inodes.iter().flatten().count(), &mut recovery_scratch)?;
        for (index, inode) in state.inodes.iter().enumerate() {
            if let Some(inode) = inode { indices.push((inode.ino, u32::try_from(index).map_err(|_| Errno::EIO)?)); }
        }
        indices.sort_unstable_by_key(|entry| entry.0);
        if indices.windows(2).any(|pair| pair[0].0 == pair[1].0) { return Err(Errno::EIO); }
        Ok::<_, Errno>(indices)
    })?;
    let mut base_update_count = 0usize;
    let mut namespace_replay = false;
    let mut referenced_count = 0usize;
    let mut cursor = journal.metadata_cursor(4096)?;
    while let Some((key, value)) = journal.next_metadata(&mut cursor)? {
        if matches!(key, OverlayKey::Inode(ino) if *ino < minimum_created_ino) {
            base_update_count = base_update_count.checked_add(1).ok_or(Errno::ENOMEM)?;
        }
        if let OverlayKey::Dirent { parent, .. } = key {
            namespace_replay = true;
            if *parent < minimum_created_ino {
                let position = base_indices.binary_search_by_key(parent, |entry| entry.0).map_err(|_| Errno::EIO)?;
                if !ROOTFS.with(|state| state.get(base_indices[position].1).is_some_and(Inode::is_dir)) { return Err(Errno::EIO); }
            } else {
                let record = journal.metadata_value(&OverlayKey::Inode(*parent))?.flatten().ok_or(Errno::EIO)?;
                validate_persistent_inode_record(&record)?;
                if record[1] != 2 { return Err(Errno::EIO); }
            }
            if let Some(value) = value {
                let target = u64::from_le_bytes(value.try_into().map_err(|_| Errno::EIO)?);
                if target >= minimum_created_ino {
                    referenced_count = referenced_count.checked_add(1).ok_or(Errno::ENOMEM)?;
                }
            }
        }
    }
    drop(cursor);
    let mut base_updates = reserve_replay_vec(base_update_count, &mut recovery_scratch)?;
    let mut referenced = reserve_replay_vec(referenced_count, &mut recovery_scratch)?;
    let mut cursor = journal.metadata_cursor(4096)?;
    while let Some((key, value)) = journal.next_metadata(&mut cursor)? {
        if matches!(key, OverlayKey::Dirent { .. }) {
            if let Some(value) = value {
                let target = u64::from_le_bytes(value.try_into().map_err(|_| Errno::EIO)?);
                if target >= minimum_created_ino { referenced.push(target); }
            }
        }
    }
    drop(cursor);
    referenced.sort_unstable();
    referenced.dedup();
    let mut created = reserve_replay_vec(referenced.len(), &mut recovery_scratch)?;
    let mut maximum_created_ino = None;
    let mut cursor = journal.metadata_cursor(4096)?;
    while let Some((key, value)) = journal.next_metadata(&mut cursor)? {
        if let OverlayKey::Inode(ino) = key {
            if !resizable || *ino == u64::MAX {
                return Err(Errno::EIO);
            }
            let bytes = value.ok_or(Errno::EIO)?;
            if *ino < minimum_created_ino {
                if bytes.len() != PERSISTENT_REGULAR_RECORD_BYTES || bytes[1] != 4 {
                    return Err(Errno::EIO);
                }
                let metadata = decode_inode_record(bytes)?;
                if metadata.mode & !0o7777 != 0 {
                    return Err(Errno::EIO);
                }
                let position = base_indices
                    .binary_search_by_key(ino, |entry| entry.0)
                    .map_err(|_| Errno::EIO)?;
                let index = base_indices[position].1;
                let valid = ROOTFS.with(|state| {
                    let inode = state.get(index).ok_or(Errno::EIO)?;
                    if matches!(inode.kind, InodeKind::Regular(_) | InodeKind::PersistentRegular)
                        || (matches!(inode.kind, InodeKind::BaseRegular { .. } | InodeKind::LazyMember { .. })
                            && metadata.mode & 0o6000 != 0)
                    {
                        return Err(Errno::EIO);
                    }
                    Ok::<_, Errno>(())
                });
                valid?;
                base_updates.push((*ino, (index, metadata)));
            } else {
                validate_persistent_inode_record(bytes)?;
                maximum_created_ino = Some(maximum_created_ino.map_or(*ino, |maximum: u64| maximum.max(*ino)));
                if referenced.binary_search(ino).is_ok() {
                    created.push((*ino, decode_persistent_inode(*ino, bytes)?));
                }
            }
        }
    }
    drop((cursor, referenced));
    namespace_replay |= !created.is_empty();
    let mut eligible_sizes = ROOTFS.with(|state| {
        let count = base_indices.len().checked_add(created.len()).ok_or(Errno::ENOMEM)?;
        let mut sizes = reserve_replay_vec(count, &mut recovery_scratch)?;
        for inode in state.inodes.iter().flatten() {
            if let InodeKind::BaseRegular {
                size,
                source: BaseSource::Image,
                ..
            } = inode.kind
            {
                let mode = base_updates.binary_search_by_key(&inode.ino, |entry| entry.0).ok()
                    .map_or(inode.mode, |position| base_updates[position].1.1.mode);
                if inode.deferred_digest == crate::sdef::DIGEST_NONE && mode & 0o6000 == 0 {
                    sizes.push((inode.ino, size));
                }
            }
        }
        Ok::<_, Errno>(sizes)
    })?;
    eligible_sizes.extend(created.iter().filter_map(|(ino, inode)| {
        matches!(inode.kind, InodeKind::PersistentRegular).then_some((*ino, 0))
    }));
    eligible_sizes.sort_unstable_by_key(|&(ino, _)| ino);
    if eligible_sizes.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(Errno::EIO);
    }
    let mut base_size = |ino| {
        eligible_sizes
            .binary_search_by_key(&ino, |&(candidate, _)| candidate)
            .ok()
            .map(|index| eligible_sizes[index].1)
    };
    if resizable {
        journal.validate_resizable_image_blocks(|ino, journal| {
            if let Some(size) = base_size(ino) { return Ok(Some(size)); }
            if ino < minimum_created_ino { return Ok(None); }
            let record = journal.metadata_value(&OverlayKey::Inode(ino))?.flatten().ok_or(Errno::EIO)?;
            validate_persistent_inode_record(&record)?;
            Ok((record[1] == 1).then_some(0))
        })?;
    } else {
        journal.validate_fixed_image_blocks(&mut base_size)?;
    }
    let base_dirents = if resizable {
        ROOTFS.with(|state| {
            let mut base_dirents = crate::retained_dirents::RetainedDirents::new();
            journal.for_each_metadata(|key, _| {
                if let OverlayKey::Dirent { parent, name } = key {
                    if *parent < minimum_created_ino {
                        let position = base_indices.binary_search_by_key(parent, |entry| entry.0).map_err(|_| Errno::EIO)?;
                        let Some(InodeKind::Dir(entries)) = state.get(base_indices[position].1).map(|inode| &inode.kind) else {
                            return Err(Errno::EIO);
                        };
                        if entries.contains_key(name) { base_dirents.try_insert(key)?; }
                    }
                }
                Ok(())
            })?;
            Ok::<_, Errno>(base_dirents)
        })?
    } else { crate::retained_dirents::RetainedDirents::new() };
    journal.release_checkpoint_metadata()?;
    journal.limit_active_tail();
    let mut active = PERSISTENT_ROOTFS.lock();
    if active.is_some() {
        return Err(Errno::EBUSY);
    }
    let allocation_totals = ROOTFS.with(|state| {
        let mut totals = reserve_replay_vec(eligible_sizes.len(), &mut recovery_scratch)?;
        for inode in state.inodes.iter().flatten().chain(created.iter().map(|(_, inode)| inode)) {
            if let Some(base_size) = base_size(inode.ino) {
                let size = journal.visible_file_size(inode.ino, base_size)?;
                let blocks = composed_inode_block_count(&mut journal, inode, state.image,
                    base_size, size, &mut byte_source)?;
                totals.push((inode.ino, size, blocks));
            }
        }
        totals.sort_unstable_by_key(|entry| entry.0);
        Ok::<_, Errno>(totals)
    })?;
    let replay = if resizable && namespace_replay {
        Some(ROOTFS.with(|state| PreparedNamespaceReplay::load(state, &mut journal, &created, Some(minimum_created_ino)))?)
    } else { None };
    let slots = ROOTFS.with(|state| recovery_slots::PreparedRecoverySlots::new(state, created.len(), replay.as_ref()))?;
    if resizable { ROOTFS.with(|state| slots.reserve(state))?; }
    let fifos = ROOTFS.with(|state| {
        let view = RecoveryNamespaceView::new(state, &created, replay.as_ref(), &base_updates)?;
        PreparedFifoRegistry::prepare(|visit| view.for_each_fifo_path(&mut |index, path, metadata| {
            visit(slots.physical_index(index), path, metadata)
        }), namespace_replay)
    })?;
    #[cfg(test)]
    if FAIL_PERSISTENCE_FIFO_RESTORE.swap(false, Ordering::SeqCst) { return Err(Errno::ENOMEM); }
    let replay = replay.map(|replay| ROOTFS.with(|state| replay.admit(state))).transpose()?;
    PERSISTENCE_RECOVERY_PRISTINE.store(false, Ordering::SeqCst);
    if resizable {
        ROOTFS.with(|state| {
            for (_, (index, metadata)) in base_updates {
                metadata.apply(state.get_mut(index).expect("validated base inode missing"));
            }
            slots.publish(state, created, replay);
            if let Some(ino) = maximum_created_ino { state.bump_next_ino(ino); }
        });
    }
    PERSISTENCE_RECOVERY_PRISTINE.store(false, Ordering::SeqCst);
    ROOTFS.with(|state| {
        for inode in state.inodes.iter_mut().flatten() {
            if let Ok(position) = allocation_totals.binary_search_by_key(&inode.ino, |entry| entry.0) {
                let (_, size, blocks) = allocation_totals[position];
                if resizable { inode.persistent_size = Some(size); }
                inode.allocated_blocks = blocks;
            }
        }
        state.persistent_allocated_blocks = None;
    });
    fifos.publish();
    ROOTFS.with(|state| {
        for archive in state.archives.values_mut() {
            archive.raw = None;
            archive.directory = None;
            archive.members.clear();
        }
        state.archive_readers.clear();
        state.archive_directories.clear();
        state.archive_verified_reads = crate::verified_read_cache::VerifiedReadCache::new();
    });
    *active = Some(PersistentMount {
        journal,
        resizable,
        base_dirents,
    });
    Ok(())
}

#[cfg(test)]
fn validate_persistent_dirents(
    state: &RootfsState,
    journal: &mut PersistentJournal,
    created: &[(u64, Inode)],
) -> Result<(), Errno> {
    PreparedNamespaceReplay::load(state, journal, created, None).map(|_| ())
}

#[cfg(test)]
fn apply_persistent_dirents(
    state: &mut RootfsState,
    journal: &mut PersistentJournal,
) -> Result<(), Errno> {
    state.reserve_inode_slots(0)?;
    let replay = PreparedNamespaceReplay::load(state, journal, &[], None)?;
    replay.admit(state)?.publish(state);
    Ok(())
}

pub fn fixed_persistence_enabled() -> bool {
    PERSISTENT_ROOTFS.lock().is_some()
}

fn resizable_persistence_enabled() -> bool {
    PERSISTENT_ROOTFS
        .lock()
        .as_ref()
        .is_some_and(|mount| mount.resizable)
}

pub fn image_length() -> Option<u64> {
    ROOTFS.with(|state| state.image.map(|geometry| geometry.image_len))
}

pub fn sync_persistence() -> Result<(), Errno> {
    if !resizable_persistence_enabled() {
        return match PERSISTENT_ROOTFS.lock().as_mut() {
            Some(mount) => mount.journal.sync(),
            None => Ok(()),
        };
    }
    let mut cursor = 0;
    loop {
        let count = ROOTFS.with(|state| state.dirty_persistent_timestamps.range(cursor..).take(64).count());
        if count == 0 { break; }
        let (next, mutations, generations) = ROOTFS.with(|state| {
            let mut mutations = crate::persistent_overlay::MutationBatch::new_writeback(count)?;
            let mut generations = crate::io_buffer::IoBuffer::allocate(count, true, |values| {
                values.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)
            })?;
            let mut next = cursor;
            for &index in state.dirty_persistent_timestamps.range(cursor..) {
                next = index.checked_add(1).ok_or(Errno::EIO)?;
                let inode = state.get(index).ok_or(Errno::EIO)?;
                if inode.content_gen == inode.synced_content_gen {
                    return Err(Errno::EIO);
                }
                let kind = match inode.kind {
                    InodeKind::PersistentRegular => 1,
                    InodeKind::BaseRegular { source: BaseSource::Image, .. } => 4,
                    _ => return Err(Errno::EIO),
                };
                mutations.push_with(PERSISTENT_REGULAR_RECORD_BYTES, || Ok(Mutation::Put {
                    key: OverlayKey::Inode(inode.ino),
                    value: encode_inode_record(kind, &[], PersistentInodeMetadata::from_inode(inode))?,
                }))?;
                generations.push((index, inode.content_gen));
                if mutations.len() == 64 {
                    break;
                }
            }
            Ok::<_, Errno>((next, mutations, generations))
        })?;
        PERSISTENT_ROOTFS.lock().as_mut().ok_or(Errno::EIO)?.journal.commit_writeback_metadata(mutations.as_slice())?;
        ROOTFS.with(|state| {
            for (index, generation) in generations {
                if let Some(inode) = state.get_mut(index) {
                    if inode.content_gen == generation {
                        inode.synced_content_gen = generation;
                        state.dirty_persistent_timestamps.remove(&index);
                    }
                }
            }
        });
        cursor = next;
    }
    PERSISTENT_ROOTFS.lock().as_mut().ok_or(Errno::EIO)?.journal.sync()
}

fn reserve_persistent_timestamp_slot(index: u32) -> Result<(), Errno> {
    if crate::prepared_map::writeback_reserve_in_use()
        && !ROOTFS.with(|state| state.dirty_persistent_timestamps.contains(&index)) {
        return Err(Errno::ENOMEM);
    }
    let full = ROOTFS.with(|state| {
        state.dirty_persistent_timestamps.len() >= MAX_DIRTY_PERSISTENT_TIMESTAMPS
            && !state.dirty_persistent_timestamps.contains(&index)
    });
    if full {
        sync_persistence()?;
    }
    Ok(())
}

pub fn checkpoint_prepared_persistence(
    storage: Box<dyn OverlayStorage + Send>,
) -> Result<(), Errno> {
    let mut pending = PREPARED_PERSISTENCE.lock();
    let pending = pending.as_mut().ok_or(Errno::EINVAL)?;
    if pending.resizable {
        pending.journal.install_metadata_block_checkpoint(storage)
    } else {
        pending.journal.install_fixed_block_checkpoint(storage)
    }
}

pub fn prepare_persistence_compaction(
    storage: Box<dyn OverlayStorage + Send>,
) -> Result<(), Errno> {
    sync_persistence()?;
    reclaim_io_read_caches(None);
    let mut live_scratch = ROOTFS_METADATA.reserve_temporary(0)?;
    let live_inodes = if resizable_persistence_enabled() {
        Some(ROOTFS.with(|state| {
            let mut inodes = reserve_replay_vec(state.inodes.len(), &mut live_scratch)?;
            inodes.extend(
                state.inodes.iter().flatten()
                    .filter(|inode| inode.nlink != 0 || inode.open_count != 0 || inode.map_pins != 0)
                    .map(|inode| inode.ino),
            );
            inodes.sort_unstable();
            if inodes.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err(Errno::EIO);
            }
            Ok::<_, Errno>(inodes)
        })?)
    } else {
        None
    };
    let mut pending = PREPARED_PERSISTENCE.lock();
    if pending.is_some() {
        return Err(Errno::EBUSY);
    }
    let mut active = PERSISTENT_ROOTFS.lock();
    let source = active.as_mut().ok_or(Errno::EINVAL)?;
    let compacted = if source.resizable {
        let live_inodes = live_inodes.as_ref().ok_or(Errno::EIO)?;
        source.journal.compact_metadata_reachable_into(storage, |key, value| {
            if matches!(key, OverlayKey::Dirent { .. })
                && value.is_none()
                && !source.base_dirents.contains(key)
            {
                return false;
            }
            let inode = match key {
                OverlayKey::Inode(inode)
                | OverlayKey::FileSize(inode)
                | OverlayKey::FileZeroFrom(inode) => *inode,
                OverlayKey::FileBlock { inode, .. } => *inode,
                OverlayKey::Dirent { parent, .. } => *parent,
            };
            live_inodes.binary_search(&inode).is_ok()
        })?
    } else {
        source.journal.compact_fixed_into(storage)?
    };
    *pending = Some(PreparedPersistence {
        journal: compacted,
        source_revision: source.journal.compaction_revision(),
        resizable: source.resizable,
    });
    Ok(())
}

pub fn activate_persistence_compaction() -> Result<(), Errno> {
    let mut pending = PREPARED_PERSISTENCE.lock();
    let prepared = pending.as_ref().ok_or(Errno::EINVAL)?;
    let mut active = PERSISTENT_ROOTFS.lock();
    let source = active.as_ref().ok_or(Errno::EINVAL)?;
    if !source
        .journal
        .can_activate_compaction(prepared.source_revision)
    {
        *pending = None;
        return Err(Errno::EBUSY);
    }
    let source = active.as_mut().ok_or(Errno::EIO)?;
    let target = &mut pending.as_mut().ok_or(Errno::EIO)?.journal;
    target.release_checkpoint_metadata()?;
    source.base_dirents.try_retain(|key| Ok(target.metadata_value(key)?.is_some()))?;
    let prepared = pending.take().ok_or(Errno::EIO)?;
    let mut journal = prepared.journal;
    journal.limit_active_tail();
    let base_dirents = active.take().ok_or(Errno::EIO)?.base_dirents;
    *active = Some(PersistentMount {
        journal,
        resizable: prepared.resizable,
        base_dirents,
    });
    Ok(())
}

pub fn cancel_persistence_compaction() {
    *PREPARED_PERSISTENCE.lock() = None;
}

fn reject_fixed_persistence_mutation() -> Result<(), Errno> {
    if fixed_persistence_enabled() {
        Err(Errno::EROFS)
    } else {
        Ok(())
    }
}

/// Registry of *foreign* mount prefixes: the canonical mount points of every
/// other filesystem still mounted under `/` after the host hands `/` to the
/// overlay (for example `/run/kandelo-run` session-seed host mounts and extra
/// `HostFileSystem` mounts). As the sole `/` authority the overlay would
/// otherwise greedily claim these sibling paths and shadow the real mount, so
/// `owns_path` returns false for any path at or under a registered prefix and
/// the syscall falls through to that mount.
///
/// Populated once by the host at overlay-configure time via
/// `set_foreign_prefixes`. tmpfs scratch mounts are excluded separately by
/// `tmpfs::owns_path`; a tmpfs prefix appearing here too is harmless (either
/// check independently disqualifies the path).
struct ForeignMounts {
    locked: AtomicBool,
    prefixes: UnsafeCell<Vec<Vec<u8>>>,
}

impl ForeignMounts {
    const fn new() -> Self {
        ForeignMounts {
            locked: AtomicBool::new(false),
            prefixes: UnsafeCell::new(Vec::new()),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Vec<Vec<u8>>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: same invariant as RootfsGlobal — the spinlock is the sole gate
        // and no reference escapes the closure.
        let slot = unsafe { &mut *self.prefixes.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / TmpfsGlobal.
unsafe impl Sync for ForeignMounts {}

static FOREIGN_MOUNTS: ForeignMounts = ForeignMounts::new();

/// Register the set of foreign mount prefixes (see [`ForeignMounts`]). `buf` is
/// a NUL-separated list of canonical absolute mount points supplied by the host
/// at overlay-configure time. Replaces any previously registered set. Entries
/// that are empty, non-absolute, or exactly `/` are ignored (`/` is the
/// overlay's own root, never foreign); trailing slashes are trimmed and
/// duplicates dropped. Returns the number of prefixes registered.
///
/// Registering also makes each prefix *reachable*: see
/// [`ensure_foreign_mount_parents`]. The two belong together because a mount
/// point the overlay refuses to claim but cannot be walked to is not a mount —
/// it is an `ENOENT` the guest sees instead of the mounted filesystem.
pub fn set_foreign_prefixes(buf: &[u8]) -> usize {
    let mut prefixes: Vec<Vec<u8>> = Vec::new();
    for part in buf.split(|&b| b == 0) {
        if part.first() != Some(&b'/') {
            continue;
        }
        let mut p = part.to_vec();
        while p.len() > 1 && p.last() == Some(&b'/') {
            p.pop();
        }
        if p == b"/" {
            continue;
        }
        if !prefixes.iter().any(|e| e == &p) {
            prefixes.push(p);
        }
    }
    let count = prefixes.len();
    FOREIGN_MOUNTS.with(|slot| *slot = prefixes);
    ensure_foreign_mount_parents();
    count
}

/// Registry of host directory anchors: the canonical guest path of a host
/// directory, and the handle the host issued for it.
///
/// Deliberately independent of [`ForeignMounts`]. The two answer different
/// questions — *which paths are host-owned* versus *which host directory
/// anchors a path* — and coupling them would impose a publication order on the
/// host for no gain.
struct MountRoots {
    locked: AtomicBool,
    roots: UnsafeCell<Vec<(Vec<u8>, i64)>>,
}

impl MountRoots {
    const fn new() -> Self {
        MountRoots {
            locked: AtomicBool::new(false),
            roots: UnsafeCell::new(Vec::new()),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Vec<(Vec<u8>, i64)>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: identical invariant to RootfsGlobal / ForeignMounts — the
        // spinlock is the sole gate and no reference escapes the closure.
        let slot = unsafe { &mut *self.roots.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / ForeignMounts.
unsafe impl Sync for MountRoots {}

static MOUNT_ROOTS: MountRoots = MountRoots::new();

/// Sentinel for "the host published no root handle for `/`". A real handle is a
/// host-issued positive value, and the kernel's own synthetic handles are
/// negative and banded, so `i64::MIN` cannot collide with either.
const NO_HOST_ROOT: i64 = i64::MIN;

/// Root handle for a host that serves `/` itself. See `set_foreign_mount_roots`.
static HOST_ROOT_HANDLE: AtomicI64 = AtomicI64::new(NO_HOST_ROOT);

/// Register the host directory handles that anchor host filesystem access.
///
/// This is the anchor of the handle-only host contract. Every host file
/// operation starts from one of these handles and steps one path component at a
/// time through `host_openat`, so the host never receives a guest path, a mount
/// prefix, a `..`, or a symlink chain.
///
/// `buf` is a sequence of self-describing records, each an 8-byte little-endian
/// `i64` root handle followed by the directory's canonical guest path and a NUL
/// terminator. Records carry their prefix rather than relying on position,
/// because the host's mount table and the prefix list it published through
/// `set_foreign_prefixes` are not guaranteed to share an ordering — a host that
/// sorts its mounts by prefix length does not — so a positional payload would
/// bind two orderings that can differ.
///
/// A record for `/` names a host that serves the root itself rather than
/// sibling mounts beneath an overlay-owned `/`. It anchors every host path that
/// no longer-prefixed record claims.
///
/// Replaces any previously registered set. Returns the number of anchors
/// registered.
pub fn set_foreign_mount_roots(buf: &[u8]) -> usize {
    HOST_ROOT_HANDLE.store(NO_HOST_ROOT, Ordering::SeqCst);
    let mut roots: Vec<(Vec<u8>, i64)> = Vec::new();
    let mut host_root = false;
    let mut rest = buf;
    while rest.len() > 8 {
        let mut handle_bytes = [0u8; 8];
        handle_bytes.copy_from_slice(&rest[..8]);
        let handle = i64::from_le_bytes(handle_bytes);
        let body = &rest[8..];
        let Some(nul) = body.iter().position(|&b| b == 0) else {
            // An unterminated final record is a malformed payload, not a
            // shorter list. Stop rather than guess at its extent.
            break;
        };
        let mut prefix = body[..nul].to_vec();
        while prefix.len() > 1 && prefix.last() == Some(&b'/') {
            prefix.pop();
        }
        rest = &body[nul + 1..];
        if prefix.first() != Some(&b'/') {
            continue;
        }
        if prefix == b"/" {
            HOST_ROOT_HANDLE.store(handle, Ordering::SeqCst);
            host_root = true;
        } else if !roots.iter().any(|(p, _)| p == &prefix) {
            roots.push((prefix, handle));
        }
    }
    let count = roots.len() + usize::from(host_root);
    MOUNT_ROOTS.with(|slot| *slot = roots);
    count
}

/// The directory handle anchoring host paths that no mount root claims, for a
/// host that serves `/` directly rather than delegating it to the in-kernel
/// overlay.
pub(crate) fn host_root_handle() -> Option<i64> {
    match HOST_ROOT_HANDLE.load(Ordering::SeqCst) {
        NO_HOST_ROOT => None,
        handle => Some(handle),
    }
}

/// The host directory handle anchoring `path`, together with the byte length of
/// that anchor's prefix, so a caller can split `path` into (anchor,
/// components-below-the-anchor) without re-deriving the match.
///
/// Longest prefix wins, so a mount nested inside another resolves to the inner
/// mount's root. `None` means no published anchor claims this path; the caller
/// then falls back to [`host_root_handle`], and failing that answers `ENOSYS` —
/// the truthful boundary rather than a fallback to name resolution.
pub(crate) fn foreign_mount_root(path: &[u8]) -> Option<(i64, usize)> {
    MOUNT_ROOTS.with(|roots| {
        let mut best: Option<(i64, usize)> = None;
        for (p, handle) in roots.iter() {
            let p = p.as_slice();
            let matches = path == p
                || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/');
            if !matches {
                continue;
            }
            if best.is_none_or(|(_, len)| p.len() > len) {
                best = Some((*handle, p.len()));
            }
        }
        best
    })
}

/// Synthesise the directories leading down to every registered foreign mount
/// point, so the kernel's per-component search-permission checks can reach a
/// mount point the `/` image itself has no path to.
///
/// A foreign mount at `/usr/local/lib/kandelo` needs `/usr`, `/usr/local` and
/// `/usr/local/lib` to exist even though the mounted backend owns the final
/// component. The mount point itself is deliberately NOT created: it belongs to
/// the foreign filesystem, which the overlay does not claim
/// (see [`path_under_foreign`]).
///
/// This is the kernel half of what the TypeScript hosts used to do to their own
/// copy of the image (`ensureMountParentDirectories`). It belongs here: the
/// namespace is the kernel's, the kernel is the one enforcing the search
/// permissions, and doing it here gives every host — Node, browser, and native
/// wasmtime — the same behaviour instead of three chances to forget it. It also
/// applies to *every* registered prefix rather than only the host's "extra"
/// mounts, because reachability is a property of the mount, not of which host
/// list a mount arrived on.
///
/// It hangs off [`ForeignMounts`] and NOT off [`MountRoots`], deliberately.
/// Those registries answer different questions — *which paths are host-owned*
/// versus *which host directory anchors a path* — and reachability is the first
/// question: it is about the shape of the kernel's own namespace, not about
/// where a mount's bytes come from. A mount point still has to be walkable when
/// no handle was ever published for it. Driving it from the handle registry
/// would also impose exactly the publication order `MountRoots` documents itself
/// as avoiding, since the ancestors have to exist before any host path below
/// them resolves.
///
/// Each prefix is walked by [`mkdir_parents`], which owns the per-component
/// rules (create a missing component, descend through an existing directory or
/// a symlink to one, and stop rather than paper over anything else).
///
/// Returns the number of directories created.
pub fn ensure_foreign_mount_parents() -> usize {
    let prefixes: Vec<Vec<u8>> = FOREIGN_MOUNTS.with(|slot| slot.clone());
    prefixes
        .iter()
        .map(|prefix| mkdir_parents(prefix, 0o755, 0, 0))
        .sum()
}

/// Create the missing ancestor directories of `path`, so `path` itself becomes
/// creatable. `path`'s final component is never created — it is the thing the
/// caller is about to make, or, for a foreign mount point, the thing another
/// filesystem owns.
///
/// Per component, from the shallowest:
///
/// * missing — create a directory with `mode`/`uid`/`gid`;
/// * an existing directory — descend into it;
/// * an existing symlink — follow it within the overlay and descend if it
///   resolves to a directory (a `/usr/local -> /opt/local` image is a normal
///   shape, and a host `stat`-based check would follow it too);
/// * anything else — stop. A regular file where a directory must go is a real
///   conflict; inventing a directory over it would hide it, and the caller's
///   own operation then fails visibly at the missing component, which is the
///   truthful result.
///
/// Returns the number of directories created. It is deliberately infallible:
/// every stopping condition leaves the caller's next operation to report the
/// real error against the real path, rather than this helper guessing which
/// errno the caller wanted.
pub fn mkdir_parents(path: &[u8], mode: u32, uid: u32, gid: u32) -> usize {
    mkdir_ancestor_chain(path, mode, uid, gid).0
}

pub fn mkdir_parents_checked(path: &[u8], mode: u32, uid: u32, gid: u32) -> Result<usize, Errno> {
    if fixed_persistence_enabled() && !resizable_persistence_enabled() { return Err(Errno::EROFS); }
    let (created, result) = mkdir_ancestor_chain(path, mode, uid, gid);
    result.map(|()| created)
}

fn mkdir_ancestor_chain(path: &[u8], mode: u32, uid: u32, gid: u32) -> (usize, Result<(), Errno>) {
    let mut created = 0usize;
    let result = (|| {
        let mut components = path.split(|&byte| byte == b'/').filter(|component| !component.is_empty()).peekable();
        let mut base = crate::IoBuffer::new();
        while let Some(component) = components.next() {
            if components.peek().is_none() { break; }
            let length = base.len().checked_add(1).and_then(|length| length.checked_add(component.len())).ok_or(Errno::ENOMEM)?;
            let mut candidate = crate::IoBuffer::try_with_capacity(length)?;
            candidate.extend_from_slice(&base);
            candidate.push(b'/');
            candidate.extend_from_slice(component);
            match lstat(&candidate) {
                Err(Errno::ENOENT) => {
                    mkdir(&candidate, mode, uid, gid)?;
                    created += 1;
                    base = candidate;
                }
                Err(error) => return Err(error),
                Ok(metadata) if metadata.st_mode & S_IFMT == S_IFDIR => base = candidate,
                Ok(metadata) if metadata.st_mode & S_IFMT == S_IFLNK => {
                    let resolved = resolve_read_symlinks(&candidate)?;
                    if lstat(&resolved)?.st_mode & S_IFMT != S_IFDIR { return Err(Errno::ENOTDIR); }
                    base = crate::IoBuffer::copy_from(&resolved)?;
                }
                Ok(_) => return Err(Errno::ENOTDIR),
            }
        }
        Ok(())
    })();
    (created, result)
}

/// Whether `path` lies at or under a registered foreign mount prefix. The match
/// respects path-component boundaries, so a foreign mount at `/run/kandelo-run`
/// matches `/run/kandelo-run` and `/run/kandelo-run/...` but not
/// `/run/kandelo-runner` or a sibling `/run/other`.
fn path_under_foreign(path: &[u8]) -> bool {
    FOREIGN_MOUNTS.with(|prefixes| {
        prefixes.iter().any(|p| {
            let p = p.as_slice();
            path == p
                || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/')
        })
    })
}

/// Split a canonical absolute path into non-empty components.
fn split_components(path: &[u8]) -> Vec<&[u8]> {
    path.split(|&b| b == b'/').filter(|c| !c.is_empty()).collect()
}

/// Master switch for in-kernel rootfs authority over `/`. Defaults OFF; the
/// host enables it at boot (`kernel_set_rootfs_enabled`) once the image has
/// loaded, so a kernel with no image never claims `/`.
static ROOTFS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable or disable in-kernel rootfs authority. Returns the previous value.
pub fn set_enabled(enabled: bool) -> bool {
    ROOTFS_ENABLED.swap(enabled, Ordering::SeqCst)
}

/// Whether in-kernel rootfs authority is currently active.
pub fn is_enabled() -> bool {
    ROOTFS_ENABLED.load(Ordering::SeqCst)
}

/// Whether the overlay's `/` mount was configured `nosuid`. Defaults OFF: a
/// normal boot mounts `/` set-ID-honoring, so a setuid/setgid binary staged in
/// the overlay (for example `/usr/bin/login`, `su`, `passwd`) elevates through
/// exec exactly as it does on the host `/` mount. The host publishes the mount's
/// real flag at overlay-configure time via `set_nosuid`; `statfs` then reports
/// `ST_NOSUID` so the exec-target set-ID proposal drops the bits on a `nosuid`
/// mount and honors them otherwise. Cleared by `reset()`.
static ROOTFS_NOSUID: AtomicBool = AtomicBool::new(false);

/// Publish whether the overlay's `/` mount is `nosuid`. Returns the previous
/// value. The host calls this once at boot, after loading the image (which
/// resets it) and before enabling rootfs authority.
pub fn set_nosuid(nosuid: bool) -> bool {
    ROOTFS_NOSUID.swap(nosuid, Ordering::SeqCst)
}

/// Whether the overlay's `/` mount is currently `nosuid`.
pub fn is_nosuid() -> bool {
    ROOTFS_NOSUID.load(Ordering::SeqCst)
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

/// Whether a canonical path belongs to the rootfs overlay: an absolute path
/// that is owned neither by the tmpfs scratch mounts nor by a registered foreign
/// mount (a sibling filesystem still mounted under `/`, see [`ForeignMounts`]).
/// Pure predicate; does not consider whether rootfs authority is enabled.
/// Synthetic namespaces (procfs, devfs, pty, `/dev/fd`, synthetic regulars) are
/// matched *before* rootfs in `namespace_lstat_raw`, exactly where the host `/`
/// fall-through sits today, so they never reach this predicate in dispatch.
pub fn owns_path(path: &[u8]) -> bool {
    path.first() == Some(&b'/')
        && !crate::tmpfs::owns_path(path)
        && !crate::devfs::owns_path(path)
        && !path_under_foreign(path)
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
// Base-tree builder (populated at boot by the image loader; used directly by
// unit tests). Parents must be inserted before their children (every loader
// walks parent-first). Each insert refuses to clobber an existing entry.
// ---------------------------------------------------------------------------

/// Clear the whole overlay (drops every inode and open stream). Used before
/// repopulating from a fresh image or manifest and by tests for isolation.
pub fn reset() {
    PERSISTENCE_RECOVERY_PRISTINE.store(false, Ordering::SeqCst);
    #[cfg(test)]
    FAIL_PERSISTENCE_FIFO_RESTORE.store(false, Ordering::SeqCst);
    clear_fifo_registry();
    *PREPARED_PERSISTENCE.lock() = None;
    *PERSISTENT_ROOTFS.lock() = None;
    ROOTFS.with(|state| *state = RootfsState::new());
    crate::rootfs_image::clear();
    FOREIGN_MOUNTS.with(|slot| slot.clear());
    ROOTFS_NOSUID.store(false, Ordering::SeqCst);
    // An in-progress image export addresses the store it was built from, so a
    // reset must drop it rather than let the next chunk serve a tree that is
    // no longer there.
    reset_image_export();
}

pub fn set_metadata_budget_bytes(limit: usize) -> Result<(), Errno> {
    ROOTFS_METADATA.set_limit(limit)
}

pub fn metadata_budget_usage() -> (usize, usize) {
    ROOTFS_METADATA.usage()
}

pub fn set_journal_state_budget_bytes(limit: usize) -> Result<(), Errno> {
    let reserve = crate::prepared_map::JOURNAL_WRITEBACK_HEADROOM;
    if limit <= reserve { return Err(Errno::EINVAL); }
    crate::prepared_map::JOURNAL_STATE_MEMORY.set_limit(limit - reserve)
}

pub fn journal_state_budget_usage() -> (usize, usize) {
    let (used, limit) = crate::prepared_map::JOURNAL_STATE_MEMORY.usage();
    let (writeback_used, writeback_limit) = crate::prepared_map::JOURNAL_WRITEBACK_MEMORY.usage();
    (used + writeback_used, limit + writeback_limit)
}

pub fn journal_state_memory_pressure() -> bool {
    let (used, limit) = crate::prepared_map::JOURNAL_STATE_MEMORY.usage();
    crate::prepared_map::writeback_reserve_in_use() || (used != 0 && used >= limit.div_ceil(2))
}

pub fn set_io_budget_bytes(limit: usize) -> Result<(), Errno> {
    let reserve = crate::io_buffer::WRITEBACK_BYTES;
    if limit <= reserve { return Err(Errno::EINVAL); }
    crate::io_buffer::IO_MEMORY.set_limit(limit - reserve)
}

pub fn io_budget_usage() -> (usize, usize) {
    let (used, limit) = crate::io_buffer::IO_MEMORY.usage();
    let (writeback_used, writeback_limit) = crate::io_buffer::WRITEBACK_MEMORY.usage();
    (used + writeback_used, limit + writeback_limit)
}

type NamespaceEntries<'a> = crate::directory_entries::DirectoryBookmark<'a>;

struct NamespaceCursor<'a> {
    state: &'a RootfsState,
    entries: Option<crate::directory_entries::DirectoryIter<'a>>,
    ancestors: crate::io_buffer::IoBuffer<(NamespaceEntries<'a>, usize)>,
    prefix_len: usize,
    path: crate::io_buffer::IoBuffer<u8>,
    directories: usize,
}

impl<'a> NamespaceCursor<'a> {
    fn new(state: &'a RootfsState) -> Result<Self, Errno> {
        Self::new_in(state, &crate::io_buffer::IO_MEMORY)
    }

    fn new_in(state: &'a RootfsState, budget: &'static crate::metadata_budget::MetadataBudget) -> Result<Self, Errno> {
        let entries = match state.root {
            Some(root) => match &state.get(root).ok_or(Errno::EIO)?.kind {
                InodeKind::Dir(entries) => Some(entries.iter()),
                _ => return Err(Errno::EIO),
            },
            None => None,
        };
        Ok(Self {
            state, entries, ancestors: crate::io_buffer::IoBuffer::new_in(budget), prefix_len: 0,
            path: crate::io_buffer::IoBuffer::new_in(budget), directories: 1,
        })
    }

    fn next(&mut self) -> Result<Option<(u32, &[u8], &Inode)>, Errno> {
        loop {
            let Some(entries) = self.entries.as_mut() else { return Ok(None) };
            if let Some((name, &index)) = entries.peek_next() {
                let inode = self.state.get(index).ok_or(Errno::EIO)?;
                if matches!(inode.kind, InodeKind::Dir(_)) {
                    if self.directories >= self.state.inodes.len() {
                        return Err(Errno::EIO);
                    }
                    let length = self.ancestors.len().checked_add(1).ok_or(Errno::ENOMEM)?;
                    if length > self.ancestors.capacity() {
                        let capacity = length.max(self.ancestors.capacity().saturating_mul(2));
                        self.ancestors.reserve_with(capacity, |ancestors| {
                            ancestors.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
                        })?;
                    }
                }
                let length = self.prefix_len.checked_add(name.len())
                    .and_then(|length| length.checked_add(1)).ok_or(Errno::ENOMEM)?;
                if length > self.path.capacity() {
                    let capacity = length.max(self.path.capacity().saturating_mul(2));
                    self.path.reserve_with(capacity, |path| {
                        path.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)
                    })?;
                }
                self.path.truncate(self.prefix_len);
                self.path.push(b'/');
                self.path.extend_from_slice(name);
                entries.next();
                if let InodeKind::Dir(children) = &inode.kind {
                    self.directories += 1;
                    let parent = core::mem::replace(entries, children.iter());
                    self.ancestors.push((parent.bookmark(), self.prefix_len));
                    self.prefix_len = self.path.len();
                }
                return Ok(Some((index, &self.path, inode)));
            }
            match self.ancestors.pop() {
                Some((entries, prefix_len)) => {
                    self.entries = Some(entries.resume());
                    self.prefix_len = prefix_len;
                }
                None => self.entries = None,
            }
        }
    }
}

struct ReplayDirectoryCursor<'a> {
    base: Option<crate::directory_entries::DirectoryIter<'a>>,
    changes: &'a [PreparedReplayChange],
    position: usize,
}

struct ReplayDirectoryBookmark<'a> {
    base: Option<NamespaceEntries<'a>>,
    changes: &'a [PreparedReplayChange],
    position: usize,
}

impl<'a> ReplayDirectoryBookmark<'a> {
    fn resume(self) -> ReplayDirectoryCursor<'a> {
        ReplayDirectoryCursor {
            base: self.base.map(|base| base.resume()), changes: self.changes, position: self.position,
        }
    }
}

impl<'a> ReplayDirectoryCursor<'a> {
    fn bookmark(&self) -> ReplayDirectoryBookmark<'a> {
        ReplayDirectoryBookmark {
            base: self.base.as_ref().map(|base| base.bookmark()), changes: self.changes, position: self.position,
        }
    }

    fn next(&mut self) -> Option<(&'a [u8], u32)> {
        loop {
            let prior = self.base.as_ref().and_then(|base| base.peek_next());
            let change = self.changes.get(self.position);
            let changed = match (prior, change) {
                (Some((name, _)), Some(change)) => match name.as_slice().cmp(&change.name) {
                    core::cmp::Ordering::Less => false,
                    core::cmp::Ordering::Equal => {
                        self.base.as_mut().expect("replay base iterator missing").next();
                        true
                    }
                    core::cmp::Ordering::Greater => true,
                },
                (Some(_), None) => false,
                (None, Some(_)) => true,
                (None, None) => return None,
            };
            if changed {
                let change = change.expect("replay change missing");
                self.position += 1;
                if let Some(target) = change.target { return Some((&change.name, target)); }
            } else {
                return self.base.as_mut().and_then(|base| base.next()).map(|(name, &target)| (name.as_slice(), target));
            }
        }
    }
}

struct RecoveryNamespaceView<'a> {
    state: &'a RootfsState,
    created: crate::io_buffer::IoBuffer<(u32, &'a Inode)>,
    replay: Option<&'a PreparedNamespaceReplay>,
    updates: &'a [(u64, (u32, PersistentInodeMetadata))],
    maximum_entries: usize,
    has_fifos: bool,
}

impl<'a> RecoveryNamespaceView<'a> {
    fn new(
        state: &'a RootfsState,
        created: &'a [(u64, Inode)],
        replay: Option<&'a PreparedNamespaceReplay>,
        updates: &'a [(u64, (u32, PersistentInodeMetadata))],
    ) -> Result<Self, Errno> {
        let mut indices = crate::io_buffer::IoBuffer::new();
        let maximum_entries = state.inodes.len().checked_add(created.len()).ok_or(Errno::ENOMEM)?;
        let has_fifos = state.inodes.iter().flatten().chain(created.iter().map(|(_, inode)| inode))
            .any(|inode| matches!(inode.kind, InodeKind::Special(S_IFIFO)));
        if !has_fifos { return Ok(Self { state, created: indices, replay, updates, maximum_entries, has_fifos }); }
        indices.reserve_with(created.len(), |indices| {
            indices.try_reserve_exact(created.len()).map_err(|_| Errno::ENOMEM)
        })?;
        for (position, (_, inode)) in created.iter().enumerate() {
            let index = if position < state.free_inodes.len() {
                state.free_inodes[state.free_inodes.len() - 1 - position]
            } else {
                u32::try_from(state.inodes.len() + position - state.free_inodes.len()).map_err(|_| Errno::ENOMEM)?
            };
            if state.get(index).is_some() { return Err(Errno::EIO); }
            indices.push((index, inode));
        }
        indices.sort_unstable_by_key(|(index, _)| *index);
        Ok(Self { state, created: indices, replay, updates, maximum_entries, has_fifos })
    }

    fn inode(&self, index: u32) -> Result<&'a Inode, Errno> {
        self.state.get(index).or_else(|| {
            self.created.binary_search_by_key(&index, |(index, _)| *index).ok()
                .map(|position| self.created[position].1)
        }).ok_or(Errno::EIO)
    }

    fn directory(&self, index: u32) -> Result<ReplayDirectoryCursor<'a>, Errno> {
        let InodeKind::Dir(entries) = &self.inode(index)?.kind else { return Err(Errno::EIO) };
        let changes = self.replay.map_or(&[][..], |replay| {
            let start = replay.changes.partition_point(|change| change.parent < index);
            let end = replay.changes.partition_point(|change| change.parent <= index);
            &replay.changes[start..end]
        });
        Ok(ReplayDirectoryCursor { base: Some(entries.iter()), changes, position: 0 })
    }

    fn fifo_stat(&self, index: u32, inode: &Inode) -> Result<WasmStat, Errno> {
        let mut metadata = inode.stat();
        if let Ok(position) = self.updates.binary_search_by_key(&inode.ino, |(ino, _)| *ino) {
            let update = self.updates[position].1.1;
            metadata.st_mode = S_IFIFO | update.mode;
            metadata.st_uid = update.uid;
            metadata.st_gid = update.gid;
            metadata.st_atime_sec = update.atime_sec;
            metadata.st_atime_nsec = update.atime_nsec;
            metadata.st_mtime_sec = update.mtime_sec;
            metadata.st_mtime_nsec = update.mtime_nsec;
            metadata.st_ctime_sec = update.ctime_sec;
            metadata.st_ctime_nsec = update.ctime_nsec;
        }
        if let Some(replay) = self.replay {
            metadata.st_nlink = *replay.links.get(index as usize).ok_or(Errno::EIO)?;
        }
        Ok(metadata)
    }

    fn for_each_fifo_path(&self, visit: &mut dyn FnMut(u32, &[u8], WasmStat) -> Result<(), Errno>) -> Result<(), Errno> {
        if !self.has_fifos { return Ok(()); }
        let Some(root) = self.state.root else { return Ok(()) };
        let mut entries = self.directory(root)?;
        let mut ancestors = crate::io_buffer::IoBuffer::new();
        let mut path = crate::io_buffer::IoBuffer::new();
        let mut prefix_len = 0usize;
        let mut directories = 1usize;
        loop {
            if let Some((name, index)) = entries.next() {
                let inode = self.inode(index)?;
                let length = prefix_len.checked_add(name.len()).and_then(|length| length.checked_add(1)).ok_or(Errno::ENOMEM)?;
                if length > path.capacity() {
                    let capacity = length.max(path.capacity().saturating_mul(2));
                    path.reserve_with(capacity, |path| path.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM))?;
                }
                path.truncate(prefix_len);
                path.push(b'/');
                path.extend_from_slice(name);
                if inode.is_dir() {
                    if directories >= self.maximum_entries { return Err(Errno::EIO); }
                    directories += 1;
                    ancestors.try_push((entries.bookmark(), prefix_len))?;
                    entries = self.directory(index)?;
                    prefix_len = path.len();
                } else if matches!(inode.kind, InodeKind::Special(S_IFIFO)) {
                    visit(index, &path, self.fifo_stat(index, inode)?)?;
                }
            } else if let Some((parent, parent_prefix)) = ancestors.pop() {
                entries = parent.resume();
                prefix_len = parent_prefix;
            } else { return Ok(()); }
        }
    }
}

fn for_each_fifo_path(
    mut visit: impl FnMut(u32, &[u8], WasmStat) -> Result<(), Errno>,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        if !state.inodes.iter().flatten().any(|inode| matches!(inode.kind, InodeKind::Special(S_IFIFO))) {
            return Ok(());
        }
        let mut cursor = NamespaceCursor::new(state)?;
        while let Some((index, path, inode)) = cursor.next()? {
            if matches!(inode.kind, InodeKind::Special(S_IFIFO)) {
                visit(index, path, inode.stat())?;
            }
        }
        Ok(())
    })
}

fn clear_fifo_registry() {
    let registry = unsafe { crate::fifo::global_fifo_table() };
    let pipes = unsafe { crate::pipe::global_pipe_table() };
    registry.retain(|_, index| {
        let owned = pipes.get(index).and_then(|pipe| pipe.fifo_metadata())
            .is_some_and(|metadata| metadata.st_dev == ROOTFS_DEV);
        if owned {
            pipes.remove_fifo_name(index);
        }
        !owned
    });
}

struct RestoredFifo {
    index: Option<usize>,
    aliases: u32,
    metadata: WasmStat,
    newly_created: bool,
}

impl crate::prepared_map::MapMemory for RestoredFifo {
    fn heap_bytes(&self) -> Result<usize, Errno> { Ok(0) }
}

fn rootfs_fifo_path_visible(path: &[u8], metadata: WasmStat, replacing: bool) -> Result<bool, Errno> {
    if crate::tmpfs::claims_path(path) { return Ok(false); }
    let Some(index) = unsafe { crate::fifo::global_fifo_table() }.lookup(path) else { return Ok(true) };
    let prior = unsafe { crate::pipe::global_pipe_table() }.get(index)
        .and_then(crate::pipe::PipeBuffer::fifo_metadata).ok_or(Errno::EIO)?;
    Ok(prior.st_dev == metadata.st_dev && (replacing || prior.st_ino == metadata.st_ino))
}

struct PreparedFifoRegistry {
    records: crate::prepared_map::PreparedMap<u32, RestoredFifo>,
    staged: crate::io_buffer::IoBuffer<(usize, crate::pipe::PipeBuffer)>,
    names: crate::fifo::FifoTable,
    replacing: bool,
}

impl PreparedFifoRegistry {
    fn prepare(
        mut walk: impl FnMut(&mut dyn FnMut(u32, &[u8], WasmStat) -> Result<(), Errno>) -> Result<(), Errno>,
        replacing: bool,
    ) -> Result<Self, Errno> {
        use crate::io_buffer::{IoBuffer, IO_MEMORY};
        use crate::prepared_map::{PreparedEntry, PreparedMap};
        let mut records: PreparedMap<u32, RestoredFifo> = PreparedMap::new();
        walk(&mut |inode, path, metadata| {
            if !rootfs_fifo_path_visible(path, metadata, replacing)? { return Ok(()); }
            let existing = if replacing { None } else { unsafe { crate::fifo::global_fifo_table() }.lookup(path) };
            if !records.contains_key(&inode) {
                let reservation = PreparedEntry::<u32, RestoredFifo>::reserve_in(&IO_MEMORY, 0)?;
                let value = RestoredFifo { index: existing, aliases: 0, metadata, newly_created: false };
                records.insert_prepared(PreparedEntry::new_reserved_in(&IO_MEMORY, inode, value, reservation)?);
            }
            let record = records.get_mut(&inode).ok_or(Errno::EIO)?;
            if let Some(index) = existing {
                if record.index.is_some_and(|prior| prior != index) { return Err(Errno::EIO); }
                record.index = Some(index);
            } else {
                record.aliases = record.aliases.checked_add(1).ok_or(Errno::EMLINK)?;
            }
            Ok(())
        })?;
        let count = records.values().filter(|record| record.index.is_none()).count();
        for record in records.values() {
            if let Some(index) = record.index {
                let pipe = unsafe { crate::pipe::global_pipe_table() }.get(index).ok_or(Errno::EIO)?;
                pipe.fifo_name_count().checked_add(record.aliases).ok_or(Errno::EMLINK)?;
            }
        }
        let indices = unsafe { crate::pipe::global_pipe_table() }.prepare_slots(count)?;
        let mut staged = IoBuffer::new();
        staged.reserve_with(count, |values| {
            values.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)
        })?;
        records.for_each_mut(|record| {
            if record.index.is_none() {
                let index = indices[staged.len()];
                let mut pipe = crate::pipe::PipeBuffer::new_fifo(crate::pipe::DEFAULT_PIPE_CAPACITY, record.metadata);
                for _ in 1..record.aliases { pipe.add_fifo_name(); }
                pipe.update_fifo_metadata(record.metadata);
                staged.push((index, pipe));
                record.index = Some(index);
                record.newly_created = true;
            }
        });
        let mut names = crate::fifo::FifoTable::new();
        walk(&mut |inode, path, metadata| {
            if !rootfs_fifo_path_visible(path, metadata, replacing)? { return Ok(()); }
            if replacing || unsafe { crate::fifo::global_fifo_table() }.lookup(path).is_none() {
                let index = records.get(&inode).and_then(|record| record.index).ok_or(Errno::EIO)?;
                let prepared = names.prepare_registration(path, index)?;
                assert!(names.publish_registration(prepared));
            }
            Ok(())
        })?;
        Ok(Self { records, staged, names, replacing })
    }

    fn publish(self) {
        if self.replacing { clear_fifo_registry(); }
        for record in self.records.values() {
            let index = record.index.expect("prepared FIFO index missing");
            if !record.newly_created {
                let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(index)
                    .expect("prepared FIFO backing missing");
                for _ in 0..record.aliases { pipe.add_fifo_name(); }
                pipe.update_fifo_metadata(record.metadata);
            }
        }
        for (index, pipe) in self.staged {
            unsafe { crate::pipe::global_pipe_table() }.publish_prepared(index, pipe);
        }
        self.names.publish_into(unsafe { crate::fifo::global_fifo_table() });
    }
}

fn restore_fifo_registry() -> Result<(), Errno> {
    let prepared = PreparedFifoRegistry::prepare(|visit| for_each_fifo_path(visit), false)?;
    prepared.publish();
    Ok(())
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
    let root = state.mount_root()?;
    let parent = state.walk(root, parent_comps)?;
    match state.get_mut(parent).map(|i| &mut i.kind) {
        Some(InodeKind::Dir(entries)) => {
            if entries.contains_key(last) {
                return Err(Errno::EEXIST);
            }
            entries.try_insert(last, child)?;
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
            let root = state.mount_root()?;
            if let Some(inode) = state.get_mut(root) {
                inode.mode = mode & 0o7777;
                inode.uid = uid;
                inode.gid = gid;
                inode.ino = ino;
            }
            return Ok(());
        };
        let child = state.insert_inode(Inode::new(
            InodeKind::Dir(DirectoryEntries::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            ino,
        ))?;
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        match link_into_parent(state, &comps, last, child) {
            Ok(()) => {
                // Bump the parent's link count for the new subdirectory's `..`.
                let root = state.mount_root()?;
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
    insert_base_file_from(path, blob_id, size, mode, uid, gid, ino, BaseSource::Host)
}

/// Attach the deferred description `path`'s bytes came with, so an export can
/// re-emit it under whatever inode number it assigns.
///
/// Separate from [`insert_base_file`] because only SOME base files have one: a
/// URL-backed lazy file does, a base tree the host walked does not. Calling it
/// with an empty payload is a no-op rather than an error, so a loader need not
/// branch on whether the image declared a section.
pub fn mark_deferred_base(path: &[u8]) -> Result<(), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.deferred_base = true;
        Ok(())
    })
}

pub fn set_deferred_payload(path: &[u8], payload: &[u8]) -> Result<(), Errno> {
    if payload.is_empty() {
        return Ok(());
    }
    if payload.len() > crate::sdef::MAX_PAYLOAD_LEN as usize {
        return Err(Errno::EINVAL);
    }
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.deferred_payload = own_metadata(payload)?;
        Ok(())
    })
}

/// Attach the address and expected digest `path`'s bytes came with.
///
/// Unlike [`set_deferred_payload`], an empty URI is NOT a no-op: it is the
/// truthful record that the image named no address, and a caller that stores
/// nothing leaves whatever was there before. This one always writes what it was
/// given, because it is also how a description is corrected.
pub fn set_deferred_source(path: &[u8], uri: &[u8], digest: &[u8]) -> Result<(), Errno> {
    if uri.len() > crate::sdef::MAX_URI_LEN as usize {
        return Err(Errno::EINVAL);
    }
    let digest = crate::sdef::digest_from(digest)?;
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.deferred_uri = own_metadata(uri)?;
        inode.deferred_digest = digest;
        Ok(())
    })
}

/// Where `path`'s deferred bytes are and what they must hash to, as the image
/// described them. `(uri, digest)`; an ordinary file yields an empty URI and
/// [`crate::sdef::DIGEST_NONE`], the same as a deferred file the image
/// described no address for.
pub fn deferred_source(
    path: &[u8],
) -> Result<(Vec<u8>, [u8; crate::sdef::DIGEST_LEN]), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let inode = state.get(idx).ok_or(Errno::ENOENT)?;
        Ok((inode.deferred_uri.to_vec(), inode.deferred_digest))
    })
}

/// Insert a base regular file whose bytes are served by the kernel from the `/`
/// image itself, at KIFS inode `ino`. The image-authoritative counterpart to
/// [`insert_base_file`]: same node, no host byte store behind it.
#[allow(clippy::too_many_arguments)]
pub fn insert_image_file(
    path: &[u8],
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    insert_base_file_from(path, ino, size, mode, uid, gid, ino, BaseSource::Image)
}

#[allow(clippy::too_many_arguments)]
fn insert_base_file_from(
    path: &[u8],
    blob_id: u64,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
    source: BaseSource,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::BaseRegular {
                blob_id,
                size,
                source,
            },
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
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
    insert_base_symlink_owned(path, own_metadata(target)?, mode, uid, gid, ino)
}

fn insert_base_symlink_owned(
    path: &[u8],
    target: OwnedMetadata,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::Symlink(target),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

pub fn insert_base_special(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
    type_bits: u32,
) -> Result<(), Errno> {
    if type_bits != S_IFIFO && type_bits != S_IFSOCK {
        return Err(Errno::EINVAL);
    }
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::Special(type_bits),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
        if let Err(error) = link_into_parent(state, &parent_comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(error);
        }
        Ok(())
    })
}

/// Insert a lazy-archive placeholder file: `size` is authoritative metadata
/// from the loader (like [`insert_base_file`]'s `size`), while the bytes live
/// at `source_path` within archive `archive_id`, not yet fetched. Placed
/// exactly like a base file; its bytes are fetched on first read.
#[allow(clippy::too_many_arguments)]
pub fn insert_lazy_file(
    path: &[u8],
    archive_id: u32,
    source_path: &[u8],
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
    uri: &[u8],
    digest: &[u8],
    payload: &[u8],
) -> Result<(), Errno> {
    // `archive_id == 0` is a file fetched STANDALONE: no archive behind it, so
    // no member path either, and `uri` is the only thing that says where its
    // bytes are. That is the shape 79 files in the shipped shell image
    // have, and the shape a deferred setuid binary takes. It needs this
    // explicit branch because the archive declaration rejects id 0.
    if (archive_id == 0) != source_path.is_empty() {
        return Err(Errno::EINVAL);
    }
    if payload.len() > crate::sdef::MAX_PAYLOAD_LEN as usize {
        return Err(Errno::EINVAL);
    }
    if uri.len() > crate::sdef::MAX_URI_LEN as usize {
        return Err(Errno::EINVAL);
    }
    // An archive member is addressed by its archive; a second address here
    // would be a second author for the same fact. Same rule the section format
    // enforces, applied at the door rather than discovered at encode.
    if archive_id != 0 && !uri.is_empty() {
        return Err(Errno::EINVAL);
    }
    let digest = crate::sdef::digest_from(digest)?;
    let owned_path = own_metadata(source_path)?;
    let owned_payload = own_metadata(payload)?;
    let owned_uri = own_metadata(uri)?;
    ROOTFS.with(|state| {
        state.bump_next_ino(ino);
        let (parent_comps, last) = parent_and_last(path).ok_or(Errno::EINVAL)?;
        let child = state.insert_inode(Inode::new(
            InodeKind::LazyMember {
                archive_id,
                source_path: owned_path,
                size,
            },
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
        if let Some(inode) = state.get_mut(child) {
            inode.deferred_payload = owned_payload;
            inode.deferred_uri = owned_uri;
            inode.deferred_digest = digest;
        }
        let comps: Vec<&[u8]> = parent_comps.iter().map(|c| &**c).collect();
        if let Err(e) = link_into_parent(state, &comps, last, child) {
            state.inodes[child as usize] = None;
            state.free_inodes.push(child);
            return Err(e);
        }
        Ok(())
    })
}

/// What a builder needs to know about whether `path`'s bytes are in the image.
///
/// `(deferred, ino, size, archive_id)`. `deferred` is false for an ordinary
/// file, in which case the other fields still describe it — a caller asking
/// "is this resident?" gets its answer without a second call.
///
/// **The fields are the ones something reads, not the ones the old TypeScript
/// registry happened to expose.** Measured across the four recipes that call
/// `getLazyEntry`/`isPathDeferred`: two use the result only as a boolean, one
/// reads `size`, one reads inode identity. `url` is not here because nothing
/// reads it through this path — it lives in the deferred payload, opaque, and
/// building an accessor for it would be a floor nobody stands on.
pub fn lazy_info(path: &[u8]) -> Result<(bool, u64, u64, u32), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let inode = state.get(idx).ok_or(Errno::ENOENT)?;
        Ok(match &inode.kind {
            InodeKind::LazyMember {
                archive_id, size, ..
            } => (true, inode.ino, *size, *archive_id),
            // A base file whose bytes the host fetches: deferred, with no
            // archive behind it.
            InodeKind::BaseRegular {
                size,
                source: BaseSource::Host,
                ..
            } => (true, inode.ino, *size, 0),
            InodeKind::BaseRegular { size, .. } => {
                (false, inode.ino, inode.persistent_size.unwrap_or(*size), 0)
            }
            InodeKind::Regular(data) => (false, inode.ino, data.len() as u64, 0),
            InodeKind::PersistentRegular => {
                (false, inode.ino, inode.persistent_size.unwrap_or(0), 0)
            }
            _ => (false, inode.ino, 0, 0),
        })
    })
}

/// The `(archive_id, source_path)` of a lazy-file placeholder at `path`: which
/// archive the byte-serving path fetches and which member within it it
/// extracts. Exposed as an accessor for the loader's own tests.
pub fn lazy_member_source(path: &[u8]) -> Result<(u32, Vec<u8>), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::LazyMember {
                archive_id,
                source_path,
                ..
            } => Ok((*archive_id, source_path.to_vec())),
            _ => Err(Errno::EINVAL),
        }
    })
}

/// Declare a lazy archive's total byte length, so the kernel can bound the
/// whole-archive fetch a member of it will need.
///
/// Idempotent when the length agrees, and `EINVAL` when it does not: one
/// archive with two lengths has no correct reading, and silently keeping either
/// one would decide a fetch bound by declaration order. An already-populated
/// entry keeps its fetched bytes — this declares a length, it does not reset an
/// archive.
pub fn declare_archive(archive_id: u32, bytes: u64) -> Result<(), Errno> {
    if archive_id == 0 {
        return Err(Errno::EINVAL);
    }
    ROOTFS.with(|state| match state.archives.get(&archive_id) {
        // The length agrees, so this is a re-declaration by another member of
        // the same archive, which is the ordinary case: a builder registers
        // members one at a time and each names the archive it belongs to.
        Some(existing) if existing.size == bytes => Ok(()),
        Some(_) => Err(Errno::EINVAL),
        None => {
            state.archives.insert(
                archive_id,
                ArchiveEntry::new(bytes, b"", crate::sdef::DIGEST_NONE, b"")?,
            );
            Ok(())
        }
    })
}

/// The size (in bytes) of archive `archive_id` as the loaded image declared
/// it, or `None` if no such archive was registered. Consumed by the
/// byte-serving path ([`ensure_archive_member`]).
pub fn archive_size(archive_id: u32) -> Option<u64> {
    ROOTFS.with(|state| state.archives.get(&archive_id).map(|entry| entry.size))
}

/// Mount points of the kernel's own mounts. Images are not required to ship
/// them: after loading an image the kernel creates them in the overlay (root
/// owned, 0755), the way an init system creates its runtime mount points at
/// boot. They are real directories, so `ls /run/kandelo` shows `exchange`.
const KERNEL_MOUNT_POINTS: &[&[u8]] = &[crate::exchange::MOUNT_PATH];

/// Create each kernel mount point and its missing ancestors. An existing
/// non-directory on the way is a conflicting image: ENOTDIR, and the load
/// fails rather than booting with an unreachable mount.
fn ensure_kernel_mount_points() -> Result<(), Errno> {
    for mount in KERNEL_MOUNT_POINTS {
        for (index, &byte) in mount.iter().enumerate().skip(1) {
            if byte == b'/' {
                ensure_directory(&mount[..index])?;
            }
        }
        ensure_directory(mount)?;
    }
    Ok(())
}

fn ensure_directory(path: &[u8]) -> Result<(), Errno> {
    match mkdir(path, 0o755, 0, 0) {
        Ok(()) => Ok(()),
        Err(Errno::EEXIST) if lstat(path)?.st_mode & S_IFMT == S_IFDIR => Ok(()),
        Err(Errno::EEXIST) => Err(Errno::ENOTDIR),
        Err(error) => Err(error),
    }
}

/// Set a just-inserted base entry's atime/mtime/ctime to the image's real mtime.
/// (The image carries one meaningful timestamp per entry; atime/ctime distinct
/// from mtime are rarely load-bearing and are not preserved separately.)
fn set_base_times(path: &[u8], mtime_sec: u64, mtime_nsec: u32) {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let Some(root) = state.root else { return };
        if let Ok(idx) = state.walk(root, &comps) {
            if let Some(inode) = state.get_mut(idx) {
                inode.atime_sec = mtime_sec;
                inode.atime_nsec = mtime_nsec;
                inode.mtime_sec = mtime_sec;
                inode.mtime_nsec = mtime_nsec;
                inode.ctime_sec = mtime_sec;
                inode.ctime_nsec = mtime_nsec;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Image-authoritative base-tree load: the kernel parses its own `/` image.
// ---------------------------------------------------------------------------

/// A [`crate::kandelo_image_fs::BlockSource`] backed by the host's raw image window.
///
/// `BlockSource::read_exact_at` takes `&self` because a resident `[u8]` image
/// needs no mutation to serve a block; a host-backed source needs `&mut` on the
/// byte-source closure, so the closure lives behind a `RefCell`. The kernel is
/// single-threaded through this path (the whole tree build runs inside one
/// `kernel_rootfs_load_image` call), so a borrow conflict is a bug rather than
/// contention, and `try_borrow_mut` reports it as `EIO` instead of panicking.
///
/// No block cache. A cache here would be an unmeasured optimisation on a boot
/// path, and `docs/agent-guidance/performance.md` governs: the cost of this
/// shape is deliberately left visible until it is measured.
struct HostImageSource<F> {
    byte_source: core::cell::RefCell<F>,
    len: u64,
}

impl<F> crate::kandelo_image_fs::BlockSource for HostImageSource<F>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    fn len(&self) -> u64 {
        self.len
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        if dst.is_empty() {
            return Ok(());
        }
        if crate::rootfs_image::read(offset, dst)?.is_some() {
            return Ok(());
        }
        // Two failures are possible here and they are different facts.
        //
        // `EINVAL` means the IMAGE is wrong: the kernel asked past the length
        // the host declared, or the host hit end-of-image inside a range that
        // length said it holds. Both say the container is not the size it
        // claims, which is a malformed image however it arose. Reporting them
        // identically keeps the verdict from depending on which byte the walk
        // happened to reach first.
        //
        // Any other errno means the HOST is wrong, or busy: `ENOSYS` (no image
        // source installed), `EAGAIN` (bytes not ready), `EIO` (transport). Those
        // propagate untouched, because the image may be perfectly good.
        let end = offset.checked_add(dst.len() as u64).ok_or(Errno::EINVAL)?;
        if end > self.len {
            return Err(Errno::EINVAL);
        }
        let mut byte_source = self.byte_source.try_borrow_mut().map_err(|_| Errno::EIO)?;
        let mut done = 0usize;
        while done < dst.len() {
            let at = offset.checked_add(done as u64).ok_or(Errno::EINVAL)?;
            let read = (*byte_source)(ByteReq::Image { offset: at }, &mut dst[done..])?;
            if read == 0 {
                return Err(Errno::EINVAL); // shorter than the declared length
            }
            done = done.checked_add(read).ok_or(Errno::EIO)?;
            if done > dst.len() {
                return Err(Errno::EIO); // host overran the buffer it was lent
            }
        }
        Ok(())
    }
}

/// A window onto part of a [`crate::kandelo_image_fs::BlockSource`].
///
/// The VFSI container wraps the KIFS filesystem at a non-zero offset, and
/// `KandeloImageFs::mount` addresses blocks from the filesystem's own byte 0. Rebasing
/// here keeps that offset out of every `KandeloImageFs` call site.
struct SubSource<'a, S> {
    inner: &'a S,
    offset: u64,
    len: u64,
}

impl<S: crate::kandelo_image_fs::BlockSource> crate::kandelo_image_fs::BlockSource for SubSource<'_, S> {
    fn len(&self) -> u64 {
        self.len
    }

    fn read_exact_at(&self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        let end = offset.checked_add(dst.len() as u64).ok_or(Errno::EIO)?;
        if end > self.len {
            return Err(Errno::EIO);
        }
        let base = self.offset.checked_add(offset).ok_or(Errno::EIO)?;
        self.inner.read_exact_at(base, dst)
    }
}

/// Read from KIFS inode `ino` of the loaded `/` image, through the same reader
/// [`load_image`] walked the tree with.
///
/// This is what `BaseSource::Image` means at the byte level. The host's whole
/// part is `ByteReq::Image`: a positioned window onto one container it already
/// holds. It resolves no name, is never told which file is being read, and
/// keeps no inode-to-path map to be asked with.
///
/// `EIO` when no image is loaded — a `BaseSource::Image` node can only have
/// been placed by [`load_image`], which records the geometry before it inserts
/// the first one, so reaching this without a geometry is a kernel bug, not a
/// host or image condition.
fn read_image_bytes<F>(
    ino: u32,
    offset: u64,
    dst: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    ImageReadCursor::new().read(ino, offset, dst, byte_source)
}

struct ImageReadCursor {
    position: Option<(u32, crate::kandelo_image_fs::FileReadPosition)>,
}

impl ImageReadCursor {
    fn new() -> Self { Self { position: None } }

    fn read<F>(&mut self, ino: u32, offset: u64, destination: &mut [u8], byte_source: &mut F) -> Result<usize, Errno>
    where
        F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
    {
        let geometry = ROOTFS.with(|state| state.image).ok_or(Errno::EIO)?;
        let source = HostImageSource {
            byte_source: core::cell::RefCell::new(byte_source),
            len: geometry.image_len,
        };
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::from_geometry(
            SubSource { inner: &source, offset: geometry.fs_offset, len: geometry.fs_len },
            geometry.image,
        );
        if self.position.as_ref().is_none_or(|(cached_ino, _)| *cached_ino != ino) {
            self.position = None;
            self.position = Some((ino, filesystem.file_read_position(ino)?));
        }
        filesystem.read_at_position(&mut self.position.as_mut().ok_or(Errno::EIO)?.1, offset, destination)
    }
}

/// The KIFS inode number behind a `BaseSource::Image` node. `blob_id` is that
/// inode number by construction ([`insert_image_file`] passes one value for
/// both), so a value that does not fit `u32` is a corrupt store rather than a
/// large image.
fn image_ino(blob_id: u64) -> Result<u32, Errno> {
    u32::try_from(blob_id).map_err(|_| Errno::EIO)
}

fn with_image_file_allocations<F, Output>(
    geometry: ImageGeometry,
    ino: u32,
    range: core::ops::Range<u64>,
    byte_source: &mut F,
    query: impl FnOnce(&mut dyn FnMut() -> Result<Option<u32>, Errno>) -> Result<Output, Errno>,
) -> Result<Output, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let source = HostImageSource {
        byte_source: core::cell::RefCell::new(byte_source),
        len: geometry.image_len,
    };
    let filesystem = crate::kandelo_image_fs::KandeloImageFs::from_geometry(
        SubSource { inner: &source, offset: geometry.fs_offset, len: geometry.fs_len },
        geometry.image,
    );
    let mut cursor = None;
    query(&mut || {
        if cursor.is_none() {
            cursor = Some(filesystem.file_allocations(ino, range.clone())?);
        }
        cursor.as_mut().ok_or(Errno::EIO)?.next_block()
    })
}

/// A suspended ancestor's directory position and prefix in the current path.
/// The walk uses an explicit stack rather than recursion: image
/// depth is untrusted input in a browser (a shared boot descriptor can name an
/// image), and the kernel has no guard page under its shadow stack.
struct PendingDir {
    position: crate::kandelo_image_fs::DirectoryPosition,
    path_len: usize,
}

fn reserve_image_walk_capacity<Value>(
    values: &mut Vec<Value>,
    required: usize,
    memory: &mut MetadataReservation<'_>,
) -> Result<(), Errno> {
    if required <= values.capacity() { return Ok(()); }
    let width = core::mem::size_of::<Value>();
    let previous = values.capacity().checked_mul(width).ok_or(Errno::ENOMEM)?;
    let capacity = values.capacity().checked_mul(2).unwrap_or(required).max(required).max(4);
    let target = capacity.checked_mul(width).ok_or(Errno::ENOMEM)?;
    memory.resize(previous.checked_add(target).ok_or(Errno::ENOMEM)?)?;
    if values.try_reserve_exact(capacity.checked_sub(values.len()).ok_or(Errno::ENOMEM)?).is_err() {
        memory.resize(previous)?;
        return Err(Errno::ENOMEM);
    }
    memory.resize(values.capacity().checked_mul(width).ok_or(Errno::ENOMEM)?)
}

fn mark_image_walk_inode(
    visited: &mut crate::prepared_map::PreparedMap<u32, Option<u32>>,
    ino: u32,
) -> Result<bool, Errno> {
    if visited.contains_key(&ino) { return Ok(false); }
    let entry = crate::prepared_map::PreparedEntry::new_reserved_in(
        &ROOTFS_METADATA, ino, None, ROOTFS_METADATA.reserve_temporary(0)?,
    )?;
    visited.insert_prepared(entry);
    Ok(true)
}

/// Ceiling on directories visited, so a corrupt image whose cycle escapes the
/// visited-set check still terminates. The nine production images have at most
/// tens of thousands of directories; a million is far above any real image and
/// far below anything that could hang a boot.
const MAX_IMAGE_DIRS: usize = 1_000_000;

/// Replace the base layer by parsing the `/` VFS image itself, pulling its bytes
/// from the host through [`ByteReq::Image`].
///
/// The kernel mounts the image's KIFS filesystem, walks it, and applies the
/// image's own deferred-file section (`SDEF`, [`crate::sdef`]) to learn which
/// inodes are deferred. The host does not resolve names; it is a positioned
/// byte window over one container it already holds. (This replaced the RTFS
/// manifest the host used to walk and re-encode, whose loader was removed on
/// 2026-10-02, as was the reader for the older `KLZY` section; an image that
/// carries `KLZY` is refused.)
///
/// `image_len` is the length of the whole VFSI container, which the host knows
/// and the container header does not carry. Returns the number of entries
/// inserted. A malformed image or a rejected insert yields `EINVAL`/`EIO` with
/// the store reset to empty — a partial tree is never left behind.
///
/// The walk visits the root first and then each directory's children in
/// sorted name order, skipping `.`/`..` and anything that is not a directory,
/// regular file, or symlink.
pub fn load_image<F>(image_len: u64, byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let result = load_image_for_composition(image_len, byte_source).and_then(|count| {
        ensure_kernel_mount_points()?;
        Ok(count)
    });
    if result.is_err() { reset(); }
    result
}

pub fn load_image_for_composition<F>(image_len: u64, byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    reset();
    let result = load_image_inner(image_len, byte_source).and_then(|count| {
        restore_fifo_registry()?;
        Ok(count)
    });
    if result.is_err() {
        reset();
    }
    result
}

pub fn load_persistent_image<F>(
    physical_length: u64,
    expected: [u8; 32],
    cache: crate::persistent_image::CacheConfig,
    read: PhysicalImageRead,
    byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    reset();
    let result = crate::rootfs_image::install(physical_length, expected, cache, read)
        .and_then(|identity| load_image_inner(identity.payload_length, byte_source))
        .and_then(|count| {
            restore_fifo_registry()?;
            ensure_kernel_mount_points()?;
            Ok(count)
        });
    if result.is_err() { reset(); }
    result
}

pub fn persistent_image_binding() -> Option<crate::persistent_image::ImageIdentity> {
    let image_length = image_length()?;
    crate::rootfs_image::binding().filter(|identity| identity.payload_length == image_length)
}

/// One deferred file as the loader needs it: which inode is deferred, how big
/// it really is, and — for an archive member — which archive and which member.
struct DeferredEntry {
    size: u64,
    /// `0` for a file fetched standalone, whose transport the host owns.
    archive_id: u32,
    /// Empty exactly when `archive_id == 0`. Owned rather than borrowed because
    /// the two carriers store it differently and neither buffer outlives this.
    source_path: Vec<u8>,
}

fn load_image_inner<F>(image_len: u64, byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    use crate::kandelo_image_fs::{BlockSource, ROOT_INO, KandeloImageFs, file_type};

    let source = HostImageSource {
        byte_source: core::cell::RefCell::new(byte_source),
        len: image_len,
    };

    // An image carrying a `KLZY` (kernel lazy-linkage) section is refused.
    //
    // `KLZY` was the TypeScript image writer's description of deferred files.
    // That writer was deleted on 2026-09-17 and nothing writes the section any
    // more: every image builder now describes deferred files with an `SDEF`
    // section in the image body. The only images that carry one predate that
    // change and were built under ABI 44, which is unreleased, so they are
    // stale artifacts. `docs/agent-guidance/abi.md` is explicit that a stale
    // artifact fails loudly and is rebuilt rather than shimmed, so the reader
    // that decoded `KLZY` was removed (2026-10-02) instead of kept as a second
    // carrier. The span is still located (the container header says where it
    // is) so that such an image is named and refused, not silently read as
    // if the section were absent.
    if crate::kandelo_image_fs::kernel_lazy_span(&source)?.is_some() {
        return Err(Errno::EINVAL);
    }

    // `fs_len`, not `image_len`: the span is the FILESYSTEM's, and `image_len`
    // above is the whole container's. They differ by the header and every
    // other section, and naming both the same is how a rename briefly made one
    // struct take the container's length twice.
    let (fs_offset, fs_len) = crate::kandelo_image_fs::kandelo_image_span(&source)?;
    let filesystem = KandeloImageFs::mount(SubSource {
        inner: &source,
        offset: fs_offset,
        len: fs_len,
    })?;

    // Remember where the filesystem is, and what `mount` just validated about
    // it, BEFORE the walk. Every `BaseSource::Image` node the walk inserts is a
    // promise that the kernel can come back for those bytes later, and this is
    // the only record of how. It is recorded inside the same call that
    // validated it, so a geometry can never outlive a successful mount: the
    // `reset()` on any error below drops it again.
    let declared_capacity = filesystem.growth_ceiling_bytes()?;
    let image_geometry = ImageGeometry {
        image_len,
        fs_offset,
        fs_len,
        capacity_bytes: declared_capacity,
        image: filesystem.geometry(),
    };
    ROOTFS.with(|state| state.image = Some(image_geometry));

    // WHAT THE IMAGE SAYS ABOUT ITSELF, KEPT. Both of these were read
    // only by the export and written only by their setters, so an image loaded
    // and re-exported came back having forgotten its own declarations: a base
    // declaring 256 MiB of room re-exported sized to its tree, and a base
    // declaring a kernel ABI re-exported declaring nothing. A load preserves
    // what the image states, or it is not a load.
    //
    // The capacity is a CEILING and not an allocation: it floors the export's
    // `max_blocks` while `total_blocks` stays sized to the content, so
    // restoring it costs the inode table its share and not the declared room.
    let declared_metadata = match crate::kandelo_image_fs::metadata_span(&source)? {
        Some((offset, len)) => {
            let len = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
            let mut bytes = OwnedMetadata::zeroed(&ROOTFS_METADATA, len)?;
            for (index, chunk) in bytes.as_mut_slice().chunks_mut(4096).enumerate() {
                source.read_exact_at(offset + index as u64 * 4096, chunk)?;
            }
            Some(bytes)
        }
        None => None,
    };
    // REFUSE AN IMAGE BUILT FOR A DIFFERENT KERNEL, here rather than in the
    // host that chose the file.
    //
    // An image is a product artifact with a long life: built once, written to
    // `local-binaries/`, and surviving every `ABI_VERSION` bump after it. So
    // "the image and the kernel disagree" is the ordinary consequence of not
    // rebuilding, not a transport accident, and the ABI contract says an
    // ABI-mismatched VFS image must fail loudly and be rebuilt.
    //
    // It used to be checked in `host/src/binary-resolver.ts`, which parsed the
    // image header in TypeScript to read one field while CHOOSING which file
    // to use. That put a contract the kernel owns in a file chooser, and made
    // the host parse the image format the kernel already parses.
    // The bytes are already in hand here, so the check costs nothing it did
    // not already pay for.
    //
    // `EPROTO` rather than `EINVAL`: the image is not malformed, it speaks a
    // different version of the contract, and a caller that cannot tell those
    // apart reports a rebuildable artifact as a corrupt one.
    // The violation carries the declared and expected numbers; this entry
    // point has no channel to report them on, so they are dropped here and the
    // errno carries the kind. Where the numbers ARE usable -- the publication
    // gate, which formats its own prose -- `check_declared_abi` hands them
    // over intact.
    if crate::image_policy::check_declared_abi(
        declared_metadata.as_ref().map(|bytes| bytes.as_slice()),
        wasm_posix_shared::ABI_VERSION,
    )
    .is_err()
    {
        return Err(Errno::EPROTO);
    }

    ROOTFS.with(|state| {
        state.image_capacity_bytes = Some(declared_capacity);
        state.image_metadata = declared_metadata;
    });

    // The image's own deferred section, when it carries one. It is BOTH a
    // linkage source (below) and the place the opaque fetch descriptions live,
    // which is why it is read once and used twice.
    let mut deferred_input = ROOTFS_METADATA.reserve_temporary(0)?;
    let deferred = filesystem.deferred_section_with_admission(|bytes| {
        let extra = bytes.checked_mul(3).ok_or(Errno::ENOMEM)?;
        let needed = deferred_input.bytes().checked_add(extra).ok_or(Errno::ENOMEM)?;
        deferred_input.resize(if needed != 0 && deferred_input.bytes() == 0 {
            needed.checked_add(4096).ok_or(Errno::ENOMEM)?
        } else { needed })
    })?;

    // The image's `SDEF` section describes its deferred files.
    //
    // An image whose body carries no `SDEF` section is refused, for the reason
    // it always was: such an image predates the kernel's ability to parse an
    // image, and the kernel cannot tell "this image has no lazy files" from
    // "this image records its lazy files only in the host-side JSON the kernel
    // cannot read". Accepting it would silently build a tree where every
    // deferred file reports size 0 — a wrong tree that looks like a right one.
    // An image with genuinely no lazy files still carries a section, empty.
    // So a missing description is a stale artifact, and
    // `docs/agent-guidance/abi.md` is explicit that a stale artifact fails
    // loudly and is rebuilt rather than shimmed.
    let mut lazy_files: BTreeMap<u32, DeferredEntry> = BTreeMap::new();
    type LazyArchiveDecl = (
        u32,
        u64,
        Vec<u8>,
        [u8; crate::sdef::DIGEST_LEN],
        Vec<u8>,
    );
    let mut lazy_archives: Vec<LazyArchiveDecl> = Vec::new();
    let section = deferred.as_ref().ok_or(Errno::EINVAL)?;
    // `decode` already rejects duplicate inodes, a record naming an
    // undeclared archive, and a half-specified linkage.
    for record in &section.records {
        lazy_files.insert(
            record.ino,
            DeferredEntry {
                size: record.size,
                archive_id: record.archive_id,
                source_path: record.source_path.clone(),
            },
        );
    }
    for archive in &section.archives {
        lazy_archives.push((
            archive.archive_id,
            archive.bytes,
            archive.uri.clone(),
            archive.digest,
            archive.payload.clone(),
        ));
    }

    // An image that SAYS it has lazy archives, through a carrier that
    // describes none, is an image whose archives this reader cannot see.
    //
    // The refusal above catches an image that describes its deferred files
    // nowhere. This catches the narrower and quieter case: a description that
    // is present and PARTIAL. The legacy `KLZY` encoder skips any archive
    // group whose raw byte length or transport it does not know -- documented
    // there as a truthful gap, because bytes that cannot be validated should
    // not be promised -- but the gap is truthful only at the writing end. Here
    // it arrives as an archive that was never mentioned, so its members are
    // walked as ordinary files and inserted with the zero length their stub
    // inodes carry. A 4,096-byte binary becomes an empty file, the load
    // reports success, and a build derived from it ships the emptiness.
    //
    // That is precisely the "wrong tree that looks like a right one" the
    // neither-carrier refusal exists to prevent, reached one archive at a time
    // instead of all at once. Same defect, same answer: a stale artifact fails
    // loudly and is rebuilt.

    let declared_flags = crate::kandelo_image_fs::container_flags(&source)?;
    if declared_flags & crate::kandelo_image_fs::VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES != 0
        && lazy_archives.is_empty()
    {
        return Err(Errno::EINVAL);
    }

    let root_stat = filesystem.stat_ino(ROOT_INO)?;
    if file_type(root_stat.mode) != S_IFDIR {
        return Err(Errno::EINVAL); // `/` is not a directory in the image
    }
    insert_base_dir(
        b"/",
        root_stat.mode,
        root_stat.uid,
        root_stat.gid,
        u64::from(ROOT_INO),
    )?;
    set_base_times_from_ms(b"/", root_stat.mtime_ms);
    let mut count = 1usize;

    let mut visited = crate::prepared_map::PreparedMap::<u32, Option<u32>>::new();
    mark_image_walk_inode(&mut visited, ROOT_INO)?;
    let mut stack: Vec<PendingDir> = Vec::new();
    let mut stack_memory = ROOTFS_METADATA.reserve_temporary(0)?;
    let mut path_memory = ROOTFS_METADATA.reserve_temporary(0)?;
    let mut dir_path = Vec::new();
    reserve_image_walk_capacity(&mut dir_path, 1, &mut path_memory)?;
    dir_path.push(b'/');
    let mut cursor = filesystem.directory_entries(ROOT_INO)?;
    let mut dirs_visited = 1usize;

    loop {
        let Some(entry) = cursor.next_entry()? else {
            let Some(parent) = stack.pop() else { break };
            dir_path.truncate(parent.path_len);
            cursor = filesystem.resume_directory(parent.position);
            continue;
        };
        if entry.name == b"." || entry.name == b".." {
            continue;
        }
        let mut abs = Vec::new();
        let mut abs_memory = ROOTFS_METADATA.reserve_temporary(0)?;
        let required = dir_path.len().checked_add(entry.name.len())
            .and_then(|length| length.checked_add(1)).ok_or(Errno::ENOMEM)?;
        reserve_image_walk_capacity(&mut abs, required, &mut abs_memory)?;
        abs.extend_from_slice(&dir_path);
        if dir_path != b"/" {
            abs.push(b'/');
        }
        abs.extend_from_slice(&entry.name);

        let stat = filesystem.stat_ino(entry.ino)?;
        let ino = u64::from(entry.ino);
        let kind = file_type(stat.mode);
        if matches!(kind, S_IFREG | S_IFLNK | S_IFIFO | S_IFSOCK)
            && !mark_image_walk_inode(&mut visited, entry.ino)? {
            let index = visited.get(&entry.ino).copied().flatten().ok_or(Errno::EINVAL)?;
            ROOTFS.with(|state| {
                let inode = state.get(index).ok_or(Errno::EIO)?;
                let nlink = inode.nlink.checked_add(1).ok_or(Errno::EMLINK)?;
                if nlink > stat.nlink {
                    return Err(Errno::EINVAL);
                }
                let (parent, name) = parent_and_last(&abs).ok_or(Errno::EINVAL)?;
                link_into_parent(state, &parent, name, index)?;
                state.get_mut(index).ok_or(Errno::EIO)?.nlink = nlink;
                Ok::<_, Errno>(())
            })?;
            count += 1;
            continue;
        }
        match file_type(stat.mode) {
            S_IFDIR => {
                if !mark_image_walk_inode(&mut visited, entry.ino)? {
                    // A directory reachable by two names is not a legal POSIX
                    // tree and would make this walk non-terminating.
                    return Err(Errno::EINVAL);
                }
                dirs_visited += 1;
                if dirs_visited > MAX_IMAGE_DIRS {
                    return Err(Errno::EINVAL);
                }
                let required = stack.len().checked_add(1).ok_or(Errno::ENOMEM)?;
                reserve_image_walk_capacity(&mut stack, required, &mut stack_memory)?;
                insert_base_dir(&abs, stat.mode, stat.uid, stat.gid, ino)?;
                set_base_times_from_ms(&abs, stat.mtime_ms);
                count += 1;
                let child_ino = entry.ino;
                stack.push(PendingDir {
                    position: cursor.position(),
                    path_len: dir_path.len(),
                });
                dir_path = abs;
                core::mem::swap(&mut path_memory, &mut abs_memory);
                cursor = filesystem.directory_entries(child_ino)?;
                continue;
            }
            S_IFREG => {
                match lazy_files.get(&entry.ino) {
                    Some(lazy) if lazy.archive_id != 0 => {
                        insert_lazy_file(
                            &abs,
                            lazy.archive_id,
                            &lazy.source_path,
                            lazy.size,
                            stat.mode,
                            stat.uid,
                            stat.gid,
                            ino,
                            // An archive member is addressed by its
                            // archive, never by itself, so there is no URI
                            // to retain here — the format refuses one.
                            b"",
                            // The member's own content digest, when the
                            // image declared one: it covers the INFLATED
                            // member, which the archive's digest cannot,
                            // because that one covers the archive.
                            deferred
                                .as_ref()
                                .and_then(|section| section.get(entry.ino))
                                .map(|record| &record.digest[..])
                                .unwrap_or(b""),
                            // The file's own fetch description, when the
                            // image carried one. An archive member usually
                            // has none — the archive carries the transport
                            // — but nothing says it cannot, and losing one
                            // the image DID carry is the defect this whole
                            // retention path exists to prevent.
                            deferred
                                .as_ref()
                                .and_then(|section| section.get(entry.ino))
                                .map(|record| record.payload.as_slice())
                                .unwrap_or(b""),
                        )?;
                    }
                    // A URL-backed lazy file (`archive_id == 0`) is a base
                    // file whose bytes the host still fetches on demand; only
                    // its size comes from the linkage.
                    Some(lazy) => {
                        insert_base_file(
                            &abs, ino, lazy.size, stat.mode, stat.uid, stat.gid, ino,
                        )?;
                        mark_deferred_base(&abs)?;
                        // Deferred REGARDLESS of whether a description came
                        // with it. `KLZY` carries none, so without this the
                        // file is indistinguishable from one the host
                        // walked -- and the export turns that into a
                        // zero-length ordinary file.

                        // Retain the fetch description verbatim. Without
                        // it, exporting this file loses the only thing that
                        // says where its bytes are: its inode number here
                        // does not survive an export's renumbering, and the
                        // kernel has no URL of its own.
                        if let Some(section) = &deferred {
                            if let Some(record) = section.get(entry.ino) {
                                set_deferred_payload(&abs, &record.payload)?;
                                set_deferred_source(&abs, &record.uri, &record.digest)?;
                            }
                        }
                    }
                    // Not deferred at all: the bytes are IN this image, at
                    // this inode, and the kernel reads them itself.
                    None => {
                        insert_image_file(
                            &abs, stat.size, stat.mode, stat.uid, stat.gid, ino,
                        )?;
                        let mut cursor = filesystem.file_allocations(entry.ino, 0..u64::MAX)?;
                        let mut counter = SparseFileBlockCounter::default();
                        let mut data_blocks = 0u64;
                        while let Some(block) = cursor.next_block()? {
                            counter.push(block);
                            data_blocks += 1;
                        }
                        let components = split_components(&abs);
                        ROOTFS.with(|state| {
                            let root = state.mount_root()?;
                            let index = state.walk(root, &components)?;
                            let inode = state.get_mut(index).ok_or(Errno::EIO)?;
                            inode.base_dense = data_blocks == stat.size.div_ceil(4096);
                            inode.allocated_blocks = counter.total();
                            Ok::<_, Errno>(())
                        })?;
                    }
                }
                set_base_times_from_ms(&abs, stat.mtime_ms);
                count += 1;
            }
            S_IFLNK => {
                    if stat.size > fs_len { return Err(Errno::EIO); }
                    let mut target = OwnedMetadata::zeroed(&ROOTFS_METADATA,
                        usize::try_from(stat.size).map_err(|_| Errno::ENOMEM)?)?;
                    if filesystem.read_link_into(entry.ino, target.as_mut_slice())? != target.len() {
                        return Err(Errno::EIO);
                    }
                    insert_base_symlink_owned(&abs, target, stat.mode, stat.uid, stat.gid, ino)?;
                set_base_times_from_ms(&abs, stat.mtime_ms);
                count += 1;
            }
            S_IFIFO | S_IFSOCK => {
                insert_base_special(&abs, stat.mode, stat.uid, stat.gid, ino, file_type(stat.mode))?;
                set_base_times_from_ms(&abs, stat.mtime_ms);
                count += 1;
            }
            _ => {}
        }
        if stat.nlink > 1 && matches!(kind, S_IFREG | S_IFLNK | S_IFIFO | S_IFSOCK) {
            let mut components = Vec::new();
            let mut components_memory = ROOTFS_METADATA.reserve_temporary(0)?;
            let required = abs.split(|byte| *byte == b'/').filter(|part| !part.is_empty()).count();
            reserve_image_walk_capacity(&mut components, required, &mut components_memory)?;
            components.extend(abs.split(|byte| *byte == b'/').filter(|part| !part.is_empty()));
            let index = ROOTFS.with(|state| {
                let root = state.mount_root()?;
                state.walk(root, &components)
            })?;
            *visited.get_mut(&entry.ino).ok_or(Errno::EIO)? = Some(index);
        }
    }

    // Archive table: every lazy archive the image declares, with the total byte
    // length `ensure_archive_member` needs to bound its whole-archive fetch.
    ROOTFS.with(|state| {
        for (archive_id, archive_bytes, uri, digest, payload) in lazy_archives.drain(..) {
            state.archives.insert(
                archive_id,
                ArchiveEntry::new(archive_bytes, &uri, digest, &payload)?,
            );
        }
        Ok::<_, Errno>(())
    })?;

    // The unverified-setuid rule, applied once the image's description is complete
    // rather than when bytes arrive: a file with no digest is STREAMED, never
    // materialized, so a demotion on the materialize path would never fire for
    // exactly the files it is about. Doing it here also means `lstat` never
    // reports a set-ID bit the kernel would not honour.
    demote_unverifiable_setid();
    // AUTHENTICATE BEFORE THE IMAGE IS USABLE, not beside it.
    //
    // This ran only in `sm_load_image` -- the image MODULE's entry point -- so
    // a builder loading a base image authenticated its cohorts and a KERNEL
    // booting the same artifact did not. What stood in for it at boot was the
    // host restoring the whole `/` image into a SECOND filesystem and calling
    // `verifyImportedLazyAtomicGroupSeals` on that: up to a gigabyte
    // materialized, then dropped from the guest mounts unread, so that one
    // boundary could be checked.
    //
    // THIS READS THE PAYLOAD, which `runtime-core` otherwise treats as opaque,
    // and that is a deliberate reversal recorded with its reasoning. Carrying
    // a payload needs no knowledge of it; refusing an image whose cohorts do
    // not authenticate does. The alternative placements were measured and
    // rejected: giving the kernel the image MODULE pulls a three-thousand-line
    // builder into a shipped wasm for a verifier, and authenticating through
    // the bridge at boot loads `lamp.vfs` twice at 249 MiB each.
    //
    // Placed after `demote_unverifiable_setid` for the reason that runs where
    // it does: the image's description is complete here, and the archive
    // payloads this reads are the ones the walk has just recorded.
    //
    // `load_image` resets on any error, so a refusal leaves no half-mounted
    // tree for the next call to build on.
    crate::seal::verify_cohorts(&archive_payloads()?)?;

    Ok(count)
}

/// Drop set-user-ID and set-group-ID from every deferred file whose image
/// declared no digest.
///
/// A deferred setuid-root binary fetched by URL with its LENGTH as the only
/// check is bytes of the right size from wherever the host got them — a
/// substituting host, a poisoned cache, a network position — executing as root
/// inside the guest. Nothing in the image can say they are the right bytes, so
/// they do not get to be root.
///
/// Demoted rather than refused, which is what "not honoured" means: the file
/// still runs, as the calling user. Refusing would make every image that
/// predates digests unbootable, and the truthful statement is not "these bytes
/// are wrong" — it is that nothing here can tell you they are right.
///
/// A lazy-archive member is verifiable by its archive's digest as well as by
/// its own. `ensure_archive_member` is the only path to a member's bytes, and
/// it refuses (EIO) and never caches an archive that fails that digest, so a
/// member extracted from it is the bytes the image named. Counting only the
/// member's own digest stripped setgid from `/usr/bin/nethack`, whose archive
/// the kernel checks on every fetch.
fn demote_unverifiable_setid() {
    ROOTFS.with(|state| {
        let verified_archives: alloc::collections::BTreeSet<u32> = state
            .archives
            .iter()
            .filter(|(_, archive)| archive.digest != crate::sdef::DIGEST_NONE)
            .map(|(id, _)| *id)
            .collect();
        for slot in state.inodes.iter_mut() {
            let Some(inode) = slot.as_mut() else { continue };
            let (deferred, archive_verified) = match &inode.kind {
                InodeKind::LazyMember { archive_id, .. } => {
                    (true, verified_archives.contains(archive_id))
                }
                InodeKind::BaseRegular {
                    source: BaseSource::Host,
                    ..
                } => (inode.deferred_base, false),
                _ => (false, false),
            };
            if deferred
                && !archive_verified
                && inode.deferred_digest == crate::sdef::DIGEST_NONE
            {
                inode.demote_setid_unverified();
            }
        }
    });
}

/// [`set_base_times`] for a source that reports one millisecond timestamp, which
/// is what an KIFS inode carries. Split the same way the RTFS manifest producer
/// split it, so the two loaders agree to the nanosecond.
fn set_base_times_from_ms(path: &[u8], mtime_ms: u64) {
    let sec = mtime_ms / 1000;
    let nsec = ((mtime_ms % 1000) * 1_000_000) as u32;
    set_base_times(path, sec, nsec);
}

// ---------------------------------------------------------------------------
// Read-path operations.
// ---------------------------------------------------------------------------

/// lstat a canonical rootfs path. The final component is not followed (the
/// caller resolved symlinks per the syscall's FOLLOW policy already).
pub fn lstat(path: &[u8]) -> Result<WasmStat, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        Ok(state.get(idx).ok_or(Errno::ENOENT)?.stat())
    })
}

/// readlink a rootfs symlink.
pub fn readlink(path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
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

/// Open (optionally creating/truncating) a rootfs regular file. Returns the
/// encoded host handle; `open_count` is incremented here and released via
/// [`release_handle`]. Copy-on-write of a base file's *bytes* is deferred to the
/// first [`write`]; `O_TRUNC` needs no base bytes (it discards them), so it
/// converts a base file to an empty overlay file directly. Directories go
/// through [`opendir`].
pub fn open(path: &[u8], flags: u32, mode: u32, uid: u32, gid: u32) -> Result<i64, Errno> {
    if resizable_persistence_enabled() && flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
        let handle = open(path, flags & !O_TRUNC, mode, uid, gid)?;
        if let Err(error) = truncate_handle(handle, 0, |_, _| Err(Errno::EIO)) {
            release_handle(handle);
            return Err(error);
        }
        return Ok(handle);
    }
    let comps = split_components(path);
    if resizable_persistence_enabled() && flags & O_CREAT != 0 {
        let creation = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(&comps)?;
            if target.is_some() {
                return Ok::<_, Errno>(None);
            }
            if flags & O_DIRECTORY != 0 {
                return Err(Errno::ENOTDIR);
            }
            let name = last.ok_or(Errno::ENOENT)?.to_vec();
            let parent_ino = state.get(parent).ok_or(Errno::EIO)?.ino;
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let mut inode = Inode::new(
                InodeKind::PersistentRegular,
                mode & 0o1777,
                uid,
                gid,
                1,
                ino,
            );
            inode.persistent_size = Some(0);
            Ok(Some((parent, name, parent_ino, inode)))
        })?;
        if let Some((parent, name, parent_ino, inode)) = creation {
            let mutations = [
                Mutation::Put {
                    key: OverlayKey::Inode(inode.ino),
                    value: encode_persistent_inode(&inode)?,
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: parent_ino,
                        name: name.clone(),
                    },
                    value: inode.ino.to_le_bytes().to_vec(),
                },
            ];
            let mut allocated = commit_persistent_namespace(&mutations, &[(parent, NamespaceTimestamp::Modified)])?;
            return ROOTFS.with(|state| {
                state.bump_next_ino(inode.ino);
                let index = state.insert_prepared_inode(inode);
                allocated.insert_into(state, parent, &name, index)?;
                state.get_mut(index).ok_or(Errno::EIO)?.open_count = 1;
                state.persistent_allocated_blocks = Some(allocated.allocated);
                Ok(inode_to_file_handle(index))
            });
        }
    }
    let fixed_persistence = fixed_persistence_enabled();
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        let inode_idx = match target {
            Some(existing) => {
                if fixed_persistence && flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                    return Err(Errno::EROFS);
                }
                if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                    return Err(Errno::EEXIST);
                }
                let inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if matches!(inode.kind, InodeKind::Symlink(_)) {
                    // The caller resolves symlinks before open; a symlink reaching
                    // here means O_NOFOLLOW on the final component.
                    return Err(Errno::ELOOP);
                }
                if matches!(inode.kind, InodeKind::Special(_)) {
                    // A socket/FIFO node cannot be opened as a regular file; the
                    // fifo path is handled before rootfs::open is reached.
                    return Err(Errno::ENXIO);
                }
                if inode.is_dir() {
                    return Err(Errno::EISDIR);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
                    // A lazy-archive member truncates like anything else, and
                    // discarding its `(archive_id, source_path, size)` is the
                    // POINT rather than a loss: `O_TRUNC` means "this file is
                    // now empty", and what its bytes used to be backed by stops
                    // mattering the moment they stop existing.
                    //
                    // This used to be a deliberate `ENOSYS` guarding against
                    // "an empty writable file instead of the real content" --
                    // which is a description of truncation. It cost the derived
                    // image builders: replacing `/usr/bin/node` with eager
                    // bytes is a whole-file replace, and it failed `ENOSYS`.
                    //
                    // The case that genuinely needs the old bytes is a PARTIAL
                    // write, which does not set `O_TRUNC` and still reaches the
                    // materialization path that cannot serve them.
                    if let Some(node) = state.get_mut(existing) {
                        let shrank = match &node.kind {
                            InodeKind::Regular(d) => !d.is_empty(),
                            InodeKind::BaseRegular { size, .. } => *size > 0,
                            InodeKind::LazyMember { size, .. } => *size > 0,
                            _ => false,
                        };
                        node.kind = InodeKind::Regular(Vec::new());
                        if shrank {
                            node.clear_setid_on_modify();
                        }
                        node.touch_modified();
                    }
                }
                existing
            }
            None => {
                if fixed_persistence {
                    return Err(Errno::EROFS);
                }
                if flags & O_CREAT == 0 {
                    return Err(Errno::ENOENT);
                }
                if flags & O_DIRECTORY != 0 {
                    return Err(Errno::ENOTDIR);
                }
                let last = last.ok_or(Errno::ENOENT)?;
                let ino = state.alloc_ino();
                let new_idx = state.insert_inode(Inode::new(
                    InodeKind::Regular(Vec::new()),
                    mode & 0o7777,
                    uid,
                    gid,
                    1,
                    ino,
                ))?;
                state.link_unpublished_inode(parent, last, new_idx)?;
                new_idx
            }
        };
        // A directory opened without opendir is rejected so callers never treat a
        // dir handle as a file.
        if state.get(inode_idx).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        state.get_mut(inode_idx).ok_or(Errno::ENOENT)?.open_count += 1;
        Ok(inode_to_file_handle(inode_idx))
    }).map(|handle| {
        if flags & O_TRUNC != 0 && flags & O_ACCMODE != O_RDONLY {
            crate::kernel_file_mapping::notify_truncated(crate::ofd::FileType::Regular, handle, 0);
        }
        handle
    })
}

/// One raw-byte transport request dispatched through a single `byte_source`
/// closure. One closure rather than one per request kind: two closures each
/// capturing `&mut host` cannot both be live at one call site (borrow-checker
/// E0524), so the kernel captures `&mut host` exactly once and matches on this
/// enum to route to `HostIO::fetch_deferred` or `HostIO::image_read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteReq {
    /// Bytes of a deferred object, addressed by the URI its image recorded.
    ///
    /// One variant for what used to be two — a base file's blob and a lazy
    /// archive's raw bytes. They were never two things to the host: both are
    /// "fetch bytes for this resource at this offset", and they were split only
    /// because the kernel addressed them by two different id namespaces. Naming
    /// the resource by URI removes the namespaces and the distinction with
    /// them, along with the `kind` discriminator the host import carried.
    ///
    /// The URI is the image's own words, carried through unread. Whoever
    /// fetches decides whether it may be fetched.
    Deferred { uri: Vec<u8>, offset: u64 },
    /// Forget transport bytes rejected by native length or digest validation.
    /// This does not start a fetch; only a later explicit read may fetch again.
    DiscardDeferred { uri: Vec<u8> },
    /// A positioned read of the VFS image's own container bytes at `offset`.
    ///
    /// This is how the kernel parses its own `/` image ([`load_image`]) instead
    /// of being handed a host-walked manifest. It is a distinct variant rather
    /// than a reserved `blob_id` sentinel on purpose: `blob_id` means "the
    /// file's inode number" everywhere else, and making one opaque id mean two
    /// things would widen what every reader of it must understand while looking
    /// like no change. There is exactly one image per kernel, so the variant
    /// carries no id at all.
    Image { offset: u64 },
}

/// Bytes for a deferred resource, refusing one the image gave no address for.
///
/// The refusal lives HERE rather than in the host shim because this is the
/// layer that knows an image described a file and said nothing about where its
/// bytes are. Asking the host to fetch an empty string would turn that into a
/// transport error about a blank address, which describes the wrong thing.
///
/// `EIO`, never `EAGAIN`: the kernel parks and retries on `EAGAIN`, so a file
/// with no address would hang its reader forever instead of failing.
fn fetch_at<F>(
    byte_source: &mut F,
    uri: &[u8],
    offset: u64,
    buf: &mut [u8],
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if uri.is_empty() {
        return Err(Errno::EIO);
    }
    byte_source(
        ByteReq::Deferred {
            uri: uri.to_vec(),
            offset,
        },
        buf,
    )
}

struct ArchiveByteSource<'a, F> {
    archive: u32,
    size: u64,
    byte_source: core::cell::RefCell<&'a mut F>,
}

impl<F> crate::kandelo_image_fs::BlockSource for ArchiveByteSource<'_, F>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    fn len(&self) -> u64 { self.size }

    fn read_exact_at(&self, offset: u64, target: &mut [u8]) -> Result<(), Errno> {
        let mut plan = ROOTFS.with(|state| {
            let archive = state.archives.get(&self.archive).ok_or(Errno::ENOENT)?;
            Ok(VerifiedFileRead {
                key: self.archive as u64,
                size: archive.size,
                digest: archive.digest,
                source: VerifiedSource::Deferred(archive.uri.to_vec()),
                archive_source: true,
            })
        })?;
        if offset.checked_add(target.len() as u64).is_none_or(|end| end > plan.size) {
            return Err(Errno::EINVAL);
        }
        let mut byte_source = self.byte_source.try_borrow_mut().map_err(|_| Errno::EIO)?;
        let count = read_verified_plan(&mut plan, offset, target, &mut **byte_source)?;
        if count != target.len() { return Err(Errno::EIO); }
        Ok(())
    }
}

fn streamed_archive_entry<S: crate::kandelo_image_fs::BlockSource>(
    archive: u32,
    size: u64,
    path: &[u8],
    source: &S,
) -> Result<crate::zip::ZipEntry, Errno> {
    let cached = ROOTFS.with(|state| {
        state.archive_directories.iter().position(|(id, _)| *id == archive)
            .map(|index| state.archive_directories.remove(index).1)
    });
    let directory = match cached {
        Some(directory) => directory,
        None => crate::zip_stream::Directory::read(source, size)?,
    };
    let entry = directory.find_member(source, path);
    if entry.as_ref().is_err_and(|error| *error != Errno::ENOENT) { return entry; }
    let needed = directory.retained_bytes();
    if needed > crate::zip_stream::DIRECTORY_CACHE_BYTES { return Err(Errno::ENOMEM); }
    ROOTFS.with(|state| {
        while state.archive_directories.len() >= 64 || needed + state.archive_directories.iter()
            .map(|(_, directory)| directory.retained_bytes()).sum::<usize>() > crate::zip_stream::DIRECTORY_CACHE_BYTES
        {
            state.archive_directories.remove(0);
        }
        state.archive_directories.try_reserve_exact(1).map_err(|_| Errno::ENOMEM)?;
        state.archive_directories.push((archive, directory));
        Ok::<_, Errno>(())
    })?;
    entry
}

fn read_streamed_archive_member<F>(
    archive: u32,
    path: &[u8],
    expected_size: u64,
    offset: u64,
    target: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let (size, cached) = ROOTFS.with(|state| {
        let size = state.archives.get(&archive).ok_or(Errno::ENOENT)?.size;
        let capacity = 2usize.saturating_sub(state.archive_readers.len());
        state.archive_readers.try_reserve_exact(capacity).map_err(|_| Errno::ENOMEM)?;
        let cached = state.archive_readers.iter().position(|(id, reader)| *id == archive && reader.entry.name == path)
            .map(|index| state.archive_readers.remove(index).1);
        Ok((size, cached))
    })?;
    let source = ArchiveByteSource { archive, size, byte_source: core::cell::RefCell::new(byte_source) };
    let mut reader = match cached {
        Some(reader) => reader,
        None => {
            let entry = streamed_archive_entry(archive, size, path, &source)?;
            crate::zip_stream::MemberReader::new(&source, size, entry)?
        }
    };
    if reader.entry.uncompressed_size as u64 != expected_size { return Err(Errno::EIO); }
    let count = reader.read_at(&source, offset, target)?;
    ROOTFS.with(|state| {
        if state.archive_readers.len() == 2 { state.archive_readers.remove(0); }
        state.archive_readers.push((archive, reader));
    });
    Ok(count)
}

/// Whole-archive fetch and member inflation for ephemeral read/copy-on-write.
/// Persistent reads use the separately bounded positioned archive path.
/// Fetch/decode runs outside the store lock; partial or rejected fetches are
/// not cached. These ephemeral buffers remain live until reset or rejection.
fn ensure_archive_member<F>(
    archive_id: u32,
    source_path: &[u8],
    byte_source: &mut F,
) -> Result<Arc<Vec<u8>>, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    enum Plan {
        /// Already inflated and cached: return this clone directly.
        Member(Arc<Vec<u8>>),
        /// Not yet inflated; `raw_present` says whether the whole-archive
        /// fetch has already happened for a previous member.
        NeedRaw { size: u64, raw_present: bool },
    }
    let plan = ROOTFS.with(|state| {
        let entry = state.archives.get(&archive_id).ok_or(Errno::ENOENT)?;
        if let Some(bytes) = entry.members.get(source_path) {
            return Ok(Plan::Member(bytes.clone()));
        }
        Ok(Plan::NeedRaw {
            size: entry.size,
            raw_present: entry.raw.is_some(),
        })
    })?;
    let (size, raw_present) = match plan {
        Plan::Member(bytes) => return Ok(bytes),
        Plan::NeedRaw { size, raw_present } => (size, raw_present),
    };
    // The archive's address and expected digest, read together so they cannot
    // describe different archives. An archive with no address cannot be
    // fetched at all, and saying so here beats asking the host to resolve an
    // empty string.
    let (uri, expected) = ROOTFS
        .with(|state| {
            state
                .archives
                .get(&archive_id)
                .map(|entry| (entry.uri.clone(), entry.digest))
        })
        .ok_or(Errno::ENOENT)?;

    if !raw_present {
        let mut data = Vec::new();
        grow_file_bytes(&mut data, usize::try_from(size).map_err(|_| Errno::ENOMEM)?, Errno::ENOMEM)?;
        let mut filled = 0usize;
        while filled < data.len() {
            let n = fetch_at(byte_source, &uri, filled as u64, &mut data[filled..])?;
            if n == 0 {
                break; // short read: trust the manifest size but never spin
            }
            filled += n;
        }
        data.truncate(filled);
        // Check BEFORE anything is stored, and drop the buffer on a mismatch.
        // Bytes that fail their digest are not "bytes we should retry parsing"
        // — they are bytes we were not supposed to receive — so caching them
        // would make one bad fetch permanent for the life of the kernel, and
        // every later member of this archive would be extracted from it.
        // Dropping them restarts the fetch from scratch on the next touch,
        // which is the same idempotent restart a short read already gets.
        //
        // A short read lands here too: `filled < size` cannot hash to a digest
        // taken over the whole archive, so a truncated fetch stops being a
        // silently truncated archive and becomes EIO.
        if filled as u64 != size || !crate::sdef::digest_accepts(&expected, &data) {
            ROOTFS.with(|state| state.invalidate_verified_uri(&uri));
            let _ = byte_source(ByteReq::DiscardDeferred { uri }, &mut []);
            return Err(Errno::EIO);
        }
        ROOTFS.with(|state| {
            if let Some(entry) = state.archives.get_mut(&archive_id) {
                // Re-check: another touch of this archive may have already
                // stored `raw` (no reentrancy in the single-threaded kernel,
                // but keep the store the source of truth).
                if entry.raw.is_none() {
                    entry.raw = Some(Arc::new(data));
                }
            }
        });
    }

    // Clone the now-cached raw archive bytes out to decode outside the lock.
    let raw = ROOTFS
        .with(|state| state.archives.get(&archive_id).and_then(|e| e.raw.clone()))
        .ok_or(Errno::ENOENT)?;

    let cached_directory =
        ROOTFS.with(|state| state.archives.get(&archive_id).and_then(|e| e.directory.clone()));
    let directory = match cached_directory {
        Some(d) => d,
        None => {
            let parsed = Arc::new(crate::zip::read_central_directory(&raw)?);
            ROOTFS.with(|state| {
                if let Some(entry) = state.archives.get_mut(&archive_id) {
                    if entry.directory.is_none() {
                        entry.directory = Some(parsed.clone());
                    }
                }
            });
            parsed
        }
    };

    let zip_entry = directory
        .iter()
        .find(|e| e.name == source_path)
        .ok_or(Errno::ENOENT)?;
    let bytes = Arc::new(crate::zip::extract(&raw, zip_entry)?);

    ROOTFS.with(|state| {
        if let Some(entry) = state.archives.get_mut(&archive_id) {
            entry
                .members
                .entry(source_path.to_vec())
                .or_insert_with(|| bytes.clone());
        }
    });

    Ok(bytes)
}

/// Materialize a base file's or lazy-archive member's bytes into a Rust-owned
/// overlay buffer (copy-on-write) if it has not been materialized yet. The
/// `byte_source` call (host byte read, or archive fetch + decode) runs
/// outside the store lock. A no-op for an already-overlay (`Regular`) file.
fn ensure_materialized<F>(idx: u32, byte_source: &mut F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    enum Base {
        None,
        BaseRegular(u64),
        ImageRegular(u32, u64),
        LazyMember(u32, Vec<u8>),
    }
    // Read under the same lock as the kind, so the address and digest cannot
    // belong to a different inode than the bytes about to be fetched for it.
    let (uri, expected) = ROOTFS
        .with(|state| {
            state
                .get(idx)
                .map(|inode| (inode.deferred_uri.to_vec(), inode.deferred_digest))
        })
        .unwrap_or_default();
    let base = ROOTFS.with(|state| match state.get(idx) {
        Some(inode) => match &inode.kind {
            InodeKind::BaseRegular {
                blob_id,
                size,
                source,
            } => match source {
                BaseSource::Image => Ok(Base::ImageRegular(image_ino(*blob_id)?, *size)),
                BaseSource::Host => Ok(Base::BaseRegular(*size)),
            },
            InodeKind::Regular(_) | InodeKind::PersistentRegular => Ok(Base::None),
            InodeKind::Dir(_) => Err(Errno::EISDIR),
            InodeKind::Symlink(_) => Err(Errno::EINVAL),
            InodeKind::Special(_) => Err(Errno::EINVAL),
            InodeKind::LazyMember {
                archive_id,
                source_path,
                ..
            } => Ok(Base::LazyMember(*archive_id, source_path.to_vec())),
        },
        None => Err(Errno::EBADF),
    })?;
    match base {
        Base::None => Ok(()),
        Base::BaseRegular(size) => {
            let mut data = Vec::new();
            grow_file_bytes(&mut data, usize::try_from(size).map_err(|_| Errno::ENOMEM)?, Errno::ENOMEM)?;
            let mut filled = 0usize;
            while filled < data.len() {
                let n = fetch_at(byte_source, &uri, filled as u64, &mut data[filled..])?;
                if n == 0 {
                    break; // short read: trust the manifest size but never spin
                }
                filled += n;
            }
            data.truncate(filled);
            // The bytes a standalone deferred file's URI served. Checked here,
            // before they become this inode's contents, for the same reason the
            // archive's are: accepting them stores them, and a stored wrong
            // answer is indistinguishable from a right one afterwards.
            if filled as u64 != size || !crate::sdef::digest_accepts(&expected, &data) {
                ROOTFS.with(|state| state.invalidate_verified_uri(&uri));
                let _ = byte_source(ByteReq::DiscardDeferred { uri }, &mut []);
                return Err(Errno::EIO);
            }
            ROOTFS.with(|state| {
                state.persistent_allocated_blocks = None;
                if let Some(inode) = state.get_mut(idx) {
                    // Re-check: only convert if still a base file (no
                    // reentrancy in the single-threaded kernel, but keep the
                    // store the source of truth).
                    if matches!(inode.kind, InodeKind::BaseRegular { .. }) {
                        inode.kind = InodeKind::Regular(data);
                    }
                }
            });
            Ok(())
        }
        Base::ImageRegular(ino, size) => {
            let mut data = Vec::new();
            grow_file_bytes(&mut data, usize::try_from(size).map_err(|_| Errno::ENOMEM)?, Errno::ENOMEM)?;
            let mut filled = 0usize;
            while filled < data.len() {
                let n = read_image_bytes(ino, filled as u64, &mut data[filled..], byte_source)?;
                if n == 0 {
                    break; // short read: trust the image's size but never spin
                }
                filled += n;
            }
            data.truncate(filled);
            ROOTFS.with(|state| {
                state.persistent_allocated_blocks = None;
                if let Some(inode) = state.get_mut(idx) {
                    if matches!(inode.kind, InodeKind::BaseRegular { .. }) {
                        inode.kind = InodeKind::Regular(data);
                    }
                }
            });
            Ok(())
        }
        Base::LazyMember(archive_id, source_path) => {
            let bytes = ensure_archive_member(archive_id, &source_path, byte_source)?;
            // The member's own digest covers the INFLATED bytes, which the
            // archive's cannot: that one covers the archive, and an archive
            // that hashes correctly can still be unpacked wrongly — a zip entry
            // naming the wrong offsets, a decompressor disagreeing with the one
            // that packed it. Checked here rather than in
            // `ensure_archive_member`, because that function also serves
            // callers with no inode to take a digest from.
            if !crate::sdef::digest_accepts(&expected, &bytes) {
                return Err(Errno::EIO);
            }
            ROOTFS.with(|state| {
                state.persistent_allocated_blocks = None;
                if let Some(inode) = state.get_mut(idx) {
                    // Re-check: only convert if still a lazy member.
                    if matches!(inode.kind, InodeKind::LazyMember { .. }) {
                        inode.kind = InodeKind::Regular(bytes.as_ref().clone());
                    }
                }
            });
            Ok(())
        }
    }
}

/// Write `buf` at `offset`, copying a base file into the overlay first, then
/// growing (zero-filling any gap) as needed.
pub fn write<F>(handle: i64, offset: i64, buf: &[u8], mut byte_source: F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    if fixed_persistence_enabled() {
        if declares_digest(idx) {
            return Err(Errno::EROFS);
        }
        let resizable = resizable_persistence_enabled();
        let (ino, image_ino, base_size) = ROOTFS.with(|state| {
            let inode = state.get(idx).ok_or(Errno::EBADF)?;
            match inode.kind {
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source: BaseSource::Image,
                } if inode.mode & 0o6000 == 0 => Ok((inode.ino, Some(image_ino(blob_id)?), size)),
                InodeKind::PersistentRegular if resizable => Ok((inode.ino, None, 0)),
                _ => Err(Errno::EROFS),
            }
        })?;
        let buf = if resizable && !buf.is_empty() {
            let remaining = crate::kandelo_image_write::MAX_FILE_BYTES
                .checked_sub(offset as u64)
                .filter(|remaining| *remaining != 0)
                .ok_or(Errno::EFBIG)?;
            &buf[..core::cmp::min(buf.len() as u64, remaining) as usize]
        } else {
            buf
        };
        let end = (offset as u64)
            .checked_add(buf.len() as u64)
            .ok_or(Errno::EFBIG)?;
        if resizable && end > i64::MAX as u64 {
            return Err(Errno::EFBIG);
        }
        if !resizable && end > base_size {
            return Err(Errno::EFBIG);
        }
        if resizable && !buf.is_empty() {
            reserve_persistent_timestamp_slot(idx)?;
        }
        return write_persistent_file(idx, ino, image_ino, base_size, resizable,
            offset as u64, buf, &mut byte_source);
    }
    let start = usize::try_from(offset).map_err(|_| Errno::EFBIG)?;
    let end = start.checked_add(buf.len()).ok_or(Errno::EFBIG)?;
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        {
            let InodeKind::Regular(data) = &mut inode.kind else {
                return Err(Errno::EISDIR);
            };
            if end > data.len() {
                grow_file_bytes(data, end, Errno::ENOSPC)?;
            }
            data[start..end].copy_from_slice(buf);
        }
        if !buf.is_empty() {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(buf.len())
    })
}

/// Grow a regular file's bytes to `new_len`, zero-filling, or report `err`
/// when kernel memory cannot hold them.
///
/// The filesystem lives in the kernel's linear memory, which has a fixed
/// ceiling (`kernelMaxPages` on the host). A plain `Vec::resize` past that
/// ceiling aborts the kernel and takes every process in the machine with it;
/// a full filesystem must instead fail the one call that filled it, as it does
/// on any other system. `try_reserve` keeps `Vec`'s amortized growth, so a
/// stream of appends stays linear.
fn grow_file_bytes(data: &mut Vec<u8>, new_len: usize, err: Errno) -> Result<(), Errno> {
    if new_len > data.len() {
        data.try_reserve(new_len - data.len()).map_err(|_| err)?;
    }
    data.resize(new_len, 0);
    Ok(())
}

struct PersistentWriteSpace {
    bytes: usize,
    block_costs: [u64; crate::persistent_overlay::CACHE_BLOCKS],
}

fn pointer_allocation_ranges(block: u64) -> Result<[Option<(u64, u64)>; 3], Errno> {
    const SINGLE: u64 = 10;
    const DOUBLE: u64 = SINGLE + 1024;
    const TRIPLE: u64 = DOUBLE + 1024 * 1024;
    const END: u64 = TRIPLE + 1024 * 1024 * 1024;
    if block < SINGLE {
        Ok([None; 3])
    } else if block < DOUBLE {
        Ok([Some((SINGLE, DOUBLE)), None, None])
    } else if block < TRIPLE {
        let leaf = DOUBLE + (block - DOUBLE) / 1024 * 1024;
        Ok([Some((DOUBLE, TRIPLE)), Some((leaf, leaf + 1024)), None])
    } else if block < END {
        let middle = TRIPLE + (block - TRIPLE) / (1024 * 1024) * (1024 * 1024);
        let leaf = TRIPLE + (block - TRIPLE) / 1024 * 1024;
        Ok([
            Some((TRIPLE, END)),
            Some((middle, middle + 1024 * 1024)),
            Some((leaf, leaf + 1024)),
        ])
    } else {
        Err(Errno::EFBIG)
    }
}

fn visit_composed_inode_allocations<F>(
    journal: &mut PersistentJournal,
    inode: &Inode,
    geometry: Option<ImageGeometry>,
    base_size: u64,
    size: u64,
    range: core::ops::Range<u64>,
    byte_source: &mut F,
    visit: impl FnMut(u32) -> Result<bool, Errno>,
) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    match inode.kind {
        InodeKind::BaseRegular { blob_id, source: BaseSource::Image, .. } if !inode.base_dense => {
            with_image_file_allocations(
                geometry.ok_or(Errno::EIO)?, image_ino(blob_id)?, range.clone(), byte_source,
                |next_base| journal.visit_composed_file_blocks_from(
                    inode.ino, base_size, size, range, next_base, visit,
                ),
            )
        }
        InodeKind::BaseRegular { source: BaseSource::Image, .. } | InodeKind::PersistentRegular => {
            let mut next = range.start;
            journal.visit_composed_file_blocks_from(inode.ino, base_size, size, range,
                || {
                    let block = u32::try_from(next).map_err(|_| Errno::EFBIG)?;
                    next += 1;
                    Ok(Some(block))
                }, visit)
        }
        _ => Err(Errno::EIO),
    }
}

fn composed_inode_block_count<F>(
    journal: &mut PersistentJournal,
    inode: &Inode,
    geometry: Option<ImageGeometry>,
    base_size: u64,
    size: u64,
    byte_source: &mut F,
) -> Result<u64, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let mut counter = SparseFileBlockCounter::default();
    visit_composed_inode_allocations(journal, inode, geometry, base_size, size,
        0..size.div_ceil(4096), byte_source, |block| { counter.push(block); Ok(true) })?;
    Ok(counter.total())
}

fn first_composed_file_allocation<F>(
    journal: &mut PersistentJournal,
    inode: &Inode,
    geometry: Option<ImageGeometry>,
    base_size: u64,
    range: core::ops::Range<u64>,
    byte_source: &mut F,
) -> Result<Option<u32>, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let size = inode.persistent_size.unwrap_or(base_size);
    let mut first = None;
    visit_composed_inode_allocations(journal, inode, geometry, base_size, size, range,
        byte_source, |block| { first = Some(block); Ok(false) })?;
    Ok(first)
}

fn plan_persistent_write<F>(
    journal: &mut PersistentJournal,
    inode: &Inode,
    geometry: Option<ImageGeometry>,
    base_size: u64,
    offset: u64,
    length: usize,
    free_blocks: u64,
    byte_source: &mut F,
) -> Result<PersistentWriteSpace, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    const BLOCK: u64 = crate::persistent_overlay::FILE_BLOCK_BYTES as u64;
    let end = offset.checked_add(length as u64).ok_or(Errno::EFBIG)?;
    let first = offset / BLOCK;
    let limit = end.div_ceil(BLOCK);
    if length == 0 || limit - first > crate::persistent_overlay::CACHE_BLOCKS as u64 {
        return Err(Errno::EINVAL);
    }
    let mut groups = [(0u64, 0u64); 8];
    let mut group_count = 0;
    let mut charged = 0;
    let mut plan = PersistentWriteSpace {
        bytes: 0,
        block_costs: [0; crate::persistent_overlay::CACHE_BLOCKS],
    };
    for block in first..limit {
        let mut additional = 0;
        if first_composed_file_allocation(
            journal, inode, geometry, base_size, block..block + 1, byte_source,
        )?
            .is_none()
        {
            additional = 1;
            for range in pointer_allocation_ranges(block)?.into_iter().flatten() {
                if groups[..group_count].contains(&range) {
                    continue;
                }
                *groups.get_mut(group_count).ok_or(Errno::EIO)? = range;
                group_count += 1;
                if first_composed_file_allocation(
                        journal,
                        inode,
                        geometry,
                        base_size,
                        range.0..range.1,
                        byte_source,
                    )?
                    .is_none()
                {
                    additional += 1;
                }
            }
        }
        if charged + additional > free_blocks {
            if plan.bytes == 0 {
                return Err(Errno::ENOSPC);
            }
            break;
        }
        charged += additional;
        inode.allocated_blocks.checked_add(charged).ok_or(Errno::EIO)?;
        plan.block_costs[(block - first) as usize] = charged;
        plan.bytes = ((block + 1) * BLOCK).min(end).saturating_sub(offset) as usize;
    }
    Ok(plan)
}

fn write_persistent_file<F>(
    index: u32,
    ino: u64,
    image_ino: Option<u32>,
    base_size: u64,
    resizable: bool,
    offset: u64,
    bytes: &[u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    const BLOCK: usize = crate::persistent_overlay::FILE_BLOCK_BYTES;
    let (used, limit) = crate::io_buffer::IO_MEMORY.usage();
    if !bytes.is_empty() && used >= limit.div_ceil(2) { reclaim_io_read_caches(None); }
    let mut free_blocks = if bytes.is_empty() {
        0
    } else {
        persistent_statfs()?.f_bfree
    };
    let mut active = PERSISTENT_ROOTFS.lock();
    let journal = &mut active.as_mut().ok_or(Errno::EIO)?.journal;
    if bytes.is_empty() {
        return journal
            .write_file_at_buffered(ino, base_size, offset, bytes, |_, _| Err(Errno::EIO));
    }
    let mut done = 0;
    let mut failure = None;
    let mut image_read = ImageReadCursor::new();
    while done < bytes.len() {
        let position = offset + done as u64;
        let within = (position % BLOCK as u64) as usize;
        let count =
            (bytes.len() - done).min(crate::persistent_overlay::CACHE_BLOCKS * BLOCK - within);
        let planned = ROOTFS.with(|state| {
            plan_persistent_write(
                journal,
                state.get(index).ok_or(Errno::EBADF)?,
                state.image,
                base_size,
                position,
                count,
                free_blocks,
                byte_source,
            )
        });
        let plan = match planned {
            Ok(plan) => plan,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        let mut read_base = |at, target: &mut [u8]| match image_ino {
            Some(image_ino) => image_read.read(image_ino, at, target, &mut *byte_source),
            None => Err(Errno::EIO),
        };
        let written = if resizable {
            journal.write_file_at_buffered(
                ino,
                base_size,
                position,
                &bytes[done..done + plan.bytes],
                &mut read_base,
            )
        } else {
            journal.write_fixed_file_at_buffered(
                ino,
                base_size,
                position,
                &bytes[done..done + plan.bytes],
                &mut read_base,
            )
        };
        let written = match written {
            Ok(written) if written != 0 && written <= plan.bytes => written,
            Ok(_) => {
                failure = Some(Errno::EIO);
                break;
            }
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        let charge = plan.block_costs[(within + written - 1) / BLOCK];
        ROOTFS.with(|state| {
            if let Some(inode) = state.get_mut(index) {
                inode.allocated_blocks += charge;
                if resizable {
                    inode.persistent_size = Some(
                        inode
                            .persistent_size
                            .unwrap_or(base_size)
                            .max(position + written as u64),
                    );
                }
            }
            state.persistent_allocated_blocks = state
                .persistent_allocated_blocks
                .and_then(|total| total.checked_add(charge));
        });
        free_blocks -= charge;
        done += written;
        if written < plan.bytes {
            break;
        }
    }
    if done != 0 {
        ROOTFS.with(|state| {
            if let Some(inode) = state.get_mut(index) {
                inode.clear_setid_on_modify();
                inode.touch_modified();
                if resizable {
                    state.dirty_persistent_timestamps.insert(index);
                }
            }
        });
        Ok(done)
    } else {
        Err(failure.unwrap_or(Errno::EIO))
    }
}

/// Truncate an open rootfs regular file to `length`, zero-filling any growth.
/// Truncating to 0 needs no base bytes (a `LazyMember` truncated to 0 needs no
/// archive fetch either); a non-zero truncate copies the base file or lazy-
/// archive member into the overlay first. The caller enforces access mode and
/// RLIMIT_FSIZE.
pub fn truncate_handle<F>(handle: i64, length: i64, byte_source: F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    truncate_handle_inner(handle, length, byte_source)?;
    crate::kernel_file_mapping::notify_truncated(crate::ofd::FileType::Regular, handle, length as u64);
    Ok(())
}

fn truncate_handle_inner<F>(handle: i64, length: i64, mut byte_source: F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if fixed_persistence_enabled() {
        if !resizable_persistence_enabled() || declares_digest(idx) {
            return Err(Errno::EROFS);
        }
        let new_size = u64::try_from(length).map_err(|_| Errno::EINVAL)?;
        if new_size > crate::kandelo_image_write::MAX_FILE_BYTES {
            return Err(Errno::EFBIG);
        }
        let (ino, image_ino, base_size, old_size, base_tail_allocated) = ROOTFS.with(|state| {
            let inode = state.get(idx).ok_or(Errno::EBADF)?;
            match inode.kind {
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source: BaseSource::Image,
                } if inode.mode & 0o6000 == 0 => Ok((
                    inode.ino,
                    Some(image_ino(blob_id)?),
                    size,
                    inode.persistent_size.unwrap_or(size),
                    inode.base_dense,
                )),
                InodeKind::PersistentRegular => Ok((
                    inode.ino,
                    None,
                    0,
                    inode.persistent_size.unwrap_or(0),
                    false,
                )),
                _ => Err(Errno::EROFS),
            }
        })?;
        let base_tail_allocated = if let Some(image_ino) = image_ino.filter(|_| {
            !base_tail_allocated && new_size < old_size && new_size < base_size && new_size % 4096 != 0
        }) {
            let geometry = ROOTFS.with(|state| state.image).ok_or(Errno::EIO)?;
            let block = new_size / 4096;
            with_image_file_allocations(geometry, image_ino, block..block + 1, &mut byte_source,
                |next_base| Ok(next_base()?.is_some()))?
        } else {
            base_tail_allocated
        };
        let allocated_blocks = if new_size >= old_size {
            ROOTFS.with(|state| state.get(idx).map(|inode| inode.allocated_blocks)).ok_or(Errno::EBADF)?
        } else {
            let mut active = PERSISTENT_ROOTFS.lock();
            let journal = &mut active.as_mut().ok_or(Errno::EIO)?.journal;
            ROOTFS.with(|state| composed_inode_block_count(journal,
                state.get(idx).ok_or(Errno::EBADF)?, state.image, base_size, new_size, &mut byte_source))?
        };
        reserve_persistent_timestamp_slot(idx)?;
        PERSISTENT_ROOTFS
            .lock()
            .as_mut()
            .ok_or(Errno::EIO)?
            .journal
            .truncate_file_at_with_base_tail(ino, base_size, new_size, base_tail_allocated, |at, dst| {
                match image_ino {
                    Some(image_ino) => read_image_bytes(image_ino, at, dst, &mut byte_source),
                    None => Err(Errno::EIO),
                }
            })?;
        ROOTFS.with(|state| {
            state.persistent_allocated_blocks = None;
            let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
            inode.persistent_size = Some(new_size);
            inode.allocated_blocks = allocated_blocks;
            if new_size != old_size {
                inode.clear_setid_on_modify();
            }
            inode.touch_modified();
            state.dirty_persistent_timestamps.insert(idx);
            Ok(())
        })?;
        return Ok(());
    }
    let new_len = usize::try_from(length).map_err(|_| Errno::EINVAL)?;
    if new_len == 0 {
        return ROOTFS.with(|state| {
            let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
            let shrank = match &inode.kind {
                InodeKind::Regular(d) => !d.is_empty(),
                InodeKind::BaseRegular { size, .. } => *size > 0,
                InodeKind::LazyMember { size, .. } => *size > 0,
                // Dir/Symlink/Special fall through to EISDIR.
                _ => return Err(Errno::EISDIR),
            };
            inode.kind = InodeKind::Regular(Vec::new());
            if shrank {
                inode.clear_setid_on_modify();
            }
            inode.touch_modified();
            Ok(())
        });
    }
    ensure_materialized(idx, &mut byte_source)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        let changed = match &mut inode.kind {
            InodeKind::Regular(data) => {
                let old_len = data.len();
                // EFBIG, not ENOSPC: it is the error POSIX gives ftruncate()
                // for a length the file cannot take.
                grow_file_bytes(data, new_len, Errno::EFBIG)?;
                old_len != new_len
            }
            _ => return Err(Errno::EISDIR),
        };
        if changed {
            inode.clear_setid_on_modify();
        }
        inode.touch_modified();
        Ok(())
    })
}

enum VerifiedSource {
    Image(u32),
    Deferred(Vec<u8>),
    Archive(u32, Vec<u8>),
}

struct VerifiedFileRead {
    key: u64,
    size: u64,
    digest: [u8; 32],
    source: VerifiedSource,
    archive_source: bool,
}

impl RootfsState {
    fn read_cache(&mut self, plan: &VerifiedFileRead) -> &mut crate::verified_read_cache::VerifiedReadCache {
        if plan.archive_source { &mut self.archive_verified_reads } else { &mut self.verified_reads }
    }
}

fn verified_file_read(index: u32) -> Result<Option<VerifiedFileRead>, Errno> {
    ROOTFS.with(|state| {
        let inode = state.get(index).ok_or(Errno::EBADF)?;
        let source = match &inode.kind {
            InodeKind::BaseRegular { blob_id, source: BaseSource::Image, .. } => {
                VerifiedSource::Image(image_ino(*blob_id)?)
            }
            InodeKind::BaseRegular { source: BaseSource::Host, .. } => {
                VerifiedSource::Deferred(inode.deferred_uri.to_vec())
            }
            InodeKind::LazyMember { archive_id, source_path, .. } => {
                VerifiedSource::Archive(*archive_id, source_path.to_vec())
            }
            _ => return Ok(None),
        };
        Ok(Some(VerifiedFileRead {
            key: inode.ino,
            size: inode.stat().st_size,
            digest: inode.deferred_digest,
            source,
            archive_source: false,
        }))
    })
}

fn prepare_verified_source<F>(plan: &mut VerifiedFileRead, byte_source: &mut F) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if let VerifiedSource::Archive(archive, path) = &plan.source {
        read_streamed_archive_member(*archive, path, plan.size, 0, &mut [], byte_source)?;
    }
    Ok(())
}

fn read_verified_source<F>(
    plan: &VerifiedFileRead,
    offset: u64,
    target: &mut [u8],
    byte_source: &mut F,
) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let mut done = 0;
    while done < target.len() {
        let position = offset.checked_add(done as u64).ok_or(Errno::EOVERFLOW)?;
        let destination = &mut target[done..];
        let count = match &plan.source {
            VerifiedSource::Image(inode) => {
                read_image_bytes(*inode, position, destination, &mut *byte_source)?
            }
            VerifiedSource::Deferred(uri) => {
                fetch_at(&mut *byte_source, uri, position, destination)?
            }
            VerifiedSource::Archive(archive, path) => {
                read_streamed_archive_member(*archive, path, plan.size, position, destination, byte_source)?
            }
        };
        if count == 0 || count > destination.len() {
            return Err(Errno::EIO);
        }
        done += count;
    }
    Ok(())
}

fn invalidate_verified_read<F>(plan: &VerifiedFileRead, byte_source: &mut F)
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    ROOTFS.with(|state| state.read_cache(plan).invalidate(plan.key));
    let uri = match &plan.source {
        VerifiedSource::Deferred(uri) => Some(uri.clone()),
        VerifiedSource::Archive(archive_id, _) => ROOTFS.with(|state| {
            state.archives.get(archive_id).map(|archive| archive.uri.to_vec())
        }),
        _ => None,
    };
    if let Some(uri) = uri {
        ROOTFS.with(|state| state.invalidate_verified_uri(&uri));
        let _ = byte_source(ByteReq::DiscardDeferred { uri }, &mut []);
    }
}

fn reclaim_io_read_caches(keep: Option<(bool, u64)>) {
    ROOTFS.with(|state| {
        state.verified_reads.retain_file(keep.filter(|(archive, _)| !archive).map(|(_, key)| key));
        state.archive_verified_reads.retain_file(keep.filter(|(archive, _)| *archive).map(|(_, key)| key));
    });
    crate::rootfs_image::discard_read_caches();
    if let Some(mut active) = PERSISTENT_ROOTFS.try_lock() {
        if let Some(mount) = active.as_mut() { mount.journal.discard_read_caches(); }
    }
}

fn allocate_verified_chunk(plan: &VerifiedFileRead, length: usize) -> Result<crate::io_buffer::IoBuffer<u8>, Errno> {
    let result = ROOTFS.with(|state| state.read_cache(plan).allocate_chunk(plan.key, length));
    if matches!(result, Err(Errno::ENOMEM)) {
        reclaim_io_read_caches(Some((plan.archive_source, plan.key)));
        return ROOTFS.with(|state| state.read_cache(plan).allocate_chunk(plan.key, length));
    }
    result
}

fn index_verified_read<F>(plan: &VerifiedFileRead, byte_source: &mut F) -> Result<bool, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let Some(mut hashes) = ROOTFS.with(|state| state.read_cache(plan).prepare(plan.key, plan.size))? else {
        return Ok(false);
    };
    let mut scratch = allocate_verified_chunk(plan, crate::verified_read_cache::CHUNK_BYTES)?;
    let mut hasher = Sha256::new();
    let mut offset = 0;
    while offset < plan.size {
        let count = (plan.size - offset).min(scratch.len() as u64) as usize;
        if let Err(error) = read_verified_source(plan, offset, &mut scratch[..count], byte_source) {
            if error != Errno::EAGAIN {
                invalidate_verified_read(plan, byte_source);
            }
            return Err(error);
        }
        hasher.update(&scratch[..count]);
        hashes.push(Sha256::digest(&scratch[..count]).into());
        offset += count as u64;
    }
    if plan.digest != crate::sdef::DIGEST_NONE && hasher.finalize()[..] != plan.digest {
        invalidate_verified_read(plan, byte_source);
        return Err(Errno::EIO);
    }
    ROOTFS.with(|state| state.read_cache(plan).install(plan.key, plan.digest, plan.size, hashes))?;
    Ok(true)
}

fn read_unindexed_verified_window<F>(
    plan: &VerifiedFileRead,
    offset: u64,
    target: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let count = (target.len().min(crate::verified_read_cache::CHUNK_BYTES) as u64)
        .min(plan.size - offset) as usize;
    let mut output = allocate_verified_chunk(plan, count)?;
    let mut scratch = allocate_verified_chunk(plan, crate::verified_read_cache::CHUNK_BYTES)?;
    let mut hasher = Sha256::new();
    let mut position = 0;
    while position < plan.size {
        let length = (plan.size - position).min(scratch.len() as u64) as usize;
        if let Err(error) = read_verified_source(plan, position, &mut scratch[..length], byte_source) {
            if error != Errno::EAGAIN {
                invalidate_verified_read(plan, byte_source);
            }
            return Err(error);
        }
        hasher.update(&scratch[..length]);
        let start = position.max(offset);
        let end = (position + length as u64).min(offset + count as u64);
        if start < end {
            output[(start - offset) as usize..(end - offset) as usize]
                .copy_from_slice(&scratch[(start - position) as usize..(end - position) as usize]);
        }
        position += length as u64;
    }
    if plan.digest != crate::sdef::DIGEST_NONE && hasher.finalize()[..] != plan.digest {
        invalidate_verified_read(plan, byte_source);
        return Err(Errno::EIO);
    }
    target[..count].copy_from_slice(&output);
    Ok(count)
}

fn read_verified_file<F>(
    index: u32,
    offset: u64,
    target: &mut [u8],
    byte_source: &mut F,
) -> Result<Option<usize>, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let Some(mut plan) = verified_file_read(index)? else {
        return Ok(None);
    };
    read_verified_plan(&mut plan, offset, target, byte_source).map(Some)
}

fn read_verified_plan<F>(
    plan: &mut VerifiedFileRead,
    offset: u64,
    target: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if offset >= plan.size || target.is_empty() {
        return Ok(0);
    }
    let length = target.len().min(usize::try_from(plan.size - offset).unwrap_or(usize::MAX));
    let mut ready = false;
    let mut done = 0;
    while done < length {
        let position = offset + done as u64;
        if let Some(count) = ROOTFS.with(|state| {
            state.read_cache(plan).copy_at(plan.key, plan.digest, plan.size, position, &mut target[done..length])
        }) {
            if count == 0 {
                return Err(Errno::EIO);
            }
            done += count;
            continue;
        }
        if !ready {
            prepare_verified_source(plan, byte_source)?;
            ready = true;
        }
        let chunk = usize::try_from(position / crate::verified_read_cache::CHUNK_BYTES as u64)
            .map_err(|_| Errno::EIO)?;
        if ROOTFS.with(|state| state.read_cache(plan).chunk_digest(plan.key, plan.digest, plan.size, chunk)).is_none() {
            if !index_verified_read(plan, byte_source)? {
                return read_unindexed_verified_window(plan, position, &mut target[done..length], byte_source)
                    .map(|count| done + count);
            }
        }
        let start = chunk as u64 * crate::verified_read_cache::CHUNK_BYTES as u64;
        let count = (plan.size - start).min(crate::verified_read_cache::CHUNK_BYTES as u64) as usize;
        let mut bytes = allocate_verified_chunk(plan, count)?;
        if let Err(error) = read_verified_source(plan, start, &mut bytes, byte_source) {
            if error != Errno::EAGAIN {
                invalidate_verified_read(plan, byte_source);
            }
            return Err(error);
        }
        if let Err(error) = ROOTFS.with(|state| {
            state.read_cache(plan).install_chunk(plan.key, plan.digest, plan.size, chunk, bytes)
        }) {
            invalidate_verified_read(plan, byte_source);
            return Err(error);
        }
    }
    Ok(done)
}

/// Read up to `buf.len()` bytes at `offset` from an open rootfs file. An
/// ordinary base file's bytes come from the image via `ByteReq::Image`; a
/// URL-backed deferred file's via `ByteReq::Deferred`; a lazy-archive
/// member's from [`ensure_archive_member`] (fetch + decode, cached); the store computes the EOF clamp and releases its lock *before*
/// the host callback so no host boundary call runs under the spinlock.
/// Returns the number of bytes read (0 at EOF).
pub fn read<F>(
    handle: i64,
    offset: i64,
    buf: &mut [u8],
    mut byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    if fixed_persistence_enabled() && !declares_digest(idx) {
        let plan = ROOTFS.with(|state| {
            let inode = state.get(idx).ok_or(Errno::EBADF)?;
            match inode.kind {
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source: BaseSource::Image,
                } => Ok(Some((inode.ino, Some(image_ino(blob_id)?), size))),
                InodeKind::PersistentRegular => Ok(Some((inode.ino, None, 0))),
                _ => Ok(None),
            }
        })?;
        if let Some((ino, image_ino, base_size)) = plan {
            let mut image_read = ImageReadCursor::new();
            return PERSISTENT_ROOTFS
                .lock()
                .as_mut()
                .ok_or(Errno::EIO)?
                .journal
                .read_file_at(ino, base_size, offset as u64, buf, |at, dst| {
                    match image_ino {
                        Some(image_ino) => image_read.read(image_ino, at, dst, &mut byte_source),
                        None => Err(Errno::EIO),
                    }
                });
        }
    }
    if fixed_persistence_enabled() && declares_digest(idx) {
        if let Some(count) = read_verified_file(idx, offset as u64, buf, &mut byte_source)? {
            return Ok(count);
        }
    }
    if declares_digest(idx) {
        ensure_materialized(idx, &mut byte_source)?;
    }
    // An overlay (Regular) file is copied under the lock; a base file yields
    // its (blob_id, size), and a lazy member its (archive_id, source_path,
    // size), so the host/archive byte fetch runs after the lock is released.
    enum Plan {
        Done(usize),
        /// A standalone deferred file: the URI its image recorded, and its
        /// real size. No blob id, because the id was only ever a name the host
        /// had to translate back into this.
        Deferred(Vec<u8>, u64),
        Image(u32, u64),
        Lazy(u32, Vec<u8>, u64),
    }
    let plan = ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::Regular(data) => {
                let Ok(start) = usize::try_from(offset) else {
                    return Ok(Plan::Done(0));
                };
                if start >= data.len() {
                    return Ok(Plan::Done(0));
                }
                let n = core::cmp::min(buf.len(), data.len() - start);
                buf[..n].copy_from_slice(&data[start..start + n]);
                Ok(Plan::Done(n))
            }
            InodeKind::PersistentRegular => Err(Errno::EIO),
            InodeKind::BaseRegular {
                blob_id,
                size,
                source,
            } => match source {
                BaseSource::Image => Ok(Plan::Image(image_ino(*blob_id)?, *size)),
                BaseSource::Host => Ok(Plan::Deferred(inode.deferred_uri.to_vec(), *size)),
            },
            InodeKind::Dir(_) => Err(Errno::EISDIR),
            InodeKind::Symlink(_) => Err(Errno::EINVAL),
            InodeKind::Special(_) => Err(Errno::EINVAL),
            InodeKind::LazyMember {
                archive_id,
                source_path,
                size,
            } => Ok(Plan::Lazy(*archive_id, source_path.to_vec(), *size)),
        }
    })?;
    match plan {
        Plan::Done(n) => Ok(n),
        Plan::Deferred(uri, size) => {
            let start = offset as u64;
            if start >= size {
                return Ok(0);
            }
            let n = core::cmp::min(buf.len() as u64, size - start) as usize;
            fetch_at(&mut byte_source, &uri, start, &mut buf[..n])
        }
        Plan::Image(ino, size) => {
            let start = offset as u64;
            if start >= size {
                return Ok(0);
            }
            let n = core::cmp::min(buf.len() as u64, size - start) as usize;
            read_image_bytes(ino, start, &mut buf[..n], &mut byte_source)
        }
        Plan::Lazy(archive_id, source_path, size) => {
            let start = offset as u64;
            if start >= size {
                return Ok(0);
            }
            if fixed_persistence_enabled() {
                let length = buf.len().min((size - start) as usize);
                return read_streamed_archive_member(archive_id, &source_path, size, start, &mut buf[..length], &mut byte_source);
            }
            let bytes = ensure_archive_member(archive_id, &source_path, &mut byte_source)?;
            // Defensive: clamp to the member's actual decoded length too, in
            // case it ever disagrees with the manifest-declared `size`.
            let avail = core::cmp::min(size, bytes.len() as u64);
            if start >= avail {
                return Ok(0);
            }
            let start_us = start as usize;
            let n = core::cmp::min(buf.len() as u64, avail - start) as usize;
            buf[..n].copy_from_slice(&bytes[start_us..start_us + n]);
            Ok(n)
        }
    }
}

/// Make `[offset, offset + len)` of an open rootfs file readable without
/// waiting: fetch a URL-backed file's window, decode a lazy-archive member, or
/// materialize a file whose image declared a digest. An `EAGAIN` from the byte
/// source (the bytes are still in flight) is returned as-is, so the caller's
/// syscall parks and retries through the ordinary blocking path.
///
/// WHY: `mmap` of a file populates the mapping only after the kernel has
/// committed the interval, from a context that cannot park. Fetching first,
/// while the syscall can still be retried, is what keeps a mapping of a lazy
/// file from being populated with zeros where the bytes had not arrived yet.
/// An image file or an overlay copy is already readable and costs nothing
/// here.
pub fn prefetch_range<F>(
    handle: i64,
    offset: i64,
    len: usize,
    mut byte_source: F,
) -> Result<(), Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let idx = file_handle_to_inode(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    if declares_digest(idx) {
        if fixed_persistence_enabled() {
            if let Some(mut plan) = verified_file_read(idx)? {
                if offset as u64 >= plan.size || len == 0 { return Ok(()); }
                let chunk = (offset as u64 / crate::verified_read_cache::CHUNK_BYTES as u64) as usize;
                if ROOTFS.with(|state| state.verified_reads.chunk_digest(plan.key, plan.digest, plan.size, chunk)).is_some() {
                    return Ok(());
                }
                prepare_verified_source(&mut plan, &mut byte_source)?;
                if !index_verified_read(&plan, &mut byte_source)? {
                    read_unindexed_verified_window(&plan, offset as u64, &mut [0; 1], &mut byte_source)?;
                }
                return Ok(());
            }
        }
        return ensure_materialized(idx, &mut byte_source);
    }
    enum Plan {
        Ready,
        Deferred(Vec<u8>, u64),
        Lazy(u32, Vec<u8>, u64),
    }
    let plan = ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        Ok::<Plan, Errno>(match &inode.kind {
            InodeKind::BaseRegular {
                size,
                source: BaseSource::Host,
                ..
            } => Plan::Deferred(inode.deferred_uri.to_vec(), *size),
            InodeKind::LazyMember {
                archive_id,
                source_path,
                size,
            } => Plan::Lazy(*archive_id, source_path.to_vec(), *size),
            _ => Plan::Ready,
        })
    })?;
    match plan {
        Plan::Ready => Ok(()),
        Plan::Lazy(archive_id, source_path, size) => {
            if fixed_persistence_enabled() {
                return read_streamed_archive_member(archive_id, &source_path, size, 0, &mut [], &mut byte_source).map(|_| ());
            }
            ensure_archive_member(archive_id, &source_path, &mut byte_source).map(|_| ())
        }
        Plan::Deferred(uri, size) => {
            let start = offset as u64;
            let end = start.saturating_add(len as u64).min(size);
            let mut scratch = alloc::vec![0u8; 64 * 1024];
            let mut at = start;
            while at < end {
                let want = core::cmp::min(scratch.len() as u64, end - at) as usize;
                let got = fetch_at(&mut byte_source, &uri, at, &mut scratch[..want])?;
                if got == 0 {
                    return Err(Errno::EIO);
                }
                at += got as u64;
            }
            Ok(())
        }
    }
}

/// Whether the image declared a digest for `idx`'s bytes.
///
/// Deliberately ONLY that. It began life also asking whether the bytes were
/// still unmaterialized, which reads like a second necessary half and is not
/// one: [`ensure_materialized`] already answers "this is an overlay file, there
/// is nothing to fetch" and returns without re-fetching or re-hashing. Asking
/// it here too was a second author for one judgement, and deleting the second
/// half changes no observable behaviour, because the function it was
/// second-guessing has already made the same call.
fn declares_digest(idx: u32) -> bool {
    ROOTFS.with(|state| match state.get(idx) {
        Some(inode) => inode.deferred_digest != crate::sdef::DIGEST_NONE,
        None => false,
    })
}

/// Current size of an open rootfs file (for `SEEK_END`).
pub fn size(handle: i64) -> Result<i64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get(idx).ok_or(Errno::EBADF)?;
        match &inode.kind {
            InodeKind::BaseRegular { size, .. } => {
                i64::try_from(inode.persistent_size.unwrap_or(*size)).map_err(|_| Errno::EOVERFLOW)
            }
            InodeKind::Regular(data) => Ok(data.len() as i64),
            InodeKind::PersistentRegular => {
                i64::try_from(inode.persistent_size.unwrap_or(0)).map_err(|_| Errno::EOVERFLOW)
            }
            InodeKind::LazyMember { size, .. } => Ok(*size as i64),
            _ => Err(Errno::EISDIR),
        }
    })
}

/// POSIX `SYMLOOP_MAX`: the maximum number of symlink hops the host-facing read
/// resolver follows before yielding `ELOOP`.
const SYMLOOP_MAX: usize = 40;

/// Resolve a host-facing overlay read path, following a symlinked final
/// component within the overlay up to [`SYMLOOP_MAX`] hops — exactly like a
/// normal `open()` *without* `O_NOFOLLOW`. Returns the canonical absolute path
/// of the first non-symlink target.
///
/// Guest opens do NOT use this. The namespace resolver already follows symlinks
/// before calling [`open`], so [`open`] intentionally refuses a symlinked final
/// component with `ELOOP` (`O_NOFOLLOW` semantics — see [`open`]). But
/// host-initiated reads ([`read_file_at`] → `kernel_rootfs_read_file`, used to
/// materialize exec targets such as `/bin/sh` → `/bin/dash`) pass a RAW path
/// with no pre-resolution, so they would hit that spurious `ELOOP`. This helper
/// closes that host-side gap while leaving the guest `O_NOFOLLOW` path intact.
///
/// A relative link target resolves against the symlink's parent directory; an
/// absolute target restarts at the mount root; `.`/`..` components collapse.
fn resolve_read_symlinks(path: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut comps: Vec<Vec<u8>> = split_components(path).iter().map(|c| c.to_vec()).collect();
    for _ in 0..SYMLOOP_MAX {
        let link_target = ROOTFS.with(|state| {
            let root = state.mount_root()?;
            let refs: Vec<&[u8]> = comps.iter().map(|c| c.as_slice()).collect();
            let idx = state.walk(root, &refs)?;
            match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
                InodeKind::Symlink(target) => Ok::<_, Errno>(Some(target.to_vec())),
                _ => Ok(None),
            }
        })?;
        let Some(target) = link_target else {
            // First non-symlink target: rebuild its canonical absolute path.
            let mut out = Vec::new();
            for c in &comps {
                out.push(b'/');
                out.extend_from_slice(c);
            }
            if out.is_empty() {
                out.push(b'/');
            }
            return Ok(out);
        };
        // Rewrite the working path to the link target: an absolute target
        // restarts at the mount root, a relative one resolves against the
        // symlink's parent dir; `.` is dropped and `..` pops a component.
        let mut next: Vec<Vec<u8>> = if target.first() == Some(&b'/') {
            Vec::new()
        } else {
            comps[..comps.len().saturating_sub(1)].to_vec()
        };
        for part in target.split(|&b| b == b'/') {
            match part {
                b"" | b"." => {}
                b".." => {
                    next.pop();
                }
                _ => next.push(part.to_vec()),
            }
        }
        comps = next;
    }
    Err(Errno::ELOOP)
}

/// Read up to `buf.len()` bytes at `offset` from the rootfs file named by
/// `path` (open `O_RDONLY` + [`read`] + [`release_handle`]).
///
/// Host-facing convenience: the kernel owns `/`, so when the host needs a file's
/// current bytes (for example to read a config file a guest may have changed)
/// it reads them through the overlay with this. Copy-on-written bytes come
/// straight from the overlay; an unmodified base file's bytes come from
/// `byte_source` exactly as a guest read would fetch them.
///
/// A symlinked path is followed within the overlay ([`resolve_read_symlinks`],
/// bounded by [`SYMLOOP_MAX`]) so a host-initiated read of `/bin/sh` →
/// `/bin/dash` serves dash's bytes instead of failing `ELOOP` — the guest open
/// path pre-resolves symlinks, but this host-facing raw-path reader must not.
pub fn read_file_at<F>(
    path: &[u8],
    offset: i64,
    buf: &mut [u8],
    byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    let resolved = resolve_read_symlinks(path)?;
    let handle = open(&resolved, O_RDONLY, 0, 0, 0)?;
    let result = read(handle, offset, buf, byte_source);
    release_handle(handle);
    result
}

/// Write `buf` at `offset` to the rootfs file named by `path`, creating it if
/// absent. When `truncate` is set the file is first emptied and its mode set to
/// `mode` ("replace this whole file" — the host `write_vfs_file` contract);
/// otherwise an existing file's mode is preserved and the bytes land at
/// `offset` (chunked continuation). An unmodified base file is copied into the
/// overlay first (via `byte_source`) so a partial write keeps the untouched bytes.
///
/// Host-facing convenience so host-side `/` writes land in the authoritative
/// overlay and are visible to live guests.
///
/// A symlinked path is followed ([`resolve_read_symlinks`], bounded by
/// [`SYMLOOP_MAX`]) for the same reason [`read_file_at`] follows one, and the
/// omission here was a real defect: `open` refuses a symlinked final component
/// with `ELOOP` because the GUEST's namespace resolver pre-resolves, and a
/// host-facing raw-path writer does not. So writing `/bin/bash` when it is a
/// symlink failed `ELOOP` while READING it succeeded.
///
/// It surfaced building the shell package, where the composer materialises
/// bash over a path the rootfs carries as a symlink. Following the link means
/// the bytes land in the file the name refers to, which is what every other
/// writer of a symlinked path does.
pub fn write_file_at<F>(
    path: &[u8],
    offset: i64,
    buf: &[u8],
    mode: u32,
    truncate: bool,
    byte_source: F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    // Resolved BEFORE the open, and the mode is applied to the resolved path
    // too: a truncating replace of `/bin/bash` must set the mode of the file
    // the link names, not of the link.
    //
    // A path that does not RESOLVE is one this call may be about to create, so
    // the raw path stands in. That keeps creation working without weakening
    // anything: `open` below reports the real error for a missing parent, and
    // an `ENOENT` here cannot hide a symlink, because resolving a symlink is
    // the only way this returns a different path at all.
    let resolved = match resolve_read_symlinks(path) {
        Ok(resolved) => resolved,
        Err(Errno::ENOENT) => path.to_vec(),
        Err(e) => return Err(e),
    };
    let flags = O_WRONLY | O_CREAT | if truncate { O_TRUNC } else { 0 };
    let handle = open(&resolved, flags, mode & 0o7777, 0, 0)?;
    let result = write(handle, offset, buf, byte_source);
    release_handle(handle);
    // open(O_CREAT) preserves an existing file's mode, so a truncating replace
    // sets it explicitly — create and replace then behave alike, matching the
    // host write_vfs_file handler.
    if truncate {
        chmod(&resolved, mode & 0o7777)?;
    }
    if result.is_ok() { crate::fs_changes::publish(1, &resolved); }
    result
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

/// Drop one owning reference (close/exec-cloexec). Frees the inode if it was the
/// last reference and the file had already been unlinked (POSIX unlink-while-
/// open). Returns `true` when this drop released the final open reference.
pub fn release_handle(handle: i64) -> bool {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return false;
    };
    ROOTFS.with(|state| {
        let Some(inode) = state.get_mut(idx) else {
            return false;
        };
        inode.open_count = inode.open_count.saturating_sub(1);
        let was_last = inode.open_count == 0;
        state.maybe_free(idx);
        was_last
    })
}

/// Take a shared-mapping reference on the file behind `handle`.
///
/// POSIX: `mmap` adds a reference to the file that a later `close` of the
/// descriptor does not remove, so the inode must outlive every descriptor and
/// every name while a mapping of it exists.
pub fn pin_mapping(handle: i64) -> Result<(), Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        if inode.is_dir() {
            return Err(Errno::EBADF);
        }
        inode.map_pins = inode.map_pins.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        Ok(())
    })
}

/// Drop a reference [`pin_mapping`] took, freeing an inode that has no name,
/// descriptor or other mapping left.
pub fn unpin_mapping(handle: i64) {
    let Ok(idx) = file_handle_to_inode(handle) else {
        return;
    };
    ROOTFS.with(|state| {
        if let Some(inode) = state.get_mut(idx) {
            inode.map_pins = inode.map_pins.saturating_sub(1);
        }
        state.maybe_free(idx);
    });
}

/// A counter that changes on every write, truncation or `O_TRUNC` open of the
/// file behind `handle`. The shared-mapping layer compares it to learn that
/// descriptor I/O changed a mapped file.
pub fn content_generation(handle: i64) -> Result<u64, Errno> {
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| Ok(state.get(idx).ok_or(Errno::EBADF)?.content_gen))
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
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        match &state.get(idx).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(map) => {
                for &child_idx in map.values() {
                    state.get(child_idx).ok_or(Errno::ENOENT)?;
                }
            }
            _ => return Err(Errno::ENOTDIR),
        }
        state.get_mut(idx).ok_or(Errno::ENOENT)?.open_count += 1;
        let iter = DirIter {
            directory: idx,
            last_name: None,
            exhausted: false,
        };
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
        let inodes = &state.inodes;
        let iter = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .and_then(|slot| slot.as_mut())
            .ok_or(Errno::EBADF)?;
        if iter.exhausted {
            return Ok(None);
        }
        let directory = inodes
            .get(iter.directory as usize)
            .and_then(|slot| slot.as_ref())
            .ok_or(Errno::EBADF)?;
        let InodeKind::Dir(entries) = &directory.kind else {
            return Err(Errno::ENOTDIR);
        };
        let next = match iter.last_name.as_deref() {
            Some(last_name) => entries.next_after(last_name),
            None => entries.iter().next(),
        };
        let Some((name, &child_idx)) = next else {
            iter.exhausted = true;
            return Ok(None);
        };
        let n = name.len();
        if n > name_buf.len() {
            return Err(Errno::EINVAL);
        }
        let child = inodes
            .get(child_idx as usize)
            .and_then(|slot| slot.as_ref())
            .ok_or(Errno::ENOENT)?;
        name_buf[..n].copy_from_slice(name);
        let result = (child.ino, dirent_type(child) as u32, n);
        iter.last_name = Some(name.clone());
        Ok(Some(result))
    })
}

/// getdents64 for a rootfs directory. `extra` entries `(name, d_type, ino)` are
/// appended after the tree's own children (deduplicated by name) so the caller
/// can inject synthetic mount points into the root listing. The directory is
/// traversed without copying all its names for each buffer-sized page.
pub fn getdents64(
    path: &[u8],
    buf: &mut [u8],
    offset: i64,
    extra: &[(&[u8], u8, u64)],
) -> Result<(usize, i64, bool), Errno> {
    let comps = split_components(path);
    ROOTFS.with(|state| {
        let root = state.mount_root()?;
        let idx = state.walk(root, &comps)?;
        let dir = state.get(idx).ok_or(Errno::ENOENT)?;
        let InodeKind::Dir(map) = &dir.kind else {
            return Err(Errno::ENOTDIR);
        };
        for &child_idx in map.values() {
            state.get(child_idx).ok_or(Errno::ENOENT)?;
        }
        if offset < 0 {
            return Err(Errno::EINVAL);
        }
        let injected = extra.iter().enumerate().filter(|(index, (name, _, _))| {
            !map.contains_key(*name)
                && !extra[..*index]
                    .iter()
                    .any(|(earlier, _, _)| earlier == name)
        });
        let entry_count = map
            .len()
            .checked_add(injected.clone().count())
            .ok_or(Errno::EOVERFLOW)?;
        let end_cookie = i64::try_from(entry_count)
            .map_err(|_| Errno::EOVERFLOW)?
            .checked_add(2)
            .ok_or(Errno::EOVERFLOW)?;
        if offset >= end_cookie {
            return Ok((0, offset, true));
        }

        let mut written = 0;
        let mut cookie = offset;
        while cookie < 2 {
            let name = if cookie == 0 {
                b".".as_slice()
            } else {
                b"..".as_slice()
            };
            let next_cookie = cookie + 1;
            let bytes =
                crate::procfs::write_dirent64(buf, written, dir.ino, next_cookie, DT_DIR as u8, name);
            if bytes == 0 {
                return if written == 0 {
                    Err(Errno::EINVAL)
                } else {
                    Ok((written, cookie, false))
                };
            }
            written += bytes;
            cookie = next_cookie;
        }

        let start = usize::try_from(cookie - 2).map_err(|_| Errno::EOVERFLOW)?;
        let entries = map
            .iter()
            .map(|(name, &child_idx)| {
                let child = state.get(child_idx).ok_or(Errno::ENOENT)?;
                Ok((name.as_slice(), child.ino, dirent_type(child)))
            })
            .chain(injected.map(|(_, &(name, d_type, ino))| Ok((name, ino, d_type))));
        for entry in entries.skip(start) {
            let (name, ino, d_type) = entry?;
            let next_cookie = cookie + 1;
            let bytes =
                crate::procfs::write_dirent64(buf, written, ino, next_cookie, d_type, name);
            if bytes == 0 {
                return if written == 0 {
                    Err(Errno::EINVAL)
                } else {
                    Ok((written, cookie, false))
                };
            }
            written += bytes;
            cookie = next_cookie;
        }
        Ok((written, cookie, true))
    })
}

/// Close a rootfs directory stream.
pub fn closedir(handle: i64) -> Result<(), Errno> {
    let iter_idx = dir_handle_to_iter(handle)?;
    ROOTFS.with(|state| {
        let slot = state
            .dir_iters
            .get_mut(iter_idx as usize)
            .ok_or(Errno::EBADF)?;
        let iter = slot.take().ok_or(Errno::EBADF)?;
        state.free_dir_iters.push(iter_idx);
        let directory = state.get_mut(iter.directory).ok_or(Errno::EBADF)?;
        directory.open_count = directory.open_count.saturating_sub(1);
        state.maybe_free(iter.directory);
        Ok(())
    })
}

/// mkdir a rootfs directory.
pub fn mkdir(path: &[u8], mode: u32, uid: u32, gid: u32) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EEXIST); // the root already exists
    }
    if resizable_persistence_enabled() {
        let (parent, name, parent_ino, inode) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(&comps)?;
            if target.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Dir(DirectoryEntries::new()), mode & 0o7777, uid, gid, 2, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.recompute_dir_nlink(parent);
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        if target.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Dir(DirectoryEntries::new()),
            mode & 0o7777,
            uid,
            gid,
            2,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        // A new subdirectory bumps the parent's link count (its `..`).
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink += 1;
        }
        Ok(())
    })
}

/// Remove an empty rootfs directory.
pub fn rmdir(path: &[u8]) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EBUSY); // cannot remove the root
    }
    let mut allocated = if resizable_persistence_enabled() {
        let (parent, key) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(&comps)?;
            let target = target.ok_or(Errno::ENOENT)?;
            match &state.get(target).ok_or(Errno::ENOENT)?.kind {
                InodeKind::Dir(entries) if entries.is_empty() => {}
                InodeKind::Dir(_) => return Err(Errno::ENOTEMPTY),
                _ => return Err(Errno::ENOTDIR),
            }
            Ok::<_, Errno>((parent, OverlayKey::Dirent {
                parent: state.get(parent).ok_or(Errno::EIO)?.ino,
                name: last.ok_or(Errno::ENOENT)?.to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(&[Mutation::Delete { key }], &[(parent, NamespaceTimestamp::Modified)])?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        match &state.get(target).ok_or(Errno::ENOENT)?.kind {
            InodeKind::Dir(entries) => {
                if !entries.is_empty() {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, parent, last)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) { entries.remove(last); }
        if let Some(parent_inode) = state.get_mut(parent) {
            parent_inode.nlink = parent_inode.nlink.saturating_sub(1);
        }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = 0;
        }
        state.maybe_free(target);
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    })
}

/// Unlink a rootfs non-directory name.
pub fn unlink(path: &[u8]) -> Result<(), Errno> {
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EISDIR);
    }
    let mut allocated = if resizable_persistence_enabled() {
        let (parent, target, key) = ROOTFS.with(|state| {
            let (parent, last, target) = state.resolve(&comps)?;
            let target = target.ok_or(Errno::ENOENT)?;
            if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
                return Err(Errno::EISDIR);
            }
            Ok::<_, Errno>((parent, target, OverlayKey::Dirent {
                parent: state.get(parent).ok_or(Errno::EIO)?.ino,
                name: last.ok_or(Errno::ENOENT)?.to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(
            &[Mutation::Delete { key }],
            &[(parent, NamespaceTimestamp::Modified), (target, NamespaceTimestamp::Changed)],
        )?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    let result = ROOTFS.with(|state| {
        let (parent, last, target) = state.resolve(&comps)?;
        let target = target.ok_or(Errno::ENOENT)?;
        let last = last.ok_or(Errno::ENOENT)?;
        if state.get(target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EISDIR);
        }
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, parent, last)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(parent).map(|i| &mut i.kind) { entries.remove(last); }
        if let Some(inode) = state.get_mut(target) {
            inode.nlink = inode.nlink.saturating_sub(1);
        }
        state.maybe_free(target);
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    });
    if result.is_ok() {
        crate::fs_changes::publish(2, path);
    }
    result
}

/// Rename `old` to `new` within the rootfs. Both paths must be rootfs paths (the
/// syscall layer maps a rootfs/tmpfs or cross-authority rename to EXDEV before
/// reaching here). POSIX replace semantics: an existing destination of a
/// compatible type is atomically replaced; type mismatches yield ENOTDIR/EISDIR
/// and a non-empty destination directory yields ENOTEMPTY.
pub fn rename(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    let old_comps = split_components(old);
    let new_comps = split_components(new);
    if old_comps.is_empty() || new_comps.is_empty() {
        return Err(Errno::EBUSY); // cannot rename the root
    }
    let into_own_subtree = new_comps.len() > old_comps.len()
        && new_comps.starts_with(&old_comps);
    let mut allocated = if resizable_persistence_enabled() {
        let mutations = ROOTFS.with(|state| {
            let (old_parent, old_name, old_target) = state.resolve(&old_comps)?;
            let old_target = old_target.ok_or(Errno::ENOENT)?;
            if into_own_subtree && state.get(old_target).ok_or(Errno::ENOENT)?.is_dir() {
                return Err(Errno::EINVAL);
            }
            let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
            if new_existing == Some(old_target) {
                return Ok::<_, Errno>(None);
            }
            let old_is_dir = state.get(old_target).ok_or(Errno::ENOENT)?.is_dir();
            if let Some(existing) = new_existing {
                let new_inode = state.get(existing).ok_or(Errno::ENOENT)?;
                if old_is_dir && !new_inode.is_dir() {
                    return Err(Errno::ENOTDIR);
                }
                if !old_is_dir && new_inode.is_dir() {
                    return Err(Errno::EISDIR);
                }
                if let InodeKind::Dir(entries) = &new_inode.kind {
                    if !entries.is_empty() {
                        return Err(Errno::ENOTEMPTY);
                    }
                }
            }
            let inode_number = state.get(old_target).ok_or(Errno::EIO)?.ino;
            let old_parent_number = state.get(old_parent).ok_or(Errno::EIO)?.ino;
            let new_parent_number = state.get(new_parent).ok_or(Errno::EIO)?.ino;
            Ok(Some(([
                Mutation::Delete {
                    key: OverlayKey::Dirent {
                        parent: old_parent_number,
                        name: old_name.ok_or(Errno::ENOENT)?.to_vec(),
                    },
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: new_parent_number,
                        name: new_name.ok_or(Errno::ENOENT)?.to_vec(),
                    },
                    value: inode_number.to_le_bytes().to_vec(),
                },
            ], old_parent, new_parent, old_target, new_existing)))
        })?;
        if let Some((mutations, old_parent, new_parent, source, replaced)) = mutations {
            let mut timestamps = vec![
                (old_parent, NamespaceTimestamp::Modified),
                (new_parent, NamespaceTimestamp::Modified),
                (source, NamespaceTimestamp::Changed),
            ];
            if let Some(replaced) = replaced {
                timestamps.push((replaced, NamespaceTimestamp::Changed));
            }
            Some(commit_persistent_namespace(
                &mutations,
                &timestamps,
            )?)
        } else {
            None
        }
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    let result = ROOTFS.with(|state| {
        let (old_parent, old_name, old_target) = state.resolve(&old_comps)?;
        let old_target = old_target.ok_or(Errno::ENOENT)?;
        if into_own_subtree && state.get(old_target).ok_or(Errno::ENOENT)?.is_dir() {
            return Err(Errno::EINVAL);
        }
        let old_name = old_name.ok_or(Errno::ENOENT)?.to_vec();
        let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();

        // Renaming a name to itself (same inode) is a no-op.
        if new_existing == Some(old_target) {
            return Ok(());
        }

        let old_is_dir = state.get(old_target).ok_or(Errno::ENOENT)?.is_dir();

        if let Some(existing) = new_existing {
            let new_is_dir = state.get(existing).ok_or(Errno::ENOENT)?.is_dir();
            if old_is_dir && !new_is_dir {
                return Err(Errno::ENOTDIR);
            }
            if !old_is_dir && new_is_dir {
                return Err(Errno::EISDIR);
            }
            if new_is_dir {
                let empty = matches!(
                    &state.get(existing).ok_or(Errno::ENOENT)?.kind,
                    InodeKind::Dir(entries) if entries.is_empty()
                );
                if !empty {
                    return Err(Errno::ENOTEMPTY);
                }
            }
        }
        let prepared = match allocated.as_mut() {
            Some(committed) => committed.take_name(new_parent, &new_name)?,
            None => PreparedDirectoryName::new(&ROOTFS_METADATA, &new_name)?,
        };
        if let Some(existing) = new_existing {
            let new_is_dir = state.get(existing).ok_or(Errno::EIO)?.is_dir();
            // Detach and free the replaced destination.
            if let Some(committed) = allocated.as_mut() { committed.remove_from(state, new_parent, &new_name)?; }
            else if let Some(InodeKind::Dir(entries)) = state.get_mut(new_parent).map(|i| &mut i.kind) { entries.remove(&new_name); }
            if let Some(inode) = state.get_mut(existing) {
                inode.nlink = if new_is_dir {
                    0
                } else {
                    inode.nlink.saturating_sub(1)
                };
            }
            state.maybe_free(existing);
        }

        // Detach the source name and reattach under the destination name.
        if let Some(committed) = allocated.as_mut() { committed.remove_from(state, old_parent, &old_name)?; }
        else if let Some(InodeKind::Dir(entries)) = state.get_mut(old_parent).map(|i| &mut i.kind) { entries.remove(&old_name); }
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert_prepared(prepared, old_target);
            }
            _ => return Err(Errno::ENOTDIR),
        }

        state.recompute_dir_nlink(old_parent);
        if new_parent != old_parent {
            state.recompute_dir_nlink(new_parent);
        }
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    });
    if result.is_ok() {
        crate::fs_changes::publish(2, old);
        crate::fs_changes::publish(1, new);
    }
    result
}

/// Create a hard link `new` to the existing file `old` within the rootfs. Hard
/// links to directories are EPERM; an existing destination is EEXIST. `old` is
/// not dereferenced (the kernel already applied the syscall's follow policy).
pub fn link(old: &[u8], new: &[u8]) -> Result<(), Errno> {
    let old_comps = split_components(old);
    let new_comps = split_components(new);
    if new_comps.is_empty() {
        return Err(Errno::EEXIST); // cannot link over the root
    }
    let persistent = resizable_persistence_enabled();
    let mut allocated = if persistent {
        let (source, new_parent, mutation) = ROOTFS.with(|state| {
            let old_idx = {
                let root = state.mount_root()?;
                state.walk(root, &old_comps)?
            };
            let source = state.get(old_idx).ok_or(Errno::ENOENT)?;
            if source.is_dir() {
                return Err(Errno::EPERM);
            }
            if source.nlink == u32::MAX {
                return Err(Errno::EMLINK);
            }
            let inode_number = source.ino;
            let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
            if new_existing.is_some() {
                return Err(Errno::EEXIST);
            }
            Ok::<_, Errno>((old_idx, new_parent, Mutation::Put {
                key: OverlayKey::Dirent {
                    parent: state.get(new_parent).ok_or(Errno::EIO)?.ino,
                    name: new_name.ok_or(Errno::ENOENT)?.to_vec(),
                },
                value: inode_number.to_le_bytes().to_vec(),
            }))
        })?;
        Some(commit_persistent_namespace(
            &[mutation],
            &[(new_parent, NamespaceTimestamp::Modified), (source, NamespaceTimestamp::Changed)],
        )?)
    } else {
        reject_fixed_persistence_mutation()?;
        None
    };
    ROOTFS.with(|state| {
        let old_idx = {
            let root = state.mount_root()?;
            state.walk(root, &old_comps)?
        };
        let source = state.get(old_idx).ok_or(Errno::ENOENT)?;
        if source.is_dir() {
            return Err(Errno::EPERM); // no hard links to directories
        }
        if source.nlink == u32::MAX {
            return Err(Errno::EMLINK);
        }
        let (new_parent, new_name, new_existing) = state.resolve(&new_comps)?;
        if new_existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let new_name = new_name.ok_or(Errno::ENOENT)?.to_vec();
        let prepared = match allocated.as_mut() {
            Some(committed) => committed.take_name(new_parent, &new_name)?,
            None => PreparedDirectoryName::new(&ROOTFS_METADATA, &new_name)?,
        };
        match state.get_mut(new_parent).map(|i| &mut i.kind) {
            Some(InodeKind::Dir(entries)) => {
                entries.insert_prepared(prepared, old_idx);
            }
            _ => return Err(Errno::ENOTDIR),
        }
        if let Some(inode) = state.get_mut(old_idx) {
            inode.nlink += 1;
            if !persistent {
                inode.touch_changed();
            }
        }
        state.persistent_allocated_blocks = allocated.as_ref().map(|committed| committed.allocated);
        Ok(())
    })
}

fn change_persistent_owner(
    metadata: &mut PersistentInodeMetadata,
    uid: u32,
    gid: u32,
    clear_setid: bool,
) {
    if uid != u32::MAX {
        metadata.uid = uid;
    }
    if gid != u32::MAX {
        metadata.gid = gid;
    }
    if clear_setid {
        metadata.mode &= !0o4000;
        if metadata.mode & 0o0010 != 0 {
            metadata.mode &= !0o2000;
        }
    }
    metadata.touch_changed();
}

fn update_persistent_inode_metadata(
    index: u32,
    update: impl FnOnce(&mut PersistentInodeMetadata) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let mut change = ROOTFS.with(|state| {
        PreparedPersistentMetadataChange::from_inode(
            index,
            state.get(index).ok_or(Errno::ENOENT)?,
        )
    })?;
    update(&mut change.metadata)?;
    let mut active = PERSISTENT_ROOTFS.lock();
    let journal = &mut active.as_mut().ok_or(Errno::EIO)?.journal;
    let mutation = change.mutation(journal)?;
    journal.commit(&[mutation])?;
    ROOTFS.with(|state| change.apply(state))
}

/// chmod a rootfs path (permission bits only).
pub fn chmod(path: &[u8], mode: u32) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        return update_persistent_inode_metadata(walk_to_inode(path)?, |metadata| {
            metadata.mode = mode & 0o7777;
            metadata.touch_changed();
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    let idx = walk_to_inode(path)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// chown a rootfs path. A field of `u32::MAX` (-1) is left unchanged. When
/// `clear_setid` is set, set-user-ID (and set-group-ID on a group-executable
/// file) is cleared, matching the host chown path.
pub fn chown(path: &[u8], uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        return update_persistent_inode_metadata(walk_to_inode(path)?, |metadata| {
            change_persistent_owner(metadata, uid, gid, clear_setid);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    let idx = walk_to_inode(path)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
        if clear_setid {
            const S_ISUID: u32 = 0o4000;
            const S_ISGID: u32 = 0o2000;
            const S_IXGRP: u32 = 0o0010;
            inode.mode &= !S_ISUID;
            if inode.mode & S_IXGRP != 0 {
                inode.mode &= !S_ISGID;
            }
        }
        inode.touch_changed();
        Ok(())
    })
}

/// fchmod an open rootfs file handle.
pub fn fchmod(handle: i64, mode: u32) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        return update_persistent_inode_metadata(file_handle_to_inode(handle)?, |metadata| {
            metadata.mode = mode & 0o7777;
            metadata.touch_changed();
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        inode.mode = mode & 0o7777;
        inode.touch_changed();
        Ok(())
    })
}

/// fchown an open rootfs file handle. A field of `u32::MAX` (-1) is unchanged.
pub fn fchown(handle: i64, uid: u32, gid: u32, clear_setid: bool) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        return update_persistent_inode_metadata(file_handle_to_inode(handle)?, |metadata| {
            change_persistent_owner(metadata, uid, gid, clear_setid);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    let idx = file_handle_to_inode(handle)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::EBADF)?;
        if uid != u32::MAX {
            inode.uid = uid;
        }
        if gid != u32::MAX {
            inode.gid = gid;
        }
        if clear_setid {
            const S_ISUID: u32 = 0o4000;
            const S_ISGID: u32 = 0o2000;
            const S_IXGRP: u32 = 0o0010;
            inode.mode &= !S_ISUID;
            if inode.mode & S_IXGRP != 0 {
                inode.mode &= !S_ISGID;
            }
        }
        inode.touch_changed();
        Ok(())
    })
}

/// Set a rootfs inode's timestamps to already-resolved values (the caller has
/// applied UTIME_NOW/UTIME_OMIT).
pub fn utimensat(
    path: &[u8],
    atime_sec: u64,
    atime_nsec: u32,
    mtime_sec: u64,
    mtime_nsec: u32,
    ctime_sec: u64,
    ctime_nsec: u32,
) -> Result<(), Errno> {
    if resizable_persistence_enabled() {
        return update_persistent_inode_metadata(walk_to_inode(path)?, |metadata| {
            if atime_nsec >= 1_000_000_000 || mtime_nsec >= 1_000_000_000 || ctime_nsec >= 1_000_000_000 {
                return Err(Errno::EINVAL);
            }
            metadata.atime_sec = atime_sec;
            metadata.atime_nsec = atime_nsec;
            metadata.mtime_sec = mtime_sec;
            metadata.mtime_nsec = mtime_nsec;
            metadata.ctime_sec = ctime_sec;
            metadata.ctime_nsec = ctime_nsec;
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    let idx = walk_to_inode(path)?;
    ROOTFS.with(|state| {
        let inode = state.get_mut(idx).ok_or(Errno::ENOENT)?;
        inode.atime_sec = atime_sec;
        inode.atime_nsec = atime_nsec;
        inode.mtime_sec = mtime_sec;
        inode.mtime_nsec = mtime_nsec;
        inode.ctime_sec = ctime_sec;
        inode.ctime_nsec = ctime_nsec;
        Ok(())
    })
}

/// Create a symbolic link at a rootfs path pointing at `target`.
pub fn symlink(target: &[u8], linkpath: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
    let comps = split_components(linkpath);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    if target.is_empty() {
        return Err(Errno::ENOENT);
    }
    if resizable_persistence_enabled() {
        if target.len() > 4096 - PERSISTENT_REGULAR_RECORD_BYTES {
            return Err(Errno::ENAMETOOLONG);
        }
        let creation = ROOTFS.with(|state| {
            let (parent, last, existing) = state.resolve(&comps)?;
            if existing.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Symlink(own_metadata(target)?), 0o777, uid, gid, 1, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let (parent, name, parent_ino, inode) = creation;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(&comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Symlink(own_metadata(target)?),
            0o777,
            uid,
            gid,
            1,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        Ok(())
    })
}

/// Create a metadata-only special node (AF_UNIX socket or FIFO) at a rootfs
/// path. `type_bits` selects S_IFSOCK or S_IFIFO. EEXIST if the name is taken.
/// The communication endpoint (registry entry / fifo pipe) is owned elsewhere,
/// keyed by path; this only creates the filesystem node. Mirrors tmpfs.
pub fn mknod_special(
    path: &[u8],
    mode: u32,
    uid: u32,
    gid: u32,
    type_bits: u32,
) -> Result<(), Errno> {
    if type_bits != S_IFIFO && type_bits != S_IFSOCK {
        return Err(Errno::EINVAL);
    }
    let comps = split_components(path);
    if comps.is_empty() {
        return Err(Errno::EEXIST);
    }
    if resizable_persistence_enabled() {
        let (parent, name, parent_ino, inode) = ROOTFS.with(|state| {
            let (parent, last, existing) = state.resolve(&comps)?;
            if existing.is_some() {
                return Err(Errno::EEXIST);
            }
            state.require_image_inode_slot()?;
            let ino = state.next_ino;
            if ino == u64::MAX {
                return Err(Errno::ENOSPC);
            }
            let inode = Inode::new(InodeKind::Special(type_bits), mode & 0o7777, uid, gid, 1, ino);
            Ok::<_, Errno>((parent, last.ok_or(Errno::ENOENT)?.to_vec(), state.get(parent).ok_or(Errno::EIO)?.ino, inode))
        })?;
        let mut allocated = commit_persistent_namespace(&[
            Mutation::Put {
                key: OverlayKey::Inode(inode.ino),
                value: encode_persistent_inode(&inode)?,
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: parent_ino, name: name.clone() },
                value: inode.ino.to_le_bytes().to_vec(),
            },
        ], &[(parent, NamespaceTimestamp::Modified)])?;
        return ROOTFS.with(|state| {
            state.bump_next_ino(inode.ino);
            let index = state.insert_prepared_inode(inode);
            allocated.insert_into(state, parent, &name, index)?;
            state.persistent_allocated_blocks = Some(allocated.allocated);
            Ok(())
        });
    }
    reject_fixed_persistence_mutation()?;
    ROOTFS.with(|state| {
        let (parent, last, existing) = state.resolve(&comps)?;
        if existing.is_some() {
            return Err(Errno::EEXIST);
        }
        let last = last.ok_or(Errno::ENOENT)?;
        let ino = state.alloc_ino();
        let new_idx = state.insert_inode(Inode::new(
            InodeKind::Special(type_bits & S_IFMT),
            mode & 0o7777,
            uid,
            gid,
            1,
            ino,
        ))?;
        state.link_unpublished_inode(parent, last, new_idx)?;
        Ok(())
    })
}

pub fn statfs(path: &[u8]) -> Result<WasmStatfs, Errno> {
    if !owns_path(path) {
        return Err(Errno::ENOENT);
    }
    if fixed_persistence_enabled() {
        return persistent_statfs();
    }
    Ok(WasmStatfs {
        f_type: 0x858458f6, // RAMFS_MAGIC
        f_bsize: 4096,
        f_blocks: 262_144,
        f_bfree: 262_144,
        f_bavail: 262_144,
        f_files: 65_536,
        f_ffree: 65_536,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: if is_nosuid() {
            wasm_posix_shared::statfs_flags::ST_NOSUID
        } else {
            0
        },
        _pad: 0,
    })
}

pub fn statfs_for_exec(path: &[u8]) -> Result<WasmStatfs, Errno> {
    if !fixed_persistence_enabled() {
        return statfs(path);
    }
    if !owns_path(path) {
        return Err(Errno::ENOENT);
    }
    Ok(WasmStatfs {
        f_type: crate::kandelo_image_fs::KANDELO_IMAGE_SUPER_MAGIC,
        f_bsize: 4096,
        f_blocks: 0,
        f_bfree: 0,
        f_bavail: 0,
        f_files: 0,
        f_ffree: 0,
        f_fsid: 0,
        f_namelen: 255,
        f_frsize: 4096,
        f_flags: if is_nosuid() {
            wasm_posix_shared::statfs_flags::ST_NOSUID
        } else {
            0
        },
        _pad: 0,
    })
}

fn persistent_inode_blocks(inode: &Inode) -> Result<u64, Errno> {
    Ok(match &inode.kind {
        InodeKind::PersistentRegular => inode.allocated_blocks,
        InodeKind::BaseRegular {
            source: BaseSource::Image,
            ..
        } => inode.allocated_blocks,
        InodeKind::Regular(bytes) => blocks_for_file(bytes.len() as u64),
        InodeKind::Symlink(target) if target.len() > 40 => blocks_for_file(target.len() as u64),
        InodeKind::Dir(entries) => {
            let mut counter = crate::kandelo_image_write::DirectorySizeCounter::new();
            for name in entries.keys() {
                counter.push(name.len())?;
            }
            blocks_for_file(counter.size())
        }
        _ => 0,
    })
}

fn persistent_deferred_record_bytes(inode: &Inode) -> u64 {
    let source_path_len = match &inode.kind {
        InodeKind::LazyMember { source_path, .. } => source_path.len(),
        InodeKind::BaseRegular {
            source: BaseSource::Host,
            ..
        } if inode.deferred_base || !inode.deferred_payload.is_empty() => 0,
        _ => return 0,
    };
    let bytes = u64::from(crate::sdef::RECORD_HEADER_SIZE)
        + source_path_len as u64
        + inode.deferred_payload.len() as u64
        + inode.deferred_uri.len() as u64;
    bytes.div_ceil(4) * 4
}

fn persistent_deferred_section_bytes(state: &RootfsState, retired: &[u32]) -> Result<u64, Errno> {
    let mut bytes = u64::from(crate::sdef::HEADER_SIZE);
    for (index, inode) in state.inodes.iter().enumerate() {
        if let Some(inode) = inode
            .as_ref()
            .filter(|_| !retired.contains(&(index as u32)))
        {
            bytes = bytes
                .checked_add(persistent_deferred_record_bytes(inode))
                .ok_or(Errno::EIO)?;
        }
    }
    for (archive_id, archive) in &state.archives {
        let referenced = state.inodes.iter().enumerate().any(|(index, inode)| {
            !retired.contains(&(index as u32)) && inode.as_ref().is_some_and(|inode| {
                matches!(&inode.kind,
                    InodeKind::LazyMember { archive_id: member_archive, .. } if member_archive == archive_id)
            })
        });
        if referenced {
            let record = u64::from(crate::sdef::ARCHIVE_ENTRY_SIZE)
                + archive.payload.len() as u64
                + archive.uri.len() as u64;
            bytes = bytes
                .checked_add(record.div_ceil(4) * 4)
                .ok_or(Errno::EIO)?;
        }
    }
    Ok(bytes)
}

fn persistent_directory_blocks_after(
    parent: u64,
    entries: &DirectoryEntries<'_>,
    mutations: &[Mutation],
) -> Result<u64, Errno> {
    let mut inserted = crate::IoBuffer::try_with_capacity(mutations.len())?;
    for mutation in mutations {
        if let Mutation::Put {
            key:
                OverlayKey::Dirent {
                    parent: changed,
                    name,
                },
            ..
        } = mutation
        {
            if *changed == parent && !entries.contains_key(name) {
                inserted.push(name.as_slice());
            }
        }
    }
    inserted.sort_unstable();
    let mut original = entries
        .keys()
        .filter(|name| {
            !mutations.iter().any(|mutation| {
                matches!(mutation, Mutation::Delete {
                key: OverlayKey::Dirent { parent: changed, name: removed }
            } if *changed == parent && removed == *name)
            })
        })
        .map(Vec::as_slice)
        .peekable();
    let mut added = inserted.into_iter().peekable();
    let mut counter = crate::kandelo_image_write::DirectorySizeCounter::new();
    loop {
        let name = match (original.peek(), added.peek()) {
            (Some(original_name), Some(added_name)) if original_name < added_name => {
                original.next()
            }
            (None, Some(_)) | (Some(_), Some(_)) => added.next(),
            (Some(_), None) => original.next(),
            (None, None) => break,
        };
        counter.push(name.ok_or(Errno::EIO)?.len())?;
    }
    Ok(blocks_for_file(counter.size()))
}

fn persistent_namespace_blocks(
    state: &RootfsState,
    mutations: &[Mutation],
    timestamps: &[(u32, NamespaceTimestamp)],
) -> Result<u64, Errno> {
    let mut projected = i128::from(state.persistent_allocated_blocks.ok_or(Errno::EIO)?);
    let mut parents = crate::IoBuffer::try_with_capacity(mutations.len())?;
    let mut outgoing: crate::IoBuffer<(u32, u32)> = crate::IoBuffer::try_with_capacity(mutations.len())?;
    for (position, mutation) in mutations.iter().enumerate() {
        let key = match mutation {
            Mutation::Put { key, .. } | Mutation::Delete { key } => key,
        };
        if mutations[..position].iter().any(|previous| match previous {
            Mutation::Put { key: previous, .. } | Mutation::Delete { key: previous } => {
                previous == key
            }
        }) {
            return Err(Errno::EIO);
        }
        match key {
            OverlayKey::Inode(ino) => {
                let Mutation::Put { value, .. } = mutation else {
                    return Err(Errno::EIO);
                };
                if *ino < state.next_ino {
                    return Err(Errno::EIO);
                }
                projected += i128::from(persistent_inode_blocks(
                    &decode_persistent_inode(*ino, value)?,
                )?);
            }
            OverlayKey::Dirent { parent, name } => {
                let index = timestamps
                    .iter()
                    .find_map(|(index, _)| {
                        state
                            .get(*index)
                            .filter(|inode| inode.ino == *parent)
                            .map(|_| *index)
                    })
                    .ok_or(Errno::EIO)?;
                let InodeKind::Dir(entries) = &state.get(index).ok_or(Errno::EIO)?.kind else {
                    return Err(Errno::EIO);
                };
                if !parents.contains(&index) {
                    parents.push(index);
                }
                if let Some(target) = entries.get(name) {
                    if let Some((_, count)) = outgoing.iter_mut().find(|(index, _)| index == target)
                    {
                        *count += 1;
                    } else {
                        outgoing.push((*target, 1));
                    }
                }
            }
            _ => return Err(Errno::EIO),
        }
    }
    for index in parents {
        let inode = state.get(index).ok_or(Errno::EIO)?;
        let InodeKind::Dir(entries) = &inode.kind else {
            return Err(Errno::EIO);
        };
        projected += i128::from(persistent_directory_blocks_after(
            inode.ino, entries, mutations,
        )?) - i128::from(persistent_inode_blocks(inode)?);
    }
    let mut retired = crate::IoBuffer::try_with_capacity(outgoing.len())?;
    for (index, removed) in outgoing {
        let inode = state.get(index).ok_or(Errno::EIO)?;
        let mut added = 0u64;
        for mutation in mutations {
            if let Mutation::Put {
                key: OverlayKey::Dirent { .. },
                value,
            } = mutation
            {
                let target =
                    u64::from_le_bytes(value.as_slice().try_into().map_err(|_| Errno::EIO)?);
                added += u64::from(target == inode.ino);
            }
        }
        let remaining = if inode.is_dir() {
            u64::from(added >= u64::from(removed))
        } else {
            u64::from(inode.nlink)
                .checked_add(added)
                .and_then(|links| links.checked_sub(u64::from(removed)))
                .ok_or(Errno::EIO)?
        };
        if remaining == 0 && inode.open_count == 0 && inode.map_pins == 0 {
            projected -= i128::from(persistent_inode_blocks(inode)?);
            retired.push(index);
        }
    }
    if retired.iter().any(|index| {
        state
            .get(*index)
            .is_some_and(|inode| persistent_deferred_record_bytes(inode) != 0)
    }) {
        projected += i128::from(blocks_for_file(persistent_deferred_section_bytes(
            state, &retired,
        )?)) - i128::from(blocks_for_file(persistent_deferred_section_bytes(
            state,
            &[],
        )?));
    }
    u64::try_from(projected).map_err(|_| Errno::EIO)
}

fn persistent_statfs() -> Result<WasmStatfs, Errno> {
    let mut active = PERSISTENT_ROOTFS.lock();
    let journal = &mut active.as_mut().ok_or(Errno::EIO)?.journal;
    if let Some(error) = journal.recorded_error() {
        return Err(error);
    }
    ROOTFS.with(|state| {
        let geometry = state.image.ok_or(Errno::EIO)?;
        let capacity_blocks = geometry.capacity_bytes.div_ceil(4096);
        let max_blocks = u32::try_from(capacity_blocks).map_err(|_| Errno::EIO)?;
        let total = match state.persistent_allocated_blocks {
            Some(total) => total,
            None => {
                let mut total = u64::from(planned_data_start_with_inodes(max_blocks, geometry.image.total_inodes));
                for inode in state.inodes.iter().flatten() {
                    total = total.checked_add(persistent_inode_blocks(inode)?).ok_or(Errno::EIO)?;
                }
                let deferred_bytes = persistent_deferred_section_bytes(state, &[])?;
                total = total.checked_add(blocks_for_file(deferred_bytes)).ok_or(Errno::EIO)?;
                state.persistent_allocated_blocks = Some(total);
                total
            }
        };
        let (inodes, free_inodes) = state.image_inode_counts().ok_or(Errno::EIO)?;
        let free_blocks = capacity_blocks.saturating_sub(total);
        Ok(WasmStatfs {
            f_type: crate::kandelo_image_fs::KANDELO_IMAGE_SUPER_MAGIC,
            f_bsize: 4096,
            f_blocks: capacity_blocks,
            f_bfree: free_blocks,
            f_bavail: free_blocks,
            f_files: inodes,
            f_ffree: free_inodes,
            f_fsid: 0,
            f_namelen: 255,
            f_frsize: 4096,
            f_flags: if is_nosuid() {
                wasm_posix_shared::statfs_flags::ST_NOSUID
            } else {
                0
            },
            _pad: 0,
        })
    })
}

// ---------------------------------------------------------------------------
// Tree export (RXPT): serialize the overlay-owned `/` tree's METADATA. This is
// a metadata-only view of the authoritative overlay state; its caller is the
// host test suite (`host/test/rootfs-image-load.test.ts`, through
// `kernel_rootfs_export_tree`). The image a builder or the host's
// `handleExportRootfsImage` saves comes from `export_container_read` below.
//
// Wire format (little-endian) — a reader must mirror it:
//   header: magic u32 = "RXPT" | version u32 = 1 | entry_count u32
//   entry:  kind u8 | mode u32 (0o7777 perm bits) | uid u32 | gid u32
//           mtime_sec u64 | mtime_nsec u32 | size u64
//           path_len u32 | path[path_len]   (absolute, "/" first)
//           target_len u32 | target[target_len]   (symlink target; else empty)
// Entries are emitted pre-order (parent before child) in the directory's
// BTreeMap order, so the layout is deterministic across chunked reads.
//
// File *bytes* are intentionally absent: a reader that needs copy-on-written
// bytes reads them through `kernel_rootfs_read_file`, and base-file/lazy bytes
// stay where the base image keeps them (so a not-yet-materialized lazy file is
// never force-fetched just to describe the tree).
// ---------------------------------------------------------------------------

pub const EXPORT_MAGIC: u32 = 0x5450_5852; // "RXPT" little-endian
pub const EXPORT_VERSION: u32 = 1;
/// A directory node.
pub const EXPORT_KIND_DIR: u8 = 1;
/// A base regular file (bytes live in the frozen base image; unchanged).
pub const EXPORT_KIND_BASE_REGULAR: u8 = 2;
/// A copy-on-written or runtime-created regular file (bytes owned by the
/// overlay; the host reads them via `kernel_rootfs_read_file`).
pub const EXPORT_KIND_COW_REGULAR: u8 = 3;
/// A symbolic link (target bytes follow in the record's `target` field).
pub const EXPORT_KIND_SYMLINK: u8 = 4;
/// A metadata-only special node (socket/FIFO). Not representable in a `/`
/// image; the host records it as skipped rather than fabricating bytes.
pub const EXPORT_KIND_SPECIAL: u8 = 5;
/// A lazy-archive member not yet materialized (bytes stay in the base image's
/// lazy archive; the host preserves the linkage rather than fetching).
pub const EXPORT_KIND_LAZY_MEMBER: u8 = 6;

#[cfg(test)]
fn export_emit(out: &mut Vec<u8>, inode: &Inode, abs_path: &[u8]) {
    let (kind, target): (u8, &[u8]) = match &inode.kind {
        InodeKind::Dir(_) => (EXPORT_KIND_DIR, b""),
        InodeKind::BaseRegular { .. } => (EXPORT_KIND_BASE_REGULAR, b""),
        InodeKind::Regular(_) | InodeKind::PersistentRegular => (EXPORT_KIND_COW_REGULAR, b""),
        InodeKind::Symlink(t) => (EXPORT_KIND_SYMLINK, t.as_slice()),
        InodeKind::Special(_) => (EXPORT_KIND_SPECIAL, b""),
        InodeKind::LazyMember { .. } => (EXPORT_KIND_LAZY_MEMBER, b""),
    };
    let size = inode.stat().st_size;
    out.push(kind);
    out.extend_from_slice(&(inode.mode & 0o7777).to_le_bytes());
    out.extend_from_slice(&inode.uid.to_le_bytes());
    out.extend_from_slice(&inode.gid.to_le_bytes());
    out.extend_from_slice(&inode.mtime_sec.to_le_bytes());
    out.extend_from_slice(&inode.mtime_nsec.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&(abs_path.len() as u32).to_le_bytes());
    out.extend_from_slice(abs_path);
    out.extend_from_slice(&(target.len() as u32).to_le_bytes());
    out.extend_from_slice(target);
}

#[cfg(test)]
fn export_walk(state: &RootfsState, idx: u32, abs_path: &[u8], out: &mut Vec<u8>, count: &mut u32) {
    let Some(inode) = state.get(idx) else {
        return;
    };
    export_emit(out, inode, abs_path);
    *count += 1;
    if let InodeKind::Dir(entries) = &inode.kind {
        for (name, &child) in entries.iter() {
            let mut child_path = Vec::with_capacity(abs_path.len() + 1 + name.len());
            if abs_path == b"/" {
                child_path.push(b'/');
            } else {
                child_path.extend_from_slice(abs_path);
                child_path.push(b'/');
            }
            child_path.extend_from_slice(name);
            export_walk(state, child, &child_path, out, count);
        }
    }
}

/// Serialize the entire overlay-owned `/` tree into an RXPT metadata buffer (see
/// the format doc above). Only inodes the overlay actually owns are present:
/// foreign mounts and tmpfs scratch keep their bytes in their own subsystems and
/// are never inserted here, so a raw pre-order walk already excludes them while
/// preserving mount-point directories (e.g. an empty `/dev`) exactly as the base
/// image carried them.
#[cfg(test)]
pub fn export_tree() -> Vec<u8> {
    ROOTFS.with(|state| {
        let mut out = Vec::new();
        out.extend_from_slice(&EXPORT_MAGIC.to_le_bytes());
        out.extend_from_slice(&EXPORT_VERSION.to_le_bytes());
        let count_pos = out.len();
        out.extend_from_slice(&0u32.to_le_bytes()); // entry_count placeholder
        let mut count = 0u32;
        if let Some(root) = state.root {
            export_walk(state, root, b"/", &mut out, &mut count);
        }
        out[count_pos..count_pos + 4].copy_from_slice(&count.to_le_bytes());
        out
    })
}

/// Stream summary for [`export_tree_read`]. Each chunk uses admitted traversal
/// scratch rather than retaining the serialized namespace. Export runs only
/// against a quiescent overlay (the host closes the snapshot gate), so the
/// tree cannot change between chunks. EOF, reset and cancellation clear it.
struct ExportCache {
    locked: AtomicBool,
    buf: UnsafeCell<Option<metadata_export::TreeSummary>>,
}

impl ExportCache {
    const fn new() -> Self {
        ExportCache {
            locked: AtomicBool::new(false),
            buf: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Option<metadata_export::TreeSummary>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: same invariant as RootfsGlobal — the spinlock is the sole gate
        // and no reference escapes the closure.
        let slot = unsafe { &mut *self.buf.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / ForeignMounts.
unsafe impl Sync for ExportCache {}

static EXPORT_CACHE: ExportCache = ExportCache::new();

/// Copy up to `out.len()` bytes of the overlay tree export at byte `offset` into
/// `out`, returning the number of bytes copied (0 at end of the buffer). The
/// `offset == 0` call starts the quiescent stream; later calls serialize their
/// range from the same tree without retaining a namespace-sized buffer.
pub fn export_tree_read(offset: i64, out: &mut [u8]) -> Result<usize, Errno> {
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    EXPORT_CACHE.with(|cache| {
        if offset == 0 {
            *cache = None;
        } else if cache.is_none() {
            return Ok(0);
        }
        if cache.as_ref().is_some_and(|summary| offset >= summary.length) {
            *cache = None;
            return Ok(0);
        }
        let (summary, count) = metadata_export::read_tree(offset, out, *cache)?;
        *cache = Some(summary);
        Ok(count)
    })
}

// ---------------------------------------------------------------------------
// Image export: emit a real KIFS `/` image from the authoritative overlay
// tree, streamed.
//
// WHAT THE KERNEL WRITES, AND WHAT IT ONLY CARRIES
//
// `export_tree` above serializes tree METADATA (RXPT), and the host rebuilds an
// image from it by cloning the frozen base image and reconciling
// (`host/src/vfs/rootfs-overlay-export.ts`). That host step is what W-4
// deletes. What moves here is the part the kernel is the authority for: the
// filesystem body. The container's three JSON sections stay host-side ON
// PURPOSE — they carry fetch URLs, transports, integrity digests, activation
// modes and atomic-group seals, which the kernel's image description has
// deliberately never carried. The kernel is downstream of the host's decision
// about which bytes it may hand over, and inventing a URL to write into an
// image would invert that.
//
// WHY IT STREAMS
//
// `lamp.vfs` is 249 MiB. `export_tree_read` caches its whole buffer because
// tree metadata is small; an image is not. So the build pass produces only the
// image's STRUCTURE — superblock, bitmaps, inode table, directory data,
// indirect blocks — and records each file's content as a reference. Bytes are
// pulled per chunk as the cursor reaches them: an image-backed file streams out
// of the `/` image the kernel already has mounted, through the same KIFS reader
// `load_image` walked it with, and is never resident.
// ---------------------------------------------------------------------------

/// Where one emitted file's bytes come from. An entry's index in
/// [`ExportPlan::contents`] is the `id` handed to the writer.
enum ImageContent {
    /// Bytes in the loaded `/` image at KIFS inode N. Streamed.
    Image(u32),
    /// Bytes the overlay owns, at arena index N. Already resident.
    Overlay(u32),
    Persistent {
        inode: u64,
        image_inode: Option<u32>,
        base_size: u64,
    },
}

/// A built image: its structure, plus how to resolve each content reference.
pub struct ExportPlan {
    image: crate::kandelo_image_write::KandeloImage,
    contents: crate::io_buffer::IoBuffer<ImageContent>,
}

impl ExportPlan {
    pub fn len(&self) -> u64 {
        self.image.len()
    }

    pub fn is_empty(&self) -> bool {
        self.image.is_empty()
    }
}

/// Resolves an emitted image's content references while a chunk is served.
struct ExportContentSource<'a, F> {
    contents: &'a [ImageContent],
    byte_source: core::cell::RefCell<&'a mut F>,
    image_read: core::cell::RefCell<ImageReadCursor>,
}

impl<F> crate::kandelo_image_write::ContentSource for ExportContentSource<'_, F>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    fn read_exact_at(&self, id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
        let entry = self
            .contents
            .get(usize::try_from(id).map_err(|_| Errno::EIO)?)
            .ok_or(Errno::EIO)?;
        match entry {
            ImageContent::Image(ino) => {
                let mut byte_source = self.byte_source.borrow_mut();
                let n = self.image_read.borrow_mut().read(*ino, offset, dst, &mut **byte_source)?;
                if n != dst.len() {
                    return Err(Errno::EIO);
                }
                Ok(())
            }
            ImageContent::Overlay(idx) => ROOTFS.with(|state| {
                let inode = state.get(*idx).ok_or(Errno::EIO)?;
                let InodeKind::Regular(data) = &inode.kind else {
                    return Err(Errno::EIO);
                };
                let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
                let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
                dst.copy_from_slice(data.get(start..end).ok_or(Errno::EIO)?);
                Ok(())
            }),
            ImageContent::Persistent { inode, image_inode, base_size } => {
                let mut byte_source = self.byte_source.borrow_mut();
                let read = PERSISTENT_ROOTFS
                    .lock()
                    .as_mut()
                    .ok_or(Errno::EIO)?
                    .journal
                    .read_file_at(*inode, *base_size, offset, dst, |at, bytes| {
                        match image_inode {
                            Some(image_inode) => self.image_read.borrow_mut().read(*image_inode, at, bytes, &mut **byte_source),
                            None => Err(Errno::EIO),
                        }
                    })?;
                if read != dst.len() {
                    return Err(Errno::EIO);
                }
                Ok(())
            }
        }
    }
}

/// One directory entry still to emit.
struct PendingExport {
    overlay: u32,
    parent_out: u32,
    name: OwnedMetadata,
}

/// What an overlay node becomes in the image. Snapshotted out of the store so
/// the writer is never driven while the store is borrowed.
enum ExportNode {
    Dir,
    ImageFile(u32, u64),
    OverlayFile(u32, u64),
    PersistentFile {
        inode: u64,
        image_inode: Option<u32>,
        base_size: u64,
        size: u64,
    },
    /// A deferred file the export can DESCRIBE: an archive member, whose real
    /// size, backing archive and member path the overlay already holds. Written
    /// as a zero-length body inode plus a record in the image's deferred
    /// section, which is what preserves laziness -- materializing the bytes
    /// here is what makes a 249 MiB image impossible.
    LazyMember {
        archive_id: u32,
        source_path: OwnedMetadata,
        size: u64,
        /// The file's own fetch description, when it has one. An archive member
        /// usually does not -- the archive carries the transport -- but a file
        /// fetched STANDALONE (`archive_id == 0`) has nothing else.
        payload: OwnedMetadata,
        /// Where a STANDALONE file's bytes are, and what they must hash to. An
        /// archive member carries no address of its own -- its archive's is the
        /// one and only answer -- so `uri` is empty for one.
        uri: OwnedMetadata,
        digest: [u8; crate::sdef::DIGEST_LEN],
    },
    /// A host-backed base file the loaded image DID describe: the description
    /// was retained verbatim at load, and is re-emitted here under the inode
    /// this export assigns. The kernel never parses it -- it is a courier.
    LazyBase {
        size: u64,
        payload: OwnedMetadata,
        uri: OwnedMetadata,
        digest: [u8; crate::sdef::DIGEST_LEN],
    },
    /// A host-backed base file with no retained description. The kernel has
    /// nothing that says where its bytes are: the blob id is the SOURCE image's
    /// inode number and this export assigns new ones. That is a base file placed
    /// by [`insert_base_file`], whose bytes are ordinary host files
    /// rather than a deferred fetch -- so it is not a missing payload, it is a
    /// file this export cannot serialize at all. It still writes an empty file.
    LazyStub,
    Symlink(OwnedMetadata),
    Special(u32),
}

/// The `data_start` `KandeloImageWriter::mkfs` will derive from `max_blocks`.
///
/// Duplicated here, deliberately and narrowly, because the image's LENGTH has
/// to be chosen before `mkfs` runs. Sizing it at `max_blocks` would emit a
/// 480 MiB container for a 249 MiB tree; sizing it too small would make every
/// image pay hundreds of 256-block growth steps.
fn planned_data_start(max_blocks: u32) -> u32 {
    let mut total_inodes = core::cmp::max(32, max_blocks / 4);
    total_inodes = total_inodes.div_ceil(32) * 32;
    planned_data_start_with_inodes(max_blocks, total_inodes)
}

fn planned_data_start_with_inodes(max_blocks: u32, total_inodes: u32) -> u32 {
    let inode_bitmap_blocks = total_inodes.div_ceil(4096 * 8);
    let block_bitmap_blocks = max_blocks.div_ceil(4096 * 8);
    let inode_table_blocks = total_inodes.div_ceil(32);
    1 + inode_bitmap_blocks + block_bitmap_blocks + inode_table_blocks
}

/// Blocks one file's data occupies, including the indirect blocks that address
/// it. Mirrors the writer's allocation rather than guessing: ten direct blocks,
/// then single-, double-, and triple-indirect pointer trees.
fn blocks_for_file(size: u64) -> u64 {
    let data = size.div_ceil(4096);
    if data <= 10 {
        return data;
    }
    let indirect_data = core::cmp::min(data - 10, 1024);
    let mut total = 10 + indirect_data + 1; // + the single indirect block
    let double_data = core::cmp::min(data - 10 - indirect_data, 1024 * 1024);
    if double_data > 0 {
        let l1 = double_data.div_ceil(1024);
        total += double_data + l1 + 1;
    }
    let triple_data = data - 10 - indirect_data - double_data;
    if triple_data > 0 {
        total += triple_data
            + triple_data.div_ceil(1024)
            + triple_data.div_ceil(1024 * 1024)
            + 1;
    }
    total
}

#[derive(Default)]
struct SparseFileBlockCounter {
    blocks: u64,
    indirect: bool,
    double_indirect: bool,
    triple_indirect: bool,
    last_double_group: Option<u32>,
    last_triple_top: Option<u64>,
    last_triple_leaf: Option<u64>,
}

impl SparseFileBlockCounter {
    fn push(&mut self, block: u32) {
        self.blocks += 1;
        if block >= 10 + 1024 + 1024 * 1024 {
            self.triple_indirect = true;
            let relative = (block - 10 - 1024 - 1024 * 1024) as u64;
            let top = relative / (1024 * 1024);
            let leaf = relative / 1024;
            if self.last_triple_top != Some(top) {
                self.blocks += 1;
                self.last_triple_top = Some(top);
            }
            if self.last_triple_leaf != Some(leaf) {
                self.blocks += 1;
                self.last_triple_leaf = Some(leaf);
            }
        } else if block >= 10 + 1024 {
            self.double_indirect = true;
            let group = (block - 10 - 1024) / 1024;
            if self.last_double_group != Some(group) {
                self.blocks += 1;
                self.last_double_group = Some(group);
            }
        } else if block >= 10 {
            self.indirect = true;
        }
    }

    fn total(self) -> u64 {
        self.blocks + u64::from(self.indirect) + u64::from(self.double_indirect) + u64::from(self.triple_indirect)
    }
}

/// Collect a directory's children onto the walk stack in reverse, so popping
/// yields the directory's own `BTreeMap` order. The emitted image is therefore
/// deterministic for a given tree, which is what lets it be compared at all.
fn push_export_children(
    overlay_dir: u32,
    parent_out: u32,
    stack: &mut crate::io_buffer::IoBuffer<PendingExport>,
) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        let inode = state.get(overlay_dir).ok_or(Errno::EIO)?;
        let InodeKind::Dir(entries) = &inode.kind else {
            return Err(Errno::ENOTDIR);
        };
        for (name, &child) in entries.iter().rev() {
            stack.try_push(PendingExport {
                overlay: child,
                parent_out,
                name: own_export_metadata(name)?,
            })?;
        }
        Ok(())
    })
}

fn own_export_metadata(bytes: &[u8]) -> Result<OwnedMetadata, Errno> {
    OwnedMetadata::copy_from(&crate::io_buffer::IO_MEMORY, bytes)
}

fn insert_export_identity(
    identities: &mut crate::prepared_map::PreparedMap<u32, u32>,
    key: u32,
    value: u32,
) -> Result<(), Errno> {
    let budget = &crate::io_buffer::IO_MEMORY;
    let reservation = crate::prepared_map::PreparedEntry::<u32, u32>::reserve_in(budget, 0)?;
    let prepared = crate::prepared_map::PreparedEntry::new_reserved_in(budget, key, value, reservation)?;
    identities.insert_prepared(prepared);
    Ok(())
}

/// Copy ownership, permissions and timestamps from the overlay inode onto the
/// emitted one.
///
/// Ownership goes first: `chown` clears a regular file's set-user and set-group
/// bits, so applying the mode afterwards is what preserves a setuid binary —
/// the same ordering the image builders use. Timestamps go last, because every
/// mutation before them stamps ctime.
fn apply_export_metadata(
    writer: &mut crate::kandelo_image_write::KandeloImageWriter,
    overlay: u32,
    out_ino: u32,
) -> Result<(), Errno> {
    let (uid, gid, mode, is_symlink, atime, mtime, ctime) = ROOTFS.with(|state| {
        let inode = state.get(overlay).ok_or(Errno::EIO)?;
        let ms = |sec: u64, nsec: u32| sec.saturating_mul(1000) + u64::from(nsec) / 1_000_000;
        Ok::<_, Errno>((
            inode.uid,
            inode.gid,
            inode.mode,
            matches!(inode.kind, InodeKind::Symlink(_)),
            ms(inode.atime_sec, inode.atime_nsec),
            ms(inode.mtime_sec, inode.mtime_nsec),
            ms(inode.ctime_sec, inode.ctime_nsec),
        ))
    })?;
    writer.set_owner(out_ino, uid, gid)?;
    // A symlink's permission bits are not meaningful and the writer fixes them
    // at 0777, as the KIFS format has always written them; overwriting them
    // would diverge from every existing image.
    if !is_symlink {
        writer.set_mode(out_ino, mode)?;
    }
    match ROOTFS.with(|state| state.export_timestamp_ms) {
        Some(fixed) => writer.set_times(out_ino, fixed, fixed, fixed),
        None => writer.set_times(out_ino, atime, mtime, ctime),
    }?;
    Ok(())
}

/// Walk the overlay and build a complete KIFS image for it.
///
/// The walk uses an explicit stack, not recursion, for the same reason
/// [`load_image`]'s does: tree depth is untrusted input in a browser and the
/// kernel has no guard page under its shadow stack. `export_tree`'s walk
/// recurses because it predates that rule; a new walk should not adopt it.
pub fn build_export_image(
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<ExportPlan, Errno> {
    let preserve_capacity = fixed_persistence_enabled();
    let result = build_export_image_with_capacity(preserve_capacity, byte_source);
    if matches!(result, Err(Errno::ENOMEM)) {
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        reclaim_io_read_caches(None);
        if crate::io_buffer::IO_MEMORY.usage().0 < used {
            return build_export_image_with_capacity(preserve_capacity, byte_source);
        }
    }
    result
}

fn build_export_image_with_capacity(
    preserve_capacity: bool,
    mut byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<ExportPlan, Errno> {
    use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter};
    let persistent = fixed_persistence_enabled();
    // Pass one: size the image, under a single borrow so the tree cannot be
    // observed in two states.
    let (inode_count, data_blocks, oversized_file) = ROOTFS.with(|state| {
        let mut inode_count = 0u64;
        let mut data_blocks = 0u64;
        let mut oversized_file = false;
        let mut count_file = |size: u64| {
            if size > crate::kandelo_image_write::MAX_FILE_BYTES {
                oversized_file = true;
                0
            } else {
                blocks_for_file(size)
            }
        };
        let mut stack = crate::io_buffer::IoBuffer::new();
        let mut seen = crate::prepared_map::PreparedMap::default();
        if let Some(root) = state.root {
            stack.try_push(root)?;
        }
        while let Some(idx) = stack.pop() {
            let Some(inode) = state.get(idx) else { continue };
            if seen.contains_key(&idx) {
                continue; // a hard link: one inode, already counted
            }
            insert_export_identity(&mut seen, idx, 0)?;
            inode_count += 1;
            match &inode.kind {
                InodeKind::Dir(entries) => {
                    // Records are 12 bytes at minimum; 40 is a generous mean
                    // that keeps the estimate above reality for real trees.
                    data_blocks += ((entries.len() as u64 * 40) + 24).div_ceil(4096).max(1);
                    for &child in entries.values() {
                        stack.try_push(child)?;
                    }
                }
                InodeKind::BaseRegular { blob_id, size, source } => {
                    if matches!(source, BaseSource::Image) {
                        let journal_backed = persistent
                            && inode.deferred_digest == crate::sdef::DIGEST_NONE
                            && inode.mode & 0o6000 == 0;
                        let export_size = if journal_backed {
                            inode.persistent_size.unwrap_or(*size)
                        } else {
                            *size
                        };
                        if export_size > crate::kandelo_image_write::MAX_FILE_BYTES {
                            let _ = count_file(export_size);
                        } else if journal_backed || !persistent {
                            data_blocks += inode.allocated_blocks;
                        } else if inode.base_dense {
                            data_blocks += count_file(export_size);
                        } else {
                            let mut counter = SparseFileBlockCounter::default();
                            with_image_file_allocations(state.image.ok_or(Errno::EIO)?, image_ino(*blob_id)?,
                                0..export_size.div_ceil(4096), &mut byte_source, |next_base| {
                                    while let Some(block) = next_base()? { counter.push(block); }
                                    Ok(())
                                })?;
                            data_blocks += counter.total();
                        }
                    }
                    // A `Host`-sourced base file stays a lazy stub: no blocks.
                }
                InodeKind::Regular(data) => data_blocks += count_file(data.len() as u64),
                InodeKind::PersistentRegular => {
                    let size = inode.persistent_size.unwrap_or(0);
                    if size > crate::kandelo_image_write::MAX_FILE_BYTES {
                        let _ = count_file(size);
                    } else {
                        data_blocks += inode.allocated_blocks;
                    }
                }
                InodeKind::Symlink(target) => {
                    if target.len() as u64 > 40 {
                        data_blocks += count_file(target.len() as u64);
                    }
                }
                InodeKind::Special(_) | InodeKind::LazyMember { .. } => {}
            }
        }
        Ok::<_, Errno>((inode_count, data_blocks, oversized_file))
    })?;
    if oversized_file {
        return Err(Errno::EFBIG);
    }
    // Inodes drive `total_inodes = max_blocks / 4`, so a tree of many tiny
    // files can need a larger maximum than its bytes do.
    let inode_requirement = (inode_count + 2).saturating_mul(4);
    // A requested capacity enters here as a FLOOR rather than replacing the
    // computation: the tree's own requirement still has to be met, and the loop
    // below still converges `data_start` against whichever is larger. Replacing
    // it would let a small request produce an image that cannot hold its own
    // contents.
    let requested_blocks = ROOTFS
        .with(|state| state.image_capacity_bytes)
        .map(|bytes| bytes.div_ceil(4096))
        .unwrap_or(0);
    let mounted_capacity = if preserve_capacity {
        ROOTFS.with(|state| state.image.map(|image| (
            image.capacity_bytes.div_ceil(4096),
            image.image.total_inodes,
        )))
    } else {
        None
    };
    if mounted_capacity.is_some_and(|(_, inodes)| inode_count + 2 > u64::from(inodes)) {
        return Err(Errno::ENOSPC);
    }
    let builder_capacity = core::cmp::max(
        core::cmp::max(inode_requirement, 64),
        requested_blocks,
    );
    let mut max_blocks = u32::try_from(
        mounted_capacity.map_or(builder_capacity, |(blocks, _)| blocks),
    ).map_err(|_| Errno::EIO)?;
    let mut data_start = match mounted_capacity {
        Some((_, inodes)) => planned_data_start_with_inodes(max_blocks, inodes),
        None => planned_data_start(max_blocks),
    };
    // One or two rounds converge: a larger maximum needs a larger block bitmap,
    // which pushes `data_start` out, which needs a larger maximum.
    for _ in 0..4 {
        let needed = u32::try_from(u64::from(data_start) + data_blocks + 64)
            .map_err(|_| Errno::EIO)?;
        if needed <= max_blocks || mounted_capacity.is_some() {
            break;
        }
        max_blocks = needed;
        data_start = planned_data_start(max_blocks);
    }
    let total_blocks = core::cmp::min(
        max_blocks,
        u32::try_from(u64::from(data_start) + data_blocks + 64).map_err(|_| Errno::EIO)?,
    );
    let total_blocks = core::cmp::max(total_blocks, 16);

    let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
        size_bytes: u64::from(total_blocks) * 4096,
        max_size_bytes: Some(u64::from(max_blocks) * 4096),
        // The kernel chooses this image's length; nothing caps growth but the
        // maximum above, so an underestimate costs a grow, not a failure.
        growable_to_bytes: u64::from(max_blocks) * 4096,
        // The writer's clock, which stamps the inodes IT creates -- the root
        // above all, which `mkfs` makes before the walk starts and which the
        // walk therefore never re-stamps. A normalised export has to set this
        // too, or the root carries 0 while every other inode carries the
        // requested instant, and the artifact is reproducible everywhere except
        // its own root directory. With no requested instant it is Kandelo's
        // reference instant, not 0: directories this walk fills are re-stamped
        // by the writer as their entries are added, and 0 reads as "no
        // timestamp" to the software that later stats them.
        now_ms: ROOTFS
            .with(|state| state.export_timestamp_ms)
            .unwrap_or(wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS),
    }, mounted_capacity.map(|(_, inodes)| inodes))?;
    // The kernel writes its deferred files into the body, so an export with
    // none says so explicitly rather than staying silent — silence is what
    // `load_image` refuses, and an image this kernel wrote must be one it can
    // read back.
    writer.declare_deferred_section()?;

    let mut contents = crate::io_buffer::IoBuffer::new();
    // Overlay arena index -> the KIFS inode it became, so the second and later
    // names for a hard-linked inode become a `link` rather than a second copy.
    let mut emitted = crate::prepared_map::PreparedMap::default();
    // Archives already declared to the writer, so one is declared once however
    // many of its members the tree holds.
    let mut declared_archives = crate::prepared_map::PreparedMap::default();

    let root_idx = ROOTFS.with(|state| state.root).ok_or(Errno::EIO)?;
    let root_out = writer.root();
    apply_export_metadata(&mut writer, root_idx, root_out)?;
    insert_export_identity(&mut emitted, root_idx, root_out)?;

    let mut stack = crate::io_buffer::IoBuffer::new();
    push_export_children(root_idx, root_out, &mut stack)?;

    while let Some(item) = stack.pop() {
        let (node, mode, already) = ROOTFS.with(|state| {
            let inode = state.get(item.overlay).ok_or(Errno::EIO)?;
            let node = match &inode.kind {
                InodeKind::Dir(_) => ExportNode::Dir,
                InodeKind::BaseRegular {
                    blob_id,
                    size,
                    source,
                } => match source {
                    BaseSource::Image if persistent
                        && inode.deferred_digest == crate::sdef::DIGEST_NONE
                        && inode.mode & 0o6000 == 0 => ExportNode::PersistentFile {
                            inode: inode.ino,
                            image_inode: Some(image_ino(*blob_id)?),
                            base_size: *size,
                            size: inode.persistent_size.unwrap_or(*size),
                        },
                    BaseSource::Image => ExportNode::ImageFile(image_ino(*blob_id)?, *size),
                    // The image does not carry these bytes; the host owns the
                    // transport. Keep the file lazy rather than force-fetching
                    // it, which is the behaviour the host reconciler documents.
                    BaseSource::Host => {
                        // Deferredness decides, not the description. A file
                        // that IS deferred re-exports as deferred even when the
                        // image it came from said nothing about where its bytes
                        // live -- that is exactly as informative as the input
                        // was, and `KLZY` inputs are never more informative
                        // than that. Emitting a stub instead would turn a
                        // 4,242-byte binary into an empty file and call the
                        // export a success.
                        if inode.deferred_base || !inode.deferred_payload.is_empty() {
                            ExportNode::LazyBase {
                                size: *size,
                                payload: own_export_metadata(&inode.deferred_payload)?,
                                uri: own_export_metadata(&inode.deferred_uri)?,
                                digest: inode.deferred_digest,
                            }
                        } else {
                            ExportNode::LazyStub
                        }
                    }
                },
                InodeKind::Regular(data) => {
                    ExportNode::OverlayFile(item.overlay, data.len() as u64)
                }
                InodeKind::PersistentRegular => {
                    ExportNode::PersistentFile {
                        inode: inode.ino,
                        image_inode: None,
                        base_size: 0,
                        size: inode.persistent_size.unwrap_or(0),
                    }
                }
                InodeKind::Symlink(target) => ExportNode::Symlink(own_export_metadata(target)?),
                InodeKind::Special(type_bits) => ExportNode::Special(*type_bits),
                InodeKind::LazyMember {
                    archive_id,
                    source_path,
                    size,
                } => ExportNode::LazyMember {
                    archive_id: *archive_id,
                    source_path: own_export_metadata(source_path)?,
                    size: *size,
                    payload: own_export_metadata(&inode.deferred_payload)?,
                    uri: own_export_metadata(&inode.deferred_uri)?,
                    digest: inode.deferred_digest,
                },
            };
            Ok::<_, Errno>((node, inode.mode, emitted.get(&item.overlay).copied()))
        })?;

        if let Some(existing) = already {
            // A second name for an inode already emitted: one hard link.
            writer.link(item.parent_out, &item.name, existing)?;
            continue;
        }

        let out_ino = match node {
            ExportNode::Special(type_bits) => {
                writer.mknod_special(item.parent_out, &item.name, mode, type_bits)?
            }
            ExportNode::Dir => {
                let ino = writer.mkdir(item.parent_out, &item.name, mode)?;
                push_export_children(item.overlay, ino, &mut stack)?;
                ino
            }
            ExportNode::Symlink(target) => {
                writer.symlink(item.parent_out, &item.name, &target)?
            }
            ExportNode::LazyMember {
                archive_id,
                source_path,
                size,
                payload,
                uri,
                digest,
            } => {
                // Declare the archive before the first record that points into
                // it. The length comes from the archive table this kernel
                // loaded; without it the record would be a dangling reference
                // and `encode` would refuse the whole section — which is the
                // behaviour we want, but the export should not have built an
                // image it cannot finish.
                //
                // `archive_id == 0` has no archive to declare: the file is
                // fetched standalone and its own payload says where from.
                if archive_id != 0 && !declared_archives.contains_key(&archive_id) {
                    let (bytes, payload, uri, digest) = ROOTFS
                        .with(|state| {
                            let entry = state.archives.get(&archive_id).ok_or(Errno::EIO)?;
                            Ok::<_, Errno>((
                                entry.size,
                                own_export_metadata(&entry.payload)?,
                                own_export_metadata(&entry.uri)?,
                                entry.digest,
                            ))
                        })?;
                    writer.declare_lazy_archive(archive_id, bytes, &uri, &digest, &payload)?;
                    insert_export_identity(&mut declared_archives, archive_id, 0)?;
                }
                // Usually empty: an archive MEMBER has no fetch description of
                // its own, because the archive carries the transport and the
                // two linkage fields beside this one locate the member inside
                // it. A file fetched standalone has nothing else, and its
                // payload is the whole of what says where its bytes are.
                writer.create_deferred_file(
                    item.parent_out,
                    &item.name,
                    mode,
                    size,
                    archive_id,
                    &source_path,
                    &uri,
                    &digest,
                    &payload,
                )?
            }
            ExportNode::LazyBase {
                size,
                payload,
                uri,
                digest,
            } => {
                // No archive linkage: these bytes are fetched standalone, which
                // is exactly what `archive_id == 0` with an empty member path
                // means. The URI is the whole of what says where they are; the
                // payload is passed through without being read.
                writer.create_deferred_file(
                    item.parent_out,
                    &item.name,
                    mode,
                    size,
                    0,
                    b"",
                    &uri,
                    &digest,
                    &payload,
                )?
            }
            ExportNode::LazyStub => {
                // A lazy stub is what `open(O_CREAT)` plus a forced truncate
                // produced in the KIFS images that predate this writer, which
                // lands on the same bytes as a created empty file: size 0,
                // data-sequence 1.
                writer.create_file(item.parent_out, &item.name, mode, Content::Bytes(b""))?
            }
            ExportNode::ImageFile(image_inode, size) => {
                let id = contents.len() as u64;
                contents.try_push(ImageContent::Image(image_inode))?;
                let dense = ROOTFS.with(|state| state.get(item.overlay)
                    .map(|inode| inode.base_dense).ok_or(Errno::EIO))?;
                if dense {
                    writer.create_file(item.parent_out, &item.name, mode, Content::Deferred { id, len: size })?
                } else {
                    writer.create_sparse_file_from(item.parent_out, &item.name, mode, id, size, |visit| {
                        let geometry = ROOTFS.with(|state| state.image).ok_or(Errno::EIO)?;
                        with_image_file_allocations(geometry, image_inode, 0..size.div_ceil(4096),
                            &mut byte_source, |next_base| {
                                while let Some(block) = next_base()? {
                                    visit(block)?;
                                }
                                Ok(())
                            })
                    })?
                }
            }
            ExportNode::OverlayFile(overlay_idx, size) => {
                let id = contents.len() as u64;
                contents.try_push(ImageContent::Overlay(overlay_idx))?;
                writer.create_file(
                    item.parent_out,
                    &item.name,
                    mode,
                    Content::Deferred { id, len: size },
                )?
            }
            ExportNode::PersistentFile { inode, image_inode, base_size, size } => {
                let id = contents.len() as u64;
                contents.try_push(ImageContent::Persistent { inode, image_inode, base_size })?;
                let dense = ROOTFS.with(|state| state.get(item.overlay)
                    .map(|inode| inode.allocated_blocks == blocks_for_file(size)).ok_or(Errno::EIO))?;
                if dense {
                    writer.create_file(item.parent_out, &item.name, mode, Content::Deferred { id, len: size })?
                } else {
                    writer.create_sparse_file_from(item.parent_out, &item.name, mode, id, size, |visit| {
                        let mut mount = PERSISTENT_ROOTFS.lock();
                        let journal = &mut mount.as_mut().ok_or(Errno::EIO)?.journal;
                        ROOTFS.with(|state| visit_composed_inode_allocations(journal,
                            state.get(item.overlay).ok_or(Errno::EIO)?, state.image, base_size, size,
                            0..size.div_ceil(4096), &mut byte_source, |block| {
                                visit(block)?;
                                Ok(true)
                            }))
                    })?
                }
            }
        };

        insert_export_identity(&mut emitted, item.overlay, out_ino)?;
        apply_export_metadata(&mut writer, item.overlay, out_ino)?;
    }

    drop(stack);
    drop(emitted);
    drop(declared_archives);
    Ok(ExportPlan {
        image: writer.finish()?,
        contents,
    })
}

/// Cache for [`export_image_read`]: the built image's STRUCTURE, not its bytes.
/// Content stays in the `/` image and the overlay and is pulled per chunk, so
/// this holds megabytes for a 249 MiB image rather than 249 MiB.
struct ImageExportCache {
    locked: AtomicBool,
    plan: UnsafeCell<Option<ExportPlan>>,
}

impl ImageExportCache {
    const fn new() -> Self {
        ImageExportCache {
            locked: AtomicBool::new(false),
            plan: UnsafeCell::new(None),
        }
    }

    fn with<R>(&'static self, f: impl FnOnce(&mut Option<ExportPlan>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        let _unlock = UnlockOnDrop(&self.locked);
        // SAFETY: same invariant as RootfsGlobal — the spinlock is the sole
        // gate and no reference escapes the closure.
        let slot = unsafe { &mut *self.plan.get() };
        f(slot)
    }
}

// SAFETY: identical invariant to RootfsGlobal / ExportCache.
unsafe impl Sync for ImageExportCache {}

static IMAGE_EXPORT_CACHE: ImageExportCache = ImageExportCache::new();

/// Copy up to `out.len()` bytes of the exported `/` image at byte `offset`,
/// returning the number of bytes copied (0 at or past the end).
///
/// The `offset == 0` call builds the image; later calls stream from it. Export
/// runs against a quiescent overlay (the host closes the snapshot gate), so the
/// tree cannot change between chunks. The plan is freed once a read reaches the
/// end, so a completed export leaves nothing resident.
pub fn export_image_read<F>(
    offset: i64,
    out: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let offset = offset as u64;
    if offset == 0 {
        IMAGE_EXPORT_CACHE.with(|slot| -> Result<(), Errno> {
            *slot = None;
            *slot = Some(build_export_image(byte_source)?);
            Ok(())
        })?;
    }
    read_prepared_export_image(offset, out, byte_source)
}

fn read_prepared_export_image<F>(offset: u64, out: &mut [u8], byte_source: &mut F) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    IMAGE_EXPORT_CACHE.with(|slot| {
        let Some(plan) = slot.as_ref() else {
            // A non-zero offset with no plan means the caller never opened the
            // stream, or the stream already ended. Either way there are no
            // bytes, and inventing some would be worse than saying so.
            return Ok(0);
        };
        if offset >= plan.len() {
            *slot = None;
            return Ok(0);
        }
        let source = ExportContentSource {
            contents: &plan.contents,
            byte_source: core::cell::RefCell::new(byte_source),
            image_read: core::cell::RefCell::new(ImageReadCursor::new()),
        };
        plan.image.read_at(&source, offset, out)
    })
}

/// Write this timestamp on every inode the next export emits, instead of the
/// inode's own.
///
/// A build that produces the same tree from the same inputs must produce the
/// same BYTES, or every downstream cache keys on the wall clock. Capacity
/// requests and product writes both stamp live times, so only the detached
/// artifact is normalised -- the tree keeps truthful timestamps while it is
/// being worked on, and the thing that gets published does not carry the
/// minute it was published in.
///
/// `None` clears the request, and the export writes each inode's real times.
pub fn set_export_timestamp(ms: Option<u64>) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.export_timestamp_ms = ms;
    });
    Ok(())
}

/// Ask the next exported image to be capable of growing to `bytes`.
///
/// A FLOOR, not a size: the export still sizes itself to hold the tree, and a
/// request smaller than that is met by the tree's own requirement rather than
/// refused. Zero clears the request.
///
/// Separate from the tree because it is a statement about the ARTIFACT, not
/// about its contents — the same product profile that declares it also checks
/// the published image against it.
pub fn set_image_capacity(bytes: u64) -> Result<(), Errno> {
    ROOTFS.with(|state| {
        state.image_capacity_bytes = if bytes == 0 { None } else { Some(bytes) };
    });
    Ok(())
}

/// One deferred file, as an enumerator sees it.
///
/// The fields are the file's IDENTITY, which is what a builder checking "this
/// step disturbed nothing" compares. `payload` is the opaque fetch description,
/// handed back unread exactly as [`archive_payloads`] hands back an archive's.
#[cfg(test)]
pub struct LazyEntryView {
    pub path: Vec<u8>,
    pub ino: u64,
    pub size: u64,
    /// `0` for a file fetched standalone; otherwise the archive it belongs to.
    pub archive_id: u32,
    /// Empty exactly when `archive_id == 0`.
    pub source_path: Vec<u8>,
    pub payload: Vec<u8>,
    /// Where a STANDALONE file's bytes are. Empty for an archive member, which
    /// is addressed by its archive.
    pub uri: Vec<u8>,
    /// What the file's bytes must hash to, or
    /// [`crate::sdef::DIGEST_NONE`] when the image declared none.
    pub digest: [u8; crate::sdef::DIGEST_LEN],
}

#[cfg(test)]
fn lazy_walk(state: &RootfsState, idx: u32, abs_path: &[u8], out: &mut Vec<LazyEntryView>) {
    let Some(inode) = state.get(idx) else {
        return;
    };
    match &inode.kind {
        InodeKind::LazyMember {
            archive_id,
            source_path,
            size,
        } => out.push(LazyEntryView {
            path: abs_path.to_vec(),
            ino: inode.ino,
            size: *size,
            archive_id: *archive_id,
            source_path: source_path.to_vec(),
            payload: inode.deferred_payload.to_vec(),
            uri: inode.deferred_uri.to_vec(),
            digest: inode.deferred_digest,
        }),
        // A URL-backed lazy file is a BASE file whose bytes the host fetches:
        // `Host`-sourced, with a real size and a fetch description. A base file
        // with no description is an ordinary host-walked file and not deferred
        // at all, which is why the payload -- not the source -- decides.
        InodeKind::BaseRegular { size, source, .. }
            if matches!(source, BaseSource::Host)
                && (inode.deferred_base || !inode.deferred_payload.is_empty()) =>
        {
            out.push(LazyEntryView {
                path: abs_path.to_vec(),
                ino: inode.ino,
                size: *size,
                archive_id: 0,
                source_path: Vec::new(),
                payload: inode.deferred_payload.to_vec(),
                uri: inode.deferred_uri.to_vec(),
                digest: inode.deferred_digest,
            })
        }
        InodeKind::Dir(entries) => {
            for (name, &child) in entries.iter() {
                let mut child_path = Vec::with_capacity(abs_path.len() + 1 + name.len());
                if abs_path == b"/" {
                    child_path.push(b'/');
                } else {
                    child_path.extend_from_slice(abs_path);
                    child_path.push(b'/');
                }
                child_path.extend_from_slice(name);
                lazy_walk(state, child, &child_path, out);
            }
        }
        _ => {}
    }
}

/// Every deferred file in the tree, in path order, with its identity.
///
/// # Why this exists rather than a digest
///
/// The builders' invariant is not "did anything change" but "did anything
/// change OTHER than these", because a build step legitimately supersedes some
/// lazy files -- the mandoc archive replacing a `man` applet, a lazy binary
/// made eager. A digest answers the first question and cannot express the
/// second, and a failure that says only "something moved" sends whoever meets
/// it to read the whole build.
#[cfg(test)]
pub fn lazy_entries() -> Vec<LazyEntryView> {
    ROOTFS.with(|state| {
        let mut out = Vec::new();
        if let Some(root) = state.root {
            lazy_walk(state, root, b"/", &mut out);
        }
        out
    })
}

pub fn serialize_lazy_entries(output: Option<&mut [u8]>) -> Result<usize, Errno> {
    metadata_export::serialize_lazy(output)
}

/// The deduplicated transport cohort of the loaded filesystem, without
/// fetching bodies, rewriting identities, or interpreting opaque descriptors.
/// Each limit is the largest declared resource size for that URI; native
/// materialization still checks each individual file/archive and its digest.
pub fn lazy_resource_limits() -> Result<crate::IoBuffer<(crate::IoBuffer<u8>, u64)>, Errno> {
    ROOTFS.with(|state| {
        let mut resources = crate::IoBuffer::new();
        for inode in state.inodes.iter().flatten() {
            if !inode.deferred_uri.is_empty() {
                resources.try_push((inode.deferred_uri.as_ref(), inode.stat().st_size))?;
            }
        }
        for archive in state.archives.values() {
            if !archive.uri.is_empty() {
                resources.try_push((archive.uri.as_slice(), archive.size))?;
            }
        }
        resources.sort_unstable_by(|left, right| left.0.cmp(right.0));
        let mut unique = 0;
        for read in 0..resources.len() {
            let (uri, size) = resources[read];
            if unique > 0 && resources[unique - 1].0 == uri {
                resources[unique - 1].1 = resources[unique - 1].1.max(size);
            } else {
                resources[unique] = (uri, size);
                unique += 1;
            }
        }
        resources.truncate(unique);
        let mut output = crate::IoBuffer::try_with_capacity(unique)?;
        for (uri, size) in resources { output.push((crate::IoBuffer::copy_from(uri)?, size)); }
        Ok(output)
    })
}

/// Every declared archive, as `(archive_id, fetch description)`.
///
/// The descriptions are opaque here, exactly as they are everywhere else in
/// this file: the kernel carries them and a CONSUMER reads them. This exists so
/// one such consumer — the builder's own filesystem, authenticating an image
/// before deriving from it — can reach them without the format learning to
/// parse what it promises not to.
pub fn archive_payloads() -> Result<crate::IoBuffer<(u32, crate::IoBuffer<u8>)>, Errno> {
    ROOTFS.with(|state| {
        let mut output = crate::IoBuffer::try_with_capacity(state.archives.len())?;
        for (id, entry) in &state.archives {
            output.push((*id, crate::IoBuffer::copy_from(&entry.payload)?));
        }
        Ok(output)
    })
}

/// Every declared archive as `(archive_id, bytes, uri, digest, payload)`.
///
/// The whole of what an image says about an archive, in one pass. It exists
/// because the caller that re-describes archives out of a built tree was
/// reading the URL and the digest by PARSING them back out of the opaque
/// payload — the format's one rule, broken by the layer above it — and could
/// not stop until the typed fields had a way out.
#[cfg(test)]
pub fn archive_descriptions() -> Vec<(u32, u64, Vec<u8>, [u8; crate::sdef::DIGEST_LEN], Vec<u8>)> {
    ROOTFS.with(|state| {
        state
            .archives
            .iter()
            .map(|(id, entry)| {
                (
                    *id,
                    entry.size,
                    entry.uri.clone(),
                    entry.digest,
                    entry.payload.clone(),
                )
            })
            .collect()
    })
}

/// One archive's fetch description, or `None` if no such archive is declared.
///
/// Opaque, like every other reach into this store. The MODULE merges a new
/// description into an existing one, because deciding when two descriptions
/// agree means reading them, and reading them is the format's job.
pub fn archive_payload(archive_id: u32) -> Result<Option<crate::IoBuffer<u8>>, Errno> {
    ROOTFS.with(|state| state.archives.get(&archive_id)
        .map(|entry| crate::IoBuffer::copy_from(&entry.payload)).transpose())
}

/// One archive's address and expected digest, or `None` if no such archive is
/// declared.
///
/// Separate from [`archive_payload`] because these two are NOT opaque: the
/// kernel acts on both. Returning them beside the payload would invite a
/// caller to treat all three the same way, and the whole point of promoting
/// them out of the payload is that they are not the same kind of thing.
pub fn archive_source(
    archive_id: u32,
) -> Option<(Vec<u8>, [u8; crate::sdef::DIGEST_LEN])> {
    ROOTFS.with(|state| {
        state
            .archives
            .get(&archive_id)
            .map(|entry| (entry.uri.clone(), entry.digest))
    })
}

/// Record where an archive is and what its bytes must hash to.
///
/// Separate from [`set_archive_payload`] because the two have different
/// lifetimes: the address and digest are known when the archive is declared and
/// never change, while a payload carrying a cohort seal cannot be completed
/// until the last member is registered. Folding them into one setter would mean
/// every seal rewrite restating an address it has no business restating.
pub fn set_archive_source(archive_id: u32, uri: &[u8], digest: &[u8]) -> Result<(), Errno> {
    if uri.len() > crate::sdef::MAX_URI_LEN as usize {
        return Err(Errno::EINVAL);
    }
    let digest = crate::sdef::digest_from(digest)?;
    ROOTFS.with(|state| match state.archives.get_mut(&archive_id) {
        Some(entry) => {
            entry.uri = own_metadata(uri)?;
            entry.digest = digest;
            Ok(())
        }
        None => Err(Errno::ENOENT),
    })
}

/// Replace one archive's fetch description.
///
/// The payload stays opaque here — this writes back whatever the caller hands
/// over, exactly as [`declare_archive`] did. It exists because the description
/// is not fully knowable at declaration time: a cohort digest covers every
/// member, so the last member must be registered before any member's seal can
/// be completed. The module completes them at export, which means rewriting a
/// payload that was already stored.
pub fn set_archive_payload(archive_id: u32, payload: &[u8]) -> Result<(), Errno> {
    ROOTFS.with(|state| match state.archives.get_mut(&archive_id) {
        Some(entry) => {
            entry.payload = own_metadata(payload)?;
            Ok(())
        }
        None => Err(Errno::ENOENT),
    })
}

/// The image metadata this filesystem currently carries, if any.
///
/// Set by [`set_image_metadata`] or restored by [`load_image`] from what the
/// image declared. Opaque bytes: the kernel stores and emits them without
/// reading them, so this hands back exactly what it was given.
pub fn copy_image_metadata(output: Option<&mut [u8]>) -> Result<usize, Errno> {
    ROOTFS.with(|state| {
        let metadata = state.image_metadata.as_deref().map(Vec::as_slice).unwrap_or_default();
        if let Some(output) = output {
            if output.len() < metadata.len() { return Err(Errno::EINVAL); }
            output[..metadata.len()].copy_from_slice(metadata);
        }
        Ok(metadata.len())
    })
}

pub fn loaded_image_capacity_bytes() -> Option<u64> {
    ROOTFS.with(|state| state.image.map(|image| image.capacity_bytes))
}

/// Set the image-metadata section the next exported container will carry, as
/// opaque bytes.
///
/// The kernel does not read them and has no opinion about their shape — they
/// are the builder's statements about its own artifact (`version`, `kernelAbi`,
/// `createdBy`). It stores them because the CONTAINER is the kernel's to write,
/// and a container the host assembles would be a second author for one format.
///
/// Empty clears it, so a builder can unset without a second entry point.
pub fn set_image_metadata(metadata: &[u8]) -> Result<(), Errno> {
    let len = crate::vfsi_container::MAX_SECTION_LEN as usize;
    if metadata.len() > len {
        return Err(Errno::EINVAL);
    }
    let value = if metadata.is_empty() { None } else { Some(own_metadata(metadata)?) };
    ROOTFS.with(|state| state.image_metadata = value);
    Ok(())
}

pub fn set_image_options(capacity_bytes: u64, timestamp_ms: Option<u64>, metadata: &[u8]) -> Result<(), Errno> {
    if metadata.len() > crate::vfsi_container::MAX_SECTION_LEN as usize { return Err(Errno::EINVAL); }
    let value = if metadata.is_empty() { None } else { Some(own_metadata(metadata)?) };
    ROOTFS.with(|state| {
        state.image_capacity_bytes = if capacity_bytes == 0 { None } else { Some(capacity_bytes) };
        state.export_timestamp_ms = timestamp_ms;
        state.image_metadata = value;
    });
    Ok(())
}

/// The exported image as a whole VFSI **container** — header, body, trailer —
/// offset-addressable and streamed, exactly like [`export_image_read`].
///
/// This is what a builder saves. `export_image_read` yields the KIFS body
/// alone, which is not an image: it has no container header, so nothing can
/// find the filesystem inside it or the sections beside it.
///
/// The container declares **no `KLZY` section**. The body's own `SDEF` section
/// is the description of its deferred files, which is what
/// [`load_image_inner`] now reads — so emitting `KLZY` as well would put two
/// descriptions of one thing into an artifact that should have exactly one.
pub fn export_container_read<F>(
    offset: i64,
    out: &mut [u8],
    byte_source: &mut F,
) -> Result<usize, Errno>
where
    F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
{
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let offset = offset as u64;

    let (flags, trailer_len) = ROOTFS.with(|state| -> Result<_, Errno> {
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: state.image_metadata.as_ref().map(|metadata| metadata.as_slice()),
            kernel_lazy: None,
        };
        Ok((sections.flags(), crate::vfsi_container::trailer_len(&sections)?))
    })?;

    // Building the plan is what `export_image_read(0, ..)` does; asking for the
    // body length has to happen first, and that is the call that does it.
    let body_len = IMAGE_EXPORT_CACHE.with(|slot| -> Result<u64, Errno> {
        if offset == 0 || slot.is_none() {
            *slot = None;
            *slot = Some(build_export_image(byte_source)?);
        }
        Ok(slot.as_ref().map(|plan| plan.len()).unwrap_or(0))
    })?;

    let head = crate::vfsi_container::header_for_body(body_len, flags)?;
    let head_len = head.len() as u64;
    let total = head_len
        .checked_add(body_len)
        .and_then(|n| n.checked_add(trailer_len))
        .ok_or(Errno::EINVAL)?;
    if offset >= total {
        reset_image_export();
        return Ok(0);
    }

    // One chunk may span two regions; copy what this offset reaches and let the
    // caller come back for the rest. Returning a short count is how every
    // streaming reader here already behaves.
    if offset < head_len {
        let from = offset as usize;
        let n = core::cmp::min(out.len(), head.len() - from);
        out[..n].copy_from_slice(&head[from..from + n]);
        return Ok(n);
    }
    if offset < head_len + body_len {
        return read_prepared_export_image(offset - head_len, out, byte_source);
    }
    ROOTFS.with(|state| {
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: state.image_metadata.as_ref().map(|metadata| metadata.as_slice()),
            kernel_lazy: None,
        };
        crate::vfsi_container::trailer_read(&sections, offset - head_len - body_len, out)
    })
}

pub fn prepared_export_container_length() -> Result<u64, Errno> {
    let body_length = IMAGE_EXPORT_CACHE.with(|slot| {
        slot.as_ref().map(|plan| plan.len()).ok_or(Errno::EINVAL)
    })?;
    ROOTFS.with(|state| {
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: state.image_metadata.as_ref().map(|metadata| metadata.as_slice()),
            kernel_lazy: None,
        };
        let header = crate::vfsi_container::header_for_body(body_length, sections.flags())?;
        let trailer_length = crate::vfsi_container::trailer_len(&sections)?;
        (header.len() as u64)
            .checked_add(body_length)
            .and_then(|length| length.checked_add(trailer_length))
            .ok_or(Errno::EOVERFLOW)
    })
}

/// Judge the image this tree WOULD export against a headroom profile.
///
/// Free space is a property of a laid-out filesystem, not of a tree, and the
/// export is what lays it out — so the plan is built and mounted, and the
/// existing policy is applied to it. Building the plan holds structure rather
/// than content, which is what makes this affordable for a 249 MiB image.
///
/// Lives here rather than in the module that calls it because `ExportPlan` is
/// private: exposing the laid-out image to reach one field would trade an
/// encapsulation for a convenience.
pub fn check_export_headroom(
    headroom: &crate::image_policy::Headroom,
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<crate::image_policy::PolicyOutcome, Errno> {
    let plan = build_export_image(byte_source)?;
    let source = crate::kandelo_image_write::KandeloImageSource {
        image: &plan.image,
        content: &crate::kandelo_image_write::NoContent,
    };
    let fs = crate::kandelo_image_fs::KandeloImageFs::mount(source)?;
    let st = fs.statfs()?;

    // **Room to GROW, not free blocks in the current allocation.**
    //
    // An export sizes the image to its tree plus a fixed slack, so free blocks
    // are a constant — 64 of them — however full the tree is. Judging a profile
    // against that constant is a check that cannot fail for the reason it
    // exists: it would compare 256 KiB to the minimum and answer the same way
    // for an empty image and a stuffed one. Found by a mutation that replaced
    // this measurement with `u64::MAX` and changed no outcome.
    //
    // What the assertion is FOR is "will normal runtime writes immediately run
    // out of room", and at runtime the image is mounted into a buffer of its
    // growth ceiling. So the headroom is the ceiling minus what the image
    // already occupies, which falls as the tree grows — the behaviour the
    // TypeScript path gets from a fixed-size buffer filling up.
    let ceiling = fs.growth_ceiling_bytes()?;
    let occupied = st
        .f_blocks
        .saturating_sub(st.f_bfree)
        .saturating_mul(u64::from(st.f_frsize));
    let free_bytes = ceiling.saturating_sub(occupied);

    let met =
        free_bytes >= headroom.minimum_free_bytes && st.f_ffree >= headroom.minimum_free_inodes;
    Ok(crate::image_policy::PolicyOutcome {
        met,
        free_bytes,
        required_bytes: headroom.minimum_free_bytes,
        free_inodes: st.f_ffree,
        required_inodes: headroom.minimum_free_inodes,
    })
}

/// The growth ceiling the image this tree would export will declare.
///
/// The builders read this out of finished image BYTES today, by parsing the
/// container header and then the KIFS superblock — format parsing in
/// TypeScript, over an artifact the kernel just produced. Asking the producer
/// avoids both the parse and the copy: a 249 MiB image does not have to cross
/// a boundary to answer a question about its own header.
pub fn export_capacity_bytes(
    byte_source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
) -> Result<u64, Errno> {
    let plan = build_export_image(byte_source)?;
    let source = crate::kandelo_image_write::KandeloImageSource {
        image: &plan.image,
        content: &crate::kandelo_image_write::NoContent,
    };
    crate::kandelo_image_fs::KandeloImageFs::mount(source)?.growth_ceiling_bytes()
}

/// Discard any in-progress export. Called by [`reset`] so a fresh store never
/// serves a chunk of the previous store's image.
pub fn reset_image_export() {
    IMAGE_EXPORT_CACHE.with(|slot| *slot = None);
    EXPORT_CACHE.with(|slot| *slot = None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::sync::Arc;
    use sha2::{Digest, Sha256};
    use wasm_posix_shared::flags::O_RDWR;

    #[test]
    fn borrowed_metadata_probe_and_copy_need_no_namespace_headroom() {
        let _guard = TestGuard::acquire();
        let metadata = alloc::vec![71; 1024 * 1024];
        set_image_options(64 * 1024 * 1024, Some(123), &metadata).unwrap();
        let used = metadata_budget_usage().0;
        set_metadata_budget_bytes(used).unwrap();
        assert_eq!(copy_image_metadata(None), Ok(metadata.len()));
        let mut short = [23; 8];
        assert_eq!(copy_image_metadata(Some(&mut short)), Err(Errno::EINVAL));
        assert_eq!(short, [23; 8]);
        let mut output = alloc::vec![31; metadata.len() + 16];
        assert_eq!(copy_image_metadata(Some(&mut output)), Ok(metadata.len()));
        assert_eq!(&output[..metadata.len()], &metadata);
        assert_eq!(&output[metadata.len()..], &[31; 16]);
        assert_eq!(metadata_budget_usage().0, used);
        assert_eq!(set_image_options(128 * 1024 * 1024, Some(456), b"new"), Err(Errno::ENOMEM));
        ROOTFS.with(|state| {
            assert_eq!(state.image_capacity_bytes, Some(64 * 1024 * 1024));
            assert_eq!(state.export_timestamp_ms, Some(123));
        });
        assert_eq!(copy_image_metadata(Some(&mut output)), Ok(metadata.len()));
        assert_eq!(&output[..metadata.len()], &metadata);
        set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
        set_image_options(128 * 1024 * 1024, Some(456), b"new").unwrap();
        assert_eq!(copy_image_metadata(None), Ok(3));
    }

    #[test]
    fn refused_resident_materialization_preserves_borrowed_file_and_kernel_usability() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let size = i64::MAX as u64;
        insert_base_file(b"/huge", 0, size, 0o640, 7, 11, 2).unwrap();
        let before = lstat(b"/huge").unwrap();
        assert_eq!(write_file_at(b"/huge", 0, &[31], 0o600, false, |_request, _output| {
            panic!("resident admission must precede fetching file bytes");
        }), Err(Errno::ENOMEM));
        let after = lstat(b"/huge").unwrap();
        assert_eq!((after.st_size, after.st_mode, after.st_uid, after.st_gid),
            (before.st_size, before.st_mode, before.st_uid, before.st_gid));
        let handle = open(b"/small", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        assert_eq!(write(handle, 0, &[37], no_bytes()), Ok(1));
        let mut bytes = [0; 1];
        assert_eq!(read(handle, 0, &mut bytes, no_bytes()), Ok(1));
        assert_eq!(bytes, [37]);
        release_handle(handle);
    }

    #[derive(Clone)]
    struct SharedJournalStorage(Arc<Mutex<Vec<u8>>>);

    impl OverlayStorage for SharedJournalStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            Ok(self.0.lock().len() as u64)
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            let bytes = self.0.lock();
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(dst.len()).ok_or(Errno::EIO)?;
            dst.copy_from_slice(bytes.get(start..end).ok_or(Errno::EIO)?);
            Ok(())
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
            let mut bytes = self.0.lock();
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            let end = start.checked_add(src.len()).ok_or(Errno::EIO)?;
            if end > bytes.len() {
                bytes.resize(end, 0);
            }
            bytes[start..end].copy_from_slice(src);
            Ok(())
        }

        fn flush(&mut self) -> Result<(), Errno> {
            Ok(())
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            self.0
                .lock()
                .truncate(usize::try_from(len).map_err(|_| Errno::EIO)?);
            Ok(())
        }
    }

    struct FailingCreateStorage {
        inner: SharedJournalStorage,
        fail_writes: Arc<AtomicBool>,
    }

    impl OverlayStorage for FailingCreateStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            self.inner.len()
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            self.inner.read_exact_at(offset, dst)
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err(Errno::ENOSPC);
            }
            self.inner.write_all_at(offset, src)
        }

        fn flush(&mut self) -> Result<(), Errno> {
            self.inner.flush()
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            self.inner.truncate(len)
        }
    }

    struct ClockChangingStorage {
        inner: SharedJournalStorage,
        change_on_flush: Arc<AtomicBool>,
    }

    impl OverlayStorage for ClockChangingStorage {
        fn len(&mut self) -> Result<u64, Errno> {
            self.inner.len()
        }

        fn read_exact_at(&mut self, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
            self.inner.read_exact_at(offset, dst)
        }

        fn write_all_at(&mut self, offset: u64, src: &[u8]) -> Result<(), Errno> {
            self.inner.write_all_at(offset, src)
        }

        fn flush(&mut self) -> Result<(), Errno> {
            self.inner.flush()?;
            if self.change_on_flush.swap(false, Ordering::SeqCst) {
                set_now(2_001, 2);
            }
            Ok(())
        }

        fn truncate(&mut self, len: u64) -> Result<(), Errno> {
            self.inner.truncate(len)
        }
    }

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
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            set_now(1_000, 0);
            TestGuard
        }
    }
    impl Drop for TestGuard {
        fn drop(&mut self) {
            reset();
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            set_enabled(false);
            TEST_LOCK.store(false, Ordering::Release);
        }
    }

    struct ReservationObservedStorage {
        inner: SharedJournalStorage,
        armed: Arc<AtomicBool>,
        prepared: Arc<AtomicBool>,
        writes: Arc<AtomicU32>,
    }

    impl OverlayStorage for ReservationObservedStorage {
        fn len(&mut self) -> Result<u64, Errno> { self.inner.len() }
        fn read_exact_at(&mut self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
            self.inner.read_exact_at(offset, destination)
        }
        fn write_all_at(&mut self, offset: u64, source: &[u8]) -> Result<(), Errno> {
            if self.armed.load(Ordering::SeqCst) {
                let ready = ROOTFS.with(|state| state.inodes.capacity() > state.inodes.len()
                    && state.free_inodes.capacity() > state.inodes.len());
                self.prepared.fetch_and(ready, Ordering::SeqCst);
                self.writes.fetch_add(1, Ordering::SeqCst);
            }
            self.inner.write_all_at(offset, source)
        }
        fn flush(&mut self) -> Result<(), Errno> { self.inner.flush() }
        fn truncate(&mut self, length: u64) -> Result<(), Errno> { self.inner.truncate(length) }
    }

    fn test_create_inode_kind(kind: usize, path: &[u8]) -> Result<(), Errno> {
        match kind {
            0 => {
                let handle = open(path, O_CREAT | O_WRONLY, 0o600, 0, 0)?;
                assert!(release_handle(handle));
                Ok(())
            }
            1 => mkdir(path, 0o700, 0, 0),
            2 => symlink(b"hello.txt", path, 0, 0),
            3 => mknod_special(path, 0o600, 0, 0, S_IFIFO),
            _ => mknod_special(path, 0o600, 0, 0, S_IFSOCK),
        }
    }

    fn test_fill_inode_capacity() -> Vec<Vec<u8>> {
        let mut paths = Vec::new();
        while ROOTFS.with(|state| state.inodes.len() < state.inodes.capacity()) {
            let path = alloc::format!("/arena-fill-{}", paths.len()).into_bytes();
            test_create_inode_kind(0, &path).unwrap();
            paths.push(path);
        }
        paths
    }

    #[test]
    fn directory_node_allocation_failure_precedes_durable_namespace_publication() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for operation in 0..7 {
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            ROOTFS.with(|state| state.reserve_inode_slots(1)).unwrap();
            let before = metadata_budget_usage().0;
            let tree = export_tree();
            let bytes = storage.0.lock().clone();
            let mutate = || match operation {
                0..=4 => test_create_inode_kind(operation, b"/allocation-retried"),
                5 => link(b"/hello.txt", b"/allocation-retried"),
                _ => rename(b"/hello.txt", b"/allocation-retried"),
            };
            crate::directory_entries::fail_next_node_allocation();
            assert_eq!(mutate(), Err(Errno::ENOMEM), "operation {operation}");
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(metadata_budget_usage().0, before);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            mutate().unwrap();
            sync_persistence().unwrap();
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            assert!(lstat(b"/allocation-retried").is_ok());
            if operation == 6 { assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT))); }
        }
    }

    #[test]
    fn metadata_quota_precedes_persistent_publication_and_releases_on_failed_io() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        for kind in 0..5 {
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let failing = Arc::new(AtomicBool::new(false));
            enable_resizable_persistence(Box::new(FailingCreateStorage {
                inner: storage.clone(), fail_writes: failing.clone(),
            }), digest, &mut source).unwrap();
            ROOTFS.with(|state| state.reserve_inode_slots(1)).unwrap();
            let before = metadata_budget_usage().0;
            let tree = export_tree();
            let journal = storage.0.lock().clone();
            set_metadata_budget_bytes(before + if kind == 2 { 2 * b"hello.txt".len() } else { 0 }).unwrap();
            assert_eq!(test_create_inode_kind(kind, b"/quota-created"), Err(Errno::ENOMEM));
            assert_eq!(metadata_budget_usage().0, before);
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), journal);
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            test_create_inode_kind(kind, b"/quota-retried").unwrap();
            let before_io = metadata_budget_usage().0;
            let tree = export_tree();
            failing.store(true, Ordering::SeqCst);
            assert_eq!(test_create_inode_kind(kind, b"/quota-created"), Err(Errno::ENOSPC));
            assert_eq!(metadata_budget_usage().0, before_io);
            assert_eq!(export_tree(), tree);
            failing.store(false, Ordering::SeqCst);
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            test_create_inode_kind(kind, b"/quota-created").unwrap();
        }
    }

    #[test]
    fn metadata_quota_preserves_link_and_rename_and_allows_reclamation_when_full() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let before = metadata_budget_usage().0;
        set_metadata_budget_bytes(before).unwrap();
        let tree = export_tree();
        let journal = storage.0.lock().clone();
        assert_eq!(link(b"/big.txt", b"/new-link"), Err(Errno::ENOMEM));
        assert_eq!(rename(b"/big.txt", b"/renamed"), Err(Errno::ENOMEM));
        assert_eq!(metadata_budget_usage().0, before);
        assert_eq!(export_tree(), tree);
        assert_eq!(*storage.0.lock(), journal);
        unlink(b"/hello.txt").unwrap();
        rename(b"/big.txt", b"/z").unwrap();
        assert_eq!(lstat(b"/z").unwrap().st_size, 45_000);
        assert!(metadata_budget_usage().0 < before);
        reset();
        assert_eq!(metadata_budget_usage().0, 0);
    }

    #[test]
    fn metadata_quota_tracks_retained_fields_and_atomic_replacement() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/held", 1, 0, 0o600, 0, 0, 2).unwrap();
        set_deferred_payload(b"/held", b"old payload").unwrap();
        set_deferred_source(b"/held", b"https://old.invalid/file", &crate::sdef::DIGEST_NONE).unwrap();
        declare_archive(1, 64).unwrap();
        set_archive_payload(1, b"old archive").unwrap();
        set_archive_source(1, b"https://old.invalid/archive", &crate::sdef::DIGEST_NONE).unwrap();
        set_image_metadata(b"old").unwrap();
        let before = metadata_budget_usage().0;
        set_metadata_budget_bytes(before).unwrap();
        assert_eq!(set_deferred_payload(b"/held", b"new payload"), Err(Errno::ENOMEM));
        assert_eq!(set_deferred_source(b"/held", b"https://new.invalid", &crate::sdef::DIGEST_NONE), Err(Errno::ENOMEM));
        assert_eq!(set_archive_payload(1, b"new archive"), Err(Errno::ENOMEM));
        assert_eq!(set_archive_source(1, b"https://new.invalid", &crate::sdef::DIGEST_NONE), Err(Errno::ENOMEM));
        assert_eq!(declare_archive(2, 64), Err(Errno::ENOMEM));
        declare_archive(1, 64).unwrap();
        assert_eq!(set_image_metadata(b"new"), Err(Errno::ENOMEM));
        let mut metadata = [0; 3];
        assert_eq!(copy_image_metadata(Some(&mut metadata)), Ok(3));
        assert_eq!(&metadata, b"old");
        assert_eq!(metadata_budget_usage().0, before);
        let handle = open(b"/held", O_RDONLY, 0, 0, 0).unwrap();
        let fields = ROOTFS.with(|state| {
            let root = state.root.unwrap();
            let inode = state.get(state.walk(root, &[b"held"]).unwrap()).unwrap();
            assert_eq!(inode.deferred_payload.as_slice(), b"old payload");
            assert_eq!(inode.deferred_uri.as_slice(), b"https://old.invalid/file");
            2 * (inode.deferred_payload.capacity() + inode.deferred_uri.capacity())
        });
        unlink(b"/held").unwrap();
        let unlinked = metadata_budget_usage().0;
        assert_eq!(before - unlinked, crate::directory_entries::DIRENT_MODEL_BYTES + 2 * b"held".len());
        assert!(release_handle(handle));
        assert_eq!(unlinked - metadata_budget_usage().0, fields);
        reset();
        assert_eq!(metadata_budget_usage().0, 0);
    }

    #[test]
    fn metadata_quota_recovery_does_not_rebuild_unlinked_inode_history() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            let limit = metadata_budget_usage().0 + 8192;
            set_metadata_budget_bytes(limit).unwrap();
            for count in 0..64 {
                let kind = count % 5;
                test_create_inode_kind(kind, b"/discard").unwrap();
                if kind <= 1 {
                    let path = if kind == 0 { &b"/discard"[..] } else { &b"/discard/child"[..] };
                    let handle = open(path, O_CREAT | O_WRONLY, 0o600, 0, 0).unwrap();
                    assert_eq!(write(handle, 0, b"orphan bytes", &mut source), Ok(12));
                    sync_persistence().unwrap();
                    assert!(release_handle(handle));
                    if kind == 1 { unlink(path).unwrap(); }
                }
                if kind == 1 { rmdir(b"/discard").unwrap(); } else { unlink(b"/discard").unwrap(); }
            }
            test_create_inode_kind(0, b"/alive").unwrap();
            test_create_inode_kind(2, b"/last-orphan").unwrap();
            unlink(b"/last-orphan").unwrap();
            sync_persistence().unwrap();
            let expected = export_tree();
            let next_ino = ROOTFS.with(|state| state.next_ino);
            let journal_bytes = storage.0.lock().clone();
            load_image(image.len() as u64, &mut source).unwrap();
            let result = if indexed {
                let mut journal = OverlayJournal::open(storage.clone(), digest).unwrap();
                journal.checkpoint_blocks_with_metadata_into(index.clone()).unwrap();
                enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index),
                    digest, journal_bytes.len() as u64, &mut source)
            } else {
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source)
            };
            assert_eq!(result, Ok(()));
            assert_eq!(export_tree(), expected);
            assert_eq!(ROOTFS.with(|state| state.next_ino), next_ino);
            assert_eq!(*storage.0.lock(), journal_bytes);
            assert!(metadata_budget_usage().0 <= limit);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        }
    }

    #[test]
    fn unlinked_inode_recovery_still_rejects_invalid_records_and_nonregular_file_data() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for invalid_time in [false, true] {
            load_image(image.len() as u64, &mut source).unwrap();
            let ino = ROOTFS.with(|state| state.next_ino);
            let inode = Inode::new(InodeKind::Symlink(own_metadata(b"hello.txt").unwrap()), 0o777, 0, 0, 0, ino);
            let mut record = encode_persistent_inode(&inode).unwrap();
            if invalid_time { record[24..28].copy_from_slice(&1_000_000_000u32.to_le_bytes()); }
            drop(inode);
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let mut journal = OverlayJournal::open(storage.clone(), digest).unwrap();
            let mut mutations = vec![Mutation::Put { key: OverlayKey::Inode(ino), value: record }];
            if !invalid_time {
                mutations.push(Mutation::Put { key: OverlayKey::FileSize(ino), value: 1u64.to_le_bytes().to_vec() });
            }
            journal.commit(&mutations).unwrap();
            let bytes = storage.0.lock().clone();
            let tree = export_tree();
            assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source), Err(Errno::EIO));
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), bytes);
        }
    }

    #[test]
    fn metadata_quota_recovery_reuses_the_final_namespace_budget() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            let limit = metadata_budget_usage().0 + 1024;
            set_metadata_budget_bytes(limit).unwrap();
            rename(b"/hello.txt", b"/h12345678").unwrap();
            rename(b"/big.txt", b"/b123456").unwrap();
            rename(b"/link", b"/l123").unwrap();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let storage = if indexed { compacted } else { storage };
            let expected = export_tree();
            let usage = metadata_budget_usage().0;
            let journal = storage.0.lock().clone();
            load_image(image.len() as u64, &mut source).unwrap();
            let result = if indexed {
                enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index),
                    digest, journal.len() as u64, &mut source)
            } else {
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source)
            };
            assert_eq!(result, Ok(()));
            assert_eq!(export_tree(), expected);
            assert_eq!(metadata_budget_usage(), (usage, limit));
            assert_eq!(*storage.0.lock(), journal);
        }
    }

    #[test]
    fn precommit_dirent_delta_keeps_package_and_user_names_unchanged_until_publication() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let mut indices = Vec::new();
        for (name, ino) in [(b"package".as_slice(), 9), (b"staged", 3), (b"user", 7),
            (b"inventory", 11), (b"staged-inventory", 12)] {
            let index = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o640, 1000, 1000, 1, ino)).unwrap();
            state.link_unpublished_inode(root, name, index).unwrap();
            indices.push(index);
        }
        state.reserve_inode_slots(0).unwrap();
        let mut edits = [
            (b"package".as_slice(), Some(3u64.to_le_bytes())),
            (b"inventory", Some(12u64.to_le_bytes())),
            (b"staged", None),
            (b"staged-inventory", None),
            (b"rollback-package", Some(9u64.to_le_bytes())),
            (b"rollback-inventory", Some(11u64.to_le_bytes())),
        ];
        edits.sort_unstable_by(|left, right| left.0.cmp(right.0));
        let used = metadata_budget_usage().0;
        let plan = PreparedNamespaceReplay::load_from_dirents(&state, &[], None, |visit| {
            for (name, value) in &edits {
                visit(1, name, value.as_ref().map(|value| value.as_slice()))?;
            }
            Ok(())
        }).unwrap();
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"package".as_slice()), Some(&indices[0]));
        assert_eq!(entries.get(b"inventory".as_slice()), Some(&indices[3]));
        assert_eq!(entries.get(b"staged".as_slice()), Some(&indices[1]));
        assert!(!entries.contains_key(b"rollback-package".as_slice()));
        assert_eq!(metadata_budget_usage().0, used);
        drop(plan);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        let plan = PreparedNamespaceReplay::load_from_dirents(&state, &[], None, |visit| {
            for (name, value) in &edits {
                visit(1, name, value.as_ref().map(|value| value.as_slice()))?;
            }
            Ok(())
        }).unwrap();
        plan.admit(&mut state).unwrap().publish(&mut state);
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"package".as_slice()), Some(&indices[1]));
        assert_eq!(entries.get(b"inventory".as_slice()), Some(&indices[4]));
        assert_eq!(entries.get(b"rollback-package".as_slice()), Some(&indices[0]));
        assert_eq!(entries.get(b"rollback-inventory".as_slice()), Some(&indices[3]));
        assert_eq!(entries.get(b"user".as_slice()), Some(&indices[2]));
        assert!(!entries.contains_key(b"staged".as_slice()));
        assert!(!entries.contains_key(b"staged-inventory".as_slice()));
        for index in indices { assert_eq!(state.get(index).unwrap().nlink, 1); }
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn precommit_dirent_delta_rejects_cycles_and_missing_targets_without_publication() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let child = state.insert_inode(Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 2)).unwrap();
        state.link_unpublished_inode(root, b"child", child).unwrap();
        let used = metadata_budget_usage().0;
        for missing in [false, true] {
            let target = if missing { 999u64 } else { 2u64 }.to_le_bytes();
            let result = PreparedNamespaceReplay::load_from_dirents(&state, &[], None, |visit| {
                visit(1, b"child", None)?;
                visit(2, b"cycle", Some(&target))
            });
            assert!(matches!(result, Err(Errno::EIO)));
            let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
            assert_eq!(entries.get(b"child".as_slice()), Some(&child));
            assert_eq!(metadata_budget_usage().0, used);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        }
    }

    #[test]
    fn precommit_namespace_operation_failure_restores_name_and_provider_credits() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let child = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 9)).unwrap();
        state.link_unpublished_inode(root, b"old", child).unwrap();
        state.reserve_inode_slots(0).unwrap();
        let used = metadata_budget_usage().0;
        set_metadata_budget_bytes(used + 8).unwrap();
        let mut provider_credit = ROOTFS_METADATA.reserve_temporary(8).unwrap();
        let target = 9u64.to_le_bytes();
        let make_plan = |state: &RootfsState| PreparedNamespaceReplay::load_from_dirents(state, &[], None, |visit| {
            visit(1, b"new", Some(&target))?;
            visit(1, b"old", None)
        }).unwrap();
        let attempted = core::cell::Cell::new(false);
        let result = make_plan(&state).admit_with(&mut state, &mut [&mut provider_credit], || {
            attempted.set(true);
            Err(Errno::EIO)
        });
        assert!(attempted.get());
        assert!(matches!(result, Err(Errno::EIO)));
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"old".as_slice()), Some(&child));
        assert!(!entries.contains_key(b"new".as_slice()));
        assert_eq!(state.get(child).unwrap().nlink, 1);
        assert_eq!(metadata_budget_usage().0, used);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 8);
        let plan = make_plan(&state).admit_with(&mut state, &mut [&mut provider_credit], || Ok(())).unwrap();
        plan.publish(&mut state);
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert!(!entries.contains_key(b"old".as_slice()));
        assert_eq!(entries.get(b"new".as_slice()), Some(&child));
        assert_eq!(metadata_budget_usage().0, used + 8);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        drop(provider_credit);
        assert_eq!(metadata_budget_usage().0, used);
    }

    #[test]
    fn precommit_namespace_refuses_insufficient_credits_before_attempting_the_operation() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let child = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 9)).unwrap();
        state.link_unpublished_inode(root, b"old", child).unwrap();
        let used = metadata_budget_usage().0;
        set_metadata_budget_bytes(used).unwrap();
        let target = 9u64.to_le_bytes();
        let plan = PreparedNamespaceReplay::load_from_dirents(&state, &[], None, |visit| {
            visit(1, b"longer", Some(&target))?;
            visit(1, b"old", None)
        }).unwrap();
        let attempted = core::cell::Cell::new(false);
        let result = plan.admit_with(&mut state, &mut [], || {
            attempted.set(true);
            Ok(())
        });
        assert!(matches!(result, Err(Errno::ENOMEM)));
        assert!(!attempted.get());
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"old".as_slice()), Some(&child));
        assert!(!entries.contains_key(b"longer".as_slice()));
        assert_eq!(metadata_budget_usage().0, used);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn precommit_dirent_source_refuses_changed_counts_and_duplicate_changes() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let child = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 9)).unwrap();
        state.link_unpublished_inode(root, b"old", child).unwrap();
        let target = 9u64.to_le_bytes();
        let used = metadata_budget_usage().0;
        for variation in 0..4 {
            let mut passes = 0;
            let result = PreparedNamespaceReplay::load_from_dirents(&state, &[], None, |visit| {
                passes += 1;
                if variation == 2 {
                    visit(1, b"new", Some(&target))?;
                    return visit(1, b"new", Some(&target));
                }
                if variation == 3 {
                    visit(1, b"old", None)?;
                    return visit(1, b"old", Some(&target));
                }
                if passes == 1 || variation == 0 { visit(1, b"old", None)?; }
                if passes == 2 && variation == 0 { visit(1, b"zzz", Some(&target))?; }
                Ok(())
            });
            assert!(matches!(result, Err(Errno::EIO)));
            let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
            assert_eq!(entries.get(b"old".as_slice()), Some(&child));
            assert!(!entries.contains_key(b"new".as_slice()));
            assert_eq!(metadata_budget_usage().0, used);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        }
    }

    fn activate_leaf_edits(edits: &[namespace_activation::LeafReplacement<'_>]) -> Result<(), Errno> {
        persistent_statfs()?;
        let mut active = PERSISTENT_ROOTFS.lock();
        let mount = active.as_mut().ok_or(Errno::EIO)?;
        ROOTFS.with(|state| namespace_activation::commit(state, mount, edits))
    }

    fn stage_leaf_bytes(path: &[u8], bytes: &[u8], source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>) -> u64 {
        let handle = open(path, O_CREAT | O_EXCL | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(handle, 0, bytes, source), Ok(bytes.len()));
        release_handle(handle);
        lstat(path).unwrap().st_ino
    }

    #[test]
    fn leaf_activation_commits_package_inventory_and_rollback_together_across_reopen() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            let package = lstat(b"/hello.txt").unwrap().st_ino;
            let inventory = stage_leaf_bytes(b"/inventory", b"version-one", &mut source);
            let next_package = stage_leaf_bytes(b"/stage-package", b"new-package", &mut source);
            let next_inventory = stage_leaf_bytes(b"/stage-inventory", b"version-two", &mut source);
            let user = stage_leaf_bytes(b"/user-data", b"must-not-change", &mut source);
            sync_persistence().unwrap();
            let mut edits = [
                namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(package), replacement: Some(next_package) },
                namespace_activation::LeafReplacement { parent: 1, name: b"inventory", expected: Some(inventory), replacement: Some(next_inventory) },
                namespace_activation::LeafReplacement { parent: 1, name: b"rollback-package", expected: None, replacement: Some(package) },
                namespace_activation::LeafReplacement { parent: 1, name: b"rollback-inventory", expected: None, replacement: Some(inventory) },
                namespace_activation::LeafReplacement { parent: 1, name: b"stage-package", expected: Some(next_package), replacement: None },
                namespace_activation::LeafReplacement { parent: 1, name: b"stage-inventory", expected: Some(next_inventory), replacement: None },
            ];
            edits.sort_unstable_by(|left, right| left.name.cmp(right.name));
            set_now(4_000, 123);
            activate_leaf_edits(&edits).unwrap();
            assert_persistent_cached_usage();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let checkpoint_end = compacted.0.lock().len() as u64;
            let storage = if indexed { compacted } else { storage };
            for reopened in [false, true] {
                if reopened {
                    load_image(image.len() as u64, &mut source).unwrap();
                    if indexed {
                        enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index.clone()), digest,
                            checkpoint_end, &mut source).unwrap();
                    } else {
                        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
                    }
                    persistent_statfs().unwrap();
                }
                for (path, ino) in [
                    (b"/hello.txt".as_slice(), next_package), (b"/inventory", next_inventory),
                    (b"/rollback-package", package), (b"/rollback-inventory", inventory), (b"/user-data", user),
                ] {
                    let metadata = lstat(path).unwrap();
                    assert_eq!((metadata.st_ino, metadata.st_nlink), (ino, 1));
                }
                for path in [b"/stage-package".as_slice(), b"/stage-inventory"] {
                    assert!(matches!(lstat(path), Err(Errno::ENOENT)));
                }
                let root = lstat(b"/").unwrap();
                assert_eq!((root.st_mtime_sec, root.st_mtime_nsec), (4_000, 123));
                assert_persistent_cached_usage();
                assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            }
            let rollback = [
                namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(next_package), replacement: Some(package) },
                namespace_activation::LeafReplacement { parent: 1, name: b"inventory", expected: Some(next_inventory), replacement: Some(inventory) },
                namespace_activation::LeafReplacement { parent: 1, name: b"rollback-inventory", expected: Some(inventory), replacement: Some(next_inventory) },
                namespace_activation::LeafReplacement { parent: 1, name: b"rollback-package", expected: Some(package), replacement: Some(next_package) },
            ];
            activate_leaf_edits(&rollback).unwrap();
            assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, package);
            assert_eq!(lstat(b"/inventory").unwrap().st_ino, inventory);
            assert_eq!(lstat(b"/user-data").unwrap().st_ino, user);
            assert_persistent_cached_usage();
        }
    }

    #[test]
    fn leaf_activation_refuses_conflicts_invalid_keys_special_files_and_live_references_before_writing() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let package = lstat(b"/hello.txt").unwrap().st_ino;
        let staged = stage_leaf_bytes(b"/staged", b"next", &mut source);
        mknod_special(b"/fifo", 0o600, 0, 0, S_IFIFO).unwrap();
        let fifo = lstat(b"/fifo").unwrap().st_ino;
        sync_persistence().unwrap();
        let edit = |name, expected, replacement| namespace_activation::LeafReplacement { parent: 1, name, expected, replacement };
        for (edits, error) in [
            (vec![edit(b"hello.txt", None, Some(staged))], Errno::EEXIST),
            (vec![edit(b"hello.txt", Some(staged), Some(package))], Errno::EEXIST),
            (vec![edit(b"missing", Some(package), Some(staged))], Errno::EEXIST),
            (vec![edit(b"../escape", None, Some(staged))], Errno::EINVAL),
            (vec![edit(b"new", None, Some(999_999))], Errno::ENOENT),
            (vec![edit(b"new", None, Some(1))], Errno::EOPNOTSUPP),
            (vec![edit(b"new", None, Some(fifo))], Errno::EOPNOTSUPP),
            (vec![edit(b"fifo", Some(fifo), None)], Errno::EOPNOTSUPP),
            (vec![edit(b"hello.txt", Some(package), Some(staged)), edit(b"hello.txt", Some(package), None)], Errno::EINVAL),
            (vec![edit(b"z", None, Some(staged)), edit(b"a", None, Some(staged))], Errno::EINVAL),
        ] {
            let bytes = storage.0.lock().clone();
            let tree = export_tree();
            assert_eq!(activate_leaf_edits(&edits), Err(error));
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(export_tree(), tree);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        }
        let handle = open(b"/staged", O_RDWR, 0, 0, 0).unwrap();
        let bytes = storage.0.lock().clone();
        let edits = [edit(b"hello.txt", Some(package), Some(staged))];
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::EBUSY));
        assert_eq!(*storage.0.lock(), bytes);
        pin_mapping(handle).unwrap();
        release_handle(handle);
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::EBUSY));
        assert_eq!(*storage.0.lock(), bytes);
        unpin_mapping(handle);
        let handle = open(b"/staged", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"dirty", &mut source), Ok(5));
        release_handle(handle);
        let bytes = storage.0.lock().clone();
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::EBUSY));
        assert_eq!(*storage.0.lock(), bytes);
        sync_persistence().unwrap();
        activate_leaf_edits(&edits).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, staged);
    }

    #[test]
    fn leaf_activation_failed_write_restores_credits_and_keeps_the_old_live_and_recovered_graph() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let fail_writes = Arc::new(AtomicBool::new(false));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(FailingCreateStorage { inner: storage.clone(), fail_writes: fail_writes.clone() }),
            digest, &mut source).unwrap();
        let package = lstat(b"/hello.txt").unwrap().st_ino;
        let staged = stage_leaf_bytes(b"/staged", b"next", &mut source);
        sync_persistence().unwrap();
        let bytes = storage.0.lock().clone();
        let tree = export_tree();
        let usage = metadata_budget_usage().0;
        let edits = [
            namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(package), replacement: Some(staged) },
            namespace_activation::LeafReplacement { parent: 1, name: b"rollback", expected: None, replacement: Some(package) },
            namespace_activation::LeafReplacement { parent: 1, name: b"staged", expected: Some(staged), replacement: None },
        ];
        fail_writes.store(true, Ordering::SeqCst);
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::ENOSPC));
        assert_eq!(export_tree(), tree);
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        assert_eq!(*storage.0.lock(), bytes);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        assert_eq!(export_tree(), tree);
        assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, package);
        assert_eq!(lstat(b"/staged").unwrap().st_ino, staged);
        assert!(matches!(lstat(b"/rollback"), Err(Errno::ENOENT)));
    }

    #[test]
    fn leaf_activation_preserves_base_tombstones_and_exact_allocation_after_compaction() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        let package = lstat(b"/hello.txt").unwrap().st_ino;
        let replaced = lstat(b"/big.txt").unwrap().st_ino;
        let staged = stage_leaf_bytes(b"/staged", b"replacement", &mut source);
        sync_persistence().unwrap();
        activate_leaf_edits(&[
            namespace_activation::LeafReplacement { parent: 1, name: b"big.txt", expected: Some(replaced), replacement: Some(staged) },
            namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(package), replacement: None },
            namespace_activation::LeafReplacement { parent: 1, name: b"staged", expected: Some(staged), replacement: None },
        ]).unwrap();
        assert_persistent_cached_usage();
        let free = persistent_statfs().unwrap().f_bfree;
        prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let end = compacted.0.lock().len() as u64;
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence_indexed(Box::new(compacted), Box::new(index), digest, end, &mut source).unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/staged"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/big.txt").unwrap().st_ino, staged);
        assert_eq!(persistent_statfs().unwrap().f_bfree, free);
        let mut bytes = [0; 11];
        assert_eq!(read_file_at(b"/big.txt", 0, &mut bytes, &mut source), Ok(11));
        assert_eq!(&bytes, b"replacement");
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn leaf_activation_budget_refusal_leaves_the_journal_and_namespace_unchanged() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let package = lstat(b"/hello.txt").unwrap().st_ino;
        let staged = stage_leaf_bytes(b"/staged", b"next", &mut source);
        sync_persistence().unwrap();
        persistent_statfs().unwrap();
        let bytes = storage.0.lock().clone();
        let tree = export_tree();
        let usage = metadata_budget_usage().0;
        set_metadata_budget_bytes(usage).unwrap();
        let edits = [
            namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(package), replacement: Some(staged) },
            namespace_activation::LeafReplacement { parent: 1, name: b"rollback-with-a-longer-name", expected: None, replacement: Some(package) },
            namespace_activation::LeafReplacement { parent: 1, name: b"staged", expected: Some(staged), replacement: None },
        ];
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::ENOMEM));
        assert_eq!(export_tree(), tree);
        assert_eq!(*storage.0.lock(), bytes);
        assert_eq!(metadata_budget_usage(), (usage, usage));
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
        activate_leaf_edits(&edits).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, staged);
    }

    #[test]
    fn leaf_activation_preflights_the_complete_transaction_including_deduplicated_metadata() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(20 * 1024 * 1024, 8192);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let staged = stage_leaf_bytes(b"/staged", b"next", &mut source);
        sync_persistence().unwrap();
        let names: Vec<Vec<u8>> = (0..3666).map(|index| {
            let mut name = vec![b'x'; 255];
            name[..4].copy_from_slice(alloc::format!("{index:04}").as_bytes());
            name
        }).collect();
        let edits: Vec<_> = names.iter().map(|name| namespace_activation::LeafReplacement {
            parent: 1, name, expected: None, replacement: Some(staged),
        }).collect();
        let dirents: Vec<_> = names.iter().map(|name| Mutation::Put {
            key: OverlayKey::Dirent { parent: 1, name: name.clone() }, value: staged.to_le_bytes().to_vec(),
        }).collect();
        assert!(crate::persistent_overlay::transaction_encoded_length(&dirents).is_ok());
        let bytes = storage.0.lock().clone();
        let tree = export_tree();
        let usage = metadata_budget_usage().0;
        assert_eq!(activate_leaf_edits(&edits), Err(Errno::EFBIG));
        assert_eq!(export_tree(), tree);
        assert_eq!(*storage.0.lock(), bytes);
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn leaf_activation_every_torn_write_and_uncertain_flush_recovers_one_complete_package_state() {
        struct InterruptedStorage {
            inner: SharedJournalStorage,
            remaining: usize,
            fail_flush: bool,
            wrote: bool,
        }
        impl OverlayStorage for InterruptedStorage {
            fn len(&mut self) -> Result<u64, Errno> { self.inner.len() }
            fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                self.inner.read_exact_at(offset, bytes)
            }
            fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
                let count = bytes.len().min(self.remaining);
                self.inner.write_all_at(offset, &bytes[..count])?;
                self.remaining -= count;
                self.wrote = true;
                if count == bytes.len() { Ok(()) } else { Err(Errno::EIO) }
            }
            fn flush(&mut self) -> Result<(), Errno> {
                if self.fail_flush && self.wrote { Err(Errno::EIO) } else { self.inner.flush() }
            }
            fn truncate(&mut self, length: u64) -> Result<(), Errno> { self.inner.truncate(length) }
        }

        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let package = lstat(b"/hello.txt").unwrap().st_ino;
        let inventory = stage_leaf_bytes(b"/inventory", b"old-inventory", &mut source);
        let next_package = stage_leaf_bytes(b"/stage-package", b"new-package", &mut source);
        let next_inventory = stage_leaf_bytes(b"/stage-inventory", b"new-inventory", &mut source);
        let user = stage_leaf_bytes(b"/user", b"user-content", &mut source);
        sync_persistence().unwrap();
        let edits = [
            namespace_activation::LeafReplacement { parent: 1, name: b"hello.txt", expected: Some(package), replacement: Some(next_package) },
            namespace_activation::LeafReplacement { parent: 1, name: b"inventory", expected: Some(inventory), replacement: Some(next_inventory) },
            namespace_activation::LeafReplacement { parent: 1, name: b"rollback-inventory", expected: None, replacement: Some(inventory) },
            namespace_activation::LeafReplacement { parent: 1, name: b"rollback-package", expected: None, replacement: Some(package) },
            namespace_activation::LeafReplacement { parent: 1, name: b"stage-inventory", expected: Some(next_inventory), replacement: None },
            namespace_activation::LeafReplacement { parent: 1, name: b"stage-package", expected: Some(next_package), replacement: None },
        ];
        let before = storage.0.lock().clone();
        let old_tree = export_tree();
        activate_leaf_edits(&edits).unwrap();
        let new_tree = export_tree();
        let length = storage.0.lock().len() - before.len();
        assert!(length > 64);
        for cut in 0..=length {
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(before.clone())));
            enable_resizable_persistence(Box::new(InterruptedStorage {
                inner: storage.clone(), remaining: cut, fail_flush: cut == length, wrote: false,
            }), digest, &mut source).unwrap();
            let usage = metadata_budget_usage().0;
            assert_eq!(activate_leaf_edits(&edits), Err(Errno::EIO), "cut={cut}");
            assert_eq!(export_tree(), old_tree, "cut={cut}");
            assert_eq!(metadata_budget_usage().0, usage, "cut={cut}");
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0, "cut={cut}");
            let bytes = storage.0.lock().clone();
            assert_eq!(activate_leaf_edits(&edits), Err(Errno::EIO), "cut={cut}");
            assert_eq!(*storage.0.lock(), bytes);
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
            assert_eq!(export_tree(), if cut == length { &new_tree } else { &old_tree }.as_slice(), "cut={cut}");
            assert_eq!(lstat(b"/user").unwrap().st_ino, user, "cut={cut}");
            assert_eq!(lstat(b"/hello.txt").unwrap().st_ino,
                if cut == length { next_package } else { package }, "cut={cut}");
            assert_eq!(lstat(b"/inventory").unwrap().st_ino,
                if cut == length { next_inventory } else { inventory }, "cut={cut}");
        }
    }

    #[test]
    fn leaf_activation_refuses_setid_base_leaves_without_committing_unrecoverable_metadata() {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(1024 * 1024),
            growable_to_bytes: 1024 * 1024, now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        for (name, mode) in [(b"suid".as_slice(), 0o4755), (b"sgid", 0o2755), (b"both", 0o6755)] {
            writer.create_file(writer.root(), name, mode, Content::Bytes(b"immutable-original")).unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let staged = stage_leaf_bytes(b"/staged", b"replacement", &mut source);
        sync_persistence().unwrap();
        for (name, mode) in [(b"suid".as_slice(), 0o4755), (b"sgid", 0o2755), (b"both", 0o6755)] {
            let mut path = vec![b'/'];
            path.extend_from_slice(name);
            let ino = lstat(&path).unwrap().st_ino;
            assert_eq!(lstat(&path).unwrap().st_mode & 0o7777, mode);
            for (target_name, expected, replacement) in [
                (name, Some(ino), None), (name, Some(ino), Some(staged)), (b"retained".as_slice(), None, Some(ino)),
            ] {
                let bytes = storage.0.lock().clone();
                let tree = export_tree();
                let usage = metadata_budget_usage().0;
                assert_eq!(activate_leaf_edits(&[namespace_activation::LeafReplacement {
                    parent: 1, name: target_name, expected, replacement,
                }]), Err(Errno::EOPNOTSUPP));
                assert_eq!(*storage.0.lock(), bytes);
                assert_eq!(export_tree(), tree);
                assert_eq!(metadata_budget_usage().0, usage);
                assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
                load_image(image.len() as u64, &mut source).unwrap();
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
                assert_eq!(export_tree(), tree);
                assert_eq!(lstat(&path).unwrap().st_mode & 0o7777, mode);
            }
        }
    }

    #[test]
    fn metadata_quota_replay_updates_existing_keys_without_duplicate_resident_names() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let first = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 9)).unwrap();
        let second = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 3)).unwrap();
        state.link_unpublished_inode(root, b"first", first).unwrap();
        state.link_unpublished_inode(root, b"second", second).unwrap();
        let storage: Box<dyn OverlayStorage + Send> = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal.commit(&[
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"first".to_vec() }, value: 3u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"second".to_vec() }, value: 3u64.to_le_bytes().to_vec() },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"absent".to_vec() } },
        ]).unwrap();
        let usage = metadata_budget_usage().0;
        set_metadata_budget_bytes(usage).unwrap();
        apply_persistent_dirents(&mut state, &mut journal).unwrap();
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"first".as_slice()), Some(&second));
        assert_eq!(entries.get(b"second".as_slice()), Some(&second));
        assert!(state.get(first).is_none());
        assert_eq!(state.get(second).unwrap().nlink, 2);
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn metadata_quota_replay_rejection_restores_removed_key_credits_before_retry() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let child = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 9)).unwrap();
        state.link_unpublished_inode(root, b"old", child).unwrap();
        let storage: Box<dyn OverlayStorage + Send> = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal.commit(&[
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"old".to_vec() } },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"longer".to_vec() }, value: 9u64.to_le_bytes().to_vec() },
        ]).unwrap();
        let usage = metadata_budget_usage().0;
        set_metadata_budget_bytes(usage).unwrap();
        assert_eq!(apply_persistent_dirents(&mut state, &mut journal), Err(Errno::ENOMEM));
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert_eq!(entries.get(b"old".as_slice()), Some(&child));
        assert!(!entries.contains_key(b"longer".as_slice()));
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        set_metadata_budget_bytes(usage + 6).unwrap();
        apply_persistent_dirents(&mut state, &mut journal).unwrap();
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else { panic!("directory expected") };
        assert!(!entries.contains_key(b"old".as_slice()));
        assert_eq!(entries.get(b"longer".as_slice()), Some(&child));
        assert_eq!(metadata_budget_usage().0, usage + 6);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn metadata_quota_replay_scratch_denial_leaves_the_tree_untouched() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let storage: Box<dyn OverlayStorage + Send> = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        let usage = metadata_budget_usage().0;
        set_metadata_budget_bytes(usage).unwrap();
        let temporary = ROOTFS_METADATA.reserve_temporary(usage * 2).unwrap();
        assert_eq!(apply_persistent_dirents(&mut state, &mut journal), Err(Errno::ENOMEM));
        assert_eq!(state.get(root).unwrap().nlink, 2);
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), usage * 2);
        drop(temporary);
        apply_persistent_dirents(&mut state, &mut journal).unwrap();
        assert_eq!(metadata_budget_usage().0, usage);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn projected_fifo_namespace_matches_replay_without_publishing_or_copying_the_tree() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/old", 0o755, 0, 0, 2).unwrap();
        insert_base_special(b"/old/fifo", 0o640, 7, 8, 3, S_IFIFO).unwrap();
        link(b"/old/fifo", b"/alias").unwrap();
        insert_base_special(b"/replaced", 0o600, 7, 8, 4, S_IFIFO).unwrap();
        let handle = open(b"/temporary", O_CREAT | O_WRONLY, 0o600, 0, 0).unwrap();
        assert!(release_handle(handle));
        unlink(b"/temporary").unwrap();
        restore_fifo_registry().unwrap();
        let old_pipe = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/replaced").unwrap();
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(old_pipe).unwrap();
        pipe.prepare_fifo_io().unwrap();
        pipe.add_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        assert_eq!(pipe.write(b"live"), 4);
        let created = vec![
            (20, Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 20)),
            (21, Inode::new(InodeKind::Special(S_IFIFO), 0o600, 9, 10, 1, 21)),
            (22, Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 22)),
        ];
        let mut updates = ROOTFS.with(|state| {
            let index = state.walk(state.root.unwrap(), &[b"old", b"fifo"]).unwrap();
            vec![(3, (index, PersistentInodeMetadata::from_inode(state.get(index).unwrap())))]
        });
        updates[0].1.1.mode = 0o660;
        updates[0].1.1.uid = 30;
        updates[0].1.1.gid = 31;
        updates[0].1.1.mtime_sec = 333;
        updates[0].1.1.mtime_nsec = 11;
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let storage: Box<dyn OverlayStorage + Send> = Box::new(storage);
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        let mut mutations = vec![
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"old".to_vec() } },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 2, name: b"fifo".to_vec() } },
        ];
        for (parent, name, ino) in [(1, b"moved".as_slice(), 2u64), (2, b"renamed", 3),
            (1, b"another", 3), (1, b"replaced", 21), (1, b"newdir", 20),
            (20, b"fifo", 21), (20, b"file", 22)] {
            mutations.push(Mutation::Put { key: OverlayKey::Dirent { parent, name: name.to_vec() }, value: ino.to_le_bytes().to_vec() });
        }
        journal.commit(&mutations).unwrap();
        let replay = ROOTFS.with(|state| {
            state.reserve_inode_slots(created.len()).unwrap();
            PreparedNamespaceReplay::load(state, &mut journal, &created, None).unwrap()
        });
        let mut predicted = Vec::new();
        drop(unsafe { crate::pipe::global_pipe_table() }.prepare_slots(2).unwrap());
        let fifos = ROOTFS.with(|state| {
            let baseline = crate::io_buffer::IO_MEMORY.usage().0;
            {
                let _limit = crate::io_buffer::test_budget(baseline);
                assert!(matches!(RecoveryNamespaceView::new(state, &created, Some(&replay), &updates), Err(Errno::ENOMEM)));
            }
            let view = RecoveryNamespaceView::new(state, &created, Some(&replay), &updates).unwrap();
            let retained = crate::io_buffer::IO_MEMORY.usage().0;
            for allocations in [0, 2, 4, 6] {
                crate::prepared_map::fail_after_allocations(allocations);
                assert!(matches!(PreparedFifoRegistry::prepare(|visit| view.for_each_fifo_path(visit), true), Err(Errno::ENOMEM)));
                assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
                assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/replaced"), Some(old_pipe));
                assert_eq!(unsafe { crate::pipe::global_pipe_table() }.get(old_pipe).unwrap().available(), 4);
            }
            view.for_each_fifo_path(&mut |index, path, metadata| {
                predicted.push((index, path.to_vec(), metadata.st_ino, metadata.st_mode,
                    metadata.st_uid, metadata.st_gid, metadata.st_nlink, metadata.st_mtime_sec, metadata.st_mtime_nsec));
                Ok(())
            }).unwrap();
            PreparedFifoRegistry::prepare(|visit| view.for_each_fifo_path(visit), true).unwrap()
        });
        assert_eq!(predicted.len(), 5);
        assert_eq!(lstat(b"/moved").unwrap_err(), Errno::ENOENT);
        assert!(lstat(b"/old/fifo").is_ok());
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/replaced"), Some(old_pipe));
        {
            let _limit = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            let replay = ROOTFS.with(|state| replay.admit(state)).unwrap();
            ROOTFS.with(|state| {
                for (_, inode) in created { state.insert_prepared_inode(inode); }
                for (_, (index, metadata)) in updates { metadata.apply(state.get_mut(index).unwrap()); }
                replay.publish(state);
            });
            fifos.publish();
        }
        let mut actual = Vec::new();
        for_each_fifo_path(|index, path, metadata| {
            actual.push((index, path.to_vec(), metadata.st_ino, metadata.st_mode,
                metadata.st_uid, metadata.st_gid, metadata.st_nlink, metadata.st_mtime_sec, metadata.st_mtime_nsec));
            let pipe = unsafe { crate::fifo::global_fifo_table() }.lookup(path).unwrap();
            let cached = unsafe { crate::pipe::global_pipe_table() }.get(pipe).unwrap().fifo_metadata().unwrap();
            assert_eq!((cached.st_ino, cached.st_uid, cached.st_gid, cached.st_nlink),
                (metadata.st_ino, metadata.st_uid, metadata.st_gid, metadata.st_nlink));
            Ok(())
        }).unwrap();
        assert_eq!(actual, predicted);
        assert_ne!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/replaced"), Some(old_pipe));
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(old_pipe).unwrap();
        assert_eq!(pipe.fifo_name_count(), 0);
        let mut bytes = [0; 4];
        assert_eq!(pipe.read(&mut bytes), 4);
        assert_eq!(&bytes, b"live");
        pipe.close_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        unsafe { crate::pipe::global_pipe_table() }.free_if_closed(old_pipe);
    }

    #[test]
    fn prepared_namespace_replay_plans_reused_and_appended_inode_slots() {
        let _guard = TestGuard::acquire();
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let vacant = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 0, 8)).unwrap();
        state.maybe_free(vacant);
        assert!(state.get(vacant).is_none());
        let created = vec![
            (20, Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 20)),
            (21, Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 21)),
        ];
        let storage: Box<dyn OverlayStorage + Send> = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal.commit(&[
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"directory".to_vec() }, value: 20u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 20, name: b"file".to_vec() }, value: 21u64.to_le_bytes().to_vec() },
        ]).unwrap();
        state.reserve_inode_slots(created.len()).unwrap();
        validate_persistent_dirents(&state, &mut journal, &created).unwrap();
        let replay = PreparedNamespaceReplay::load(&state, &mut journal, &created, None).unwrap().admit(&mut state).unwrap();
        for (_, inode) in created { state.insert_prepared_inode(inode); }
        replay.publish(&mut state);
        assert_eq!(state.get(vacant).unwrap().ino, 20);
        let directory = state.walk(root, &[b"directory"]).unwrap();
        let file = state.walk(root, &[b"directory", b"file"]).unwrap();
        assert_eq!(directory, vacant);
        assert_eq!(state.get(file).unwrap().ino, 21);
        assert_eq!(state.get(root).unwrap().nlink, 3);
        assert_eq!(state.get(directory).unwrap().nlink, 2);
        assert_eq!(state.get(file).unwrap().nlink, 1);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn recovery_slot_remapping_preserves_live_handles_directories_and_fifo_aliases() {
        let _guard = TestGuard::acquire();
        let (root, old_directory, old_child, held, mapped, vacant) = ROOTFS.with(|state| {
            let root = state.mount_root().unwrap();
            let directory = state.insert_inode(Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 10)).unwrap();
            let child = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 11)).unwrap();
            let held = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 12)).unwrap();
            let mapped = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 13)).unwrap();
            let vacant = state.insert_inode(Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 0, 14)).unwrap();
            state.get_mut(held).unwrap().open_count = 1;
            state.get_mut(mapped).unwrap().map_pins = 1;
            state.link_unpublished_inode(root, b"old", directory).unwrap();
            state.link_unpublished_inode(directory, b"child", child).unwrap();
            state.link_unpublished_inode(root, b"held", held).unwrap();
            state.link_unpublished_inode(root, b"mapped", mapped).unwrap();
            state.maybe_free(vacant);
            (root, directory, child, held, mapped, vacant)
        });
        let created = vec![
            (20, Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o750, 12, 34, 2, 20)),
            (21, Inode::new(InodeKind::Special(S_IFIFO), 0o640, 56, 78, 1, 21)),
            (22, Inode::new(InodeKind::PersistentRegular, 0o600, 90, 91, 1, 22)),
        ];
        let storage: Box<dyn OverlayStorage + Send> = Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal.commit(&[
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"old".to_vec() } },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 10, name: b"child".to_vec() } },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"held".to_vec() } },
            Mutation::Delete { key: OverlayKey::Dirent { parent: 1, name: b"mapped".to_vec() } },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"new".to_vec() }, value: 20u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 20, name: b"fifo".to_vec() }, value: 21u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"alias".to_vec() }, value: 21u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 20, name: b"file".to_vec() }, value: 22u64.to_le_bytes().to_vec() },
            Mutation::Put { key: OverlayKey::Dirent { parent: 1, name: b"link".to_vec() }, value: 22u64.to_le_bytes().to_vec() },
        ]).unwrap();
        let replay = ROOTFS.with(|state| PreparedNamespaceReplay::load(state, &mut journal, &created, None)).unwrap();
        let before_io = io_budget_usage().0;
        {
            let _budget = crate::io_buffer::test_budget(before_io);
            assert!(matches!(ROOTFS.with(|state| recovery_slots::PreparedRecoverySlots::new(state, created.len(), Some(&replay))), Err(Errno::ENOMEM)));
        }
        assert_eq!(io_budget_usage().0, before_io);
        let slots = ROOTFS.with(|state| recovery_slots::PreparedRecoverySlots::new(state, created.len(), Some(&replay))).unwrap();
        assert_eq!(slots.physical_index(vacant), old_child);
        assert_eq!(slots.physical_index(vacant + 1), old_directory);
        assert_eq!(slots.physical_index(vacant + 2), vacant);
        assert_eq!(slots.physical_index(held), held);
        assert_eq!(slots.physical_index(mapped), mapped);
        ROOTFS.with(|state| slots.reserve(state)).unwrap();
        let fifos = ROOTFS.with(|state| {
            let view = RecoveryNamespaceView::new(state, &created, Some(&replay), &[]).unwrap();
            PreparedFifoRegistry::prepare(|visit| view.for_each_fifo_path(&mut |index, path, metadata| {
                visit(slots.physical_index(index), path, metadata)
            }), true)
        }).unwrap();
        ROOTFS.with(|state| {
            let replay = replay.admit(state).unwrap();
            slots.publish(state, created, Some(replay));
            assert_eq!(state.walk(root, &[b"new"]).unwrap(), old_child);
            assert_eq!(state.walk(root, &[b"new", b"fifo"]).unwrap(), old_directory);
            assert_eq!(state.walk(root, &[b"new", b"file"]).unwrap(), vacant);
            assert_eq!(state.walk(root, &[b"link"]).unwrap(), vacant);
            assert_eq!(state.get(held).unwrap().ino, 12);
            assert_eq!(state.get(held).unwrap().nlink, 0);
            assert_eq!(state.get(mapped).unwrap().ino, 13);
            assert_eq!(state.get(mapped).unwrap().nlink, 0);
        });
        fifos.publish();
        assert_eq!(lstat(b"/new").unwrap().st_nlink, 2);
        assert_eq!(lstat(b"/new/file").unwrap().st_nlink, 2);
        assert_eq!(lstat(b"/new/fifo").unwrap().st_nlink, 2);
        let fifo = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/new/fifo").unwrap();
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/alias"), Some(fifo));
        assert_eq!(unsafe { crate::pipe::global_pipe_table() }.get(fifo).unwrap().fifo_name_count(), 2);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        ROOTFS.with(|state| {
            state.get_mut(held).unwrap().open_count = 0;
            state.get_mut(mapped).unwrap().map_pins = 0;
            state.maybe_free(held);
            state.maybe_free(mapped);
            assert!(state.get(held).is_none());
            assert!(state.get(mapped).is_none());
        });
    }

    #[test]
    fn replacement_recovery_reuses_final_inode_slots_at_the_running_metadata_budget() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        for index in 0..127 {
            let path = alloc::format!("/base-{index:03}");
            write_file_at(path.as_bytes(), 0, b"", 0o644, true, no_bytes()).unwrap();
        }
        let image = drain_container(8192, &mut no_bytes());
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let arena_capacity = ROOTFS.with(|state| state.inodes.capacity());
        let budget = metadata_budget_usage().0 + 48 * 1024;
        set_metadata_budget_bytes(budget).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        for index in 0..127 {
            let old = alloc::format!("/base-{index:03}");
            let new = alloc::format!("/next-{index:03}");
            unlink(old.as_bytes()).unwrap();
            let handle = open(new.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
            release_handle(handle);
        }
        sync_persistence().unwrap();
        assert_eq!(ROOTFS.with(|state| state.inodes.capacity()), arena_capacity);
        let committed = storage.0.lock().clone();
        set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
        load_image(image.len() as u64, &mut source).unwrap();
        set_metadata_budget_bytes(budget).unwrap();
        assert_eq!(ROOTFS.with(|state| state.reserve_inode_slots(127)), Err(Errno::ENOMEM));
        let pristine_tree = export_tree();
        let before_recovery = metadata_budget_usage().0;
        let before_io = io_budget_usage().0;
        FAIL_PERSISTENCE_FIFO_RESTORE.store(true, Ordering::SeqCst);
        assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source), Err(Errno::ENOMEM));
        assert!(persistence_recovery_is_pristine());
        assert_eq!(export_tree(), pristine_tree);
        assert_eq!(*storage.0.lock(), committed);
        assert_eq!(metadata_budget_usage().0, before_recovery);
        assert_eq!(io_budget_usage().0, before_io);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        assert_eq!(ROOTFS.with(|state| state.inodes.capacity()), arena_capacity);
        assert!(metadata_budget_usage().0 <= budget);
        assert_eq!(*storage.0.lock(), committed);
        for index in 0..127 {
            assert_eq!(lstat(alloc::format!("/base-{index:03}").as_bytes()).unwrap_err(), Errno::ENOENT);
            assert_eq!(lstat(alloc::format!("/next-{index:03}").as_bytes()).unwrap().st_nlink, 1);
        }
    }

    #[test]
    fn metadata_quota_replay_preserves_the_base_tree_and_fifo_registry_before_retry() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        for index in 0..24 {
            test_create_inode_kind(index % 5, alloc::format!("/quota-replayed-{index}").as_bytes()).unwrap();
        }
        load_image(image.len() as u64, &mut source).unwrap();
        let fifo = test_registered_fifo(b"/base-owned-fifo", ROOTFS_DEV);
        let before = metadata_budget_usage().0;
        set_metadata_budget_bytes(before).unwrap();
        let tree = export_tree();
        let journal = storage.0.lock().clone();
        assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source), Err(Errno::ENOMEM));
        assert!(persistence_recovery_is_pristine());
        assert_eq!(metadata_budget_usage().0, before);
        assert_eq!(export_tree(), tree);
        assert_eq!(*storage.0.lock(), journal);
        assert!(PERSISTENT_ROOTFS.lock().is_none());
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/base-owned-fifo"), Some(fifo));
        set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        for index in 0..24 { lstat(alloc::format!("/quota-replayed-{index}").as_bytes()).unwrap(); }
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/base-owned-fifo"), None);
    }

    #[test]
    fn metadata_quota_charges_retained_arena_capacity_after_partial_reservation_failure() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        test_fill_inode_capacity();
        let before = metadata_budget_usage().0;
        let old_capacity = ROOTFS.with(|state| state.inodes.capacity());
        ROOTFS.with(|state| state.fail_inode_reservation = Some(InodeReservationFailure::Reclamation));
        assert_eq!(ROOTFS.with(|state| state.reserve_inode_slots(1)), Err(Errno::ENOMEM));
        let new_capacity = ROOTFS.with(|state| state.inodes.capacity());
        assert!(new_capacity > old_capacity);
        let retained = metadata_budget_usage().0;
        assert_eq!(retained - before, (new_capacity - old_capacity) * INODE_METADATA_BYTES);
        set_metadata_budget_bytes(retained).unwrap();
        ROOTFS.with(|state| state.fail_inode_reservation = None);
        assert_eq!(test_create_inode_kind(0, b"/denied"), Err(Errno::ENOMEM));
        assert_eq!(metadata_budget_usage().0, retained);
        set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
        test_create_inode_kind(0, b"/retried").unwrap();
        reset();
        assert_eq!(metadata_budget_usage().0, 0);
    }

    #[test]
    fn persistent_creations_reserve_inode_and_reclamation_slots_before_journal_writes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        for kind in 0..5 {
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let armed = Arc::new(AtomicBool::new(false));
            let prepared = Arc::new(AtomicBool::new(true));
            let writes = Arc::new(AtomicU32::new(0));
            let storage = ReservationObservedStorage {
                inner: SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))),
                armed: armed.clone(), prepared: prepared.clone(), writes: writes.clone(),
            };
            enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
            test_fill_inode_capacity();
            armed.store(true, Ordering::SeqCst);
            test_create_inode_kind(kind, b"/arena-created").unwrap();
            assert!(writes.load(Ordering::SeqCst) > 0);
            assert!(prepared.load(Ordering::SeqCst), "creation kind {kind} allocated after journal publication");
        }
    }

    #[test]
    fn inode_reservation_failures_precede_persistent_creation_and_allow_slot_reuse() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        for stage in [InodeReservationFailure::Arena, InodeReservationFailure::Reclamation] {
            for kind in 0..5 {
                let mut source = image_host(&image);
                load_image(image.len() as u64, &mut source).unwrap();
                let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
                let fillers = test_fill_inode_capacity();
                let before = export_tree();
                let journal_before = storage.0.lock().clone();
                let counters = ROOTFS.with(|state| (state.inodes.len(), state.free_inodes.len(), state.next_ino));
                ROOTFS.with(|state| state.fail_inode_reservation = Some(stage));
                assert_eq!(test_create_inode_kind(kind, b"/arena-rejected"), Err(Errno::ENOMEM), "{stage:?} kind {kind}");
                assert_eq!(export_tree(), before);
                assert_eq!(*storage.0.lock(), journal_before);
                assert_eq!(ROOTFS.with(|state| (state.inodes.len(), state.free_inodes.len(), state.next_ino)), counters);
                assert_eq!(lstat(b"/arena-rejected").err(), Some(Errno::ENOENT));
                let existing = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
                assert!(release_handle(existing));
                let reused = fillers.last().unwrap();
                unlink(reused).unwrap();
                let capacities = ROOTFS.with(|state| (state.inodes.capacity(), state.free_inodes.capacity()));
                test_create_inode_kind(kind, b"/arena-reused").unwrap();
                assert_eq!(ROOTFS.with(|state| (state.inodes.capacity(), state.free_inodes.capacity())), capacities);
                ROOTFS.with(|state| state.fail_inode_reservation = None);
                test_create_inode_kind(kind, b"/arena-retried").unwrap();
            }
        }
    }

    #[test]
    fn root_inode_allocation_failure_is_typed_and_retryable() {
        let _guard = TestGuard::acquire();
        for stage in [InodeReservationFailure::Arena, InodeReservationFailure::Reclamation] {
            reset();
            ROOTFS.with(|state| state.fail_inode_reservation = Some(stage));
            assert_eq!(lstat(b"/").err(), Some(Errno::ENOMEM));
            ROOTFS.with(|state| {
                assert!(state.root.is_none());
                assert!(state.inodes.is_empty());
                assert!(state.free_inodes.is_empty());
                assert_eq!(state.next_ino, 1);
                state.fail_inode_reservation = None;
            });
            assert_eq!(lstat(b"/").unwrap().st_ino, 1);
        }
    }

    #[test]
    fn inode_reclamation_after_unlink_does_not_grow_its_free_list() {
        let _guard = TestGuard::acquire();
        let mut handles = Vec::new();
        for index in 0..64 {
            let path = alloc::format!("/held-{index}");
            let handle = open(path.as_bytes(), O_CREAT | O_WRONLY, 0o600, 0, 0).unwrap();
            unlink(path.as_bytes()).unwrap();
            handles.push(handle);
        }
        let capacity = ROOTFS.with(|state| {
            assert!(state.free_inodes.capacity() >= state.inodes.len());
            state.fail_inode_reservation = Some(InodeReservationFailure::Reclamation);
            (state.free_inodes.as_ptr() as usize, state.free_inodes.capacity())
        });
        for handle in handles { assert!(release_handle(handle)); }
        ROOTFS.with(|state| {
            assert_eq!(state.free_inodes.len(), 64);
            assert_eq!((state.free_inodes.as_ptr() as usize, state.free_inodes.capacity()), capacity);
            state.fail_inode_reservation = None;
        });
    }

    #[test]
    fn replay_inode_reservation_failure_keeps_the_base_tree_and_fifo_registry() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        for index in 0..24 {
            test_create_inode_kind(index % 5, alloc::format!("/replayed-{index}").as_bytes()).unwrap();
        }
        for stage in [InodeReservationFailure::Arena, InodeReservationFailure::Reclamation] {
            load_image(image.len() as u64, &mut source).unwrap();
            let fifo = test_registered_fifo(b"/base-owned-fifo", ROOTFS_DEV);
            let tree = export_tree();
            let journal = storage.0.lock().clone();
            ROOTFS.with(|state| state.fail_inode_reservation = Some(stage));
            assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source), Err(Errno::ENOMEM));
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), journal);
            assert!(PERSISTENT_ROOTFS.lock().is_none());
            assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/base-owned-fifo"), Some(fifo));
            ROOTFS.with(|state| state.fail_inode_reservation = None);
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            for index in 0..24 { lstat(alloc::format!("/replayed-{index}").as_bytes()).unwrap(); }
            assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/base-owned-fifo"), None);
        }
    }

    #[test]
    fn recovery_retry_authority_ends_before_namespace_and_fifo_publication() {
        let _guard = TestGuard::acquire();
        for resizable in [false, true] {
            let image = tiny_vfs_described().to_vec();
            let digest: [u8; 32] = Sha256::digest(&image).into();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            assert!(!persistence_recovery_is_pristine());
            enable_persistence_internal(Box::new(storage.clone()), None, digest, resizable, &mut source).unwrap();
            assert!(!persistence_recovery_is_pristine());
            if resizable { test_create_inode_kind(3, b"/published-before-fifo").unwrap(); }
            load_image(image.len() as u64, &mut source).unwrap();
            let journal = storage.0.lock().clone();
            FAIL_PERSISTENCE_FIFO_RESTORE.store(true, Ordering::SeqCst);
            assert_eq!(enable_persistence_internal(Box::new(storage.clone()), None, digest, resizable, &mut source), Err(Errno::ENOMEM));
            assert!(persistence_recovery_is_pristine());
            assert!(PERSISTENT_ROOTFS.lock().is_none());
            assert_eq!(*storage.0.lock(), journal);
            assert_eq!(lstat(b"/published-before-fifo").unwrap_err(), Errno::ENOENT);
            assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/published-before-fifo"), None);
            enable_persistence_internal(Box::new(storage.clone()), None, digest, resizable, &mut source).unwrap();
            if resizable {
                assert_eq!(lstat(b"/published-before-fifo").unwrap().st_mode & S_IFMT, S_IFIFO);
                assert!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/published-before-fifo").is_some());
            }
            assert!(!persistence_recovery_is_pristine());
            assert_eq!(enable_persistence_internal(Box::new(storage.clone()), None, digest, resizable, &mut source), Err(Errno::EBUSY));
            assert!(!persistence_recovery_is_pristine());
        }
    }

    #[test]
    fn journal_byte_budget_refusal_preserves_the_base_and_qualifies_for_conversion() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        test_create_inode_kind(0, b"/admitted-after-conversion").unwrap();
        load_image(image.len() as u64, &mut source).unwrap();
        let before = storage.0.lock().clone();
        let tree = export_tree();
        let usage = journal_state_budget_usage().0;
        {
            let _budget = crate::prepared_map::test_budget(usage + 1);
            assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source), Err(Errno::ENOMEM));
            assert!(persistence_recovery_is_pristine());
            assert_eq!(journal_state_budget_usage().0, usage);
            assert_eq!(*storage.0.lock(), before);
            assert_eq!(export_tree(), tree);
            assert!(PERSISTENT_ROOTFS.lock().is_none());
        }
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        assert!(lstat(b"/admitted-after-conversion").is_ok());
    }

    fn test_registered_fifo(path: &[u8], device: u64) -> usize {
        let mut metadata = lstat(b"/").unwrap();
        metadata.st_dev = device;
        metadata.st_mode = S_IFIFO | 0o600;
        metadata.st_nlink = 1;
        let pipe = crate::pipe::PipeBuffer::new_fifo(64, metadata);
        let index = unsafe { crate::pipe::global_pipe_table() }.alloc(pipe);
        assert!(unsafe { crate::fifo::global_fifo_table() }.register(path.to_vec(), index));
        index
    }

    fn test_remove_registered_fifo(path: &[u8]) {
        if let Some(index) = unsafe { crate::fifo::global_fifo_table() }.remove(path) {
            unsafe { crate::pipe::global_pipe_table() }.remove_fifo_name(index);
        }
    }

    #[test]
    fn reset_removes_unreachable_rootfs_fifo_aliases_but_preserves_open_endpoints() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let index = test_registered_fifo(b"/lost-fifo", ROOTFS_DEV);
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(index).unwrap();
        pipe.prepare_fifo_io().unwrap();
        pipe.add_fifo_name();
        pipe.add_fifo_endpoint_ref(crate::pipe::FifoOpenSide::Reader);
        pipe.add_fifo_endpoint_ref(crate::pipe::FifoOpenSide::Writer);
        pipe.publish_fifo_read_write_open();
        assert_eq!(pipe.write(b"live"), 4);
        assert!(unsafe { crate::fifo::global_fifo_table() }.register(b"/lost-fifo-alias".to_vec(), index));
        reset();
        let original = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/lost-fifo");
        let alias = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/lost-fifo-alias");
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(index).unwrap();
        let names = pipe.fifo_name_count();
        let nlink = pipe.fifo_metadata().unwrap().st_nlink;
        let mut bytes = [0; 4];
        let read = pipe.read(&mut bytes);
        test_remove_registered_fifo(b"/lost-fifo");
        test_remove_registered_fifo(b"/lost-fifo-alias");
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get_mut(index).unwrap();
        pipe.close_read_end();
        pipe.close_write_end();
        unsafe { crate::pipe::global_pipe_table() }.free_if_closed(index);
        assert_eq!((original, alias, names, nlink), (None, None, 0, 0));
        assert_eq!(read, 4);
        assert_eq!(&bytes, b"live");
        assert!(unsafe { crate::pipe::global_pipe_table() }.get(index).is_none());
    }

    #[test]
    fn reset_does_not_remove_a_foreign_fifo_shadowing_a_rootfs_name() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_special(b"/shadowed-fifo", 0o600, 0, 0, 2, S_IFIFO).unwrap();
        link(b"/shadowed-fifo", b"/visible-fifo").unwrap();
        let index = test_registered_fifo(b"/shadowed-fifo", ROOTFS_DEV + 1);
        let foreign = unsafe { crate::pipe::global_pipe_table() }.get_mut(index).unwrap();
        foreign.prepare_fifo_io().unwrap();
        foreign.add_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        assert_eq!(foreign.write(b"foreign"), 7);
        restore_fifo_registry().unwrap();
        let visible = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/visible-fifo").unwrap();
        assert_ne!(visible, index);
        let root = unsafe { crate::pipe::global_pipe_table() }.get_mut(visible).unwrap();
        root.prepare_fifo_io().unwrap();
        root.add_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        assert_eq!(root.write(b"root"), 4);
        let mut root_bytes = [0; 4];
        assert_eq!(root.read(&mut root_bytes), 4);
        assert_eq!(&root_bytes, b"root");
        root.close_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        reset();
        let registration = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/shadowed-fifo");
        let names = unsafe { crate::pipe::global_pipe_table() }.get(index).map(|pipe| pipe.fifo_name_count());
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/visible-fifo"), None);
        let foreign = unsafe { crate::pipe::global_pipe_table() }.get_mut(index).unwrap();
        assert_eq!(foreign.fifo_metadata().unwrap().st_dev, ROOTFS_DEV + 1);
        let mut bytes = [0; 7];
        assert_eq!(foreign.read(&mut bytes), 7);
        assert_eq!(&bytes, b"foreign");
        foreign.close_reference(crate::pipe::InFlightPipeRefKind::ReadWrite);
        test_remove_registered_fifo(b"/shadowed-fifo");
        assert_eq!(registration, Some(index));
        assert_eq!(names, Some(1));
    }

    #[test]
    fn reset_reclaims_closed_orphan_fifos_without_claiming_a_reused_foreign_slot() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let index = test_registered_fifo(b"/reused-fifo", ROOTFS_DEV);
        reset();
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/reused-fifo"), None);
        assert!(unsafe { crate::pipe::global_pipe_table() }.get(index).is_none());
        let foreign = test_registered_fifo(b"/reused-fifo", ROOTFS_DEV + 1);
        assert_eq!(foreign, index);
        reset();
        let registration = unsafe { crate::fifo::global_fifo_table() }.lookup(b"/reused-fifo");
        test_remove_registered_fifo(b"/reused-fifo");
        assert_eq!(registration, Some(foreign));
    }

    #[test]
    fn namespace_path_admission_refusal_preserves_the_pending_entry_for_retry() {
        use crate::metadata_budget::MetadataBudget;
        static BUDGET: MetadataBudget = MetadataBudget::new(0);
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/d", 0o755, 0, 0, 2).unwrap();
        let long_path = alloc::format!("/d/{}", "a".repeat(200));
        insert_base_file(long_path.as_bytes(), 0, 0, 0o644, 0, 0, 3).unwrap();
        insert_base_file(b"/d/z", 0, 0, 0o644, 0, 0, 4).unwrap();
        ROOTFS.with(|state| {
            let mut cursor = NamespaceCursor::new_in(state, &BUDGET).unwrap();
            assert!(matches!(cursor.next(), Err(Errno::ENOMEM)));
            assert_eq!(BUDGET.usage().0, 0);
            BUDGET.set_limit(65536).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, b"/d");
            let used = BUDGET.usage().0;
            BUDGET.set_limit(used).unwrap();
            assert!(matches!(cursor.next(), Err(Errno::ENOMEM)));
            assert_eq!(BUDGET.usage().0, used);
            assert_eq!(&*cursor.path, b"/d");
            BUDGET.set_limit(65536).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, long_path.as_bytes());
            assert_eq!(cursor.next().unwrap().unwrap().1, b"/d/z");
            assert!(cursor.next().unwrap().is_none());
            drop(cursor);
            assert_eq!(BUDGET.usage().0, 0);
        });
    }

    #[test]
    fn namespace_path_refusal_after_ancestor_growth_retries_the_same_descent() {
        use crate::metadata_budget::MetadataBudget;
        static BUDGET: MetadataBudget = MetadataBudget::new(65536);
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/d", 0o755, 0, 0, 2).unwrap();
        let long_path = alloc::format!("/d/{}", "a".repeat(200));
        insert_base_dir(long_path.as_bytes(), 0o755, 0, 0, 3).unwrap();
        ROOTFS.with(|state| {
            let mut cursor = NamespaceCursor::new_in(state, &BUDGET).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, b"/d");
            let used = BUDGET.usage().0;
            let ancestor_charge = 2 * core::mem::size_of::<(NamespaceEntries<'_>, usize)>();
            BUDGET.set_limit(used + 2 * ancestor_charge).unwrap();
            assert!(matches!(cursor.next(), Err(Errno::ENOMEM)));
            assert_eq!(cursor.ancestors.capacity(), 2);
            assert_eq!(cursor.ancestors.len(), 1);
            assert_eq!(cursor.directories, 2);
            assert_eq!(&*cursor.path, b"/d");
            assert_eq!(BUDGET.usage().0, used + ancestor_charge);
            BUDGET.set_limit(65536).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, long_path.as_bytes());
            assert!(cursor.next().unwrap().is_none());
            drop(cursor);
            assert_eq!(BUDGET.usage().0, 0);
        });
    }

    #[test]
    fn namespace_ancestor_admission_refusal_preserves_depth_and_releases_credit() {
        use crate::metadata_budget::MetadataBudget;
        static BUDGET: MetadataBudget = MetadataBudget::new(65536);
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/d", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/d/d", 0o755, 0, 0, 3).unwrap();
        ROOTFS.with(|state| {
            let mut cursor = NamespaceCursor::new_in(state, &BUDGET).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, b"/d");
            let used = BUDGET.usage().0;
            BUDGET.set_limit(used).unwrap();
            assert!(matches!(cursor.next(), Err(Errno::ENOMEM)));
            assert_eq!(BUDGET.usage().0, used);
            assert_eq!(cursor.ancestors.len(), 1);
            assert_eq!(cursor.directories, 2);
            BUDGET.set_limit(65536).unwrap();
            assert_eq!(cursor.next().unwrap().unwrap().1, b"/d/d");
            assert!(cursor.next().unwrap().is_none());
            let expected = 2 * (cursor.path.capacity()
                + cursor.ancestors.capacity() * core::mem::size_of::<(NamespaceEntries<'_>, usize)>());
            assert_eq!(BUDGET.usage().0, expected);
            drop(cursor);
            assert_eq!(BUDGET.usage().0, 0);
        });
    }

    #[test]
    fn fifo_registry_restore_refusal_publishes_no_prefix_and_can_retry_all_aliases() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_special(b"/fifo", 0o640, 7, 8, 2, S_IFIFO).unwrap();
        link(b"/fifo", b"/alias").unwrap();
        insert_base_special(b"/other", 0o600, 7, 8, 3, S_IFIFO).unwrap();
        let pipes = unsafe { crate::pipe::global_pipe_table() };
        drop(pipes.prepare_slots(2).unwrap());
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let active = pipes.count_active();
        for allocations in 0..5 {
            crate::prepared_map::fail_after_allocations(allocations);
            assert_eq!(restore_fifo_registry(), Err(Errno::ENOMEM));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
            assert_eq!(unsafe { crate::pipe::global_pipe_table() }.count_active(), active);
            let names = unsafe { crate::fifo::global_fifo_table() };
            assert_eq!(names.lookup(b"/fifo"), None);
            assert_eq!(names.lookup(b"/alias"), None);
            assert_eq!(names.lookup(b"/other"), None);
            assert_eq!(lstat(b"/fifo").unwrap().st_nlink, 2);
        }
        restore_fifo_registry().unwrap();
        let names = unsafe { crate::fifo::global_fifo_table() };
        let original = names.lookup(b"/fifo").unwrap();
        assert_eq!(names.lookup(b"/alias"), Some(original));
        assert_ne!(names.lookup(b"/other"), Some(original));
        assert_eq!(unsafe { crate::pipe::global_pipe_table() }.get(original).unwrap().fifo_name_count(), 2);
        assert_eq!(names.remove(b"/alias"), Some(original));
        unsafe { crate::pipe::global_pipe_table() }.remove_fifo_name(original);
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        crate::prepared_map::fail_after_allocations(2);
        assert_eq!(restore_fifo_registry(), Err(Errno::ENOMEM));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/alias"), None);
        assert_eq!(unsafe { crate::pipe::global_pipe_table() }.get(original).unwrap().fifo_name_count(), 1);
        restore_fifo_registry().unwrap();
        assert_eq!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/alias"), Some(original));
        assert_eq!(unsafe { crate::pipe::global_pipe_table() }.get(original).unwrap().fifo_name_count(), 2);
        clear_fifo_registry();
        assert_eq!(unsafe { crate::pipe::global_pipe_table() }.count_active(), active);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn fifo_namespace_walk_retains_only_depth_scratch_and_shares_restored_aliases() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let suffix = "n".repeat(200);
        for index in 0..512 {
            let directory = alloc::format!("/d{index:04}-{suffix}");
            insert_base_dir(directory.as_bytes(), 0o755, 0, 0, 2 + index * 2).unwrap();
            let file = alloc::format!("{directory}/file");
            insert_host_file(file.as_bytes(), 0, 0, 0o644, 0, 0, 3 + index * 2).unwrap();
        }
        let mut path = alloc::format!("/d0000-{suffix}").into_bytes();
        for depth in 0..40 {
            path.extend_from_slice(b"/deep");
            insert_base_dir(&path, 0o700, 0, 0, 2000 + depth).unwrap();
        }
        path.extend_from_slice(b"/fifo");
        insert_base_special(&path, 0o640, 7, 8, 3000, S_IFIFO).unwrap();
        link(&path, b"/z-alias").unwrap();
        symlink(&path, b"/link-not-followed", 0, 0).unwrap();
        ROOTFS.with(|state| {
            let mut cursor = NamespaceCursor::new(state).unwrap();
            let mut count = 0;
            let mut fifos = 0;
            let mut scratch_peak = 0;
            while let Some((_, _, inode)) = cursor.next().unwrap() {
                count += 1;
                if matches!(inode.kind, InodeKind::Special(S_IFIFO)) { fifos += 1; }
                scratch_peak = scratch_peak.max(cursor.path.capacity()
                    + cursor.ancestors.capacity() * core::mem::size_of::<(NamespaceEntries<'_>, usize)>());
            }
            assert_eq!(count, 1067);
            assert_eq!(fifos, 2);
            assert!(scratch_peak <= 16 * 1024, "namespace traversal scratch: {scratch_peak}");
        });
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        ROOTFS.with(|state| {
            let view = RecoveryNamespaceView::new(state, &[], None, &[]).unwrap();
            let mut fifos = 0;
            view.for_each_fifo_path(&mut |_, _, _| {
                fifos += 1;
                assert!(crate::io_buffer::IO_MEMORY.usage().0 - baseline <= 16 * 1024);
                Ok(())
            }).unwrap();
            assert_eq!(fifos, 2);
        });
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            let mut visited = 0;
            assert_eq!(for_each_fifo_path(|_, _, metadata| {
                visited += 1;
                assert_eq!((metadata.st_uid, metadata.st_gid, metadata.st_nlink), (7, 8, 2));
                Err(error)
            }), Err(error));
            assert_eq!(visited, 1);
        }
        restore_fifo_registry().unwrap();
        let registry = unsafe { crate::fifo::global_fifo_table() };
        let original = registry.lookup(&path).unwrap();
        assert_eq!(registry.lookup(b"/z-alias"), Some(original));
        assert_eq!(registry.lookup(b"/link-not-followed"), None);
        let pipe = unsafe { crate::pipe::global_pipe_table() }.get(original).unwrap();
        assert_eq!(pipe.fifo_name_count(), 2);
        assert_eq!(pipe.fifo_metadata().unwrap().st_nlink, 2);
    }

    #[test]
    fn fifo_namespace_walk_rejects_cycles_and_reset_can_discard_them() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        ROOTFS.with(|state| {
            let root = state.root.unwrap();
            let InodeKind::Dir(entries) = &mut state.get_mut(root).unwrap().kind else { panic!() };
            entries.try_insert(b"cycle", root).unwrap();
            let mut cursor = NamespaceCursor::new(state).unwrap();
            assert!(matches!(cursor.next(), Err(Errno::EIO)));
        });
        reset();
        ROOTFS.with(|state| assert!(state.inodes.is_empty()));
    }

    #[test]
    fn lazy_resource_limits_deduplicate_files_and_archives_without_fetching() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/first", 7, 4, 0o755, 0, 0, 2).unwrap();
        insert_base_file(b"/second", 8, 4, 0o755, 0, 0, 3).unwrap();
        set_deferred_source(b"/first", b"binaries/programs/tool.wasm", b"").unwrap();
        set_deferred_source(b"/second", b"binaries/programs/tool.wasm", b"").unwrap();
        declare_archive(9, 20).unwrap();
        set_archive_source(9, b"archives/data.zip", b"").unwrap();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _limit = crate::io_buffer::test_budget(baseline);
            assert_eq!(lazy_resource_limits(), Err(Errno::ENOMEM));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
        assert_eq!(
            lazy_resource_limits().unwrap(),
            alloc::vec![
                (crate::IoBuffer::copy_from(b"archives/data.zip").unwrap(), 20),
                (crate::IoBuffer::copy_from(b"binaries/programs/tool.wasm").unwrap(), 4),
            ]
        );
        assert_eq!(
            deferred_source(b"/first").unwrap().0,
            b"binaries/programs/tool.wasm"
        );
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    /// Insert a host-backed base file AND record the address this test host
    /// serves it at, mirroring what `load_image` does from a deferred record:
    /// the file goes in, then its source is attached.
    ///
    /// Before URIs the address was implicit — the blob id WAS the address, as
    /// far as a host holding a table was concerned. It is explicit now, which
    /// is why a fixture has to state it: a deferred file nobody gave an address
    /// cannot be fetched, and that is the truth rather than an inconvenience.
    #[allow(clippy::too_many_arguments)]
    fn insert_host_file(
        path: &[u8],
        blob_id: u64,
        size: u64,
        mode: u32,
        uid: u32,
        gid: u32,
        ino: u64,
    ) -> Result<(), Errno> {
        insert_base_file(path, blob_id, size, mode, uid, gid, ino)?;
        set_deferred_source(path, &blob_uri(blob_id), b"")
    }

    /// The address this test host serves a blob at.
    ///
    /// The fixtures register it and the host resolves it, which is the whole
    /// shape of the contract now: an image says where bytes are and a host
    /// fetches from there. Derived from the id the fixtures already use so the
    /// two cannot drift, and prefixed `test:` so it is obviously not a URL
    /// anything would really fetch.
    fn blob_uri(blob_id: u64) -> alloc::vec::Vec<u8> {
        alloc::format!("test:blob/{blob_id}").into_bytes()
    }

    /// The address this test host serves a lazy ARCHIVE at.
    fn archive_uri(archive_id: u32) -> alloc::vec::Vec<u8> {
        alloc::format!("test:archive/{archive_id}").into_bytes()
    }

    /// A small in-memory byte store standing in for the host `byte_source`
    /// dispatch closure — ONE closure serving `ByteReq::Deferred` for both
    /// standalone blobs ([`blob_uri`]) and whole archives ([`archive_uri`]),
    /// mirroring the kernel's single `&mut host` capture. An address with no
    /// matching entry returns `ENOSYS` ("no backing configured for this
    /// transport op"), not a silent success. Returns the closure alongside a
    /// shared call counter (incremented only for archive fetches) so tests can
    /// assert whether an archive fetch actually happened (vs. served from the
    /// archive's `members` cache).
    fn make_byte_source(
        blobs: alloc::vec::Vec<(u64, alloc::vec::Vec<u8>)>,
        archives: alloc::vec::Vec<(u32, alloc::vec::Vec<u8>)>,
    ) -> (
        impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
        alloc::rc::Rc<core::cell::Cell<usize>>,
    ) {
        let calls = alloc::rc::Rc::new(core::cell::Cell::new(0usize));
        let counter = calls.clone();
        let source = move |req: ByteReq, buf: &mut [u8]| -> Result<usize, Errno> {
            match req {
                // ONE arm for what used to be two, because the host is asked
                // one question now: bytes for this address. Which kind of
                // resource it is is the image's business, not the transport's.
                ByteReq::Deferred { uri, offset } => {
                    if let Some((_, data)) =
                        blobs.iter().find(|(id, _)| blob_uri(*id) == uri)
                    {
                        let start = offset as usize;
                        if start >= data.len() {
                            return Ok(0);
                        }
                        let n = core::cmp::min(buf.len(), data.len() - start);
                        buf[..n].copy_from_slice(&data[start..start + n]);
                        return Ok(n);
                    }
                    counter.set(counter.get() + 1);
                    let (_, data) = archives
                        .iter()
                        .find(|(id, _)| archive_uri(*id) == uri)
                        .ok_or(Errno::ENOSYS)?;
                    let start = offset as usize;
                    if start >= data.len() {
                        return Ok(0);
                    }
                    let n = core::cmp::min(buf.len(), data.len() - start);
                    buf[..n].copy_from_slice(&data[start..start + n]);
                    Ok(n)
                }
                // This fixture host serves blob and archive bytes only; a test
                // that reaches for image bytes through it is asking for a
                // capability it never installed, and ENOSYS is the truthful
                // answer (the same one a real host gives before an image source
                // is wired).
                ByteReq::DiscardDeferred { .. } => Ok(0),
                ByteReq::Image { .. } => Err(Errno::ENOSYS),
            }
        };
        (source, calls)
    }

    fn build_sample_tree() {
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/usr", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/usr/bin", 0o755, 0, 0, 3).unwrap();
        insert_host_file(b"/usr/bin/hello", 42, 11, 0o755, 0, 0, 4).unwrap();
        insert_base_symlink(b"/usr/bin/hi", b"hello", 0o777, 0, 0, 5).unwrap();
        insert_host_file(b"/etc-issue-blob-empty", 43, 0, 0o644, 0, 0, 6).unwrap();
    }

    /// The real tiny.zip fixture (see `zip.rs` tests for member facts): a
    /// DEFLATE member `bin/big.txt` (4096 bytes, all `b'a'`) and a STORE
    /// member `etc/small.txt` (`b"hello\n"`).
    const TINY_ZIP: &[u8] = include_bytes!("testdata/tiny.zip");

    /// Register archive `archive_id`'s manifest-authoritative `size` directly
    /// in the registry. Test-only: production registers archives from an
    /// image's `SDEF` section in `load_image`.
    fn insert_archive_entry(archive_id: u32, size: u64) {
        ROOTFS.with(|state| {
            state.archives.insert(
                archive_id,
                ArchiveEntry::new(size, &archive_uri(archive_id), crate::sdef::DIGEST_NONE, b"").unwrap(),
            );
        });
    }

    /// `/lazy/f` is a `LazyMember` pointing at `bin/big.txt` (size 4096) in
    /// archive 7, whose manifest-recorded size is `TINY_ZIP.len()`.
    fn build_lazy_tree() {
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/lazy", 0o755, 0, 0, 2).unwrap();
        insert_lazy_file(
            b"/lazy/f",
            7,
            b"bin/big.txt",
            4096,
            0o644,
            0,
            0,
            3,
            b"",
            b"",
            b"",
        )
        .unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
    }

    #[test]
    fn owns_path_excludes_tmpfs_scratch_and_relative() {
        assert!(owns_path(b"/usr/bin/ls"));
        assert!(owns_path(b"/"));
        assert!(owns_path(b"/etc/passwd"));
        assert!(owns_path(b"/home/maker/.fdoom.tar/savegame/doomsav0.dsg"));
        assert!(owns_path(b"/root/settings"));
        assert!(owns_path(b"/srv/site"));
        // tmpfs scratch prefixes belong to tmpfs, not rootfs.
        assert!(!owns_path(b"/tmp"));
        assert!(!owns_path(b"/tmp/x"));
        assert!(!owns_path(b"/var/run/php.sock"));
        // non-absolute is never a rootfs path.
        assert!(!owns_path(b"relative"));
    }

    #[test]
    fn owns_path_excludes_registered_foreign_mounts() {
        let _g = TestGuard::acquire();
        // Baseline: with nothing registered, sibling `/` paths are overlay-owned.
        assert!(owns_path(b"/run/kandelo-run/work/1-1.wasm"));
        assert!(owns_path(b"/mnt/data/file"));

        // `/dev/shm` is NOT one of them any more: the in-kernel tmpfs serves it,
        // so the overlay never owned it regardless of what the host registers.
        // It used to be the example here, which stopped being true the moment
        // POSIX shared memory moved in-kernel.
        assert!(!owns_path(b"/dev/shm/sem.foo"));
        assert!(crate::tmpfs::owns_path(b"/dev/shm/sem.foo"));

        // The host registers the sibling mounts that remain after dropping `/`.
        let n = set_foreign_prefixes(b"/dev/shm\0/run/kandelo-run\0/mnt/data\0");
        assert_eq!(n, 3);

        // Paths at or under a foreign prefix are NOT overlay-owned: they must
        // fall through to the sibling host mount.
        assert!(!owns_path(b"/run/kandelo-run"));
        assert!(!owns_path(b"/run/kandelo-run/work/1-1.wasm"));
        assert!(!owns_path(b"/mnt/data/file"));

        // Siblings that share a leading path segment but are NOT under a
        // foreign mount stay overlay-owned (component-boundary match).
        assert!(owns_path(b"/run/other"));
        assert!(owns_path(b"/run/kandelo-runner")); // not `/run/kandelo-run/...`
        assert!(owns_path(b"/mnt/datastore")); // not `/mnt/data/...`
        assert!(owns_path(b"/usr/bin/ls"));
        assert!(owns_path(b"/"));

        // A fresh (empty) registration restores the greedy default.
        assert_eq!(set_foreign_prefixes(b""), 0);
        assert!(owns_path(b"/run/kandelo-run/work/1-1.wasm"));
    }

    #[test]
    fn set_foreign_prefixes_ignores_root_relative_and_dedupes() {
        let _g = TestGuard::acquire();
        // `/` (the overlay's own root) and non-absolute / empty entries are
        // dropped; trailing slashes trimmed; duplicates collapsed.
        let n = set_foreign_prefixes(b"/\0\0relative\0/dev/shm/\0/dev/shm\0");
        assert_eq!(n, 1);
        assert!(!owns_path(b"/dev/shm/x"));
        assert!(owns_path(b"/")); // root is never foreign
    }

    #[test]
    fn registering_a_foreign_prefix_creates_its_parent_directories() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/usr", 0o755, 0, 0, 2).unwrap();

        // `/usr/local` and `/usr/local/lib` are missing from the image; the
        // mount point `/usr/local/lib/kandelo` itself belongs to the foreign
        // filesystem and must NOT be created.
        assert_eq!(set_foreign_prefixes(b"/usr/local/lib/kandelo\0"), 1);

        assert!(is_dir(b"/usr/local"));
        assert!(is_dir(b"/usr/local/lib"));
        assert_eq!(lstat(b"/usr/local").unwrap().st_mode & 0o7777, 0o755);
        assert_eq!(lstat(b"/usr/local").unwrap().st_uid, 0);
        assert!(lstat(b"/usr/local/lib/kandelo").is_err());

        // And the created parents are walkable, which is the point: without
        // them the kernel's per-component search cannot reach the mount.
        assert!(!owns_path(b"/usr/local/lib/kandelo/x"));
    }

    #[test]
    fn foreign_mount_parents_are_idempotent_and_top_level_is_a_no_op() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();

        // A mount directly under `/` has no ancestor to synthesise.
        assert_eq!(set_foreign_prefixes(b"/dev\0"), 1);
        assert_eq!(ensure_foreign_mount_parents(), 0);

        // Re-registering an already-satisfied prefix creates nothing more.
        assert_eq!(set_foreign_prefixes(b"/a/b/c\0"), 1);
        assert!(is_dir(b"/a/b"));
        assert_eq!(ensure_foreign_mount_parents(), 0);
    }

    #[test]
    fn foreign_mount_parents_follow_a_symlinked_component() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/opt", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/opt/local", 0o755, 0, 0, 3).unwrap();
        insert_base_symlink(b"/usr", b"/opt", 0o777, 0, 0, 4).unwrap();

        assert_eq!(set_foreign_prefixes(b"/usr/local/lib/kandelo\0"), 1);

        // `/usr` resolved to `/opt`, so the synthesised `lib` lands under the
        // real directory rather than as a sibling of the symlink.
        assert!(is_dir(b"/opt/local/lib"));
        assert!(lstat(b"/usr/local").is_err()); // still only reachable via the link
    }

    #[test]
    fn foreign_mount_parents_stop_at_a_non_directory_rather_than_hide_it() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/usr", 0, 0, 0o644, 0, 0, 2).unwrap();

        assert_eq!(set_foreign_prefixes(b"/usr/local/lib/kandelo\0"), 1);

        // The image says `/usr` is a regular file. That conflict stays visible:
        // the file is untouched and no directory is invented over it.
        assert_eq!(lstat(b"/usr").unwrap().st_mode & S_IFMT, S_IFREG);
        assert!(lstat(b"/usr/local").is_err());
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
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());

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
        let mut blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("the byte source must not be called for an empty file");
        };
        let h = open(b"/etc-issue-blob-empty", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 0);
        assert!(release_handle(h));
    }

    #[test]
    fn open_directory_is_eisdir() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert_eq!(open(b"/usr/bin", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::EISDIR);
    }

    #[test]
    fn cow_write_materializes_base_then_overwrites() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        // O_RDWR == 2.
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        // Overwrite "world" -> "there".
        assert_eq!(write(h, 6, b"there", &mut blob).unwrap(), 5);
        // A reader that panics proves post-COW reads never touch the host.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("post-COW read must be served from the overlay");
        };
        let mut buf = [0u8; 16];
        let n = read(h, 0, &mut buf, &mut panic_blob).unwrap();
        assert_eq!(&buf[..n], b"hello there");
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_size, 11);
        assert!(release_handle(h));
    }

    #[test]
    fn cow_write_past_eof_zero_fills() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        assert_eq!(write(h, 13, b"X", &mut blob).unwrap(), 1);
        let mut buf = [0u8; 32];
        let n = read(h, 0, &mut buf, &mut blob).unwrap();
        assert_eq!(n, 14);
        assert_eq!(&buf[..11], b"hello world");
        assert_eq!(&buf[11..13], &[0u8, 0u8]); // zero-fill gap
        assert_eq!(buf[13], b'X');
        assert!(release_handle(h));
    }

    #[test]
    fn write_clears_setuid_bit() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/suid", 7, 3, 0o4755, 0, 0, 2).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(7u64, b"abc".to_vec())], alloc::vec::Vec::new());
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o4755);
        let h = open(b"/suid", 2, 0, 0, 0).unwrap();
        write(h, 0, b"Z", &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o0755);
        release_handle(h);
    }

    /// The three halves of `clear_setid_on_modify` that `write_clears_setuid_bit`
    /// does not reach: that a no-op does NOT clear, that truncate does, and that
    /// set-group-ID survives on a file the group cannot execute.
    ///
    /// `tmpfs.rs` asserts all three for its own twin of this method
    /// (`write_and_truncate_clear_setid_only_on_real_modification`); rootfs —
    /// the filesystem that owns `/` — asserted only that a real write clears
    /// set-user-ID. The set-group-ID condition in particular was a live branch
    /// with nothing behind it.
    /// An image carrying one setuid-root deferred file, with `digest` declared
    /// or not. Built by the real writer so the section is the one production
    /// emits.
    fn setuid_deferred_image(digest: &[u8]) -> alloc::vec::Vec<u8> {
        let mut w =
            crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(128 * 1024))
                .expect("mkfs");
        let root = w.root();
        w.create_deferred_file(
            root,
            b"sudo",
            0o6755,
            4_242,
            0,
            b"",
            b"https://example.invalid/sudo.wasm",
            digest,
            b"",
        )
        .expect("a setuid-root lazy binary, the shape the unverified-setuid rule is about");
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        let mut image = crate::vfsi_container::header(body.len(), sections.flags())
            .expect("header")
            .to_vec();
        image.extend_from_slice(&body);
        image.extend_from_slice(&crate::vfsi_container::trailer(&sections).expect("trailer"));
        image
    }

    /// An image whose root holds the given entries: `true` for a directory,
    /// `false` for an empty regular file. Declares its (empty) deferred-file
    /// section, as `load_image` requires.
    fn image_with_root_entries(entries: &[(&[u8], bool)]) -> alloc::vec::Vec<u8> {
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(
            crate::kandelo_image_write::KandeloImageConfig::fixed(128 * 1024),
        )
        .expect("mkfs");
        let root = w.root();
        for (name, is_dir) in entries {
            if *is_dir {
                w.mkdir(root, name, 0o755).expect("mkdir");
            } else {
                w.create_file(root, name, 0o644, crate::kandelo_image_write::Content::Bytes(b""))
                    .expect("create file");
            }
        }
        w.declare_deferred_section();
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");
        crate::vfsi_container::wrap(
            &body,
            &crate::vfsi_container::ContainerSections {
                lazy_json: b"",
                archive_json: None,
                metadata_json: None,
                kernel_lazy: None,
            },
        )
        .expect("wrap")
    }

    #[test]
    fn composition_load_preserves_the_image_namespace_without_runtime_mount_points() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(64 * 1024, 32);
        load_image_for_composition(image.len() as u64, image_host(&image)).unwrap();
        assert_eq!(lstat(b"/run").err(), Some(Errno::ENOENT));
        load_image(image.len() as u64, image_host(&image)).unwrap();
        assert_eq!(lstat(b"/run/kandelo/exchange").unwrap().st_mode & S_IFMT, S_IFDIR);
    }

    #[test]
    fn loading_an_image_creates_the_kernel_mount_points() {
        let _guard = TestGuard::acquire();
        // An image with no /run at all still gets the exchange mount point,
        // as an init system creates its runtime mount points at boot.
        let image = image_with_root_entries(&[]);
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        for path in [&b"/run"[..], b"/run/kandelo", b"/run/kandelo/exchange"] {
            let st = lstat(path).unwrap();
            assert_eq!(st.st_mode, S_IFDIR | 0o755, "{}", core::str::from_utf8(path).unwrap());
            assert_eq!((st.st_uid, st.st_gid), (0, 0));
        }
        // An image that already has /run keeps it.
        let image = image_with_root_entries(&[(b"run", true)]);
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(lstat(b"/run/kandelo/exchange").unwrap().st_mode & S_IFMT, S_IFDIR);
    }

    #[test]
    fn an_image_with_a_file_where_a_mount_point_belongs_fails_to_load() {
        let _guard = TestGuard::acquire();
        // A regular file at /run: nothing can be mounted beneath it, and
        // booting anyway would leave the exchange mount unreachable.
        let image = image_with_root_entries(&[(b"run", false)]);
        assert_eq!(
            load_image(image.len() as u64, image_host(&image)),
            Err(Errno::ENOTDIR)
        );
    }

    #[test]
    fn setid_is_demoted_on_deferred_bytes_nothing_can_verify() {
        let _guard = TestGuard::acquire();
        // The rule: "the setuid bit is not honoured on unverified bytes". A
        // deferred setuid-root binary fetched by URL with its LENGTH
        // as the only check is bytes of the right size from wherever the host
        // got them, executing as root inside the guest.
        let image = setuid_deferred_image(b"");
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(
            lstat(b"/sudo").expect("stat").st_mode & 0o7777,
            0o0755,
            "no digest, so not root and not the group either",
        );
        // Demoted, not refused: the file is still there, still deferred, still
        // its real size. Refusing would make every image predating digests
        // unbootable, and the truthful statement is not "these bytes are wrong".
        assert_eq!(lstat(b"/sudo").expect("stat").st_size, 4_242);
        assert!(lazy_info(b"/sudo").expect("described").0);
    }

    #[test]
    fn setid_survives_when_the_image_says_what_the_bytes_must_be() {
        let _guard = TestGuard::acquire();
        // The control, and the reason the demotion above is about
        // VERIFIABILITY rather than about being deferred. Without this the
        // demotion could be stripping set-ID from every lazy file and the test
        // above would read the same.
        let image = setuid_deferred_image(&[0x5Au8; crate::sdef::DIGEST_LEN]);
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(
            lstat(b"/sudo").expect("stat").st_mode & 0o7777,
            0o6755,
            "a declared digest keeps the bits: these bytes can be checked",
        );
    }

    /// An image carrying one setgid lazy-archive member, its archive's digest
    /// declared or not, and no digest of the member's own: the shape the shell
    /// image's `/usr/bin/nethack` takes.
    fn setgid_archive_member_image(archive_digest: &[u8]) -> alloc::vec::Vec<u8> {
        let mut w =
            crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(128 * 1024))
                .expect("mkfs");
        let root = w.root();
        w.declare_lazy_archive(3, 4_096, b"nethack.zip", archive_digest, b"")
            .expect("declare archive");
        let ino = w
            .create_deferred_file(root, b"nethack", 0o2755, 2_048, 3, b"bin/nethack", b"", b"", b"")
            .expect("a setgid member addressed by its archive");
        w.set_owner(ino, 0, 60).expect("root:games");
        w.set_mode(ino, 0o2755).expect("setgid survives a trailing chmod");
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        let mut image = crate::vfsi_container::header(body.len(), sections.flags())
            .expect("header")
            .to_vec();
        image.extend_from_slice(&body);
        image.extend_from_slice(&crate::vfsi_container::trailer(&sections).expect("trailer"));
        image
    }

    #[test]
    fn setid_survives_on_a_member_of_an_archive_the_image_can_verify() {
        let _guard = TestGuard::acquire();
        // The member declares no digest of its own; its archive does, and
        // `ensure_archive_member` refuses archive bytes that fail it before any
        // member is extracted. That verifies the member's bytes too.
        let image = setgid_archive_member_image(&[0x5Au8; crate::sdef::DIGEST_LEN]);
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        let st = lstat(b"/nethack").expect("stat");
        assert_eq!(st.st_mode & 0o7777, 0o2755, "the archive's digest vouches for the member");
        assert_eq!((st.st_uid, st.st_gid), (0, 60));
    }

    #[test]
    fn setid_is_demoted_on_a_member_of_an_archive_nothing_can_verify() {
        let _guard = TestGuard::acquire();
        // The control: neither the member nor its archive names a digest, so
        // the archive digest above is what kept the bits.
        let image = setgid_archive_member_image(b"");
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(lstat(b"/nethack").expect("stat").st_mode & 0o7777, 0o0755);
        assert_eq!(lstat(b"/nethack").expect("stat").st_size, 2_048);
    }

    #[test]
    fn setid_clears_only_on_real_modification_and_respects_group_exec() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/suid", 7, 3, 0o6755, 0, 0, 2).unwrap();
        // Declared WITH a digest, so materializing it verifies and the set-ID
        // bits survive the fetch. Without one they are demoted on arrival (the
        // test above), which would mask the modification behaviour this test is
        // named for. The address is the blob's, because under URI relay a
        // deferred file with no address is EIO before any digest is consulted.
        set_deferred_source(b"/suid", &blob_uri(7), &crate::sdef::digest_of(b"abc"))
            .expect("declare it");
        let (mut blob, _) =
            make_byte_source(alloc::vec![(7u64, b"abc".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/suid", 2, 0, 0, 0).unwrap();

        // A zero-length write is not a modification: both bits survive.
        write(h, 0, b"", &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o6755);

        // A real write clears set-user-ID, and set-group-ID too because the
        // file is group-executable.
        write(h, 0, b"Z", &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o0755);

        // Truncating to the size it already has changes nothing, so the bits
        // stay; a real shrink clears them.
        chmod(b"/suid", 0o6755).unwrap();
        let len = size(h).unwrap();
        truncate_handle(h, len, &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o6755);
        truncate_handle(h, 0, &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o0755);

        // Set-group-ID on a file the GROUP CANNOT EXECUTE is not a
        // privilege the write invalidates, so it survives while set-user-ID
        // goes. This is the `S_IXGRP` branch, which no test reached before.
        chmod(b"/suid", 0o6745).unwrap();
        write(h, 0, b"Y", &mut blob).unwrap();
        assert_eq!(lstat(b"/suid").unwrap().st_mode & 0o7777, 0o2745);

        release_handle(h);
    }

    /// A retry after `EAGAIN` must not write its bytes into a file that
    /// replaced the one it was fetching for.
    ///
    /// This is the kernel-model form of a danger the TypeScript filesystem
    /// guards with an inode compare-and-swap. There, materialization `await`s a
    /// fetch, so a peer can unlink and recreate the path inside that window.
    /// Here there is no window: the byte source answers or returns `EAGAIN`,
    /// the call unwinds, and the guest retries. The risk moves to the retry —
    /// between the two attempts the tree really can change.
    ///
    /// What keeps it correct is POSIX rather than a protocol: the open handle
    /// pins its inode, so `unlink` detaches the NAME while the handle keeps the
    /// FILE, and a replacement created at that name is a different inode. The
    /// retry therefore serves the file the handle still refers to.
    #[test]
    fn a_retry_after_eagain_serves_the_handle_not_the_replacement() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/f", 21, 8, 0o644, 0, 0, 2).unwrap();

        // EAGAIN on the first call, the real bytes on every call after it.
        let calls = alloc::rc::Rc::new(core::cell::Cell::new(0usize));
        let seen = calls.clone();
        let mut source = move |req: ByteReq, dst: &mut [u8]| -> Result<usize, Errno> {
            seen.set(seen.get() + 1);
            if seen.get() == 1 {
                return Err(Errno::EAGAIN);
            }
            let ByteReq::Deferred { offset, .. } = req else {
                return Err(Errno::EIO);
            };
            let data = b"ORIGINAL";
            let start = offset as usize;
            if start >= data.len() {
                return Ok(0);
            }
            let n = core::cmp::min(dst.len(), data.len() - start);
            dst[..n].copy_from_slice(&data[start..start + n]);
            Ok(n)
        };

        let h = open(b"/f", 2, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        // First attempt: the bytes are not ready.
        assert_eq!(read(h, 0, &mut buf, &mut source).unwrap_err(), Errno::EAGAIN);

        // Between the attempts the tree changes underneath, exactly as another
        // process would change it.
        unlink(b"/f").unwrap();
        let replacement = open(b"/f", O_CREAT | 2, 0o644, 0, 0).unwrap();
        write(replacement, 0, b"REPLACED", &mut source).unwrap();

        // The retry serves the handle's file, not the new name-holder.
        let n = read(h, 0, &mut buf, &mut source).unwrap();
        assert_eq!(&buf[..n], b"ORIGINAL");

        // And the replacement is untouched by the fetch that was in flight.
        let mut other = [0u8; 16];
        let m = read(replacement, 0, &mut other, &mut source).unwrap();
        assert_eq!(&other[..m], b"REPLACED");

        assert!(release_handle(h));
        assert!(release_handle(replacement));
    }

    #[test]
    fn otrunc_discards_base_without_reading_blob() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // O_WRONLY|O_TRUNC == 1|0o1000; blob reader must not be called.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("O_TRUNC must not read base bytes");
        };
        let h = open(b"/usr/bin/hello", 1 | O_TRUNC, 0, 0, 0).unwrap();
        assert_eq!(size(h).unwrap(), 0);
        assert_eq!(write(h, 0, b"new", &mut panic_blob).unwrap(), 3);
        let mut buf = [0u8; 8];
        assert_eq!(read(h, 0, &mut buf, &mut panic_blob).unwrap(), 3);
        assert_eq!(&buf[..3], b"new");
        release_handle(h);
    }

    #[test]
    fn create_new_file_under_dir() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![], alloc::vec::Vec::new());
        // O_CREAT|O_WRONLY == 0o100|1.
        let h = open(b"/usr/bin/fresh", O_CREAT | 1, 0o644, 7, 8).unwrap();
        assert_eq!(write(h, 0, b"data", &mut blob).unwrap(), 4);
        release_handle(h);
        let st = lstat(b"/usr/bin/fresh").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_mode & 0o7777, 0o644);
        assert_eq!(st.st_uid, 7);
        assert_eq!(st.st_gid, 8);
        assert_eq!(st.st_size, 4);
        // O_CREAT|O_EXCL on the now-existing file fails.
        assert_eq!(
            open(b"/usr/bin/fresh", O_CREAT | O_EXCL | 1, 0o644, 0, 0).unwrap_err(),
            Errno::EEXIST
        );
    }

    #[test]
    fn truncate_grow_and_shrink() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", 2, 0, 0, 0).unwrap();
        // Shrink to 5.
        truncate_handle(h, 5, &mut blob).unwrap();
        assert_eq!(size(h).unwrap(), 5);
        // Grow to 8 (zero-filled).
        truncate_handle(h, 8, &mut blob).unwrap();
        let mut buf = [0u8; 16];
        let n = read(h, 0, &mut buf, &mut blob).unwrap();
        assert_eq!(n, 8);
        assert_eq!(&buf[..5], b"hello");
        assert_eq!(&buf[5..8], &[0u8, 0u8, 0u8]);
        release_handle(h);
    }

    #[test]
    fn create_missing_without_ocreat_is_enoent() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        assert_eq!(open(b"/usr/bin/nope", 1, 0, 0, 0).unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn mkdir_rmdir_lifecycle() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        mkdir(b"/usr/lib", 0o755, 0, 0).unwrap();
        assert!(is_dir(b"/usr/lib"));
        assert_eq!(mkdir(b"/usr/lib", 0o755, 0, 0).unwrap_err(), Errno::EEXIST);
        // The parent's link count reflects each subdir's `..`.
        let usr = lstat(b"/usr").unwrap();
        assert_eq!(usr.st_nlink, 4); // 2 (self + `.`) + 2 subdirs (bin, lib)
        rmdir(b"/usr/lib").unwrap();
        assert_eq!(lstat(b"/usr/lib").unwrap_err(), Errno::ENOENT);
        assert_eq!(rmdir(b"/usr/bin").unwrap_err(), Errno::ENOTEMPTY);
        assert_eq!(rmdir(b"/").unwrap_err(), Errno::EBUSY);
    }

    #[test]
    fn unlink_base_and_created_files() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Unlink a base file: the entry disappears (bytes stay in the host).
        unlink(b"/usr/bin/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        assert_eq!(unlink(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        // Unlinking a directory is EISDIR (use rmdir).
        assert_eq!(unlink(b"/usr/bin").unwrap_err(), Errno::EISDIR);
    }

    #[test]
    fn unlink_while_open_defers_free() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let h = open(b"/usr/bin/hello", O_RDONLY, 0, 0, 0).unwrap();
        unlink(b"/usr/bin/hello").unwrap();
        // Name is gone, but the open handle still reads (unlink-while-open).
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        let mut buf = [0u8; 5];
        assert_eq!(read(h, 0, &mut buf, &mut blob).unwrap(), 5);
        assert_eq!(&buf, b"hello");
        assert!(release_handle(h)); // frees now
        assert!(!handle_is_live(h));
    }

    #[test]
    fn rename_moves_and_replaces() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Move a file to a new name in another dir.
        mkdir(b"/opt", 0o755, 0, 0).unwrap();
        rename(b"/usr/bin/hello", b"/opt/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap_err(), Errno::ENOENT);
        assert_eq!(lstat(b"/opt/hello").unwrap().st_size, 11);
        // Replace an existing regular destination atomically.
        insert_host_file(b"/opt/other", 44, 3, 0o644, 0, 0, 20).unwrap();
        rename(b"/opt/hello", b"/opt/other").unwrap();
        assert_eq!(lstat(b"/opt/other").unwrap().st_size, 11);
        // Directory-into-own-subtree is EINVAL.
        assert_eq!(rename(b"/opt", b"/opt/sub").unwrap_err(), Errno::EINVAL);
        assert_eq!(rename(b"/opt/", b"/opt/sub").unwrap_err(), Errno::EINVAL);
        assert_eq!(rename(b"/opt", b"/opt//sub").unwrap_err(), Errno::EINVAL);
        assert_eq!(rename(b"/opt/other", b"/opt/other/child"), Err(Errno::ENOTDIR));
    }

    /// `rename`'s doc comment promises four POSIX guarantees about the
    /// destination; `rename_moves_and_replaces` asserted one of them (an
    /// existing regular file is replaced) plus the own-subtree EINVAL. These
    /// are the other three, each a distinct branch in the implementation, plus
    /// the case that makes ENOTEMPTY meaningful: a directory MAY replace an
    /// empty directory.
    #[test]
    fn rename_enforces_destination_type_and_emptiness() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        mkdir(b"/opt", 0o755, 0, 0).unwrap();

        // A directory cannot replace a non-directory.
        assert_eq!(
            rename(b"/opt", b"/usr/bin/hello").unwrap_err(),
            Errno::ENOTDIR
        );
        // A non-directory cannot replace a directory.
        assert_eq!(rename(b"/usr/bin/hello", b"/opt").unwrap_err(), Errno::EISDIR);

        // A directory cannot replace a NON-EMPTY directory: `/usr/bin` still
        // holds `hello`, because both renames above failed.
        mkdir(b"/src", 0o755, 0, 0).unwrap();
        assert_eq!(rename(b"/src", b"/usr/bin").unwrap_err(), Errno::ENOTEMPTY);

        // ...but it may replace an empty one, which is what makes the check
        // above a check on emptiness rather than on being a directory.
        mkdir(b"/empty", 0o755, 0, 0).unwrap();
        rename(b"/src", b"/empty").unwrap();
        assert!(is_dir(b"/empty"));
        assert_eq!(lstat(b"/src").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn hard_link_shares_inode() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        link(b"/usr/bin/hello", b"/usr/bin/hello2").unwrap();
        let a = lstat(b"/usr/bin/hello").unwrap();
        let b = lstat(b"/usr/bin/hello2").unwrap();
        assert_eq!(a.st_ino, b.st_ino);
        assert_eq!(a.st_nlink, 2);
        // Removing one name leaves the other.
        unlink(b"/usr/bin/hello").unwrap();
        assert_eq!(lstat(b"/usr/bin/hello2").unwrap().st_nlink, 1);
        // No hard links to directories.
        assert_eq!(link(b"/usr/bin", b"/bin2").unwrap_err(), Errno::EPERM);
    }

    #[test]
    fn rename_replacing_one_hard_link_preserves_other_links() {
        let _guard = TestGuard::acquire();
        build_sample_tree();
        insert_host_file(b"/replace", 44, 3, 0o644, 0, 0, 20).unwrap();
        link(b"/replace", b"/survivor").unwrap();
        let replaced_ino = lstat(b"/survivor").unwrap().st_ino;
        rename(b"/usr/bin/hello", b"/replace").unwrap();
        assert_eq!(lstat(b"/survivor").unwrap().st_ino, replaced_ino);
        assert_eq!(lstat(b"/survivor").unwrap().st_nlink, 1);
        assert_ne!(lstat(b"/replace").unwrap().st_ino, replaced_ino);
    }

    /// A declared capacity is a growth ceiling, not download bytes.
    ///
    /// `main`'s #1419 found the canonical rootfs shipping 16 MiB for 3 MiB of
    /// content: the TypeScript writer serialized its whole backing buffer, so
    /// `--sab-size` became product bytes. This export must keep the two apart:
    /// a 16 MiB request raises the ceiling the image declares while the body
    /// stays sized to the tree it holds.
    #[test]
    fn a_declared_capacity_raises_the_ceiling_without_shipping_free_blocks() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        const DECLARED: u64 = 16 * 1024 * 1024;
        set_image_capacity(DECLARED).expect("declare capacity");

        assert!(
            export_capacity_bytes(&mut no_bytes()).expect("capacity") >= DECLARED,
            "the image declares at least the requested growth ceiling",
        );
        let body = drain_export(8192, &mut no_bytes());
        assert!(
            (body.len() as u64) < DECLARED / 4,
            "the body is sized to its tree, not the declared capacity: {} bytes",
            body.len(),
        );
        crate::kandelo_image_fs::KandeloImageFs::mount(body.as_slice()).expect("mount");
    }

    #[test]
    fn a_normalized_export_stamps_one_instant_on_every_inode_including_the_root() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        const FIXED: u64 = 946_684_800_000; // 2000-01-01T00:00:00Z

        // Without normalisation the export writes each inode's own times, and
        // two builds of the same tree differ by the minute they ran in --
        // which keys every downstream cache on the wall clock.
        set_export_timestamp(Some(FIXED)).expect("normalise");
        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");

        // THE ROOT ESPECIALLY. `mkfs` creates it before the walk begins, so the
        // walk never re-stamps it: normalising only the walk leaves an artifact
        // that is reproducible everywhere except its own root directory, which
        // is the half of this that is invisible until something compares whole
        // images.
        let root = fs.resolve(b"/", true).expect("/");
        let root_stat = fs.stat_ino(root).expect("root stat");
        assert_eq!(
            (root_stat.mtime_ms, root_stat.ctime_ms, root_stat.atime_ms),
            (FIXED, FIXED, FIXED),
            "the root carries the normalised instant",
        );

        let etc = fs.resolve(b"/etc", true).expect("/etc");
        let etc_stat = fs.stat_ino(etc).expect("etc stat");
        assert_eq!(
            (etc_stat.mtime_ms, etc_stat.ctime_ms, etc_stat.atime_ms),
            (FIXED, FIXED, FIXED),
        );
        let passwd = fs.resolve(b"/etc/passwd", true).expect("/etc/passwd");
        let passwd_stat = fs.stat_ino(passwd).expect("passwd stat");
        assert_eq!(
            (passwd_stat.mtime_ms, passwd_stat.ctime_ms, passwd_stat.atime_ms),
            (FIXED, FIXED, FIXED),
        );
    }

    #[test]
    fn an_export_that_was_not_normalized_keeps_each_inode_s_own_times() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        // The negative control. Without it this pair would pass for an export
        // that stamped one instant on everything ALWAYS, which would throw away
        // truthful timestamps in every build that never asked for
        // reproducibility.
        set_base_times_from_ms(b"/etc/passwd", 1_700_000_000_000);
        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let passwd = fs.resolve(b"/etc/passwd", true).expect("/etc/passwd");
        assert_eq!(
            fs.stat_ino(passwd).expect("stat").mtime_ms,
            1_700_000_000_000,
            "an un-normalised export carries the file's own time",
        );
    }

    #[test]
    fn only_a_file_with_a_fetch_description_enumerates_as_deferred() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Two base files that differ in ONE thing. Both are `Host`-sourced
        // regular files with a real size, which is why the source cannot be
        // what decides: a tree the host walked is full of them and none of its
        // files is deferred.
        //
        // What makes a file deferred is that something says where its bytes
        // come from. `/walked.bin` has no such description and its bytes are an
        // ordinary host file; `/fetched.bin` has one and its bytes are a
        // promise. Enumerating the first would tell a builder its tree is full
        // of lazy files it never registered.
        insert_host_file(b"/walked.bin", 77, 4096, 0o644, 0, 0, 90).unwrap();
        insert_host_file(b"/fetched.bin", 78, 8192, 0o644, 0, 0, 91).unwrap();
        set_deferred_payload(b"/fetched.bin", br#"{"url":"https://x/f.bin"}"#).unwrap();

        let entries = lazy_entries();
        let paths: alloc::vec::Vec<&[u8]> =
            entries.iter().map(|e| e.path.as_slice()).collect();
        assert_eq!(paths, alloc::vec![b"/fetched.bin".as_slice()]);
        assert_eq!(entries[0].size, 8192, "its REAL length, not a stub's");
        assert_eq!(entries[0].archive_id, 0, "fetched standalone");
    }

    #[test]
    fn chmod_keeps_the_bits_it_owns_and_takes_no_others() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // `inode.mode` holds PERMISSIONS; the file's type comes from its kind
        // and is OR-ed in by `lstat`. So a mode arriving with type bits set
        // must be narrowed, or a regular file can be made to report itself as
        // a directory as well -- `S_IFDIR | S_IFREG` at once, which is not a
        // type any caller can act on.
        //
        // Every existing chmod assertion masks the result with `& 0o7777`,
        // the SAME mask the code applies, so removing the code's mask changed
        // nothing any of them could see. A test that applies the transform it
        // is checking cannot check it. Mutation testing is what said so.
        chmod(b"/usr/bin/hello", S_IFDIR | 0o700).unwrap();

        // Asserted through the EXPORT, not through `lstat`, and the difference
        // is the whole test. `Inode::stat` composes `type_bits | (mode &
        // 0o7777)`, so it masks a second time and every `lstat` assertion in
        // this file is blind to whether `chmod` masked at all -- a mutation
        // that deleted the narrowing left the suite green, and a test I wrote
        // against `lstat` to catch it stayed green too.
        //
        // The export walk reads `inode.mode` RAW and hands it to the writer,
        // so that is where an unmasked mode becomes a file whose recorded type
        // says directory and regular at once.
        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let hello = fs.resolve(b"/usr/bin/hello", true).expect("/usr/bin/hello");
        assert_eq!(
            fs.stat_ino(hello).unwrap().mode,
            S_IFREG | 0o700,
            "the exported file keeps its own type and takes only permissions",
        );

        // And the bits chmod DOES own reach the image. Narrowing to `0o777`
        // instead of `0o7777` would drop set-user-ID silently, which is the
        // mutation this half exists to kill -- the existing setuid test
        // chmods to `0o4755` and then CHOWNS, which clears the bit on purpose,
        // so it can never notice a chmod that dropped it first.
        chmod(b"/usr/bin/hello", 0o4711).unwrap();
        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let hello = fs.resolve(b"/usr/bin/hello", true).expect("/usr/bin/hello");
        assert_eq!(fs.stat_ino(hello).unwrap().mode, S_IFREG | 0o4711);
    }

    /// `chown` here does NOT follow a final symlink, and the syscall layer
    /// depends on that.
    ///
    /// The TypeScript filesystem this replaced answered symlink ownership with
    /// two operations --
    /// `chown` followed the link, `lchown` did not. This filesystem has one,
    /// and the reason it needs only one is the layering: `sys_chown` resolves
    /// with `PathResolveOptions::FOLLOW` and hands down an ALREADY-RESOLVED
    /// path, so following again here would be a second traversal of a link the
    /// caller already walked. POSIX is satisfied above, not here.
    ///
    /// Nothing asserted it, and it is not a detail: a VFS image builder creates
    /// symlinks in bulk -- the shipped shell image carries thousands -- and it
    /// calls this function directly, without a syscall layer in front. Whether
    /// ownership lands on the link or its target is a difference that ships.
    #[test]
    fn chown_does_not_follow_a_final_symlink() {
        let _g = TestGuard::acquire();
        build_sample_tree();

        chown(b"/usr/bin/hello", 11, 12, false).unwrap();
        symlink(b"hello", b"/usr/bin/hello-link", 0, 0).unwrap();

        chown(b"/usr/bin/hello-link", 21, 22, false).unwrap();

        let link = lstat(b"/usr/bin/hello-link").unwrap();
        let target = lstat(b"/usr/bin/hello").unwrap();
        // The link moved; the target kept the ownership it was given.
        assert_eq!(
            (link.st_uid, link.st_gid, target.st_uid, target.st_gid),
            (21, 22, 11, 12),
            "chown followed the symlink instead of owning it: link={:?} target={:?}",
            (link.st_uid, link.st_gid),
            (target.st_uid, target.st_gid),
        );
    }

    /// `fchown` through an open handle, which had NO test caller at all.
    ///
    /// The function was written, exported and never exercised — `grep` for
    /// `fchown(` in this file found the definition and nothing else. It is the
    /// path `sys_fchown` takes for a rootfs file, so an image whose ownership
    /// is set through a descriptor rather than a path was resting on an
    /// unasserted function.
    ///
    /// Asserted against `chown`'s behaviour rather than independently: the two
    /// differ only in how they name the inode, and a difference in what they DO
    /// to it would be a bug in whichever one a caller did not use.
    #[test]
    fn fchown_matches_chown_through_an_open_handle() {
        let _g = TestGuard::acquire();
        build_sample_tree();

        // O_RDWR == 2.
        let handle = open(b"/usr/bin/hello", 2, 0, 0, 0).expect("open");
        fchown(handle, 31, 32, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (31, 32), "the handle names the same inode as the path");

        // -1 leaves a field alone, exactly as the path form does.
        fchown(handle, u32::MAX, 41, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (31, 41), "u32::MAX is the unchanged sentinel");

        // And it clears set-user-ID on request, so a descriptor is not a way
        // around the rule a path is held to.
        chmod(b"/usr/bin/hello", 0o4755).unwrap();
        fchown(handle, 1, 1, true).unwrap();
        assert_eq!(
            lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777,
            0o0755,
            "set-user-ID survives an fchown that asked to clear it",
        );
        release_handle(handle);
    }

    /// `statfs` reports `ST_NOSUID` when the `/` mount is nosuid, and nothing
    /// asserted it.
    ///
    /// `is_nosuid()` has exactly one reader in the whole tree — the `f_flags`
    /// field built here — so an unasserted flag means the setter, the getter
    /// and the field they exist for were all covered by nothing. A mount that
    /// reports itself as permitting set-user-ID when it does not is the kind
    /// of answer a program uses to decide whether to trust a binary.
    ///
    /// This is the property the four browser tests blocked behind `mount(2)`
    /// cover for a HOST-side filesystem. Asserting it here means the kernel's
    /// own answer does not depend on those tests surviving.
    #[test]
    fn statfs_reports_nosuid_exactly_when_the_mount_is_nosuid() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let previous = is_nosuid();

        set_nosuid(false);
        let permissive = statfs(b"/").expect("statfs");
        assert_eq!(
            permissive.f_flags & wasm_posix_shared::statfs_flags::ST_NOSUID,
            0,
            "a permissive mount must not claim ST_NOSUID",
        );

        set_nosuid(true);
        let restricted = statfs(b"/").expect("statfs");
        assert_eq!(
            restricted.f_flags & wasm_posix_shared::statfs_flags::ST_NOSUID,
            wasm_posix_shared::statfs_flags::ST_NOSUID,
            "a nosuid mount must say so: a program asks this before trusting a setuid binary",
        );

        // The setter reports what it replaced, which is how a caller restores
        // the previous state rather than guessing at it.
        assert!(set_nosuid(previous), "set_nosuid returns the prior value");
    }

    #[test]
    fn persistent_statfs_reports_logical_capacity_and_live_allocation() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        const CAPACITY: u64 = 256 * 1024 * 1024;
        set_image_capacity(CAPACITY).unwrap();
        let image = drain_container(8192, &mut no_bytes());
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);

        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let before = statfs(b"/").unwrap();
        let mount = statfs_for_exec(b"/").unwrap();
        assert_eq!((mount.f_type, mount.f_fsid, mount.f_flags),
            (before.f_type, before.f_fsid, before.f_flags));
        assert_eq!(mount.f_blocks, 0);
        assert_eq!(before.f_type, crate::kandelo_image_fs::KANDELO_IMAGE_SUPER_MAGIC);
        assert!(before.f_blocks * u64::from(before.f_frsize) >= CAPACITY);
        assert!(before.f_blocks < 262_144);
        assert!(before.f_bfree < before.f_blocks);
        assert_eq!(before.f_bavail, before.f_bfree);

        let handle = open(b"/statfs-created", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(handle, 0, &[7; 4096], &mut source), Ok(4096));
        let after = statfs(b"/").unwrap();
        assert_eq!(after.f_blocks, before.f_blocks);
        assert_eq!(after.f_files, before.f_files);
        assert!(after.f_bfree < before.f_bfree);
        assert!(after.f_ffree < before.f_ffree);
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        let recovered = statfs(b"/").unwrap();
        assert_eq!((recovered.f_blocks, recovered.f_bfree, recovered.f_files, recovered.f_ffree),
            (after.f_blocks, after.f_bfree, after.f_files, after.f_ffree));
    }

    fn empty_capacity_image(capacity: u64, inode_capacity: u32) -> Vec<u8> {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(capacity),
            growable_to_bytes: capacity,
            now_ms: 0,
        }, Some(inode_capacity)).unwrap();
        writer.declare_deferred_section().unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        }).unwrap()
    }

    #[test]
    fn persistent_image_hardlinks_share_inodes_across_recovery_and_checkpoint() {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024,
            now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        let original = writer.create_file(writer.root(), b"original", 0o644, Content::Bytes(b"before")).unwrap();
        writer.link(writer.root(), b"original-alias", original).unwrap();
        let symlink = writer.symlink(writer.root(), b"link", b"original").unwrap();
        writer.link(writer.root(), b"link-alias", symlink).unwrap();
        let fifo = writer.mknod_special(writer.root(), b"fifo", 0o600, S_IFIFO).unwrap();
        writer.link(writer.root(), b"fifo-alias", fifo).unwrap();
        let lazy = writer.create_deferred_file(writer.root(), b"lazy", 0o644, 7, 0,
            b"", b"https://example.invalid/lazy", &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.link(writer.root(), b"lazy-alias", lazy).unwrap();
        writer.declare_lazy_archive(1, 64, b"https://example.invalid/archive", &crate::sdef::DIGEST_NONE, b"").unwrap();
        let member = writer.create_deferred_file(writer.root(), b"member", 0o644, 7, 1,
            b"member", b"", &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.link(writer.root(), b"member-alias", member).unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let mut source = image_host(&image);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let assert_links = || {
            for name in ["original", "link", "fifo", "lazy", "member"] {
                let first = lstat(alloc::format!("/{name}").as_bytes()).unwrap();
                let alias = lstat(alloc::format!("/{name}-alias").as_bytes()).unwrap();
                assert_eq!(first.st_ino, alias.st_ino, "{name}");
                assert_eq!((first.st_nlink, alias.st_nlink), (2, 2), "{name}");
            }
        };
        load_image(image.len() as u64, &mut source).unwrap();
        assert_links();
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_ffree, 24);
        let handle = open(b"/original", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"after!", &mut source), Ok(6));
        release_handle(handle);
        sync_persistence().unwrap();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_links();
        let mut bytes = [0; 6];
        assert_eq!(read_file_at(b"/original-alias", 0, &mut bytes, &mut source), Ok(6));
        assert_eq!(&bytes, b"after!");
        let snapshot = drain_container(4096, &mut source);
        reset();
        let mut snapshot_source = image_host(&snapshot);
        load_image(snapshot.len() as u64, &mut snapshot_source).unwrap();
        assert_links();
        let snapshot_digest: [u8; 32] = Sha256::digest(&snapshot).into();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), snapshot_digest, &mut snapshot_source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_ffree, 24);
        assert_eq!(read_file_at(b"/original-alias", 0, &mut bytes, &mut snapshot_source), Ok(6));
        assert_eq!(&bytes, b"after!");
    }

    fn assert_persistent_cached_usage() {
        let cached = ROOTFS.with(|state| state.persistent_allocated_blocks.take()).expect("cached usage");
        persistent_statfs().unwrap();
        assert_eq!(ROOTFS.with(|state| state.persistent_allocated_blocks), Some(cached));
    }

    #[test]
    fn persistent_namespace_capacity_rejects_allocations_without_publishing() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(64 * 1024, 32);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = Arc::new(Mutex::new(Vec::new()));
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage.clone())), digest, &mut source).unwrap();
        let full = open(b"/full", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        assert_eq!(write(full, 0, &[7; 10 * 4096], &mut source), Ok(7 * 4096));
        sync_persistence().unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        let durable = storage.lock().clone();
        let before = lstat(b"/").unwrap();
        assert_eq!(mkdir(b"/blocked-dir", 0o700, 0, 0), Err(Errno::ENOSPC));
        assert_eq!(symlink(&[b'x'; 41], b"/blocked-link", 0, 0), Err(Errno::ENOSPC));
        assert_eq!(lstat(b"/blocked-dir").err(), Some(Errno::ENOENT));
        assert_eq!(lstat(b"/blocked-link").err(), Some(Errno::ENOENT));
        let after = lstat(b"/").unwrap();
        assert_eq!((after.st_mtime_sec, after.st_mtime_nsec, after.st_nlink),
            (before.st_mtime_sec, before.st_mtime_nsec, before.st_nlink));
        assert_eq!(*storage.lock(), durable);
        let empty = open(b"/empty", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        release_handle(empty);
        assert_persistent_cached_usage();
        symlink(b"full", b"/inline", 0, 0).unwrap();
        assert_persistent_cached_usage();
        mknod_special(b"/fifo", 0o600, 0, 0, S_IFIFO).unwrap();
        assert_persistent_cached_usage();
        let mut denied = None;
        for number in 0..64 {
            let name = alloc::format!("/alias-{number:03}-{}", "x".repeat(240));
            let links = lstat(b"/full").unwrap().st_nlink;
            let durable_length = storage.lock().len();
            match link(b"/full", name.as_bytes()) {
                Ok(()) => {
                    assert_persistent_cached_usage();
                    assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
                }
                Err(Errno::ENOSPC) => {
                    assert_eq!(lstat(name.as_bytes()).err(), Some(Errno::ENOENT));
                    assert_eq!(lstat(b"/full").unwrap().st_nlink, links);
                    assert_eq!(storage.lock().len(), durable_length);
                    denied = Some(name);
                    break;
                }
                Err(error) => panic!("unexpected link failure: {error:?}"),
            }
        }
        assert!(denied.is_some());
        truncate_handle(full, 0, &mut source).unwrap();
        link(b"/full", denied.as_ref().unwrap().as_bytes()).unwrap();
        mkdir(b"/after-reclaim", 0o700, 0, 0).unwrap();
        assert_persistent_cached_usage();
        release_handle(full);
        sync_persistence().unwrap();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage)), digest, &mut source).unwrap();
        assert_eq!(lstat(b"/blocked-dir").err(), Some(Errno::ENOENT));
        assert_eq!(lstat(b"/blocked-link").err(), Some(Errno::ENOENT));
        assert!(lstat(b"/after-reclaim").is_ok());
        assert_eq!(lstat(denied.unwrap().as_bytes()).unwrap().st_ino, lstat(b"/full").unwrap().st_ino);
    }

    #[test]
    fn persistent_namespace_capacity_balances_cross_directory_rename_at_full_capacity() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(64 * 1024, 32);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = Arc::new(Mutex::new(Vec::new()));
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage.clone())), digest, &mut source).unwrap();
        mkdir(b"/from", 0o700, 0, 0).unwrap();
        mkdir(b"/to", 0o700, 0, 0).unwrap();
        let handle = open(b"/source", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        let mut spill = Vec::new();
        for directory in [b"/from".as_slice(), b"/to".as_slice()] {
            for number in 0..32 {
                let name = alloc::format!("entry-{number:03}-{}", "x".repeat(240)).into_bytes();
                let mut path = directory.to_vec();
                path.push(b'/');
                path.extend_from_slice(&name);
                let grows = ROOTFS.with(|state| {
                    let root = state.mount_root().unwrap();
                    let index = state.walk(root, &split_components(directory)).unwrap();
                    let InodeKind::Dir(entries) = &state.get(index).unwrap().kind else { panic!("not a directory") };
                    let mut counter = crate::kandelo_image_write::DirectorySizeCounter::new();
                    for existing in entries.keys() { counter.push(existing.len()).unwrap(); }
                    counter.push(name.len()).unwrap();
                    counter.size() > 4096
                });
                if grows {
                    if directory == b"/from" { link(b"/source", &path).unwrap(); }
                    spill.push(path);
                    break;
                }
                link(b"/source", &path).unwrap();
            }
        }
        assert_eq!(spill.len(), 2);
        let free = statfs(b"/").unwrap().f_bfree;
        assert!(free <= 10);
        assert_eq!(write(handle, 0, &vec![7; free as usize * 4096], &mut source), Ok(free as usize * 4096));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        let inode = lstat(b"/source").unwrap();
        rename(&spill[0], &spill[1]).unwrap();
        assert_persistent_cached_usage();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(lstat(&spill[0]).err(), Some(Errno::ENOENT));
        assert_eq!(lstat(&spill[1]).unwrap().st_ino, inode.st_ino);
        assert_eq!(lstat(b"/source").unwrap().st_nlink, inode.st_nlink);
        let durable = storage.lock().clone();
        let blocked = [b"/from/".as_slice(), &vec![b'y'; 255]].concat();
        assert_eq!(link(b"/source", &blocked), Err(Errno::ENOSPC));
        assert_eq!(*storage.lock(), durable);
        assert_eq!(lstat(&blocked).err(), Some(Errno::ENOENT));
        release_handle(handle);
        sync_persistence().unwrap();
        let checkpoint = drain_container(4096, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&checkpoint).unwrap(),
        ).unwrap();
        assert_eq!(filesystem.statfs().unwrap().f_bfree, 0);
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage)), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(lstat(&spill[0]).err(), Some(Errno::ENOENT));
        assert_eq!(lstat(&spill[1]).unwrap().st_ino, inode.st_ino);
    }

    #[test]
    fn persistent_namespace_allocation_cache_tracks_deferred_final_references() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        let uri = [b'x'; 4096];
        writer.declare_lazy_archive(1, 64, &uri, &crate::sdef::DIGEST_NONE, b"").unwrap();
        let first = writer.create_deferred_file(writer.root(), b"first", 0o600, 1, 1,
            b"first", b"", &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.link(writer.root(), b"alias", first).unwrap();
        writer.create_deferred_file(writer.root(), b"second", 0o600, 1, 1,
            b"second", b"", &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.create_deferred_file(writer.root(), b"standalone", 0o600, 1, 0,
            b"", &uri, &crate::sdef::DIGEST_NONE, b"").unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut source).unwrap();
        let handle = open(b"/first", O_RDONLY, 0, 0, 0).unwrap();
        pin_mapping(handle).unwrap();
        let initial = statfs(b"/").unwrap().f_bfree;
        unlink(b"/first").unwrap();
        assert_persistent_cached_usage();
        unlink(b"/alias").unwrap();
        assert_persistent_cached_usage();
        assert_eq!(statfs(b"/").unwrap().f_bfree, initial);
        release_handle(handle);
        assert_persistent_cached_usage();
        unpin_mapping(handle);
        statfs(b"/").unwrap();
        rename(b"/second", b"/standalone").unwrap();
        assert_persistent_cached_usage();
        assert!(statfs(b"/").unwrap().f_bfree > initial);
        unlink(b"/standalone").unwrap();
        assert_persistent_cached_usage();
        mkdir(b"/directory", 0o700, 0, 0).unwrap();
        assert_persistent_cached_usage();
        rmdir(b"/directory").unwrap();
        assert_persistent_cached_usage();
    }

    #[test]
    fn persistent_truncate_preserves_sparse_holes_on_full_disk() {
        use crate::kandelo_image_write::{Content, ContentSource, KandeloImageConfig, KandeloImageWriter};
        struct Filled;
        impl ContentSource for Filled {
            fn read_exact_at(&self, _id: u64, _offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                bytes.fill(b's');
                Ok(())
            }
        }
        let _guard = TestGuard::acquire();
        let high = 9 * 1024 * 1024 * 1024;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(64 * 1024),
            growable_to_bytes: 64 * 1024, now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_file(writer.root(), b"base", 0o600,
            Content::SparseDeferred { id: 1, len: high + 8192, blocks: &[0] }).unwrap();
        let body = writer.finish().unwrap().to_vec(&Filled).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = Arc::new(Mutex::new(Vec::new()));
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage.clone())), digest, &mut source).unwrap();
        let base = open(b"/base", O_RDWR, 0, 0, 0).unwrap();
        let sparse = open(b"/sparse", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        truncate_handle(sparse, (high + 8192) as i64, &mut source).unwrap();
        let filler = open(b"/filler", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        assert_eq!(write(filler, 0, &[7; 9 * 4096], &mut source), Ok(6 * 4096));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        for handle in [base, sparse] {
            truncate_handle(handle, (high + 1) as i64, &mut source).unwrap();
            assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
            ROOTFS.with(|state| assert_eq!(state.persistent_allocated_blocks, Some(16)));
            truncate_handle(handle, (high + 8192) as i64, &mut source).unwrap();
            let mut bytes = [1; 8];
            assert_eq!(read(handle, (high - 1) as i64, &mut bytes, &mut source), Ok(8));
            assert_eq!(bytes, [0; 8]);
        }
        truncate_handle(base, 1, &mut source).unwrap();
        truncate_handle(base, (high + 8192) as i64, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        for handle in [base, sparse, filler] { release_handle(handle); }
        sync_persistence().unwrap();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(storage)), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        let mut bytes = [1; 8];
        assert_eq!(read_file_at(b"/base", 0, &mut bytes, &mut source), Ok(8));
        assert_eq!(bytes, [b's', 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(read_file_at(b"/sparse", high as i64, &mut bytes, &mut source), Ok(8));
        assert_eq!(bytes, [0; 8]);
        let checkpoint = drain_container(4096, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&checkpoint).unwrap(),
        ).unwrap();
        assert_eq!(filesystem.statfs().unwrap().f_bfree, 0);
    }

    #[test]
    fn persistent_write_capacity_limits_prefixes_without_charging_overwrites() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(64 * 1024, 32);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let handle = open(b"/capacity", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 7);
        assert_eq!(write(handle, 0, &[7; 11 * 4096], &mut source), Ok(7 * 4096));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(lstat(b"/capacity").unwrap().st_size, 7 * 4096);
        assert_eq!(write(handle, 7 * 4096, b"x", &mut source), Err(Errno::ENOSPC));
        assert_eq!(write(handle, 4095, b"yz", &mut source), Ok(2));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        truncate_handle(handle, 0, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 7);
        assert_eq!(write(handle, 9 * 1024 * 1024 * 1024, b"tail", &mut source), Ok(4));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 3);
        sync_persistence().unwrap();
        release_handle(handle);
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 3);
        let handle = open(b"/capacity", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, &[8; 7 * 4096], &mut source), Ok(3 * 4096));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(write(handle, 3 * 4096, b"x", &mut source), Err(Errno::ENOSPC));
        release_handle(handle);
    }

    #[test]
    fn shared_io_pressure_reclaims_other_read_owners_but_retains_active_verification() {
        let _guard = TestGuard::acquire();
        let tiny_digest: [u8; 32] = Sha256::digest([7]).into();
        let archive_digest: [u8; 32] = Sha256::digest([7; 4096]).into();
        ROOTFS.with(|state| {
            for archive in [false, true] {
                let cache = if archive { &mut state.archive_verified_reads } else { &mut state.verified_reads };
                let length = if archive { 4096 } else { 1 };
                let digest = if archive { archive_digest } else { tiny_digest };
                for key in [11, 12] {
                    let mut hashes = cache.prepare(key, length as u64).unwrap().unwrap();
                    hashes.push(digest);
                    cache.install(key, digest, length as u64, hashes).unwrap();
                    let mut bytes = cache.allocate_chunk(key, length).unwrap();
                    bytes.fill(7);
                    cache.install_chunk(key, digest, length as u64, 0, bytes).unwrap();
                }
            }
        });
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        let _limit = crate::io_buffer::test_budget(used);
        assert_eq!(io_budget_usage(), (used, used + crate::io_buffer::WRITEBACK_BYTES));
        assert_eq!(set_io_budget_bytes(crate::io_buffer::WRITEBACK_BYTES), Err(Errno::EINVAL));
        assert_eq!(set_io_budget_bytes(crate::io_buffer::WRITEBACK_BYTES + used - 1), Err(Errno::ENOMEM));
        let plan = VerifiedFileRead { key: 11, size: 1, digest: tiny_digest, source: VerifiedSource::Image(1), archive_source: false };
        let bytes = allocate_verified_chunk(&plan, 4096).unwrap();
        assert_eq!(bytes.len(), 4096);
        ROOTFS.with(|state| {
            assert_eq!(state.verified_reads.chunk_digest(11, tiny_digest, 1, 0), Some(tiny_digest));
            assert_eq!(state.verified_reads.chunk_digest(12, tiny_digest, 1, 0), None);
            assert_eq!(state.archive_verified_reads.chunk_digest(11, archive_digest, 4096, 0), None);
            assert_eq!(state.archive_verified_reads.chunk_digest(12, archive_digest, 4096, 0), None);
        });
        assert!(crate::io_buffer::IO_MEMORY.usage().0 <= used);
        let active = PERSISTENT_ROOTFS.lock();
        reclaim_io_read_caches(Some((false, 11)));
        drop(active);
    }

    #[test]
    fn persistent_verified_reads_preserve_allocation_and_deferred_identity() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let data = vec![7; 8192];
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024,
            now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_deferred_file(writer.root(), b"verified", 0o600, data.len() as u64, 0,
            b"", &blob_uri(42), &crate::sdef::digest_of(&data), b"").unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut image_host(&image)).unwrap();
        let before = statfs(b"/").unwrap();
        let handle = open(b"/verified", O_RDONLY, 0, 0, 0).unwrap();
        let (mut source, _) = make_byte_source(alloc::vec![(42, data)], Vec::new());
        assert_eq!(read(handle, 0, &mut [0; 1], &mut source), Ok(1));
        let cached = statfs(b"/").unwrap();
        assert_eq!(cached.f_bfree, before.f_bfree);
        assert_eq!(lazy_entries().len(), 1);
        assert_eq!(lazy_entries()[0].digest, crate::sdef::digest_of(&vec![7; 8192]));
        ROOTFS.with(|state| state.persistent_allocated_blocks = None);
        assert_eq!(statfs(b"/").unwrap().f_bfree, cached.f_bfree);
        release_handle(handle);
        let checkpoint = drain_container(4096, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&checkpoint).unwrap(),
        ).unwrap();
        assert_eq!(filesystem.deferred_section().unwrap().unwrap().records.len(), 1);
    }

    #[test]
    fn persistent_verified_chunk_eviction_reauthenticates_changed_transport_bytes() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let size = 7 * crate::verified_read_cache::CHUNK_BYTES;
        let expected = crate::sdef::digest_of(&vec![92; size]);
        let uri = blob_uri(123);
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_deferred_file(writer.root(), b"verified", 0o600, size as u64, 0,
            b"", &uri, &expected, b"").unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), Sha256::digest(&image).into(), &mut image_host(&image)).unwrap();
        let before = statfs(b"/").unwrap().f_bfree;
        let changed = core::cell::Cell::new(false);
        let calls = core::cell::Cell::new(0usize);
        let discards = core::cell::Cell::new(0usize);
        let mut source = |request: ByteReq, bytes: &mut [u8]| match request {
            ByteReq::Deferred { offset, .. } => {
                calls.set(calls.get() + 1);
                assert!(bytes.len() <= crate::verified_read_cache::CHUNK_BYTES);
                let count = bytes.len().min(size.saturating_sub(offset as usize));
                bytes[..count].fill(if changed.get() { 93 } else { 92 });
                Ok(count)
            }
            ByteReq::DiscardDeferred { .. } => { discards.set(discards.get() + 1); Ok(0) }
            _ => Err(Errno::EIO),
        };
        let handle = open(b"/verified", O_RDONLY, 0, 0, 0).unwrap();
        prefetch_range(handle, 0, 1, &mut source).unwrap();
        for chunk in 0..7 {
            let mut byte = [0];
            assert_eq!(read(handle, (chunk * crate::verified_read_cache::CHUNK_BYTES) as i64, &mut byte, &mut source), Ok(1));
            assert_eq!(byte, [92]);
        }
        assert_eq!(calls.get(), 14);
        changed.set(true);
        let mut byte = [0xaa];
        assert_eq!(read(handle, 0, &mut byte, &mut source), Err(Errno::EIO));
        assert_eq!(byte, [0xaa]);
        assert_eq!(calls.get(), 15);
        assert_eq!(discards.get(), 1);
        changed.set(false);
        assert_eq!(read(handle, 0, &mut byte, &mut source), Ok(1));
        assert_eq!(byte, [92]);
        assert_eq!(calls.get(), 23);
        let key = lstat(b"/verified").unwrap().st_ino;
        ROOTFS.with(|state| state.verified_reads.invalidate(key));
        changed.set(true);
        byte[0] = 0xaa;
        assert_eq!(read(handle, 0, &mut byte, &mut source), Err(Errno::EIO));
        assert_eq!(byte, [0xaa]);
        assert_eq!(discards.get(), 2);
        assert_eq!(statfs(b"/").unwrap().f_bfree, before);
        release_handle(handle);
    }

    #[test]
    fn persistent_verified_archive_reads_preserve_member_and_archive_descriptions() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let directory = crate::zip::read_central_directory(TINY_ZIP).unwrap();
        let entry = directory.iter().find(|entry| entry.name == b"bin/big.txt").unwrap();
        let member = crate::zip::extract(TINY_ZIP, entry).unwrap();
        let expected = crate::sdef::digest_of(&member);
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.declare_lazy_archive(7, TINY_ZIP.len() as u64, &archive_uri(7), &crate::sdef::digest_of(TINY_ZIP), b"").unwrap();
        writer.create_deferred_file(writer.root(), b"member", 0o600, member.len() as u64, 7,
            b"bin/big.txt", b"", &expected, b"").unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        let (mut source, _) = make_byte_source(Vec::new(), vec![(7, TINY_ZIP.to_vec())]);
        ensure_archive_member(7, b"bin/big.txt", &mut source).unwrap();
        ROOTFS.with(|state| assert!(state.archives.get(&7).unwrap().raw.is_some()));
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), Sha256::digest(&image).into(), &mut image_host(&image)).unwrap();
        let before = statfs(b"/").unwrap().f_bfree;
        let handle = open(b"/member", O_RDONLY, 0, 0, 0).unwrap();
        let mut bytes = [0; 32];
        assert_eq!(read(handle, 0, &mut bytes, &mut source), Ok(32));
        assert_eq!(&bytes, &member[..32]);
        assert_eq!(statfs(b"/").unwrap().f_bfree, before);
        assert_eq!(lazy_entries()[0].archive_id, 7);
        assert_eq!(lazy_entries()[0].source_path, b"bin/big.txt");
        ROOTFS.with(|state| {
            let archive = state.archives.get(&7).unwrap();
            assert!(archive.raw.is_none() && archive.directory.is_none() && archive.members.is_empty());
            assert_eq!(state.archive_readers.len(), 1);
        });
        release_handle(handle);
        let checkpoint = drain_container(4096, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&checkpoint).unwrap(),
        ).unwrap();
        let deferred = filesystem.deferred_section().unwrap().unwrap();
        assert_eq!(deferred.records.len(), 1);
        assert_eq!(deferred.archives.len(), 1);
        assert_eq!(deferred.records[0].digest, expected);
    }

    #[test]
    fn persistent_streamed_large_archives_preserve_disk_space_and_bound_reader_retention() {
        use crate::kandelo_image_fs::BlockSource;
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let size = 96 * 1024 * 1024;
        let source = crate::zip_stream::fixtures::Archive::new(b"large", size, None);
        let mut scratch = vec![0; 1024 * 1024];
        let mut archive_hash = Sha256::new();
        let mut offset = 0;
        while offset < source.len() {
            let count = scratch.len().min((source.len() - offset) as usize);
            source.read_exact_at(offset, &mut scratch[..count]).unwrap();
            archive_hash.update(&scratch[..count]);
            offset += count as u64;
        }
        let digest: [u8; 32] = archive_hash.finalize().into();
        scratch.fill(86);
        let mut member_hash = Sha256::new();
        for _ in 0..96 { member_hash.update(&scratch); }
        let member_digest: [u8; 32] = member_hash.finalize().into();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        for (archive, name, archive_digest, file_digest) in [
            (7, b"verified".as_slice(), digest, member_digest),
            (8, b"unverified".as_slice(), digest, crate::sdef::DIGEST_NONE),
            (9, b"legacy".as_slice(), crate::sdef::DIGEST_NONE, crate::sdef::DIGEST_NONE),
        ] {
            writer.declare_lazy_archive(archive, source.len(), &archive_uri(archive), &archive_digest, b"").unwrap();
            writer.create_deferred_file(writer.root(), name, 0o600, size as u64, archive,
                b"large", b"", &file_digest, b"").unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), Sha256::digest(&image).into(), &mut image_host(&image)).unwrap();
        let before = statfs(b"/").unwrap();
        let mut transport = |request: ByteReq, bytes: &mut [u8]| match request {
            ByteReq::Deferred { offset, .. } => {
                assert!(bytes.len() <= crate::verified_read_cache::CHUNK_BYTES);
                source.read_exact_at(offset, bytes)?;
                Ok(bytes.len())
            }
            _ => Err(Errno::EIO),
        };
        for path in [b"/verified".as_slice(), b"/unverified", b"/legacy"] {
            let handle = open(path, O_RDONLY, 0, 0, 0).unwrap();
            prefetch_range(handle, size as i64 - 100, 100, &mut transport).unwrap();
            let mut bytes = [0; 100];
            assert_eq!(read(handle, size as i64 - 100, &mut bytes, &mut transport), Ok(100));
            assert_eq!(bytes, [86; 100]);
            release_handle(handle);
        }
        assert_eq!(statfs(b"/").unwrap().f_bfree, before.f_bfree);
        ROOTFS.with(|state| {
            assert_eq!(state.archive_readers.len(), 2);
            for archive in state.archives.values() {
                assert!(archive.raw.is_none() && archive.directory.is_none() && archive.members.is_empty());
            }
        });
    }

    #[test]
    fn persistent_archive_directory_cache_evicts_old_metadata() {
        use crate::kandelo_image_fs::BlockSource;
        let _guard = TestGuard::acquire();
        let source = crate::zip_stream::fixtures::Archive::new(b"file", 100, None);
        for archive in 1..=70 {
            assert_eq!(streamed_archive_entry(archive, source.len(), b"file", &source).unwrap().uncompressed_size, 100);
        }
        ROOTFS.with(|state| {
            assert_eq!(state.archive_directories.len(), 64);
            assert_eq!(state.archive_directories[0].0, 7);
            assert!(state.archive_directories.iter().map(|(_, directory)| directory.retained_bytes()).sum::<usize>()
                <= crate::zip_stream::DIRECTORY_CACHE_BYTES);
        });
    }

    #[test]
    fn persistent_archive_rejection_invalidates_decoder_and_raw_proofs() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let directory = crate::zip::read_central_directory(TINY_ZIP).unwrap();
        let entry = directory.iter().find(|entry| entry.name == b"bin/big.txt").unwrap();
        let member = crate::zip::extract(TINY_ZIP, entry).unwrap();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.declare_lazy_archive(7, TINY_ZIP.len() as u64, &archive_uri(7), &crate::sdef::digest_of(TINY_ZIP), b"").unwrap();
        for (name, expected) in [(b"good".as_slice(), crate::sdef::digest_of(&member)), (b"bad".as_slice(), [8; 32])] {
            writer.create_deferred_file(writer.root(), name, 0o600, member.len() as u64, 7,
                b"bin/big.txt", b"", &expected, b"").unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), Sha256::digest(&image).into(), &mut image_host(&image)).unwrap();
        let ready = core::cell::Cell::new(true);
        let discards = core::cell::Cell::new(0);
        let mut transport = |request: ByteReq, bytes: &mut [u8]| match request {
            ByteReq::Deferred { offset, .. } if ready.get() => {
                let offset = offset as usize;
                let count = bytes.len().min(TINY_ZIP.len().saturating_sub(offset));
                bytes[..count].copy_from_slice(&TINY_ZIP[offset..offset + count]);
                Ok(count)
            }
            ByteReq::Deferred { .. } => Err(Errno::EAGAIN),
            ByteReq::DiscardDeferred { .. } => { ready.set(false); discards.set(discards.get() + 1); Ok(0) }
            _ => Err(Errno::EIO),
        };
        let good = open(b"/good", O_RDONLY, 0, 0, 0).unwrap();
        let bad = open(b"/bad", O_RDONLY, 0, 0, 0).unwrap();
        prefetch_range(good, 0, 1, &mut transport).unwrap();
        assert_eq!(read(bad, 0, &mut [0xaa; 1], &mut transport), Err(Errno::EIO));
        assert_eq!(discards.get(), 1);
        ROOTFS.with(|state| {
            assert!(state.archive_readers.is_empty());
            assert!(state.archive_directories.is_empty());
            assert!(state.archive_verified_reads.chunk_digest(7, crate::sdef::digest_of(TINY_ZIP), TINY_ZIP.len() as u64, 0).is_none());
        });
        assert_eq!(prefetch_range(good, 0, 1, &mut transport), Err(Errno::EAGAIN));
        release_handle(good);
        release_handle(bad);
    }

    #[test]
    fn persistent_verified_uri_rejection_invalidates_other_file_prefetch_proofs() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let size = 8192;
        let uri = blob_uri(321);
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(8 * 1024 * 1024),
            growable_to_bytes: 8 * 1024 * 1024, now_ms: 0,
        }, Some(35)).unwrap();
        writer.declare_deferred_section().unwrap();
        for (name, byte) in [(b"good".as_slice(), 7), (b"bad".as_slice(), 8)] {
            writer.create_deferred_file(writer.root(), name, 0o600, size as u64, 0,
                b"", &uri, &crate::sdef::digest_of(&vec![byte; size]), b"").unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        load_image(image.len() as u64, &mut image_host(&image)).unwrap();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), Sha256::digest(&image).into(), &mut image_host(&image)).unwrap();
        let ready = core::cell::Cell::new(true);
        let mut source = |request: ByteReq, bytes: &mut [u8]| match request {
            ByteReq::Deferred { offset, .. } if ready.get() => {
                let count = bytes.len().min(size.saturating_sub(offset as usize));
                bytes[..count].fill(7);
                Ok(count)
            }
            ByteReq::Deferred { .. } => Err(Errno::EAGAIN),
            ByteReq::DiscardDeferred { .. } => { ready.set(false); Ok(0) }
            _ => Err(Errno::EIO),
        };
        let good = open(b"/good", O_RDONLY, 0, 0, 0).unwrap();
        let bad = open(b"/bad", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(read(good, 0, &mut [0; 1], &mut source), Ok(1));
        assert_eq!(read(bad, 0, &mut [0; 1], &mut source), Err(Errno::EIO));
        assert_eq!(prefetch_range(good, 0, 1, &mut source), Err(Errno::EAGAIN));
        ready.set(true);
        prefetch_range(good, 0, 1, &mut source).unwrap();
        assert_eq!(read(good, 0, &mut [0; 1], &mut source), Ok(1));
        release_handle(good);
        release_handle(bad);
    }

    #[test]
    fn persistent_write_capacity_spans_cache_chunks_and_preserves_partial_tail() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(512 * 1024, 32);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut source).unwrap();
        let handle = open(b"/chunks", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        let free = statfs(b"/").unwrap().f_bfree;
        assert_eq!(free, 119);
        let expected = (free as usize - 1) * 4096;
        let generation = content_generation(handle).unwrap();
        assert_eq!(write(handle, 0, &[7; 128 * 4096], &mut source), Ok(expected));
        assert_eq!(content_generation(handle), Ok(generation + 1));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        ROOTFS.with(|state| state.persistent_allocated_blocks = None);
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(write(handle, expected as i64 - 1, b"xy", &mut source), Ok(1));
        assert_eq!(size(handle), Ok(expected as i64));
        let mut tail = [0];
        assert_eq!(read(handle, expected as i64 - 1, &mut tail, &mut source), Ok(1));
        assert_eq!(tail, [b'x']);
        truncate_handle(handle, 0, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, free);
        let offset = 9 * 1024 * 1024 * 1024 + 4095;
        let sparse_expected = (free as usize - 4) * 4096 - 4095;
        assert_eq!(write(handle, offset, &[9; 128 * 4096], &mut source), Ok(sparse_expected));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        ROOTFS.with(|state| state.persistent_allocated_blocks = None);
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        release_handle(handle);
    }

    #[test]
    fn persistent_write_capacity_rejects_fixed_mode_sparse_allocation_when_full() {
        use crate::kandelo_image_write::{Content, ContentSource, KandeloImageConfig, KandeloImageWriter};
        struct Zeros;
        impl ContentSource for Zeros {
            fn read_exact_at(&self, _id: u64, _offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                bytes.fill(0);
                Ok(())
            }
        }
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024,
            max_size_bytes: Some(64 * 1024),
            growable_to_bytes: 64 * 1024,
            now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_file(writer.root(), b"sparse", 0o600, Content::SparseDeferred {
            id: 1, len: 3 * 4096, blocks: &[0],
        }).unwrap();
        writer.create_file(writer.root(), b"filler", 0o600, Content::Bytes(&[7; 9 * 4096])).unwrap();
        let body = writer.finish().unwrap().to_vec(&Zeros).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        enable_fixed_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut source).unwrap();
        let handle = open(b"/sparse", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        assert_eq!(write(handle, 4096, b"new", &mut source), Err(Errno::ENOSPC));
        assert_eq!(write(handle, 0, b"old", &mut source), Ok(3));
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        release_handle(handle);
    }

    #[test]
    fn persistent_write_capacity_charges_shared_pointer_groups_once() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(128 * 1024, 35);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        enable_resizable_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut source).unwrap();
        let handle = open(b"/groups", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        let mut free = statfs(b"/").unwrap().f_bfree;
        for (offset, charge) in [
            (10 * 4096, 2), (11 * 4096, 1),
            (1034 * 4096, 3), ((1034 + 1024) * 4096, 2),
            (9 * 1024 * 1024 * 1024, 4), (9 * 1024 * 1024 * 1024 + 4096, 1),
        ] {
            assert_eq!(write(handle, offset, b"x", &mut source), Ok(1));
            free -= charge;
            assert_eq!(statfs(b"/").unwrap().f_bfree, free);
            ROOTFS.with(|state| state.persistent_allocated_blocks = None);
            assert_eq!(statfs(b"/").unwrap().f_bfree, free);
        }
        release_handle(handle);
    }

    #[test]
    fn persistent_statfs_uses_mounted_inode_geometry_without_exporting() {
        let _guard = TestGuard::acquire();
        const CAPACITY: u64 = 8 * 1024 * 1024;
        let image = empty_capacity_image(CAPACITY, 35);
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let before = statfs(b"/").unwrap();
        assert_eq!((before.f_blocks, before.f_bfree, before.f_files, before.f_ffree),
            (2048, 2038, 35, 29));
        set_nosuid(true);
        assert_eq!(statfs(b"/").unwrap().f_flags, wasm_posix_shared::statfs_flags::ST_NOSUID);
        set_nosuid(false);
        let length = journal.0.lock().len();
        for _ in 0..20 {
            assert_eq!(statfs(b"/").unwrap().f_bfree, before.f_bfree);
        }
        assert_eq!(journal.0.lock().len(), length);
    }

    #[test]
    fn persistent_statfs_matches_checkpoint_for_wide_directories_and_deferred_metadata() {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageSource, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        const CAPACITY: u64 = 64 * 1024 * 1024;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 2 * 1024 * 1024,
            max_size_bytes: Some(CAPACITY),
            growable_to_bytes: CAPACITY,
            now_ms: 0,
        }, Some(4099)).unwrap();
        writer.declare_deferred_section().unwrap();
        for index in 0..700 {
            let mut name = alloc::format!("entry-{index:05}").into_bytes();
            name.resize(12 + index * 103 % 244, b'x');
            writer.create_file(writer.root(), &name, 0o644, Content::Bytes(b"")).unwrap();
        }
        writer.create_file(writer.root(), b"dense", 0o644, Content::Bytes(&[7; 47 * 4096])).unwrap();
        let mut uri = b"https://example.invalid/".to_vec();
        uri.resize(3000, b'x');
        writer.declare_lazy_archive(7, 12345, &uri, &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.create_deferred_file(writer.root(), b"member", 0o644, 99, 7,
            &[b'm'; 3000], b"", &crate::sdef::DIGEST_NONE, b"").unwrap();
        let standalone = writer.create_deferred_file(writer.root(), b"standalone", 0o644, 999, 0,
            b"", &uri, &crate::sdef::DIGEST_NONE, b"").unwrap();
        writer.link(writer.root(), b"standalone-hardlink", standalone).unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let compare_checkpoint = |reader: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>| {
            let actual = statfs(b"/").unwrap();
            let plan = build_export_image(reader).unwrap();
            let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(KandeloImageSource {
                image: &plan.image, content: &NoContent,
            }).unwrap();
            let expected = filesystem.statfs().unwrap();
            assert_eq!(actual.f_bfree, CAPACITY / 4096 - (expected.f_blocks - expected.f_bfree));
            assert_eq!((actual.f_files, actual.f_ffree), (expected.f_files, expected.f_ffree));
        };
        compare_checkpoint(&mut source);
        mkdir(b"/nested", 0o755, 0, 0).unwrap();
        symlink(&[b'x'; 41], b"/long-symlink", 0, 0).unwrap();
        let handle = open(b"/nested/sparse", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        for offset in [0, 10 * 4096, 1034 * 4096, 9 * 1024 * 1024 * 1024] {
            assert_eq!(write(handle, offset, b"tail", &mut source), Ok(4));
        }
        compare_checkpoint(&mut source);
        truncate_handle(handle, 20 * 4096, &mut source).unwrap();
        release_handle(handle);
        unlink(b"/member").unwrap();
        unlink(b"/standalone").unwrap();
        compare_checkpoint(&mut source);
        unlink(b"/standalone-hardlink").unwrap();
        compare_checkpoint(&mut source);
        sync_persistence().unwrap();
        let before = statfs(b"/").unwrap();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, before.f_bfree);
        compare_checkpoint(&mut source);
    }

    #[test]
    fn loaded_image_capacity_is_independent_of_builder_and_persistent_exports() {
        let _guard = TestGuard::acquire();
        const CAPACITY: u64 = 64 * 1024;
        let image = empty_capacity_image(CAPACITY, 35);
        let mut source = image_host(&image);
        assert_eq!(loaded_image_capacity_bytes(), None);
        load_image(image.len() as u64, &mut source).unwrap();
        assert_eq!(loaded_image_capacity_bytes(), Some(CAPACITY));
        assert!(export_capacity_bytes(&mut source).unwrap() > CAPACITY);
        set_image_capacity(8 * 1024 * 1024).unwrap();
        assert_eq!(loaded_image_capacity_bytes(), Some(CAPACITY));
        assert!(export_capacity_bytes(&mut source).unwrap() >= 8 * 1024 * 1024);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_eq!(export_capacity_bytes(&mut source), Ok(CAPACITY));
        assert_eq!(statfs(b"/").unwrap().f_blocks, CAPACITY / 4096);
        reset();
        assert_eq!(loaded_image_capacity_bytes(), None);
    }

    #[test]
    fn persistent_checkpoint_preserves_mounted_capacity_and_inode_geometry() {
        let _guard = TestGuard::acquire();
        const CAPACITY: u64 = 8 * 1024 * 1024;
        let image = empty_capacity_image(CAPACITY, 35);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        let handle = open(b"/sparse", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(handle, 9 * 1024 * 1024 * 1024, b"tail", &mut source), Ok(4));
        sync_persistence().unwrap();
        release_handle(handle);
        let exported = drain_container(4096, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&exported).unwrap(),
        ).unwrap();
        assert_eq!(filesystem.growth_ceiling_bytes(), Ok(CAPACITY));
        assert_eq!(filesystem.geometry().total_inodes, 35);
        assert_eq!(filesystem.statfs().unwrap().f_ffree, 28);
        reset();
        let mut source = image_host(&exported);
        load_image(exported.len() as u64, &mut source).unwrap();
        let digest: [u8; 32] = Sha256::digest(&exported).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_files, 35);
        let handle = open(b"/sparse", O_RDONLY, 0, 0, 0).unwrap();
        let mut bytes = [0; 4];
        assert_eq!(read(handle, 9 * 1024 * 1024 * 1024, &mut bytes, &mut source), Ok(4));
        assert_eq!(&bytes, b"tail");
        release_handle(handle);
    }

    #[test]
    fn persistent_checkpoint_rejects_overcommitted_legacy_data_without_growing_disk() {
        let _guard = TestGuard::acquire();
        let image = empty_capacity_image(64 * 1024, 32);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let handle = open(b"/full", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let index = file_handle_to_inode(handle).unwrap();
        let inode = ROOTFS.with(|state| state.get(index).unwrap().ino);
        let bytes = vec![42; 80 * 1024];
        PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal
            .write_file_at(inode, 0, 0, &bytes, |_, _| Err(Errno::EIO)).unwrap();
        ROOTFS.with(|state| {
            let inode = state.get_mut(index).unwrap();
            inode.persistent_size = Some(bytes.len() as u64);
            inode.allocated_blocks = blocks_for_file(bytes.len() as u64);
            state.persistent_allocated_blocks = None;
        });
        let committed = journal.0.lock().clone();
        assert_eq!(build_export_image(&mut source).err(), Some(Errno::ENOSPC));
        assert_eq!(*journal.0.lock(), committed);
        assert_eq!(statfs(b"/").unwrap().f_bfree, 0);
        release_handle(handle);
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        let handle = open(b"/full", O_RDONLY, 0, 0, 0).unwrap();
        let mut tail = [0];
        assert_eq!(read(handle, bytes.len() as i64 - 1, &mut tail, &mut source), Ok(1));
        assert_eq!(tail, [42]);
        release_handle(handle);
    }

    #[test]
    fn persistent_statfs_retains_unlinked_deferred_metadata_through_mapping_lifetime() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        for archive_member in [false, true] {
            reset();
            let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
                size_bytes: 64 * 1024,
                max_size_bytes: Some(8 * 1024 * 1024),
                growable_to_bytes: 8 * 1024 * 1024,
                now_ms: 0,
            }, Some(35)).unwrap();
            writer.declare_deferred_section().unwrap();
            let mut uri = b"https://example.invalid/".to_vec();
            uri.resize(if archive_member { 3000 } else { 4096 }, b'x');
            if archive_member {
                writer.declare_lazy_archive(1, 100, &uri, &crate::sdef::DIGEST_NONE, b"").unwrap();
            }
            writer.create_deferred_file(writer.root(), b"deferred", 0o600, 1,
                u32::from(archive_member), if archive_member { &[b'm'; 3000] } else { b"" },
                if archive_member { b"" } else { &uri }, &crate::sdef::DIGEST_NONE, b"").unwrap();
            let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
            let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
                lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
            }).unwrap();
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let digest: [u8; 32] = Sha256::digest(&image).into();
            let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
            let handle = open(b"/deferred", O_RDONLY, 0, 0, 0).unwrap();
            let before = statfs(b"/").unwrap();
            unlink(b"/deferred").unwrap();
            assert_eq!(statfs(b"/").unwrap().f_bfree, before.f_bfree, "archive member: {archive_member}");
            pin_mapping(handle).unwrap();
            release_handle(handle);
            let held = statfs(b"/").unwrap();
            assert_eq!((held.f_bfree, held.f_ffree), (before.f_bfree, before.f_ffree));
            unpin_mapping(handle);
            let freed = statfs(b"/").unwrap();
            assert_eq!((freed.f_bfree, freed.f_ffree), (before.f_bfree + 1, before.f_ffree + 1));
            sync_persistence().unwrap();
            reset();
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
            assert_eq!(statfs(b"/").unwrap().f_bfree, freed.f_bfree);
        }
    }

    #[test]
    fn persistent_statfs_retains_unlinked_sparse_blocks_through_mapping_lifetime() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        for (path, created) in [(b"/created-orphan".as_slice(), true), (b"/big.txt".as_slice(), false)] {
            let baseline = statfs(b"/").unwrap();
            let handle = open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
            assert_eq!(write(handle, 9 * 1024 * 1024 * 1024 + 7, b"X", &mut source), Ok(1));
            let named = statfs(b"/").unwrap();
            assert!(named.f_bfree < baseline.f_bfree);
            unlink(path).unwrap();
            let unlinked = statfs(b"/").unwrap();
            assert_eq!((unlinked.f_bfree, unlinked.f_ffree), (named.f_bfree, named.f_ffree));
            pin_mapping(handle).unwrap();
            release_handle(handle);
            assert_eq!(statfs(b"/").unwrap().f_bfree, named.f_bfree);
            unpin_mapping(handle);
            let freed = statfs(b"/").unwrap();
            assert!(freed.f_bfree > named.f_bfree);
            assert_eq!(freed.f_ffree, named.f_ffree + 1);
            if created {
                assert_eq!(freed.f_bfree, baseline.f_bfree);
            } else {
                assert!(freed.f_bfree > baseline.f_bfree);
            }
        }
        sync_persistence().unwrap();
        let before_reboot = statfs(b"/").unwrap();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        let recovered = statfs(b"/").unwrap();
        assert_eq!((recovered.f_bfree, recovered.f_ffree), (before_reboot.f_bfree, before_reboot.f_ffree));
    }

    #[test]
    fn persistent_inode_capacity_preserves_open_unlinked_slots_and_recovers() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let journal = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal.clone()), digest, &mut source).unwrap();
        let available = statfs(b"/").unwrap().f_ffree;
        assert!(available > 0 && available < 1024);
        let mut held = None;
        for number in 0..available {
            let path = alloc::format!("/inode-{number}");
            let handle = open(path.as_bytes(), O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
            if number == 0 {
                held = Some(handle);
            } else {
                release_handle(handle);
            }
        }
        assert_eq!(statfs(b"/").unwrap().f_ffree, 0);
        let length = journal.0.lock().len();
        assert_eq!(open(b"/no-file", O_CREAT | O_RDWR, 0o600, 0, 0), Err(Errno::ENOSPC));
        assert_eq!(mkdir(b"/no-dir", 0o700, 0, 0), Err(Errno::ENOSPC));
        assert_eq!(symlink(b"inode-0", b"/no-link", 0, 0), Err(Errno::ENOSPC));
        for kind in [S_IFIFO, S_IFSOCK] {
            assert_eq!(mknod_special(b"/no-special", 0o600, 0, 0, kind), Err(Errno::ENOSPC));
        }
        assert_eq!(journal.0.lock().len(), length);
        let existing = open(b"/inode-1", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
        release_handle(existing);
        link(b"/inode-1", b"/another-name").unwrap();
        unlink(b"/inode-0").unwrap();
        assert_eq!(statfs(b"/").unwrap().f_ffree, 0);
        assert_eq!(open(b"/still-full", O_CREAT | O_RDWR, 0o600, 0, 0), Err(Errno::ENOSPC));
        let held = held.unwrap();
        pin_mapping(held).unwrap();
        release_handle(held);
        assert_eq!(statfs(b"/").unwrap().f_ffree, 0);
        unpin_mapping(held);
        assert_eq!(statfs(b"/").unwrap().f_ffree, 1);
        symlink(b"inode-1", b"/reused", 0, 0).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_ffree, 0);
        sync_persistence().unwrap();

        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(journal), digest, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_ffree, 0);
        assert!(matches!(lstat(b"/inode-0"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/inode-1").unwrap().st_nlink, 2);
        assert_eq!(mkdir(b"/full-after-reboot", 0o700, 0, 0), Err(Errno::ENOSPC));
        unlink(b"/reused").unwrap();
        mkdir(b"/reused-dir", 0o700, 0, 0).unwrap();
        rmdir(b"/reused-dir").unwrap();
        mknod_special(b"/reused-fifo", 0o600, 0, 0, S_IFIFO).unwrap();
    }

    #[test]
    fn chmod_chown_and_symlink_creation() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        chmod(b"/usr/bin/hello", 0o600).unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o600);
        chown(b"/usr/bin/hello", 5, 6, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (5, 6));
        // -1 leaves a field unchanged.
        chown(b"/usr/bin/hello", u32::MAX, 9, false).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_uid, st.st_gid), (5, 9));
        // chown clears set-uid when asked.
        chmod(b"/usr/bin/hello", 0o4755).unwrap();
        chown(b"/usr/bin/hello", 1, 1, true).unwrap();
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o0755);

        symlink(b"../lib/x", b"/usr/bin/newlink", 7, 8).unwrap();
        let mut buf = [0u8; 32];
        let n = readlink(b"/usr/bin/newlink", &mut buf).unwrap();
        assert_eq!(&buf[..n], b"../lib/x");
        // A symlink's OWN metadata, which nothing asserted before: mutation
        // testing showed `symlink` could hand out any mode and the whole suite
        // stayed green. Modes were checked for directories and files and never
        // for a symlink. It matters beyond tidiness -- VFS image builders
        // create symlinks in bulk (the shipped shell image carries thousands),
        // so an unasserted mode is a silent difference in a published image.
        let st = lstat(b"/usr/bin/newlink").unwrap();
        assert_eq!(
            st.st_mode & 0o7777,
            0o777,
            "a symlink is lrwxrwxrwx; its mode is not the creator's umask business",
        );
        assert_eq!((st.st_uid, st.st_gid), (7, 8), "symlink ownership comes from the caller");
        assert_eq!(symlink(b"y", b"/usr/bin/newlink", 0, 0).unwrap_err(), Errno::EEXIST);
    }

    #[test]
    fn open_o_trunc_on_a_lazy_member_truncates_it_like_any_other_file() {
        let _g = TestGuard::acquire();
        // A lazy member `/g` of archive 7, 999 bytes, placed directly.
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        declare_archive(7, 1234).unwrap();
        insert_lazy_file(b"/g", 7, b"bin/g", 999, 0o644, 0, 0, 2, b"", b"", b"").unwrap();

        // This once asserted `ENOSYS`, on the grounds that
        // truncating would "silently convert it into an empty writable file
        // ... and hand back fabricated success". That is a description of what
        // `O_TRUNC` MEANS: the file becomes empty, and what its bytes used to
        // be backed by stops mattering the moment they stop existing. Nothing
        // is fabricated, because nothing was promised -- a truncating open
        // never needed the content.
        //
        // It cost the derived image builders. Replacing `/usr/bin/node` with
        // eager bytes is a whole-file replace, and it failed `ENOSYS` in a
        // product build. It was also a host/kernel DIVERGENCE: the TypeScript
        // filesystem that used to serve `/` allowed the same truncate, so two
        // implementations of one filesystem disagreed about a POSIX operation.
        //
        // The case that genuinely cannot be served is a PARTIAL write, which
        // needs the old bytes, does not set `O_TRUNC`, and still reaches the
        // materialization path that cannot fetch them.
        let handle = open(b"/g", O_WRONLY | O_TRUNC, 0, 0, 0).expect("truncate succeeds");
        release_handle(handle);

        // It is now an ordinary empty file, and no longer claims a backing it
        // does not have.
        let st = lstat(b"/g").unwrap();
        assert_eq!(st.st_mode & S_IFMT, S_IFREG);
        assert_eq!(st.st_size, 0, "truncated to nothing");
        assert!(
            lazy_member_source(b"/g").is_err(),
            "a truncated file no longer names an archive member",
        );
    }

    #[test]
    fn special_socket_and_fifo_nodes() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/run", 0o755, 0, 0, 2).unwrap();
        mknod_special(b"/run/s.sock", 0o755, 7, 8, S_IFSOCK).unwrap();
        mknod_special(b"/run/f.fifo", 0o644, 0, 0, wasm_posix_shared::mode::S_IFIFO).unwrap();

        let s = lstat(b"/run/s.sock").unwrap();
        assert_eq!(s.st_mode & S_IFMT, S_IFSOCK);
        assert_eq!((s.st_uid, s.st_gid), (7, 8));
        assert_eq!(s.st_size, 0);
        let f = lstat(b"/run/f.fifo").unwrap();
        assert_eq!(f.st_mode & S_IFMT, wasm_posix_shared::mode::S_IFIFO);

        // A special node cannot be opened as a regular file.
        assert_eq!(open(b"/run/s.sock", O_RDONLY, 0, 0, 0).unwrap_err(), Errno::ENXIO);
        // Duplicate mknod is EEXIST.
        assert_eq!(
            mknod_special(b"/run/s.sock", 0o755, 0, 0, S_IFSOCK).unwrap_err(),
            Errno::EEXIST
        );

        // getdents lists both nodes.
        let mut buf = [0u8; 512];
        let (n, _c, _d) = getdents64(b"/run", &mut buf, 0, &[]).unwrap();
        assert!(buf[..n].windows(6).any(|w| w == b"s.sock"));
        assert!(buf[..n].windows(6).any(|w| w == b"f.fifo"));

        unlink(b"/run/s.sock").unwrap();
        assert_eq!(lstat(b"/run/s.sock").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn utimensat_sets_times() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        utimensat(b"/usr/bin/hello", 100, 1, 200, 2, 300, 3).unwrap();
        let st = lstat(b"/usr/bin/hello").unwrap();
        assert_eq!((st.st_atime_sec, st.st_atime_nsec), (100, 1));
        assert_eq!((st.st_mtime_sec, st.st_mtime_nsec), (200, 2));
        assert_eq!((st.st_ctime_sec, st.st_ctime_nsec), (300, 3));
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
    fn opendir_readdir_pages_a_wide_directory() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/wide", 0o755, 0, 0, 2).unwrap();
        for entry in 0..1024 {
            let path = alloc::format!("/wide/file-{entry:04}");
            insert_host_file(path.as_bytes(), entry, 0, 0o644, 0, 0, entry + 3).unwrap();
        }

        let handle = opendir(b"/wide").unwrap();
        let mut short = [0u8; 3];
        assert_eq!(readdir(handle, &mut short).unwrap_err(), Errno::EINVAL);
        let mut name = [0u8; 32];
        for entry in 0..1024 {
            let (ino, d_type, length) = readdir(handle, &mut name).unwrap().unwrap();
            assert_eq!(ino, entry + 3);
            assert_eq!(d_type, DT_REG);
            assert_eq!(&name[..length], alloc::format!("file-{entry:04}").as_bytes());
        }
        assert_eq!(readdir(handle, &mut name).unwrap(), None);
        assert_eq!(readdir(handle, &mut name).unwrap(), None);
        closedir(handle).unwrap();
    }

    #[test]
    fn opendir_keeps_an_unlinked_directory_alive_until_close() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/empty", 0o755, 0, 0, 2).unwrap();
        let inode_idx = ROOTFS.with(|state| {
            state.walk(state.root.unwrap(), &[b"empty".as_slice()]).unwrap()
        });
        let handle = opendir(b"/empty").unwrap();
        rmdir(b"/empty").unwrap();
        assert_eq!(lstat(b"/empty").unwrap_err(), Errno::ENOENT);
        assert!(ROOTFS.with(|state| state.get(inode_idx).is_some()));
        assert_eq!(readdir(handle, &mut [0u8; 32]).unwrap(), None);
        closedir(handle).unwrap();
        assert!(!ROOTFS.with(|state| state.get(inode_idx).is_some()));
    }

    #[test]
    fn getdents64_injects_dot_entries() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let mut buf = [0u8; 512];
        let (written, _cookie, _done) = getdents64(b"/usr/bin", &mut buf, 0, &[]).unwrap();
        assert!(written > 0);
        // The formatter injects "." and ".."; the raw buffer should contain the
        // child names too.
        let hay = &buf[..written];
        assert!(hay.windows(5).any(|w| w == b"hello"));
        assert!(hay.windows(2).any(|w| w == b"hi"));
    }

    #[test]
    fn getdents64_injects_and_dedups_root_virtuals() {
        let _g = TestGuard::acquire();
        // A root with a real `bin` dir but no `dev`/`proc` (those are synthetic
        // kernel mounts, injected via `extra`), plus a name that collides with an
        // injected virtual to exercise dedup.
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/bin", 0o755, 0, 0, 2).unwrap();
        insert_base_dir(b"/dev", 0o755, 0, 0, 3).unwrap(); // already present
        let extra: &[(&[u8], u8, u64)] = &[(b"dev", 4, 2), (b"proc", 4, 2)];
        let mut buf = [0u8; 512];
        let (written, _c, _d) = getdents64(b"/", &mut buf, 0, extra).unwrap();
        let hay = &buf[..written];
        assert!(hay.windows(3).any(|w| w == b"bin"));
        assert!(hay.windows(4).any(|w| w == b"proc")); // injected
        // `dev` present exactly once (the base entry; the injected one is deduped).
        let dev_hits = (0..hay.len().saturating_sub(2))
            .filter(|&i| &hay[i..i + 3] == b"dev")
            .count();
        assert_eq!(dev_hits, 1, "dev should appear once, not duplicated");
    }

    #[test]
    fn getdents64_pages_a_wide_directory_without_losing_cookies() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/wide", 0o755, 0, 0, 2).unwrap();
        for entry in 0..1024 {
            let path = alloc::format!("/wide/file-{entry:04}");
            insert_host_file(path.as_bytes(), entry, 0, 0o644, 0, 0, entry + 3).unwrap();
        }

        let mut short = [0u8; 16];
        assert_eq!(
            getdents64(b"/wide", &mut short, 0, &[]).unwrap_err(),
            Errno::EINVAL
        );
        let mut buf = [0u8; 80];
        let mut cookie = 0;
        let mut names = Vec::new();
        loop {
            let (written, next_cookie, exhausted) =
                getdents64(b"/wide", &mut buf, cookie, &[]).unwrap();
            assert!(written > 0);
            assert!(next_cookie > cookie);
            let mut position = 0;
            while position < written {
                let record = &buf[position..written];
                let record_cookie = i64::from_le_bytes(record[8..16].try_into().unwrap());
                let record_len = u16::from_le_bytes(record[16..18].try_into().unwrap()) as usize;
                assert_eq!(record_cookie, names.len() as i64 + 1);
                assert!(record_len <= record.len());
                let name_len = record[19..record_len]
                    .iter()
                    .position(|&byte| byte == 0)
                    .unwrap();
                names.push(record[19..19 + name_len].to_vec());
                position += record_len;
            }
            assert_eq!(position, written);
            cookie = next_cookie;
            if exhausted {
                break;
            }
        }
        assert_eq!(cookie, 1026);
        assert_eq!(names[0], b".");
        assert_eq!(names[1], b"..");
        for entry in 0..1024 {
            assert_eq!(names[entry + 2], alloc::format!("file-{entry:04}").as_bytes());
        }
        assert_eq!(
            getdents64(b"/wide", &mut buf, cookie, &[]).unwrap(),
            (0, cookie, true)
        );
        assert_eq!(
            getdents64(b"/wide", &mut buf, i64::MAX, &[]).unwrap(),
            (0, i64::MAX, true)
        );
    }

    #[test]
    fn getdents64_matches_shared_formatter_with_injected_entries() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_file(b"/alpha", 0, 0, 0o644, 0, 0, 2).unwrap();
        insert_base_file(b"/dev", 0, 0, 0o644, 0, 0, 3).unwrap();
        insert_base_file(b"/omega", 0, 0, 0o644, 0, 0, 4).unwrap();
        let extra: &[(&[u8], u8, u64)] = &[
            (b"dev", DT_DIR as u8, 50),
            (b"proc", DT_DIR as u8, 51),
            (b"proc", DT_DIR as u8, 52),
            (b"tmp", DT_DIR as u8, 53),
        ];
        let entries = alloc::vec![
            (b"alpha".to_vec(), DT_REG as u8, 2),
            (b"dev".to_vec(), DT_REG as u8, 3),
            (b"omega".to_vec(), DT_REG as u8, 4),
            (b"proc".to_vec(), DT_DIR as u8, 51),
            (b"tmp".to_vec(), DT_DIR as u8, 53),
        ];
        for offset in 0..9 {
            for capacity in [0, 16, 24, 48, 72, 128, 256] {
                let mut actual = alloc::vec![0u8; capacity];
                let mut expected = alloc::vec![0u8; capacity];
                let actual_result = getdents64(b"/", &mut actual, offset, extra);
                let expected_result = crate::procfs::write_virtual_dirents64(
                    &mut expected,
                    offset,
                    1,
                    1,
                    &entries,
                );
                assert_eq!(
                    actual_result, expected_result,
                    "offset={offset}, capacity={capacity}"
                );
                assert_eq!(actual, expected, "offset={offset}, capacity={capacity}");
            }
        }
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

    #[test]
    fn read_file_at_reads_base_bytes_by_path() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"hello world");
        // Positioned read.
        let n = read_file_at(b"/usr/bin/hello", 6, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"world");
    }

    #[test]
    fn write_file_at_truncate_replaces_bytes_and_mode() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        let n = write_file_at(b"/usr/bin/hello", 0, b"NEW", 0o600, true, &mut blob).unwrap();
        assert_eq!(n, 3);
        let mut buf = [0u8; 32];
        // A reader that panics proves the replaced file is served from the
        // overlay, never re-fetched from the base blob.
        let mut panic_blob = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("replaced file must be served from the overlay");
        };
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut panic_blob).unwrap();
        assert_eq!(&buf[..n], b"NEW");
        assert_eq!(lstat(b"/usr/bin/hello").unwrap().st_mode & 0o7777, 0o600);
    }

    #[test]
    fn write_file_at_partial_over_base_keeps_untouched_tail() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        // Non-truncating positioned write copies the base file into the overlay
        // and overwrites only the tail, keeping the leading bytes intact.
        let n = write_file_at(b"/usr/bin/hello", 6, b"WORLD", 0o644, false, &mut blob).unwrap();
        assert_eq!(n, 5);
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/hello", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"hello WORLD");
    }

    #[test]
    fn write_file_at_creates_absent_file() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let (mut blob, _) = make_byte_source(alloc::vec![], alloc::vec::Vec::new());
        let n = write_file_at(b"/usr/bin/fresh", 0, b"data", 0o644, true, &mut blob).unwrap();
        assert_eq!(n, 4);
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/usr/bin/fresh", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"data");
        assert_eq!(lstat(b"/usr/bin/fresh").unwrap().st_mode & 0o7777, 0o644);
    }

    /// The host-facing "place this file in the rootfs" path does NOT create the
    /// directories leading to it, and `mkdir_parents` is what closes that gap.
    ///
    /// A plausible assumption is that the browser MITM CA-certificate write
    /// needs nothing beyond `kernel_rootfs_write_file`. It does: the browser
    /// entry writes
    /// `/etc/ssl/certs/ca-certificates.crt` and creates `/etc`, `/etc/ssl` and
    /// `/etc/ssl/certs` first, because a demo image need not carry them.
    /// `write_file_at` opens with `O_CREAT`, which is `ENOENT` on a missing
    /// parent exactly as POSIX requires, so the write half alone loses the
    /// directory half silently.
    #[test]
    fn checked_parent_creation_persists_directories_and_resolves_existing_aliases() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        assert_eq!(mkdir_parents_checked(b"/etc/ssl/certs/ca", 0o750, 22, 33), Ok(3));
        symlink(b"/etc/ssl/certs", b"/cert-alias", 0, 0).unwrap();
        assert_eq!(mkdir_parents_checked(b"/cert-alias/nested/file", 0o750, 22, 33), Ok(1));
        write_file_at(b"/etc/ssl/certs/nested/file", 0, b"staged", 0o600, true, &mut source).unwrap();
        sync_persistence().unwrap();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        assert_eq!(mkdir_parents_checked(b"/cert-alias/nested/file", 0o755, 0, 0), Ok(0));
        let metadata = lstat(b"/etc/ssl/certs/nested").unwrap();
        assert_eq!((metadata.st_uid, metadata.st_gid, metadata.st_mode & 0o7777), (22, 33, 0o750));
        let mut bytes = [0; 6];
        assert_eq!(read_file_at(b"/etc/ssl/certs/nested/file", 0, &mut bytes, &mut source), Ok(6));
        assert_eq!(&bytes, b"staged");
        load_image(image.len() as u64, &mut source).unwrap();
        enable_fixed_persistence(Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))), digest, &mut source).unwrap();
        assert_eq!(mkdir_parents_checked(b"/etc/ssl/certs/ca", 0o755, 0, 0), Err(Errno::EROFS));
        assert!(!is_dir(b"/etc"));
    }

    #[test]
    fn checked_parent_creation_preserves_errors_and_partial_prefixes_without_unadmitted_scratch() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let before = io_budget_usage().0;
        {
            let _budget = crate::io_buffer::test_budget(before);
            assert_eq!(mkdir_parents_checked(b"/blocked/file", 0o755, 0, 0), Err(Errno::ENOMEM));
            assert_eq!(mkdir_parents(b"/blocked/file", 0o755, 0, 0), 0);
            assert_eq!(mkdir_parents_checked(b"/file", 0o755, 0, 0), Ok(0));
        }
        assert_eq!(io_budget_usage().0, before);
        assert!(!is_dir(b"/blocked"));
        write_file_at(b"/not-a-directory", 0, b"file", 0o644, true, &mut source).unwrap();
        assert_eq!(mkdir_parents_checked(b"/not-a-directory/file", 0o755, 0, 0), Err(Errno::ENOTDIR));
        symlink(b"/loop-b", b"/loop-a", 0, 0).unwrap();
        symlink(b"/loop-a", b"/loop-b", 0, 0).unwrap();
        assert_eq!(mkdir_parents_checked(b"/loop-a/file", 0o755, 0, 0), Err(Errno::ELOOP));
        let available = statfs(b"/").unwrap().f_ffree;
        for index in 0..available - 1 {
            let path = alloc::format!("/fill-{index}");
            let handle = open(path.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
            release_handle(handle);
        }
        assert_eq!(mkdir_parents_checked(b"/one/two/file", 0o755, 0, 0), Err(Errno::ENOSPC));
        assert!(is_dir(b"/one"));
        assert!(!is_dir(b"/one/two"));
        assert_eq!(mkdir_parents(b"/another/two/file", 0o755, 0, 0), 0);
        sync_persistence().unwrap();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        assert!(is_dir(b"/one"));
        assert!(!is_dir(b"/one/two"));
    }

    #[test]
    fn write_file_at_needs_its_parents_and_mkdir_parents_supplies_them() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![], alloc::vec::Vec::new());

        // The gap, stated as a fact rather than as reasoning.
        assert_eq!(
            write_file_at(
                b"/etc/ssl/certs/ca-certificates.crt",
                0,
                b"-----BEGIN CERTIFICATE-----\n",
                0o644,
                true,
                &mut blob,
            ),
            Err(Errno::ENOENT),
        );

        // And the capability that closes it, from the same code the foreign
        // mount points use.
        assert_eq!(
            mkdir_parents(b"/etc/ssl/certs/ca-certificates.crt", 0o755, 0, 0),
            3,
        );
        let n = write_file_at(
            b"/etc/ssl/certs/ca-certificates.crt",
            0,
            b"-----BEGIN CERTIFICATE-----\n",
            0o644,
            true,
            &mut blob,
        )
        .unwrap();
        assert_eq!(n, 28);
        assert!(is_dir(b"/etc/ssl/certs"));
        assert_eq!(
            lstat(b"/etc/ssl/certs/ca-certificates.crt").unwrap().st_mode & 0o7777,
            0o644,
        );
    }

    /// Minimal RXPT record: (kind, mode, uid, gid, mtime_sec, size, path, target).
    #[allow(clippy::type_complexity)]
    fn parse_export(buf: &[u8]) -> Vec<(u8, u32, u32, u32, u64, u64, Vec<u8>, Vec<u8>)> {
        let mut pos = 0usize;
        let rd_u32 = |b: &[u8], p: &mut usize| {
            let v = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
            *p += 4;
            v
        };
        let rd_u64 = |b: &[u8], p: &mut usize| {
            let v = u64::from_le_bytes(b[*p..*p + 8].try_into().unwrap());
            *p += 8;
            v
        };
        assert_eq!(rd_u32(buf, &mut pos), EXPORT_MAGIC);
        assert_eq!(rd_u32(buf, &mut pos), EXPORT_VERSION);
        let count = rd_u32(buf, &mut pos);
        let mut out = Vec::new();
        for _ in 0..count {
            let kind = buf[pos];
            pos += 1;
            let mode = rd_u32(buf, &mut pos);
            let uid = rd_u32(buf, &mut pos);
            let gid = rd_u32(buf, &mut pos);
            let mtime_sec = rd_u64(buf, &mut pos);
            let _mtime_nsec = rd_u32(buf, &mut pos);
            let size = rd_u64(buf, &mut pos);
            let path_len = rd_u32(buf, &mut pos) as usize;
            let path = buf[pos..pos + path_len].to_vec();
            pos += path_len;
            let target_len = rd_u32(buf, &mut pos) as usize;
            let target = buf[pos..pos + target_len].to_vec();
            pos += target_len;
            out.push((kind, mode, uid, gid, mtime_sec, size, path, target));
        }
        assert_eq!(pos, buf.len(), "export buffer had trailing bytes");
        out
    }

    #[test]
    fn export_tree_serializes_overlay_tree_preorder() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        // Copy-on-write `/usr/bin/hello` so it reports as a COW file, not base.
        let (mut blob, _) =
            make_byte_source(alloc::vec![(42u64, b"hello world".to_vec())], alloc::vec::Vec::new());
        write_file_at(b"/usr/bin/hello", 0, b"NEW", 0o600, true, &mut blob).unwrap();

        let buf = export_tree();
        let records = parse_export(&buf);
        let paths: Vec<&[u8]> = records.iter().map(|r| r.6.as_slice()).collect();
        assert_eq!(
            paths,
            alloc::vec![
                &b"/"[..],
                &b"/etc-issue-blob-empty"[..],
                &b"/usr"[..],
                &b"/usr/bin"[..],
                &b"/usr/bin/hello"[..],
                &b"/usr/bin/hi"[..],
            ]
        );
        // Kinds: root+usr+bin dirs, one base file, the COW file, the symlink.
        assert_eq!(records[0].0, EXPORT_KIND_DIR); // /
        assert_eq!(records[1].0, EXPORT_KIND_BASE_REGULAR); // /etc-issue-blob-empty
        assert_eq!(records[2].0, EXPORT_KIND_DIR); // /usr
        assert_eq!(records[3].0, EXPORT_KIND_DIR); // /usr/bin
        assert_eq!(records[4].0, EXPORT_KIND_COW_REGULAR); // /usr/bin/hello (COW)
        assert_eq!(records[5].0, EXPORT_KIND_SYMLINK); // /usr/bin/hi
        // COW file carries the overlay-authoritative mode (0o600) and size (3).
        assert_eq!(records[4].1, 0o600);
        assert_eq!(records[4].5, 3);
        // Symlink carries its target bytes.
        assert_eq!(records[5].7, b"hello");
        // mtime preserved (TestGuard pins now to 1000s).
        assert_eq!(records[0].4, 1000);
    }

    #[test]
    fn lazy_metadata_enumeration_borrows_a_wide_cohort_and_preserves_wire_bytes() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/nested", 0o755, 0, 0, 2).unwrap();
        declare_archive(7, 999).unwrap();
        set_archive_source(7, b"https://x/archive.zip", &[9; 32]).unwrap();
        set_archive_payload(7, b"archive-description").unwrap();
        insert_lazy_file(b"/nested/member", 7, b"inside", 17, 0o640, 4, 5, 3, b"", &[8; 32], b"member-description").unwrap();
        for index in 0..1000 {
            let path = alloc::format!("/deferred-{index:04}-{}", "n".repeat(180));
            insert_lazy_file(path.as_bytes(), 0, b"", 23, 0o600, 4, 5,
                100 + index, b"https://x/file", &[7; 32], &[6; 64]).unwrap();
        }
        fn bytes(output: &mut Vec<u8>, value: &[u8]) {
            output.extend_from_slice(&(value.len() as u32).to_le_bytes());
            output.extend_from_slice(value);
        }
        let files = lazy_entries();
        let archives = archive_descriptions();
        let mut expected = Vec::new();
        expected.extend_from_slice(&(files.len() as u32).to_le_bytes());
        expected.extend_from_slice(&(archives.len() as u32).to_le_bytes());
        for file in files {
            bytes(&mut expected, &file.path);
            expected.extend_from_slice(&file.ino.to_le_bytes());
            expected.extend_from_slice(&file.size.to_le_bytes());
            expected.extend_from_slice(&file.archive_id.to_le_bytes());
            for value in [&file.source_path[..], &file.payload, &file.uri, &file.digest] { bytes(&mut expected, value); }
        }
        for (id, size, uri, digest, payload) in archives {
            expected.extend_from_slice(&id.to_le_bytes());
            expected.extend_from_slice(&size.to_le_bytes());
            for value in [&payload[..], &uri, &digest] { bytes(&mut expected, value); }
        }
        assert!(expected.len() > 64 * 1024);
        let before = io_budget_usage().0;
        {
            let _budget = crate::io_buffer::test_budget(before + 64 * 1024);
            assert_eq!(serialize_lazy_entries(None), Ok(expected.len()));
            assert_eq!(io_budget_usage().0, before);
            let mut output = vec![0; expected.len()];
            assert_eq!(serialize_lazy_entries(Some(&mut output)), Ok(expected.len()));
            assert_eq!(output, expected);
            assert_eq!(io_budget_usage().0, before);
            let mut small = vec![0xCC; expected.len() - 1];
            assert_eq!(serialize_lazy_entries(Some(&mut small)), Err(Errno::ERANGE));
            assert!(small.iter().all(|byte| *byte == 0xCC));
        }
        let _budget = crate::io_buffer::test_budget(before);
        let mut output = [0xCC; 31];
        assert_eq!(serialize_lazy_entries(None), Err(Errno::ENOMEM));
        assert_eq!(serialize_lazy_entries(Some(&mut output)), Err(Errno::ENOMEM));
        assert_eq!(output, [0xCC; 31]);
        assert_eq!(io_budget_usage().0, before);
    }

    #[test]
    fn archive_payload_cohort_ownership_survives_return_and_releases_its_admission() {
        let _guard = TestGuard::acquire();
        declare_archive(7, 999).unwrap();
        set_archive_payload(7, &[3; 4096]).unwrap();
        let before = io_budget_usage().0;
        let payloads = archive_payloads().unwrap();
        assert_eq!(payloads[0].0, 7);
        assert_eq!(payloads[0].1, [3; 4096]);
        assert!(io_budget_usage().0 >= before + 8192);
        drop(payloads);
        assert_eq!(io_budget_usage().0, before);
        let payload = archive_payload(7).unwrap().unwrap();
        assert_eq!(payload, [3; 4096]);
        assert!(io_budget_usage().0 >= before + 8192);
        drop(payload);
        assert_eq!(io_budget_usage().0, before);
        let _budget = crate::io_buffer::test_budget(before);
        assert_eq!(archive_payloads(), Err(Errno::ENOMEM));
        assert_eq!(archive_payload(7), Err(Errno::ENOMEM));
        assert_eq!(archive_payload(8), Ok(None));
        assert_eq!(archive_size(7), Some(999));
        assert_eq!(io_budget_usage().0, before);
    }

    #[test]
    fn metadata_export_streams_a_wide_tree_without_retaining_the_encoded_namespace() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        mkdir(b"/wide", 0o755, 0, 0).unwrap();
        for index in 0..1000 {
            let path = alloc::format!("/wide/{index:04}-{}", "n".repeat(200));
            write_file_at(path.as_bytes(), 0, b"", 0o640, true, no_bytes()).unwrap();
        }
        let expected = export_tree();
        assert!(expected.len() > 64 * 1024);
        let before = io_budget_usage().0;
        let _budget = crate::io_buffer::test_budget(before + 64 * 1024);
        let mut actual = Vec::new();
        let mut chunk = [0; 8192];
        loop {
            let count = export_tree_read(actual.len() as i64, &mut chunk).unwrap();
            assert_eq!(io_budget_usage().0, before);
            if count == 0 { break; }
            actual.extend_from_slice(&chunk[..count]);
            assert!(actual.len() <= expected.len());
        }
        assert_eq!(actual, expected);
        assert!(EXPORT_CACHE.with(|slot| slot.is_none()));
        assert!(core::mem::size_of::<metadata_export::TreeSummary>() <= 3 * core::mem::size_of::<usize>());
    }

    #[test]
    fn metadata_export_refusal_preserves_output_and_releases_stream_authority() {
        let _guard = TestGuard::acquire();
        build_sample_tree();
        let before = io_budget_usage().0;
        let mut output = [0xCC; 17];
        {
            let _budget = crate::io_buffer::test_budget(before);
            assert_eq!(export_tree_read(0, &mut output), Err(Errno::ENOMEM));
            assert_eq!(output, [0xCC; 17]);
            assert!(EXPORT_CACHE.with(|slot| slot.is_none()));
            assert_eq!(io_budget_usage().0, before);
        }
        assert_eq!(export_tree_read(0, &mut output), Ok(output.len()));
        reset_image_export();
        output.fill(0xCC);
        assert_eq!(export_tree_read(1, &mut output), Ok(0));
        assert_eq!(output, [0xCC; 17]);
        assert_eq!(export_tree_read(0, &mut output), Ok(output.len()));
        assert_eq!(export_tree_read((1i64 << 32) + 17, &mut output), Ok(0));
        assert!(EXPORT_CACHE.with(|slot| slot.is_none()));
    }

    #[test]
    fn export_tree_read_chunks_match_whole_buffer() {
        let _g = TestGuard::acquire();
        build_sample_tree();
        let whole = export_tree();
        // Read the same bytes back in tiny chunks through the cached reader.
        let mut reassembled = Vec::new();
        let mut offset = 0i64;
        loop {
            let mut chunk = [0u8; 7];
            let n = export_tree_read(offset, &mut chunk).unwrap();
            if n == 0 {
                break;
            }
            reassembled.extend_from_slice(&chunk[..n]);
            offset += n as i64;
        }
        assert_eq!(reassembled, whole);
    }

    #[test]
    fn read_file_at_follows_final_symlink() {
        // /bin/dash is a real base file; /bin/sh -> dash (relative). A
        // host-facing read of the symlink must serve dash's bytes, not ELOOP.
        // This is the popen("/bin/sh") exec-materialize path (gap G7).
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/bin", 0o755, 0, 0, 2).unwrap();
        insert_host_file(b"/bin/dash", 50, 5, 0o755, 0, 0, 3).unwrap();
        insert_base_symlink(b"/bin/sh", b"dash", 0o777, 0, 0, 4).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(50u64, b"DASH!".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/bin/sh", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"DASH!");
    }

    #[test]
    fn read_file_at_follows_symlink_chain_and_absolute_target() {
        // /a -> /b (absolute) -> c (relative to /) -> file. Every hop must be
        // followed to the terminal regular file.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/c", 60, 3, 0o644, 0, 0, 2).unwrap();
        insert_base_symlink(b"/b", b"c", 0o777, 0, 0, 3).unwrap();
        insert_base_symlink(b"/a", b"/b", 0o777, 0, 0, 4).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec![(60u64, b"XYZ".to_vec())], alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        let n = read_file_at(b"/a", 0, &mut buf, &mut blob).unwrap();
        assert_eq!(&buf[..n], b"XYZ");
    }

    #[test]
    fn a_dangling_symlink_is_itself_a_file_even_though_its_target_is_not() {
        // PORTED from a host symlink test ("lstat on dangling symlink
        // succeeds") that asserted it against the TypeScript filesystem this
        // module replaced. The kernel had every other symlink claim that test
        // made and not this one.
        //
        // The asymmetry is the whole of it: `lstat` answers about the LINK, so
        // a link to nothing is still a link and reports itself; anything that
        // follows the link reaches nothing and says ENOENT. A reader that
        // conflated them would make a broken alias invisible to `ls -l`, which
        // is exactly the state a user needs to see in order to fix it.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_symlink(b"/dangling", b"/nonexistent", 0o777, 0, 0, 2).unwrap();

        let st = lstat(b"/dangling").expect("the link itself exists");
        assert_eq!(st.st_mode & S_IFMT, S_IFLNK);

        let (mut blob, _) = make_byte_source(alloc::vec::Vec::new(), alloc::vec::Vec::new());
        let mut buf = [0u8; 8];
        assert_eq!(
            read_file_at(b"/dangling", 0, &mut buf, &mut blob).unwrap_err(),
            Errno::ENOENT,
            "following it reaches nothing",
        );
    }

    #[test]
    fn unlink_removes_the_symlink_and_not_what_it_points_at() {
        // PORTED from a host symlink test ("unlink removes a dangling symlink
        // itself"). POSIX `unlink(2)` removes the directory entry the
        // path names; when that entry is a symlink it removes the LINK and
        // never follows it. The opposite behaviour is the dangerous one --
        // deleting an alias would silently delete the file it aliases -- and
        // nothing in the kernel asserted which way it goes.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/target.txt", 70, 5, 0o644, 0, 0, 2).unwrap();
        insert_base_symlink(b"/link.txt", b"target.txt", 0o777, 0, 0, 3).unwrap();

        unlink(b"/link.txt").expect("unlink the alias");
        assert!(lstat(b"/link.txt").is_err(), "the alias is gone");
        assert_eq!(
            lstat(b"/target.txt").expect("the target survives").st_mode & S_IFMT,
            S_IFREG,
            "and it is still the file it always was",
        );

        // THE OTHER DIRECTION, which is what makes this about the link rather
        // than about unlink working at all: removing the TARGET leaves the
        // alias in place as a link, now dangling.
        insert_base_symlink(b"/link2.txt", b"target.txt", 0o777, 0, 0, 4).unwrap();
        unlink(b"/target.txt").expect("unlink the target");
        assert_eq!(
            lstat(b"/link2.txt").expect("the alias survives").st_mode & S_IFMT,
            S_IFLNK,
        );
    }

    #[test]
    fn read_file_at_self_loop_symlink_is_eloop() {
        // /loop -> loop resolves forever; the bounded resolver returns ELOOP
        // rather than spinning.
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_symlink(b"/loop", b"loop", 0o777, 0, 0, 2).unwrap();
        let (mut blob, _) = make_byte_source(alloc::vec::Vec::new(), alloc::vec::Vec::new());
        let mut buf = [0u8; 32];
        assert_eq!(
            read_file_at(b"/loop", 0, &mut buf, &mut blob).unwrap_err(),
            Errno::ELOOP
        );
    }

    // -- LazyMember materialization -------------------------------------------

    #[test]
    fn lazy_member_read_fetches_decodes_and_serves_bytes() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        let n = read(h, 0, &mut buf, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h);
    }

    #[test]
    fn lazy_member_second_read_served_from_cache() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        read(h, 0, &mut buf, &mut fetch).unwrap();
        let first_calls = calls.get();
        assert_eq!(first_calls, 1);

        let mut buf2 = [0u8; 4096];
        let n = read(h, 0, &mut buf2, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf2.iter().all(|&b| b == b'a'));
        // Served from the archive's `members` cache: no second fetch.
        assert_eq!(calls.get(), first_calls);
        release_handle(h);
    }

    /// Set archive `archive_id`'s expected digest, as a v5 SDEF section would.
    fn set_archive_digest(archive_id: u32, digest: [u8; crate::sdef::DIGEST_LEN]) {
        ROOTFS.with(|state| {
            if let Some(entry) = state.archives.get_mut(&archive_id) {
                entry.digest = digest;
            }
        });
    }

    #[test]
    fn an_archive_whose_bytes_fail_their_digest_is_refused_and_not_cached() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        // The image says the archive hashes to this. The host is about to serve
        // something else — a substituted, corrupted or truncated fetch, which
        // before v5 reached the filesystem as file contents nobody questioned.
        set_archive_digest(7, crate::sdef::digest_of(TINY_ZIP));

        let mut tampered = TINY_ZIP.to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        let (mut bad, bad_calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, tampered)]);

        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        assert_eq!(
            read(h, 0, &mut buf, &mut bad),
            Err(Errno::EIO),
            "bytes that fail their digest are an I/O error, not contents",
        );
        assert_eq!(bad_calls.get(), 1, "it did fetch, and then rejected");
        // Nothing was retained: not the raw archive, not a parsed directory,
        // not a member. A cached bad archive would make one bad fetch permanent
        // and serve every later member of it out of the same bytes.
        ROOTFS.with(|state| {
            let entry = state.archives.get(&7).expect("still declared");
            assert!(entry.raw.is_none(), "the failing archive was not cached");
            assert!(entry.directory.is_none(), "nor its parsed directory");
            assert!(entry.members.is_empty(), "nor any member of it");
        });
        // And the file is still lazy rather than a half-materialized regular
        // file, so the retry below is a real retry.
        assert!(lazy_info(b"/lazy/f").expect("still described").0);

        // The proof that only the digest rejected it: the SAME read against a
        // host serving the right bytes now succeeds. Without this the test
        // could pass because the fetch path was broken in some other way.
        let (mut good, good_calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let n = read(h, 0, &mut buf, &mut good).expect("the right bytes are accepted");
        assert_eq!(n, 4096);
        assert!(buf.iter().all(|&b| b == b'a'));
        assert_eq!(
            good_calls.get(),
            1,
            "the refused fetch left nothing behind, so this one had to happen"
        );
        release_handle(h);
    }

    #[test]
    fn a_verified_file_the_guest_has_written_is_not_re_verified() {
        let _g = TestGuard::acquire();
        // A digest describes the bytes the IMAGE declared, not the bytes the
        // file has. Once it is materialized and the guest writes to it, the
        // contents are deliberately something else — re-checking them would
        // turn every write to a verified file into an EIO on the next read.
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let real: &[u8] = b"the bytes the image described";
        insert_host_file(b"/fetched.bin", 9, real.len() as u64, 0o644, 0, 0, 9).unwrap();
        mark_deferred_base(b"/fetched.bin").unwrap();
        set_deferred_source(
            b"/fetched.bin",
            &blob_uri(9),
            &crate::sdef::digest_of(real),
        )
        .expect("declare it");

        let (mut fetch, _) =
            make_byte_source(alloc::vec![(9u64, real.to_vec())], alloc::vec::Vec::new());
        let h = open(b"/fetched.bin", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 64];
        assert_eq!(
            read(h, 0, &mut buf, &mut fetch).expect("verified once"),
            real.len()
        );
        write(h, 0, b"THE", &mut fetch).expect("the guest replaces three bytes");
        let n = read(h, 0, &mut buf, &mut fetch).expect("still readable after a write");
        assert_eq!(&buf[..3], b"THE");
        assert_eq!(n, real.len());
        release_handle(h);
    }

    #[test]
    fn an_archive_that_declares_no_digest_is_still_served() {
        let _g = TestGuard::acquire();
        // Every image in existence before v5 declares none, and `KLZY` has no
        // field for one at all. Refusing those would not be a stricter kernel,
        // it would be a kernel that cannot boot the images we ship — so "no
        // digest declared" accepts, and whether an image may declare none is a
        // question for whoever decides it may be loaded.
        build_lazy_tree();
        let (mut fetch, _) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        assert_eq!(read(h, 0, &mut buf, &mut fetch), Ok(4096));
        release_handle(h);
    }

    #[test]
    fn a_member_whose_inflated_bytes_fail_their_digest_is_refused() {
        let _g = TestGuard::acquire();
        // The archive is exactly what the image described; the MEMBER is not.
        // The archive's digest cannot catch this — it covers the archive — so
        // without the per-record digest an archive that hashes correctly but
        // unpacks wrongly would be accepted in full.
        build_lazy_tree();
        set_archive_digest(7, crate::sdef::digest_of(TINY_ZIP));
        set_deferred_source(b"/lazy/f", b"", &[0x11u8; crate::sdef::DIGEST_LEN])
            .expect("declare a digest the member's bytes will not match");

        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        assert_eq!(read(h, 0, &mut buf, &mut fetch), Err(Errno::EIO));
        assert_eq!(calls.get(), 1, "the archive itself passed and was fetched");
        // The file stays deferred: a member that failed its digest must not
        // become this inode's contents.
        assert!(lazy_info(b"/lazy/f").expect("still described").0);
        release_handle(h);
    }

    #[test]
    fn a_short_deferred_file_cannot_become_a_truncated_overlay() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_host_file(b"/short", 9, 4, 0o644, 0, 0, 9).unwrap();
        mark_deferred_base(b"/short").unwrap();
        let uri = blob_uri(9);
        set_deferred_source(b"/short", &uri, &crate::sdef::DIGEST_NONE).unwrap();
        let before = lstat(b"/short").unwrap();
        let h = open(b"/short", O_WRONLY, 0, 0, 0).unwrap();
        let mut discarded = 0;
        let mut short = |req: ByteReq, buf: &mut [u8]| match req {
            ByteReq::Deferred { offset: 0, .. } => {
                buf[..2].copy_from_slice(b"ab");
                Ok(2)
            }
            ByteReq::Deferred { .. } => Ok(0),
            ByteReq::DiscardDeferred { uri: rejected } => {
                assert_eq!(rejected, uri);
                discarded += 1;
                // A cache-cleanup error must not hide the original EIO.
                Err(Errno::ENOSYS)
            }
            ByteReq::Image { .. } => Err(Errno::ENOSYS),
        };
        assert_eq!(write(h, 0, b"Z", &mut short), Err(Errno::EIO));
        assert_eq!(discarded, 1);
        let after = lstat(b"/short").unwrap();
        assert_eq!(after.st_size, before.st_size);
        assert_eq!(after.st_mode, before.st_mode);
        assert_eq!(after.st_mtime_sec, before.st_mtime_sec);
        assert!(lazy_info(b"/short").unwrap().0);
        let (mut complete, _) = make_byte_source(alloc::vec![(9, b"abcd".to_vec())], alloc::vec![]);
        assert_eq!(write(h, 0, b"Z", &mut complete), Ok(1));
        let mut bytes = [0; 4];
        assert_eq!(read(h, 0, &mut bytes, &mut complete), Ok(4));
        assert_eq!(&bytes, b"Zbcd");
        release_handle(h);
    }

    #[test]
    fn a_standalone_file_whose_bytes_fail_their_digest_is_refused() {
        let _g = TestGuard::acquire();
        // The other kind of deferred file: no archive, one URI, and a digest
        // over the bytes that URI serves.
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        let real: &[u8] = b"the bytes the image described";
        insert_host_file(b"/fetched.bin", 9, real.len() as u64, 0o644, 0, 0, 9).unwrap();
        mark_deferred_base(b"/fetched.bin").unwrap();
        set_deferred_source(
            b"/fetched.bin",
            &blob_uri(9),
            &crate::sdef::digest_of(real),
        )
        .expect("declare where it is and what it must be");

        // EXACTLY as long as the real thing, because length is the check that
        // already passed: `fetchArchive` compares byte counts today, and the
        // whole reason a digest was needed is that same-length substitution
        // sails through it. A shorter forgery would be refused by the size
        // clamp and this test would prove nothing.
        let forged: &[u8] = b"the bytes a substituting host";
        assert_eq!(forged.len(), real.len(), "the forgery must not be caught by length");
        let (mut bad, _) = make_byte_source(
            alloc::vec![(9u64, forged.to_vec())],
            alloc::vec::Vec::new(),
        );
        let h = open(b"/fetched.bin", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 64];
        assert_eq!(read(h, 0, &mut buf, &mut bad), Err(Errno::EIO));
        // Not materialized, so the wrong bytes are not this file's contents and
        // a later read re-fetches rather than serving them from the overlay.
        assert!(lazy_info(b"/fetched.bin").expect("still described").0);

        // A WINDOW of it is refused too, which is the case the whole-file
        // materialization gate exists for: a digest covers the whole object, so
        // a four-byte read has nothing to check itself against and must not be
        // the one read that escapes verification.
        let (mut bad_window, _) = make_byte_source(
            alloc::vec![(9u64, forged.to_vec())],
            alloc::vec::Vec::new(),
        );
        let mut window = [0u8; 4];
        assert_eq!(read(h, 5, &mut window, &mut bad_window), Err(Errno::EIO));

        let (mut good, _) =
            make_byte_source(alloc::vec![(9u64, real.to_vec())], alloc::vec::Vec::new());
        let n = read(h, 0, &mut buf, &mut good).expect("the right bytes are accepted");
        assert_eq!(&buf[..n], real);
        release_handle(h);
    }

    /// Two DIFFERENT members of the SAME archive: the whole-archive fetch is
    /// amortized across both, not repeated per member.
    #[test]
    fn lazy_member_second_different_member_reuses_archive_fetch() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_base_dir(b"/lazy", 0o755, 0, 0, 2).unwrap();
        insert_lazy_file(
            b"/lazy/big",
            7,
            b"bin/big.txt",
            4096,
            0o644,
            0,
            0,
            3,
            b"",
            b"",
            b"",
        )
        .unwrap();
        insert_lazy_file(
            b"/lazy/small",
            7,
            b"etc/small.txt",
            6,
            0o644,
            0,
            0,
            4,
            b"",
            b"",
            b"",
        )
        .unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);

        let h1 = open(b"/lazy/big", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf1 = [0u8; 4096];
        let n1 = read(h1, 0, &mut buf1, &mut fetch).unwrap();
        assert_eq!(n1, 4096);
        assert!(buf1.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h1);

        let h2 = open(b"/lazy/small", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf2 = [0u8; 6];
        let n2 = read(h2, 0, &mut buf2, &mut fetch).unwrap();
        assert_eq!(n2, 6);
        assert_eq!(&buf2, b"hello\n");
        // A different member of the SAME archive reuses the cached
        // whole-archive fetch: the total stays 1, not 2.
        assert_eq!(calls.get(), 1);
        release_handle(h2);
    }

    #[test]
    fn lazy_member_fetch_eagain_is_idempotent_restart() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let h = open(b"/lazy/f", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 4096];
        let mut failing =
            |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> { Err(Errno::EAGAIN) };
        assert_eq!(
            read(h, 0, &mut buf, &mut failing).unwrap_err(),
            Errno::EAGAIN
        );

        // Nothing partial was cached by the failed attempt: a working fetcher
        // on the very next call re-fetches the whole archive from scratch and
        // succeeds.
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let n = read(h, 0, &mut buf, &mut fetch).unwrap();
        assert_eq!(n, 4096);
        assert!(buf.iter().all(|&b| b == b'a'));
        assert_eq!(calls.get(), 1);
        release_handle(h);
    }

    #[test]
    fn lazy_member_missing_source_path_is_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_lazy_file(b"/g", 7, b"bin/nope", 10, 0o644, 0, 0, 2, b"", b"", b"").unwrap();
        insert_archive_entry(7, TINY_ZIP.len() as u64);
        let (mut fetch, _calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/g", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        assert_eq!(
            read(h, 0, &mut buf, &mut fetch).unwrap_err(),
            Errno::ENOENT
        );
        release_handle(h);
    }

    #[test]
    fn lazy_member_missing_archive_registration_is_enoent() {
        let _g = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        insert_lazy_file(
            b"/g",
            42,
            b"bin/big.txt",
            4096,
            0o644,
            0,
            0,
            2,
            b"",
            b"",
            b"",
        )
        .unwrap();
        // No insert_archive_entry(42, ..): archive_id 42 is not registered.
        let (mut fetch, _calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        let h = open(b"/g", O_RDONLY, 0, 0, 0).unwrap();
        let mut buf = [0u8; 16];
        assert_eq!(
            read(h, 0, &mut buf, &mut fetch).unwrap_err(),
            Errno::ENOENT
        );
        release_handle(h);
    }

    #[test]
    fn lazy_member_write_materializes_then_overwrites() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        // O_RDWR == 2.
        let h = open(b"/lazy/f", 2, 0, 0, 0).unwrap();
        assert_eq!(write(h, 0, b"XYZ", &mut fetch).unwrap(), 3);
        assert_eq!(calls.get(), 1);

        // A fetcher that panics proves the post-materialization node is a
        // Regular overlay file, never re-touching the archive.
        let mut panic_fetch = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> {
            panic!("post-materialization read must be served from the overlay");
        };
        let mut buf = [0u8; 4096];
        let n = read(h, 0, &mut buf, &mut panic_fetch).unwrap();
        assert_eq!(n, 4096);
        assert_eq!(&buf[..3], b"XYZ");
        assert!(buf[3..].iter().all(|&b| b == b'a'));
        assert_eq!(lstat(b"/lazy/f").unwrap().st_size, 4096);
        release_handle(h);
    }

    #[test]
    fn materializing_one_deferred_file_leaves_every_other_file_untouched() {
        // PORTED from a host test that asserted it about the TypeScript
        // filesystem's `SharedArrayBuffer`, which is gone. THE HAZARD OUTLIVED THE MECHANISM.
        //
        // There, the host served the kernel's image window out of the same
        // buffer a materialization wrote into, so a materialization that moved
        // or clobbered blocks would make the kernel read a wrong tree with no
        // error anywhere. The buffer is gone -- the kernel reads the image
        // through `imageRead` and materializes into its own overlay -- but the
        // shape of the failure is identical: one file's arrival must not
        // disturb another's bytes, and nothing here asserted that.
        //
        // A BASE file beside the deferred one, because a base file is the one
        // whose content does not live in the overlay at all: it is read back
        // out of the image, which is the read a wrongly-placed overlay block
        // would corrupt.
        let _g = TestGuard::acquire();
        build_lazy_tree();
        insert_host_file(b"/lazy/plain", 90, 5, 0o644, 0, 0, 4).unwrap();

        let (mut fetch, _calls) = make_byte_source(
            alloc::vec![(90u64, b"PLAIN".to_vec())],
            alloc::vec![(7u32, TINY_ZIP.to_vec())],
        );

        let mut before = [0u8; 8];
        let n = read_file_at(b"/lazy/plain", 0, &mut before, &mut fetch).unwrap();
        assert_eq!(&before[..n], b"PLAIN");

        // O_RDWR == 2: writing a lazy member MATERIALIZES it, which is the
        // mutation that allocates.
        let h = open(b"/lazy/f", 2, 0, 0, 0).unwrap();
        assert_eq!(write(h, 0, b"XYZ", &mut fetch).unwrap(), 3);
        release_handle(h);

        // The mutation really happened -- otherwise the assertion below is
        // vacuous, which is exactly how the version of this claim being
        // retired could have passed without proving anything.
        assert_eq!(lstat(b"/lazy/f").unwrap().st_size, 4096);

        let mut after = [0u8; 8];
        let n = read_file_at(b"/lazy/plain", 0, &mut after, &mut fetch).unwrap();
        assert_eq!(&after[..n], b"PLAIN", "the base file came through untouched");
        assert_eq!(
            lstat(b"/lazy/plain").unwrap().st_size,
            5,
            "and it is still the size it was",
        );
    }

    #[test]
    fn lazy_member_truncate_to_zero_converts_to_empty_regular() {
        let _g = TestGuard::acquire();
        build_lazy_tree();
        let (mut fetch, calls) =
            make_byte_source(alloc::vec::Vec::new(), alloc::vec![(7u32, TINY_ZIP.to_vec())]);
        // O_RDWR == 2.
        let h = open(b"/lazy/f", 2, 0, 0, 0).unwrap();
        truncate_handle(h, 0, &mut fetch).unwrap();
        // Truncating to 0 needs no archive bytes.
        assert_eq!(calls.get(), 0);
        assert_eq!(size(h).unwrap(), 0);
        assert_eq!(lstat(b"/lazy/f").unwrap().st_size, 0);
        release_handle(h);
    }

    // -----------------------------------------------------------------------
    // load_image: the kernel parsing its own `/` image.
    // -----------------------------------------------------------------------

    /// A real VFSI container emitted by the production image writer. Six inodes:
    /// `/` (dir), `/big.txt` (45,000 B), `/dir` (dir), `/dir/*` , `/hello.txt`,
    /// `/link` (symlink). It carries no `KLZY` section, which is exactly the
    /// "older image" case `kernel_lazy_span` must read as `None` rather than as
    /// corruption.
    /// A small `/` image built at test time by the Rust image writer; see
    /// `crate::test_fixtures::tiny_vfs` for its tree.
    fn tiny_vfs() -> &'static [u8] {
        crate::test_fixtures::tiny_vfs()
    }

    /// The same image with an empty `SDEF` section declared, so it loads; see
    /// `crate::test_fixtures::tiny_vfs_described`.
    fn tiny_vfs_described() -> &'static [u8] {
        crate::test_fixtures::tiny_vfs_described()
    }

    mod persistent_image;

    /// A host that owns `image` and serves only [`ByteReq::Image`]. Blob and
    /// archive requests are `ENOSYS`, so a test that accidentally reaches for
    /// them fails loudly instead of reading image bytes by another name.
    fn image_host(image: &[u8]) -> impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> + '_ {
        move |req, buf| match req {
            ByteReq::Image { offset } => {
                let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
                if start >= image.len() {
                    return Ok(0);
                }
                let n = core::cmp::min(buf.len(), image.len() - start);
                buf[..n].copy_from_slice(&image[start..start + n]);
                Ok(n)
            }
            _ => Err(Errno::ENOSYS),
        }
    }

    /// `tiny_vfs_described()` with a `KLZY` section appended and its container
    /// flag set: a well-formed image whose body describes its deferred files
    /// with `SDEF` but which ALSO carries the retired `KLZY` section. The
    /// section goes after the existing (empty) lazy-JSON section, which is
    /// where `kernel_lazy_span` walks to find it, so this exercises the real
    /// section-walk rather than a shortcut.
    fn tiny_vfs_with_kernel_lazy(section: &[u8]) -> Vec<u8> {
        let mut image = tiny_vfs_described().to_vec();
        let flags = u32::from_le_bytes([image[8], image[9], image[10], image[11]]);
        let flagged = flags | wasm_posix_shared::abi::VFS_IMAGE_FLAG_HAS_KERNEL_LAZY;
        image[8..12].copy_from_slice(&flagged.to_le_bytes());
        image.extend_from_slice(&(section.len() as u32).to_le_bytes());
        image.extend_from_slice(section);
        image
    }

    fn tiny_vfs_with_growth_capacity(capacity: u64) -> Vec<u8> {
        let original = tiny_vfs_described().to_vec();
        let mut source = image_host(&original);
        load_image(original.len() as u64, &mut source).unwrap();
        set_image_capacity(capacity).unwrap();
        let image = drain_container(8192, &mut source);
        reset();
        image
    }

    /// An image that DECLARES lazy archives and carries none is refused.
    ///
    /// The guard exists — `container_flags` is read once, right here — and
    /// nothing exercised it: the test module referenced neither
    /// `container_flags` nor `VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES` at all.
    ///
    /// Its own comment says what it prevents, and it is not a formality: a
    /// stale artifact whose archives were dropped turns a 4,096-byte binary
    /// into an empty file, the load reports SUCCESS, and a build derived from
    /// it ships the emptiness. The declaration is the only evidence that
    /// something is missing, so refusing on it is the difference between a
    /// loud failure and a wrong tree that looks like a right one.
    #[test]
    fn load_image_refuses_an_image_that_declares_lazy_archives_and_carries_none() {
        let _guard = TestGuard::acquire();
        // A well-formed image with an EMPTY archive table ...
        let mut image = tiny_vfs_described().to_vec();
        // ... whose header says it has lazy archives.
        let flags = u32::from_le_bytes([image[8], image[9], image[10], image[11]]);
        let declared = flags | crate::kandelo_image_fs::VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES;
        image[8..12].copy_from_slice(&declared.to_le_bytes());

        assert_eq!(
            load_image(image.len() as u64, image_host(&image)).err(),
            Some(Errno::EINVAL),
            "an image declaring archives it does not carry must fail loudly",
        );

        // The same image without the declaration loads, so the refusal is
        // about the MISMATCH rather than about anything else in the fixture.
        let honest = tiny_vfs_described().to_vec();
        assert!(
            load_image(honest.len() as u64, image_host(&honest)).is_ok(),
            "an image that declares nothing it lacks still loads",
        );
    }

    #[test]
    fn load_image_builds_the_base_tree_from_a_real_vfs_image() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let count = load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(count, 6, "root + 4 root entries + 1 file under /dir");

        let root = lstat(b"/").expect("/ stat");
        assert_eq!(root.st_mode & 0xf000, S_IFDIR);
        assert_eq!(root.st_mode & 0o7777, 0o755);
        assert_eq!(root.st_ino, 1);

        let big = lstat(b"/big.txt").expect("/big.txt stat");
        assert_eq!(big.st_mode & 0xf000, S_IFREG);
        assert_eq!(big.st_mode & 0o7777, 0o644);
        assert_eq!(big.st_size, 45_000);
        assert_eq!(big.st_ino, 6);
        // The image's own mtime, in whole seconds plus nanoseconds — not the
        // store's create-time stamp, which `TestGuard` pinned at 1,000s.
        assert_eq!(big.st_mtime_sec, 1_788_130_661);
        assert_eq!(big.st_mtime_nsec, 647_000_000);

        assert_eq!(lstat(b"/hello.txt").expect("hello").st_size, 11);
        assert_eq!(lstat(b"/dir").expect("dir").st_mode & 0xf000, S_IFDIR);

        let link = lstat(b"/link").expect("/link stat");
        assert_eq!(link.st_mode & 0xf000, S_IFLNK);
        let mut target = [0u8; 64];
        let n = readlink(b"/link", &mut target).expect("readlink");
        assert_eq!(n, link.st_size as usize);
        assert!(!target[..n].is_empty());
    }

    #[test]
    fn image_walk_vector_admission_covers_growth_overlap_before_allocation() {
        let budget = crate::metadata_budget::MetadataBudget::new(64);
        let mut memory = budget.reserve_temporary(0).unwrap();
        let mut values = Vec::<u64>::new();
        reserve_image_walk_capacity(&mut values, 4, &mut memory).unwrap();
        values.extend_from_slice(&[1, 2, 3, 4]);
        assert_eq!(budget.temporary_usage(), 32);
        reserve_image_walk_capacity(&mut values, 8, &mut memory).unwrap();
        values.extend_from_slice(&[5, 6, 7, 8]);
        assert_eq!(budget.temporary_usage(), 64);
        assert_eq!(reserve_image_walk_capacity(&mut values, 16, &mut memory), Err(Errno::ENOMEM));
        assert_eq!(values, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(values.capacity(), 8);
        assert_eq!(budget.temporary_usage(), 64);
        drop((values, memory));
        assert_eq!(budget.temporary_usage(), 0);
    }

    #[test]
    fn image_walk_inode_admission_is_temporary_fallible_and_duplicate_free() {
        use crate::kandelo_image_fs::ROOT_INO;
        let _guard = TestGuard::acquire();
        let mut visited = crate::prepared_map::PreparedMap::new();
        let limit = ROOTFS_METADATA.usage().1;
        let blocker = ROOTFS_METADATA.reserve_temporary(limit * 2).unwrap();
        assert_eq!(mark_image_walk_inode(&mut visited, ROOT_INO), Err(Errno::ENOMEM));
        assert!(visited.is_empty());
        assert_eq!(ROOTFS_METADATA.usage().0, 0);
        drop(blocker);
        assert_eq!(mark_image_walk_inode(&mut visited, ROOT_INO), Ok(true));
        let used = ROOTFS_METADATA.temporary_usage();
        assert!(used > 0);
        assert_eq!(mark_image_walk_inode(&mut visited, ROOT_INO), Ok(false));
        assert_eq!(ROOTFS_METADATA.temporary_usage(), used);
        *visited.get_mut(&ROOT_INO).unwrap() = Some(42);
        assert_eq!(visited.get(&ROOT_INO), Some(&Some(42)));
        drop(visited);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn image_load_traversal_refusal_resets_partial_tree_and_retries() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let mut source = image_host(&image);
        let mut blocker = None;
        let mut triggered = false;
        let result = load_image(image.len() as u64, |request, destination| {
            if !triggered && ROOTFS.with(|state| state.mount_root().is_ok()) {
                let available = ROOTFS_METADATA.usage().1 * 2 - ROOTFS_METADATA.temporary_usage();
                blocker = Some(ROOTFS_METADATA.reserve_temporary(available)?);
                triggered = true;
            }
            source(request, destination)
        });
        assert!(triggered);
        assert_eq!(result, Err(Errno::ENOMEM));
        assert_eq!(metadata_budget_usage().0, 0);
        drop(blocker);
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        load_image(image.len() as u64, &mut source).unwrap();
        assert!(lstat(b"/hello.txt").is_ok());
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
    }

    #[test]
    fn load_image_streams_wide_and_deep_directories_with_cross_directory_hardlinks() {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: 4 * 1024 * 1024,
            max_size_bytes: None,
            growable_to_bytes: 4 * 1024 * 1024,
            now_ms: 123000,
        }).unwrap();
        writer.declare_deferred_section().unwrap();
        let shared = writer.create_file(writer.root(), b"shared", 0o640, Content::Bytes(b"shared bytes")).unwrap();
        let mut deepest = Vec::new();
        for index in (0..240).rev() {
            let name = alloc::format!("{index:04}-{}", "n".repeat(200));
            let directory = writer.mkdir(writer.root(), name.as_bytes(), 0o751).unwrap();
            writer.create_file(directory, b"file", 0o600, Content::Bytes(b"payload")).unwrap();
            if index == 0 {
                deepest.push(b'/');
                deepest.extend_from_slice(name.as_bytes());
                let mut parent = directory;
                for _ in 0..40 {
                    parent = writer.mkdir(parent, b"deep", 0o700).unwrap();
                    deepest.extend_from_slice(b"/deep");
                }
                writer.link(parent, b"alias", shared).unwrap();
            }
            if index == 239 {
                writer.link(directory, b"alias", shared).unwrap();
            }
        }
        deepest.extend_from_slice(b"/alias");
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(body.as_slice()).unwrap();
        let first_directory = alloc::format!("/0239-{}", "n".repeat(200));
        let first_directory_ino = filesystem.resolve(first_directory.as_bytes(), false).unwrap();
        let table = u32::from_le_bytes(body[36..40].try_into().unwrap()) as usize * 4096;
        let pointer = table + first_directory_ino as usize * 128 + 48;
        let first_directory_offset = 16 + u32::from_le_bytes(body[pointer..pointer + 4].try_into().unwrap()) as u64 * 4096;
        let mut first_directory_live_inodes = None;
        let mut source = image_host(&image);
        assert_eq!(load_image(image.len() as u64, |request, destination| {
            if matches!(request, ByteReq::Image { offset } if offset == first_directory_offset)
                && first_directory_live_inodes.is_none()
            {
                first_directory_live_inodes = Some(ROOTFS.with(|state| state.inodes.iter().flatten().count()));
            }
            source(request, destination)
        }), Ok(524));
        assert_eq!(first_directory_live_inodes, Some(3));
        let original = lstat(b"/shared").unwrap();
        assert_eq!(original.st_nlink, 3);
        assert_eq!(lstat(&deepest).unwrap().st_ino, original.st_ino);
        for index in [0, 137, 239] {
            let path = alloc::format!("/{index:04}-{}/file", "n".repeat(200));
            let mut bytes = [0; 7];
            assert_eq!(read_file_at(path.as_bytes(), 0, &mut bytes, &mut source), Ok(7));
            assert_eq!(&bytes, b"payload");
        }
        let exported = drain_export(8192, &mut source);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).unwrap();
        let shared_ino = filesystem.resolve(b"/shared", false).unwrap();
        assert_eq!(filesystem.resolve(&deepest, false).unwrap(), shared_ino);
        assert_eq!(filesystem.stat_ino(shared_ino).unwrap().nlink, 3);
    }

    #[test]
    fn load_image_resets_and_retries_after_nested_directory_source_failures() {
        use crate::kandelo_image_fs::{KandeloImageFs, unwrap_vfsi};
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let body = unwrap_vfsi(&image).unwrap();
        let filesystem = KandeloImageFs::mount(body).unwrap();
        let directory = filesystem.resolve(b"/dir", false).unwrap();
        let table = u32::from_le_bytes(body[36..40].try_into().unwrap()) as usize * 4096;
        let pointer = table + directory as usize * 128 + 48;
        let directory_offset = 16 + u32::from_le_bytes(body[pointer..pointer + 4].try_into().unwrap()) as u64 * 4096;
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            let mut source = image_host(&image);
            let mut failed = false;
            assert_eq!(load_image(image.len() as u64, |request, destination| {
                if matches!(request, ByteReq::Image { offset } if offset == directory_offset) {
                    failed = true;
                    return Err(error);
                }
                source(request, destination)
            }), Err(error));
            assert!(failed);
            ROOTFS.with(|state| {
                assert!(state.image.is_none());
                assert!(state.root.is_none());
                assert!(state.inodes.is_empty());
            });
            assert_eq!(load_image(image.len() as u64, image_host(&image)), Ok(6));
            assert_eq!(lstat(b"/dir/nested.txt").unwrap().st_mode & S_IFMT, S_IFREG);
        }
    }

    /// The point of the whole item: after `load_image`, an ordinary file's
    /// BYTES come out of the image too, not out of a host byte store.
    ///
    /// `image_host` answers `ByteReq::Base` with `ENOSYS`, so this test cannot
    /// pass by accident — a read that still reached for the host blob store
    /// would fail rather than quietly return the same bytes by another route.
    #[test]
    fn image_backed_file_bytes_are_served_from_the_image() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let mut host = image_host(&image);
        load_image(image.len() as u64, &mut host).expect("load image");

        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).expect("open");
        let mut buf = [0u8; 32];
        let n = read(handle, 0, &mut buf, &mut host).expect("read");
        assert_eq!(n, 11);
        assert_eq!(&buf[..n], b"hello sffs\n");

        // Positioned read inside the file, and the EOF clamp.
        let mut tail = [0u8; 32];
        let n = read(handle, 6, &mut tail, &mut host).expect("read at 6");
        assert_eq!(&tail[..n], b"sffs\n");
        assert_eq!(read(handle, 11, &mut tail, &mut host).expect("read at EOF"), 0);
        release_handle(handle);
    }

    #[test]
    fn extended_container_header_loads_a_real_rootfs_image() {
        let _guard = TestGuard::acquire();
        let original = tiny_vfs_described().to_vec();
        let body_len = u32::from_le_bytes(original[12..16].try_into().unwrap()) as u64;
        let mut extended = original[..12].to_vec();
        extended[4..8].copy_from_slice(&2u32.to_le_bytes());
        extended.extend_from_slice(&24u32.to_le_bytes());
        extended.extend_from_slice(&body_len.to_le_bytes());
        extended.extend_from_slice(&original[16..]);
        let mut host = image_host(&extended);
        assert_eq!(load_image(extended.len() as u64, &mut host), Ok(6));
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).expect("open");
        let mut bytes = [0u8; 11];
        assert_eq!(read(handle, 0, &mut bytes, &mut host), Ok(11));
        assert_eq!(&bytes, b"hello sffs\n");
        release_handle(handle);
    }

    #[test]
    fn fixed_persistence_replays_image_file_overwrite_after_reset() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();

        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 6, b"KIFS", &mut image_bytes).unwrap(), 4);
        let mut changed = [0u8; 16];
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello KIFS\n");
        assert_eq!(write(handle, 11, b"!", &mut image_bytes), Err(Errno::EFBIG));
        sync_persistence().unwrap();
        release_handle(handle);
        assert_eq!(
            open(b"/hello.txt", O_RDWR | O_TRUNC, 0, 0, 0),
            Err(Errno::EROFS)
        );
        assert_eq!(
            open(b"/new", O_RDWR | O_CREAT, 0o644, 0, 0),
            Err(Errno::EROFS)
        );
        assert_eq!(unlink(b"/hello.txt"), Err(Errno::EROFS));

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        assert_eq!(
            enable_fixed_persistence(Box::new(storage.clone()), [0u8; 32], &mut image_bytes),
            Err(Errno::EIO),
        );
        enable_fixed_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello KIFS\n");
        release_handle(handle);
    }

    #[test]
    fn fixed_persistence_exports_unsynced_visible_image_bytes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 6, b"KIFS", &mut image_bytes), Ok(4));
        release_handle(handle);

        let exported = drain_container(4096, &mut image_bytes);
        reset();
        let mut exported_bytes = image_host(&exported);
        load_image(exported.len() as u64, &mut exported_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let mut bytes = [0u8; 16];
        let read_len = read(handle, 0, &mut bytes, &mut exported_bytes).unwrap();
        assert_eq!(&bytes[..read_len], b"hello KIFS\n");
        release_handle(handle);
    }

    #[test]
    fn resizable_persistence_exports_created_and_zero_fenced_bytes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let hello = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(hello, 3, &mut image_bytes).unwrap();
        truncate_handle(hello, 11, &mut image_bytes).unwrap();
        assert_eq!(write(hello, 10, b"!", &mut image_bytes), Ok(1));
        release_handle(hello);
        let fresh = open(b"/fresh", O_CREAT | O_RDWR, 0o640, 0, 0).unwrap();
        assert_eq!(write(fresh, 8192, b"TAIL", &mut image_bytes), Ok(4));
        sync_persistence().unwrap();
        release_handle(fresh);

        let exported = drain_container(4096, &mut image_bytes);
        reset();
        let mut exported_bytes = image_host(&exported);
        load_image(exported.len() as u64, &mut exported_bytes).unwrap();
        let hello = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let mut hello_bytes = [0u8; 11];
        assert_eq!(read(hello, 0, &mut hello_bytes, &mut exported_bytes), Ok(11));
        assert_eq!(&hello_bytes, b"hel\0\0\0\0\0\0\0!");
        release_handle(hello);
        let fresh = open(b"/fresh", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(fresh).unwrap().st_size, 8196);
        let mut fresh_bytes = [0u8; 7];
        assert_eq!(read(fresh, 8189, &mut fresh_bytes, &mut exported_bytes), Ok(7));
        assert_eq!(&fresh_bytes, b"\0\0\0TAIL");
        release_handle(fresh);
    }

    #[test]
    fn streamed_sparse_snapshot_source_errors_preserve_live_and_durable_state() {
        use crate::kandelo_image_write::{Content, ContentSource, KandeloImageConfig, KandeloImageWriter};
        struct BaseContent;
        impl ContentSource for BaseContent {
            fn read_exact_at(&self, _id: u64, _offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                bytes.fill(7);
                Ok(())
            }
        }
        let _guard = TestGuard::acquire();
        let high = 9 * 1024 * 1024 * 1024u64;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 256 * 1024, max_size_bytes: Some(256 * 1024),
            growable_to_bytes: 256 * 1024, now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        for (name, mode) in [(&b"sparse"[..], 0o600), (&b"protected"[..], 0o4644)] {
            writer.create_file(writer.root(), name, mode, Content::SparseDeferred {
                id: 1, len: high + 4096, blocks: &[0, (high / 4096) as u32],
            }).unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&BaseContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        for persistence in 0..3 {
            reset();
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            if persistence == 1 {
                enable_fixed_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            } else if persistence == 2 {
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            }
            if persistence != 0 {
                let handle = open(b"/sparse", O_RDWR, 0, 0, 0).unwrap();
                assert_eq!(write(handle, 4096, b"new", &mut source), Ok(3));
                release_handle(handle);
                sync_persistence().unwrap();
            }
            if persistence == 2 {
                let handle = open(b"/created", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
                assert_eq!(write(handle, high as i64, b"tail", &mut source), Ok(4));
                release_handle(handle);
                sync_persistence().unwrap();
            }
            let durable = storage.0.lock().clone();
            let before = statfs(b"/").unwrap();
            let describe = || ROOTFS.with(|state| state.inodes.iter().flatten().map(|inode|
                (inode.ino, inode.allocated_blocks, inode.persistent_size, inode.nlink))
                .collect::<Vec<_>>());
            let previous = describe();
            let mut requests = 0;
            let plan = build_export_image(&mut |request, bytes| {
                requests += 1;
                source(request, bytes)
            }).unwrap();
            assert!(requests > 4);
            let expected_size = plan.len();
            drop(plan);
            for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
                for fail_at in 0..requests {
                    let mut calls = 0;
                    let result = build_export_image(&mut |request, bytes| {
                        if calls == fail_at { return Err(error); }
                        calls += 1;
                        source(request, bytes)
                    });
                    assert_eq!(result.err(), Some(error), "mode={persistence} call={fail_at}");
                    assert_eq!(describe(), previous);
                    let current = statfs(b"/").unwrap();
                    assert_eq!((current.f_bfree, current.f_ffree), (before.f_bfree, before.f_ffree));
                    assert_eq!(*storage.0.lock(), durable);
                }
            }
            assert_eq!(build_export_image(&mut source).unwrap().len(), expected_size);
            let snapshot = drain_container(4096, &mut source);
            assert!(snapshot.len() < 512 * 1024);
            reset();
            let mut reopened = image_host(&snapshot);
            load_image(snapshot.len() as u64, &mut reopened).unwrap();
            for name in [&b"/sparse"[..], &b"/protected"[..]] {
                let handle = open(name, O_RDONLY, 0, 0, 0).unwrap();
                let mut bytes = [0; 4];
                assert_eq!(read(handle, high as i64, &mut bytes, &mut reopened), Ok(4));
                assert_eq!(bytes, [7; 4]);
                assert_eq!(read(handle, 4096, &mut bytes, &mut reopened), Ok(4));
                if persistence != 0 && name == b"/sparse" { assert_eq!(&bytes, b"new\0"); }
                else { assert_eq!(bytes, [0; 4]); }
                release_handle(handle);
            }
            if persistence == 2 { assert_eq!(lstat(b"/created").unwrap().st_size, high + 4); }
        }
    }

    #[test]
    fn allocation_ledger_recovery_source_errors_do_not_publish_partial_state() {
        use crate::kandelo_image_write::{Content, ContentSource, KandeloImageConfig, KandeloImageWriter};
        struct BaseContent;
        impl ContentSource for BaseContent {
            fn read_exact_at(&self, _id: u64, _offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                bytes.fill(7);
                Ok(())
            }
        }
        let _guard = TestGuard::acquire();
        let high = 9 * 1024 * 1024 * 1024u64;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_file(writer.root(), b"sparse", 0o600, Content::SparseDeferred {
            id: 1, len: high + 4096, blocks: &[0, (high / 4096) as u32],
        }).unwrap();
        let body = writer.finish().unwrap().to_vec(&BaseContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        for indexed in [false, true] {
            reset();
            let mut source = image_host(&image);
            load_image(image.len() as u64, &mut source).unwrap();
            let mut storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            let handle = open(b"/sparse", O_RDWR, 0, 0, 0).unwrap();
            assert_eq!(write(handle, 4096, b"new", &mut source), Ok(3));
            release_handle(handle);
            mkdir(b"/added", 0o755, 0, 0).unwrap();
            let handle = open(b"/added/data", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
            assert_eq!(write(handle, 9 * 4096, b"yes", &mut source), Ok(3));
            release_handle(handle);
            sync_persistence().unwrap();
            let expected_free = statfs(b"/").unwrap().f_bfree;
            let checkpoint = if indexed {
                let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
                let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
                prepare_persistence_compaction(Box::new(target.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
                storage = target;
                let end = storage.0.lock().len() as u64;
                Some((index, end))
            } else {
                None
            };
            reset();
            load_image(image.len() as u64, &mut source).unwrap();
            let describe = || ROOTFS.with(|state| (
                state.next_ino,
                state.inodes.iter().flatten().map(|inode|
                    (inode.ino, inode.allocated_blocks, inode.persistent_size, inode.nlink))
                    .collect::<Vec<_>>(),
            ));
            let before = describe();
            let durable = storage.0.lock().clone();
            let recover = |reader: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>| {
                match &checkpoint {
                    Some((index, end)) => enable_resizable_persistence_indexed(
                        Box::new(storage.clone()), Box::new(index.clone()), digest, *end, reader),
                    None => enable_resizable_persistence(Box::new(storage.clone()), digest, reader),
                }
            };
            for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
                let mut unavailable = |_: ByteReq, _: &mut [u8]| Err(error);
                assert_eq!(recover(&mut unavailable), Err(error));
                assert!(!fixed_persistence_enabled());
                assert_eq!(describe(), before);
                assert_eq!(lstat(b"/added").err(), Some(Errno::ENOENT));
                assert_eq!(*storage.0.lock(), durable);
            }
            recover(&mut source).unwrap();
            assert_eq!(statfs(b"/").unwrap().f_bfree, expected_free);
            assert_eq!(lstat(b"/added/data").unwrap().st_size, 9 * 4096 + 3);
            let handle = open(b"/sparse", O_RDONLY, 0, 0, 0).unwrap();
            let mut bytes = [0; 3];
            assert_eq!(read(handle, 4096, &mut bytes, &mut source), Ok(3));
            assert_eq!(&bytes, b"new");
            release_handle(handle);
        }
    }

    #[test]
    fn positioned_sparse_mutation_queries_fail_before_changing_live_or_durable_state() {
        use crate::kandelo_image_write::{Content, ContentSource, KandeloImageConfig, KandeloImageWriter};
        struct BaseContent;
        impl ContentSource for BaseContent {
            fn read_exact_at(&self, _id: u64, _offset: u64, bytes: &mut [u8]) -> Result<(), Errno> {
                bytes.fill(7);
                Ok(())
            }
        }
        let _guard = TestGuard::acquire();
        let offset = 9 * 1024 * 1024 * 1024u64;
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 128 * 1024, max_size_bytes: Some(128 * 1024),
            growable_to_bytes: 128 * 1024, now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_file(writer.root(), b"sparse", 0o600, Content::SparseDeferred {
            id: 1, len: offset + 8192, blocks: &[0, (offset / 4096) as u32],
        }).unwrap();
        let body = writer.finish().unwrap().to_vec(&BaseContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let handle = open(b"/sparse", O_RDWR, 0, 0, 0).unwrap();
        let free = statfs(b"/").unwrap().f_bfree;
        let before = fstat(handle).unwrap();
        let durable = storage.0.lock().clone();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            let mut unavailable = |request, bytes: &mut [u8]| match request {
                ByteReq::Image { .. } => Err(error),
                other => source(other, bytes),
            };
            assert_eq!(write(handle, offset as i64, &[9; 4096], &mut unavailable), Err(error));
            assert_eq!(write(handle, (offset - 4096) as i64, &[9; 4096], &mut unavailable), Err(error));
            assert_eq!(truncate_handle(handle, (offset + 13) as i64, &mut unavailable), Err(error));
            let unchanged = fstat(handle).unwrap();
            assert_eq!(unchanged.st_size, before.st_size);
            assert_eq!(unchanged.st_mtime_sec, before.st_mtime_sec);
            assert_eq!(unchanged.st_mtime_nsec, before.st_mtime_nsec);
            assert_eq!(unchanged.st_ctime_sec, before.st_ctime_sec);
            assert_eq!(unchanged.st_ctime_nsec, before.st_ctime_nsec);
            assert_eq!(statfs(b"/").unwrap().f_bfree, free);
            assert_eq!(*storage.0.lock(), durable);
        }
        let mut bytes = [0; 32];
        assert_eq!(read(handle, offset as i64, &mut bytes, &mut source), Ok(bytes.len()));
        assert_eq!(bytes, [7; 32]);
        assert_eq!(write(handle, offset as i64, &[9; 4096], &mut source), Ok(4096));
        assert_eq!(statfs(b"/").unwrap().f_bfree, free);
        truncate_handle(handle, (offset + 13) as i64, &mut source).unwrap();
        assert_eq!(read(handle, offset as i64, &mut bytes, &mut source), Ok(13));
        assert_eq!(&bytes[..13], &[9; 13]);
        truncate_handle(handle, (offset - 4096 + 13) as i64, &mut source).unwrap();
        assert_eq!(statfs(b"/").unwrap().f_bfree, free + 4);
        assert_persistent_cached_usage();
        sync_persistence().unwrap();
        release_handle(handle);
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        assert_eq!(lstat(b"/sparse").unwrap().st_size, offset - 4096 + 13);
        assert_eq!(statfs(b"/").unwrap().f_bfree, free + 4);
        let handle = open(b"/sparse", O_RDWR, 0, 0, 0).unwrap();
        let mut unavailable = |_, _: &mut [u8]| Err(Errno::EIO);
        truncate_handle(handle, 0, &mut unavailable).unwrap();
        truncate_handle(handle, (offset + 8192) as i64, &mut unavailable).unwrap();
        assert_eq!(write(handle, offset as i64, &[8; 4096], &mut unavailable), Ok(4096));
        assert_eq!(read(handle, offset as i64, &mut bytes, &mut unavailable), Ok(bytes.len()));
        assert_eq!(bytes, [8; 32]);
        assert_eq!(read(handle, 0, &mut bytes, &mut unavailable), Ok(bytes.len()));
        assert_eq!(bytes, [0; 32]);
        assert_eq!(statfs(b"/").unwrap().f_bfree, free + 1);
        sync_persistence().unwrap();
        release_handle(handle);
    }

    #[test]
    fn sparse_base_file_survives_journal_mutations_and_snapshot() {
        use crate::kandelo_image_write::{
            Content, ContentSource, KandeloImageConfig, KandeloImageWriter,
        };

        struct BaseContent;

        impl ContentSource for BaseContent {
            fn read_exact_at(&self, _id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                dst.fill(if offset == 0 { b'A' } else { b'T' });
                Ok(())
            }
        }

        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(128 * 1024)).unwrap();
        writer.declare_deferred_section().unwrap();
        let size = 512 * 1024 * 1024u64 + 1;
        let middle = 400 * 1024 * 1024u64;
        let blocks = [0, (middle / 4096) as u32, (size / 4096) as u32];
        writer
            .create_file(
                writer.root(),
                b"base-sparse",
                0o644,
                Content::SparseDeferred {
                    id: 1,
                    len: size,
                    blocks: &blocks,
                },
            )
            .unwrap();
        let body = writer.finish().unwrap().to_vec(&BaseContent).unwrap();
        let image = crate::vfsi_container::wrap(
            &body,
            &crate::vfsi_container::ContainerSections {
                lazy_json: b"",
                archive_json: None,
                metadata_json: None,
                kernel_lazy: None,
            },
        )
        .unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let unmodified = drain_container(4096, &mut source);
        assert!(unmodified.len() < 64 * 1024 * 1024);
        let body = crate::kandelo_image_fs::unwrap_vfsi(&unmodified).unwrap();
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(body).unwrap();
        let inode = filesystem.resolve(b"/base-sparse", true).unwrap();
        assert_eq!(filesystem.allocated_file_blocks(inode), Ok(blocks.to_vec()));
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        let handle = open(b"/base-sparse", O_RDWR, 0, 0, 0).unwrap();
        let offset = 20 * 4096 + 3;
        assert_eq!(write(handle, offset, b"X", &mut source), Ok(1));
        truncate_handle(handle, 256 * 1024 * 1024, &mut source).unwrap();
        truncate_handle(handle, size as i64, &mut source).unwrap();
        assert_eq!(write(handle, (size - 1) as i64, b"Z", &mut source), Ok(1));
        sync_persistence().unwrap();
        release_handle(handle);

        let exported = drain_container(4096, &mut source);
        assert!(exported.len() < 64 * 1024 * 1024);
        reset();
        let mut snapshot_source = image_host(&exported);
        load_image(exported.len() as u64, &mut snapshot_source).unwrap();
        let handle = open(b"/base-sparse", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, size);
        for (position, expected) in [
            (0, b'A'),
            (offset as i64, b'X'),
            (middle as i64, 0),
            ((size - 1) as i64, b'Z'),
        ] {
            let mut byte = [0];
            assert_eq!(read(handle, position, &mut byte, &mut snapshot_source), Ok(1));
            assert_eq!(byte[0], expected);
        }
        release_handle(handle);
    }

    #[test]
    fn dense_base_extension_and_reextension_export_without_filling_holes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        let size = 512 * 1024 * 1024i64 + 11;
        let hello = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(hello, size, &mut source).unwrap();
        assert_eq!(write(hello, size - 1, b"H", &mut source), Ok(1));
        release_handle(hello);
        let big = open(b"/big.txt", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(big, 0, &mut source).unwrap();
        truncate_handle(big, size, &mut source).unwrap();
        assert_eq!(write(big, size - 1, b"B", &mut source), Ok(1));
        release_handle(big);
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            digest,
            checkpoint_end,
            &mut source,
        )
        .unwrap();

        let exported = drain_container(4096, &mut source);
        assert!(exported.len() < 64 * 1024 * 1024);
        reset();
        let mut snapshot_source = image_host(&exported);
        load_image(exported.len() as u64, &mut snapshot_source).unwrap();
        for (path, head, tail) in [
            (b"/hello.txt".as_slice(), b'h', b'H'),
            (b"/big.txt".as_slice(), 0, b'B'),
        ] {
            let handle = open(path, O_RDONLY, 0, 0, 0).unwrap();
            assert_eq!(fstat(handle).unwrap().st_size, size as u64);
            for (position, expected) in [(0, head), (256 * 1024 * 1024, 0), (size - 1, tail)] {
                let mut byte = [1];
                assert_eq!(read(handle, position, &mut byte, &mut snapshot_source), Ok(1));
                assert_eq!(byte[0], expected);
            }
            release_handle(handle);
        }
    }

    #[test]
    fn exported_large_dense_image_round_trips_through_v2_container() {
        use crate::kandelo_image_write::{
            Content, ContentSource, KandeloImageConfig, KandeloImageWriter,
        };

        struct Pattern;

        impl ContentSource for Pattern {
            fn read_exact_at(&self, _id: u64, offset: u64, dst: &mut [u8]) -> Result<(), Errno> {
                for (index, byte) in dst.iter_mut().enumerate() {
                    *byte = ((offset + index as u64) % 251) as u8;
                }
                Ok(())
            }
        }

        let _guard = TestGuard::acquire();
        let file_size = (1u64 << 32) - 16 * 1024 * 1024;
        let image_size = (1u64 << 32) + 64 * 1024 * 1024;
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig {
            size_bytes: image_size,
            max_size_bytes: Some(image_size),
            growable_to_bytes: image_size,
            now_ms: wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS,
        })
        .unwrap();
        writer.declare_deferred_section().unwrap();
        writer
            .create_file(
                writer.root(),
                b"large",
                0o644,
                Content::Deferred {
                    id: 1,
                    len: file_size,
                },
            )
            .unwrap();
        let body = writer.finish().unwrap();
        assert!(body.len() > u32::MAX as u64);
        assert!(body.resident_bytes() < 128 * 1024 * 1024);
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        let header = crate::vfsi_container::header_for_body(body.len(), sections.flags()).unwrap();
        let trailer = crate::vfsi_container::trailer(&sections).unwrap();
        let container_len = header.len() as u64 + body.len() + trailer.len() as u64;
        let mut source = |request: ByteReq, out: &mut [u8]| match request {
            ByteReq::Image { offset } if offset < header.len() as u64 => {
                let start = offset as usize;
                let count = out.len().min(header.len() - start);
                out[..count].copy_from_slice(&header[start..start + count]);
                Ok(count)
            }
            ByteReq::Image { offset } if offset < header.len() as u64 + body.len() => {
                body.read_at(&Pattern, offset - header.len() as u64, out)
            }
            ByteReq::Image { offset } if offset < container_len => {
                let start = (offset - header.len() as u64 - body.len()) as usize;
                let count = out.len().min(trailer.len() - start);
                out[..count].copy_from_slice(&trailer[start..start + count]);
                Ok(count)
            }
            ByteReq::Image { .. } => Ok(0),
            _ => Err(Errno::ENOSYS),
        };
        load_image(container_len, &mut source).unwrap();
        let handle = open(b"/large", O_RDONLY, 0, 0, 0).unwrap();
        let mut byte = [0];
        assert_eq!(read(handle, file_size as i64 - 1, &mut byte, &mut source), Ok(1));
        assert_eq!(byte[0], ((file_size - 1) % 251) as u8);
        release_handle(handle);
        let digest = [42; 32];
        enable_resizable_persistence(
            Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new())))),
            digest,
            &mut source,
        )
        .unwrap();
        let handle = open(b"/large", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(handle, (file_size + 1) as i64, &mut source).unwrap();
        release_handle(handle);
        sync_persistence().unwrap();
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;
        reset();
        load_image(container_len, &mut source).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            digest,
            checkpoint_end,
            &mut source,
        )
        .unwrap();

        let mut exported_header = [0; 24];
        assert_eq!(export_container_read(0, &mut exported_header, &mut source), Ok(24));
        assert_eq!(u32::from_le_bytes(exported_header[4..8].try_into().unwrap()), 2);
        let exported_body_len = u64::from_le_bytes(exported_header[16..24].try_into().unwrap());
        assert!(exported_body_len > u32::MAX as u64);
        let export_resident =
            IMAGE_EXPORT_CACHE.with(|slot| slot.as_ref().unwrap().image.resident_bytes());
        assert!(export_resident < 128 * 1024 * 1024);
        let mut boundary = [0; 4096];
        assert_eq!(
            export_container_read(1i64 << 32, &mut boundary, &mut source),
            Ok(boundary.len())
        );
        let mut exported_trailer = [0; 4];
        assert_eq!(
            export_container_read(
                (24 + exported_body_len) as i64,
                &mut exported_trailer,
                &mut source,
            ),
            Ok(4)
        );
        assert_eq!(exported_trailer, [0; 4]);

        let exported = HostImageSource {
            byte_source: core::cell::RefCell::new(|request: ByteReq, out: &mut [u8]| {
                match request {
                    ByteReq::Image { offset } => {
                        export_container_read(offset as i64, out, &mut source)
                    }
                    _ => Err(Errno::ENOSYS),
                }
            }),
            len: 24 + exported_body_len + 4,
        };
        let (body_offset, body_len) =
            crate::kandelo_image_fs::kandelo_image_span(&exported).unwrap();
        assert_eq!((body_offset, body_len), (24, exported_body_len));
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(SubSource {
            inner: &exported,
            offset: body_offset,
            len: body_len,
        })
        .unwrap();
        let inode = filesystem.resolve(b"/large", true).unwrap();
        assert_eq!(filesystem.stat_ino(inode).unwrap().size, file_size + 1);
        assert_eq!(filesystem.read_at(inode, file_size - 1, &mut byte), Ok(1));
        assert_eq!(byte[0], ((file_size - 1) % 251) as u8);
        assert_eq!(filesystem.read_at(inode, file_size, &mut byte), Ok(1));
        assert_eq!(byte[0], 0);
    }

    #[test]
    fn persistent_file_size_limit_rejects_uncheckpointable_growth() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/large", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let mut export_chunk = [0; 4096];
        assert!(export_container_read(0, &mut export_chunk, &mut image_bytes).unwrap() > 0);
        let offset = crate::kandelo_image_write::MAX_FILE_BYTES as i64;
        let journal_length = storage.0.lock().len();
        assert_eq!(write(handle, offset, b"x", &mut image_bytes), Err(Errno::EFBIG));
        assert_eq!(truncate_handle(handle, offset + 1, &mut image_bytes), Err(Errno::EFBIG));
        assert_eq!(fstat(handle).unwrap().st_size, 0);
        assert_eq!(storage.0.lock().len(), journal_length);
        assert_eq!(write(handle, offset - 1, b"xyz", &mut image_bytes), Ok(1));
        assert_eq!(fstat(handle).unwrap().st_size, offset as u64);
        assert_eq!(write(handle, offset, b"", &mut image_bytes), Ok(0));
        sync_persistence().unwrap();
        release_handle(handle);

        let checkpoint = drain_container(4096, &mut image_bytes);
        let filesystem = crate::kandelo_image_fs::KandeloImageFs::mount(
            crate::kandelo_image_fs::unwrap_vfsi(&checkpoint).unwrap(),
        ).unwrap();
        let inode = filesystem.resolve(b"/large", true).unwrap();
        assert_eq!(filesystem.stat_ino(inode).unwrap().size, offset as u64);
        let mut byte = [0];
        assert_eq!(filesystem.read_at(inode, offset as u64 - 1, &mut byte), Ok(1));
        assert_eq!(byte, *b"x");

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/large", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, offset as u64);
        assert_eq!(read(handle, offset - 1, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, *b"x");
        release_handle(handle);
    }

    #[test]
    fn sparse_four_gib_file_exports_and_reopens_without_materializing_its_hole() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/large", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(write(handle, u32::MAX as i64, b"x", &mut image_bytes), Ok(1));
        release_handle(handle);

        let mut head = [0u8; 24];
        assert_eq!(export_container_read(0, &mut head, &mut image_bytes), Ok(16));
        assert_eq!(u32::from_le_bytes(head[4..8].try_into().unwrap()), 1);
        let body_len = u32::from_le_bytes(head[12..16].try_into().unwrap());
        assert!(body_len < 64 * 1024 * 1024, "snapshot body used {body_len} bytes");
        let resident = IMAGE_EXPORT_CACHE.with(|slot| slot.as_ref().unwrap().image.resident_bytes());
        assert!(resident < 32 * 1024 * 1024, "snapshot metadata used {resident} bytes");
        let exported = drain_container(4096, &mut image_bytes);
        reset();
        let mut exported_bytes = image_host(&exported);
        load_image(exported.len() as u64, &mut exported_bytes).unwrap();
        let handle = open(b"/large", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, u32::MAX as u64 + 1);
        let mut bytes = [1u8; 2];
        assert_eq!(read(handle, u32::MAX as i64 - 1, &mut bytes, &mut exported_bytes), Ok(2));
        assert_eq!(bytes, [0, b'x']);
        release_handle(handle);
    }

    #[test]
    fn sparse_nine_gib_file_exports_and_reopens_across_triple_indirect_branches() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/large", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let offset = 9 * 1024 * 1024 * 1024i64 + 7;
        assert_eq!(write(handle, offset, b"TAIL", &mut image_bytes), Ok(4));
        sync_persistence().unwrap();
        release_handle(handle);

        let mut head = [0u8; 16];
        assert_eq!(
            export_container_read(0, &mut head, &mut image_bytes),
            Ok(16)
        );
        assert!(u32::from_le_bytes(head[12..16].try_into().unwrap()) < 64 * 1024 * 1024);
        let resident = IMAGE_EXPORT_CACHE.with(|slot| slot.as_ref().unwrap().image.resident_bytes());
        assert!(
            resident < 32 * 1024 * 1024,
            "snapshot metadata used {resident} bytes"
        );
        let exported = drain_container(4096, &mut image_bytes);
        assert!(exported.len() < 64 * 1024 * 1024);
        assert_eq!(
            u32::from_le_bytes(exported[20..24].try_into().unwrap()),
            crate::kandelo_image_fs::KANDELO_IMAGE_EXTENDED_VERSION
        );

        reset();
        let mut exported_bytes = image_host(&exported);
        load_image(exported.len() as u64, &mut exported_bytes).unwrap();
        let handle = open(b"/large", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, offset as u64 + 4);
        let mut bytes = [1u8; 6];
        assert_eq!(
            read(handle, offset - 2, &mut bytes, &mut exported_bytes),
            Ok(6)
        );
        assert_eq!(&bytes, b"\0\0TAIL");
        release_handle(handle);
    }

    #[test]
    fn indexed_sparse_file_exports_only_its_live_blocks() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/indexed-sparse", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let offset = 9 * 1024 * 1024 * 1024i64 + 7;
        assert_eq!(write(handle, offset, b"TAIL", &mut image_bytes), Ok(4));
        sync_persistence().unwrap();
        release_handle(handle);
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        let exported = drain_container(4096, &mut image_bytes);
        assert!(exported.len() < 64 * 1024 * 1024);
        assert_eq!(
            u32::from_le_bytes(exported[20..24].try_into().unwrap()),
            crate::kandelo_image_fs::KANDELO_IMAGE_EXTENDED_VERSION
        );
        reset();
        let mut exported_bytes = image_host(&exported);
        load_image(exported.len() as u64, &mut exported_bytes).unwrap();
        let handle = open(b"/indexed-sparse", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, offset as u64 + 4);
        let mut bytes = [1u8; 6];
        assert_eq!(read(handle, offset - 2, &mut bytes, &mut exported_bytes), Ok(6));
        assert_eq!(&bytes, b"\0\0TAIL");
        release_handle(handle);
    }

    #[test]
    fn prepared_compaction_refuses_intervening_write_without_switching_source() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();

        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 6, b"KIFS", &mut image_bytes).unwrap(), 4);
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        assert_eq!(write(handle, 6, b"live", &mut image_bytes).unwrap(), 4);
        assert_eq!(activate_persistence_compaction(), Err(Errno::EBUSY));
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let mut changed = [0u8; 16];
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello live\n");
        release_handle(handle);
    }

    #[test]
    fn journal_cache_reservation_failure_precedes_new_journal_header_writes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for failure_after in 0..4 {
            load_image(image.len() as u64, &mut source).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let tree = export_tree();
            let usage = metadata_budget_usage().0;
            let fault = crate::persistent_overlay::fail_cache_after(failure_after);
            let result = enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source);
            drop(fault);
            assert_eq!(result, Err(Errno::ENOMEM));
            assert!(persistence_recovery_is_pristine());
            assert!(storage.0.lock().is_empty());
            assert_eq!(export_tree(), tree);
            assert_eq!(metadata_budget_usage().0, usage);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            assert!(!fixed_persistence_enabled());
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            assert_eq!(storage.0.lock().len(), 72);
        }
    }

    #[test]
    fn journal_node_recovery_failure_preserves_plain_and_indexed_storage() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            let handle = open(b"/journal-node-recovery", O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
            assert_eq!(write(handle, 0, b"old", &mut source), Ok(3));
            sync_persistence().unwrap();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let checkpoint_end = compacted.0.lock().len() as u64;
            assert_eq!(write(handle, 0, b"later", &mut source), Ok(5));
            sync_persistence().unwrap();
            release_handle(handle);
            let storage = if indexed { compacted } else { storage };
            let bytes = storage.0.lock().clone();
            let index_bytes = index.0.lock().clone();
            load_image(image.len() as u64, &mut source).unwrap();
            let tree = export_tree();
            let usage = metadata_budget_usage().0;
            let enable = |source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>| {
                if indexed {
                    enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index.clone()),
                        digest, checkpoint_end, source)
                } else { enable_resizable_persistence(Box::new(storage.clone()), digest, source) }
            };
            crate::prepared_map::fail_after_allocations(0);
            assert_eq!(enable(&mut source), Err(Errno::ENOMEM));
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(*index.0.lock(), index_bytes);
            assert_eq!(metadata_budget_usage().0, usage);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            assert!(!fixed_persistence_enabled());
            enable(&mut source).unwrap();
            let handle = open(b"/journal-node-recovery", O_RDONLY, 0, 0, 0).unwrap();
            let mut actual = [0; 5];
            assert_eq!(read(handle, 0, &mut actual, &mut source), Ok(5));
            assert_eq!(&actual, b"later");
            release_handle(handle);
        }
    }

    #[test]
    fn directory_node_recovery_allocation_failure_leaves_plain_and_indexed_base_unchanged() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            rename(b"/hello.txt", b"/allocation-recovered").unwrap();
            sync_persistence().unwrap();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let storage = if indexed { compacted } else { storage };
            let bytes = storage.0.lock().clone();
            load_image(image.len() as u64, &mut source).unwrap();
            let tree = export_tree();
            let usage = metadata_budget_usage().0;
            let enable = |source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>| {
                if indexed {
                    enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index.clone()),
                        digest, bytes.len() as u64, source)
                } else { enable_resizable_persistence(Box::new(storage.clone()), digest, source) }
            };
            crate::directory_entries::fail_next_node_allocation();
            assert_eq!(enable(&mut source), Err(Errno::ENOMEM));
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(metadata_budget_usage().0, usage);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            assert!(!fixed_persistence_enabled());
            enable(&mut source).unwrap();
            assert!(lstat(b"/allocation-recovered").is_ok());
            assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
            assert_eq!(*storage.0.lock(), bytes);
        }
    }

    #[test]
    fn retained_base_dirent_admission_precedes_commit_and_recovery_publication() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for indexed in [false, true] {
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let compacted = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            load_image(image.len() as u64, &mut source).unwrap();
            let failing = Arc::new(AtomicBool::new(false));
            enable_resizable_persistence(Box::new(FailingCreateStorage {
                inner: storage.clone(), fail_writes: failing.clone(),
            }), digest, &mut source).unwrap();
            let tree = export_tree();
            let usage = metadata_budget_usage().0;
            let bytes = storage.0.lock().clone();
            set_metadata_budget_bytes(usage).unwrap();
            failing.store(true, Ordering::SeqCst);
            assert_eq!(unlink(b"/hello.txt"), Err(Errno::ENOSPC));
            assert_eq!(export_tree(), tree);
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(metadata_budget_usage(), (usage, usage));
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);

            failing.store(false, Ordering::SeqCst);
            load_image(image.len() as u64, &mut source).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
            unlink(b"/hello.txt").unwrap();
            assert!(metadata_budget_usage().0 < usage);
            sync_persistence().unwrap();
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            if indexed {
                prepare_persistence_compaction(Box::new(compacted.clone())).unwrap();
                checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
                activate_persistence_compaction().unwrap();
            }
            let storage = if indexed { compacted } else { storage };
            let bytes = storage.0.lock().clone();
            load_image(image.len() as u64, &mut source).unwrap();
            let base = export_tree();
            let usage = metadata_budget_usage().0;
            set_metadata_budget_bytes(usage).unwrap();
            let enable = |source: &mut dyn FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>| {
                if indexed {
                    enable_resizable_persistence_indexed(Box::new(storage.clone()), Box::new(index.clone()),
                        digest, bytes.len() as u64, source)
                } else { enable_resizable_persistence(Box::new(storage.clone()), digest, source) }
            };
            assert_eq!(enable(&mut source), Err(Errno::ENOMEM));
            assert_eq!(export_tree(), base);
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(metadata_budget_usage(), (usage, usage));
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            assert!(!fixed_persistence_enabled());
            set_metadata_budget_bytes(crate::metadata_budget::DEFAULT_ROOTFS_METADATA_BYTES).unwrap();
            enable(&mut source).unwrap();
            assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
            assert_eq!(*storage.0.lock(), bytes);
            reset();
            assert_eq!(metadata_budget_usage().0, 0);
        }
    }

    #[test]
    fn failed_compaction_activation_keeps_the_active_mount() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();

        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"live", &mut image_bytes), Ok(4));
        rename(b"/hello.txt", b"/moved").unwrap();
        sync_persistence().unwrap();
        let base_dirents = PERSISTENT_ROOTFS
            .lock()
            .as_ref()
            .unwrap()
            .base_dirents
            .keys();
        assert!(!base_dirents.is_empty());
        prepare_persistence_compaction(Box::new(target)).unwrap();
        checkpoint_prepared_persistence(Box::new(index)).unwrap();
        let ino = fstat(handle).unwrap().st_ino;
        PREPARED_PERSISTENCE
            .lock()
            .as_mut()
            .unwrap()
            .journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileSize(ino),
                value: 11u64.to_le_bytes().to_vec(),
            }])
            .unwrap();
        assert_eq!(activate_persistence_compaction(), Err(Errno::EBUSY));
        assert!(PERSISTENT_ROOTFS.lock().is_some());
        assert_eq!(
            PERSISTENT_ROOTFS.lock().as_ref().unwrap().base_dirents.keys(),
            base_dirents
        );
        cancel_persistence_compaction();
        assert_eq!(write(handle, 0, b"safe", &mut image_bytes), Ok(4));
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        let handle = open(b"/moved", O_RDONLY, 0, 0, 0).unwrap();
        let mut changed = [0u8; 16];
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"safeo sffs\n");
        release_handle(handle);
    }

    #[test]
    fn indexed_fixed_persistence_replays_only_the_tail_after_checkpoint() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();

        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 6, b"KIFS", &mut image_bytes).unwrap(), 4);
        sync_persistence().unwrap();
        let checkpoint_end = source.0.lock().len() as u64;
        PERSISTENT_ROOTFS
            .lock()
            .as_mut()
            .unwrap()
            .journal
            .checkpoint_fixed_blocks_into(index.clone())
            .unwrap();
        let prefix_digest: [u8; 32] =
            Sha256::digest(&source.0.lock()[..checkpoint_end as usize]).into();
        crate::persistent_overlay_index::BlockCheckpoint::open(
            index.clone(),
            base_digest,
            prefix_digest,
            checkpoint_end,
        )
        .unwrap();
        assert_eq!(write(handle, 6, b"live", &mut image_bytes).unwrap(), 4);
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence_indexed(
            Box::new(source),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let mut changed = [0u8; 16];
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello live\n");
        release_handle(handle);
    }

    #[test]
    fn resizable_persistence_reopens_sparse_growth_and_truncate() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(
            write(handle, i64::MAX - 1, b"overflow", &mut image_bytes),
            Err(Errno::EFBIG)
        );
        let far_offset = 8 * 1024 * 1024 * 1024i64 + 7;
        assert_eq!(write(handle, far_offset, b"hello", &mut image_bytes), Ok(5));
        assert_eq!(fstat(handle).unwrap().st_size, (far_offset + 5) as u64);
        assert_eq!(size(handle), Ok(far_offset + 5));
        let mut visible = [0; 8];
        assert_eq!(
            read(handle, far_offset - 3, &mut visible, &mut image_bytes),
            Ok(8)
        );
        assert_eq!(&visible, b"\0\0\0hello");
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_size, (far_offset + 5) as u64);
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(truncate_handle(handle, 6, &mut image_bytes), Ok(()));
        assert_eq!(fstat(handle).unwrap().st_size, 6);
        assert_eq!(size(handle), Ok(6));
        assert_eq!(
            read(handle, 0, &mut visible, &mut image_bytes),
            Ok(6)
        );
        assert_eq!(&visible[..6], b"hello ");
        assert_eq!(truncate_handle(handle, far_offset + 5, &mut image_bytes), Ok(()));
        assert_eq!(
            read(handle, far_offset + 4, &mut visible, &mut image_bytes),
            Ok(1)
        );
        assert_eq!(visible[0], 0);
        sync_persistence().unwrap();
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        release_handle(handle);

        let checkpoint_end = target.0.lock().len() as u64;
        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        assert_eq!(
            enable_fixed_persistence_indexed(
                Box::new(target.clone()),
                Box::new(index.clone()),
                base_digest,
                checkpoint_end,
                &mut image_bytes,
            ),
            Err(Errno::EIO)
        );
        enable_resizable_persistence_indexed(
            Box::new(target.clone()),
            Box::new(index.clone()),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_size, (far_offset + 5) as u64);
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(
            read(handle, far_offset + 4, &mut visible, &mut image_bytes),
            Ok(1)
        );
        assert_eq!(visible[0], 0);
        release_handle(handle);
        let handle = open(b"/hello.txt", O_RDWR | O_TRUNC, 0, 0, 0).unwrap();
        assert_eq!(fstat(handle).unwrap().st_size, 0);
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_size, 0);
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(handle, 8, &mut image_bytes).unwrap();
        assert_eq!(read(handle, 0, &mut visible, &mut image_bytes), Ok(8));
        assert_eq!(visible, [0; 8]);
        release_handle(handle);
    }

    #[test]
    fn resizable_persistence_replays_rename_and_unlink_after_indexed_compaction() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        link(b"/hello.txt", b"/alias").unwrap();
        rename(b"/hello.txt", b"/moved").unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/moved").unwrap().st_nlink, 2);
        assert_eq!(lstat(b"/alias").unwrap().st_ino, lstat(b"/moved").unwrap().st_ino);
        let mut bytes = [0; 11];
        assert_eq!(read(handle, 0, &mut bytes, &mut image_bytes), Ok(11));
        assert_eq!(&bytes, b"hello sffs\n");
        release_handle(handle);
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target.clone()),
            Box::new(index.clone()),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/alias").unwrap().st_nlink, 2);
        let handle = open(b"/moved", O_RDONLY, 0, 0, 0).unwrap();
        unlink(b"/moved").unwrap();
        assert!(matches!(lstat(b"/moved"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/alias").unwrap().st_nlink, 1);
        assert_eq!(read(handle, 0, &mut bytes, &mut image_bytes), Ok(11));
        release_handle(handle);
        sync_persistence().unwrap();

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/moved"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/alias").unwrap().st_nlink, 1);
    }

    #[test]
    fn resizable_persistence_reopens_created_sparse_regular_file() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/created", O_CREAT | O_RDWR, 0o640, 7, 8).unwrap();
        let offset = 8 * 1024 * 1024 * 1024i64 + 7;
        assert_eq!(write(handle, offset, b"DATA", &mut image_bytes), Ok(4));
        assert_eq!(size(handle), Ok(offset + 4));
        let stat = fstat(handle).unwrap();
        assert_eq!(stat.st_size, (offset + 4) as u64);
        assert_eq!(stat.st_mode & 0o7777, 0o640);
        assert_eq!((stat.st_uid, stat.st_gid), (7, 8));
        let setid_handle = open(b"/setid", O_CREAT | O_RDWR, 0o6755, 7, 8).unwrap();
        assert_eq!(fstat(setid_handle).unwrap().st_mode & 0o6000, 0);
        release_handle(setid_handle);
        sync_persistence().unwrap();
        release_handle(handle);
        assert!(storage.0.lock().len() < 10_000);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/setid").unwrap().st_mode & 0o6000, 0);
        let handle = open(b"/created", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(size(handle), Ok(offset + 4));
        let mut bytes = [0; 4];
        assert_eq!(read(handle, offset, &mut bytes, &mut image_bytes), Ok(4));
        assert_eq!(&bytes, b"DATA");
        truncate_handle(handle, 2, &mut image_bytes).unwrap();
        sync_persistence().unwrap();
        release_handle(handle);

        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;
        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(target),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        assert_eq!(lstat(b"/created").unwrap().st_size, 2);
        let handle = open(b"/created", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(read(handle, 0, &mut bytes, &mut image_bytes), Ok(2));
        assert_eq!(&bytes[..2], b"\0\0");
        release_handle(handle);
    }

    #[test]
    fn failed_persistent_create_does_not_publish_an_inode_or_name() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let fail_writes = Arc::new(AtomicBool::new(false));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(
            Box::new(FailingCreateStorage {
                inner: storage.clone(),
                fail_writes: fail_writes.clone(),
            }),
            base_digest,
            &mut image_bytes,
        )
        .unwrap();
        let next_ino = ROOTFS.with(|state| state.next_ino);
        let root_before = lstat(b"/").unwrap();
        fail_writes.store(true, Ordering::SeqCst);
        assert_eq!(
            open(b"/not-created", O_CREAT | O_RDWR, 0o644, 0, 0),
            Err(Errno::ENOSPC)
        );
        assert!(matches!(lstat(b"/not-created"), Err(Errno::ENOENT)));
        assert_eq!(ROOTFS.with(|state| state.next_ino), next_ino);
        let root_after = lstat(b"/").unwrap();
        assert_eq!((root_after.st_mtime_sec, root_after.st_mtime_nsec), (root_before.st_mtime_sec, root_before.st_mtime_nsec));
        assert_eq!((root_after.st_ctime_sec, root_after.st_ctime_nsec), (root_before.st_ctime_sec, root_before.st_ctime_nsec));

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        assert!(matches!(lstat(b"/not-created"), Err(Errno::ENOENT)));
        let root_reopened = lstat(b"/").unwrap();
        assert_eq!((root_reopened.st_mtime_sec, root_reopened.st_mtime_nsec), (root_before.st_mtime_sec, root_before.st_mtime_nsec));
    }

    #[test]
    fn failed_persistent_namespace_changes_leave_live_and_reopened_names_intact() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let mut image_bytes = image_host(&image);
        for operation in ["rename", "rename-over", "unlink", "link"] {
            reset();
            load_image(image.len() as u64, &mut image_bytes).unwrap();
            let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
            let fail_writes = Arc::new(AtomicBool::new(false));
            enable_resizable_persistence(
                Box::new(FailingCreateStorage {
                    inner: storage.clone(),
                    fail_writes: fail_writes.clone(),
                }),
                base_digest,
                &mut image_bytes,
            )
            .unwrap();
            let root_before = lstat(b"/").unwrap();
            let file_before = lstat(b"/hello.txt").unwrap();
            let replacement_before = lstat(b"/big.txt").unwrap();
            fail_writes.store(true, Ordering::SeqCst);
            let result = match operation {
                "rename" => rename(b"/hello.txt", b"/moved"),
                "rename-over" => rename(b"/hello.txt", b"/big.txt"),
                "unlink" => unlink(b"/hello.txt"),
                _ => link(b"/hello.txt", b"/linked"),
            };
            assert_eq!(result, Err(Errno::ENOSPC), "{operation}");
            for reopened in [false, true] {
                if reopened {
                    reset();
                    load_image(image.len() as u64, &mut image_bytes).unwrap();
                    enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
                }
                let root_after = lstat(b"/").unwrap();
                let file_after = lstat(b"/hello.txt").unwrap();
                assert_eq!(file_after.st_ino, file_before.st_ino, "{operation}");
                assert_eq!(file_after.st_nlink, file_before.st_nlink, "{operation}");
                assert_eq!(lstat(b"/big.txt").unwrap().st_ino, replacement_before.st_ino, "{operation}");
                assert_eq!(root_after.st_mtime_sec, root_before.st_mtime_sec, "{operation}");
                assert_eq!(root_after.st_mtime_nsec, root_before.st_mtime_nsec, "{operation}");
                assert!(matches!(lstat(b"/moved"), Err(Errno::ENOENT)), "{operation}");
                assert!(matches!(lstat(b"/linked"), Err(Errno::ENOENT)), "{operation}");
            }
        }
    }

    #[test]
    fn resizable_persistence_replays_namespace_timestamps() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let reopen = || {
            reset();
            load_image(image.len() as u64, image_host(&image)).unwrap();
            enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_host(&image)).unwrap();
        };
        let times = |path: &[u8]| {
            let stat = lstat(path).unwrap();
            (stat.st_mtime_sec, stat.st_mtime_nsec, stat.st_ctime_sec, stat.st_ctime_nsec)
        };
        reopen();
        utimensat(b"/", 10, 1, 11, 2, 12, 3).unwrap();

        set_now(2_000, 1);
        mkdir(b"/a", 0o755, 0, 0).unwrap();
        assert_eq!(times(b"/"), (2_000, 1, 2_000, 1));
        reopen();
        assert_eq!(times(b"/"), (2_000, 1, 2_000, 1));

        set_now(2_001, 2);
        let handle = open(b"/a/file", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(handle);
        assert_eq!(times(b"/a"), (2_001, 2, 2_001, 2));
        reopen();
        assert_eq!(times(b"/a"), (2_001, 2, 2_001, 2));

        set_now(2_002, 3);
        link(b"/a/file", b"/alias").unwrap();
        assert_eq!(times(b"/"), (2_002, 3, 2_002, 3));
        assert_eq!(times(b"/a/file").2, 2_002);
        reopen();
        assert_eq!(times(b"/"), (2_002, 3, 2_002, 3));
        assert_eq!(times(b"/alias").2, 2_002);

        let replaced = open(b"/a/moved", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(replaced);
        link(b"/a/moved", b"/a/retained").unwrap();
        set_now(2_003, 4);
        rename(b"/alias", b"/a/moved").unwrap();
        assert_eq!(times(b"/"), (2_003, 4, 2_003, 4));
        assert_eq!(times(b"/a"), (2_003, 4, 2_003, 4));
        assert_eq!(times(b"/a/file").2, 2_003);
        assert_eq!(times(b"/a/retained").2, 2_003);
        reopen();
        assert_eq!(times(b"/"), (2_003, 4, 2_003, 4));
        assert_eq!(times(b"/a"), (2_003, 4, 2_003, 4));
        assert_eq!(times(b"/a/moved").2, 2_003);
        assert_eq!(times(b"/a/retained").2, 2_003);

        set_now(2_004, 5);
        unlink(b"/a/moved").unwrap();
        assert_eq!(times(b"/a"), (2_004, 5, 2_004, 5));
        assert_eq!(times(b"/a/file").2, 2_004);
        reopen();
        assert_eq!(times(b"/a"), (2_004, 5, 2_004, 5));
        assert_eq!(times(b"/a/file").2, 2_004);

        set_now(2_005, 6);
        symlink(b"file", b"/a/link", 0, 0).unwrap();
        assert_eq!(times(b"/a"), (2_005, 6, 2_005, 6));
        reopen();
        assert_eq!(times(b"/a"), (2_005, 6, 2_005, 6));

        set_now(2_006, 7);
        unlink(b"/a/link").unwrap();
        unlink(b"/a/retained").unwrap();
        assert_eq!(times(b"/a"), (2_006, 7, 2_006, 7));
        reopen();
        assert_eq!(times(b"/a"), (2_006, 7, 2_006, 7));

        set_now(2_007, 8);
        unlink(b"/a/file").unwrap();
        assert_eq!(times(b"/a"), (2_007, 8, 2_007, 8));
        reopen();
        assert_eq!(times(b"/a"), (2_007, 8, 2_007, 8));

        set_now(2_008, 9);
        rmdir(b"/a").unwrap();
        assert_eq!(times(b"/"), (2_008, 9, 2_008, 9));
        reopen();
        assert_eq!(times(b"/"), (2_008, 9, 2_008, 9));
        assert!(matches!(lstat(b"/a"), Err(Errno::ENOENT)));
    }

    #[test]
    fn persistent_link_keeps_the_committed_ctime_when_clock_changes_during_flush() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let change_on_flush = Arc::new(AtomicBool::new(false));
        load_image(image.len() as u64, image_host(&image)).unwrap();
        enable_resizable_persistence(
            Box::new(ClockChangingStorage {
                inner: storage.clone(),
                change_on_flush: change_on_flush.clone(),
            }),
            base_digest,
            &mut image_host(&image),
        )
        .unwrap();

        set_now(2_000, 1);
        change_on_flush.store(true, Ordering::SeqCst);
        link(b"/hello.txt", b"/alias").unwrap();
        let live = lstat(b"/hello.txt").unwrap();
        assert_eq!((live.st_ctime_sec, live.st_ctime_nsec), (2_000, 1));
        assert_eq!(live.st_nlink, 2);

        reset();
        load_image(image.len() as u64, image_host(&image)).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_host(&image)).unwrap();
        let reopened = lstat(b"/alias").unwrap();
        assert_eq!((reopened.st_ctime_sec, reopened.st_ctime_nsec), (2_000, 1));
        assert_eq!(reopened.st_nlink, 2);
    }

    #[test]
    fn resizable_timestamp_writeback_tracks_only_dirty_inodes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        let first = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        let second = open(b"/big.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(first, 0, b"A", &mut image_bytes), Ok(1));
        assert_eq!(write(second, 0, b"B", &mut image_bytes), Ok(1));
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), 2);
        chmod(b"/hello.txt", 0o600).unwrap();
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), 1);
        sync_persistence().unwrap();
        assert!(ROOTFS.with(|state| state.dirty_persistent_timestamps.is_empty()));
        release_handle(first);
        release_handle(second);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mode & 0o777, 0o600);
        let first = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let second = open(b"/big.txt", O_RDONLY, 0, 0, 0).unwrap();
        let mut byte = [0];
        assert_eq!(read(first, 0, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, [b'A']);
        assert_eq!(read(second, 0, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, [b'B']);
        release_handle(first);
        release_handle(second);
    }

    #[test]
    fn accepted_timestamp_and_data_batches_drain_at_the_ordinary_io_limit() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_with_growth_capacity(2 * 1024 * 1024);
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let mut handles = Vec::new();
        for index in 0..MAX_DIRTY_PERSISTENT_TIMESTAMPS {
            let path = alloc::format!("/bounded-{index}");
            handles.push(open(path.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap());
        }
        set_now(2_000, 3);
        for (index, handle) in handles.iter().enumerate() {
            assert_eq!(write(*handle, 0, &[index as u8], &mut source), Ok(1));
        }
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), MAX_DIRTY_PERSISTENT_TIMESTAMPS);
        let used = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _quota = crate::io_buffer::test_budget(used);
            sync_persistence().unwrap();
            assert!(ROOTFS.with(|state| state.dirty_persistent_timestamps.is_empty()));
            assert_eq!(crate::io_buffer::WRITEBACK_MEMORY.usage().0, 0);
            assert!(crate::io_buffer::IO_MEMORY.usage().0 < used);
        }
        for handle in handles { release_handle(handle); }
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        for index in 0..MAX_DIRTY_PERSISTENT_TIMESTAMPS {
            let path = alloc::format!("/bounded-{index}");
            let stat = lstat(path.as_bytes()).unwrap();
            assert_eq!((stat.st_mtime_sec, stat.st_mtime_nsec), (2_000, 3));
            let handle = open(path.as_bytes(), O_RDONLY, 0, 0, 0).unwrap();
            let mut byte = [0];
            assert_eq!(read(handle, 0, &mut byte, &mut source), Ok(1));
            assert_eq!(byte, [index as u8]);
            release_handle(handle);
        }
    }

    #[test]
    fn compaction_live_inode_scratch_refusal_leaves_target_and_namespace_unpublished() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        let before = storage.0.lock().clone();
        let inode = lstat(b"/hello.txt").unwrap().st_ino;
        let limit = ROOTFS_METADATA.usage().1;
        {
            let _pressure = ROOTFS_METADATA.reserve_temporary(2 * limit).unwrap();
            assert_eq!(prepare_persistence_compaction(Box::new(target.clone())), Err(Errno::ENOMEM));
            assert!(target.0.lock().is_empty());
            assert_eq!(*storage.0.lock(), before);
            assert_eq!(lstat(b"/hello.txt").unwrap().st_ino, inode);
            assert!(PREPARED_PERSISTENCE.lock().is_none());
            assert_eq!(ROOTFS_METADATA.temporary_usage(), 2 * limit);
        }
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        assert!(!target.0.lock().is_empty());
        assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
        cancel_persistence_compaction();
        assert_eq!(*storage.0.lock(), before);
    }

    #[test]
    fn resizable_timestamp_writeback_bounds_dirty_inodes() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_with_growth_capacity(2 * 1024 * 1024);
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        let mut handles = Vec::new();
        for index in 0..=MAX_DIRTY_PERSISTENT_TIMESTAMPS {
            let path = alloc::format!("/dirty-{index}");
            handles.push(open(path.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap());
        }
        for handle in handles.iter().take(MAX_DIRTY_PERSISTENT_TIMESTAMPS) {
            assert_eq!(write(*handle, 0, b"X", &mut image_bytes), Ok(1));
        }
        assert_eq!(
            ROOTFS.with(|state| state.dirty_persistent_timestamps.len()),
            MAX_DIRTY_PERSISTENT_TIMESTAMPS
        );
        assert_eq!(
            write(handles[MAX_DIRTY_PERSISTENT_TIMESTAMPS], 0, b"Y", &mut image_bytes),
            Ok(1)
        );
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), 1);
        sync_persistence().unwrap();
        for handle in handles.iter().take(MAX_DIRTY_PERSISTENT_TIMESTAMPS) {
            assert_eq!(truncate_handle(*handle, 2, &mut image_bytes), Ok(()));
        }
        assert_eq!(
            ROOTFS.with(|state| state.dirty_persistent_timestamps.len()),
            MAX_DIRTY_PERSISTENT_TIMESTAMPS
        );
        assert_eq!(
            truncate_handle(handles[MAX_DIRTY_PERSISTENT_TIMESTAMPS], 2, &mut image_bytes),
            Ok(())
        );
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), 1);
        sync_persistence().unwrap();
        for handle in handles {
            release_handle(handle);
        }

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        for index in 0..=MAX_DIRTY_PERSISTENT_TIMESTAMPS {
            let path = alloc::format!("/dirty-{index}");
            let handle = open(path.as_bytes(), O_RDONLY, 0, 0, 0).unwrap();
            let mut byte = [0];
            assert_eq!(lstat(path.as_bytes()).unwrap().st_size, 2);
            assert_eq!(read(handle, 0, &mut byte, &mut image_bytes), Ok(1));
            assert_eq!(
                byte[0],
                if index == MAX_DIRTY_PERSISTENT_TIMESTAMPS { b'Y' } else { b'X' }
            );
            release_handle(handle);
        }
    }

    #[test]
    fn failed_timestamp_slot_writeback_preserves_prior_dirty_data() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_with_growth_capacity(2 * 1024 * 1024);
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let fail_writes = Arc::new(AtomicBool::new(false));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(
            Box::new(FailingCreateStorage {
                inner: storage.clone(),
                fail_writes: fail_writes.clone(),
            }),
            base_digest,
            &mut image_bytes,
        ).unwrap();
        let mut handles = Vec::new();
        for index in 0..=MAX_DIRTY_PERSISTENT_TIMESTAMPS {
            let path = alloc::format!("/dirty-{index}");
            handles.push(open(path.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap());
        }
        assert_eq!(
            write(handles[MAX_DIRTY_PERSISTENT_TIMESTAMPS], 0, b"Y", &mut image_bytes),
            Ok(1)
        );
        sync_persistence().unwrap();
        for handle in handles.iter().take(MAX_DIRTY_PERSISTENT_TIMESTAMPS) {
            assert_eq!(write(*handle, 0, b"X", &mut image_bytes), Ok(1));
        }
        fail_writes.store(true, Ordering::SeqCst);
        assert_eq!(
            write(handles[MAX_DIRTY_PERSISTENT_TIMESTAMPS], 0, b"Y", &mut image_bytes),
            Err(Errno::ENOSPC)
        );
        assert_eq!(
            ROOTFS.with(|state| state.dirty_persistent_timestamps.len()),
            MAX_DIRTY_PERSISTENT_TIMESTAMPS
        );
        let mut byte = [0];
        assert_eq!(read(handles[0], 0, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, [b'X']);
        assert_eq!(open(b"/dirty-64", O_TRUNC | O_RDWR, 0, 0, 0), Err(Errno::ENOSPC));
        assert_eq!(lstat(b"/dirty-64").unwrap().st_size, 1);
        assert_eq!(
            read(handles[MAX_DIRTY_PERSISTENT_TIMESTAMPS], 0, &mut byte, &mut image_bytes),
            Ok(1)
        );
        assert_eq!(byte, [b'Y']);
        for handle in handles {
            release_handle(handle);
        }

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/dirty-0").unwrap().st_size, 0);
        assert_eq!(lstat(b"/dirty-64").unwrap().st_size, 1);
    }

    #[test]
    fn failed_timestamp_writeback_keeps_dirty_inode_and_reopens_old_data() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let fail_writes = Arc::new(AtomicBool::new(false));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(
            Box::new(FailingCreateStorage {
                inner: storage.clone(),
                fail_writes: fail_writes.clone(),
            }),
            base_digest,
            &mut image_bytes,
        ).unwrap();
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"X", &mut image_bytes), Ok(1));
        fail_writes.store(true, Ordering::SeqCst);
        assert_eq!(sync_persistence(), Err(Errno::ENOSPC));
        assert_eq!(ROOTFS.with(|state| state.dirty_persistent_timestamps.len()), 1);
        let mut byte = [0];
        assert_eq!(read(handle, 0, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, [b'X']);
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        let reopened = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        assert_eq!(read(reopened, 0, &mut byte, &mut image_bytes), Ok(1));
        assert_eq!(byte, [b'h']);
        release_handle(reopened);
    }

    #[test]
    fn resizable_compaction_reclaims_closed_orphans_but_preserves_open_handles() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let first = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let first_index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let second = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let second_index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/orphan", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        let ino = fstat(handle).unwrap().st_ino;
        let offset = 8 * 1024 * 1024 * 1024 + 7;
        assert_eq!(write(handle, offset, b"DATA", &mut image_bytes), Ok(4));
        sync_persistence().unwrap();
        unlink(b"/orphan").unwrap();

        prepare_persistence_compaction(Box::new(first.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(first_index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        assert_eq!(
            PERSISTENT_ROOTFS
                .lock()
                .as_ref()
                .unwrap()
                .journal
                .state()
                .metadata_entries()
                .count(),
            0
        );
        assert!(PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal.metadata_value(&OverlayKey::Inode(ino)).unwrap().is_some());
        let mut bytes = [0; 4];
        assert_eq!(read(handle, offset, &mut bytes, &mut image_bytes), Ok(4));
        assert_eq!(&bytes, b"DATA");
        let first_size = first.0.lock().len();
        let first_blocks = u64::from_le_bytes(first_index.0.lock()[80..88].try_into().unwrap());
        assert_eq!(first_blocks, 1);
        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(first.clone()),
            Box::new(first_index.clone()),
            base_digest,
            first_size as u64,
            &mut image_bytes,
        ).unwrap();
        assert_eq!(
            PERSISTENT_ROOTFS
                .lock()
                .as_ref()
                .unwrap()
                .journal
                .state()
                .metadata_entries()
                .count(),
            0
        );
        assert!(ROOTFS.with(|state| state.inodes.iter().flatten().all(|inode| inode.ino != ino)));

        let base = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        let base_ino = fstat(base).unwrap().st_ino;
        assert_eq!(write(base, 0, b"OLD", &mut image_bytes), Ok(3));
        sync_persistence().unwrap();
        unlink(b"/hello.txt").unwrap();
        release_handle(base);
        mkdir(b"/removed-dir", 0o755, 0, 0).unwrap();
        let removed_dir_ino = lstat(b"/removed-dir").unwrap().st_ino;
        mkdir(b"/removed-dir/nested", 0o755, 0, 0).unwrap();
        let nested_ino = lstat(b"/removed-dir/nested").unwrap().st_ino;
        rmdir(b"/removed-dir/nested").unwrap();
        rmdir(b"/removed-dir").unwrap();

        prepare_persistence_compaction(Box::new(second.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(second_index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        {
            let mut active = PERSISTENT_ROOTFS.lock();
            let journal = &mut active.as_mut().unwrap().journal;
            for orphan in [ino, base_ino, removed_dir_ino, nested_ino] {
                assert_eq!(journal.metadata_value(&OverlayKey::Inode(orphan)), Ok(None));
            }
            assert_eq!(journal.metadata_value(&OverlayKey::Dirent {
                parent: removed_dir_ino,
                name: b"nested".to_vec(),
            }), Ok(None));
        }
        assert!(second.0.lock().len() < first_size);
        let indexed_blocks = u64::from_le_bytes(second_index.0.lock()[80..88].try_into().unwrap());
        assert_eq!(indexed_blocks, 0);
        let checkpoint_end = second.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(second), Box::new(second_index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        assert!(matches!(lstat(b"/orphan"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/removed-dir"), Err(Errno::ENOENT)));
        let replacement = open(b"/replacement", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        assert_eq!(fstat(replacement).unwrap().st_size, 0);
        release_handle(replacement);
    }

    #[test]
    fn resizable_compaction_drops_transient_dirent_tombstones_but_keeps_base_deletions() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let first = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let first_index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let second = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let second_index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        rename(b"/hello.txt", b"/moved").unwrap();
        unlink(b"/moved").unwrap();
        let replacement = open(b"/replacement", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(replacement);
        rename(b"/replacement", b"/big.txt").unwrap();
        unlink(b"/big.txt").unwrap();
        for index in 0..64 {
            let path = alloc::format!("/temporary-{index}");
            let handle = open(path.as_bytes(), O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
            release_handle(handle);
            unlink(path.as_bytes()).unwrap();
        }
        prepare_persistence_compaction(Box::new(first.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(first_index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let base_key = OverlayKey::Dirent { parent: 1, name: b"hello.txt".to_vec() };
        let replaced_base_key = OverlayKey::Dirent { parent: 1, name: b"big.txt".to_vec() };
        let transient_key = OverlayKey::Dirent { parent: 1, name: b"temporary-0".to_vec() };
        {
            let mut active = PERSISTENT_ROOTFS.lock();
            let journal = &mut active.as_mut().unwrap().journal;
            assert_eq!(journal.metadata_value(&base_key), Ok(Some(None)));
            assert_eq!(journal.metadata_value(&replaced_base_key), Ok(Some(None)));
            assert_eq!(journal.metadata_value(&transient_key), Ok(None));
            assert_eq!(journal.metadata_value(&OverlayKey::Dirent { parent: 1, name: b"moved".to_vec() }), Ok(None));
        }
        let first_len = first.0.lock().len();
        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(first), Box::new(first_index), base_digest, first_len as u64,
            &mut image_bytes,
        ).unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/big.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/moved"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/temporary-0"), Err(Errno::ENOENT)));
        let handle = open(b"/temporary-next", O_CREAT | O_RDWR, 0o644, 0, 0).unwrap();
        release_handle(handle);
        unlink(b"/temporary-next").unwrap();
        prepare_persistence_compaction(Box::new(second.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(second_index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        assert_eq!(PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal.metadata_value(&base_key), Ok(Some(None)));
        assert_eq!(PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal.metadata_value(&replaced_base_key), Ok(Some(None)));
        assert_eq!(PERSISTENT_ROOTFS.lock().as_mut().unwrap().journal.metadata_value(&OverlayKey::Dirent {
            parent: 1, name: b"temporary-next".to_vec(),
        }), Ok(None));
        let second_len = second.0.lock().len();
        assert_eq!(second_len, first_len);
        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(
            Box::new(second), Box::new(second_index), base_digest, second_len as u64,
            &mut image_bytes,
        ).unwrap();
        assert!(matches!(lstat(b"/hello.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/big.txt"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/temporary-next"), Err(Errno::ENOENT)));
    }

    #[test]
    fn resizable_persistence_reopens_special_nodes_after_indexed_compaction_and_export() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        mknod_special(b"/created-fifo", 0o640, 7, 8, S_IFIFO).unwrap();
        link(b"/created-fifo", b"/fifo-alias").unwrap();
        mknod_special(b"/created-socket", 0o755, 9, 10, S_IFSOCK).unwrap();
        assert_eq!(lstat(b"/created-fifo").unwrap().st_mode, S_IFIFO | 0o640);
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(target), Box::new(index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        let fifo = lstat(b"/created-fifo").unwrap();
        assert_eq!(fifo.st_mode, S_IFIFO | 0o640);
        assert_eq!(fifo.st_nlink, 2);
        assert_eq!((fifo.st_uid, fifo.st_gid), (7, 8));
        assert_eq!(lstat(b"/fifo-alias").unwrap().st_ino, fifo.st_ino);
        assert_eq!(
            unsafe { crate::fifo::global_fifo_table() }.lookup(b"/created-fifo"),
            unsafe { crate::fifo::global_fifo_table() }.lookup(b"/fifo-alias"),
        );
        assert!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/created-fifo").is_some());
        let socket = lstat(b"/created-socket").unwrap();
        assert_eq!(socket.st_mode, S_IFSOCK | 0o755);
        assert_eq!((socket.st_uid, socket.st_gid), (9, 10));

        let snapshot = drain_container(8192, &mut image_bytes);
        reset();
        load_image(snapshot.len() as u64, image_host(&snapshot)).unwrap();
        assert_eq!(lstat(b"/created-fifo").unwrap().st_mode, S_IFIFO | 0o640);
        assert_eq!(lstat(b"/fifo-alias").unwrap().st_ino, lstat(b"/created-fifo").unwrap().st_ino);
        assert!(unsafe { crate::fifo::global_fifo_table() }.lookup(b"/created-fifo").is_some());
        assert_eq!(lstat(b"/created-socket").unwrap().st_mode, S_IFSOCK | 0o755);
    }

    #[test]
    fn resizable_persistence_reopens_created_symlink_after_indexed_compaction() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        symlink(b"/hello.txt", b"/created-link", 7, 8).unwrap();
        assert_eq!(lstat(b"/created-link").unwrap().st_mode & S_IFMT, S_IFLNK);
        let mut bytes = [0; 32];
        assert_eq!(readlink(b"/created-link", &mut bytes), Ok(10));
        assert_eq!(&bytes[..10], b"/hello.txt");
        link(b"/created-link", b"/alias-link").unwrap();
        sync_persistence().unwrap();

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/created-link").unwrap().st_nlink, 2);
        assert_eq!(readlink(b"/alias-link", &mut bytes), Ok(10));
        unlink(b"/created-link").unwrap();
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(target), Box::new(index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        assert!(matches!(lstat(b"/created-link"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/alias-link").unwrap().st_nlink, 1);
        assert_eq!(readlink(b"/alias-link", &mut bytes), Ok(10));
        assert_eq!(&bytes[..10], b"/hello.txt");
    }

    #[test]
    fn resizable_persistence_reopens_directory_tree_after_indexed_compaction() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        let root_links = lstat(b"/").unwrap().st_nlink;
        mkdir(b"/created-dir", 0o750, 7, 8).unwrap();
        mkdir(b"/empty-dir", 0o700, 7, 8).unwrap();
        mkdir(b"/created-dir/nested", 0o700, 7, 8).unwrap();
        assert_eq!(lstat(b"/").unwrap().st_nlink, root_links + 2);
        let handle = open(b"/created-dir/nested/file", O_CREAT | O_RDWR, 0o640, 7, 8).unwrap();
        assert_eq!(write(handle, 0, b"nested", &mut image_bytes), Ok(6));
        release_handle(handle);
        symlink(b"file", b"/created-dir/nested/link", 7, 8).unwrap();
        rename(b"/created-dir", b"/moved-dir").unwrap();
        assert_eq!(rmdir(b"/moved-dir"), Err(Errno::ENOTEMPTY));
        assert_eq!(link(b"/moved-dir", b"/alias-dir"), Err(Errno::EPERM));
        rmdir(b"/empty-dir").unwrap();
        sync_persistence().unwrap();

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/").unwrap().st_nlink, root_links + 1);
        assert!(matches!(lstat(b"/created-dir"), Err(Errno::ENOENT)));
        assert!(matches!(lstat(b"/empty-dir"), Err(Errno::ENOENT)));
        assert_eq!(lstat(b"/moved-dir").unwrap().st_mode & 0o777, 0o750);
        assert_eq!(lstat(b"/moved-dir").unwrap().st_nlink, 3);
        let mut link_target = [0; 8];
        assert_eq!(readlink(b"/moved-dir/nested/link", &mut link_target), Ok(4));
        assert_eq!(&link_target[..4], b"file");
        let handle = open(b"/moved-dir/nested/file", O_RDONLY, 0, 0, 0).unwrap();
        let mut content = [0; 6];
        assert_eq!(read(handle, 0, &mut content, &mut image_bytes), Ok(6));
        assert_eq!(&content, b"nested");
        release_handle(handle);
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(target), Box::new(index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/moved-dir").unwrap().st_nlink, 3);
        assert_eq!(lstat(b"/moved-dir/nested/file").unwrap().st_size, 6);
        assert_eq!(readlink(b"/moved-dir/nested/link", &mut link_target), Ok(4));
    }

    #[test]
    fn resizable_persistence_refuses_directory_self_move_before_journaling() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes).unwrap();
        mkdir(b"/parent", 0o755, 0, 0).unwrap();
        let journal_length = storage.0.lock().len();

        assert_eq!(rename(b"/parent/", b"/parent/child"), Err(Errno::EINVAL));
        assert_eq!(rename(b"/parent", b"/parent//child"), Err(Errno::EINVAL));
        assert_eq!(storage.0.lock().len(), journal_length);
        assert!(lstat(b"/parent").is_ok());
        assert!(matches!(lstat(b"/parent/child"), Err(Errno::ENOENT)));

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        assert!(lstat(b"/parent").is_ok());
        assert!(matches!(lstat(b"/parent/child"), Err(Errno::ENOENT)));
    }

    #[test]
    fn persistent_metadata_writer_refuses_unrecoverable_setid_namespace_updates() {
        use crate::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs_with_inode_capacity(KandeloImageConfig {
            size_bytes: 64 * 1024, max_size_bytes: Some(1024 * 1024),
            growable_to_bytes: 1024 * 1024, now_ms: 0,
        }, Some(32)).unwrap();
        writer.declare_deferred_section().unwrap();
        writer.create_file(writer.root(), b"plain", 0o644, Content::Bytes(b"plain")).unwrap();
        for (name, mode) in [(b"suid".as_slice(), 0o4755), (b"sgid", 0o2755), (b"both", 0o6755)] {
            writer.create_file(writer.root(), name, mode, Content::Bytes(b"immutable")).unwrap();
        }
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        for name in [b"suid".as_slice(), b"sgid", b"both"] {
            let mut path = vec![b'/'];
            path.extend_from_slice(name);
            for operation in ["link", "unlink", "rename", "rename-over"] {
                reset();
                load_image(image.len() as u64, &mut source).unwrap();
                let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
                enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
                let bytes = storage.0.lock().clone();
                let tree = export_tree();
                let usage = metadata_budget_usage().0;
                let result = match operation {
                    "link" => link(&path, b"/alias"),
                    "unlink" => unlink(&path),
                    "rename" => rename(&path, b"/moved"),
                    _ => rename(b"/plain", &path),
                };
                assert_eq!(result, Err(Errno::EPERM), "{operation}");
                assert_eq!(*storage.0.lock(), bytes, "{operation}");
                assert_eq!(export_tree(), tree, "{operation}");
                assert_eq!(metadata_budget_usage().0, usage, "{operation}");
                assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
                reset();
                load_image(image.len() as u64, &mut source).unwrap();
                enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
                assert_eq!(export_tree(), tree, "{operation}");
            }
        }
    }

    #[test]
    fn persistent_metadata_writer_refuses_unrecoverable_special_permissions() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let digest: [u8; 32] = Sha256::digest(&image).into();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        enable_resizable_persistence(Box::new(storage.clone()), digest, &mut source).unwrap();
        mknod_special(b"/fifo-permissions", 0o600, 7, 8, S_IFIFO).unwrap();
        mknod_special(b"/socket-permissions", 0o600, 9, 10, S_IFSOCK).unwrap();
        mkdir(b"/setgid-directory", 0o755, 0, 0).unwrap();
        chmod(b"/setgid-directory", 0o2775).unwrap();
        chmod(b"/fifo-permissions", 0o1600).unwrap();
        chmod(b"/socket-permissions", 0o1600).unwrap();
        for mode in [0o4600, 0o2600, 0o6600] {
            for path in [b"/fifo-permissions".as_slice(), b"/socket-permissions"] {
                let bytes = storage.0.lock().clone();
                let tree = export_tree();
                let usage = metadata_budget_usage().0;
                assert_eq!(chmod(path, mode), Err(Errno::EPERM));
                assert_eq!(*storage.0.lock(), bytes);
                assert_eq!(export_tree(), tree);
                assert_eq!(metadata_budget_usage().0, usage);
                assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            }
            let fifo_handle = inode_to_file_handle(walk_to_inode(b"/fifo-permissions").unwrap());
            let bytes = storage.0.lock().clone();
            let tree = export_tree();
            assert_eq!(fchmod(fifo_handle, mode), Err(Errno::EPERM));
            assert_eq!(*storage.0.lock(), bytes);
            assert_eq!(export_tree(), tree);
            for kind in [S_IFIFO, S_IFSOCK] {
                let bytes = storage.0.lock().clone();
                let tree = export_tree();
                let usage = metadata_budget_usage().0;
                assert_eq!(mknod_special(b"/invalid-special", mode, 0, 0, kind), Err(Errno::EPERM));
                assert_eq!(*storage.0.lock(), bytes);
                assert_eq!(export_tree(), tree);
                assert_eq!(metadata_budget_usage().0, usage);
                assert_eq!(ROOTFS_METADATA.temporary_usage(), 0);
            }
        }
        let tree = export_tree();
        reset();
        load_image(image.len() as u64, &mut source).unwrap();
        enable_resizable_persistence(Box::new(storage), digest, &mut source).unwrap();
        assert_eq!(export_tree(), tree);
    }

    #[test]
    fn resizable_persistence_replays_explicit_metadata_updates() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        chmod(b"/hello.txt", 0o640).unwrap();
        chown(b"/hello.txt", 7, 8, true).unwrap();
        utimensat(b"/hello.txt", 123, 456, 234, 567, 345, 678).unwrap();
        assert_eq!(chmod(b"/hello.txt", 0o4755), Err(Errno::EPERM));
        let handle = open(b"/created-meta", O_CREAT | O_RDWR, 0o644, 1, 2).unwrap();
        fchmod(handle, 0o600).unwrap();
        fchown(handle, 9, 10, true).unwrap();
        assert_eq!(fchmod(handle, 0o6755), Err(Errno::EPERM));
        release_handle(handle);
        mkdir(b"/metadata-dir", 0o755, 1, 2).unwrap();
        chmod(b"/metadata-dir", 0o700).unwrap();
        chown(b"/metadata-dir", 11, 12, false).unwrap();
        sync_persistence().unwrap();

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let base = lstat(b"/hello.txt").unwrap();
        assert_eq!(base.st_mode & 0o7777, 0o640);
        assert_eq!((base.st_uid, base.st_gid), (7, 8));
        assert_eq!((base.st_atime_sec, base.st_atime_nsec), (123, 456));
        assert_eq!((base.st_mtime_sec, base.st_mtime_nsec), (234, 567));
        assert_eq!((base.st_ctime_sec, base.st_ctime_nsec), (345, 678));
        let created = lstat(b"/created-meta").unwrap();
        assert_eq!(created.st_mode & 0o7777, 0o600);
        assert_eq!((created.st_uid, created.st_gid), (9, 10));
        let directory = lstat(b"/metadata-dir").unwrap();
        assert_eq!(directory.st_mode & 0o7777, 0o700);
        assert_eq!((directory.st_uid, directory.st_gid), (11, 12));
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(target), Box::new(index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mtime_sec, 234);
        assert_eq!(lstat(b"/created-meta").unwrap().st_mode & 0o7777, 0o600);
        assert_eq!(lstat(b"/metadata-dir").unwrap().st_uid, 11);
    }

    #[test]
    fn failed_persistent_metadata_update_does_not_change_live_inode() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let fail_writes = Arc::new(AtomicBool::new(false));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(
            Box::new(FailingCreateStorage { inner: storage.clone(), fail_writes: fail_writes.clone() }),
            base_digest,
            &mut image_bytes,
        ).unwrap();
        let before = lstat(b"/hello.txt").unwrap();
        fail_writes.store(true, Ordering::SeqCst);
        assert_eq!(chmod(b"/hello.txt", 0o600), Err(Errno::ENOSPC));
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mode, before.st_mode);
        assert_eq!(lstat(b"/hello.txt").unwrap().st_ctime_sec, before.st_ctime_sec);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(storage), base_digest, &mut image_bytes).unwrap();
        assert_eq!(lstat(b"/hello.txt").unwrap().st_mode, before.st_mode);
    }

    #[test]
    fn resizable_persistence_syncs_write_and_truncate_timestamps() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source.clone()), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 0, b"TIME", &mut image_bytes), Ok(4));
        let written = fstat(handle).unwrap();
        sync_persistence().unwrap();
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let reopened = lstat(b"/hello.txt").unwrap();
        assert_eq!((reopened.st_mtime_sec, reopened.st_mtime_nsec), (written.st_mtime_sec, written.st_mtime_nsec));
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        truncate_handle(handle, 0, &mut image_bytes).unwrap();
        let truncated = fstat(handle).unwrap();
        release_handle(handle);
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_resizable_persistence_indexed(Box::new(target), Box::new(index), base_digest, checkpoint_end, &mut image_bytes).unwrap();
        let reopened = lstat(b"/hello.txt").unwrap();
        assert_eq!(reopened.st_size, 0);
        assert_eq!((reopened.st_mtime_sec, reopened.st_mtime_nsec), (truncated.st_mtime_sec, truncated.st_mtime_nsec));
    }

    #[test]
    fn persistent_graph_validation_merges_changes_in_wide_base_directory() {
        let mut state = RootfsState::new();
        let root_index = state.mount_root().unwrap();
        for number in 0..4096 {
            let ino = state.alloc_ino();
            let index = state.insert_inode(Inode::new(
                InodeKind::Regular(Vec::new()),
                0o644,
                0,
                0,
                1,
                ino,
            )).unwrap();
            let InodeKind::Dir(entries) = &mut state.get_mut(root_index).unwrap().kind else {
                panic!("root must be a directory");
            };
            entries.try_insert(alloc::format!("base-{number:04}").as_bytes(), index).unwrap();
        }
        let created_ino = state.next_ino;
        let created = vec![(
            created_ino,
            Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, created_ino),
        )];
        let storage: Box<dyn OverlayStorage + Send> =
            Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"base-0001".to_vec(),
                    },
                    value: created_ino.to_le_bytes().to_vec(),
                },
                Mutation::Delete {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"base-0002".to_vec(),
                    },
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"new-link".to_vec(),
                    },
                    value: created_ino.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        assert_eq!(
            validate_persistent_dirents(&state, &mut journal, &created),
            Ok(())
        );
    }

    #[test]
    fn persistent_graph_validation_rejects_disconnected_directory_cycle() {
        let mut state = RootfsState::new();
        state.mount_root().unwrap();
        let created = vec![
            (
                10,
                Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 10),
            ),
            (
                11,
                Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 11),
            ),
        ];
        let storage: Box<dyn OverlayStorage + Send> =
            Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 10,
                        name: b"child".to_vec(),
                    },
                    value: 11u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 11,
                        name: b"parent".to_vec(),
                    },
                    value: 10u64.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        assert_eq!(
            validate_persistent_dirents(&state, &mut journal, &created),
            Err(Errno::EIO)
        );
    }

    #[test]
    fn persistent_dirent_replay_uses_inode_numbers_not_arena_order() {
        let mut state = RootfsState::new();
        let root = state.mount_root().unwrap();
        let later = state.insert_inode(Inode::new(
            InodeKind::PersistentRegular,
            0o644,
            0,
            0,
            0,
            9,
        )).unwrap();
        let earlier = state.insert_inode(Inode::new(
            InodeKind::PersistentRegular,
            0o644,
            0,
            0,
            0,
            3,
        )).unwrap();
        let storage: Box<dyn OverlayStorage + Send> =
            Box::new(SharedJournalStorage(Arc::new(Mutex::new(Vec::new()))));
        let mut journal = OverlayJournal::open(storage, [0; 32]).unwrap();
        journal
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"earlier".to_vec(),
                    },
                    value: 3u64.to_le_bytes().to_vec(),
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 1,
                        name: b"later".to_vec(),
                    },
                    value: 9u64.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        validate_persistent_dirents(&state, &mut journal, &[]).unwrap();
        apply_persistent_dirents(&mut state, &mut journal).unwrap();
        let InodeKind::Dir(entries) = &state.get(root).unwrap().kind else {
            panic!("root must be a directory");
        };
        assert_eq!(entries.get(b"earlier".as_slice()), Some(&earlier));
        assert_eq!(entries.get(b"later".as_slice()), Some(&later));
    }

    #[test]
    fn rejected_persistence_metadata_preserves_the_unrepaired_journal() {
        use crate::persistent_overlay::{Mutation, OverlayKey};

        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        let storage = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(storage.clone(), base_digest).unwrap();
        let created = Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 99_999);
        let mut record = encode_persistent_inode(&created).unwrap();
        record[0] = 2;
        journal.commit(&[Mutation::Put { key: OverlayKey::Inode(created.ino), value: record }]).unwrap();
        drop(journal);
        storage.0.lock().extend_from_slice(b"incomplete next transaction");
        let original = storage.0.lock().clone();
        let next_ino = ROOTFS.with(|state| state.next_ino);
        assert_eq!(enable_resizable_persistence(Box::new(storage.clone()), base_digest, &mut image_bytes), Err(Errno::EIO));
        assert_eq!(*storage.0.lock(), original);
        assert_eq!(ROOTFS.with(|state| state.next_ino), next_ino);
    }

    #[test]
    fn resizable_persistence_rejects_namespace_and_unknown_file_records() {
        use crate::persistent_overlay::{Mutation, OverlayKey};

        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();

        let namespace = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(namespace.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::Dirent {
                    parent: 1,
                    name: b"new".to_vec(),
                },
                value: 7u64.to_le_bytes().to_vec(),
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(namespace), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );

        let removed_directory = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(removed_directory.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Delete {
                key: OverlayKey::Dirent {
                    parent: 1,
                    name: b"dir".to_vec(),
                },
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(removed_directory), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );

        let unknown_parent = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(unknown_parent.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Delete {
                key: OverlayKey::Dirent {
                    parent: 99_999,
                    name: b"hello.txt".to_vec(),
                },
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(unknown_parent), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );

        let malformed_inode = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(malformed_inode.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::Inode(99_999),
                value: b"not a persistent inode".to_vec(),
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(malformed_inode), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );

        let invalid_creation = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(invalid_creation.clone(), base_digest).unwrap();
        let created = Inode::new(InodeKind::PersistentRegular, 0o644, 0, 0, 1, 99_999);
        journal
            .commit(&[
                Mutation::Put {
                    key: OverlayKey::Inode(created.ino),
                    value: encode_persistent_inode(&created).unwrap(),
                },
                Mutation::Put {
                    key: OverlayKey::Dirent {
                        parent: 99_998,
                        name: b"ghost".to_vec(),
                    },
                    value: created.ino.to_le_bytes().to_vec(),
                },
            ])
            .unwrap();
        let next_ino = ROOTFS.with(|state| state.next_ino);
        assert_eq!(
            enable_resizable_persistence(Box::new(invalid_creation), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );
        assert_eq!(ROOTFS.with(|state| state.next_ino), next_ino);

        let linked_directory = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(linked_directory.clone(), base_digest).unwrap();
        let created_dir = Inode::new(InodeKind::Dir(DirectoryEntries::new()), 0o755, 0, 0, 2, 99_999);
        journal.commit(&[
            Mutation::Put {
                key: OverlayKey::Inode(created_dir.ino),
                value: encode_persistent_inode(&created_dir).unwrap(),
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: 1, name: b"first-dir".to_vec() },
                value: created_dir.ino.to_le_bytes().to_vec(),
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: 1, name: b"second-dir".to_vec() },
                value: created_dir.ino.to_le_bytes().to_vec(),
            },
        ]).unwrap();
        assert_eq!(enable_resizable_persistence(Box::new(linked_directory), base_digest, &mut image_bytes), Err(Errno::EIO));
        assert!(matches!(lstat(b"/first-dir"), Err(Errno::ENOENT)));

        let cyclic_directory = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(cyclic_directory.clone(), base_digest).unwrap();
        journal.commit(&[
            Mutation::Put {
                key: OverlayKey::Inode(created_dir.ino),
                value: encode_persistent_inode(&created_dir).unwrap(),
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: 1, name: b"cycle".to_vec() },
                value: created_dir.ino.to_le_bytes().to_vec(),
            },
            Mutation::Put {
                key: OverlayKey::Dirent { parent: created_dir.ino, name: b"back".to_vec() },
                value: 1u64.to_le_bytes().to_vec(),
            },
        ]).unwrap();
        assert_eq!(enable_resizable_persistence(Box::new(cyclic_directory), base_digest, &mut image_bytes), Err(Errno::EIO));
        assert!(matches!(lstat(b"/cycle"), Err(Errno::ENOENT)));

        let invalid_metadata = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(invalid_metadata.clone(), base_digest).unwrap();
        let base_inode = lstat(b"/hello.txt").unwrap().st_ino;
        let mut metadata = ROOTFS.with(|state| {
            PersistentInodeMetadata::from_inode(
                state.inodes.iter().flatten().find(|inode| inode.ino == base_inode).unwrap(),
            )
        });
        metadata.atime_nsec = 1_000_000_000;
        journal.commit(&[Mutation::Put {
            key: OverlayKey::Inode(base_inode),
            value: encode_inode_record(4, &[], metadata).unwrap(),
        }]).unwrap();
        assert_eq!(enable_resizable_persistence(Box::new(invalid_metadata), base_digest, &mut image_bytes), Err(Errno::EIO));
        assert!(lstat(b"/hello.txt").unwrap().st_atime_nsec < 1_000_000_000);

        let unknown = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(unknown.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileSize(99_999),
                value: 1u64.to_le_bytes().to_vec(),
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(unknown), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );

        let oversized = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut journal = OverlayJournal::open(oversized.clone(), base_digest).unwrap();
        journal
            .commit(&[Mutation::Put {
                key: OverlayKey::FileSize(lstat(b"/hello.txt").unwrap().st_ino),
                value: (i64::MAX as u64 + 1).to_le_bytes().to_vec(),
            }])
            .unwrap();
        assert_eq!(
            enable_resizable_persistence(Box::new(oversized), base_digest, &mut image_bytes),
            Err(Errno::EIO)
        );
    }

    #[test]
    fn prepared_checkpoint_survives_activation_and_reopen() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let base_digest: [u8; 32] = Sha256::digest(&image).into();
        let source = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let target = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let index = SharedJournalStorage(Arc::new(Mutex::new(Vec::new())));
        let mut image_bytes = image_host(&image);
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence(Box::new(source), base_digest, &mut image_bytes).unwrap();
        let handle = open(b"/hello.txt", O_RDWR, 0, 0, 0).unwrap();
        assert_eq!(write(handle, 6, b"KIFS", &mut image_bytes).unwrap(), 4);
        sync_persistence().unwrap();
        prepare_persistence_compaction(Box::new(target.clone())).unwrap();
        checkpoint_prepared_persistence(Box::new(index.clone())).unwrap();
        activate_persistence_compaction().unwrap();
        let checkpoint_end = target.0.lock().len() as u64;
        let mut changed = [0u8; 16];
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello KIFS\n");
        release_handle(handle);

        reset();
        load_image(image.len() as u64, &mut image_bytes).unwrap();
        enable_fixed_persistence_indexed(
            Box::new(target),
            Box::new(index),
            base_digest,
            checkpoint_end,
            &mut image_bytes,
        )
        .unwrap();
        let handle = open(b"/hello.txt", O_RDONLY, 0, 0, 0).unwrap();
        let count = read(handle, 0, &mut changed, &mut image_bytes).unwrap();
        assert_eq!(&changed[..count], b"hello KIFS\n");
        release_handle(handle);
    }

    /// 45,000 bytes is past KIFS's ten direct block pointers, so this read
    /// exercises the single-indirect path through the same host image window.
    #[test]
    fn image_backed_read_spans_indirect_blocks() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let mut host = image_host(&image);
        load_image(image.len() as u64, &mut host).expect("load image");

        let handle = open(b"/big.txt", O_RDONLY, 0, 0, 0).expect("open");
        let mut whole = alloc::vec![0u8; 45_000];
        let mut filled = 0usize;
        while filled < whole.len() {
            let n = read(handle, filled as i64, &mut whole[filled..], &mut host).expect("read");
            assert_ne!(n, 0, "short read at {filled}");
            filled += n;
        }
        assert_eq!(filled, 45_000);

        // Cross-check against a DIRECT mount of the same image: same bytes,
        // reached without the store, without the remembered geometry, and
        // without `KandeloImageFs::from_geometry`. If the plumbing this item adds ever
        // mis-addresses a block, the two disagree.
        let direct_source = crate::kandelo_image_fs::unwrap_vfsi(&image).expect("vfsi body");
        let direct = crate::kandelo_image_fs::KandeloImageFs::mount(direct_source).expect("direct mount");
        let big_ino = direct.resolve(b"/big.txt", true).expect("resolve");
        let mut expected = alloc::vec![0u8; 45_000];
        let mut done = 0usize;
        while done < expected.len() {
            let n = direct
                .read_at(big_ino, done as u64, &mut expected[done..])
                .expect("direct read");
            assert_ne!(n, 0);
            done += n;
        }
        assert_eq!(whole, expected);
        // Reading past the last block stops at the file size, not at a block
        // boundary.
        let mut past = [0u8; 8];
        assert_eq!(read(handle, 45_000, &mut past, &mut host).expect("EOF"), 0);
        release_handle(handle);
    }

    /// Copy-on-write of an image-backed file pulls the base bytes from the
    /// image, not from the host.
    #[test]
    fn image_backed_copy_on_write_materializes_from_the_image() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let mut host = image_host(&image);
        load_image(image.len() as u64, &mut host).expect("load image");

        // O_RDWR == 2.
        let handle = open(b"/hello.txt", 2, 0, 0, 0).expect("open");
        assert_eq!(write(handle, 0, b"HELLO", &mut host).expect("write"), 5);
        let mut buf = [0u8; 32];
        let n = read(handle, 0, &mut buf, &mut host).expect("read");
        assert_eq!(&buf[..n], b"HELLO sffs\n", "the un-overwritten tail is the image's");
        release_handle(handle);
    }

    /// Release-and-recreate: a second build after `reset` must be
    /// indistinguishable from the first.
    ///
    /// This is the property the image builders actually need, and it
    /// was an open question rather than a fact. The measured finding is that
    /// no production builder path holds two live filesystems -- the one
    /// apparent case builds sequentially and `rebaseToNewFileSystem` has only
    /// test callers -- so the requirement is one live instance at a time with
    /// an explicit teardown, NOT an instance handle threaded through every
    /// call site.
    ///
    /// The tree is built with ALLOCATING operations on purpose. The existing
    /// sample tree passes explicit inode numbers, so it would sail through a
    /// `next_ino` counter that survived the reset; `mkdir` and `symlink` call
    /// `alloc_ino`, so a leaked counter shows up immediately as different
    /// inode numbers on the second pass.
    #[test]
    fn reset_gives_a_second_build_a_clean_slate() {
        let _guard = TestGuard::acquire();
        fn build() -> alloc::vec::Vec<(u64, u32, u32, u32)> {
            insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
            mkdir(b"/a", 0o755, 1, 2).unwrap();
            mkdir(b"/a/b", 0o700, 3, 4).unwrap();
            symlink(b"../x", b"/a/link", 5, 6).unwrap();
            [b"/a".as_ref(), b"/a/b".as_ref(), b"/a/link".as_ref()]
                .iter()
                .map(|p| {
                    let st = lstat(p).unwrap();
                    (st.st_ino, st.st_mode & 0o7777, st.st_uid, st.st_gid)
                })
                .collect()
        }
        let first = build();
        reset();
        let second = build();
        assert_eq!(
            first, second,
            "a build after reset must not inherit inode numbers or metadata \
             from the previous one -- sequential image builds in one process \
             would otherwise differ for no reason the recipe explains",
        );
    }

    #[test]
    fn reset_drops_the_image_geometry_with_the_tree() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        load_image(image.len() as u64, image_host(&image)).expect("load image");
        ROOTFS.with(|state| assert!(state.image.is_some()));
        reset();
        ROOTFS.with(|state| assert!(state.image.is_none()));
    }

    #[test]
    fn load_image_rejects_an_image_that_declares_no_deferred_section() {
        let _guard = TestGuard::acquire();
        // `tiny_vfs()` carries no `SDEF` section, so it predates the kernel's
        // ability to read deferred files out of an image.
        // Loading it would build a tree where every deferred file reports size
        // 0 — wrong, and indistinguishable from right. It must fail loudly and
        // be rebuilt, not be read on a best-effort basis.
        assert_eq!(
            load_image(tiny_vfs().len() as u64, image_host(tiny_vfs())).unwrap_err(),
            Errno::EINVAL
        );
        assert_eq!(lstat(b"/big.txt").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn load_image_accepts_an_image_whose_deferred_section_is_empty() {
        let _guard = TestGuard::acquire();
        // An image with genuinely no lazy files still declares the section, and
        // that is what distinguishes it from a stale one.
        let image = tiny_vfs_described().to_vec();
        assert_eq!(load_image(image.len() as u64, image_host(&image)).unwrap(), 6);
        assert_eq!(lstat(b"/big.txt").expect("big").st_size, 45_000);
    }

    #[test]
    fn deferred_metadata_source_errors_reset_partial_image_state_and_allow_reload() {
        use crate::kandelo_image_write::{KandeloImageConfig, KandeloImageWriter, NoContent};
        let _guard = TestGuard::acquire();
        let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(64 * 1024)).unwrap();
        writer.create_deferred_file(writer.root(), b"lazy", 0o644,
            123, 0, b"", b"https://example.invalid/data", b"", &[7; 8193]).unwrap();
        let body = writer.finish().unwrap().to_vec(&NoContent).unwrap();
        let read_u32 = |offset: usize| u32::from_le_bytes(body[offset..offset + 4].try_into().unwrap());
        let metadata_inode = read_u32(76) as usize;
        let inode_table = read_u32(36) as usize * 4096;
        let first_block = read_u32(inode_table + metadata_inode * 128 + crate::kandelo_image_fs::INO_DIRECT);
        let payload_offset = 16 + u64::from(first_block) * 4096
            + u64::from(crate::sdef::HEADER_SIZE) + u64::from(crate::sdef::RECORD_HEADER_SIZE);
        let image = crate::vfsi_container::wrap(&body, &crate::vfsi_container::ContainerSections {
            lazy_json: b"", archive_json: None, metadata_json: None, kernel_lazy: None,
        }).unwrap();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            let mut source = image_host(&image);
            let mut failed = false;
            assert_eq!(load_image(image.len() as u64, |request, bytes| {
                if matches!(request, ByteReq::Image { offset } if offset >= payload_offset) {
                    failed = true;
                    return Err(error);
                }
                source(request, bytes)
            }), Err(error));
            assert!(failed);
            ROOTFS.with(|state| {
                assert!(state.image.is_none());
                assert!(state.root.is_none());
                assert!(state.inodes.is_empty());
            });
            load_image(image.len() as u64, image_host(&image)).unwrap();
            assert_eq!(lstat(b"/lazy").unwrap().st_size, 123);
        }
    }

    #[test]
    fn load_image_rejects_a_malformed_container_and_resets_the_store() {
        let _guard = TestGuard::acquire();
        build_sample_tree();
        assert!(lstat(b"/").is_ok());

        let mut bad = tiny_vfs_described().to_vec();
        bad[0] ^= 0xff; // break the VFSI magic
        assert_eq!(
            load_image(bad.len() as u64, image_host(&bad)).unwrap_err(),
            Errno::EINVAL
        );
        // Not just "the new tree is absent": the PREVIOUS tree is gone too, so a
        // failed load can never leave a caller reading a half-replaced base.
        assert_eq!(lstat(b"/a").unwrap_err(), Errno::ENOENT);
    }

    #[test]
    fn load_image_rejects_an_image_shorter_than_the_host_declared() {
        let _guard = TestGuard::acquire();
        // The host claims a longer image than it can serve, and the cut lands in
        // a block the loader must read (the inode table): this container is not
        // the size it says, and that is refused.
        //
        // A cut inside the trailing host-side JSON sections is NOT detected,
        // and that is correct rather than a gap: the kernel never reads those
        // sections. It used to walk past them to reach a `KLZY` section; since
        // `KLZY` is refused by its header flag alone (2026-10-02), nothing in
        // the load touches the trailer, so this test no longer cuts there.
        let image = tiny_vfs_described().to_vec();
        for cut in [13_000usize] {
            assert_eq!(
                load_image(image.len() as u64, image_host(&image[..cut])).unwrap_err(),
                Errno::EINVAL,
                "truncated at {cut}"
            );
            assert_eq!(lstat(b"/big.txt").unwrap_err(), Errno::ENOENT);
        }
    }

    #[test]
    fn load_image_propagates_enosys_when_no_image_source_is_installed() {
        let _guard = TestGuard::acquire();
        // This is the dormant case: every host declares `host_image_read`, and a
        // host with no image source answers ENOSYS. It must surface as ENOSYS,
        // not as a corrupt-image EINVAL, so a misconfigured host is legible.
        let mut none = |_req: ByteReq, _buf: &mut [u8]| -> Result<usize, Errno> { Err(Errno::ENOSYS) };
        assert_eq!(
            load_image(1_024, &mut none).unwrap_err(),
            Errno::ENOSYS
        );
    }

    #[test]
    fn load_image_never_asks_the_host_beyond_the_declared_image_length() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let limit = image.len() as u64;
        let mut highest = 0u64;
        let mut source = |req: ByteReq, buf: &mut [u8]| -> Result<usize, Errno> {
            let ByteReq::Image { offset } = req else {
                return Err(Errno::ENOSYS);
            };
            let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
            if start >= image.len() {
                return Ok(0);
            }
            let n = core::cmp::min(buf.len(), image.len() - start);
            highest = highest.max(offset + n as u64);
            buf[..n].copy_from_slice(&image[start..start + n]);
            Ok(n)
        };
        load_image(limit, &mut source).expect("load image");
        assert!(highest <= limit, "read past the declared image length");
        // And it reads far less than the whole image: the point of the cursor is
        // that a 16-256 MiB image is never made resident in kernel memory.
        assert!(highest > 0);
    }

    // -- Image export -------------------------------------------------------

    /// A byte source that refuses everything. Correct for a tree with no
    /// image-backed files: if the export reaches for host bytes anyway, the
    /// test fails loudly instead of quietly succeeding.
    fn no_bytes() -> impl FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno> {
        |_, _| Err(Errno::ENOSYS)
    }

    /// Stream a whole export out through the public cursor, in `chunk`-sized
    /// A drain loop stops when the export returns 0, which is correct until a
    /// defect stops it returning 0 — and a mutation trial did exactly that in
    /// the sibling module, making the export ignore its offset and restart
    /// forever. The test spun growing a buffer instead of failing, and the run
    /// waited eighteen minutes on it.
    ///
    /// The bound is far above any image these tests build, so it can only be
    /// hit by non-termination, and it names the cause rather than just failing.
    /// Applied here because the same kind of defect can reach this export: no
    /// mutation hangs these today, and a test that CAN hang eventually will.
    fn assert_not_spinning(drained: usize) {
        const SANE_LIMIT: usize = 4 * 1024 * 1024;
        assert!(
            drained <= SANE_LIMIT,
            "the export is not advancing: {drained} bytes drained from a tiny image, \
             so some chunk is being served again instead of the next one",
        );
    }

    /// reads, exactly as the host will.
    fn drain_export<F>(chunk: usize, byte_source: &mut F) -> Vec<u8>
    where
        F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
    {
        let mut out = Vec::new();
        let mut offset = 0i64;
        loop {
            let mut buf = alloc::vec![0u8; chunk];
            let n = export_image_read(offset, &mut buf, byte_source).expect("export chunk");
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            offset += n as i64;
            assert_not_spinning(out.len());
        }
        out
    }

    /// Drain the whole exported CONTAINER, the way a builder saves one.
    fn drain_container<F>(chunk: usize, byte_source: &mut F) -> Vec<u8>
    where
        F: FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>,
    {
        let mut out = Vec::new();
        let mut offset = 0i64;
        loop {
            let mut buf = alloc::vec![0u8; chunk];
            let n =
                export_container_read(offset, &mut buf, byte_source).expect("container chunk");
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            offset += n as i64;
            assert_not_spinning(out.len());
        }
        out
    }

    #[test]
    fn container_export_streams_large_metadata_at_the_resident_limit() {
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        let mut source = image_host(&image);
        load_image(image.len() as u64, &mut source).unwrap();
        let mut metadata = alloc::vec![b' '; 2 * 1024 * 1024];
        metadata[..2].copy_from_slice(b"{}");
        set_image_metadata(&metadata).unwrap();
        let mut header = [0; 16];
        assert_eq!(export_container_read(0, &mut header, &mut source), Ok(16));
        let body_len = u32::from_le_bytes(header[12..16].try_into().unwrap()) as u64;
        let trailer_start = 16 + body_len;
        let resident = metadata_budget_usage().0;
        let temporary = ROOTFS_METADATA.temporary_usage();
        set_metadata_budget_bytes(resident).unwrap();
        let metadata_length = (metadata.len() as u32).to_le_bytes();
        let trailer_len = 8 + metadata.len();
        let mut offset = 0;
        while offset < trailer_len {
            let mut out = [0xa5; 257];
            let count = export_container_read((trailer_start + offset as u64) as i64, &mut out, &mut source).unwrap();
            assert_eq!(count, out.len().min(trailer_len - offset));
            for (index, byte) in out[..count].iter().enumerate() {
                let position = offset + index;
                let expected = if position < 4 { 0 }
                    else if position < 8 { metadata_length[position - 4] }
                    else { metadata[position - 8] };
                assert_eq!(*byte, expected);
            }
            assert!(out[count..].iter().all(|byte| *byte == 0xa5));
            assert_eq!(metadata_budget_usage().0, resident);
            assert_eq!(ROOTFS_METADATA.temporary_usage(), temporary);
            offset += count;
        }
        assert_eq!(export_container_read((trailer_start + trailer_len as u64) as i64, &mut [0; 1], &mut source), Ok(0));
        assert!(IMAGE_EXPORT_CACHE.with(|slot| slot.is_none()));
        assert!(ROOTFS.with(|state| state.image_metadata.as_ref().unwrap().as_slice() == metadata.as_slice()));
    }

    fn build_small_overlay() {
        mkdir(b"/etc", 0o755, 0, 0).expect("mkdir /etc");
        write_file_at(b"/etc/passwd", 0, b"root:x:0:0\n", 0o644, true, no_bytes())
            .expect("write passwd");
        mkdir(b"/opt", 0o700, 7, 9).expect("mkdir /opt");
        // Crosses the ten direct blocks into the single indirect block, so the
        // export exercises indirect allocation with streamed content.
        let big: Vec<u8> = (0..45_000usize).map(|i| (i % 251) as u8).collect();
        write_file_at(b"/opt/big.bin", 0, &big, 0o600, true, no_bytes()).expect("write big");
        symlink(b"/etc/passwd", b"/pw", 0, 0).expect("symlink");
        symlink(
            b"/opt/a-target-path-long-enough-to-need-its-own-data-block",
            b"/longpw",
            0,
            0,
        )
        .expect("long symlink");
    }

    /// A whole image with a URL-backed deferred file in it: an KIFS body whose
    /// deferred section names one inode, a `KLZY` section declaring that inode
    /// deferred with no archive, and a real VFSI container around both.
    ///
    /// Built rather than committed as a fixture because the point is that BOTH
    /// descriptions come from one writer; a hand-assembled one could disagree
    /// with itself in a way no production image can.
    fn url_backed_image(url: &[u8], real_size: u64) -> Vec<u8> {
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(
            256 * 1024,
        ))
        .expect("mkfs");
        let root = w.root();
        // The URL goes in the ADDRESS field, not the payload. It used to sit in
        // the payload because the format had nowhere typed for it and the host
        // resolved the file by inode number instead; the kernel relays the
        // address now, so an image that hid its URL in an opaque blob would be
        // an image the kernel cannot fetch.
        let ino = w
            .create_deferred_file(root, b"big.bin", 0o644, real_size, 0, b"", url, b"", b"")
            .expect("deferred");
        // No file in this body carries content, so the content source is never
        // consulted -- a deferred file is described, not stored.
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize the body");

        let _ = ino;
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        let mut image = crate::vfsi_container::header(body.len(), sections.flags())
            .expect("header")
            .to_vec();
        image.extend_from_slice(&body);
        image.extend_from_slice(&crate::vfsi_container::trailer(&sections).expect("trailer"));
        image
    }

    /// Distinct constants so a round-trip test that crossed two of them would
    /// fail rather than pass by coincidence.
    /// An archive payload shaped the way a PRODUCER writes one: the caller's
    /// fetch description inside a seal envelope that declares no seal.
    ///
    /// The fixtures below used a bare `b"sha256:abc"` as a stand-in for an
    /// opaque description, which was faithful while the loader carried
    /// payloads without reading them. It authenticates cohorts now, so a bare
    /// stand-in is an image no producer emits — `sm_register_lazy_archive`
    /// wraps every descriptor exactly like this. The claim these fixtures make
    /// is unchanged: whatever the image carries comes back byte for byte.
    fn unsealed_payload(descriptor: &[u8]) -> Vec<u8> {
        crate::seal::encode(&crate::seal::ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: crate::seal::SealState::None,
        })
        .expect("encode an unsealed payload")
    }

    const ARCHIVE_URI: &[u8] = b"https://example.invalid/php-8.3.zip";
    const ARCHIVE_DIGEST: [u8; crate::sdef::DIGEST_LEN] =
        [0xA1; crate::sdef::DIGEST_LEN];
    const FILE_DIGEST: [u8; crate::sdef::DIGEST_LEN] =
        [0xF1; crate::sdef::DIGEST_LEN];
    const MEMBER_DIGEST: [u8; crate::sdef::DIGEST_LEN] =
        [0x3D; crate::sdef::DIGEST_LEN];

    /// The same image as [`url_backed_image`] but described ONLY by its body:
    /// no `KLZY` section, and the container flag clear.
    fn sdef_only_image(url: &[u8], real_size: u64) -> Vec<u8> {
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(
            256 * 1024,
        ))
        .expect("mkfs");
        let root = w.root();
        w.declare_lazy_archive(
            3,
            8_000_000,
            ARCHIVE_URI,
            &ARCHIVE_DIGEST,
            &unsealed_payload(b"sha256:feed"),
        )
        .expect("declare");
        // The standalone file is addressed by `url`; its digest covers the
        // bytes that address serves.
        w.create_deferred_file(
            root,
            b"big.bin",
            0o644,
            real_size,
            0,
            b"",
            url,
            &FILE_DIGEST,
            b"",
        )
        .expect("url-backed");
        w.create_deferred_file(
            root,
            b"php",
            0o755,
            4_242,
            3,
            b"usr/bin/php",
            b"",
            &MEMBER_DIGEST,
            b"",
        )
            .expect("archive member");
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");

        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        crate::vfsi_container::wrap(&body, &sections).expect("wrap")
    }

    /// An image in the shape the legacy writer produces when it had to skip an
    /// archive group: the member is an ordinary EMPTY file in the body, the
    /// kernel-facing section describes nothing, and only the container header
    /// still says there are lazy archives.
    ///
    /// `claims_archives` is the one thing that varies, so the test can show
    /// that the header flag is what decides -- a fixture with the flag clear
    /// must LOAD, or the refusal is coming from something else.
    fn legacy_image_with_an_undescribed_archive(claims_archives: bool) -> Vec<u8> {
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(
            256 * 1024,
        ))
        .expect("mkfs");
        let root = w.root();
        // The member as the legacy body holds it: a zero-length regular file.
        // Its real length lived only in the archive metadata that was skipped,
        // so nothing here says this file is 4,242 bytes of binary.
        w.create_file(root, b"php", 0o755, crate::kandelo_image_write::Content::Bytes(b""))
            .expect("member stub");
        // An `SDEF` that describes nothing: the description is present and
        // says there are no deferred files, while the header still claims
        // lazy archives. (This used to be an empty `KLZY`, the legacy encoder's
        // output once it had skipped the only group it had; `KLZY` is no longer
        // read, and the guard under test is about the claim, not the carrier.)
        w.declare_deferred_section();
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");

        // The HOST-side archive JSON, which a legacy image really carries and
        // which the kernel cannot read. Its presence is what sets the header's
        // lazy-archive flag, so the flag word and the sections AGREE -- and the
        // container's own "no bytes the flags do not account for" check is
        // therefore satisfied. Only the kernel-facing section is short.
        //
        // The first two versions of this fixture set the flag by hand with no
        // such section, and the container check refused them before the load
        // ever looked. That is a THIRD different check doing the refusing, and
        // it is why the mutation kept surviving a test that read as correct.
        let archive_json: &[u8] = br#"[{"url":"https://example.invalid/x.zip"}]"#;
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: if claims_archives { Some(archive_json) } else { None },
            metadata_json: None,
            kernel_lazy: None,
        };
        crate::vfsi_container::wrap(&body, &sections).expect("wrap")
    }

    #[test]
    fn an_image_claiming_archives_it_describes_nowhere_is_refused() {
        let _guard = TestGuard::acquire();
        // The neither-carrier refusal catches an image that describes
        // its deferred files nowhere. This is the quieter case: a description
        // that is PRESENT and partial.
        //
        // Accepting it builds a tree where an archive member is an ordinary
        // empty file -- a 4,242-byte binary reporting zero -- and the load
        // returns success. A build derived from that base ships the emptiness,
        // and nothing anywhere reported a problem.
        let claiming = legacy_image_with_an_undescribed_archive(true);
        assert_eq!(
            load_image(claiming.len() as u64, image_host(&claiming)).unwrap_err(),
            Errno::EINVAL,
            "an image whose archives this reader cannot see is refused",
        );

        // The negative control, and the reason it is here: the same bytes with
        // the claim removed must LOAD. Without it this test would pass for any
        // refusal at all, which is exactly how its first two versions passed.
        let honest = legacy_image_with_an_undescribed_archive(false);
        assert!(
            load_image(honest.len() as u64, image_host(&honest)).is_ok(),
            "the header's claim is what decides, not something else",
        );
    }

    #[test]
    fn a_load_leaves_the_image_it_was_handed_byte_for_byte_unchanged() {
        let _guard = TestGuard::acquire();
        // PORTED from a host test that asserted this of the host's restore — the gigabyte materialization
        // that no longer happens. The claim belongs to whoever reads the
        // image, and that is now this loader.
        //
        // The kernel builds its tree from these bytes and keeps reading them
        // afterwards: every base file is a promise that the image can be asked
        // again. A loader that amended what it was handed would make the tree
        // and the artifact disagree, and the disagreement would surface later,
        // somewhere else, as a wrong file rather than as a failed load.
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        mkdir(b"/usr", 0o755, 0, 0).expect("mkdir /usr");
        write_file_at(b"/usr/thing", 0, b"ordinary bytes", 0o644, true, no_bytes())
            .expect("a file, so the image is not empty");
        let image = drain_container(8192, &mut no_bytes());
        let pristine = image.clone();

        reset();
        let count = load_image(image.len() as u64, image_host(&image)).expect("load");
        assert_eq!(count, 3, "root, /usr, /usr/thing");
        assert_eq!(image, pristine, "the loader wrote into the image it was given");

        // NOT VACUOUS: the tree really was built from those bytes, so the
        // comparison is about a loader that read them rather than one that
        // ignored them.
        assert_eq!(lstat(b"/usr/thing").expect("stat").st_size, 14);
    }

    #[test]
    fn a_load_refuses_an_image_whose_cohorts_do_not_authenticate() {
        let _guard = TestGuard::acquire();
        // THE BOOT-TIME BOUNDARY, tested where it now lives.
        //
        // This check ran only in the image module's `sm_load_image`, so a
        // builder authenticated and a booting kernel did not; the host stood
        // in for it by restoring the whole `/` image into a second filesystem
        // to call `verifyImportedLazyAtomicGroupSeals` on it. Two trials --
        // the check removed, and the check made advisory -- both SURVIVED
        // when the guard first moved here, because every test that exercised
        // it verifies against the other crate.
        //
        // The archive declares a cohort of two and supplies one, which is the
        // partial activation atomic cohorts exist to forbid.
        let descriptor: &[u8] = b"{\"url\":\"https://example.invalid/tools.zip\"}";
        let mut identity = alloc::vec![
            (b"tools".to_vec(), crate::seal::sha256(descriptor)),
            (b"docs".to_vec(), crate::seal::sha256(b"{}")),
        ];
        let cohort = crate::seal::sha256(
            &crate::seal::cohort_identity(b"shell", &mut identity).expect("identity"),
        );
        let payload = crate::seal::encode(&crate::seal::ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: crate::seal::SealState::Sealed(crate::seal::ArchiveSeal {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 2,
                cohort_digest: cohort,
                descriptor_digest: crate::seal::sha256(descriptor),
            }),
        })
        .expect("encode");

        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        mkdir(b"/opt", 0o755, 0, 0).expect("mkdir /opt");
        declare_archive(3, 8_000_000).expect("declare archive");
        set_archive_payload(3, &payload).expect("seal it short of its count");
        insert_lazy_file(
            b"/opt/tools", 3, b"opt/tools", 4_242, 0o755, 0, 0, 2, b"", b"", b"",
        )
        .expect("archive member");
        let tampered = drain_container(8192, &mut no_bytes());

        assert_eq!(
            load_image(tampered.len() as u64, image_host(&tampered)).unwrap_err(),
            Errno::EPERM,
            "a cohort short of its count",
        );
        // The refusal UNLOADS. `load_image` resets on error, and an image that
        // failed to authenticate must not be left mounted for the next call to
        // build on.
        assert!(lstat(b"/opt/tools").is_err(), "and its tree is gone");

        // THE NEGATIVE CONTROL, and it is what makes the refusal about the
        // cohort rather than about anything else this image happens to carry.
        // The same tree, the same archive, the same descriptor -- sealed to a
        // cohort of ONE, which is complete -- must load.
        reset();
        let mut whole = alloc::vec![(b"tools".to_vec(), crate::seal::sha256(descriptor))];
        let one = crate::seal::sha256(
            &crate::seal::cohort_identity(b"shell", &mut whole).expect("identity"),
        );
        let sealed = crate::seal::encode(&crate::seal::ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: crate::seal::SealState::Sealed(crate::seal::ArchiveSeal {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 1,
                cohort_digest: one,
                descriptor_digest: crate::seal::sha256(descriptor),
            }),
        })
        .expect("encode");
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        mkdir(b"/opt", 0o755, 0, 0).expect("mkdir /opt");
        declare_archive(3, 8_000_000).expect("declare archive");
        set_archive_payload(3, &sealed).expect("seal it whole");
        insert_lazy_file(
            b"/opt/tools", 3, b"opt/tools", 4_242, 0o755, 0, 0, 2, b"", b"", b"",
        )
        .expect("archive member");
        let honest = drain_container(8192, &mut no_bytes());
        assert!(
            load_image(honest.len() as u64, image_host(&honest)).is_ok(),
            "a complete cohort loads, so the refusal above is the cohort's",
        );
    }

    #[test]
    fn an_image_the_kernel_exported_is_one_the_kernel_can_load() {
        let _guard = TestGuard::acquire();
        // The round trip that makes the kernel the image's only author: an
        // exported image must load back with nothing lost. Several separate
        // holes each broke it -- the archive member exported as an empty file,
        // the URL-backed file lost its description, the section could not name
        // an archive, the loader refused a body-described image -- and any one
        // still open breaks this.
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        mkdir(b"/usr", 0o755, 0, 0).expect("mkdir /usr");
        declare_archive(3, 8_000_000).expect("declare archive");
        set_archive_payload(3, &unsealed_payload(b"sha256:abc")).expect("describe it");
        insert_lazy_file(
            b"/usr/php",
            3,
            b"usr/bin/php",
            4_242,
            0o755,
            0,
            0,
            2,
            b"",
            b"",
            b"",
        )
        .expect("archive member");
        write_file_at(b"/etc-ish", 0, b"ordinary bytes", 0o644, true, no_bytes())
            .expect("an ordinary file, so the tree is not all deferred");

        // Through the call a builder actually makes, not a container this test
        // assembles: if the kernel emits the container, a test that assembles
        // its own is checking a path nothing ships.
        let image = drain_container(8192, &mut no_bytes());

        let count = load_image(image.len() as u64, image_host(&image)).expect("load it back");
        assert_eq!(count, 4, "root, /usr, /usr/php, /etc-ish");

        // The lazy member survived the whole round trip: real size, linkage,
        // and an archive length to bound its fetch.
        assert_eq!(lstat(b"/usr/php").expect("stat").st_size, 4_242);
        assert_eq!(lstat(b"/usr/php").expect("stat").st_mode & 0o7777, 0o755);
        assert_eq!(
            lazy_member_source(b"/usr/php").expect("linkage"),
            (3, b"usr/bin/php".to_vec()),
        );
        assert_eq!(archive_size(3), Some(8_000_000));

        // The archive's own fetch description survives too. Without it
        // the round trip would preserve everything EXCEPT the integrity data
        // every production image's archives carry -- a loss that shows up only
        // when something is fetched.
        let carried = ROOTFS.with(|state| {
            state.archives.get(&3).map(|entry| entry.payload.clone())
        });
        assert_eq!(carried, Some(unsealed_payload(b"sha256:abc")));

        // And the ordinary file is still ordinary -- not swept up as deferred.
        assert_eq!(lstat(b"/etc-ish").expect("stat").st_size, 14);
    }

    #[test]
    fn an_image_described_only_by_its_body_loads() {
        let _guard = TestGuard::acquire();
        // The image declares no `KLZY`; its body's SDEF section is the whole
        // description, which is what the Rust export writes. A loader that
        // refused it would make an image the kernel wrote one the kernel could
        // not read.
        let url: &[u8] = b"https://example.invalid/big.bin";
        let image = sdef_only_image(url, 45_000);
        let count = load_image(image.len() as u64, image_host(&image)).expect("load image");
        assert_eq!(count, 3, "root + two deferred files");

        // Both kinds of deferred file get their REAL size from the body, not
        // the zero-length stub the body inode holds. That is the whole failure
        // this refusal was protecting against, now checked rather than avoided.
        assert_eq!(lstat(b"/big.bin").expect("stat").st_size, 45_000);
        assert_eq!(lstat(b"/php").expect("stat").st_size, 4_242);

        // The archive member's linkage came through too, and the archive's
        // length with it -- so the fetch it will need is bounded.
        assert_eq!(
            lazy_member_source(b"/php").expect("linkage"),
            (3, b"usr/bin/php".to_vec()),
        );
        assert_eq!(archive_size(3), Some(8_000_000));
        // And its descriptor, which KLZY has no field for and SDEF does.
        assert_eq!(
            ROOTFS.with(|state| state.archives.get(&3).map(|e| e.payload.clone())),
            Some(unsealed_payload(b"sha256:feed")),
        );
        // ... along with the two fields v5 promoted OUT of that descriptor,
        // which the kernel does not merely carry: the address it will hand the
        // host, and the digest it will check the arriving bytes against.
        assert_eq!(
            archive_source(3),
            Some((ARCHIVE_URI.to_vec(), ARCHIVE_DIGEST)),
        );
        assert_eq!(
            deferred_source(b"/big.bin").expect("the standalone file's source"),
            (url.to_vec(), FILE_DIGEST),
        );
        // An archive member has no address of its own -- its archive's is the
        // one answer -- but it does have a digest, because the archive's covers
        // the ARCHIVE and this one covers the inflated member.
        assert_eq!(
            deferred_source(b"/php").expect("the member's source"),
            (Vec::new(), MEMBER_DIGEST),
        );
    }

    #[test]
    fn an_address_and_digest_survive_a_load_and_re_export() {
        let _guard = TestGuard::acquire();
        // The reason these live on the inode rather than in a side table. An
        // export renumbers every inode, so a description keyed by the SOURCE
        // image's inode number cannot be re-attached afterwards -- and a
        // deferred file re-emitted without its address is one nothing can ever
        // fetch, exported as a success. The payload once had exactly this
        // failure; these two fields would repeat it silently, because an image with no
        // digest verifies nothing and still loads.
        let url: &[u8] = b"https://example.invalid/big.bin";
        let image = sdef_only_image(url, 45_000);
        load_image(image.len() as u64, image_host(&image)).expect("load image");

        let exported = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount the export");
        let section = fs
            .deferred_section()
            .expect("read the section")
            .expect("the export describes its deferred files");

        let archive = section
            .archives
            .iter()
            .find(|a| a.archive_id == 3)
            .expect("the archive is re-declared");
        assert_eq!(archive.uri, ARCHIVE_URI);
        assert_eq!(archive.digest, ARCHIVE_DIGEST);
        assert_eq!(archive.bytes, 8_000_000);

        // Found by size rather than by inode number, precisely because the
        // numbers are not the ones the source image used.
        let standalone = section
            .records
            .iter()
            .find(|r| r.size == 45_000)
            .expect("the standalone file is re-described");
        assert_eq!(standalone.uri, url);
        assert_eq!(standalone.digest, FILE_DIGEST);

        let php = section
            .records
            .iter()
            .find(|r| r.size == 4_242)
            .expect("the member is re-described");
        assert_eq!(php.archive_id, 3);
        assert_eq!(php.digest, MEMBER_DIGEST);
        assert!(
            php.uri.is_empty(),
            "a member is addressed by its archive, and the export must not invent a second address"
        );
    }

    #[test]
    fn an_image_built_for_another_kernel_abi_is_refused_at_load() {
        let _guard = TestGuard::acquire();
        // The check that used to live in `host/src/binary-resolver.ts`, which
        // parsed the image header in TypeScript while choosing which FILE to
        // use. An image is built once and outlives every ABI bump after it, so
        // this is the ordinary consequence of not rebuilding -- and the ABI
        // contract says it fails loudly rather than boots.
        let body = |()| {
            let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(
                crate::kandelo_image_write::KandeloImageConfig::fixed(128 * 1024),
            )
            .expect("mkfs");
            let root = w.root();
            w.create_file(root, b"plain", 0o644, crate::kandelo_image_write::Content::Bytes(b"hi"))
                .expect("a plain file");
            w.declare_deferred_section();
            w.finish()
                .expect("finish")
                .to_vec(&crate::kandelo_image_write::NoContent)
                .expect("materialize")
        };
        let wrap_with = |metadata: Option<&[u8]>| {
            crate::vfsi_container::wrap(
                &body(()),
                &crate::vfsi_container::ContainerSections {
                    lazy_json: b"",
                    archive_json: None,
                    metadata_json: metadata,
                    kernel_lazy: None,
                },
            )
            .expect("wrap")
        };

        let stale = alloc::format!(r#"{{"version":1,"kernelAbi":{}}}"#, 1u32);
        let image = wrap_with(Some(stale.as_bytes()));
        assert_eq!(
            load_image(image.len() as u64, image_host(&image)).unwrap_err(),
            Errno::EPROTO,
            "an image declaring ABI 1 must not mount on this kernel",
        );

        // EPROTO and not EINVAL, and the distinction is the point: this image
        // is well-formed. The SAME bytes with a matching declaration load.
        let current =
            alloc::format!(r#"{{"version":1,"kernelAbi":{}}}"#, wasm_posix_shared::ABI_VERSION);
        let matching = wrap_with(Some(current.as_bytes()));
        assert!(
            load_image(matching.len() as u64, image_host(&matching)).is_ok(),
            "the same image declaring THIS kernel's ABI must load",
        );

        // And an image that declares nothing still loads: declaring an ABI is
        // what makes the check possible, and an image predating the field
        // makes no claim this could contradict.
        let silent = wrap_with(None);
        assert!(
            load_image(silent.len() as u64, image_host(&silent)).is_ok(),
            "absence of a declaration is not a violation",
        );
    }

    #[test]
    fn an_image_that_describes_its_deferred_files_nowhere_is_still_refused() {
        let _guard = TestGuard::acquire();
        // The refusal this change was careful NOT to weaken. No `KLZY`, and a
        // body with no SDEF section either: the kernel cannot tell "no lazy
        // files" from "lazy files recorded only in host-side JSON I cannot
        // read", and loading it would build a tree where every deferred file
        // reports size 0 -- a wrong tree that looks like a right one.
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(
            128 * 1024,
        ))
        .expect("mkfs");
        let root = w.root();
        w.create_file(root, b"plain", 0o644, crate::kandelo_image_write::Content::Bytes(b"hi"))
            .expect("a file with no deferred anything");
        let body = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");
        let sections = crate::vfsi_container::ContainerSections {
            lazy_json: b"",
            archive_json: None,
            metadata_json: None,
            kernel_lazy: None,
        };
        let image = crate::vfsi_container::wrap(&body, &sections).expect("wrap");

        assert_eq!(
            load_image(image.len() as u64, image_host(&image)).unwrap_err(),
            Errno::EINVAL,
        );

        // And the same tree WITH an empty `SDEF` section loads, so the refusal
        // above is the missing description rather than anything else about
        // this image.
        let mut w = crate::kandelo_image_write::KandeloImageWriter::mkfs(crate::kandelo_image_write::KandeloImageConfig::fixed(
            128 * 1024,
        ))
        .expect("mkfs");
        let root = w.root();
        w.create_file(root, b"plain", 0o644, crate::kandelo_image_write::Content::Bytes(b"hi"))
            .expect("a file with no deferred anything");
        w.declare_deferred_section();
        let described = w
            .finish()
            .expect("finish")
            .to_vec(&crate::kandelo_image_write::NoContent)
            .expect("materialize");
        let with_sdef = crate::vfsi_container::wrap(&described, &sections).expect("wrap");
        assert_eq!(
            load_image(with_sdef.len() as u64, image_host(&with_sdef)).expect("loads"),
            2,
        );
    }

    /// The `KLZY` reader was removed on 2026-10-02: the TypeScript writer that
    /// emitted the section was deleted on 2026-09-17, every builder now writes
    /// `SDEF`, and an image that still carries `KLZY` can only be a pre-change
    /// build under ABI 44, which is unreleased. Such an image is a stale
    /// artifact and is refused loudly, even when its body ALSO describes its
    /// deferred files with `SDEF` -- reading the body and ignoring the section
    /// would silently drop whatever the section said.
    #[test]
    fn an_image_carrying_a_klzy_section_is_refused() {
        let _guard = TestGuard::acquire();
        // The section's contents do not matter: its presence is the refusal.
        let image = tiny_vfs_with_kernel_lazy(b"KLZY and anything after it");
        assert_eq!(
            load_image(image.len() as u64, image_host(&image)).unwrap_err(),
            Errno::EINVAL,
        );
        assert_eq!(lstat(b"/big.txt").unwrap_err(), Errno::ENOENT, "no partial tree");

        // The same image without the section loads, so the refusal is the
        // section and nothing else about it.
        let without = tiny_vfs_described();
        assert_eq!(load_image(without.len() as u64, image_host(without)).expect("loads"), 6);
    }

    #[test]
    fn a_url_backed_files_description_survives_load_and_export() {
        let _guard = TestGuard::acquire();
        // Why the loader retains descriptions. The kernel cannot RECONSTRUCT this
        // description -- it holds no URL, and the file's inode number in the
        // source image does not survive an export's renumbering -- so the only
        // way an exported image can say where these bytes are is if the loader
        // kept what it was given.
        let url: &[u8] = b"https://example.invalid/big.bin#sha256:deadbeef";
        let image = url_backed_image(url, 45_000);
        load_image(image.len() as u64, image_host(&image)).expect("load image");

        // Before the export: the size is authoritative from the linkage, and
        // nothing has been fetched.
        assert_eq!(lstat(b"/big.bin").expect("stat").st_size, 45_000);

        let exported = drain_export(8192, &mut image_host(&image));
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount exported image");

        let ino = fs.resolve(b"/big.bin", true).expect("the path survives");
        assert_eq!(
            fs.stat_ino(ino).expect("stat").size,
            0,
            "the body inode is a stub; the image describes bytes it does not carry",
        );

        let record = fs
            .deferred_section()
            .expect("decodes")
            .expect("the export emits a deferred section")
            .get(ino)
            .cloned()
            .expect("a record keyed by the inode THIS export assigned");
        // The ADDRESS, not the payload: the URL moved to a typed field when the
        // kernel started relaying it, and "the description survives" now means
        // the thing that says where the bytes are survives.
        assert_eq!(record.uri, url, "carried through byte for byte");
        assert_eq!(record.size, 45_000, "the real size, not the stub's");
        assert_eq!(record.archive_id, 0, "fetched standalone, not from an archive");
        assert!(record.source_path.is_empty(), "and so with no member path");
    }

    #[test]
    fn registering_a_half_specified_linkage_is_refused_at_the_call() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");

        // An archive with no member to extract from it.
        assert_eq!(
            insert_lazy_file(b"/a", 4, b"", 10, 0o644, 0, 0, 2, b"", b"", b""),
            Err(Errno::EINVAL),
        );
        // A member with no archive to extract it from.
        assert_eq!(
            insert_lazy_file(b"/b", 0, b"members/x", 10, 0o644, 0, 0, 3, b"", b"", b""),
            Err(Errno::EINVAL),
        );

        // Refused at the CALL, not later at the export. Neither name exists, so
        // the tree is not left holding a file it cannot describe — which is the
        // whole point of checking here rather than in `create_deferred_file`.
        assert!(lstat(b"/a").is_err());
        assert!(lstat(b"/b").is_err());

        // And both whole forms are accepted, so the refusals above are the
        // half-specification and not something else about these calls.
        insert_lazy_file(
            b"/member",
            4,
            b"members/x",
            10,
            0o644,
            0,
            0,
            4,
            b"",
            b"",
            b"",
        )
        .expect("an archive member");
        insert_lazy_file(
            b"/solo",
            0,
            b"",
            10,
            0o644,
            0,
            0,
            5,
            b"",
            b"",
            b"https://example.invalid/x",
        )
        .expect("a standalone fetch");
    }

    #[test]
    fn registering_an_oversized_fetch_description_is_refused() {
        let _guard = TestGuard::acquire();
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        let too_long = alloc::vec![b'x'; crate::sdef::MAX_PAYLOAD_LEN as usize + 1];
        assert_eq!(
            insert_lazy_file(b"/a", 0, b"", 10, 0o644, 0, 0, 2, b"", b"", &too_long),
            Err(Errno::EINVAL),
        );
        assert!(lstat(b"/a").is_err(), "and nothing was created");
    }

    #[test]
    fn exporting_a_member_of_an_archive_with_no_known_length_fails_loudly() {
        let _guard = TestGuard::acquire();
        // `insert_lazy_file` places a member; nothing here declares how long
        // archive 3 is. The export must refuse rather than declare it as zero
        // bytes — a consumer would then know which archive to fetch and be told
        // to read none of it, which is a silently empty file wearing the shape
        // of a correct one.
        //
        // Not reachable through the module bridge, which takes the archive's
        // length alongside the member for exactly this reason. It is reachable
        // here, and this is the layer that has to refuse.
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        insert_lazy_file(
            b"/big",
            3,
            b"members/big.bin",
            99_999,
            0o644,
            0,
            0,
            2,
            b"",
            b"",
            b"",
        )
        .expect("the member itself is well-formed");

        let mut buf = alloc::vec![0u8; 8192];
        assert_eq!(
            export_image_read(0, &mut buf, &mut no_bytes()).unwrap_err(),
            Errno::EIO,
        );

        // Declaring the length makes the same tree exportable, so the refusal
        // above is the missing length and not something else about the tree.
        reset_image_export();
        declare_archive(3, 8_000_000).expect("declare");
        let exported = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount");
        assert_eq!(
            fs.deferred_section()
                .expect("decodes")
                .expect("section")
                .archive_bytes(3),
            Some(8_000_000),
        );
    }

    #[test]
    fn a_host_write_to_a_symlinked_path_lands_in_the_file_it_names() {
        let _g = TestGuard::acquire();
        // `open` refuses a symlinked final component with ELOOP on purpose:
        // the GUEST's namespace resolver pre-resolves, so a symlink arriving
        // there means `O_NOFOLLOW`. A host-facing raw-path writer does not
        // pre-resolve, and `write_file_at` never closed that gap even though
        // `read_file_at` beside it does.
        //
        // The result was that READING `/bin/bash` through a symlink worked and
        // WRITING it failed ELOOP. It surfaced building the shell package,
        // where the composer materialises bash over a path the rootfs carries
        // as a symlink -- a product build, not a test.
        mkdir(b"/bin", 0o755, 0, 0).expect("mkdir /bin");
        mkdir(b"/usr", 0o755, 0, 0).expect("mkdir /usr");
        mkdir(b"/usr/bin", 0o755, 0, 0).expect("mkdir /usr/bin");
        // A DIFFERENT initial mode, so the chmod a truncating replace performs
        // is observable. With both at 0o755 the write could set the mode of the
        // LINK and nothing would notice -- which is exactly what a surviving
        // mutant showed.
        write_file_at(b"/usr/bin/bash", 0, b"old", 0o600, true, no_bytes())
            .expect("the real file");
        symlink(b"/usr/bin/bash", b"/bin/bash", 0, 0).expect("the alias");

        write_file_at(b"/bin/bash", 0, b"new bytes", 0o755, true, no_bytes())
            .expect("writing through the symlink must not fail ELOOP");

        // The bytes landed in the file the NAME refers to, and the link is
        // still a link rather than having been replaced by a regular file.
        let mut buf = [0u8; 16];
        let n = read_file_at(b"/usr/bin/bash", 0, &mut buf, no_bytes()).expect("read target");
        assert_eq!(&buf[..n], b"new bytes");
        assert_eq!(
            lstat(b"/bin/bash").expect("lstat").st_mode & S_IFMT,
            S_IFLNK,
            "the alias is still a symlink",
        );

        // The MODE landed on the target too. A truncating replace sets the mode
        // explicitly, and it must set it on the file the name refers to --
        // `chmod` here walks directories without following a final symlink, so
        // handing it the raw path would silently re-mode the link instead.
        assert_eq!(
            lstat(b"/usr/bin/bash").expect("lstat").st_mode & 0o7777,
            0o755,
            "the replaced file carries the mode the write asked for",
        );
    }

    #[test]
    fn a_host_write_still_creates_a_file_that_does_not_exist_yet() {
        let _g = TestGuard::acquire();
        // The negative control for the resolution above. A path that does not
        // RESOLVE is one the caller may be about to create, so the raw path
        // stands in -- without this, following symlinks would have turned every
        // creating write into ENOENT, which is exactly what it did on the first
        // attempt and what sixteen tests caught.
        mkdir(b"/etc", 0o755, 0, 0).expect("mkdir /etc");
        write_file_at(b"/etc/fresh", 0, b"created", 0o644, true, no_bytes())
            .expect("a creating write still creates");
        let mut buf = [0u8; 16];
        let n = read_file_at(b"/etc/fresh", 0, &mut buf, no_bytes()).expect("read it back");
        assert_eq!(&buf[..n], b"created");

        // And a missing PARENT is still the caller's error, not a silent
        // creation somewhere else.
        assert_eq!(
            write_file_at(b"/nope/deep", 0, b"x", 0o644, true, no_bytes()).unwrap_err(),
            Errno::ENOENT,
        );
    }

    #[test]
    fn a_deferred_file_with_no_description_re_exports_as_deferred() {
        let _guard = TestGuard::acquire();
        // A `KLZY`-described image says a file is deferred and how big
        // it really is, and says NOTHING about where its bytes come from -- the
        // URL lives in host-side JSON the kernel does not read. So a deferred
        // file loaded from one arrives with an empty payload, which used to be
        // indistinguishable from a base file the host WALKED.
        //
        // The export treated them the same and wrote a stub, so a 4,242-byte
        // binary came out a zero-length ORDINARY file and the export reported
        // success. Re-emitting it as deferred is not "dressed up as pointing
        // nowhere": the input pointed nowhere too, and this carries exactly
        // what the input carried.
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        insert_host_file(b"/php", 77, 4_242, 0o755, 0, 0, 2).expect("base file");
        mark_deferred_base(b"/php").expect("deferred, description unknown");

        let exported = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount");
        // The image's inode is a zero-length stub BY DESIGN -- a deferred file's
        // bytes are not in the image, and its real length lives in the deferred
        // record beside it. So the stub proves nothing either way, and the
        // record is where the difference between a fix and the defect shows:
        // without one, this file is simply an empty ordinary file.
        let php = fs.resolve(b"/php", true).expect("/php");
        assert_eq!(fs.stat_ino(php).expect("stat").size, 0, "a deferred stub");
        let section = fs.deferred_section().expect("decodes").expect("section");
        assert_eq!(section.records.len(), 1, "exactly this file is deferred");
        let record = &section.records[0];
        assert_eq!(record.size, 4_242, "the record carries the real length");
        assert_eq!(record.archive_id, 0, "fetched standalone");
        assert!(
            record.payload.is_empty(),
            "no description, because the image it came from carried none",
        );
    }

    #[test]
    fn a_base_file_with_no_description_still_exports_as_a_stub() {
        let _guard = TestGuard::acquire();
        // The honest other half. A base file with host-held bytes
        // carries no deferred description at all -- its bytes are ordinary host
        // files, not a deferred fetch -- so there is nothing to retain and
        // nothing to re-emit. This is not "the payload went missing"; it is a
        // file this export cannot serialize, and it must not be dressed up as a
        // deferred file pointing nowhere.
        insert_base_dir(b"/", 0o755, 0, 0, 1).expect("root");
        insert_host_file(b"/walked.bin", 77, 4096, 0o644, 0, 0, 2).expect("base file");

        let exported = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount exported image");
        let ino = fs.resolve(b"/walked.bin", true).expect("the path survives");
        assert_eq!(fs.stat_ino(ino).expect("stat").size, 0);
        // The export always DECLARES a section, because an image that declares
        // none is one `load_image` refuses. So the claim here is that
        // the section is EMPTY, not absent: no description in, no record out --
        // an empty payload must not become a deferred record that says nothing.
        let section = fs
            .deferred_section()
            .expect("decodes")
            .expect("the export always declares a section");
        assert!(section.records.is_empty(), "no description in, no record out");
        assert!(section.archives.is_empty());
    }

    #[test]
    fn an_exported_image_mounts_and_round_trips_the_overlay() {
        let _guard = TestGuard::acquire();
        build_small_overlay();

        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount exported image");

        // Directory structure and metadata.
        let etc = fs.resolve(b"/etc", true).expect("/etc");
        assert_eq!(fs.stat_ino(etc).unwrap().mode, S_IFDIR | 0o755);
        let opt = fs.resolve(b"/opt", true).expect("/opt");
        let opt_stat = fs.stat_ino(opt).unwrap();
        assert_eq!(opt_stat.mode, S_IFDIR | 0o700);
        assert_eq!((opt_stat.uid, opt_stat.gid), (7, 9));

        // Overlay-owned bytes.
        let passwd = fs.resolve(b"/etc/passwd", true).expect("/etc/passwd");
        let size = fs.stat_ino(passwd).unwrap().size as usize;
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(passwd, 0, &mut buf).unwrap(), size);
        assert_eq!(buf, b"root:x:0:0\n");

        // A file large enough to need the single indirect block.
        let big = fs.resolve(b"/opt/big.bin", true).expect("/opt/big.bin");
        let size = fs.stat_ino(big).unwrap().size as usize;
        assert_eq!(size, 45_000);
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(big, 0, &mut buf).unwrap(), size);
        for (i, b) in buf.iter().enumerate() {
            assert_eq!(*b, (i % 251) as u8, "byte {i}");
        }
        assert_eq!(fs.stat_ino(big).unwrap().mode, S_IFREG | 0o600);

        // Both symlink encodings.
        let link = fs.resolve(b"/pw", false).expect("/pw");
        assert_eq!(fs.read_link(link).unwrap(), b"/etc/passwd");
        let long = fs.resolve(b"/longpw", false).expect("/longpw");
        assert_eq!(
            fs.read_link(long).unwrap(),
            b"/opt/a-target-path-long-enough-to-need-its-own-data-block"
        );
    }

    #[test]
    fn an_exported_image_carries_the_overlay_timestamps() {
        // The fixtures in `kandelo_image_write` pin timestamps to zero because the
        // TypeScript writer stamps `Date.now()`. A real exported image must
        // carry the overlay's own mtimes, or every save would flatten them.
        let _guard = TestGuard::acquire();
        set_now(1_700_000_123, 456_000_000);
        write_file_at(b"/stamped", 0, b"x", 0o644, true, no_bytes()).expect("write");

        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let ino = fs.resolve(b"/stamped", true).expect("resolve");
        let stat = fs.stat_ino(ino).unwrap();
        assert_eq!(stat.mtime_ms, 1_700_000_123 * 1000 + 456);
    }

    #[test]
    fn a_setuid_file_survives_the_export() {
        // Both the write and the chown clear a regular file's set-user bit, so
        // this only holds because the export applies ownership before mode.
        let _guard = TestGuard::acquire();
        write_file_at(b"/su", 0, b"#!/bin/sh\n", 0o4755, true, no_bytes()).expect("write");
        chown(b"/su", 0, 0, false).expect("chown");

        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let ino = fs.resolve(b"/su", true).expect("resolve");
        assert_eq!(fs.stat_ino(ino).unwrap().mode & 0o7777, 0o4755);
    }

    #[test]
    fn hard_links_export_as_one_inode_with_two_names() {
        let _guard = TestGuard::acquire();
        write_file_at(b"/a", 0, b"shared", 0o644, true, no_bytes()).expect("write");
        link(b"/a", b"/b").expect("link");

        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        let a = fs.resolve(b"/a", true).expect("/a");
        let b = fs.resolve(b"/b", true).expect("/b");
        assert_eq!(a, b, "one inode, not a second copy");
        assert_eq!(fs.stat_ino(a).unwrap().nlink, 2);
        let mut buf = [0u8; 16];
        let n = fs.read_at(a, 0, &mut buf).unwrap();
        assert_eq!(&buf[..n], b"shared");
    }

    #[test]
    fn special_nodes_survive_image_export_and_reload() {
        let _guard = TestGuard::acquire();
        write_file_at(b"/keep", 0, b"k", 0o644, true, no_bytes()).expect("write");
        mknod_special(b"/sock", 0o755, 0, 0, S_IFSOCK).expect("special");
        mknod_special(b"/fifo", 0o640, 7, 8, S_IFIFO).expect("fifo");

        let bytes = drain_export(8192, &mut no_bytes());
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(bytes.as_slice()).expect("mount");
        assert!(fs.resolve(b"/keep", true).is_ok());
        assert_eq!(fs.stat_ino(fs.resolve(b"/sock", false).unwrap()).unwrap().mode, S_IFSOCK | 0o755);
        let fifo = fs.stat_ino(fs.resolve(b"/fifo", false).unwrap()).unwrap();
        assert_eq!(fifo.mode, S_IFIFO | 0o640);
        assert_eq!((fifo.uid, fifo.gid), (7, 8));

        let container = drain_container(8192, &mut no_bytes());
        reset();
        load_image(container.len() as u64, image_host(&container)).unwrap();
        assert_eq!(lstat(b"/sock").unwrap().st_mode & S_IFMT, S_IFSOCK);
        assert_eq!(lstat(b"/fifo").unwrap().st_mode & S_IFMT, S_IFIFO);
    }

    #[test]
    fn export_is_chunk_independent() {
        // The host reads this in scratch-region-sized chunks, so an export
        // read at an arbitrary offset and width must agree with every other
        // chunking of the same image.
        let _guard = TestGuard::acquire();
        build_small_overlay();

        let reference = drain_export(1 << 20, &mut no_bytes());
        assert!(!reference.is_empty());
        for chunk in [1usize, 7, 512, 4095, 4096, 4097, 65536] {
            let streamed = drain_export(chunk, &mut no_bytes());
            assert_eq!(streamed, reference, "chunk size {chunk}");
        }
    }

    #[test]
    fn export_is_deterministic_for_the_same_tree() {
        // Two exports of an unchanged tree must be identical. Without this the
        // image could not be compared to anything, including itself.
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let first = drain_export(8192, &mut no_bytes());
        let second = drain_export(8192, &mut no_bytes());
        assert_eq!(first, second);
    }

    #[test]
    fn overlay_mutations_reach_the_exported_image() {
        // The whole reason export moved off the frozen base image: the export
        // must reflect runtime state, not the image the session booted from.
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let before = drain_export(8192, &mut no_bytes());

        unlink(b"/etc/passwd").expect("unlink");
        write_file_at(b"/etc/group", 0, b"root:x:0:\n", 0o640, true, no_bytes())
            .expect("write group");
        chmod(b"/opt", 0o751).expect("chmod");

        let after = drain_export(8192, &mut no_bytes());
        assert_ne!(before, after, "a mutated tree must export differently");

        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(after.as_slice()).expect("mount");
        assert!(fs.resolve(b"/etc/passwd", true).is_err(), "deleted file is gone");
        let group = fs.resolve(b"/etc/group", true).expect("/etc/group");
        assert_eq!(fs.stat_ino(group).unwrap().mode, S_IFREG | 0o640);
        let opt = fs.resolve(b"/opt", true).expect("/opt");
        assert_eq!(fs.stat_ino(opt).unwrap().mode, S_IFDIR | 0o751);
    }

    #[test]
    fn image_backed_files_stream_out_of_the_loaded_image() {
        // The end-to-end shape of image-backed export: the kernel reads a base
        // file's bytes out of the `/` image it mounted, and writes them into a
        // new image, without either image being resident in kernel memory.
        let _guard = TestGuard::acquire();
        let image = tiny_vfs_described().to_vec();
        load_image(image.len() as u64, image_host(&image)).expect("load image");

        let exported = drain_export(8192, &mut image_host(&image));
        let fs = crate::kandelo_image_fs::KandeloImageFs::mount(exported.as_slice()).expect("mount exported");

        // Same tree as the source image, read back out of the EXPORTED one.
        let hello = fs.resolve(b"/hello.txt", true).expect("/hello.txt");
        let size = fs.stat_ino(hello).unwrap().size as usize;
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(hello, 0, &mut buf).unwrap(), size);
        assert_eq!(buf, b"hello sffs\n");

        // The 45000-byte file crosses into the single indirect block on BOTH
        // sides: streamed out of the source image's indirect blocks and written
        // into the exported image's.
        let big = fs.resolve(b"/big.txt", true).expect("/big.txt");
        let size = fs.stat_ino(big).unwrap().size as usize;
        assert_eq!(size, 45_000);
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(big, 0, &mut buf).unwrap(), size);
        for (i, b) in buf.iter().enumerate() {
            assert_eq!(*b, (i % 251) as u8, "byte {i}");
        }

        let nested = fs.resolve(b"/dir/nested.txt", true).expect("/dir/nested.txt");
        let size = fs.stat_ino(nested).unwrap().size as usize;
        let mut buf = alloc::vec![0u8; size];
        assert_eq!(fs.read_at(nested, 0, &mut buf).unwrap(), size);
        assert_eq!(buf, b"nested\n");

        let link = fs.resolve(b"/link", false).expect("/link");
        assert_eq!(fs.read_link(link).unwrap(), b"hello.txt");
    }

    #[test]
    fn the_export_holds_structure_not_content() {
        // The claim that makes the export streaming rather than buffering: a plan for
        // an image full of file bytes must not hold those bytes. Measured
        // against the plan itself, not inferred from the design.
        let _guard = TestGuard::acquire();
        // Eight megabytes of overlay-owned content across several files.
        for i in 0..8 {
            let data = alloc::vec![i as u8; 1 << 20];
            let path = alloc::format!("/f{i}").into_bytes();
            write_file_at(&path, 0, &data, 0o644, true, no_bytes()).expect("write");
        }
        let plan = build_export_image(&mut no_bytes()).expect("build");
        assert!(plan.len() >= 8 << 20, "the image really is that large");
        // Every megabyte-sized file is a reference, one per file, and the
        // structure the plan holds is orders of magnitude smaller.
        assert_eq!(plan.contents.len(), 8);
        let resident = plan.image.resident_bytes();
        assert!(
            resident < (1 << 20),
            "structure must stay far below the image size, was {resident}"
        );
        assert!(
            resident >= 2 * crate::kandelo_image_fs::BLOCK_SIZE as u64,
            "resident_bytes must include its superblock and first inode-table page, was {resident}"
        );
    }

    #[test]
    fn export_traversal_refusal_releases_credit_and_preserves_live_tree_for_retry() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let before = drain_export(8192, &mut no_bytes());
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut refusals = 0;
        let mut successes = 0;
        for allowance in [0, 32, 128, 256, 512, 1024, 2048, 4096, 16384, 1024 * 1024] {
            {
                let _limit = crate::io_buffer::test_budget(baseline + allowance);
                match build_export_image(&mut no_bytes()) {
                    Err(Errno::ENOMEM) => refusals += 1,
                    Ok(plan) => { successes += 1; drop(plan); }
                    Err(error) => panic!("unexpected export refusal: {error:?}"),
                }
            }
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        }
        assert!(refusals > 0);
        assert!(successes > 0);
        assert_eq!(drain_export(8192, &mut no_bytes()), before);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn export_reclaims_warmed_clean_read_caches_without_losing_live_contents() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let expected = drain_export(8192, &mut no_bytes());
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let length = 512 * 1024;
        let digest: [u8; 32] = Sha256::digest(vec![7; length]).into();
        ROOTFS.with(|state| {
            for archive in [false, true] {
                let cache = if archive { &mut state.archive_verified_reads } else { &mut state.verified_reads };
                for key in [11, 12] {
                    let mut hashes = cache.prepare(key, length as u64).unwrap().unwrap();
                    hashes.push(digest);
                    cache.install(key, digest, length as u64, hashes).unwrap();
                    let mut bytes = cache.allocate_chunk(key, length).unwrap();
                    bytes.fill(7);
                    cache.install_chunk(key, digest, length as u64, 0, bytes).unwrap();
                }
            }
        });
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(retained > baseline + 4 * 1024 * 1024);
        let _limit = crate::io_buffer::test_budget(retained);
        assert_eq!(drain_export(8192, &mut no_bytes()), expected);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 <= retained - 4 * 1024 * 1024);
    }

    #[test]
    fn export_content_credit_survives_chunks_and_releases_at_eof_or_cancellation() {
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let baseline = crate::io_buffer::IO_MEMORY.usage().0;
        let mut chunk = [0u8; 4096];
        assert!(export_image_read(0, &mut chunk, &mut no_bytes()).unwrap() > 0);
        let retained = crate::io_buffer::IO_MEMORY.usage().0;
        assert!(retained > baseline);
        assert!(export_image_read(4096, &mut chunk, &mut no_bytes()).unwrap() > 0);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, retained);
        reset_image_export();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        drain_export(4096, &mut no_bytes());
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
        assert!(export_image_read(0, &mut chunk, &mut no_bytes()).unwrap() > 0);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 > baseline);
        reset();
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, baseline);
    }

    #[test]
    fn a_reset_discards_an_in_progress_export() {
        // An export addresses the store it was built from. If a reset left the
        // plan in place, the next chunk would serve a tree that is gone —
        // reading overlay arena indices that now mean something else.
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let mut source = no_bytes();
        let mut buf = alloc::vec![0u8; 4096];
        let first = export_image_read(0, &mut buf, &mut source).expect("first chunk");
        assert!(first > 0);

        reset();

        let n = export_image_read(4096, &mut buf, &mut source).expect("after reset");
        assert_eq!(n, 0, "a reset export must end, not serve stale bytes");
    }

    #[test]
    fn an_unopened_export_stream_yields_nothing() {
        // A non-zero offset with no plan is a caller error, not a reason to
        // build an image and serve its middle as if the stream had been opened.
        let _guard = TestGuard::acquire();
        build_small_overlay();
        let mut buf = alloc::vec![0u8; 4096];
        assert_eq!(
            export_image_read(4096, &mut buf, &mut no_bytes()).expect("no plan"),
            0
        );
        assert!(export_image_read(-1, &mut buf, &mut no_bytes()).is_err());
    }

}
